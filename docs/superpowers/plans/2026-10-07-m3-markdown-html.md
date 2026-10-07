# M3 Markdown/HTML 与文件内搜索 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** markdown 一等渲染（markdown-it + markpad 五步管线移植：净化→高亮→图表→KaTeX→复制/灯箱，TOC、front matter、callouts）；html 双层防御沙箱预览；文件内搜索（代码/文本分块搜索 + markdown 渲染视图 + html 源码，spec M2 顺延项）。

**Architecture:** `packages/render-text` 新增 `markdown.ts`（引擎+管线）与 `html.ts`（沙箱）；搜索实现在 `packages/render-text/src/search.ts` + UI 搜索面板（apps/web）。管线输入输出均为 DOM/字符串，引擎可替换（档 2 comrak 预留）。

**Tech Stack:** markdown-it + GFM 插件（markdown-it-task-lists 等）、dompurify、katex、mermaid 11、highlight.js（已有）；全部懒加载。

**Spec:** `docs/superpowers/specs/2026-10-06-vviewer-design.md`（5.3 Markdown / 5.4 HTML / 5.9 文件内搜索 / M3 里程碑行）。**markpad 源码可直读移植（项目自有 BSD-3）：/share/rw/repo/markpad-aio/Markpad/src/lib/{pipeline/,utils/sanitize.ts,utils/markdown.ts,utils/frontMatter.ts,components/Toc.svelte}**——移植时剥离 Tauri invoke 依赖。

## Global Constraints

- 沿用项目全局约束（TS strict、Angular 中文 commit）。
- 管线五步顺序固定：sanitize → highlight → diagrams → katex → copyCode/lightbox（markpad `pipeline/index.ts` 的语义，输入为净化后的 DOM）。
- 净化：DOMPurify，禁 `<style>`、白名单 URI（http/https/mailto/相对/data:image），Markdown 与 HTML 渲染共用。
- mermaid 懒加载且失败不阻塞其余管线步骤；Kroki 等远程服务不实现。
- 搜索契约：`{query, matches: [{line, startOffset, endOffset, preview}], total}`，Enter/Shift+Enter 跳转、全部命中高亮；搜索 UI 快捷键 `/`。
- M3 验收：samples/m3 的 md（表格/任务列表/围栏代码高亮/callout/公式/mermaid/目录）渲染断言全绿；html 沙箱断言（script 不执行）；搜索断言（跳转 + 计数）；净化单测全绿。

---

### Task 1: markdown-it 集成与 front matter

**Files:** Create `packages/render-text/src/markdown/{engine.ts,frontMatter.ts}`; Test `packages/render-text/test/markdownEngine.test.ts`
**Interfaces:** `renderMarkdownToHtml(src: string): { html: string; frontMatter: Record<string, unknown> | null }`——front matter（`---` YAML 块）用 `yaml` 库解析后从源剥离再渲染；markdown-it 开 GFM 全家（table/strikethrough/tasklist/linkify）、`html: true`（输出必经 sanitize）。YAML 解析失败返回 null 且原文渲染（容错）。
**Steps:** 失败测试（表格/任务列表/围栏/front matter 剥离/坏 YAML 容错）→ 实现 → 绿 → Commit `feat(render-text): markdown-it 引擎与 front matter`

### Task 2: sanitize 与 callouts/媒体链接增强

**Files:** Create `packages/render-text/src/markdown/{sanitize.ts,enrich.ts}`; Test `packages/render-text/test/markdownSanitize.test.ts`
**Interfaces:** `sanitizeHtml(dirty: string | Document): string`（DOMPurify 配置照 brief：FORBID_TAGS style、ALLOWED_URI_REGEXP 白名单、ADD_ATTR data-* 保留 mermaid/katex 钩子）；`enrichMarkdownDom(root: Document)`——callouts（`[!note]` 块引用转样式化卡片，≥6 类型 + 默认）、音视频链接（`.mp4/.webm/.mp3` 等结尾的媒体链接转 `<video>/<audio>` 占位）。参考 markpad `utils/markdown.ts` 的 processMarkdownHtml（可直读移植，剥 invoke）。
**Steps:** 失败测试（script 剥除、style 禁、javascript: URI 剥、callout 转换、媒体链接）→ 实现 → 绿 → Commit `feat(render-text): DOMPurify 净化与 callouts/媒体链接增强`

### Task 3: 管线五步——highlight/katex/mermaid/copyCode/lightbox

**Files:** Create `packages/render-text/src/markdown/pipeline.ts`; Test `packages/render-text/test/markdownPipeline.test.ts`
**Interfaces:** `runPipeline(root: Document, ctx: { highlightFence: (code: string, lang: string) => Promise<string | null>; themeClassPrefix: string }): Promise<void>`——五步顺序执行；highlight 步：对 `pre code.language-x` 调 ctx.highlightFence（实现端接 packages/highlight 的 TreeSitterEngine——**浏览器端经 HighlightClient，围栏代码块走完整降级链；返回 null 时保留 hljs 兜底**——实现为注入回调使 render-text 不直接依赖 highlight 包，依赖倒置）；katex 步：`$...$`/`$$...$$` 文本节点扫描（简单分隔符策略，跳过代码块）渲染 KaTeX，失败保留原文；mermaid 步：`code.language-mermaid` → 容器 div + `mermaid.render`（动态 import，失败显示原文 + 错误样式）；copyCode 步：代码块右上复制按钮（navigator.clipboard）；lightbox 步：图片点击放大（简单 overlay）。
**Steps:** 失败测试（顺序执行——用调用记录数组断言五步次序；katex 行内/块级；mermaid 失败不阻塞 copyCode；highlightFence 注入被调用）→ 实现 → 绿 → Commit `feat(render-text): markdown 渲染五步管线`

