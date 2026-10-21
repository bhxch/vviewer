# 递延清偿批 阶段一（server/core/worker 14 项）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 清偿递延清偿批（spec 2026-10-21-deferred-cleanup-design.md §3 阶段一）的 14 项 server/core/worker 递延项，行为锁零翻转。

**Architecture:** 全部为既有接口内的小修：凭据 Debug 面收口、Range 错误优先级重排、core 状态字段收敛、wasm 门控补齐与谓词统一、worker 判定时机前移、注释文档修正、TS 信号守卫收编、VV_READY 输出门控。无新依赖（Task 5 的流式读用 worker crate 既有 futures 面）。

**Tech Stack:** Rust（axum 适配层 / vviewer-core / vviewer-storage / vviewer-worker，workers-rs 0.8.7）+ TypeScript（packages/core tree store，vitest）。

**Spec:** docs/superpowers/specs/2026-10-21-deferred-cleanup-design.md（§3 阶段一、§4 裁决、§6 门禁）

## Global Constraints

- main 直行，不建 worktree（仓库既有实践）；每任务原子 commit，Angular 规范中文提交信息。
- 行为锁：既有测试零改动零翻转（本计划明示改锚的除外：Task 2 新增 416 前置、Task 8 VV_READY 语义变更）。
- clippy：与基线（48 项）比零新增；`cargo clippy --workspace --all-targets` 纪律照旧。
- wasm 双形态纪律：`cargo check -p vviewer-core -p vviewer-worker --target wasm32-unknown-unknown --no-default-features` 零告警；native `cargo test --workspace` 全绿。
- 重建前端一律 `pnpm --filter web build:e2e`（本阶段无前端构建面，仅防误操作注记）。
- SDD 台账：`.superpowers/sdd/2026-10-21-deferred-cleanup-stage1/progress.md`（`cat >>` heredoc 追加，逐任务记 `minor (deferred)`）；阶段收口把各任务终态抄送 docs/report/sdd-deferred-minors-2026-10-21.md。

---

### Task 1: config Debug 面 token 脱敏（1-1）

**背景勘误（须入报告）：** 台账原文「config.rs server 侧 MountConfig derive(Debug) 泄漏面」已被现状推翻——core/src/mounts.rs:65-83 的 MountConfig 手工 Debug 已脱敏，且 server/src/config.rs:433-443 已有嵌套 Debug 锁测（FileConfig/ResolvedConfig 走同一实现）。**真实残留 = `FileConfig.token` / `ResolvedConfig.token` / `ServeArgs.token` 三个字段明文进 Debug**。本任务修 token 面，并把勘误写进任务报告。

**Files:**
- Modify: `server/src/config.rs`（FileConfig/ResolvedConfig 手工 Debug）
- Modify: `server/src/main.rs:120` 附近的 ServeArgs（手工 Debug 或脱敏包装）
- Test: `server/src/config.rs` 既有 tests 模块内追加

**Interfaces:**
- Produces: `FileConfig`/`ResolvedConfig`/`ServeArgs` 的 Debug 输出中 token 恒为 `[redacted]`/存在性标记；无新公共 API。

- [ ] **Step 1: 写失败锁测**（config.rs tests 模块，紧邻既有 redacted 测试）

```rust
/// 1-1：token 字段不得经任何配置结构 Debug 外泄（MountConfig 已脱敏的姊妹锚——
/// 台账 deferred 1-1 的真实残留面）。
#[test]
fn token_is_redacted_in_all_config_debug_faces() {
    let mut f = FileConfig::default();
    f.token = Some("TOPSECRET-TOKEN".into());
    let dbg = format!("{f:?}");
    assert!(!dbg.contains("TOPSECRET-TOKEN"), "{dbg}");
    assert!(dbg.contains("[redacted]"), "存在性保留: {dbg}");

    let r = resolve_config(cli(&["/c1"]), Some(f)).unwrap();
    // resolve_config 不搬 token 以外的密值；此处直接构造断言
    let mut r2 = r.clone();
    r2.token = Some("TOPSECRET-TOKEN".into());
    assert!(!format!("{r2:?}").contains("TOPSECRET-TOKEN"));

    let args: ServeArgs = r2.into();
    // ServeArgs::from 透传 token；Debug 面同样脱敏
    let mut a = args;
    a.token = Some("TOPSECRET-TOKEN".into());
    assert!(!format!("{a:?}").contains("TOPSECRET-TOKEN"));
}
```

