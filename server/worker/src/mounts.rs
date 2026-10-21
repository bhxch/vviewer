//! VV_MOUNTS env JSON 解析（多端发布阶段三 Task 2）：worker 形态的静态挂载
//! 配置源。plan Global Constraints：**env JSON 结构同 TOML `[[mount]]`**——
//! 即 `POST /api/mounts` 请求体的同形态数组，直接复用
//! [`vviewer_core::mounts::MountConfig`]（serde：`deny_unknown_fields` 把
//! typo 字段挡在解析期，与 TOML 配置同款错误面）。
//!
//! 读取通道（`state.rs`）：`env.var`（wrangler.toml `[vars]`/dashboard）→
//! `env.secret`（Wrangler Secrets，**推荐通道**——凭据走 Secrets 纪律，
//! 整份 JSON 含凭据时按 Secret 配置）。解析失败/字段缺失的错误消息仅含
//! 字段名（`build_mount` 错误面纪律，凭据不进错误/日志）。

use vviewer_core::mounts::MountConfig;

/// 解析 VV_MOUNTS JSON 字符串 → 挂载配置列表。
///
/// 形态：JSON 数组（TOML `[[mount]]` 的 env 等价物）：
/// `[{"kind":"s3","endpoint":"...","bucket":"...","access_key_id":"...",
///   "secret_access_key":"..."}, ...]`
///
/// 空串/空白 = 无挂载（纯 mounts API 动态注册形态）；缺 `kind` 或含未知
/// 字段 → Err（消息含字段名，不含值——值面可能携带凭据）。
pub fn parse_mounts_json(json: &str) -> Result<Vec<MountConfig>, String> {
    let trimmed = json.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }
    serde_json::from_str::<Vec<MountConfig>>(trimmed)
        .map_err(|e| format!("VV_MOUNTS: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use vviewer_core::mounts::MountKind;

    #[test]
    fn parses_s3_and_webdav_entries() {
        let json = r#"[
            {"kind":"s3","label":"docs","endpoint":"http://127.0.0.1:9000",
             "bucket":"b1","prefix":"sub","access_key_id":"ak","secret_access_key":"sk",
             "path_style":true},
            {"kind":"webdav","endpoint":"https://dav.example.com/dav",
             "username":"u","password":"p"}
        ]"#;
        let mounts = parse_mounts_json(json).unwrap();
        assert_eq!(mounts.len(), 2);
        assert_eq!(mounts[0].kind, MountKind::S3);
        assert_eq!(mounts[0].bucket.as_deref(), Some("b1"));
        assert_eq!(mounts[0].path_style, Some(true));
        assert_eq!(mounts[1].kind, MountKind::WebDav);
        assert_eq!(mounts[1].username.as_deref(), Some("u"));
    }

    #[test]
    fn empty_string_means_no_mounts() {
        assert!(parse_mounts_json("").unwrap().is_empty());
        assert!(parse_mounts_json("  \n ").unwrap().is_empty());
    }

    #[test]
    fn missing_kind_and_unknown_fields_are_rejected_with_field_names() {
        // 缺 kind（deny_unknown_fields/serde 枚举解析期把关）
        let err = parse_mounts_json(r#"[{"endpoint":"http://x"}]"#).unwrap_err();
        assert!(err.contains("kind"), "{err}");
        // 未知字段（typo 防线，与 TOML 配置同款拒绝面）
        let err = parse_mounts_json(r#"[{"kind":"s3","bucketn":"b"}]"#).unwrap_err();
        assert!(err.contains("bucketn"), "{err}");
        // 非数组形态（单对象）拒绝
        assert!(parse_mounts_json(r#"{"kind":"s3"}"#).is_err());
    }

    #[test]
    fn parse_error_faces_name_fields_not_values() {
        // 凭据三不纪律的解析错误面：常见配置缺陷（缺 kind/未知字段/非数组）
        // 的错误消息只含字段名/形态描述。注记：字段**类型**错误（如凭据误写
        // 为数字）的 serde 消息会回显字面量——M-3 后装配错误对外统一通用 500
        // （entry.rs），本消息仅进运行时日志（console_error），不再构成访客
        // 可见面；凭据按 Secret 通道配置（state.rs env_string）即为正确形态。
        let err = parse_mounts_json(r#"[{"endpoint":"http://x"}]"#).unwrap_err();
        assert!(err.contains("kind"), "{err}");
        assert!(!err.contains("http://x"), "{err}");

        let err = parse_mounts_json(r#"[{"kind":"s3","bucketn":"b"}]"#).unwrap_err();
        assert!(err.contains("bucketn"), "{err}");

        let err = parse_mounts_json(r#"{"kind":"s3"}"#).unwrap_err();
        assert!(err.contains("invalid type"), "{err}");
    }
}
