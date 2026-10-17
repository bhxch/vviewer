//! path 参数安全解析：清洗（绝对路径/`..` 段拒绝）+ canonicalize 越界校验。

use std::path::PathBuf;

use crate::error::AppError;
use crate::state::AppState;

/// 将 `/api/tree`、`/api/file` 的相对 path 参数清洗为 root 下的路径。
///
/// - 空参数 → root 本身；
/// - 绝对路径、`..` 段、NUL 字节 → 400；
/// - 空段与 `.` 段跳过（`a//b`、`./a` 合法）。
pub fn clean_relative(root: &std::path::Path, raw: Option<&str>) -> Result<PathBuf, AppError> {
    let raw = raw.unwrap_or("");
    if raw.starts_with('/') {
        return Err(AppError::bad_request("path must be relative to root"));
    }
    // NUL 字节前置拒绝（BUG-46）：任何 fs 调用都必然以 InvalidInput 失败，
    // 前置拦截使错误归 400 且不携带 errno 文本
    if raw.as_bytes().contains(&b'\0') {
        return Err(AppError::bad_request("path contains NUL byte"));
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

/// canonicalize 失败的错误分类（BUG-46）：调用方可构造的病态输入归 4xx，
/// 不再一律 500 附 errno 文本（误导监控与重试语义）。
/// - NotFound → 404（既有语义）；
/// - InvalidInput（NUL 直达 fs 的防御位）→ 400；
/// - ENAMETOOLONG(Linux 36) → 400（超长名是请求侧构造）；
/// - ELOOP(Linux 40，root 内自环 symlink) → 404（路径不可解析为可用资源）；
/// - 其余（权限、IO 等真环境故障）保持 500。
fn classify_canonicalize_error(e: std::io::Error) -> AppError {
    match e.kind() {
        std::io::ErrorKind::NotFound => AppError::not_found("path not found"),
        std::io::ErrorKind::InvalidInput => AppError::bad_request("path contains NUL byte"),
        _ => match e.raw_os_error() {
            // Linux errno 常量按数值匹配（避免引入 libc 依赖；POSIX 固定值）。
            // kind() 的 io_error_more 映射（InvalidFilename/FilesystemLoop）随
            // Rust 版本漂移，raw_os_error 才是稳定判据。
            Some(36) => AppError::bad_request("file name too long"),
            Some(40) => AppError::not_found("path contains a symlink loop"),
            _ => AppError::internal(e.to_string()),
        },
    }
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

    let canonical = tokio::fs::canonicalize(&joined)
        .await
        .map_err(classify_canonicalize_error)?;

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

    /// BUG-46 错误分类锁测：NUL/超长归 400、自环 symlink 归 404、
    /// 其余 errno（权限等）保持 500（真内部故障不得被掩盖为客户端错误）。
    #[test]
    fn canonicalize_error_classification_maps_pathological_input_to_4xx() {
        use axum::http::StatusCode;

        // NUL 字节：fs 层 InvalidInput（无 errno）→ 400
        let nul = classify_canonicalize_error(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "file name contained an unexpected NUL byte",
        ));
        assert_eq!(nul.0, StatusCode::BAD_REQUEST);

        // ENAMETOOLONG(36) / ELOOP(40)：按 raw_os_error 数值 → 400 / 404
        let too_long = classify_canonicalize_error(std::io::Error::from_raw_os_error(36));
        assert_eq!(too_long.0, StatusCode::BAD_REQUEST);
        let symlink_loop = classify_canonicalize_error(std::io::Error::from_raw_os_error(40));
        assert_eq!(symlink_loop.0, StatusCode::NOT_FOUND);

        // EACCES(13)：环境故障 → 500（分类面不外溢）
        let perm = classify_canonicalize_error(std::io::Error::from_raw_os_error(13));
        assert_eq!(perm.0, StatusCode::INTERNAL_SERVER_ERROR);
    }

    /// BUG-46 NUL 前置拦截：clean_relative 对含 NUL 的 path 参数直接 400，
    /// 不依赖 fs 层 InvalidInput。
    #[test]
    fn clean_relative_rejects_nul_byte() {
        let err = clean_relative(std::path::Path::new("/tmp"), Some("a\0b")).unwrap_err();
        assert_eq!(err.0, axum::http::StatusCode::BAD_REQUEST);
        assert_eq!(err.1, "path contains NUL byte");
    }
}
