//! `POST /api/compute/highlight`（Task 3）：tree-sitter 服务端主语法高亮。
//!
//! 裁剪（M6 计划级裁决）：服务端 v1 无 injection——只做主语法高亮，injection
//! 回调恒 None；markdown 围栏等注入场景由前端本地高亮兜底（policy=local）。
//!
//! 关键点：
//! - tree-sitter 节点偏移是 UTF-8 字节偏移，前端区间是 UTF-16 代码单元偏移，
//!   响应前经 [`Utf16Index`]（按行增量表 + 二分定位 + 行内小步修正）转换；
//! - path 模式走 [`crate::guard`]（canonicalize 越界校验）并按
//!   `(canonical_path, mtime_ms, size)` 缓存响应（64 条 LRU 简易淘汰）；
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
use tree_sitter_highlight::{HighlightConfiguration, HighlightEvent, Highlighter};

use crate::compute::queries::{self, HIGHLIGHT_NAMES};
use crate::error::AppError;
use crate::state::AppState;

/// text/path 输入上限（UTF-8 字节）：超限 413。
pub const HIGHLIGHT_MAX_BYTES: usize = 20 * 1024 * 1024;

/// 区间数上限：超过即 413（防御病态输入——UTF-16 转换与 JSON 序列化都是
/// O(intervals)，2M 区间远超正常源文件的必要精度，放行会拖垮内存与响应）。
pub const MAX_INTERVALS: usize = 2_000_000;

/// 缓存准入上限：区间数超过它的响应不进缓存（单条数十 MB，会迅速挤掉
/// 64 条 LRU 里的全部常规条目，命中率归零）。
pub const CACHE_MAX_INTERVALS: usize = 500_000;

/// 同步解析的响应侧超时：超限放弃等待返回 504（见模块注释：不中断线程）。
pub const HIGHLIGHT_TIMEOUT: Duration = Duration::from_secs(10);

