//! S3 后端（Task 3）：手写 SigV4 签名 + ListObjectsV2 解析 + GET/HEAD 读取。
//!
//! ## 版本耦合注记（svgbob 教训）
//! ListObjectsV2 响应按 S3 API 2006-03-01 的**字面结构**解析：只认
//! `<Contents><Key>…</Key><Size>…</Size><LastModified>…</LastModified></Contents>`
//! 与 `<CommonPrefixes><Prefix>…</Prefix></CommonPrefixes>`，外加
//! `<IsTruncated>`/`<NextContinuationToken>`；不做通用 XML 解析（不引解析器）。
//! 上游若改结构（tag 改名/命名空间前缀化），`tests/s3.rs` 的格式样本锚与
//! 本模块单测样本即失效——先改样本再改解析。
//!
//! ## 签名锚
//! SigV4 全链以 AWS 官方向量校验（docs.aws.amazon.com「Signature Calculations
//! for the Authorization Header: Transferring Payload in a Single Chunk」）：
//! GET Object（Range 头）/ GET Bucket Lifecycle（空值 query）/ List Objects
//! （query 排序）三向量整链签名比对；key 段 `$`→`%24` 编码与非空 payload
//! hash 取自官方 PUT Object 向量的字面形态，做纯函数单测锚（该向量签名串
//! 的 SignedHeaders 集不含 x-amz-content-sha256，与本实现「恒签
//! x-amz-content-sha256」的 S3 强制形态不同，故不作整链比对，见模块单测注）。

use std::path::Path;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use hmac::{Hmac, Mac};
use percent_encoding::{percent_decode_str, utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};
use sha2::{Digest, Sha256};
use tokio::io::AsyncReadExt;

use crate::transport::{HttpRequest, HttpByteStream};
use crate::{
    sort_entries_dirs_first, Entry, EntryKind, FileRead, HttpTransport, MountCapabilities,
    RangeSpec, StorageBackend, StorageError, StorageErrorKind,
};

/// 阶段一配置面无 region 字段（spec §2 的 mount 字段集），而 SigV4 需要 region
/// 参与签名：默认 us-east-1——MinIO/R2/OSS/COS 等兼容实现普遍不校验 region；
/// 对接严格按 region 校验的 AWS 真桶（非 us-east-1 区域）需扩配置面。签名
/// 函数 [`sign_request`] 已参数化，扩展面时零改动。
const DEFAULT_REGION: &str = "us-east-1";
const SERVICE: &str = "s3";
/// 分页安全阀：单次 list_dir 最多跟随的页数（每页默认 ≤1000 键）——防御
/// 病态服务端（IsTruncated 恒 true）把列表调用变成死循环。
const MAX_LIST_PAGES: usize = 1000;
/// 错误响应体采样上界（排障片段：S3 错误 XML 的 Code/Message）。
const ERROR_BODY_SNIPPET: usize = 512;

/// AWS UriEncode 的 query 字符集：unreserved（A-Za-z0-9-._~）之外全编码。
const QUERY_SET: &AsciiSet =
    &NON_ALPHANUMERIC.remove(b'-').remove(b'.').remove(b'_').remove(b'~');
/// 对象 key 段字符集：query 集之上额外保留 '/'（key 逐段编码、'/' 作分隔保留）。
const URI_SET: &AsciiSet = &QUERY_SET.remove(b'/');

// ---------- 配置与凭证 ----------

/// S3 挂载配置（server 侧 config.rs 的 MountConfig 由 Task 5 装配映射到本
/// 结构；storage crate 不反向依赖 server）。Debug 手工实现：凭证字段脱敏
///（评审 Major-1——Task 5 起启动日志 Debug 打印配置为常见形态）。
#[derive(Clone)]
pub struct S3MountConfig {
    /// 形如 `https://s3.us-east-1.amazonaws.com` 或 `http://127.0.0.1:9000`
    ///（尾 '/' 容忍，new 内规范化）。
    pub endpoint: String,
    pub bucket: String,
    /// 挂载子路径：空串=桶根；非空规范化为 `xxx/`（去前导 '/'，保证尾 '/'）。
    pub prefix: String,
    pub access_key_id: String,
    pub secret_access_key: String,
    /// true（Global Constraints 缺省形态）：path-style `{endpoint}/{bucket}/{key}`；
    /// false：virtual-host `{scheme}://{bucket}.{host}/{key}`。
    pub path_style: bool,
}

impl std::fmt::Debug for S3MountConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("S3MountConfig")
            .field("endpoint", &self.endpoint)
            .field("bucket", &self.bucket)
            .field("prefix", &self.prefix)
            .field("access_key_id", &"[redacted]")
            .field("secret_access_key", &"[redacted]")
            .field("path_style", &self.path_style)
            .finish()
    }
}

/// SigV4 凭证（Debug 手工实现，双字段均脱敏——评审 Major-1）。
#[derive(Clone)]
pub struct S3Credentials {
    pub access_key_id: String,
    pub secret_access_key: String,
}

impl std::fmt::Debug for S3Credentials {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("S3Credentials")
            .field("access_key_id", &"[redacted]")
            .field("secret_access_key", &"[redacted]")
            .finish()
    }
}

/// 签名产物：请求应携带的全部头（host / 调用方附加头小写化 / x-amz-date /
/// x-amz-content-sha256 / authorization——authorization 恒在末位）。
/// Debug 手工实现：authorization 值脱敏（评审 Major-1，含明文签名串）。
#[derive(Clone)]
pub struct SignedHeaders {
    pub headers: Vec<(String, String)>,
}

impl std::fmt::Debug for SignedHeaders {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SignedHeaders")
            .field("headers", &crate::redacted_headers(&self.headers))
            .finish()
    }
}

