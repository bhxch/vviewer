# 设计：Markdown 渲染能力全量对齐 Markpad（图表/KaTeX/扩展语法/lightbox/导出）

- 日期：2026-10-19
- 状态：已评审（brainstorm 确认，待实施）
- 关联：`2026-10-06-vviewer-design.md`（管线/渲染器架构）、`2026-10-09-full-grammar-alignment-design.md`（tree-sitter 高亮）、`2026-10-16-media-error-fallback-design.md`（媒体占位）、后续 `字体系统`/`设置中心` 两 spec（settings schema 演进）

## 1. 背景与目标

2026-10-10 Markpad 格式对比结论：「vviewer 缺 markdown 图表渲染与图片 lightbox」。经本轮核实（源码级），真实差距比该结论更细：mermaid/katex/lightbox/代码块复制/callout/front matter **均已存在**，剩余差距为六块——图表矩阵（graphviz/plantuml 家族/mermaid 主题联动）、KaTeX 细节（mhchem/分隔符/math 围栏）、扩展语法（mark/ins/描述列表/行内脚注/callout 折叠/wikilink）、lightbox 交互增强（缩放/平移/多图导航）、代码块语言徽标、导出 HTML/PDF。

目标：对齐参考实现 `/share/rw/repo/markpad-aio/Markpad`（v2.8.4，Tauri + comrak 单引擎），按 vviewer 的 web 只读查看器与双引擎（本地 markdown-it / 服务端 comrak）架构适配。

### 已拍板的决策（brainstorm 记录）

| 决策点 | 结论 |
| --- | --- |
| 图表矩阵 | **全对齐 markpad 11 类**；本地图表引擎全部懒加载动态 import；svgbob 在 vviewer 走 kroki（不引入 markpad 的 Rust 侧 layout-rs/svbob 服务端渲染，避免扩服务端面） |
| 扩展语法 | **全量**：`==mark==`/`++ins++`/描述列表/行内脚注/callout 折叠后缀/wikilink（`[[#heading]]` 锚跳转 + `![[img]]` 嵌入）；wikilink 跨文件跳转不做（多根目录解析复杂，`[[file...]]` 形态降级为字面链接） |
| 硬换行 | **保持 GFM**（`breaks:false`），不对齐 markpad 的 `hardbreaks:true`（编辑器场景选择；查看器以 CommonMark/GFM 语义为准） |
| 导出 | **移植 markpad 方案**适配 web：HTML=自包含单文件（内联样式+图片 data URI+KaTeX 字体裁剪）；PDF=隐藏 iframe 打印模板（`@page` 分页保护+大图缩放），浏览器原生出 PDF，零依赖 |
| 双引擎一致性 | 扩展语法双端同步实现（markdown-it 插件 + comrak extension 开启）+ 一致性锚测试；wikilink/callout 折叠放前端 enrich 层（引擎无关，天然一致） |

### 非目标

- 不做公式编号/`\eqref` 引用体系（markpad 亦无）。
- 不做 markpad 的可点击回写任务列表（只读查看器无源文件回写）、front matter 可编辑面板。
- 不做 `~sub~`/`^sup^`/`||spoiler||`/emoji 短代码（markpad 刻意不启用，同裁决）。
- lightbox 不做触摸捏合缩放与旋转（markpad 无；移动端用按钮缩放）。
- 导出不含音视频媒体本体（`<video>/<audio>` 占位降级为链接，防 data URI 爆炸）。
- 不引入服务端图表渲染能力（kroki 覆盖）。

## 2. 阶段一：图表矩阵

### 2.1 图表注册表（移植 markpad `src/lib/diagrams.ts` 结构）

新模块 `packages/render-text/src/markdown/diagrams.ts`：类型注册表 + 分发，接管现有 `pipeline.ts` 内联 mermaid 步（`runDiagrams` 重写为查表分发，`language-mermaid` 特判退役）。

| fence 语言 | 别名 | 默认模式 | 本地引擎（全懒加载） |
| --- | --- | --- | --- |
| mermaid | — | local | `mermaid`（已有依赖，维持 11.x 现行版本） |
| graphviz | `dot` | local | `@viz-js/viz`（wasm） |
| plantuml / c4plantuml / ditaa / blockdiag / nwdiag / actdiag / seqdiag / erd / pikchr | — | kroki | — |
| svgbob | — | kroki | —（markpad 默认 rust 不移植） |
| excalidraw | — | local | `@excalidraw/utils` |
| nomnoml | — | local | `nomnoml` |
| bpmn | — | local | `bpmn-js` |
| vega / vegalite | `vega-lite` | local | `vega-embed` |
| math | `latex` | local | KaTeX display（阶段二接线） |

