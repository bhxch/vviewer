//! vviewer server CLI 入口。

use std::net::SocketAddr;
use std::path::PathBuf;

use clap::{Parser, Subcommand};
use rand::RngCore;

/// 生成 32 字节随机 hex 令牌（CLI `--token-gen` 与 ticket 共用格式）。
pub fn generate_token() -> String {
    let mut buf = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut buf);
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

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
        /// 要暴露的根目录
        #[arg(long)]
        root: PathBuf,
        /// 前端构建产物目录（SvelteKit adapter-static build），挂载于 `/`
        #[arg(long)]
        web_dist: Option<PathBuf>,
        /// 监听端口
        #[arg(long, default_value_t = 8321)]
        port: u16,
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
        /// 允许来自该精确 origin 的跨域 API 访问（Task 3 生效）
        #[arg(long)]
        cors_origin: Option<String>,
    },
}

fn main() {
    let cli = Cli::parse();
    match cli.command {
        Command::Serve {
            root,
            web_dist,
            port,
            token,
            token_gen,
            allow_lan,
            hidden,
            cors_origin: _cors_origin, // Task 3 接线
        } => {
            if let Err(code) = serve(ServeArgs {
                root,
                web_dist,
                port,
                token,
                token_gen,
                allow_lan,
                hidden,
            }) {
                std::process::exit(code);
            }
        }
    }
}

pub struct ServeArgs {
    pub root: PathBuf,
    pub web_dist: Option<PathBuf>,
    pub port: u16,
    pub token: Option<String>,
    pub token_gen: bool,
    pub allow_lan: bool,
    pub hidden: bool,
}

/// 启动服务；配置错误返回 exit code（不 panic）。
fn serve(args: ServeArgs) -> Result<(), i32> {
    let token = if args.token_gen {
        let t = generate_token();
        println!("{t}");
        Some(t)
    } else {
        args.token
    };

    if args.allow_lan && token.is_none() {
        eprintln!("error: --allow-lan exposes the server to your network and requires --token or --token-gen");
        return Err(2);
    }

    let root = if args.root.is_dir() {
        args.root
    } else {
        eprintln!("error: --root is not a directory: {}", args.root.display());
        return Err(2);
    };

    if let Some(dist) = &args.web_dist {
        if !dist.is_dir() {
            eprintln!("error: --web-dist is not a directory: {}", dist.display());
            return Err(2);
        }
    }

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    // bind：--allow-lan ? 0.0.0.0 : 127.0.0.1
    let ip: std::net::IpAddr = if args.allow_lan {
        std::net::Ipv4Addr::UNSPECIFIED.into()
    } else {
        std::net::Ipv4Addr::LOCALHOST.into()
    };
    let sock = SocketAddr::new(ip, args.port);

    let state = vviewer::state::AppState::new(root, args.web_dist, token, args.hidden);
    let app = vviewer::build_router(state);

    let runtime = tokio::runtime::Runtime::new().map_err(|e| {
        eprintln!("error: failed to start tokio runtime: {e}");
        2
    })?;
    runtime.block_on(async move {
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
