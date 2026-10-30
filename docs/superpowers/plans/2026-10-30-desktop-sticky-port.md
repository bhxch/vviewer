# 桌面粘性端口（sticky port）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 桌面薄壳记住上次成功端口并优先复用（bind 失败自动回退 `--port 0`），使绝大多数启动 origin 稳定，用户状态与 SW/HTTP 缓存跨启动生效。

**Architecture:** server 新增 `--emit-ready-line` 放宽 1-14 就绪行门（存量调用面输出零变化）；壳新增 `sticky.rs`（AppConfigDir 下 `desktop-shell.json` 读/写纯函数）并把 `start_and_wait` 改造为「粘性尝试 → Ended 回退 → 成功写回实测端口」两段编排。错误窗/重启/单实例/回收链路零改动（复用 start_and_wait）。

**Tech Stack:** Rust（Tauri 2 壳独立 workspace + axum/clap server）、serde_json（壳新直依赖）、cargo 集成测试（spawn 先例 `server/tests/ready_protocol.rs`）。

**Spec:** `docs/superpowers/specs/2026-10-30-desktop-sticky-port-design.md`（执行者须同读）

## Global Constraints

- 薄壳纪律：无 IPC/无 tauri:// 面；server 只绑 127.0.0.1、无 token、不加 --allow-lan（全部不变）。
- 1-14 语义：显式端口**不加 flag** 不输出就绪行；wire 格式 `VV_READY port=<n>` 恒纯净（`ready_line` 单测 + 集成断言双锁）。
- config 键名约定：FileConfig 字段名即 TOML 键名（蛇形，`config.rs:41-56` 先例）——新键 `emit_ready_line`（设计文档 D3 行的 `emit-ready-line` 是笔误，Task 4 修正）。
- 布尔开关合并语义：`cli.X || file.X.unwrap_or(false)`（SetTrue 通道，`config.rs:175` allow_lan 先例）。
- 壳侧验证边界：GUI 不可 headless 跑——壳任务=cargo check/clippy/test + 源码锚（2-6 先例），端到端归冒烟清单。
- 每任务 TDD（先失败测试后实现）+ 原子提交；commit message 中文 Angular 规范（`type(scope): 描述`）。
- 就绪协议/回收纪律不变：`ready.rs` 零改动；两次 spawn 间僵尸回收沿用 `kill_server`（kill+wait）。

## Review Focus

- 粘性端口被占（他进程或孤儿 sidecar）→ 回退随机端口成功、无错误窗 —— Task 3 源码锚 + 冒烟 9。
- 旧版 sidecar 无新 flag → 粘性与回退双双 exit 2 → 既有错误窗，stderr 尾部可见 `unexpected argument` 可诊断 —— Task 4 binaries/README 配套注记（D8 裁决：不做针对性文案）。
- sticky JSON 损坏 / 端口 0 / 字段缺失 → 静默视同无粘性、正常随机启动 —— Task 2 单测。
- 配置目录不可写 → 写回静默失败、启动不受影响 —— Task 2 单测。
- 回退成功后写回新端口成为新粘性（D6 自愈语义）—— Task 3 源码锚 + 冒烟 9 尾句。

---

### Task 1: server `--emit-ready-line` flag

**Files:**
- Modify: `server/src/main.rs:21-61`（`Command::Serve` clap 参数）
- Modify: `server/src/assembly.rs:21-58`（`ServeArgs` 字段 + 手工 Debug）、`assembly.rs:266-271`（就绪行门）
- Modify: `server/src/config.rs`（`FileConfig`、`ResolvedConfig`、合并、`From<ResolvedConfig>`、两处手工 Debug）
- Test: `server/tests/ready_protocol.rs`（两个新 spawn 集成测试）

**Interfaces:**
- Consumes: 既有 `serve()` 装配链、`ready_line(port: u16) -> String`（`assembly.rs:125`，wire 不动）。
- Produces:
  - clap: `serve --emit-ready-line`（`#[arg(long)] emit_ready_line: bool`）；
  - TOML: 顶层键 `emit_ready_line: Option<bool>`；
  - `ServeArgs` 新字段 `pub emit_ready_line: bool`；
  - 行为：`kernel_assigned || args.emit_ready_line` 为真且非测试构建 → 输出 `VV_READY port=<n>`。

- [ ] **Step 1: 写失败集成测试（追加到 `ready_protocol.rs`）**

