//! `POST /api/search`：ripgrep 跨文件搜索，NDJSON 流式响应。
//!
//! 裁决（M6）：search 属 file-server 基础能力——挂在 Bearer 组内但不要求
//! `--compute`；rg 与 grep 皆缺时 501（前端据此降级为浏览器内 grep；仅 rg
//! 缺失时服务端自动降级 grep）。
//!
//! 实现链路：spawn `rg --json`（PATH 探测，`state.rg_path` 可覆盖）→ 逐行解析
//! match 事件 → 转 NDJSON 帧下发；上限 1000 命中即 kill 子进程并下发截断终帧；
//! 客户端断连（响应 body 被 drop → channel 发送失败）→ kill 子进程。
//!
//! 参数实测（rg 15.2）：`--max-filesize 2M` 跳过超限文件；`--sort path` 输出顺序
//! 确定；`--no-ignore` 与文件树可见性对齐（不尊重 .gitignore）；`state.hidden` 时
//! 追加 `--hidden` 与树同步展示 dot 条目；pattern 一律经 `-e` 传入（防 `-` 开头
//! pattern 被解析为 flag）；字面量默认 `-F`，`regex: true` 用 rg 默认正则引擎。
//! 单文件命中数不设限（BUG-57，2026-10-17）：`--max-count 50`（grep 路径 `-m`）
//! 曾把单文件命中行静默压到 50 且终帧无任何信号，与纯前端 grepStoreLocal（全局
//! 1000 命中上限 + truncated 终帧）双路径不一致——现放开单文件上限，截断语义
//! 统一由 pump 的 MAX_MATCHES（1000，`truncated: true` 终帧）承担。
//!
//! A 项降级链：rg 缺失时自动 fallback 系统 grep——参数映射/`--null` 行协议/
//! 已知差异（无 filesize 跳过、顺序不保证、ERE、col=1）见 `grep_args`/`grep_frame`；
//! health 据同一选择链宣告 `searchEngine`。
//!
//! workspace 多根：`root` 参数缺省 = 跨全部根（目录参数逐根追加，命中帧带
//! `"root": <idx>`）；`root=Some(i)` = 限定单根（多根下此时才允许携带 path，
//! 帧无 root 字段与单根部署同形状）。

use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::time::Duration;

use axum::body::Body;
use axum::extract::State;
use axum::response::{IntoResponse, Response};
use axum::Json;
use futures_core::Stream;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, ChildStderr, ChildStdout, Command};
use tokio::sync::mpsc;

use crate::error::AppError;
use crate::guard;
use crate::state::AppState;

/// 命中数上限：达到后 kill rg 并下发 `truncated: true` 终帧。
pub const MAX_MATCHES: usize = 1000;
/// pattern 最大字符数。
pub const MAX_PATTERN_CHARS: usize = 256;
/// 预览行文本最大字符数（按 Unicode 标量值截断，不劈多字节字符）。
pub const PREVIEW_MAX_CHARS: usize = 200;
/// 跳过的文件大小上限（--max-filesize；rg 的 M = MiB）。
const RG_MAX_FILESIZE: &str = "2M";
/// rg 搜索总墙钟上限：防子进程挂起导致 pump 永久 await（进程+任务泄漏），
/// 也给断连 kill 的延迟设上界。生产 60s；单测以 200ms 注入验证超时路径。
const SEARCH_TIMEOUT: Duration = Duration::from_secs(60);
/// channel 缓冲： rg 产出快于客户端消费时的背压水位。
const FRAME_CHANNEL: usize = 64;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchRequest {
    pub pattern: String,
    #[serde(default)]
    pub glob: Option<String>,
    #[serde(default)]
    pub case_sensitive: bool,
    #[serde(default)]
    pub regex: bool,
    #[serde(default)]
    pub path: Option<String>,
    /// 限定根索引（workspace 多根，0 起）：None = 跨全部根搜索；Some(i) = 仅第
    /// i 根（此时 path 相对该根）。多根部署下 None+path 因无基准根 400；
    /// 单根部署沿用历史形状（path 相对 0 号根，无需显式 root）。
    #[serde(default)]
    pub root: Option<usize>,
}

/// 跨文件搜索引擎：rg 主路径，grep 降级路径（A 项 fallback）。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum SearchEngine {
    Rg,
    Grep,
}

impl SearchEngine {
    pub(crate) fn name(self) -> &'static str {
        match self {
            SearchEngine::Rg => "rg",
            SearchEngine::Grep => "grep",
        }
    }
}

/// PATH 探测首个可执行文件；找不到返回 None（Windows 补 .exe 后缀）。
pub fn probe(exe: &str) -> Option<String> {
    let paths = std::env::var_os("PATH")?;
    let exe = if cfg!(windows) { format!("{exe}.exe") } else { exe.to_string() };
    for dir in std::env::split_paths(&paths) {
        let candidate = dir.join(&exe);
        if is_executable(&candidate) {
            return Some(candidate.to_string_lossy().into_owned());
        }
    }
    None
}

/// 兼容旧调用（rg_available 守卫等）。
pub fn probe_rg() -> Option<String> {
    probe("rg")
}

/// 单引擎解析（覆盖语义见 state.rs 字段注释）。
fn resolve_one(over: Option<&str>, exe: &str, engine: SearchEngine) -> Option<(SearchEngine, String)> {
    match over {
        None => probe(exe).map(|p| (engine, p)),
        Some(p) if is_executable(Path::new(p)) => Some((engine, p.to_string())),
        Some(_) => None, // 显式注入但不可执行：该引擎不可用，跳过（模拟缺失）
    }
}

