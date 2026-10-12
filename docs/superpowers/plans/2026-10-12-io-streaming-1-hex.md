# IO 级流式计划 1（core/store/dispatch 下沉 + hex 迁移）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 IO 流式的接口与管线地基（StreamCtx / rangeCapable / dispatch 读下沉），并完成 hex 渲染器流式化——远端/本地大文件 hex 浏览内存有界、首屏只拉头部、SSE 重渲染免全量重读。

**Architecture:** dispatch 接管读控制权（ViewerPane 只传 read 闭包）：head 探测选路后，streaming 渲染器收 head + StreamCtx，非 streaming 渲染器走现状全量。hex 经块缓存访问器（64KB×8 LRU）把 `buffer.subarray` 换成「缓存命中直取 / 未命中异步拉块重渲染」；搜索走 need/chunk 握手协议由 worker 驱动逐块扫描。

**Tech Stack:** TypeScript（packages/core、packages/render-binary）、vitest（jsdom + fake worker 既有模式）、Playwright（默认通道，假服务器字节计量）。

**Spec:** `docs/superpowers/specs/2026-10-12-io-streaming-design.md`

**滚动计划说明：** 本计划为三份滚动计划的第一份（spec §9 分期①②③）。jsonl（④）与 code（⑤）在计划 1 落地后各立独立计划——届时 StreamCtx/dispatch 地基已被计划 1 验证，渲染器迁移细节按实际地基写，避免现在为未验证的接口写千行细节。

## Global Constraints

- 非 streaming 渲染器（image/av/pdf/docx/xlsx/pptx/markdown/html/archive）与 markdown 行为零改动；既有测试不改断言（新增测试除外）。
- 服务端零改动（Range header 已支持：file.rs parse_range/206/Content-Range）。
- dispatch 兼容路径必须保留：`dispatch(source, buffer, target, opts)` 不带 opts.read 的既有调用（含全部既有测试）行为逐字节等价。
- hex 注入文本/DOM 结构（.vv-hex-row 等类名、行格式 renderHexBytes 输出）零变更；e2e 断言除新增计量用例外不改。
- 禁 any；受控断言需注释；每任务原子 commit（Angular 规范）。
- 测试一律从仓库根跑 vitest（jsdom 配置在根 vitest.config.ts；包目录直跑缺环境）。

---

### Task 1: core 类型演进（StreamCtx / streaming / rangeCapable / FileSource.size）

**Files:**
- Modify: `packages/core/src/types.ts`（ByteRange 旁、TreeStore、Renderer、FileSource）
- Test: 无新文件（类型任务，编译即验证；`pnpm typecheck` 全绿为门）

**Interfaces:**
- Produces（后续所有任务依赖，逐字采用）：
  - `export interface StreamCtx { readonly size: number | null; readonly head: Uint8Array<ArrayBuffer>; read(range: ByteRange): Promise<Uint8Array<ArrayBuffer>>; }`
  - `Renderer` 增 `streaming?: boolean;`，render 签名第 5 参 `ctx?: StreamCtx`
  - `TreeStore` 增 `readonly rangeCapable?: boolean;`
  - `FileSource` 增 `size?: number | null;`（FileSource 定义位置以 types.ts 实际为准；若不在 core，则在该类型定义文件同步补）

- [ ] **Step 1: 写类型**——按 Produces 逐字添加，注释引用 spec §2.1/§2.2/§2.3（各一段，说明向后兼容语义：缺省即旧行为）。

- [ ] **Step 2: 验证**——Run: `pnpm typecheck && pnpm test`。Expected: 全绿（纯增量类型，无行为变化）。

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/types.ts
git commit -m "feat(core): StreamCtx/streaming/rangeCapable 类型地基——IO 流式向后兼容演进