先从既有测试尾部提取两个共享 helper（签名固定，实现照既有测试体搬）：

```rust
/// 挑一个当前空闲的 TCP 端口（bind :0 → 取 local_addr → drop；微小竞窗可接受，
/// 显式端口测试没有 --port 0 可用）
fn pick_free_port() -> u16 { /* std::net::TcpListener::bind("127.0.0.1:0") */ }

/// spawn serve（--root <dir> --port <port_arg> [--emit-ready-line]），返回
/// (KillOnDrop, stdout 行 Receiver, stderr 累积缓冲)——stdout/stderr 排水形态
/// 照既有 serve_port_zero_assigns_kernel_port_and_emits_ready_line 测试体
fn spawn_serve(dir: &std::path::Path, port_arg: &str, emit_ready_line: bool)
    -> (KillOnDrop, mpsc::Receiver<String>, Arc<Mutex<String>>)
```

新测试一（flag 使显式端口出就绪行）：

```rust
#[test]
fn serve_explicit_port_with_flag_emits_ready_line() {
    // pick_free_port + tempdir → spawn_serve(dir, &port.to_string(), true)
    // 15s 内收到一行，断言该行 == format!("VV_READY port={port}")（纯净）
    // 裸 TCP GET /api/health 断言 200（照既有测试收尾形态）
}
```

新测试二（无 flag 锁 1-14 静默）：

```rust
#[test]
fn serve_explicit_port_without_flag_stays_silent() {
    // spawn_serve(dir, &port.to_string(), false)
    // 轮询 GET /api/health 至 200（上限 15s，说明 bind 已过、ready_line 打印点已过）
    // 再 drain stdout 500ms：断言从未出现 VV_READY 前缀行
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test --manifest-path server/Cargo.toml --test ready_protocol`
Expected: 编译失败（`--emit-ready-line` 未知参数 clap 直接报错 / `spawn_serve` 未定义）

- [ ] **Step 3: 实现四处接线**

1. `main.rs` `Command::Serve`：`/// 输出 VV_READY port=<n> 就绪行（桌面薄壳消费；显式端口默认不输出，1-14）#[arg(long)] emit_ready_line: bool`，并进 `ServeArgs { .. }` 构造。
2. `assembly.rs` `ServeArgs`：`pub emit_ready_line: bool` + 手工 Debug 追加 `.field("emit_ready_line", &self.emit_ready_line)`（非敏感，原样）。
3. `assembly.rs:268-271` 门改为 `#[cfg(not(test))] if kernel_assigned || args.emit_ready_line { ... }`（注记 1-14 修订：flag 为显式 opt-in 通道）。
4. `config.rs`：`FileConfig` 加 `pub emit_ready_line: Option<bool>`；`ResolvedConfig` 加 `pub emit_ready_line: bool`；合并行照 `config.rs:175` 形态 `emit_ready_line: cli.emit_ready_line || file.emit_ready_line.unwrap_or(false),`；`From<ResolvedConfig> for ServeArgs` 构造与两处手工 Debug 各补一字段。

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run: `cargo test --manifest-path server/Cargo.toml`
Expected: 新增两测 PASS；既有 `ready_line_wire_format_is_exact`（assembly.rs:773）与全部存量测试 PASS（输出零变化证明）

- [ ] **Step 5: Commit**

```bash
git add server/src/main.rs server/src/assembly.rs server/src/config.rs server/tests/ready_protocol.rs
git commit -m "feat(server): --emit-ready-line 显式端口就绪行通道——壳粘性端口前提（1-14 存量面零变化）"
```

---

### Task 2: 壳 sticky 模块（读/写纯函数）

**Files:**
- Modify: `apps/desktop/src-tauri/Cargo.toml`（`[dependencies]` 加 `serde_json = "1"`）
- Create: `apps/desktop/src-tauri/src/sticky.rs`（模块 + `#[cfg(test)] mod tests`）
- Modify: `apps/desktop/src-tauri/src/main.rs`（`mod sticky;` 声明，紧跟 `mod ready;`）

**Interfaces:**
- Consumes: 无（叶子模块）。
- Produces（Task 3 消费，签名精确）:

```rust
/// 粘性端口落盘文件名（AppConfigDir 下）
pub const STICKY_FILE: &str = "desktop-shell.json";
/// 读粘性端口：文件缺失/JSON 损坏/字段缺失/端口 0 一律 None，不 panic 无告警
pub fn read_sticky_port(dir: &std::path::Path) -> Option<u16>;
/// 写粘性端口：create_dir_all + 覆写 JSON {"port": n}；任何 IO/序列化错误静默吞
/// （持久化是优化不是依赖）
pub fn write_sticky_port(dir: &std::path::Path, port: u16);
```

- [ ] **Step 1: 写失败单测（`sticky.rs` tests mod）**

七例，断言面即接口语义：

```rust
roundtrip_writes_and_reads_back        // write(8080) → read == Some(8080)
missing_file_is_none                   // 空目录 → None
corrupt_json_is_none                   // 手写 "not json" → None
zero_port_is_none                      // 手写 {"port":0} → None
missing_port_field_is_none             // 手写 {} → None
write_creates_missing_dir              // 不存在的两级目录 → write → read 命中
write_failure_never_panics             // dir 是一个普通文件（create_dir_all 必败）→ 不 panic
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml sticky`
Expected: 编译失败（模块不存在）

- [ ] **Step 3: 实现**

`serde_json::json!` / 派生 `Deserialize` 的小结构体二选一（≤30 行）；读侧 `std::fs::read_to_string` + 解析 + `port != 0` 校验；写侧 `create_dir_all` + `fs::write`，`let Ok(..) = ... else { return }` 吞错。

- [ ] **Step 4: 跑测试确认通过 + clippy**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml && cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets`
Expected: sticky 七例 PASS；存量测试 PASS；clippy 零告警

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/Cargo.toml apps/desktop/src-tauri/Cargo.lock apps/desktop/src-tauri/src/sticky.rs apps/desktop/src-tauri/src/main.rs
git commit -m "feat(desktop): sticky 模块——粘性端口 AppConfigDir 读/写纯函数（损坏容错静默降级）"
```

---

### Task 3: 壳启动编排（粘性 → 回退 → 写回）

**Files:**
- Modify: `apps/desktop/src-tauri/src/main.rs:159-219`（`start_and_wait` 改造 + 新 `attempt_start`）
- Test: `apps/desktop/src-tauri/src/main.rs` tests mod（源码锚一例）

**Interfaces:**
- Consumes: Task 2 `sticky::{STICKY_FILE, read_sticky_port, write_sticky_port}`；既有 `kill_server`/`wait_for_ready`/`spawn_stdout_reader`/`RestartGuard`（语义全部不动）。
- Produces: `start_and_wait(app: &AppHandle) -> Result<u16, LaunchFailure>` 签名不变（bootstrap/restart_async 零改动）；新增私有：

```rust
/// 单次 spawn+等就绪（port_arg 为 "--port" 的值："0" 或粘性端口十进制串）。
/// 开场 kill_server 出旧槽 + stderr_tail 重置；Timeout 自行 kill 后回 Err。
fn attempt_start(app: &AppHandle, generation: u64, port_arg: &str,
                 sidecar: &std::path::Path, web_dist: &std::path::Path,
                 root: &std::path::Path) -> Result<u16, crate::ready::WaitFailure>;
```

编排语义（D3-D6，全部落在本任务）：
- 组件解析（sidecar/web_dist/root）留在 `start_and_wait`，Resolve 失败一次性早退（不重试）；
- 粘性文件路径：`app.path().resolve(sticky::STICKY_FILE, BaseDirectory::AppConfigDir)`（`use tauri::path::BaseDirectory` 已有），`.ok()` 失败 = 无粘性；其 `parent()` 为读写目录；
- 首选粘性端口（`Some(p)` 且 `p != 0`）→ `attempt_start(.., &p.to_string(), ..)`；
- `Err(WaitFailure::Ended)` → `attempt_start(.., "0", ..)` 回退一次（bind 失败 exit 2 → stdout EOF 即此形态）；
- `Err(WaitFailure::Timeout)` → **不回退**（防 30s+ 最坏启动）：`kill_server` + `Err(LaunchFailure::Timeout)`（既有映射）；
- 回退成功同路径成功（D6）：任一尝试 `Ok(port)` → `sticky::write_sticky_port(dir, port)` → `Ok(port)`；
- `Ended`（回退也败）→ `Err(LaunchFailure::Exited)`（既有映射）；
- C4 护栏：`restarting` 置位 + `RestartGuard` + `generation += 1` 留在 `start_and_wait` 开场，跨两次尝试生效；退出监视仍仅在最终 `Ok` 后 spawn 一次。

