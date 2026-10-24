//! kroki 转发域（spec 2026-10-23 §8.2）：转发不算计算——native/worker 双形态
//! 编译进（模块不挂 feature 门）。
//!
//! SSRF 防线：上游 host 只来自部署侧配置（native `--kroki-host` / worker
//! `VV_KROKI_HOST`，装配点在适配层），请求体仅 raw 源码；lang 白名单拦截
//! 路径注入。上游协议 POST `{host}/{lang}/svg`（text/plain）→ 200 SVG bytes。

use std::sync::Arc;

use crate::error::CoreError;

/// 缺省上游 host（部署侧未配置时的兜底）：公开 kroki.io 服务。native
/// `--kroki-host`/TOML `[kroki] host` 与 worker `VV_KROKI_HOST` 的缺省共同
/// 引用本常量（SSRF 防线：客户端永不可指定上游，host 只来自部署侧配置）。
pub const DEFAULT_KROKI_HOST: &str = "https://kroki.io";

/// `POST /api/kroki` 的原始请求体上限（BE-2 双适配层共享闸门常量单源，spec
/// 2026-10-23 §8.2）：图源码文本 1MB 已超合理形态数个数量级；超限直接 413，
/// 防无界 body 转发上游（本服务即上游的敞开代理面）。
pub const KROKI_BODY_LIMIT: usize = 1024 * 1024;

/// body `{lang, source}`（BE-2 双份 DTO 合一；serde 未知字段默认忽略）。
#[derive(serde::Deserialize)]
pub struct KrokiRequest {
    pub lang: String,
    pub source: String,
}

/// 消息截断（前 200 字节，字符边界安全——直接按字节切片可能在多字节字符中间
/// panic）。
pub fn trunc_200(s: &str) -> &str {
    let mut end = s.len().min(200);
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

/// 上游错误映射单源（BE-2，双传输实现共用）：非 2xx 状态 + 响应体 →
/// [`CoreError`]——4xx → bad_request、其余（5xx/3xx 等）→ internal；消息
/// `kroki {status}: {body 前 200 字节}`（与两侧传输实现原产出逐字节同形：
/// native 侧 `status.as_u16()`、worker 侧 `status: u16` 在各自调用点收敛为
/// u16 后输出一致）。
pub fn upstream_error(status: u16, body: &[u8]) -> CoreError {
    let msg = String::from_utf8_lossy(body);
    let text = format!("kroki {}: {}", status, trunc_200(&msg));
    if (400..500).contains(&status) {
        CoreError::bad_request(text)
    } else {
        CoreError::internal(text)
    }
}

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
/// `http` 为注入的传输接缝。Clone 共享同一 `Arc<dyn>`（适配层 AppState 的
/// Clone 装配面需要——AppState 克隆不复制传输接缝）。
#[derive(Clone)]
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

    use super::{KrokiHttp, KrokiState, render, trunc_200, upstream_error};
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

    /// trunc_200 字符边界截断锁测（BE-2 下沉补测）：多字节字符中间安全——
    /// 截断点回退到最近边界，不 panic、不产生撕裂半字符；ASCII 恰 200 与
    /// 短串原样。
    #[test]
    fn trunc_200_截断在字符边界() {
        assert_eq!(trunc_200("abc"), "abc");
        // 300 字节的连续 3 字节字符：200 落在第 67 个字符中间 → 退到 198
        let s = "中".repeat(100);
        assert_eq!(trunc_200(&s), "中".repeat(66));
        // ASCII 恰取 200
        let a = "a".repeat(250);
        assert_eq!(trunc_200(&a).len(), 200);
    }

    /// upstream_error 分类锁测（BE-2 下沉补测）：4xx → bad_request、其余 →
    /// internal；消息 `kroki {status}: {body}` 与双侧传输实现原产出同形。
    #[test]
    fn upstream_error_4xx_bad_request_其余_internal() {
        let e = upstream_error(400, b"bad lang");
        assert_eq!(e.0, http::StatusCode::BAD_REQUEST);
        assert_eq!(e.1, "kroki 400: bad lang");
        let e = upstream_error(502, b"upstream down");
        assert_eq!(e.0, http::StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(e.1, "kroki 502: upstream down");
    }
}
