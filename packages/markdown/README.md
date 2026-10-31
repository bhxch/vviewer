# @vviewer/markdown

markdown 完整渲染组合包：一行装配「markdown 引擎 → sanitize → enrich → 五步管线
（highlight / diagrams / katex / copyCode / lightbox）→ 挂载 → heading id → TOC →
导出装配」。自 `@vviewer/render-text` 的 `src/markdown/` 迁出参数化而成，渲染行为
默认等价；本包不依赖 `@vviewer/core`、`apps/*` 或 render-text（宿主侧 core 值以
结构类型直接传入）。

## 快速上手

```ts
import { createMarkdownView } from '@vviewer/markdown';
import '@vviewer/markdown/markdown.css'; // 完整排版/高亮映射/图表/灯箱样式

const view = createMarkdownView(document.querySelector('#doc')!);
await view.render('# 标题\n\n```ts\nconst x = 1;\n```\n');
view.getToc();          // 目录
await view.search('x'); // 文件内搜索
view.destroy();
```

默认选项即完整效果：

- **高亮**：包内默认 tree-sitter 主线程高亮器（`src/highlightDefault.ts`，按 fence
  逐块 parse，单块有界）。grammar wasm 默认来自
  `https://cdn.jsdelivr.net/npm/@bhxch/vviewer-grammars-full@0.1.0/grammars/`
  （manifest 与 wasm 同目录是发布布局契约，URL 必须以 `/grammars/` 结尾）；查询
  资产默认取同发布包的 `queries/` 兄弟目录（由 baseUrl 推导，可经
  `options.highlight.queriesUrl` 覆盖）；web-tree-sitter runtime wasm 默认取
  jsdelivr `web-tree-sitter@0.25`（可经 `options.highlight.runtimeDir` 覆盖）。
  完全离线/自托管可直传 `options.highlight.table`（GrammarTable）与
  `options.highlight.queries`（VirtualQueries）跳过全部网络请求。
- **降级链**：tree-sitter 失败（引擎初始化失败/未知语言/解析失败）→ hljs 动态
  import → 原文 plain，与原 render-text 管线一致；默认实现永不抛错（主线程同步
  产出，无 tab 取消语义）。
- **语言集**：默认按 grammar manifest 全集可用（至少覆盖 lite 子集
  javascript/typescript/ts/tsx/bash/json/css/html/python/rust/yaml；当前发布
  grammar 包为自建 34 语言、不含 markdown——markdown 围栏走 hljs 兜底）。可用
  `options.highlight.languages` 收窄白名单；白名单外/未知语言直接降级。
- **katex**：`runKatex` 动态 `import('katex/dist/katex.min.css')`（bundler 消费
  形态，vite 抽独立样式 chunk 按需注入）。**无 bundler 使用时需自行引入 katex
  css**（如 `<link href=".../katex/dist/katex.min.css">`），否则公式无排印。
- **diagram**：五步管线 diagrams 步开启，模式按 `@vviewer/render-diagram` 注册表
  defaultMode（mermaid/graphviz 等本地引擎，plantuml 等走 kroki img，kroki host
  缺省 `DEFAULT_KROKI_HOST`）。
- **lightbox / sanitize / enrich**：全开，DOM 类名契约与原实现逐字节一致
  （`.vv-markdown`/`.md-code-bar`/`.md-code-lang`/`.md-diagram-*`/`[data-mermaid]`/
  `.katex`/`.markdown-alert-*`/`#md-lightbox-overlay`/`.md-wikilink-dead`/
  `a.anchor`/`[data-vv-blocked-external]`/`user-content-`/`data-md-*`）。

## CSS 单源

`src/css.ts` 是样式单源（CSS 字符串常量，tsc publish 形态可用）；`src/markdown.css`
为消费面镜像（`<link>`/CSS import 用），两者由 `test/cssMirror.test.ts` 锁逐字节
等价。导出装配 `exportBaseCss` 的共享规则段引用同一常量——原 app.css↔export.ts
双端手工镜像就此消灭（app.css 侧切换为下一步）。

所有设计令牌写成 `var(--token, 默认值)` 形态：本包不定义 `:root` 令牌块、不与宿主
主题打架。缺省值取 app.css 亮色现值（`--ui-*`/`--code-*`/`--hljs-*`）与 highlight
包 `onelight` 主题（应用默认代码主题）的 53 条 capture 解析值（`--vv-ts-*`）；
宿主注入 `style#vv-code-theme` 与各主题令牌照常覆盖。例外（保持原语义）：
`--hljs-type/--hljs-variable/--hljs-tag` 默认未定义（仅代码主题映射命中时生效），
`--vv-ts-variable/--vv-ts-number` 在 onelight 无 fg 值回落 `inherit`。

## API 概览

