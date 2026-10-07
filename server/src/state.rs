//! 共享应用状态。

use std::path::PathBuf;

/// 传给所有 handler 的共享状态。
#[derive(Clone)]
pub struct AppState {
    /// `--root` 原始路径。
    pub root: PathBuf,
    /// `--web-dist` 前端静态产物目录；未指定时 `/` 返回占位页。
    pub web_dist: Option<PathBuf>,
    /// 访问令牌；None 表示免鉴权（仅默认 127.0.0.1 绑定时允许）。
    pub token: Option<String>,
    /// `--hidden`：隐藏 dot 开头条目。
    pub hidden: bool,
}

impl AppState {
    pub fn new(root: PathBuf, web_dist: Option<PathBuf>, token: Option<String>, hidden: bool) -> Self {
        Self { root, web_dist, token, hidden }
    }
}
