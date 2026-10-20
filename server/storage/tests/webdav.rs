//! WebDAV 后端集成测试（Task 4，mock transport 基建——与 s3.rs 同一套）。
//!
//! 断言面：
//! - PROPFIND Depth:1 multistatus 解析：`d:`/`D:` 命名空间双形态（版本耦合
//!   样本锚）、文件与集合区分（尾斜杠 + resourcetype）、href percent 解码
//!   （中文路径）、XML 实体反转义、Depth:1 自身条目跳过；
//! - Basic auth：Authorization 头形态（明文凭证不入 Debug 输出）；
//! - read_range：Range 请求头与响应流（无窗/起点 0 窗/中段窗两 GET）；
//! - **Range 防线（spec §2，降级语义）**：忽略 Range 的全量响应 / 无
//!   Content-Range → 该挂载标记 rangeCapable=false，且本次读仍从实际响应体
//!   切出正确请求窗；
//! - 错误映射：404→NotFound、401→认证失败语义（Other）、500→Other；
//! - stat：PROPFIND Depth:0 文件/集合、挂载根恒 Dir 不发请求、404→NotFound；
//! - 能力位：远端后端 watch/search 均 false。

use std::path::Path;
use std::sync::Arc;

use tokio::io::AsyncReadExt;

use vviewer_storage::transport::{http_response, MockTransport};
use vviewer_storage::webdav::{WebDavBackend, WebDavMountConfig};
use vviewer_storage::{
    ByteStream, EntryKind, HttpTransport, HttpRequest, MountCapabilities, RangeSpec,
    StorageBackend, StorageErrorKind,
};

fn config() -> WebDavMountConfig {
    WebDavMountConfig {
        endpoint: "https://dav.example.com/dav".into(),
        prefix: "sub".into(),
        username: "alice".into(),
        password: "s3cret".into(),
    }
}

fn backend_with(transport: Arc<dyn HttpTransport>) -> Arc<WebDavBackend> {
    Arc::new(WebDavBackend::new(config(), transport))
}

fn header<'a>(req: &'a HttpRequest, name: &str) -> Option<&'a str> {
    req.headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(name))
        .map(|(_, v)| v.as_str())
}

async fn drain(mut stream: ByteStream) -> Vec<u8> {
    let mut out = Vec::new();
    stream.read_to_end(&mut out).await.unwrap();
    out
}

// ---------- multistatus 格式样本（版本耦合锚：RFC 4918 §14.16 字面结构） ----------

/// `d:` 小写前缀形态：集合自身 + 两个文件（含 XML 实体与 percent 编码中文）
/// + 一个集合。**版本耦合锚**：解析只认本文件的字面形态，上游服务器若换
/// 结构（tag 改名/嵌套变形）此处样本即失效。
const PROPFIND_PAGE_LOWER: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:">
  <d:response>
    <d:href>/dav/sub/</d:href>
    <d:propstat>
      <d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
  <d:response>
    <d:href>/dav/sub/a.txt</d:href>
    <d:propstat>
      <d:prop><d:resourcetype/><d:getcontentlength>314</d:getcontentlength><d:getlastmodified>Fri, 24 May 2013 00:00:00 GMT</d:getlastmodified></d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
  <d:response>
    <d:href>/dav/sub/b&amp;c.txt</d:href>
    <d:propstat>
      <d:prop><d:getcontentlength>7</d:getcontentlength></d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
  <d:response>
    <d:href>/dav/sub/%E4%B8%AD%E6%96%87.txt</d:href>
    <d:propstat>
      <d:prop><d:resourcetype/><d:getcontentlength>3</d:getcontentlength></d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
  <d:response>
    <d:href>/dav/sub/dir/</d:href>
    <d:propstat>
      <d:prop><d:resourcetype><d:collection/></d:resourcetype><d:getlastmodified>Thu, 01 Jun 2017 00:00:00 GMT</d:getlastmodified></d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>"#;

/// `D:` 大写前缀形态 + 绝对 URI href（另一种常见服务器回传形态）。
const PROPFIND_PAGE_UPPER: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>/dav/sub/</D:href>
    <D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
  </D:response>
  <D:response>
    <D:href>https://dav.example.com/dav/sub/doc.pdf</D:href>
    <D:propstat><D:prop><D:resourcetype/><D:getcontentlength>4096</D:getcontentlength></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
  </D:response>
  <D:response>
    <D:href>/dav/sub/nested/</D:href>
    <D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
  </D:response>
