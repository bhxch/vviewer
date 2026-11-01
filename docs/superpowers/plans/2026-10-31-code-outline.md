# 代码大纲（tags.scm）+ 右面板「目录/属性」切换 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 代码文件获得 tree-sitter 符号大纲（tags.scm 驱动，现盘 51 语 + 上游补主流语），右面板加 `[目录 | 属性]` 切换器（有大纲默认「目录」，无大纲纯属性现状）。

**Architecture:** 协议面三层打通（QueryFile.tags → 两装载器 → engine.outline → worker 分派 → HighlightClient.outline）；渲染器全量 parse 路径完成后投递大纲请求（≤2MB，窗口/流式路径不产大纲）；鸭子方法 `getOutline()` 照抄 getToc 三件套上行；右面板切换器按数据源互斥渲染（Toc.svelte/Outline 视图双组件）。

**Tech Stack:** web-tree-sitter、Svelte 5 runes、vitest、playwright 双 project。

**Spec:** `docs/superpowers/specs/2026-10-31-code-outline-panel-switch-design.md`

## Global Constraints

- 覆盖策略：缺 tags 查询或 worker 不可用 → 不显示大纲，**无正则兜底**；>2MB（窗口/流式/服务端路径）不产大纲。
- 大纲数据类型 `OutlineEntry { name: string; kind: string; line: number（0 起）; byteStart: number; byteEnd: number; depth: number }`（packages/vviewer-core/src/types.ts，**不并 TocEntry**——其 id 是真 DOM heading id 三依赖）。
- 捕获约定：只收集 `@name` + `@definition.*` 配对；`@doc/@ignore/@local.*` 及下划线辅助捕获忽略；同 match 无 @name 配对时用 definition 节点文本（trim）为名（rust 形态）；depth 按节点 byte range 包含关系栈式计算；按位置排序。
- 上游 tags 补充源：nvim-treesitter `runtime/queries/<lang>/tags.scm`（MIT），首版补 typescript/tsx/bash/shell/zig/json/lua/c（语言集实现时按上游在册情况定，报告列明实补清单）；与现盘 51 语合并去重。
- `#strip!/#select-adjacent!` 谓词（tree-sitter-tags 专用）：**Task 1 首步 spike 实测 web-tree-sitter 兼容性**；不兼容则 generate.mjs 生成期剥除含该谓词的行（仅影响 doc 注释关联，语义无损）——禁止运行时静默吞错。
- 滚动跟随：`RenderCodeHandle` 增可选 `firstVisibleLine?(): number`（仅全量模式，lineAtOffset 同款「仅全量」先例）；接线在 AppShell 节流循环；成本超预期降级为仅点击高亮（降级记档）。
- 大纲点击：`Object.assign(tab, { pendingLine: line + 1 })` 复用既有通道（ViewerPane :440-444 消费），零新契约。
- 切换器状态会话内不持久化；markdown TOC 数据链与 Toc.svelte 零改动。
- 工作树 server/core/build.rs 属并行会话——提交一律 scoped add；门禁一律 HEAD 口径（commit 后重跑受影响面）。

## Review Focus

- worker 协议扩展的向后兼容：旧格式 worker + 新格式主线程（或反向）的混布瞬间——OutlineRequest 必须独立消息形态，旧 worker 收到不崩（serveWorker 未知 kind 分派路径核证）。
- outline 请求的取消/失效：tab 切换、文件切换、快速连续 parse（同 lang 去重通道不可复用 highlight 的 pendingByLang——大纲与高亮是两类请求，需独立 pending 面 + id 失效）。
- depth 计算 O(n²) 风险：大文件千级符号的包含关系两两比较——栈式按 start 排序后线性，单测锁复杂度形态（千级条目 <50ms 量级断言）。
- 切换器显隐三态：有大纲→[目录|属性]；无大纲但 md TOC 有→同样；两者皆无→无切换器纯属性（检查器/导出区块不受影响）。
- 服务端渲染路径（>2MB）与 hljs 降级路径：getOutline 鸭子方法缺席 → ViewerPane 上行空数组 → 无切换器（不得抛错）。

---

### Task 1: highlight 包协议面 + tags 资产扩容（含 spike 前置）

