# Deferred 清偿实施计划（终审 deferred 15 条 + 立项候选 2 条）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 清偿流式硬化终审的全部 deferred 项：测试覆盖补强（5）、代码卫生（4）、语义收紧（3）、跟踪/立项类落地（3 + 2 候选）。

**Architecture:** 全部为已定位的小面修复——纯测试补强、卫生清理、abort 判定收紧（错误身份判定）、探针细口径（resource timing + query 逐文件打点）、jsonl↔code 委托锚行号映射（字节偏移换算）、dispatch 级取消（ViewerPane effect 级 controller）。5 个实施任务 + 收尾门禁。

**Tech Stack:** TypeScript / vitest（jsdom，仓库根跑）/ Playwright。

**Spec:** 上游 spec docs/superpowers/specs/2026-10-15-streaming-hardening-design.md + 终审报告 findings（ledger 记录，工作区已删——本计划 §各任务自带全部上下文）。

## Global Constraints

- vitest 必须在仓库根跑：`pnpm vitest run ...`；typecheck 门禁 `pnpm typecheck` 0E。
- e2e 前必须重建：`cd apps/web && VV_GRAMMAR_CDN=https://cdn.grammars.test/grammars/ pnpm --filter web build`；长命令后台运行。
- 原子提交（Angular 规范）；缺省行为不变原则（探针开关类）。
- abort 错误身份判定统一形态：`DOMException(message, 'AbortError')`。
- 不引入新功能面（本计划全部是清偿已定位项）。

---

### Task 1: 测试覆盖补强（一类 5 条）

**Files:**
- Modify: `packages/core/test/tree-signal.test.ts`（①③⑤）
- Modify: `packages/render-text/test/blockStream.test.ts`（②④）
- Modify: `packages/core/test/dispatcher.test.ts`（新增 signal 用例；若该文件无 dispatcher 单测则新建 `packages/core/test/dispatch-signal.test.ts`）
- Modify: `packages/highlight/test/queries-remote.test.ts`（⑧try/finally）
- Modify: `packages/core/src/tree/localFiles.ts` + `packages/core/src/tree/singleFile.ts`（取消错误统一 DOMException AbortError——为 Task 3 铺路，随本任务先行）

**Interfaces:**
- Produces: localFiles/singleFile 取消错误统一为 `new DOMException('读取已取消', 'AbortError')`（message 不变，既有 `rejects.toThrow('读取已取消')` 断言仍过）。

- [ ] **Step 1（①dispatcher abort 透传单测）**：dispatcher 级用例——构造可编程 read（挂起），经 `dispatch(source, null, host, { read })` 渲染 code 窗口（或直接构造 renderCtx 形态调用），断言：signal abort 后 reject 以 AbortError 原样上抛（`err.name === 'AbortError'`，**非** DispatchReadError）；非 abort 的读失败 reject 为 DispatchReadError（对照断言）。参照 `packages/core/test/` 既有 dispatch 测试的 source/registry 夹具形态。

- [ ] **Step 2（②fullReload 用例 + ④身份断言）**：blockStream.test.ts 追加——rangeless 200 形态（read 首块返回超长字节触发 200-回退）+ 挂起全量重取中 abort，断言 reject AbortError；现有 destroy 用例补 `expect(sawSignal).toBe(controller.signal)` 身份断言（消除 5s 超时式失败）。

- [ ] **Step 3（⑤时序去随机）**：tree-signal.test.ts 用例 2 的 `setTimeout(() => controller.abort(), 20)` 改为事件驱动确定性——`const p = store.read(...); await vi.waitFor(() => (服务器侧已收到请求的钩子).truthy); controller.abort();`（服务器 createServer 回调里置位 `received = true` 作为钩子）。

- [ ] **Step 4（⑧try/finally）**：queries-remote.test.ts SUSP-06 用例把 `TreeSitterEngine.create` 移入 try/finally（finally 中 server close）。

- [ ] **Step 5（⑥导入清理 + 取消错误统一）**：tree-signal.test.ts 删未使用的 `vi` 导入；localFiles/singleFile 的取消抛出改 `new DOMException('读取已取消', 'AbortError')`（message 保留）。

- [ ] **Step 6: 跑测试与门禁**

Run: `pnpm vitest run packages/core packages/render-text packages/highlight && pnpm typecheck`
Expected: 全绿（新增用例先红后绿的 TDD 顺序：每个新用例先验证其红形态再实现/确认）。

- [ ] **Step 7: 提交**

```bash
git add -A packages/core packages/render-text/test packages/highlight/test
git commit -m "test(core,render-text,highlight): 终审 deferred 测试补强——dispatcher abort 透传/fullReload 用例/时序去随机/卫生清理"
```

---

### Task 2: 代码卫生（二类 4 条）