（`cli()` helper 为 config.rs 既有测试装置；若签名不同以现状为准，断言主体不变。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test -p vviewer --lib token_is_redacted`
Expected: FAIL（Debug 含明文 token）

- [ ] **Step 3: 实现**——FileConfig/ResolvedConfig 改手工 Debug（MountConfig 同款 `redacted` 闭包风格，仅 token 脱敏、其余字段原样）：

```rust
impl std::fmt::Debug for FileConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FileConfig")
            .field("root", &self.root)
            .field("web_dist", &self.web_dist)
            .field("port", &self.port)
            .field("token", &self.token.as_ref().map(|_| "[redacted]"))
            // ……其余字段逐个原样列出（allow_lan/hidden/cors_origin/compute/log_file/mounts）
            .finish()
    }
}
```

ResolvedConfig/ServeArgs 同型。**derive 上的 `Debug` 移除，其余 derive（Clone/PartialEq/Default/Deserialize）保留**——PartialEq 不受影响；若 `#[derive(Debug)]` 被 tests 或 log 用到，行为等价（脱敏后）。

- [ ] **Step 4: 全量 config 测试**

Run: `cargo test -p vviewer --lib config`
Expected: PASS（含既有 mounts 嵌套锁测）

- [ ] **Step 5: Commit**

```bash
git add server/src/config.rs server/src/main.rs
git commit -m "fix(server): 配置三面 token 字段 Debug 脱敏——凭据不入日志（台账 1-1）

MountConfig 嵌套脱敏既有锁测在案；真实残留为 FileConfig/ResolvedConfig/
ServeArgs 顶层 token 明文，改手工 Debug 补齐（存在性标记保留）。台账
deferred 的 MountConfig 表述系过时记录，勘误随阶段台账回写 digest。"
```

---

### Task 2: file 域——Range 语法前置 416 与窗口断言（1-2、1-3）

**Files:**
- Modify: `server/src/routes/file.rs`（parse_range 拆分 + handler 前置语法判定）
- Modify: `server/core/src/file.rs:76-83`（read 窗口 debug_assert）
- Test: `server/src/routes/file.rs` tests 模块、`server/tests/tree_file.rs`

**Interfaces:**
- Produces: `parse_range_syntax(h: &str) -> Result<Option<RawRange>, ()>`（语法面，不依赖 size）；`RawRange { first: Option<u64>, last: Option<u64> }`（`bytes=a-` → `{Some(a), None}`；`bytes=-n` 后缀 → `{None, Some(n)}`）；既有 `parse_range(h, size)` 保留为 syntax+resolve 组合（签名不变，既有锁测零改动）。
- Produces: 语法非法的 Range 在 locate 之前即 416（`Content-Range: bytes */*`）；打开失败（500 面）仅在 Range 合法或缺失时可达。

- [ ] **Step 1: 写失败测试**（两处）

routes/file.rs tests 内（纯函数面）：

```rust
/// 1-2：语法判定与 size 无关——非法语法在 locate 前即可判 416。
#[test]
fn range_syntax_is_checkable_without_size() {
    assert!(parse_range_syntax("bytes=x-y").is_err());
    assert!(parse_range_syntax("units=0-1").is_err());
    assert_eq!(parse_range_syntax("bytes=0-1"), Ok(Some(RawRange { first: Some(0), last: Some(1) })));
    assert_eq!(parse_range_syntax("bytes=-4"), Ok(Some(RawRange { first: None, last: Some(4) })));
    assert_eq!(parse_range_syntax("bytes=250-"), Ok(Some(RawRange { first: Some(250), last: None })));
    assert_eq!(parse_range_syntax(""), Ok(None), "无 Range 头形态由调用方保证非空");
}
```

