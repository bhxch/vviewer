# 递延清偿批 阶段二（桌面壳 7 项）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 清偿 spec 2026-10-21-deferred-cleanup-design.md §3 阶段二的 7 项桌面壳递延项：其中 6 项修复落码、1 项（2-5）预检已核实解决转销账。

**Architecture:** 全部在 apps/desktop/src-tauri 薄壳内（main.rs 427 行 + ready.rs）与 server/tests/ready_protocol.rs 一个测试助手：进程治理（reap/信号）、stderr 块边界、重启异步化、dialog 源码锚、测试诊断面。零产品行为变更面在 wire 协议（VV_READY 契约不动）。

**Tech Stack:** Rust（Tauri 2 薄壳，独立 manifest+lockfile）、std 进程/线程原语、ctrlc 3.x（新依赖，简报授权）。

**Spec:** docs/superpowers/specs/2026-10-21-deferred-cleanup-design.md（§3 阶段二、§4 裁决 5、§6 门禁）

## Global Constraints

- main 直行；每任务原子 commit；Angular 规范中文提交信息。
- GUI 不可本地验证的验收形态：纯函数单测 + 源码锚/include_str 锚 + cargo check/clippy 全绿 + README 冒烟清单扩充（发布门禁项，实跑留实机窗口）。
- VV_READY wire 契约与 ready.rs 解析器行为零变更（2-5 已解决，不动）。
- desktop crate 为独立 manifest（Cargo.lock 独立入库）；新依赖只进 apps/desktop/src-tauri/Cargo.toml。
- SDD 台账：`.superpowers/sdd/2026-10-22-deferred-cleanup-stage2/progress.md`；阶段收口把终态抄送 docs/report/sdd-deferred-minors-2026-10-21.md。
- 预检结论（计划期已核实，实现者勿重复劳动）：**2-5 已解决**——ready.rs:7/40/124-126 既有严格数字校验与 `+`/`-` 拒绝锁测（桌面 T2 顺带落地），digest 注记过时，Task 7 仅回写销账。

---

### Task 1: health_status 诊断面改进（2-1）

**背景定位（计划期核实）：** `health_status` 是 server/tests/ready_protocol.rs:230 的**测试助手**（非产品代码）——解析失败 `unwrap_or(0)` 丢响应体，断言失败时只剩 `0 != 200` 无从诊断。修法=抽解析函数、失败携带响应头片段。

**Files:**
- Modify: `server/tests/ready_protocol.rs:228-245` 附近（health_status 与新解析函数）

**Interfaces:**
- Produces: `fn parse_status_line(head: &str) -> Result<u16, String>`（HTTP 状态行 → 状态码；失败 Err 携带原文片段）。

- [ ] **Step 1: 写失败测试**（ready_protocol.rs tests 区，本文件为集成测试文件、辅助函数在文件底部 `mod tests` 之外/之内以现状为准）

```rust
/// 2-1：状态行解析失败必须携带响应原文（诊断完整性——unwrap_or(0) 使
/// 「为何非 200」不可诊断）。
#[test]
fn parse_status_line_carries_diagnosis_on_failure() {
    assert_eq!(parse_status_line("HTTP/1.1 200 OK\r\n"), Ok(200));
    assert_eq!(parse_status_line("HTTP/1.0 500 Internal Server Error\r\n"), Ok(500));
    let err = parse_status_line("garbage\r\n").unwrap_err();
    assert!(err.contains("garbage"), "错误须携带原文: {err}");
    assert!(parse_status_line("HTTP/1.1\r\n").is_err(), "缺状态码段");
}
```

- [ ] **Step 2: 跑测试确认失败**（函数不存在编译败）

Run: `cargo test -p vviewer --test ready_protocol parse_status_line`
Expected: FAIL（E0425）

- [ ] **Step 3: 实现**——抽函数并接入 health_status：