**Files:**
- Modify: `packages/vviewer-highlight/src/queries.ts`（QueryFile/ExpandedQuery/expandQuery/expandQueryAsync 四动点）、`src/core-parse.ts`（两装载器白名单 :420/:438 + doPrepare 编译 :349-353 + engine.outline 方法）、`src/types.ts`（OutlineRequest/Response）、`src/worker.ts`（分派）、`src/client.ts`（outline 方法 + 独立 pending 面）、`src/index.ts`（导出）
- Modify: `tools/helix-assets/generate.mjs`（TAGS_SOURCES 第二源表 + copyTags）+ `tools/helix-assets/test/generate.test.ts`（守门锚）
- Test: `packages/vviewer-highlight/test/outline.test.ts`（新）

- [ ] **Step 1: spike（一次性，结论入报告）**——node 脚本：web-tree-sitter Parser + 现盘 python/go/javascript 三份 tags.scm 经 `new Query(lang, scm)` 编译 + `query.matches(tree)` 实跑（grammar wasm 从构建缓存或临时自建取一件）。结论二选一：A 兼容（谓词仅附着不阻断）→ 直用；B 编译/匹配抛错 → generate.mjs 增 `stripTagsPredicates`（剥 `#strip!/#select-adjacent!` 所在 pattern 行）并重验。**未过 spike 不得继续 Step 2 之后。**
- [ ] **Step 2: 失败单测**——①QueryFile.tags 继承展开（父 tags 拼接）；②两装载器白名单含 tags.scm（fetch 失败静默空）；③capture 配对纯函数（synthetic matches → OutlineEntry[]：@name 配对/无配对用节点文本/@doc 忽略/double capture/depth 栈式千级条目时限）；④协议往返形状（OutlineRequest/Response 序列化形态）。
- [ ] **Step 3: 实现**——协议 `OutlineRequest { id; lang; text }` / `OutlineResponse { id; ok; entries?; error? }`；worker serveWorker 对 outline kind 独立分派（未知 kind 不崩路径核证）；engine.outline(text, lang)：全文本 parse 一次 → tags query matches → 配对纯函数；client.outline(text, lang) 独立 pending Map + 同款三层失效。
- [ ] **Step 4: tags 资产扩容**——generate.mjs `TAGS_SOURCES`（nvim-treesitter pin commit 固定，env 覆盖同款）+ `copyTags`（存在即拷、缺目录静默）+ generateAll 接线；实补语言下载入库；守门测试补「tags 目录数 ≥ 基线、抽查 typescript/bash 捕获形态」。
- [ ] **Step 5: 跑绿**——`pnpm vitest run packages/vviewer-highlight/test packages/helix-assets 2>/dev/null || pnpm vitest run packages/vviewer-highlight/test tools/helix-assets/test`（仓库根，命令按实况）+ `pnpm typecheck` 0E。
- [ ] **Step 6: Commit**——`feat(highlight): tags.scm 大纲协议面——QueryFile 第三字段+worker outline 通道+上游补源`

### Task 2: 渲染器挂接（render-text）+ core 类型

**Files:**
- Modify: `packages/vviewer-core/src/types.ts`（OutlineEntry + RenderedInstance.getOutline?: () => OutlineEntry[]）
- Modify: `packages/vviewer-render-text/src/code/client.ts`（RenderCodeHandle 增可选 `getOutline?`/`firstVisibleLine?`）、`code/index.ts`（实例鸭子方法）、`renderCode.ts`（全量路径：start() tree-sitter 分支 parse 完成后投递 outline 请求 + getOutline 返回缓存 + firstVisibleLine 实现）、`renderCodeWindowed.ts`（不产大纲——getOutline 返回 []，firstVisibleLine 缺席）
- Test: render-text 既有测试形态（源码契约锚先例；runes 不可直测处用契约断言）

- [ ] **Step 1: 失败单测/契约锚**——①OutlineEntry 类型与 RenderedInstance 契约（编译期）；②renderCode 全量路径 outline 触发时机（parse 完成后一次，不发于 hljs/plain 分支）；③firstVisibleLine 仅全量存在、窗口模式 `'firstVisibleLine' in handle === false`。
- [ ] **Step 2: 实现**——renderCode：`client.outline(text, lang)` fire-and-forget（独立于高亮失败面，catch 静默空）；`getOutline(): OutlineEntry[]`（请求完成前返回 []）；firstVisibleLine 从虚拟滚动容器取首可视行（现有 scrollTop/行高计算）。
- [ ] **Step 3: 跑绿 + typecheck**
- [ ] **Step 4: Commit**——`feat(render-text): code 全量路径大纲提取与鸭子契约——getOutline/firstVisibleLine 可选方法`

