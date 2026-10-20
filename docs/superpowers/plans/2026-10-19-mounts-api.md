# 目录挂载阶段二：代理挂载 API 与前端接入 Implementation Plan（spec §3）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 运行时挂载三 API（POST/GET/DELETE /api/mounts，Bearer 鉴权，凭据不回显）；health/mounts 宣告 per-root 能力与 fsRoots 边界；前端对账重注册（IndexedDB 记住的代理挂载连接后自动 POST 幂等重注册）；挂载根 watch 不可用提示与搜索 404 文案收敛。

**Architecture:** 服务端 mounts 运行时容器（`RwLock<Vec<RuntimeMount>>` 追加，rootIndex=fsRoots+序）复用阶段一 StorageBackend 构造；三 API 挂 Bearer 鉴权（既有 auth 中间件豁免面不变）；前端 `mountsSync.ts`（连接后对账：本地持久化代理配置指纹比对→缺失 POST）挂 connectServer 后链。

**Tech Stack:** axum 0.8 既有路由模式、tower oneshot 集成测试、vitest/playwright。

**Spec:** `docs/superpowers/specs/2026-10-19-directory-mounting-design.md` §3

## Global Constraints

- 凭据三不纪律：不进 tracing 日志、不进 health/mounts 回显、不进错误信息（上游错误脱敏转译）。
- DELETE 仅可删运行时注册项（静态 TOML 项拒绝）；活跃引用 tab 收 watch 失效帧（复用 store 释放语义）。
- 前端对账幂等：按配置指纹（kind+endpoint+bucket/prefix+label 规范化串）比对，缺失才 POST；注册失败静默标记待重试。
- health 增量：fsRoots 已有（阶段一）；`GET /api/mounts` 承担静态+运行时清单与 per-root 能力（watch/search=false 对挂载根）。
- watch：挂载根无 SSE 变更帧（能力 false）；搜索对挂载根显式 root 返回 404 文案收敛（阶段一遗留：加「该根不可服务端搜索」区分度）。
- 每任务原子提交；cargo 勿与 vitest 并发。

---

### Task 1: 运行时挂载三 API

**Files:**
- Modify: `server/src/state.rs`（RuntimeMount 容器 + with_runtime_mounts/挂载注册方法——复用阶段一 build_mount 构造 backend）
- Modify: `server/src/routes/mod.rs`（三路由，Bearer 门——既有 auth 中间件模式；豁免面不变）
- Create: `server/src/routes/mounts.rs`（POST/GET/DELETE handler + 单测）
- Test: `server/tests/mounts_api.rs`（oneshot 既有模式）

**Interfaces:**
- Produces: `POST /api/mounts` body=阶段一 MountConfig 形态（kind/label/endpoint/bucket/prefix/凭据）→ 201 `{ rootIndex }`；`GET /api/mounts` → 静态+运行时脱敏清单（含 rootIndex/kind/label/endpoint 脱敏/capabilities）；`DELETE /api/mounts/:index` → 静态项 405/运行时项 204+watch 失效帧。
- 无 --compute/--token 语义：token 未设置时三 API 免鉴权（与既有 health 豁免面同口径——**需 spec 对齐核实：spec §3 说「有 token 时需 Bearer」，无 token 部署免鉴权可写挂载？——实施时按 spec 字面+报告记录风险**）。

- [ ] **Step 1: 写失败测试**（POST 注册返回 rootIndex=fsRoots 起算/GET 脱敏清单无凭据字段/DELETE 运行时 204+静态 405/鉴权矩阵[有 token 无 Bearer 401]/重注册幂等[同指纹不重复分配]/注册的挂载根 tree/file 立即可用）。
- [ ] **Step 2: 确认失败**
- [ ] **Step 3: 实现**
- [ ] **Step 4: 全量 cargo 回归**
- [ ] **Step 5: Commit** `feat(server): 运行时挂载三 API——Bearer 门/脱敏清单/指纹幂等`

---

### Task 2: 前端对账重注册与 watch/搜索语义

**Files:**
- Modify: `apps/web/src/lib/mountsSync.ts`（新建：代理配置 IndexedDB 持久化[挂 mounts store 于既有 db v3] + 对账/重注册/待重试标记）
- Modify: `apps/web/src/lib/openFlow.svelte.ts`（connectServer 后链挂 mountsSync）
- Modify: `apps/web/src/lib/tree` 消费面（挂载根 watch 能力 false → watch 面板「此源不支持变更推送」态——rg 既有 watch 状态展示定位）
- Modify: search 404 文案（rg 'path not found' 前端错误展示——挂载根显式 root 的 404 文案区分「该根不可服务端搜索，已切换浏览器内搜索」）
- Test: mountsSync.test.ts（fake-indexeddb + fetch mock）

**Interfaces:**
- Produces: mounts IndexedDB store（db v3 内新增 object store——v3 已由 fonts 占用则 v4，顺延规则）`{ id, kind: 'proxy', label, endpoint, bucket, prefix, username, secret, fingerprint, createdAt }`；`syncMountsOnConnect(serverBase, token?): Promise<void>`。

- [ ] **Step 1: 写失败测试**（指纹比对缺失才 POST/已注册不重复/注册失败静默标记/挂载根 watch 态/搜索文案）。
- [ ] **Step 2: 确认失败**
- [ ] **Step 3: 实现**
- [ ] **Step 4: 跑测试确认通过 + apps/web 回归**
- [ ] **Step 5: Commit** `feat(mounts): 前端对账重注册与 watch/搜索语义`

---

### Task 3: e2e + 门禁 + 文档

**Files:**
- Create: `apps/web/e2e-server/b-mounts.spec.ts`（release 二进制 --config 含 mock 不可达 mount + API 直测；或 Cargo 集成为主 e2e 为辅——按 mock 可行性取）+ Modify: `server/README.md`（三 API 文档）

- [ ] **Step 1: e2e/集成**：注册→挂载根打开/浏览/compute 链路（真实 reqwest 不可达 mock 服务怎么办——**集成测试 MockTransport 已覆盖读路径，e2e 只测 API 面+对账前端单测已覆盖**——按此口径取舍并在报告记录）。
- [ ] **Step 2: 门禁**：typecheck + 全仓 vitest + cargo --workspace + 定向 e2e。
- [ ] **Step 3: README + Commit** `test(mounts): 挂载 API 集成与文档`

---

### 实施风险与裁决预留

- 无 token 部署的三 API 免鉴权写面——spec 字面 vs 安全直觉的冲突：实施时按 spec 字面实现，报告显著标注风险（无 token 部署本就是 LAN 信任模型）。
- DELETE 的活跃 tab 失效帧——「引用该根的活跃 tab」判定面实读 tabStore；实现复杂度超预期时降级为「DELETE 成功+前端下次访问自然 404」并报告裁决。
- mountsSync 的对账时机（connectServer 成功后异步 fire-and-forget vs await）——不阻塞首屏取 fire-and-forget。
- mounts store 的 db 版本顺延（fonts 占 v3→本计划 v4 或同 v3 追加 store——按 session.ts upgrade 回调实际结构取，报告记录）。
