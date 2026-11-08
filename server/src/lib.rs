//! vviewer server 库：路由构建与静态资产服务（供集成测试复用）。

pub mod adapt;
// serve 装配链升 lib 面（装配可测化）：启动校验链/静态挂载装配/缺省
// transport（native 门控双版本）/serve 编排自 bin main.rs 整体迁入，bin 只留
// clap 解析薄壳——装配行为经 lib 面供单元/集成测试直达（断言随迁零改动）。
pub mod assembly;
pub mod auth;
// compute 域随 Task 3 迁 vviewer-core::compute（多端发布阶段二，native feature
// 门控）——原 `vviewer::compute::*` 路径经本 re-export 保持既有调用点/集成测试
// （tests/compute_highlight.rs、tests/compute_markdown.rs）零改动。
#[cfg(feature = "native")]
pub use vviewer_core::compute;
// --config TOML 解析合并随装配链升 lib 面：原 bin 模块（main.rs 的
// `mod config;`）改经 lib 声明，解析/合并语义与锁测零改动。
pub mod config;
pub mod error;
pub mod logging;
pub mod routes;
pub mod state;
// watch（notify）域随 native feature 门控：worker 形态（--no-default-features）
// 编译不存在——/api/events 不挂载、ChangeHub 不构造（state.rs 协同门控）。
#[cfg(feature = "native")]
pub mod watch;

use std::time::Duration;

use axum::extract::{Request, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode, Uri};
use axum::middleware::{self, Next};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use state::AppState;
use tower_http::cors::{AllowOrigin, CorsLayer};
use tower_http::services::ServeDir;
use tower_http::trace::TraceLayer;

// ticket 域随 Task 3 迁 vviewer-core::tickets（多端发布阶段二）——生成器原
// 路径 re-export：`vviewer::generate_token()`（CLI --token-gen 与 ticket 共用
// 格式）零改动。
pub use vviewer_core::tickets::generate_token;

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

/// SPA fallback：未知路径在**导航请求**（Accept 含 `text/html`）下返回 dist/index.html，
/// 其余一律 404。两层特判：
/// - `.scm`/`.wasm` 资产路径（在前，不受 Accept 影响）——查询目录（如 113/307 缺
///   injections.scm）未命中时不得以 200 index.html 兜底，否则前端把 HTML 误载为查询
///   文本，整语言查询编译失败降级 hljs（终审 C1，双层修之 server 层）。
/// - SWR-DEF-01（e2e 锚 SWR-ROUTE-07）：fallback 原先对任何未知路径回 200 HTML——未知
///   **资产** URL（如 foreign 资产 `/file-viewer-assets/xxx.js`）也拿到 200 HTML，被 SW
///   的 CacheFirst（`cacheableResponse` 只收 200；SW 层无法按 content-type 过滤——
///   generateSW 不支持自定义 cacheWillUpdate plugin）收进 vv-foreign-assets 缓存，污染
///   资产解析一个部署周期。根治：fallback 只对导航请求生效——浏览器导航 Accept 恒含
///   text/html；脚本/wasm/fetch 的 Accept 是具体类型或 `*/*`，一律 404，资产 200 HTML
///   污染面归零（服务端契约由 server/tests/health.rs 集成锚守住）。
async fn serve_index(uri: Uri, headers: HeaderMap, State(state): State<AppState>) -> Response {
    let path = uri.path();
    if path.ends_with(".scm") || path.ends_with(".wasm") {
        return (StatusCode::NOT_FOUND, "grammar asset not found").into_response();
    }
    // 大小写不敏感子串判定：浏览器导航 Accept 恒含 "text/html"；缺 Accept 头（非浏览器
    // 形态）按非导航处理，缺省拒绝
    let is_navigation = headers
        .get(header::ACCEPT)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|accept| accept.to_ascii_lowercase().contains("text/html"));
    if !is_navigation {
        return (
            StatusCode::NOT_FOUND,
            "spa fallback only serves navigation requests (accept: text/html)",
        )
            .into_response();
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
            // 静态资产 + SPA fallback（导航请求的未知路径 → index.html，其余 404）
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
    // 用 list 而非 Const(exact)：仅当请求 Origin 匹配才回显该值（Const 会无条件回显常量）。
    // '*' 在此防御性跳过（CLI 层 main.rs 已启动即拒）：AllowOrigin::list 收到通配值
    // 会在库内 panic（BUG-45），build_router 作为 pub API 不得因配置值崩溃。
    // expose_headers：x-vv-lang/x-vv-encoding 是 JS 可读响应头，跨源默认被浏览器
    // CSP 过滤拦截（I1）——不暴露则前端跨源部署拿不到语言/编码检测结果
    let cors = state
        .cors_origin
        .as_deref()
        .filter(|o| !o.contains('*'))
        .and_then(|o| HeaderValue::from_str(o).ok())
        .map(|origin| {
            CorsLayer::new()
                .allow_origin(AllowOrigin::list([origin]))
                // DELETE：阶段二挂载 API（DELETE /api/mounts/{index}）的跨域面——
                // 精确 origin 配置下浏览器预检需放行该谓词
                .allow_methods([Method::GET, Method::POST, Method::DELETE])
                .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE])
                .expose_headers([
                    header::HeaderName::from_static("x-vv-lang"),
                    header::HeaderName::from_static("x-vv-encoding"),
                ])
        });
    match cors {
        Some(layer) => app.layer(layer),
        None => app,
    }
}
