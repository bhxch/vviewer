# BUG-68 watcher 日志刷盘修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 BUG-68——数据根含越界 symlink/不可读目录时 watcher 降级后日志无上界刷盘（实测 ≈47GB/天）与 CPU 空转。

**Architecture:** 四点修复——① notify 两级后端显式 `with_follow_symlinks(false)`（根因：notify 8.2 默认 `follow_symlinks: true`，扫描深入 root 外 symlink）；② 日志抑制两层（默认 EnvFilter `info,notify=error` 静默 notify 内部 WARN + watch.rs 自身错误限频）；③ 新增 `--log-file`（10MB 单备份覆盖式滚动）；④ 部署文档补日志与轮转说明。

**Tech Stack:** Rust（axum/notify 8.2/tracing + tracing-subscriber），Playwright（e2e-server）。

**Spec:** `docs/superpowers/specs/2026-10-11-watch-log-flood-design.md`（BUG-68 登记、根因链、四点决策——本计划从该 spec 出发，两者同读）。

## Global Constraints

- 服务端约定「配置错误返回 exit code（不 panic）」——`--log-file` 不可用时返回 exit 2，禁止 panic/unwrap 用户输入路径。
- 不新增运行时依赖；仅 `[dev-dependencies]` 允许新增（`log`、`tracing-log`）。
- watch.rs 日志保留 `[watch]` 前缀与既有语义；SSE 帧（`watch-degraded`/`watch-recovered`/`changed`）语义零改动。
- 提交遵循 Angular 规范、原子化；每任务独立提交。
- 测试运行入口：Rust `cargo test --manifest-path server/Cargo.toml`；vitest `pnpm test`；服务端 e2e `pnpm --filter web exec playwright test --config=playwright.server.config.ts`（跑前必须 `cargo build --release --manifest-path server/Cargo.toml`，webServer 直接执行 release 二进制）。

---

### Task 1: 根因修复——两级 watcher 后端不跟随 symlink

**Files:**
- Modify: `server/src/watch.rs:471-497`（`open_recommended`/`open_poll`）
- Modify: `server/src/watch.rs`（模块 doc 注释 1-19 行区，补「不跟随 symlink」语义）
- Test: `server/src/watch.rs`（tests 模块内新增）

**Interfaces:**
- Consumes: notify 8.2 `RecommendedWatcher::new(handler, Config)`、`Config::default().with_follow_symlinks(false)`、`PollWatcher::new(handler, Config)`（均为 notify 公开 API）。
- Produces: 行为变更——含越界 symlink 的 root 建监听健康为 `WatchHealth::Ok`（修复前 Degraded/Recovering）；`open_recommended`/`open_poll` 签名不变（后续任务依赖不变）。

- [ ] **Step 1: 写失败测试（真实 FS 集成：越界 symlink 下健康应为 Ok）**

在 `server/src/watch.rs` 的 `mod tests` 内追加（`#[cfg(unix)]`——chmod 0o000 仅对非 root 生效，测试以非 root 运行）：

