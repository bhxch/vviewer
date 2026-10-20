//! Task 1（阶段二）集成测试：运行时挂载三 API（POST/GET/DELETE /api/mounts，spec §3）。
//!
//! oneshot 既有模式（tests/mounts.rs 同款 MockTransport 注入）。断言面：
//! - POST 注册 → 201 `{rootIndex}`（rootIndex = fsRoots 起算）；注册的挂载根
//!   tree/file 立即可用；
//! - GET 脱敏清单：fsRoots / staticMounts / runtimeMounts / mounts（含
//!   rootIndex/kind/label/endpoint/capabilities），响应体无凭据；
//! - DELETE：运行时项 204 + tombstone（不移位/空洞不复用）；静态项（fs 根/
//!   静态挂载）405（带 `Allow` 头）；越界/已删 404；
//! - 鉴权矩阵：有 token 无 Bearer → 401（spec §3「有 token 时需 Bearer」）；
//!   **无 token 部署三 API 免鉴权**（spec 字面口径——LAN 信任模型，写面裸奔
//!   风险在任务报告显著记录）；
//! - 重注册幂等：同指纹（kind+endpoint+bucket/prefix+label，无凭据）返回既有
//!   rootIndex，不重复分配；
//! - POST body 显式上限 64KB（DefaultBodyLimit）：超限 413 无副作用，限值内不误伤。

use std::sync::Arc;

use axum::body::{Body, Bytes};
use axum::http::{HeaderMap, Request, StatusCode};
use serde_json::{json, Value};
use tower::ServiceExt;

use vviewer::state::{AppState, MountMeta, MountRoot};
use vviewer_storage::s3::{S3Backend, S3MountConfig};
use vviewer_storage::transport::{http_response, MockTransport};

// ---------- S3 mock 页面（ListObjectsV2 字面结构，与 tests/mounts.rs 同源缩略） ----------

const FULL_BODY: &[u8] = b"0123456789ABCDEFGHIJ"; // 20B

const LIST_PAGE: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <IsTruncated>false</IsTruncated>
  <Contents><Key>sub/a.txt</Key><LastModified>2019-02-19T21:48:39.000Z</LastModified><Size>20</Size></Contents>
  <CommonPrefixes><Prefix>sub/dir/</Prefix></CommonPrefixes>
</ListBucketResult>"#;

fn s3_mock() -> Arc<MockTransport> {
    Arc::new(
        MockTransport::new()
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
            .with_route("GET", "list-type=2", |_| {
                http_response(200, &[("content-type", "application/xml")], LIST_PAGE)
            })
            .with_route("GET", "a.txt", |_| {
                http_response(200, &[("content-length", "20")], FULL_BODY)
            }),
    )
}

/// POST /api/mounts 的 S3 注册体（凭据含特征值，供泄漏断言用）。
const ACCESS_KEY: &str = "AKIAIOSFODNN7EXAMPLE";
const SECRET_KEY: &str = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";

fn s3_body() -> Value {
    json!({
        "kind": "s3",
        "label": "docs",
        "endpoint": "http://127.0.0.1:9000",
        "bucket": "b1",
        "prefix": "sub",
        "access_key_id": ACCESS_KEY,
        "secret_access_key": SECRET_KEY,
        "path_style": true
    })
}

// ---------- fixture 与请求助手 ----------

struct Fixture {
    _dir: tempfile::TempDir,
    state: AppState,
}

/// 1 fs 根 + 运行时注册 transport 注入 MockTransport（token 按需）。
fn fixture(token: Option<&str>) -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("local.txt"), b"local-root\n").unwrap();
    let state = AppState::new(
        dir.path().to_path_buf(),
        None,
        token.map(str::to_string),
        false,
        None,
    )
    .with_runtime_transport(s3_mock());
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

fn json(bytes: &[u8]) -> Value {
    serde_json::from_slice(bytes).unwrap()
}

/// 静态 S3 挂载注入（阶段一 with_mounts 面——GET 清单 staticMounts 段的来源）。
fn static_s3_mount() -> MountRoot {
    MountRoot {
        backend: Arc::new(S3Backend::new(
            S3MountConfig {
                endpoint: "http://127.0.0.1:9000".into(),
                bucket: "static-bucket".into(),
                prefix: "static".into(),
                access_key_id: ACCESS_KEY.into(),
                secret_access_key: SECRET_KEY.into(),
                path_style: true,
            },
            Arc::new(MockTransport::new()),
        )),
        meta: MountMeta {
            kind: "s3",
            label: Some("static-docs".into()),
            endpoint: "http://127.0.0.1:9000".into(),
            bucket: Some("static-bucket".into()),
            prefix: "static".into(),
        },
    }
}

