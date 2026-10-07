//! `POST /api/ticket`（Bearer 保护）：为 EventSource 签发一次性 SSE 升级票据。
//!
//! 票据的校验与消费在 `routes::events`（SSE 升级门）。

use axum::extract::State;
use axum::Json;

/// 需 Bearer 有效（挂在鉴权中间件组内）。
pub async fn issue_ticket(State(state): State<crate::state::AppState>) -> Json<serde_json::Value> {
    Json(serde_json::json!({ "ticket": state.tickets.issue() }))
}