```rust
/// 构造「root 内含指向外部目录的 symlink，目标含 0o000 子目录」的场景。
/// 修复前：inotify 建 watch 的 walkdir 深入 symlink 遇 EACCES → 建监听失败
/// → 健康非 Ok（BUG-68 现场形态）；修复后（follow_symlinks=false）不深入 → Ok。
#[cfg(unix)]
fn make_root_with_escape_symlink(dir: &Path) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let root = dir.join("root");
    let target = dir.join("outside");
    std::fs::create_dir_all(target.join("locked")).unwrap();
    std::fs::set_permissions(target.join("locked"), PermissionsExt::from_mode(0o000)).unwrap();
    std::fs::create_dir_all(&root).unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(&target, root.join("escape")).unwrap();
    root
}

/// BUG-68 根因回归：root 含越界 symlink（目标含不可读目录）时 watcher 健康应为
/// Ok——扫描不深入 symlink，不再因目标内权限错误致建监听失败。
#[cfg(unix)]
#[test]
fn escape_symlink_root_watches_ok() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let root = make_root_with_escape_symlink(dir.path());
    let hub = ChangeHub::spawn(&root);
    assert_eq!(hub.health(), WatchHealth::Ok, "含越界 symlink 的 root 应健康 Ok");
    // 后台重试/降级稳定后仍为 Ok（不因运行期问题翻转为 Recovering/Degraded）
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(hub.health(), WatchHealth::Ok);
    drop(hub); // stop 置位，聚合线程退出
    // 恢复权限便于 tempdir 清理
    std::fs::set_permissions(dir.path().join("outside/locked"), PermissionsExt::from_mode(0o700)).ok();
}

/// 降级路径（PollWatcher）同样不深入 symlink：强制降级后，root 内真实文件的
/// 变更仍能经 pollscan 聚合为 changed（越界 symlink 不阻断扫描、不产生错误事件）。
#[cfg(unix)]
#[test]
fn poll_session_over_escape_symlink_still_delivers_changed() {
    let dir = tempfile::tempdir().unwrap();
    let root = make_root_with_escape_symlink(dir.path());
    let stop = AtomicBool::new(false);
    let rec_fails = Arc::new(AtomicUsize::new(0));
    let poll_root = root.clone();
    let open_rec: Opener = Box::new(move || {
        rec_fails.fetch_add(1, Ordering::SeqCst);
        Err(NotifyError::io(std::io::Error::other("forced degrade")))
    });
    let open_poll: Opener = Box::new(move || {
        let (w, rx) = open_poll(&poll_root, Duration::from_millis(50))?;
        Ok((Box::new(w) as Box<dyn Send>, rx, "Poll".to_string()))
    });
    let mut factory = factory(open_rec, open_poll);
    let session = factory.build(&stop).expect("降级 poll 会话应建立成功");
    assert!(session.degraded);
    // 写一个真实文件，等 ≥2 个轮询周期，断言收到该路径的事件（无 Err 事件）
    std::fs::write(root.join("seed.txt"), "x").unwrap();
    let deadline = Instant::now() + Duration::from_secs(3);
    let mut saw_seed = false;
    while Instant::now() < deadline {
        match session.rx.recv_timeout(Duration::from_millis(100)) {
            Ok(Ok(ev)) => {
                let mut out = BTreeSet::new();
                collect_event(&ev, &root, &mut out);
                if out.iter().any(|p| p.contains("seed.txt")) {
                    saw_seed = true;
                    break;
                }
            }
            Ok(Err(_)) => panic!("poll 会话不得产生错误事件（BUG-68 刷屏源应消失）"),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
            Err(_) => panic!("事件通道意外断开"),
        }
    }
    assert!(saw_seed, "3s 内应收到 seed.txt 的变更事件");
    drop(session);
    std::fs::set_permissions(dir.path().join("outside/locked"), std::os::unix::fs::PermissionsExt::from_mode(0o700)).ok();
}
```

（`factory`/`fast_policy` 复用 tests 模块既有 helper；`make_root_with_escape_symlink` 中 `#[cfg(unix)]` 重复标注可去掉——函数本身放在已有 `#[cfg(unix)]` 不必要，直接去掉内层多余属性，两个测试标注 `#[cfg(unix)]` 即可。）

- [ ] **Step 2: 跑测试确认失败（红）**

Run: `cargo test --manifest-path server/Cargo.toml watch::tests::escape_symlink -- --nocapture`
Expected: `escape_symlink_root_watches_ok` FAIL（`health` 为 Degraded/Recovering，非 Ok）——同时确认这就是 BUG-68 的最小复现。

- [ ] **Step 3: 实现根因修复**

`server/src/watch.rs`：

```rust
// open_recommended 改为（原 notify::recommended_watcher 不传 Config、吃默认 follow_symlinks=true）：
fn open_recommended(
    root: &Path,
) -> Result<(RecommendedWatcher, std::sync::mpsc::Receiver<RawEvent>), NotifyError> {
    let (raw_tx, raw_rx) = std::sync::mpsc::channel::<RawEvent>();
    let mut watcher = RecommendedWatcher::new(
        move |res: RawEvent| {
            let _ = raw_tx.send(res);
        },
        // BUG-68：扫描不跟随 symlink——越界 symlink（如 → /etc）内的权限错误
        // 不再使建监听失败/重扫报错；symlink 条目自身的增删改仍上报
        NotifyConfig::default().with_follow_symlinks(false),
    )?;
    watcher.watch(root, RecursiveMode::Recursive)?;
    Ok((watcher, raw_rx))
}

// open_poll 的 Config 追加：
NotifyConfig::default()
    .with_poll_interval(poll_interval)
    .with_follow_symlinks(false)
```

模块 doc（1-19 行区）追加一段：

