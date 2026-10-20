//! WebDAV 后端（Task 4）：PROPFIND Depth:1 multistatus 轻解析 + GET 读取 +
//! Range 防线降级（spec §2）。
//!
//! ## 版本耦合注记（svgbob 教训）
//! multistatus 按 RFC 4918 §14.16 的**字面结构**解析：只认
//! `<{p}response><{p}href>…</{p}href>` 与 prop 内的 `<{p}resourcetype>`（含
//! `<{p}collection/>`）/`<{p}getcontentlength>`/`<{p}getlastmodified>`，`p`
//! 为任意命名空间前缀（含空）——`d:`/`D:` 双形态是 dav 服务器世界的常见
//! 两态，任意自定义前缀（`md:`）有独立样本锚（tests/webdav.rs 格式样本锚）；
//! 不做通用 XML 解析（不引解析器）。
//! 上游若改结构（tag 改名/嵌套变形），先改样本再改解析。
//!
//! ## Range 防线（spec §2——与 S3 的 206 拒绝语义不同源）
//! WebDAV 服务器不可控：窗 GET 的响应 Content-Range/Content-Length 与请求
//! 窗**不符**（无 Content-Range、窗段错位、长度>窗）时不报错，而是把该
//! 挂载标记 `rangeCapable=false`（[`WebDavBackend::range_capable`]，interior
//! [`AtomicBool`]——探测只能发生在运行期首次窗读取，构造期探测需额外往返
//! 且盖不住服务器行为漂移）并**降级**：从实际响应体（通常为被无视 Range 的
//! 全量）中切出请求窗返回；前端据此走 io-streaming 既有全量切片通道。
//!
//! ## Basic auth
//! 凭据以 `Authorization: Basic base64(user:pass)` 预先附带于全部请求
//!（dav 服务器普遍接受 preemptive basic，省 401 challenge 往返）。base64
//! 为模块内手写实现（零新依赖，RFC 4648 向量锚定）。
//!
//! ## 共享助手
//! HTTP-date 解析/XML 实体反转义/compat 桥等纯文本小助手复用 s3 模块的
//! `pub(crate)` 实现（Task 3 落点，扩散最小）；WebDAV 侧 URL path 编码集
//! 与 S3 key 编码集同构但独立声明（两协议语义解耦，防单边改动串扰）。

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use async_trait::async_trait;
use percent_encoding::{percent_decode_str, utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};
use tokio::io::AsyncReadExt;

use crate::s3::{
    dir_entry, header_value, into_tokio, normalize_prefix, parse_http_date_millis, read_up_to,
    xml_unescape,
};
use crate::transport::HttpRequest;
use crate::{
    sort_entries_dirs_first, ByteStream, Entry, EntryKind, FileRead, HttpTransport,
    MountCapabilities, RangeSpec, StorageBackend, StorageError,
};

/// 错误响应体采样上界（排障片段，与 s3 同款）。
const ERROR_BODY_SNIPPET: usize = 512;

/// PROPFIND 请求体：显式索取列表/读取所需三属性（多数服务器对空 body 走
/// allprop，显式 prop 面更小、兼容面更稳）。
const PROPFIND_BODY: &str = r#"<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getlastmodified/></d:prop></d:propfind>"#;

// ---------- 配置与凭证 ----------

/// WebDAV 挂载配置（server 侧 config.rs 的 MountConfig 由 Task 5 装配映射；
/// storage crate 不反向依赖 server）。Debug 手工实现：凭证字段脱敏
///（Task 3 评审 Major-1 必守先例——启动日志 Debug 打印配置为常见形态）。
#[derive(Clone)]
pub struct WebDavMountConfig {
    /// 形如 `https://dav.example.com/dav`（尾 '/' 容忍，new 内规范化）；
    /// dav 服务器的路径段（如 Nextcloud 的 remote.php/dav/files/user）随
    /// endpoint 携带。
    pub endpoint: String,
    /// 挂载子路径：空串=endpoint 根；非空规范化为 `xxx/`（同 S3 语义）。
    pub prefix: String,
    pub username: String,
    pub password: String,
}

