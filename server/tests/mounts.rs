//! Task 5 集成测试：根装配接入挂载后端（根序 = fs 根 + 静态挂载序，spec §2）。
//!
//! 经 `AppState::with_mounts` 注入 MockTransport 构造的 S3/WebDAV 后端——
//! 与 main.rs 装配链消费同一 builder 面。断言面：
//! - tree：挂载根（root=1）列目录走 S3 ListObjectsV2（签名请求面 / 目录标记
//!   对象不浮现 / 子目录 prefix 拼接）；fs 根（root=0）零变化回归（默认根、
//!   总根数越界 400）；
//! - file：挂载根全量 200 / Range 206（backend 收到路由层已钳制的窗，窗恒
//!   len>0）/ 缺失 404 / 上游 500 错误降级（JSON error，消息透传排障片段）；
//! - health：`roots`=总根数、`fsRoots`=fs 边界、挂载根摘要（kind/label/
//!   endpoint/bucket/prefix，无凭据）；rootPaths 仅 fs 根；
//! - 挂载根 path 清洗：绝对路径 / `..` 照旧 400（无 fs canonicalize）。

use std::sync::{Arc, OnceLock};

use axum::body::Body;
use axum::http::{Request, StatusCode};
use tower::ServiceExt;

use vviewer::state::{AppState, MountMeta, MountRoot};
use vviewer_storage::s3::{S3Backend, S3MountConfig};
use vviewer_storage::transport::{http_response, MockTransport};
use vviewer_storage::webdav::{WebDavBackend, WebDavMountConfig};
use vviewer_storage::{HttpRequest, StorageBackend};

// ---------- S3 mock 页面（ListObjectsV2 字面结构样本，与 storage/tests/s3.rs 同源） ----------

const FULL_BODY: &[u8] = b"0123456789ABCDEFGHIJ"; // 20B

/// 挂载根列表页：prefix=sub/ 下 1 文件 + 1 目录（CommonPrefixes）+ 1 个零字节
/// 目录标记对象（解析后不浮现）。
const LIST_PAGE: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <IsTruncated>false</IsTruncated>
  <Contents><Key>sub/a.txt</Key><LastModified>2019-02-19T21:48:39.000Z</LastModified><Size>20</Size></Contents>
  <Contents><Key>sub/dir/</Key><Size>0</Size></Contents>
  <CommonPrefixes><Prefix>sub/dir/</Prefix></CommonPrefixes>
</ListBucketResult>"#;

/// 子目录页：prefix=sub/dir/（URL 中为 `prefix=sub%2Fdir%2F`）。
const DIR_PAGE: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <IsTruncated>false</IsTruncated>
  <Contents><Key>sub/dir/inner.txt</Key><Size>5</Size></Contents>
</ListBucketResult>"#;

/// 空页（stat 404 防线探测：prefix 无命中 → NotFound）。
const EMPTY_PAGE: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <IsTruncated>false</IsTruncated>
</ListBucketResult>"#;

fn s3_transport() -> Arc<MockTransport> {
    Arc::new(
        MockTransport::new()
            // stat 的 HEAD：a.txt 命中（Content-Length/Last-Modified），其余 404
            .with_route("HEAD", "a.txt", |_| {
                http_response(
                    200,
                    &[
                        ("content-length", "20"),
                        ("last-modified", "Fri, 24 May 2013 00:00:00 GMT"),
                    ],
                    b"",
                )
            })
            .with_route("HEAD", "b1", |_| http_response(404, &[], b""))
            // 上游故障注入：错误降级断言面
            .with_route("GET", "boom.bin", |_| http_response(500, &[], b"boom"))
            // 列目录：missing/local 前缀的探测页为空（stat 判 NotFound），
            // 其余按 prefix 分支返回挂载根 / 子目录页
            .with_route("GET", "list-type=2", |req: &HttpRequest| {
                let xml = if req.url.contains("missing") || req.url.contains("local") {
                    EMPTY_PAGE
                } else if req.url.contains("prefix=sub%2Fdir%2F") {
                    DIR_PAGE
                } else {
                    LIST_PAGE
                };
                http_response(200, &[("content-type", "application/xml")], xml)
            })
            // 读 a.txt：带窗 Range → 206 窗；否则 200 全量
            .with_route("GET", "a.txt", |req: &HttpRequest| {
                let range = req
                    .headers
                    .iter()
                    .find(|(k, _)| k.eq_ignore_ascii_case("range"))
                    .map(|(_, v)| v.as_str());
                match range {
                    Some("bytes=2-5") => http_response(
                        206,
                        &[("content-range", "bytes 2-5/20"), ("content-length", "4")],
                        b"2345",
                    ),
                    _ => http_response(200, &[("content-length", "20")], FULL_BODY),
                }
            }),
    )
}

