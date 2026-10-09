//! Task 3 集成测试：POST /api/compute/highlight（tree-sitter 服务端高亮）。
//!
//! 覆盖：text 模式区间语义、未知语言 400、20MB 上限 413、path 模式 + 缓存
//! 命中（计数观测钩子）、path 穿越 403、鉴权与 --compute 开关。

use std::os::unix::fs::symlink;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use serde_json::{json, Value};
use tower::ServiceExt;
use vviewer::compute::highlight::{cache_reset, cache_stats};
use vviewer::state::AppState;

struct Fixture {
    _dir: tempfile::TempDir,
    app: axum::Router,
}

/// 全局响应缓存是进程级静态：依赖 cache_reset/计数的用例必须串行，
/// 否则并发用例的 reset 会让对方的 miss/hit 计数快照失效（与单测模块同约定）。
fn serial_lock() -> std::sync::MutexGuard<'static, ()> {
    static SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());
    SERIAL.lock().unwrap_or_else(|p| p.into_inner())
}

fn fixture(compute: bool, token: Option<&str>) -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let state =
        AppState::new(dir.path().to_path_buf(), None, token.map(str::to_string), false, None)
            .with_compute(compute);
    let app = vviewer::build_router(state);
    Fixture { _dir: dir, app }
}

async fn post_json(
    app: axum::Router,
    uri: &str,
    authorization: Option<&str>,
    body: Value,
) -> (StatusCode, Value) {
    let mut builder = Request::builder()
        .method("POST")
        .uri(uri)
        .header("content-type", "application/json");
    if let Some(auth) = authorization {
        builder = builder.header("authorization", auth);
    }
    let res = app
        .oneshot(builder.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = res.status();
    let bytes = axum::body::to_bytes(res.into_body(), usize::MAX).await.unwrap();
    let body = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, body)
}

const RUST_SAMPLE: &str = r#"//! 示例源码：中文注释与 emoji 😀 混排
fn main() {
    let msg = "你好 world";
    println!("{msg}");
}
"#;

// ---------- text 模式 ----------