impl std::fmt::Debug for WebDavMountConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WebDavMountConfig")
            .field("endpoint", &self.endpoint)
            .field("prefix", &self.prefix)
            .field("username", &"[redacted]")
            .field("password", &"[redacted]")
            .finish()
    }
}

/// Basic auth 凭证（Debug 手工实现，双字段均脱敏——同 S3Credentials 先例）。
/// **模块私有**（台账②：无外部消费面——`WebDavBackend::new` 从 cfg 字段面构造，
/// 集成测试只经 `WebDavMountConfig`；`pub` 会把凭据载体扩成 crate 外可触达面）。
/// S3 侧 `S3Credentials` 因进入 `sign_request` 的 pub 纯函数签名而必须 pub，
/// 两处不对称是有意的。
#[derive(Clone)]
struct WebDavCredentials {
    username: String,
    password: String,
}

impl std::fmt::Debug for WebDavCredentials {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WebDavCredentials")
            .field("username", &"[redacted]")
            .field("password", &"[redacted]")
            .finish()
    }
}

// ---------- Basic auth（手写 base64，零新依赖） ----------

const B64_ALPHABET: &[u8; 64] =
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// RFC 4648 标准 base64（含 padding），向量锚见模块单测。
fn base64_encode(data: &[u8]) -> String {
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = chunk.get(1).copied().unwrap_or(0) as u32;
        let b2 = chunk.get(2).copied().unwrap_or(0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(B64_ALPHABET[(n >> 18) as usize & 63] as char);
        out.push(B64_ALPHABET[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { B64_ALPHABET[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { B64_ALPHABET[n as usize & 63] as char } else { '=' });
    }
    out
}

/// `Authorization` 头值：`Basic base64(user:pass)`。
fn basic_auth(creds: &WebDavCredentials) -> String {
    format!(
        "Basic {}",
        base64_encode(format!("{}:{}", creds.username, creds.password).as_bytes())
    )
}

// ---------- multistatus 字面结构解析（版本耦合，见模块注） ----------

/// 单个 `<response>` 的原始字段（href 为原文，消费侧反转义+解码）。
struct DavRawEntry {
    href: String,
    is_collection: bool,
    size: Option<u64>,
    mtime: Option<u64>,
}

/// 在 `xml` 中寻找开标签 `<[prefix:]local…>`（标签名后界须为 '>'/' '/'/'，
/// 排除 `<responseXYZ>` 前缀碰撞），返回（'<' 位置，'>' 之后位置，前缀含
/// ':' 或空）。逐 '<' 扫描安全：合法 XML 文本域的 '<' 均已转义，注释/CDATA
///（`<!--`/`<![CDATA[`）的名字解析不匹配 local 即跳过。
fn open_tag<'a>(xml: &'a str, local: &str) -> Option<(usize, usize, &'a str)> {
    let bytes = xml.as_bytes();
    for i in 0..bytes.len() {
        if bytes[i] != b'<' {
            continue;
        }
        let name_start = i + 1;
        let mut j = name_start;
        while j < bytes.len()
            && (bytes[j].is_ascii_alphanumeric() || matches!(bytes[j], b'-' | b'.' | b'_' | b':'))
        {
            j += 1;
        }
        if j >= bytes.len() || !matches!(bytes[j], b'>' | b' ' | b'/') {
            continue;
        }
        let name = &xml[name_start..j];
        let (prefix, matched) = match name.split_once(':') {
            Some((p, l)) => (&name[..p.len() + 1], l == local),
            None => ("", name == local),
        };
        if !matched {
            continue;
        }
        let end = xml[j..].find('>')? + j + 1;
        return Some((i, end, prefix));
    }
    None
}

/// 顺序提取所有 `<[p:]local>…</[p:]local>` 块（每块前缀独立识别；无嵌套
/// 假设——multistatus 的 response 块平铺，与 s3 的 blocks 同形态）。
/// 返回（块内容，前缀）。
fn blocks<'a>(xml: &'a str, local: &str) -> Vec<(&'a str, &'a str)> {
    let mut out = Vec::new();
    let mut rest = xml;
    while let Some((_, end, prefix)) = open_tag(rest, local) {
        let close = format!("</{prefix}{local}>");
        match rest[end..].find(&close) {
            Some(e) => {
                out.push((&rest[end..end + e], prefix));
                rest = &rest[end + e + close.len()..];
            }
            None => break, // 截断块：按字面契约视为终止
        }
    }
    out
}

/// 文本内首个 `<[p:]tag>…</[p:]tag>` 内容；自闭合 `<[p:]tag/>` 返回空串。
fn inner<'a>(xml: &'a str, local: &str) -> Option<&'a str> {
    let (start, end, prefix) = open_tag(xml, local)?;
    if xml[start..end].ends_with("/>") {
        return Some("");
    }
    let close = format!("</{prefix}{local}>");
    let e = xml[end..].find(&close)? + end;
    Some(&xml[end..e])
}