server/tests/tree_file.rs（router 面——RED 关键：语法非法 Range + 不存在路径 → 416 而非 404/500）：

```rust
/// 1-2：双重故障错误优先级——语法非法 Range 先于 locate 失败（台账 1-2：
/// Range 非法+打开失败并存时 416 优先，不再让 500/404 抢答）。
#[tokio::test]
async fn invalid_range_wins_over_missing_file() {
    let app = ...; // 既有测试装置同款（照本文件首例装配）
    let res = app.oneshot(get("/api/file?path=/no/such.bin").header("range", "bytes=x-y")).await.unwrap();
    assert_eq!(res.status(), 416);
    assert_eq!(res.headers().get("content-range").unwrap(), "bytes */*");
}
```

（装置形态照 tree_file.rs 既有用例；helper 名以文件现状为准。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test -p vviewer --lib range_syntax && cargo test -p vviewer --test tree_file invalid_range`
Expected: 均 FAIL（函数不存在 / 现返回 404）

- [ ] **Step 3: 实现**

routes/file.rs：把 `parse_range` 拆为语法面 `parse_range_syntax` 与定界面 `resolve_range(raw, size)`（first/last 的 None 语义：后缀/开区间；钳制与不可满足判定照搬现逻辑分支）；`parse_range(h, size)` 重写为两者组合（行为逐字节等价，既有锁测验证）。handler 在 `locate` **之前**插入：

```rust
// 1-2 双重故障优先级：Range 语法非法与文件是否存在无关（RFC 9110 §14.2 的
// 请求语法错误），在 stat/打开之前即 416（size 未知形态 `bytes */*`）
if let Some(h) = headers.get(header::RANGE).and_then(|v| v.to_str().ok()) {
    if !if_range_present && !has_multiple_ranges(h) && parse_range_syntax(h).is_err() {
        return Ok(range_not_satisfiable_unbounded());
    }
}
```

新 `range_not_satisfiable_unbounded()`：同 `range_not_satisfiable` 但 `Content-Range: bytes */*`。If-Range/多区间过滤既有语义不动（它们命中时 Range 整体忽略，不进本分支）。

core/src/file.rs read（:83 前）：

```rust
Some(w) => {
    // 1-3：路由层解析产物不变式——窗口非空（len=0 窗是上游解析缺陷，
    // 静默产出空 206 会污染缓存语义）
    debug_assert!(w.len >= 1, "empty window from route layer: {w:?}");
    (StatusCode::PARTIAL_CONTENT, Some(w.start), w.len)
}
```

- [ ] **Step 4: 跑全部相关测试**

Run: `cargo test -p vviewer --lib && cargo test -p vviewer --test tree_file`
Expected: PASS 零翻转（既有 parse_range 锁测经组合路径仍绿）

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/file.rs server/core/src/file.rs server/tests/tree_file.rs
git commit -m "fix(server): Range 语法错误前置 416——双重故障不再让 500/404 抢答（台账 1-2）

parse_range 拆语法面/定界面组合复用，handler 在 locate 前判语法；
size 未知形态 Content-Range 用 bytes */*。连带 core::file 补窗口
len>=1 debug_assert（台账 1-3）。"
```

---

### Task 3: CoreState 收口——runtime_transport 私有化与 version 断言（1-4、1-5）

**Files:**
- Modify: `server/core/src/state.rs`（字段可见性、health 断言）
- Test: `server/core/src/state.rs` tests、`server/core/src/health.rs` tests

**Interfaces:**
- Consumes: 既有 `with_transport()`（唯一 setter，不动）。
- Produces: `runtime_transport` 字段私有（跨 crate 只经 `with_transport`/`register_mount`）；`health::handle` 对空 version debug_assert。

- [ ] **Step 1: 消费面盘点（不改码）**

Run: `rg -n 'runtime_transport' server/ --type rust | grep -v 'core/src/state.rs'`
Expected: 记录全部命中——适配层委托 `with_transport`（server/src/state.rs 注释在案），worker 经 `with_transport`；若存在跨 crate 直接字段读写，先改为 `with_transport` 委托并在报告记录。

- [ ] **Step 2: 写失败测试**（health.rs tests 内）

```rust
/// 1-5：旁路构造的空 version 在 debug 构建即暴露（装配点必然注入的
/// 不变式锚；release 无断言、行为不变）。
#[test]
#[cfg(debug_assertions)]
#[should_panic(expected = "version 未注入")]
fn health_rejects_uninjected_version_in_debug() {
    let state = test_state_with_version(""); // 既有测试装置，version 显式置空
    let _ = vviewer_core::health::handle(&state, true).unwrap();
}
```

（health::handle 签名以现状为准；装置若不能显式置空 version，用 `CoreState::new` 后改字段。）

- [ ] **Step 3: 跑测试确认失败**

Run: `cargo test -p vviewer-core health_rejects_uninjected`
Expected: FAIL（当前无断言，不 panic）

- [ ] **Step 4: 实现**

state.rs:115 字段 `pub runtime_transport` → 去掉 `pub`（doc 注释「私有面」本就如此声明）；同文件内 `with_transport`/`register_mount` 消费不动。health.rs handle 入口处：

```rust
// 1-5：version 由适配层装配注入（CARGO_PKG_VERSION）；空串=旁路构造，
// debug 构建立即暴露，release 宣告空串行为不变（既有 wire 不改）
debug_assert!(!state.version.is_empty(), "version 未注入（旁路构造？）");
```

Step 2 的 `state.version` 字段本就是 pub 写入面（既有测试 :367 同款），保留。

- [ ] **Step 5: 全量回归**

Run: `cargo test -p vviewer-core && cargo test --workspace`
Expected: 全绿零翻转（若 health 既有测试有未注入 version 的旁路构造，为其补 `version: "test"` 注入并在报告记录——属测试装置适配非行为变更）

- [ ] **Step 6: Commit**

```bash
git add server/core/src/state.rs server/core/src/health.rs
git commit -m "refactor(core): runtime_transport 收私有+version 空串 debug 断言（台账 1-4/1-5）

