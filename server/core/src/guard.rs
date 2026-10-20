//! path 参数安全解析：清洗（绝对路径/`..` 段/NUL 拒绝）+ canonicalize 越界校验
//! + 非 UTF-8 文件名 `%XX` 形态的寻址回退。
//!
//! 多端发布阶段二 Task 2 自适配层 `vviewer/src/guard.rs` 业务体原样迁入：
//! 消费状态核 [`CoreState`]，错误面 [`CoreError`]（适配层包装为 AppError，
//! search/compute 等未迁移域经包装按迁移前签名消费）。

use std::path::PathBuf;

use crate::error::CoreError;
use crate::state::CoreState;

/// 将 `/api/tree`、`/api/file` 的相对 path 参数清洗为 root 下的路径。
///
/// - 空参数 → root 本身；
/// - 绝对路径、`..` 段、NUL 字节 → 400；
/// - 空段与 `.` 段跳过（`a//b`、`./a` 合法）。
pub fn clean_relative(root: &std::path::Path, raw: Option<&str>) -> Result<PathBuf, CoreError> {
    let raw = raw.unwrap_or("");
    if raw.starts_with('/') {
        return Err(CoreError::bad_request("path must be relative to root"));
    }
    // NUL 字节前置拒绝（BUG-46）：任何 fs 调用都必然以 InvalidInput 失败，
    // 前置拦截使错误归 400 且不携带 errno 文本
    if raw.as_bytes().contains(&b'\0') {
        return Err(CoreError::bad_request("path contains NUL byte"));
    }
    let mut out = root.to_path_buf();
    for comp in raw.split('/') {
        match comp {
            "" | "." => continue,
            ".." => return Err(CoreError::bad_request("path must not contain '..'")),
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
fn classify_canonicalize_error(e: std::io::Error) -> CoreError {
    match e.kind() {
        std::io::ErrorKind::NotFound => CoreError::not_found("path not found"),
        std::io::ErrorKind::InvalidInput => CoreError::bad_request("path contains NUL byte"),
        _ => match e.raw_os_error() {
            // Linux errno 常量按数值匹配（避免引入 libc 依赖；POSIX 固定值）。
            // kind() 的 io_error_more 映射（InvalidFilename/FilesystemLoop）随
            // Rust 版本漂移，raw_os_error 才是稳定判据。
            Some(36) => CoreError::bad_request("file name too long"),
            Some(40) => CoreError::not_found("path contains a symlink loop"),
            _ => CoreError::internal(e.to_string()),
        },
    }
}

/// root 越界 400 的单一事实源（WSX 观察 1）：guard 前置拒绝与各 handler 的防御式
/// 分支（search 的 parser_roots 取根等）共用同一构造，文案不得漂移——reachable 面
/// 形状由 WSX-02 / MRF-02 e2e 与本模块单测锁定。
pub fn root_out_of_range(idx: usize) -> CoreError {
    CoreError::bad_request(format!("root index out of range: {idx}"))
}

/// 十六进制位 → 数值（严格大小写混合 hex，不接受 +/- 符号）。
fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// 组件级 `%XX`→字节解码（BUG-48 寻址回退的构件，与 tree 列出侧
/// `encode_invalid_utf8` 互逆）：至少成功解码一处才返回 Some；`%` 后非
/// 严格两位 hex 的序列按字面保留。
fn percent_decode_bytes(comp: &str) -> Option<Vec<u8>> {
    let bytes = comp.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    let mut decoded = false;
    while i < bytes.len() {
        let hex = if bytes[i] == b'%'
            && i + 3 <= bytes.len()
            && bytes[i + 1].is_ascii_hexdigit()
            && bytes[i + 2].is_ascii_hexdigit()
        {
            Some((hex_val(bytes[i + 1]), hex_val(bytes[i + 2])))
        } else {
            None
        };
        match hex {
            Some((Some(hi), Some(lo))) => {
                out.push(hi * 16 + lo);
                i += 3;
                decoded = true;
            }
            _ => {
                out.push(bytes[i]);
                i += 1;
            }
        }
    }
    decoded.then_some(out)
}

/// 路径级 `%XX` 解码重写（BUG-48）：tree 列出的非 UTF-8 名以 `%XX` 形态
/// 返回，其字面路径不存在；字面 canonicalize NotFound 后按组件解码重试。
/// 任一组件解码结果引入路径语法（`/`、`\`、NUL）或等于 `..` → 400（否则
/// 可借 `%2E%2E` 绕过 clean_relative 的穿越校验）。无组件可解码 → None
/// （不重试，按原 404 报错）。
fn percent_decoded_path(p: &std::path::Path) -> Result<Option<PathBuf>, CoreError> {
    use std::os::unix::ffi::OsStringExt;
    let mut out = PathBuf::with_capacity(p.as_os_str().len());
    let mut changed = false;
    for comp in p.components() {
        let os = comp.as_os_str();
        match os.to_str() {
            Some(s) => {
                if let Some(decoded) = percent_decode_bytes(s) {
                    if decoded.contains(&b'/')
                        || decoded.contains(&b'\\')
                        || decoded.contains(&0)
                        || decoded == b".."
                    {
                        return Err(CoreError::bad_request(
                            "path must not contain '..' or path separators",
                        ));
                    }
                    changed = true;
                    out.push(std::ffi::OsString::from_vec(decoded));
                } else {
                    out.push(os);
                }
            }
            None => out.push(os),
        }
    }
    Ok(changed.then_some(out))
}

/// [`resolve_at`] 的多根参数化形态：按 `root_idx` 选择基准根。
/// 越界 → 400 "root index out of range"；清洗与越界校验均对所选根。
pub async fn resolve_at(
    state: &CoreState,
    raw: Option<&str>,
    root_idx: usize,
) -> Result<PathBuf, CoreError> {
    let root = state
        .roots
        .get(root_idx)
        .ok_or_else(|| root_out_of_range(root_idx))?;
    let joined = clean_relative(&root.raw, raw)?;

    let canonical = match tokio::fs::canonicalize(&joined).await {
        Ok(c) => c,
        // BUG-48 寻址回退：字面 NotFound 且含可解码组件 → `%XX` 解码重写后
        // 重试（仍失败按分类报错）；解码前先过 `..`/分隔符走私防护
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            match percent_decoded_path(&joined)? {
                Some(decoded) => tokio::fs::canonicalize(&decoded)
                    .await
                    .map_err(classify_canonicalize_error)?,
                None => return Err(classify_canonicalize_error(e)),
            }
        }
        Err(e) => return Err(classify_canonicalize_error(e)),
    };

    if !canonical.starts_with(&root.canonical) {
        // symlink 等手段越出 root（含 root 自身之外的一切目标）
        // TOCTOU：canonicalize 与后续 fs 操作之间的 symlink 竞态窗口为已知已接受风险。
        return Err(CoreError::forbidden("path escapes root"));
    }
    Ok(canonical)
}

/// 完整解析（0 号根）：清洗 → canonicalize（不存在 → 404）→ 越出 root → 403。
/// 返回 canonical 路径，handler 后续 fs 操作都基于它。
pub async fn resolve(state: &CoreState, raw: Option<&str>) -> Result<PathBuf, CoreError> {
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
        assert_eq!(err.0, http::StatusCode::BAD_REQUEST);
        assert_eq!(err.1, "root index out of range: 2");
    }

    /// BUG-46 错误分类锁测：NUL/超长归 400、自环 symlink 归 404、
    /// 其余 errno（权限等）保持 500（真内部故障不得被掩盖为客户端错误）。
    #[test]
    fn canonicalize_error_classification_maps_pathological_input_to_4xx() {
        use http::StatusCode;

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
        assert_eq!(err.0, http::StatusCode::BAD_REQUEST);
        assert_eq!(err.1, "path contains NUL byte");
    }

    /// BUG-48 组件级解码：与 tree 列出侧 `%XX` 编码互逆；无 `%HH` 序列
    /// （含字面 `%` 非法序列）不解码（None → 不触发回退重试）。
    #[test]
    fn percent_decode_bytes_roundtrips_fidelity_names() {
        assert_eq!(
            percent_decode_bytes("bad%FF%FEname.txt").unwrap(),
            b"bad\xff\xfename.txt".to_vec()
        );
        assert_eq!(percent_decode_bytes("a%2Bb%20c").unwrap(), b"a+b c".to_vec());
        // 无 % → None；字面 % 与非法 hex 序列按原样保留且不算解码成功
        assert_eq!(percent_decode_bytes("plain.txt"), None);
        assert_eq!(percent_decode_bytes("100%.txt"), None);
        assert_eq!(percent_decode_bytes("%ZZ"), None);
        // 混合：%2E 解码、%ZZ 字面
        assert_eq!(percent_decode_bytes("a%2Eb%ZZ").unwrap(), b"a.b%ZZ".to_vec());
    }

    /// BUG-48 路径级重写：可解码时重写整条路径；无组件可解码 → None。
    #[test]
    fn percent_decoded_path_rewrites_only_encoded_components() {
        use std::os::unix::ffi::OsStringExt;
        let p = std::path::Path::new("/root/dir/bad%FF%FEname.txt");
        let out = percent_decoded_path(p).unwrap().unwrap();
        assert_eq!(
            out,
            PathBuf::from(std::ffi::OsString::from_vec(
                b"/root/dir/bad\xff\xfename.txt".to_vec()
            ))
        );
        // 全组件无 %HH → None（resolve_at 不重试，保持 404）
        let p = std::path::Path::new("/root/plain.txt");
        assert!(percent_decoded_path(p).unwrap().is_none());
    }

    /// BUG-48 走私防护：解码结果不得引入 `..` / 路径分隔符 / NUL——
    /// `%2E%2E` 形态若放行可绕过 clean_relative 的穿越校验。
    #[test]
    fn percent_decoded_path_rejects_traversal_smuggling() {
        use http::StatusCode;
        for evil in ["/root/a/%2E%2E/b", "/root/a%2Fb", "/root/a%00b", "/root/%5C.."] {
            let err = percent_decoded_path(std::path::Path::new(evil)).unwrap_err();
            assert_eq!(err.0, StatusCode::BAD_REQUEST, "case: {evil}");
        }
    }
}
