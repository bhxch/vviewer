# 递延清偿批 阶段四（web 卫生 6 项）+ 阶段五（附录+待核 8 项）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 清偿 spec §3 阶段四 6 项（pako 动态导入/graphre 入组/kroki 失败态/三小件）与阶段五 8 项（lightbox 四件+待核三件核实处置+spec 勘误），两阶段各设独立门禁步。

**Architecture:** 阶段四五皆为小件：两处构建/导入形态调整、lightbox 四件集中在 lightbox.ts 单文件、待核项按侦察结论走「销账或最小补强」。侦察期关键事实已内嵌各任务（行号为侦察时点，盘上漂移以现状为准）。

**Tech Stack:** TypeScript（packages/render-text、apps/web）+ vite/rolldown 构建面 + vitest/playwright。

**Spec:** docs/superpowers/specs/2026-10-21-deferred-cleanup-design.md（§3 阶段四/五、§4 裁决、§6 门禁）

## Global Constraints

- main 直行；每任务原子 commit；Angular 规范中文提交信息。
- 重建一律 `pnpm --filter web build:e2e`（防 CDN 注入冲掉的既有纪律）；预算门 `node tools/diagram-budget.mjs` 在 4-1/4-2 后必跑。
- vitest 跑法=仓库根（包目录缺 jsdom）；不 dispatch 任何子代理。
- SDD 台账：`.superpowers/sdd/2026-10-23-deferred-cleanup-stage4-5/progress.md`（两阶段分节记）；收口抄送 digest 两行（阶段四/阶段五各一行头部标注）。

---

## 阶段四

### Task 1: pako 动态导入（4-1）

**定位**：diagrams.ts:4 静态 `import pako from 'pako'`，唯一消费 `createKrokiUrl`（:57-63，`pako.deflate(...,{level:9})`+btoa）；生产调用链 pipeline.ts:12 顶层静态 import → :295 kroki 分支（`renderDiagramBlock` 为 async 可 await）；测试 diagrams.test.ts:4,32-44 同步调用需改 await；diagrams.ts 其余导出被 apps/web 五处静态 import（viewer.ts:10/markdownFence.ts:4/settingsDraft.ts:11/stores/settings.ts:2/DiagramsSection.svelte:7）——动态化仅 `createKrokiUrl` 右移，类型面用既有 @types/pako 不受影响。

**Files:**
- Modify: `packages/render-text/src/markdown/diagrams.ts`（删顶层 import，createKrokiUrl 内动态 import）
- Modify: `packages/render-text/src/markdown/pipeline.ts`（kroki 分支 await）
- Test: `packages/render-text/src/markdown/diagrams.test.ts`（改 await）

**Interfaces:**
- Produces: `createKrokiUrl(...): Promise<string>`（签名加 Promise——调用点仅 pipeline.ts:295 与测试）。

- [ ] **Step 1: 改测试为 await 形态**（:32-44 断言主体不变）
- [ ] **Step 2: 红灯**——`pnpm vitest run packages/render-text/src/markdown/diagrams.test.ts`（测试先 await 化而实现未改 → 编译/断言红）
- [ ] **Step 3: 实现**——diagrams.ts 删 ：4 顶层导入；createKrokiUrl 内：

```typescript
const { default: pako } = await import('pako');
```

pipeline.ts:295 调用点 await。diagrams.ts 文档注补：「4-1：pako 主包静态导入退役——kroki 编码惰性化，非 kroki 文档不再进主图。」
- [ ] **Step 4: 门禁**——`pnpm vitest run packages/render-text/ && pnpm typecheck && pnpm --filter web build:e2e && node tools/diagram-budget.mjs`（预算应持平或降——pako 出主图）。
- [ ] **Step 5: Commit**——`perf(md): pako 主包导入惰性化——kroki 编码右移动态 chunk（台账 4-1）`

### Task 2: graphre 入 diagram-engines chunk 组（4-2）

**定位**：graphre@0.1.3 为 nomnoml 依赖（nomnoml dist UMD require）；vite.config.ts:203-206 组正则 `(@viz-js[\/]viz|nomnoml)` 不含 graphre → 落默认共享 chunk。

**Files:**
- Modify: `apps/web/vite.config.ts:205`

- [ ] **Step 1: 正则补 `|graphre`**（注释同步：graphre 随 nomnoml 归堆）
- [ ] **Step 2: 门禁+验证**——`pnpm --filter web build:e2e` 后核产物：`rg -l 'graphre' apps/web/build/_app/immutable/chunks/` 应仅命中 diagram-engines-*.js（graphre 代码入组）；`node tools/diagram-budget.mjs` 门过。
- [ ] **Step 3: Commit**——`build(web): graphre 并入 diagram-engines chunk 组（台账 4-2）`

