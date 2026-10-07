//! `POST /api/search`：ripgrep 跨文件搜索，NDJSON 流式响应。
//!
//! 裁决（M6）：search 属 file-server 基础能力——挂在 Bearer 组内但不要求
//! `--compute`；ripgrep 缺失时 501（前端据此降级为浏览器内 grep）。
//!
//! 实现链路：spawn `rg --json`（PATH 探测，`state.rg_path` 可覆盖）→ 逐行解析
//! match 事件 → 转 NDJSON 帧下发；上限 1000 命中即 kill 子进程并下发截断终帧；
//! 客户端断连（响应 body 被 drop → channel 发送失败）→ kill 子进程。
//!
//! 参数实测（rg 15.2）：`--max-count 50` 按文件压命中行数；`--max-filesize 2M`
//! 跳过超限文件；`--sort path` 输出顺序确定；`--no-ignore` 与文件树可见性对齐
//! （不尊重 .gitignore）；`state.hidden` 时追加 `--hidden` 与树同步展示 dot 条目；
//! pattern 一律经 `-e` 传入（防 `-` 开头 pattern 被解析为 flag）；字面量默认
//! `-F`，`regex: true` 用 rg 默认正则引擎。

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
/// 每文件命中行数上限（--max-count）。
const RG_MAX_COUNT: &str = "50";
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
}

