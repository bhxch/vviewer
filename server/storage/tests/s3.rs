//! S3 后端集成测试（Task 3，mock transport 基建）。
//!
//! 断言面：
//! - SigV4 AWS 官方向量锚（GET object us-east-1 经典例，逐 header 断言）；
//!   另三个官方向量（query 排序/空值 query/`$` 段编码/payload hash）作为
//!   纯函数单测锚在 src/s3.rs `#[cfg(test)]` 模块内；
//! - ListObjectsV2 响应 XML（字面结构，S3 API 2006-03-01 版本耦合）→
//!   Entry 映射：Contents/CommonPrefixes/Delimiter/挂载 prefix 拼接/实体反转义；
//! - list_dir 分页：NextContinuationToken 透传到下一请求；
//! - read_range：Range 请求头与响应流（start>0 两段 GET；start==0 单 GET）；
//! - 错误映射：404→NotFound、403→Other；
//! - stat：HEAD 文件 / 目录前缀探测 / 空探 NotFound / 挂载根恒 Dir；
//! - 能力位：远端后端 watch/search 均 false；virtual-host 风格 URL 形态。

use std::path::Path;
use std::sync::Arc;

use futures_util::io::AsyncReadExt as FuturesAsyncReadExt;
use tokio::io::AsyncReadExt;

use vviewer_storage::s3::{sign_request, S3Backend, S3Credentials, S3MountConfig};
use vviewer_storage::transport::{http_response, MockTransport};
use vviewer_storage::{
    ByteStream, EntryKind, HttpTransport, HttpRequest, MountCapabilities, RangeSpec,
    StorageBackend, StorageErrorKind,
};

/// AWS 官方文档示例凭证（docs.aws.amazon.com SigV4 各例通用，非真实凭证）。
const AK: &str = "AKIAIOSFODNN7EXAMPLE";
const SK: &str = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
/// 空载荷 SHA256（GET/HEAD/列表请求的 payload hash）。
const EMPTY_SHA256: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

fn s3_config() -> S3MountConfig {
    S3MountConfig {
        endpoint: "https://s3.test.example.com".into(),
        bucket: "example-bucket".into(),
        prefix: "sub".into(),
        access_key_id: AK.into(),
        secret_access_key: SK.into(),
        path_style: true,
    }
}

fn backend_with(transport: Arc<dyn HttpTransport>) -> Arc<dyn StorageBackend> {
    Arc::new(S3Backend::new(s3_config(), transport))
}

fn header<'a>(req: &'a HttpRequest, name: &str) -> Option<&'a str> {
    req.headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(name))
        .map(|(_, v)| v.as_str())
}

async fn drain_tokio(mut stream: ByteStream) -> Vec<u8> {
    let mut out = Vec::new();
    stream.read_to_end(&mut out).await.unwrap();
    out
}

// ---------- SigV4：AWS 官方向量（GET object us-east-1 经典例） ----------

#[test]
fn sigv4_aws_official_get_object_vector() {
    // 官方向量：docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html
    // 「Example: GET Object」——canonical request / string-to-sign / signature
    // 全链官方给定，逐 header 断言。
    let signed = sign_request(
        "GET",
        "https://examplebucket.s3.amazonaws.com/test.txt",
        &[("Range".to_string(), "bytes=0-9".to_string())],
        b"",
        &S3Credentials { access_key_id: AK.into(), secret_access_key: SK.into() },
        "us-east-1",
        "s3",
        "20130524T000000Z",
    );

    let get = |name: &str| {
        signed
            .get(name)
            .unwrap_or_else(|| panic!("missing header {name}"))
    };
    assert_eq!(get("host"), "examplebucket.s3.amazonaws.com");
    assert_eq!(get("range"), "bytes=0-9");
    assert_eq!(get("x-amz-date"), "20130524T000000Z");
    assert_eq!(get("x-amz-content-sha256"), EMPTY_SHA256);
    assert_eq!(
        get("authorization"),
        "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"
    );
    // 签出面恰好这 5 个头（host/range/x-amz-date/x-amz-content-sha256/authorization）
    assert_eq!(signed.headers.len(), 5);
}

