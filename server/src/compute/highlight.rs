//! `POST /api/compute/highlight`（Task 3）：tree-sitter 服务端主语法高亮。
//!
//! injections 已接线（阶段 1，spec §2.2）：injection_callback 经
//! `queries::config_ref` 从全局注册表解析注入语言的 HighlightConfiguration。
//!
//! 关键点：
//! - tree-sitter 节点偏移是 UTF-8 字节偏移，前端区间是 UTF-16 代码单元偏移，
//!   响应前经 [`Utf16Index`]（按行增量表 + 二分定位 + 行内小步修正）转换；
//! - path 模式走 [`crate::guard`]（canonicalize 越界校验）并按
//!   `(canonical_path, mtime_ms, size, lang, start_line, line_count)` 缓存响应
//!   （64 条 LRU 简易淘汰）；带 range 的请求流式扫行、区间相对 chunk 首行，
//!   响应带 `baseLine`（= startLine）告知客户端基准行；
//! - 解析是同步 CPU 工作：`spawn_blocking` + 响应侧 `tokio::time::timeout`
//!   （生产 [`HIGHLIGHT_TIMEOUT`]，封装于 [`parse_with_timeout`]，测试可注入短时限）。
//!   超时无法中断已进入同步解析的线程（无取消点），只能放弃其结果返回 504，
//!   线程会在解析自然完成后释放回阻塞线程池——故超时仅是响应侧保护，
//!   不是解析取消。
//!
//! 响应紧凑编码：`{intervals: [[s,e,ci],...], captures: [name,...]}`——
//! 区间用三元数组、捕获名去重为索引表，显著小于逐对象展开的 JSON。

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, UNIX_EPOCH};

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use tree_sitter_highlight::{HighlightEvent, Highlighter};

use crate::compute::queries::{self, HIGHLIGHT_NAMES};
use crate::error::AppError;
use crate::state::AppState;

/// text/path 输入上限（UTF-8 字节）：超限 413。
pub const HIGHLIGHT_MAX_BYTES: usize = 20 * 1024 * 1024;

/// range.lineCount 上限：懒高亮按可视区请求，5000 行远超最大视口预算；
/// 超限 400（区间数上限 [`MAX_INTERVALS`] 之外的第一道闸，防单次请求解析量失控）。
pub const MAX_RANGE_LINES: u64 = 5000;

/// 区间数上限：超过即 413（防御病态输入——UTF-16 转换与 JSON 序列化都是
/// O(intervals)，2M 区间远超正常源文件的必要精度，放行会拖垮内存与响应）。
pub const MAX_INTERVALS: usize = 2_000_000;

/// 缓存准入上限：区间数超过它的响应不进缓存（单条数十 MB，会迅速挤掉
/// 64 条 LRU 里的全部常规条目，命中率归零）。
pub const CACHE_MAX_INTERVALS: usize = 500_000;

/// 同步解析的响应侧超时：超限放弃等待返回 504（见模块注释：不中断线程）。
pub const HIGHLIGHT_TIMEOUT: Duration = Duration::from_secs(10);

/// 响应体：区间三元组（UTF-16 起止偏移 + 捕获名索引，左闭右开）。
/// 带 range 的请求：区间相对 chunk 首行，`baseLine` = 请求 startLine；
/// 无 range（整文件/text）：`baseLine` = 0（与历史响应口径一致）。
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct HighlightResponse {
    pub intervals: Vec<[u64; 3]>,
    pub captures: Vec<String>,
    #[serde(rename = "baseLine")]
    pub base_line: u64,
}

/// 可视区行范围（serde rename 对齐前端驼峰契约；行号 0 起，与客户端
/// buildLineIndex/revealLine 的行号约定一致）。
#[derive(Debug, Copy, Clone, Deserialize, PartialEq, Eq)]
pub struct HighlightRange {
    #[serde(rename = "startLine")]
    pub start_line: u64,
    #[serde(rename = "lineCount")]
    pub line_count: u64,
}

#[derive(Deserialize)]
pub struct HighlightRequest {
    /// 服务端相对路径（走 guard；与 text 同时给出时优先 path）。
    #[serde(default)]
    pub path: Option<String>,
    /// 直接高亮的文本（≤ 20MB）。
    #[serde(default)]
    pub text: Option<String>,
    /// 语言名（queries 注册表键）。
    #[serde(default)]
    pub lang: Option<String>,
    /// 可视区行范围（仅 path 模式接受；缺省 = 整文件）。
    #[serde(default)]
    pub range: Option<HighlightRange>,
}

// ---------- 字节 → UTF-16 偏移转换 ----------

/// 按行增量表：每行行首一对（字节偏移 → UTF-16 偏移）映射点。
/// 查询时二分定位行，行内对该行内字符小步累加（单行长度即修正开销）。
pub struct Utf16Index {
    line_start_bytes: Vec<usize>,
    line_start_utf16: Vec<usize>,
}

