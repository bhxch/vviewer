# IO 级流式计划 3（code 迁移）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** code 渲染器流式化：行索引字节流式构建、窗口解码、后台全文搜索（进度/取消/定位）、防线口径从 PLAIN_MAX_BYTES 换代 STREAM_MAX_BYTES；吸收 BlockStream 块表有界化（P2 终审 B1）。

**Architecture:** ①BlockStream 增可选 `maxBlocks` LRU（B1：块表有界化，jsonl 同步接入）；②`codeIndex.ts` 行索引流式推进器（与 jsonlIndex 同型但**保留空行**——code 行索引含空行，parametrize 或独立实现）；③「块解码缓存 + 前缀解码游标」从 jsonl/index.ts 抽公共 `textWindow.ts`（jsonl 改用，code 复用——P2-T3 已立的钩子面标准）；④renderCode 双模式：`size ≤ 2MB` 全量（tree-sitter 整文件现状路径，renderer 内 ctx.read 自取全量）、`>2MB` 流式（索引后台构建 + lazy 高亮按已构建索引 + 窗口解码）、`> STREAM_MAX_BYTES(512MB)` 提示降级 hex 打开；⑤搜索后台全文扫描。

**Tech Stack:** TypeScript（packages/render-text、apps/web SearchPanel 交互零变更）、vitest、Playwright。

**Spec:** `docs/superpowers/specs/2026-10-12-io-streaming-design.md` §4.3/§5；计划 1/2 遗留（/tmp/vviewer-plan1-ledger-final.md、/tmp/vviewer-plan2-ledger-final.md）。

## Global Constraints

- 全量/兼容路径零回归：`size ≤ 2MB`、!ctx、非 UTF-8 三回退下 renderCode 行为与现状逐字节等价；既有 code 测试断言零变更（新增除外）。
- SearchPanel/ViewerPane 鸭子接口（search/gotoMatch/getMeta/getScrollHost/getEngine/getComputeWhere）签名零变更——后台扫描对 UI 侧表现为 search() 返回 Promise 语义内的进度回调扩展（可选字段）。
- e2e 既有断言零变更（新增计量/进度用例除外）。
- 禁 any；注释中文；测试仓库根跑；每任务原子 commit。
- 计划 1/2 遗留吸收：①B1 块表有界化（Task 1）+ jsonl 接入上限（Task 1）+ STREAM_MAX_BYTES 统一裁决（Task 1 定常量、jsonl 同步接入）；②mountJsonlView 钩子面标准沿用（Task 3 抽 textWindow 时同标准：分歧段逐字保留+窄钩子+既有用例零变更+等价性钉住）；③T2 遗留「oversized 预览跨块多字节无专测」——Task 2 的等价性用例覆盖多字节巨行（jsonl 侧顺手补亦可）。

---

### Task 1: BlockStream 有界化 + STREAM_MAX_BYTES 统一裁决

**Files:**
- Modify: `packages/render-text/src/blockStream.ts`（maxBlocks LRU）
- Modify: `packages/render-text/src/jsonl/index.ts`（窗口模式接入 maxBlocks + 流式尺寸上限提示）
- Test: `packages/render-text/test/blockStream.test.ts` + `jsonl-render.test.ts`（追加）

**Interfaces:**
- Produces: `createBlockStream(ctx, blockSize, opts?: { maxBlocks?: number })`——块表超上限按 LRU 逐出（head 预置块同样计入；被逐出块再访问返回 null/重拉——与 hexSource 同语义）；`export const STREAM_MAX_BYTES = 512 * 1024 * 1024`（新常量放 blockStream.ts 或独立 streamLimits.ts，jsonl/code 共享）。

- [ ] **Step 1: 写失败测试**：maxBlocks 逐出（第 N+1 块进入后最旧块重拉）；jsonl 窗口模式接入 maxBlocks 后滚动回看重拉正确；`STREAM_MAX_BYTES` 常量存在且 = 512MB。
- [ ] **Step 2: 跑红** → **Step 3: 实现** → **Step 4: 跑绿**（jsonl 既有用例零回归）。
- [ ] **Step 5: Commit**

```bash
git commit -m "feat(render-text): blockStream 块表 LRU 有界化 + STREAM_MAX_BYTES 统一裁决

计划 2 终审 B1：块表无界致滚动到底原始字节全量常驻。maxBlocks 可选 LRU
（jsonl 窗口模式接入）；STREAM_MAX_BYTES=512MB 常量供 jsonl/code 统一
流式尺寸防线（spec §4.3 防线换代口径）。"
```

### Task 2: jsonl 窗口模式接入尺寸上限 + textWindow 公共抽取