### Task 3: kroki 失败态核实处置（4-3）

**定位（侦察）**：pipeline.ts:292-306 kroki 分支**已有** error 监听：加 diagramError 类、写文案 `kroki 渲染失败（${type.id}）`、隐藏 view 展开源码、toggle 改「图」——deferred 原文「只露源码无失败文案」与现状不符；无重试/超时为设计内形态。

- [ ] **Step 1: 核实处置**——`git log -S 'kroki 渲染失败' -- packages/render-text/src/markdown/pipeline.ts` 定位文案引入时点：若早于或同批于 Plan 1 终审（即 deferred 记录后已被修复），**销账**（digest 标「✅ 已解决（失败文案+类+源码面板切换在案 pipeline.ts:298-304）——阶段五核实销账」）；若确有缺口（如失败态无 aria/文案不显），补最小件并报告。
- [ ] **Step 2: 台账记录裁决 + （如销账）随 Task A4 commit 走 digest**

### Task 4: 三小件——manifestJson 字段过滤 / 分号 nit 核实销账 / README :index（4-4、4-5、4-6）

**定位**：mountsSync.test.ts:131-148 manifestJson 助手 `Set(staticMounts)` 身份判重（两次 entryOf 实例化不命中，cosmetic）；4-5 分号 pattern 在 HEAD 未复现（b-mounts-manager 679 行零命中）；server/README.md:125/:180 `:index` 为 axum 0.7 旧写法（路由实为 `{index}`，routes/mod.rs:65）。

**Files:**
- Modify: `apps/web/src/lib/mountsSync.test.ts`（:140-142 按字段过滤）、`server/README.md`（:125/:180）、`docs/report/sdd-deferred-minors-2026-10-21.md`（销账标注）

- [ ] **Step 1: manifestJson 过滤改字段判**——`entries.filter((e) => !staticMounts.some((s) => s.id === e.id && s.rootIndex === e.rootIndex))`（或按助手实际键面取 id/rootIndex 组合）；跑 `pnpm vitest run apps/web/src/lib/mountsSync.test.ts` 零翻转。
- [ ] **Step 2: 4-5 核实**——全 e2e 目录 grep（`rg '; *//' apps/web/e2e/ | rg -i 'assert|expect'` 等）：找到则修，找不到则销账（「HEAD 未复现，疑后续提交顺手清」）。
- [ ] **Step 3: README :index → `{index}`** 两处；顺带统一 server/src/lib.rs:145 与 routes/mounts.rs:38 注释（非必须，做了则报告）。
- [ ] **Step 4: Commit**——`test(web),docs(server): manifestJson 字段过滤+README 路由写法对齐 axum 0.8（台账 4-4/4-6）`（4-3/4-5 销账随 Task B3 digest commit 走，或并入本笔，报告定）。

### 阶段四门禁步

- [ ] `pnpm typecheck && pnpm vitest run && pnpm --filter web build:e2e && node tools/diagram-budget.mjs` 全绿后进阶段五。

---

## 阶段五

### Task 5: lightbox 四件（5-2、5-3、5-4、5-5）

**定位**：lightbox.ts:246-253 onKey 无输入守卫（Escape/←→/+/-/r/f 全劫持）；:110-113 openLightbox 按 src 找首匹配（同 src 错位）；:66-81 collectGallery 已含 `.md-diagram-view svg`，但 pipeline.ts:519-527 runLightbox 只对 img 绑点击（svg 无接线）；a11y：无 role=dialog/aria-modal/焦点管理/aria-live（:232 mkBtn 有 aria-label）。

**Files:**
- Modify: `packages/render-text/src/markdown/lightbox.ts`（守卫/焦点/aria/身份定位）、`packages/render-text/src/markdown/pipeline.ts`（svg 点击接线）
- Test: lightbox 既有测试文件（盘点落位；pipeline 侧接线测试照 gallery 既有形态）

**Interfaces:**
- Produces: `openLightbox(items, origin)` 的定位改元素身份（收集时记录元素引用或 index，同 src 多图各归各位）；onKey 对 `input/textarea/select/[contenteditable]` 焦点直通不劫持。