```rust
/// 解析状态行第二段为状态码；失败 Err 携带响应头原文片段（2-1：诊断
/// 完整性——明文优于魔法值 0）。
fn parse_status_line(head: &str) -> Result<u16, String> {
    let code = head
        .split_whitespace()
        .nth(1)
        .ok_or_else(|| format!("状态行缺失码段: {head}"))?;
    code.parse::<u16>()
        .map_err(|_| format!("状态码非数字: {head}"))
}
```

health_status 循环内读到响应头后改为：`match parse_status_line(&head) { Ok(s) => return s, Err(msg) => panic!("{msg}") }`（连接失败仍走重试；**已收到响应但解析不了**属测试装置缺陷，立即 panic 带原文）。原 `unwrap_or(0)` 删除。

- [ ] **Step 4: 全量**

Run: `cargo test -p vviewer --test ready_protocol`
Expected: 4 passed（既有 spawn 用例零翻转）

- [ ] **Step 5: Commit**

```bash
git add server/tests/ready_protocol.rs
git commit -m "test(server): health_status 解析失败携带响应原文——诊断不再丢面（台账 2-1）"
```

---

### Task 2: spawn_exit_monitor Err 分支 reap（2-2）

**Files:**
- Modify: `apps/desktop/src-tauri/src/main.rs:279-284`（Err 分支）

- [ ] **Step 1: 实现**——Err 分支与 Ok(Some) 分支同纪律回收（kill+wait；kill 对已退出进程返回 Err 属预期，wait 兜底防僵尸）：

```rust
Err(_) => {
    // 2-2：try_wait Err 形态也须 reap（guard.take() 裸丢弃在部分平台
    // 留僵尸——与 kill_server 同纪律 kill+wait；kill 幂等可失败）
    if let Some(mut child) = guard.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
    drop(guard);
    ask_restart_or_exit(&app, LaunchFailure::Exited);
}
```

测试说明（如实）：try_wait 的 Err 形态平台级不可构造，无诚实单测——防线为与 Ok(Some) 分支共享回收纪律的代码评审；本任务不造 vacuous 测试。

- [ ] **Step 2: 编译+clippy+既有单测**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml && cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets`
Expected: 全绿零警告

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src-tauri/src/main.rs
git commit -m "fix(desktop): exit 监视 Err 分支补 reap——kill+wait 同纪律防僵尸（台账 2-2）"
```

---

### Task 3: stderr 跨块 UTF-8 边界保留（2-3）

**Files:**
- Modify: `apps/desktop/src-tauri/src/main.rs:306-325`（collect_stderr）
- Test: `apps/desktop/src-tauri/src/main.rs` tests 模块（新分块读装置）

**Interfaces:**
- Produces: `fn collect_stderr` 对「多字节字符被读边界切开」的流不再产出 U+FFFD 噪声（不完整尾字节跨读保留，EOF 时 lossy 兜底）。

- [ ] **Step 1: 写失败测试**（main.rs tests 模块）

```rust
/// 2-3：多字节字符被读边界切开时，摘要不得出现 U+FFFD（不完整尾巴跨读保留）。
#[test]
fn collect_stderr_keeps_multibyte_chars_across_chunk_boundary() {
    struct ChunkReader { data: Vec<u8>, pos: usize, chunk: usize }
    impl Read for ChunkReader {
        fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
            let end = (self.pos + self.chunk).min(self.data.len());
            let n = end - self.pos;
            out[..n].copy_from_slice(&self.data[self.pos..end]);
            self.pos = end;
            Ok(n)
        }
    }
    // "中" = 3 字节，读块大小 1 强制三块拼接；前后夹 ASCII 定位边界
    let payload = b"ok\xe4\xb8\xadend".to_vec();
    let tail = Arc::new(Mutex::new(String::new()));
    collect_stderr(ChunkReader { data: payload, pos: 0, chunk: 1 }, tail.clone());
    let s = tail.lock().unwrap().clone();
    assert_eq!(s, "ok中end", "跨块字符必须完整: {s:?}");
}
```