### Task 4: markdownRenderer 与 html 渲染器（沙箱）

**Files:** Create `packages/render-text/src/markdown/markdownRenderer.ts`、`packages/render-text/src/html.ts`; Modify `apps/web/src/lib/viewer.ts`（install 两个 renderer + highlightFence 回调接线 HighlightClient）；Test `packages/render-text/test/htmlRenderer.test.ts`
**Interfaces:** `markdownRenderer: Renderer`（id 'markdown'，exts md/markdown；render：renderMarkdownToHtml → sanitize → innerHTML → enrich → runPipeline → TOC 数据输出 `getToc(): {level,text,id}[]`）；`htmlRenderer: Renderer`（id 'html'，exts html/htm；双层防御照 file-viewer `html.ts` 模式：DOMPurify WHOLE_DOCUMENT + 属性二次清洗 → srcdoc 注入 sandbox iframe（`sandbox="allow-same-origin"?` **不**给 allow-scripts；opaque origin）+ CSP meta）＋源码/渲染视图切换（源码视图复用 codeRenderer 的 renderCode）。highlightFence 接线：viewer.ts 构造回调调 `highlightClient.highlight(code, lang)` → 区间 + captureToCssClass 生成 span HTML（复用 render-text 已有区间渲染纯函数；失败返回 null 走管线内 hljs 兜底）。
**Steps:** html 失败测试（script 不执行——iframe sandbox 属性断言；on* 剥除；视图切换标记）→ 实现两 renderer + viewer 接线 → 绿 → Commit `feat(render-text): markdown/html 渲染器（沙箱双层防御）`

### Task 5: TOC 组件与右栏面板

**Files:** Create `apps/web/src/lib/Toc.svelte`、`apps/web/src/lib/MetaPanel.svelte`（空壳预留 M4）；Modify `AppShell.svelte`（右栏挂载 + markdown tab 显示 TOC）；Modify `apps/web/src/app.css`
**Interfaces:** ViewerPane 的 RenderedInstance 增加 `getToc?(): {level,text,id}[]`（markdownRenderer 已产）；TOC 点击滚动到 heading id；滚动跟随（IntersectionObserver 高亮当前节）。窄屏右栏并入抽屉。
**Steps:** build 绿 + 手动验证说明；Commit `feat(web): 目录侧栏（滚动跟随）`

### Task 6: 文件内搜索（M2 顺延项）

**Files:** Create `packages/render-text/src/search.ts`、`apps/web/src/lib/SearchPanel.svelte`; Modify `code.ts`（暴露搜索）、`ViewerPane.svelte`（`/` 快捷键 + 面板挂载 + 跳转）；Test `packages/render-text/test/search.test.ts`
**Interfaces:**
- `searchCode(lines: string[], query: string, opts?: {caseSensitive?: boolean}): SearchMatch[]`——纯函数（行级扫描，返回行号与偏移；大文件天然分块——行数组已存在，无额外 IO）。
- RenderedInstance 可选 `search?(query): Promise<SearchMatch[]>` + `gotoMatch?(index): void`：code 实现=行数组扫描 + 滚动到行 + 命中行临时高亮；markdown 渲染视图实现=对渲染 DOM 的文本节点 TreeWalker 找 query，命中处 `window.find` 式滚动 + `<mark>` 包裹（退出搜索时还原）；html 源码视图=复用 code 实现。
- SearchPanel UI：输入框、计数（n/N）、上/下一个、Esc 关闭；快捷键 `/` 聚焦。
**Steps:** 失败测试（searchCode 大小写/多命中/空 query；code 实例 search 跳转用 fake DOM）→ 实现 → 绿 → Commit `feat(render-text): 文件内搜索（代码分块/markdown DOM/html 源码）`

### Task 7: samples/m3 + E2E

**Files:** Create `apps/web/e2e/m3.spec.ts`、`samples/m3/{demo.md,page.html}`
**Interfaces:** 断言：表格/任务列表渲染；围栏代码出现 `ts-*` 或 `hljs-*` span；callout 卡片；katex 公式（`.katex` 存在）；mermaid 容器存在（svg 或错误样式）；TOC 项数与标题数一致；html 页面 script 未执行（window 标记不存在——通过 iframe contentDocument 检查）；搜索面板 `/` 打开、输入后计数 >0、Enter 跳转（滚动位置变化）。连续 3 次全绿。
**Steps:** 样例 → 测试 → 绿 → Commit `test(web): M3 E2E（markdown 管线/沙箱/搜索）`

## Self-Review 记录

- Spec 覆盖：5.3（T1-T5）、5.4（T4）、5.9 文件内搜索（T6，含 M2 顺延的代码搜索）、M3 验收（T7）；档 2 comrak 不在本期（M6）。
- 依赖倒置裁决：pipeline 的 highlight 步通过回调注入，render-text 不新增对 highlight 包的硬依赖（viewer.ts 接线）。
- DOMPurify/katex/mermaid/markdown-it/yaml 依赖全部加在 packages/render-text（markdown 相关）与 apps/web（mermaid 体积大放 web 端动态 import——执行者按 tree-shaking 实测决定放哪边，报告说明）。