**Files:**
- Modify: `packages/render-text/src/jsonl/index.ts`（窗口模式超 STREAM_MAX_BYTES → 状态条提示 + 停止续读 + 建议以 hex 打开；「块解码缓存+前缀解码游标」抽 `textWindow.ts`）
- Create: `packages/render-text/src/textWindow.ts`（从 jsonl/index.ts 抽取：块解码缓存 LRU + 前缀解码游标 + 跨块字节域拼装）
- Test: `packages/render-text/test/textWindow.test.ts`（新）+ jsonl-render.test.ts（零变更回归）

**Interfaces:**
- Produces: `createTextWindow(): TextWindow`——`feedBlock(i, bytes)`、`decodeRange(startChar, endChar): string`（或等价形态——以 jsonl/index.ts 现状实现为抽取源，接口按现状反推）、LRU 上限注入。**抽取纪律（P2-T3 立的钩子面标准）**：分歧段逐字保留、既有 jsonl 用例零变更、抽后 jsonl 等价性用例（双模式 DOM diff）仍绿。
- jsonl 尺寸上限交互：loadedBytes 超 STREAM_MAX_BYTES → 续读停机 + 状态条追加「已达流式上限，建议以 hex 打开」（不复用错误卡片——非失败态）。

- [ ] **Step 1: textWindow 单测**（从 jsonl 等价性用例平移：跨块多字节/LRU/前缀游标）→ 红
- [ ] **Step 2: 抽取 + jsonl 改用** → 绿（既有全部零变更）
- [ ] **Step 3: jsonl 上限停机用例** → 红 → 实现 → 绿
- [ ] **Step 4: Commit**

```bash
git commit -m "refactor(render-text): textWindow 公共抽取 + jsonl 流式尺寸上限

块解码缓存/前缀游标抽 textWindow（计划 3 code 复用，钩子面标准沿用）；
jsonl 窗口模式超 STREAM_MAX_BYTES 停止续读并提示 hex 打开（B1 尺寸上限
统一裁决落地）。"
```

### Task 3: codeIndex 行索引流式推进器（保留空行）

**Files:**
- Create: `packages/render-text/src/codeIndexStream.ts`
- Test: `packages/render-text/test/code-index-stream.test.ts`（新）

**Interfaces:**
- Produces: 与 JsonlIndexState 同型但**空行也产出条目**（code 行索引含空行，行号 = 文本行号）：`createCodeIndex(maxLineBytes)` / `advanceCodeIndex(state, chunk)` / `finishCodeIndex(state)`。CRLF/CR 语义同 code.ts 现状归一化（\r\n→\n 字节级等价：\r\n 记一行终结符）。

- [ ] **Step 1: 写失败测试**：基本切行（含空行条目）；CRLF；跨块 \r\n；巨行 >=（对齐 code 现状语义——rg buildLineIndex/解析处确认 code 是否有巨行防护，无则 maxLineBytes 传 Infinity 语义）；等价性用例（全量 decode+replace+buildLineIndex 行序列 vs 索引产物，含空行/多字节/1MB 巨行）。
- [ ] **Step 2: 跑红** → **Step 3: 实现**（可复用 indexStream 内部机制——若 jsonlIndex 可参数化 dropBlank 则参数化，否则独立实现，二选一报告理由）→ **Step 4: 跑绿**。
- [ ] **Step 5: Commit**

```bash
git commit -m "feat(render-text): codeIndex 行索引流式推进器——保留空行字节扫描

与 jsonlIndex 同型但空行产出条目（code 行号=文本行号）；跨块 \r\n、
巨行、多字节等价性专测（spec §4.3 索引层）。"
```

### Task 4: renderCode 窗口模式（高亮分界 + 窗口解码 + meta）

**Files:**
- Modify: `packages/render-text/src/code.ts`（renderCode 双模式：ctx 存在且 UTF-8 且 size>2MB → 窗口流式；size≤2MB → ctx.read 全量走现状 tree-sitter 路径；!ctx/非 UTF-8 → 现状（非 UTF-8 同 jsonl 守卫补拉全量）；>STREAM_MAX_BYTES → 提示条 + 停止索引 + 建议 hex）
- Modify: code 的 Renderer 注册处：`streaming: true`
- Test: `packages/render-text/test/code.test.ts`（追加窗口模式用例——先确认 code 测试文件名）