// ---------- ListObjectsV2：XML → Entry 映射 ----------

/// 单页列表样本：S3 API 2006-03-01 字面结构（Contents/CommonPrefixes/Delimiter/
/// 实体转义/零字节目录标记）。**版本耦合锚**：解析只认本文件的字面形态，
/// S3 上游若改结构（如 tag 改名/加命名空间前缀）此处样本即失效。
const LIST_PAGE: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>example-bucket</Name>
  <Prefix>sub/</Prefix>
  <KeyCount>4</KeyCount>
  <MaxKeys>1000</MaxKeys>
  <Delimiter>/</Delimiter>
  <IsTruncated>false</IsTruncated>
  <Contents>
    <Key>sub/a.txt</Key>
    <LastModified>2019-02-19T21:48:39.000Z</LastModified>
    <ETag>&quot;77d0367cc4b26dbc0a0d9043a37ebda8&quot;</ETag>
    <Size>314</Size>
    <StorageClass>STANDARD</StorageClass>
  </Contents>
  <Contents>
    <Key>sub/b&amp;c.txt</Key>
    <LastModified>2020-06-01T00:00:00.000Z</LastModified>
    <Size>7</Size>
    <StorageClass>STANDARD</StorageClass>
  </Contents>
  <Contents>
    <Key>sub/zero-marker/</Key>
    <LastModified>2021-01-01T00:00:00.000Z</LastModified>
    <Size>0</Size>
    <StorageClass>STANDARD</StorageClass>
  </Contents>
  <CommonPrefixes>
    <Prefix>sub/dir/</Prefix>
  </CommonPrefixes>
</ListBucketResult>"#;

#[tokio::test]
async fn list_dir_maps_contents_and_common_prefixes() {
    let transport = Arc::new(
        MockTransport::new().with_route("GET", "example-bucket", move |_| {
            http_response(200, &[("content-type", "application/xml")], LIST_PAGE)
        }),
    );
    let backend = backend_with(transport.clone());

    let entries = backend.list_dir(Path::new("")).await.unwrap();
    let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
    // 目录优先 + 自然序（与 LocalFs 呈现序一致）；零字节目录标记（尾 '/' 键）不浮现
    assert_eq!(names, vec!["dir", "a.txt", "b&c.txt"]);

    let dir = &entries[0];
    assert_eq!(dir.kind, EntryKind::Dir);
    assert_eq!(dir.size, None);
    assert_eq!(dir.mtime, None);

    let a = &entries[1];
    assert_eq!(a.kind, EntryKind::File);
    assert_eq!(a.size, Some(314));
    assert_eq!(a.mtime, Some(1550612919000)); // 2019-02-19T21:48:39.000Z

    let b = &entries[2];
    assert_eq!(b.name, "b&c.txt"); // XML 实体反转义
    assert_eq!(b.size, Some(7));
    assert_eq!(b.mtime, Some(1590969600000)); // 2020-06-01T00:00:00.000Z

    // 请求面：ListObjectsV2 参数 + prefix 拼接（挂载 prefix "sub" + 根 "" → sub/）
    let reqs = transport.recorded_requests();
    assert_eq!(reqs.len(), 1);
    let req = &reqs[0];
    assert_eq!(req.method, "GET");
    assert!(
        req.url.starts_with("https://s3.test.example.com/example-bucket?"),
        "path-style URL, got {}",
        req.url
    );
    assert!(req.url.contains("list-type=2"), "{}", req.url);
    assert!(req.url.contains("delimiter=%2F"), "{}", req.url);
    assert!(req.url.contains("prefix=sub%2F"), "{}", req.url);
    // 签名头（值随请求面变化，断言形态锚）
    assert_eq!(header(req, "host"), Some("s3.test.example.com"));
    assert_eq!(header(req, "x-amz-content-sha256"), Some(EMPTY_SHA256));
    let amz_date = header(req, "x-amz-date").unwrap();
    assert_eq!(amz_date.len(), 16, "YYYYMMDDThhmmssZ: {amz_date}");
    assert!(amz_date.ends_with('Z') && amz_date.as_bytes()[8] == b'T');
    let auth = header(req, "authorization").unwrap();
    assert!(
        auth.starts_with(&format!(
            "AWS4-HMAC-SHA256 Credential={AK}/"
        )) && auth.contains("/s3/aws4_request, "),
        "auth={auth}"
    );
}

