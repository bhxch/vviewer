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

#[cfg(test)]
mod tests {
    use super::require_token;

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
}
