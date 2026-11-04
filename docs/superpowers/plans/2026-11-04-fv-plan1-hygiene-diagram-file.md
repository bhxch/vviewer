# file-viewer 引入 · 计划 1（批次一卫生批 + 批次二图表拆独立渲染器）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 vviewer 侧扩展名绑定缺口并补台账（批次一）；把 markdown 已支持的图表类型拆出独立文件渲染器，29 型 / 33 扩展名双击即图形预览、可切源码模式（批次二）；顺带完成排除清单中的自有补绑（archive 21 扩展名 + hex `.macho`）。

**Architecture:** 图表文件渲染器落 `packages/vviewer-render-text/src/diagramFile.ts`（**对 spec §5.2 落位的有意偏差**：diagram 包被 render-text 的 markdown 依赖，反向 import code.ts 的 renderCode 会成环；render-text 已依赖 diagram/highlight 两包，renderCode/decodeText/sanitize 全本地——spec 已随本计划补注记）。渲染分发复用 diagram 包导出（`renderDiagramEngine`/`createKrokiUrl`/`resolveDiagramType`）与 markdown 管线的模式注入（`getDiagramOptions().modeOf`），server 路径经装配注入的 `remoteCall`（同源 computeRouter 缝、执行器形态——md 管线侧为描述缝，fetch 在管线内）。装配点 `apps/web/src/lib/viewer.ts` 图表渲染器先于 codeRenderer 安装（generated fallback 补空位机制的前置铁律）。

**Tech Stack:** TypeScript / Svelte 5（装配层不动组件）/ vitest（jsdom，仓库根跑）/ Playwright。

**Spec:** `docs/superpowers/specs/2026-11-04-file-viewer-integration-design.md`（§4 批次一、§5 批次二、§6.3 排除清单自有补绑部分）

## Global Constraints

- 不新增任何 npm 依赖（本计划零 package.json 变更）。
- registry 一扩展名一 owner；专有渲染器先注册、`installFallbackExtensions` 只补空位（装配铁律，`packages/vviewer-core/src/registry/registry.ts`）。
- 扩展名一律小写无点（registry 注册侧归一，`registry.ts:25`）。
- 图表渲染器**不得**抢 `md/markdown/html/htm/svg/jsonl/ndjson`（既有 owner）。
- vitest 在仓库根跑（包目录直跑缺 jsdom）；svelte-check 在 apps/web 下跑；e2e 前必 `pnpm --filter web build:e2e`（裸 build 冲掉 CDN 注入，H11 坑）。
- 每任务原子 commit；commit message Conventional Commits 中文。
- 渲染器样式单一来源 `apps/web/src/app.css`（模块不注入 CSS）。

## Review Focus

1. **大写扩展名/带点写法**：`.DOT`、`.Mermaid` 等输入必须归一命中（registry 查询侧小写化）——Task 3 测试锚。
2. **装配顺序回退**：若 codeRenderer 先装，generated 670 项会把 dot/gv/mermaid/mmd/bpmn 等占走，图表渲染器 install 抛 RegistryError——Task 5 装配顺序测试锚（同序 fresh registry 零冲突）。
3. **kroki-only 类型被 modeOf 判成 local**：无本地引擎时必须回落 kroki 再回落源码，不得空白死等——Task 4 回退链测试锚。
4. **非 UTF-8/超大图表源**：>2MB 直落源码视图；decode 失败不抛未捕获——Task 4 测试锚。
5. **zipx 支持度误绑**：若 libarchive.js 不支持 zipx 而绑定了，打开即错误卡片静默降级——Task 2 先核实再定清单，核实结论写进 commit。

---

### Task 1: 批次一绑定缺口（hex/.hex、av/.mpeg+.weba、code/.tsv）

**Files:**
- Modify: `packages/vviewer-render-binary/src/hex.ts:785`（extensions 数组加 `'hex'`）
- Modify: `packages/vviewer-render-media/src/av.ts:356`（extensions 数组加 `'mpeg'`, `'weba'`）
- Modify: `packages/vviewer-render-text/src/code/index.ts:54`（extensions 数组加 `'tsv'`，注释注明批次三转移 renderer-spreadsheet）
- Test: `packages/vviewer-render-binary/test/*.test.ts`、`packages/vviewer-render-media/test/*.test.ts`、`packages/vviewer-render-text/test/`（各包既有测试文件就近加；无对应文件则新建 `extensions.test.ts`）