</D:multistatus>"#;

const STAT_FILE_PAGE: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:">
  <d:response>
    <d:href>/dav/sub/a.txt</d:href>
    <d:propstat><d:prop><d:resourcetype/><d:getcontentlength>314</d:getcontentlength><d:getlastmodified>Fri, 24 May 2013 00:00:00 GMT</d:getlastmodified></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  </d:response>
</d:multistatus>"#;

const STAT_DIR_PAGE: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:">
  <d:response>
    <d:href>/dav/sub/dir/</d:href>
    <d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype><d:getlastmodified>Thu, 01 Jun 2017 00:00:00 GMT</d:getlastmodified></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  </d:response>
</d:multistatus>"#;

// ---------- list_dir：PROPFIND Depth:1 multistatus 解析 ----------

#[tokio::test]
async fn list_dir_parses_lower_namespace_multistatus() {
    let transport = Arc::new(
        MockTransport::new().with_route("PROPFIND", "dav.example.com", move |_| {
            http_response(207, &[("content-type", "application/xml")], PROPFIND_PAGE_LOWER)
        }),
    );
    let backend = backend_with(transport.clone());

    let entries = backend.list_dir(Path::new("")).await.unwrap();
    let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
    // 目录优先 + 自然序（与 LocalFs/S3 呈现序一致）；Depth:1 的集合自身条目
    // 不浮现；href 的 percent 编码解码为中文、XML 实体反转义
    assert_eq!(names, vec!["dir", "a.txt", "b&c.txt", "中文.txt"]);

    let dir = &entries[0];
    assert_eq!(dir.kind, EntryKind::Dir);
    assert_eq!(dir.size, None);
    assert_eq!(dir.mtime, Some(1_496_275_200_000)); // Thu, 01 Jun 2017

    let a = &entries[1];
    assert_eq!(a.kind, EntryKind::File);
    assert_eq!(a.size, Some(314));
    assert_eq!(a.mtime, Some(1_369_353_600_000)); // Fri, 24 May 2013

    assert_eq!(entries[3].kind, EntryKind::File);
    assert_eq!(entries[3].size, Some(3));

    // 请求面：PROPFIND Depth:1 + 集合 URL（挂载 prefix "sub" + 尾斜杠）+
    // propfind 请求体 + Basic auth + Content-Type
    let reqs = transport.recorded_requests();
    assert_eq!(reqs.len(), 1);
    let req = &reqs[0];
    assert_eq!(req.method, "PROPFIND");
    assert_eq!(req.url, "https://dav.example.com/dav/sub/");
    assert_eq!(header(req, "depth"), Some("1"));
    assert_eq!(header(req, "content-type"), Some("application/xml"));
    let auth = header(req, "authorization").unwrap();
    assert!(auth.starts_with("Basic "), "auth={auth}");
    assert!(!auth.contains("s3cret") && !auth.contains("alice"), "auth={auth}");
    assert!(req.body.as_deref().unwrap_or(b"").len() > 0, "propfind 请求体存在");
}

#[tokio::test]
async fn list_dir_parses_upper_namespace_and_absolute_href() {
    let transport = Arc::new(
        MockTransport::new().with_route("PROPFIND", "dav.example.com", |_| {
            http_response(207, &[], PROPFIND_PAGE_UPPER)
        }),
    );
    let backend = backend_with(transport);

    let entries = backend.list_dir(Path::new("")).await.unwrap();
    let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
    // `D:` 前缀解析 + 绝对 URI href 剥 scheme/authority 取名 + 自身跳过
    assert_eq!(names, vec!["nested", "doc.pdf"]);
    assert_eq!(entries[0].kind, EntryKind::Dir);
    assert_eq!(entries[1].kind, EntryKind::File);
    assert_eq!(entries[1].size, Some(4096));
}