### Task 3: 上行链 + 右面板切换器 + e2e OUT

**Files:**
- Create: `apps/web/src/lib/OutlineView.svelte`
- Modify: `apps/web/src/lib/ViewerPane.svelte`（getOutline 鸭子上行 :446-448 并列 + tab 切换清空 :511）、`apps/web/src/lib/AppShell.svelte`（outlineEntries state + 切换器 + 互斥渲染 + 滚动跟随节流循环 + :1141-1148 区域改造）、`apps/web/src/app.css`（切换器/大纲样式）
- Test: e2e `apps/web/e2e/b-code-outline.spec.ts`

- [ ] **Step 1: ViewerPane/AppShell 上行**——`ontoc` 同款 `onoutline` props；`outlineEntries = $state<OutlineEntry[]>([])`；:1119-1122 接线；:511 清空同款。
- [ ] **Step 2: 切换器与视图**——`.vv-right` 顶部（折叠钮后）`[目录 | 属性]` 分段钮：显隐 = `tocEntries.length > 0 || outlineEntries.length > 0`；`rightView` 默认 = 有目录时 'toc' 否则 'meta'；互斥渲染 `{#if rightView==='toc'}{md: Toc}{code: OutlineView}{:else}<MetaPanel/>{/if}`——md/code 大纲区分：`outlineEntries.length > 0` 时目录视图渲染 OutlineView，否则 Toc（两者不会同时有：实例互斥）。OutlineView：缩进树（depth 钳制 8 层）+ 点击 `pendingLine` 通道 + activeLine 高亮（AppShell 节流循环读 handle.firstVisibleLine 二分大纲表）。
- [ ] **Step 3: e2e OUT-01..**（前置 corpus+build:e2e）——OUT-01 python 文件大纲渲染与 depth；OUT-02 点击跳转（pendingLine 通道，行视口就位）；OUT-03 切换器显隐三态（py 有/ts 有/md TOC 有/无大纲文件纯属性）；OUT-04 >2MB 不出大纲 + hljs 降级路径无切换器；OUT-05 无 tags 语言（如 ada 现盘无则用实盘缺查语）无切换器；OUT-06 滚动跟随（滚动后高亮项变化）与 markdown TOC 回归（m3.spec 既有锚不翻）。定向 `playwright test b-code-outline m3 b-markdown-html-docs-md07-09`。
- [ ] **Step 4: 门禁 + Commit**——`feat(outline): 右面板目录/属性切换器与代码大纲视图——pendingLine 跳转+滚动跟随`

### Task 4: 全量门禁（HEAD 口径）

- [ ] **Step 1**——corpus + `build:e2e` → `pnpm typecheck && pnpm test` → playwright 双 project 全量 → server 套件 → diagram-budget（无新增 assets 面预期不变）。
- [ ] **Step 2**——翻红按 HEAD 口径处置真修，最终数字对应最终 HEAD；报告写 task-4。
- [ ] **Step 3: Commit（如有修复）**——`fix(outline): 门禁收口`

## Self-Review 记录

- 规格覆盖：spec §2 数据面（T1 含 spike/扩容/协议）、§2.3 上行（T2/T3）、§3 切换器三态/默认目录/点击/跟随（T3）、覆盖策略与无兜底（Global Constraints + OUT-04/05）——全覆盖。
- 类型一致：OutlineEntry 三处（core 定义/T1 worker 产出/T2 渲染器/T3 视图）一致；getOutline 鸭子名四处一致。
- Review Focus 五条：混布兼容（T1 协议独立分派）、独立 pending（T1 Step 3）、depth 复杂度（T1 用例③）、切换器三态（T3 Step 2/OUT-03）、服务端降级（OUT-04）。
- 顺序依赖：T1→T2→T3→T4 严格串行（协议→渲染器→UI→门禁）。
