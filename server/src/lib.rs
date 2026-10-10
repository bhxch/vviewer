//! vviewer server 库：路由构建与静态资产服务（供集成测试复用）。

pub mod auth;
pub mod compute;
pub mod detect;
pub mod error;
pub mod guard;
pub mod routes;
pub mod state;
pub mod watch;

use std::time::Duration;

use axum::extract::{Request, State};
use axum::http::{header, HeaderValue, Method, StatusCode, Uri};
use axum::middleware::{self, Next};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use rand::Rng;
use state::AppState;
use tower_http::cors::{AllowOrigin, CorsLayer};
use tower_http::services::ServeDir;
use tower_http::trace::TraceLayer;

/// 生成 32 字节随机 hex（CLI `--token-gen` 与 ticket 共用格式）。
pub fn generate_token() -> String {
    let mut buf = [0u8; 32];
    rand::rng().fill_bytes(&mut buf);
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

/// ticket 定期清理周期。
pub const TICKET_SWEEP_INTERVAL: Duration = Duration::from_secs(15);

/// `/api` 未匹配路径的统一 JSON 404。
pub async fn api_not_found() -> Response {
    (
        StatusCode::NOT_FOUND,
        Json(serde_json::json!({ "error": "not found" })),
    )
        .into_response()
}

/// 未指定 `--web-dist` 时 `/` 的极简占位页。
async fn placeholder_page() -> Html<&'static str> {
    Html(
        "<!doctype html><html><head><meta charset=\"utf-8\"><title>vviewer</title></head>\
         <body><h1>vviewer server</h1>\
         <p>Web UI not served. Restart with <code>--web-dist &lt;DIR&gt;</code> to serve the frontend build.</p>\
         </body></html>",
    )
}

/// SPA fallback：任何未知路径返回 dist/index.html。`.scm`/`.wasm` 资产路径除外——
/// 查询目录（如 113/307 缺 injections.scm）未命中时不得以 200 index.html 兜底，
/// 否则前端把 HTML 误载为查询文本，整语言查询编译失败降级 hljs（终审 C1，双层修之 server 层）。
async fn serve_index(uri: Uri, State(state): State<AppState>) -> Response {
    let path = uri.path();
    if path.ends_with(".scm") || path.ends_with(".wasm") {
        return (StatusCode::NOT_FOUND, "grammar asset not found").into_response();
    }
    let Some(dist) = &state.web_dist else {
        return placeholder_page().await.into_response();
    };
    match tokio::fs::read(dist.join("index.html")).await {
        Ok(bytes) => {
            let mut res = (
                [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
                bytes,
            )
                .into_response();
            // index.html 禁缓存（BUG-15 server 子项）：磁盘缓存启发式命中会让
            // 「离线 reload 落 chrome-error」的 SW 缺陷被新鲜窗口掩盖
            res.headers_mut()
                .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
            res
        }
        Err(_) => (
            StatusCode::NOT_FOUND,
            "index.html not found in --web-dist",
        )
            .into_response(),
    }
}

/// index.html 响应禁缓存中间件（BUG-15 server 子项）：ServeDir 直接命中 `/` 与
/// `*/index.html` 的成功响应同样下发 `cache-control: no-cache`；其余路径（API、
/// 带 hash 的静态资产）不受影响。
async fn no_cache_index(req: Request, next: Next) -> Response {
    let is_index = req.uri().path() == "/" || req.uri().path().ends_with("/index.html");
    let mut res = next.run(req).await;
    if is_index && res.status().is_success() {
        res.headers_mut()
            .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    }
    res
}

/// 组装完整应用路由（不含 CORS/鉴权层的动态部分，鉴权在 Task 3 引入）。
pub fn build_router(state: AppState) -> Router {
    let api = routes::api_router(state.clone());

    let app = match &state.web_dist {
        Some(dist) => {
            // 静态资产 + SPA fallback（未知路径 → index.html）
            let spa_fallback = Router::new()
                .fallback(serve_index)
                .with_state(state.clone());
            let static_svc = ServeDir::new(dist)
                .append_index_html_on_directories(true)
                .fallback(spa_fallback);
            Router::new()
                .nest("/api", api)
                .fallback_service(static_svc)
                // index.html（直接命中与 SPA fallback）禁缓存；/api 路径不命中条件
                .layer(middleware::from_fn(no_cache_index))
        }
        None => Router::new()
            .nest("/api", api)
            .fallback_service(get(placeholder_page)),
    };

    // 两个分支的 Router 均已无状态化（api/serve_index 已绑定 state）
    let app = app.layer(TraceLayer::new_for_http());

    // CORS：--cors-origin 时精确 origin + GET/POST + authorization/content-type；否则不加层。
    // 用 list 而非 Const(exact)：仅当请求 Origin 匹配才回显该值（Const 会无条件回显常量）
    let cors = state
        .cors_origin
        .as_deref()
        .and_then(|o| HeaderValue::from_str(o).ok())
        .map(|origin| {
            CorsLayer::new()
                .allow_origin(AllowOrigin::list([origin]))
                .allow_methods([Method::GET, Method::POST])
                .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE])
        });
    match cors {
        Some(layer) => app.layer(layer),
        None => app,
    }
}