spec 2026-10-12-io-streaming §2：Renderer 第 5 参可选 ctx（非 streaming
渲染器忽略即旧行为）、TreeStore.rangeCapable 能力标记（缺省 false）、
FileSource.size 透传（null=未知）。零行为变化。"
```

### Task 2: remote Range 透传 + 两 store 能力标记

**Files:**
- Modify: `packages/core/src/tree/remote.ts`（request 签名、read）
- Modify: `packages/core/src/tree/localFiles.ts`（read range 分支 + 标记）
- Modify: `packages/core/src/tree/localFs.ts`（补 rangeCapable: true 标记——range 已实现）
- Test: `packages/core/test/`（remote 既有测试文件内追加；localFiles 既有测试文件内追加——先 `rg -l "createLocalFilesStore|createRemoteStore" packages/core/test` 定位）

**Interfaces:**
- Consumes: Task 1 的 ByteRange/rangeCapable。
- Produces: `remote read(path, {range})` 发 `Range: bytes=start-end`；206 返回该区间；**200（服务器忽略 Range）返回全量，不做切片**（调用方自校验，spec §2.3）；localFiles read 同签名；两 store `rangeCapable: true`。

- [ ] **Step 1: 写失败测试**——remote 测试内追加（沿用该文件既有 fake fetch 注入模式）：

```ts
it('read 带 range：透传 Range 头，206 返回区间字节', async () => {
  // fake fetch 断言 headers.range === 'bytes=100-199'，返回 206 + 100 字节
  const store = makeStore(); // 该文件既有构造方式
  const got = await store.read('a.txt', { range: { start: 100, end: 199 } });
  expect(got).toHaveLength(100);
});

it('read 带 range 但服务器回 200 全量：原样返回全量（调用方自校验）', async () => {
  // fake fetch 忽略 Range 回 200 + 全量
  const got = await store.read('a.txt', { range: { start: 0, end: 9 } });
  expect(got).toHaveLength(FULL.length);
});
```

localFiles 测试内追加：构造 3 个 File（内容 'abcdef' 等），`read(path, { range: { start: 1, end: 3 } })` → `bcde`（4 字节，end 含）；无 range 全量不变。

- [ ] **Step 2: 跑红**——Run: `pnpm exec vitest run packages/core/test`。Expected: 新用例 FAIL（remote 未发 Range 头/localFiles 无 range 分支）。

- [ ] **Step 3: 实现**——remote.ts：`request(apiPath, path, extraHeaders?: Record<string,string>)` 末参合并进 fetch headers；read：

```ts
async read(path, opts) {
  const r = opts?.range;
  const res = await request('/api/file', path, r ? { range: `bytes=${r.start}-${r.end}` } : undefined);
  // …既有 meta 头逻辑不动
  return new Uint8Array(await res.arrayBuffer());
}
```

read 返回类型已是 `Uint8Array<ArrayBuffer>`（Y1 收窄）。localFiles read：

```ts
async read(path, opts) {
  const f = /* 既有查找 */;
  if (!f) throw new Error(`未知路径: ${path}`);
  const r = opts?.range;
  const blob = r ? f.slice(r.start, r.end + 1) : f; // end 含 → slice end+1
  return new Uint8Array(await blob.arrayBuffer());
}
```

两 store 返回对象加 `rangeCapable: true`（localFs 同补标记）。

- [ ] **Step 4: 跑绿**——同 Step 2 命令。Expected: 全绿。
- [ ] **Step 5: Commit**

```bash
git add packages/core/src/tree/remote.ts packages/core/src/tree/localFiles.ts packages/core/src/tree/localFs.ts packages/core/test
git commit -m "feat(core): remote Range 透传与 localFiles slice——streaming 地基

