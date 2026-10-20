# 多端发布阶段二：vviewer-core 抽取重构 Implementation Plan（spec 阶段二）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 业务逻辑抽为框架无关 `server/core` crate（纯类型请求/响应 + 全部业务 handler），axum 适配层薄化为双向映射；watch/compute/diagrams 转 native-only cargo feature 门控（worker 形态裁剪前提）；对外行为逐字节零变化（既有 cargo 测试全绿为行为锁）。

**Architecture:** `server/core`（vviewer-core）定义 `CoreRequest { method, path, headers, body }` / `CoreResponse { status, headers, body }` 与按域 handler 模块（health/tree/file/mounts/search/auth/tickets/compute）；它们操作 `CoreState`（StorageBackend 分发 + 配置 + 运行时挂载容器——从 AppState 提取的非 axum 部分）。axum 适配层（server/ 既有）把 axum Request 映射为 CoreRequest、handler 产出映射回 Response；tower-http 静态/压缩/CORS 层留在适配层。feature 门控：`watch`（notify）/`compute`（comrak/tree-sitter/diagrams）为 server 与 core 共识的 cargo feature，无 feature 时对应 handler 编译不存在、路由不挂载、health 不宣告——与 `--compute` 既有可选语义同形。

**Tech Stack:** 纯 Rust 重构；tokio（core 内可用——worker 形态经 features 裁剪的是 notify/comrak 等重依赖，非 tokio 本体）；既有 cargo 测试矩阵。

**Spec:** `docs/superpowers/specs/2026-10-19-multiplatform-release-design.md` 阶段二

## Global Constraints

- **行为锁铁律**：`cargo test --workspace` 全绿且**既有测试零改动**（允许的例外：测试内 use 路径随代码迁移的机械适配——断言逻辑零变化）；对外 HTTP 行为逐字节等价（启动校验/exit code/错误 JSON 形态/消息文本）。
- watch（notify）与 compute（comrak/tree-sitter/diagrams/layout-rs/svgbob）为 cargo feature `native`（默认开启——native 构建 `--all-features` 或 default 行为不变；worker 形态 `--no-default-features` 裁剪）。
- core crate 不依赖 axum/tower-http/notify/comrak——依赖倒置方向：server → core 单向。
- 鉴权（constant-time Bearer 比较）、挂载三 API、StorageBackend 分发、启动校验逻辑全部入 core。
- SSE events 端点：body 为流——CoreResponse.body 需支持流形态（枚举 Full(Bytes)/Stream），worker 形态该路由不挂载（watch=false 能力缺失）。
- 每任务原子提交；任务串行（每步行为锁全量回归）；本计划为纯重构——**不新增功能、不修 bug、不顺手优化**（发现的独立问题记台账）。

---

### Task 1: core crate 骨架 + 类型与鉴权 + health

**Files:**
- Create: `server/core/`（vviewer-core crate：lib.rs/CoreRequest/CoreResponse/CoreState(从 AppState 提取)/auth.rs/health.rs）
- Modify: 根 workspace 声明；server/Cargo.toml（+vviewer-core path 依赖）
- Modify: `server/src/`（auth.rs/health.rs 业务体迁移至 core，axum 侧留薄适配）

**Interfaces:**
- Produces: `CoreRequest/CoreResponse` 类型、`CoreState`（非 axum 状态：config/roots/mounts 容器/auth token）、`core::auth::check(token, expected) -> bool`（constant-time 原语义）、`core::health::handle(state) -> CoreResponse`。

- [ ] **Step 1: 迁移前基线**（`cargo test --workspace` 全绿记录数字——行为锁基线）。
- [ ] **Step 2: 实现**（auth/health 先行小域验证抽取模式：handler 业务体搬 core、axum handler 变 10 行映射；既有 health 测试迁移或经适配层保持原路径——**测试文件的断言零变化**，仅 use 适配）。
- [ ] **Step 3: 全量回归（行为锁）+ Commit** `refactor(server): core crate 骨架——类型/鉴权/health 抽取`

---

### Task 2: tree/file/mounts 域抽取

**Files:**
- Modify: `server/core/`（tree.rs/file.rs/mounts.rs——含 Range 解析[路由层裁决保留：Range 解析属 HTTP 语义，留适配层；core 收已解析窗口]、挂载三 API 业务体）
- Modify: `server/src/routes/`（对应薄适配）

**Interfaces:**
- Consumes: Task 1 类型/CoreState + vviewer-storage StorageBackend。
- Produces: core::tree::list/core::file::read(range: Option<ResolvedRange>)/core::mounts::{register,manifest,unregister}。

- [ ] **Step 1-5: 同 Task 1 模式**（迁移→行为锁回归→Commit `refactor(server): tree/file/mounts 域抽取`）。

---

### Task 3: search/auth 门/tickets-events + feature 门控（watch/compute/diagrams）

**Files:**
- Modify: `server/core/`（search.rs[rg/grep spawn——注意 std::process 在 core 可用，worker 形态经 feature 裁剪该 handler]/tickets+events[SSE 流形态]/compute.rs[feature="native"]）
- Modify: `server/Cargo.toml` + `server/core/Cargo.toml`（features 定义：`native = ["notify", "comrak", ...]` default；core 的 compute 模块 `#[cfg(feature = "native")]`）
- Modify: `server/src/routes/mod.rs`（feature 门控路由挂载——无 native feature 时 watch/compute 路由不挂、health 不宣告）

**Interfaces:**
- Produces: feature 门控语义（`--no-default-features` 构建：watch/compute/diagrams 路由不存在、health 不宣告 compute/diagrams/searchEngine[rg spawn 属 search——search 是否随 native 裁剪：spec 阶段三 Worker 无 rg——search handler 依赖 std::process 非 native 重依赖，**裁剪由 worker 侧 feature 决定**——server 侧 search 保留在 core、worker 适配层不挂载该路由并同步 health 不宣告。实现按此口径）。

- [ ] **Step 1-5: 同模式**（`cargo test --workspace` + `cargo check --no-default-features` 双形态验证 → Commit `refactor(server): search/tickets-events 抽取与 native feature 门控`）。

---

### Task 4: 收尾——零残留核验与文档

**Files:**
- rg 核验（server/src 内 axum 之外零业务逻辑残留——业务体全在 core）；`server/README.md`（架构章节补 core/adapter 分层与 feature 矩阵）；spec 阶段二实施注记。

- [ ] **Step 1: 双形态全门禁**：`cargo test --workspace` + `cargo check --no-default-features` + `cargo build --release`（native 默认）+ clippy。
- [ ] **Step 2: Commit** `docs(server): core/adapter 分层文档——阶段二收口`

---

### 实施风险与裁决预留

- AppState 拆分边界（axum 特有状态 vs CoreState）——实读后取「CoreState 持有全部业务依赖」的最干净切法；axum State 持 CoreState + axum 特有 extension。
- SSE 流的 CoreResponse 形态（Body::Stream 的类型参数——core 内自定义 Stream 类型避免 axum 依赖）。
- 迁移顺序策略：逐域小步（每步行为锁）优于一次大爆炸——任务切分即为此设计。
- 测试迁移形态：集成测试（tests/*.rs）走 HTTP 层可零改动（ router 不变即测试不变）——**优先保 router 形态不变使集成测试零改动**；单元测试（模块内）随业务体迁移。
- tracing 面随迁移（core 内 tracing 宏可用——tracing 非 axum 依赖）。
- worker 侧 search 不挂载的 health 宣告口径——阶段三 Worker 计划消费，本计划只保证「路由不挂载+health 不宣告」的机制存在（feature + 适配层路由表）。