impl SignedHeaders {
    /// 大小写不敏感取头值（测试与调用方断言用）。
    pub fn get(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
}

// ---------- SigV4 纯函数 ----------

/// SigV4 签名（纯函数，AWS 官方向量锚定）。
///
/// `url` 为完整绝对 URL（query 值可任意编码形态——canonical 化统一按
/// decode→UriEncode 重编码后排序，幂等）；`extra_headers` 为业务头（如
/// Range，名字大小写不敏感，签名内统一小写）；`payload` 参与 hash（GET/
/// HEAD 传空串）；`amz_date` 为 `YYYYMMDDThhmmssZ`（显式注入以锚定官方
/// 向量；生产路径经 [`amz_date_now`] 生成）。
///
/// 调用方若自带 `x-amz-date`/`x-amz-content-sha256`，以自带值为准（不重复注头）。
pub fn sign_request(
    method: &str,
    url: &str,
    extra_headers: &[(String, String)],
    payload: &[u8],
    creds: &S3Credentials,
    region: &str,
    service: &str,
    amz_date: &str,
) -> SignedHeaders {
    let payload_hash = sha256_hex(payload);

    // URL 拆解：scheme://authority/path?query（canonical host 含非默认端口）
    let (base, query) = match url.split_once('?') {
        Some((b, q)) => (b, q),
        None => (url, ""),
    };
    let authority_full = base.split("://").nth(1).unwrap_or(base);
    // path 保留前导 '/'（canonical URI 从根起："/test.txt"；空 path → "/"）；
    // 连续 '/' 的空段按字面保留（不规范化，S3 语义）
    let (authority, path) = match authority_full.split_once('/') {
        Some((a, p)) => (a, format!("/{p}")),
        None => (authority_full, String::new()),
    };

    // 签名头集：host + x-amz-*（调用方自带则覆盖）+ 业务头小写化，按名排序；
    // 同名重复按 AWS 规则逗号拼接。
    let mut headers: Vec<(String, String)> = vec![
        ("host".into(), authority.to_owned()),
        ("x-amz-content-sha256".into(), payload_hash.clone()),
        ("x-amz-date".into(), amz_date.to_owned()),
    ];
    for (name, value) in extra_headers {
        let lower = name.to_ascii_lowercase();
        headers.retain(|(k, _)| *k != lower);
        headers.push((lower, canonical_header_value(value)));
    }
    headers.sort_by(|a, b| a.0.cmp(&b.0));
    let mut merged: Vec<(String, String)> = Vec::with_capacity(headers.len());
    for (k, v) in headers {
        match merged.last_mut() {
            Some((lk, lv)) if *lk == k => {
                lv.push(',');
                lv.push_str(&v);
            }
            _ => merged.push((k, v)),
        }
    }

    let signed = merged.iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>().join(";");
    let canonical_headers =
        merged.iter().map(|(k, v)| format!("{k}:{v}\n")).collect::<String>();

    // 规范请求：METHOD\ncanonical_uri\ncanonical_query\ncanonical_headers\nsigned\npayload_hash
    let canonical_request = format!(
        "{method}\n{}\n{}\n{canonical_headers}\n{signed}\n{payload_hash}",
        canonical_uri(&path),
        canonical_query(query),
    );

    let date = amz_date.get(..8).unwrap_or("");
    let scope = format!("{date}/{region}/{service}/aws4_request");
    let string_to_sign = format!(
        "AWS4-HMAC-SHA256\n{amz_date}\n{scope}\n{}",
        sha256_hex(canonical_request.as_bytes())
    );

    let k_date = hmac_sha256(format!("AWS4{}", creds.secret_access_key).as_bytes(), date.as_bytes());
    let k_region = hmac_sha256(&k_date, region.as_bytes());
    let k_service = hmac_sha256(&k_region, service.as_bytes());
    let k_signing = hmac_sha256(&k_service, b"aws4_request");
    let signature = hex::encode(hmac_sha256(&k_signing, string_to_sign.as_bytes()));

    merged.push((
        "authorization".into(),
        format!(
            "AWS4-HMAC-SHA256 Credential={}/{scope}, SignedHeaders={signed}, Signature={signature}",
            creds.access_key_id
        ),
    ));

    SignedHeaders { headers: merged }
}

/// canonical URI：path 逐段 decode → UriEncode（'/' 保留为分隔）；空 path → "/"。
/// 对已编码输入幂等（调用方 wire URL 与签名走同一编码规则）。
fn canonical_uri(path: &str) -> String {
    if path.is_empty() {
        return "/".to_owned();
    }
    path.split('/')
        .map(|seg| {
            let bytes: Vec<u8> = percent_decode_str(seg).collect();
            utf8_percent_encode(&String::from_utf8_lossy(&bytes), URI_SET).to_string()
        })
        .collect::<Vec<_>>()
        .join("/")
}

/// canonical query：各对 decode → UriEncode 重编码后按编码名（再按值）字节序排序。
/// 无 '=' 的裸名视为空值（canonical 形态 `name=`）。
fn canonical_query(query: &str) -> String {
    if query.is_empty() {
        return String::new();
    }
    let mut pairs: Vec<(String, String)> = query
        .split('&')
        .filter(|p| !p.is_empty())
        .map(|pair| match pair.split_once('=') {
            Some((k, v)) => (decode_percent(k), decode_percent(v)),
            None => (decode_percent(pair), String::new()),
        })
        .map(|(k, v)| (encode_query(&k), encode_query(&v)))
        .collect();
    pairs.sort();
    pairs
        .iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join("&")
}

fn decode_percent(s: &str) -> String {
    if !s.contains('%') {
        return s.to_owned();
    }
    let bytes: Vec<u8> = percent_decode_str(s).collect();
    // key/prefix 文本域 UTF-8；损失性转换仅出现在上游本就非 UTF-8 的病态输入
    String::from_utf8_lossy(&bytes).into_owned()
}

fn encode_query(s: &str) -> String {
    utf8_percent_encode(s, QUERY_SET).to_string()
}

/// AWS SigV4 canonical headers 值形态：trim + 内部连续空白折叠为单空格
///（签名规范步骤 4）。现调用面均为机器构造头（无多余空白），实害为零；
/// 折叠防未来人写头形态参与签名导致 SignatureDoesNotMatch（评审 Minor-2）。
fn canonical_header_value(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut pending_ws = false;
    for c in value.chars() {
        if c.is_whitespace() {
            // 前导空白丢弃；内部连续空白只记一个
            pending_ws = !out.is_empty();
        } else {
            if pending_ws {
                out.push(' ');
                pending_ws = false;
            }
            out.push(c);
        }
    }
    out
}

fn sha256_hex(data: &[u8]) -> String {
    hex::encode(Sha256::digest(data))
}

type HmacSha256 = Hmac<Sha256>;

fn hmac_sha256(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC accepts any key length");
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
}

// ---------- 日期换算（手工历法，避免引 chrono/time） ----------

/// 当前时刻的 x-amz-date（UTC，`YYYYMMDDThhmmssZ`）。
pub(crate) fn amz_date_now() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    amz_date_from_epoch(secs)
}