**Interfaces:**
- Consumes: Task 1 BlockStream LRU、Task 2 textWindow、Task 3 codeIndex、既有 lazy 高亮 chunk 机制（chunkKey=startLine）。
- Produces: 窗口模式行为——
  - 索引：后台逐块推进（首屏首块即可渲染），`getMeta().lines` 动态（「N+ 行」形态与 ViewerPane 显示兼容——核验 meta 消费点）；
  - 行渲染：virtualScroller 行文本经 textWindow 窗口解码；可视行超出已加载索引 → ensure 续读 + 重渲（占位保行高，hex 同款）；
  - 高亮：strategy 判定用 size（ctx.size）：≤2MB 全量 tree-sitter（read 自取）；>2MB lazy（既有 chunk 高亮按已构建索引工作——核验 lazy 的行文本来源在窗口模式下换 textWindow）；
  - 滚动持久化/搜索面板挂载零变更。

- [ ] **Step 1: 写失败测试**（用例清单）：窗口模式首屏只读 head+首块；行渲染与全量模式逐字节一致（双模式 diff 为空，含空行/多字节/巨行）；size≤2MB 走全量 tree-sitter（read 全量断言 + 引擎=tree-sitter）；>2MB 引擎=lazy 且可视 chunk 高亮工作；getMeta lines 动态；STREAM_MAX_BYTES 提示条。
- [ ] **Step 2: 跑红** → **Step 3: 实现** → **Step 4: 跑绿**（code 全部测试 + render-text 全套 + 全仓）。
- [ ] **Step 5: Commit**

```bash
git commit -m "feat(render-text): code 窗口流式渲染——索引流式+窗口解码+防线换代

renderCode 第 5 参 ctx：>2MB 流式（codeIndex 后台索引、textWindow 窗口
解码、lazy 高亮兼容）；≤2MB 全量 tree-sitter 现状路径；PLAIN_MAX_BYTES
防线换代 STREAM_MAX_BYTES=512MB（spec §4.3）。"
```

### Task 5: code 后台全文搜索（进度/取消/定位）

**Files:**
- Modify: `packages/render-text/src/code.ts`（窗口模式 search 重写）
- Test: `packages/render-text/test/code.test.ts`（追加）+ 既有 search 相关测试（t-search e2e 若断言进度 UI 则更新——先 rg）

**Interfaces:**
- Produces: 窗口模式 `search(query, opts)` 语义——从文件头逐块解码扫描到 EOF（BlockStream 驱动），返回 Promise<SearchMatch[]> 不变；进度经新增可选回调（SearchPanel 零变更的前提下：进度显示挂状态条/现有 notice 机制，核验 SearchPanel 现状后定挂点——以「UI 零变更」优先，进度若无处显示则仅记 console/省略，报告说明）；取消 = 新搜索/tab 销毁令牌失效；`gotoMatch(i)` 确保目标块已读（ensure）后跳转高亮；扫描中已命中结果即时可用（渐进）。
- 全量模式 search 现状不动。

- [ ] **Step 1: 写失败测试**：窗口模式搜索命中正确（跨块 query）；取消令牌（重入搜索旧令牌失效）；gotoMatch 定位未加载块；扫描渐进（前块命中先于全文完成可用——若实现为完成制则测取消后部分结果语义，报告说明取舍）。
- [ ] **Step 2: 跑红** → **Step 3: 实现** → **Step 4: 跑绿**（code 全部 + 全仓）。
- [ ] **Step 5: Commit**

```bash
git commit -m "feat(render-text): code 后台全文扫描搜索——块解码/取消/定位

窗口模式 search：BlockStream 逐块解码扫描到 EOF，令牌取消、gotoMatch
ensure 定位；全量模式现状不动（spec §4.3 搜索）。"
```

### Task 6: e2e 计量 + 验收（计划 3 收尾）

**Files:**
- Modify: `apps/web/e2e/b-io-streaming.spec.ts`（追加 code 计量与搜索用例）
- Test: 本任务即测试

- [ ] **Step 1: 计量用例**：远端 10MB js 文件 code 打开首屏 ≤1MB（head+首块）；滚动续读；tree-sitter ≤2MB 路径全量（2MB 内文件打开即全量 read 断言）；后台搜索大文件命中跳转正确 + 取消不悬挂。
- [ ] **Step 2: 回归**——code 既有 e2e（rg 定位 t-code/t-search 系列）+ 全仓 vitest + svelte-check + `pnpm build`。
- [ ] **Step 3: Commit**

```bash
git commit -m "test(e2e): code 流式计量与搜索端到端锚点"
```

## 验收（计划级）

1. vitest 全绿（新增 ≥15 用例）、svelte-check（apps/web）0E/0W、playwright 默认通道全绿。
2. 结构断言：code 窗口模式不持全量解码文本（textWindow LRU 单测）+ BlockStream 块表有界（B1 关闭）。
3. spec §4.3 全项兑现；计划 1/2 遗留吸收清单逐项关闭或显式转终局 review。