/// 响应体：区间三元组（UTF-16 起止偏移 + 捕获名索引，左闭右开）。
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct HighlightResponse {
    pub intervals: Vec<[u64; 3]>,
    pub captures: Vec<String>,
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
    let config: Arc<HighlightConfiguration> = queries::config(lang).ok_or_else(|| {
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
            |_: &str| {
                None::<&HighlightConfiguration> // v1 无 injection（模块注释）
            },
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
    Ok(HighlightResponse { intervals, captures })
}

// ---------- path 模式响应缓存 ----------

/// 缓存键必须含 lang：同 (path,mtime,size) 换语言请求结果不同，
/// 缺 lang 会让不同语言互命中错误区间（review fix 1）。
type CacheKey = (PathBuf, u64, u64, String);

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

/// body `{path?, text?, lang}` → `{intervals, captures}`。
/// text/path 超 20MB → 413；区间数超 [`MAX_INTERVALS`] → 413；未知语言 → 400；
/// 解析超 10s → 504。path 模式区间数超 [`CACHE_MAX_INTERVALS`] 的响应不进缓存。
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

    // path 模式：guard 解析（400/403/404）→ 元数据 → 缓存查询 → 读文件
    let mut cache_key: Option<CacheKey> = None;
    let text: String = if let Some(path) = req.path.as_deref().filter(|p| !p.is_empty()) {
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
        if meta.len() > HIGHLIGHT_MAX_BYTES as u64 {
            return too_large("file");
        }
        let key = (canonical.clone(), mtime_ms(&meta), meta.len(), lang.to_string());
        if let Some(cached) = CACHE.get(&key) {
            return Json(HighlightResponse::clone(&cached)).into_response();
        }
        let bytes = match tokio::fs::read(&canonical).await {
            Ok(b) => b,
            Err(e) => return AppError::internal(e.to_string()).into_response(),
        };
        cache_key = Some(key);
        match String::from_utf8(bytes) {
            Ok(t) => t,
            Err(_) => return AppError::bad_request("file is not valid UTF-8").into_response(),
        }
    } else if let Some(text) = req.text {
        if text.len() > HIGHLIGHT_MAX_BYTES {
            return too_large("text");
        }
        text
    } else {
        return AppError::bad_request("path or text is required").into_response();
    };

    // CRLF/CR → LF 归一化（final re-review 修复）：path 模式原样读文件、text 模式
    // 原样收文本，Utf16Index 会在含 \r 的原文上换算——\r 计入前一行长度，CRLF 文件
    // 的区间相对客户端（renderCode 解码后即归一化，apps/web highlightClient 只发
    // {path, lang}）整体右移。两模式统一在解析前归一，与客户端口径三方一致；
    // (canonical_path, mtime, size) 缓存键指向原文件元数据，不受归一化影响。
    let text = text.replace("\r\n", "\n").replace('\r', "\n");

    // 同步解析：阻塞线程执行，响应侧超时（无法中断线程本身，见模块注释）
    let lang_owned = lang.to_string();
    let handle = tokio::task::spawn_blocking(move || run_highlight(&lang_owned, &text));
    let result = match parse_with_timeout(timeout, handle).await {
        Ok(resp) => resp,
        Err(response) => return response,
    };

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
        let key: CacheKey = (PathBuf::from("/tmp/huge.rs"), 1, 1, "rust".into());
        // 超限响应：insert 静默跳过（请求侧仍正常返回，只是不占缓存）
        CACHE.insert(
            key.clone(),
            HighlightResponse { intervals: vec![[0, 1, 0]; CACHE_MAX_INTERVALS + 1], captures: vec![] },
        );
        assert_eq!(CACHE.len(), 0, "超 50 万区间的响应不进缓存");
        // 未超限：正常入缓存
        CACHE.insert(
            key.clone(),
            HighlightResponse { intervals: vec![[0, 1, 0]; CACHE_MAX_INTERVALS], captures: vec![] },
        );
        assert_eq!(CACHE.len(), 1, "阈值内正常缓存");
        assert!(CACHE.get(&key).is_some());
        cache_reset();
    }

    #[test]
    fn cache_hit_miss_and_lru_eviction() {
        let _g = serial_lock();
        cache_reset();
        let key: CacheKey = (PathBuf::from("/tmp/a.rs"), 1, 2, "rust".into());
        assert!(CACHE.get(&key).is_none(), "未插入时 miss");
        for i in 0..(CACHE_CAP as u64) {
            CACHE.insert(
                (PathBuf::from(format!("/tmp/k{i}")), 0, i, "rust".into()),
                HighlightResponse { intervals: vec![], captures: vec![] },
            );
        }
        assert_eq!(CACHE.len(), CACHE_CAP);
        // 命中 0 号把它移到队尾，插入新条目淘汰的应是 1 号而非 0 号
        let hit0 = CACHE.get(&(PathBuf::from("/tmp/k0"), 0, 0, "rust".into())).is_some();
        assert!(hit0);
        CACHE.insert(
            (PathBuf::from("/tmp/new"), 0, 9, "rust".into()),
            HighlightResponse { intervals: vec![], captures: vec![] },
        );
        assert_eq!(CACHE.len(), CACHE_CAP, "上限 64");
        assert!(
            CACHE.get(&(PathBuf::from("/tmp/k0"), 0, 0, "rust".into())).is_some(),
            "LRU touch 后 0 号保留"
        );
        assert!(
            CACHE.get(&(PathBuf::from("/tmp/k1"), 0, 1, "rust".into())).is_none(),
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
        let rust_key: CacheKey = (path.clone(), 7, 100, "rust".into());
        let py_key: CacheKey = (path.clone(), 7, 100, "python".into());
        let rust_resp =
            HighlightResponse { intervals: vec![[0, 1, 0]], captures: vec!["keyword".into()] };
        let py_resp = HighlightResponse { intervals: vec![[0, 2, 0]], captures: vec!["string".into()] };
        CACHE.insert(rust_key.clone(), rust_resp.clone());
        // 同 (path,mtime,size) 换 lang：必须 miss，不命中 rust 的响应
        assert!(CACHE.get(&py_key).is_none(), "异 lang 不得互命中");
        CACHE.insert(py_key.clone(), py_resp.clone());
        assert_eq!(*CACHE.get(&rust_key).unwrap(), rust_resp, "rust 键仍是 rust 响应");
        assert_eq!(*CACHE.get(&py_key).unwrap(), py_resp, "python 键是 python 响应");
        cache_reset();
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