/// epoch 秒 → x-amz-date。锚：1_369_353_600 → "20130524T000000Z"（AWS 向量日期）。
pub(crate) fn amz_date_from_epoch(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let (y, m, d) = civil_from_days(days);
    format!(
        "{y:04}{m:02}{d:02}T{:02}{:02}{:02}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

/// 天数 → (年, 月, 日)（Howard Hinnant civil_from_days，公历无YEAR0惯例）。
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// (年, 月, 日) → 天数（civil_from_days 逆变换）。
fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as u64;
    let mp = if m > 2 { m - 3 } else { m + 9 } as u64;
    let doy = (153 * mp + 2) / 5 + d as u64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe as i64 - 719_468
}

/// ListObjectsV2 `<LastModified>`（ISO 8601）→ epoch 毫秒：
/// `2019-02-19T21:48:39.000Z`。
pub(crate) fn parse_iso8601_millis(s: &str) -> Option<u64> {
    let (date, time) = s.trim().strip_suffix('Z')?.split_once('T')?;
    let mut ymd = date.split('-');
    let y: i64 = ymd.next()?.parse().ok()?;
    let m: u32 = ymd.next()?.parse().ok()?;
    let d: u32 = ymd.next()?.parse().ok()?;
    let time = time.split('.').next().unwrap_or(time);
    let mut hms = time.split(':');
    let h: u64 = hms.next()?.parse().ok()?;
    let mi: u64 = hms.next()?.parse().ok()?;
    let sec: u64 = hms.next()?.parse().ok()?;
    let total = days_from_civil(y, m, d) * 86_400 + (h * 3600 + mi * 60 + sec) as i64;
    u64::try_from(total).ok().map(|t| t * 1000)
}

const MONTHS: [&str; 12] =
    ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/// HTTP-date（IMF-fixdate）→ epoch 毫秒：`Fri, 24 May 2013 00:00:00 GMT`
///（HEAD 的 Last-Modified）。
pub(crate) fn parse_http_date_millis(s: &str) -> Option<u64> {
    let rest = s.trim().split_once(", ")?.1;
    let mut parts = rest.split_whitespace();
    let d: u32 = parts.next()?.parse().ok()?;
    let mon = parts.next()?;
    let m = MONTHS.iter().position(|mo| *mo == mon)? as u32 + 1;
    let y: i64 = parts.next()?.parse().ok()?;
    let mut hms = parts.next()?.split(':');
    let h: u64 = hms.next()?.parse().ok()?;
    let mi: u64 = hms.next()?.parse().ok()?;
    let sec: u64 = hms.next()?.parse().ok()?;
    let total = days_from_civil(y, m, d) * 86_400 + (h * 3600 + mi * 60 + sec) as i64;
    u64::try_from(total).ok().map(|t| t * 1000)
}

// ---------- ListObjectsV2 XML 字面结构解析（版本耦合，见模块注） ----------

struct RawFile {
    key: String,
    size: Option<u64>,
    mtime: Option<u64>,
}

struct ListPage {
    files: Vec<RawFile>,
    /// CommonPrefixes 的原始前缀（如 `sub/dir/`）。
    dirs: Vec<String>,
    is_truncated: bool,
    next_token: Option<String>,
}

/// 顺序提取 `<tag>…</tag>` 块内容（字面扫描，无嵌套假设——S3 列表响应
/// 的 Contents/CommonPrefixes 为平铺块）。
fn blocks<'a>(xml: &'a str, tag: &str) -> Vec<&'a str> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let mut out = Vec::new();
    let mut rest = xml;
    while let Some(start) = rest.find(&open) {
        let after = &rest[start + open.len()..];
        match after.find(&close) {
            Some(end) => {
                out.push(&after[..end]);
                rest = &after[end + close.len()..];
            }
            None => break, // 截断块：按字面契约视为终止
        }
    }
    out
}

/// 块内首个 `<tag>…</tag>` 文本（不 trim——key/prefix 文本域精确保真）。
fn inner<'a>(block: &'a str, tag: &str) -> Option<&'a str> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = block.find(&open)? + open.len();
    let end = block[start..].find(&close)? + start;
    Some(&block[start..end])
}

