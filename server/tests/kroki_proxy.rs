// 裁剪形态（worker，--no-default-features）断言面为死路径：kroki 的 native
// 传输（ReqwestKrokiHttp）与 /api/kroki 路由随 native feature 编译裁剪
// （spec 2026-10-23 §8.2 门控语义，routes/kroki 同款门），本文件整体门禁化
// （tests/events.rs 先例；断言零变化——native 形态照常全量运行）。
#![cfg(feature = "native")]
//! Task 2（P3 批次）集成测试：`POST /api/kroki` 服务端代发端点（spec 2026-10-23
//! §8.2）。
//!
//! oneshot 既有模式（tests/mounts_api.rs 同款）。kroki 上游经 AppState 注入
//! mock [`KrokiHttp`]（`with_kroki` 整态注入——与 with_runtime_transport 的
//! MockTransport 缝同款），免真实外网（SSRF 面测试纪律）。断言面：
//! - 成功 200 `{svg}`：host 拼接与 raw body 透传经 mock 请求记录锚定；
//! - lang 白名单：路径注入形态 400（core 域裁决），且不触达上游（记录为空）；
//! - 鉴权矩阵：有 token 无 Bearer → 401（auth_mw 保护组，与 tree/file 同组）；
//! - body 显式上限 1MB（DefaultBodyLimit）：超限 413；
//! - [`ReqwestKrokiHttp`] 非 2xx 映射直测（评审承接项：core 无 upstream 构造
//!   器——4xx → 400 / 5xx → 500，消息透传上游 body 前 200 字节）：本地 TCP
//!   listener 手写最小 HTTP 响应，免真实外网。

use std::sync::{Arc, Mutex};

use axum::body::{Body, Bytes};
use axum::http::{HeaderMap, Request, StatusCode};
use async_trait::async_trait;
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tower::ServiceExt;
use vviewer::routes::kroki::ReqwestKrokiHttp;
use vviewer::state::AppState;
use vviewer_core::error::CoreError;
use vviewer_core::kroki::{KrokiHttp, KrokiState};

// ---------- fixture 与请求助手 ----------

/// kroki 上游 mock：按构造参数定成败与响应体，请求面（url, body）全量记录。
struct MockKrokiHttp {
    /// 上游响应字节（Ok 面）。
    body: Vec<u8>,
    /// Some = 恒返回该错误（Err 面——CoreError → AppError 适配映射状态/消息
    /// 原样透传）。
    error: Option<CoreError>,
    requests: Mutex<Vec<(String, Vec<u8>)>>,
}

impl MockKrokiHttp {
    fn ok(body: &[u8]) -> Self {
        Self { body: body.to_vec(), error: None, requests: Mutex::new(Vec::new()) }
    }

    fn recorded(&self) -> Vec<(String, Vec<u8>)> {
        self.requests.lock().unwrap().clone()
    }
}

#[async_trait]
impl KrokiHttp for MockKrokiHttp {
    async fn post_text(&self, url: String, body: Vec<u8>) -> Result<Vec<u8>, CoreError> {
        self.requests.lock().unwrap().push((url, body));
        match &self.error {
            Some(e) => Err(CoreError(e.0, e.1.clone())),
            None => Ok(self.body.clone()),
        }
    }
}

struct Fixture {
    _dir: tempfile::TempDir,
    state: AppState,
}

fn fixture(token: Option<&str>, http: MockKrokiHttp, kroki_host: &str) -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("local.txt"), b"local-root\n").unwrap();
    let state = AppState::new(
        dir.path().to_path_buf(),
        None,
        token.map(str::to_string),
        false,
        None,
    )
    .with_kroki(KrokiState { host: kroki_host.to_string(), http: Arc::new(http) });
    Fixture { _dir: dir, state }
}

async fn send(
    app: axum::Router,
    method: &str,
    uri: &str,
    authorization: Option<&str>,
    body: Option<Value>,
) -> (StatusCode, HeaderMap, Bytes) {
    let mut builder = Request::builder().method(method).uri(uri);
    if let Some(auth) = authorization {
        builder = builder.header("authorization", auth);
    }
    let req = match body {
        Some(v) => builder
            .header("content-type", "application/json")
            .body(Body::from(v.to_string()))
            .unwrap(),
        None => builder.body(Body::empty()).unwrap(),
    };
    let res = app.oneshot(req).await.unwrap();
    let status = res.status();
    let headers = res.headers().clone();
    let bytes = axum::body::to_bytes(res.into_body(), usize::MAX).await.unwrap();
    (status, headers, bytes)
}

