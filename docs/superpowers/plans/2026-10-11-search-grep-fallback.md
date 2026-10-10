# rg 缺失自动 fallback grep 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** rg 缺失时服务端 `/api/search` 自动降级系统 grep，health 宣告实际引擎，NDJSON 协议与前端消费逻辑不变。

**Architecture:** `search.rs` 引入 `SearchEngine` 枚举与统一引擎选择链（rg 覆盖 → PATH rg → grep 覆盖 → PATH grep → 501）；pump 读循环抽出引擎感知的 `FrameParser`（rg --json 事件 / grep `--null` 行两种解析共享超时/截断/断连骨架）；health 新增 `searchEngine` 字段；前端仅加引擎徽标（新缓存模块）。

**Tech Stack:** Rust（axum + tokio 子进程，无新依赖）；Svelte 5 + TypeScript（前端展示层）。

**Spec:** `docs/superpowers/specs/2026-10-11-search-grep-fallback-design.md`

## Global Constraints

- NDJSON 协议不变：命中帧 `{file,line,col,text}` + 终帧 `{done,truncated,error?}`，帧形状逐字段与 rg 路径一致。
- grep 参数必须用长选项 `--null`（短参 `-Z` 在 BSD grep 是 `--decompress`）；`-rHn -s -I`。
- grep 路径 col 恒为 1；rg 路径列换算逻辑不动。
- 退出码语义 0=命中/1=无命中/2=出错，两引擎一致，pump 判定共享。
- `MAX_MATCHES=1000`、`SEARCH_TIMEOUT=60s`、`PREVIEW_MAX_CHARS=200`、相对路径剥 root、UTF-16 列约定全部复用现状。
- 注释风格：中文 doc comment 讲 why；模块头注释随行为更新。
- TDD：每任务先写失败测试；每任务独立 commit（Angular 规范中文 message）。
- 门禁命令：`cargo test --manifest-path server/Cargo.toml`（server 全量）、`pnpm test`（root vitest）、`pnpm typecheck`。
- 测试环境守卫沿用现状：真子进程测试以 `probe("rg")` / `probe("grep")` 可用性 gate，缺失则 `return` 跳过。

### 关键语义裁决（实施必读）：路径覆盖的注入语义

`state.rg_path` / `state.grep_path` 是测试注入位（无 CLI flag）。为保证「rg 缺失 + grep 存在 → 200」在装有 rg 的 CI 上可测，语义定义为：

- `None` → PATH 探测该引擎；
- `Some(p)` 且 `p` 可执行 → 直接绑定该引擎；
- `Some(p)` 且 `p` 不可执行 → **该引擎视为不可用并跳过其 PATH 探测**（模拟缺失），链继续走下一引擎。

这与 spec §2.1「rg_path 缺失路径 spawn 失败 501」的差异是必要的：硬绑定会让 spec §3 自己要求的集成测试（注入真 grep 跑通 fallback）在 CI 上无法触发。spawn `ErrorKind::NotFound` 的 501 分支保留（防探测与 spawn 之间的 TOCTOU）。既有 501 测试按 spec 同步改为 rg+grep 双缺失注入。

---

### Task 1: 引擎选择链——probe 泛化、SearchEngine、resolve_engine、state.grep_path

**Files:**
- Modify: `server/src/state.rs`（`rg_path` 字段注释更新 + `grep_path` 字段 + builder）
- Modify: `server/src/routes/search.rs:65-76`（probe 泛化 + 枚举 + resolve_engine + 单测）

**Interfaces:**
- Consumes: 现有 `probe_rg()`、`is_executable(p)`、`AppError::not_implemented`。
- Produces（后续任务依赖的精确签名）:
  - `pub fn probe(exe: &str) -> Option<String>`（Windows 补 `.exe`）
  - `pub fn probe_rg() -> Option<String>`（保留旧名 = `probe("rg")`，`tests/search.rs::rg_available` 继续用）
  - `#[derive(Clone, Copy, PartialEq, Eq, Debug)] pub(crate) enum SearchEngine { Rg, Grep }` + `pub(crate) fn name(self) -> &'static str`（"rg"/"grep"）
  - `pub(crate) fn resolve_engine(state: &AppState) -> Result<(SearchEngine, String), AppError>`
  - `AppState.grep_path: Option<String>` + `pub fn with_grep_path(mut self, grep_path: Option<String>) -> Self`

