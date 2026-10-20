//! vviewer server CLI 入口。

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use clap::{Parser, Subcommand};

use vviewer::state::{MountMeta, MountRoot};
use vviewer_storage::s3::{S3Backend, S3MountConfig};
use vviewer_storage::transport::{HttpTransport, ReqwestTransport};
use vviewer_storage::webdav::{WebDavBackend, WebDavMountConfig};

mod config;
use config::{MountConfig, MountKind, DEFAULT_PORT, load_file_config, resolve_config};

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

/// 挂载后端构造（spec §2 装配链）： MountConfig → (backend, 元信息)。per-kind
/// 必填校验在此（config.rs 只做字面解析，见其模块注）——错误消息含挂载序号与
/// 字段名（与 resolve_config 的报错约定一致），serve 统一 exit 2。
fn build_mount_roots(
    mounts: &[MountConfig],
) -> Result<Vec<MountRoot>, String> {
    if mounts.is_empty() {
        return Ok(Vec::new());
    }
    // reqwest transport 实例全挂载共享一个 Arc（连接池复用；无挂载不构建）
    let transport: Arc<dyn HttpTransport> = Arc::new(
        ReqwestTransport::new()
            .map_err(|e| format!("http transport init: {}", e.message()))?,
    );
    mounts
        .iter()
        .enumerate()
        .map(|(i, m)| {
            build_mount(m, transport.clone())
                .map_err(|e| format!("mount #{i}: {e}"))
        })
        .collect()
}

/// 展示面 endpoint 的 userinfo 剥除（评审 M1）：`https://user:pass@host/path`
/// → `https://host/path`——WebDAV/S3 误配置把凭据写进 endpoint 时，明文凭据
/// 不得流入免鉴权可读的 `/api/health` 回显与 MountMeta/RootSpec 的 Debug 面。
///
/// 识别口径（RFC 3986 authority 语义）：userinfo 以 authority 段（首个 `/`
/// 之前）内的首个 `@` 分隔——path 段含 `@` 不误剥；无 scheme 形态（storage
/// 侧按 https 兜底可连）同样收口。`@` 不存在或 userinfo 为空（`https://@host`
/// 无可泄漏物）原样返回。
///
/// **只影响展示面**：后端构造（S3MountConfig/WebDavMountConfig）用原值——
/// userinfo 凭据是连接所需，剥除会让挂载静默连不上。
fn display_endpoint(endpoint: &str) -> String {
    let (prefix, rest) = match endpoint.split_once("://") {
        Some((scheme, rest)) => (format!("{scheme}://"), rest),
        None => (String::new(), endpoint),
    };
    let authority = rest.split('/').next().unwrap_or(rest);
    match authority.split_once('@') {
        Some((userinfo, host)) if !userinfo.is_empty() => {
            format!("{prefix}{host}{}", &rest[authority.len()..])
        }
        _ => endpoint.to_owned(),
    }
}

fn build_mount(
    cfg: &MountConfig,
    transport: Arc<dyn HttpTransport>,
) -> Result<MountRoot, String> {
    /// Option 字段必填校验（错误消息含字段名）。
    fn required<T>(field: Option<T>, name: &str, kind: &str) -> Result<T, String> {
        field.ok_or_else(|| format!("{kind} mount: missing required field `{name}`"))
    }
    match cfg.kind {
        MountKind::S3 => {
            let kind = "s3";
            let endpoint = required(cfg.endpoint.clone(), "endpoint", kind)?;
            let bucket = required(cfg.bucket.clone(), "bucket", kind)?;
            let access_key_id = required(cfg.access_key_id.clone(), "access_key_id", kind)?;
            let secret_access_key =
                required(cfg.secret_access_key.clone(), "secret_access_key", kind)?;
            let prefix = cfg.prefix.clone().unwrap_or_default();
            // path_style 缺省 true（Global Constraints 的 path-style URL 形态）
            let path_style = cfg.path_style.unwrap_or(true);
            let backend = S3Backend::new(
                S3MountConfig {
                    endpoint: endpoint.clone(),
                    bucket: bucket.clone(),
                    prefix: prefix.clone(),
                    access_key_id,
                    secret_access_key,
                    path_style,
                },
                transport,
            );
            Ok(MountRoot {
                backend: Arc::new(backend),
                meta: MountMeta {
                    kind: "s3",
                    label: cfg.label.clone(),
                    // 展示面脱敏（评审 M1）；连接面（上方 backend）用原值
                    endpoint: display_endpoint(&endpoint),
                    bucket: Some(bucket),
                    prefix,
                },
            })
        }
        MountKind::WebDav => {
            let kind = "webdav";
            let endpoint = required(cfg.endpoint.clone(), "endpoint", kind)?;
            let username = required(cfg.username.clone(), "username", kind)?;
            let password = required(cfg.password.clone(), "password", kind)?;
            let prefix = cfg.prefix.clone().unwrap_or_default();
            let backend = WebDavBackend::new(
                WebDavMountConfig {
                    endpoint: endpoint.clone(),
                    prefix: prefix.clone(),
                    username,
                    password,
                },
                transport,
            );
            Ok(MountRoot {
                backend: Arc::new(backend),
                meta: MountMeta {
                    kind: "webdav",
                    label: cfg.label.clone(),
                    // 展示面脱敏（评审 M1）；连接面（上方 backend）用原值
                    endpoint: display_endpoint(&endpoint),
                    bucket: None,
                    prefix,
                },
            })
        }
    }
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
    let sock = SocketAddr::new(ip, args.port.unwrap_or(DEFAULT_PORT));

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
        tracing::info!("vviewer listening on http://{sock}");
        axum::serve(listener, app).await.map_err(|e| {
            eprintln!("error: server failure: {e}");
            2
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

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

    // ---------- 评审 M1：展示面 endpoint userinfo 剥除 ----------

    #[test]
    fn display_endpoint_strips_userinfo_credentials() {
        // WebDAV 已知误配置形态：凭据写在 endpoint
        assert_eq!(
            display_endpoint("https://user:pass@dav.example.com/dav"),
            "https://dav.example.com/dav"
        );
        // path-style S3 误配置：凭据在 endpoint（无 path 段）
        assert_eq!(
            display_endpoint("http://AKIA:topsecret@127.0.0.1:9000"),
            "http://127.0.0.1:9000"
        );
        // 无 scheme 形态（storage 侧按 https 兜底可连）同样收口
        assert_eq!(
            display_endpoint("user:pass@dav.example.com"),
            "dav.example.com"
        );
    }

    #[test]
    fn display_endpoint_keeps_credential_free_endpoints() {
        assert_eq!(
            display_endpoint("http://127.0.0.1:9000"),
            "http://127.0.0.1:9000"
        );
        assert_eq!(
            display_endpoint("https://dav.example.com/dav"),
            "https://dav.example.com/dav"
        );
        // path 段含 '@' 不误剥（userinfo 只在 authority 段识别）
        assert_eq!(
            display_endpoint("https://dav.example.com/a@b/c"),
            "https://dav.example.com/a@b/c"
        );
        // 空 userinfo（https://@host）无可泄漏物，原样
        assert_eq!(display_endpoint("https://@dav.example.com"), "https://@dav.example.com");
    }

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
}
