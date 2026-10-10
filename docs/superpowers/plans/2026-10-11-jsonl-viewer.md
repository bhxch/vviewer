# JSON Lines 行卡片流式渲染器 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `.jsonl`/`.ndjson` 专用渲染器——每行一卡片（pretty + 折叠封顶）、可变高度窗口化滚动、惰性解析 + tree-sitter json 卡片级高亮、>200MB 退 code 纯文本。

**Architecture:** `packages/render-text/src/jsonl/` 三模块——`parse.ts`（行状态机/pretty/折叠，纯函数）、`window.ts`（测量缓存型可变高度窗口数学，纯函数 + DOM 适配）、`index.ts`（renderJsonl 组装：worker 高亮、getMeta、降级委托）。registry 装配插在 fallback 生成物之前（jsonl/ndjson 专有优先）。

**Tech Stack:** TypeScript（render-text 新子路径 `./jsonl`）、vitest（jsdom，fake HighlightClient 注入先例）、Playwright e2e。

**Spec:** `docs/superpowers/specs/2026-10-11-jsonl-viewer-design.md`

## Global Constraints

- **IO 裁决（对 spec §2.2 的已记录偏差）**：渲染器接口为 `render(buffer)` 全量字节（ViewerPane 全量 read；hex/remote 现状同样，`opts.range` 实现缺失）——本计划 IO 层全量读，**流式落在解析/渲染层**（首屏只解析可视行块、LRU 缓存、滚动续解析）；IO 级流式（File.slice/Range）需 Renderer 接口演进，独立后续项。因此总行数**已知**（全量切分），meta 直接显示总行数（spec 的「已加载 N 行」作废）。
- **高亮裁决（对 spec §2.1/2.3 的细化）**：每张卡片文本（单原始行的 pretty）独立完整、无跨行上下文 → 逐卡片调用全局 `getHighlightClient().highlight(text, 'json')`，**不走 code.ts 的 chunk 协议/泵**（不重构 code.ts）；「≤2MB 整文件 tree-sitter」等价实现为逐卡片 ts 高亮；卡片惰性解析使 >2MB 自动 lazy；`HighlightCanceledError`（tab 切换 cancelAll）→ 丢弃在途、不写缓存、不自动续队。>200MB 委托 `renderCode(buffer, target, { highlight: false, oversizeNotice: true })`（spec §2.3 plain 降级）。
- 装配铁律：`registry.install(jsonlRenderer)` 必须在 `installFallbackExtensions` **之前**（viewer.ts 现位于 archiveRenderer 之后、installFallbackExtensions 之前），jsonl/ndjson 专有优先、生成物跳过（registry.ts 注释已预留此契约）。
- 折叠：pretty 后 >40 行默认折叠（首 40 行 +「展开全部」）；展开封顶 400 行，超出卡片内滚动（高度有界是窗口化前提）。单原始行 >1MB 不解析：原始文本前 64KB + 「行过大（>1MB）」徽标。
- 空行跳过；UTF-8 BOM 剥离；解析失败行 = 原始文本 + 错误徽标（tooltip 原因），不影响他行。
- DOM 类名约定：容器 `.vv-jsonl`（滚动宿主）、卡片 `.vv-jsonl-card`（`data-line` 原始行号 1 起）、错误态 `.vv-jsonl-card-failed`、折叠按钮 `.vv-jsonl-expand`。e2e 与测试同锚。
- 中文注释讲 why；TDD；每任务独立 commit（Angular 中文 message）。
- 门禁：`pnpm test`、`pnpm typecheck`；svelte-check 基线 12E/2W 不新增（本计划不动 .svelte）；e2e 仿 t-pwa.spec.ts 的 paint-probe 口径。

---

### Task 1: parse.ts 行状态机与折叠（纯函数）

**Files:**
- Create: `packages/render-text/src/jsonl/parse.ts`
- Create: `packages/render-text/test/jsonl-parse.test.ts`