fn s3_meta() -> MountMeta {
    MountMeta {
        kind: "s3",
        label: Some("docs".into()),
        endpoint: "http://127.0.0.1:9000".into(),
        bucket: Some("b1".into()),
        prefix: "sub".into(),
    }
}

fn s3_backend(transport: Arc<MockTransport>) -> Arc<dyn StorageBackend> {
    Arc::new(S3Backend::new(
        S3MountConfig {
            endpoint: "http://127.0.0.1:9000".into(),
            bucket: "b1".into(),
            prefix: "sub".into(),
            access_key_id: "AKIAIOSFODNN7EXAMPLE".into(),
            secret_access_key: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY".into(),
            path_style: true,
            region: None,
        },
        transport,
    ))
}

struct Fixture {
    _dir: tempfile::TempDir,
    state: AppState,
    transport: Arc<MockTransport>,
}

/// fs 根（1 文件）+ S3 挂载（root=1）。
fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("local.txt"), b"local-root\n").unwrap();
    let transport = s3_transport();
    let state = AppState::new(dir.path().to_path_buf(), None, None, false, None).with_mounts(vec![
        MountRoot { backend: s3_backend(transport.clone()), meta: s3_meta() },
    ]);
    Fixture { _dir: dir, state, transport }
}

/// 3-9（TOCTOU 共源）：头/体两测共享同一 fixture 实例——AppState+router 进程级
/// 构建一次，200 头面与 Range 206 体面各自 oneshot（router Clone 同源即达意）。
fn fixture_with_mount() -> &'static (Fixture, axum::Router) {
    static SHARED: OnceLock<(Fixture, axum::Router)> = OnceLock::new();
    SHARED.get_or_init(|| {
        let f = fixture();
        let app = vviewer::build_router(f.state.clone());
        (f, app)
    })
}

async fn get(app: axum::Router, uri: &str) -> (StatusCode, axum::http::HeaderMap, axum::body::Bytes) {
    get_with(app, uri, |b| b).await
}

async fn get_with<F>(
    app: axum::Router,
    uri: &str,
    set_headers: F,
) -> (StatusCode, axum::http::HeaderMap, axum::body::Bytes)
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

fn names_of(json: &serde_json::Value) -> Vec<&str> {
    json["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["name"].as_str().unwrap())
        .collect()
}

// ---------- tree：挂载根走 S3 后端 ----------

#[tokio::test]
async fn tree_mount_root_lists_s3_entries() {
    let f = fixture();
    let app = vviewer::build_router(f.state);

    // 挂载根（root=1）：目录优先；零字节目录标记对象（sub/dir/）不浮现
    let json = tree_json(app.clone(), "/api/tree?root=1").await;
    assert_eq!(names_of(&json), vec!["dir", "a.txt"]);
    assert_eq!(json["entries"][0]["kind"], "dir");
    assert_eq!(json["entries"][1]["kind"], "file");
    assert_eq!(json["entries"][1]["size"], 20);

    // 子目录：ListObjectsV2 prefix=sub/dir/（挂载 prefix 拼接）
    let json = tree_json(app, "/api/tree?root=1&path=dir").await;
    assert_eq!(names_of(&json), vec!["inner.txt"]);

    // 请求面：SigV4 签名头 + 挂载 prefix 进入列表查询
    let reqs = f.transport.recorded_requests();
    let list = reqs
        .iter()
        .find(|r| r.method == "GET" && r.url.contains("list-type=2"))
        .expect("ListObjectsV2 请求已发出");
    assert!(list.url.contains("prefix=sub%2F"), "url={}", list.url);
    let auth = list
        .headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("authorization"))
        .map(|(_, v)| v.as_str())
        .expect("authorization 头");
    assert!(auth.starts_with("AWS4-HMAC-SHA256 "), "auth={auth}");
}

