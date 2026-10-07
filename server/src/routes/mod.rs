//! HTTP 路由。

pub mod compute;
pub mod events;
pub mod file;
pub mod health;
pub mod ticket;
pub mod tree;

use axum::extract::DefaultBodyLimit;
use axum::middleware;
use axum::routing::{get, post};
use axum::Router;

use crate::auth;

/// /api/compute/* 的原始请求体上限：略高于应用层 5MB（给 JSON 包装留余量），
/// 超限直接 413，防止 handler 解析超大 body。text 字段的精确 5MB 判定在 handler。
const COMPUTE_BODY_LIMIT: usize = 6 * 1024 * 1024;

/// `/api` 子路由；未匹配的 API 路径统一返回 JSON 404。
///
/// 鉴权分组：tree/file/ticket/compute 在 Bearer 中间件组内；
/// health 免认证；events 用一次性 ticket 自证（EventSource 无法带头）。
pub fn api_router(state: crate::state::AppState) -> Router {
    let mut protected = Router::new()
        .route("/tree", get(tree::tree))
        .route("/file", get(file::file))
        .route("/ticket", post(ticket::issue_ticket));
    // --compute 才暴露计算端点；未启用时路径不存在（统一 JSON 404）
    if state.compute {
        protected = protected.route(
            "/compute/markdown",
            post(compute::markdown).layer(DefaultBodyLimit::max(COMPUTE_BODY_LIMIT)),
        );
    }
    let protected = protected
        .layer(middleware::from_fn_with_state(
            state.clone(),
            auth::auth_mw,
        ))
        .with_state(state.clone());

    Router::new()
        .route("/health", get(health::health))
        .route("/events", get(events::events))
        .merge(protected)
        .fallback(crate::api_not_found)
        .with_state(state)
}