/// multistatus → 原始条目。集合判定 = resourcetype 含 `<…collection…>`
///（RFC 4918 §15.2）；href 缺失按空串（消费侧按空名跳过）。mtime 走共享
/// HTTP-date 解析（getlastmodified）。
fn parse_multistatus(xml: &str) -> Vec<DavRawEntry> {
    blocks(xml, "response")
        .into_iter()
        .map(|(block, _)| DavRawEntry {
            href: inner(block, "href").unwrap_or_default().to_owned(),
            is_collection: inner(block, "resourcetype")
                .map(|rt| open_tag(rt, "collection").is_some())
                .unwrap_or(false),
            size: inner(block, "getcontentlength").and_then(|s| s.trim().parse().ok()),
            mtime: inner(block, "getlastmodified").and_then(parse_http_date_millis),
        })
        .collect()
}

// ---------- href/url 工具 ----------

/// href 反转义 + percent 解码（先 XML 实体后 %XX——服务端编码顺序的逆）；
/// 非法 UTF-8 损失性转换（病态输入）。
fn decode_href(href: &str) -> String {
    percent_decode_str(&xml_unescape(href)).decode_utf8_lossy().into_owned()
}

/// 绝对 URI href → path 部分（`http://h/p` → `/p`）；其余原样。
fn normalize_href(href: &str) -> &str {
    match href.split_once("://") {
        Some((_, rest)) => rest.find('/').map(|i| &rest[i..]).unwrap_or("/"),
        None => href,
    }
}

/// Depth:1 的首个 response 是集合自身——跳过判定：绝对 path/URI 形态与请求
/// path 全等（尾斜杠不敏感）；相对引用形态（RFC 4918 允许，罕见）退化为与
/// 请求 path 末段全等（绝对形态的嵌套同名子目录走全等分支，不误判）。
fn is_self(href: &str, req_path: &str) -> bool {
    let h = normalize_href(href).trim_end_matches('/');
    let r = req_path.trim_end_matches('/');
    match h.strip_prefix('/') {
        Some(h) => h == r.trim_start_matches('/'),
        None => !r.is_empty() && h == r.rsplit('/').next().unwrap_or(""),
    }
}

/// 请求 URL 的 path 部分（自集合比较用）。
fn url_path(url: &str) -> &str {
    let rest = url.split("://").nth(1).unwrap_or(url);
    match rest.find('/') {
        Some(i) => &rest[i..],
        None => "/",
    }
}

/// WebDAV URL path 段编码集：unreserved（A-Za-z0-9-._）之外全编码、'/' 保留
/// 为分隔（与 s3 的 key 段编码同构）；纯编码不做 decode 归一（同 s3 评审
/// Minor-1 口径：字面 '%XX' 的段编码 '%'→%25，归一会指向错误资源）。
const URI_SET: &AsciiSet = &NON_ALPHANUMERIC.remove(b'-').remove(b'.').remove(b'_').remove(b'/');

/// path 逐段编码（'/' 作分隔保留）。
fn encode_path(path: &str) -> String {
    path.split('/')
        .map(|seg| utf8_percent_encode(seg, URI_SET).to_string())
        .collect::<Vec<_>>()
        .join("/")
}

// ---------- 响应侧助手 ----------

