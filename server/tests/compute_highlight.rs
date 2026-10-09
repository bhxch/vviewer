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

// ---------- range 协议（阶段 4 Task 1：服务端按可视区高亮契约） ----------

/// 8 行 rust fixture（0 起行号，wc -l 口径，末行带换行）：line 5 "fn target() {"、
/// line 6 "    let x = 1;"——range 切片后 chunk 内 keyword 偏移可精确预算
/// （fn@0..2、let@18..21）。
const RANGE_SAMPLE: &str = "//! lazy range fixture\nfn a() {}\nfn b() {}\nfn c() {}\nfn d() {}\nfn target() {\n    let x = 1;\n}\n";

/// chunk（line 5 起 3 行，\n join）内的两个 keyword 区间断言（精确 UTF-16 偏移）。
fn assert_chunk_keyword_intervals(body: &Value) {
    let captures: Vec<&str> =
        body["captures"].as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
    let is_keyword = |ci: u64| {
        let c = captures[ci as usize];
        c == "keyword" || c.starts_with("keyword.")
    };
    let intervals = body["intervals"].as_array().unwrap();
    let has_fn = intervals.iter().any(|iv| {
        let t = iv.as_array().unwrap();
        t[0].as_u64() == Some(0) && t[1].as_u64() == Some(2) && is_keyword(t[2].as_u64().unwrap())
    });
    assert!(has_fn, "chunk 首行 \"fn\" 应有恰在 [0,2) 的 keyword 区间: {body}");
    let has_let = intervals.iter().any(|iv| {
        let t = iv.as_array().unwrap();
        t[0].as_u64() == Some(18) && t[1].as_u64() == Some(21) && is_keyword(t[2].as_u64().unwrap())
    });
    assert!(has_let, "chunk 次行 \"let\" 应有恰在 [18,21) 的 keyword 区间: {body}");
}