**Files:**
- Modify: `packages/highlight/src/worker.ts`（`_kind` rest 剥离改为显式 Omit/解构）
- Modify: `packages/highlight/src/client.ts`（init-progress console.debug 尾参 undefined 消除：`detail` 条件化）
- Modify: `packages/render-text/src/code.ts`（SUSP-01 退出分支双 refresh 合并：exit 分支不走 clearHit 的内部条件 refresh，改为手动 hitLine=-1/active 类清除 + 单次 refresh(true)；行为锚点=退出后行级背景/mark/active 全消且恰一次重绘）
- Modify: `apps/web/e2e/b-stream-resilience-helpers.ts`（三处 serve catch 与 notifyChanged catch 的策略差异加对齐注释——「notifyChanged 出册有行为、serve 纯静默」一句话注释各一处）

**Interfaces:**
- Consumes: clearHit 现状（hitTimer 清理 + hitLine=-1 + applyHitClass + 条件 refresh）。
- Produces: exit 分支行为等价（单次 refresh）；client.ts debug 帧无 undefined 字面；worker.ts 无未使用变量。

- [ ] **Step 1**: 各文件按上述锚点修改（全部为微改）。
- [ ] **Step 2: 跑测试与门禁**

Run: `pnpm vitest run packages/highlight packages/render-text && pnpm typecheck`
Expected: 全绿（SUSP-01 既有单测锁退出行为，双刷合并不得使其变红）。

- [ ] **Step 3: 提交**

```bash
git add packages/highlight/src packages/render-text/src/code.ts apps/web/e2e/b-stream-resilience-helpers.ts
git commit -m "chore(highlight,render-text): 终审 deferred 卫生清理——未使用变量/debug 尾参/退出双刷/装置注释对齐"
```

---

### Task 3: abort 判定收紧（三类 T1②）

**Files:**
- Modify: `packages/render-text/src/code.ts` + `packages/render-text/src/jsonl/index.ts`（各静默分支判定从 `readAbort.signal.aborted` 收紧为「err 是 AbortError」：新增模块级 helper `isAbortError(err): boolean`（`err instanceof DOMException && err.name === 'AbortError'` 兼容 `err instanceof Error && err.name === 'AbortError'`），静默分支改为 `if (isAbortError(err)) return;`）
- Test: `packages/render-text/test/code.test.ts`（追加竞态用例）

**Interfaces:**
- Consumes: Task 1 的统一取消错误形态（DOMException AbortError）。
- Produces: 真取消恒静默；「真实读失败 + abort 竞态」不再被误吞（走既有置闩+debug——实例已 destroyed 无消费方，日志如实）。jsonl 同口径。

- [ ] **Step 1: 写失败测试**

code.test.ts 追加：

```ts
it('abort 判定收紧：destroy 竞态下的真实读失败不被误吞（置闩+日志，非静默）', async () => {
  stubResizeObserver();
  const debugSpy = vi.spyOn(console, 'debug');
  // ctx.read：收到块 1 请求后立即以真实读失败 reject（ECONNRESET 形态），不等 abort
  const ctx: StreamCtx = {
    size: 5 * 256 * 1024,
    head: full.slice(0, 8192),
    read: (r) =>
      r.start === 0
        ? Promise.resolve(full.slice(0, r.end + 1))
        : Promise.reject(Object.assign(new Error('连接被重置'), { code: 'ECONNRESET' }))
  };
  const inst = renderCode(full.slice(0, 8192), host, { ctx, ext: 'js', highlight: false });
  // 首块成功 mount → 泵拉块 1 → 真实失败（无 abort 参与）→ continueFailed 闩 + 日志照常
  await vi.waitFor(
    () => expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining('后台索引泵拉块失败'), expect.anything()),
    { timeout: 2_000 }
  );
  debugSpy.mockRestore();
  inst.destroy();
});
```

说明：本用例锚定「非 abort 错误照常置闩」（现行为已如此，防 Task 3 收紧时误伤）；真正的收紧断言=「signal.aborted 但 err 非 AbortError → 不静默」形态，用可编程 read（abort 已发生但 read 以普通 Error reject）构造。两种形态都落用例。

- [ ] **Step 2: 实现 helper 与分支收紧**（code 四处 + jsonl 两处；localFiles/singleFile 的取消错误已在 Task 1 统一为 AbortError 名，静默判定可识别）。
- [ ] **Step 3: 跑测试与门禁**

Run: `pnpm vitest run packages/render-text packages/core && pnpm typecheck`
Expected: 全绿（既有 destroy 用例的真 abort 路径仍静默）。

- [ ] **Step 4: 提交**

```bash
git add packages/render-text packages/core
git commit -m "fix(render-text): abort 静默判定收紧为错误身份——destroy 竞态下真实读失败不再被误吞"
```

---

### Task 4: worker init 探针细口径（四类 T9①）