/// 非 2xx → [`StorageError`]：404→NotFound、401→认证失败语义（Other 类别
/// ——StorageErrorKind 无独立认证档，消息携带 401 与 auth 字样）、403→
/// forbidden、5xx→server error、其余→Other；错误体采样 ≤512B 入消息。
async fn ensure_status(
    resp: crate::transport::HttpResponse,
) -> Result<crate::transport::HttpResponse, StorageError> {
    if (200..300).contains(&resp.status) {
        return Ok(resp);
    }
    let status = resp.status;
    let mut body = into_tokio(resp.body);
    let snippet =
        String::from_utf8_lossy(&read_up_to(&mut body, ERROR_BODY_SNIPPET).await).into_owned();
    match status {
        404 => Err(StorageError::not_found(format!("webdav: http 404 {snippet}"))),
        401 => Err(StorageError::other(format!(
            "webdav: http 401 authentication failed (check username/password) {snippet}"
        ))),
        403 => Err(StorageError::other(format!("webdav: http 403 forbidden {snippet}"))),
        n if n >= 500 => {
            Err(StorageError::other(format!("webdav: http {n} server error {snippet}")))
        }
        n => Err(StorageError::other(format!("webdav: http {n} {snippet}"))),
    }
}

/// multistatus 响应体读取（PROPFIND；207 预期，2xx 兼容）。
async fn read_body(resp: crate::transport::HttpResponse) -> Result<String, StorageError> {
    let mut body = into_tokio(resp.body);
    let mut bytes = Vec::new();
    body.read_to_end(&mut bytes)
        .await
        .map_err(|e| StorageError::other(format!("webdav body: {e}")))?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// total_size：206 → Content-Range 尾段总长优先（'*' 不可得时退
/// Content-Length）；200（含 Range 被无视形态）→ Content-Length 优先（体为
/// 全量）、Content-Range 兜底。
fn total_size_of(resp: &crate::transport::HttpResponse) -> Result<u64, StorageError> {
    let cr_total = header_value(resp, "content-range")
        .and_then(|cr| cr.rsplit('/').next())
        .and_then(|t| t.trim().parse::<u64>().ok());
    let content_length =
        header_value(resp, "content-length").and_then(|v| v.trim().parse::<u64>().ok());
    let total = if resp.status == 206 {
        cr_total.or(content_length)
    } else {
        content_length.or(cr_total)
    };
    total.ok_or_else(|| StorageError::other("webdav: response missing content-length/content-range"))
}

/// Range 防线判定（spec §2 口径——校验响应的 content-range/长度与请求窗
/// 一致）：无 Content-Range、窗段与 {start..start+len-1} 错位、或响应长度
/// >请求窗 → false（降级）。无 Content-Length 的 chunked 形态放过（窗长由
/// take 兜底）。
fn window_honored(resp: &crate::transport::HttpResponse, start: u64, len: u64) -> bool {
    let Some(cr) = header_value(resp, "content-range") else {
        return false; // 无 Content-Range（含 Range 被无视的 200 形态）
    };
    let Some((range_part, _)) = cr.trim().split_once('/') else {
        return false;
    };
    let range_part = range_part
        .trim()
        .strip_prefix("bytes")
        .unwrap_or(range_part.trim())
        .trim_start_matches([' ', '=']);
    let Some((a, b)) = range_part.split_once('-') else {
        return false;
    };
    let (Ok(a), Ok(b)) = (a.trim().parse::<u64>(), b.trim().parse::<u64>()) else {
        return false;
    };
    if a != start || b != start + len - 1 {
        return false; // 窗段错位
    }
    header_value(resp, "content-length")
        .and_then(|v| v.trim().parse::<u64>().ok())
        .map(|cl| cl <= len)
        .unwrap_or(true) // 响应长度>请求窗 → 不符
}

/// 丢弃 n 字节（Range 防线降级：全量体切窗时跳到窗起点）。EOF/错误即止。
async fn skip_bytes<R: tokio::io::AsyncRead + Unpin>(r: &mut R, mut n: u64) {
    let mut scratch = [0u8; 8192];
    while n > 0 {
        let want = scratch.len().min(n as usize);
        match r.read(&mut scratch[..want]).await {
            Ok(0) => break,
            Ok(k) => n -= k as u64,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
    }
}

// ---------- WebDAV 后端 ----------

/// WebDAV 只读后端：PROPFIND Depth:1 列目录 / Depth:0 stat / GET（带 Range
/// 防线）读文件。经 [`crate::HttpTransport`] 发请求（native =
/// ReqwestTransport，测试 = MockTransport）。
pub struct WebDavBackend {
    endpoint: String, // 无尾 '/'
    prefix: String,   // "" 或 "xxx/"
    creds: WebDavCredentials,
    http: Arc<dyn HttpTransport>,
    /// Range 防线降级标记（spec §2）：true=实测窗请求被遵从；发现不符即置
    /// false（一旦降级恒降级——阶段一无重探机制，见模块注）。
    range_capable: AtomicBool,
}

impl WebDavBackend {
    pub fn new(cfg: WebDavMountConfig, http: Arc<dyn HttpTransport>) -> Self {
        Self {
            endpoint: cfg.endpoint.trim_end_matches('/').to_owned(),
            prefix: normalize_prefix(&cfg.prefix),
            creds: WebDavCredentials { username: cfg.username, password: cfg.password },
            http,
            range_capable: AtomicBool::new(true),
        }
    }

    /// Range 防线降级标记（spec §2 的 rangeCapable）：true=窗请求实测被
    /// 遵从；false=服务端曾无视 Range/响应窗不符，前端应走全量切片通道
    ///（暴露面：Task 5 装配/health 摘要消费）。
    pub fn range_capable(&self) -> bool {
        self.range_capable.load(Ordering::Relaxed)
    }

    /// 挂载相对路径 → 相对串（trim '/'；非 UTF-8 相对路径必然无法构成
    /// URL → NotFound，与 s3 同款）。
    fn rel_str(&self, path: &Path) -> Result<String, StorageError> {
        path.to_str()
            .map(|s| s.trim_matches('/').to_owned())
            .ok_or_else(|| StorageError::not_found("webdav: non-utf8 path"))
    }

    /// 集合 URL（恒尾 '/'）：`{endpoint}/{prefix}{rel}/`。
    fn collection_url(&self, rel: &str) -> String {
        let p = format!("{}{}", self.prefix, rel);
        let p = p.trim_end_matches('/'); // prefix 自带尾 '/'：剥掉避免双斜杠
        if p.is_empty() {
            format!("{}/", self.endpoint)
        } else {
            format!("{}/{}/", self.endpoint, encode_path(p))
        }
    }

    /// 资源 URL（文件/stat 目标，无尾斜杠）。
    fn resource_url(&self, rel: &str) -> String {
        let p = format!("{}{}", self.prefix, rel);
        let p = p.trim_end_matches('/');
        if p.is_empty() {
            format!("{}/", self.endpoint)
        } else {
            format!("{}/{}", self.endpoint, encode_path(p))
        }
    }

    /// 附 Basic auth 的请求执行（头按传入序，authorization 恒末位）。
    async fn request(
        &self,
        method: &str,
        url: &str,
        headers: Vec<(&str, String)>,
        body: Option<Vec<u8>>,
    ) -> Result<crate::transport::HttpResponse, StorageError> {
        let mut all: Vec<(String, String)> =
            headers.into_iter().map(|(k, v)| (k.to_owned(), v)).collect();
        all.push(("authorization".into(), basic_auth(&self.creds)));
        self.http
            .execute(HttpRequest {
                method: method.to_owned(),
                url: url.to_owned(),
                headers: all,
                body,
            })
            .await
    }

    /// PROPFIND（Depth: 0 单点 / 1 单层）。
    async fn propfind(&self, url: &str, depth: u8) -> Result<crate::transport::HttpResponse, StorageError> {
        self.request(
            "PROPFIND",
            url,
            vec![("Depth", depth.to_string()), ("Content-Type", "application/xml".into())],
            Some(PROPFIND_BODY.as_bytes().to_vec()),
        )
        .await
    }

    /// GET（可选 Range 头）。
    async fn get(&self, url: &str, range: Option<&str>) -> Result<crate::transport::HttpResponse, StorageError> {
        let headers = range.map(|r| vec![("Range", r.to_owned())]).unwrap_or_default();
        self.request("GET", url, headers, None).await
    }
}

#[async_trait]
impl StorageBackend for WebDavBackend {
    /// 单层目录列表：PROPFIND Depth:1，multistatus → Entry。集合自身条目
    /// 跳过；集合判定 = resourcetype 或 href 尾斜杠（双信号，spec 口径）；
    /// 呈现序与 LocalFs/S3 统一（目录优先 + 自然序）。
    async fn list_dir(&self, path: &Path) -> Result<Vec<Entry>, StorageError> {
        let rel = self.rel_str(path)?;
        let url = self.collection_url(&rel);
        let resp = ensure_status(self.propfind(&url, 1).await?).await?;
        let xml = read_body(resp).await?;
        let req_path = url_path(&url);

        let mut entries: Vec<Entry> = Vec::new();
        for raw in parse_multistatus(&xml) {
            let decoded = decode_href(&raw.href);
            if is_self(&decoded, req_path) {
                continue; // Depth:1 的集合自身
            }
            let is_dir = raw.is_collection || decoded.ends_with('/');
            // 名 = 解码后 path 末段（集合先剥尾 '/'；越层/空名防御性跳过）
            let name = normalize_href(&decoded)
                .trim_end_matches('/')
                .rsplit('/')
                .next()
                .unwrap_or("");
            if name.is_empty() {
                continue;
            }
            let (kind, size) =
                if is_dir { (EntryKind::Dir, None) } else { (EntryKind::File, raw.size) };
            entries.push(Entry { name: name.to_owned(), kind, size, mtime: raw.mtime });
        }

        sort_entries_dirs_first(&mut entries);
        Ok(entries)
    }

    /// 读取文件（可选窗）：窗 GET + 前缀采样，形态与 S3 后端一致（窗起点
    /// 0 时头与流取自同一响应；起点 >0 时前缀 GET 先发，记录序 [head,
    /// window]）。差异在防线语义：窗响应与请求窗**不符**时不报错，标记
    /// [`Self::range_capable()`]=false 并降级——从实际响应体（通常为被无视
    /// Range 的全量）切出请求窗返回（spec §2：WebDAV 服务器不可控，降级
    /// 而非拒绝）。
    async fn read_range(
        &self,
        path: &Path,
        range: Option<RangeSpec>,
        head_len: usize,
    ) -> Result<FileRead, StorageError> {
        let rel = self.rel_str(path)?;
        if rel.is_empty() {
            return Err(StorageError::not_found("webdav: empty path"));
        }
        let url = self.resource_url(&rel);
        let start = range.map(|r| r.start).unwrap_or(0);
        let head_from_window = start == 0;

        // 检测头（文件前缀 ≤head_len）：起点 >0 时独立前缀 GET 且先发
        //（前缀 GET 不参与防线判定：200 时读到的仍是文件前缀，语义不变，
        // 读幅有 head_len 上界——窗 GET 会给出防线结论）
        let prefix_head: Option<Vec<u8>> = if !head_from_window && head_len > 0 {
            let head_range = format!("bytes=0-{}", head_len - 1);
            let resp = ensure_status(self.get(&url, Some(&head_range)).await?).await?;
            let mut head_body = into_tokio(resp.body);
            Some(read_up_to(&mut head_body, head_len).await)
        } else {
            None
        };

        // 窗 GET：Range 头 bytes=start-(start+len-1)；None → 全量（无 Range 头）
        let window_header = range.map(|r| format!("bytes={}-{}", r.start, r.start + r.len - 1));
        let resp = ensure_status(self.get(&url, window_header.as_deref()).await?).await?;

        // Range 防线（spec §2）：不符 → 降级标记（不报错）
        let honored = match (window_header.as_deref(), range) {
            (Some(_), Some(r)) => {
                let ok = window_honored(&resp, r.start, r.len);
                if !ok {
                    self.range_capable.store(false, Ordering::Relaxed);
                }
                ok
            }
            _ => true,
        };

        let total_size = total_size_of(&resp)?;
        let want = range.map(|r| r.len).unwrap_or(total_size);

        let mut body = into_tokio(resp.body);
        let head: Vec<u8> = if head_from_window && head_len > 0 {
            read_up_to(&mut body, head_len).await
        } else {
            prefix_head.unwrap_or_default()
        };

        // 流：honored 时起点已定位；降级时响应体为全量——起点 0 的窗即前缀
        //（Cursor 链回放 + take），起点 >0 先丢弃 start 字节再按窗截取。
        // 病态响应（声明不符但体实为窗）下切窗尽力而为，注释存证。
        let stream: ByteStream = if head_from_window {
            Box::pin(std::io::Cursor::new(head.clone()).chain(body).take(want))
        } else {
            if !honored {
                skip_bytes(&mut body, start).await;
            }
            Box::pin(body.take(want))
        };

        Ok(FileRead { total_size, head, stream })
    }

    /// 单点元数据：PROPFIND Depth:0（dav 无 HEAD 目录语义，统一走
    /// multistatus 单条目）。挂载根按定义是集合（PROPFIND 目标恒
    /// collection），恒 Dir 不发请求（同 S3 挂载根先例）。
    async fn stat(&self, path: &Path) -> Result<Entry, StorageError> {
        let rel = self.rel_str(path)?;
        if rel.is_empty() {
            return Ok(dir_entry(""));
        }

        let url = self.resource_url(&rel);
        let resp = ensure_status(self.propfind(&url, 0).await?).await?;
        let xml = read_body(resp).await?;
        let raw = parse_multistatus(&xml)
            .into_iter()
            .next()
            .ok_or_else(|| StorageError::other("webdav: stat got empty multistatus"))?;

        let decoded = decode_href(&raw.href);
        let is_dir = raw.is_collection || decoded.ends_with('/');
        let name = normalize_href(&decoded)
            .trim_end_matches('/')
            .rsplit('/')
            .next()
            .unwrap_or("")
            .to_owned();
        let (kind, size) =
            if is_dir { (EntryKind::Dir, None) } else { (EntryKind::File, raw.size) };
        Ok(Entry { name, kind, size, mtime: raw.mtime })
    }

    /// 能力位：远端后端降级（Global Constraints：仅 LocalFs=true）。
    fn capabilities(&self) -> MountCapabilities {
        MountCapabilities { watch: false, search: false }
    }
}

// ---------- 单测：base64 向量 / 解析器 / 防线判定真值表 ----------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transport::http_response;

    /// RFC 4648 §10 测试向量 + Basic auth 实用形态。
    #[test]
    fn base64_rfc4648_vectors() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foob"), "Zm9vYg==");
        assert_eq!(base64_encode(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
        assert_eq!(base64_encode(b"user:pass"), "dXNlcjpwYXNz");
    }

    #[test]
    fn basic_auth_header_shape() {
        let creds =
            WebDavCredentials { username: "alice".into(), password: "s3cret".into() };
        let auth = basic_auth(&creds);
        assert!(auth.starts_with("Basic "));
        assert_eq!(auth, format!("Basic {}", base64_encode(b"alice:s3cret")));
        assert!(!auth.contains("s3cret"), "Basic 值不含明文密码");
    }

    /// 凭证脱敏 Debug（Task 3 评审 Major-1 必守先例）。
    #[test]
    fn debug_redacts_credentials() {
        let creds =
            WebDavCredentials { username: "alice".into(), password: "s3cret".into() };
        let dbg = format!("{creds:?}");
        assert!(!dbg.contains("alice") && !dbg.contains("s3cret"), "{dbg}");
        assert_eq!(dbg.matches("[redacted]").count(), 2, "{dbg}");

        let cfg = WebDavMountConfig {
            endpoint: "https://dav.test.example.com".into(),
            prefix: "sub".into(),
            username: "alice".into(),
            password: "s3cret".into(),
        };
        let dbg = format!("{cfg:?}");
        assert!(!dbg.contains("alice") && !dbg.contains("s3cret"), "{dbg}");
    }

    /// 字面结构解析锚（tests/webdav.rs 集成样本同源）：两前缀形态/集合位/
    /// size/mtime/自闭合 resourcetype。
    #[test]
    fn parse_multistatus_prefix_forms() {
        let d_form = r#"<d:multistatus xmlns:d="DAV:">
          <d:response><d:href>/a/</d:href>
            <d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
          </d:response>
          <d:response><d:href>/a/f.txt</d:href>
            <d:propstat><d:prop><d:resourcetype/><d:getcontentlength>5</d:getcontentlength><d:getlastmodified>Fri, 24 May 2013 00:00:00 GMT</d:getlastmodified></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
          </d:response>
        </d:multistatus>"#;
        let entries = parse_multistatus(d_form);
        assert_eq!(entries.len(), 2);
        assert!(entries[0].is_collection);
        assert_eq!(entries[0].href, "/a/");
        assert!(!entries[1].is_collection);
        assert_eq!(entries[1].size, Some(5));
        assert_eq!(entries[1].mtime, Some(1_369_353_600_000));

        // `D:` 大写前缀同构（同一文档换前缀必须同样解析）
        let upper = d_form.replace("d:", "D:");
        let entries = parse_multistatus(&upper);
        assert_eq!(entries.len(), 2);
        assert!(entries[0].is_collection);
        assert_eq!(entries[1].size, Some(5));
    }

    /// 防线判定真值表：CR 缺失/窗段错位/长度>窗 → false；CR 窗段吻合
    /// （CL 恰等/缺失 chunked）→ true。
    #[test]
    fn window_honored_truth_table() {
        let resp = |headers: &[(&str, &str)]| http_response(206, headers, b"x");
        assert!(window_honored(
            &resp(&[("content-range", "bytes 10-15/20"), ("content-length", "6")]),
            10,
            6
        ));
        // chunked（无 Content-Length）：窗段吻合即放行
        assert!(window_honored(&resp(&[("content-range", "bytes 0-9/*")]), 0, 10));
        // 无 Content-Range
        assert!(!window_honored(&resp(&[("content-length", "20")]), 10, 6));
        // 窗段错位
        assert!(!window_honored(
            &resp(&[("content-range", "bytes 0-5/20"), ("content-length", "6")]),
            10,
            6
        ));
        // 响应长度>请求窗
        assert!(!window_honored(
            &resp(&[("content-range", "bytes 10-15/20"), ("content-length", "20")]),
            10,
            6
        ));
        // '*' 窗段（416 形态）
        assert!(!window_honored(&resp(&[("content-range", "bytes */20")]), 10, 6));
    }

    /// total 提取优先级：206 CR 优先；200 CL 优先；206 CR '*' 退 CL；
    /// 双缺失报错。
    #[test]
    fn total_size_precedence() {
        let resp = |status: u16, headers: &[(&str, &str)]| http_response(status, headers, b"x");
        assert_eq!(
            total_size_of(&resp(
                206,
                &[("content-range", "bytes 0-9/20"), ("content-length", "10")]
            ))
            .unwrap(),
            20
        );
        assert_eq!(
            total_size_of(&resp(200, &[("content-range", "bytes 0-999/5000"), ("content-length", "1000")]))
                .unwrap(),
            1000,
            "200 体为全量：CL 优先于错位的 CR"
        );
        assert_eq!(total_size_of(&resp(206, &[("content-range", "bytes 0-9/*"), ("content-length", "10")])).unwrap(), 10);
        assert!(total_size_of(&resp(206, &[])).is_err());
    }

    /// href 归一与自身判定：绝对 path/绝对 URI/相对引用；同名嵌套子目录不误判。
    #[test]
    fn is_self_and_href_normalization() {
        assert!(is_self("/dav/sub/", "/dav/sub/"));
        assert!(is_self("/dav/sub", "/dav/sub/"));
        assert!(is_self("http://h.test/dav/sub/", "/dav/sub/"));
        assert!(!is_self("/dav/sub/a.txt", "/dav/sub/"));
        assert!(!is_self("/dav/sub/sub/", "/dav/sub/"), "同名嵌套子目录不误判");
        assert!(is_self("sub/", "/dav/sub/"), "相对引用退化末段");
        assert!(!is_self("sub/child/", "/dav/sub/"));
        assert_eq!(normalize_href("http://h.test/dav/sub/a.txt"), "/dav/sub/a.txt");
        assert_eq!(normalize_href("/dav/sub/a.txt"), "/dav/sub/a.txt");
    }

    /// path 段编码（与 s3 同构）：中文 percent 化、字面 '%' → %25、'/' 保留。
    #[test]
    fn encode_path_segments() {
        assert_eq!(encode_path("sub/中文.txt"), "sub/%E4%B8%AD%E6%96%87.txt");
        assert_eq!(encode_path("a%2Fb"), "a%252Fb");
        assert_eq!(encode_path("plain.bin"), "plain.bin");
        assert_eq!(encode_path(""), "");
    }
}
