//! Task 1 集成测试：/api/health 能力发现 + 静态资产挂载。

use axum::body::Body;
use axum::http::{header, HeaderValue, Request, StatusCode};
use tower::ServiceExt;
use vviewer::state::AppState;

fn test_state(root: std::path::PathBuf, web_dist: Option<std::path::PathBuf>) -> AppState {
    AppState::new(root, web_dist, None, false, None)
}

async fn get_body(
    app: axum::Router,
    uri: &str,
) -> (StatusCode, axum::body::Bytes) {
    get_body_with(app, uri, &[]).await
}

/// 带请求头的 oneshot：SPA fallback 的 Accept 收窄契约（SWR-DEF-01）需要区分
/// 导航形态（Accept 含 text/html）与 fetch/资源加载形态（`*/*` 或缺头）。
async fn get_body_with(
    app: axum::Router,
    uri: &str,
    headers: &[(header::HeaderName, &'static str)],
) -> (StatusCode, axum::body::Bytes) {
    let mut builder = Request::builder().uri(uri);
    for (name, value) in headers {
        builder = builder.header(name, HeaderValue::from_static(value));
    }
    let res = app
        .oneshot(builder.body(Body::empty()).unwrap())
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

    // SPA fallback：导航请求（Accept 含 text/html）的未知路径返回 index.html
    // （SWR-DEF-01 收窄后：非导航形态一律 404，见 spa_fallback_gated_on_navigation_accept）
    let (status, body) = get_body_with(
        app,
        "/some/spa/route",
        &[(
            header::ACCEPT,
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        )],
    )
    .await;
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

    // 非 .scm/.wasm 未知路径在导航形态下仍走 SPA fallback（回归确认修法不外溢）
    let (status, body) = get_body_with(
        app,
        "/some/spa/route",
        &[(
            header::ACCEPT,
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        )],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body.as_ref(), b"<html>spa-shell</html>");
}

/// SWR-DEF-01 修复锚（e2e 锚 SWR-ROUTE-07 的服务端契约面）：SPA fallback 只对导航
/// 请求生效。此前任何未知路径回 200 index.html——未知资产 URL（foreign 资产 .js）也
/// 拿到 200 HTML，被 SW 的 CacheFirst（cacheableResponse 只收 200）收进
/// vv-foreign-assets 缓存污染资产解析；收窄后非导航形态（fetch 的 `*/*`、缺头）一律
/// 404，404 被 cacheableResponse 拒收，污染面归零。
#[tokio::test]
async fn spa_fallback_gated_on_navigation_accept() {
    let root = tempfile::tempdir().unwrap();
    let dist = tempfile::tempdir().unwrap();
    std::fs::write(dist.path().join("index.html"), "<html>spa-shell</html>").unwrap();
    let app = vviewer::build_router(test_state(
        root.path().to_path_buf(),
        Some(dist.path().to_path_buf()),
    ));

    // fetch/XHR 形态（Accept: */*）：未知路径 → 404，不回 index.html
    let (status, body) = get_body_with(app.clone(), "/spa/route", &[(header::ACCEPT, "*/*")]).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "fetch 形态应 404");
    assert_ne!(body.as_ref(), b"<html>spa-shell</html>", "fetch 形态不得回 index.html");

    // 缺 Accept 头（非浏览器形态）：缺省拒绝 → 404
    let (status, body) = get_body(app.clone(), "/spa/route").await;
    assert_eq!(status, StatusCode::NOT_FOUND, "缺 Accept 头应缺省 404");
    assert_ne!(body.as_ref(), b"<html>spa-shell</html>");

    // 决定性用例：未知 .js 路径（模拟 foreign 资产 /file-viewer-assets/xxx.js）+ fetch
    // 形态 → 404（不再拿到 200 HTML 进 SW 运行时缓存）
    let (status, body) = get_body_with(
        app.clone(),
        "/file-viewer-assets/vendor/docx/docx.js",
        &[(header::ACCEPT, "*/*")],
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "foreign 资产形态未知 .js 应 404");
    assert_ne!(
        body.as_ref(),
        b"<html>spa-shell</html>",
        "未知 .js 不得回 index.html（SWR-DEF-01 污染面）"
    );

    // 导航形态（Accept 含 text/html）：未知路径 → 200 text/html（SPA 兜底保留）
    let (status, body) = get_body_with(
        app.clone(),
        "/spa/route",
        &[(header::ACCEPT, "text/html,application/xhtml+xml")],
    )
    .await;
    assert_eq!(status, StatusCode::OK, "导航形态应 200 兜底");
    assert_eq!(body.as_ref(), b"<html>spa-shell</html>");

    // `.scm`/`.wasm` 特判保持在前：导航形态下缺失的语法/查询资产仍 404（终审 C1，
    // 不得以 200 index.html 兜底），不被 Accept 收窄破坏
    for uri in ["/queries/elisp/injections.scm", "/grammars/tree-sitter-elisp.wasm"] {
        let (status, body) = get_body_with(
            app.clone(),
            uri,
            &[(header::ACCEPT, "text/html,application/xhtml+xml")],
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{uri} 特判应维持 404");
        assert_ne!(body.as_ref(), b"<html>spa-shell</html>", "{uri} 不得回 index.html");
    }
}

// 裁剪形态（worker）断言面为死路径：--compute 不宣告（native feature 门控，
// 修复轮 1 评审 M-1；core::health 的裁剪侧行为由 vviewer-core 锚测覆盖）。
#[cfg(feature = "native")]
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