/// 引擎选择链：rg 覆盖/探测 → grep 覆盖/探测 → 双缺 501。
pub(crate) fn resolve_engine(state: &AppState) -> Result<(SearchEngine, String), AppError> {
    if let Some(found) = resolve_one(state.rg_path.as_deref(), "rg", SearchEngine::Rg) {
        return Ok(found);
    }
    if let Some(found) = resolve_one(state.grep_path.as_deref(), "grep", SearchEngine::Grep) {
        return Ok(found);
    }
    Err(AppError::not_implemented(
        "cross-file search unavailable: neither ripgrep (rg) nor grep found on server",
    ))
}

#[cfg(unix)]
fn is_executable(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(p)
        .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable(p: &Path) -> bool {
    std::fs::metadata(p).map(|m| m.is_file()).unwrap_or(false)
}

/// 组装 rg 参数（不含 rg 程序路径与搜索目录，便于单测断言）。
/// 单文件命中数不设限（BUG-57）：无 --max-count，截断统一由 MAX_MATCHES 承担。
fn rg_args(req: &SearchRequest, hidden: bool) -> Vec<String> {
    let mut args = vec![
        "--json".to_string(),
        "--max-filesize".to_string(),
        RG_MAX_FILESIZE.to_string(),
        "--sort".to_string(),
        "path".to_string(),
        "--no-ignore".to_string(),
        "--no-messages".to_string(),
    ];
    if hidden {
        args.push("--hidden".to_string());
    }
    if let Some(glob) = req.glob.as_deref().filter(|g| !g.is_empty()) {
        args.push("-g".to_string());
        args.push(glob.to_string());
    }
    if !req.case_sensitive {
        args.push("-i".to_string());
    }
    if !req.regex {
        args.push("-F".to_string());
    }
    args.push("-e".to_string());
    args.push(req.pattern.clone());
    args
}

/// 组装 grep 参数（rg 缺失 fallback，A 项）。行格式 `path\0line:content`。
/// 已知差异（spec §2.2）：无 --max-filesize（全读，60s 墙钟+命中上限兜底）、
/// 无 --sort path（顺序不保证）、regex 走 ERE 方言、无列号（col 恒 1）。
/// `hidden` 无对应开关：grep -r 天然含 dot 条目、不读 ignore。
/// --include 仅按 basename 匹配 glob（rg -g 对相对路径全程匹配），含 / 的 glob 在 grep 下语义不同；
/// BSD grep 的 --include 为全路径匹配（* 跨 /），含 / 的 glob 两端行为不同。
fn grep_args(req: &SearchRequest, hidden: bool) -> Vec<String> {
    let _ = hidden;
    // 单文件命中数不设限（BUG-57 同 rg 路径）：无 -m，截断统一由 MAX_MATCHES 承担。
    let mut args = vec![
        // 长选项强制：短参 -Z 在 GNU grep 是 --null、BSD grep 是 --decompress
        "--null".to_string(),
        "-rHn".to_string(),
        "-s".to_string(),
        "-I".to_string(),
    ];
    if let Some(glob) = req.glob.as_deref().filter(|g| !g.is_empty()) {
        args.push(format!("--include={glob}"));
    }
    if !req.case_sensitive {
        args.push("-i".to_string());
    }
    if req.regex {
        args.push("-E".to_string());
    } else {
        args.push("-F".to_string());
    }
    args.push("-e".to_string());
    args.push(req.pattern.clone());
    args
}

pub async fn search(State(state): State<AppState>, Json(req): Json<SearchRequest>) -> Response {
    if req.pattern.is_empty() {
        return AppError::bad_request("pattern must not be empty").into_response();
    }
    if req.pattern.chars().count() > MAX_PATTERN_CHARS {
        return AppError::bad_request("pattern too long (max 256 chars)").into_response();
    }

    // 多根歧义防护：未显式指定根时 path 无基准根（单根部署无歧义，沿用历史形状）
    if req.root.is_none() && req.path.is_some() && state.roots.len() > 1 {
        return AppError::bad_request("path requires an explicit root").into_response();
    }

    // 搜索目录：root=Some(i) → 该根（path 相对该根，复用 guard 清洗 + canonicalize
    // + 越界 403）；root=None → 跨根，目录 = 全部根逐个追加（rg/grep 均支持多目录；
    // 单根部署带 path 时 path 相对 0 号根——历史形状，多根带 path 已在上方 400）
    let dirs: Vec<PathBuf> = match req.root {
        Some(i) => {
            let dir = match guard::resolve_at(&state, req.path.as_deref(), i).await {
                Ok(d) => d,
                Err(e) => return e.into_response(),
            };
            vec![dir]
        }
        None => match req.path.as_deref() {
            Some(path) => {
                let dir = match guard::resolve_at(&state, Some(path), 0).await {
                    Ok(d) => d,
                    Err(e) => return e.into_response(),
                };
                vec![dir]
            }
            None => state.roots.iter().map(|r| r.canonical.clone()).collect(),
        },
    };

    // handler 返回 Response 而非 Result，? 不可用：与 guard::resolve 同款 match 展开
    let (engine, bin) = match resolve_engine(&state) {
        Ok(found) => found,
        Err(e) => return e.into_response(),
    };

    let args = match engine {
        SearchEngine::Rg => rg_args(&req, state.hidden),
        SearchEngine::Grep => grep_args(&req, state.hidden),
    };
    let mut command = Command::new(&bin);
    command
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true); // 兜底：pump 任务整体被 drop 时也要杀掉子进程
    // 根目录参数逐个追加（跨根 = 多目录单进程；rg/grep 对多目录语义一致）
    for dir in &dirs {
        command.arg(dir);
    }
    let mut child = match command.spawn() {
        Ok(c) => c,
        // 探测与 spawn 之间文件被移除（TOCTOU 窗口）：等同引擎不可用
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return AppError::not_implemented(format!(
                "cross-file search unavailable: failed to spawn {} ({e})",
                engine.name()
            ))
            .into_response();
        }
        Err(e) => {
            return AppError::internal(format!("failed to spawn {}: {e}", engine.name()))
                .into_response()
        }
    };

    let stdout: ChildStdout = child.stdout.take().expect("rg stdout must be piped");
    let stderr: ChildStderr = child.stderr.take().expect("rg stderr must be piped");

    let (tx, rx) = mpsc::channel::<Result<String, std::io::Error>>(FRAME_CHANNEL);
    // 根感知解析：限定单根（或部署单根）时解析器只见一个根——命中帧无 root 字段，
    // 与历史单根形状逐字节一致；跨根时携带全部根，命中帧按命中根附 root 索引。
    // 防御式取根：root 越界本应被 guard::resolve_at 前置 400，这里不再依赖该
    // 顺序耦合（直接索引 panic 会绕过 handler 的错误应答通道）。文案走
    // guard::root_out_of_range 单一事实源（WSX 观察 1：两处曾不一致且本分支不可达）
    let parser_roots: Vec<PathBuf> = match req.root {
        Some(i) => match state.roots.get(i) {
            Some(r) => vec![r.canonical.clone()],
            None => return guard::root_out_of_range(i).into_response(),
        },
        None => state.roots.iter().map(|r| r.canonical.clone()).collect(),
    };
    let parser = match engine {
        SearchEngine::Rg => FrameParser::Rg { roots: parser_roots },
        SearchEngine::Grep => FrameParser::Grep { roots: parser_roots },
    };
    let pump_handle = tokio::spawn(pump(child, stdout, stderr, parser, tx, SEARCH_TIMEOUT));
    // 结局观测（tracing debug 级）：读取 outcome 字段同时消除 test-only 字段告警
    tokio::spawn(async move {
        if let Ok(outcome) = pump_handle.await {
            tracing::debug!(
                client_gone = outcome.client_gone,
                truncated = outcome.truncated,
                rg_error = ?outcome.rg_error,
                "search stream ended"
            );
        }
    });

    Response::builder()
        .header("content-type", "application/x-ndjson")
        .header("cache-control", "no-store")
        .body(Body::from_stream(ReceiverStream { rx }))
        .expect("static response builder")
}

