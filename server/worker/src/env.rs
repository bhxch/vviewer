//! VV_TOKEN 装配纪律的纯函数面（host 编译、native 单测覆盖——`Env` 读取面
//! 在 wasm 门控的 `state.rs`，纯决策抽出至此可测）。
//!
//! **fail-closed（终审 I-1）**：Workers 形态天然公网可达，`core.token = None`
//! 时 dispatch 的 authorize 全放行（native auth_mw 同构语义）——「无 token」
//! 几乎总是误配置而非有意裸奔，系统应在装配期失败关闭而非静默开放。与
//! native「`--allow-lan` 必须 token 否则拒绝启动（exit 2）」是等价精神的
//! 不同实现：公网暴露面必须显式配置鉴权，误配置失败关闭。错误消息指引
//! `wrangler secret put VV_TOKEN`（Secret 通道纪律，见 server/README.md
//! 「Workers 部署/配置面」）。

/// VV_TOKEN 装配校验：`None`/空串/全空白 → Err（fail-closed，消息含修复指
/// 引）；`Some(非空白)` → Ok(原值)——字面原样透传不 trim（与 native token
/// 字面语义一致，全空白视同缺失仅因空令牌不可用）。
pub fn require_token(raw: Option<String>) -> Result<String, String> {
    match raw {
        Some(token) if !token.trim().is_empty() => Ok(token),
        _ => Err("VV_TOKEN is required: this Workers deployment refuses to \
                  serve without it (fail-closed). Set it with `wrangler secret \
                  put VV_TOKEN`"
            .to_string()),
    }
}

/// VV_KROKI_HOST 装配校验（spec 2026-10-23 §8.2；fail-closed 纪律与
/// [`require_token`] 同源）：`None`（未配置）→ Ok(core 缺省
/// `DEFAULT_KROKI_HOST`)；`Some(非空白且 http(s):// 前缀)` → Ok(字面原样，
/// 不 trim)；**显式给了但形态非法**（空白串/缺 http(s):// 前缀）→ Err——
/// 显式无效值 ≠ 未配置，静默兜底会掩盖部署侧误配（SSRF 防线：上游 host 只
/// 来自部署侧配置，装配期失败关闭）。与 native `--kroki-host` 的启动校验链
/// 同一规则（validate_startup）。
pub fn resolve_kroki_host(raw: Option<String>) -> Result<String, String> {
    match raw {
        None => Ok(vviewer_core::kroki::DEFAULT_KROKI_HOST.to_string()),
        Some(host)
            if !host.trim().is_empty()
                && (host.starts_with("http://") || host.starts_with("https://")) =>
        {
            Ok(host)
        }
        Some(_) => Err("VV_KROKI_HOST is invalid: must be a non-empty http(s):// \
                        URL (e.g. https://kroki.io); this deployment refuses to \
                        start with an invalid kroki upstream host (fail-closed)"
            .to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::{require_token, resolve_kroki_host};

    #[test]
    fn missing_token_fails_closed_with_guidance() {
        // None（未配置/未部署 secret）：装配拒绝，消息指明变量名与 Secret 命令
        let err = require_token(None).unwrap_err();
        assert!(err.contains("VV_TOKEN"), "{err}");
        assert!(err.contains("wrangler secret put VV_TOKEN"), "{err}");
        // 空串/全空白等同缺失（空令牌语义上不可用）
        assert!(require_token(Some(String::new())).is_err());
        assert!(require_token(Some("  \n\t".into())).is_err());
    }

    #[test]
    fn present_token_passes_through() {
        // 有 VV_TOKEN：装配通过，字面原样透传（不 trim——与 native 一致）
        assert_eq!(require_token(Some("sekret".into())).unwrap(), "sekret");
    }

    // ---------- VV_KROKI_HOST（spec 2026-10-23 §8.2） ----------

    #[test]
    fn missing_kroki_host_falls_back_to_core_default() {
        // None = 未配置 → core 缺省（公开 kroki.io）
        assert_eq!(
            resolve_kroki_host(None).unwrap(),
            vviewer_core::kroki::DEFAULT_KROKI_HOST
        );
    }

    #[test]
    fn valid_kroki_host_passes_through_verbatim() {
        // http/https 皆可；字面原样透传不 trim（与 token 字面语义一致）
        assert_eq!(resolve_kroki_host(Some("https://kroki.io".into())).unwrap(), "https://kroki.io");
        assert_eq!(
            resolve_kroki_host(Some("http://127.0.0.1:8081/".into())).unwrap(),
            "http://127.0.0.1:8081/"
        );
    }

    #[test]
    fn invalid_kroki_host_fails_closed() {
        // 显式空白串 ≠ 未配置——静默兜底会掩盖误配（I-1 fail-closed 先例形态）
        for bad in ["", "   ", "kroki.io", "ftp://kroki.io", "//kroki.io"] {
            let err = resolve_kroki_host(Some(bad.to_string())).unwrap_err();
            assert!(err.contains("VV_KROKI_HOST"), "bad={bad} err={err}");
            assert!(err.contains("fail-closed"), "bad={bad} err={err}");
        }
    }
}