#[tokio::test]
async fn highlight_rust_text_yields_intervals_with_keyword_capture() {
    let f = fixture(true, None);
    let (status, body) = post_json(
        f.app,
        "/api/compute/highlight",
        None,
        json!({ "text": RUST_SAMPLE, "lang": "rust" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let intervals = body["intervals"].as_array().expect("intervals 数组");
    assert!(!intervals.is_empty(), "区间非空");
    // 三元组形状
    for iv in intervals {
        let t = iv.as_array().unwrap();
        assert_eq!(t.len(), 3, "三元组: {iv}");
        assert!(t[0].is_u64() && t[1].is_u64() && t[2].is_u64(), "{iv}");
    }
    let captures: Vec<&str> =
        body["captures"].as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
    assert!(
        captures.iter().any(|c| *c == "keyword" || c.starts_with("keyword.")),
        "应含 keyword 类捕获: {captures:?}"
    );
    // UTF-16 偏移不越界（样本含 CJK/emoji，若按字节算必超 UTF-16 长度）
    let utf16_len = RUST_SAMPLE.encode_utf16().count();
    for iv in intervals {
        let t = iv.as_array().unwrap();
        assert!(t[1].as_u64().unwrap() <= utf16_len as u64, "区间在 UTF-16 长度内: {iv}");
    }
}

#[tokio::test]
async fn highlight_empty_text_ok() {
    let f = fixture(true, None);
    let (status, body) =
        post_json(f.app, "/api/compute/highlight", None, json!({ "text": "", "lang": "rust" }))
            .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["intervals"].as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn highlight_unknown_lang_400() {
    let f = fixture(true, None);
    let (status, body) = post_json(
        f.app,
        "/api/compute/highlight",
        None,
        json!({ "text": "x", "lang": "brainfuck" }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(body["error"].as_str().unwrap().contains("unsupported language"), "{body}");
}

#[tokio::test]
async fn highlight_missing_lang_400() {
    let f = fixture(true, None);
    let (status, body) =
        post_json(f.app, "/api/compute/highlight", None, json!({ "text": "x" })).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(body["error"].is_string(), "{body}");
}

#[tokio::test]
async fn highlight_missing_path_and_text_400() {
    let f = fixture(true, None);
    let (status, body) =
        post_json(f.app, "/api/compute/highlight", None, json!({ "lang": "rust" })).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(body["error"].as_str().unwrap().contains("path or text"), "{body}");
}

#[tokio::test]
async fn highlight_over_20mb_text_413() {
    let f = fixture(true, None);
    let big = "a".repeat(20 * 1024 * 1024 + 1);
    let (status, body) = post_json(
        f.app,
        "/api/compute/highlight",
        None,
        json!({ "text": big, "lang": "rust" }),
    )
    .await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    assert!(body["error"].is_string(), "413 应有 JSON error: {body}");
}

// ---------- java 与 html→js 注入（阶段 1 收口，Highlighter 端到端） ----------

#[tokio::test]
async fn highlight_java_ok() {
    let f = fixture(true, None);
    let (status, body) = post_json(
        f.app,
        "/api/compute/highlight",
        None,
        json!({ "text": "class A { int x = 1; }", "lang": "java" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(!body["intervals"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn highlight_html_injects_javascript() {
    let f = fixture(true, None);
    let with_js = "<html><body><script>let x = 1;</script></body></html>";
    let without_js = "<html><body><p>plain</p></body></html>";
    let (s1, b1) = post_json(f.app.clone(), "/api/compute/highlight", None,
        json!({ "text": with_js, "lang": "html" })).await;
    let (s2, b2) = post_json(f.app, "/api/compute/highlight", None,
        json!({ "text": without_js, "lang": "html" })).await;
    assert_eq!((s1, s2), (StatusCode::OK, StatusCode::OK));
    let n1 = b1["intervals"].as_array().unwrap().len();
    let n2 = b2["intervals"].as_array().unwrap().len();
    assert!(n1 > n2, "注入 JS 后区间应更多: {n1} vs {n2}");
}

// ---------- path 模式 + 缓存 ----------

#[tokio::test]
async fn highlight_path_mode_parses_and_second_call_hits_cache() {
    let _serial = serial_lock();
    let f = fixture(true, None);
    let dir = f._dir.path();
    std::fs::write(dir.join("main.rs"), RUST_SAMPLE).unwrap();
    cache_reset();
    let before = cache_stats();

    let (status, body) = post_json(
        f.app.clone(),
        "/api/compute/highlight",
        None,
        json!({ "path": "main.rs", "lang": "rust" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(!body["intervals"].as_array().unwrap().is_empty());
    let after_first = cache_stats();
    assert!(
        after_first.1 > before.1,
        "首次未命中（miss 计数增加）: {before:?} → {after_first:?}"
    );

    // mtime/size 不变：第二次应命中缓存（响应一致 + hits 计数增加）
    let (status2, body2) = post_json(
        f.app,
        "/api/compute/highlight",
        None,
        json!({ "path": "main.rs", "lang": "rust" }),
    )
    .await;
    assert_eq!(status2, StatusCode::OK);
    assert_eq!(body, body2, "缓存响应与首次一致");
    let after_second = cache_stats();
    assert!(after_second.0 > after_first.0, "命中计数增加: {after_first:?} → {after_second:?}");
    cache_reset();
}

#[tokio::test]
async fn highlight_path_mode_404_when_missing() {
    let f = fixture(true, None);
    let (status, body) = post_json(
        f.app,
        "/api/compute/highlight",
        None,
        json!({ "path": "no/such.rs", "lang": "rust" }),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
}

#[tokio::test]
async fn highlight_path_mode_traversal_rejected() {
    let f = fixture(true, None);
    let dir = f._dir.path();
    // `..` 段：清洗即拒（400）
    let (status, _) = post_json(
        f.app.clone(),
        "/api/compute/highlight",
        None,
        json!({ "path": "../outside.rs", "lang": "rust" }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "`..` 段应 400");

    // symlink 指向 root 外：canonicalize 越界（403）
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(outside.path().join("secret.rs"), "fn f() {}\n").unwrap();
    symlink(outside.path().join("secret.rs"), dir.join("leak.rs")).unwrap();
    let (status, body) = post_json(
        f.app,
        "/api/compute/highlight",
        None,
        json!({ "path": "leak.rs", "lang": "rust" }),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "symlink 越界应 403: {body}");
}

#[tokio::test]
async fn highlight_path_mode_directory_400_and_overlarge_file_413() {
    let f = fixture(true, None);
    let dir = f._dir.path();
    std::fs::create_dir(dir.join("sub")).unwrap();
    let (status, _) = post_json(
        f.app.clone(),
        "/api/compute/highlight",
        None,
        json!({ "path": "sub", "lang": "rust" }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "目录不是文件");

    let big = "x".repeat(20 * 1024 * 1024 + 1);
    std::fs::write(dir.join("big.rs"), &big).unwrap();
    let (status, body) = post_json(
        f.app,
        "/api/compute/highlight",
        None,
        json!({ "path": "big.rs", "lang": "rust" }),
    )
    .await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE, "{body}");
}

// ---------- path 模式 CRLF 归一化（与客户端 renderCode 口径一致） ----------

#[tokio::test]
async fn highlight_path_mode_crlf_intervals_on_normalized_text() {
    let _serial = serial_lock();
    let f = fixture(true, None);
    let dir = f._dir.path();
    // CRLF 文件：客户端按归一化（LF）文本渲染行，服务端若在含 \r 原文上换算
    // Utf16Index，第二行起区间整体右移（每个前导 \r +1）
    let crlf = "fn main() {\r\n    let x = 1;\r\n}\r\n";
    std::fs::write(dir.join("crlf.rs"), crlf).unwrap();
    cache_reset();

    let (status, body) = post_json(
        f.app,
        "/api/compute/highlight",
        None,
        json!({ "path": "crlf.rs", "lang": "rust" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");

    // 归一化文本中第二行 "let" 的 UTF-16 起点应为 16；若未归一化会是 17（\r 入账）
    let normalized = crlf.replace("\r\n", "\n");
    let let_start = normalized.find("let x").unwrap() as u64;
    assert_eq!(let_start, 16, "归一化后 let 起点（防用例自身漂移）");
    let captures: Vec<&str> =
        body["captures"].as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
    let intervals = body["intervals"].as_array().unwrap();
    let has_let_keyword = intervals.iter().any(|iv| {
        let t = iv.as_array().unwrap();
        let (s, e, ci) = (t[0].as_u64().unwrap(), t[1].as_u64().unwrap(), t[2].as_u64().unwrap() as usize);
        s == let_start && e == let_start + 3 && (captures[ci] == "keyword" || captures[ci].starts_with("keyword."))
    });
    assert!(
        has_let_keyword,
        "\"let\" 应有起点恰在归一化位置 {let_start} 的 keyword 区间: {intervals:?}"
    );
    cache_reset();
}

// ---------- 开关与鉴权 ----------

#[tokio::test]
async fn highlight_404_without_compute_flag() {
    let f = fixture(false, None);
    let (status, body) = post_json(
        f.app,
        "/api/compute/highlight",
        None,
        json!({ "text": "x", "lang": "rust" }),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert!(body["error"].is_string());
}

#[tokio::test]
async fn highlight_requires_bearer_when_token_configured() {
    let f = fixture(true, Some("tok-1"));
    let (status, _) = post_json(
        f.app.clone(),
        "/api/compute/highlight",
        None,
        json!({ "text": "fn f() {}\n", "lang": "rust" }),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, body) = post_json(
        f.app,
        "/api/compute/highlight",
        Some("Bearer tok-1"),
        json!({ "text": "fn f() {}\n", "lang": "rust" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
}

/// BUG-10 收尾：highlight 响应按 Accept-Encoding: gzip 协商压缩（intervals 可达
/// 十余 MB，浏览器默认携带该头）。仅断言协商生效（header + gzip magic），
/// 压缩本体由 tower-http CompressionLayer 保证。
#[tokio::test]
async fn highlight_response_gzip_when_requested() {
    let _guard = serial_lock();
    cache_reset();
    let f = fixture(true, None);
    let res = f
        .app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/compute/highlight")
                .header("content-type", "application/json")
                .header("accept-encoding", "gzip")
                .body(Body::from(json!({ "text": RUST_SAMPLE, "lang": "rust" }).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(res.headers().get("content-encoding").unwrap(), "gzip");
    let bytes = axum::body::to_bytes(res.into_body(), usize::MAX).await.unwrap();
    // gzip magic：1f 8b
    assert_eq!(&bytes[0..2], &[0x1f, 0x8b]);
}

/// 对照：不带 Accept-Encoding: gzip 时响应不压缩（原样 JSON）。
#[tokio::test]
async fn highlight_response_identity_without_gzip_accept() {
    let _guard = serial_lock();
    cache_reset();
    let f = fixture(true, None);
    let res = f
        .app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/compute/highlight")
                .header("content-type", "application/json")
                .body(Body::from(json!({ "text": RUST_SAMPLE, "lang": "rust" }).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    assert!(res.headers().get("content-encoding").is_none());
    let bytes = axum::body::to_bytes(res.into_body(), usize::MAX).await.unwrap();
    assert_eq!(&bytes[0..1], b"{");
}
