//! vviewer server CLI 入口（薄壳）：clap CLI 解析 + 装配链调用。serve 装配链
//! （启动校验/挂载装配/bind/就绪行/runtime 编排）在 [`vviewer::assembly`]，
//! `--config` TOML 解析合并在 [`vviewer::config`]——两者均已升 lib 面（装配
//! 可测化），本文件不持装配逻辑（CLI 语义与 exit code 契约逐字保持）。

use std::path::PathBuf;

use clap::{Parser, Subcommand};

use vviewer::assembly::{ServeArgs, serve};
use vviewer::config::{load_file_config, resolve_config};

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
        /// kroki 转发上游 host（/api/kroki 的 SSRF 防线——host 只来自部署侧
        /// 配置；默认 https://kroki.io，非法值启动即拒）
        #[arg(long)]
        kroki_host: Option<String>,
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
            kroki_host,
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
                kroki_host,
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
