//! LocalFs 语义锚定测试（Task 2 纯重构行为锁的 storage 侧锚点）。
//!
//! 断言与下沉前的 routes/tree.rs 扫描、routes/file.rs 读取逐条对齐：
//! - list_dir = 既有 tree 扫描输出（hidden 过滤 / 目录优先+自然排序 /
//!   BUG-48 保真名 / 目录无 size / mtime 毫秒 / 竞态删除跳过）；
//! - read_range = 既有 file 读取形态（单次 open：先读检测头再 seek 窗口，
//!   Range 解析留路由层——backend 收到已解析的 start/len 窗）；
//! - stat = 既有 metadata 语义（跟随 symlink；NotFound 错误分类）。
//!
//! HTTP 侧行为锁在 server/tests/tree_file.rs（零改动全绿为验收）。

use std::ffi::OsStr;
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use tokio::io::AsyncReadExt;

use vviewer_storage::{
    file_name_fidelity, natural_cmp, ByteStream, EntryKind, HttpTransport, HttpRequest,
    HttpResponse, LocalFs, MountCapabilities, RangeSpec, StorageBackend, StorageError,
    StorageErrorKind,
};

/// 与 server/tests/tree_file.rs fixture 同款形态（对齐锚定面）。
fn fixture(hidden: bool) -> (tempfile::TempDir, Arc<dyn StorageBackend>) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    std::fs::write(root.join("a2.txt"), b"two").unwrap();
    std::fs::write(root.join("a10.txt"), b"ten").unwrap();
    std::fs::write(root.join(".secret"), b"hidden-content").unwrap();
    std::fs::create_dir(root.join(".hdir")).unwrap();
    std::fs::create_dir(root.join("子目录")).unwrap();
    std::fs::write(root.join("子目录/内.txt"), "inner").unwrap();
    // 非法 UTF-8 名（BUG-48）：列出侧 %XX 保真、寻址侧字节直达
    std::fs::write(root.join(OsStr::from_bytes(b"bad\xff\xfename.txt")), b"bad").unwrap();
    std::fs::write(root.join("digits.bin"), b"0123456789").unwrap();
    let backend: Arc<dyn StorageBackend> = Arc::new(LocalFs::new(root.to_path_buf(), hidden));
    (dir, backend)
}

async fn drain(mut stream: ByteStream) -> Vec<u8> {
    let mut out = Vec::new();
    stream.read_to_end(&mut out).await.unwrap();
    out
}

// ---------- list_dir：与既有 tree 扫描输出对齐 ----------

#[tokio::test]
async fn list_dir_aligns_with_tree_scan_output() {
    let (_d, b) = fixture(false);
    let mut entries = b.list_dir(Path::new("")).await.unwrap();
    let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
    // 目录优先（目录间自然序），文件按自然序：'.'(0x2e) 最小、2 < 10、%XX 形态按字面参与排序
    assert_eq!(
        names,
        vec![
            ".hdir",
            "子目录",
            ".secret",
            "a2.txt",
            "a10.txt",
            "bad%FF%FEname.txt",
            "digits.bin",
        ]
    );
    // 条目形状：目录无 size；文件有 size + mtime（毫秒）
    let dir_entry = &entries[0];
    assert_eq!(dir_entry.kind, EntryKind::Dir);
    assert!(dir_entry.size.is_none());
    assert!(dir_entry.mtime.is_some());
    entries.sort_by(|a, b| a.name.cmp(&b.name));
    let a2 = entries.iter().find(|e| e.name == "a2.txt").unwrap();
    assert_eq!(a2.kind, EntryKind::File);
    assert_eq!(a2.size, Some(3));
    assert!(a2.mtime.is_some());
}

#[tokio::test]
async fn list_dir_hidden_filters_dot_entries() {
    let (_d, b) = fixture(true);
    let entries = b.list_dir(Path::new("")).await.unwrap();
    let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
    assert!(!names.iter().any(|n| n.starts_with('.')), "names={names:?}");
    assert!(names.contains(&"a2.txt"));
}

#[tokio::test]
async fn list_dir_relative_path_lists_subdirectory() {
    let (_d, b) = fixture(false);
    let entries = b.list_dir(Path::new("子目录")).await.unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].name, "内.txt");
    assert_eq!(entries[0].kind, EntryKind::File);
    assert_eq!(entries[0].size, Some(5)); // "inner" 字节数
}

