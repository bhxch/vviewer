# IO 级流式计划 2（jsonl 迁移）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** jsonl 渲染器流式化：行索引按字节流式构建、块解码缓存、「已加载 N 行」归还 spec D §2.2 口径；落地公共块流读取器（计划 3 code 复用），吸收计划 1 全部遗留。

**Architecture:** 新公共模块 `blockStream.ts`（StreamCtx → 块序列：短读 atEnd 探测、超长返回即 200-回退切全量模式——兑现计划 1 F3）+ `jsonlIndex.ts`（字节级行终结符扫描推进器）。renderJsonl 双模式：窗口模式（ctx + UTF-8/ASCII：索引流式、块文本缓存 LRU、滚动续读）与全量模式（现状逐字节不动：!ctx / 非 UTF-8 / !rangeCapable 全量视图）。

**Tech Stack:** TypeScript（packages/render-text）、vitest、Playwright 默认通道。

**Spec:** `docs/superpowers/specs/2026-10-12-io-streaming-design.md` §4.2/§5/§8；计划 1 遗留（/tmp/vviewer-plan1-ledger-final.md 快照，见 Global Constraints）。

## Global Constraints

- 全量模式零回归：!ctx（兼容路径）、!rangeCapable（全量视图）、非 UTF-8 编码三种回退下，renderJsonl 行为与现状逐字节等价；既有 jsonl 三测试文件（parse/render/window）断言零变更（新增除外）。
- 状态条文案变更仅限「共 N 行」→「已加载 N 行」（流式模式）；失败徽标「N 行解析失败」文案不变（t-open-with.spec.ts:353 断言依赖）。
- 滚动契约不变：.vv-jsonl 类名/卡片 DOM 结构/HeightModel 机制零变更。
- e2e 断言更新清单（spec §8.1）：凡断言「共 N 行」的流式路径用例改为「已加载 N 行」；先 rg 全量排查再改。
- 禁 any；注释中文；测试从仓库根跑；每任务原子 commit。
- 计划 1 遗留吸收：①Task 1 落地 blockStream（F3 公共化）；②Task 4 补 dispatcher「streaming+capable+size≤1MB」分支用例；③Task 1 顺手补 localFs rangeCapable 断言；④Task 4 顺手透传 QuickOpen/GlobalSearch/archive 的 source.size；⑤Task 5 顺手修 worker SearchChunkRequest.bytes 注释漂移；⑥detect O(n) 收口=本计划设计内解决（仅 UTF-8/ASCII 流式，非 UTF-8 全量回退自带 full 精判）。

---

### Task 1: blockStream 公共块流读取器

**Files:**
- Create: `packages/render-text/src/blockStream.ts`
- Modify: `packages/core/src/tree/localFs.test.ts` 所在文件（顺手：补 `expect(store.rangeCapable).toBe(true)` 一行——rg 定位 localFs 测试文件）
- Test: `packages/render-text/test/blockStream.test.ts`（新）

**Interfaces:**
- Consumes: `StreamCtx`（core，Task P1-T1）。
- Produces（Task 3/计划 3 依赖，逐字采用）：

```ts
export interface BlockStream {
  readonly blockSize: number;
  /** 已确认的文件字节数（size 已知时= size；未知时随短读探测推进） */
  readonly confirmedBytes: number;
  /** 200-回退已触发：ctx 交付过全量（此时 readBlock 为全量切片） */
  readonly degradedToFull: boolean;
  /** 第 i 块字节（末块短读）；i 必须已 ensure */
  block(i: number): Uint8Array<ArrayBuffer>;
  /** 确保第 i 块就绪；返回该块字节。i > 当前已确认块数时仅按序推进（不跳读） */
  ensureBlock(i: number): Promise<Uint8Array<ArrayBuffer>>;
  /** 已确认末块（短读或 size 精确到达） */
  atEnd(): boolean;
}
export function createBlockStream(ctx: StreamCtx, blockSize: number): BlockStream
```