impl Utf16Index {
    /// 单遍扫描文本建表：行首偏移 + 累计 UTF-16 长度（BMP 外字符计 2）。
    pub fn new(text: &str) -> Self {
        let mut line_start_bytes = vec![0usize];
        let mut line_start_utf16 = vec![0usize];
        let mut utf16 = 0usize;
        for (byte, ch) in text.char_indices() {
            if ch == '\n' {
                // \n 之后即下一行行首
                line_start_bytes.push(byte + 1);
                line_start_utf16.push(utf16 + 1);
            }
            utf16 += ch.len_utf16();
        }
        Self { line_start_bytes, line_start_utf16 }
    }

    /// 字节偏移 → UTF-16 代码单元偏移。`byte` 越界时按 clamp 处理，
    /// 非字符边界向下取整（tree-sitter 偏移理论上恒在边界上，防御性兜底）。
    pub fn to_utf16(&self, text: &str, byte: usize) -> usize {
        let mut byte = byte.min(text.len());
        while byte > 0 && !text.is_char_boundary(byte) {
            byte -= 1;
        }
        // 二分：最后一个 <= byte 的行首
        let line = self.line_start_bytes.partition_point(|&b| b <= byte) - 1;
        let line_start = self.line_start_bytes[line];
        let in_line: usize = text[line_start..byte].chars().map(char::len_utf16).sum();
        self.line_start_utf16[line] + in_line
    }
}

// ---------- 核心高亮 ----------

/// 对文本执行主语法高亮并产出紧凑响应（阻塞，调用方放 spawn_blocking）。
pub fn run_highlight(lang: &str, text: &str) -> Result<HighlightResponse, AppError> {
    let config = queries::config_ref(lang).ok_or_else(|| {
        AppError::bad_request(format!(
            "unsupported language: {lang} (supported: {:?})",
            queries::supported_languages()
        ))
    })?;

    let mut highlighter = Highlighter::new();
    let events = highlighter
        .highlight(
            &config,
            text.as_bytes(),
            None, // encoding：UTF-8 默认（0.27 新增参数，UTF-16LE/BE 显式传入才需要）
            None, // cancellation flag：响应侧超时即放弃结果（模块注释），无需协作取消
            |injected: &str| queries::config_ref(injected),
        )
        .map_err(|e| AppError::internal(format!("highlight query 执行失败: {e}")))?;

    let names = &*HIGHLIGHT_NAMES;
    let mut intervals: Vec<[u64; 3]> = Vec::new();
    let mut captures: Vec<String> = Vec::new();
    let mut stack: Vec<usize> = Vec::new();
    let index = Utf16Index::new(text);

    for event in events {
        let event = event.map_err(|e| AppError::internal(format!("highlight 迭代失败: {e}")))?;
        match event {
            HighlightEvent::HighlightStart(h) => stack.push(h.0),
            HighlightEvent::HighlightEnd => {
                stack.pop();
            }
            HighlightEvent::Source { start, end } => {
                // 仅取最内层捕获（嵌套时里层优先，与 helix/web 前端语义一致）
                let Some(&h) = stack.last() else { continue };
                let Some(name) = names.get(h) else { continue };
                if end <= start {
                    continue;
                }
                // 区间数上限：超限即断（惰性迭代器在此停止消费，解析不再推进）
                if intervals.len() >= MAX_INTERVALS {
                    return Err(AppError::payload_too_large(format!(
                        "highlight intervals exceed {MAX_INTERVALS}"
                    )));
                }
                let ci = match captures.iter().position(|n| n == name) {
                    Some(i) => i,
                    None => {
                        captures.push(name.clone());
                        captures.len() - 1
                    }
                };
                let s = index.to_utf16(text, start) as u64;
                let e = index.to_utf16(text, end) as u64;
                intervals.push([s, e, ci as u64]);
            }
        }
    }
    Ok(HighlightResponse { intervals, captures, base_line: 0 })
}

// ---------- path 模式响应缓存 ----------

/// 缓存键必须含 lang：同 (path,mtime,size) 换语言请求结果不同，
/// 缺 lang 会让不同语言互命中错误区间（review fix 1）。
/// 末两位 (start_line, line_count) 为 range 维度：无 range 用 (0, u64::MAX)
/// 占位——合法 lineCount ∈ 1..=[`MAX_RANGE_LINES`]，占位键与任何具体 range 键
/// 互不命中；缓存响应含 baseLine（= start_line），键不含 range 会互命中错基准。
type CacheKey = (PathBuf, u64, u64, String, u64, u64);

/// (path, mtime_ms, size) → 响应；HashMap + 访问序 VecDeque 的简易 LRU（64 条）。
struct CacheInner {
    entries: HashMap<CacheKey, Arc<HighlightResponse>>,
    order: VecDeque<CacheKey>,
}

pub struct HighlightCache {
    inner: Mutex<CacheInner>,
    hits: AtomicU64,
    misses: AtomicU64,
}