/// pump 的结果（单测断言用）：client_gone = 客户端断连（已 kill 子进程）。
pub(crate) struct PumpOutcome {
    pub client_gone: bool,
    pub truncated: bool,
    pub rg_error: Option<String>,
}

/// 引擎感知的行解析：None = 跳过该行（rg 非 match 事件/二进制帧、grep 畸形行）。
/// `roots` 为参与搜索的根（canonical）列表：长度 >1 时命中帧携带 `"root": <idx>`。
pub(crate) enum FrameParser {
    Rg { roots: Vec<PathBuf> },
    Grep { roots: Vec<PathBuf> },
}

impl FrameParser {
    fn frame(&self, line: &str) -> Option<String> {
        match self {
            FrameParser::Rg { roots } => {
                let v = serde_json::from_str::<Value>(line).ok()?;
                if v.get("type").and_then(Value::as_str) != Some("match") {
                    return None;
                }
                match_frame(&v, roots)
            }
            FrameParser::Grep { roots } => grep_frame(line, roots),
        }
    }
}

/// 读取引擎子进程输出并经解析器下发 NDJSON 帧；客户端断连 / 截断 / 墙钟超时均
/// kill 子进程。`timeout` 为整个读循环的总 deadline（生产 SEARCH_TIMEOUT，测试注入短时限）。
pub(crate) async fn pump(
    mut child: Child,
    stdout: ChildStdout,
    stderr: ChildStderr,
    parser: FrameParser,
    tx: mpsc::Sender<Result<String, std::io::Error>>,
    timeout: Duration,
) -> PumpOutcome {
    // stderr 转后台收集（rg 写完即退出，不会阻塞 stdout 解析）
    let stderr_task = tokio::spawn(async move {
        let mut out = String::new();
        let mut reader = BufReader::new(stderr);
        let _ = tokio::io::AsyncReadExt::read_to_string(&mut reader, &mut out).await;
        out
    });

    let mut lines = BufReader::new(stdout).lines();
    let mut sent = 0usize;
    let mut truncated = false;

    // 整个读循环包总 deadline：rg 挂起（stdout 永不关闭）时 kill 而非永久 await，
    // 客户端断连的 kill 延迟随之有界（--sort path 串行输出下尤其重要）
    enum LoopExit {
        StreamEnd,
        ClientGone,
    }
    let exited = tokio::time::timeout(timeout, async {
        while let Ok(Some(line)) = lines.next_line().await {
            let Some(payload) = parser.frame(&line) else {
                continue; // 非 match 事件 / 二进制帧 / 畸形行：跳过，不参与截断判定
            };
            if sent >= MAX_MATCHES {
                // 恰好 1000 时不能立即判截断（可能 rg 已无更多命中）；
                // 继续读到出现第 1001 个「可下发」match 才算 truncated
                //（判定放在 payload 提取之后：二进制帧不计入，避免误报截断）
                truncated = true;
                break;
            }
            if tx.send(Ok(payload)).await.is_err() {
                // 客户端断连（响应 body 被 drop）：杀子进程，不再发终帧
                let _ = child.kill().await;
                let _ = child.wait().await;
                return LoopExit::ClientGone;
            }
            sent += 1;
        }
        LoopExit::StreamEnd
    })
    .await;

    match exited {
        Err(_) => {
            // 墙钟超时：kill 子进程并下发 error 终帧（消费端可见的超时语义）
            let _ = child.kill().await;
            let _ = child.wait().await;
            let done = json!({ "done": true, "truncated": false, "error": "search timeout" });
            let _ = tx.send(Ok(format!("{}\n", done))).await;
            return PumpOutcome {
                client_gone: false,
                truncated: false,
                rg_error: Some("search timeout".to_string()),
            };
        }
        Ok(LoopExit::ClientGone) => {
            return PumpOutcome { client_gone: true, truncated: false, rg_error: None };
        }
        Ok(LoopExit::StreamEnd) => {}
    }

    let rg_error = if truncated {
        let _ = child.kill().await;
        let _ = child.wait().await;
        None
    } else {
        match child.wait().await {
            // rg 约定：0 = 有命中，1 = 无命中，其余 = 出错（如非法正则）
            Ok(status) if matches!(status.code(), Some(c) if c != 0 && c != 1) => {
                let msg = stderr_task.await.unwrap_or_default();
                let msg = msg.lines().last().unwrap_or("rg failed").trim().to_string();
                Some(msg.chars().take(300).collect::<String>())
            }
            _ => None,
        }
    };

    let mut done = json!({ "done": true, "truncated": truncated });
    if let Some(err) = &rg_error {
        done["error"] = Value::String(err.clone());
    }
    let _ = tx.send(Ok(format!("{}\n", done))).await;
    PumpOutcome { client_gone: false, truncated, rg_error }
}