语义：①`ctx.size !== null` 时块数 = ceil(size/blockSize)，末块精确短读；②`size === null` 时逐块满请求，返回短于 blockSize 即标记 atEnd；③**任一 read 返回字节数 > 请求长度（Range-less 200）→ 抛弃流式缓冲、向 ctx 请求全量（read({0, MAX_SAFE_INTEGER})），degradedToFull=true，此后 block(i) 为全量切片、atEnd()=true**（兑现计划 1 F3，不再契约信任）；④ctx.read 失败原样抛出（读失败面上抛，调用方按 DispatchReadError 口径处理）。

- [ ] **Step 1: 写失败测试**（用例清单）：head 覆盖首块直取不触发 read；size 已知末块短读+atEnd；size 未知短读探测 atEnd；逐块顺序推进（ensureBlock(2) 前置拉 0/1）；**超长返回→degradedToFull + 后续 block 为全量切片 + atEnd**；read 失败原样上抛。
- [ ] **Step 2: 跑红** → **Step 3: 实现** → **Step 4: 跑绿**（含 localFs 断言一行）。
- [ ] **Step 5: Commit**

```bash
git add packages/render-text/src/blockStream.ts packages/render-text/test/blockStream.test.ts packages/core/test/<localFs测试文件>
git commit -m "feat(render-text): blockStream 公共块流读取器——短读 atEnd/200-回退全量切换

StreamCtx→块序列统一抽象（计划 3 code 复用）：size 已知精确分块、未知短读
探测；Range-less 服务器超长返回即切全量模式（兑现计划 1 终审 F3，不再
契约信任）。顺手补 localFs rangeCapable 断言（计划 1 遗留③）。"
```

### Task 2: jsonlIndex 行索引流式推进器

**Files:**
- Create: `packages/render-text/src/jsonl/indexStream.ts`
- Test: `packages/render-text/test/jsonl-index-stream.test.ts`（新）

**Interfaces:**
- Produces：

```ts
export interface JsonlIndexState {
  /** 行起始字节偏移（相对文件头；行内容不含终结符） */
  offsets: number[];
  /** 各行字节长（不含终结符；与 offsets 平行） */
  lengths: number[];
  /** 已消费的字节游标（块边界或行终结符后） */
  loadedBytes: number;
  /** 已扫描到文件末尾 */
  atEnd: boolean;
  /** 超长行（> maxLineBytes）行号集合——不解析、预览截断（parse.ts 既有语义） */
  oversized: Set<number>;
}
export function createJsonlIndex(maxLineBytes: number): JsonlIndexState
/** 喂入一块原始字节（utf-8 原始流；块边界已由 BlockStream 对齐）推进索引 */
export function advanceJsonlIndex(state: JsonlIndexState, chunk: Uint8Array): void
```

语义：行终结符 `\n` 或 `\r`（`\r\n` 记为一个终结符——CRLF 不产生空行，对齐全量模式 `replace(/\r\n?/g,'\n')` + splitJsonlLines 丢弃空行的最终语义）；空行不产出条目（JSONL 惯例）；`maxLineBytes` = 1MB（对齐 parse.ts 既有巨行防护常量，rg 确认名后引用之）。

- [ ] **Step 1: 写失败测试**（用例清单）：LF 基本切行；CRLF 不产生空行；孤立 CR（旧 Mac）计终结符；空行丢弃；**块边界切开 \r\n**（\r 在块尾、\n 在下块头——依赖 BlockStream 对齐？不：BlockStream 按 blockSize 切，不保证行对齐！设计裁决——advanceJsonlIndex 接受任意切面的 chunk 序列，内部维护「上一字节是否 \r」跨块状态，调用方必须按序喂块）；巨行超限记 oversized；atEnd 后尾行无终结符也产出；空文件零行。
- [ ] **Step 2: 跑红** → **Step 3: 实现** → **Step 4: 跑绿**（与全量模式等价性用例：同一多行含 CRLF/空行/巨行文本，全量 decode+replace+splitJsonlLines 的 (offset,len) 序列与索引产物一致——offset 用字节换算）。
- [ ] **Step 5: Commit**

