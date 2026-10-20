//! vviewer server CLI 入口。

use std::net::SocketAddr;
use std::path::PathBuf;

use clap::{Parser, Subcommand};

mod config;
use config::{DEFAULT_PORT, load_file_config, resolve_config};

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
            let resolved = match resolve_config(cli_args, file) {
                Ok(r) => r,
                Err(e) => {
                    eprintln!("error: {e}");
                    std::process::exit(2);
                }
            };
            // Task 5 前挂载不接线：resolved.mounts 随合并产物承载，本任务不消费
            if let Err(code) = serve(resolved.into()) {
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

/// 启动服务；配置错误返回 exit code（不 panic）。
fn serve(args: ServeArgs) -> Result<(), i32> {
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

    #[test]
    fn empty_token_is_rejected() {
        // 空 token 启动即拒（exit 2），先于 root 校验（root 故意指向不存在路径）
        assert_eq!(serve(args(Some(String::new()))), Err(2));
    }

    #[test]
    fn empty_root_list_is_rejected() {
        // 多值 --root 后缺根同样启动即拒（exit 2）
        let mut a = args(None);
        a.root.clear();
        assert_eq!(serve(a), Err(2));
    }

    #[test]
    fn wildcard_cors_origin_is_rejected_cleanly() {
        // BUG-45：'*' 直传 AllowOrigin::list 会在 bind 前库内 panic（exit 101）；
        // 修复后启动即以配置错误退出（exit 2），且先于 root 校验无关紧要——
        // args() 的 root 故意指向不存在路径，只要 Err(2) 即达验收。
        let mut a = args(None);
        a.cors_origin = Some("*".to_string());
        assert_eq!(serve(a), Err(2));
        // 通配形态变体同拒（防御不限于裸 '*'）
        let mut a = args(None);
        a.cors_origin = Some("http://*.example.com".to_string());
        assert_eq!(serve(a), Err(2));
    }
}
