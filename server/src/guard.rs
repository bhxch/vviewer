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

/// root 越界 400 的单一事实源（WSX 观察 1）：guard 前置拒绝与各 handler 的防御式
/// 分支（search 的 parser_roots 取根等）共用同一构造，文案不得漂移——reachable 面
/// 形状由 WSX-02 / MRF-02 e2e 与本模块单测锁定。
pub(crate) fn root_out_of_range(idx: usize) -> AppError {
    AppError::bad_request(format!("root index out of range: {idx}"))
}

/// [`resolve`] 的多根参数化形态：按 `root_idx` 选择基准根。
/// 越界 → 400 "root index out of range"；清洗与越界校验均对所选根。
pub async fn resolve_at(
    state: &AppState,
    raw: Option<&str>,
    root_idx: usize,
) -> Result<PathBuf, AppError> {
    let root = state
        .roots
        .get(root_idx)
        .ok_or_else(|| root_out_of_range(root_idx))?;
    let joined = clean_relative(&root.raw, raw)?;

    let canonical = tokio::fs::canonicalize(&joined).await.map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => AppError::not_found("path not found"),
        _ => AppError::internal(e.to_string()),
    })?;

    if !canonical.starts_with(&root.canonical) {
        // symlink 等手段越出 root（含 root 自身之外的一切目标）
        // TOCTOU：canonicalize 与后续 fs 操作之间的 symlink 竞态窗口为已知已接受风险。
        return Err(AppError::forbidden("path escapes root"));
    }
    Ok(canonical)
}

/// 完整解析（0 号根）：清洗 → canonicalize（不存在 → 404）→ 越出 root → 403。
/// 返回 canonical 路径，handler 后续 fs 操作都基于它。
pub async fn resolve(state: &AppState, raw: Option<&str>) -> Result<PathBuf, AppError> {
    resolve_at(state, raw, 0).await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 越界文案单一事实源锁测（WSX 观察 1）：guard 前置拒绝与 search 防御分支
    /// 共用本构造，reachable 面（WSX-02/MRF-02 e2e）形状即此，不得漂移。
    #[test]
    fn root_out_of_range_message_is_canonical() {
        let err = root_out_of_range(2);
        assert_eq!(err.0, axum::http::StatusCode::BAD_REQUEST);
        assert_eq!(err.1, "root index out of range: 2");
    }
}
