# 阶段 3：路由语义修订实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 拆掉路由层为「服务端 14 语言、无 injection、大文件 auto 不远程」旧现实设的三道门——服务端现已 301 语言且 injections/locals 已接线（阶段 1）——实现：auto 下注入语言不再被豁免；大文件远程路由按文件来源区分（server-served 不限大小，本地来源维持现状）；e2e 断言随新契约改写。

**Architecture:** `decideComputeRoute` 的 auto 判定（hasCompute && remoteFn && hasServerPath）不变——大小门不在它那里，在 `highlightRouter.ts` 的硬护栏。改动三处语义：①删除 `INJECTION_LANGS` 豁免（`highlightRemoteEligible` 整体退役）；②`routeLargeFileHighlight` 硬护栏从 `policy !== 'remote' → null` 改为 `remote || (auto && 有 src.path)`，且 **auto 路径失败回退本地 hljs 分块（warn + null），显式 remote 失败维持抛错错误卡片**；③`highlightClient.remoteAttempted` 不再问注入豁免。markdown compute 围栏留本地（BUG-22）与 `remoteLanguageAdvertised`（集合 301 自动放宽）均不动。

**Tech Stack:** vitest（core 单测矩阵 + web 单测）、Playwright（CMP-02 双护栏 / CMP-04 换语言）。

**Spec:** `docs/superpowers/specs/2026-10-09-full-grammar-alignment-design.md`（§4 阶段 3）

## Global Constraints

- 显式 `remote` / `local` 语义零变化；auto 失败回退本地语义零变化（`runRouted` 不动）。
- markdown compute 的围栏留本地逻辑（BUG-22，viewer.ts:114 附近）零变化。
- `remoteLanguageAdvertised` 函数与语义零变化。
- 本地来源文件（无 src.path）在任何策略的大文件链路恒 null（现状保持）。
- 回归护栏一进一出：删「auto 3MB 零 POST」（旧契约），立「server-served 3MB auto 必须 POST」+「本地添加 3MB auto 仍零 POST」双护栏。
- commit Angular 规范、原子化。

---

### Task 1: core 路由——INJECTION_LANGS 豁免退役 + 单测矩阵更新

**Files:**
- Modify: `packages/core/src/compute/router.ts`（删 :27-47 的 INJECTION_LANGS 与 highlightRemoteEligible；同步修模块头与两处 doc 注释）
- Modify: `packages/core/src/compute/index.ts`（若 re-export 了二者，删除导出——先 `rg -n "INJECTION_LANGS|highlightRemoteEligible" packages apps/web` 全仓找引用点）
- Modify: `packages/core/test/computeRouter.test.ts`（删注入豁免矩阵行）

**Interfaces:**
- Produces: `@vviewer/core` 不再导出 INJECTION_LANGS / highlightRemoteEligible（Task 2 的 highlightClient 调用点同步拆除，见 Task 2——**本任务先删导出会导致 apps/web typecheck 红**，故本任务与 Task 2 需在同一验证闭环内先后落地：本任务只动 core 包文件并跑 core 包测试；全仓 typecheck 留待 Task 2 完成后收口。若执行者希望本任务独立绿，可把两处删除放在一个 commit 而调用点更新放 Task 2，typecheck 红属预期中间态，commit message 注明）。

- [ ] **Step 1: 全仓引用点盘点**

```bash
rg -n "INJECTION_LANGS|highlightRemoteEligible" packages apps/web docs --type ts
```
记录全部引用（预期：router.ts 定义与导出、compute/index.ts re-export、highlightClient.ts:175 调用、computeRouter.test.ts 矩阵、router.ts 头注释、code.ts/highlightClient.ts 注释提及）。

- [ ] **Step 2: 更新 core 单测（先改测试）**

computeRouter.test.ts：删除「auto + INJECTION_LANGS 不装配 remoteFn」相关矩阵行；新增正向断言——`highlightRemoteEligible` 不再存在（import 报错即语义）不必测，改为在 routeHighlight 层补一例：auto + rust（原注入豁免语言）+ remoteFn 在场 + hasServerPath → 走远程（decision remote，mock remoteFn 被调用）。

- [ ] **Step 3: 跑 core 测试确认新例红/旧行绿**

Run: `pnpm vitest run packages/core`
Expected: 新例 FAIL（现行为 auto 下 rust 走本地——豁免在装配侧不在 router，routeHighlight 本身不看语言……）