#[tokio::test]
async fn list_dir_joins_mount_prefix_with_relative_path() {
    let transport = Arc::new(
        MockTransport::new().with_route("GET", "example-bucket", |_| {
            http_response(
                200,
                &[],
                r#"<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>"#,
            )
        }),
    );
    let backend = backend_with(transport.clone());

    let entries = backend.list_dir(Path::new("docs")).await.unwrap();
    assert!(entries.is_empty());
    let reqs = transport.recorded_requests();
    // prefix = 挂载 prefix "sub/" + 相对路径 "docs" + "/"
    assert!(
        reqs[0].url.contains("prefix=sub%2Fdocs%2F"),
        "{}",
        reqs[0].url
    );
}

// ---------- 分页：continuation-token 透传 ----------

#[tokio::test]
async fn list_dir_follows_continuation_token() {
    let transport = Arc::new(
        MockTransport::new().with_route("GET", "example-bucket", |req: &HttpRequest| {
            if req.url.contains("continuation-token=") {
                // 第 2 页：末页
                http_response(
                    200,
                    &[],
                    r#"<ListBucketResult>
                      <IsTruncated>false</IsTruncated>
                      <Contents><Key>sub/e.txt</Key><LastModified>2020-06-01T00:00:00.000Z</LastModified><Size>5</Size></Contents>
                    </ListBucketResult>"#,
                )
            } else {
                // 第 1 页：截断 + 续传 token（含 '/' 与 '='，编码面参与断言）
                http_response(
                    200,
                    &[],
                    r#"<ListBucketResult>
                      <IsTruncated>true</IsTruncated>
                      <NextContinuationToken>next-page/1=</NextContinuationToken>
                      <Contents><Key>sub/a.txt</Key><LastModified>2019-02-19T21:48:39.000Z</LastModified><Size>3</Size></Contents>
                    </ListBucketResult>"#,
                )
            }
        }),
    );
    let backend = backend_with(transport.clone());

    let entries = backend.list_dir(Path::new("")).await.unwrap();
    let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
    assert_eq!(names, vec!["a.txt", "e.txt"]); // 两页聚合

    let reqs = transport.recorded_requests();
    assert_eq!(reqs.len(), 2);
    assert!(!reqs[0].url.contains("continuation-token="));
    assert!(
        reqs[1].url.contains("continuation-token=next-page%2F1%3D"),
        "token 透传（percent 编码形态）: {}",
        reqs[1].url
    );
}

// ---------- read_range：Range 请求头与响应流 ----------

const BIG_BODY: &[u8] = b"0123456789ABCDEFGHIJ"; // 20 字节

#[tokio::test]
async fn read_range_full_file_single_get() {
    let transport = Arc::new(
        MockTransport::new().with_route("GET", "big.bin", |req: &HttpRequest| {
            assert!(header(req, "range").is_none(), "全量读取不带 Range");
            http_response(200, &[("content-length", "20")], BIG_BODY)
        }),
    );
    let backend = backend_with(transport);

    let read = backend
        .read_range(Path::new("big.bin"), None, 8)
        .await
        .unwrap();
    assert_eq!(read.total_size, 20);
    assert_eq!(read.head, b"01234567"); // 文件前缀采样
    assert_eq!(drain_tokio(read.stream).await, BIG_BODY); // 流 = 全量窗
}