**Interfaces:**
- Produces:
  - `const JSONL_OVERSIZE_LINE_BYTES = 1_048_576; const JSONL_OVERSIZE_PREVIEW_BYTES = 65_536; const JSONL_COLLAPSE_LINES = 40; const JSONL_EXPAND_CAP_LINES = 400;`
  - `type JsonlLineState = { kind: 'ok'; pretty: string; prettyLines: number } | { kind: 'failed'; raw: string; reason: string } | { kind: 'oversize'; raw: string };`
  - `function splitJsonlLines(text: string): string[]`——剥单个 UTF-8 BOM（解码侧若已剥则空串无害）、按 `\n` 切分（调用方保证已 CRLF 归一）、**丢弃空行与纯空白行**（JSONL 惯例容忍尾空行）。
  - `function parseJsonlLine(raw: string): JsonlLineState`——字节长（`new TextEncoder().encode(raw).length`，行级成本可接受）>1MB → oversize（raw 截前 64KB）；`JSON.parse` 成功 → `JSON.stringify(v, null, 2)` pretty + 行数；失败 → failed（reason 取 err.message 去换行、截 120 字符）。
  - `function collapseFor(prettyLines: number): { collapsed: boolean; visibleLines: number; capped: boolean }`——≤40 全显；>40 collapsed、visible=40；展开请求时 visible=min(prettyLines, 400)、capped=prettyLines>400（UI 据此显示卡片内滚动提示）。

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from 'vitest';
import {
  splitJsonlLines, parseJsonlLine, collapseFor,
  JSONL_COLLAPSE_LINES, JSONL_EXPAND_CAP_LINES,
} from '../src/jsonl/parse';

describe('splitJsonlLines', () => {
  it('strips BOM, drops blank lines, keeps content lines', () => {
    expect(splitJsonlLines('\uFEFF{"a":1}\n\n{"b":2}\n  \n')).toEqual(['{"a":1}', '{"b":2}']);
    expect(splitJsonlLines('')).toEqual([]);
  });
});

describe('parseJsonlLine', () => {
  it('ok: pretty-prints preserving key order', () => {
    const s = parseJsonlLine('{"b":1,"a":[1,2]}');
    expect(s).toMatchObject({ kind: 'ok' });
    if (s.kind === 'ok') {
      expect(s.pretty).toBe('{\n  "b": 1,\n  "a": [\n    1,\n    2\n  ]\n}');
      expect(s.prettyLines).toBe(8);
    }
  });
  it('failed: keeps raw and short reason', () => {
    const s = parseJsonlLine('{oops');
    expect(s.kind).toBe('failed');
    if (s.kind === 'failed') { expect(s.raw).toBe('{oops'); expect(s.reason.length).toBeLessThanOrEqual(120); }
  });
  it('oversize: >1MB raw truncated to 64KB with oversize kind', () => {
    const big = 'x'.repeat(1_048_577);
    const s = parseJsonlLine(big);
    expect(s.kind).toBe('oversize');
    if (s.kind === 'oversize') expect(s.raw.length).toBe(65_536);
  });
  it('oversize threshold equals 1MB exactly', () => {
    expect(parseJsonlLine('x'.repeat(1_048_576)).kind).toBe('oversize');
    expect(parseJsonlLine('x'.repeat(1_048_575)).kind).toBe('failed'); // 1MB-1 的 x 非 JSON
  });
});