remote read 带 range 发 Range: bytes=start-end（206 区间；200 全量原样
返回由调用方自校验——spec §2.3）；localFiles 补 File.slice 分支；三 store
补 rangeCapable 标记。服务端已支持 Range header，零服务端改动。"
```

### Task 3: dispatch 读下沉（streaming 选路 + ctx 构造 + 兼容路径）

**Files:**
- Modify: `packages/core/src/dispatch/dispatcher.ts`（dispatch 签名、读流程、ctx 构造、redisplay 透传）
- Test: `packages/core/src/dispatch/dispatcher.test.ts`（既有文件追加；先确认文件名 `rg -l "createDispatcher" packages/core/test`）

**Interfaces:**
- Consumes: Task 1 类型、Task 2 rangeCapable。
- Produces:
  - dispatch 签名：`dispatch(source, buffer: Uint8Array<ArrayBuffer> | null, target, opts?: DispatchOptions & { read?: (range?: ByteRange) => Promise<Uint8Array<ArrayBuffer>> })`——`buffer === null` 时必须提供 opts.read。
  - streaming 渲染器：render 第 5 参收 ctx；`buffer` 形参收 head。
  - 降级：streaming + `!store.rangeCapable` → 全量 read 后 ctx = 全量切片视图（size=full.length）。
  - 非 streaming：全量 read → render(full)（无 ctx）。

- [ ] **Step 1: 写失败测试**（用例要点，代码按既有 dispatcher.test 的 fake registry 模式写全）：

```ts
// ① streaming 渲染器 + rangeCapable store：render 收 head（8KB）而非全量，第 5 参 ctx
//    断言 ctx.size === source.size、ctx.read({start,end}) 经 read 闭包取区间
// ② streaming + !rangeCapable：ctx.head 为全量、ctx.size === 全量长、read 同步切片
// ③ 非 streaming 渲染器 + opts.read：render 收全量（read() 全量被拉取），无 ctx
// ④ 兼容：dispatch(source, buffer, target) 不带 read——行为与旧逐字节等价（head=full.slice）
// ⑤ buffer===null 且无 read → 抛错（信息含 'dispatch'）
// ⑥ streaming 渲染器错误卡片 open-as 重入：redisplay 透传 read（重入后仍走 streaming 路径）
```

- [ ] **Step 2: 跑红**——Expected: ①②⑥ FAIL（签名/行为未实现）。
- [ ] **Step 3: 实现**——dispatch 内部（关键结构，变量名可按现状对齐）：

```ts
const read = opts?.read;
if (buffer === null && read === undefined) throw new Error('dispatch 需要 buffer 或 opts.read');
// 读策略（spec §3）：≤1MB 且 size 已知 → 直接全量（保 detect 的 full 编码精判，
// 与现状 full: buffer.length <= FULL_LIMIT 语义一致）；size 未知 → 先 head 探测
let probe: Uint8Array<ArrayBuffer>;
let full: Uint8Array<ArrayBuffer> | null = buffer;
const headOnly = buffer === null;
if (buffer === null) {
  const size = source.size ?? null;
  if (size !== null && size <= FULL_LIMIT) full = await read!();
  probe = full ?? (await read!({ start: 0, end: HEAD_SIZE - 1 }));
} else {
  probe = buffer;
}
const head = probe.slice(0, HEAD_SIZE);
const det = detect({ name: source.name, head, full: full !== null && full.length <= FULL_LIMIT ? full : undefined });
// …既有 override/redisplay（redisplay 闭包改为 dispatch(source, null, target, { ...o, read })？
//   不对——兼容路径 buffer 非空时保持传 buffer；headOnly 时传 null+read）
let renderer = /* 既有选路 */;
if (!renderer.streaming) {
  if (full === null) full = read !== undefined ? await read!() : buffer!;
  // head/full 变量即旧 buffer 语义，后续 render(full, …) 与 catch 分支不动
} else {
  const capable = source.store.rangeCapable === true;
  if (!capable && full === null) full = await read!();
  const ctx: StreamCtx = capable
    ? { size: source.size ?? null, head: probe, read: (r) => read!(r) }
    : { size: full!.length, head: full!, read: async (r) => full!.subarray(r.start, r.end + 1) };
  // render(full-length-或-head?, …) —— streaming 渲染器收 probe 作 buffer 形参 + ctx
}
```

注意三点：(a) 非 streaming 且 buffer 直传（read undefined）时不得重复 read——full=buffer 即旧值；(b) streaming 的 buffer 形参传 `full ?? probe`（capable 且 size 未知时为 head，else 全量/切片视图底座）；(c) 渲染失败 catch 分支的错误卡片 open-as 用 `full ?? probe` 的 looksTextual 排序——head-only 时退化为 head 探测（可接受，注释说明）。实现时以「旧语义零回归」为第一原则逐段对齐。

- [ ] **Step 4: 跑绿**——`pnpm exec vitest run packages/core/test` + `pnpm test`（全仓，确认所有既有 dispatch 调用方零回归）。Expected: 全绿。
- [ ] **Step 5: Commit**

```bash
git add packages/core/src/dispatch/dispatcher.ts packages/core/src/dispatch/dispatcher.test.ts
git commit -m "feat(core): dispatch 读下沉——streaming 选路 + StreamCtx 构造