runtime_transport 消费面本就仅 register_mount/with_transport（doc 已声明
私有面），可见性落到实处；health 对旁路构造的空 version 在 debug 构建即
panic，release wire 零变化。"
```

---

### Task 4: events wasm 门控与谓词统一（1-6、1-7）

**Files:**
- Modify: `server/core/src/lib.rs:28`（events 模块门）
- Modify: `server/worker/src/lib.rs:28,30,41,44,49`（谓词统一）
- Test: 既有编译锚（无新测试文件；core events 锚测照旧）

**Interfaces:**
- Produces: wasm 目标下 `vviewer_core::events` 不存在；全仓 `cfg` 谓词统一为 `target_family = "wasm"`。

- [ ] **Step 1: 消费面盘点（不改码）**

Run: `rg -n 'crate::events|core::events|use crate::events' server/ | grep -v 'core/src/events.rs'`
Expected: 仅适配层 server/src/routes/events.rs（native-only 编译）与 core tests。worker 零命中（能力矩阵本就不挂 events）。若有 wasm 可达消费点，停下报告裁决。

- [ ] **Step 2: 实现**

lib.rs:28：

```rust
/// SSE events 域：worker 形态不挂载（能力矩阵裁剪），wasm 目标整体不编译
/// （台账 1-6：tokio broadcast/mpsc 在 wasm 可编译但驱动面有运行时 panic 触点
/// ——不可达论证成立后按模块级门控落死）。tickets 为纯表结构不随门。
#[cfg(not(target_family = "wasm"))]
pub mod events;
```

worker/src/lib.rs 五处 `#[cfg(target_arch = "wasm32")]` → `#[cfg(target_family = "wasm")]`（1-7 统一口径：与 core search/state/guard、storage s3/lib 既有六处一致；模块 doc 注释里「wasm32-unknown-unknown」的文字表述不动——那是目标名不是谓词）。

