//! HTTP 路由。

pub mod file;
pub mod health;
pub mod tree;

use axum::routing::get;
use axum::Router;

/// `/api` 子路由；未匹配的 API 路径统一返回 JSON 404。
pub fn api_router(state: crate::state::AppState) -> Router {
    Router::new()
        .route("/health", get(health::health))
        .route("/tree", get(tree::tree))
        .route("/file", get(file::file))
        .fallback(crate::api_not_found)
        .with_state(state)
}