（`use std::io::Read;` tests 模块内补；Arc/Mutex 已在根 use。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml collect_stderr_keeps`
Expected: FAIL（现状 `s` 含 U+FFFD：`ok\u{fffd}\u{fffd}\u{fffd}end`）

- [ ] **Step 3: 实现**

```rust
/// stderr 收集线程：追加进环形尾部（保留最后 [`STDERR_TAIL_LIMIT`] 字节）。
/// 2-3：不完整 UTF-8 尾字节能跨读保留（向后找块内最后边界，剩余 ≤3 字节
/// 留待下块；EOF 时剩余 lossy 兜底）——逐块 lossy 会把被读边界撕开的
/// 多字节字符变成 U+FFFD 观感噪声。
fn collect_stderr<R: Read>(mut reader: R, tail: Arc<Mutex<String>>) {
    let mut buf = [0u8; 512];
    let mut pending: Vec<u8> = Vec::new();
    loop {
        match reader.read(&mut buf) {
            Ok(0) | Err(_) => {
                let mut t = tail.lock().unwrap();
                t.push_str(&String::from_utf8_lossy(&pending));
                trim_tail(&mut t);
                return;
            }
            Ok(n) => {
                pending.extend_from_slice(&buf[..n]);
                // 块内最后一个 UTF-8 边界：尾部最多 3 字节可能是被切开的多字节
                // 序列前缀；超过 3 字节仍无边界即非法序列，整块 lossy 兜底
                let mut split = pending.len();
                let limit = split.saturating_sub(3);
                while split > limit && !pending.is_char_boundary(split) {
                    split -= 1;
                }
                let flushed = String::from_utf8_lossy(&pending[..split]).into_owned();
                pending.drain(..split);
                let mut t = tail.lock().unwrap();
                t.push_str(&flushed);
                trim_tail(&mut t);
            }
        }
    }
}

/// 环形尾部裁剪（UTF-8 字符边界对齐；从 collect_stderr 各刷写点共用）。
fn trim_tail(t: &mut String) {
    let len = t.len();
    if len > STDERR_TAIL_LIMIT {
        let cut = len - STDERR_TAIL_LIMIT;
        let cut = (cut..len).find(|&i| t.is_char_boundary(i)).unwrap_or(len);
        t.drain(..cut);
    }
}
```

（EOF 分支的 pending 多数场景为空——push 空串无害；`trim_tail` 抽取系去重，行为与原裁剪逐语句一致。）

- [ ] **Step 4: 全量**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`
Expected: 全绿（既有 dialog 契约测试照绿）

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/main.rs
git commit -m "fix(desktop): stderr 跨块 UTF-8 边界保留——错误窗摘要不再产 U+FFFD 噪声（台账 2-3）"
```

---

### Task 4: 重启路径异步化（2-4）

**Files:**
- Modify: `apps/desktop/src-tauri/src/main.rs`（bootstrap/ask_restart_or_exit 回调 + 新 restart_async）

**Interfaces:**
- Produces: `fn restart_async(app: AppHandle)`——后台线程跑 start_and_wait，结果经 run_on_main_thread 回主线程（窗口创建 macOS 约束）。首次启动（setup 内）保持同步（无窗口可画，注释已声明）。

- [ ] **Step 1: 实现**

ask_restart_or_exit 的 restart 回调改为：

```rust
.show(move |restart| {
    if restart {
        let h = handle.clone();
        // 2-4：重启编排出主线程——同步等待 15s 曾冻结错误窗与事件循环
        let _ = h.run_on_main_thread(move || restart_async(h.clone()));
    } else {
        handle.exit(1);
    }
});
```

新增（bootstrap 下方）：

```rust
/// 重启编排（2-4）：后台线程 spawn+等就绪，主线程只做窗操作（macOS 约束）。
/// 结果两条路（建窗/再弹错误窗）各自回主线程分派；并发双重启由错误窗
/// 模态语义天然排除（一次仅一个待选窗）。
fn restart_async(app: AppHandle) {
    std::thread::spawn(move || match start_and_wait(&app) {
        Ok(port) => {
            let h = app.clone();
            let _ = app.run_on_main_thread(move || show_or_navigate(&h, port));
        }
        Err(failure) => {
            let h = app.clone();
            let _ = app.run_on_main_thread(move || ask_restart_or_exit(&h, failure));
        }
    });
}
```

bootstrap 与 setup 内首次启动注释不动（同步形态保留：setup 时无窗口，阻塞无碍——原文已在 main.rs:100-103）。ask_restart_or_exit 的 doc 注释补一行：「重启编排 2-4 起异步（restart_async），错误窗不再被 15s 等待冻结」。

- [ ] **Step 2: 编译+clippy+既有单测**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml && cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets`
Expected: 全绿