- 每类渲染模式可按语言切换 `local | kroki | source`（仅源码高亮），settings 持久化：`diagrams: { krokiHost: string; modes: Record<string, mode> }`（settings.ts 白名单扩展；面板新增「图表」节。spec 6 设置中心落地后迁移 UI，schema 不再变）。
- 未注册语言的 fence 不受影响（走高亮步）。

### 2.2 kroki 通道

- 移植 markpad `kroki.ts`：pako deflate + base64url → `{krokiHost}/{type}/svg/{data}`，以 `<img>` 承载；默认 `https://kroki.io`，可在设置改自架 host。
- sanitize 允许 img src 指向配置的 kroki host（sanitize.ts URI 白名单加动态源——host 来自用户设置，按「用户自配置外域」放行并注记隐私语义：图源数据将发往该服务）。
- kroki 渲染失败保留源码卡片 + 错误态（对齐现有 mermaid 失败形态）。

### 2.3 mermaid 主题联动 + 图/源码切换

- `mermaid.initialize` 补 `theme`：按当前解析亮暗（`data-theme-mode` + prefers-color-scheme + appearance 主题基色）映射 `'dark' | 'default'`。
- 主题切换重画：外观签名变化时对已挂载的 `data-mermaid` 容器以新主题重渲染（mermaid 色彩烘焙进 SVG 不可反演，重画失败保留旧图）——挂到 `applyAppearance` 订阅点（theme.ts 中心化订阅已有）。
- 每个图表 wrapper 加「图 / 源码」切换钮（markpad 全局点击委托同款）：源码侧按 `DIAGRAM_HIGHLIGHT_MAP` 高亮（graphviz→dot、bpmn→xml、math→latex 等，tree-sitter 优先 hljs 兜底）。

### 2.4 PWA 体积防线

本地图表引擎动态 chunk 不进 SW precache（`vite-plugin-pwa` globPatterns 排除图表 chunk 命名规则，运行时缓存承接），防止 precache 膨胀数 MB。bpmn-js/vega-embed 体积大，懒加载后首用有一次网络等待（与 mermaid 现状同语义）。

## 3. 阶段二：KaTeX 对齐

- **mhchem**：管线 katex 动态 import 同处追加 `katex/contrib/mhchem`（**必须 `.mjs` 裸子路径**，markpad #745 教训：`dist/contrib/*.js` 的 CJS 副本会产生第二个解析器、宏表分裂）。`$\ce{CO2}$` 可用。
- **分隔符扩展**：`scanMathSegments`（pipeline.ts）在 `$..$`/`$$..$$` 之外增加 `\(...\)` 行内与 `\[...\]` 块级识别；跳过祖先规则复用（code/script/style/`.katex`）。转义 `\$` 不触发（沿用现有扫描语义）。
- **` ```math ` 围栏**：注册表 math 槽（2.1），`katex.renderToString(displayMode:true)`；高亮步跳过清单补 `language-math`（同 mermaid 现状）。别名 `latex` 同路由。
- 无编号体系（非目标）。

## 4. 阶段三：扩展语法 + 代码块语言徽标

### 4.1 双引擎同步项（需一致性锚测试）

| 语法 | markdown-it 侧 | comrak 侧 | 备注 |
| --- | --- | --- | --- |
| `==mark==` | `markdown-it-mark` | `options.extension.highlight = true` | `<mark>`；sanitize 默认放行，确认即可 |
| `++ins++` | `markdown-it-ins` | `options.extension.insert = true` | `<ins>`（Pandoc/CriticMarkup 拼法） |
| `; term` / `: def` | `markdown-it-deflist` | `options.extension.description_lists = true` | `<dl>/<dt>/<dd>` sanitize 确认 |
| `^[行内脚注]` | 自写 inline rule，产出与 `markdown-it-footnote` 同构节点（并入同一 footnote env 计数，防 id 撞 `[^1]`） | `options.extension.inline_footnotes = true` | 无现成插件，风险项；失败降级字面渲染并记档 |
| ```` ```math ```` | 无需（fence 原样透出） | 无需 | 阶段二前端路由，双引擎天然一致 |

- comrak 版本 0.56 的 extension 字段名以实施时 API 为准（上表为 markpad 0.54 同名推断，冲突时以 cargo doc 校正）。
- **一致性锚测试**：双引擎金标语料（每语法 ≥2 例，含与代码块/HTML 混排），本地 markdown-it 渲染 vs 服务端 comrak compute 渲染 DOM 结构等价断言（沿用 M3 双引擎测试基建）。

### 4.2 引擎无关项（enrich.ts 前端 DOM 后处理，单实现双端一致）