// ---------- POST：注册与 rootIndex 分配 ----------

#[tokio::test]
async fn post_registers_runtime_mount_and_returns_fs_based_root_index() {
    let f = fixture(None);
    let app = vviewer::build_router(f.state.clone());

    // 1 fs 根、无静态挂载：首个运行时项 rootIndex=1（fsRoots 起算）
    let (status, _, body) = send(app.clone(), "POST", "/api/mounts", None, Some(s3_body())).await;
    assert_eq!(status, StatusCode::CREATED, "{}", String::from_utf8_lossy(&body));
    let v = json(&body);
    assert_eq!(v["rootIndex"], 1, "{v}");

    // GET 清单：fsRoots=1，runtimeMounts 含 rootIndex/kind/label/endpoint/bucket/
    // prefix/capabilities（挂载根 watch/search=false）
    let (status, _, body) = send(app, "GET", "/api/mounts", None, None).await;
    assert_eq!(status, StatusCode::OK);
    let v = json(&body);
    assert_eq!(v["fsRoots"], 1, "{v}");
    assert_eq!(v["staticMounts"].as_array().unwrap().len(), 0, "{v}");
    let runtime = v["runtimeMounts"].as_array().unwrap();
    assert_eq!(runtime.len(), 1, "{v}");
    assert_eq!(runtime[0]["rootIndex"], 1, "{v}");
    assert_eq!(runtime[0]["kind"], "s3", "{v}");
    assert_eq!(runtime[0]["label"], "docs", "{v}");
    assert_eq!(runtime[0]["endpoint"], "http://127.0.0.1:9000", "{v}");
    assert_eq!(runtime[0]["bucket"], "b1", "{v}");
    assert_eq!(runtime[0]["prefix"], "sub", "{v}");
    assert_eq!(runtime[0]["capabilities"]["watch"], false, "{v}");
    assert_eq!(runtime[0]["capabilities"]["search"], false, "{v}");
    // mounts 汇总段 = 静态 + 运行时
    let all = v["mounts"].as_array().unwrap();
    assert_eq!(all.len(), 1, "{v}");
    assert_eq!(all[0]["rootIndex"], 1, "{v}");
}