```rust
//! 扫描不跟随 symlink（BUG-68）：notify 8.2 默认 `follow_symlinks=true` 会使
//! 递归扫描深入 root 外 symlink（如 → /etc），权限错误致建监听失败降级
//! PollWatcher 后，周期重扫每轮对每个被拒路径刷 WARN（实测 ≈47GB/天）。
//! `with_follow_symlinks(false)` 后两级后端都只在 root 内扫描；越界 symlink
//! 目标内的变更本就在 root 外（collect_event 既有口径剔除），语义不变。
```

- [ ] **Step 4: 跑测试确认通过（绿）**

Run: `cargo test --manifest-path server/Cargo.toml watch::tests`
Expected: 全部 PASS（含既有用例不回归）。

- [ ] **Step 5: 提交**

```bash
git add server/src/watch.rs
git commit -m "fix(server): watcher 扫描不跟随 symlink（BUG-68 根因）

why: notify 8.2 默认 follow_symlinks=true，root 含越界 symlink 时 inotify
建监听失败降级 PollWatcher，周期重扫对每个被拒路径刷 WARN（实测 47GB/天）。
what: 两级后端显式 with_follow_symlinks(false)，补越界 symlink 集成回归。"
```

---

### Task 2: watch.rs 日志收编（eprintln→tracing）+ 错误日志限频

**Files:**
- Modify: `server/src/watch.rs`（全部 `eprintln!` 站点 + `run_loop`/`session_loop` 签名 + tests）

**Interfaces:**
- Consumes: `tracing` crate（已在 dependencies）。
- Produces: `ErrorLogGate`（`new(window: Duration)`、`admit(&mut self, now: Instant) -> Admission`、`Admission::{First, Suppressed, Summary(u64)}`）——Task 3 不依赖，后续调参可注入；`session_loop` 签名变为 `fn session_loop(session: WatchSession, root: &Path, tx: &broadcast::Sender<String>, stop: &AtomicBool, gate: &mut ErrorLogGate) -> bool`。

- [ ] **Step 1: 写失败测试（ErrorLogGate 语义）**

tests 模块追加：

```rust
use std::time::Instant;

/// 限频器：窗口首条直记（First）；窗口内后续静默累计（Suppressed）；窗口过期后
/// 的首条以摘要形式输出累计数（Summary(n)）并重开窗口（该条即新窗口首条语义）。
#[test]
fn error_log_gate_first_suppress_then_summary() {
    let t0 = Instant::now();
    let mut gate = ErrorLogGate::new(Duration::from_secs(60));
    assert!(matches!(gate.admit(t0), Admission::First));
    for i in 1..=5 {
        assert!(matches!(gate.admit(t0 + Duration::from_secs(i)), Admission::Suppressed));
    }
    // 窗口（60s）过期后的首条：Summary(5) 并重开窗口
    assert!(matches!(gate.admit(t0 + Duration::from_secs(61)), Admission::Summary(5)));
    // 新窗口内继续静默
    assert!(matches!(gate.admit(t0 + Duration::from_secs(62)), Admission::Suppressed));
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test --manifest-path server/Cargo.toml error_log_gate`
Expected: FAIL（`ErrorLogGate` 未定义）。

- [ ] **Step 3: 实现 ErrorLogGate + 替换全部 eprintln! + session_loop 接线**

watch.rs 顶部（`WatchHealth` 定义前）加：

```rust
/// 运行期错误日志限频（BUG-68 抑制层）：同窗口内错误只记首条，过期后输出
/// 一条「n 条已抑制」摘要，避免高频错误事件逐条刷日志。
struct ErrorLogGate {
    window: Duration,
    last_reset: Option<Instant>,
    suppressed: u64,
}

enum Admission {
    /// 窗口首条：直接记录
    First,
    /// 窗口内：静默累计
    Suppressed,
    /// 窗口过期后的首条：输出摘要（携带被抑制条数），并重开窗口
    Summary(u64),
}

impl ErrorLogGate {
    fn new(window: Duration) -> Self {
        Self { window, last_reset: None, suppressed: 0 }
    }

    fn admit(&mut self, now: Instant) -> Admission {
        match self.last_reset {
            None => {
                self.last_reset = Some(now);
                Admission::First
            }
            Some(t) if now.duration_since(t) >= self.window => {
                let n = self.suppressed;
                self.suppressed = 0;
                self.last_reset = Some(now);
                Admission::Summary(n)
            }
            Some(_) => {
                self.suppressed += 1;
                Admission::Suppressed
            }
        }
    }
}
```

