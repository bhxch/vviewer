# 代码大纲（tags.scm）+ 右面板「目录/属性」切换设计

- 日期：2026-10-31
- 状态：已批准（brainstorming 六需求批量立项之一；需求 4+5 合并）
- 上游：`2026-10-10 四阶段全量对齐 Markpad 301`（查询资产管线）、`2026-10-12-io-streaming-design.md`（code 窗口/全量双形态）

## 1. 背景与动机

右面板的目录树（TOC）目前仅 markdown 有：数据链 = `getToc()`（`markdownRenderer.ts:335-341` 渲染后 DOM 查询 h1-h4）→ `ViewerPane.svelte:446-448` → `AppShell.svelte:1053` `tocEntries` → `Toc.svelte`（`.vv-right` 内 MetaPanel 的兄弟节点，单滚动流堆叠）。代码文件无大纲。

**关键资产事实**：`packages/vviewer-highlight/assets/queries/` 已有 **53 种语言的 `tags.scm`**（tree-sitter 符号定义查询约定：`@name` + `@definition.class/function/...` 捕获），目前是死资产——全仓无任何符号提取代码；浏览器端装载器只 fetch highlights/injections 两类（`core-parse.ts:393-427`）。

用户拍板：代码文件也要大纲；右面板在有目录树时可切换「目录/属性」两个视图，**有大纲时默认「目录」**。

## 2. 数据面：大纲提取

### 2.1 查询资产扩容

- 现盘 53 语直接启用（c/cpp/c-sharp/go/java/javascript/python/ruby/rust/scala/swift/kotlin/lua/php/elixir/…，清单见 brainstorm 实测）。
- **补齐主流缺口**：现盘缺 typescript/tsx/shell/zig 等——从上游补充这些语言的 tags.scm（nvim-treesitter 仓库为首选源，MIT 同域）。管线落点：`tools/helix-assets/generate.mjs` 新增 tags 补充源常量表（现 SOURCES `:11-20` 源自 Markpad pin，`QUERY_PATCHES` `:215-233` 同文件），产物同规则入库（assets 内 .scm 直接入库先例，955 文件在册）；守门测试 `generate.test.ts:149-176` 增 tags 锚。
- 消费端装载：`queries.ts` `QueryFile`（`:1-6` 仅 highlights/injections 两字段）增 `tags?` 字段 + `expandQuery` 继承语义；`core-parse.ts` 两装载器（`remoteQueryLoader:393-427`、`loadQueriesFromDir:430-442`）白名单增 `tags.scm`（fetch 404/缺文件 → 静默空，引擎侧不报错）。服务端 `queries.rs`/`build.rs` **不接 tags**（大纲纯前端能力）。
- 覆盖策略（已定）：**缺 tags 查询或引擎不可用 → 不显示大纲，无正则兜底**（质量一致性优先）。

### 2.2 worker 协议与提取

- 消息协议（`packages/vviewer-highlight/src/types.ts:24-39` `HighlightRequest/Response`）扩展：`OutlineRequest { id, lang, text }` / `OutlineResponse { id, ok, entries }`；`entry = { name, kind, line（0 起）, byteStart, byteEnd, depth }`。worker 分派（`worker.ts:21-28` createHandler、`:118-170` serveWorker）与客户端 `HighlightClient`（`client.ts`）对应扩面。
- 引擎方法 `outline(text, lang)`：仿 `highlight()`（`core-parse.ts:218`）——`Query::new(tags.scm)` → matches → 配对收集 `@name` 与 `@definition.*`（无 `@name` 配对的捕获丢弃）；`kind` = 捕获名去 `@definition.` 前缀；**depth 按节点 byte range 包含关系栈式计算**（tags 查询不表达嵌套，运行时推导）；按位置排序。
- 客户端触发：code 渲染器在**全量 parse 路径**（≤2MB 主路径）完成后投递 outline 请求（全文随请求携带，worker 独立 parse 一次，异步不阻塞渲染）；窗口/服务端流式路径（>2MB）不产大纲（已定）。per 请求 id 失效（tab 切换/文件切换丢弃在飞结果），复用高亮通道的 id 失效三层防护惯例。

### 2.3 上行与数据归一