- [ ] **Step 1: 写失败测试**（照既有 lightbox 测试形态；jsdom 可驱动）
  - 5-2：`<input>` 聚焦时按 Escape/←→ 不开合不改缩放；
  - 5-5：同 src 两图，点第二张开第二张（当前实现红：开首张）；
  - 5-4：`.md-diagram-view svg` 点击开灯箱；
  - 5-3：开启后 overlay `role="dialog"`+`aria-modal="true"` 存在、焦点入 overlay、关闭还原到触发元素。
- [ ] **Step 2: 红灯确认 → 实现**：
  - 5-2：onKey 首行守卫 `const t = e.target as HTMLElement; if (t.closest('input,textarea,select,[contenteditable]')) return;`
  - 5-5：collectGallery 条目带元素引用（或 openLightbox 接 origin 元素按引用 indexOf）；
  - 5-4：runLightbox 对 `.md-diagram-view svg` 与 img 同款点击绑定（src=outerHTML 的画廊条目对应）；
  - 5-3：overlay 建时 `role="dialog" aria-modal="true"`、`overlay.focus()`（tabindex=-1）、关闭时 `origin.focus()` 还原、计数 span `aria-live="polite"`。
- [ ] **Step 3: 全量**——`pnpm vitest run packages/render-text/ && pnpm typecheck`；零翻转。
- [ ] **Step 4: Commit**——`fix(md): lightbox 输入守卫/元素身份定位/svg 直开/a11y 基线（台账 5-2/5-3/5-4/5-5）`

### Task 6: 待核三件核实处置 + spec 勘误（5-6、5-7、5-8、5-1）

**定位（侦察）**：5-6 dynamic 页型=export.ts:293 类型在案+collectPrintHtml :318-321 占位锚在案，但 **MetaPanel.svelte:131 硬编码 a4 无页型选项**，且 `vv-dynamic-page` 壳侧消费全仓零命中（机制半边未实现）；5-7 降级引导**已在案**（MetaPanel.svelte:132-134 showNotice 两态文案）；5-8 重渲**已走 local 引擎**（markdownRenderer.ts:532-551），失败静默半边在 :540-541（`if (!ok) return;`）；5-1 勘误候选=md-katex-syntax **plan**（docs/superpowers/plans/）：脚注「无现成插件自写 inline rule」说法过时（实为 markdown-it-footnote 4.0.0 自带）、comrak `parser.inline_footnotes` 说法失实（实为 Extension 选项）、`server/src/compute/markdown.rs` 路径漂移（实为 server/core/src）。

- [ ] **Step 1: 5-6 销账**——机制半边（壳 onload 回写实高）未实现，接 UI 会产出坏选项；digest 标「✅ 核实销账（类型与占位锚为设计预留，机制半边未实现——补全属功能立项非清偿面）」。
- [ ] **Step 2: 5-7 销账**——降级引导两态文案在案（面板内 notice 非 toast，口径满足「引导手动打印」）。
- [ ] **Step 3: 5-8 最小补强+销账**——markdownRenderer.ts:540-541 失败分支补 `console.warn('mermaid 主题重渲失败，保留旧图', err)`（或既有日志惯例）+注释声明「静默保留为设计形态，warn 供诊断」；「改走 local 引擎」半边核实销账。
- [ ] **Step 4: 5-1 spec 勘误**——md-katex-syntax plan 修正三处：脚注说法（markdown-it-footnote 4.0.0 自带 footnote_inline，engine.ts:12-16）、comrak inline_footnotes 属 Extension 非 Parse（server/core/src/compute/markdown.rs:65-72）、compute 路径 server/src→server/core/src；行号漂移引用改函数名。
- [ ] **Step 5: Commit**——`docs(spec,md): katex 计划勘误三处+待核三项核实处置（台账 5-1/5-6/5-7/5-8）`（5-8 若涉码则随码分笔）

### Task 7: 阶段四五门禁 + digest 回写

- [ ] **Step 1: 全量门禁**——`pnpm typecheck && pnpm vitest run && pnpm --filter web build:e2e && node tools/diagram-budget.mjs`（阶段四五无 Rust 面，workspace cargo 不必重跑但跑一次作收口锚亦可）+ playwright 定向（b-mounts-manager + m3 域 md 相关）。
- [ ] **Step 2: digest 回写**——阶段四 6 项+阶段五 8 项逐条终态（销账项带核实结论）；头部补「阶段四清偿：<日期>，6/6」「阶段五清偿：<日期>，8/8（3 销账+5 修）」。
- [ ] **Step 3: 台账终条 + Commit**——`docs(report): 递延清偿批阶段四五终态回写——6+8 项清账`