ViewerPane 的全量 read 下沉到 dispatcher：head 探测选路后 streaming 渲染器
收 head+ctx（≤1MB 保 full 编码精判语义），非 streaming 全量路径与兼容路径
（buffer 直传、无 opts.read）逐字节等价（spec §3）。"
```

### Task 4: ViewerPane 接线（read 闭包 + source.size）

**Files:**
- Modify: `apps/web/src/lib/ViewerPane.svelte:179-193`（read 下放）
- Modify: `apps/web/src/lib/openFlow.svelte.ts`（addTab/树打开链路把 TreeNode.size 写入 Tab.source.size——定位 `source: { storeId… }` 构造点；FileTree open 事件若带 size 则透传）
- Test: 无新单测（组件接线）；验证=svelte-check 0E0W + 全仓 vitest + 定向 e2e（Task 8）。

- [ ] **Step 1: ViewerPane**——`const buffer = await current.source.store.read(current.source.path)` 改为不再自读：

```ts
const res = await dispatcher.dispatch(
  current.source,
  null,
  host,
  {
    rendererOverride: current.overrideRenderer,
    read: (range) => current.source.store.read(current.source.path, range ? { range } : undefined)
  }
);
```

（dispatch 内部 read 失败会 throw——既有 catch 分支接住走错误卡片，UX 与现状一致。）

- [ ] **Step 2: source.size 透传**——TreeNode.size 已在树数据中（types.ts:3-14）：FileTree 行点击/树打开事件把 size 带到 addTab → Tab.source.size（找 openFlow addTab 的 source 构造与 FileTree onTreeOpen 事件形状，缺 size 字段则 TreeNode 已有 size 直接随事件对象可达）。单文件/拖拽打开链路（openFiles/openUrl）有 File.size 可带；url 链路未知大小带 null。
- [ ] **Step 3: 验证**——`npx svelte-check`（apps/web）0E0W；仓库根 `pnpm test` 全绿；`pnpm build` 成功。
- [ ] **Step 4: Commit**

```bash
git add apps/web/src/lib/ViewerPane.svelte apps/web/src/lib/openFlow.svelte.ts
git commit -m "refactor(web): ViewerPane 读下放 dispatch + source.size 透传

全量 read 从视图层下沉（Task 3 读策略接管）；TreeNode/File.size 经
Tab.source.size 供 ctx.size（spec §3）。"
```

### Task 5: hex 窗口渲染（块缓存访问器 + size null 回退）

**Files:**
- Create: `packages/render-binary/src/hexSource.ts`（块缓存访问器，纯逻辑可单测）
- Modify: `packages/render-binary/src/hex.ts`（renderHex 入参、virtualScroller onRange 取数路径、结构树 tail、status 行）
- Modify: `packages/render-binary/src/hexRenderer.ts`（或 hex.ts 的 renderer 注册处——rg 定位 `id: 'hex'` 的 Renderer 对象）：声明 `streaming: true`，renderHex 增第 6 参 ctx 透传
- Test: `packages/render-binary/test/hexSource.test.ts`（新）+ `test/hex.test.ts`（追加窗口模式用例）

**Interfaces:**
- Consumes: Task 3 的 ctx 第 5 参。
- Produces: `createHexSource(size: number, head: Uint8Array, read: (r: ByteRange) => Promise<Uint8Array<ArrayBuffer>>)` → `{ size; slice(start, end): Uint8Array | null; ensure(start, end): Promise<void> }`——slice 未就绪返回 null；ensure 拉取覆盖区间的块并 resolve；内部 64KB 块 LRU 上限 8 块。**size 未知不进 hexSource**：hex.ts 在创建前处理（见 Step 4 回退）。

- [ ] **Step 1: hexSource 单测先行**（新文件，用例清单）：
  1. head 覆盖区间 slice 直取（不触发 read）；
  2. 未就绪区间 slice → null，ensure 后 slice 返回正确字节（fake read 记录请求区间）；
  3. 块对齐：请求 [100, 200] 拉取覆盖块（对齐 64KB），跨块区间一次 ensure 多块；
  4. LRU：第 9 个不相交块进入后最旧块被逐出（slice → null 且再次 ensure 重新拉取）；
  5. 同块并发 ensure 去重为单次 read（并发计数断言）。

- [ ] **Step 2: 跑红**——Expected: FAIL（hexSource 不存在）。
- [ ] **Step 3: 实现 hexSource.ts**（完整纯逻辑模块：块 Map<index, Uint8Array> + LRU 序 + ensure 合并并发请求）。
- [ ] **Step 4: hex.ts 接入**——renderHex 增末参 `ctx?: StreamCtx`；内部：
  - `ctx === undefined`（兼容路径/非 streaming 调用）：现状全量逻辑不动（buffer 直用）；
  - `ctx.size === null`（size 未知来源回退，spec §5）：`const full = await ctx.read({ start: 0, end: Number.MAX_SAFE_INTEGER })`——远端 Range 端点由服务端钳制（file.rs end 钳制）返回整文件、localFs/localFiles slice 越界自然钳制——拿到全量后走现状逻辑（=旧行为）；
  - 窗口模式（`ctx.size !== null`）：`const src = createHexSource(ctx.size, ctx.head, ctx.read)`；`rowCount`/status 用 `src.size`；onRange 内 `src.slice(start, end)`：
    - 非 null → 现状 renderHexBytes 路径（字节一致）；
    - null → 该窗口行先渲染为空占位（保行高），`void src.ensure(start, end).then(() => 重新触发当前窗口渲染)`——virtualScroller handle 的重渲染入口用既有 API（onRange 由滚动触发；编程重渲用 handle 暴露的刷新方法，若无则在 ensure.then 里直接对当前 first/last 重跑一次格式化并 replaceChildren——以 hex.ts 现状实现最小侵入为准）；
  - 结构树 tail：全量模式下现状 slice；窗口模式 `src.ensure(size-8K, size-1)` 后取（异步，structReady promise 语义保持）；
  - 搜索（startSearch/gotoHit/inspect cursor flash）：命中渲染依赖 slice——统一走「slice null → ensure + 重渲」路径。
- [ ] **Step 5: hex.test.ts 追加用例**：
  1. ctx（size 已知 fake read）渲染：首屏只读 head+首窗块（fake read 记录区间断言字节数 ≤ head+2 块）；
  2. 滚动到远处窗口：触发对应块 read（区间断言）；
  3. size null：行为与全量等价（既有断言形状复用）；
  4. 行文本与全量模式逐字节一致（同 buffer 两种模式输出 diff 为空）。
- [ ] **Step 6: 跑绿**——`pnpm exec vitest run packages/render-binary/test` + 全仓 `pnpm test`。
- [ ] **Step 7: Commit**

```bash
git add packages/render-binary/src/hexSource.ts packages/render-binary/src/hex.ts packages/render-binary/src/hexRenderer.ts packages/render-binary/test/hexSource.test.ts packages/render-binary/test/hex.test.ts
git commit -m "feat(render-binary): hex 窗口流式渲染——块缓存访问器 + size 回退

