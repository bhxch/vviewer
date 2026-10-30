# @vviewer/render-diagram

『图表围栏 → SVG』引擎适配层：30 类图表语言注册表 + 本地 wasm 引擎（mermaid /
@viz-js/viz / nomnoml / katex / svgbob wasm）+ jsdelivr CDN 直链八引擎 + kroki /
PlantUML 官方服务器 URL 编码。自 render-text markdown 管线迁出的渲染器类通用能力。

边界约定：

- **回退链编排不在本包**：local → kroki → official → 错误卡的多级回落由留守的
  render-text pipeline（`pipeline.ts` renderDiagramBlock）编排，本包只负责单引擎
  渲染，失败一律抛错上交（负结果不缓存，可重试）。
- **图表 SVG 净化不在本包**：`sanitizeDiagramFragment` 由留守 pipeline 调用；
  `data-vv-diagram` 选项参数的对端契约是 render-text/pipeline 与
  server/core/src/compute/diagrams.rs。本包对 sanitize 零依赖。
- 全部第三方引擎为动态 import（mermaid/@viz-js/viz/nomnoml/katex/pako 惰性加载），
  对消费方主 bundle 零增量。

## 公共导出面（`src/index.ts`）

| 符号 | 说明 |
| --- | --- |
| `DIAGRAM_TYPES` / `DiagramType` | 30 类注册表（kroki v0.33.0 对齐）：id/别名/local 启用集/默认模式/kroki 类型名/高亮语言/engine/多渲染器/officialServer 旗标 |
| `resolveDiagramType(lang)` | fence 语言 → 图表类型（小写归一；空串/非图表语言 null） |
| `createKrokiUrl(host, type, source)` | kroki URL：pako deflate(9) + base64url 无填充，host 尾斜杠归一，pako 惰性 import |
| `createPlantumlUrl(source)` | PlantUML 官方服务器 URL：deflateRaw + 官方自定义 base64 字母表（0-9A-Za-z-_），编码向量已对官方服务器实测锚定 |
| `DEFAULT_KROKI_HOST` / `DEFAULT_PLANTUML_HOST` | 默认服务地址常量 |
| `DiagramMode` | `'local' \| 'kroki' \| 'server' \| 'official' \| 'source'` |
| `renderDiagramEngine(engine, source, opts?)` | 单引擎渲染入口；opts `{ mermaidTheme, renderer }`（renderer=hpcc 走 CDN hpcc 引擎） |
| `renderMermaidInto(container, source, theme)` | 就地重渲染 mermaid 容器（外观主题联动）；成功 true，失败 false 保留旧图 |
| `MERMAID_THEMES` / `MermaidTheme` | mermaid 原生五值主题枚举（'auto' 由 app 侧解析后注入具体值） |
| `DiagramEngineId` | 引擎 id 联合：mermaid/graphviz/nomnoml/math/svgbob + CDN 八类 |

`cdnEngines.ts`（renderExcalidrawCdn / renderBpmnCdn / renderVegaCdn /
renderGraphvizHpcc / renderWavedromCdn / renderBytefieldCdn / renderDbmlCdn /
renderD2Cdn 与测试注入口 `__setCdnLoaderForTest`）为包内实现细节，不经根导出；
包内测试以相对引用覆盖。

## CDN 直链隐式依赖面（版本钉死在 `src/markdown/cdnEngines.ts` 代码内）

jsdelivr `+esm` 精确版本运行时拼 URL（`@vite-ignore` 防静态打包），升级需改代码并
同步 `cdnEngines.test.ts` 的精确 URL 断言。当前钉死清单（2026-10-23 实测勘定）：

`@excalidraw/utils@0.1.5`、`bpmn-js@18.31.0`（lib/NavigatedViewer.js 子路径）、
`vega-embed@7.3.0`、`@hpcc-js/wasm-graphviz@1.30.0`、`wavedrom@3.7.0`、
`bytefield-svg@1.11.0`、`@softwaretechnik/dbml-renderer@1.0.31`、`@d2lang/d2@0.1.34`。

## svgbob wasm 构建链（发布前置）

glue（`svgbob_wasm.js` / `svgbob_wasm_bg.wasm`）为构建期产物，不入库（本目录内嵌
.gitignore 排除；根 .gitignore 条目已同步改指本包）；`svgbob_wasm.d.ts`
手写入库保证 typecheck 不依赖构建时序。构建：`pnpm gen:svgbob-wasm`（根脚本）→
`packages/render-diagram/tools/build-svgbob-wasm.mjs` → Rust crate
`packages/render-diagram/tools/svgbob-wasm`
（svgbob =0.7.6 / wasm-bindgen =0.2.129，release opt-level=s + lto，wasm-opt 有则
-Oz，bindgen --target web）。前置 rust toolchain + wasm32-unknown-unknown target +
wasm-bindgen CLI（脚本三级自供给：PATH → ~/.cache/svgbob → 官方 release 下载）。

发布本包必须前置 gen 并把 js/wasm 产物复制进 dist（pack 脚本职责，同 highlight
assets 先例），故列第二批发布。CI 侧 wasm-bindgen 缓存键
（ci.yml/pages-deploy.yml `hashFiles('packages/render-diagram/tools/svgbob-wasm/Cargo.toml')`）
与 rust-cache workspaces 已同步改指本包 crate 路径。

## 测试布局

- `src/markdown/` 同目录同置三件：diagrams.test.ts（注册表/编码往返与官方实锚
  向量）、diagramEngines.test.ts（真渲染 + svgbob wasm fixture 锚）、cdnEngines.test.ts
  （mock loader 精确 URL 断言/finally 收尾/分发委派）。
- `test/mermaidFail.test.ts`：mermaid 真加载失败分支（mock 模块工厂抛错 →
  renderDiagramEngine reject、renderMermaidInto false、负结果不缓存）——承接
  markdownPipeline.mermaidFail.test.ts 随管线留守 render-text 后移交的语义。
- svgbob 真渲染用例缺 gen 产物时 skipIf 兜底；根 vitest include 同时覆盖
  `packages/*/src/**/*.test.ts` 与 `packages/*/test/**/*.test.ts` 两形态。