describe('collapseFor', () => {
  it('short lines fully visible', () => {
    expect(collapseFor(8)).toEqual({ collapsed: false, visibleLines: 8, capped: false });
  });
  it('long lines collapse to 40 and cap expansion at 400', () => {
    expect(collapseFor(JSONL_COLLAPSE_LINES + 1))
      .toEqual({ collapsed: true, visibleLines: JSONL_COLLAPSE_LINES, capped: false });
    expect(collapseFor(JSONL_EXPAND_CAP_LINES + 50))
      .toEqual({ collapsed: true, visibleLines: JSONL_EXPAND_CAP_LINES, capped: true });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/render-text/test/jsonl-parse.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 parse.ts**（纯函数、中文注释讲 why；`JSON.parse` 包 try/catch；`TextEncoder` 模块级单例）

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/render-text/test/jsonl-parse.test.ts`
Expected: 全 PASS

- [ ] **Step 5: Commit**

```bash
git add packages/render-text/src/jsonl/parse.ts packages/render-text/test/jsonl-parse.test.ts
git commit -m "feat(render-text): jsonl 行状态机与折叠纯函数

why: D 项渲染器的解析核心需可独立单测（spec D §2.1/2.3）。
what: splitJsonlLines（BOM/空行）/parseJsonlLine（ok/failed/oversize
三态+pretty）/collapseFor（40 折叠/400 封顶）。"
```

---

### Task 2: window.ts 可变高度窗口数学（纯函数 + jsdom 适配）

**Files:**
- Create: `packages/render-text/src/jsonl/window.ts`
- Create: `packages/render-text/test/jsonl-window.test.ts`

**Interfaces:**
- Produces:
  - `const JSONL_ESTIMATED_CARD_HEIGHT = 120;`（未测卡片估算高，px；折叠态典型值）
  - `class HeightModel`：`constructor(estimate = JSONL_ESTIMATED_CARD_HEIGHT)`；`total(rows: number): number`（实测+未测估算外推）；`measure(row: number, height: number): void`（首测或偏差 >1px 才更新并置 dirty）；`offsetOf(row: number): number`（前缀和，未测段按 estimate）；`rowAt(y: number, rows: number): number`（y→行，末段二分/线性扫描皆可，行数大时用前缀和二分）；`dirty: boolean`（消费后清 false）。
  - `function visibleRange(model: HeightModel, scrollTop: number, viewportH: number, rows: number, overscan = 5): { first: number; last: number }`。
  - DOM 适配（index.ts 内，本任务只测数学）：渲染后 `measure(row, cardEl.offsetHeight)` → dirty → 容器重设总高并修正 translateY。

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from 'vitest';
import { HeightModel, visibleRange, JSONL_ESTIMATED_CARD_HEIGHT } from '../src/jsonl/window';

describe('HeightModel', () => {
  it('estimates unknown rows and corrects after measure', () => {
    const m = new HeightModel();
    expect(m.total(10)).toBe(10 * JSONL_ESTIMATED_CARD_HEIGHT);
    m.measure(2, 300);
    expect(m.total(10)).toBe(9 * JSONL_ESTIMATED_CARD_HEIGHT + 300);
    expect(m.offsetOf(3)).toBe(2 * JSONL_ESTIMATED_CARD_HEIGHT + 300);
    expect(m.dirty).toBe(true);
  });
  it('rowAt maps y through measured and estimated segments', () => {
    const m = new HeightModel();
    for (let r = 0; r < 5; r++) m.measure(r, 100); // 前 5 行实测 100px
    expect(m.rowAt(0, 20)).toBe(0);
    expect(m.rowAt(450, 20)).toBe(4);   // 400..500 属第 5 行（0 起）
    expect(m.rowAt(5 * 100 + 10, 20)).toBe(5); // 进入估算段
  });
  it('visibleRange pads with overscan and clamps', () => {
    const m = new HeightModel();
    for (let r = 0; r < 50; r++) m.measure(r, 100);
    expect(visibleRange(m, 0, 250, 50, 5)).toEqual({ first: 0, last: 7 });
    expect(visibleRange(m, 10_000, 250, 50, 5)).toEqual({ first: 44, last: 49 });
  });
});
```

（`last` 为含端 index；`visibleRange` 语义：first=max(0, rowAt(scrollTop)-overscan)、last=min(rows-1, rowAt(scrollTop+viewportH)+overscan)。以实现注释固定该契约，测试与之自洽。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/render-text/test/jsonl-window.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 window.ts**（前缀和懒重建：measured 变更置 dirty，`offsetOf/total/rowAt` 前重建前缀和数组——行数大时 O(n) 重建仅发生在 dirty 后首次查询，滚动稳态 O(log n) 二分；中文注释讲清估算修正策略与「大幅跳跃滚动一次高度跳动」的已知限制）

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/render-text/test/jsonl-window.test.ts`
Expected: 全 PASS

- [ ] **Step 5: Commit**

```bash
git add packages/render-text/src/jsonl/window.ts packages/render-text/test/jsonl-window.test.ts
git commit -m "feat(render-text): jsonl 可变高度窗口数学（测量缓存型）

why: 卡片高度不一，core virtualScroller 固定行高 API 不适用（spec D §2.3）。
what: HeightModel（前缀和懒重建/首测修正/估算外推）+ visibleRange。"
```

---

### Task 3: renderJsonl 组装（卡片 DOM + 高亮 + getMeta + 降级委托）

**Files:**
- Create: `packages/render-text/src/jsonl/index.ts`
- Create: `packages/render-text/test/jsonl-render.test.ts`
- Modify: `packages/render-text/package.json`（exports 加 `"./jsonl": "./src/jsonl/index.ts"`）

**Interfaces:**
- Consumes: Task 1/2 纯函数；`getHighlightClient()`（code.ts 已导出单例，App 启动接线）、`HighlightCanceledError`（@vviewer/highlight 或 code.ts re-export，以实际导出位置为准）、`renderCode`（>200MB 委托）、`detectLanguage`（'jsonl'→'json'）。
- Produces:
  - `export const jsonlRenderer: Renderer`——`{ id: 'jsonl', label: 'JSON Lines', extensions: ['jsonl', 'ndjson'], render }`；render(buffer, target, source, det)：
    - `size > PLAIN_MAX_BYTES`（200MB，从 code.ts import 常量或本地同值常量并注释同源）→ `return renderCode(buffer, target, { highlight: false, oversizeNotice: true })`（沿用其提示条与实例扩展）。
    - 否则：`target.classList.add('vv-jsonl')`；CRLF→LF 归一 + UTF-8 解码（`new TextDecoder(det.encoding ?? 'utf-8')`——与 code.ts L537 同款；失败容错 fallback utf-8）；`splitJsonlLines` → 行原 文本数组；`HeightModel` + 自建窗口循环（滚动 → visibleRange → 仅渲染窗口内卡片：解析（惰性 + `Map<number, JsonlLineState>` 解析缓存，**不设上限**——解析结果字符串体积与全量文本同阶，行数已知可全持；pretty 文本另存）→ 高亮（卡片级 `getHighlightClient().highlight(pretty, 'json')`，在途 Promise Set，destroy 时对未完成者 swallow `HighlightCanceledError`；结果 intervals → 复用 code.ts 导出的 `renderLineHtml`/`splitHighlightedLines` 转 HTML，**导出名以 code.ts 实际为准**，若无合用导出则在本模块内实现 intervals→span 的最小转换并注释缘由）→ `measure(row, el.offsetHeight)` → dirty 时容器总高/位移修正。
    - 卡片 DOM：`div.vv-jsonl-card[data-line]` = `span.vv-jsonl-gutter`（1 起行号）+ `pre.vv-jsonl-body`（pretty 文本或原始文本；failed 加 `.vv-jsonl-card-failed` + `title=reason` + `span.vv-jsonl-badge`「解析失败」；oversize 加徽标「行过大（>1MB）」；capped 时尾部 `.vv-jsonl-cap` 提示「已截断显示（N 行）」+ 卡片内 max-height 滚动）+ 折叠按钮 `.vv-jsonl-expand`（collapsed 时「展开全部」，点击后全量重渲染该卡片——简单化：点击直接置 visibleLines=prettyLines 重渲染，不做渐进）。
    - 状态条：`div.vv-jsonl-status`（pre 兄弟节点，仿 code.ts 提示条防清空）：「共 N 行 · M 行解析失败」（M>0 时红色徽标）；失败>0 时 `aria-live="polite"`。
    - 返回实例：`{ destroy()（解绑滚动/取消在途）, getMeta: () => ({ encoding: det.encoding, lang: 'json', size: buffer.length, lines: totalRows }) }`（CodeFileMeta 同形状，lines=总行数已知——ViewerPane 鸭子探测自动消费）。
  - exports 注册：`"./jsonl": "./src/jsonl/index.ts"`。

- [ ] **Step 1: 写失败测试**（fake HighlightClient 手法仿 code.test.ts L313-315 与 render-binary client.test.ts；`vi.stubGlobal('ResizeObserver', ...)`）

```ts
// jsonl-render.test.ts 关键用例（完整版由实现者按此语义铺开）：
// 1) ok/failed/oversize 混合文件：卡片数=非空行数、failed 卡带 badge+title、
//    oversize 卡 64KB 截断 + 徽标、状态条「共 3 行 · 1 行解析失败」。
// 2) 高亮：fake client.highlight 记录 (text, lang) 调用；断言首屏只高亮可视卡片
//    （两屏数据 + 小 viewport，调用量 = 可视卡片数而非全量）；lang 恒 'json'。
// 3) 取消：highlight reject HighlightCanceledError → 不写 DOM 高亮、不抛未处理 rejection。
// 4) 折叠：prettyLines>40 卡片初始 40 行可见 + .vv-jsonl-expand 存在；点击后
//    prettyLines≤400 全显、>400 出现 .vv-jsonl-cap 且卡片内滚动（style 断言）。
// 5) getMeta：lines=总行数（含 failed/oversize——它们也是行）、size=buffer.length。
// 6) 降级：>200MB 阈值用 vi.mock 常量不可行（PLIAN 常量 import 自 code）——改为
//    断言 renderJsonl 对 size>PLAIN_MAX_BYTES 走委托：以 jest.spyOn 不可行（ESM），
//    落点=把阈值判断抽为可注入 opts（render 内部读 import 的常量，测试经
//    构造 200MB+ buffer 不现实）→ 用例改在 index.ts 导出内部 helper
//    shouldDelegateToCode(size) 并直接单测（true@200MB+1 / false@200MB）。
```

（用例 6 的处理是计划裁决：**不做真 200MB buffer 测试**，导出 `shouldDelegateToCode(size: number): boolean` 纯函数单测 + e2e 兜底不覆盖降级。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/render-text/test/jsonl-render.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 index.ts + exports**（要点见 Interfaces；DOM 构造用 `document.createElement` 命令式，风格对齐 code.ts/hex.ts；滚动监听 passive；`requestAnimationFrame` 合并 measure 修正；模块头中文注释写明 IO 全量/解析流式裁决与卡片级高亮裁决）

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run: `pnpm vitest run packages/render-text/test/ && pnpm test && pnpm typecheck`
Expected: jsonl 三套测试全 PASS；既有 render-text/core 测试零回归

- [ ] **Step 5: Commit**

```bash
git add packages/render-text/src/jsonl/index.ts packages/render-text/test/jsonl-render.test.ts packages/render-text/package.json
git commit -m "feat(render-text): JSON Lines 行卡片渲染器

why: .jsonl/.ndjson 此前仅纯文本视图（spec D 主目标）。
what: renderJsonl 组装——惰性解析+卡片级 tree-sitter json 高亮+
可变高度窗口+折叠封顶+失败行徽标+getMeta+>200MB 委托 code。"
```

---

### Task 4: 装配 + e2e（OPEN-04 改造/往返/性能锚点）

**Files:**
- Modify: `apps/web/src/lib/viewer.ts`（install jsonlRenderer：archiveRenderer 之后、installFallbackExtensions 之前；import 自 `@vviewer/render-text/jsonl`）
- Modify: `apps/web/e2e/t-open-with.spec.ts`（OPEN-04 改断言 + 新增往返与性能用例）
- Create: 无新文件（性能用例并入 t-open-with.spec.ts）

**Interfaces:**
- Consumes: Task 3 jsonlRenderer；C 项 openWithOf（jsonlRenderer 注册后自动进 .jsonl 候选）。
- Produces: 装配与 e2e 锚点。

- [ ] **Step 1: 装配 + OPEN-04 改造**（先改 viewer.ts 与 OPEN-04 断言：`.vv-code-pre` → `.vv-jsonl` + `.vv-jsonl-card` 含 `"first"`；注入通道沿用 dropFile。）

- [ ] **Step 2: 新增 e2e 用例**（同文件）：

```ts
test('OPEN-05：解析失败行徽标与折叠', async ({ page }) => {
  const lines = [
    JSON.stringify({ id: 1, nested: { deep: [1, 2, 3] } }),
    '{broken',
    JSON.stringify({ id: 3 }),
  ].join('\n');
  await dropFile(page, { name: 'mixed.jsonl', type: 'application/jsonl', content: lines });
  await expect(page.locator('.vv-jsonl-card-failed')).toHaveCount(1);
  await expect(page.locator('.vv-jsonl-status')).toContainText('1 行解析失败');
});

test('OPEN-06：打开方式往返 jsonl↔code（override）', async ({ page }) => {
  await dropFile(page, { name: 'r.jsonl', type: 'application/jsonl', content: '{"a":1}\n' });
  await expect(page.locator('.vv-jsonl-card')).toHaveCount(1);
  // 切 code（候选含 code，经 C 项 openWithOf 自动出现）
  await page.locator('.meta-openwith').selectOption('code');
  await expect(page.locator('.vv-code-pre')).toBeVisible();
  // 切回 jsonl
  await page.locator('.meta-openwith').selectOption('jsonl');
  await expect(page.locator('.vv-jsonl-card')).toBeVisible();
});

test('OPEN-07：1MB/约 5000 行首屏性能锚点（BUG-16 口径）', async ({ page }) => {
  // 合成约 1MB jsonl（~5000 行 × ~200B）；installPaintProbe 仿 t-pwa.spec.ts L137-155
  // 探针选择器 '.vv-jsonl-card'；桌面 <200ms 断言（spec §3 锚点），移动放宽按
  // t-pwa 双倍惯例（<400ms）；9 轮取中位。
});
```

（OPEN-07 若在本文件外的性能预算体系更合适，可放 t-pwa.spec.ts 并在报告说明；二选一，不双写。）

- [ ] **Step 3: 跑 e2e + 全量门禁**

Run: 重建 build 后 `pnpm playwright test e2e/t-open-with.spec.ts`（双 project）+ `pnpm test && pnpm typecheck`
Expected: 全绿（OPEN-04/05/06/07 通过；既有 OPEN-01..03 不回归）

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/lib/viewer.ts apps/web/e2e/t-open-with.spec.ts
git commit -m "feat(web,e2e): jsonl 渲染器装配与端到端锚点

why: 渲染器需接入装配（fallback 生成物之前）并以 e2e 固化行为与性能。
what: viewer.ts install jsonlRenderer + OPEN-04 改断言 + 失败徽标/
打开方式往返/1MB 首屏 <200ms 性能锚点用例。"
```

---

### Task 5: 收尾——注册表锚点核对 + 文档 + 全量门禁

**Files:**
- Modify: `README.md`（若含格式支持清单则补 JSON Lines；无则跳过并报告）
- 验证性核对（不改码）：`packages/core/test/registry.test.ts` 的 jsonl→'code' 断言为**模拟场景**（自装 mock registry），D 项后真实装配 jsonl 归 jsonlRenderer——核对无需改码，若断言真实装配则更新。

- [ ] **Step 1: 核对与文档**（registry.test.ts 语义核对；README 格式清单按实际情况补一行「JSON Lines（.jsonl/.ndjson）行卡片视图」）
- [ ] **Step 2: 全量门禁**：`pnpm test && pnpm typecheck && pnpm playwright test apps/web/e2e/t-open-with.spec.ts apps/web/e2e/b-app-shell-sources.spec.ts`（或仓库实际命令形态）+ `node tools/grammar-builder/gen-code-extensions.mjs --check`（生成物未变确认）
- [ ] **Step 3: Commit**

```bash
git add README.md packages/core/test/registry.test.ts
git commit -m "docs(web): 格式清单补 JSON Lines 与注册表锚点核对

why: D 项收尾——用户可见格式清单与装配语义一致性确认。
what: README 格式行 + registry 测试语义核对（模拟场景断言保持）。"
```

---

## Self-Review 结论

- **Spec 覆盖**：§2.1 注册/管线→T3/T4（高亮逐卡片裁决已声明）；§2.2 解析层流式→T1/T3（IO 流式偏差已声明）；§2.3 卡片/窗口/降级→T2/T3；§3 测试→各任务+T4 e2e；§5 验收→T4/T5。无未记录缺口。
- **占位扫描**：`renderLineHtml`/`splitHighlightedLines` 导出名、HighlightClient 取消语义、playwright 命令形态等以「以实际为准」处均给了语义锚点与先例路径（code.test.ts/client.test.ts/t-pwa.spec.ts），无悬空引用；用例 6 的阈值测试落点已裁决（shouldDelegateToCode 纯函数）。
- **类型一致性**：JsonlLineState/HeightModel/visibleRange/jsonlRenderer/shouldDelegateToCode 前后一致；DOM 类名约束表已固定（.vv-jsonl/.vv-jsonl-card/-failed/.vv-jsonl-expand/.vv-jsonl-status/.vv-jsonl-gutter/-body/-badge/-cap）。
- **计划对 spec 的两项已声明偏差**：IO 层流式→解析层流式（Renderer 接口现状所限，独立后续）；「已加载 N 行」→总行数直显。另两项细化：逐卡片高亮（≤2MB 整文件 ts 的等价实现）、降级测试落点（shouldDelegateToCode）。