### 高层

- `createMarkdownView(container, options?)` → `MarkdownView`
  （`render(source)` / `destroy()` / `getToc()` / `search(query, opts?)` /
  `gotoMatch(i)` / `getEngine()` / `getMeta()` / `getExportDocument()` /
  `applyTheme({ mermaidTheme? })`）。
- `markdownRenderer`：Renderer 形态（buffer + Detection 协议，结构兼容 core
  `Renderer`，供 dispatcher/宿主装配）；超大输入降级为包内纯文本视图（宿主可经
  `options.renderOversize` 注入原 code 渲染器形态的降级实例）。

### options 全集（MarkdownViewOptions）

| 选项 | 缺省 | 说明 |
| --- | --- | --- |
| `highlightFence` | 包内默认 tree-sitter | 围栏高亮回调（worker client 桥接缝） |
| `highlight` | CDN 默认 | 默认高亮器选项（baseUrl/table/queries/queriesUrl/runtimeDir/languages） |
| `markdownBackend` | 模块注入→本地引擎 | 正文引擎后端（compute 路由） |
| `resolveRemoteBase` | 恒 null | 远程计算来源决策（原 `getRemoteBase` 切断点） |
| `resolveImage` | src 原样 | 相对图片解析器（blob URL 生命周期由视图托管） |
| `diagram` | 注册表语义 | 图表选项（krokiHost/mermaidTheme/modeOf/krokiVia/rendererOf/serverDiagramOf/krokiProxy/remoteCall，可部分注入） |
| `ui` | 中文缺省 | 管线文案（copyTitle/copyLabel/copiedLabel/copyFailedLabel/diagramLabel/sourceLabel/krokiErrorText/officialErrorText） |
| `themeClassPrefix` | 无 | 管线生成元素类名前缀 |
| `source` | 空 | 文档来源上下文（storeId/path，供后端路由） |
| `renderOversize` | 包内纯文本降级 | 超大输入降级渲染器 |

### 低层转出口

- 管线：`runPipeline` / `runSteps` / `getPipelineSteps` / `PipelineCtx` /
  `PipelineStep` / `PipelineUiTexts`。
- enrich：`enrichMarkdownDom`（媒体替换/callout/wikilink/任务列表归一）。
- 渲染器零件：`assignHeadingIds` / `remapHeadingHashLinks` / `extractToc` /
  `slugifyHeading` / `renderMarkdownBody` / `collectTextNodes` / `MARKUP_MAX_BYTES`。
- 导出：`collectExportHtml` / `collectPrintHtml` / `exportBaseCss`（数据面；Blob
  下载/print iframe 触发壳留在宿主应用）。
- 高亮：`createDefaultHighlightFence(options?)`（默认高亮器工厂，宿主可自建后经
  `options.highlightFence` 注入）、`DEFAULT_GRAMMARS_BASE_URL` /
  `DEFAULT_LITE_LANGUAGES` / `normalizeGrammarsBase` / `deriveQueriesBase`。
- 引擎转出口：`renderMarkdownToHtml` / `createMarkdownEngine` /
  `protectLatexDelimiters` / `parseFrontMatter` / `GfmAnchorizer`。
- 灯箱转出口：`removeLightboxOverlay` / `LIGHTBOX_OVERLAY_ID` / `LIGHTBOX_OWNER_ATTR`。

### 模块级注入缝（原 render-text 同款，供应用装配/测试）

`setHighlightFence` / `setMarkdownBackend` / `setResolveRemoteBase` /
`setMarkdownImageResolver` / `setDiagramOptions`（各有对应 getter；传 null 解绑）。
视图路径的 `options.*` 优先于模块缝（`resolveImage`/`resolveRemoteBase` 仅实例选项）。

## 应用侧迁移注记（render-text → 本包）

- **getRemoteBase 切断**：原 `getRemoteBase(source.storeId)` 判定改为
  `setResolveRemoteBase(fn)`（Renderer 路径）/ `options.resolveRemoteBase`（视图
  路径），fn 内复用 core `getRemoteBase` 即可。
- **vv:\* 事件 → applyTheme**：包内不再监听 `vv:appearance-applied` /
  `vv:diagram-settings-applied`；应用切换外观/保存图表设置时，把 mermaid 主题桥接
  到实例 `applyTheme({ mermaidTheme })`（缺参=渲染时快照，等价原 detail 缺省语义）。
- **highlight client 桥接**：原 render-text `attachHighlightClient` 注入的 worker
  client 改为包一层 `HighlightFence`（区间 → `assignIntervalsToLines` +
  `renderLineHtml` → 行 HTML）经 `setHighlightFence` / `options.highlightFence`
  注入；`HighlightCanceledError` 抛出语义（管线静默跳过该块）保持有效。