const CACHE_CAP: usize = 64;

static CACHE: Lazy<HighlightCache> = Lazy::new(|| HighlightCache {
    inner: Mutex::new(CacheInner { entries: HashMap::new(), order: VecDeque::new() }),
    hits: AtomicU64::new(0),
    misses: AtomicU64::new(0),
});

impl HighlightCache {
    fn get(&self, key: &CacheKey) -> Option<Arc<HighlightResponse>> {
        let mut inner = self.inner.lock().unwrap();
        let hit = inner.entries.get(key).cloned();
        if hit.is_some() {
            // LRU touch：移到访问序末尾
            if let Some(pos) = inner.order.iter().position(|k| k == key) {
                inner.order.remove(pos);
            }
            inner.order.push_back(key.clone());
            self.hits.fetch_add(1, Ordering::Relaxed);
        } else {
            self.misses.fetch_add(1, Ordering::Relaxed);
        }
        hit
    }

    fn insert(&self, key: CacheKey, resp: HighlightResponse) {
        // 超大响应跳过缓存（请求仍正常返回）：见 CACHE_MAX_INTERVALS 注释
        if resp.intervals.len() > CACHE_MAX_INTERVALS {
            return;
        }
        let mut inner = self.inner.lock().unwrap();
        if inner.entries.insert(key.clone(), Arc::new(resp)).is_none() {
            inner.order.push_back(key);
        }
        while inner.entries.len() > CACHE_CAP {
            let Some(evict) = inner.order.pop_front() else { break };
            inner.entries.remove(&evict);
        }
    }

    /// 条目数（测试断言用）。
    #[cfg(test)]
    fn len(&self) -> usize {
        self.inner.lock().unwrap().entries.len()
    }
}

/// 缓存命中/未命中计数（E2E 与集成测试观测钩子）。
#[doc(hidden)]
pub fn cache_stats() -> (u64, u64) {
    (CACHE.hits.load(Ordering::Relaxed), CACHE.misses.load(Ordering::Relaxed))
}

/// 清空缓存并归零计数（测试隔离用）。
#[doc(hidden)]
pub fn cache_reset() {
    CACHE.inner.lock().unwrap().entries.clear();
    CACHE.inner.lock().unwrap().order.clear();
    CACHE.hits.store(0, Ordering::Relaxed);
    CACHE.misses.store(0, Ordering::Relaxed);
}

// ---------- handler ----------

fn too_large(what: &str) -> Response {
    (
        StatusCode::PAYLOAD_TOO_LARGE,
        Json(serde_json::json!({
            "error": format!("{what} exceeds {}MB limit", HIGHLIGHT_MAX_BYTES / 1024 / 1024)
        })),
    )
        .into_response()
}

/// 解析任务的响应侧超时包装：deadline 内未完成 → 504（解析线程不中断，见模块注释）。
/// 独立函数便于测试注入永不完成的任务做确定性 504 断言。
async fn parse_with_timeout(
    timeout: Duration,
    handle: tokio::task::JoinHandle<Result<HighlightResponse, AppError>>,
) -> Result<HighlightResponse, Response> {
    match tokio::time::timeout(timeout, handle).await {
        Ok(Ok(Ok(resp))) => Ok(resp),
        Ok(Ok(Err(e))) => Err(e.into_response()),
        Ok(Err(join_err)) => Err(
            AppError::internal(format!("highlight task panicked: {join_err}")).into_response()
        ),
        Err(_) => Err(
            (
                StatusCode::GATEWAY_TIMEOUT,
                Json(serde_json::json!({
                    "error": format!(
                        "highlight timed out after {}ms (parsing thread finishes in background)",
                        timeout.as_millis()
                    )
                })),
            )
                .into_response(),
        ),
    }
}

