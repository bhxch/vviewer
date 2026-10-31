# @bhxch/vviewer-markdown

<!-- npm 包名：@bhxch/vviewer-markdown（monorepo 内部名=发布名，单名方案）。 -->

markdown 完整渲染组合包：一行装配「markdown 引擎 → sanitize → enrich → 五步管线
（highlight / diagrams / katex / copyCode / lightbox）→ 挂载 → heading id → TOC →
导出装配」。自 `@bhxch/vviewer-render-text` 的 `src/markdown/` 迁出参数化而成，渲染行为
默认等价；本包不依赖 `@bhxch/vviewer-core`、`apps/*` 或 render-text（宿主侧 core 值以
结构类型直接传入）。

## 安装

```bash
npm install @bhxch/vviewer-markdown
```

## 快速上手

```ts
import { createMarkdownView } from '@bhxch/vviewer-markdown';
import '@bhxch/vviewer-markdown/markdown.css'; // 完整排版/高亮映射/图表/灯箱样式

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
- **diagram**：五步管线 diagrams 步开启，模式按 `@bhxch/vviewer-render-diagram` 注册表
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

## 自带 Worker 高亮（独立使用进阶，可选）

默认高亮器在主线程逐块 parse（单块有界，常规文档无感）。若代码块偏大/偏多，
不想占主线程：**优先用现成包 `@bhxch/vviewer-markdown-highlight-worker`**——
`attachMarkdownHighlightWorker({ init: { grammarsBase, runtimeDir } })` 一行接入
（worker 入口/协议端/取消语义全现成，dispose 回落默认高亮器），见该包 README。

以下为自托管 worker 文件或想自建协议端时的手工配方——**worker 文件只有两行**：
tree-sitter 引擎、消息协议（init 握手/请求去重/批量取消/看门狗）、区间→行 HTML
的原料全部是 `@bhxch/vviewer-highlight` 的公开导出，第三方只写 RPC 壳（合计约 40 行，
vviewer 本体 apps/web/src/lib/ts-worker.ts + render-text `fenceToHtml` 即同款）。

**worker 文件**（`md-highlight.worker.ts`，由宿主打包器编译）：

```ts
import { serveWorker } from '@bhxch/vviewer-highlight';

serveWorker(); // 非 worker 环境调用是 no-op；引擎配置经 client 的 init 握手带来
```

**主线程**（一次性装配；失败链与默认高亮器一致——`null` → 该块降级 hljs → 原文）：

```ts
import { setHighlightFence } from '@bhxch/vviewer-markdown';
import {
  HighlightClient,
  HighlightCanceledError,
  assignIntervalsToLines,
  renderLineHtml,
  type HighlightInterval,
} from '@bhxch/vviewer-highlight';

const client = new HighlightClient(
  new Worker(new URL('./md-highlight.worker.ts', import.meta.url), { type: 'module' }),
  {
    // 必须以 /grammars/ 结尾（manifest 与 wasm 同目录的发布布局契约）；离线形态
    // 改传 table/queries 直传（见「默认高亮器选项」）
    grammarsBase: 'https://cdn.jsdelivr.net/npm/@bhxch/vviewer-grammars-full@0.1.0/grammars/',
    runtimeDir: 'https://cdn.jsdelivr.net/npm/web-tree-sitter@0.25/',
  },
);

/** 行表构建（wc -l 口径）：'a\nb\n' → ['a','b']；空文件 '' → []。 */
const buildLineIndex = (text: string): string[] => {
  if (text === '') return [];
  const lines = text.split('\n');
  return lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines;
};
/** 行起始偏移（UTF-16，含前序换行符）：'ab\ncd' → [0, 3]。 */
const buildLineOffsets = (lines: string[]): number[] => {
  const offsets: number[] = [];
  let offset = 0;
  for (const line of lines) {
    offsets.push(offset);
    offset += line.length + 1;
  }
  return offsets;
};

setHighlightFence(async (code, lang) => {
  let intervals: HighlightInterval[];
  try {
    intervals = await client.highlight(code, lang); // init 完成前请求由 worker 侧排队
  } catch (err) {
    if (err instanceof HighlightCanceledError) throw err; // 取消：管线静默跳过该块
    return null; // worker 失败/未知语言：该块降级 hljs
  }
  const lines = buildLineIndex(code);
  const byLine = new Map(
    assignIntervalsToLines(intervals, buildLineOffsets(lines)).map((a) => [a.line, a.segs]),
  );
  return lines.map((line, i) => renderLineHtml(line, byLine.get(i))).join('\n');
});
// 逐视图注入则改用 createMarkdownView(el, { highlightFence })
```

注意事项：打包器需支持 `new Worker(new URL(...), { type: 'module' })` 模式
（Vite/webpack 5/Rollup 原生支持）；站点 CSP 需放行 `worker-src`；从 CDN 直接
`import` 本包（无自有 worker 文件）的场景，worker URL 与页面跨域会被浏览器禁止，
需 fetch→Blob→`createObjectURL` 包装或自托管 worker 文件。

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

## 仓库与许可

- 仓库：[bhxch/vviewer](https://github.com/bhxch/vviewer)，源码位于 `packages/vviewer-markdown/`
- 许可：Apache-2.0；第三方依赖许可见仓库 `THIRD_PARTY_NOTICES.md`