#[tokio::test]
async fn read_range_window_from_start_single_get() {
    let transport = Arc::new(
        MockTransport::new().with_route("GET", "big.bin", |req: &HttpRequest| {
            assert_eq!(header(req, "range"), Some("bytes=0-9"));
            http_response(206, &[("content-range", "bytes 0-9/20")], b"0123456789")
        }),
    );
    let backend = backend_with(transport);

    let read = backend
        .read_range(
            Path::new("big.bin"),
            Some(RangeSpec { start: 0, len: 10 }),
            8,
        )
        .await
        .unwrap();
    assert_eq!(read.total_size, 20); // Content-Range 总长
    assert_eq!(read.head, b"01234567");
    assert_eq!(drain_tokio(read.stream).await, b"0123456789");
}

#[tokio::test]
async fn read_range_mid_window_uses_two_gets() {
    let transport = Arc::new(
        MockTransport::new().with_route("GET", "big.bin", |req: &HttpRequest| {
            match header(req, "range") {
                // 前缀采样 GET
                Some("bytes=0-7") => {
                    http_response(206, &[("content-range", "bytes 0-7/20")], b"01234567")
                }
                // 窗 GET（bytes=10-15 → "ABCDEF"）
                Some("bytes=10-15") => {
                    http_response(206, &[("content-range", "bytes 10-15/20")], b"ABCDEF")
                }
                other => panic!("unexpected range header {other:?}"),
            }
        }),
    );
    let backend = backend_with(transport.clone());

    let read = backend
        .read_range(
            Path::new("big.bin"),
            Some(RangeSpec { start: 10, len: 6 }),
            8,
        )
        .await
        .unwrap();
    assert_eq!(read.total_size, 20);
    assert_eq!(read.head, b"01234567"); // 头来自文件前缀 GET
    assert_eq!(drain_tokio(read.stream).await, b"ABCDEF"); // 流来自窗 GET

    let reqs = transport.recorded_requests();
    assert_eq!(reqs.len(), 2);
    assert_eq!(header(&reqs[0], "range"), Some("bytes=0-7"));
    assert_eq!(header(&reqs[1], "range"), Some("bytes=10-15"));
}

// ---------- 错误映射 ----------

#[tokio::test]
async fn error_mapping_404_is_not_found() {
    let transport = Arc::new(MockTransport::new().with_route("GET", "missing.bin", |_| {
        http_response(404, &[], "<Error><Code>NoSuchKey</Code></Error>")
    }));
    let backend = backend_with(transport);

    let err = backend
        .read_range(Path::new("missing.bin"), None, 8)
        .await
        .unwrap_err();
    assert_eq!(err.kind(), StorageErrorKind::NotFound);
}

#[tokio::test]
async fn error_mapping_403_is_other_with_status() {
    let transport = Arc::new(MockTransport::new().with_route("GET", "denied.bin", |_| {
        http_response(403, &[], "<Error><Code>AccessDenied</Code></Error>")
    }));
    let backend = backend_with(transport);

    let err = backend
        .read_range(Path::new("denied.bin"), None, 8)
        .await
        .unwrap_err();
    assert_eq!(err.kind(), StorageErrorKind::Other);
    assert!(err.message().contains("403"), "message={}", err.message());
}

// ---------- stat ----------

#[tokio::test]
async fn stat_file_via_head() {
    let transport = Arc::new(
        MockTransport::new().with_route("HEAD", "a.txt", |_| {
            http_response(
                200,
                &[
                    ("content-length", "314"),
                    ("last-modified", "Fri, 24 May 2013 00:00:00 GMT"),
                ],
                b"",
            )
        }),
    );
    let backend = backend_with(transport.clone());

    let entry = backend.stat(Path::new("a.txt")).await.unwrap();
    assert_eq!(entry.kind, EntryKind::File);
    assert_eq!(entry.size, Some(314));
    assert_eq!(entry.mtime, Some(1369353600000)); // 2013-05-24T00:00:00Z

    let reqs = transport.recorded_requests();
    assert_eq!(reqs[0].method, "HEAD");
    assert!(reqs[0].url.ends_with("/example-bucket/sub/a.txt"));
}

