//! HTTP 路由。

pub mod file;
pub mod health;
pub mod ticket;
pub mod tree;

use axum::middleware;
use axum::routing::{get, post};
use axum::Router;

use crate::auth;

/// `/api` 子路由；未匹配的 API 路径统一返回 JSON 404。
///
/// 鉴权分组：tree/file/ticket 在 Bearer 中间件组内；
/// health 免认证；events 用一次性 ticket 自证（EventSource 无法带头）。
pub fn api_router(state: crate::state::AppState) -> Router {
    let protected = Router::new()
        .route("/tree", get(tree::tree))
        .route("/file", get(file::file))
        .route("/ticket", post(ticket::issue_ticket))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            auth::auth_mw,
        ))
        .with_state(state.clone());

    Router::new()
        .route("/health", get(health::health))
        .route("/events", get(ticket::events))
        .merge(protected)
        .fallback(crate::api_not_found)
        .with_state(state)
}