`run_loop`：循环前 `let mut gate = ErrorLogGate::new(Duration::from_secs(60));`，调用改为
`let errored = session_loop(sess, &root, &tx, &stop, &mut gate);`。

`session_loop` 的错误分支替换：

```rust
Ok(Err(e)) => {
    match gate.admit(Instant::now()) {
        Admission::First => tracing::warn!("[watch] runtime error, will rebuild: {e:?}"),
        Admission::Suppressed => {}
        Admission::Summary(n) => {
            tracing::warn!("[watch] runtime error window: {n} suppressed, latest: {e:?}")
        }
    }
    return true;
}
// 窗口内混入错误分支（第二个 Ok(Err(_))）同样走 gate：
Ok(Err(_)) => {
    let _ = gate.admit(Instant::now()); // 该分支不含错误详情，静默或摘要皆由下次输出兜底
    return true;
}
```

（第二处 `Ok(Err(_))` 无错误载荷，直接丢弃计数不影响语义；保持两个分支都 `return true`。）

全部 `eprintln!`（`spawn_with` 3 处、`RetryFactory::build` 7 处）替换为 tracing 宏并保留 `[watch]` 前缀：
- `[watch] root=… fstype=…`（111 行）→ `tracing::info!`
- `watcher established backend=…`（119）→ `tracing::info!`
- `watcher startup FAILED …`（125）→ `tracing::error!`
- `recommended probe succeeded …`（262）→ `tracing::info!`
- `recommended probe failed …`（269）→ `tracing::warn!`
- `preferred PollWatcher failed …`（279）→ `tracing::warn!`
- `watcher establish failed (retry …)`（294）→ `tracing::warn!`
- `degraded to PollWatcher …`（313）→ `tracing::warn!`
- `PollWatcher fallback failed …`（321）→ `tracing::error!`
- `watcher established after {misses} fallback failures`（338）→ `tracing::info!`
- `watcher still unavailable …`（347）→ `tracing::warn!`

文件头部 `use` 区加 `use tracing::{error, info, warn};`（或全用 `tracing::` 全限定，二选一保持一致）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cargo test --manifest-path server/Cargo.toml watch::tests`
Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add server/src/watch.rs
git commit -m "refactor(server): watch 日志收编 tracing 并加错误限频（BUG-68 抑制层）

why: 刷盘抑制需全部日志走 subscriber（--log-file 才对全量生效），且运行期
错误事件逐条记日志在高频故障下无上界。
what: eprintln 全量迁 tracing（保留 [watch] 前缀），新增 ErrorLogGate
窗口限频（首条直记、60s 摘要）。"
```

---

### Task 3: logging.rs（默认过滤 + 滚动 Writer + init_tracing）与 --log-file

**Files:**
- Create: `server/src/logging.rs`
- Modify: `server/src/lib.rs:4-11`（模块表加 `pub mod logging;`）
- Modify: `server/src/main.rs`（`Serve` 子命令参数、`ServeArgs`、`serve()` 初始化）
- Modify: `server/Cargo.toml`（`[dev-dependencies]` 加 `log = "0.4"`、`tracing-log = "0.2"`）
- Test: `server/src/logging.rs`（tests 模块）

**Interfaces:**
- Consumes: tracing-subscriber 0.3（fmt + env-filter 已启用；`tracing-log` 默认特性提供 log 桥接）。
- Produces: `vviewer::logging::init_tracing(log_file: Option<&Path>) -> std::io::Result<()>`（main.rs 调用）、`vviewer::logging::DEFAULT_FILTER: &str = "info,notify=error"`、`RotatingWriter`（`new(path)`/`with_capacity(path, cap)`，`Clone`，实现 `io::Write`）。

- [ ] **Step 1: 写失败测试**

`server/src/logging.rs` 新建（先含模块 doc、常量、`init_tracing` 骨架返回 `Ok(())` 占位不实现细节——不行，禁止占位：直接按下方 Step 3 全量实现，但测试先行的红相通过「RotatingWriter 未定义编译失败」体现）：