// ---------- tree/file：fs 根零变化回归 ----------

#[tokio::test]
async fn fs_root_behavior_unchanged_alongside_mounts() {
    let f = fixture();
    let app = vviewer::build_router(f.state);

    // 默认根仍为 0 号 fs 根，形状不变
    let json = tree_json(app.clone(), "/api/tree").await;
    assert_eq!(names_of(&json), vec!["local.txt"]);
    let (status, _, body) = get(app.clone(), "/api/file?path=local.txt").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body.as_ref(), b"local-root\n");

    // 总根数 = fs 1 + 挂载 1：root=2 越界照旧 400
    let (status, _, body) = get(app.clone(), "/api/tree?root=2").await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert!(json["error"].as_str().unwrap().contains("root index out of range"));

    // fs 根文件不在挂载根：404（HEAD 404 + 探测页空 → NotFound）
    let (status, _, body) = get(app, "/api/file?root=1&path=local.txt").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert!(json["error"].is_string());
}

// ---------- file：挂载根读取 ----------

#[tokio::test]
async fn file_mount_root_full_200() {
    let (_, app) = fixture_with_mount();
    let (status, headers, body) =
        get(app.clone(), "/api/file?root=1&path=a.txt").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body.as_ref(), FULL_BODY);
    assert_eq!(headers["content-length"], "20");
    assert_eq!(headers["content-type"], "text/plain");
    // 编码检测来自 S3 GET 的前缀采样（head 与流同源）
    assert_eq!(headers["x-vv-encoding"], "utf-8");
}

#[tokio::test]
async fn file_mount_root_range_206() {
    let (_, app) = fixture_with_mount();
    let (status, headers, body) = get_with(
        app.clone(),
        "/api/file?root=1&path=a.txt",
        |b| b.header("range", "bytes=2-5"),
    )
    .await;
    assert_eq!(status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(body.as_ref(), b"2345");
    assert_eq!(headers["content-range"], "bytes 2-5/20");
    assert_eq!(headers["content-length"], "4");
}

#[tokio::test]
async fn file_mount_root_missing_is_404() {
    let f = fixture();
    let (status, _, body) =
        get(vviewer::build_router(f.state), "/api/file?root=1&path=missing.bin").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert!(json["error"].is_string());
}

/// 错误降级：上游 500 → JSON error（StorageError::Other → 500，排障片段透传），
/// 不 panic、不撕裂响应。
#[tokio::test]
async fn file_mount_root_upstream_error_degrades_to_500_json() {
    let f = fixture();
    let (status, _, body) =
        get(vviewer::build_router(f.state), "/api/file?root=1&path=boom.bin").await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let msg = json["error"].as_str().unwrap();
    assert!(msg.contains("boom"), "error={msg}");
}

/// 挂载根 path 清洗安全面照旧：绝对路径 / `..` 拒 400，无 fs canonicalize。
#[tokio::test]
async fn mount_root_path_cleaning_rejects_traversal_and_absolute() {
    let f = fixture();
    let app = vviewer::build_router(f.state);
    for uri in [
        "/api/tree?root=1&path=../etc",
        "/api/tree?root=1&path=%2Fetc",
        "/api/file?root=1&path=..%2Fetc",
        "/api/file?root=1&path=%2Fetc%2Fpasswd",
    ] {
        let (status, _, _) = get(app.clone(), uri).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "uri={uri}");
    }
}