**裁决预注（执行者注意）**：`decideComputeRoute` 从不接收 lang——注入豁免发生在 highlightClient 装配侧（不装配 remoteFn）。因此本任务在 core 层的可测变化仅为「导出删除」；上述新例若发现 router 层无行为差异属预期，把它改写为装配侧契约测试放 Task 2（highlightClient 侧无直接单测基建时，用 computeRouter.test 保留「auto+remoteFn 装配即远程」的一般矩阵即可）。core 层本任务的实际交付 = 导出与注释退役 + 矩阵清理。

- [ ] **Step 4: 删除定义与导出**

router.ts 删 INJECTION_LANGS 与 highlightRemoteEligible 及其注释块；模块头「M6 注入语言路由」相关句子删；index.ts re-export 删。

- [ ] **Step 5: core 包测试绿 + Commit**

```bash
pnpm vitest run packages/core
git add packages/core
git commit -m "feat(core): 退役 INJECTION_LANGS 路由豁免

why: 阶段 1 服务端已接线 injections/locals（301 语言），豁免的存在前提
（服务端 v1 无 injection）消失（spec §4）。
what: 删除 INJECTION_LANGS 与 highlightRemoteEligible 定义、导出与注释；
调用点拆除与 e2e 改写随后续任务。全仓 typecheck 中间态红由 Task 2 收口。"
```

---

### Task 2: highlightClient 接线简化 + highlightRouter 硬护栏改造

**Files:**
- Modify: `apps/web/src/lib/highlightClient.ts`（remoteAttempted :172-176 删 highlightRemoteEligible 调用与 import；注释 :32-33、:190-192 更新）
- Modify: `apps/web/src/lib/highlightRouter.ts`（硬护栏 :22 + auto 失败回退语义）
- Modify: `apps/web/src/lib/highlightRouter.test.ts`（新契约矩阵）
- Modify: `packages/render-text/src/code.ts`（:633-636 附近注释同步；逻辑不动）

**Interfaces:**
- Produces: `routeLargeFileHighlight` 新契约——
  - `policy === 'local'` → null；无 `src.path` → null（不变）；
  - `policy === 'remote'` → 远程，失败**抛错**（错误卡片，不变）；
  - `policy === 'auto'` 且有 `src.path` → 远程，失败 **console.warn + 返回 null**（回退本地 hljs 分块，可用性优先）。

- [ ] **Step 1: 先改 web 单测（新契约矩阵）**

highlightRouter.test.ts 既有用例按新语义重写/扩展：

```ts
// 矩阵（loadSettings mock policy）：
// local + 有 path → null（零 fetch）
// remote + 有 path → fetch POST 且返回 intervals；fetch 500 → throw（错误卡片语义）
// auto + 有 path → fetch POST；fetch 200 → intervals；fetch 500 → null + console.warn 一次
// auto + 无 path → null（零 fetch）—— 本地添加文件的回归护栏
// remote + 无 path → null（零 fetch，现状保持）
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run apps/web/src/lib/highlightRouter.test.ts`
Expected: auto + 有 path 的用例 FAIL（现护栏 policy !== 'remote' → null）

- [ ] **Step 3: 实现**

```ts
// highlightRouter.ts 硬护栏段替换为：
  const policy = loadSettings().computePolicy;
  if (policy === 'local') return null;
  // 本地文件无服务端 path 语义，远程高亮无从谈起（用户添加的文件/文件夹恒本地）
  if (typeof src.path !== 'string' || src.path === '') return null;
  // auto 下 server-served 文件不限大小走服务端（spec §4 阶段 3）；失败回退本地 hljs 分块
// fetch 段的 !res.ok / catch 处理：
  try {
    const res = await fetch(...);
    if (!res.ok) throw new Error(`远程高亮失败: HTTP ${res.status}`);
    return decodeHighlightResponse(await res.json());
  } catch (err) {
    if (policy === 'auto') {
      console.warn(`[vviewer] 大文件远程高亮失败，回退本地分块：${errorText(err)}`);
      return null;
    }
    throw err; // 显式 remote：错误卡片
  }
```

（errorText 若无本地实现，内联 `err instanceof Error ? err.message : String(err)`；fetch 网络异常同样落入该 catch。）

highlightClient.ts：`remoteAttempted` 删 `highlightRemoteEligible(policy, lang) &&`；相关 import 删；:32-33 与 :190-192 注释改为「服务端已接线 injections（阶段 1），auto 不再豁免注入语言」。

- [ ] **Step 4: 跑 web 测试 + 全仓收口**

```bash
pnpm vitest run apps/web/src/lib
pnpm vitest run packages/core   # Task 1 遗留确认
pnpm typecheck                   # Task 1 中间态红的收口点
```
Expected: 全绿。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/highlightClient.ts apps/web/src/lib/highlightRouter.ts apps/web/src/lib/highlightRouter.test.ts packages/render-text/src/code.ts
git commit -m "feat(web): 大文件路由按文件来源区分，拆除注入语言装配豁免