fn kroki_body(lang: &str, source: &str) -> Value {
    json!({ "lang": lang, "source": source })
}

fn json(bytes: &[u8]) -> Value {
    serde_json::from_slice(bytes).unwrap()
}

// ---------- 成功面：200 {svg}，host 拼接与 raw body 透传 ----------

#[tokio::test]
async fn post_kroki_proxies_to_upstream_and_returns_svg() {
    const SVG: &[u8] = b"<svg xmlns='http://www.w3.org/2000/svg'/>";
    let mock = Arc::new(MockKrokiHttp::ok(SVG));
    let dir = tempfile::tempdir().unwrap();
    let state = AppState::new(dir.path().to_path_buf(), None, None, false, None).with_kroki(
        KrokiState { host: "http://kroki.internal.test/".into(), http: mock.clone() },
    );
    let app = vviewer::build_router(state);

    let (status, headers, body) = send(
        app,
        "POST",
        "/api/kroki",
        None,
        Some(kroki_body("svgbob", "+-->+")),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        headers["content-type"].to_str().unwrap(),
        "application/json"
    );
    assert_eq!(
        json(&body)["svg"].as_str().unwrap(),
        String::from_utf8(SVG.to_vec()).unwrap()
    );

    // 请求面锚定：host 拼接（尾斜杠归一、路径只含白名单 lang）+ raw body
    // 原样透传（不加工、不包装）
    let reqs = mock.recorded();
    assert_eq!(reqs.len(), 1, "{reqs:?}");
    assert_eq!(reqs[0].0, "http://kroki.internal.test/svgbob/svg", "host 拼接（尾斜杠归一）");
    assert_eq!(reqs[0].1, b"+-->+".to_vec(), "raw body 透传");
}

// ---------- lang 白名单：400 且不触达上游 ----------

#[tokio::test]
async fn post_kroki_invalid_lang_rejected_400_without_upstream_call() {
    let mock = Arc::new(MockKrokiHttp::ok(b"<svg/>"));
    let dir = tempfile::tempdir().unwrap();
    let state = AppState::new(dir.path().to_path_buf(), None, None, false, None).with_kroki(
        KrokiState { host: "http://kroki.internal.test".into(), http: mock.clone() },
    );
    let app = vviewer::build_router(state);

    for lang in ["../etc", "graphviz?x=1", "", "PlantUml"] {
        let (status, _, body) = send(
            app.clone(),
            "POST",
            "/api/kroki",
            None,
            Some(kroki_body(lang, "src")),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "lang={lang}");
        assert_eq!(json(&body)["error"], "invalid diagram language", "lang={lang}");
    }
    assert!(mock.recorded().is_empty(), "白名单拒绝不得触达上游");
}

// ---------- 鉴权矩阵：有 token 无 Bearer 401，携 Bearer 放行 ----------

#[tokio::test]
async fn kroki_requires_bearer_when_token_configured() {
    let mock = MockKrokiHttp::ok(b"<svg/>");
    let f = fixture(Some("sekret"), mock, "http://kroki.internal.test");
    let app = vviewer::build_router(f.state.clone());

    // 无 Bearer → 401（auth_mw 保护组）
    let (status, headers, body) = send(
        app.clone(),
        "POST",
        "/api/kroki",
        None,
        Some(kroki_body("svgbob", "+-->+")),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(headers["www-authenticate"], "Bearer");
    assert_eq!(json(&body)["error"], "unauthorized");

    // 携正确 Bearer → 200
    let (status, _, _) = send(
        app,
        "POST",
        "/api/kroki",
        Some("Bearer sekret"),
        Some(kroki_body("svgbob", "+-->+")),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
}

// ---------- body 显式上限 1MB（DefaultBodyLimit）→ 413 ----------

/// tower 层限值闸门：合法可解析的 JSON 仅因体积超 1MB 被拒——证明限值确实
/// 挂在 POST /api/kroki 路由（DefaultBodyLimit）。响应体是 axum 提取器拒绝
/// 的纯文本（非 JSON error 形状），只锚状态码。
#[tokio::test]
async fn post_kroki_over_1mb_body_rejected_413() {
    let mock = MockKrokiHttp::ok(b"<svg/>");
    let f = fixture(None, mock, "http://kroki.internal.test");
    let app = vviewer::build_router(f.state);

    // source 撑到 1MB+1：字段级合法（String 无形状限制），拒收只能来自限值层
    let big = kroki_body("svgbob", &"x".repeat(1024 * 1024 + 1));
    let (status, _, _) = send(app, "POST", "/api/kroki", None, Some(big)).await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
}

// ---------- ReqwestKrokiHttp 非 2xx 映射直测（本地 TCP listener，免外网） ----------

/// 手写最小 HTTP 响应的单发上游：返回 ReqwestKrokiHttp 对该上游的转发结局。
async fn upstream_once(status_line: &'static str, body: &'static str) -> Result<Vec<u8>, CoreError> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut sock, _) = listener.accept().await.unwrap();
        let mut buf = [0u8; 4096];
        let _ = sock.read(&mut buf).await; // 请求头/体不校验（转发的接缝面在 mock 用例）
        let resp = format!(
            "{status_line}\r\ncontent-type: text/plain\r\ncontent-length: {}\r\n\r\n{body}",
            body.len()
        );
        sock.write_all(resp.as_bytes()).await.unwrap();
    });
    let http = ReqwestKrokiHttp::new();
    let out = http.post_text(format!("http://{addr}/svgbob/svg"), b"src".to_vec()).await;
    server.await.unwrap();
    out
}