/// PATH 探测首个可执行的 `rg`；找不到返回 None（→ 501）。
pub fn probe_rg() -> Option<String> {
    let paths = std::env::var_os("PATH")?;
    let exe = if cfg!(windows) { "rg.exe" } else { "rg" };
    for dir in std::env::split_paths(&paths) {
        let candidate = dir.join(exe);
        if is_executable(&candidate) {
            return Some(candidate.to_string_lossy().into_owned());
        }
    }
    None
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
fn rg_args(req: &SearchRequest, hidden: bool) -> Vec<String> {
    let mut args = vec![
        "--json".to_string(),
        "--max-count".to_string(),
        RG_MAX_COUNT.to_string(),
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

pub async fn search(State(state): State<AppState>, Json(req): Json<SearchRequest>) -> Response {
    if req.pattern.is_empty() {
        return AppError::bad_request("pattern must not be empty").into_response();
    }
    if req.pattern.chars().count() > MAX_PATTERN_CHARS {
        return AppError::bad_request("pattern too long (max 256 chars)").into_response();
    }

    // 搜索目录：复用 guard（清洗 + canonicalize + 越界 403）
    let dir = match guard::resolve(&state, req.path.as_deref()).await {
        Ok(d) => d,
        Err(e) => return e.into_response(),
    };

    let Some(rg) = state.rg_path.clone().or_else(probe_rg) else {
        return AppError::not_implemented(
            "cross-file search unavailable: ripgrep (rg) not found on server",
        )
        .into_response();
    };

    let mut command = Command::new(&rg);
    command
        .args(rg_args(&req, state.hidden))
        .arg(&dir)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true); // 兜底：pump 任务整体被 drop 时也要杀掉子进程
    let mut child = match command.spawn() {
        Ok(c) => c,
        // 注入路径不存在 / 可执行文件缺失：等同 rg 不可用
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return AppError::not_implemented(format!(
                "cross-file search unavailable: failed to spawn rg ({e})"
            ))
            .into_response();
        }
        Err(e) => return AppError::internal(format!("failed to spawn rg: {e}")).into_response(),
    };

    let stdout: ChildStdout = child.stdout.take().expect("rg stdout must be piped");
    let stderr: ChildStderr = child.stderr.take().expect("rg stderr must be piped");

    let (tx, rx) = mpsc::channel::<Result<String, std::io::Error>>(FRAME_CHANNEL);
    let pump_handle =
        tokio::spawn(pump(child, stdout, stderr, state.root_canonical.clone(), tx, SEARCH_TIMEOUT));
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

/// 读取 rg --json 输出并下发 NDJSON 帧；客户端断连 / 截断 / 墙钟超时均 kill 子进程。
/// `timeout` 为整个读循环的总 deadline（生产 SEARCH_TIMEOUT，测试注入短时限）。
pub(crate) async fn pump(
    mut child: Child,
    stdout: ChildStdout,
    stderr: ChildStderr,
    root_canonical: PathBuf,
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
            let Ok(frame) = serde_json::from_str::<Value>(&line) else {
                continue; // 非 JSON 行（理论上没有）：跳过
            };
            if frame.get("type").and_then(Value::as_str) != Some("match") {
                continue; // 简化：只发 match 帧 + 终帧（begin/end 丢弃）
            }
            if sent >= MAX_MATCHES {
                // 恰好 1000 时不能立即判截断（可能 rg 已无更多命中），
                // 继续读到出现第 1001 个 match 才算 truncated
                truncated = true;
                break;
            }
            let Some(payload) = match_frame(&frame, &root_canonical) else {
                continue; // 二进制文件（lines.bytes）等无文本帧：跳过
            };
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

/// rg match 事件 → NDJSON 命中帧字符串；无法提取文本（二进制帧等）返回 None。
fn match_frame(frame: &Value, root_canonical: &Path) -> Option<String> {
    let data = frame.get("data")?;
    let path_text = data.get("path")?.get("text")?.as_str()?;
    let line_no = data.get("line_number")?.as_u64()?;
    let line_text = data.get("lines")?.get("text")?.as_str()?;
    let submatch = data.get("submatches")?.as_array()?.first()?;
    let start = submatch.get("start")?.as_u64()? as usize;

    // rg 回显的是我们传入的目录（canonical 绝对路径）：剥掉 root 得相对路径，
    // 统一 `/` 分隔（Windows 反斜杠归一）
    let abs = Path::new(path_text);
    let rel = abs.strip_prefix(root_canonical).unwrap_or(abs);
    let rel = rel.to_string_lossy().replace('\\', "/");

    // rg 的 submatch start 是行内字节偏移：换算 1 起「字符」列（多字节安全）
    let col = line_text
        .get(..start.min(line_text.len()))
        .map(|prefix| prefix.chars().count() + 1)
        .unwrap_or(1);

    let text = line_text.trim_end_matches(['\n', '\r']);
    let preview: String = text.chars().take(PREVIEW_MAX_CHARS).collect();
    // NDJSON：帧自带换行分隔（Body 逐 chunk 写出，不补分隔符）
    Some(format!("{}\n", json!({ "file": rel, "line": line_no, "col": col, "text": preview })))
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
        };
        let args = rg_args(&req, false);
        assert!(args.contains(&"-i".to_string()));
        assert!(args.contains(&"-F".to_string()));
        assert!(!args.contains(&"--hidden".to_string()));
        // pattern 经 -e 传入，防 '-' 开头被当 flag
        let e = args.iter().position(|a| a == "-e").unwrap();
        assert_eq!(args[e + 1], "needle");
    }

    #[test]
    fn rg_args_regex_case_sensitive_glob_hidden() {
        let req = SearchRequest {
            pattern: "n.e+".into(),
            glob: Some("*.rs".into()),
            case_sensitive: true,
            regex: true,
            path: None,
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
        };
        assert!(!rg_args(&req, false).contains(&"-g".to_string()));
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
        let out: Value = serde_json::from_str(&match_frame(&frame, root).unwrap()).unwrap();
        assert_eq!(out["file"], "sub/b.rs");
        assert_eq!(out["line"], 3);
        assert_eq!(out["col"], 7);
        assert_eq!(out["text"], "const needle = 1;");
    }

    #[test]
    fn match_frame_col_counts_chars_not_bytes() {
        let root = Path::new("/tmp/root");
        // "中文needle"：n 的字节偏移 6，字符列 3
        let frame = sample_match("/tmp/root/zh.txt", 1, "中文needle\n", 6);
        let out: Value = serde_json::from_str(&match_frame(&frame, root).unwrap()).unwrap();
        assert_eq!(out["col"], 3);
        assert_eq!(out["text"], "中文needle");
    }

    #[test]
    fn match_frame_truncates_long_lines_on_char_boundary() {
        let root = Path::new("/tmp/root");
        let long = "中".repeat(500);
        let frame = sample_match("/tmp/root/a.txt", 1, &format!("{long}\n"), 0);
        let out: Value = serde_json::from_str(&match_frame(&frame, root).unwrap()).unwrap();
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
        assert!(match_frame(&frame, Path::new("/tmp/root")).is_none());
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
            dir.path().to_path_buf(),
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
            dir.path().to_path_buf(),
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
            dir.path().to_path_buf(),
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
}