先在 Cargo.toml 追加 dev-deps 后创建 `server/src/logging.rs`，tests 模块：

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;
    use std::sync::{Arc, Mutex};

    /// 滚动：写入超过 cap 后当前文件滚动为 `.old`（覆盖旧备份），当前文件从零继续。
    #[test]
    fn rotating_writer_rolls_over_capacity() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("vviewer.log");
        let mut w = RotatingWriter::with_capacity(&path, 1_000).unwrap();
        let line = "x".repeat(99) + "\n";
        for _ in 0..30 {
            w.write_all(line.as_bytes()).unwrap();
        }
        w.flush().unwrap();
        let old = std::fs::read(dir.path().join("vviewer.log.old")).unwrap_or_default();
        let cur = std::fs::read(&path).unwrap();
        assert!(!old.is_empty(), "滚动后应存在非空 .old 备份");
        assert!(cur.len() <= 1_000 + line.len(), "当前文件应在新窗口内: {cur_len}", cur_len = cur.len());
        // 滚动后继续可写（句柄有效）
        w.write_all(b"after-rotate\n").unwrap();
        w.flush().unwrap();
        assert!(std::fs::read_to_string(&path).unwrap().contains("after-rotate"));
    }

    /// 追加语义：重启（重建 Writer）后从既有文件长度续计（不因 restart 立即滚动错乱）。
    #[test]
    fn rotating_writer_resumes_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("vviewer.log");
        std::fs::write(&path, "z".repeat(900)).unwrap();
        let mut w = RotatingWriter::with_capacity(&path, 1_000).unwrap();
        w.write_all(b"tail\n").unwrap();
        w.flush().unwrap();
        assert_eq!(std::fs::read(&path).unwrap().len(), 905, "未超 cap 不应滚动");
        assert!(!path.with_extension("log.old").exists(), "不应提前滚动");
    }

    /// 把 log crate 记录桥接进当前 dispatcher 后，默认过滤应静默 notify 的
    /// 扫描 WARN（BUG-68 抑制层），其他 target 的 WARN 正常通过。
    #[test]
    fn default_filter_silences_notify_scan_warns() {
        let _ = tracing_log::LogTracer::init(); // 全局仅生效一次，重复调用失败可忽略
        let sink: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
        struct SharedSink(Arc<Mutex<Vec<u8>>>);
        impl std::io::Write for SharedSink {
            fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
                self.0.lock().unwrap().extend_from_slice(buf);
                Ok(buf.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let w = sink.clone();
        let subscriber = tracing_subscriber::fmt()
            .with_ansi(false)
            .with_env_filter(tracing_subscriber::EnvFilter::new(DEFAULT_FILTER))
            .with_writer(move || SharedSink(w.clone()))
            .finish();
        tracing::subscriber::with_default(subscriber, || {
            log::warn!(target: "notify::poll::data", "walkdir error scanning fake");
            log::warn!(target: "vviewer::logging_test", "visible warn");
        });
        let out = String::from_utf8(sink.lock().unwrap().clone()).unwrap();
        assert!(!out.contains("notify::poll::data"), "notify 扫描 WARN 应被默认过滤: {out}");
        assert!(out.contains("visible warn"), "其他 target 不应被误伤: {out}");
    }

    #[test]
    fn default_filter_constant_is_notify_error() {
        assert_eq!(DEFAULT_FILTER, "info,notify=error");
    }
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test --manifest-path server/Cargo.toml logging::`
Expected: 编译失败（`RotatingWriter`/`DEFAULT_FILTER` 未定义）。

- [ ] **Step 3: 实现 logging.rs 全量**

```rust
//! 日志装配（BUG-68）：默认过滤收紧 + 可选 --log-file 单备份滚动。
//!
//! 默认 EnvFilter `info,notify=error`：notify crate 的扫描 WARN（poll 周期
//! 重扫对不可读路径的逐条报错）默认静默，可观测性由 watch.rs 自身的
//! 降级/自愈日志承担；`RUST_LOG` 可整体覆盖（如 `info,notify=warn` 排查）。
//! `--log-file` 时日志写文件，超 10MB 滚动为 `<PATH>.old`（单备份覆盖式）。

use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

/// 无 RUST_LOG 时的默认过滤：notify 内部 WARN（含 poll 重扫报错）默认静默。
pub const DEFAULT_FILTER: &str = "info,notify=error";

/// 单文件滚动阈值：当前日志超过该字节数即滚动。
const LOG_ROTATE_BYTES: u64 = 10 * 1024 * 1024;

/// 装配全局 subscriber。`log_file = Some(path)` 时写文件（ANSI 关闭、滚动），
/// None 维持 stdout。启动期参数错误由调用方转为 exit code（本函数只报 IO 错误）。
pub fn init_tracing(log_file: Option<&Path>) -> io::Result<()> {
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new(DEFAULT_FILTER));
    match log_file {
        Some(p) => {
            let writer = RotatingWriter::new(p)?;
            tracing_subscriber::fmt()
                .with_env_filter(filter)
                .with_ansi(false)
                .with_writer(move || writer.clone())
                .init();
        }
        None => {
            tracing_subscriber::fmt().with_env_filter(filter).init();
        }
    }
    Ok(())
}

/// 滚动文件 Writer：Append 打开，写入累计超 cap 时 rename 为 `<path>.old`
/// （覆盖旧备份）后重建当前文件。Clone 共享同一状态（MakeWriter 闭包用）。
#[derive(Clone)]
pub struct RotatingWriter {
    inner: Arc<Mutex<RotatingState>>,
}

struct RotatingState {
    path: PathBuf,
    file: std::fs::File,
    written: u64,
    cap: u64,
}

impl RotatingWriter {
    pub fn new(path: &Path) -> io::Result<Self> {
        Self::with_capacity(path, LOG_ROTATE_BYTES)
    }

    fn with_capacity(path: &Path, cap: u64) -> io::Result<Self> {
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent)?;
            }
        }
        let file = std::fs::OpenOptions::new().create(true).append(true).open(path)?;
        let written = file.metadata()?.len();
        Ok(Self {
            inner: Arc::new(Mutex::new(RotatingState { path: path.to_path_buf(), file, written, cap })),
        })
    }
}