- [ ] **Step 3: 冒烟清单同步**——README 桌面冒烟清单的「重启服务」步补注：「点击后错误窗立即可交互（异步重启），就绪后原窗导航」。定位：README 桌面端章节冒烟清单（rg '重启服务' README.md）。

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src-tauri/src/main.rs README.md
git commit -m "fix(desktop): 重启编排异步化——错误窗不再被 15s 就绪等待冻结（台账 2-4）"
```

---

### Task 5: dialog Builder 链源码锚（2-6）

**Files:**
- Modify: `apps/desktop/src-tauri/src/main.rs` tests 模块（:405-427 区）

- [ ] **Step 1: 写测试**（紧邻既有 dialog_plugin_registers_manager_state）

```rust
/// 2-6 源码锚：main 的 Builder 链必须含 dialog 插件注册行。mock 契约测试
/// （上方）锁「注册后取态可用」，本锚锁「链上确实注册了」——Wry 不可 mock，
/// 删行防线=本锚+人工评审双保险（include_str 把源码烙进测试二进制，
/// 无盘上文件依赖）。
#[test]
fn builder_chain_registers_dialog_plugin() {
    const SRC: &str = include_str!("main.rs");
    assert!(
        SRC.contains(".plugin(dialog_plugin())"),
        "Builder 链缺 dialog 插件注册——错误窗三条路径将随 DialogExt state() panic 整体失效"
    );
}
```

- [ ] **Step 2: 跑测试**（本测试天然绿——它是锁测；有效性以变异心态核验：注释声明删行即红）

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml builder_chain`
Expected: PASS

- [ ] **Step 3: 既有测试 doc 同步**——dialog_plugin_registers_manager_state 的「局限（如实注记）」段末尾补一句：「删行防线另有 builder_chain_registers_dialog_plugin 源码锚（2-6），双保险成立」。

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src-tauri/src/main.rs
git commit -m "test(desktop): Builder 链 dialog 注册源码锚——删行防线从单人工升双保险（台账 2-6）"
```

---

### Task 6: 信号处理——SIGTERM/SIGINT 回收 sidecar（2-7）

**Files:**
- Modify: `apps/desktop/src-tauri/Cargo.toml`（新增 `ctrlc = "3"` 依赖）
- Modify: `apps/desktop/src-tauri/src/main.rs`（setup 内注册 + 可测抽取）
- Modify: `README.md`（冒烟清单补 SIGTERM 步）

**Interfaces:**
- Produces: `fn shutdown_now(state: &ServerState)`（kill_server + exit(0)，信号处理器与 RunEvent::Exit 共用语义体）。

- [ ] **Step 1: 依赖**

apps/desktop/src-tauri/Cargo.toml `[dependencies]` 追加 `ctrlc = "3"`（桌面 crate 独立 lockfile，提交带上 Cargo.lock 变更）。

- [ ] **Step 2: 写失败测试**（tests 模块）

```rust
/// 2-7：shutdown_now 语义体——kill_server（kill+wait 防僵尸）后 exit(0)。
/// exit 的进程终止面不可在测试内实跑（会杀掉测试进程），锁 kill 半边：
/// 用真实子进程验证回收（spawn sleep → shutdown 前半等价物）。
#[test]
fn shutdown_reaps_child_process() {
    let mut child = std::process::Command::new("sleep")
        .arg("30")
        .spawn()
        .expect("sleep 可用（coreutils）");
    // 与 shutdown_now 前半同语句（kill_server 私有于 bin——经同模块测试直调）
    let _ = child.kill();
    let _ = child.wait();
    // 已 reap：二次 wait 立即返回（无悬挂）
    assert!(child.try_wait().unwrap().is_some());
}
```

（说明：ctrlc 的 handler 注册与进程退出面不可 headless 单测——诚实边界照 2-6 先例注记；本测试锁语义体的可测半边。`sleep` 在 Windows CI 缺席——`#[cfg(unix)]` 门控本测试并在报告注记。）

