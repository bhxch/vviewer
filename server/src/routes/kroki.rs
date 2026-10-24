//! `POST /api/kroki` 薄适配（spec 2026-10-23 §8.2）：转发业务体在
//! [`vviewer_core::kroki`]（双形态恒编译进——worker 适配见 worker crate 的
//! `FetchKrokiHttp`），本模块只留 axum 提取/响应重建与 native reqwest 传输
//! 实现。整体随 native feature 门控（reqwest 门控纪律：裁剪形态 workspace
//! 全图零 reqwest，与 compute/events 同款）。
//!
//! 错误映射（评审承接项：core 无 `upstream` 构造器——简报草稿的 502 语义由
//! 本适配层自行落）：网络错/上游 5xx → internal，上游 4xx → bad_request；
//! 消息透传上游 body 前 200 字节（UTF-8 字符边界安全截断，非字节硬切）。

use std::time::Duration;

use axum::extract::State;
use axum::Json;
use serde::{Deserialize, Serialize};
use vviewer_core::error::CoreError;

use crate::error::AppError;
use crate::state::AppState;

/// body `{lang, source}`（serde 未知字段默认忽略——与 compute 请求面同语义）。
#[derive(Deserialize)]
pub struct KrokiRequest {
    pub lang: String,
    pub source: String,
}

/// 响应 `{svg}`。
#[derive(Serialize)]
pub struct KrokiResponse {
    pub svg: String,
}

/// body `{lang, source}` → `{svg}`。Bearer 保护组内（转发不算计算——不要求
/// `--compute`，路由挂载在 compute 门控之外见 routes/mod.rs）；lang 白名单与
/// host 拼接在 core（SSRF 防线：上游 host 只来自部署侧配置）。
pub async fn proxy(
    State(state): State<AppState>,
    Json(req): Json<KrokiRequest>,
) -> Result<Json<KrokiResponse>, AppError> {
    let bytes =
        vviewer_core::kroki::render(&state.kroki, &req.lang, req.source.as_bytes()).await?;
    let svg = String::from_utf8(bytes)
        .map_err(|_| AppError::internal("kroki 响应非 UTF-8"))?;
    Ok(Json(KrokiResponse { svg }))
}

/// 消息截断（前 200 字节，字符边界安全——直接按字节切片可能在多字节字符中间
/// panic；worker 适配层同款实现，两侧语义一致）。
fn trunc_200(s: &str) -> &str {
    let mut end = s.len().min(200);
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

/// [`vviewer_core::kroki::KrokiHttp`] 的 native 实现（reqwest + rustls）：30s
/// 请求级超时；禁跟随重定向（[`reqwest::redirect::Policy::none`]）——部署侧
/// 上游是唯一合法出站目标，重定向即异常：默认策略会把 302→GET 改写重发出站
/// 目标，构成内网响应中继面，故 3xx 一律不跟随、按非 2xx 错误面落地（非成功
/// 态且非 4xx → internal，消息透传上游状态与 body 前 200 字节）；非 2xx/
/// 网络错映射 CoreError（4xx → bad_request、5xx/网络错 → internal）。
pub struct ReqwestKrokiHttp {
    client: reqwest::Client,
}

impl ReqwestKrokiHttp {
    pub fn new() -> Self {
        Self {
            client: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .expect("reqwest Client 构建不可失败（仅设 redirect 策略）"),
        }
    }
}

impl Default for ReqwestKrokiHttp {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait::async_trait]
impl vviewer_core::kroki::KrokiHttp for ReqwestKrokiHttp {
    async fn post_text(&self, url: String, body: Vec<u8>) -> Result<Vec<u8>, CoreError> {
        let resp = self
            .client
            .post(url)
            .header(reqwest::header::CONTENT_TYPE, "text/plain")
            .body(body)
            .timeout(Duration::from_secs(30))
            .send()
            .await
            .map_err(|e| CoreError::internal(format!("kroki 请求失败: {e}")))?;
        let status = resp.status();
        let bytes = resp
            .bytes()
            .await
            .map_err(|e| CoreError::internal(format!("kroki 读响应失败: {e}")))?;
        if !status.is_success() {
            let msg = String::from_utf8_lossy(&bytes);
            let text =
                format!("kroki {}: {}", status.as_u16(), trunc_200(&msg));
            return Err(if status.is_client_error() {
                CoreError::bad_request(text)
            } else {
                CoreError::internal(text)
            });
        }
        Ok(bytes.to_vec())
    }
}