- [ ] **Step 3: 双形态编译锚 + 全量测试**

Run: `cargo check -p vviewer-core --target wasm32-unknown-unknown --no-default-features && cargo check -p vviewer-worker --target wasm32-unknown-unknown --no-default-features && cargo check --workspace --all-targets --no-default-features && cargo test --workspace`
Expected: 全绿（core events 锚测 host 照常；events.rs 内 `#[cfg(test)]` 随模块门在 wasm 消失——host 测试面不变）

- [ ] **Step 4: Commit**

```bash
git add server/core/src/lib.rs server/worker/src/lib.rs
git commit -m "refactor(core,worker): events 随 wasm 目标门控+谓词统一 target_family（台账 1-6/1-7）

events 域 worker 不挂载、wasm 不编译（模块级门落死不可达面）；全仓
cfg 谓词从 wasm32/target_family 混用统一为 target_family=\"wasm\"。"
```

---

### Task 5: worker——is_asset_path 大小写与 413 判定时机（1-8、1-10）

**Files:**
- Modify: `server/worker/src/http.rs:57`（is_asset_path）
- Modify: `server/worker/src/http.rs`（新增 payload 累计闸纯函数）
- Modify: `server/worker/src/dispatch.rs:214-226`（mounts_register）
- Test: `server/worker/src/http.rs` tests 模块（native 跑法照既有 `cargo test -p vviewer-worker`）

**Interfaces:**
- Produces: `is_asset_path` 对 `.WASM/.Scm/.MJS/.CSS` 等大小写变体命中；`payload_fits(acc: &mut usize, chunk_len: usize, cap: usize) -> bool`（累计闸纯函数，跨目标编译）。

- [ ] **Step 1: 写失败测试**（http.rs tests）

```rust
/// 1-8：扩展名大小写不敏感（C1 纪律的补网——`.WASM` 误载 HTML 的同型风险）。
#[test]
fn asset_path_is_case_insensitive() {
    for p in ["/grammars/rust.WASM", "/grammars/Rust.Wasm", "/x.SCM", "/a.Mjs", "/s.Css"] {
        assert!(is_asset_path(p), "{p}");
    }
    assert!(!is_asset_path("/plain.WASMX"), "非尾扩展不算");
}

/// 1-10：累计闸语义——边界恰等允许、超一即拒（分块到达序无关）。
#[test]
fn payload_gate_bounds_accumulation() {
    let mut n = 0usize;
    assert!(payload_fits(&mut n, 100, 100) && n == 100);
    assert!(!payload_fits(&mut n, 1, 100));
    let mut m = 99usize;
    assert!(payload_fits(&mut m, 1, 100) && m == 100);
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test -p vviewer-worker asset_path_is && cargo test -p vviewer-worker payload_gate`
Expected: FAIL

- [ ] **Step 3: 实现**

http.rs：

```rust
pub fn is_asset_path(path: &str) -> bool {
    // 1-8：大小写不敏感（ASCII 恒可——扩展名集全 ASCII）
    let lower = path.to_ascii_lowercase();
    lower.ends_with(".wasm") || lower.ends_with(".scm")
        || lower.ends_with(".mjs") || lower.ends_with(".css")
}

/// 1-10 累计闸：消费一块前判定，累计超 cap 即 false（调用方 413）。
pub fn payload_fits(acc: &mut usize, chunk_len: usize, cap: usize) -> bool {
    let next = acc.saturating_add(chunk_len);
    if next > cap { return false; }
    *acc = next;
    true
}
```

dispatch.rs mounts_register（**先验证 API 再落码**：读 `~/.cargo/registry/src/*/worker-0.8.7/src/request.rs` 确认 `headers()`/`stream()` 形态；`stream()` 若不可用则 Content-Length 预检照写、流式闸降级为 `text()` 后判定+注记，报告记录裁决）：