#[tokio::test]
async fn registered_mount_root_serves_tree_and_file_immediately() {
    let f = fixture(None);
    let app = vviewer::build_router(f.state.clone());

    let (status, _, body) = send(app.clone(), "POST", "/api/mounts", None, Some(s3_body())).await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(json(&body)["rootIndex"], 1);

    // tree：注册即服务（无需重启/重装配）
    let (status, _, body) = send(app.clone(), "GET", "/api/tree?root=1", None, None).await;
    assert_eq!(status, StatusCode::OK);
    let tree = json(&body);
    let names: Vec<&str> = tree["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, vec!["dir", "a.txt"], "目录优先");

    // file：全量读取走 mock S3
    let (status, _, body) = send(app, "GET", "/api/file?root=1&path=a.txt", None, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body.as_ref(), FULL_BODY);
}

// ---------- GET：静态/运行时分段与脱敏 ----------

#[tokio::test]
async fn manifest_splits_static_and_runtime_and_never_echoes_credentials() {
    let dir = tempfile::tempdir().unwrap();
    let transport = s3_mock();
    let state = AppState::new(dir.path().to_path_buf(), None, None, false, None)
        .with_mounts(vec![static_s3_mount()])
        .with_runtime_transport(transport);
    let app = vviewer::build_router(state);

    // 运行时注册：endpoint 携带 userinfo（误配置形态）——展示面剥除
    let mut runtime_body = s3_body();
    runtime_body["endpoint"] = json!("http://user:topsecret@127.0.0.1:9000");
    runtime_body["label"] = json!("runtime-docs");
    let (status, _, _) = send(app.clone(), "POST", "/api/mounts", None, Some(runtime_body)).await;
    assert_eq!(status, StatusCode::CREATED);

    let (status, _, body) = send(app, "GET", "/api/mounts", None, None).await;
    assert_eq!(status, StatusCode::OK);
    let v = json(&body);

    assert_eq!(v["fsRoots"], 1, "{v}");
    let statics = v["staticMounts"].as_array().unwrap();
    assert_eq!(statics.len(), 1, "{v}");
    assert_eq!(statics[0]["rootIndex"], 1, "静态段自 fsRoots 起算: {v}");
    assert_eq!(statics[0]["kind"], "s3", "{v}");
    assert_eq!(statics[0]["bucket"], "static-bucket", "{v}");

    let runtime = v["runtimeMounts"].as_array().unwrap();
    assert_eq!(runtime.len(), 1, "{v}");
    assert_eq!(runtime[0]["rootIndex"], 2, "运行时段接在静态段之后: {v}");
    assert_eq!(
        runtime[0]["endpoint"], "http://127.0.0.1:9000",
        "userinfo 剥除: {v}"
    );

    let all = v["mounts"].as_array().unwrap();
    assert_eq!(all.len(), 2, "{v}");
    assert_eq!(all[0]["rootIndex"], 1, "{v}");
    assert_eq!(all[1]["rootIndex"], 2, "{v}");

    // 凭据永不回显（spec §6 三不纪律之 GET 面）：注册体里的密钥、userinfo
    // 密码、静态后端凭据全部不得出现
    let text = String::from_utf8(body.to_vec()).unwrap();
    assert!(!text.contains("topsecret"), "{text}");
    assert!(!text.contains(ACCESS_KEY), "{text}");
    assert!(!text.contains(SECRET_KEY), "{text}");
    // 结构面即保证：凭据字段名不出现
    assert!(!text.contains("secret_access_key"), "{text}");
    assert!(!text.contains("access_key_id"), "{text}");
    assert!(!text.contains("password"), "{text}");
}

// ---------- DELETE：运行时 204 / 静态 405 / 越界 404 ----------

#[tokio::test]
async fn delete_removes_runtime_and_rejects_static_and_out_of_range() {
    let f = fixture(None);
    let app = vviewer::build_router(f.state.clone());

    let (status, _, body) = send(app.clone(), "POST", "/api/mounts", None, Some(s3_body())).await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(json(&body)["rootIndex"], 1);

    // 运行时项：204 + 槽位 tombstone（活跃 tab 失效帧降级路径：删除即成功，
    // 引用该根的 tab 下次访问自然失效——裁决记录在任务报告）
    let (status, _, body) = send(app.clone(), "DELETE", "/api/mounts/1", None, None).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert!(body.is_empty());

    let (_, _, body) = send(app.clone(), "GET", "/api/mounts", None, None).await;
    assert_eq!(json(&body)["runtimeMounts"].as_array().unwrap().len(), 0);
    // 已删根回归越界 400（tombstone 空洞不再解析）
    let (status, _, body) = send(app.clone(), "GET", "/api/tree?root=1", None, None).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(json(&body)["error"].as_str().unwrap().contains("root index out of range"));

    // fs 根拒删：405（静态语义——方法对该资源类不适用）+ Allow 头（RFC 9110
    // §15.5.5 MUST：405 响应必须宣告目标资源支持的方法集合）
    let (status, headers, body) = send(app.clone(), "DELETE", "/api/mounts/0", None, None).await;
    assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED);
    assert!(json(&body)["error"].as_str().unwrap().contains("static"));
    assert_eq!(
        headers.get("allow").map(|v| v.to_str().unwrap()),
        Some("GET, POST"),
        "405 须携 Allow 头"
    );

    // 越界：404
    let (status, _, body) = send(app, "DELETE", "/api/mounts/99", None, None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert!(json(&body)["error"].is_string());
}

#[tokio::test]
async fn delete_rejects_static_config_mount_with_405() {
    let dir = tempfile::tempdir().unwrap();
    let state = AppState::new(dir.path().to_path_buf(), None, None, false, None)
        .with_mounts(vec![static_s3_mount()])
        .with_runtime_transport(s3_mock());
    let app = vviewer::build_router(state);

    // 静态 TOML 挂载（rootIndex=1）拒删；fs 根（0）同拒（Allow 头断言在
    // delete_removes_runtime 用例，此处不重复）
    for idx in [0, 1] {
        let (status, _, _) =
            send(app.clone(), "DELETE", &format!("/api/mounts/{idx}"), None, None).await;
        assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED, "idx={idx}");
    }

    // 运行时段接在静态之后：注册 idx=2 可删
    let (status, _, _) = send(app.clone(), "POST", "/api/mounts", None, Some(s3_body())).await;
    assert_eq!(status, StatusCode::CREATED);
    let (status, _, _) = send(app, "DELETE", "/api/mounts/2", None, None).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
}

