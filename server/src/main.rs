//! vviewer server CLI 入口。

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use clap::{Parser, Subcommand};

use vviewer::state::{build_mount, MountRoot};
use vviewer_storage::transport::HttpTransport;
// reqwest 唯一入口符号：native 门控内才存在（storage default-features =
// false，终审 I-1）——与 core 侧 default_transport 同形，静态装配专用。
#[cfg(feature = "native")]
use vviewer_storage::transport::ReqwestTransport;

mod config;
use config::{MountConfig, DEFAULT_PORT, load_file_config, resolve_config};

#[derive(Parser)]
#[command(name = "vviewer", version, about = "vviewer local viewer server")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// 通过 HTTP 暴露一个本地目录
    Serve {
        /// TOML 配置文件：serve 全参数默认值面（CLI 显式参数优先，未知键报错）
        #[arg(long)]
        config: Option<PathBuf>,
        /// 要暴露的根目录（可重复传入挂载多根；首个为 0 号根）
        #[arg(long)]
        root: Vec<PathBuf>,
        /// 前端构建产物目录（SvelteKit adapter-static build），挂载于 `/`
        #[arg(long)]
        web_dist: Option<PathBuf>,
        /// 监听端口（默认 8321）
        #[arg(long)]
        port: Option<u16>,
        /// 访问令牌，请求需带 `Authorization: Bearer <token>`
        #[arg(long)]
        token: Option<String>,
        /// 生成随机令牌（打印到 stdout 后启用鉴权）
        #[arg(long, conflicts_with = "token")]
        token_gen: bool,
        /// 绑定 0.0.0.0（局域网可访问；必须配置令牌）
        #[arg(long)]
        allow_lan: bool,
        /// 目录列表隐藏 dot 开头条目
        #[arg(long)]
        hidden: bool,
        /// 允许来自该精确 origin 的跨域 API 访问
        #[arg(long)]
        cors_origin: Option<String>,
        /// 启用服务端计算端点（/api/compute/*，health 能力追加 "compute"）
        #[arg(long)]
        compute: bool,
        /// 日志写文件（可选；默认 stdout），超 10MB 滚动为 <PATH>.old 单备份
        #[arg(long)]
        log_file: Option<PathBuf>,
    },
}

fn main() {
    let cli = Cli::parse();
    match cli.command {
        Command::Serve {
            config,
            root,
            web_dist,
            port,
            token,
            token_gen,
            allow_lan,
            hidden,
            cors_origin,
            compute,
            log_file,
        } => {
            // --config：文件先载入（配置错误 exit 2），再与 CLI 合并（优先级 CLI > 文件）
            let file = match config.map(|p| load_file_config(&p)) {
                None => None,
                Some(Ok(file)) => Some(file),
                Some(Err(e)) => {
                    eprintln!("error: {e}");
                    std::process::exit(2);
                }
            };
            let cli_args = ServeArgs {
                root,
                web_dist,
                port,
                token,
                token_gen,
                allow_lan,
                hidden,
                cors_origin,
                compute,
                log_file,
            };
            let mut resolved = match resolve_config(cli_args, file) {
                Ok(r) => r,
                Err(e) => {
                    eprintln!("error: {e}");
                    std::process::exit(2);
                }
            };
            // 挂载配置随合并产物进装配链（serve 内经后端构造接线，per-kind
            // 必填校验错误 exit 2）
            let mounts = std::mem::take(&mut resolved.mounts);
            if let Err(code) = serve(resolved.into(), mounts) {
                std::process::exit(code);
            }
        }
    }
}

pub struct ServeArgs {
    pub root: Vec<PathBuf>,
    pub web_dist: Option<PathBuf>,
    /// CLI 显式值；None=未提供（配置文件 port 可补默认，合并见 config::resolve_config）
    pub port: Option<u16>,
    pub token: Option<String>,
    pub token_gen: bool,
    pub allow_lan: bool,
    pub hidden: bool,
    pub cors_origin: Option<String>,
    pub compute: bool,
    pub log_file: Option<PathBuf>,
}