impl Write for RotatingWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let mut st = self.inner.lock().expect("log writer 锁中毒");
        if st.written >= st.cap {
            st.file.flush()?;
            let mut old = st.path.as_os_str().to_owned();
            old.push(".old");
            std::fs::rename(&st.path, PathBuf::from(old))?;
            st.file = std::fs::OpenOptions::new().create(true).append(true).open(&st.path)?;
            st.written = 0;
        }
        st.file.write_all(buf)?;
        st.written += buf.len() as u64;
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.lock().expect("log writer 锁中毒").file.flush()
    }
}
```

（MakeWriter 走 tracing-subscriber 对 `Fn() -> W`（`W: io::Write`）的 blanket impl——`move || writer.clone()`，`RotatingWriter: Clone` 且每次写内部加锁。）

- [ ] **Step 4: 接线 lib.rs 与 main.rs**

`server/src/lib.rs` 模块表加（按字母序插入 `detect` 后）：

```rust
pub mod logging;
```

`server/Cargo.toml` `[dev-dependencies]` 追加：

```toml
log = "0.4"
tracing-log = "0.2"
```

`server/src/main.rs`：`Serve` 子命令参数追加（`compute` 字段后）：

```rust
/// 日志写文件（可选；默认 stdout），超 10MB 滚动为 <PATH>.old 单备份
#[arg(long)]
log_file: Option<PathBuf>,
```

`ServeArgs` 加 `pub log_file: Option<PathBuf>,` 并在 `Cli::parse` 匹配与构造处透传；`serve()` 中 `--root`/`--web-dist` 校验之后、`build_router`/`AppState` 构造之前加：

```rust
if let Err(e) = vviewer::logging::init_tracing(args.log_file.as_deref()) {
    eprintln!("error: --log-file 不可用: {e}");
    return Err(2);
}
```

- [ ] **Step 5: 跑测试确认通过 + 手工冒烟**

Run: `cargo test --manifest-path server/Cargo.toml`
Expected: 全部 PASS（logging 新用例 + watch 既有用例）。

冒烟（确认 --log-file 落盘与滚动路径真实可用，不进提交）：

```bash
cargo build --manifest-path server/Cargo.toml
./server/target/debug/vviewer serve --root samples/m1 --port 8399 --log-file /tmp/vv-log-smoke/vviewer.log &
sleep 2; curl -s http://127.0.0.1:8399/api/health >/dev/null; sleep 1
ls -la /tmp/vv-log-smoke/ && head -3 /tmp/vv-log-smoke/vviewer.log
kill %1
```

Expected: `/tmp/vv-log-smoke/vviewer.log` 存在且含 `[watch] root=…` 行（watch 日志已走 subscriber）。

- [ ] **Step 6: 提交**

```bash
git add server/src/logging.rs server/src/lib.rs server/src/main.rs server/Cargo.toml
git commit -m "feat(server): --log-file 单备份滚动与默认 notify 过滤（BUG-68）

