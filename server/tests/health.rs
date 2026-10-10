//! Task 1 集成测试：/api/health 能力发现 + 静态资产挂载。

use axum::body::Body;
use axum::http::{Request, StatusCode};
use tower::ServiceExt;
use vviewer::state::AppState;

fn test_state(root: std::path::PathBuf, web_dist: Option<std::path::PathBuf>) -> AppState {
    AppState::new(root, web_dist, None, false, None)
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

#[tokio::test]
async fn grammar_asset_paths_not_swallowed_by_spa_fallback() {
    let root = tempfile::tempdir().unwrap();
    let dist = tempfile::tempdir().unwrap();
    std::fs::write(dist.path().join("index.html"), "<html>spa-shell</html>").unwrap();
    // 存在的 .scm 资产：ServeDir 直接命中 → 200 正常内容（非 index.html）
    std::fs::create_dir_all(dist.path().join("queries").join("rust")).unwrap();
    std::fs::write(dist.path().join("queries").join("rust").join("highlights.scm"), ";; rust query").unwrap();

    let app = vviewer::build_router(test_state(
        root.path().to_path_buf(),
        Some(dist.path().to_path_buf()),
    ));

    // 存在 .scm → 200 正常
    let (status, body) = get_body(app.clone(), "/queries/rust/highlights.scm").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body.as_ref(), b";; rust query");

    // 不存在的 .scm/.wasm → 404（终审 C1：不得以 200 index.html 兜底——
    // 否则前端把 HTML 误载为查询文本，缺 injections.scm 的语言整体降级 hljs）
    for uri in [
        "/queries/elisp/injections.scm",
        "/grammars/tree-sitter-elisp.wasm",
        "/queries/a/b/highlights.scm",
    ] {
        let (status, body) = get_body(app.clone(), uri).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{uri} 应 404");
        assert_ne!(body.as_ref(), b"<html>spa-shell</html>", "{uri} 不得回 index.html");
    }

    // 非 .scm/.wasm 未知路径仍走 SPA fallback（回归确认修法不外溢）
    let (status, body) = get_body(app, "/some/spa/route").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body.as_ref(), b"<html>spa-shell</html>");
}

#[tokio::test]
async fn compute_health_advertises_sorted_language_list() {
    let dir = tempfile::tempdir().unwrap();
    let state = test_state(dir.path().to_path_buf(), None).with_compute(true);
    let app = vviewer::build_router(state);

    let res = app
        .oneshot(
            Request::builder()
                .uri("/api/health")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body = axum::body::to_bytes(res.into_body(), usize::MAX).await.unwrap();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let caps = json["capabilities"].as_array().unwrap();
    assert!(caps.iter().any(|c| c == "compute"));
    // 语言集合宣告（排序 canonical 名）。注册表生成式（server Task 5）：集合来自
    // grammars-manifest.json 可编译源，不再豁免特定语言（原「java 不在场」随
    // 硬编码子集退役，客户端路由豁免的前提已解除）
    let langs = json["computeLanguages"].as_array().expect("computeLanguages 应宣告");
    let names: Vec<&str> = langs.iter().map(|x| x.as_str().unwrap()).collect();
    let mut sorted = names.clone();
    sorted.sort_unstable();
    assert_eq!(names, sorted);
    assert!(names.contains(&"rust") && names.contains(&"python"));
}
