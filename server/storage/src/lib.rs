//! vviewer-storage：存储抽象 crate（目录挂载阶段一，plan 2026-10-19 Task 2）。
//!
//! [`StorageBackend`] 是所有存储后端的统一接缝：fs 根下沉的 [`LocalFs`] 与
//! 后续 S3/WebDAV 挂载后端（Task 3/4）共用同一 trait，路由层按根分发。
//! [`HttpTransport`] 是多端发布（wasm 复用）预留的纯 HTTP 接缝：native
//! reqwest 实现在 Task 3，本 crate 只立形。
//!
//! ## 接缝约定
//! - trait 方法路径参数为**后端根下的相对路径**（[`Path`] 载体，保留非 UTF-8
//!   字节——BUG-48 寻址链要求字节保真，`&str` 会丢字节）；
//! - Range 解析（HTTP 头语义）留路由层，backend 收到已解析的
//!   [`RangeSpec`]`{start, len}` 窗；416/多区间/If-Range 等 HTTP 语义不进本 crate；
//! - 只读：trait 无任何写路径（Global Constraints）；能力位
//!   [`MountCapabilities`]`{ watch, search }` 仅 LocalFs 为 true；
//! - **HttpTransport 不得让 tokio/hyper 类型穿过接口**（纯 HTTP 语义，wasm
//!   复用前提）：body 载体为 [`HttpByteStream`] = `futures-io::AsyncRead`
//!   trait 对象（futures-io 无运行时依赖，wasm 可用）；[`StorageBackend`]
//!   的 `ByteStream`（tokio 侧，native-only）不在此约束内。两态互转桥在
//!   Task 3（S3 经 tokio-util compat 从 transport body 构造 backend 流）。

use std::cmp::Ordering;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::time::UNIX_EPOCH;

use async_trait::async_trait;
use futures_io::AsyncRead as FuturesAsyncRead;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncSeekExt};

/// [`StorageBackend`] 产出的字节流（native-only，tokio 生态内消费——axum
/// Body 直接受 tokio AsyncRead）。
pub type ByteStream = Pin<Box<dyn AsyncRead + Send>>;

/// [`HttpTransport`] 接缝的 body 载体：wasm 可用的 futures-io trait 对象
/// （评审 Major-1：tokio::io 类型不得穿 HttpTransport 接缝——tokio::io 在
/// wasm 不可用；futures-io 为纯 trait 定义，无运行时/平台依赖）。
pub type HttpByteStream = Pin<Box<dyn FuturesAsyncRead + Send>>;

// ---------- 错误 ----------

/// 存储错误类别：server 侧映射 HTTP 状态（NotFound → 404，其余 → 500），
/// 与既有 `From<io::Error> for AppError` 分类一致。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StorageErrorKind {
    NotFound,
    Other,
}

/// 存储层错误：类别 + 原始消息（io 错误文本原样透传，500 响应文本不漂移）。
#[derive(Debug, Clone)]
pub struct StorageError {
    kind: StorageErrorKind,
    message: String,
}

impl StorageError {
    pub fn not_found(what: impl Into<String>) -> Self {
        Self { kind: StorageErrorKind::NotFound, message: what.into() }
    }

    pub fn other(message: impl Into<String>) -> Self {
        Self { kind: StorageErrorKind::Other, message: message.into() }
    }

    /// io 错误统一映射（与既有 AppError::from(io::Error) 同款分类）：
    /// NotFound → NotFound；其余错误文本原样保留。
    pub(crate) fn from_io(e: std::io::Error) -> Self {
        match e.kind() {
            std::io::ErrorKind::NotFound => Self::not_found("not found"),
            _ => Self::other(e.to_string()),
        }
    }

    pub fn kind(&self) -> StorageErrorKind {
        self.kind
    }

    pub fn message(&self) -> &str {
        &self.message
    }
}

impl std::fmt::Display for StorageError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.kind.as_str(), self.message)
    }
}