- [ ] **Step 1: 写失败源码锚测试（tests mod，照 2-6 `builder_chain_registers_dialog_plugin` 的 concat! 防 vacuous 惯例）**

```rust
/// 粘性编排源码锚：read/write 接线与 attempt_start 抽取缺失任一即红。
/// 回退尝试 "0" 的语义 headless 不可锚（传参形态随实现者裁量），GUI 冒烟 9 承载。
#[test]
fn orchestration_wires_sticky_read_write_and_attempt_start() {
    const SRC: &str = include_str!("main.rs");
    assert!(SRC.contains(concat!("sticky::", "read_sticky_port")), "缺粘性读取");
    assert!(SRC.contains(concat!("sticky::", "write_sticky_port")), "缺成功写回（D6）");
    assert!(SRC.contains(concat!("fn attempt_", "start(")), "缺单次尝试抽取（回退载体）");
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml orchestration_wires`
Expected: FAIL（缺 sticky::read_sticky_port 接线）

- [ ] **Step 3: 实现 `attempt_start` + `start_and_wait` 两段编排**

现 `start_and_wait` 中「Command::new 起到 wait_for_ready 止」整体平移进 `attempt_start`（`"0"` 字面量换 `port_arg` 参数，其余逐字保留：stderr 重置/stdout reader/child 入槽）；`start_and_wait` 按「编排语义」重写为解析 + 粘性读取 + 尝试/回退 + 写回。doc 注记更新：就绪行前提从 `--port 0` 放宽为 `--emit-ready-line`（壳恒传，见 Task 1）。

- [ ] **Step 4: 跑测试确认通过 + 全量壳回归**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml && cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets && cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml`
Expected: 新锚 + 存量 15 例（C1 契约/C4 护栏/stderr 收集等）全 PASS；clippy 零告警

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/main.rs
git commit -m "feat(desktop): 启动编排粘性端口化——Ended 回退 --port 0、成功写回（D4-D6）"
```

---

### Task 4: 文档对齐 + 全量回归

**Files:**
- Modify: `apps/desktop/src-tauri/binaries/README.md`（版本配套注记）
- Modify: `apps/desktop/README.md:53`（启动编排描述）+ 冒烟清单（增 8/9 两行）
- Modify: `docs/superpowers/specs/2026-10-30-desktop-sticky-port-design.md`（D3 行 TOML 键名笔误 `emit-ready-line` → `emit_ready_line`；裁决补记追加一条）

**Interfaces:**
- Consumes: Task 1-3 的事实面（flag 名、编排语义、回退链）。
- Produces: 文档与实现一致（无新代码面）。

- [ ] **Step 1: 三处文档修改**

1. `binaries/README.md` 追加：sidecar 须与本壳同代（需支持 `--emit-ready-line`）；旧版 sidecar 会粘性与回退双双启动失败，错误窗 stderr 尾部可见 `unexpected argument '--emit-ready-line'` 即此症（D8）。
2. `apps/desktop/README.md:53` 改为：server 额外参数固定 `serve --port <粘性|0> --emit-ready-line`（粘性=上次成功端口，AppConfigDir `desktop-shell.json`；被占回退内核分配）；冒烟清单追加两行（内容照 spec「行为规格」8/9 行逐字）。
3. spec D3 行与「裁决补记」：TOML 键名修正为 `emit_ready_line`（补注「计划期核对 FileConfig 命名约定后修正」）。

- [ ] **Step 2: 全量回归**

Run: `cargo test --manifest-path server/Cargo.toml && cargo clippy --manifest-path server/Cargo.toml --all-targets && cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml && cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets`
Expected: 双 workspace 全绿

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src-tauri/binaries/README.md apps/desktop/README.md docs/superpowers/specs/2026-10-30-desktop-sticky-port-design.md
git commit -m "docs(desktop): 粘性端口文档对齐——版本配套注记/冒烟 8-9/spec 键名笔误修正"
```

- [ ] **Step 4: 人工冒烟移交（无法 headless，向用户交代）**

冒烟 8（设置跨重启保留）、9（占端口回退）留待真实 GUI 执行，端到端验收以此为准。