**Interfaces:**
- Consumes: 各渲染器导出的 Renderer 对象（`hexRenderer`/`avRenderer`/`codeRenderer`）。
- Produces: 三渲染器 extensions 数组各 +1/ +2/ +1；无签名变化。

- [ ] **Step 1: 写失败测试**（每包一测，锚 registry 归一）：

```ts
// 以 hex 为例（av/code 同构）：fresh registry 安装后 byExtension 命中且大小写归一
import { createRegistry } from '@bhxch/vviewer-core';
const registry = createRegistry();
registry.install(hexRenderer);
expect(registry.byExtension('hex')?.id).toBe('hex');
expect(registry.byExtension('HEX')?.id).toBe('hex');
```

- [ ] **Step 2: 跑测试确认失败**：`pnpm vitest run packages/vviewer-render-binary/test` → FAIL（'hex' 未注册）。
- [ ] **Step 3: 三处 extensions 数组按上文加扩展名**（code 处加行注释：`// tsv：批次三引入 @file-viewer/renderer-spreadsheet 桥接时转移（spec 2026-11-04 §4.1）`）。
- [ ] **Step 4: 跑三个包测试全绿**：`pnpm vitest run packages/vviewer-render-binary packages/vviewer-render-media packages/vviewer-render-text` → PASS（generated 670 项不含 hex/mpeg/weba/tsv，已实测无冲突；如意外报 RegistryError 即停下报告）。
- [ ] **Step 5: Commit**：`fix(web): 批次一绑定缺口——hex 补 .hex、av 补 .mpeg/.weba、code 补 .tsv（spec §4.1）`

### Task 2: archive 补绑 21 扩展名 + hex 补绑 `.macho`（排除清单自有补绑）

**Files:**
- Modify: `packages/vviewer-render-archive/src/archive.ts:120`
- Modify: `packages/vviewer-render-binary/src/hex.ts:785`（加 `'macho'`）
- Test: 同 Task 1 模式，archive 包测试锚全部新扩展名

**Interfaces:**
- Consumes: libarchive.js 引擎（既有依赖，不改版本）。
- Produces: archive extensions 8→29（视 Step 1 核实结果），hex extensions +macho。

- [ ] **Step 1: 核实 libarchive.js 支持面**：读 `node_modules/libarchive.js` 的 README/源码格式清单（rg 'zip|7z|rarc' 模式），对 spec 候选 21 个逐个判定：`gzip,bzip2,tbz,tbz2,txz,tzst,lzma,zst,cab,ar,cpio,xar,lha,lzh,jar,war,ear,apk,cbz,cbr,zipx`。**zipx 单独判定**（libarchive 对 zipx 仅部分算法）；不支持的从清单剔除并在 commit message 记录剔除理由。libarchive.js 对 tar 系（jar/war/ear/apk 本质 zip/tar 容器）的支持以引擎实测为准。
- [ ] **Step 2: 写失败测试**：archive 测试锚全清单（含大小写归一例 `ZIP`）+ hex 锚 `macho`。
- [ ] **Step 3: 跑测试确认失败** → Step 4: 按核实清单改两处 extensions → Step 5: 跑包测试绿 → **Step 6: Commit**：`feat(web): archive 补绑 libarchive.js 已支持扩展名（21→实测 N 个）+ hex 补 .macho（spec §6.3 排除清单自有补绑；zipx 判定=<结论>）`

### Task 3: 图表文件渲染器模块——类型/扩展名映射与注册面

**Files:**
- Create: `packages/vviewer-render-text/src/diagramFile.ts`
- Test: `packages/vviewer-render-text/test/diagramFile.test.ts`

**Interfaces:**
- Consumes: `resolveDiagramType`、`DiagramType`（`@bhxch/vviewer-render-diagram`）；`Renderer` 类型（core）。
- Produces（Task 4/5 依赖）:
  - `export const DIAGRAM_FILE_EXTS: Readonly<Record<string, readonly string[]>>`——29 型 → 扩展名，逐字取 spec §5.1 表；
  - `export function createDiagramFileRenderers(opts: DiagramFileRenderOpts): Renderer[]`——29 个 Renderer，id `diagram-<type>`，label 取 `resolveDiagramType(type)` 的既有 label 字段；
  - `export interface DiagramFileRenderOpts { remoteCall?: (path: string, init?: { method?: string; body?: unknown }) => Promise<unknown>; }`