impl std::error::Error for StorageError {}

impl StorageErrorKind {
    fn as_str(self) -> &'static str {
        match self {
            StorageErrorKind::NotFound => "not found",
            StorageErrorKind::Other => "storage error",
        }
    }
}

// ---------- 数据类型 ----------

/// 条目类别。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EntryKind {
    Dir,
    File,
}

/// 目录条目（list_dir 列出与 stat 单点查询共用形态）：
/// 目录 `size` 为 None；`mtime` 为 epoch 起毫秒（不可得时 None）。
#[derive(Debug, Clone)]
pub struct Entry {
    /// 保真名（合法 UTF-8 原样；非法字节按 `%XX` 编码，见 [`file_name_fidelity`]）。
    pub name: String,
    pub kind: EntryKind,
    pub size: Option<u64>,
    pub mtime: Option<u64>,
}

/// 能力位（Global Constraints）：仅 LocalFs 两项为 true；远端后端按实测降级。
#[derive(Debug, Clone, Copy)]
pub struct MountCapabilities {
    pub watch: bool,
    pub search: bool,
}

/// 逻辑读取窗（路由层 Range 解析的产物）：从 `start` 起读 `len` 字节。
/// 后端信任窗在 total_size 内（既有路由 parse_range 已做钳制与 416 判定）。
#[derive(Debug, Clone, Copy)]
pub struct RangeSpec {
    pub start: u64,
    pub len: u64,
}

/// 一次读取的产物：总量 + 检测头 + 已定位到窗起点的字节流。
///
/// `head` 与 `stream` 来自**同一次打开**（既有 file handler 单开形态：先读
/// ≤head_len 字节做编码采样，再 seek 回窗起点流式读）——拆成两次打开会在
/// 「头与体来自不同文件状态」处引入既有行为没有的竞态。
pub struct FileRead {
    pub total_size: u64,
    /// 文件前缀（≤请求的 head_len；编码检测采样窗）。
    pub head: Vec<u8>,
    /// 已定位到窗起点、已按窗长 take 的字节流（调用方直接包装为响应体）。
    pub stream: ByteStream,
}

impl std::fmt::Debug for FileRead {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FileRead")
            .field("total_size", &self.total_size)
            .field("head", &self.head)
            .field("stream", &"ByteStream(..)")
            .finish()
    }
}

// ---------- 核心接缝 ----------

/// 存储后端统一接缝（只读）。
///
/// 路径参数为后端根下的相对路径；空路径即根自身。dyn 分发
/// （`Arc<dyn StorageBackend>`）要求 async 方法经 `#[async_trait]` 装箱
/// （RPITIT 形态无法 dyn）。
#[async_trait]
pub trait StorageBackend: Send + Sync {
    /// 单层目录列表：条目顺序与过滤由后端语义决定（LocalFs = 目录优先 +
    /// 自然序 + hidden 过滤，与既有 /api/tree 扫描输出对齐）。
    async fn list_dir(&self, path: &Path) -> Result<Vec<Entry>, StorageError>;

    /// 读取文件（可选窗）：单次打开，返回总量、检测头与已定位字节流。
    async fn read_range(
        &self,
        path: &Path,
        range: Option<RangeSpec>,
        head_len: usize,
    ) -> Result<FileRead, StorageError>;

    /// 单点元数据查询（跟随 symlink）。
    async fn stat(&self, path: &Path) -> Result<Entry, StorageError>;

    /// 能力宣告（watch/search；LocalFs 恒 true）。
    fn capabilities(&self) -> MountCapabilities;
}

/// 纯 HTTP 语义接缝（多端发布 spec 的 wasm 复用前提）：
/// method/url/headers/body → status/headers/字节流。native reqwest 实现
/// 在 Task 3（transport.rs）；**不得让 tokio/hyper 类型穿过本接口**。
#[async_trait]
pub trait HttpTransport: Send + Sync {
    async fn execute(&self, req: HttpRequest) -> Result<HttpResponse, StorageError>;
}