/// 台账③：任意自定义命名空间前缀（服务器自由选前缀，`d:`/`D:` 只是常见两态
/// ——解析按「前缀无关的 local name」识别，此处锚一个非典型前缀 `md:`）。
#[tokio::test]
async fn list_dir_parses_arbitrary_custom_namespace_prefix() {
    const MD_PREFIX_PAGE: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<md:multistatus xmlns:md="DAV:">
  <md:response>
    <md:href>/dav/sub/</md:href>
    <md:propstat><md:prop><md:resourcetype><md:collection/></md:resourcetype></md:prop><md:status>HTTP/1.1 200 OK</md:status></md:propstat>
  </md:response>
  <md:response>
    <md:href>/dav/sub/md-file.txt</md:href>
    <md:propstat><md:prop><md:resourcetype/><md:getcontentlength>9</md:getcontentlength></md:prop><md:status>HTTP/1.1 200 OK</md:status></md:propstat>
  </md:response>
</md:multistatus>"#;
    let transport = Arc::new(
        MockTransport::new().with_route("PROPFIND", "dav.example.com", |_| {
            http_response(207, &[], MD_PREFIX_PAGE)
        }),
    );
    let backend = backend_with(transport);

    let entries = backend.list_dir(Path::new("")).await.unwrap();
    let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
    assert_eq!(names, vec!["md-file.txt"]);
    assert_eq!(entries[0].kind, EntryKind::File);
    assert_eq!(entries[0].size, Some(9));
}