renderHex 收 StreamCtx：64KB×8 LRU 块缓存，可视行命中直取、未命中
ensure 拉块重渲（占位保行高）；结构树 tail 按需拉；size null 来源全量
回退（=现状）。行格式输出与全量模式逐字节一致（spec §4.1）。"
```

### Task 6: hex 搜索 need/chunk 握手（worker 驱动逐块扫描）

**Files:**
- Modify: `packages/render-binary/src/binary.worker.ts`（search 协议扩展）
- Modify: `packages/render-binary/src/client.ts`（请求侧协议）
- Modify: `packages/render-binary/src/hex.ts`（startSearch 窗口模式分支）
- Test: `packages/render-binary/test/searchScan.test.ts`（worker 协议用例追加）+ `test/hexSearch.test.ts`（窗口模式搜索）

**Interfaces:**
- Produces（worker 协议扩展，向后兼容）：
  - 请求（窗口模式）：`{ id, kind: 'search', needle, caseInsensitive?, size }`——**无 data**；
  - worker → 主线程：`{ type: 'search-need', id, start, end }`（1MB 步进，末块钳制）；
  - 主线程 → worker：`{ type: 'search-chunk', id, start, bytes }`；
  - worker 内部按 searchScan 既有语义逐块 scanChunk（overlap 去重、块内即时判停、进度、maxHits、search-cancel 失效 id）。
  - 兼容：`data` 形式的旧请求照常服务（全量模式）。

- [ ] **Step 1: 写失败测试**（searchScan.test.ts 既有 fakeCtx 模式追加）：

```ts
it('search 窗口协议：无 data → search-need 逐块请求，chunk 回灌后照常 progress/done', async () => {
  const { ctx, out } = fakeCtx();
  serveBinaryWorker(ctx, { chunkSize: 4 });
  post(ctx, { id: 7, kind: 'search', needle: enc('ab'), size: 8 } as never); // 无 data
  await drain();
  // 断言第一条 search-need { start: 0, end: 4 }（chunkSize 4）
  const need = out.find((m) => (m as { type?: string }).type === 'search-need');
  expect(need).toMatchObject({ id: 7, start: 0, end: 4 });
  // 回灌 chunk → progress → need 下一块 → … → done
  post(ctx, { type: 'search-chunk', id: 7, start: 0, bytes: enc('abab') } as never);
  await drain();
  // …逐块回灌至末块，断言 done.truncated === false 且命中齐全
});