- **callout 折叠后缀**：`> [!note]+` / `> [!note]-` 解析 → 可折叠卡片（`+` 默认展开、`-` 默认收起），标题钮点击切换；现有 callout 转换（enrich.ts:88）扩展。
- **wikilink**：全文前端处理（CommonMark 下 `[[...]]` 双引擎均输出字面文本，enrich 层文本节点扫描即可，无分叉）：
  - `[[#heading]]` → 锚链接，改写指向本页 `user-content-` id（复用 GfmAnchorizer 基名算法）；目标不存在则渲染为不可点样式；
  - `[[file]]` / `[[file#heading]]` → 按已拍板降级：渲染为链接样式的字面文本（不可点），title 注记「跨文件 wikilink 不支持」；
  - `![[img.png]]` / `![[img.png|100]]` / `![[img.png|100x50]]` → `<img>`，相对路径经 `markdownImages.resolveImageBlobUrl` 同链路解析，`|` 尺寸段转 width/height 属性（属性值转义）。
- **代码块语言徽标**：copyCode 步补 `.lang-label`（取 `code[class*=language-]` 首词），无语言显示复制图标；点击徽标=复制（对齐 markpad 交互），现有「复制」按钮语义并入徽标。

## 5. 阶段四：lightbox 增强

现有 body 级单例 overlay（pipeline.ts lightbox 步）扩展为 markpad `ZoomOverlay` 同交互集：

- **缩放**：按钮 + 滚轮（以光标为中心）+ `+`/`-`/`=` 键，MIN/MAX 限幅；`r`/`f` 重置视图。
- **平移**：拖拽（grab 光标）。
- **多图导航**：画廊收集文档内 `img` 与已渲染图表 SVG（跳过 <32px 小图、KaTeX 块），prev/next 钮 + ←/→ 方向键；Esc 关闭。
- owner 代币防多实例互删语义保留；移动端按钮缩放（无捏合，非目标已声明）。

## 6. 阶段五：导出 HTML

- **入口**：MetaPanel 新增「导出」动作区（仅 markdown 渲染 tab 生效，非 markdown tab 不显示）：`导出 HTML` / `导出 PDF` 两钮；产出经浏览器下载。
- **内容**：克隆管线完成后的 DOM（代码已高亮、公式已排版、图表已成 SVG），lightbox/复制钮等交互壳剥离。
- **样式内联**：当前生效主题的 `--vv-*` 变量集 + 代码主题注入样式块（`</style` 转义防护）+ 基础排版样式，合成单 `<style>`。
- **图片 data URI**：`blob:`/同源相对图 fetch→base64 内联；外域 http(s) 图保留原 URL（CORS 不可控，不强拉）；音视频占位降级为源地址超链接（非目标已声明）。
- **KaTeX 字体裁剪**：按文档实际用到的 KaTeX 字体族嵌 `@font-face`（移植 markpad `exportFonts.ts` 思路，全嵌约 395KB，按需裁剪）。
- **TOC**：静态锚目录（标题层级列表 + 锚链接，无滚动跟踪脚本——YAGNI 裁剪，markpad 的交互 TOC 脚本不移植）。
- front matter：按预览现状一并输出（不做导出专属形态）。
- mermaid 保持当前主题（WYSIWYG；打印浅色主题仅 PDF 路径用）。

## 7. 阶段六：导出 PDF

- 移植 markpad WebView 打印方案（无 puppeteer、零依赖）：隐藏 iframe 载入打印版 HTML（复用阶段五样式合成 + `@page` 规则 + `@media print` CSS），`contentWindow.print()` 由系统打印对话框出 PDF。
- 页型：a4/a3/letter/legal/**dynamic**（单页动态高度：实测 iframe scrollHeight 后注入精确页高）。
- 分页保护：PRE/TABLE/FIGURE/SVG 等不可断标签 `break-inside: avoid`；大图按页高 95% `max-height` 缩放防跨页。
- mermaid 打印主题：PDF 路径强制浅色重画（markpad `mermaidPrint.ts` 同思路），避免暗色图在纸面不可读。
- Chromium 下 iframe 内 `print()` 需用户手势触发（导出按钮点击链路内，天然满足）；若 iframe print 被策略拦截，降级 `window.print()` + 打印样式表作用域方案（实施时验证择一，不双轨并存）。

## 8. 测试

- 单测：图表注册表分发/别名/模式回退、kroki URL 编码（pako+base64url 向量）、math 扫描器新分隔符与跳过规则、wikilink 四形态、callout 折叠、徽标、lightbox 状态机（缩放限幅/画廊收集过滤）、导出样式合成与字体裁剪、data URI 转换（blob/外域/失败降级）。
- 一致性：4.1 双引擎金标语料。
- e2e：图表渲染冒烟（graphviz local / plantuml kroki 走 mock host）、math 围栏、wikilink 锚跳、lightbox 键盘全交互、导出 HTML 下载内容断言（jsdom 侧 DOM 快照 + playwright 下载事件）、PDF 打印模板 iframe 结构断言。
- PWA：preache 体积门禁（图表 chunk 排除生效）。