- [ ] **Step 1: 写失败测试**：
  - 映射表全锚：29 型每一项 `resolveDiagramType(type)` 非空且 `DIAGRAM_FILE_EXTS[type]` 与 spec §5.1 表逐字一致（测试里内联期望表，防实现漂移）；
  - 31 个扩展名去重（无跨型重复）；
  - fresh registry 按映射安装 29 渲染器零 RegistryError；`byExtension('dot')`→`diagram-graphviz`、`byExtension('MERMAID')`→`diagram-mermaid`（大小写归一锚，Review Focus 1）；
  - 与既有 owner 不撞：`byExtension('md'|'markdown'|'html'|'htm'|'svg'|'jsonl')` 不被任何 diagram-* 认领（先装 markdown/html/jsonl 渲染器再装 diagram 系，install 不抛）。
- [ ] **Step 2: 跑测试确认失败** → Step 3: 实现映射表 + `createDiagramFileRenderers`（render 体本任务为最小抛错桩，Task 4 替换；**本任务测试只锚注册面**） → Step 4: 测试绿 → Step 5: Commit：`feat(web): 图表文件渲染器注册面——29 型/33 扩展名映射（spec §5.1）`

### Task 4: 图表文件渲染器渲染路径——三分发 + 失败回退 + 大小门 + 切换

**Files:**
- Modify: `packages/vviewer-render-text/src/diagramFile.ts`（render 体实装）
- Test: `packages/vviewer-render-text/test/diagramFile.test.ts`（追加）

**Interfaces:**
- Consumes: `renderDiagramEngine(engine, source, { mermaidTheme?, renderer? })`、`createKrokiUrl(host, krokiType, source)`、`DEFAULT_KROKI_HOST`（diagram 包）；`getDiagramOptions()`（`@bhxch/vviewer-markdown` markdownRenderer.ts:199，含 `modeOf(lang)/krokiVia/serverDiagramOf/mermaidTheme/krokiHost`——字段以该文件 DiagramRenderOptions 实态为准）；server/kroki-server 响应的图表 SVG 净化函数（`@bhxch/vviewer-sanitize` 导出，与 `packages/vviewer-markdown/src/pipeline.ts:221` 附近 server 分支同款 import）；`renderCode`/`renderDegradedCode`/`decodeText`（本包 `./code`、`./decodeText`）；streaming renderer 契约（`streaming: false`，全量 buffer 在手）。
- Produces: 可渲染的 29 个 Renderer（Task 5 装配消费）。

- [ ] **Step 1: 写失败测试**（jsdom，mock 引擎层）：
  - **local 成功**：`vi.mock('@bhxch/vviewer-render-diagram')` 使 `renderDiagramEngine` 返回 `<svg id="t"/>`，render `.dot` 文件 → target 内出现该 svg（经净化路径注入）；
  - **kroki 客户端**：mode kroki 时 `createKrokiUrl` 被以 `(host, 'plantuml', source)` 调用且 target 出现 `<img>`（mock createKrokiUrl）；
  - **server**：注入 `remoteCall` 返回 `{svg:'<svg/>'}`（以 pipeline.ts server 分支实态响应形状为准）→ target 出现净化后 svg；无 remoteCall 时 server 模式跳过走 local/kroki 回落；
  - **回退链**（Review Focus 3）：`modeOf` 强制返回 'local' 且类型无本地引擎（plantuml）→ 依次尝试 kroki；kroki 失败（createKrokiUrl reject）→ target 落 `renderCode` 源码视图（断言 pre/源码文本出现）+ 状态提示元素（showStatusNotice 同通道的调用被触发，mock 断言）；
  - **引擎抛错**：renderDiagramEngine reject → 源码视图回退；
  - **大小门**（Review Focus 4）：`>2MB` buffer → 不调引擎，直落源码视图 + 降级提示卡（renderDegradedCode 路径）；
  - **切换**：渲染态点击切换钮 → 源码视图出现且**不重读文件**（buffer 引用断言：引擎调用次数不增）；再点回渲染态。