/// mtime → epoch 毫秒（取不到则 0，仍参与键区分大小/路径）。
fn mtime_ms(meta: &std::fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// [`read_line_chunk`] 的结果：`Ok` 为 chunk 文本与实际行数（可少于请求，自然
/// 截断）；`StartBeyondEof` 携带文件实际行数（start_line ≥ 实际行数，含空文件）；
/// `TooLarge` 为 chunk 字节超 [`HIGHLIGHT_MAX_BYTES`]（handler 回 413，不截断）。
#[derive(Debug, PartialEq, Eq)]
enum ChunkRead {
    Ok { chunk: String, lines: u64 },
    StartBeyondEof { total: u64 },
    TooLarge,
}

/// 流式扫行（path+range 模式）：跳过 start_line 行后读至多 line_count 行，
/// `\n` join 为 chunk 文本——全程不整读文件，内存有界（range 模式因此不设
/// [`HIGHLIGHT_MAX_BYTES`] 文件大小上限，仅对产出 chunk 设同一上限）。
/// 行语义与 wc -l 同口径（以 `\n` 结尾的文件不计末尾空行），行号 0 起；末尾
/// 空行不参与 range 寻址（客户端 meta 行数同口径）。tokio `next_line` 剥离
/// `\r\n` 行尾，残留 `\r`（CR-only 文件、行内孤立 `\r`）由调用方对 chunk 文本
/// 沿用整文件路径的 `replace` 归一——两模式同源语义。
/// 返回：[`ChunkRead::Ok`]；[`ChunkRead::StartBeyondEof`] = start_line ≥ 实际
/// 行数；[`ChunkRead::TooLarge`] = chunk 超 [`HIGHLIGHT_MAX_BYTES`]；
/// `Err(io)` = 读文件失败（含非 UTF-8：`lines()` 产 InvalidData）。
async fn read_line_chunk(
    path: &std::path::Path,
    start_line: u64,
    line_count: u64,
) -> std::io::Result<ChunkRead> {
    use tokio::io::AsyncBufReadExt;
    let file = tokio::fs::File::open(path).await?;
    let mut lines = tokio::io::BufReader::new(file).lines();
    // chunk 字节预算（含 \n 分隔/行尾，按归一化后口径）：跳行与取行两阶段都计，
    // 每行读入后立即检查——超限即断（review fix：range 窗口不得无声超限；
    // 不截断——截断会让窗口无声缩水）。最小改动实现点：在 next_line 产出
    // String 后计数中断，不做 fill_buf 预检（单次超长行的分配不可避免）。
    let mut bytes: u64 = 0;
    let mut skipped: u64 = 0;
    while skipped < start_line {
        match lines.next_line().await? {
            Some(l) => {
                bytes += l.len() as u64 + 1;
                skipped += 1;
                if bytes > HIGHLIGHT_MAX_BYTES as u64 {
                    return Ok(ChunkRead::TooLarge);
                }
            }
            None => return Ok(ChunkRead::StartBeyondEof { total: skipped }),
        }
    }
    let mut chunk: Vec<String> = Vec::new();
    while (chunk.len() as u64) < line_count {
        match lines.next_line().await? {
            Some(l) => {
                bytes += l.len() as u64 + 1;
                chunk.push(l);
                if bytes > HIGHLIGHT_MAX_BYTES as u64 {
                    return Ok(ChunkRead::TooLarge);
                }
            }
            None => break, // 不足 line_count：越过文件尾，自然截断（200）
        }
    }
    if chunk.is_empty() {
        // line_count 已校验 ≥ 1：跳行成功但一行未得 = start_line 恰为总行数
        return Ok(ChunkRead::StartBeyondEof { total: start_line });
    }
    Ok(ChunkRead::Ok { chunk: chunk.join("\n"), lines: chunk.len() as u64 })
}

/// body `{path?, text?, lang, range?}` → `{intervals, captures, baseLine}`。
/// text/path 超 20MB → 413；区间数超 [`MAX_INTERVALS`] → 413；未知语言 → 400；
/// 解析超 10s → 504。path 模式区间数超 [`CACHE_MAX_INTERVALS`] 的响应不进缓存。
/// range 仅 path 模式接受（text+range → 400）；lineCount ∈ 1..=[`MAX_RANGE_LINES`]
/// 否则 400；startLine ≥ 文件实际行数（含空文件）→ 400 并报实际行数；lineCount
/// 越过文件尾 → 自然截断为实际行数（200）。
pub async fn highlight(State(state): State<AppState>, Json(req): Json<HighlightRequest>) -> Response {
    highlight_with_timeout(state, req, HIGHLIGHT_TIMEOUT).await
}

/// [`highlight`] 的可注入超时形态（504 自动化测试注入短 deadline；生产走
/// [`HIGHLIGHT_TIMEOUT`]）。响应侧保护语义见模块注释：不中断已进入同步解析的线程。
pub(crate) async fn highlight_with_timeout(
    state: AppState,
    req: HighlightRequest,
    timeout: Duration,
) -> Response {
    let Some(lang) = req.lang.as_deref().filter(|l| !l.is_empty()) else {
        return AppError::bad_request("missing lang").into_response();
    };
    if !queries::is_supported(lang) {
        return AppError::bad_request(format!(
            "unsupported language: {lang} (supported: {:?})",
            queries::supported_languages()
        ))
        .into_response();
    }

    // range 结构校验（先于模式分流）：仅 path 模式接受（text+range → 400）
    if let Some(range) = req.range {
        if range.line_count == 0 || range.line_count > MAX_RANGE_LINES {
            return AppError::bad_request(format!(
                "range.lineCount must be in 1..={MAX_RANGE_LINES}, got {}",
                range.line_count
            ))
            .into_response();
        }
        if req.path.as_deref().filter(|p| !p.is_empty()).is_none() {
            return AppError::bad_request(
                "range requires path mode (text + range is not supported)",
            )
            .into_response();
        }
    }

    // path 模式：guard 解析（400/403/404）→ 元数据 → 缓存查询 → 读文件/流式扫行
    let mut cache_key: Option<CacheKey> = None;
    let (text, base_line): (String, u64) =
        if let Some(path) = req.path.as_deref().filter(|p| !p.is_empty()) {
            let canonical = match crate::guard::resolve(&state, Some(path)).await {
                Ok(p) => p,
                Err(e) => return e.into_response(),
            };
            let meta = match tokio::fs::metadata(&canonical).await {
                Ok(m) if m.is_file() => m,
                Ok(_) => return AppError::bad_request("path is not a file").into_response(),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    return AppError::not_found("path not found").into_response()
                }
                Err(e) => return AppError::internal(e.to_string()).into_response(),
            };
            // 整文件模式保留 20MB 上限；range 模式流式扫行内存有界，不设上限
            if req.range.is_none() && meta.len() > HIGHLIGHT_MAX_BYTES as u64 {
                return too_large("file");
            }
            // LRU 键追加 range 维度（无 range 用 (0, u64::MAX) 占位，见 CacheKey 注释）
            let (start_line, line_count) = match req.range {
                Some(r) => (r.start_line, r.line_count),
                None => (0, u64::MAX),
            };
            let key =
                (canonical.clone(), mtime_ms(&meta), meta.len(), lang.to_string(), start_line, line_count);
            if let Some(cached) = CACHE.get(&key) {
                return Json(HighlightResponse::clone(&cached)).into_response();
            }
            let file_text: String = match req.range {
                Some(r) => match read_line_chunk(&canonical, r.start_line, r.line_count).await {
                    Ok(ChunkRead::Ok { chunk, .. }) => chunk,
                    // startLine ≥ 实际行数（含空文件）：400 携带实际行数
                    Ok(ChunkRead::StartBeyondEof { total }) => {
                        return AppError::bad_request(format!(
                            "range.startLine {} is beyond end of file: {} lines",
                            r.start_line, total
                        ))
                        .into_response()
                    }
                    // chunk 超 20MB（单行超长或多行累计）：413，与整文件路径同限
                    Ok(ChunkRead::TooLarge) => return too_large("chunk"),
                    Err(e) if e.kind() == std::io::ErrorKind::InvalidData => {
                        return AppError::bad_request("file is not valid UTF-8").into_response()
                    }
                    Err(e) => return AppError::internal(e.to_string()).into_response(),
                },
                None => {
                    let bytes = match tokio::fs::read(&canonical).await {
                        Ok(b) => b,
                        Err(e) => return AppError::internal(e.to_string()).into_response(),
                    };
                    match String::from_utf8(bytes) {
                        Ok(t) => t,
                        Err(_) => {
                            return AppError::bad_request("file is not valid UTF-8").into_response()
                        }
                    }
                }
            };
            cache_key = Some(key);
            let base_line = req.range.map_or(0, |r| r.start_line);
            (file_text, base_line)
        } else if let Some(text) = req.text {
            if text.len() > HIGHLIGHT_MAX_BYTES {
                return too_large("text");
            }
            (text, 0)
        } else {
            return AppError::bad_request("path or text is required").into_response();
        };

    // CRLF/CR → LF 归一化（final re-review 修复）：path 模式原样读文件、text 模式
    // 原样收文本，Utf16Index 会在含 \r 的原文上换算——\r 计入前一行长度，CRLF 文件
    // 的区间相对客户端（renderCode 解码后即归一化，apps/web highlightClient 只发
    // {path, lang}）整体右移。两模式统一在解析前归一，与客户端口径三方一致；
    // (canonical_path, mtime, size, range) 缓存键指向原文件元数据，不受归一化影响。
    // range 模式 chunk 同源处理：tokio 扫行已剥离 \r\n 行尾，此处的 replace 兜底
    // 行内孤立 \r 与 CR-only 文件——与整文件路径语义一致（流式扫行注释）。
    let text = text.replace("\r\n", "\n").replace('\r', "\n");

    // 同步解析：阻塞线程执行，响应侧超时（无法中断线程本身，见模块注释）
    let lang_owned = lang.to_string();
    let handle = tokio::task::spawn_blocking(move || run_highlight(&lang_owned, &text));
    let mut result = match parse_with_timeout(timeout, handle).await {
        Ok(resp) => resp,
        Err(response) => return response,
    };
    // range 模式：区间相对 chunk 首行（Utf16Index 以 chunk 文本建表，不做平移），
    // baseLine 告知客户端基准行；无 range/text 模式保持 0
    result.base_line = base_line;

    if let Some(key) = cache_key {
        CACHE.insert(key, result.clone());
    }
    Json(result).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 缓存计数断言与其他用例串行（全局静态缓存跨用例共享）。
    fn serial_lock() -> std::sync::MutexGuard<'static, ()> {
        static SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());
        SERIAL.lock().unwrap_or_else(|p| p.into_inner())
    }

    const RUST_SAMPLE: &str = r#"// 示例：emoji 😀 与中文混排
