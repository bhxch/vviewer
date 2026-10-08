//! 集成测试：index.html 与 SPA fallback 下发 `cache-control: no-cache`（BUG-15
//! server 子项）。磁盘缓存启发式命中 index.html 会掩盖 SW 缺陷（离线 reload 落
//! chrome-error 却「看起来正常」），故必须显式禁缓存且不影响带 hash 的静态资产。

use axum::body::Body;
use axum::http::{HeaderMap, Request, StatusCode};
use tower::ServiceExt;
use vviewer::state::AppState;

struct Fixture {
    _dist: tempfile::TempDir,
    state: AppState,
}

fn fixture() -> Fixture {
    let dist = tempfile::tempdir().unwrap();
    std::fs::write(dist.path().join("index.html"), "<!doctype html><html>vv</html>").unwrap();
    std::fs::write(dist.path().join("app-abc123.js"), "console.log(1)").unwrap();
    let root = tempfile::tempdir().unwrap();
    let state = AppState::new(
        root.path().to_path_buf(),
        Some(dist.path().to_path_buf()),
        None,
        false,
        None,
    );
    Fixture { _dist: dist, state }
}

async fn get(state: &AppState, path: &str) -> (StatusCode, HeaderMap) {
    let app = vviewer::build_router(state.clone());
    let req = Request::builder().uri(path).body(Body::empty()).unwrap();
    let res = app.oneshot(req).await.unwrap();
    (res.status(), res.headers().clone())
}

#[tokio::test]
async fn index_routes_carry_no_cache() {
    let f = fixture();
    // `/` 与 `/index.html`：ServeDir 直接命中；`/spa/route`：SPA fallback → index.html
    for path in ["/", "/index.html", "/spa/route"] {
        let (status, headers) = get(&f.state, path).await;
        assert_eq!(status, StatusCode::OK, "{path} 应 200");
        assert_eq!(
            headers["cache-control"],
            "no-cache",
            "{path} 应显式禁缓存"
        );
    }
}

#[tokio::test]
async fn hashed_static_assets_keep_default_cache_headers() {
    let f = fixture();
    let (_, headers) = get(&f.state, "/app-abc123.js").await;
    assert_eq!(headers["content-type"], "text/javascript");
    assert!(
        !headers.contains_key("cache-control"),
        "带 hash 的静态资产不应被强制 no-cache: {:?}",
        headers
    );
}

#[tokio::test]
async fn api_responses_unaffected_by_no_cache_middleware() {
    let f = fixture();
    let (_, headers) = get(&f.state, "/api/nope").await;
    assert_eq!(headers["content-type"], "application/json");
    assert!(
        !headers.contains_key("cache-control"),
        "API 404 不应被中间件改写缓存头"
    );
}