- [ ] **Step 2: 跑测试确认失败** → Step 3: 实装 render 体。要点：文本 `decodeText(buffer)`；`size>2MB` 门先行；mode = `getDiagramOptions()?.modeOf(type) ?? resolveDiagramType(type)?.defaultMode ?? 'source'`；降级链 local→kroki→source 与 md 管线一致（local 且无本地引擎→kroki）；源码视图 `renderCode(buffer, el, { highlight: true, ext: det.ext })`（同 html.ts 源码视图形态）；切换 UI 移植 `packages/vviewer-render-text/src/html.ts:80` 起的双视图机制（同包先例，读后同构移植，不引新依赖）。
- [ ] **Step 4: 测试绿** → Step 5: 全包回归 `pnpm vitest run packages/vviewer-render-text` → PASS → Step 6: Commit：`feat(web): 图表文件渲染器渲染路径——local/kroki/server 三分发+失败回退源码+2MB 门+视图切换（spec §5.2）`

### Task 5: 装配接线——viewer.ts 安装顺序 + remoteCall 注入

**Files:**
- Modify: `apps/web/src/lib/viewer.ts:48`（codeRenderer 之前插入 `registry.install(...createDiagramFileRenderers({ remoteCall }))` 展开——29 个 install 按映射序）
- Test: 既有装配测试文件（rg `viewer.ts` 对应 `apps/web/src/lib/*.test.ts`；无则 `packages/vviewer-render-text/test/diagramFile.test.ts` 追加装配序锚）

**Interfaces:**
- Consumes: Task 3/4 的 `createDiagramFileRenderers`；web 层既有 server 通道封装（rg `remoteCall` 在 apps/web/src 的现名——md 管线 PipelineCtx.diagram.remoteCall 的装配点，复用同一实现传入）。
- Produces: registry 装配终态。

- [ ] **Step 1: 写失败测试**：装配序锚——fresh registry 按 viewer.ts 实际语句序 install（diagram 29 → code → markdown → html → …），断言 `byExtension('dot').id === 'diagram-graphviz'` 且 `byExtension('tsv').id === 'code'`（Review Focus 2 锁死：顺序颠倒即 generated 占位反转）。
- [ ] **Step 2: 确认失败** → Step 3: 改 viewer.ts（diagram install 块置于 `codeRenderer` 之前；remoteCall 从 web 层既有 server 封装取，同 md 管线注入点） → Step 4: 测试绿 + `pnpm --filter web typecheck` 0E → Step 5: Commit：`feat(web): 图表文件渲染器装配——先于 code 安装（generated 补空位铁律）+server remoteCall 注入`

### Task 6: e2e 锚 + NOTICES 三行 + 收口门禁

**Files:**
- Create: `apps/web/e2e/b-diagram-file.spec.ts`
- Create: `apps/web/e2e/fixtures/diagram-file/`（小体量文本夹具：`sample.dot`、`flow.mermaid`、`proc.puml`、`big.dot`（>2MB 生成），均文本可入库）
- Modify: `THIRD_PARTY_NOTICES.md`（补三行：@viz-js/viz MIT / nomnoml MIT / pako MIT AND Zlib，用途与里程碑按 §4.2 表）
- Test: e2e（desktop only）

**Interfaces:**
- Consumes: Task 5 装配终态；既有 e2e helper（openFlow 装置、`build:e2e` 产物伺服）。
- Produces: DIA-FILE 域 5 锚；台账补齐。

- [ ] **Step 1: e2e 五锚**：
  - DIA-FILE-01 `.dot` 打开 → 图形渲染（svg 存在、无源码 pre）——抢注锚；
  - DIA-FILE-02 切换钮 → 源码视图（pre 含 dot 源文本）→ 切回渲染；
  - DIA-FILE-03 `.mermaid` 打开 → mermaid 本地引擎渲染；
  - DIA-FILE-04 `.puml` + `page.route` mock krokiHost 请求 → kroki 路径渲染（或断言 img src 指向 mock）；route.abort 变体 → 源码视图 + 提示（回退锚）；
  - DIA-FILE-05 `big.dot`（>2MB）→ 直接源码视图 + 降级提示。
- [ ] **Step 2: `pnpm --filter web build:e2e` 后跑 e2e**（铁律）→ 全绿。
- [ ] **Step 3: NOTICES 三行 + Commit**：`test(e2e): DIA-FILE 域五锚+docs: 台账补齐 viz/nomnoml/pako（spec §4.2/§5.3）`
- [ ] **Step 4: 收口门禁**：`pnpm vitest run`（仓库根）exit0；`pnpm --filter web typecheck` 0E；`pnpm --filter web test:e2e -- b-diagram-file` 绿；`git status --porcelain` 净空。
