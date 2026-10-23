//! kroki 转发域（spec 2026-10-23 §8.2）：转发不算计算——native/worker 双形态
//! 编译进（模块不挂 feature 门）。
//!
//! SSRF 防线：上游 host 只来自部署侧配置（native `--kroki-host` / worker
//! `VV_KROKI_HOST`，装配点在适配层），请求体仅 raw 源码；lang 白名单拦截
//! 路径注入。上游协议 POST `{host}/{lang}/svg`（text/plain）→ 200 SVG bytes。

use std::sync::Arc;

use crate::error::CoreError;

/// HTTP 传输接缝：kroki 上游转发由适配层注入（native reqwest / worker fetch），
/// 本域只消费抽象——纯逻辑（host 拼接 / lang 白名单 / raw 透传）可脱网测试。
/// `Arc<dyn>` dyn 分发形态与 storage 的 StorageBackend 同款（RPITIT 无法
/// `Arc<dyn>`，async-trait 生成 dyn 兼容 trait）。
#[async_trait::async_trait]
pub trait KrokiHttp: Send + Sync {
    /// POST text/plain `body` 到 `url`；2xx 返回响应字节，非 2xx 由实现方
    /// 映射 [`CoreError`]（状态码透传语义归适配层，本域不解释）。
    async fn post_text(&self, url: String, body: Vec<u8>) -> Result<Vec<u8>, CoreError>;
}

/// kroki 域状态：host 仅来自部署侧配置（SSRF 防线——客户端永不可指定上游），
/// `http` 为注入的传输接缝。
pub struct KrokiState {
    pub host: String,
    pub http: Arc<dyn KrokiHttp>,
}

/// lang 白名单：非空且仅 `[a-z0-9-]`。kroki 官方图语言（svgbob/graphviz/
/// plantuml/mermaid/dot/…）全在集内；`../`、query、大写变体（PlantUml）等
/// 路径注入一律挡下——lang 直接拼 URL path 段，白名单是唯一防线。
fn valid_lang(lang: &str) -> bool {
    !lang.is_empty()
        && lang.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// 转发渲染：POST `{host}/{lang}/svg`，body 即 raw 源码（不加工、不加包装），
/// 成功原样返回上游 SVG 字节。host 尾部斜杠归一——部署侧配置带不带尾斜杠
/// 皆可，lang 之外不引入任何路径段。
pub async fn render(state: &KrokiState, lang: &str, source: &[u8]) -> Result<Vec<u8>, CoreError> {
    if !valid_lang(lang) {
        return Err(CoreError::bad_request("invalid diagram language"));
    }
    let url = format!("{}/{}/svg", state.host.trim_end_matches('/'), lang);
    state.http.post_text(url, source.to_vec()).await
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::{KrokiHttp, KrokiState, render};
    use crate::error::CoreError;

    struct MockHttp {
        body: Vec<u8>,
        status_ok: bool,
    }

    #[async_trait::async_trait]
    impl KrokiHttp for MockHttp {
        async fn post_text(&self, url: String, body: Vec<u8>) -> Result<Vec<u8>, CoreError> {
            assert_eq!(url, "https://kroki.io/svgbob/svg"); // host 仅来自 state.host
            assert_eq!(body, b"+-->+".to_vec());
            if !self.status_ok {
                return Err(CoreError::bad_request("kroki 400"));
            }
            Ok(self.body.clone())
        }
    }

    #[tokio::test]
    async fn render_拼接_host_白名单_lang_透传_raw_body() {
        let st = KrokiState {
            host: "https://kroki.io/".into(),
            http: Arc::new(MockHttp { body: b"<svg/>".to_vec(), status_ok: true }),
        };
        assert_eq!(render(&st, "svgbob", b"+-->+").await.unwrap(), b"<svg/>");
    }

    #[tokio::test]
    async fn lang_白名单_拒绝路径注入() {
        let st = KrokiState {
            host: "https://kroki.io".into(),
            http: Arc::new(MockHttp { body: vec![], status_ok: true }),
        };
        for bad in ["../etc", "graphviz?x=1", "", "PlantUml"] {
            assert!(render(&st, bad, b"src").await.is_err());
        }
    }
}
