//! `POST /api/compute/markdown`（Bearer，`--compute` 时挂载）：comrak GFM 渲染。

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::{Deserialize, Serialize};

use crate::compute::markdown::{render, MARKDOWN_MAX_BYTES};

#[derive(Deserialize)]
pub struct MarkdownRequest {
    pub text: String,
    #[serde(default)]
    pub options: MarkdownOptions,
}

#[derive(Deserialize, Default)]
pub struct MarkdownOptions {
    #[serde(default)]
    pub wikilinks: bool,
}

#[derive(Serialize)]
pub struct MarkdownResponse {
    pub html: String,
}

/// body `{text, options?: {wikilinks?}}` → `{html}`。
/// text 超过 5MB（UTF-8 字节）返回 413；原始请求体由 DefaultBodyLimit 兜底。
pub async fn markdown(
    State(_state): State<crate::state::AppState>,
    Json(req): Json<MarkdownRequest>,
) -> Response {
    if req.text.len() > MARKDOWN_MAX_BYTES {
        return (
            StatusCode::PAYLOAD_TOO_LARGE,
            Json(serde_json::json!({
                "error": format!("markdown text exceeds {}MB limit", MARKDOWN_MAX_BYTES / 1024 / 1024)
            })),
        )
            .into_response();
    }
    let html = render(&req.text, req.options.wikilinks);
    Json(MarkdownResponse { html }).into_response()
}