/// 用例 1：range 首段 {0,3} → 200、baseLine==0、区间非空。
#[tokio::test]
async fn highlight_range_first_window_baseline_zero() {
    let _serial = serial_lock();
    cache_reset();
    let f = fixture(true, None);
    std::fs::write(f._dir.path().join("win.rs"), RANGE_SAMPLE).unwrap();
    let (status, body) = post_json(
        f.app,
        "/api/compute/highlight",
        None,
        json!({ "path": "win.rs", "lang": "rust", "range": { "startLine": 0, "lineCount": 3 } }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["baseLine"].as_u64(), Some(0), "首段 baseLine=0: {body}");
    assert!(!body["intervals"].as_array().unwrap().is_empty(), "区间非空: {body}");
}

/// 用例 2：range 中段 {5,3} → 200、baseLine==5、区间相对 chunk 首行
/// （fn@0..2、let@18..21 均落在对应行的 UTF-16 长度内）。
#[tokio::test]
async fn highlight_range_middle_window_offsets_relative_to_chunk() {
    let _serial = serial_lock();
    cache_reset();
    let f = fixture(true, None);
    std::fs::write(f._dir.path().join("win.rs"), RANGE_SAMPLE).unwrap();
    let (status, body) = post_json(
        f.app,
        "/api/compute/highlight",
        None,
        json!({ "path": "win.rs", "lang": "rust", "range": { "startLine": 5, "lineCount": 3 } }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["baseLine"].as_u64(), Some(5), "baseLine=startLine: {body}");
    assert_chunk_keyword_intervals(&body);
}

/// 用例 3：lineCount 越过文件尾（startLine=末 2 行、lineCount=10）→ 200 截断，
/// 响应与 lineCount=2 的精确请求完全一致（截断语义的行为锚），区间不越 chunk。
#[tokio::test]
async fn highlight_range_overruns_file_tail_truncates() {
    let _serial = serial_lock();
    cache_reset();
    let f = fixture(true, None);
    std::fs::write(f._dir.path().join("win.rs"), RANGE_SAMPLE).unwrap();
    let (status, body) = post_json(
        f.app.clone(),
        "/api/compute/highlight",
        None,
        json!({ "path": "win.rs", "lang": "rust", "range": { "startLine": 6, "lineCount": 10 } }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status2, body2) = post_json(
        f.app,
        "/api/compute/highlight",
        None,
        json!({ "path": "win.rs", "lang": "rust", "range": { "startLine": 6, "lineCount": 2 } }),
    )
    .await;
    assert_eq!(status2, StatusCode::OK);
    assert_eq!(body, body2, "越界请求应截断为与精确请求一致: {body} vs {body2}");
    assert_eq!(body["baseLine"].as_u64(), Some(6));
    // chunk = "    let x = 1;\n}"（UTF-16 长 16）：区间不越界
    let utf16_len = "    let x = 1;\n}".encode_utf16().count();
    for iv in body["intervals"].as_array().unwrap() {
        let t = iv.as_array().unwrap();
        assert!(t[1].as_u64().unwrap() <= utf16_len as u64, "区间不越 chunk: {iv}");
    }
}

/// 用例 4：startLine 越界（== 总行数、远超）→ 400 且报实际行数；
/// 边界对照 startLine=末行（7）合法 → 200。
#[tokio::test]
async fn highlight_range_start_line_beyond_eof_400() {
    let _serial = serial_lock();
    cache_reset();
    let f = fixture(true, None);
    std::fs::write(f._dir.path().join("win.rs"), RANGE_SAMPLE).unwrap();
    for start in [8u64, 100] {
        let (status, body) = post_json(
            f.app.clone(),
            "/api/compute/highlight",
            None,
            json!({ "path": "win.rs", "lang": "rust", "range": { "startLine": start, "lineCount": 1 } }),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "startLine={start}: {body}");
        assert!(
            body["error"].as_str().unwrap().contains("8 lines"),
            "错误应携带实际行数: {body}"
        );
    }
    let (status, body) = post_json(
        f.app,
        "/api/compute/highlight",
        None,
        json!({ "path": "win.rs", "lang": "rust", "range": { "startLine": 7, "lineCount": 1 } }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "末行合法: {body}");
    assert_eq!(body["baseLine"].as_u64(), Some(7));
}

/// 用例 5：lineCount=0 → 400；lineCount=5001 → 400；lineCount=5000（上限值，
/// 文件仅 8 行自然截断）→ 200。
#[tokio::test]
async fn highlight_range_line_count_bounds() {
    let _serial = serial_lock();
    cache_reset();
    let f = fixture(true, None);
    std::fs::write(f._dir.path().join("win.rs"), RANGE_SAMPLE).unwrap();
    for line_count in [0u64, 5001] {
        let (status, body) = post_json(
            f.app.clone(),
            "/api/compute/highlight",
            None,
            json!({
                "path": "win.rs", "lang": "rust",
                "range": { "startLine": 0, "lineCount": line_count }
            }),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "lineCount={line_count}: {body}");
        assert!(body["error"].is_string(), "{body}");
    }
    let (status, body) = post_json(
        f.app,
        "/api/compute/highlight",
        None,
        json!({ "path": "win.rs", "lang": "rust", "range": { "startLine": 0, "lineCount": 5000 } }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "上限值 5000 合法（自然截断）: {body}");
    assert_eq!(body["baseLine"].as_u64(), Some(0));
}

/// 用例 6：text 模式带 range → 400（仅 path 模式接受 range）。
#[tokio::test]
async fn highlight_range_with_text_mode_400() {
    let f = fixture(true, None);
    let (status, body) = post_json(
        f.app,
        "/api/compute/highlight",
        None,
        json!({
            "text": "fn f() {}\n", "lang": "rust",
            "range": { "startLine": 0, "lineCount": 3 }
        }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert!(body["error"].as_str().unwrap().contains("range"), "{body}");
}

/// 用例 7：CRLF 文件 range 的区间与 LF 版本完全一致（归一化口径与整文件路径同源）。
#[tokio::test]
async fn highlight_range_crlf_intervals_match_lf() {
    let _serial = serial_lock();
    cache_reset();
    let f = fixture(true, None);
    let dir = f._dir.path();
    let lf = "fn a() {\n    let x = 1;\n}\n";
    std::fs::write(dir.join("lf.rs"), lf).unwrap();
    std::fs::write(dir.join("crlf.rs"), lf.replace('\n', "\r\n")).unwrap();
    let (_, lf_body) = post_json(
        f.app.clone(),
        "/api/compute/highlight",
        None,
        json!({ "path": "lf.rs", "lang": "rust", "range": { "startLine": 0, "lineCount": 3 } }),
    )
    .await;
    let (_, crlf_body) = post_json(
        f.app,
        "/api/compute/highlight",
        None,
        json!({ "path": "crlf.rs", "lang": "rust", "range": { "startLine": 0, "lineCount": 3 } }),
    )
    .await;
    assert!(!lf_body["intervals"].as_array().unwrap().is_empty(), "LF 区间非空（防双空相等）");
    assert_eq!(lf_body["intervals"], crlf_body["intervals"], "CRLF 区间应与 LF 一致");
    assert_eq!(lf_body["captures"], crlf_body["captures"]);
    assert_eq!(lf_body["baseLine"], crlf_body["baseLine"]);
}

/// 用例 8：多字节行（中文 + emoji）range：区间 UTF-16 偏移相对 chunk 换算正确
/// （"fn" 应在 16..18 = 首行 UTF-16 长 15 + 换行 1；字节口径会是 22——锁定单位）。
#[tokio::test]
async fn highlight_range_multibyte_utf16_offsets() {
    let _serial = serial_lock();
    cache_reset();
    let f = fixture(true, None);
    let src = "let s = \"你好😀\";\nfn g() {}\n";
    std::fs::write(f._dir.path().join("cjk.rs"), src).unwrap();
    let (status, body) = post_json(
        f.app,
        "/api/compute/highlight",
        None,
        json!({ "path": "cjk.rs", "lang": "rust", "range": { "startLine": 0, "lineCount": 2 } }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["baseLine"].as_u64(), Some(0));
    let captures: Vec<&str> =
        body["captures"].as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
    let has_fn = body["intervals"].as_array().unwrap().iter().any(|iv| {
        let t = iv.as_array().unwrap();
        t[0].as_u64() == Some(16)
            && t[1].as_u64() == Some(18)
            && {
                let c = captures[t[2].as_u64().unwrap() as usize];
                c == "keyword" || c.starts_with("keyword.")
            }
    });
    assert!(has_fn, "\"fn\" 应在 chunk UTF-16 偏移 [16,18): {body}");
}

/// 用例 9：无 range 的旧请求 → baseLine==0 且与 text 模式同内容响应完全一致
/// （回归锚：无 range 路径行为不变）。
#[tokio::test]
async fn highlight_without_range_legacy_anchor_base_line_zero() {
    let _serial = serial_lock();
    cache_reset();
    let f = fixture(true, None);
    std::fs::write(f._dir.path().join("win.rs"), RANGE_SAMPLE).unwrap();
    let (status, body) = post_json(
        f.app.clone(),
        "/api/compute/highlight",
        None,
        json!({ "path": "win.rs", "lang": "rust" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["baseLine"].as_u64(), Some(0), "无 range baseLine=0: {body}");
    let (status2, body2) = post_json(
        f.app,
        "/api/compute/highlight",
        None,
        json!({ "text": RANGE_SAMPLE, "lang": "rust" }),
    )
    .await;
    assert_eq!(status2, StatusCode::OK);
    assert_eq!(body, body2, "path 无 range 与 text 同内容响应应一致（回归锚）");
    cache_reset();
}

/// 用例 10：LRU 键含 range 维度——同 range 二次命中缓存，不同 range / 无 range
/// 均不互命中（计数精确断言）。
#[tokio::test]
async fn highlight_range_lru_keyed_by_range_dimension() {
    let _serial = serial_lock();
    cache_reset();
    let f = fixture(true, None);
    std::fs::write(f._dir.path().join("win.rs"), RANGE_SAMPLE).unwrap();
    let range_a = json!({ "path": "win.rs", "lang": "rust", "range": { "startLine": 0, "lineCount": 3 } });
    let range_b = json!({ "path": "win.rs", "lang": "rust", "range": { "startLine": 5, "lineCount": 3 } });
    let no_range = json!({ "path": "win.rs", "lang": "rust" });
    let before = cache_stats();

    let (s, first_a) = post_json(f.app.clone(), "/api/compute/highlight", None, range_a.clone()).await;
    assert_eq!(s, StatusCode::OK, "{first_a}");
    let (_, second_a) = post_json(f.app.clone(), "/api/compute/highlight", None, range_a.clone()).await;
    assert_eq!(first_a, second_a, "同 range 二次响应一致（命中缓存）");
    let (s, first_b) = post_json(f.app.clone(), "/api/compute/highlight", None, range_b.clone()).await;
    assert_eq!(s, StatusCode::OK, "不同 range 不得命中 A 的条目: {first_b}");
    let (_, second_b) = post_json(f.app.clone(), "/api/compute/highlight", None, range_b.clone()).await;
    assert_eq!(first_b, second_b);
    let (s, _) = post_json(f.app.clone(), "/api/compute/highlight", None, no_range.clone()).await;
    assert_eq!(s, StatusCode::OK, "无 range 占位键不得命中 range 条目");
    let (_, third_a) = post_json(f.app, "/api/compute/highlight", None, range_a).await;
    assert_eq!(third_a, first_a);

    let (hits, misses) = cache_stats();
    assert_eq!((hits - before.0, misses - before.1), (3, 3), "命中 3 次（A×2、B×1）miss 3 次");
    cache_reset();
}

/// 裁决补充：空文件（0 行）任何 range → 400（含实际行数 0）。
#[tokio::test]
async fn highlight_range_empty_file_400() {
    let _serial = serial_lock();
    cache_reset();
    let f = fixture(true, None);
    std::fs::write(f._dir.path().join("empty.rs"), "").unwrap();
    let (status, body) = post_json(
        f.app,
        "/api/compute/highlight",
        None,
        json!({ "path": "empty.rs", "lang": "rust", "range": { "startLine": 0, "lineCount": 3 } }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert!(body["error"].as_str().unwrap().contains("0 lines"), "报实际行数: {body}");
}

/// 平价补充：range 模式非 UTF-8 文件 → 400（与整文件路径的 InvalidData 语义一致，
/// 不因流式读行走 500）。
#[tokio::test]
async fn highlight_range_invalid_utf8_400() {
    let _serial = serial_lock();
    cache_reset();
    let f = fixture(true, None);
    std::fs::write(f._dir.path().join("bin.rs"), b"\xff\xfe\x00bad").unwrap();
    let (status, body) = post_json(
        f.app,
        "/api/compute/highlight",
        None,
        json!({ "path": "bin.rs", "lang": "rust", "range": { "startLine": 0, "lineCount": 3 } }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
}