#[tokio::test]
async fn list_dir_missing_dir_is_not_found() {
    let (_d, b) = fixture(false);
    let err = b.list_dir(Path::new("no-such-dir")).await.unwrap_err();
    assert_eq!(err.kind(), StorageErrorKind::NotFound);
}

#[tokio::test]
async fn list_dir_on_file_is_error() {
    let (_d, b) = fixture(false);
    // 既有路由先 stat 判 is_dir → 404 "not a directory"，list_dir 直指文件
    // 属防御位：ENOTDIR 报错（不指定类别，跨平台稳定的是「非 Ok」本身）
    assert!(b.list_dir(Path::new("a2.txt")).await.is_err());
}

// ---------- stat：与既有 metadata 语义对齐 ----------

#[tokio::test]
async fn stat_file_dir_and_missing() {
    let (_d, b) = fixture(true); // hidden=true：hidden 只过滤列出，不过滤寻址
    let f = b.stat(Path::new("a2.txt")).await.unwrap();
    assert_eq!(f.kind, EntryKind::File);
    assert_eq!(f.size, Some(3));
    assert!(f.mtime.is_some());

    let dir = b.stat(Path::new("子目录")).await.unwrap();
    assert_eq!(dir.kind, EntryKind::Dir);
    assert!(dir.size.is_none()); // 目录无 size（与 tree 输出形状一致）

    let dot = b.stat(Path::new(".secret")).await.unwrap();
    assert_eq!(dot.size, Some(14));

    let err = b.stat(Path::new("no-such.bin")).await.unwrap_err();
    assert_eq!(err.kind(), StorageErrorKind::NotFound);
}

#[tokio::test]
async fn stat_follows_symlink() {
    let (_d, b) = fixture(false);
    let link = _d.path().join("link.bin");
    std::os::unix::fs::symlink("digits.bin", &link).unwrap();
    let e = b.stat(Path::new("link.bin")).await.unwrap();
    assert_eq!(e.kind, EntryKind::File);
    assert_eq!(e.size, Some(10)); // 跟随 symlink 取目标 metadata
}

/// &Path 接缝字节保真（BUG-48 寻址侧）：非 UTF-8 名以原始字节 stat 成功。
/// 这是 trait 用 &Path 而非 &str 的锁测——&str 会在此丢失字节。
#[tokio::test]
async fn stat_carries_non_utf8_bytes_through_path_seam() {
    let (_d, b) = fixture(false);
    let raw: PathBuf = OsStr::from_bytes(b"bad\xff\xfename.txt").into();
    let e = b.stat(&raw).await.unwrap();
    assert_eq!(e.kind, EntryKind::File);
    assert_eq!(e.size, Some(3));
    // 列出侧保真名与寻址侧原始字节互为可寻址形态
    assert_eq!(file_name_fidelity(OsStr::from_bytes(b"bad\xff\xfename.txt")), "bad%FF%FEname.txt");
}

// ---------- read_range：与既有 file 读取形态对齐（单开：头→seek→窗） ----------

#[tokio::test]
async fn read_range_none_streams_whole_file_with_head() {
    let (_d, b) = fixture(false);
    let read = b.read_range(Path::new("digits.bin"), None, 8192).await.unwrap();
    assert_eq!(read.total_size, 10);
    assert_eq!(read.head, b"0123456789"); // 检测头 = 文件前缀
    assert_eq!(drain(read.stream).await, b"0123456789");
}

#[tokio::test]
async fn read_range_window_streams_exact_slice_and_keeps_head() {
    let (_d, b) = fixture(false);
    // 窗口语义 = 既有 parse_range 产物直接透传（Range 解析留路由层）：
    // bytes=2-5 → start 2 len 4
    let read = b
        .read_range(Path::new("digits.bin"), Some(RangeSpec { start: 2, len: 4 }), 8192)
        .await
        .unwrap();
    assert_eq!(read.total_size, 10);
    assert_eq!(read.head, b"0123456789"); // 头与窗无关：既有「先读头再 seek」单开形态
    assert_eq!(drain(read.stream).await, b"2345");
}

#[tokio::test]
async fn read_range_suffix_window() {
    let (_d, b) = fixture(false);
    // bytes=-3 → parse_range 产物 (7, 3)
    let read = b
        .read_range(Path::new("digits.bin"), Some(RangeSpec { start: 7, len: 3 }), 8192)
        .await
        .unwrap();
    assert_eq!(drain(read.stream).await, b"789");
}

