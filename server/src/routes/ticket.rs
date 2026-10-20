//! `POST /api/ticket`（Bearer 保护）薄适配（多端发布阶段二 Task 3）：签发
//! 业务体（一次性 ticket 表）在 [`vviewer_core::tickets`]；本模块只留 State
//! 提取与响应重建。票据的校验与消费在 `vviewer_core::events`（SSE 升级门）。

use axum::extract::State;
use axum::response::Response;

use crate::adapt;
use crate::state::AppState;

/// 需 Bearer 有效（挂在鉴权中间件组内）。
pub async fn issue_ticket(State(state): State<AppState>) -> Response {
    adapt::to_axum(vviewer_core::tickets::issue(&state.tickets))
}
