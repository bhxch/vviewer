//! path 参数安全解析（Task 2：清洗；Task 3 追加 canonicalize 越界校验）。

use std::path::PathBuf;

use crate::error::AppError;
use crate::state::AppState;

/// 将 `/api/tree`、`/api/file` 的相对 path 参数清洗为 root 下的路径。
///
/// - 空参数 → root 本身；
/// - 绝对路径、`..` 段 → 400；
/// - 空段与 `.` 段跳过（`a//b`、`./a` 合法）。
pub fn clean_relative(root: &std::path::Path, raw: Option<&str>) -> Result<PathBuf, AppError> {
    let raw = raw.unwrap_or("");
    if raw.starts_with('/') {
        return Err(AppError::bad_request("path must be relative to root"));
    }
    let mut out = root.to_path_buf();
    for comp in raw.split('/') {
        match comp {
            "" | "." => continue,
            ".." => return Err(AppError::bad_request("path must not contain '..'")),
            c => out.push(c),
        }
    }
    Ok(out)
}

/// handler 入口用的异步解析占位：Task 3 在此追加 `tokio::fs::canonicalize` +
/// `starts_with(root_canonical)` 越界校验（symlink 等）。
pub async fn resolve(state: &AppState, raw: Option<&str>) -> Result<PathBuf, AppError> {
    clean_relative(&state.root, raw)
}