#[tokio::test]
async fn read_range_head_capped_by_head_len() {
    let (_d, b) = fixture(false);
    let read = b.read_range(Path::new("digits.bin"), None, 4).await.unwrap();
    assert_eq!(read.head, b"0123"); // ≤8KB 窗口上限由调用方（检测采样窗）给
    assert_eq!(drain(read.stream).await, b"0123456789");
}

#[tokio::test]
async fn read_range_empty_file_full_read() {
    let (_d, b) = fixture(false);
    std::fs::write(_d.path().join("empty.txt"), b"").unwrap();
    let read = b.read_range(Path::new("empty.txt"), None, 8192).await.unwrap();
    assert_eq!(read.total_size, 0);
    assert!(read.head.is_empty());
    assert!(drain(read.stream).await.is_empty());
}

#[tokio::test]
async fn read_range_missing_file_is_not_found() {
    let (_d, b) = fixture(false);
    let err = b
        .read_range(Path::new("no-such.bin"), None, 8192)
        .await
        .unwrap_err();
    assert_eq!(err.kind(), StorageErrorKind::NotFound);
}

// ---------- 能力位与 trait 形状 ----------

#[tokio::test]
async fn localfs_capabilities_watch_and_search_true() {
    let (_d, b) = fixture(false);
    let caps: MountCapabilities = b.capabilities();
    assert!(caps.watch);
    assert!(caps.search);
}

/// HttpTransport 接缝编译锚：纯 HTTP 语义（method/url/headers/body →
/// status/headers/字节流），mock 实现可经 Arc<dyn> 调用。
#[tokio::test]
async fn http_transport_trait_is_dyn_dispatchable() {
    struct MockTransport;

    #[async_trait]
    impl HttpTransport for MockTransport {
        async fn execute(&self, req: HttpRequest) -> Result<HttpResponse, StorageError> {
            Ok(HttpResponse {
                status: 200,
                headers: vec![("x-echo-method".to_string(), req.method)],
                body: Box::pin(tokio::io::empty()),
            })
        }
    }

    let t: Arc<dyn HttpTransport> = Arc::new(MockTransport);
    let res = t
        .execute(HttpRequest {
            method: "GET".to_string(),
            url: "https://example.test/obj".to_string(),
            headers: vec![],
            body: None,
        })
        .await
        .unwrap();
    assert_eq!(res.status, 200);
    assert_eq!(res.headers[0].1, "GET");
}

// ---------- 下沉构件的既有语义锚 ----------

/// BUG-48 保真名：合法 UTF-8 原样、非法字节 %XX（与 tree 既有锁测同款断言）。
#[test]
fn fidelity_name_passes_utf8_and_encodes_invalid_bytes() {
    assert_eq!(file_name_fidelity(OsStr::new("ok.txt")), "ok.txt");
    assert_eq!(file_name_fidelity(OsStr::new("空格 名.txt")), "空格 名.txt");
    let raw = OsStr::from_bytes(b"bad\xff\xfename.txt");
    assert_eq!(file_name_fidelity(raw), "bad%FF%FEname.txt");
    let raw = OsStr::from_bytes(b"\xe4\xb8\xad\xff.txt");
    assert_eq!(file_name_fidelity(raw), "中%FF.txt");
}

/// 自然序锚：数字段按数值比较；数值相等时前导零多者在前。
#[test]
fn natural_cmp_digit_segments_compare_numerically() {
    use std::cmp::Ordering;
    assert_eq!(natural_cmp("a2.txt", "a10.txt"), Ordering::Less);
    assert_eq!(natural_cmp("a10.txt", "a2.txt"), Ordering::Greater);
    assert_eq!(natural_cmp("a2.txt", "a2.txt"), Ordering::Equal);
    assert_eq!(natural_cmp("a02", "a2"), Ordering::Greater); // 数值相等时前导零多者在后（保持确定性）
    assert_eq!(natural_cmp("中文", "digits"), Ordering::Greater); // 字节序
}

/// 错误类型：Display/Error 形态（server 侧 From<StorageError> for AppError 的输入）。
#[test]
fn storage_error_display_and_kind() {
    let e = StorageError::not_found("not found");
    assert_eq!(e.kind(), StorageErrorKind::NotFound);
    // 编译期锚：实现 std::error::Error（可被 ?/From 链消费）
    let _: &dyn std::error::Error = &e;
    assert!(e.to_string().contains("not found"));
}