#[tokio::test]
async fn stat_directory_via_prefix_probe() {
    let transport = Arc::new(
        MockTransport::new()
            .with_route("HEAD", "example-bucket", |_| http_response(404, &[], b""))
            .with_route("GET", "example-bucket", |_| {
                http_response(
                    200,
                    &[],
                    r#"<ListBucketResult>
                      <IsTruncated>false</IsTruncated>
                      <CommonPrefixes><Prefix>sub/docs/</Prefix></CommonPrefixes>
                    </ListBucketResult>"#,
                )
            }),
    );
    let backend = backend_with(transport.clone());

    let entry = backend.stat(Path::new("docs")).await.unwrap();
    assert_eq!(entry.kind, EntryKind::Dir);
    assert_eq!(entry.size, None);

    let reqs = transport.recorded_requests();
    assert_eq!(reqs[0].method, "HEAD");
    // 目录探测：prefix=sub/docs/ 限定探查 + max-keys=1
    assert!(reqs[1].url.contains("prefix=sub%2Fdocs%2F"), "{}", reqs[1].url);
    assert!(reqs[1].url.contains("max-keys=1"), "{}", reqs[1].url);
}

#[tokio::test]
async fn stat_missing_is_not_found() {
    let transport = Arc::new(
        MockTransport::new()
            .with_route("HEAD", "example-bucket", |_| http_response(404, &[], b""))
            .with_route("GET", "example-bucket", |_| {
                http_response(
                    200,
                    &[],
                    r#"<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>"#,
                )
            }),
    );
    let backend = backend_with(transport);

    let err = backend.stat(Path::new("nope")).await.unwrap_err();
    assert_eq!(err.kind(), StorageErrorKind::NotFound);
}

#[tokio::test]
async fn stat_mount_root_is_dir_without_requests() {
    let transport = Arc::new(MockTransport::new());
    let backend = backend_with(transport.clone());

    let entry = backend.stat(Path::new("")).await.unwrap();
    assert_eq!(entry.kind, EntryKind::Dir);
    assert!(transport.recorded_requests().is_empty());
}

// ---------- 能力位与 URL 风格 ----------

#[tokio::test]
async fn capabilities_are_degraded_for_remote() {
    let transport = Arc::new(MockTransport::new());
    let backend = backend_with(transport);
    let caps: MountCapabilities = backend.capabilities();
    assert!(!caps.watch);
    assert!(!caps.search);
}

#[tokio::test]
async fn virtual_host_style_url() {
    let cfg = S3MountConfig {
        path_style: false,
        ..s3_config()
    };
    let transport = Arc::new(
        MockTransport::new().with_route("GET", "example-bucket", |_| {
            http_response(
                200,
                &[],
                r#"<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>"#,
            )
        }),
    );
    let backend: Arc<dyn StorageBackend> =
        Arc::new(S3Backend::new(cfg, transport.clone()));

    backend.list_dir(Path::new("")).await.unwrap();
    let reqs = transport.recorded_requests();
    assert!(
        reqs[0].url.starts_with("https://example-bucket.s3.test.example.com?"),
        "virtual-host 风格：{}",
        reqs[0].url
    );
}

// ---------- transport 基建自检 ----------

#[tokio::test]
async fn mock_transport_unmatched_route_errors() {
    let transport = MockTransport::new().with_route("GET", "only-this", |_| {
        http_response(200, &[], b"hi")
    });
    let err = transport
        .execute(HttpRequest {
            method: "GET".into(),
            url: "https://x.test/other".into(),
            headers: vec![],
            body: None,
        })
        .await
        .unwrap_err();
    assert_eq!(err.kind(), StorageErrorKind::Other);

    // 命中路由：body 经 futures 侧 drain（HttpByteStream 消费形态锚）
    let resp = transport
        .execute(HttpRequest {
            method: "GET".into(),
            url: "https://x.test/only-this".into(),
            headers: vec![],
            body: None,
        })
        .await
        .unwrap();
    assert_eq!(resp.status, 200);
    let mut body = resp.body;
    let mut out = Vec::new();
    body.read_to_end(&mut out).await.unwrap();
    assert_eq!(out, b"hi");
}
