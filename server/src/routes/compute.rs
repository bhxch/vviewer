//! `POST /api/compute/*` 薄适配（多端发布阶段二 Task 3）：渲染/高亮业务体在
//! [`vviewer_core::compute`]（native feature 门控——本模块整体随门控裁剪）；
//! 本模块只留 axum 提取与响应重建，错误经 `CoreError → AppError` 统一映射为
//! 既有 JSON 形态（400/413/504 消息文本逐字保持）。

use axum::extract::State;
use axum::response::Response;
use axum::Json;

use vviewer_core::compute::highlight::{HighlightRequest, HIGHLIGHT_TIMEOUT};
use vviewer_core::compute::markdown::MarkdownRequest;

use crate::adapt;
use crate::error::AppError;
use crate::state::AppState;

/// body `{text, options?: {wikilinks?}}` → `{html}`。Bearer 保护 + `--compute`
/// + native feature 三重门（路由挂载见 routes/mod.rs）。
///
/// text 超过 5MB（UTF-8 字节）返回 413；原始请求体由 DefaultBodyLimit 兜底。
pub async fn markdown(
    State(_state): State<AppState>,
    Json(req): Json<MarkdownRequest>,
) -> Result<Response, AppError> {
    Ok(adapt::to_axum(vviewer_core::compute::markdown::markdown(req)?))
}

/// body `{path?, text?, lang, range?, cacheId?}` → `{intervals, captures,
/// baseLine, cacheId?}`。响应侧 504 超时语义见 core::compute::highlight 模块
/// 注释（生产超时 [`HIGHLIGHT_TIMEOUT`]）。
pub async fn highlight(
    State(state): State<AppState>,
    Json(req): Json<HighlightRequest>,
) -> Result<Response, AppError> {
    Ok(adapt::to_axum(
        vviewer_core::compute::highlight::highlight(&state.core, req, HIGHLIGHT_TIMEOUT).await?,
    ))
}