- code 渲染器实例新增鸭子方法 `getOutline()`（仿 `getToc`，`client.ts:173` 契约模式）→ `ViewerPane` 读取上行（`ViewerPane.svelte:446-448` 链路并列扩展，AppShell 新 state `outlineEntries`，`:511` tab 切换清空同款）。
- **数据形状（builder check 收敛，替代原「TocEntry 归一」口径）**：大纲不并入 `TocEntry`——其 `id` 是真 DOM heading 元素 id，`Toc.svelte` 的 key/`getElementById` 点击/IntersectionObserver 三处机制全依赖此事实，大纲条目无 DOM 锚点却需要 `line`/`depth` 载荷，硬并会让两边都变形。新类型 `OutlineEntry { name, kind, line（0 起）, byteStart, byteEnd, depth }` 落 `packages/vviewer-core/src/types.ts`；`Toc.svelte`/`TocEntry` 零改动，目录视图 = md 分支（Toc 现状）与 code 分支（新 Outline 视图组件，缩进树渲染）在切换器下按数据源互斥渲染。
- 点击通道（builder check 收敛）：code 大纲项点击 → `Object.assign(tab, { pendingLine: line + 1 })` 复用既有通道（GlobalSearchPanel `:160-168` 写入、ViewerPane `:438-446` 消费的同款），零新契约、零实例引用注入。md 分支维持组件内 DOM id 滚动现状。

## 3. 交互面：右面板切换（已定）

- `.vv-right` 顶部新增**分段切换器 `[目录 | 属性]`**，**仅当目录数据非空时渲染**（`tocEntries.length > 0` 或 `outlineEntries.length > 0`）；无大纲文件维持现状纯属性（检查器/导出区块留在属性视图内，MetaPanel 不动）。
- 视图状态 `rightView: 'toc' | 'meta'`：**默认 = 有目录时 'toc'**（用户拍板），会话内切换不持久化、不跨文件记忆（每次打开有大纲的文件回到目录视图）。零快照/零 settings 新增。
  - **实现语义（Task 3 评审对齐）**：用户手动切换过视图（含语言轻入口落位属性面板）后跨文件保持其选择；未动过则每次按有无大纲默认落位——「不跨文件记忆」据此修正为「未动过时跟随默认落位」。
- 大纲渲染：缩进树列表（depth → 缩进层级，深度钳制防深嵌套爆版面——builder 定钳制值）；kind 是否以小徽标展示列为 builder 细节（v1 允许纯缩进+名）。
- 点击跳转：`revealLine(line + 1)`（`client.ts:173` 契约 / `renderCodeWindowed.ts:1284` 含未加载行续读已备；ViewerPane `pendingLine` 通道同款）。
- 滚动跟随（纳入，便宜版；builder check 收敛接线）：`RenderCodeHandle` 增**可选方法** `firstVisibleLine()`——仅全量模式提供（`lineAtOffset` 同款「仅全量」契约先例，`client.ts:179`），实现从虚拟滚动容器取数；节流循环持在 AppShell（读激活 tab 渲染 handle → 二分 `outlineEntries` → activeOutlineLine 下行给目录视图高亮）。窗口/流式路径缺席该方法 → 跟随静默不启用。若实施实测成本超预期，降级为「仅点击后高亮当前项」，降级记档。md 侧维持 IntersectionObserver 现状（`Toc.svelte:16-52`）。

## 4. 触达面

packages/vviewer-highlight（QueryFile/装载器/协议/engine outline/tags 资产+generate.mjs）、packages/vviewer-render-text（code 实例 getOutline + 渲染路径挂钩 + `firstVisibleLine()` 可选契约）、packages/vviewer-core（OutlineEntry 新类型）、apps/web（ViewerPane 上行/AppShell 切换器与 state/新 Outline 视图组件/app.css）。e2e：OUT-01..——python/typescript 大纲渲染与 depth、点击跳转（pendingLine 通道）、切换器显隐（有/无大纲）、>2MB 不出大纲、md TOC 回归、无 tags 语言（如 ada）无切换器。

## 5. 非目标

- 服务端大纲（compute 通道）不做；大纲不进会话快照/搜索索引；折叠大纲节点（v1 平铺缩进树，不折叠）。
- 大纲与高亮共享 parse 的优化（worker 不保 tree，独立 parse 一次在 ≤2MB 下可接受）——若实施实测成本高，再立优化项。
