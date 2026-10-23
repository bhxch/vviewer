//! `POST /api/compute/*` 薄适配（多端发布阶段二 Task 3）：渲染/高亮业务体在
//! [`vviewer_core::compute`]（native feature 门控——本模块整体随门控裁剪）；
//! 本模块只留 axum 提取与响应重建，错误经 `CoreError → AppError` 统一映射为
//! 既有 JSON 形态（400/413/504 消息文本逐字保持）。diagram（Task 4，spec
//! 2026-10-23 §8.1）与 kroki 同款直调 core 纯函数：请求/响应类型与错误面在
//! 本层（不经 CoreResponse），白名单归一与渲染失败双 400 语义见 [`diagram`]。

use axum::extract::State;
use axum::response::Response;
use axum::Json;
use serde::{Deserialize, Serialize};

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

/// body `{lang, source}`（spec 2026-10-23 §8.1）：本地来源文档图表的服务端
/// 单图渲染载体——围栏管线之外，直发图源码取 SVG 的通道。
#[derive(Deserialize)]
pub struct DiagramRequest {
    pub lang: String,
    pub source: String,
}

/// 响应 `{svg}`。
#[derive(Serialize)]
pub struct DiagramResponse {
    pub svg: String,
}

/// body `{lang, source}` → `{svg}`。Bearer 保护 + `--compute` + native feature
/// 三重门（与 markdown 同组，路由挂载见 routes/mod.rs）。双 400 面：lang 不在
/// 服务端原生集（canonical_of NATIVE 表归一，大小写不敏感）；渲染失败（解析
/// 失败/零节点图判空早退——围栏管线是保留原 fence 交客户端，端点无原文可保留
/// 故显式 400）。无应用层体积判定，body 闸门即路由 DefaultBodyLimit（6MB）。
pub async fn diagram(
    State(_state): State<AppState>,
    Json(req): Json<DiagramRequest>,
) -> Result<Json<DiagramResponse>, AppError> {
    let canon = vviewer_core::compute::diagrams::canonical_of(&req.lang)
        .ok_or_else(|| AppError::bad_request("非服务端原生图表语言"))?;
    let svg = vviewer_core::compute::diagrams::render_diagram_svg(canon, &req.source)
        .ok_or_else(|| AppError::bad_request("图表渲染失败"))?;
    Ok(Json(DiagramResponse { svg }))
}