/// HTTP 请求描述（纯 HTTP 语义；method 为 "GET"/"PROPFIND" 等谓词字面）。
#[derive(Debug, Clone)]
pub struct HttpRequest {
    pub method: String,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<Vec<u8>>,
}

/// HTTP 响应描述（body 为 [`HttpByteStream`]——futures-io 载体，头按出现序保留）。
pub struct HttpResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: HttpByteStream,
}

/// 接缝类型形状的编译级锚（评审 Major-1）：HttpRequest/HttpResponse 可安全
/// Send 转移，body 字段载体钉死为 [`HttpByteStream`]（futures-io trait 对象）。
/// 若有人把 body 换回 tokio 类型，最后的 fn 签名断言即编译失败——tokio
/// AsyncRead 载体与 futures-io 载体非同一类型。
#[cfg(test)]
const _: () = {
    const fn assert_send_static<T: Send + 'static>() {}
    const fn assert_unpin<T: Unpin>() {}
    assert_send_static::<HttpRequest>();
    assert_send_static::<HttpResponse>();
    assert_send_static::<HttpByteStream>();
    assert_unpin::<HttpByteStream>();
};

impl std::fmt::Debug for HttpResponse {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HttpResponse")
            .field("status", &self.status)
            .field("headers", &self.headers)
            .field("body", &"HttpByteStream(..)")
            .finish()
    }
}

// ---------- 名称保真（自 routes/tree.rs 下沉，BUG-48 列出侧） ----------

/// 文件名保真转换（BUG-48）：合法 UTF-8 名原样返回；含非法字节的名把非法
/// 字节 percent-encode 为 `%XX`（合法段原样），产出「可列出且可寻址」的可逆
/// 形态。此前 `to_string_lossy` 把非法字节替换为 U+FFFD——替换名与磁盘真实
/// 字节不匹配，该文件一旦被列出便无法经任何 HTTP 路径寻址（guard 侧配套
/// `%XX` 解码回退仍在 server crate guard.rs）。
pub fn file_name_fidelity(name: &OsStr) -> String {
    match std::str::from_utf8(name.as_encoded_bytes()) {
        Ok(s) => s.to_string(),
        Err(_) => encode_invalid_utf8(name.as_encoded_bytes()),
    }
}

/// 非法 UTF-8 字节序列的 percent-encode：`std::str::from_utf8` 逐段校验，
/// 合法段原样拼接、错误处按 `error_len`（None = 不完整尾部，取剩余全部）
/// 逐字节 `%XX`。与 guard 的解码回退互为逆变换。
fn encode_invalid_utf8(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() + 8);
    let mut rest = bytes;
    loop {
        match std::str::from_utf8(rest) {
            Ok(s) => {
                out.push_str(s);
                return out;
            }
            Err(e) => {
                let valid = e.valid_up_to();
                // valid_up_to 保证前缀合法；unwrap 只在切片越界时不可能发生
                out.push_str(std::str::from_utf8(&rest[..valid]).unwrap_or(""));
                let bad = e.error_len().unwrap_or(rest.len() - valid);
                for b in &rest[valid..valid + bad] {
                    out.push_str(&format!("%{b:02X}"));
                }
                rest = &rest[valid + bad..];
            }
        }
    }
}