// ---------- health：fsRoots 边界与挂载根摘要 ----------

/// T4 台账 ②收口的共存验证面：webdav 挂载经同一装配面进入 health 摘要。
fn dav_backend() -> Arc<dyn StorageBackend> {
    Arc::new(WebDavBackend::new(
        WebDavMountConfig {
            endpoint: "https://dav.example.com/dav".into(),
            prefix: String::new(),
            username: "alice".into(),
            password: "s3cret".into(),
        },
        Arc::new(MockTransport::new()),
    ))
}

#[tokio::test]
async fn health_declares_fs_roots_boundary_and_mount_summary() {
    let f = fixture();
    // 追加 webdav 挂载（root=2）：总根数 3 = fs 1 + s3 + webdav
    let state = f.state.with_mounts(vec![MountRoot {
        backend: dav_backend(),
        meta: MountMeta {
            kind: "webdav",
            label: None,
            endpoint: "https://dav.example.com/dav".into(),
            bucket: None,
            prefix: String::new(),
        },
    }]);
    let (_, _, body) = get(vviewer::build_router(state), "/api/health").await;
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap();

    assert_eq!(v["roots"], 3, "roots=总根数（rootIndex 寻址面）: {v}");
    assert_eq!(v["fsRoots"], 1, "fsRoots=fs 根数边界: {v}");

    let mounts = v["mounts"].as_array().expect("mounts 摘要数组");
    assert_eq!(mounts.len(), 2, "{v}");
    assert_eq!(mounts[0]["kind"], "s3");
    assert_eq!(mounts[0]["label"], "docs");
    assert_eq!(mounts[0]["endpoint"], "http://127.0.0.1:9000");
    assert_eq!(mounts[0]["bucket"], "b1");
    assert_eq!(mounts[0]["prefix"], "sub");
    assert_eq!(mounts[1]["kind"], "webdav");
    assert_eq!(mounts[1]["endpoint"], "https://dav.example.com/dav");
    assert_eq!(mounts[1]["prefix"], "");
    assert!(mounts[1].get("bucket").is_none(), "webdav 无 bucket: {v}");
    assert!(mounts[1].get("label").is_none(), "无 label 时省略: {v}");

    // 凭据永不入 health（spec §2 服务端纪律）
    let text = String::from_utf8(body.to_vec()).unwrap();
    assert!(!text.contains("s3cret"), "{text}");
    assert!(!text.contains("alice"), "{text}");
    assert!(!text.contains("AKIA"), "{text}");
}

/// rootPaths 仅 fs 根（挂载 endpoint 不是 fs 路径，走 mounts 摘要通道）。
#[tokio::test]
async fn health_root_paths_cover_fs_roots_only() {
    let d0 = tempfile::tempdir().unwrap();
    let d1 = tempfile::tempdir().unwrap();
    let transport = s3_transport();
    let state = AppState::new(d0.path().to_path_buf(), None, None, false, None)
        .with_roots(vec![d0.path().to_path_buf(), d1.path().to_path_buf()])
        .with_mounts(vec![MountRoot {
            backend: s3_backend(transport),
            meta: s3_meta(),
        }]);
    let (_, _, body) = get(vviewer::build_router(state), "/api/health").await;
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap();

    assert_eq!(v["roots"], 3, "{v}");
    assert_eq!(v["fsRoots"], 2, "{v}");
    let paths = v["rootPaths"].as_array().expect("rootPaths");
    assert_eq!(paths.len(), 2, "rootPaths 仅 fs 根: {v}");
    assert_eq!(v["mounts"].as_array().unwrap().len(), 1, "{v}");
}