/// 逐根尝试剥绝对路径前缀：命中即返回 (相对路径, 根索引)。全不中时回退
/// (原路径, 0)（与历史单根 `unwrap_or(abs)` 行为一致；正常链路 rg/grep 回显的
/// 就是传入目录，不会走到回退）。嵌套根（根 B 在根 A 内）按索引序首个命中为准。
fn strip_root<'a>(abs: &'a Path, roots: &[PathBuf]) -> (&'a Path, usize) {
    for (i, root) in roots.iter().enumerate() {
        if let Ok(rel) = abs.strip_prefix(root) {
            return (rel, i);
        }
    }
    (abs, 0)
}

/// rg match 事件 → NDJSON 命中帧字符串；无法提取文本（二进制帧等）返回 None。
/// 跨根（roots.len() > 1）时命中帧携带命中根索引 `"root": <idx>`（0 起）。
fn match_frame(frame: &Value, roots: &[PathBuf]) -> Option<String> {
    let data = frame.get("data")?;
    let path_text = data.get("path")?.get("text")?.as_str()?;
    let line_no = data.get("line_number")?.as_u64()?;
    let line_text = data.get("lines")?.get("text")?.as_str()?;
    let submatch = data.get("submatches")?.as_array()?.first()?;
    let start = submatch.get("start")?.as_u64()? as usize;

    // rg 回显的是我们传入的目录（canonical 绝对路径）：逐根剥前缀得相对路径
    // 与命中根索引，统一 `/` 分隔（Windows 反斜杠归一）
    let abs = Path::new(path_text);
    let (rel, root_idx) = strip_root(abs, roots);
    let rel = rel.to_string_lossy().replace('\\', "/");

    // rg 的 submatch start 是行内字节偏移：换算 1 起 UTF-16 码元列（与前端 JS
    // 字符串索引同一约定；BMP 内与字符数一致，增补平面字符按 2 计）
    let col = line_text
        .get(..start.min(line_text.len()))
        .map(|prefix| prefix.encode_utf16().count() + 1)
        .unwrap_or(1);

    let text = line_text.trim_end_matches(['\n', '\r']);
    let preview: String = text.chars().take(PREVIEW_MAX_CHARS).collect();
    // NDJSON：帧自带换行分隔（Body 逐 chunk 写出，不补分隔符）
    let mut out = json!({ "file": rel, "line": line_no, "col": col, "text": preview });
    if roots.len() > 1 {
        out["root"] = json!(root_idx);
    }
    Some(format!("{}\n", out))
}

/// grep `--null -rHn` 输出行 `path\0line:content` → NDJSON 命中帧；畸形行 None。
/// NUL 分隔文件名与行内容（文件名含冒号安全）；行号后首个冒号切出内容
/// （内容含冒号无歧义）。grep 无列号：col 恒 1（spec §2.3 裁决）。
/// 跨根语义与 [`match_frame`] 一致（帧携带 `"root": <idx>`）。
fn grep_frame(line: &str, roots: &[PathBuf]) -> Option<String> {
    let (path_text, rest) = line.split_once('\0')?;
    let (line_no_raw, content) = rest.split_once(':')?;
    let line_no: u64 = line_no_raw.parse().ok()?;

    let abs = Path::new(path_text);
    let (rel, root_idx) = strip_root(abs, roots);
    let rel = rel.to_string_lossy().replace('\\', "/");

    let text: String = content.chars().take(PREVIEW_MAX_CHARS).collect();
    let mut out = json!({ "file": rel, "line": line_no, "col": 1, "text": text });
    if roots.len() > 1 {
        out["root"] = json!(root_idx);
    }
    Some(format!("{}\n", out))
}