/// 评审承接项映射落地面：上游 4xx → bad_request（400）、5xx → internal（500），
/// 消息透传「kroki {status}: {body 前 200 字节}」；2xx → Ok(bytes) 原样返回。
#[tokio::test]
async fn reqwest_kroki_http_maps_upstream_status_to_core_error() {
    // 4xx → 400，消息含状态与上游 body
    let e = upstream_once("HTTP/1.1 400 Bad Request", "bad source!").await.unwrap_err();
    assert_eq!(e.0, StatusCode::BAD_REQUEST, "{e:?}");
    assert!(e.1.contains("kroki 400"), "{e:?}");
    assert!(e.1.contains("bad source!"), "{e:?}");

    // 5xx → 500
    let e = upstream_once("HTTP/1.1 500 Internal Server Error", "boom").await.unwrap_err();
    assert_eq!(e.0, StatusCode::INTERNAL_SERVER_ERROR, "{e:?}");
    assert!(e.1.contains("kroki 500"), "{e:?}");
    assert!(e.1.contains("boom"), "{e:?}");

    // 2xx → Ok(原样字节)
    let svg = upstream_once("HTTP/1.1 200 OK", "<svg/>").await.unwrap();
    assert_eq!(svg, b"<svg/>");
}

// ---------- 重定向禁跟随锁死（redirect Policy::none，终审加固） ----------

/// 上游 302 + Location：reqwest 禁重定向下 302 原样回流、不得跟随（防
/// 302→GET 改写出站目标构成内网响应中继面——部署侧上游是唯一合法目标，
/// 重定向即异常）。走完整 /api/kroki 端点锁死对外可观测面：302 非成功态
/// 也非 client_error → internal 500，消息透传上游状态（kroki 302）。
#[tokio::test]
async fn post_kroki_does_not_follow_upstream_redirect() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut sock, _) = listener.accept().await.unwrap();
        let mut buf = [0u8; 4096];
        let _ = sock.read(&mut buf).await; // 请求头/体不校验（同 upstream_once）
        // 302 指向另一内网目标：默认重定向策略会改发 GET 至 Location——
        // 禁跟随后该响应原样回流，出站面不变
        let resp = "HTTP/1.1 302 Found\r\nlocation: http://127.0.0.1:9/intranet\r\ncontent-length: 0\r\n\r\n";
        sock.write_all(resp.as_bytes()).await.unwrap();
    });
    let dir = tempfile::tempdir().unwrap();
    let state = AppState::new(dir.path().to_path_buf(), None, None, false, None).with_kroki(
        KrokiState { host: format!("http://{addr}"), http: Arc::new(ReqwestKrokiHttp::new()) },
    );
    let app = vviewer::build_router(state);

    let (status, _, body) = send(
        app,
        "POST",
        "/api/kroki",
        None,
        Some(kroki_body("svgbob", "+-->+")),
    )
    .await;
    server.await.unwrap();
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{body:?}");
    assert!(String::from_utf8_lossy(&body).contains("kroki 302"), "{body:?}");
}
