//! `GET /api/events?ticket=` 薄适配（多端发布阶段二 Task 3）：SSE 驱动任务、
//! ticket 门与 wire 编码业务体在 [`vviewer_core::events`]（body 经
//! `CoreBody::Stream` 流形态承载）；本模块只留 Query 提取、watch 广播中心的
//! 订阅缝注入与响应重建。watch 广播中心属 notify 域（native feature 门控，
//! 见 routes/mod.rs 挂载与 state.rs）。

use axum::extract::{Query, State};
use axum::response::Response;
use serde::Deserialize;

use crate::adapt;
use crate::error::AppError;

#[derive(Deserialize)]
pub struct EventsQuery {
    pub ticket: Option<String>,
}

/// ticket 校验（一次性，沿用 T3 语义）在 core 内：缺失/无效/过期 → 401。
/// 订阅闭包在校验通过后才被调用（建连快照时序与迁移前逐语句一致）。
pub async fn events(
    State(state): State<crate::state::AppState>,
    Query(q): Query<EventsQuery>,
) -> Result<Response, AppError> {
    Ok(adapt::to_axum(vviewer_core::events::handle(
        &state.tickets,
        q.ticket,
        || (state.changes.health().snapshot_frame(), state.changes.subscribe()),
    )?))
}