- [ ] **Step 1: 写失败测试**（`search.rs` 测试模块新增）

```rust
// ---------- resolve_engine ----------

/// 与 health 测试同款的轻量 state（root 仅作 watcher 基准，不参与断言）。
fn test_state() -> AppState {
    AppState::new(PathBuf::from("."), None, None, false, None)
}

#[test]
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test --manifest-path server/Cargo.toml --lib routes::search::tests::resolve_engine`
Expected: 编译失败（`probe`/`SearchEngine`/`resolve_engine`/`with_grep_path` 未定义）

- [ ] **Step 3: 最小实现**

`state.rs`：`rg_path` 字段注释替换为覆盖语义说明，新增 `grep_path`：

```rust
/// rg 可执行路径覆盖：None = 请求时 PATH 探测；Some(可执行) = 直接绑定；
/// Some(不可执行) = rg 不可用（跳过 PATH 探测——测试模拟 rg 缺失，A 项降级链）。
pub rg_path: Option<String>,
/// grep 路径覆盖：语义同 `rg_path`（rg 不可用时的 fallback 引擎，探测链第二位）。
pub grep_path: Option<String>,
```

`AppState::new` 初始化处补 `grep_path: None,`；builder 追加：

```rust
/// builder：注入 grep 路径（None = PATH 探测；测试注入不存在路径模拟 grep 缺失）。
pub fn with_grep_path(mut self, grep_path: Option<String>) -> Self {
    self.grep_path = grep_path;
    self
}
```

`search.rs`：`probe_rg` 重构为泛化 `probe`（保留 `probe_rg` 薄封装，`rg_args`/`rg_path` 等既有代码不动），新增枚举与选择链：

```rust
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
fn resolve_one(over: Option<&String>, exe: &str, engine: SearchEngine) -> Option<(SearchEngine, String)> {
    match over {
        None => probe(exe).map(|p| (engine, p)),
        Some(p) if is_executable(Path::new(p)) => Some((engine, p.clone())),
        Some(_) => None, // 显式注入但不可执行：该引擎不可用，跳过（模拟缺失）
    }
}

/// 引擎选择链：rg 覆盖/探测 → grep 覆盖/探测 → 双缺 501。
pub(crate) fn resolve_engine(state: &AppState) -> Result<(SearchEngine, String), AppError> {
    if let Some(found) = resolve_one(state.rg_path.as_ref(), "rg", SearchEngine::Rg) {
        return Ok(found);
    }
    if let Some(found) = resolve_one(state.grep_path.as_ref(), "grep", SearchEngine::Grep) {
        return Ok(found);
    }
    Err(AppError::not_implemented(
        "cross-file search unavailable: neither ripgrep (rg) nor grep found on server",
    ))
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cargo test --manifest-path server/Cargo.toml --lib routes::search::tests`
Expected: 新增 3 例 PASS，既有 `probe_rg_finds_executable_or_none` 等全 PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/state.rs server/src/routes/search.rs
git commit -m "feat(server): 搜索引擎选择链与 grep 路径注入位

why: A 项 rg 缺失自动降级 grep 的地基；需统一引擎解析供 search/health 共用。
what: probe 泛化 + SearchEngine 枚举 + resolve_engine 覆盖语义链
（Some(不可执行)=模拟缺失）+ AppState.grep_path。"
```

---

### Task 2: grep_args 参数映射

**Files:**
- Modify: `server/src/routes/search.rs`（`rg_args` 后新增 `grep_args` + 单测）

**Interfaces:**
- Consumes: `SearchRequest`、`RG_MAX_COUNT`（"50"）。
- Produces: `fn grep_args(req: &SearchRequest, hidden: bool) -> Vec<String>`（Task 4 search() 调用）

- [ ] **Step 1: 写失败测试**（镜像 rg_args 三例的覆盖面）

```rust
// ---------- grep_args ----------