```rust
async fn mounts_register(mut req: Request, state: &'static WorkerState) -> worker::Result<Response> {
    // 1-10：显式 Content-Length 超限先拒（不读 body）；分块面走流式累计闸
    if let Some(len) = req.headers().get("content-length").and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<usize>().ok()) {
        if len > MOUNTS_BODY_LIMIT {
            return json_error(413, "payload too large");
        }
    }
    let mut acc = 0usize;
    let mut buf: Vec<u8> = Vec::new();
    let mut stream = req.stream()?; // futures Stream<Item=Result<Vec<u8>>>
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        if !crate::http::payload_fits(&mut acc, chunk.len(), MOUNTS_BODY_LIMIT) {
            return json_error(413, "payload too large");
        }
        buf.extend_from_slice(&chunk);
    }
    let body = String::from_utf8_lossy(&buf).into_owned();
    // ……serde 解析段原样
}
```

（`use futures::StreamExt` 或 worker crate re-export 面按实际依赖落；worker Cargo.toml 若缺 futures-util 显式加。）

- [ ] **Step 4: 全量**

Run: `cargo test -p vviewer-worker && cargo check -p vviewer-worker --target wasm32-unknown-unknown --no-default-features`
Expected: PASS（is_asset_path 既有 4 断言照旧绿）+ wasm check 绿

- [ ] **Step 5: Commit**

```bash
git add server/worker/src/http.rs server/worker/src/dispatch.rs
git commit -m "fix(worker): 资产扩展名大小写不敏感+413 判定前移（台账 1-8/1-10）

is_asset_path 改 ASCII 小写归一（C1 纪律补网）；mounts POST 先
Content-Length 预检、分块面流式累计闸，超限不再先全读 body。"
```

---

### Task 6: 裁剪形态注记与两处文档修正（1-9、1-11、1-12）

**Files:**
- Modify: `server/src/main.rs:210` 附近 `default_http_transport`（裁剪分支 debug_assert+注释）
- Modify: `server/storage/src/lib.rs:209-215`（encode_invalid_utf8 注释）
- Modify: `server/storage/src/s3.rs:316-355`（历法注释）

- [ ] **Step 1: 1-9**——读 `default_http_transport` 裁剪形态错误分支（`cargo check --no-default-features` 可达性论证在案：server bin 恒 native 构建、worker 不经本 crate）。在分支内加：

```rust
// 1-9：裁剪形态本分支不可达（server bin 恒 native、worker 部署不经本 crate
// ——workers 计划终审论证在案）；运行时配置错误保留为防御性护栏，
// debug 构建额外断言暴露误用。
debug_assert!(false, "trimmed-form default_http_transport unreachable in server bin");
```

（若该函数在 `#[cfg(feature = "native")]` 内本就整段不编译，则改为：在非 native 占位分支补同款注释+debug_assert；以实际门控形态为准，报告记录。）

- [ ] **Step 2: 1-11**——lib.rs:213 `valid_up_to 保证前缀合法；unwrap 只在切片越界时不可能发生` 改写为明确不变式注释：「`valid_up_to` 由 `from_utf8` 契约保证 ≤ rest.len() 且指向合法前缀终点；切片 `&rest[..valid]` 不可能越界，unwrap 不可达」。含混的「锚归属」表述（指向产生轮次的描述）删除，改述不变式本身。

- [ ] **Step 3: 1-12**——s3.rs 历法区（:316 起至 amz_date 格式化 ：333 `"{y:04}{m:02}{d:02}T{:02}{:02}{:02}Z"` 附近）逐句核对：找到声称「前导零保真/搬运自原实现」的注释（台账 1-12：表述有固有缺陷——`{:02}` 是格式化器语义非数据保真，历法换算不产生/丢失前导零）。按实际措辞修正为准确表述；**若全仓已无该注释（rg '前导零|保真' s3.rs 零命中），在 amz_date 格式化处补一句正确说明并销账**。

- [ ] **Step 4: 编译+测试**

Run: `cargo check --workspace --all-targets && cargo test -p vviewer-storage`
Expected: 绿（纯注释/断言变更，行为锁零翻转）

- [ ] **Step 5: Commit**