/// 自然排序比较（自 routes/tree.rs 下沉）：数字段按数值比较（a2 < a10），
/// 其余按字节比较（UTF-8 字节序即码点序，非 ASCII 名字稳定）。
pub fn natural_cmp(a: &str, b: &str) -> Ordering {
    let (mut ab, mut bb) = (a.as_bytes(), b.as_bytes());
    loop {
        match (ab.first(), bb.first()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(&x), Some(&y)) => {
                if x.is_ascii_digit() && y.is_ascii_digit() {
                    let (a_digits, a_rest) = split_digits(ab);
                    let (b_digits, b_rest) = split_digits(bb);
                    // 去前导零后：先比长度再比字典序 == 数值比较
                    let at = strip_leading_zeros(a_digits);
                    let bt = strip_leading_zeros(b_digits);
                    match at.len().cmp(&bt.len()).then_with(|| at.cmp(bt)) {
                        Ordering::Equal => {
                            // 数值相等时前导零多者在前（保持确定性）
                            let zeros = a_digits.len().cmp(&b_digits.len());
                            if zeros != Ordering::Equal {
                                return zeros;
                            }
                            ab = a_rest;
                            bb = b_rest;
                        }
                        ord => return ord,
                    }
                } else {
                    match x.cmp(&y) {
                        Ordering::Equal => {
                            ab = &ab[1..];
                            bb = &bb[1..];
                        }
                        ord => return ord,
                    }
                }
            }
        }
    }
}

fn split_digits(b: &[u8]) -> (&[u8], &[u8]) {
    let end = b.iter().position(|c| !c.is_ascii_digit()).unwrap_or(b.len());
    (&b[..end], &b[end..])
}

fn strip_leading_zeros(d: &[u8]) -> &[u8] {
    let first_non_zero = d.iter().position(|&c| c != b'0').unwrap_or(d.len());
    &d[first_non_zero..]
}

// ---------- LocalFs（自 routes/tree.rs、routes/file.rs 下沉） ----------

/// 本地文件系统后端：fs 根（阶段一唯一的 fs 形态根）。
///
/// `root` 取构造时的 canonical 根（guard canonicalize 失败回退原路径时同款）；
/// 路由层把 guard 解析出的 canonical 绝对路径按根 strip 成相对路径后传入，
/// 本后端 join 回根——**实际触达的绝对路径与下沉前逐字节一致**。
pub struct LocalFs {
    root: PathBuf,
    /// `--hidden`：列出时过滤 dot 开头条目（寻址/读取不过滤，与既有语义一致）。
    hidden: bool,
}

impl LocalFs {
    pub fn new(root: PathBuf, hidden: bool) -> Self {
        Self { root, hidden }
    }

    /// 相对路径 join 回根（空路径 = 根自身）。
    fn resolve(&self, path: &Path) -> PathBuf {
        self.root.join(path)
    }

    /// 读文件头 ≤head_len（循环填满，容忍短读）——自 routes/file.rs read_head
    /// 原样搬运（cap 参数化：8KB 采样窗由调用方传入）。
    async fn read_head(f: &mut tokio::fs::File, cap: usize) -> Vec<u8> {
        let mut buf = vec![0u8; cap];
        let mut filled = 0;
        while filled < buf.len() {
            match f.read(&mut buf[filled..]).await {
                Ok(0) => break,
                Ok(n) => filled += n,
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }
        buf.truncate(filled);
        buf
    }

    /// mtime → epoch 起毫秒（不可得时 None）。
    fn mtime_millis(md: &std::fs::Metadata) -> Option<u64> {
        md.modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
    }
}

#[async_trait]
impl StorageBackend for LocalFs {
    /// 单层目录列表——自 routes/tree.rs 扫描循环原样搬运：
    /// 保真名、hidden 过滤、跟随 symlink 取目标 metadata、竞态删除跳过、
    /// 目录优先 + 自然排序。
    async fn list_dir(&self, path: &Path) -> Result<Vec<Entry>, StorageError> {
        let dir = self.resolve(path);
        let mut rd = tokio::fs::read_dir(&dir).await.map_err(StorageError::from_io)?;
        let mut entries: Vec<Entry> = Vec::new();
        while let Some(e) = rd.next_entry().await.map_err(StorageError::from_io)? {
            let name = file_name_fidelity(e.file_name().as_os_str());
            if self.hidden && name.starts_with('.') {
                continue;
            }
            // 跟随 symlink 取目标 metadata：symlink 目录按 dir 呈现（进入时仍有 canonicalize 守卫）
            let md = match tokio::fs::metadata(e.path()).await {
                Ok(md) => md,
                Err(_) => continue, // 竞态删除等瞬时错误：跳过该条目
            };
            let mtime = Self::mtime_millis(&md);
            let (kind, size) = if md.is_dir() {
                (EntryKind::Dir, None)
            } else {
                (EntryKind::File, Some(md.len()))
            };
            entries.push(Entry { name, kind, size, mtime });
        }

        entries.sort_by(|a, b| {
            let rank = |e: &Entry| if matches!(e.kind, EntryKind::Dir) { 0u8 } else { 1 };
            rank(a).cmp(&rank(b)).then_with(|| natural_cmp(&a.name, &b.name))
        });

        Ok(entries)
    }

