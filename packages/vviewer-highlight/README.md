# @bhxch/vviewer-highlight

代码高亮生态包：web-tree-sitter 高亮引擎（grammar/queries 资产装载、injection 递归、
chunk 子文本解析、worker 化）+ capture→CSS 绑定核（capture 归约/类名/变量名映射层）
+ 区间→行 HTML（嵌套区间展平、按行分配、搜索命中叠加）。

## 子路径导出

| 路径 | 内容 |
| --- | --- |
| `.`（`src/index.ts`） | 引擎/主题/langdetect/worker 全量：`TreeSitterEngine`、`HighlightClient`、`createHandler`/`initWorker`/`serveWorker`、`detectLanguage`、`expandQuery(Async)`、`validateVscodeTheme`/`tokenColorsToThemeTable`/`themeToCssVars`、`CODE_CAPTURES`、`resolveCaptureClass`、`CAPTURE_CLASS_PREFIX`、`CAPTURE_VAR_PREFIX` 等 |
| `./lines`（`src/lines.ts`） | 区间→行 HTML 生态：`flattenIntervals`、`assignIntervalsToLines`、`mergeChunkLines`、`splitHighlightedLines`、`overlaySearchHits`、`renderLineHtml`、`lineOf`、`escapeHtml`、类型 `LineSeg`/`LineAssignment`/`SearchHitOverlayOptions` |
| `./assets/*`（`assets/`） | `languages.json`、`themes.json`、`queries/<lang>/*.scm`、`vscode/{dark,light}_modern.json`、`LICENSE-README.md`（schema 与本包 `queries.ts`/`vscode.ts` 消费面配套） |

exports 字段落地即封闭子路径集合——新增深路径消费必须同批补 exports 条目。

## lines 子路径的两类消费形态

`assignIntervalsToLines`/`mergeChunkLines`/`renderLineHtml`/`flattenIntervals` 消费
tree-sitter 引擎产出的 `HighlightInterval[]`（本包 `.` 导出的类型）。

`splitHighlightedLines`/`overlaySearchHits` 则**服务于宿主自备 highlight.js 输出的
降级场景**：它们只消费 hljs 产出的高亮 HTML 字符串（跨行 span 闭合/重开惯例、
`&amp;/&lt;/&gt;` 实体约定），本包不依赖 highlight.js，hljs 由宿主自带。
`overlaySearchHits(html, hits, options?)` 的 `options.hitClass` 参数化命中段
`<mark>` 类名（默认 `'vv-search-hit'`，宿主查看器既有语义不随包承诺）。

行 span 类名由 `renderLineHtml` 统一经 `resolveCaptureClass` 归约到
`CODE_CAPTURES`（53 个）最近语义父级再点转 `-`，前缀来自 `CAPTURE_CLASS_PREFIX`
（`'ts-'`）；CSS 变量前缀 `CAPTURE_VAR_PREFIX`（`'--vv-ts-'`）。类名 ⊂ 清单 ⇒
每个 span 都有宿主 app.css 的 `.ts-*` 规则与注入变量（app 侧 theme 双向测试锁定，
53 条规则一一对应）——改前缀或清单须同批改宿主样式与对齐测试。

## web-tree-sitter 运行时锁（升级纪律）

运行时锁 `~0.25.10`（package.json `"//"` 注记）：grammar wasm 已改为
tree-sitter-cli 0.27 自建（产物含 dylink.0 节，实测 0.25 运行时可加载解析）；
0.27 运行时强制要求 dylink.0 且运行时文件更名 `web-tree-sitter.wasm`。升级须
另行评估 grammar 产物兼容性并全量跑 `test/runtime.test.ts`、
`test/local-grammars.test.ts`、`test/queries-remote.test.ts`，不得随小版本顺带。

## 发布注意（首批上 npm）

- monorepo 态 exports 指 `src/*.ts` 与包根 `assets/`；发布态 package.json 由
  pack-packages.mjs 复制改写到 dist，`'./assets/*'` 相对形式不变即指
  `dist/assets/`，两态路径一致。
- `tsc` 只 emit `.js`/`.d.ts`，assets 不会进 dist——pack-packages.mjs 需显式
  `cp -r assets dist/`；files 白名单（`assets/queries`、`assets/languages.json`、
  `assets/themes.json`、`assets/vscode`、`assets/LICENSE-README.md`）即发布资产面。
- 发布版去 `private` 由 pack 脚本产出（同 `tools/grammar-builder/pack-npm.mjs`
  惯例），workspace 态保持 `private: true`。
- assets 体积 ~5.3M（queries 307 语言目录为头部）；`queries/` 各语言 `.scm` 与
  `LICENSE-README.md` 的分发义务见其内说明。