```bash
git add server/src/main.rs server/storage/src/lib.rs server/storage/src/s3.rs
git commit -m "docs(server,storage): 裁剪分支不可达断言与两处注释订正（台账 1-9/1-11/1-12）"
```

---

### Task 7: core/tree anySignal 收编（1-13）

**Files:**
- Create: `packages/core/src/tree/signals.ts`
- Create: `packages/core/src/tree/signals.test.ts`
- Modify: `packages/core/src/tree/remote.ts:207`（改用 anySignal）
- Modify: `packages/core/src/tree/directS3.ts:448-465`（本地 helper 迁出改导入）

**Interfaces:**
- Produces: `export function anySignal(a: AbortSignal, b: AbortSignal): AbortSignal`（native any 优先、缺失时手写桥接、已断同步传播 reason 取先断侧——directS3 既有实现逐语句迁移）。

- [ ] **Step 1: 写失败测试**（照 apps/web/src/lib/mergeAbortSignals.test.ts 的桩法：删除/还原 `AbortSignal.any` 探测双分支都要钉）

```typescript
import { describe, expect, it, afterEach } from 'vitest';
import { anySignal } from './signals';

const ANY_DESC = Object.getOwnPropertyDescriptor(AbortSignal, 'any');
afterEach(() => { if (ANY_DESC) Object.defineProperty(AbortSignal, 'any', ANY_DESC); });

describe('anySignal', () => {
  it('原生 any 存在时直用（reason 随源传播）', async () => {
    const a = new AbortController(), b = new AbortController();
    const m = anySignal(a.signal, b.signal);
    a.abort(new DOMException('x', 'AbortError'));
    expect(m.reason?.name).toBe('AbortError');
  });
  it('缺失时手写桥接：任一 abort 同步传播', () => {
    const desc = ANY_DESC; Object.defineProperty(AbortSignal, 'any', { value: undefined, configurable: true });
    const a = new AbortController(), b = new AbortController();
    const m = anySignal(a.signal, b.signal);
    b.abort(new DOMException('y', 'AbortError'));
    expect(m.aborted).toBe(true);
    expect(m.reason?.message).toBe('y');
  });
  it('预 abort 一侧同步断', () => {
    const a = new AbortController(); a.abort(new DOMException('pre', 'AbortError'));
    expect(anySignal(a.signal, new AbortController().signal).aborted).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**（模块不存在）

Run: `pnpm vitest run packages/core/src/tree/signals.test.ts`
Expected: FAIL（Cannot find module）

- [ ] **Step 3: 实现**——signals.ts 内容 = directS3.ts:448-465 的 `anySignal` 逐语句迁移（含 doc 注释），`export`；directS3.ts 删本地实现改 `import { anySignal } from './signals'`；remote.ts:207：

```typescript
const merged =
  signal && timeoutSignal ? anySignal(timeoutSignal, signal) : (signal ?? timeoutSignal);
```

（上行注释「Safari 17.0–17.3 有 timeout 无 any」的谨慎度说明随迁移进 signals.ts doc；remote.ts 请求 doc 里 `AbortSignal.any` 字样改「anySignal 合并」。）

- [ ] **Step 4: 包测试+类型门**

Run: `pnpm vitest run packages/core/src/tree/ && pnpm typecheck`
Expected: PASS / 0E（core 全部既有测试零翻转）

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/tree/signals.ts packages/core/src/tree/signals.test.ts packages/core/src/tree/remote.ts packages/core/src/tree/directS3.ts
git commit -m "fix(core): remote 30s 超时并流的 AbortSignal.any 收编 anySignal 守卫（台账 1-13）

directS3 终审 M-1 的存在性守卫抽 signals.ts 单源，remote.ts:207 裸用点
改导入——同构环境无 AbortSignal.any 时与直连同款手写桥接。"
```

---

### Task 8: VV_READY 内核分配门控（1-14）

**Files:**
- Modify: `server/src/main.rs:308-311`（输出条件）
- Test: `server/tests/ready_protocol.rs`（新增显式端口用例）