    /// 文件读取——自 routes/file.rs 读取段原样搬运（单开：读头 → seek → take）：
    /// 头供编码检测采样；Range 解析留路由层，此处只按已解析窗定位。
    async fn read_range(
        &self,
        path: &Path,
        range: Option<RangeSpec>,
        head_len: usize,
    ) -> Result<FileRead, StorageError> {
        let full = self.resolve(path);
        let mut f = tokio::fs::File::open(&full).await.map_err(StorageError::from_io)?;
        let head = Self::read_head(&mut f, head_len).await;

        // 总量：与既有 handler 的 metadata 形态一致（读头后 seek 前取，静态文件恒定；
        // None 窗时 take 需要它兜底全量长度）
        let meta = tokio::fs::metadata(&full).await.map_err(StorageError::from_io)?;
        let total_size = meta.len();

        let (start, len) = match range {
            Some(r) => (r.start, r.len),
            None => (0, total_size),
        };

        // 读 head 消耗了读取位置（小文件可能已读空），统一回到响应起点
        f.seek(std::io::SeekFrom::Start(start))
            .await
            .map_err(StorageError::from_io)?;
        let stream: ByteStream = Box::pin(f.take(len));

        Ok(FileRead { total_size, head, stream })
    }

    /// 单点元数据（跟随 symlink）——语义与既有 `tokio::fs::metadata` 直读一致。
    async fn stat(&self, path: &Path) -> Result<Entry, StorageError> {
        let full = self.resolve(path);
        let md = tokio::fs::metadata(&full).await.map_err(StorageError::from_io)?;
        let mtime = Self::mtime_millis(&md);
        let (kind, size) = if md.is_dir() {
            (EntryKind::Dir, None)
        } else {
            (EntryKind::File, Some(md.len()))
        };
        let name = full
            .file_name()
            .map(file_name_fidelity)
            .unwrap_or_default();
        Ok(Entry { name, kind, size, mtime })
    }

    fn capabilities(&self) -> MountCapabilities {
        MountCapabilities { watch: true, search: true }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// join 空相对路径 = 根自身（list_dir(Path::new("")) 的寻址前提）。
    #[test]
    fn resolve_empty_relative_path_yields_root() {
        let fs = LocalFs::new(PathBuf::from("/tmp/root"), false);
        let joined = fs.resolve(Path::new(""));
        assert!(joined.starts_with("/tmp/root"), "joined={joined:?}");
        // 文件系统语义下根自身与其尾斜杠形态等价
        assert_eq!(joined, PathBuf::from("/tmp/root").join(""));
    }

    /// resolve 拼接：相对段逐段 join，实际触达路径 = 下沉前路由直读的绝对路径。
    #[test]
    fn resolve_joins_relative_segments_under_root() {
        let fs = LocalFs::new(PathBuf::from("/tmp/root"), false);
        assert_eq!(fs.resolve(Path::new("a/b.txt")), PathBuf::from("/tmp/root/a/b.txt"));
    }
}