#[tokio::test]
async fn list_dir_joins_mount_prefix_with_relative_path() {
    let transport = Arc::new(
        MockTransport::new().with_route("PROPFIND", "dav.example.com", |_| {
            http_response(207, &[], r#"<d:multistatus xmlns:d="DAV:"/>"#)
        }),
    );
    let backend = backend_with(transport.clone());

    let entries = backend.list_dir(Path::new("docs")).await.unwrap();
    assert!(entries.is_empty());
    let reqs = transport.recorded_requests();
    // 集合 URL = endpoint + 挂载 prefix + 相对路径，恒尾斜杠
    assert_eq!(reqs[0].url, "https://dav.example.com/dav/sub/docs/");
}

#[tokio::test]
async fn request_url_encodes_chinese_and_literal_percent() {
    let transport = Arc::new(
        MockTransport::new().with_route("PROPFIND", "dav.example.com", |_| {
            http_response(207, &[], STAT_FILE_PAGE)
        }),
    );
    let backend = backend_with(transport.clone());

    // 字面 '%' 段纯编码（%→%25，不解码归一——同 s3 评审 Minor-1 口径）
    backend.stat(Path::new("目录/图%20片.png")).await.unwrap();
    let reqs = transport.recorded_requests();
    assert!(
        reqs[0].url.ends_with("/dav/sub/%E7%9B%AE%E5%BD%95/%E5%9B%BE%2520%E7%89%87.png"),
        "{}",
        reqs[0].url
    );
}

// ---------- read_range：Range 请求头与响应流 ----------

const BIG_BODY: &[u8] = b"0123456789ABCDEFGHIJ"; // 20 字节

#[tokio::test]
async fn read_range_full_file_without_range_header() {
    let transport = Arc::new(
        MockTransport::new().with_route("GET", "dav.example.com", |req: &HttpRequest| {
            assert!(header(req, "range").is_none(), "全量读取不带 Range");
            http_response(200, &[("content-length", "20")], BIG_BODY)
        }),
    );
    let backend = backend_with(transport);

    let read = backend
        .read_range(Path::new("big.bin"), None, 8)
        .await
        .unwrap();
    assert_eq!(read.total_size, 20); // Content-Length
    assert_eq!(read.head, b"01234567"); // 文件前缀采样（编码检测窗）
    assert_eq!(drain(read.stream).await, BIG_BODY);
}

#[tokio::test]
async fn read_range_window_from_start_honored() {
    let transport = Arc::new(
        MockTransport::new().with_route("GET", "dav.example.com", |req: &HttpRequest| {
            assert_eq!(header(req, "range"), Some("bytes=0-9"));
            http_response(
                206,
                &[("content-range", "bytes 0-9/20"), ("content-length", "10")],
                b"0123456789",
            )
        }),
    );
    let backend = backend_with(transport.clone());
    assert!(backend.range_capable(), "初始实测未降级");

    let read = backend
        .read_range(Path::new("big.bin"), Some(RangeSpec { start: 0, len: 10 }), 8)
        .await
        .unwrap();
    assert_eq!(read.total_size, 20); // Content-Range 尾段总长
    assert_eq!(read.head, b"01234567");
    assert_eq!(drain(read.stream).await, b"0123456789");
    assert!(backend.range_capable(), "窗被遵从：不降级");
}

#[tokio::test]
async fn read_range_mid_window_uses_two_gets() {
    let transport = Arc::new(
        MockTransport::new().with_route("GET", "dav.example.com", |req: &HttpRequest| {
            match header(req, "range") {
                // 前缀采样 GET
                Some("bytes=0-7") => {
                    http_response(
                        206,
                        &[("content-range", "bytes 0-7/20"), ("content-length", "8")],
                        b"01234567",
                    )
                }
                // 窗 GET（bytes=10-15 → "ABCDEF"）
                Some("bytes=10-15") => {
                    http_response(
                        206,
                        &[("content-range", "bytes 10-15/20"), ("content-length", "6")],
                        b"ABCDEF",
                    )
                }
                other => panic!("unexpected range header {other:?}"),
            }
        }),
    );
    let backend = backend_with(transport.clone());

    let read = backend
        .read_range(Path::new("big.bin"), Some(RangeSpec { start: 10, len: 6 }), 8)
        .await
        .unwrap();
    assert_eq!(read.total_size, 20);
    assert_eq!(read.head, b"01234567"); // 头来自前缀 GET
    assert_eq!(drain(read.stream).await, b"ABCDEF"); // 流来自窗 GET
    assert!(backend.range_capable());

    let reqs = transport.recorded_requests();
    assert_eq!(reqs.len(), 2);
    assert_eq!(header(&reqs[0], "range"), Some("bytes=0-7")); // 记录序 [head, window]
    assert_eq!(header(&reqs[1], "range"), Some("bytes=10-15"));
}

// ---------- Range 防线（spec §2：不符 → rangeCapable=false 降级标记） ----------

/// 服务器无视 Range 返 200 全量：本次读从全量体切出请求窗（降级不报错，
/// 与 S3 的拒绝语义不同源——WebDAV 服务器不可控），挂载标记 rangeCapable=false。
#[tokio::test]
async fn range_defense_full_response_marks_not_capable() {
    let transport = Arc::new(
        MockTransport::new().with_route("GET", "dav.example.com", |req: &HttpRequest| {
            assert!(header(req, "range").is_some(), "窗/前缀请求均带 Range");
            // 无视 Range：一律 200 全量
            http_response(200, &[("content-length", "20")], BIG_BODY)
        }),
    );
    let backend = backend_with(transport.clone());

    let read = backend
        .read_range(Path::new("big.bin"), Some(RangeSpec { start: 10, len: 6 }), 8)
        .await
        .unwrap();
    // 降级不报错：从全量体切出正确的窗
    assert_eq!(read.total_size, 20);
    assert_eq!(read.head, b"01234567"); // 头仍为文件前缀（来自前缀 GET）
    assert_eq!(drain(read.stream).await, b"ABCDEF");
    assert!(!backend.range_capable(), "窗不符 → rangeCapable=false");

    let reqs = transport.recorded_requests();
    assert_eq!(reqs.len(), 2);
    assert_eq!(header(&reqs[0], "range"), Some("bytes=0-7"));
    assert_eq!(header(&reqs[1], "range"), Some("bytes=10-15"));
}

/// 206 但无 Content-Range 且长度>请求窗：同样降级标记。
#[tokio::test]
async fn range_defense_missing_content_range_marks_not_capable() {
    let transport = Arc::new(
        MockTransport::new().with_route("GET", "dav.example.com", |_| {
            // 有 206 状态但无 Content-Range、长度为全量 20（窗 10）
            http_response(206, &[("content-length", "20")], BIG_BODY)
        }),
    );
    let backend = backend_with(transport);

    let read = backend
        .read_range(Path::new("big.bin"), Some(RangeSpec { start: 0, len: 10 }), 8)
        .await
        .unwrap();
    assert_eq!(read.total_size, 20);
    assert_eq!(read.head, b"01234567");
    assert_eq!(drain(read.stream).await, b"0123456789"); // 起点窗自全量体切出
    assert!(!backend.range_capable());
}

// ---------- 错误映射 ----------

#[tokio::test]
async fn error_mapping_404_401_500() {
    let transport = Arc::new(
        MockTransport::new()
            .with_route("GET", "missing.bin", |_| http_response(404, &[], b"not found"))
            .with_route("GET", "locked.bin", |_| http_response(401, &[], b"unauthorized"))
            .with_route("GET", "oops.bin", |_| http_response(500, &[], b"boom")),
    );
    let backend = backend_with(transport);

    let err = backend
        .read_range(Path::new("missing.bin"), None, 8)
        .await
        .unwrap_err();
    assert_eq!(err.kind(), StorageErrorKind::NotFound);

    let err = backend
        .read_range(Path::new("locked.bin"), None, 8)
        .await
        .unwrap_err();
    assert_eq!(err.kind(), StorageErrorKind::Other);
    assert!(
        err.message().contains("401") && err.message().contains("auth"),
        "认证失败语义：{}",
        err.message()
    );

    let err = backend
        .read_range(Path::new("oops.bin"), None, 8)
        .await
        .unwrap_err();
    assert_eq!(err.kind(), StorageErrorKind::Other);
    assert!(err.message().contains("500"), "message={}", err.message());
}

// ---------- stat：PROPFIND Depth:0 ----------

#[tokio::test]
async fn stat_file_via_propfind_depth0() {
    let transport = Arc::new(
        MockTransport::new().with_route("PROPFIND", "dav.example.com", |_| {
            http_response(207, &[], STAT_FILE_PAGE)
        }),
    );
    let backend = backend_with(transport.clone());

    let entry = backend.stat(Path::new("a.txt")).await.unwrap();
    assert_eq!(entry.kind, EntryKind::File);
    assert_eq!(entry.name, "a.txt");
    assert_eq!(entry.size, Some(314));
    assert_eq!(entry.mtime, Some(1_369_353_600_000));

    let reqs = transport.recorded_requests();
    assert_eq!(reqs[0].method, "PROPFIND");
    assert_eq!(header(&reqs[0], "depth"), Some("0"));
    assert_eq!(reqs[0].url, "https://dav.example.com/dav/sub/a.txt");
}

#[tokio::test]
async fn stat_dir_via_resourcetype_collection() {
    let transport = Arc::new(
        MockTransport::new().with_route("PROPFIND", "dav.example.com", |_| {
            http_response(207, &[], STAT_DIR_PAGE)
        }),
    );
    let backend = backend_with(transport);

    let entry = backend.stat(Path::new("dir")).await.unwrap();
    assert_eq!(entry.kind, EntryKind::Dir);
    assert_eq!(entry.name, "dir");
    assert_eq!(entry.size, None);
    assert_eq!(entry.mtime, Some(1_496_275_200_000));
}

#[tokio::test]
async fn stat_mount_root_is_dir_without_requests() {
    let transport = Arc::new(MockTransport::new());
    let backend = backend_with(transport.clone());

    let entry = backend.stat(Path::new("")).await.unwrap();
    assert_eq!(entry.kind, EntryKind::Dir);
    assert!(transport.recorded_requests().is_empty());
}

#[tokio::test]
async fn stat_missing_is_not_found() {
    let transport = Arc::new(
        MockTransport::new().with_route("PROPFIND", "dav.example.com", |_| {
            http_response(404, &[], b"")
        }),
    );
    let backend = backend_with(transport);

    let err = backend.stat(Path::new("nope")).await.unwrap_err();
    assert_eq!(err.kind(), StorageErrorKind::NotFound);
}

// ---------- 能力位与凭证脱敏 ----------

#[tokio::test]
async fn capabilities_are_degraded_for_remote() {
    let transport = Arc::new(MockTransport::new());
    let backend = backend_with(transport);
    let caps: MountCapabilities = backend.capabilities();
    assert!(!caps.watch);
    assert!(!caps.search);
}

#[test]
fn debug_redacts_credentials() {
    let cfg = config();
    let dbg = format!("{cfg:?}");
    assert!(dbg.contains("[redacted]"), "{dbg}");
    assert!(!dbg.contains("alice"), "{dbg}");
    assert!(!dbg.contains("s3cret"), "{dbg}");
    // endpoint/prefix 非敏感：原样可排障
    assert!(dbg.contains("dav.example.com"), "{dbg}");
}
