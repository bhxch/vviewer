//! Task 3 集成测试：Bearer 鉴权 / ticket 流程 / 路径穿越与 symlink / CORS。

use std::time::{Duration, Instant};

use axum::body::Body;
use axum::http::{Request, StatusCode};
use tower::ServiceExt;
use vviewer::state::AppState;

struct Fixture {
    _dir: tempfile::TempDir,
    state: AppState,
}

fn fixture(token: Option<&str>, cors_origin: Option<&str>) -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    std::fs::write(root.join("a.txt"), "visible").unwrap();
    std::fs::create_dir(root.join("sub")).unwrap();
    std::fs::write(root.join("sub/b.txt"), "inner").unwrap();

    Fixture {
        state: AppState::new(
            root.to_path_buf(),
            None,
            token.map(str::to_string),
            false,
            cors_origin.map(str::to_string),
        ),
        _dir: dir,
    }
}

async fn req(
    app: axum::Router,
    method: &str,
    uri: &str,
    authorization: Option<&str>,
) -> (StatusCode, axum::http::HeaderMap, axum::body::Bytes) {
    let mut builder = Request::builder().method(method).uri(uri);
    if let Some(auth) = authorization {
        builder = builder.header("authorization", auth);
    }
    let res = app
        .oneshot(builder.body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = res.status();
    let headers = res.headers().clone();
    let bytes = axum::body::to_bytes(res.into_body(), usize::MAX).await.unwrap();
    (status, headers, bytes)
}

fn json(bytes: &[u8]) -> serde_json::Value {
    serde_json::from_slice(bytes).unwrap()
}

// ---------- Bearer 鉴权 ----------

#[tokio::test]
async fn health_is_exempt_from_token() {
    let f = fixture(Some("tok-123"), None);
    let (status, _, _) = req(
        vviewer::build_router(f.state),
        "GET",
        "/api/health",
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn protected_api_requires_bearer() {
    let f = fixture(Some("tok-123"), None);
    let app = vviewer::build_router(f.state);

    let (status, _, body) = req(app.clone(), "GET", "/api/tree", None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert!(json(&body)["error"].is_string());

    let (status, _, _) = req(app.clone(), "GET", "/api/tree", Some("Bearer wrong")).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    // scheme 大小写不敏感
    let (status, _, _) = req(app.clone(), "GET", "/api/tree", Some("bearer tok-123")).await;
    assert_eq!(status, StatusCode::OK);

    let (status, _, _) = req(app, "GET", "/api/tree", Some("Bearer tok-123")).await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn file_endpoint_requires_bearer_too() {
    let f = fixture(Some("tok-123"), None);
    let app = vviewer::build_router(f.state);
    let (status, _, _) = req(app, "GET", "/api/file?path=a.txt", None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn no_token_config_allows_everything() {
    let f = fixture(None, None);
    let app = vviewer::build_router(f.state);
    let (status, _, _) = req(app.clone(), "GET", "/api/tree", None).await;
    assert_eq!(status, StatusCode::OK);
    let (status, _, _) = req(app, "POST", "/api/ticket", None).await;
    assert_eq!(status, StatusCode::OK);
}

// ---------- ticket ----------

#[tokio::test]
async fn ticket_requires_bearer_when_token_configured() {
    let f = fixture(Some("tok-123"), None);
    let (status, _, _) = req(
        vviewer::build_router(f.state),
        "POST",
        "/api/ticket",
        None,
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn ticket_flow_issue_consume_once_and_expiry() {
    let f = fixture(Some("tok-123"), None);
    let state = f.state.clone();
    let app = vviewer::build_router(state.clone());

    // 签发
    let (status, _, body) = req(
        app.clone(),
        "POST",
        "/api/ticket",
        Some("Bearer tok-123"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let ticket = json(&body)["ticket"].as_str().unwrap().to_string();
    assert_eq!(ticket.len(), 64, "32B hex");
    assert!(ticket.chars().all(|c| c.is_ascii_hexdigit()));

    // 无 ticket → 401
    let (status, _, _) = req(app.clone(), "GET", "/api/events", None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    // 有效 ticket → 通过校验
    let (status, _, _) = req(
        app.clone(),
        "GET",
        &format!("/api/events?ticket={ticket}"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    // 一次性：同一 ticket 二次使用 → 401
    let (status, _, _) = req(
        app.clone(),
        "GET",
        &format!("/api/events?ticket={ticket}"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    // 过期注入：直接操作 state 写入已过期 ticket → 401
    state
        .tickets
        .insert_raw("expired-tok".into(), Instant::now() - Duration::from_secs(1));
    let (status, _, _) = req(
        app,
        "GET",
        "/api/events?ticket=expired-tok",
        None,
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

// ---------- 路径安全 ----------

#[tokio::test]
async fn traversal_rejected_after_url_decode() {
    let f = fixture(Some("tok-123"), None);
    let app = vviewer::build_router(f.state);
    let auth = Some("Bearer tok-123");

    for uri in [
        "/api/tree?path=../secret",
        "/api/tree?path=%2e%2e%2fsecret", // ../secret URL 编码
        "/api/tree?path=sub%2f..%2f..%2fsecret",
        "/api/file?path=..%2fsecret",
        "/api/tree?path=%2Fetc", // 绝对路径
    ] {
        let (status, _, body) = req(app.clone(), "GET", uri, auth).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "uri={uri}");
        assert!(json(&body)["error"].is_string(), "uri={uri}");
    }
}

#[tokio::test]
async fn legitimate_subpath_still_works() {
    let f = fixture(Some("tok-123"), None);
    let app = vviewer::build_router(f.state);
    let (status, _, body) = req(
        app,
        "GET",
        "/api/file?path=sub/b.txt",
        Some("Bearer tok-123"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body.as_ref(), b"inner");
}

#[cfg(unix)]
#[tokio::test]
async fn symlink_escaping_root_forbidden_but_internal_allowed() {
    let f = fixture(Some("tok-123"), None);
    let root = f._dir.path();

    // root 外的机密文件与目录
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(outside.path().join("secret.txt"), "top-secret").unwrap();
    std::fs::create_dir(outside.path().join("sub")).unwrap();

    // 越界 symlink → 403
    std::os::unix::fs::symlink(outside.path().join("secret.txt"), root.join("leak.txt")).unwrap();
    std::os::unix::fs::symlink(outside.path().join("sub"), root.join("leakdir")).unwrap();

    // root 内 symlink（指向 root 内真实文件）→ 放行
    std::os::unix::fs::symlink(root.join("a.txt"), root.join("ok.txt")).unwrap();

    let app = vviewer::build_router(f.state.clone());
    let auth = Some("Bearer tok-123");

    let (status, _, body) = req(app.clone(), "GET", "/api/file?path=leak.txt", auth).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert!(json(&body)["error"].is_string());

    let (status, _, _) = req(app.clone(), "GET", "/api/tree?path=leakdir", auth).await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    let (status, _, body) = req(app, "GET", "/api/file?path=ok.txt", auth).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body.as_ref(), b"visible");

    drop(f);
    outside.close().unwrap();
}

// ---------- CORS ----------

#[tokio::test]
async fn cors_layer_applied_only_when_configured() {
    // 配置了 origin：简单请求回显 allow-origin
    let f = fixture(Some("tok-123"), Some("http://example.com"));
    let app = vviewer::build_router(f.state);
    let builder = Request::builder()
        .method("GET")
        .uri("/api/health")
        .header("origin", "http://example.com");
    let res = app.oneshot(builder.body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(
        res.headers()["access-control-allow-origin"],
        "http://example.com"
    );

    // 未配置：无 CORS 头
    let f = fixture(Some("tok-123"), None);
    let app = vviewer::build_router(f.state);
    let builder = Request::builder()
        .method("GET")
        .uri("/api/health")
        .header("origin", "http://example.com");
    let res = app.oneshot(builder.body(Body::empty()).unwrap()).await.unwrap();
    assert!(res.headers().get("access-control-allow-origin").is_none());

    // 预检：放行且不要求 Bearer
    let f = fixture(Some("tok-123"), Some("http://example.com"));
    let app = vviewer::build_router(f.state);
    let builder = Request::builder()
        .method("OPTIONS")
        .uri("/api/tree")
        .header("origin", "http://example.com")
        .header("access-control-request-method", "GET")
        .header("access-control-request-headers", "authorization");
    let res = app.oneshot(builder.body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(
        res.headers()["access-control-allow-origin"],
        "http://example.com"
    );
    assert!(res
        .headers()
        .get("access-control-allow-headers")
        .is_some_and(|v| v.to_str().unwrap().contains("authorization")));
}

#[tokio::test]
async fn cross_origin_not_echoed_for_unlisted_origin() {
    let f = fixture(Some("tok-123"), Some("http://example.com"));
    let app = vviewer::build_router(f.state);
    let builder = Request::builder()
        .method("GET")
        .uri("/api/health")
        .header("origin", "http://evil.example");
    let res = app.oneshot(builder.body(Body::empty()).unwrap()).await.unwrap();
    assert!(res.headers().get("access-control-allow-origin").is_none());
}
