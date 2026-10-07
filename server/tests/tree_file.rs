//! Task 2 集成测试：/api/tree（排序/过滤/404）与 /api/file（Range/MIME/X-VV 头）。

use axum::body::Body;
use axum::http::{HeaderMap, Request, StatusCode};
use tower::ServiceExt;
use vviewer::state::AppState;

struct Fixture {
    _dir: tempfile::TempDir,
    state: AppState,
}

fn fixture(hidden: bool) -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    std::fs::write(root.join("a2.txt"), b"two").unwrap();
    std::fs::write(root.join("a10.txt"), b"ten").unwrap();
    std::fs::write(root.join("empty.txt"), b"").unwrap();
    std::fs::write(root.join("中文.txt"), "中文内容").unwrap();
    std::fs::write(root.join(".secret"), b"hidden-content").unwrap();
    std::fs::create_dir(root.join(".hdir")).unwrap();
    std::fs::create_dir(root.join("子目录")).unwrap();
    std::fs::write(root.join("子目录/内.txt"), "inner").unwrap();
    std::fs::write(root.join("data.rs"), "fn main() {}").unwrap();
    // "中文" 的 GBK 字节：非法 UTF-8 → gb18030
    std::fs::write(root.join("gb.txt"), [0xd6u8, 0xd0, 0xce, 0xc4]).unwrap();
    // UTF-16LE BOM
    std::fs::write(root.join("u16le.txt"), [0xffu8, 0xfe, 0x61, 0x00]).unwrap();
    std::fs::write(root.join("digits.bin"), b"0123456789").unwrap();
    // 8KB 边界截断的多字节字符（8190 ASCII + 3 字节 "你"）→ 前缀容错 utf-8
    let mut straddle = vec![b'a'; 8190];
    straddle.extend_from_slice("你".as_bytes());
    std::fs::write(root.join("straddle.txt"), &straddle).unwrap();
    // 文件尾悬空多字节前缀（全文件 <8KB）→ 严格判否 gb18030
    std::fs::write(root.join("lone.bin"), [0xE4u8, 0xBD]).unwrap();

    Fixture {
        state: AppState::new(root.to_path_buf(), None, None, hidden, None),
        _dir: dir,
    }
}

async fn get(app: axum::Router, uri: &str) -> (StatusCode, HeaderMap, axum::body::Bytes) {
    get_with(app, uri, |b| b).await
}

async fn get_with<F>(
    app: axum::Router,
    uri: &str,
    set_headers: F,
) -> (StatusCode, HeaderMap, axum::body::Bytes)
where
    F: FnOnce(axum::http::request::Builder) -> axum::http::request::Builder,
{
    let req = set_headers(Request::builder().uri(uri)).body(Body::empty()).unwrap();
    let res = app.oneshot(req).await.unwrap();
    let status = res.status();
    let headers = res.headers().clone();
    let bytes = axum::body::to_bytes(res.into_body(), usize::MAX).await.unwrap();
    (status, headers, bytes)
}

async fn tree_json(app: axum::Router, uri: &str) -> serde_json::Value {
    let (status, _, body) = get(app, uri).await;
    assert_eq!(status, StatusCode::OK, "uri={uri}");
    serde_json::from_slice(&body).unwrap()
}

// ---------- /api/tree ----------