```bash
git add packages/render-text/src/jsonl/indexStream.ts packages/render-text/test/jsonl-index-stream.test.ts
git commit -m "feat(render-text): jsonl 行索引流式推进器——字节扫描 LF/CRLF/CR 终结符

offsets+lengths 流式追加、巨行防护、跨块 \r\n 状态；与全量模式切行语义
等价性有专用用例钉住（spec §4.2 索引层）。"
```

### Task 3: renderJsonl 窗口模式（双模式 + 状态条 + 滚动续读）

**Files:**
- Modify: `packages/render-text/src/jsonl/index.ts`（双模式分叉、窗口渲染路径）
- Test: `packages/render-text/test/jsonl-render.test.ts`（追加窗口模式用例）

**Interfaces:**
- Consumes: Task 1 BlockStream、Task 2 索引推进器、StreamCtx。
- Produces: `renderJsonl(buffer, target, det, ctx?: StreamCtx)`——`ctx` 存在且 `(det.encoding ?? 'utf-8')` 属 utf-8/ascii → **窗口模式**（size 未知同样流式：BlockStream 短读探测 atEnd，spec §5「jsonl/code 仍可流式」）；否则全量模式（现状代码路径不动：!ctx / 非 UTF-8）。全量视图（!rangeCapable 时 dispatcher 给的 ctx.head=全量+同步切片 read）属于窗口模式的退化形态，天然工作，无需特判。窗口模式行为：
  - 索引：BlockStream（256KB）逐块喂 advanceJsonlIndex；首屏确保前 2 块；
  - 行文本：块解码缓存 `Map<blockIndex, string>` LRU 8 块（TextDecoder utf-8 fatal:false；行文本=块文本切片；跨块巨行按索引 lengths 从多块拼——oversized 行不走拼装，走预览截断）；
  - 状态条：`已加载 N 行`（atEnd 前）/ `共 N 行`（atEnd 后）+ 失败徽标不变；滚动接近已加载尾部（剩 ≤ OVERSCAN×2 行）→ `void` 续读下一块并重渲；
  - getMeta().lines 返回已加载行数（动态）；
  - 卡片渲染/折叠/高亮/解析缓存逻辑复用现状（stateOf(i) 的行文本来源换块缓存）。

- [ ] **Step 1: 写失败测试**（用例清单）：窗口模式首屏只拉 2 块（fake ctx 记录区间断言）；「已加载 N 行」状态条；滚动到底触发续读 + atEnd 后变「共 N 行」；行渲染输出与全量模式逐字节一致（同文件双模式 DOM diff 为空）；块解码缓存 LRU 上限；oversized 行预览；非 UTF-8 encoding → 全量路径（ctx.read 全量未被调用则经由 head?——非 UTF-8+capable 时 render 内 `await ctx.read({0,MAX})` 走全量，现状断言形状复用）。
- [ ] **Step 2: 跑红** → **Step 3: 实现** → **Step 4: 跑绿**（jsonl 全部测试 + 全仓）。
- [ ] **Step 5: Commit**

```bash
git add packages/render-text/src/jsonl/index.ts packages/render-text/test/jsonl-render.test.ts
git commit -m "feat(render-text): jsonl 窗口流式渲染——索引流式+块文本缓存+已加载 N 行

renderJsonl 第 4 参 ctx：UTF-8/ASCII 窗口模式（索引流式、256KB 块解码
缓存 LRU 8、滚动续读、状态条「已加载 N 行/共 N 行」）；非 UTF-8/无 ctx/
全量视图三回退走现状路径逐字节不动（spec §4.2，归还 jsonl spec §2.2
「总行数未知」口径）。"
```

### Task 4: streaming 声明 + 回退矩阵补全 + size 透传补遗

