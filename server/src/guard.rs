//! path 参数安全解析：清洗（绝对路径/`..` 段拒绝）+ canonicalize 越界校验。

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

/// 完整解析：清洗 → canonicalize（不存在 → 404）→ 越出 root → 403。
/// 返回 canonical 路径，handler 后续 fs 操作都基于它。
pub async fn resolve(state: &AppState, raw: Option<&str>) -> Result<PathBuf, AppError> {
    let joined = clean_relative(&state.root, raw)?;

    let canonical = tokio::fs::canonicalize(&joined).await.map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => AppError::not_found("path not found"),
        _ => AppError::internal(e.to_string()),
    })?;

    if !canonical.starts_with(&state.root_canonical) {
        // symlink 等手段越出 root（含 root 自身之外的一切目标）
        // TOCTOU：canonicalize 与后续 fs 操作之间的 symlink 竞态窗口为已知已接受风险。
        return Err(AppError::forbidden("path escapes root"));
    }
    Ok(canonical)
}