/// XML 实体反转义：五个命名实体 + 十进制/十六进制数字引用；孤立 '&' 原样。
/// （Task 4 起 WebDAV multistatus 解析复用——共享文本助手暂居本模块，
/// 扩散最小；后续第三实现需要时再迁 lib。）
pub(crate) fn xml_unescape(s: &str) -> String {
    if !s.contains('&') {
        return s.to_owned();
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        let tail = &rest[i..];
        let replaced = tail.find(';').and_then(|semi| {
            let entity = &tail[1..semi];
            if let Some(num) = entity.strip_prefix('#') {
                let code = if let Some(hex) = num.strip_prefix('x').or_else(|| num.strip_prefix('X'))
                {
                    u32::from_str_radix(hex, 16).ok()
                } else {
                    num.parse::<u32>().ok()
                };
                code.and_then(char::from_u32).map(|c| c.to_string())
            } else {
                match entity {
                    "amp" => Some("&".to_owned()),
                    "lt" => Some("<".to_owned()),
                    "gt" => Some(">".to_owned()),
                    "quot" => Some("\"".to_owned()),
                    "apos" => Some("'".to_owned()),
                    _ => None,
                }
            }
            .map(|r| (r, semi))
        });
        match replaced {
            Some((r, semi)) => {
                out.push_str(&r);
                rest = &tail[semi + 1..];
            }
            None => {
                out.push('&');
                rest = &tail[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

fn parse_list_v2(xml: &str) -> Result<ListPage, StorageError> {
    let mut files = Vec::new();
    for block in blocks(xml, "Contents") {
        let key = inner(block, "Key")
            .map(xml_unescape)
            .ok_or_else(|| StorageError::other("s3 list: <Contents> missing <Key>"))?;
        let size = inner(block, "Size").and_then(|s| s.trim().parse().ok());
        let mtime = inner(block, "LastModified").and_then(parse_iso8601_millis);
        files.push(RawFile { key, size, mtime });
    }

    let dirs = blocks(xml, "CommonPrefixes")
        .iter()
        .map(|b| {
            inner(b, "Prefix")
                .map(xml_unescape)
                .ok_or_else(|| StorageError::other("s3 list: <CommonPrefixes> missing <Prefix>"))
        })
        .collect::<Result<Vec<_>, _>>()?;

    let is_truncated = inner(xml, "IsTruncated")
        .map(|s| s.trim().eq_ignore_ascii_case("true"))
        .unwrap_or(false);
    let next_token = inner(xml, "NextContinuationToken").map(xml_unescape);

    Ok(ListPage { files, dirs, is_truncated, next_token })
}

// ---------- S3 后端 ----------

/// S3 只读后端：ListObjectsV2（delimiter=/）列目录 + Range GET 读文件 +
/// HEAD/probe stat。经 [`crate::HttpTransport`] 发请求（native =
/// ReqwestTransport，测试 = MockTransport）。
pub struct S3Backend {
    endpoint: String, // 无尾 '/'
    bucket: String,
    prefix: String, // "" 或 "xxx/"
    creds: S3Credentials,
    path_style: bool,
    http: Arc<dyn HttpTransport>,
}

impl S3Backend {
    pub fn new(cfg: S3MountConfig, http: Arc<dyn HttpTransport>) -> Self {
        Self {
            endpoint: cfg.endpoint.trim_end_matches('/').to_owned(),
            bucket: cfg.bucket,
            prefix: normalize_prefix(&cfg.prefix),
            creds: S3Credentials {
                access_key_id: cfg.access_key_id,
                secret_access_key: cfg.secret_access_key,
            },
            path_style: cfg.path_style,
            http,
        }
    }

    /// 挂载相对路径 → 对象 key（挂载 prefix 前置；空路径=挂载根 → 空 key）。
    /// S3 key 域为 UTF-8；非 UTF-8 相对路径必然无对应键 → NotFound。
    fn object_key(&self, path: &Path) -> Result<String, StorageError> {
        let rel = path
            .to_str()
            .ok_or_else(|| StorageError::not_found("s3: non-utf8 path"))?
            .trim_matches('/');
        Ok(if rel.is_empty() { String::new() } else { format!("{}{rel}", self.prefix) })
    }

    /// 挂载相对路径 → ListObjectsV2 prefix（恒以 '/' 结尾）。
    fn list_prefix(&self, path: &Path) -> Result<String, StorageError> {
        let rel = path
            .to_str()
            .ok_or_else(|| StorageError::not_found("s3: non-utf8 path"))?
            .trim_matches('/');
        Ok(if rel.is_empty() {
            self.prefix.clone()
        } else {
            format!("{}{rel}/", self.prefix)
        })
    }

    /// 桶基 URL（不含 query）：path-style `{endpoint}/{bucket}`；virtual-host
    /// `{scheme}://{bucket}.{authority}`。
    fn bucket_base(&self) -> String {
        if self.path_style {
            format!("{}/{}", self.endpoint, self.bucket)
        } else {
            let (scheme, authority) = split_scheme_authority(&self.endpoint);
            format!("{scheme}://{bucket}.{authority}", bucket = self.bucket)
        }
    }

    /// 对象 URL：key 逐段 UriEncode（'/' 保留），前置桶基。纯编码不解码
    ///（评审 Minor-1：decode→re-encode 会把字面含 %XX 的 key（a%2Fb.txt）
    /// 解码归一指向错误对象；'%' 字面编码为 %25）。decode 归一化只留在
    /// sign_request 的 canonical 化内（wire URL 的 %25 解码回 % 后重编码稳定）。
    fn object_url(&self, key: &str) -> String {
        let base = self.bucket_base();
        let encoded = encode_key_path(key);
        if encoded.is_empty() {
            base
        } else {
            format!("{base}/{encoded}")
        }
    }

    /// 签名并执行请求（GET/HEAD，空载荷）。
    async fn signed_request(
        &self,
        method: &str,
        url: &str,
        extra: &[(&str, &str)],
    ) -> Result<crate::transport::HttpResponse, StorageError> {
        let extra_headers: Vec<(String, String)> = extra
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect();
        let signed = sign_request(
            method,
            url,
            &extra_headers,
            b"",
            &self.creds,
            DEFAULT_REGION,
            SERVICE,
            &amz_date_now(),
        );
        self.http
            .execute(HttpRequest {
                method: method.to_owned(),
                url: url.to_owned(),
                headers: signed.headers,
                body: None,
            })
            .await
    }

    /// 一次 ListObjectsV2 请求 → 解析页。
    async fn list_page(
        &self,
        list_prefix: &str,
        token: Option<&str>,
        max_keys: Option<u32>,
    ) -> Result<ListPage, StorageError> {
        let mut pairs: Vec<(String, String)> = vec![
            ("list-type".into(), "2".into()),
            ("delimiter".into(), "/".into()),
            ("prefix".into(), list_prefix.to_owned()),
        ];
        if let Some(t) = token {
            pairs.push(("continuation-token".into(), t.to_owned()));
        }
        if let Some(mk) = max_keys {
            pairs.push(("max-keys".into(), mk.to_string()));
        }
        let query = pairs
            .iter()
            .map(|(k, v)| format!("{}={}", encode_query(k), encode_query(v)))
            .collect::<Vec<_>>()
            .join("&");
        let url = format!("{}?{query}", self.bucket_base());

        let resp = ensure_status(self.signed_request("GET", &url, &[]).await?).await?;
        let mut body = into_tokio(resp.body);
        let mut bytes = Vec::new();
        body.read_to_end(&mut bytes)
            .await
            .map_err(|e| StorageError::other(format!("s3 list body: {e}")))?;
        parse_list_v2(&String::from_utf8_lossy(&bytes))
    }
}

/// 挂载子路径规范化：空串或 `xxx/`（WebDAV 后端同款语义，Task 4 复用）。
pub(crate) fn normalize_prefix(prefix: &str) -> String {
    let trimmed = prefix.trim_matches('/');
    if trimmed.is_empty() {
        String::new()
    } else {
        format!("{trimmed}/")
    }
}

fn split_scheme_authority(endpoint: &str) -> (&str, &str) {
    let (scheme, rest) = endpoint.split_once("://").unwrap_or(("https", endpoint));
    let authority = rest.split(['/', '?']).next().unwrap_or(rest);
    (scheme, authority)
}

/// 对象 key 路径的 URL 编码：逐段 UriEncode、'/' 保留为分隔（纯编码，
/// 不做 decode 归一——评审 Minor-1，语义注见 [`S3Backend::object_url`]）。
fn encode_key_path(key: &str) -> String {
    key.split('/')
        .map(|seg| utf8_percent_encode(seg, URI_SET).to_string())
        .collect::<Vec<_>>()
        .join("/")
}

/// futures-io body → tokio 流（tokio-util compat 桥，Task 2 评审明确的
/// 必做交接项；WebDAV GET 同样接，Task 4 复用）。
pub(crate) fn into_tokio(body: HttpByteStream) -> impl tokio::io::AsyncRead + Unpin + Send {
    tokio_util::compat::FuturesAsyncReadCompatExt::compat(body)
}

/// 非 2xx → [`StorageError`]：404→NotFound、403→Other（403 字样保序），
/// 错误体采样 ≤512B 入消息（S3 错误 XML 的 Code/Message 排障用）。
async fn ensure_status(resp: crate::transport::HttpResponse) -> Result<crate::transport::HttpResponse, StorageError> {
    if (200..300).contains(&resp.status) {
        return Ok(resp);
    }
    let status = resp.status;
    let mut body = into_tokio(resp.body);
    let snippet = String::from_utf8_lossy(&read_up_to(&mut body, ERROR_BODY_SNIPPET).await)
        .into_owned();
    match status {
        404 => Err(StorageError::not_found(format!("s3: http 404 {snippet}"))),
        403 => Err(StorageError::other(format!("s3: http 403 forbidden {snippet}"))),
        n => Err(StorageError::other(format!("s3: http {n} {snippet}"))),
    }
}

/// 循环读满 cap（容忍短读，EOF 截断）——与 LocalFs::read_head 同形态
///（WebDAV 头采样/错误体采样复用）。
pub(crate) async fn read_up_to<R: tokio::io::AsyncRead + Unpin>(r: &mut R, cap: usize) -> Vec<u8> {
    let mut buf = vec![0u8; cap];
    let mut filled = 0;
    while filled < buf.len() {
        match r.read(&mut buf[filled..]).await {
            Ok(0) => break,
            Ok(n) => filled += n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
    }
    buf.truncate(filled);
    buf
}

/// 大小写不敏感取响应头值（WebDAV Range 防线/total 提取复用）。
pub(crate) fn header_value<'a>(
    resp: &'a crate::transport::HttpResponse,
    name: &str,
) -> Option<&'a str> {
    resp.headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(name))
        .map(|(_, v)| v.as_str())
}

/// total_size：206 → Content-Range 尾段总长；200 → Content-Length
///（Range 被忽略的服务端形态下同为总长）。
fn total_size_from(resp: &crate::transport::HttpResponse) -> Result<u64, StorageError> {
    if let Some(total) = header_value(resp, "content-range")
        .and_then(|cr| cr.rsplit('/').next())
        .and_then(|t| t.trim().parse::<u64>().ok())
    {
        return Ok(total);
    }
    if let Some(cl) = header_value(resp, "content-length").and_then(|v| v.trim().parse().ok()) {
        return Ok(cl);
    }
    Err(StorageError::other("s3: response missing content-length/content-range"))
}

/// 目录条目构造（size/mtime 默认空；WebDAV stat/list 挂载根复用）。
pub(crate) fn dir_entry(name: &str) -> Entry {
    Entry { name: name.to_owned(), kind: EntryKind::Dir, size: None, mtime: None }
}

#[async_trait]
impl StorageBackend for S3Backend {
    /// 单层目录列表：ListObjectsV2（delimiter=/，CommonPrefixes=子目录），
    /// 跟随 NextContinuationToken 聚合全部页；呈现序与 LocalFs 一致
    /// （目录优先 + 自然序）。Contents 里尾 '/' 的零字节目录标记不浮现。
    async fn list_dir(&self, path: &Path) -> Result<Vec<Entry>, StorageError> {
        let list_prefix = self.list_prefix(path)?;
        let mut token: Option<String> = None;
        let mut entries: Vec<Entry> = Vec::new();
        let mut pages = 0usize;
        loop {
            pages += 1;
            if pages > MAX_LIST_PAGES {
                return Err(StorageError::other(format!(
                    "s3 list: pagination exceeded {MAX_LIST_PAGES} pages"
                )));
            }
            let page = self.list_page(&list_prefix, token.as_deref(), None).await?;

            for f in page.files {
                if f.key.ends_with('/') {
                    continue; // 目录标记对象：目录语义由 CommonPrefixes 承载
                }
                let rel = f.key.strip_prefix(&self.prefix).unwrap_or(&f.key);
                // delimiter=/ 下 rel 无 '/'；防御非遵从服务端取末段
                let name = rel.rsplit('/').next().unwrap_or(rel);
                if name.is_empty() {
                    continue;
                }
                entries.push(Entry {
                    name: name.to_owned(),
                    kind: EntryKind::File,
                    size: f.size,
                    mtime: f.mtime,
                });
            }
            for prefix in page.dirs {
                let rel = prefix.strip_prefix(&self.prefix).unwrap_or(&prefix);
                let name = rel.trim_end_matches('/');
                if name.is_empty() || name.contains('/') {
                    continue; // 挂载前缀自身/越层前缀：防御
                }
                entries.push(dir_entry(name));
            }

            if !page.is_truncated {
                break;
            }
            match page.next_token {
                Some(t) if !t.is_empty() => token = Some(t),
                // 截断但无续传 token：防御性终止（病态服务端形态）
                _ => break,
            }
        }
        sort_entries_dirs_first(&mut entries);
        Ok(entries)
    }

    /// 读取文件（可选窗）：窗 GET + 前缀采样。窗起点为 0 时头与流取自同一
    /// 响应（贴近 LocalFs 单开形态）；起点 >0 时另发前缀 GET（S3 对象按
    /// 覆盖写整体替换，两 GET 竞态窗远小于 fs 写入场景——与下沉前 handler
    /// 单开注记的差异点，评审记录）。
    async fn read_range(
        &self,
        path: &Path,
        range: Option<RangeSpec>,
        head_len: usize,
    ) -> Result<FileRead, StorageError> {
        let key = self.object_key(path)?;
        if key.is_empty() {
            return Err(StorageError::not_found("s3: empty key"));
        }
        let url = self.object_url(&key);
        let start = range.map(|r| r.start).unwrap_or(0);
        let head_from_window = start == 0;

        // 检测头（文件前缀 ≤head_len，编码检测采样窗）：起点 >0 时需独立前缀
        // GET 且先发（记录序 [head, window]）；起点 0 时头取自窗响应体（单
        // GET，贴近 LocalFs 单开形态）
        let prefix_head: Option<Vec<u8>> = if !head_from_window && head_len > 0 {
            let head_range = format!("bytes=0-{}", head_len - 1);
            let resp =
                ensure_status(self.signed_request("GET", &url, &[("Range", head_range.as_str())]).await?)
                    .await?;
            let mut head_body = into_tokio(resp.body);
            Some(read_up_to(&mut head_body, head_len).await)
        } else {
            None
        };

        // 窗 GET：Range 头 bytes=start-(start+len-1)；None → 全量（无 Range 头）
        let window_header = range.map(|r| format!("bytes={}-{}", r.start, r.start + r.len - 1));
        let extra: Vec<(&str, &str)> = window_header
            .as_deref()
            .map(|h| vec![("Range", h)])
            .unwrap_or_default();
        let resp = ensure_status(self.signed_request("GET", &url, &extra).await?).await?;
        // Range 防线（评审 Minor-3）：窗请求必须 206——服务端无视 Range 返
        // 200 时 body 是全量前缀流，take(want) 会静默产出错误窗数据；此处
        // 显式报错而非静默。前缀采样 GET 不做此校验：200（Range 被忽略）时
        // 读到的仍是文件前缀，语义不变（读幅有 head_len 上界）。
        if window_header.is_some() && resp.status != 206 {
            return Err(StorageError::other(format!(
                "s3: range request not honored (http {})",
                resp.status
            )));
        }
        let total_size = total_size_from(&resp)?;
        let want = range.map(|r| r.len).unwrap_or(total_size);

        let mut body = into_tokio(resp.body);
        let head: Vec<u8> = if head_from_window && head_len > 0 {
            read_up_to(&mut body, head_len).await
        } else {
            prefix_head.unwrap_or_default()
        };

        // 流：窗起点已定位（206 防线保证）
        let stream: crate::ByteStream = if head_from_window {
            Box::pin(std::io::Cursor::new(head.clone()).chain(body).take(want))
        } else {
            Box::pin(body.take(want))
        };

        Ok(FileRead { total_size, head, stream })
    }

    /// 单点元数据：HEAD 对象 → File（Content-Length/Last-Modified）；404 →
    /// 目录前缀探测（ListObjectsV2 prefix={key}/ max-keys=1，S3 目录是
    /// CommonPrefix 语义、无对象实体）——命中 → Dir，未命中 → NotFound。
    /// 挂载根（空 key）恒 Dir（空桶根可列，不探）。
    async fn stat(&self, path: &Path) -> Result<Entry, StorageError> {
        let key = self.object_key(path)?;
        if key.is_empty() {
            return Ok(dir_entry(""));
        }

        let url = self.object_url(&key);
        match ensure_status(self.signed_request("HEAD", &url, &[]).await?).await {
            Ok(resp) => {
                let name = key.rsplit('/').next().unwrap_or(&key).to_owned();
                Ok(Entry {
                    name,
                    kind: EntryKind::File,
                    size: header_value(&resp, "content-length").and_then(|v| v.trim().parse().ok()),
                    mtime: header_value(&resp, "last-modified").and_then(parse_http_date_millis),
                })
            }
            Err(e) if e.kind() == StorageErrorKind::NotFound => {
                let probe = self.list_page(&format!("{key}/"), None, Some(1)).await?;
                if probe.files.is_empty() && probe.dirs.is_empty() {
                    Err(e)
                } else {
                    Ok(dir_entry(key.rsplit('/').next().unwrap_or(&key)))
                }
            }
            Err(e) => Err(e),
        }
    }

    /// 能力位：远端后端降级（Global Constraints：仅 LocalFs=true）。
    fn capabilities(&self) -> MountCapabilities {
        MountCapabilities { watch: false, search: false }
    }
}

// ---------- 单测：AWS 官方向量（另三例）与纯函数锚 ----------

#[cfg(test)]
mod tests {
    use super::*;

    const AK: &str = "AKIAIOSFODNN7EXAMPLE";
    const SK: &str = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
    const EMPTY_SHA256: &str =
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

    fn creds() -> S3Credentials {
        S3Credentials { access_key_id: AK.into(), secret_access_key: SK.into() }
    }

    /// 从 authorization 头提取官方 Signature 比对。
    fn signature_of(signed: &SignedHeaders) -> &str {
        let auth = signed.get("authorization").expect("authorization");
        auth.rsplit("Signature=")
            .next()
            .expect("Signature= segment")
    }

    /// 官方向量「Example: GET Bucket Lifecycle」：canonical query `lifecycle=`
    ///（裸名空值）+ canonical URI "/"。
    #[test]
    fn vector_get_bucket_lifecycle() {
        let signed = sign_request(
            "GET",
            "https://examplebucket.s3.amazonaws.com?lifecycle",
            &[],
            b"",
            &creds(),
            "us-east-1",
            "s3",
            "20130524T000000Z",
        );
        assert_eq!(
            signed.get("authorization").unwrap(),
            "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543"
        );
    }

    /// 官方向量「Example: GET Bucket (List Objects)」：query 输入未排序
    ///（prefix=J&max-keys=2），canonical 排序为 max-keys=2&prefix=J。
    #[test]
    fn vector_list_objects_sorted_query() {
        let signed = sign_request(
            "GET",
            "https://examplebucket.s3.amazonaws.com?prefix=J&max-keys=2",
            &[],
            b"",
            &creds(),
            "us-east-1",
            "s3",
            "20130524T000000Z",
        );
        assert_eq!(
            signature_of(&signed),
            "34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7"
        );
        assert_eq!(
            signed.get("authorization").unwrap(),
            "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7"
        );
    }

    /// 官方 PUT Object 向量的字面形态锚：canonical URI `$`→`%24`（该向量
    /// SignedHeaders 集 date;host;x-amz-date;x-amz-storage-class 不含
    /// x-amz-content-sha256，与本实现「S3 恒签 x-amz-content-sha256」不同，
    /// 故只锚编码规则不做整链比对）。
    #[test]
    fn canonical_uri_encodes_special_chars_official_shape() {
        assert_eq!(canonical_uri("test$file.text"), "test%24file.text");
        assert_eq!(canonical_uri(""), "/");
        assert_eq!(canonical_uri("sub/dir/中文.txt"), "sub/dir/%E4%B8%AD%E6%96%87.txt");
        assert_eq!(canonical_uri("a%20b"), "a%20b"); // 幂等：已编码不重编码
    }

    /// 非空 payload hash 放置锚：x-amz-content-sha256 = sha256(payload)
    ///（官方向量 GET/Lifecycle/List 均为空载哈希，非空载复用同一 canonical 位）。
    #[test]
    fn payload_hash_nonempty() {
        let signed = sign_request(
            "PUT",
            "https://examplebucket.s3.amazonaws.com/test$file.text",
            &[],
            b"Welcome to Amazon S3.",
            &creds(),
            "us-east-1",
            "s3",
            "20130524T000000Z",
        );
        assert_eq!(
            signed.get("x-amz-content-sha256").unwrap(),
            sha256_hex(b"Welcome to Amazon S3.")
        );
        assert_ne!(signed.get("x-amz-content-sha256").unwrap(), EMPTY_SHA256);
    }

    /// 历法锚：AWS 向量日期。
    #[test]
    fn amz_date_epoch_anchor() {
        assert_eq!(amz_date_from_epoch(1_369_353_600), "20130524T000000Z");
        assert_eq!(amz_date_from_epoch(0), "19700101T000000Z");
    }

    /// LastModified（ISO 8601）与 Last-Modified（HTTP-date）解析锚。
    #[test]
    fn date_parsers() {
        assert_eq!(parse_iso8601_millis("2019-02-19T21:48:39.000Z"), Some(1_550_612_919_000));
        assert_eq!(parse_iso8601_millis("2020-06-01T00:00:00Z"), Some(1_590_969_600_000));
        assert_eq!(parse_iso8601_millis("garbage"), None);
        assert_eq!(
            parse_http_date_millis("Fri, 24 May 2013 00:00:00 GMT"),
            Some(1_369_353_600_000)
        );
        assert_eq!(parse_http_date_millis("garbage"), None);
    }

    /// XML 实体反转义（S3 key 文本域：&amp; &lt; &gt; &quot; &apos; + 数字引用）。
    #[test]
    fn xml_unescape_cases() {
        assert_eq!(xml_unescape("b&amp;c.txt"), "b&c.txt");
        assert_eq!(xml_unescape("a&lt;b&gt;"), "a<b>");
        assert_eq!(xml_unescape("&quot;q&quot; &apos;p&apos;"), "\"q\" 'p'");
        assert_eq!(xml_unescape("&#65;&#x42;"), "AB");
        assert_eq!(xml_unescape("plain&"), "plain&"); // 孤立 '&' 原样
        assert_eq!(xml_unescape("no-escape"), "no-escape");
    }

    /// 字面结构解析锚（S3 API 2006-03-01 格式样本，tests/s3.rs 集成样本同源）。
    #[test]
    fn parse_list_v2_literal_structure() {
        let xml = r#"<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
          <IsTruncated>true</IsTruncated>
          <NextContinuationToken>tok/1=</NextContinuationToken>
          <Contents><Key>sub/a.txt</Key><LastModified>2019-02-19T21:48:39.000Z</LastModified><Size>314</Size></Contents>
          <Contents><Key>sub/m/</Key><Size>0</Size></Contents>
          <CommonPrefixes><Prefix>sub/dir/</Prefix></CommonPrefixes>
        </ListBucketResult>"#;
        let page = parse_list_v2(xml).unwrap();
        assert_eq!(page.files.len(), 2);
        assert_eq!(page.files[0].key, "sub/a.txt");
        assert_eq!(page.files[0].size, Some(314));
        assert_eq!(page.files[0].mtime, Some(1_550_612_919_000));
        assert_eq!(page.files[1].key, "sub/m/");
        assert_eq!(page.dirs, vec!["sub/dir/"]);
        assert!(page.is_truncated);
        assert_eq!(page.next_token.as_deref(), Some("tok/1="));
    }

    /// prefix 规范化与 virtual-host 拆解。
    #[test]
    fn prefix_and_endpoint_normalization() {
        assert_eq!(normalize_prefix(""), "");
        assert_eq!(normalize_prefix("/"), "");
        assert_eq!(normalize_prefix("sub"), "sub/");
        assert_eq!(normalize_prefix("/a/b/"), "a/b/");
        assert_eq!(
            split_scheme_authority("http://127.0.0.1:9000"),
            ("http", "127.0.0.1:9000")
        );
        assert_eq!(
            split_scheme_authority("https://s3.us-east-1.amazonaws.com/x"),
            ("https", "s3.us-east-1.amazonaws.com")
        );
    }

    /// 凭证脱敏 Debug（评审 Major-1）：secret/access key 与明文签名串不得
    /// 出现在 Debug 输出。
    #[test]
    fn debug_redacts_secrets() {
        let cfg = S3MountConfig {
            endpoint: "https://s3.test.example.com".into(),
            bucket: "b".into(),
            prefix: "sub".into(),
            access_key_id: AK.into(),
            secret_access_key: SK.into(),
            path_style: true,
        };
        let dbg = format!("{cfg:?}");
        assert!(dbg.contains("[redacted]"), "{dbg}");
        assert!(!dbg.contains(AK), "{dbg}");
        assert!(!dbg.contains(SK), "{dbg}");

        let creds_dbg = format!("{:?}", creds());
        assert!(!creds_dbg.contains(AK) && !creds_dbg.contains(SK), "{creds_dbg}");

        let signed = sign_request(
            "GET",
            "https://x/y",
            &[],
            b"",
            &creds(),
            "us-east-1",
            "s3",
            "20240101T000000Z",
        );
        let dbg = format!("{signed:?}");
        assert!(dbg.contains("[redacted]"), "{dbg}");
        assert!(!dbg.contains("Signature="), "{dbg}");
    }

    /// key 路径纯编码（评审 Minor-1）：字面 '%' → %25、保留 '/'、不解码归一。
    #[test]
    fn encode_key_path_literal_percent() {
        assert_eq!(encode_key_path("a%2Fb.txt"), "a%252Fb.txt");
        assert_eq!(encode_key_path("sub/中文.txt"), "sub/%E4%B8%AD%E6%96%87.txt");
        assert_eq!(encode_key_path("plain.txt"), "plain.txt");
        assert_eq!(encode_key_path(""), "");
    }

    /// canonical header 值空白折叠（评审 Minor-2）：trim + 连续空白归一。
    #[test]
    fn canonical_header_value_folds_whitespace() {
        assert_eq!(canonical_header_value("bytes=0-9"), "bytes=0-9");
        assert_eq!(canonical_header_value("  bytes=0-9  "), "bytes=0-9");
        assert_eq!(canonical_header_value("a  b\t\tc\r\nd  "), "a b c d");
        assert_eq!(canonical_header_value("   "), "");
    }
}