- [ ] **Step 3: 跑测试确认失败**（函数不存在时跳过——本步实际为编译锚；测试体不依赖新函数，RED 形态=无）

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml shutdown_reaps`
Expected: PASS 与否均记录（测试锁的是语义半边，非新代码——诚实定性）

- [ ] **Step 4: 实现**——setup 内 manage 之后：

```rust
// 2-7：SIGTERM/SIGINT → 与 RunEvent::Exit 同一回收路径后退出——桌面壳被
// 信号终止时 server sidecar 不再孤儿化。Windows 如实注记：ctrlc 映射
// CTRL_C/CTRL_BREAK；TerminateProcess 强杀无回调面（文档语义基线，
// 台账 2-7 既往口径一致）。
let signal_app = app.handle().clone();
ctrlc::set_handler(move || {
    shutdown_now(&signal_app.state::<ServerState>());
})
.expect("注册信号处理器失败");
```

根区新增：

```rust
/// 信号退出语义体（2-7）：回收子进程后整进程退出；RunEvent::Exit 路径
/// （窗口关闭/错误窗退出）保持 app.exit 既有编排不动。
fn shutdown_now(state: &ServerState) {
    kill_server(state);
    std::process::exit(0);
}
```

- [ ] **Step 5: README 冒烟清单**——桌面端冒烟清单补一项：「启动后 `kill -TERM <壳pid>`：应用退出且 `pgrep vviewer-server` 无残留」（unix-only，标注）。

- [ ] **Step 6: 全量**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml && cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets`
Expected: 全绿

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src-tauri/Cargo.toml apps/desktop/src-tauri/Cargo.lock apps/desktop/src-tauri/src/main.rs README.md
git commit -m "fix(desktop): SIGTERM/SIGINT 注册回收处理器——sidecar 不再孤儿化（台账 2-7）"
```

---

### Task 7: 2-5 销账确认 + 阶段门禁 + digest 回写

**Files:**
- Modify: `docs/report/sdd-deferred-minors-2026-10-21.md`

- [ ] **Step 1: 2-5 核实记录**——ready.rs:124-126（`parse_ready_line("VV_READY port=+8080") == None` 等）已锁严格校验；digest 对应行（解析器容忍前导 +）标「✅ 已解决（桌面 T2 顺带落地，锁测在案）——阶段二核实销账，无新 commit」。

- [ ] **Step 2: 全量门禁**（desktop crate 与 server workspace 分开跑，先 server 后 desktop 勿并行）：

```bash
pnpm typecheck && pnpm vitest run && cargo test --workspace
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets 2>&1 | tail -3
```

Expected: 全绿零翻转；desktop clippy 零警告（薄壳纪律既有门）。

- [ ] **Step 3: digest 回写**——阶段二 7 项逐条终态（映射：2-1→Task 1 commit、2-2→Task 2、2-3→Task 3、2-4→Task 4、2-5→销账无 commit、2-6→Task 5、2-7→Task 6）；头部补「阶段二清偿：<日期>，6 修+1 销账」。

- [ ] **Step 4: 台账收口 + Commit**

```bash
git add docs/report/sdd-deferred-minors-2026-10-21.md
git commit -m "docs(report): 递延清偿批阶段二终态回写——6 修+2-5 核实销账"
```

## 任务依赖

Task 1（server tests）与 Task 2-6（desktop crate）零交叠；Task 2/3 同文件 main.rs 不同函数区——串行执行天然消冲突；Task 6 的 Cargo.toml/lockfile 独占；Task 7 恒最后。推荐执行序：2→3→4→5→6（desktop 聚批，T2/T3 可合并派发）→1→7。