// 台账 1-1：token 明文不得经 Debug 外泄（日志/panic 消息面），存在性标记
// （Some("[redacted]")/None）保留供排障；其余字段原样。与 config.rs 的
// FileConfig/ResolvedConfig 手工 Debug 同款纪律（同一锁测覆盖三面）。
impl std::fmt::Debug for ServeArgs {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ServeArgs")
            .field("root", &self.root)
            .field("web_dist", &self.web_dist)
            .field("port", &self.port)
            .field("token", &self.token.as_ref().map(|_| "[redacted]"))
            .field("token_gen", &self.token_gen)
            .field("allow_lan", &self.allow_lan)
            .field("hidden", &self.hidden)
            .field("cors_origin", &self.cors_origin)
            .field("compute", &self.compute)
            .field("log_file", &self.log_file)
            .finish()
    }
}

/// 启动校验链的纯检查部分（自 serve() 提取以便单测；错误消息与检查顺序逐字保持
/// 既有行为，serve() 外层统一加 "error: " 前缀并映射 exit 2）。
/// `token` 为解析后的最终令牌（--token-gen 已生成）；`--config` 合并产物经同一条
/// 链校验——数据来源多一路，校验规则零改动（spec 2026-10-19 §2.1）。
fn validate_startup(args: &ServeArgs, token: Option<&str>) -> Result<(), String> {
    if token.is_some_and(str::is_empty) {
        return Err("--token must not be empty".to_string());
    }

    if args.allow_lan && token.is_none() {
        return Err(
            "--allow-lan exposes the server to your network and requires --token or --token-gen"
                .to_string(),
        );
    }

    // '*'（及一切通配形态）不是合法的精确 origin：HeaderValue 校验拦不住它，
    // 直传 tower-http `AllowOrigin::list` 会在 bind 前库内 panic（exit 101，BUG-45）。
    // 按 main.rs「配置错误返回 exit code（不 panic）」约定与 SRV-10 前例，
    // 启动即拒并指认参数与补救（通配 CORS 本就不在本服务威胁模型内，不提供替代值）。
    if let Some(origin) = &args.cors_origin {
        if origin.contains('*') {
            return Err(format!(
                "--cors-origin does not support wildcard '{origin}'; pass an exact origin (e.g. http://127.0.0.1:8080)"
            ));
        }
    }

    if args.root.is_empty() {
        return Err("at least one --root is required".to_string());
    }

    for root in &args.root {
        if !root.is_dir() {
            return Err(format!("--root is not a directory: {}", root.display()));
        }
    }

    if let Some(dist) = &args.web_dist {
        if !dist.is_dir() {
            return Err(format!("--web-dist is not a directory: {}", dist.display()));
        }
    }

    Ok(())
}

/// 桌面薄壳就绪行（plan 2026-10-19 Global Constraints：bind 成功后向 stdout 输出
/// 恰好一行 `VV_READY port=<n>`，n=listener 实测端口，--port 0 时为内核分配值；
/// 1-14 收窄：仅 --port 0 输出，显式端口面向人读不再多一行）。纯净行无前缀
/// 装饰——壳侧解析器按行首精确匹配；wire 格式由单测锁定。
fn ready_line(port: u16) -> String {
    format!("VV_READY port={port}")
}

/// 静态挂载装配（spec §2 启动链）：reqwest transport 建一次全挂载共享，逐项
/// 委托 [`vviewer::state::build_mount`]（阶段二下沉——运行时注册消费同一构造；
/// per-kind 必填校验在其内）。错误消息加挂载序号前缀，serve 统一 exit 2。
fn build_mount_roots(
    mounts: &[MountConfig],
) -> Result<Vec<MountRoot>, String> {
    if mounts.is_empty() {
        return Ok(Vec::new());
    }
    // reqwest transport 实例全挂载共享一个 Arc（连接池复用；无挂载不构建）
    let transport = default_http_transport()?;
    mounts
        .iter()
        .enumerate()
        .map(|(i, m)| {
            build_mount(m, transport.clone())
                .map_err(|e| format!("mount #{i}: {e}"))
        })
        .collect()
}