#[tokio::test]
async fn tree_root_dirs_first_then_natural_order() {
    let f = fixture(false);
    let json = tree_json(vviewer::build_router(f.state), "/api/tree").await;
    let names: Vec<&str> = json["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["name"].as_str().unwrap())
        .collect();

    assert_eq!(
        names,
        vec![
            ".hdir",       // 目录优先；目录间也按自然序
            "子目录",      // 目录优先
            ".secret",     // 文件按自然序：'.'(0x2e) 最小
            "a2.txt",      // 自然序：2 < 10
            "a10.txt",
            "data.rs",
            "digits.bin",
            "empty.txt",
            "gb.txt",
            "lone.bin",
            "straddle.txt",
            "u16le.txt",
            "中文.txt",
        ]
    );

    // 条目形状：目录无 size；文件有 size + mtime
    let first = &json["entries"][0];
    assert_eq!(first["kind"], "dir");
    assert!(first.get("size").is_none());
    let a2 = &json["entries"].as_array().unwrap()[3];
    assert_eq!(a2["kind"], "file");
    assert_eq!(a2["size"], 3);
    assert!(a2["mtime"].is_u64());
}

#[tokio::test]
async fn tree_hidden_filters_dot_entries() {
    let f = fixture(true);
    let json = tree_json(vviewer::build_router(f.state), "/api/tree").await;
    let names: Vec<&str> = json["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["name"].as_str().unwrap())
        .collect();
    assert!(!names.iter().any(|n| n.starts_with('.')), "names={names:?}");
    assert!(names.contains(&"a2.txt"));
}

#[tokio::test]
async fn tree_subdirectory_with_encoded_chinese_path() {
    let f = fixture(false);
    let json = tree_json(
        vviewer::build_router(f.state),
        "/api/tree?path=%E5%AD%90%E7%9B%AE%E5%BD%95",
    )
    .await;
    let entries = json["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0]["name"], "内.txt");
    assert_eq!(entries[0]["kind"], "file");
    assert_eq!(entries[0]["size"], 5); // "inner" 字节数
}

#[tokio::test]
async fn tree_missing_path_returns_json_404() {
    let f = fixture(false);
    let (status, _, body) =
        get(vviewer::build_router(f.state), "/api/tree?path=no-such-dir").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert!(json["error"].is_string());
}

#[tokio::test]
async fn tree_path_pointing_at_file_returns_404() {
    let f = fixture(false);
    let (status, _, body) = get(vviewer::build_router(f.state), "/api/tree?path=a2.txt").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert!(json["error"].is_string());
}

// ---------- /api/file ----------

#[tokio::test]
async fn file_full_200_with_detection_headers() {
    let f = fixture(false);
    let (status, headers, body) =
        get(vviewer::build_router(f.state), "/api/file?path=digits.bin").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body.as_ref(), b"0123456789");
    assert_eq!(headers["content-type"], "application/octet-stream");
    assert_eq!(headers["accept-ranges"], "bytes");
    assert_eq!(headers["content-length"], "10");
    assert_eq!(headers["x-vv-encoding"], "utf-8");
    assert!(headers.get("x-vv-lang").is_none());
    assert!(headers.get("content-range").is_none());
}

#[tokio::test]
async fn file_xvv_lang_from_languages_json() {
    let f = fixture(false);
    let (status, headers, body) =
        get(vviewer::build_router(f.state), "/api/file?path=data.rs").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers["x-vv-lang"], "rust");
    assert_eq!(headers["content-type"], "text/x-rust");
    assert_eq!(body.as_ref(), b"fn main() {}");
}

#[tokio::test]
async fn file_xvv_encoding_variants() {
    let f = fixture(false);

    let cases = [
        ("gb.txt", "gb18030"),          // 非法 UTF-8（GBK 字节）
        ("u16le.txt", "utf-16le"),      // BOM
        ("中文.txt", "utf-8"),           // 多字节合法 UTF-8
        ("straddle.txt", "utf-8"),      // 8KB 边界截断字符 → 前缀容错
        ("lone.bin", "gb18030"),        // 文件尾悬空前缀（<8KB 全量）→ 严格判否
        ("empty.txt", "utf-8"),         // 空文件
    ];
    for (name, expect) in cases {
        let (status, headers, _) = get(
            vviewer::build_router(f.state.clone()),
            &format!("/api/file?path={name}"),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{name}");
        assert_eq!(headers["x-vv-encoding"], expect, "{name}");
    }
}

#[tokio::test]
async fn file_range_bytes_a_b() {
    let f = fixture(false);
    let (status, headers, body) = get_with(
        vviewer::build_router(f.state),
        "/api/file?path=digits.bin",
        |b| b.header("range", "bytes=2-5"),
    )
    .await;
    assert_eq!(status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(body.as_ref(), b"2345");
    assert_eq!(headers["content-range"], "bytes 2-5/10");
    assert_eq!(headers["content-length"], "4");
}

#[tokio::test]
async fn file_range_open_ended() {
    let f = fixture(false);
    let (status, headers, body) = get_with(
        vviewer::build_router(f.state),
        "/api/file?path=digits.bin",
        |b| b.header("range", "bytes=7-"),
    )
    .await;
    assert_eq!(status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(body.as_ref(), b"789");
    assert_eq!(headers["content-range"], "bytes 7-9/10");
}

#[tokio::test]
async fn file_range_suffix() {
    let f = fixture(false);
    let (status, headers, body) = get_with(
        vviewer::build_router(f.state),
        "/api/file?path=digits.bin",
        |b| b.header("range", "bytes=-3"),
    )
    .await;
    assert_eq!(status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(body.as_ref(), b"789");
    assert_eq!(headers["content-range"], "bytes 7-9/10");
}

#[tokio::test]
async fn file_range_end_clamped_to_size() {
    let f = fixture(false);
    let (status, headers, body) = get_with(
        vviewer::build_router(f.state),
        "/api/file?path=digits.bin",
        |b| b.header("range", "bytes=0-100"),
    )
    .await;
    assert_eq!(status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(body.as_ref(), b"0123456789");
    assert_eq!(headers["content-range"], "bytes 0-9/10");
}

#[tokio::test]
async fn file_multi_range_takes_first() {
    let f = fixture(false);
    let (status, _, body) = get_with(
        vviewer::build_router(f.state),
        "/api/file?path=digits.bin",
        |b| b.header("range", "bytes=0-1,3-4"),
    )
    .await;
    assert_eq!(status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(body.as_ref(), b"01");
}

#[tokio::test]
async fn file_range_unsatisfiable_variants() {
    let f = fixture(false);
    let cases: [(&str, &str); 4] = [
        ("bytes=10-", "bytes */10"),  // start == size
        ("bytes=5-2", "bytes */10"),  // 起止倒挂
        ("bytes=abc", "bytes */10"),  // 非数字
        ("bytes=-0", "bytes */10"),   // suffix 0
    ];
    for (range, expect_cr) in cases {
        let (status, headers, body) = get_with(
            vviewer::build_router(f.state.clone()),
            "/api/file?path=digits.bin",
            |b| b.header("range", range),
        )
        .await;
        assert_eq!(status, StatusCode::RANGE_NOT_SATISFIABLE, "range={range}");
        assert_eq!(headers["content-range"], expect_cr, "range={range}");
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert!(json["error"].is_string(), "range={range}");
    }
}

#[tokio::test]
async fn file_empty_file_and_range_on_empty() {
    let f = fixture(false);
    let (status, headers, body) =
        get(vviewer::build_router(f.state.clone()), "/api/file?path=empty.txt").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers["content-length"], "0");
    assert!(body.is_empty());

    let (status, headers, _) = get_with(
        vviewer::build_router(f.state),
        "/api/file?path=empty.txt",
        |b| b.header("range", "bytes=0-"),
    )
    .await;
    assert_eq!(status, StatusCode::RANGE_NOT_SATISFIABLE);
    assert_eq!(headers["content-range"], "bytes */0");
}

#[tokio::test]
async fn file_missing_returns_json_404_and_directory_rejected() {
    let f = fixture(false);
    let (status, _, body) =
        get(vviewer::build_router(f.state.clone()), "/api/file?path=no-such.bin").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert!(json["error"].is_string());

    let (status, _, body) =
        get(vviewer::build_router(f.state), "/api/file?path=%E5%AD%90%E7%9B%AE%E5%BD%95").await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert!(json["error"].is_string());
}