// ---------- DELETE tombstone：非尾项删除不移位、空洞不填充 ----------

/// I-1 终审锁测：删非尾项（rootIndex=2，共 1/2/3 三项）后——旧索引不再解析
/// （tree 400 越界；旧 `Vec::remove` 压缩实现此处会把后继项静默串进该索引）、
/// 后继项 rootIndex 不移位且照常路由、清单不含已删项、重复 DELETE 404、新
/// POST 追加分配不填充空洞（rootIndex 复用窗口消灭，重启才回收）。
#[tokio::test]
async fn delete_middle_slot_tombstones_without_shifting_or_reuse() {
    let f = fixture(None);
    let app = vviewer::build_router(f.state.clone());

    // 注册三项：rootIndex 1/2/3（label 区分指纹）
    for label in ["m-one", "m-two", "m-three"] {
        let mut body = s3_body();
        body["label"] = json!(label);
        let (status, _, _) = send(app.clone(), "POST", "/api/mounts", None, Some(body)).await;
        assert_eq!(status, StatusCode::CREATED);
    }

    // 删非尾项（rootIndex=2，label=m-two）→ 204
    let (status, _, _) = send(app.clone(), "DELETE", "/api/mounts/2", None, None).await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    // 旧 rootIndex=2 不再解析：400 越界（无内容串扰）
    let (status, _, body) = send(app.clone(), "GET", "/api/tree?root=2", None, None).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(json(&body)["error"].as_str().unwrap().contains("root index out of range"));

    // 后继项不移位：rootIndex=3 仍是 m-three，且原索引照常路由
    let (_, _, body) = send(app.clone(), "GET", "/api/mounts", None, None).await;
    let v = json(&body);
    let runtime = v["runtimeMounts"].as_array().unwrap();
    let indexes: Vec<u64> =
        runtime.iter().map(|e| e["rootIndex"].as_u64().unwrap()).collect();
    assert_eq!(indexes, vec![1, 3], "空洞保留不移位: {v}");
    assert_eq!(runtime[1]["label"], "m-three", "{v}");
    let (status, _, _) = send(app.clone(), "GET", "/api/tree?root=3", None, None).await;
    assert_eq!(status, StatusCode::OK, "后继项原索引照常路由");

    // 重复 DELETE 已删索引 → 404（空洞即 NotFound）
    let (status, _, _) = send(app.clone(), "DELETE", "/api/mounts/2", None, None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // 新 POST 追加分配：rootIndex=4，不填充空洞
    let mut fresh = s3_body();
    fresh["label"] = json!("m-four");
    let (status, _, body) = send(app.clone(), "POST", "/api/mounts", None, Some(fresh)).await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(json(&body)["rootIndex"], 4, "追加分配，不填充已删空洞");

    // 清单不含已删项（任何段都不出现 m-two）
    let (_, _, body) = send(app, "GET", "/api/mounts", None, None).await;
    let text = json(&body).to_string();
    assert!(!text.contains("m-two"), "manifest 不含已删项: {text}");
}

// ---------- 幂等：同指纹不重复分配 ----------

#[tokio::test]
async fn reregistration_with_same_fingerprint_returns_existing_root_index() {
    let f = fixture(None);
    let app = vviewer::build_router(f.state.clone());

    let (status, _, body) = send(app.clone(), "POST", "/api/mounts", None, Some(s3_body())).await;
    assert_eq!(status, StatusCode::CREATED, "首次注册 201");
    let first = json(&body)["rootIndex"].as_u64().unwrap();

    // 同配置重注册：200 + 既有 rootIndex，不重复分配（对账幂等，spec §3）
    let (status, _, body) = send(app.clone(), "POST", "/api/mounts", None, Some(s3_body())).await;
    assert_eq!(status, StatusCode::OK, "幂等命中 200");
    assert_eq!(json(&body)["rootIndex"].as_u64().unwrap(), first);

    // 指纹无凭据面：仅换密钥的同配置同样命中既有项（凭据轮换语义注记见报告）
    let mut rotated = s3_body();
    rotated["secret_access_key"] = json!("ROTATED-SECRET-VALUE");
    let (status, _, body) = send(app.clone(), "POST", "/api/mounts", None, Some(rotated)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(json(&body)["rootIndex"].as_u64().unwrap(), first);

    // 指纹变化（label 不同）：新分配
    let mut other = s3_body();
    other["label"] = json!("other");
    let (status, _, body) = send(app.clone(), "POST", "/api/mounts", None, Some(other)).await;
    assert_eq!(status, StatusCode::CREATED);
    let second = json(&body)["rootIndex"].as_u64().unwrap();
    assert_eq!(second, first + 1);

    let (_, _, body) = send(app, "GET", "/api/mounts", None, None).await;
    let v = json(&body);
    assert_eq!(v["runtimeMounts"].as_array().unwrap().len(), 2, "{v}");
}

#[tokio::test]
async fn fingerprint_ignores_whitespace_and_credential_fields() {
    let f = fixture(None);
    let app = vviewer::build_router(f.state.clone());

    // 先注册基准配置（rootIndex=1）
    let (status, _, _) = send(app.clone(), "POST", "/api/mounts", None, Some(s3_body())).await;
    assert_eq!(status, StatusCode::CREATED);

    // 字段带意外空白的变体：trim 规范化后同指纹 → 命中既有项
    let mut spaced = s3_body();
    spaced["endpoint"] = json!("  http://127.0.0.1:9000  ");
    spaced["prefix"] = json!(" sub ");
    let (status, _, body) = send(app.clone(), "POST", "/api/mounts", None, Some(spaced)).await;
    assert_eq!(status, StatusCode::OK, "trim 规范化后同指纹命中既有项");
    assert_eq!(json(&body)["rootIndex"], 1);

    let (_, _, body) = send(app, "GET", "/api/mounts", None, None).await;
    assert_eq!(json(&body)["runtimeMounts"].as_array().unwrap().len(), 1);
}

// ---------- 鉴权矩阵：有 token 需 Bearer；无 token 免鉴权（spec 字面） ----------

#[tokio::test]
async fn token_deployment_requires_bearer_for_all_three() {
    let f = fixture(Some("tok-123"));
    let app = vviewer::build_router(f.state.clone());

    // 无 Bearer：三 API 全 401（含 GET 清单——清单非豁免面）
    let (status, _, _) = send(app.clone(), "POST", "/api/mounts", None, Some(s3_body())).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _, _) = send(app.clone(), "GET", "/api/mounts", None, None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _, _) = send(app.clone(), "DELETE", "/api/mounts/1", None, None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    // 错误 token 同拒
    let (status, _, _) =
        send(app.clone(), "POST", "/api/mounts", Some("Bearer wrong"), Some(s3_body())).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    // 正确 Bearer：注册/清单/删除全通
    let (status, _, body) =
        send(app.clone(), "POST", "/api/mounts", Some("Bearer tok-123"), Some(s3_body())).await;
    assert_eq!(status, StatusCode::CREATED, "{}", String::from_utf8_lossy(&body));
    let idx = json(&body)["rootIndex"].as_u64().unwrap();
    let (status, _, _) =
        send(app.clone(), "GET", "/api/mounts", Some("Bearer tok-123"), None).await;
    assert_eq!(status, StatusCode::OK);
    let (status, _, _) =
        send(app, "DELETE", &format!("/api/mounts/{idx}"), Some("Bearer tok-123"), None).await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    // 注册确未落容器（401 的 POST 不产生副作用）
    let (_, _, body) = send(
        vviewer::build_router(f.state.clone()),
        "GET",
        "/api/mounts",
        Some("Bearer tok-123"),
        None,
    )
    .await;
    assert_eq!(json(&body)["runtimeMounts"].as_array().unwrap().len(), 0);
}

/// spec 字面口径（spec §3「有 token 时需 Bearer」的逆命题）：无 token 部署三 API
/// 免鉴权。⚠ LAN 信任模型下的写面裸奔风险——任务报告显著记录（裁决：按 spec
/// 字面实现，与 health 豁免面同口径）。
#[tokio::test]
async fn tokenless_deployment_allows_mount_apis_per_spec_literal() {
    let f = fixture(None);
    let app = vviewer::build_router(f.state);

    // WebDAV 注册体（kind=webdav 面覆盖：清单无 bucket 字段）
    let dav = json!({
        "kind": "webdav",
        "label": "dav",
        "endpoint": "https://dav.example.com/dav",
        "username": "alice",
        "password": "s3cret"
    });
    let (status, _, body) = send(app.clone(), "POST", "/api/mounts", None, Some(dav)).await;
    assert_eq!(status, StatusCode::CREATED, "{}", String::from_utf8_lossy(&body));
    assert_eq!(json(&body)["rootIndex"], 1);

    let (status, _, body) = send(app.clone(), "GET", "/api/mounts", None, None).await;
    assert_eq!(status, StatusCode::OK);
    let v = json(&body);
    let runtime = v["runtimeMounts"].as_array().unwrap();
    assert_eq!(runtime.len(), 1, "{v}");
    assert_eq!(runtime[0]["kind"], "webdav", "{v}");
    assert!(runtime[0].get("bucket").is_none(), "webdav 无 bucket 字段: {v}");

    // 凭据不回显（webdav 账号对面）
    let text = String::from_utf8(body.to_vec()).unwrap();
    assert!(!text.contains("alice"), "{text}");
    assert!(!text.contains("s3cret"), "{text}");

    let (status, _, _) = send(app, "DELETE", "/api/mounts/1", None, None).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
}

// ---------- POST body 上限：64KB 显式限值（DefaultBodyLimit）→ 413 ----------

/// tower 层限值闸门：合法可解析的 JSON 仅因体积超 64KB 被拒——证明限值确实
/// 挂在 POST 路由（DefaultBodyLimit），而非 serde/校验层。响应体是 axum 提取器
/// 拒绝的纯文本（非 JSON error 形状——与 compute 的 handler 层 413 不同源），
/// 只锚状态码；并断言无副作用（超限请求不得产生任何注册）。
#[tokio::test]
async fn post_over_64kb_body_rejected_413_without_side_effect() {
    let f = fixture(None);
    let app = vviewer::build_router(f.state.clone());

    // label 撑到 64KB+1：字段级合法（String 无形状限制），拒收只能来自限值层
    let mut big = s3_body();
    big["label"] = json!("x".repeat(64 * 1024 + 1));
    let (status, _, _) = send(app, "POST", "/api/mounts", None, Some(big)).await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);

    let (_, _, body) = send(
        vviewer::build_router(f.state),
        "GET",
        "/api/mounts",
        None,
        None,
    )
    .await;
    assert_eq!(
        json(&body)["runtimeMounts"].as_array().unwrap().len(),
        0,
        "超限 POST 不得产生注册副作用"
    );
}

/// 限值边界内的常规注册体（<64KB）不受影响——限值不误伤正常形态。
#[tokio::test]
async fn post_under_64kb_body_accepted() {
    let f = fixture(None);
    let app = vviewer::build_router(f.state);

    let mut normal = s3_body();
    normal["label"] = json!("x".repeat(60 * 1024));
    let (status, _, _) = send(app, "POST", "/api/mounts", None, Some(normal)).await;
    assert_eq!(status, StatusCode::CREATED);
}

// ---------- 注册校验：缺必填 400、未知字段 4xx、坏 JSON 4xx；错误不携凭据 ----------

#[tokio::test]
async fn post_validation_errors_name_field_without_credential_echo() {
    let f = fixture(None);
    let app = vviewer::build_router(f.state);

    // S3 缺 bucket → 400，错误含字段名
    let mut missing = s3_body();
    missing["bucket"] = Value::Null;
    let (status, _, body) = send(app.clone(), "POST", "/api/mounts", None, Some(missing)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let v = json(&body);
    assert!(v["error"].as_str().unwrap().contains("bucket"), "{v}");

    // 错误消息不含其他凭据值（三不纪律之错误面）
    let text = serde_json::to_string(&v).unwrap();
    assert!(!text.contains(ACCESS_KEY), "{text}");
    assert!(!text.contains(SECRET_KEY), "{text}");

    // WebDAV 缺 password → 400 含字段名
    let dav = json!({ "kind": "webdav", "endpoint": "https://dav.example.com", "username": "u" });
    let (status, _, body) = send(app.clone(), "POST", "/api/mounts", None, Some(dav)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(json(&body)["error"].as_str().unwrap().contains("password"));

    // 未知字段（deny_unknown_fields——防静默忽略拼错键）→ 4xx
    let mut unknown = s3_body();
    unknown["acces_key_id"] = json!("typo");
    let (status, _, _) = send(app.clone(), "POST", "/api/mounts", None, Some(unknown)).await;
    assert!(status.is_client_error(), "未知字段拒: {status}");

    // 非 JSON body → 4xx
    let req = Request::builder()
        .method("POST")
        .uri("/api/mounts")
        .header("content-type", "application/json")
        .body(Body::from("not json"))
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert!(res.status().is_client_error(), "坏 JSON 拒: {}", res.status());
}