**Files:**
- Modify: `packages/render-text/src/jsonl/index.ts` 的 Renderer 注册处（rg "id: 'jsonl'"）：`streaming: true`
- Modify: `packages/core/src/dispatch/dispatcher.ts` 或其测试（补「streaming+capable+size≤1MB」分支用例——计划 1 遗留②）
- Modify: `apps/web/src/lib/openFlow.svelte.ts`（QuickOpen/GlobalSearch/archive 链路 source.size 透传——计划 1 遗留④；rg "addTab(" 各调用点核对 size 来源：QuickOpen 的 ScannedFile 有 size？GlobalSearch 命中行有 size？archive 条目有 size——逐点补，无 size 来源的传 null）
- Test: 对应测试文件

- [ ] **Step 1: dispatcher 分支用例**（streaming+capable+size≤1MB：head=全量、ctx.size=size、零额外 read）——红
- [ ] **Step 2: jsonlRenderer streaming 声明**（streaming 路径经 Task 3 已可用）——此时远端 jsonl 打开自动窗口化
- [ ] **Step 3: size 透传三链路**（QuickOpen `ScannedFile`/GlobalSearch/archive 事件的 size 字段核对补齐）
- [ ] **Step 4: 验证**——全仓 vitest + svelte-check 0E/0W（apps/web）+ `pnpm build`。
- [ ] **Step 5: Commit**

```bash
git commit -m "feat(render-text,web): jsonl streaming 声明 + size 透传补遗

jsonlRenderer streaming:true（远端 jsonl 打开即窗口化）；补 dispatcher
streaming+capable+≤1MB 分支用例（计划 1 遗留②）；QuickOpen/GlobalSearch/
archive 三链路 source.size 透传（遗留④）。"
```

### Task 5: e2e 断言更新 + 计量 + 验收

**Files:**
- Modify: 既有 jsonl e2e 中断言「共 N 行」的流式路径用例（先 `rg -n "共 .*行|vv-jsonl-status" apps/web/e2e` 全量排查，逐一判定该路径是否流式——本地注入 localfiles 走窗口化，断言改「已加载 N 行」或滚动到底后「共 N 行」）
- Modify: `packages/render-binary/src/binary.worker.ts`（顺手：SearchChunkRequest.bytes 注释漂移修正——遗留⑤）
- Create/Modify: `apps/web/e2e/b-io-streaming.spec.ts`（追加 jsonl 计量用例）
- Test: 本任务即测试

- [ ] **Step 1: rg 排查「共 N 行」断言并逐一更新**（每处注明该用例来源 store 与模式）
- [ ] **Step 2: jsonl 计量用例**（追加到 b-io-streaming）：远端 5MB jsonl 首屏总拉取 ≤ head+2 块+余量（<1MB）；滚动到底触发续读且 atEnd 后状态条「共 N 行」；失败行徽标文案不回归（对照 t-open-with:353 语义）。
- [ ] **Step 3: 回归**——`pnpm exec playwright test e2e/t-open-with.spec.ts` + jsonl 定向（rg 出的 spec）+ 全仓 vitest + svelte-check。
- [ ] **Step 4: Commit**

```bash
git commit -m "test(e2e): jsonl 流式断言迁移——已加载 N 行/续读/首屏计量

「共 N 行」流式路径断言迁移（spec §8.1）；b-io-streaming 追加 jsonl
首屏 ≤1MB 与滚动续读计量；worker bytes 注释漂移顺手修（遗留⑤）。"
```

## 验收（计划级）

1. vitest 全绿（新增 ≥12 用例）、svelte-check（apps/web）0E/0W、playwright 默认通道全绿。
2. 结构断言：jsonl 窗口模式不持全量解码文本（块缓存 LRU 8 上限单测）。
3. spec §8.1 断言变更全部落地且逐处注明模式。
4. 计划 3（code）前提就绪：BlockStream 经 jsonl 端到端验证。
