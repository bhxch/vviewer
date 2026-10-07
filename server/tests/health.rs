//! Task 1 集成测试：/api/health 能力发现 + 静态资产挂载。

use axum::body::Body;
use axum::http::{Request, StatusCode};
use tower::ServiceExt;
use vviewer::state::AppState;

fn test_state(root: std::path::PathBuf, web_dist: Option<std::path::PathBuf>) -> AppState {
    AppState::new(root, web_dist, None, false)
}

async fn get_body(
    app: axum::Router,
    uri: &str,
) -> (StatusCode, axum::body::Bytes) {
    let res = app
        .oneshot(
            Request::builder()
                .uri(uri)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let status = res.status();
    let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    (status, bytes)
}

#[tokio::test]
async fn health_reports_name_version_capabilities() {
    let dir = tempfile::tempdir().unwrap();
    let app = vviewer::build_router(test_state(dir.path().to_path_buf(), None));

    let (status, body) = get_body(app, "/api/health").await;
    assert_eq!(status, StatusCode::OK);

    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["name"], "vviewer");
    assert_eq!(json["version"], env!("CARGO_PKG_VERSION"));
    let caps = json["capabilities"].as_array().unwrap();
    assert!(caps.iter().any(|c| c == "file-server"));
}

#[tokio::test]
async fn unknown_api_path_returns_json_404() {
    let dir = tempfile::tempdir().unwrap();
    let app = vviewer::build_router(test_state(dir.path().to_path_buf(), None));

    let (status, body) = get_body(app, "/api/does-not-exist").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert!(json["error"].is_string());
}

#[tokio::test]
async fn root_without_web_dist_serves_placeholder() {
    let dir = tempfile::tempdir().unwrap();
    let app = vviewer::build_router(test_state(dir.path().to_path_buf(), None));

    let (status, body) = get_body(app, "/").await;
    assert_eq!(status, StatusCode::OK);
    let text = String::from_utf8(body.to_vec()).unwrap();
    assert!(text.contains("--web-dist"), "占位页应提示 --web-dist");
}

#[tokio::test]
async fn web_dist_serves_assets_and_spa_fallback() {
    let root = tempfile::tempdir().unwrap();
    let dist = tempfile::tempdir().unwrap();
    std::fs::write(dist.path().join("index.html"), "<html>spa-shell</html>").unwrap();
    std::fs::write(dist.path().join("app.js"), "console.log(1)").unwrap();

    let app = vviewer::build_router(test_state(
        root.path().to_path_buf(),
        Some(dist.path().to_path_buf()),
    ));

    // 直接命中静态资产
    let (status, body) = get_body(app.clone(), "/app.js").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body.as_ref(), b"console.log(1)");

    // SPA fallback：未知路径返回 index.html
    let (status, body) = get_body(app, "/some/spa/route").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body.as_ref(), b"<html>spa-shell</html>");
}
