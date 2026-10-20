//! `POST /api/search` 薄适配（多端发布阶段二 Task 3）：业务体（参数校验/多根
//! 目录解析/rg·grep spawn 探测链/pump 解析/NDJSON 帧面）在
//! [`vviewer_core::search`]；本模块只留 axum 提取与响应重建。`probe_rg` 经
//! 原路径 re-export（tests/search.rs 零改动）；错误经 `CoreError → AppError`
//! 统一映射为既有 JSON 形态（501/400/403 消息文本逐字保持）。

pub use vviewer_core::search::{probe, probe_rg};

use axum::extract::State;
use axum::response::Response;
use axum::Json;

use crate::adapt;
use crate::error::AppError;
use crate::state::AppState;

/// 裁决（M6）：search 属 file-server 基础能力——挂在 Bearer 组内但不要求
/// `--compute`（路由组见 routes/mod.rs）。
pub async fn search(
    State(state): State<AppState>,
    Json(req): Json<vviewer_core::search::SearchRequest>,
) -> Result<Response, AppError> {
    Ok(adapt::to_axum(vviewer_core::search::search(&state.core, req).await?))
}