/// 静态挂载缺省 transport（native：reqwest 连接池建一次全挂载共享；行为与
/// 挪出门控前逐语句一致）。裁剪形态无 reqwest——worker 部署不经本 crate
/// （worker 复用的是 core + storage），静态挂载面随 native 裁剪，报配置错误。
#[cfg(feature = "native")]
fn default_http_transport() -> Result<Arc<dyn HttpTransport>, String> {
    Ok(Arc::new(
        ReqwestTransport::new()
            .map_err(|e| format!("http transport init: {}", e.message()))?,
    ))
}

/// 静态挂载缺省 transport（裁剪形态：无 reqwest，静态挂载不可用）。
#[cfg(not(feature = "native"))]
fn default_http_transport() -> Result<Arc<dyn HttpTransport>, String> {
    // 1-9：裁剪形态本分支不可达（server bin 恒 native、worker 部署不经本 crate
    // ——workers 计划终审论证在案）；运行时配置错误保留为防御性护栏，
    // debug 构建额外断言暴露误用。
    debug_assert!(false, "trimmed-form default_http_transport unreachable in server bin");
    Err("http transport requires the `native` feature (static mounts are native-only)".into())
}

/// 启动服务；配置错误返回 exit code（不 panic）。
fn serve(args: ServeArgs, mounts: Vec<MountConfig>) -> Result<(), i32> {
    let generated = if args.token_gen {
        let t = vviewer::generate_token();
        println!("{t}");
        Some(t)
    } else {
        None
    };

    // 启动校验链（纯检查部分提取为 validate_startup；消息与检查顺序逐字保持既有行为）
    if let Err(msg) = validate_startup(&args, generated.as_deref().or(args.token.as_deref())) {
        eprintln!("error: {msg}");
        return Err(2);
    }
    let token = generated.or(args.token);

    let roots: Vec<PathBuf> = args.root;

    if let Err(e) = vviewer::logging::init_tracing(args.log_file.as_deref()) {
        eprintln!("error: --log-file 不可用: {e}");
        return Err(2);
    }

    // 挂载后端构造（spec §2：per-kind 必填校验在此，配置错误 exit 2；reqwest
    // transport 实例全挂载共享一个 Arc）
    let mount_roots = match build_mount_roots(&mounts) {
        Ok(m) => m,
        Err(e) => {
            eprintln!("error: {e}");
            return Err(2);
        }
    };

    // bind：--allow-lan ? 0.0.0.0 : 127.0.0.1
    let ip: std::net::IpAddr = if args.allow_lan {
        std::net::Ipv4Addr::UNSPECIFIED.into()
    } else {
        std::net::Ipv4Addr::LOCALHOST.into()
    };
    let resolved_port = args.port.unwrap_or(DEFAULT_PORT);
    // 1-14：内核分配判定——解析链上 resolved_port == 0 即内核分配（显式
    // --port 0；未提供端口默认 DEFAULT_PORT=8321 非 0，不触发）。测试构建
    // 就绪行整体静默，判定随之免编译（免 unused 告警）。
    #[cfg(not(test))]
    let kernel_assigned = resolved_port == 0;
    let sock = SocketAddr::new(ip, resolved_port);

    let state = vviewer::state::AppState::new(
        roots[0].clone(),
        args.web_dist,
        token,
        args.hidden,
        args.cors_origin,
    )
    .with_roots(roots)
    .with_mounts(mount_roots)
    .with_compute(args.compute);
    let app = vviewer::build_router(state.clone());
    let tickets = state.tickets;

    let runtime = tokio::runtime::Runtime::new().map_err(|e| {
        eprintln!("error: failed to start tokio runtime: {e}");
        2
    })?;
    runtime.block_on(async move {
        // ticket 过期定期清理（签发时另有惰性清理兜底）
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(vviewer::TICKET_SWEEP_INTERVAL);
            loop {
                interval.tick().await;
                tickets.sweep();
            }
        });

        let listener = tokio::net::TcpListener::bind(sock)
            .await
            .map_err(|e| {
                eprintln!("error: failed to bind {sock}: {e}");
                2
            })?;
        // --port 0（桌面薄壳随机端口前提）：内核分配，实测地址以 listener.local_addr
        // 为准——listening 日志与就绪行同源，不再打印配置值 0
        let local = listener.local_addr().map_err(|e| {
            eprintln!("error: failed to read listener local address: {e}");
            2
        })?;
        tracing::info!("vviewer listening on http://{local}");
        // 1-14：就绪行语义收窄——仅内核分配端口（--port 0，桌面薄壳消费面）输出；
        // 显式端口面向人读，不再多一行。wire 格式与解析契约不变（ready_line 单测锁）。
        #[cfg(not(test))]
        if kernel_assigned {
            println!("{}", ready_line(local.port()));
        }
        axum::serve(listener, app).await.map_err(|e| {
            eprintln!("error: server failure: {e}");
            2
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use vviewer::state::MountKind;

    fn args(token: Option<String>) -> ServeArgs {
        ServeArgs {
            root: vec![PathBuf::from("/nonexistent-root-for-test")],
            web_dist: None,
            port: None,
            token,
            token_gen: false,
            allow_lan: false,
            hidden: false,
            cors_origin: None,
            compute: false,
            log_file: None,
        }
    }

    fn s3_cfg(field: &str) -> MountConfig {
        let mut m = MountConfig {
            kind: MountKind::S3,
            label: Some("docs".into()),
            endpoint: Some("http://127.0.0.1:9000".into()),
            bucket: Some("b1".into()),
            prefix: Some("sub".into()),
            access_key_id: Some("ak".into()),
            secret_access_key: Some("sk".into()),
            username: None,
            password: None,
            path_style: None,
            region: None,
        };
        match field {
            "endpoint" => m.endpoint = None,
            "bucket" => m.bucket = None,
            "access_key_id" => m.access_key_id = None,
            "secret_access_key" => m.secret_access_key = None,
            _ => {}
        }
        m
    }

    #[test]
    fn empty_token_is_rejected() {
        // 空 token 启动即拒（exit 2），先于 root 校验（root 故意指向不存在路径）
        assert_eq!(serve(args(Some(String::new())), Vec::new()), Err(2));
    }

    #[test]
    fn empty_root_list_is_rejected() {
        // 多值 --root 后缺根同样启动即拒（exit 2）
        let mut a = args(None);
        a.root.clear();
        assert_eq!(serve(a, Vec::new()), Err(2));
    }

    #[test]
    fn wildcard_cors_origin_is_rejected_cleanly() {
        // BUG-45：'*' 直传 AllowOrigin::list 会在 bind 前库内 panic（exit 101）；
        // 修复后启动即以配置错误退出（exit 2），且先于 root 校验无关紧要——
        // args() 的 root 故意指向不存在路径，只要 Err(2) 即达验收。
        let mut a = args(None);
        a.cors_origin = Some("*".to_string());
        assert_eq!(serve(a, Vec::new()), Err(2));
        // 通配形态变体同拒（防御不限于裸 '*'）
        let mut a = args(None);
        a.cors_origin = Some("http://*.example.com".to_string());
        assert_eq!(serve(a, Vec::new()), Err(2));
    }

    // ---------- 启动校验链直测（config 文件侧形态，台账 3-13/3-14） ----------

    /// 3-13：文件侧 allow_lan=false ≡ 缺省（不做「显式拒绝」）——false 不绕过
    /// 「allow_lan 必须 token」校验的否全面，也不新增面（config.rs 链测只锁
    /// true 的拒绝面，此处锁 false≡缺省的合并+校验直测）。
    #[test]
    fn file_allow_lan_false_equals_absent() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = vec![dir.path().to_path_buf()];
        let file_false =
            config::FileConfig { allow_lan: Some(false), ..Default::default() };

        // 合并面：false 与缺省同落 allow_lan=false（不产生「显式拒绝」形态）
        let resolved_false =
            resolve_config(ServeArgs { root: root.clone(), ..args(None) }, Some(file_false))
                .unwrap();
        let resolved_absent =
            resolve_config(ServeArgs { root: root.clone(), ..args(None) }, None).unwrap();
        assert!(!resolved_false.allow_lan);
        assert_eq!(resolved_false.allow_lan, resolved_absent.allow_lan);

        // 校验链面：无 CLI --allow-lan、无 token——两形态同过，不因 allow_lan 拒绝
        let a_false: ServeArgs = resolved_false.into();
        let a_absent: ServeArgs = resolved_absent.into();
        assert_eq!(validate_startup(&a_false, None), Ok(()));
        assert_eq!(validate_startup(&a_absent, None), Ok(()));
    }

    /// 3-14：web_dist 指向文件（非目录）→ 校验链报错且消息含 is_dir 语义
    /// （消息以现状为准，锁现状文案）。
    #[test]
    fn web_dist_pointing_at_file_is_rejected() {
        let root_dir = tempfile::tempdir().expect("tempdir");
        let file_tmp = tempfile::tempdir().expect("tempdir");
        let web_dist = file_tmp.path().join("not-a-dir.txt");
        std::fs::write(&web_dist, b"x").expect("write file");

        let mut a = args(None);
        a.root = vec![root_dir.path().to_path_buf()];
        a.web_dist = Some(web_dist.clone());
        let err = validate_startup(&a, None).unwrap_err();
        assert!(err.contains("--web-dist is not a directory"), "got: {err}");
        assert!(err.contains(web_dist.to_string_lossy().as_ref()), "got: {err}");
    }

    // ---------- 挂载后端构造（per-kind 必填校验，错误消息含字段名） ----------

    #[test]
    fn s3_mount_requires_endpoint_bucket_and_keys() {
        let transport: Arc<dyn HttpTransport> = Arc::new(
            vviewer_storage::transport::MockTransport::new(),
        );
        for field in ["endpoint", "bucket", "access_key_id", "secret_access_key"] {
            let err = build_mount(&s3_cfg(field), transport.clone()).unwrap_err();
            assert!(err.contains(field), "field={field} err={err}");
            assert!(err.contains("s3 mount"), "field={field} err={err}");
        }
        // 全字段齐备 → 构造成功，元信息齐面（凭据不入 meta）
        let root = build_mount(&s3_cfg(""), transport).unwrap();
        let meta = &root.meta;
        assert_eq!(meta.kind, "s3");
        assert_eq!(meta.label.as_deref(), Some("docs"));
        assert_eq!(meta.bucket.as_deref(), Some("b1"));
        assert_eq!(meta.prefix, "sub");
        // 元信息结构面即无凭据字段（spec §2：凭据不入 health/mounts 回显/日志）
        let dbg = format!("{meta:?}");
        assert!(!dbg.contains("sk"), "meta 无凭据字段: {dbg}");
        // 远端能力降级（Global Constraints）
        let caps = root.backend.capabilities();
        assert!(!caps.watch && !caps.search);
    }

    #[test]
    fn webdav_mount_requires_endpoint_and_account_pair() {
        let transport: Arc<dyn HttpTransport> = Arc::new(
            vviewer_storage::transport::MockTransport::new(),
        );
        let mut cfg = MountConfig {
            kind: MountKind::WebDav,
            label: None,
            endpoint: Some("https://dav.example.com".into()),
            bucket: None,
            prefix: None,
            access_key_id: None,
            secret_access_key: None,
            username: Some("u".into()),
            password: Some("p".into()),
            path_style: None,
            region: None,
        };
        let root = build_mount(&cfg, transport.clone()).unwrap();
        assert_eq!(root.meta.kind, "webdav");
        assert_eq!(root.meta.bucket, None, "webdav 无 bucket");
        assert_eq!(root.meta.prefix, "");

        for field in ["endpoint", "username", "password"] {
            let saved = match field {
                "endpoint" => cfg.endpoint.take(),
                "username" => cfg.username.take(),
                _ => cfg.password.take(),
            };
            let err = build_mount(&cfg, transport.clone()).unwrap_err();
            assert!(err.contains(field), "field={field} err={err}");
            match field {
                "endpoint" => cfg.endpoint = saved,
                "username" => cfg.username = saved,
                _ => cfg.password = saved,
            }
        }
    }

    #[test]
    fn empty_mount_list_builds_nothing() {
        assert!(build_mount_roots(&[]).unwrap().is_empty());
    }

    #[test]
    fn mount_construction_error_is_indexed() {
        let err = build_mount_roots(&[s3_cfg("bucket"), s3_cfg("")]).unwrap_err();
        assert!(err.contains("mount #0"), "err={err}");
    }

    // ---------- 评审 M1/I1：展示面 endpoint userinfo 剥除 ----------
    // display_endpoint 的纯函数用例随实现下沉 storage crate（lib.rs tests）；
    // 此处保留装配链两线分离的集成锚。

    /// 两条线分离核实：meta/health 展示面剥除凭据，backend 连接面仍用原
    /// endpoint（凭据是连接所需——剥了会静默连不上）。
    #[tokio::test]
    async fn mount_meta_strips_userinfo_while_backend_keeps_original() {
        use vviewer_storage::transport::{http_response, MockTransport};

        let transport = Arc::new(
            MockTransport::new().with_route("HEAD", "b1", |_| {
                http_response(200, &[("content-length", "0")], b"")
            }),
        );
        let cfg = MountConfig {
            kind: MountKind::S3,
            label: None,
            endpoint: Some("http://ak:sk@127.0.0.1:9000".into()),
            bucket: Some("b1".into()),
            prefix: None,
            access_key_id: Some("AKIAIOSFODNN7EXAMPLE".into()),
            secret_access_key: Some("wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY".into()),
            username: None,
            password: None,
            path_style: None,
            region: None,
        };
        let root = build_mount(&cfg, transport.clone()).unwrap();

        // 展示面（health 摘要/Debug 的数据源）已剥除
        assert_eq!(root.meta.endpoint, "http://127.0.0.1:9000");
        let dbg = format!("{:?}", root.meta);
        assert!(!dbg.contains("ak:sk"), "{dbg}");

        // 连接面：stat 实际请求仍带原 endpoint（userinfo 在 URL 中）
        root.backend.stat(std::path::Path::new("a.txt")).await.unwrap();
        let reqs = transport.recorded_requests();
        assert_eq!(
            reqs[0].url,
            "http://ak:sk@127.0.0.1:9000/b1/a.txt",
            "backend 用原 endpoint"
        );
    }

    // ---------- 就绪协议（plan 2026-10-19 Task 1） ----------

    /// wire 契约锁定：壳侧（Task 2）按行首 strip_prefix("VV_READY port=") 解析，
    /// 输出不得携带时间戳/等级等任何装饰。
    #[test]
    fn ready_line_wire_format_is_exact() {
        assert_eq!(ready_line(8321), "VV_READY port=8321");
        assert_eq!(ready_line(0), "VV_READY port=0");
        assert_eq!(ready_line(u16::MAX), "VV_READY port=65535");
    }
}