it('search-cancel 使窗口任务失效：不再发 search-need', async () => { /* 同既有取消语义 */ });
```

（协议类型在 binary.worker.ts 的 BinaryRequest/BinaryWorkerMessage 联合中正式扩展，测试去掉 as never。）

- [ ] **Step 2: 跑红** → **Step 3: 实现 worker 窗口循环**（state 机：id 活跃时发 need、收 chunk 后 scanChunk(overlap=needle.length-1, maxHits 配额)、累计进度、末块后 done；cancel/新请求失效同既有）→ **Step 4: client.ts**——`search` 方法窗口模式发无 data 请求、监听 search-need 经回调（hex.ts 注入的 read 闭包）取块回灌；超时/读失败 → abort 该任务并置错误态。
- [ ] **Step 5: hex.ts startSearch 分支**——窗口模式（`ctx.size !== null`，src 已建）：走新协议（client 注入 read 回调）；全量回退/兼容路径：现状 data 请求不变。gotoHit 依赖的块由 ensure 保证（命中 offset 所在块）。
- [ ] **Step 6: 跑绿**——render-binary 全部测试 + `pnpm test`。
- [ ] **Step 7: Commit**

```bash
git add packages/render-binary/src/binary.worker.ts packages/render-binary/src/client.ts packages/render-binary/src/hex.ts packages/render-binary/test
git commit -m "feat(render-binary): hex 搜索 need/chunk 握手——窗口模式逐块扫描

worker 驱动 1MB 步进 search-need，主线程经 ctx.read 回灌 search-chunk；
scanChunk 语义（overlap 去重/块内判停/进度/maxHits/cancel）全保留；data
旧协议照常服务全量模式，向后兼容（spec §4.1 搜索）。"
```

### Task 7: e2e 字节计量 + 验收

**Files:**
- Create: `apps/web/e2e/b-io-streaming.spec.ts`（假服务器 + 响应字节数统计）
- Test: 本任务即测试

- [ ] **Step 1: 假服务器计量**——仿 t-workspace 的 startFakeServer：/api/file handler 记录每请求 Range 头与响应字节数（`req.headers.range` + 计量累加），暴露 `page.evaluate` 可读的 `window.__vvIoStats`（由测试经 fetch 后自带统计即可——更简单：handler 把统计写进响应头 `x-served-bytes`？不可行——直接在 spec 内用 page.on('response') 统计 body 大小与 range 头）。
- [ ] **Step 2: 用例**（逐字断言）：
  1. 「远端 10MB 文件 hex 首屏：总拉取 ≤ 1MB」——生成 10MB（fill 循环 Uint8Array）假文件，openDir+openHexFile，`page.on('response')` 累计 /api/file 字节，断言 ≤ 1_100_000 且状态条显示 10.0 MB（formatSize）；
  2. 「滚动到末尾触发续读」——scrollTop 拉满后断言出现 0xfffff0 行首偏移的行且新增 range 请求；
  3. 「SSE 重渲染免全量重读」——外部 touch 文件（fs.write 触发假服务器 SSE 或直接调刷新 ↻），等待重渲染后总字节数增幅 < 2MB（窗口级）而非 10MB；
  4. 「搜索 need/chunk 端到端」——hex 搜索既存字节序列，命中跳转正确（复用 t-hex-enhance 模式）。
- [ ] **Step 3: 回归**——`pnpm exec playwright test e2e/t-hex-enhance.spec.ts e2e/t-hex.spec.ts`（既有 hex e2e 断言零变更须全绿）+ 全仓 vitest + svelte-check。
- [ ] **Step 4: Commit**

```bash
git add apps/web/e2e/b-io-streaming.spec.ts
git commit -m "test(e2e): IO 流式字节计量锚点——首屏/续读/免重读/搜索端到端

假服务器 + response 计量：10MB 文件首屏 ≤1MB、滚动续读、SSE 重渲染
无全量重读、窗口搜索 need/chunk 端到端（spec §6）。"
```

## 验收（计划级）

1. 全部门禁：vitest 全绿（新增 ≥15 用例）、svelte-check 0E/0W、cargo 不受影响（零服务端改动，跑一次确认）、playwright 默认通道全绿（含新增计量用例）。
2. 手工口径：远端 10MB 文件 hex 浏览内存中不出现全量 buffer（结构断言：hex 窗口模式不引用 size 全 buffer——代码评审项）。
3. 计划 2（jsonl）与计划 3（code）的实施前提就绪：StreamCtx/dispatch 地基经 hex 端到端验证。