fn main() {
    let msg = "你好 world 😀";
    println!("{msg}");
}
"#;

    fn highlight_rust(text: &str) -> HighlightResponse {
        run_highlight("rust", text).expect("rust 高亮应成功")
    }

    #[test]
    fn rust_sample_yields_intervals_with_keyword_class_capture() {
        let resp = highlight_rust(RUST_SAMPLE);
        assert!(!resp.intervals.is_empty(), "区间非空");
        assert!(!resp.captures.is_empty(), "捕获表非空");
        // 存在 keyword 类捕获（fn/let 关键字）
        let has_keyword = resp.captures.iter().any(|c| {
            c == "keyword" || c.starts_with("keyword.")
        });
        assert!(has_keyword, "应含 keyword 类捕获: {:?}", resp.captures);
        // fn 关键字位置：第 2 行 "fn" —— 找到覆盖它的 keyword 区间
        let fn_byte = RUST_SAMPLE.find("fn main").unwrap();
        let idx = Utf16Index::new(RUST_SAMPLE);
        let fn_u16 = idx.to_utf16(RUST_SAMPLE, fn_byte) as u64;
        assert!(
            resp.intervals.iter().any(|&[s, e, ci]| s <= fn_u16 && fn_u16 + 2 <= e && {
                let cap = &resp.captures[ci as usize];
                cap == "keyword" || cap.starts_with("keyword.function") || cap.starts_with("keyword.")
            }),
            "fn 应有 keyword 区间: {:?}",
            resp.intervals
        );
    }

    #[test]
    fn intervals_are_utf16_offsets_and_monotonic() {
        let resp = highlight_rust(RUST_SAMPLE);
        let utf16_len = RUST_SAMPLE.encode_utf16().count() as u64;
        for &[s, e, _ci] in &resp.intervals {
            assert!(s < e, "左闭右开非空: {s},{e}");
            assert!(e <= utf16_len, "不越界: {e} > {utf16_len}");
        }
        // 区间按起始位置有序（tree-sitter 事件序）
        let starts: Vec<u64> = resp.intervals.iter().map(|i| i[0]).collect();
        let mut sorted = starts.clone();
        sorted.sort_unstable();
        assert_eq!(starts, sorted, "事件序应单调");
    }

    #[test]
    fn utf16_ascii_identity() {
        let text = "fn main() {}\nlet x = 1;\n";
        let idx = Utf16Index::new(text);
        for (b, _) in text.char_indices() {
            assert_eq!(idx.to_utf16(text, b), b, "ASCII 字节偏移即 UTF-16 偏移 @{b}");
        }
        assert_eq!(idx.to_utf16(text, text.len()), text.encode_utf16().count());
    }

    #[test]
    fn utf16_cjk_three_bytes_to_one_unit() {
        let text = "你好，世界"; // 全 3 字节 BMP 字符
        let idx = Utf16Index::new(text);
        assert_eq!(idx.to_utf16(text, 0), 0);
        assert_eq!(idx.to_utf16(text, 3), 1, "一个 CJK 字符 = 1 个 UTF-16 单元");
        assert_eq!(idx.to_utf16(text, 9), 3);
        assert_eq!(idx.to_utf16(text, text.len()), 5, "总长 5 个单元");
    }

    #[test]
    fn utf16_emoji_counts_as_surrogate_pair() {
        let text = "a😀b"; // 😀 = 4 字节 = 2 个 UTF-16 单元
        let idx = Utf16Index::new(text);
        assert_eq!(idx.to_utf16(text, 1), 1);
        assert_eq!(idx.to_utf16(text, 5), 3, "emoji 代理对 +2");
        assert_eq!(idx.to_utf16(text, 6), 4);
        assert_eq!(idx.to_utf16(text, text.len()), 4);
    }

    #[test]
    fn utf16_multiline_mixed_content() {
        let text = "fn main() {\n    let s = \"中文😀ok\";\n}\n";
        let idx = Utf16Index::new(text);
        // 第 2 行行首：第 1 行 "fn main() {\n" = 11 字节 = 11 单元
        assert_eq!(idx.to_utf16(text, 11), 11);
        // 第 3 行行首（跨 CJK + emoji 行累计）
        let line3 = text.find("}\n").unwrap();
        let expect = text[..line3].encode_utf16().count();
        assert_eq!(idx.to_utf16(text, line3), expect, "跨行累计按 UTF-16 计");
        // 每个字符边界上与逐步编码一致
        for (b, _) in text.char_indices() {
            assert_eq!(idx.to_utf16(text, b), text[..b].encode_utf16().count(), "@{b}");
        }
    }

    #[test]
    fn utf16_clamps_and_walks_back_to_boundary() {
        let text = "中文abc";
        let idx = Utf16Index::new(text);
        assert_eq!(idx.to_utf16(text, 2), 0, "中间字节向下取整到字符边界");
        assert_eq!(idx.to_utf16(text, 100), 5, "越界 clamp 到文本末尾");
    }

    #[test]
    fn unknown_language_400() {
        let err = run_highlight("nope", "x").unwrap_err();
        assert_eq!(err.0, StatusCode::BAD_REQUEST);
        assert!(err.1.contains("unsupported language"));
    }

    #[test]
    fn intervals_over_limit_returns_413() {
        // 重复行快速膨胀区间：先量 100 行的区间数（同构行区间数恒定），
        // 按比例放大到刚过 MAX_INTERVALS，避免盲目构造超大输入拖慢测试。
        let line = "let v = 1;\n";
        let per100 = run_highlight("rust", &line.repeat(100))
            .expect("样例高亮应成功")
            .intervals
            .len();
        assert!(per100 > 0, "样例行应产出区间");
        let big = line.repeat((MAX_INTERVALS / per100 + 2) * 100);
        let err = run_highlight("rust", &big).unwrap_err();
        assert_eq!(err.0, StatusCode::PAYLOAD_TOO_LARGE, "超限语义 413: {err}");
        assert!(err.1.contains("intervals"), "错误指明区间超限: {err}");
    }

    #[test]
    fn cache_skips_responses_over_interval_cap() {
        let _g = serial_lock();
        cache_reset();
        let key: CacheKey = (PathBuf::from("/tmp/huge.rs"), 1, 1, "rust".into(), 0, u64::MAX);
        // 超限响应：insert 静默跳过（请求侧仍正常返回，只是不占缓存）
        CACHE.insert(
            key.clone(),
            HighlightResponse {
                intervals: vec![[0, 1, 0]; CACHE_MAX_INTERVALS + 1],
                captures: vec![],
                base_line: 0,
            },
        );
        assert_eq!(CACHE.len(), 0, "超 50 万区间的响应不进缓存");
        // 未超限：正常入缓存
        CACHE.insert(
            key.clone(),
            HighlightResponse {
                intervals: vec![[0, 1, 0]; CACHE_MAX_INTERVALS],
                captures: vec![],
                base_line: 0,
            },
        );
        assert_eq!(CACHE.len(), 1, "阈值内正常缓存");
        assert!(CACHE.get(&key).is_some());
        cache_reset();
    }

    #[test]
    fn cache_hit_miss_and_lru_eviction() {
        let _g = serial_lock();
        cache_reset();
        let key: CacheKey = (PathBuf::from("/tmp/a.rs"), 1, 2, "rust".into(), 0, u64::MAX);
        assert!(CACHE.get(&key).is_none(), "未插入时 miss");
        for i in 0..(CACHE_CAP as u64) {
            CACHE.insert(
                (PathBuf::from(format!("/tmp/k{i}")), 0, i, "rust".into(), 0, u64::MAX),
                HighlightResponse { intervals: vec![], captures: vec![], base_line: 0 },
            );
        }
        assert_eq!(CACHE.len(), CACHE_CAP);
        // 命中 0 号把它移到队尾，插入新条目淘汰的应是 1 号而非 0 号
        let hit0 = CACHE
            .get(&(PathBuf::from("/tmp/k0"), 0, 0, "rust".into(), 0, u64::MAX))
            .is_some();
        assert!(hit0);
        CACHE.insert(
            (PathBuf::from("/tmp/new"), 0, 9, "rust".into(), 0, u64::MAX),
            HighlightResponse { intervals: vec![], captures: vec![], base_line: 0 },
        );
        assert_eq!(CACHE.len(), CACHE_CAP, "上限 64");
        assert!(
            CACHE.get(&(PathBuf::from("/tmp/k0"), 0, 0, "rust".into(), 0, u64::MAX)).is_some(),
            "LRU touch 后 0 号保留"
        );
        assert!(
            CACHE.get(&(PathBuf::from("/tmp/k1"), 0, 1, "rust".into(), 0, u64::MAX)).is_none(),
            "最久未用的 1 号被淘汰"
        );
        let (hits, misses) = cache_stats();
        assert!(hits >= 2 && misses >= 2, "计数观测: hits={hits} misses={misses}");
        cache_reset();
        assert_eq!(cache_stats(), (0, 0));
        assert_eq!(CACHE.len(), 0);
    }

    #[test]
    fn cache_key_includes_lang_same_path_no_cross_hit() {
        let _g = serial_lock();
        cache_reset();
        let path = PathBuf::from("/tmp/poly.gl");
        let rust_key: CacheKey = (path.clone(), 7, 100, "rust".into(), 0, u64::MAX);
        let py_key: CacheKey = (path.clone(), 7, 100, "python".into(), 0, u64::MAX);
        let rust_resp = HighlightResponse {
            intervals: vec![[0, 1, 0]],
            captures: vec!["keyword".into()],
            base_line: 0,
        };
        let py_resp = HighlightResponse {
            intervals: vec![[0, 2, 0]],
            captures: vec!["string".into()],
            base_line: 0,
        };
        CACHE.insert(rust_key.clone(), rust_resp.clone());
        // 同 (path,mtime,size) 换 lang：必须 miss，不命中 rust 的响应
        assert!(CACHE.get(&py_key).is_none(), "异 lang 不得互命中");
        CACHE.insert(py_key.clone(), py_resp.clone());
        assert_eq!(*CACHE.get(&rust_key).unwrap(), rust_resp, "rust 键仍是 rust 响应");
        assert_eq!(*CACHE.get(&py_key).unwrap(), py_resp, "python 键是 python 响应");
        cache_reset();
    }

    /// range 维度（Task 1）：无 range 的 (0, u64::MAX) 占位键与具体 range 键
    /// 互不命中——缓存响应含 baseLine，键不含 range 会互命中错基准。
    #[test]
    fn cache_key_range_dimension_no_cross_hit() {
        let _g = serial_lock();
        cache_reset();
        let whole: CacheKey = (PathBuf::from("/tmp/r.rs"), 1, 10, "rust".into(), 0, u64::MAX);
        let r03: CacheKey = (PathBuf::from("/tmp/r.rs"), 1, 10, "rust".into(), 0, 3);
        let whole_resp =
            HighlightResponse { intervals: vec![[0, 9, 0]], captures: vec![], base_line: 0 };
        let range_resp =
            HighlightResponse { intervals: vec![[0, 2, 0]], captures: vec![], base_line: 0 };
        CACHE.insert(whole.clone(), whole_resp.clone());
        assert!(CACHE.get(&r03).is_none(), "range 键不得命中无 range 条目");
        CACHE.insert(r03.clone(), range_resp.clone());
        assert_eq!(*CACHE.get(&whole).unwrap(), whole_resp, "无 range 键仍是整文件响应");
        cache_reset();
    }

    /// 流式扫行（Task 1）：中段取行、越过文件尾自然截断、start_line == 总行数
    /// 与空文件返回 StartBeyondEof(实际行数)、tokio next_line 剥离 \r\n 行尾。
    #[tokio::test]
    async fn read_line_chunk_skip_truncate_and_beyond_eof() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("chunk.txt");
        std::fs::write(&p, "l0\nl1\nl2\nl3\n").unwrap();
        // 中段：跳 1 取 2
        let ChunkRead::Ok { chunk, lines } = read_line_chunk(&p, 1, 2).await.unwrap() else {
            panic!("应为 Ok");
        };
        assert_eq!((chunk, lines), ("l1\nl2".to_string(), 2));
        // 越过文件尾：截断为实际行数
        let ChunkRead::Ok { chunk, lines } = read_line_chunk(&p, 2, 10).await.unwrap() else {
            panic!("应为 Ok");
        };
        assert_eq!((chunk, lines), ("l2\nl3".to_string(), 2));
        // start_line == 总行数（4）→ StartBeyondEof(4)；空文件 → StartBeyondEof(0)
        assert_eq!(
            read_line_chunk(&p, 4, 1).await.unwrap(),
            ChunkRead::StartBeyondEof { total: 4 }
        );
        let empty = dir.path().join("empty.txt");
        std::fs::write(&empty, "").unwrap();
        assert_eq!(
            read_line_chunk(&empty, 0, 3).await.unwrap(),
            ChunkRead::StartBeyondEof { total: 0 }
        );
        // \r\n 行尾在扫描期剥离：chunk 与 LF 版本逐字节一致（孤立 \r 由调用方
        // replace 兜底，与整文件路径同源）
        let crlf = dir.path().join("crlf.txt");
        std::fs::write(&crlf, "a\r\nb\r\n").unwrap();
        let ChunkRead::Ok { chunk, lines } = read_line_chunk(&crlf, 0, 5).await.unwrap() else {
            panic!("应为 Ok");
        };
        assert_eq!((chunk, lines), ("a\nb".to_string(), 2));
    }
    /// 504 自动化（终审 M6：超时路径此前无测试）：注入永不完成的解析任务 + 200ms
    /// deadline + 挂钟暂停——advance 越过 deadline 后超时分支确定触发，不依赖
    /// 真实解析耗时（直接 2.6MB 解析与 advance 的真实调度窗口存在竞态，不可靠）；
    /// 同时锁定报错文案携带真实 deadline（动态化后的格式回归）。
    #[tokio::test(start_paused = true)]
    async fn parse_timeout_returns_504_with_injected_deadline() {
        let handle =
            tokio::spawn(std::future::pending::<Result<HighlightResponse, AppError>>());
        let task = tokio::spawn(parse_with_timeout(Duration::from_millis(200), handle));
        tokio::time::advance(Duration::from_secs(1)).await; // 虚拟时钟越过 200ms deadline
        let err = task.await.unwrap().unwrap_err();
        assert_eq!(err.status(), StatusCode::GATEWAY_TIMEOUT);
        let bytes = axum::body::to_bytes(err.into_body(), usize::MAX).await.unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert!(
            v["error"].as_str().unwrap().contains("timed out after 200ms"),
            "报错应携带注入的 deadline: {v}"
        );
    }
}