#[test]
fn grep_args_defaults_are_literal_and_insensitive() {
    let req = SearchRequest {
        pattern: "needle".into(),
        glob: None,
        case_sensitive: false,
        regex: false,
        path: None,
    };
    let args = grep_args(&req, false);
    // 行格式协议：NUL 分隔（长选项——-Z 在 BSD grep 是 decompress）
    for a in ["--null", "-rHn", "-s", "-I", "-m", "50", "-i", "-F", "-e", "needle"] {
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
    };
    assert!(!grep_args(&req, false).iter().any(|a| a.starts_with("--include")));
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test --manifest-path server/Cargo.toml --lib routes::search::tests::grep_args`
Expected: 编译失败（`grep_args` 未定义）

- [ ] **Step 3: 最小实现**（紧跟 `rg_args` 之后）

```rust
/// 组装 grep 参数（rg 缺失 fallback，A 项）。行格式 `path\0line:content`。
/// 已知差异（spec §2.2）：无 --max-filesize（全读，60s 墙钟+命中上限兜底）、
/// 无 --sort path（顺序不保证）、regex 走 ERE 方言、无列号（col 恒 1）。
/// `hidden` 无对应开关：grep -r 天然含 dot 条目、不读 ignore。
fn grep_args(req: &SearchRequest, hidden: bool) -> Vec<String> {
    let _ = hidden;
    let mut args = vec![
        // 长选项强制：短参 -Z 在 GNU grep 是 --null、BSD grep 是 --decompress
        "--null".to_string(),
        "-rHn".to_string(),
        "-s".to_string(),
        "-I".to_string(),
        "-m".to_string(),
        RG_MAX_COUNT.to_string(),
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cargo test --manifest-path server/Cargo.toml --lib routes::search::tests::grep_args`
Expected: 3 例 PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/search.rs
git commit -m "feat(server): grep 参数映射（rg 缺失降级引擎）

why: fallback 引擎需要与 rg 语义对齐的参数集。
what: grep_args——--null -rHn 行协议、-m 每文件上限、--include glob、
-F/-E 模式、-s -I；已知差异注释固化。"
```

---

### Task 3: pump 重构——FrameParser 引擎分发 + grep_frame 解析

**Files:**
- Modify: `server/src/routes/search.rs`（`pump` 签名与循环体、新增 `FrameParser`/`grep_frame`、既有 4 处测试调用点）
- Test: 同文件测试模块

**Interfaces:**
- Consumes: `match_frame`（不动）、`PREVIEW_MAX_CHARS`、`PumpOutcome`。
- Produces:
  - `pub(crate) enum FrameParser { Rg { root_canonical: PathBuf }, Grep { root_canonical: PathBuf } }` + `fn frame(&self, line: &str) -> Option<String>`（None=跳过该行）
  - `pub(crate) async fn pump(mut child, stdout, stderr, parser: FrameParser, tx, timeout) -> PumpOutcome`（第 4 参由 `root_canonical: PathBuf` 改为 `parser: FrameParser`，其余不变）
  - `fn grep_frame(line: &str, root_canonical: &Path) -> Option<String>`

- [ ] **Step 1: 写失败测试**

```rust
// ---------- grep_frame ----------

#[test]
fn grep_frame_parses_nul_line_format() {
    let root = Path::new("/tmp/root");
    let line = "/tmp/root/sub/a.rs\012:const needle = 1;";
    let out: Value = serde_json::from_str(&grep_frame(line, root).unwrap()).unwrap();
    assert_eq!(out["file"], "sub/a.rs");
    assert_eq!(out["line"], 12);
    assert_eq!(out["col"], 1, "grep 无列号，恒 1");
    assert_eq!(out["text"], "const needle = 1;");
}

#[test]
fn grep_frame_colon_in_path_and_content_is_safe() {
    let root = Path::new("/tmp/root");
    // 文件名含冒号（NUL 分隔保护）与内容含冒号（首个冒号后全为内容）
    let line = "/tmp/root/we:ird.txt\0the:rest: here";
    let out: Value = serde_json::from_str(&grep_frame(line, root).unwrap()).unwrap();
    assert_eq!(out["file"], "we:ird.txt");
    assert_eq!(out["line"], 1);
    assert_eq!(out["text"], "the:rest: here");
}

#[test]
fn grep_frame_utf8_content_and_preview_truncation() {
    let root = Path::new("/tmp/root");
    let out: Value =
        serde_json::from_str(&grep_frame("/tmp/root/zh.txt\0中文needle", root).unwrap()).unwrap();
    assert_eq!(out["text"], "中文needle");
    let long = "中".repeat(500);
    let out: Value =
        serde_json::from_str(&grep_frame(&format!("/tmp/root/l\01:{long}"), root).unwrap())
            .unwrap();
    assert_eq!(out["text"].as_str().unwrap().chars().count(), PREVIEW_MAX_CHARS);
}

#[test]
fn grep_frame_malformed_lines_are_skipped() {
    let root = Path::new("/tmp/root");
    assert!(grep_frame("no nul at all", root).is_none());
    assert!(grep_frame("/p\0not-a-number:content", root).is_none());
    assert!(grep_frame("/p\0", root).is_none());
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

    let parser = FrameParser::Grep { root_canonical: dir.path().to_path_buf() };
    let (tx, mut rx) = mpsc::channel::<Result<String, std::io::Error>>(8);
    let handle = tokio::spawn(pump(child, stdout, stderr, parser, tx, std::time::Duration::from_secs(60)));

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
    assert_eq!(frames.last().is_some(), true, "必须有终帧");
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
```

同时**改造既有 4 处 pump 调用点**（本任务内属于签名迁移，不算新测试）：

- `pump_kills_child_when_receiver_dropped`：`FrameParser::Rg { root_canonical: dir.path().to_path_buf() }`
- `pump_exact_1000_matches_is_not_truncated`、`pump_binary_match_after_1000_does_not_report_truncated`：同上（Rg + dir）
- `pump_timeout_kills_child_and_emits_error_frame`：`FrameParser::Grep { root_canonical: dir.path().to_path_buf() }`（sh 挂起无输出，解析器不参与）

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test --manifest-path server/Cargo.toml --lib routes::search::tests::grep_frame`
Expected: 编译失败（`grep_frame`/`FrameParser` 未定义）

- [ ] **Step 3: 实现 FrameParser 并重构 pump**

```rust
/// 引擎感知的行解析：None = 跳过该行（rg 非 match 事件/二进制帧、grep 畸形行）。
pub(crate) enum FrameParser {
    Rg { root_canonical: PathBuf },
    Grep { root_canonical: PathBuf },
}

impl FrameParser {
    fn frame(&self, line: &str) -> Option<String> {
        match self {
            FrameParser::Rg { root_canonical } => {
                let v = serde_json::from_str::<Value>(line).ok()?;
                if v.get("type").and_then(Value::as_str) != Some("match") {
                    return None;
                }
                match_frame(&v, root_canonical)
            }
            FrameParser::Grep { root_canonical } => grep_frame(line, root_canonical),
        }
    }
}
```

`pump` 签名第 4 参 `root_canonical: PathBuf` → `parser: FrameParser`；循环体替换为：

```rust
while let Ok(Some(line)) = lines.next_line().await {
    let Some(payload) = parser.frame(&line) else {
        continue; // 非 match 事件 / 二进制帧 / 畸形行：跳过，不参与截断判定
    };
    // ……（sent/MAX_MATCHES/tx.send 逻辑原样保留）
}
```

新增解析函数（置于 `match_frame` 之后）：

```rust
/// grep `--null -rHn` 输出行 `path\0line:content` → NDJSON 命中帧；畸形行 None。
/// NUL 分隔文件名与行内容（文件名含冒号安全）；行号后首个冒号切出内容
/// （内容含冒号无歧义）。grep 无列号：col 恒 1（spec §2.3 裁决）。
fn grep_frame(line: &str, root_canonical: &Path) -> Option<String> {
    let (path_text, rest) = line.split_once('\0')?;
    let (line_no_raw, content) = rest.split_once(':')?;
    let line_no: u64 = line_no_raw.parse().ok()?;

    let abs = Path::new(path_text);
    let rel = abs.strip_prefix(root_canonical).unwrap_or(abs);
    let rel = rel.to_string_lossy().replace('\\', "/");

    let text: String = content.chars().take(PREVIEW_MAX_CHARS).collect();
    Some(format!("{}\n", json!({ "file": rel, "line": line_no, "col": 1, "text": text })))
}
```

- [ ] **Step 4: 跑测试确认通过（pump 既有测试全量回归）**

Run: `cargo test --manifest-path server/Cargo.toml --lib routes::search`
Expected: 既有 rg pump 测试（断连/超时/恰 1000/二进制不计截断）+ 新增 grep_frame/pump_grep 全 PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/search.rs
git commit -m "feat(server): pump 引擎分发——FrameParser 抽象与 grep 行解析

why: rg --json 与 grep --null 两种行格式共享超时/截断/断连骨架。
what: FrameParser（Rg/Grep）+ grep_frame（NUL 行格式、col=1、
预览截断、畸形行跳过）+ 既有测试调用点迁移。"
```

---

### Task 4: search() 接线 + 集成测试

**Files:**
- Modify: `server/src/routes/search.rs:122-186`（handler）、模块头注释（L1-14）
- Modify: `server/tests/search.rs`（`missing_rg_is_501` 改造 + 新增 2 例）

**Interfaces:**
- Consumes: Task 1 `resolve_engine`/`SearchEngine::name`、Task 2 `grep_args`、Task 3 `FrameParser`。
- Produces: handler 行为（rg/grep 双引擎 + 501 语义）；无新公共接口。

- [ ] **Step 1: 写失败集成测试**（`server/tests/search.rs`）

改造既有（**替换** `missing_rg_is_501`）：

```rust
// ---------- rg+grep 双缺 → 501（spec A：单注 rg 在有 grep 机器会走 fallback） ----------

#[tokio::test]
async fn missing_rg_and_grep_is_501() {
    let f = fixture(None);
    let state = f
        .state
        .with_rg_path(Some("/nonexistent/rg-for-test".to_string()))
        .with_grep_path(Some("/nonexistent/grep-for-test".to_string()));
    let (status, frames) = post_search(state, json!({ "pattern": "needle" })).await;
    assert_eq!(status, StatusCode::NOT_IMPLEMENTED);
    assert_eq!(frames.len(), 1);
    assert!(frames[0].get("error").is_some());
}

// ---------- rg 缺失 + grep 存在 → 200（fallback 全链路） ----------

#[tokio::test]
async fn missing_rg_falls_back_to_grep() {
    let Some(grep) = vviewer::routes::search::probe("grep") else {
        return;
    };
    let f = fixture(None);
    let state = f
        .state
        .with_rg_path(Some("/nonexistent/rg-for-test".to_string()))
        .with_grep_path(Some(grep));
    let (status, frames) = post_search(state, json!({ "pattern": "needle" })).await;
    assert_eq!(status, StatusCode::OK);
    let hits = match_frames(&frames);
    let first = hits.iter().find(|h| h["file"] == "a.txt").unwrap();
    assert_eq!(first["line"], 2);
    assert_eq!(first["col"], 1, "grep 路径 col 恒 1");
    assert_eq!(first["text"], "needle here");
    // 已知差异（spec §2.2）：grep 无 --max-filesize，>2MiB 的 big.txt 照常命中
    assert!(
        hits.iter().any(|h| h["file"] == "big.txt"),
        "grep 无大文件跳过：fallback 行为差异用测试固化"
    );
    let done = done_frame(&frames);
    assert_eq!(done["done"], true);
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test --manifest-path server/Cargo.toml --test search`
Expected: `missing_rg_falls_back_to_grep` FAIL（rg_path 硬绑定旧逻辑 501）；`missing_rg_and_grep_is_501` PASS（旧逻辑即 501）

- [ ] **Step 3: handler 接线**（`search.rs`）

`search()` 中替换 `let Some(rg) = state.rg_path.clone().or_else(probe_rg) else { ... }` 起至 spawn 段：

```rust
let (engine, bin) = resolve_engine(&state)?;

let args = match engine {
    SearchEngine::Rg => rg_args(&req, state.hidden),
    SearchEngine::Grep => grep_args(&req, state.hidden),
};
let mut command = Command::new(&bin);
command
    .args(args)
    .arg(&dir)
    .stdin(std::process::Stdio::null())
    .stdout(std::process::Stdio::piped())
    .stderr(std::process::Stdio::piped())
    .kill_on_drop(true);
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
```

pump 调用处传解析器：

```rust
let parser = match engine {
    SearchEngine::Rg => FrameParser::Rg { root_canonical: state.root_canonical.clone() },
    SearchEngine::Grep => FrameParser::Grep { root_canonical: state.root_canonical.clone() },
};
let pump_handle = tokio::spawn(pump(child, stdout, stderr, parser, tx, SEARCH_TIMEOUT));
```

模块头注释（L1-14）追加一段：

```rust
//! A 项降级链：rg 缺失时自动 fallback 系统 grep——参数映射/`--null` 行协议/
//! 已知差异（无 filesize 跳过、顺序不保证、ERE、col=1）见 `grep_args`/`grep_frame`；
//! health 据同一选择链宣告 `searchEngine`。
```

- [ ] **Step 4: 跑集成测试全量确认通过**

Run: `cargo test --manifest-path server/Cargo.toml --test search`
Expected: 全 PASS（含改造后的 501 与新 fallback；无 rg 机器上 fallback 测试自动跳过）

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/search.rs server/tests/search.rs
git commit -m "feat(server): /api/search 接通 grep 降级引擎

why: rg 缺失环境下跨文件搜索保持服务端执行（spec A 主目标）。
what: handler 按 resolve_engine 选引擎组参/解析；501 语义收敛为
双引擎皆缺；集成测试固化 fallback 全链路与 --max-filesize 差异。"
```

---

### Task 5: health 宣告 searchEngine

**Files:**
- Modify: `server/src/routes/health.rs`（结构体字段 + handler + 测试 helper 重构）

**Interfaces:**
- Consumes: `crate::routes::search::resolve_engine`、`SearchEngine::name`。
- Produces: `Health.search_engine: Option<&'static str>`（JSON `searchEngine`，双缺省略）。

- [ ] **Step 1: 写失败测试**（health.rs 测试模块；helper 重构为接受 state）

```rust
async fn health_json(state: AppState) -> serde_json::Value {
    let res = health(State(state)).await;
    let bytes = to_bytes(res.into_response().into_body(), 64 * 1024)
        .await
        .expect("body");
    serde_json::from_slice(&bytes).expect("json")
}

// 既有两例改调用：health_json({ let mut s = AppState::new(...); s.compute = compute; s }) 风格
// —— 统一改为：
fn base_state() -> AppState {
    AppState::new(PathBuf::from("."), None, None, false, None)
}

#[tokio::test]
async fn no_compute_omits_language_list() {
    let v = health_json(base_state()).await;
    assert_eq!(v["capabilities"], serde_json::json!(["file-server"]));
    assert!(v.get("computeLanguages").is_none());
}

#[tokio::test]
async fn compute_advertises_sorted_full_registry() {
    let v = health_json(base_state().with_compute(true)).await;
    // ……（原断言体不变）
}

#[tokio::test]
async fn search_engine_omitted_when_both_engines_missing() {
    let state = base_state()
        .with_rg_path(Some("/nonexistent/rg-for-test".to_string()))
        .with_grep_path(Some("/nonexistent/grep-for-test".to_string()));
    let v = health_json(state).await;
    assert!(v.get("searchEngine").is_none());
}

#[tokio::test]
async fn search_engine_announces_forced_grep() {
    let grep = crate::routes::search::probe("grep").expect("CI 需要系统 grep");
    let state = base_state()
        .with_rg_path(Some("/nonexistent/rg-for-test".to_string()))
        .with_grep_path(Some(grep));
    let v = health_json(state).await;
    assert_eq!(v["searchEngine"], "grep");
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test --manifest-path server/Cargo.toml --lib routes::health`
Expected: 编译失败（`search_engine` 字段未定义）

- [ ] **Step 3: 实现**

```rust
/// 跨文件搜索引擎宣告（A 项）：rg/grep 择一；双缺时字段整体省略。
/// 与 /api/search 同一选择链，测试经 rg_path/grep_path 注入覆盖。
#[serde(rename = "searchEngine", skip_serializing_if = "Option::is_none")]
pub search_engine: Option<&'static str>,
```

handler 内：

```rust
let search_engine =
    crate::routes::search::resolve_engine(&state).ok().map(|(engine, _)| engine.name());
```

（`Health { ..., search_engine }` 补字段初始化。）

- [ ] **Step 4: 跑测试确认通过**

Run: `cargo test --manifest-path server/Cargo.toml --lib routes::health`
Expected: 4 例 PASS（既有 2 例重构后不回归）

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/health.rs
git commit -m "feat(server): health 宣告跨文件搜索引擎

why: 前端与运维需感知实际引擎（rg/grep）与降级状态。
what: searchEngine 字段（双缺省略）+ 选择链复用 + 注入式单测。"
```

---

### Task 6: 前端引擎徽标（缓存模块 + 搜索面板）

**Files:**
- Create: `apps/web/src/lib/searchEngineCache.ts`
- Create: `apps/web/src/lib/searchEngineCache.test.ts`
- Modify: `apps/web/src/lib/openFlow.svelte.ts`（connectServer 缓存写入，L312-335 一带）
- Modify: `apps/web/src/lib/GlobalSearchPanel.svelte`（状态区徽标，degraded 提示之后）

**Interfaces:**
- Consumes: health 响应 `searchEngine` 字段（Task 5）。
- Produces: `loadSearchEngine(): 'rg' | 'grep' | null`、`saveSearchEngine(engine: unknown): void`（sessionStorage key `vv:search-engine`）。

- [ ] **Step 1: 写失败测试**

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { loadSearchEngine, saveSearchEngine } from './searchEngineCache';

describe('searchEngineCache', () => {
  afterEach(() => {
    sessionStorage.clear();
  });

  it('round-trips valid engine kinds', () => {
    saveSearchEngine('grep');
    expect(loadSearchEngine()).toBe('grep');
    saveSearchEngine('rg');
    expect(loadSearchEngine()).toBe('rg');
  });

  it('treats unknown values as absent (旧服务端兼容)', () => {
    saveSearchEngine('bogus');
    expect(loadSearchEngine()).toBeNull();
  });

  it('returns null when nothing cached', () => {
    expect(loadSearchEngine()).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run apps/web/src/lib/searchEngineCache.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现缓存模块**

```ts
/** 会话级跨文件搜索引擎宣告缓存（A 项）：connectServer 时自 health 写入，
 * GlobalSearchPanel 徽标读取。旧服务端无字段 → 移除缓存视为未知。 */

const KEY = 'vv:search-engine';

export type SearchEngineKind = 'rg' | 'grep';

export function loadSearchEngine(): SearchEngineKind | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    return raw === 'rg' || raw === 'grep' ? raw : null;
  } catch {
    return null;
  }
}

export function saveSearchEngine(engine: unknown): void {
  try {
    if (engine === 'rg' || engine === 'grep') {
      sessionStorage.setItem(KEY, engine);
    } else {
      sessionStorage.removeItem(KEY);
    }
  } catch {
    // 存储不可用：徽标缺失，连接不受影响
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run apps/web/src/lib/searchEngineCache.test.ts`
Expected: 3 例 PASS

- [ ] **Step 5: 接线 openFlow 与搜索面板**

`openFlow.svelte.ts`：顶部 import `saveSearchEngine`（自 `./searchEngineCache`）；`connectServer` 的 caps 类型扩为 `{ capabilities?: unknown; computeLanguages?: unknown; searchEngine?: unknown }`；在 computeLanguages 缓存块之后追加：

```ts
// 搜索引擎宣告缓存（A 项）：旧服务端无字段 → 清缓存，徽标不显示
saveSearchEngine(caps.searchEngine);
```

`GlobalSearchPanel.svelte`：import 区加 `import { loadSearchEngine } from './searchEngineCache';`；组件顶层（`let panelEl` 附近）加 `const searchEngine = loadSearchEngine();`；状态区 `{#if degraded}` 块之后加：

```svelte
{#if searchEngine}
  <span
    class="vv-gsearch-hint"
    title={searchEngine === 'grep'
      ? '降级引擎：无列定位、结果顺序不保证、正则为 ERE 方言'
      : ''}
  >服务端搜索：{searchEngine}</span>
{/if}
```

（复用既有 `.vv-gsearch-hint` 样式，无新增 CSS。）

- [ ] **Step 6: 全量前端门禁**

Run: `pnpm test && pnpm typecheck`
Expected: 全绿

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/lib/searchEngineCache.ts apps/web/src/lib/searchEngineCache.test.ts apps/web/src/lib/openFlow.svelte.ts apps/web/src/lib/GlobalSearchPanel.svelte
git commit -m "feat(web): 全局搜索面板展示服务端搜索引擎

why: health 宣告 searchEngine 后前端需可见（grep 降级时附限制说明）。
what: vv:search-engine 会话缓存模块 + connectServer 写入 + 面板徽标。"
```

---

### Task 7: 文档更新与全量门禁

**Files:**
- Modify: `README.md`、`docs/deploy.md`（rg 依赖描述处；用 `rg -n 'ripgrep|\brg\b' README.md docs/deploy.md` 定位）

**Interfaces:** 无代码接口。

- [ ] **Step 1: 更新文档**

定位现有 ripgrep 依赖描述并改写为（保留上下文格式）：

> 跨文件搜索依赖 ripgrep（rg）——**可选**：缺失时自动降级系统 grep（功能差异：无大文件跳过、结果顺序不保证、正则为 ERE 方言、无列定位）；两者皆缺时搜索退回浏览器内执行。`GET /api/health` 经 `searchEngine` 字段宣告实际引擎。

- [ ] **Step 2: 全量门禁**

Run: `cargo test --manifest-path server/Cargo.toml && pnpm test && pnpm typecheck`
Expected: 全绿（cargo lib+集成、vitest 全量、tsc）

- [ ] **Step 3: Commit**

```bash
git add README.md docs/deploy.md
git commit -m "docs: 搜索依赖更新为 rg 可选（缺失自动降级 grep）

why: A 项落地后部署者无需强依赖 rg。
what: README/deploy 依赖说明与 searchEngine 宣告口径。"
```

---

## Self-Review 结论

- **Spec 覆盖**：§2.1 引擎链→Task 1/4；§2.2 参数映射→Task 2；§2.3 解析分发→Task 3/4；§2.4 health+徽标→Task 5/6；§3 测试矩阵→各任务；§5 文档→Task 7。无缺口。
- **占位扫描**：无 TBD/「适当处理」；所有代码步骤含实际代码。
- **类型一致性**：`resolve_engine`/`SearchEngine::name`/`grep_args`/`FrameParser`/`with_grep_path`/`loadSearchEngine` 前后引用一致；pump 新签名在 Task 3 定义、Task 4 消费一致。
- **计划对 spec 的必要细化**（1 处，已在上文「关键语义裁决」声明）：`rg_path` 注入语义由「缺失路径 spawn 失败 501」细化为「Some(不可执行)=该引擎不可用并跳过探测」——否则 spec §3 要求的「rg 缺失 + grep 存在 → 200」在装有 rg 的 CI 上不可测。
