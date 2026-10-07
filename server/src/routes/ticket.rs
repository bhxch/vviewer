//! `POST /api/ticket`（Bearer 保护）与 `GET /api/events` 的 ticket 校验门。
//!
//! T4 在 events 处升级为 SSE 流；本任务先落 ticket 校验语义与空 event-stream 响应。

use axum::extract::{Query, State};
use axum::http::header;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;

use crate::error::AppError;

/// 需 Bearer 有效（挂在鉴权中间件组内）。
pub async fn issue_ticket(State(state): State<crate::state::AppState>) -> Json<serde_json::Value> {
    Json(serde_json::json!({ "ticket": state.tickets.issue() }))
}

#[derive(Deserialize)]
pub struct EventsQuery {
    pub ticket: Option<String>,
}

/// ticket 校验：缺失/无效/过期 → 401；一次性（消费即删）。
pub async fn events(
    State(state): State<crate::state::AppState>,
    Query(q): Query<EventsQuery>,
) -> Result<Response, AppError> {
    let valid = q
        .ticket
        .as_deref()
        .is_some_and(|t| state.tickets.consume(t));
    if !valid {
        return Err(AppError::unauthorized("missing or invalid ticket"));
    }
    // T4：消费 ticket 后升级 SSE；当前为空流占位
    Ok((
        [(header::CONTENT_TYPE, "text/event-stream")],
        "retry: 1000\n\n",
    )
        .into_response())
}