why: 服务端 301 语言 + injections 接线后，旧三道门中的两道失去前提
（spec §4）：auto 下 server-served 文件应不限大小走服务端，注入语言
不应被强制留在本地。
what: routeLargeFileHighlight 硬护栏改 remote || (auto && hasServerPath)，
auto 失败回退本地分块（warn+null）而显式 remote 维持抛错错误卡片；
remoteAttempted 不再问注入豁免。"
```

---

### Task 3: e2e 断言改写 + 文档与 spec 回写

**Files:**
- Modify: `apps/web/e2e-server/b-compute-global-search-server.spec.ts`（CMP-02 双护栏、CMP-04 换集外语言）
- Modify: `apps/web/e2e/` 与 `apps/web/e2e-server/` 中其他引用旧契约的断言（先 `rg -n "零 POST|零 POST|php" apps/web/e2e apps/web/e2e-server` 盘点）
- Modify: `server/README.md` 或 `docs/e2e/code-highlight-degrade.md`（路由语义段落，若有）
- Modify: `docs/superpowers/specs/2026-10-09-full-grammar-alignment-design.md`（§7 阶段 3 回写）

**Interfaces:**
- Consumes: Task 2 新契约。

- [ ] **Step 1: 盘点旧契约断言**

```bash
rg -n "CMP-02|CMP-04|zero.*POST|零 POST|3MB" apps/web/e2e apps/web/e2e-server --type ts
```

- [ ] **Step 2: CMP-02 拆双护栏**

原「auto 3MB 保持 hljs 分块零 POST」用例改写为两个：
- server-served 3MB 文件 + auto → 断言发生 POST `/api/compute/highlight`（route 计数 ≥1）且高亮成功（tree-sitter 渲染路径）；
- 本地添加的 3MB 文件（单文件上传通道构造）+ auto → 断言零 POST 且走 hljs 分块。
原「remote 3MB POST」用例保持。

- [ ] **Step 3: CMP-04 换集外语言**

php 已在服务端 301 集内——把「php 400 → auto 回退 / remote 错误卡片」用例的语言换成一个 301 集外语言名（如 `brainfuck`——server 单测同款集外名；断言不变：auto 回退本地、remote 错误卡片）。同时检查该 spec 内 php 若还作为「服务端支持」正例使用则保留。

- [ ] **Step 4: 相关联召排查**（m6.spec.ts policy=remote 1.5MB 远程用例、b-code-highlight-degrade HL 系列等），有旧契约措辞/断言一并改写；无则记录「已排查无波及」。

- [ ] **Step 5: 本地跑 e2e + Commit**

```bash
cd apps/web && pnpm exec playwright test b-compute-global-search-server m6 b-code-highlight-degrade
```
Expected: 全绿（e2e-server 套件按其 config 跑）。全量门禁：`pnpm vitest run && pnpm typecheck`。

- [ ] **Step 6: 文档与 spec 回写 + Commit**

server/README（或 code-highlight-degrade.md）路由语义段落更新为「auto：server-served 文件不限大小走服务端（失败回退），本地来源 >2MB 恒 hljs 分块；注入语言不再豁免」；spec §7 阶段 3 行回写实测（双护栏 e2e 结果、CMP-04 新语言）。

```bash
git add apps/web/e2e apps/web/e2e-server server/README.md docs
git commit -m "test(e2e): 路由新契约双护栏断言与 spec 回写

why: 旧契约断言（auto 3MB 零 POST、php 400 场景）已被阶段 3 语义反转，
必须改写为双向护栏防回归（spec §4）。
what: CMP-02 拆 server-served/本地来源双护栏；CMP-04 换集外语言；
路由语义文档与 spec §7 回写。"
```

---

## Self-Review 记录

1. **Spec 覆盖**：§4 三道门——INJECTION_LANGS 删除→Task 1+2；宣告集合放宽（已随阶段 1 health 301 自动生效，函数保留）→Task 1 约束确认；>2MB 硬护栏按来源区分→Task 2；markdown 不动→全局约束；e2e 改写→Task 3；策略枚举/settings/UI 无新值→未触碰清单。无缺口。
2. **占位符扫描**：Task 1 Step 3 为裁决预注（core 层无行为差异的显式说明与交付口径收窄），非占位符；Task 3 Step 4 为显式排查指令。其余含完整代码/命令。
3. **类型一致性**：routeLargeFileHighlight 新契约（auto warn+null / remote throw）↔ Task 2 测试矩阵 ↔ Task 3 双护栏断言一致；highlightRemoteEligible 删除 ↔ 引用点盘点指令闭合。