/// mpsc Receiver → Stream 适配（tokio 未开 stream feature，手写避免新依赖）。
/// 响应 body 被 drop 时 Receiver 随之 drop，pump 的 send 失败即触发 kill。
struct ReceiverStream {
    rx: mpsc::Receiver<Result<String, std::io::Error>>,
}

impl Stream for ReceiverStream {
    type Item = Result<String, std::io::Error>;

    fn poll_next(
        mut self: Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Self::Item>> {
        self.rx.poll_recv(cx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---------- rg_args ----------

    #[test]
    fn rg_args_defaults_are_literal_and_insensitive() {
        let req = SearchRequest {
            pattern: "needle".into(),
            glob: None,
            case_sensitive: false,
            regex: false,
            path: None,
            root: None,
        };
        let args = rg_args(&req, false);
        assert!(args.contains(&"-i".to_string()));
        assert!(args.contains(&"-F".to_string()));
        assert!(!args.contains(&"--hidden".to_string()));
        // pattern 经 -e 传入，防 '-' 开头被当 flag
        let e = args.iter().position(|a| a == "-e").unwrap();
        assert_eq!(args[e + 1], "needle");
    }

    /// BUG-57：单文件命中数不设限——rg 无 --max-count、grep 无 -m；截断语义
    /// 统一由 pump 的 MAX_MATCHES（终帧 truncated:true）承担。
    #[test]
    fn rg_grep_args_have_no_per_file_count_cap() {
        let req = SearchRequest {
            pattern: "x".into(),
            glob: None,
            case_sensitive: false,
            regex: false,
            path: None,
            root: None,
        };
        let rg = rg_args(&req, false);
        assert!(!rg.contains(&"--max-count".to_string()), "rg 不得带 --max-count: {rg:?}");
        let grep = grep_args(&req, false);
        assert!(!grep.contains(&"-m".to_string()), "grep 不得带 -m: {grep:?}");
    }

    #[test]
    fn rg_args_regex_case_sensitive_glob_hidden() {
        let req = SearchRequest {
            pattern: "n.e+".into(),
            glob: Some("*.rs".into()),
            case_sensitive: true,
            regex: true,
            path: None,
            root: None,
        };
        let args = rg_args(&req, true);
        assert!(!args.contains(&"-i".to_string()));
        assert!(!args.contains(&"-F".to_string()));
        assert!(args.contains(&"--hidden".to_string()));
        let g = args.iter().position(|a| a == "-g").unwrap();
        assert_eq!(args[g + 1], "*.rs");
    }

    #[test]
    fn rg_args_empty_glob_is_ignored() {
        let req = SearchRequest {
            pattern: "x".into(),
            glob: Some(String::new()),
            case_sensitive: false,
            regex: false,
            path: None,
            root: None,
        };
        assert!(!rg_args(&req, false).contains(&"-g".to_string()));
    }

    // ---------- grep_args ----------

    #[test]
    fn grep_args_defaults_are_literal_and_insensitive() {
        let req = SearchRequest {
            pattern: "needle".into(),
            glob: None,
            case_sensitive: false,
            regex: false,
            path: None,
            root: None,
        };
        let args = grep_args(&req, false);
        // 行格式协议：NUL 分隔（长选项——-Z 在 BSD grep 是 decompress）
        for a in ["--null", "-rHn", "-s", "-I", "-i", "-F", "-e", "needle"] {
            assert!(args.contains(&a.to_string()), "缺参数 {a}: {args:?}");
        }
        // NUL 必须长选项，禁短参
        assert!(!args.contains(&"-Z".to_string()));
    }

    #[test]
    fn grep_args_regex_case_sensitive_glob() {
        let req = SearchRequest {
            pattern: "n.e+".into(),
            glob: Some("*.rs".into()),
            case_sensitive: true,
            regex: true,
            path: None,
            root: None,
        };
        let args = grep_args(&req, true);
        assert!(!args.contains(&"-i".to_string()));
        assert!(!args.contains(&"-F".to_string()));
        assert!(args.contains(&"-E".to_string()), "regex 模式用 ERE");
        assert!(args.contains(&"--include=*.rs".to_string()));
    }

    #[test]
    fn grep_args_empty_glob_is_ignored() {
        let req = SearchRequest {
            pattern: "x".into(),
            glob: Some(String::new()),
            case_sensitive: false,
            regex: false,
            path: None,
            root: None,
        };
        assert!(!grep_args(&req, false).iter().any(|a| a.starts_with("--include")));
    }

    // ---------- match_frame ----------

    fn sample_match(path: &str, line: u64, line_text: &str, start: u64) -> Value {
        serde_json::json!({
            "type": "match",
            "data": {
                "path": { "text": path },
                "line_number": line,
                "lines": { "text": line_text },
                "submatches": [{ "match": { "text": "needle" }, "start": start, "end": start + 6 }]
            }
        })
    }

    #[test]
    fn match_frame_maps_fields_and_relative_path() {
        let root = Path::new("/tmp/root");
        let frame = sample_match("/tmp/root/sub/b.rs", 3, "const needle = 1;\n", 6);
        let out: Value = serde_json::from_str(&match_frame(&frame, &[root.to_path_buf()]).unwrap()).unwrap();
        assert_eq!(out["file"], "sub/b.rs");
        assert_eq!(out["line"], 3);
        assert_eq!(out["col"], 7);
        assert_eq!(out["text"], "const needle = 1;");
    }

    #[test]
    fn match_frame_col_counts_utf16_units() {
        let root = Path::new("/tmp/root");
        // BMP 中文："中文needle" 的 n 字节偏移 6，UTF-16 码元列 3（与字符数一致）
        let frame = sample_match("/tmp/root/zh.txt", 1, "中文needle\n", 6);
        let out: Value = serde_json::from_str(&match_frame(&frame, &[root.to_path_buf()]).unwrap()).unwrap();
        assert_eq!(out["col"], 3);
        assert_eq!(out["text"], "中文needle");
        // 增补平面（😀 = 4 字节 / 1 字符 / 2 UTF-16 码元）：字符计会得 2，UTF-16 计得 3
        let frame = sample_match("/tmp/root/emoji.txt", 1, "\u{1F600}needle\n", 4);
        let out: Value = serde_json::from_str(&match_frame(&frame, &[root.to_path_buf()]).unwrap()).unwrap();
        assert_eq!(out["col"], 3);
    }

    #[test]
    fn match_frame_truncates_long_lines_on_char_boundary() {
        let root = Path::new("/tmp/root");
        let long = "中".repeat(500);
        let frame = sample_match("/tmp/root/a.txt", 1, &format!("{long}\n"), 0);
        let out: Value = serde_json::from_str(&match_frame(&frame, &[root.to_path_buf()]).unwrap()).unwrap();
        let text = out["text"].as_str().unwrap();
        assert_eq!(text.chars().count(), PREVIEW_MAX_CHARS);
    }

    #[test]
    fn match_frame_skips_binary_frames() {
        let frame = serde_json::json!({
            "type": "match",
            "data": {
                "path": { "text": "/tmp/root/bin.dat" },
                "line_number": 1,
                "lines": { "bytes": "AAECAw==" },
                "submatches": [{ "start": 0, "end": 6 }]
            }
        });
        assert!(match_frame(&frame, &[PathBuf::from("/tmp/root")]).is_none());
    }

    // ---------- grep_frame ----------

    #[test]
    fn grep_frame_parses_nul_line_format() {
        let root = Path::new("/tmp/root");
        let line = "/tmp/root/sub/a.rs\012:const needle = 1;";
        let out: Value = serde_json::from_str(&grep_frame(line, &[root.to_path_buf()]).unwrap()).unwrap();
        assert_eq!(out["file"], "sub/a.rs");
        assert_eq!(out["line"], 12);
        assert_eq!(out["col"], 1, "grep 无列号，恒 1");
        assert_eq!(out["text"], "const needle = 1;");
    }

    #[test]
    fn grep_frame_colon_in_path_and_content_is_safe() {
        let root = Path::new("/tmp/root");
        // 文件名含冒号（NUL 分隔保护）与内容含冒号（首个冒号后全为内容）
        let line = "/tmp/root/we:ird.txt\01:the:rest: here";
        let out: Value = serde_json::from_str(&grep_frame(line, &[root.to_path_buf()]).unwrap()).unwrap();
        assert_eq!(out["file"], "we:ird.txt");
        assert_eq!(out["line"], 1);
        assert_eq!(out["text"], "the:rest: here");
    }

    #[test]
    fn grep_frame_utf8_content_and_preview_truncation() {
        let root = Path::new("/tmp/root");
        let out: Value = serde_json::from_str(
            &grep_frame("/tmp/root/zh.txt\01:中文needle", &[root.to_path_buf()]).unwrap(),
        )
        .unwrap();
        assert_eq!(out["text"], "中文needle");
        let long = "中".repeat(500);
        let out: Value = serde_json::from_str(
            &grep_frame(&format!("/tmp/root/l\01:{long}"), &[root.to_path_buf()]).unwrap(),
        )
        .unwrap();
        assert_eq!(out["text"].as_str().unwrap().chars().count(), PREVIEW_MAX_CHARS);
    }

    #[test]
    fn grep_frame_malformed_lines_are_skipped() {
        let root = Path::new("/tmp/root");
        assert!(grep_frame("no nul at all", &[root.to_path_buf()]).is_none());
        assert!(grep_frame("/p\0not-a-number:content", &[root.to_path_buf()]).is_none());
        assert!(grep_frame("/p\0", &[root.to_path_buf()]).is_none());
    }

    // ---------- 多根根感知：逐根剥前缀 + 帧 root 字段 ----------

    /// 跨根：按命中根剥前缀并记索引（帧带 root）；单根：形状不变、无 root 字段。
    #[test]
    fn match_frame_tags_root_index_across_roots_and_omits_when_single() {
        let roots = [PathBuf::from("/tmp/r0"), PathBuf::from("/tmp/r1")];
        let frame = sample_match("/tmp/r1/a.txt", 1, "needle\n", 0);
        let out: Value = serde_json::from_str(&match_frame(&frame, &roots).unwrap()).unwrap();
        assert_eq!(out["file"], "a.txt");
        assert_eq!(out["root"], 1, "跨根命中帧应带命中根索引");

        let frame = sample_match("/tmp/r0/b.txt", 1, "needle\n", 0);
        let out: Value = serde_json::from_str(&match_frame(&frame, &roots).unwrap()).unwrap();
        assert_eq!(out["file"], "b.txt");
        assert_eq!(out["root"], 0);

        // 单根（部署单根或 root=Some 限定）：同一路径形状不变、无 root 字段
        let out: Value = serde_json::from_str(&match_frame(&frame, &roots[..1]).unwrap()).unwrap();
        assert_eq!(out["file"], "b.txt");
        assert!(out.get("root").is_none(), "单根帧不应有 root 字段");
    }

    #[test]
    fn grep_frame_tags_root_index_across_roots() {
        let roots = [PathBuf::from("/tmp/r0"), PathBuf::from("/tmp/r1")];
        let line = "/tmp/r1/sub/a.rs\012:needle";
        let out: Value = serde_json::from_str(&grep_frame(line, &roots).unwrap()).unwrap();
        assert_eq!(out["file"], "sub/a.rs");
        assert_eq!(out["root"], 1);
        let out: Value = serde_json::from_str(&grep_frame(line, &roots[..1]).unwrap()).unwrap();
        assert!(out.get("root").is_none(), "单根帧不应有 root 字段");
    }

    // ---------- probe_rg ----------

    #[test]
    fn probe_rg_finds_executable_or_none() {
        // 有 rg 时返回以 rg 结尾的路径；没有则 None（都不应 panic）
        match probe_rg() {
            Some(p) => assert!(p.ends_with("rg")),
            None => {}
        }
    }

    // ---------- resolve_engine ----------

    /// 与 health 测试同款的轻量 state（root 仅作 watcher 基准，不参与断言）。
    fn test_state() -> AppState {
        AppState::new(PathBuf::from("."), None, None, false, None)
    }

    #[test]
    #[cfg(unix)] // /bin/sh 仅 unix 恒存在
    fn resolve_engine_prefers_executable_rg_path_override() {
        // /bin/sh 恒存在且可执行：验证「Some(可执行) → 直接绑定 rg」
        let state = test_state().with_rg_path(Some("/bin/sh".to_string()));
        let (engine, path) = resolve_engine(&state).unwrap();
        assert_eq!(engine, SearchEngine::Rg);
        assert_eq!(path, "/bin/sh");
    }

    #[test]
    fn resolve_engine_missing_rg_path_falls_back_to_grep() {
        // Some(不可执行) = rg 不可用（跳过 rg 探测）→ 降级 grep 链
        let grep = probe("grep").expect("测试环境需要系统 grep");
        let state = test_state()
            .with_rg_path(Some("/nonexistent/rg-for-test".to_string()))
            .with_grep_path(Some(grep.clone()));
        let (engine, path) = resolve_engine(&state).unwrap();
        assert_eq!(engine, SearchEngine::Grep);
        assert_eq!(path, grep);
    }

    #[test]
    fn resolve_engine_both_unavailable_is_err() {
        let state = test_state()
            .with_rg_path(Some("/nonexistent/rg-for-test".to_string()))
            .with_grep_path(Some("/nonexistent/grep-for-test".to_string()));
        assert!(resolve_engine(&state).is_err());
    }

    // ---------- 取消：客户端断连 → kill 子进程 ----------

    #[tokio::test]
    async fn pump_kills_child_when_receiver_dropped() {
        let Some(rg) = probe_rg() else {
            return; // 环境无 rg：跳过
        };
        let dir = tempfile::tempdir().unwrap();
        let content: String = "needle here\n".repeat(200);
        std::fs::write(dir.path().join("a.txt"), &content).unwrap();

        let mut child = Command::new(&rg)
            .args(["--json", "--no-ignore", "--no-messages", "-e", "needle"])
            .arg(dir.path())
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();

        let (tx, mut rx) = mpsc::channel::<Result<String, std::io::Error>>(4);
        let handle = tokio::spawn(pump(
            child,
            stdout,
            stderr,
            FrameParser::Rg { roots: vec![dir.path().to_path_buf()] },
            tx,
            std::time::Duration::from_secs(60),
        ));

        // 收 2 帧后丢弃接收端（模拟客户端断连）→ pump 应杀子进程收尾
        let mut got = 0;
        while let Some(item) = rx.recv().await {
            if item.is_ok() {
                got += 1;
            }
            if got >= 2 {
                break;
            }
        }
        drop(rx);
        let outcome = handle.await.unwrap();
        assert!(outcome.client_gone, "断连后 pump 应报告 client_gone（即已 kill）");
    }

    // ---------- 墙钟超时：kill 挂起子进程 + error 终帧 ----------

    /// 真 rg 挂起难以稳定模拟：以 `sh -c "exec sleep 30"` 充当假 rg
    /// （stdout 挂起不关闭，exec 使 kill 直接命中进程），deadline 注入 200ms。
    #[cfg(unix)]
    #[tokio::test]
    async fn pump_timeout_kills_child_and_emits_error_frame() {
        let dir = tempfile::tempdir().unwrap();
        let mut child = Command::new("sh")
            .args(["-c", "exec sleep 30"])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();

        let (tx, mut rx) = mpsc::channel::<Result<String, std::io::Error>>(4);
        let started = std::time::Instant::now();
        let handle = tokio::spawn(pump(
            child,
            stdout,
            stderr,
            FrameParser::Grep { roots: vec![dir.path().to_path_buf()] },
            tx,
            std::time::Duration::from_millis(200),
        ));

        let outcome = handle.await.unwrap();
        assert_eq!(outcome.rg_error.as_deref(), Some("search timeout"));
        assert!(!outcome.truncated);
        assert!(!outcome.client_gone);
        // 在 deadline 附近收尾（远小于 sleep 30），子进程已被 kill
        assert!(started.elapsed() < std::time::Duration::from_secs(10));
        // 终帧携带 error 字段，消费端可见超时语义
        let done = rx.recv().await.expect("超时终帧必须发出").unwrap();
        let v: Value = serde_json::from_str(done.trim()).unwrap();
        assert_eq!(v["done"], true);
        assert_eq!(v["truncated"], false);
        assert_eq!(v["error"], "search timeout");
        // 终帧之后流结束
        assert!(rx.recv().await.is_none());
    }

    // ---------- 截断：恰好 1000 命中不算截断 ----------

    #[tokio::test]
    async fn pump_exact_1000_matches_is_not_truncated() {
        let Some(rg) = probe_rg() else {
            return;
        };
        let dir = tempfile::tempdir().unwrap();
        // 20 文件 × 50 行 = 恰好 1000（--max-count 50）
        for i in 0..20 {
            let content: String = "needle line\n".repeat(50);
            std::fs::write(dir.path().join(format!("f{i:02}.txt")), content).unwrap();
        }
        let mut child = Command::new(&rg)
            .args([
                "--json",
                "--max-count",
                "50",
                "--sort",
                "path",
                "--no-ignore",
                "--no-messages",
                "-e",
                "needle",
            ])
            .arg(dir.path())
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();

        let (tx, mut rx) = mpsc::channel::<Result<String, std::io::Error>>(256);
        let handle = tokio::spawn(pump(
            child,
            stdout,
            stderr,
            FrameParser::Rg { roots: vec![dir.path().to_path_buf()] },
            tx,
            std::time::Duration::from_secs(60),
        ));

        let mut frames = Vec::new();
        while let Some(Ok(line)) = rx.recv().await {
            frames.push(line);
        }
        let outcome = handle.await.unwrap();
        assert!(!outcome.truncated);
        let hits = frames[..frames.len() - 1].len();
        assert_eq!(hits, 1000);
        let done: Value = serde_json::from_str(frames.last().unwrap()).unwrap();
        assert_eq!(done["truncated"], false);
    }

    /// 1000 个文本命中之后再遇到二进制文件的 match 帧（lines.bytes）：
    /// 二进制帧不下发也不得计入截断判定（判定在 payload 提取之后），
    /// 恰 1000 个可下发命中依旧不算截断。
    #[tokio::test]
    async fn pump_binary_match_after_1000_does_not_report_truncated() {
        let Some(rg) = probe_rg() else {
            return;
        };
        let dir = tempfile::tempdir().unwrap();
        // 20 文件 × 50 行 = 恰好 1000 个文本命中（--max-count 50）
        for i in 0..20 {
            let content: String = "needle line\n".repeat(50);
            std::fs::write(dir.path().join(format!("f{i:02}.txt")), content).unwrap();
        }
        // 二进制文件（含 NUL）：rg 以 lines.bytes 回显命中，match_frame 提取不到文本
        std::fs::write(dir.path().join("bin.dat"), b"needle\x00tail\n").unwrap();
        let mut child = Command::new(&rg)
            .args([
                "--json",
                "--max-count",
                "50",
                "--sort",
                "path",
                "--no-ignore",
                "--no-messages",
                "-e",
                "needle",
            ])
            .arg(dir.path())
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();

        let (tx, mut rx) = mpsc::channel::<Result<String, std::io::Error>>(256);
        let handle = tokio::spawn(pump(
            child,
            stdout,
            stderr,
            FrameParser::Rg { roots: vec![dir.path().to_path_buf()] },
            tx,
            std::time::Duration::from_secs(60),
        ));

        let mut frames = Vec::new();
        while let Some(Ok(line)) = rx.recv().await {
            frames.push(line);
        }
        let outcome = handle.await.unwrap();
        assert!(!outcome.truncated, "二进制帧不应计入截断判定");
        let hits = frames[..frames.len() - 1].len();
        assert_eq!(hits, 1000, "二进制命中帧不应下发");
        let done: Value = serde_json::from_str(frames.last().unwrap()).unwrap();
        assert_eq!(done["truncated"], false);
    }

    // ---------- pump 走 grep 引擎全链路（真子进程） ----------

    #[cfg(unix)]
    #[tokio::test]
    async fn pump_grep_streams_match_frames_and_done() {
        let Some(grep) = probe("grep") else {
            return; // 环境无 grep：跳过
        };
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), "needle here\nno\n").unwrap();
        std::fs::write(dir.path().join("b.txt"), "中文needle\n").unwrap();

        let mut child = Command::new(&grep)
            .args(["--null", "-rHn", "-s", "-I", "-e", "needle"])
            .arg(dir.path())
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();

        let parser = FrameParser::Grep { roots: vec![dir.path().to_path_buf()] };
        let (tx, mut rx) = mpsc::channel::<Result<String, std::io::Error>>(8);
        let handle = tokio::spawn(pump(
            child,
            stdout,
            stderr,
            parser,
            tx,
            std::time::Duration::from_secs(60),
        ));

        let mut frames = Vec::new();
        while let Some(Ok(line)) = rx.recv().await {
            frames.push(line);
        }
        let outcome = handle.await.unwrap();
        assert!(!outcome.truncated);
        assert!(outcome.rg_error.is_none(), "grep 退出码 0/1 均非错误");
        let hits: Vec<Value> = frames[..frames.len() - 1]
            .iter()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        assert!(frames.last().is_some(), "必须有终帧");
        let done: Value = serde_json::from_str(frames.last().unwrap()).unwrap();
        assert_eq!(done["done"], true);
        assert_eq!(hits.len(), 2);
        let a = hits.iter().find(|h| h["file"] == "a.txt").unwrap();
        assert_eq!(a["line"], 1);
        assert_eq!(a["col"], 1);
        assert_eq!(a["text"], "needle here");
        let b = hits.iter().find(|h| h["file"] == "b.txt").unwrap();
        assert_eq!(b["text"], "中文needle");
    }
}