**Interfaces:**
- Produces: VV_READY 行仅在 `--port 0`（内核分配）路径输出；显式端口 stdout 无该行。桌面壳消费面（--port 0）不受影响。

- [ ] **Step 1: 写失败测试**（ready_protocol.rs，照既有 spawn 测试装置）

```rust
/// 1-14：显式端口路径不再输出就绪行（终审裁决：多一行仅人读噪声）——
/// 壳侧消费面只有 --port 0，wire 契约不变。
#[test]
fn explicit_port_emits_no_ready_line() {
    // 照既有 spawn 装置：Command::new(CARGO_BIN_EXE_vviewer) + args["serve", "--port", "<空闲端口>", ...]
    // stdout 逐行收集至 health 探活成功；断言全输出无 "VV_READY port=" 前缀行
}
```

（装置细节照本文件既有 `--port 0` 用例逐行仿写：KillOnDrop/stderr 排水/health 轮询；空闲端口用 std TcpListener bind :0 后取端口再放。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test -p vviewer --test ready_protocol explicit_port`
Expected: FAIL（现状显式端口也输出 VV_READY）

- [ ] **Step 3: 实现**（main.rs bind 段）

```rust
// 1-14：就绪行语义收窄——仅内核分配端口（--port 0，桌面薄壳消费面）输出；
// 显式端口面向人读，不再多一行。wire 格式与解析契约不变（ready_line 单测锁）。
#[cfg(not(test))]
if kernel_assigned {
    println!("{}", ready_line(local.port()));
}
```

`kernel_assigned` 取自端口解析处（`--port 0` 或未提供→DEFAULT_PORT 的判定：**仅显式/默认 0 才算**，即 `resolved_port == 0`；未提供端口默认 8321 非 0，不输出）。注释同步 main.rs:182 的 fn doc（「--port 0 时输出」改「仅 --port 0 输出」）。

- [ ] **Step 4: 全量**

Run: `cargo test -p vviewer --test ready_protocol && cargo test --workspace`
Expected: PASS（既有 --port 0 spawn 用例照绿零改动）

- [ ] **Step 5: 文档**——server/README.md VV_READY 行补「仅 --port 0 输出」。

- [ ] **Step 6: Commit**

```bash
git add server/src/main.rs server/tests/ready_protocol.rs server/README.md
git commit -m "feat(server): VV_READY 收窄为 --port 0 专属——显式端口不再多一行（台账 1-14）

桌面壳（唯一机器消费面）走 --port 0 不受影响；ready_protocol 补显式
端口无就绪行断言；README 同步。"
```

---

### Task 9: 阶段门禁与 digest 阶段一回写

**Files:**
- Modify: `docs/report/sdd-deferred-minors-2026-10-21.md`（阶段一 14 项终态回写）

- [ ] **Step 1: 全量门禁**

```bash
pnpm typecheck && pnpm vitest run && cargo test --workspace && cargo clippy --workspace --all-targets 2>&1 | tail -5
```

Expected: typecheck 0E；vitest exit0；cargo 全绿零翻转；clippy 告警数 ≤ 基线 48（零新增）。

- [ ] **Step 2: digest 回写**——摘要文档「二、已销账」与「一、仍开放」中阶段一 14 项（编号 1-1..1-14 对应提取表的 A 组+局部）逐条补终态：修复项附 commit hash 与一句话修法；1-1 加勘误注记（MountConfig 原表述过时，实际修复面=token 字段）。

- [ ] **Step 3: 台账收口**——`.superpowers/sdd/2026-10-21-deferred-cleanup-stage1/progress.md` 终条：门禁数字 + 递延项（若有）。

- [ ] **Step 4: Commit**

```bash
git add docs/report/sdd-deferred-minors-2026-10-21.md
git commit -m "docs(report): 递延清偿批阶段一终态回写——14 项销账+1-1 勘误"
```

---

## 任务依赖

Task 1-8 互相独立可串行任意序；Task 9 恒最后。推荐执行序 = 编号序（Rust 面 1-6 → TS 面 7 → wire 变更 8 → 收口 9）。