**Files:**
- Modify: `packages/highlight/src/core-parse.ts`（create：parser-init 完成后读 `performance.getEntriesByType('resource')` 过滤 runtimeDir 下 wasm 条目，detail 附 `name/duration/transferSize`；ready 帧同补）
- Modify: `packages/highlight/src/queries.ts`（remoteQueryLoader/expandQueryAsync 逐文件打点：每次 query 资产 fetch 完成经回调上报 `query-loaded file=... detail=...`——回调经 EngineOptions 透传，仅 debug 开启时注入，缺省零改动）
- Modify: `packages/highlight/src/worker.ts`（透传新帧）
- Test: `packages/highlight/test/client.test.ts`（追加：debug 开启时 wasm resource 帧含 timing 字段、逐 query 帧序列；无开关零帧——既有用例背书）

**Interfaces:**
- Produces: init-progress 帧新增 `query-loaded` stage（每 query 文件一帧）与 wasm 帧 detail 增强（resource timing）；缺省（无开关）行为仍逐字节不变。

- [ ] **Step 1: 写失败测试**（debug 开启 → 帧序列含 query-loaded 与 wasm timing detail；关闭 → 零帧，既有零噪声用例背书）。
- [ ] **Step 2: 实现**（performance resource 过滤注意 worker context 独立 buffer、Parser.init 后立查；queries 回调透传经 EngineOptions 可选字段，不影响既有构造）。
- [ ] **Step 3: 跑测试与门禁**

Run: `pnpm vitest run packages/highlight && pnpm typecheck`
Expected: 全绿。

- [ ] **Step 4: 提交**

```bash
git add packages/highlight
git commit -m "feat(highlight): init 探针细口径——wasm resource timing 与 query 逐文件帧（vvWorkerDebug）"
```

---

### Task 5: 行号映射 + dispatch 级取消（四类立项候选 2 条）

**Files:**
- Modify: `packages/render-text/src/code.ts`（全量模式 handle 增 `lineAtOffset(offset: number): number`——复用既有 `lineOf(lineOffsets, pos)` 二分；仅全量模式有 lineOffsets，窗口模式不暴露）
- Modify: `packages/render-text/src/jsonl/index.ts`（降级锚定恢复处：委托 code 分支不再直接 revealLine(内容行号)，改「锚行字节偏移（`index.offsets[anchorLine] + bomLen`）→ code 实例 `lineAtOffset` → 物理行号 → revealLine」；实例无 lineAtOffset 时回退现行为）
- Modify: `apps/web/src/lib/ViewerPane.svelte`（effect 级 AbortController：read 闭包 signal 与实例 signal 合并——抽 helper `mergeAbortSignals(a, b)`（AbortSignal.any 不可用时回退手写组合）入可单测模块，effect cleanup 时 abort 覆盖 pre-instance 在飞读窗口）
- Test: `packages/render-text/test/code.test.ts`（lineAtOffset 单测）、`packages/render-text/test/jsonl-render.test.ts`（含空行夹具的委托降级锚行单测——含空行文件锚行不再漂移）、`apps/web/src/lib/` 的 mergeAbortSignals 单测（新建小测试文件或挂既有 utils 测试）

**Interfaces:**
- Produces: `RenderCodeHandle.lineAtOffset?(offset: number): number`（可选扩展，窗口模式缺席）；jsonl 委托锚行含空行文件精确；effect 级取消覆盖「rev++ 早于实例 resolve」窗口。

- [ ] **Step 1: 写失败测试**（三段：lineAtOffset 二分正确性；含空行 jsonl 委托降级锚行=物理行（现状红：漂移空行数）；mergeAbortSignals 任一 abort 即断且结果 signal aborted 同步传播）。
- [ ] **Step 2: 实现**（顺序：code lineAtOffset → jsonl 换算 → ViewerPane 合并；each 最小侵入）。
- [ ] **Step 3: 跑测试与门禁**

Run: `pnpm vitest run packages/render-text && pnpm typecheck`
Expected: 全绿（既有降级/锚定用例零回归——无空行夹具行为不变）。

- [ ] **Step 4: 提交**

```bash
git add packages/render-text apps/web/src/lib
git commit -m "fix(render-text,web): 委托降级锚行物理行号映射 + effect 级读取消——终审立项候选两项落地"
```

---

### Task 6: 收尾全量门禁

**Files:** 无新改动（验证 + 有红即修）。

- [ ] **Step 1**: 串行全量门禁（全部后台）：`pnpm typecheck && pnpm vitest run` → `cd server && cargo test` → build → `CI=true npx playwright test --project=chromium --retries=0` → `--project=mobile --retries=0`。
- [ ] **Step 2**: 有红即修（修复单独提交）；瞬态红按「单跑复验→该域全通道复跑」口径处置。
- [ ] **Step 3**: 报告写 `.superpowers/sdd/2026-10-16-deferred-cleanup/task-6-report.md`。