why: 无轮转时异常路径下日志无上界增长（BUG-68）；notify 内部扫描 WARN
对用户无行动价值且是刷盘主体。
what: 新增 logging 模块（默认 info,notify=error、RotatingWriter 10MB 单备份
滚动）、Serve 增 --log-file，配置错误返回 exit 2 不 panic。"
```

---

### Task 4: 部署文档（deploy.md 日志节 + README 参数行）

**Files:**
- Modify: `docs/deploy.md`（systemd 节之后追加「日志与轮转」）
- Modify: `server/README.md`（`## CLI 参数` 表追加 `--log-file` 行）

**Interfaces:** 无代码接口。

- [ ] **Step 1: deploy.md 追加「日志与轮转」节**

在「systemd 常驻」节之后追加：

```markdown
## 日志与轮转

默认日志走 stdout（tracing 格式化）。默认过滤 `info,notify=error`：notify crate
的扫描 WARN（如数据根存在指向外部的 symlink、权限不足目录时的轮询报错）默认
静默，需要排查时用 `RUST_LOG` 覆盖：

\```bash
RUST_LOG=info,notify=warn ./server/target/release/vviewer serve --root /path/to/data
\```

长时间常驻二选一：

1. **systemd/journald（推荐）**：日志进 journald，自带大小上限与轮转
   （`journald.conf` 的 `SystemMaxUse` 等）；
2. **`--log-file <PATH>`**：服务端直接写文件，超过 10MB 自动滚动为
   `<PATH>.old`（单备份覆盖式）。

⚠️ 不要用 `nohup … > file 2>&1` 裸重定向到文件：无轮转无上限。数据根内存在
越界 symlink / 不可读目录时，旧版本曾出现日志无界增长与 CPU 空转（BUG-68，
2026-10-10 已修复并默认过滤 notify 扫描告警）；即便修复后，裸重定向也使任何
未预期的日志增长直达磁盘。
\```
```

（写入时去掉 `\` 转义——围栏用真实三反引号。）

- [ ] **Step 2: server/README.md 参数表加行**

`## CLI 参数` 表（`| 参数 | 默认 | 说明 |`）末尾追加：

```markdown
| `--log-file <PATH>` | stdout | 日志写文件（ANSI 关闭），超 10MB 滚动为 `<PATH>.old` 单备份；不可用则拒绝启动（exit 2） |
```

- [ ] **Step 3: 核对与提交**

通读两处改动确认与 `--cors-origin` 等既有条目格式一致。

```bash
git add docs/deploy.md server/README.md
git commit -m "docs(deploy): 日志与轮转指引——journald/--log-file/禁裸重定向（BUG-68）"
```

---

### Task 5: e2e-server 回归用例 + 全量验证门

**Files:**
- Modify: `apps/web/e2e-server/t-srv.spec.ts`（追加 `BUG-68` describe，沿用该文件 `spawnServe`/辅助实例模式）

**Interfaces:**
- Consumes: Task 1-3 修复后的 release 二进制；t-srv 既有 `spawnServe(port, extraArgs)`、SSE 模式（`POST /api/ticket` → `GET /api/events?ticket=`，参考 `b-server-file-service.spec.ts:224-232`）。
- Produces: BUG-68 可执行回归锚点（README §3.2.4：本任务即修复 PR，直接落正式断言，非 fixme）。

- [ ] **Step 1: 重建 release 二进制（含全部修复）**

```bash
cargo build --release --manifest-path server/Cargo.toml
```

- [ ] **Step 2: 在 t-srv.spec.ts 追加 BUG-68 用例**

文件末尾追加（端口 4383——与既有 4375-4379/4382 错开；模式参考该文件既有缺陷块）：

```ts
test.describe('BUG-68 [探索]: root 含越界 symlink 时 watcher 不降级', () => {
  // 修复前：inotify 建 watch 深入 symlink→外部目录遇 EACCES 失败 → 建连快照
  // 带 watch-degraded；修复后（follow_symlinks=false）不深入 → 无降级帧且
  // changed 照常（10-10 e2e 轮 §2.3 现场的最小化回归）。红相证据见 watch.rs
  // 单测 escape_symlink_root_watches_ok 的红→绿。
  test('建连快照无 watch-degraded，root 内变更照常 changed', async () => {
    test.setTimeout(30_000);
    const fs = await import('node:fs');
    const path = await import('node:path');
    const os = await import('node:os');
    // 1) 自建 root：内部 symlink → 外部目录（含 0o000 子目录）
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'vv-bug68-'));
    const root = path.join(base, 'root');
    const outside = path.join(base, 'outside');
    fs.mkdirSync(path.join(outside, 'locked'), { recursive: true });
    fs.chmodSync(path.join(outside, 'locked'), 0o000);
    fs.mkdirSync(root, { recursive: true });
    fs.symlinkSync(outside, path.join(root, 'escape'));
    // 2) 独立实例（4383）：--root 指向该 root（同源 web-dist 与既有实例一致）
    const child = spawn(binPath, [ // binPath/spawn 常量与该文件既有用法一致
      'serve', '--root', root, '--web-dist', WEB_DIST, '--port', '4383',
    ]);
    const base_url = 'http://127.0.0.1:4383';
    try {
      await waitForHealth(base_url); // 该文件/套件已有的 readiness helper；无则轮询 fetch /api/health
      // 3) SSE 建连：快照帧不得含 watch-degraded
      const ticket = ((await (await fetch(`${base_url}/api/ticket`, { method: 'POST' })).json()) as { ticket: string }).ticket;
      const res = await fetch(`${base_url}/api/events?ticket=${ticket}`, { headers: { accept: 'text/event-stream' } });
      expect(res.ok).toBeTruthy();
      const reader = res.body!.getReader();
      let snapshot = '';
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline) {
        const { value, done } = await Promise.race([
          reader.read(),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error('读帧超时')), 2_000)),
        ]);
        if (done) break;
        snapshot += new TextDecoder().decode(value);
        if (snapshot.includes('data:')) break; // 拿到建连快照/首帧即可
      }
      expect(snapshot).not.toContain('watch-degraded');
      // 4) root 内真实文件变更照常 changed（watcher 活着）
      fs.writeFileSync(path.join(root, 'seed68.txt'), 'x');
      let changed = '';
      while (Date.now() < deadline + 5_000) {
        const { value, done } = await Promise.race([
          reader.read(),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error('等 changed 超时')), 5_000)),
        ]);
        if (done) break;
        changed += new TextDecoder().decode(value);
        if (changed.includes('seed68.txt')) break;
      }
      expect(changed).toContain('changed');
      expect(changed).toContain('seed68.txt');
      reader.cancel().catch(() => {});
    } finally {
      child.kill('SIGTERM');
      fs.chmodSync(path.join(outside, 'locked'), 0o700);
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
```

（`binPath`/`WEB_DIST`/`waitForHealth` 若与该文件既有常量名不同，按文件内实际名称对齐；辅助实例用 `child.kill('SIGTERM')` 收尾，遵循该文件既有孤儿进程教训。）

- [ ] **Step 3: 跑新用例与服务端全量 e2e**

```bash
pnpm --filter web exec playwright test --config=playwright.server.config.ts
```

Expected: 全部 PASS（含既有 t-srv/t-cmp/b-server-* 不回归；新增 BUG-68 用例绿）。

- [ ] **Step 4: 全量验证门**

```bash
cargo test --manifest-path server/Cargo.toml   # Rust 全量
pnpm test                                       # vitest（web/packages 单测不回归）
```

Expected: 全绿。若前端 vitest 或既有套件出现与本次改动无关的失败，按既有口径区分（已知 flaky：m3-search.spec.ts:107 焦点断言）并在提交说明中如实记录。

- [ ] **Step 5: 提交**

```bash
git add apps/web/e2e-server/t-srv.spec.ts
git commit -m "test(e2e): BUG-68 回归——越界 symlink root 不降级且 changed 照常

why: BUG-68 修复（follow_symlinks=false + 抑制 + --log-file）缺服务端
端到端回归锚点。
what: t-srv 追加独立实例用例：SSE 建连快照无 watch-degraded、root 内
变更照常 changed。"
```

---

## Self-Review 记录

- Spec 覆盖：§4.1→Task 1；§4.2（filter 部分→Task 3 默认过滤、限频部分→Task 2）；§4.3→Task 3；§4.4→Task 4；§5.1→Task 1、§5.2→Task 2、§5.3/§5.4→Task 3、§5.5→Task 5；验收门→Task 5 Step 4。无缺口。
- 类型一致性：`ErrorLogGate::admit -> Admission`（Task 2 内定义与使用一致）；`init_tracing(Option<&Path>) -> io::Result<()>`（Task 3 定义与 main.rs 调用一致）；`session_loop` 新签名与 run_loop 调用一致。
- 红相说明：Task 1 两测有真实红相（health 断言/编译失败）；Task 5 的 e2e 用例不设红相（修复已先行落地，红相证据由 Task 1 单测红 + 10-10 事故现场承担，用例作为回归锚点）——已在用例注释中声明。
