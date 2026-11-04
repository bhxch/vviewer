# file-viewer 引入增强 · 设计文档

- 日期：2026-11-04
- 状态：待用户批准（brainstorm 产物，获批后转 writing-plans）
- 调研依据：`docs/file-viewer/format-package-survey-2026-11-04.md`（47 管线逐行对照、许可证红线、覆盖矩阵）
- 用户决策记录（brainstorm 两轮四题+三题+builder check 收口，全部拍板）：①引入范围=全量（npm 引入、不进主包；LicenseRef-PMEL 取 MPL-2.0 面；bpmn-js 排除 npm 依赖——md 管线既有运行时 CDN 加载姿态不变）；②data-asset=引 data 包，wasm 与字体查看都开；③音频=补别名+引 capability-midi；④图片=引 renderer-image 仅新 5 扩展名；⑤图表拆分=全集（29 型，builder check 补漏 7 型后收口）；⑥默认模式=默认渲染失败回退源码，引擎形态以 vviewer 图表注册表实态为准（七类 CDN 本地引擎非 kroki）；⑦drawio=引官方运行时；⑧**部署=大资产不进本项目 dist，Pages/Workers/桌面均不背重资产；资产包优先直接用 file-viewer 已发布的 @file-viewer/assets-\*（CDN 直链精确版本），除非必须二次封装并发包**；⑨**桥接契约=方案 A**（嵌套附件回调走 vviewer dispatcher；.shp 边车经 resolveSibling 统一回调读兄弟文件——§6.4 细化：L1/R1/R2/L3 来源全适用，仅裸单文件降级报错）；⑩**远端全量物化：进度卡无分级全量级显示**（地址·进度·速度·ETA·已下载/完整大小·取消，size 未知不定态）+**确认门阈值可设**（settings 远端下载确认阈值，默认 512MB，先确认后下载，知情自担无独立硬上限，size 未知不适用）+**另存为双形态**（完成后另存为 FS Access 主/blob 兜底；下载并另存为=泵写盘+getFile 回填盘 backed File 免内存峰值）；⑪**URL 通道维持 v1 不启用**（桥接集零渐进式消费者；上游唯一渐进式=renderer-pdf URL-only pdfjs Range I/O；直连 S3 动态签名不可直链 URL 已记档）；⑫**vviewer 自有 pdf 接 Range 能力转正本批**（PDFDataRangeTransport 接 ctx.read，§6.6）。

## 1. 背景与动机

vviewer 网页版只读查看器现有 12 个自研渲染器，格式面与 file-viewer（flyfish-dev/file-viewer 3.3.3，Apache-2.0）存在系统性互补：vviewer 占优大文件流式/语法高亮/hex 增强/markdown 管线；file-viewer 占优 Office 全家桶、区域格式（OFD/HWP/iWork/WordPerfect）、阅读类（EPUB/FB2/UMD）、工程类（CAD 除外——AGPL 红线）、设计类与数据类（SQLite/Parquet/Avro）。调研确认其包家族可 npm 直引、许可兼容（排除两条红线后），本设计按三批渐进引入，全部许可决策已在调研报告中钉死。

## 2. 目标 / 非目标 / 反目标

**目标**
1. 修复 vviewer 侧扩展名绑定缺口并补齐第三方台账（本批快赢）。
2. markdown 已支持的图表类型拆出独立文件渲染器：双击即图形预览，可切源码模式。
3. file-viewer 许可允许的包全量引入（npm 依赖 + 动态 import，逐包落地），形成「每扩展名一个默认渲染器 + open-as 随时切换」的统一形态。

**非目标**
- 不引入 `renderer-cad`（AGPL-3.0-only）、`renderer-3d`（occt-import-js LGPL-2.1）及连带 `preset-all`/`preset-engineering`/全部 `*-full` 壳——许可红线不可谈判。
- 不引入 bpmn-js（bpmn.io 自有许可）——drawing 包的 BPMN 为显式 opt-in，不启用即不存在；`.bpmn` 文件仍走 vviewer Kroki（批次二已覆盖）。
- 不引入 `renderer-text`/`renderer-ppt`/`renderer-pdf`/`renderer-archive`/`renderer-binary`（对应面 vviewer 占优或已有同库实现，见 §6.3 排除清单）。
- 不改 vviewer 既有渲染器的内部实现（流式/虚拟滚动/消毒链全部原样）。
- 不追求 file-viewer 与 vviewer 渲染器间的搜索契约互通（file-viewer 渲染器暂不支持 vviewer SearchMatch，见 §6.4）。

**反目标（做了即失败）**
- 任何 file-viewer 代码/资产进入主 chunk 或 PWA precache（体积回归）。
- 同一扩展名在 registry 出现双 owner（装配冲突静默吞掉其一）。
- 引入顺序导致中间态默认渲染器降级（如 tsv 先 code 后 spreadsheet 的转移没有随包完成）。

## 3. 约束

- vviewer 渲染器契约：`Renderer.render(buffer, target, source, det, ctx?, opts?)`（`packages/vviewer-core/src/types.ts:166` 附近），registry 一扩展名一 owner，`installFallbackExtensions` 只补空位（专有先注册是装配铁律）。
- 桥接渲染器声明 `streaming: false` → dispatcher 自动走全量物化路径（回退矩阵既有契约）；原 512MB 硬防线在该通路改为**可设阈值的确认门**（§6.4），Range 流式源在 dispatcher 层补拉，桥接层零感知。
- 第三方引入约束（THIRD_PARTY_NOTICES.md 头注）：仅收 MIT / Apache-2.0 / BSD / ISC / MPL-2.0；双许可取其一需显式记录。
- 部署面三形态同源 dist：Pages（子路径 base）、桌面 Tauri、Cloudflare Workers（assets_fallback）；PWA precache 预算门禁既有（`tools/diagram-budget.mjs` 先例）。
- kroki-only 图表类型渲染依赖 krokiHost（settings.diagrams 既有配置），离线场景由失败回退兜底（§5.3）。

## 4. 批次一：卫生批（绑定缺口 + 台账补齐）

### 4.1 扩展名绑定修复

| 缺口 | 修复 | 位置 |
| --- | --- | --- |
| hex 渲染器不认 `.hex` | `hex` 加入扩展名清单 | `packages/vviewer-render-binary/src/hex.ts:785` |
| av 未绑 `.mpeg`/`.weba` | `mpeg`、`weba` 加入扩展名清单 | `packages/vviewer-render-media/src/av.ts:356` |
| `.tsv` 无归属 | `tsv` 加入 code 内置清单（临时落点；批次三引入 renderer-spreadsheet 时**转移**至其桥接渲染器——表格化优于纯文本，转移时从内置清单移除并原子提交） | `packages/vviewer-render-text/src/code/index.ts:54` |

三个扩展名均无 registry 冲突（generated 670 项不含 hex/mpeg/weba/tsv，实测）。

### 4.2 THIRD_PARTY_NOTICES 补齐

补三行（均为 2026-10-19 图表批引入，遗漏未入账）：

| 组件 | 许可 | 用途 | 引入里程碑 |
| --- | --- | --- | --- |
| @viz-js/viz | MIT | graphviz 本地渲染（render-diagram） | md-diagrams 批 |
| nomnoml | MIT | nomnoml 本地渲染（render-diagram） | md-diagrams 批 |
| pako | MIT AND Zlib | kroki URL deflate 编码（render-diagram） | md-diagrams 批 |

### 4.3 验收

- 单测：三个绑定扩展名的 registry 锚（byExtension 返回正确 renderer）；既有 vitest 全绿（无行为变更面）。
- 手验：`.hex`/`.tsv`/`.mpeg` 样例文件走正确渲染器。

## 5. 批次二：图表类型拆独立渲染器

### 5.1 类型与扩展名映射（全集 29 型 / 33 扩展名）

依据 vviewer 图表注册表（`vviewer-render-diagram/src/markdown/diagrams.ts`，30 型对齐 kroki v0.33.0；`math` 不拆——`.tex` 维持 latex 源码高亮；`drawio` 不在注册表中，归批次三官方运行时）。**引擎形态/默认模式以注册表实态为准（builder check 核实）**：excalidraw/bpmn/vega/vegalite/dbml/wavedrom/bytefield 七类为 CDN 直链本地引擎、defaultMode local（@excalidraw/utils、bpmn-js NavigatedViewer、vega-embed、dbml-renderer、wavedrom、bytefield-svg——bpmn-js 沿用 md 管线既有运行时 CDN 加载姿态，不作 npm 依赖），与 md 围栏行为一致，不降级为 kroki 网络渲染：

| 图表类型 | 扩展名 | 引擎形态 | 默认模式 |
| --- | --- | --- | --- |
| mermaid | mermaid, mmd | local（mermaid 12） | local |
| plantuml / c4plantuml | plantuml, puml / c4plantuml（造） | kroki（settings.diagrams.krokiHost） | kroki |
| graphviz | dot, gv | local（@viz-js/viz） | local |
| d2 | d2 | kroki（defaultMode 例外，既有注册表裁定） | kroki |
| dbml | dbml | CDN 本地（dbml-renderer） | local |
| vega / vegalite | vega, vg（后两个造）/ vl | CDN 本地（vega-embed） | local |
| excalidraw | excalidraw | CDN 本地（@excalidraw/utils） | local |
| bpmn | bpmn | CDN 本地（bpmn-js NavigatedViewer，运行时 CDN） | local |
| nomnoml | nomnoml（造） | local | local |
| svgbob | svgbob | local（wasm） | local |
| pikchr | pikchr | kroki | kroki |
| ditaa | ditaa | kroki | kroki |
| blockdiag / nwdiag / actdiag / seqdiag | 同名（造） | kroki | kroki |
| erd | erd | kroki | kroki |
| structurizr | dsl | kroki | kroki |
| bytefield | bytefield（造） | CDN 本地（bytefield-svg） | local |
| wavedrom | wavedrom（造） | CDN 本地（wavedrom） | local |
| tikz | tikz（造） | kroki | kroki |
| umlet | uxf（通行格式扩展名） | kroki | kroki |
| goat | goat（造） | kroki | kroki |
| wireviz | wireviz（造） | kroki | kroki |
| packetdiag / rackdiag | 同名（造） | kroki | kroki |
| symbolator | symbolator（造） | kroki | kroki |

标「造」= 无通行扩展名，注册一个类型同名（或格式约定，如 umlet→uxf）的扩展名。扩展名与 generated 670 项的重叠（dot/gv/mermaid/mmd/bpmn/dbml/d2 等已实测在册）由「专有先注册、generated 补空位」机制天然消解，装配顺序必须保证图表渲染器先于 fallback 安装。

### 5.2 渲染器形态

- 落位：`packages/vviewer-render-text/src/diagramFile.ts`（**实施修正**：原定 diagram 包落位与 markdown→diagram 既有依赖成环——文件渲染器需回退复用 render-text 的 renderCode；render-text 已依赖 diagram/highlight，零新依赖零环，id 命名与分发设计不变），每类型导出一个 Renderer 实例（id `diagram-<type>`），装配点统一安装。
- 渲染：读全量文本 → 按类型走既有 pipeline 三分发（local 引擎本地渲染 / kroki 经 krokiHost / server-served 优先服务端）→ 产出 SVG/HTML 注入 target。产出物复用 markdown 管线的 sanitize 钩子（图表 SVG 过消毒链）。
- 失败回退：渲染异常（引擎加载失败/网络失败/语法错误）自动落源码视图——复用 `renderCode`（同一高亮链，类型对应语言如 mermaid/dot 有 tree-sitter 语法）+ 状态条提示（复用 showStatusNotice 通道）。
- 源码/渲染切换：渲染器内 toggle（交互与样式复用 html 渲染器 `html.ts` 的源码/渲染双视图先例：默认渲染视图，一键切源码再切回，切换不重读文件）。Tab.overrideRenderer/open-as 机制照常可用（切到 code 渲染器为持久 Tab 级 override）。
- 大文件：图表源文件超过 2MB 直接落源码视图（图表源超此规模渲染无意义），提示走错误卡片文案。

### 5.3 验收

- 单测：类型→扩展名映射表全锚、registry 无冲突、失败回退分支（引擎抛错→源码视图）。
- e2e：local 型渲染锚（mermaid 样例 SVG 出现）、CDN 本地型渲染锚（excalidraw/vega 等七类按 CDN 引擎形态）、kroki 型 mock krokiHost 渲染锚、失败回退锚（kroki 断网→源码+提示）、切换锚（渲染↔源码往返）、`.dot` 抢注锚（graphviz 渲染器而非 code 兜底）。

## 6. 批次三：file-viewer 逐包引入

### 6.1 桥接层（一次性基建，契约深度=方案 A，用户拍板）

新包 `packages/vviewer-render-foreign/`：
- `bridge.ts`：`wrapFileViewerRenderer({ id, label, extensions, mount }) → Renderer`——render 内把 `Uint8Array` 物化为 `Blob`（dispatcher 已保证全量视图），调 file-viewer 浏览器 API 渲染进 target；destroy 对接其 unmount/lifecycle。
- **嵌套回调（方案 A）**：桥接层向 file-viewer 宿主契约提供嵌套渲染回调（对应其 `renderNestedBuffer` 缝，`file-viewer/packages/core/src/contracts/types.ts:971`）——附件 buffer 经 **vviewer 既有 dispatcher（byExtension）** 承接（pdf/image/docx 等全是 vviewer 强项，零新依赖）；dispatcher 无对应渲染器的附件回落下载。邮件附件内嵌预览因此开箱可用，不重做桥接面。数据源对接全貌（分来源 × 分渲染器）见 §6.4。
- **`.shp` 边车**：`resolveSibling` 统一回调经 store 读兄弟文件（L1/R1/R2/L3 全适用），裸单文件降级错误卡——细化见 §6.4。
- file-viewer 侧入口以其 README 为准（`@file-viewer/core/browser` 的 `mountViewer`/组件化 API；`core/headless` 的 `precheckFileViewerSource` 可选用于预检），实施时按其 v3.3.3 实际 API 适配——此处只钉死桥接方向与契约映射，具体 API 调用形态是实施者自由度。
- 不支持 SearchMatch：MetaPanel 搜索入口对桥接渲染器 tab 显示「当前渲染器不支持检索」禁用态（复用既有状态通道，不新增机制）。
- opts.signal 透传：destroy/取消时调 file-viewer 的销毁路径；abort 语义对齐 vviewer `abortReadError` 分类（批次外的既有错误身份层）。

### 6.2 资产部署（大资产不进本项目 dist，优先直用上游已发布资产包，用户拍板）

**原则**：file-viewer 的 JS 代码包走常规 npm 依赖 + rolldown 动态 import（chunk 分离进 dist，mammoth 先例）；**Worker/WASM/字体/vendor 大资产不进 dist、不进 PWA precache、Pages/Workers/桌面三形态都不背**；客户端三层资产解析链（同源 dist → 服务端 origin → CDN）沿既有机制，CDN 层**默认直链 file-viewer 已发布的资产包**（`https://cdn.jsdelivr.net/npm/@file-viewer/assets-<x>@3.3.3/viewer/…`，其 package.json `files` 含 `viewer/` 目录，发布面已确认）。**仅当直接使用不可行时才二次封装发包**（用户原则：「除非必须二次封装并发包，不然优先用 file-viewer 已经发布的包」）。

**需要新增的 npm 包（vviewer 侧发布）：默认 0 个**。

预案包（仅触发以下任一条件时才创建发布）：`@bhxch/vviewer-foreign-assets`（grammars 前例全套发布链：contentHash 去重门、OIDC provenance、jsdelivr 精确版本钉死），触发条件——
1. 上游资产包存在超 jsdelivr 单文件 20MB 上限的文件（assets-typst 编译器 wasm、assets-drawing diagrams.net bundle 需实测，实施首任务核实）；
2. 上游 assets 包的 manifest/installer 结构无法脱离 asset-installer 直接以 URL base 方式伺服（receipt 字段等 installer 耦合项需重组）。
触发时只聚合出问题的资产组，其余继续直链上游包；发布形态（单包 vs 按资产组拆分）按 grammars 前例（npm 单包解包 228MB 已验证可行）默认单包。

**需要直接引入的 npm 包（file-viewer 侧）**：

- 代码依赖（23 个，构建期 chunk 分离）：核心 `@file-viewer/core`；渲染器 `@file-viewer/renderer-email` `-epub` `-ofd` `-chm` `-word` `-presentation` `-spreadsheet` `-iwork` `-hangul` `-wordperfect` `-data` `-design` `-image` `-geo` `-typst` `-dicom` `-signature` `-eda` `-drawing` `-media`（末者为 capability-midi 宿主，其媒体扩展名不注册）；能力 `@file-viewer/capability-rtf` `-midi` `-drawio-official`
- 资产包（7 个，**不入构建**，运行时 CDN 直链精确版本）：`@file-viewer/assets-standard` `-data` `-design` `-drawing` `-hangul` `-iwork` `-typst`

**版本锁定纪律（用户拍板：必须精确锁定，避免静默升级）**：全部 30 个直引包（代码 23 + 资产 7）在 package.json 写**无 `^`/`~` 前缀的精确版本**（pnpm add 默认加 `^`，须显式剥除）；lockfile 入库；资产 CDN URL 与代码依赖钉**同一版本号**；上游升级是显式决策——单独 commit 改版本号（代码+资产 CDN 同步）+ e2e 重锚，禁止任何 range 让 `pnpm install`/lockfile 刷新静默带新版本。CI 加一道白名单校验：`@file-viewer/*` 与涉外依赖声明必须无范围前缀（仿既有 gen-code-extensions `--check` 惯例）。

**运行时**：各桥接渲染器首次打开对应扩展名时经三层链按需 fetch 资产；SW 对 CDN/该前缀设 CacheFirst（运行时缓存，不进 precache）。

**门禁**：新增 foreign 预算门禁（仿 `tools/diagram-budget.mjs`）——主 chunk 与 precache 清单断言不含 `@file-viewer/*` 代码面误入主 chunk（动态 import 面）、dist 无 file-viewer 资产目录。

### 6.3 引入清单与扩展名默认面总表（核心交付物）

规则（用户拍板）：§4.1 调研报告「vviewer 已覆盖且占优」的面与批次二新增图表格式默认 vviewer 渲染器；其余默认 file-viewer 渲染器；全部扩展名 open-as 可切对方。

**引入（19 组，逐包落地、每包独立 commit + e2e 锚 + NOTICES 行）**：

| 序 | 包 | 接管扩展名（默认 file-viewer 渲染） | 备注 |
| --- | --- | --- | --- |
| 1 | @file-viewer/core | —（基建） | 桥接层依赖 |
| 2 | renderer-email | eml, msg, mbox | eml 从 code 兜底转移 |
| 3 | renderer-epub | epub, fb2, umd | |
| 4 | renderer-ofd | ofd | |
| 5 | renderer-chm | chm | |
| 6 | renderer-word + capability-rtf | doc, docm, dotx, dotm, odt, odp, rtf | docx 维持 vviewer mammoth；dot 维持批次二 graphviz（扩展名语义以 graphviz 优先，Word 模板极罕见）；ppt 后述 |
| 7 | renderer-presentation | ppt, pptm, potx, potm, ppsx, ppsm | pptx 维持 vviewer 自研 OOXML；pot 维持批次二 structurizr? 否——pot 是 PowerPoint 模板，批次二未占（graphviz 用 dot/gv），归此处 |
| 8 | renderer-spreadsheet | xltx, xlsb, xlt, xla, xlam, xltm, ods, fods, dbf, tsv（自 code 转移） | xlsx/xlsm/xls 维持 vviewer SheetJS；csv 维持 code |
| 9 | renderer-iwork | pages, numbers, key | |
| 10 | renderer-hangul | hwp, hwpx | |
| 11 | renderer-wordperfect | wpd, wp, wp5, wp6 | |
| 12 | renderer-data | sqlite, parquet, avro, webarchive + ttf, otff, woff, woff2（字体查看，fonts store 加载职责不动）+ wasm（模块结构/导出解析；hex 保留 open-as 兜底） | 依赖 sql.js/hyparquet/avsc/ag-psd 全 MIT |
| 13 | renderer-design | psb, pdd, psdt, psd, ait, ai, idml, icml, idms, inx, fla, xfl, xd, indd, indt, ps, eps, ase, aco, abr, csh, pat, grd, asl | design 系全量（用户拍板 experimental 也引）；psd/ai/eps/psb/ait 归 design（高保真形态）而非 data 基础视图，避免同扩展名双 file-viewer 渲染器归属纠结；LicenseRef-PMEL 取 MPL-2.0 面记档 |
| 14 | renderer-image | tiff, tif, heic, heif, jxl（仅新 5） | 原 9 格式维持 vviewer；jxl 上游实现形态实施时核实（其 npm deps 无 jxl 专用库），若实际不支持则该扩展名回退未注册并在 commit 注记 |
| 15 | renderer-geo | geojson, kml, gpx, shp（前三自 code 兜底转移） | maplibre BSD-3 |
| 16 | renderer-typst + assets-typst | typ, typst（自 code 兜底转移） | 渲染式预览；资产大（wasm 编译器+字体），懒加载不进 precache |
| 17 | renderer-dicom | dcm, dicom | experimental（用户拍板全量） |
| 18 | renderer-signature | p7m/p7s/p7c/p7b/pkcs7/cms/cmsc/tsd/tst/tsq/tsr/asics/scs/asice/sce/ers/asc/sig/pgp/gpg/jws（22，sig 自 code 兜底转移） | experimental opt-in；用户拍板 |
| 19 | renderer-eda | olb, dra, gds, oas, oasis | |
| 20 | renderer-drawing + capability-drawio-official + assets-drawing | drawio, dio | 仅启用 drawio 类型（diagrams.net 官方运行时，Apache-2.0）；mermaid/plantuml/excalidraw/bpmn 部分不启用（批次二 vviewer 渲染器接管）；bpmn-js 不装 |
| 21 | capability-midi（连带 renderer-media 宿主依赖） | midi, mid | renderer-media 的媒体扩展名**不注册**（vviewer av 占优），仅 MIDI 面生效 |

**排除（不引，理由记档）**：`renderer-cad`（AGPL）、`renderer-3d`（LGPL）、`renderer-text`/`renderer-pdf`/`renderer-ppt`（对应管线 vviewer 占优）、`renderer-archive`（与 vviewer archive 渲染器同库——jszip + libarchive.js 两引擎完全相同，差异仅在扩展名绑定面：上游 29 个 vs vviewer 8 个；多出的 21 个扩展名改为 **vviewer archive 渲染器补绑定**——libarchive.js 本身支持 tbz/tbz2/txz/tzst/lzma/zst/cab/ar/cpio/xar/lha/lzh/jar/war/ear/apk/cbz/cbr/gzip/bzip2 等，零新依赖；zipx 支持与否实施时核实）、`renderer-binary`（vviewer hex 占优且结构树已含 Mach-O 解析——`struct.ts:101/108` MACHO_CPUS/MACHO_TYPES，`.macho` 缺的只是扩展名绑定，补绑即得完整能力；上游包为实验性 opt-in 模板检视形态，file-viewer 自己也未进 preset-all）、`bpmn-js`（自有许可）。

**默认面校验**：批次收口时以脚本重跑调研报告 §3.1 覆盖矩阵，「未注册 174」应归零（除 jxl/zipx 两个待核实项外），产出更新版矩阵回写报告。

### 6.4 数据源对接策略（分来源 × 分渲染器，用户要求展开设计）

**来源分档**（vviewer FileSource 实态）：

| 档 | 来源 | 文件数据形态 |
| --- | --- | --- |
| L1 本地文件夹面 | FS Access 目录树（bindFs） | `handle.getFile()` → File 对象在手，无网络 |
| L2 本地单文件面 | 文件输入/拖放/本地 Files store | File/ArrayBuffer 在手 |
| L3 归档面 | zip 条目 tab（zipStore） | 条目解压即 Blob 在手 |
| R1 远端服务面 | 远端服务端文件（Range-capable + SSE watch） | StreamCtx.read 分块窗段 |
| R2 直连存储面 | S3/WebDAV 直连（Range 206 校验三态）、proxy 挂载 | 同上，凭据在 store 层 |

**总原则**：桥接渲染器一律声明 `streaming: false` → dispatcher 全量物化路径接管（≤512MB 防线、size 未知走 EOF 物化、abort signal 贯穿），桥接层只见全量 `Uint8Array` → `new File([buf], name)`。**不启用 file-viewer 的 mountViewer URL 通道**（再评估结论见下小节）。远端来源（R1/R2）的全量物化有体量分级与下载进度卡，见下。

#### 远端全量物化：下载进度卡 + 确认门 + 另存为（R1/R2，用户点名设计）

- **物化泵与进度事件**：远端全量物化统一走显式泵（ctx.read 分块循环），逐块上报进度（节流 ~200ms；载体=dispatcher 的 full-view 补拉循环加可选 onReadProgress 钩子，或桥接层自泵——实施者自由度 §9，**契约钉死**：进度事件含 loaded/total、abort signal 贯穿、取消落 `abortReadError` 既有错误身份层）。
- **进度卡（无分级，全量级显示）**：远端下载**无论大小一律显示**进度卡；字段：源地址（脱敏 display endpoint + path）、进度条、**已下载/完整大小**（size 未知=不定态：「已下载 N MB（总大小未知）」）、**下载速度**（~5s 滑动窗口均值）、**预估剩余时间**（速度未稳显示「计算中」）、**取消**；完成态自动让位给渲染。UI 载体=ViewerPane 加载态区（错误卡片同通道，新增 loading-progress 形态）。
- **确认门（阈值可设置）**：`total > 阈值` 时**先确认后下载**——确认卡明示文件名/大小/目标渲染器与内存影响，确认后泵才启动；阈值=settings「远端下载确认阈值」（存储与数据组，MB 计，默认 512，clamp 1–4096）。原 512MB 硬防线在此通路改为确认门（知情自担，**无独立硬上限**）；size 未知不适用确认门（无前置数字，直接不定态下载）。settings 接入走既有 SettingsCenter 注册表 + normalizeSettings 白名单 + 导入导出。
- **另存为（便捷 + 大文件省内存双形态）**：
  - **完成后另存为**：进度卡完成态提供「另存为」按钮——`showSaveFilePicker`（FS Access）为主，blob URL + `download` 属性兜底（无 FS Access 环境，SHELL-07 同域受限）；
  - **下载并另存为（推荐给确认门以上大文件）**：确认卡/进度卡的第二个动作——泵直接写 FS Access writable stream 落盘，完成后 `handle.getFile()` 回填 File 给渲染器：**浏览器盘 backed File，渲染器无需全量驻留内存**，是超大文件的最优路径；无 FS Access 环境降级为普通下载路径。
  - **泛化为 tab 级动作（用户确认加入）**：TabContextMenu 增第七动作「另存为」——统一 saveAs 管线的另一消费面，覆盖进度卡触达不到的场景：zip 条目导出单文件（zipStore 读全量）、流式渲染器（code/jsonl/hex 窗口模式）打开的远端文件全量拉取（复用泵+进度卡+确认门同规则）、非流式渲染器已物化实例直写（零下载）、本地文件另存副本；占位/错误 tab 置灰。右键点击为合法 user gesture，picker 可直接弹出；实现下沉为共享管线，进度卡两动作与菜单项共用。
- **作用面**：统一落在 dispatcher 全量物化通路——自有非流式渲染器（pdf/docx/xlsx/archive…）与桥接渲染器一致受益；本地来源（L1–L3）不涉下载，不显示进度卡、不受确认门。
- **验收锚**：进度卡字段全锚（R1 mock 慢泵）、确认门双路（阈值修改生效/确认与取消各一）、另存为双形态（picker 桩 + 锚量下载）、不定态锚（size 未知）。

#### URL 通道再评估（用户点名核查）

**上游事实**：file-viewer **有**渐进式渲染器——`renderer-pdf` 的 URL-only 路径特意走 pdfjs Range I/O（`packages/renderers/pdf/src/pdf.ts:2185-2203`：「The URL-only path deliberately supplies an empty buffer for PDF.js Range I/O」，`getDocument({ url: streamUrl, rangeChunkSize, disableAutoFetch, … })`，线性化 PDF 可 Range 渐进加载）；`renderer-media` 的音视频 `<video src=url>` 天然渐进（已被排除不引）。**其余渲染器（zip 系 Office/epub/chm/ofd、email、data、设计系）都是整载解析，无渐进形态**。

**桥接集消费者分析**：pdf 默认归 vviewer 自有渲染器（调研 §4.1 占优）→ **桥接集内 URL 渐进通道零消费者，维持 v1 不启用**。渐进式的真实受益者是 **vviewer 自有 pdf 渲染器**（现状 `getDocument({ data: buffer })`，`packages/vviewer-render-doc/src/pdf.ts:62` 全量载入）——**后续候选（不在本 spec）**：pdf.ts 增加 Range transport 模式，走 pdfjs `PDFDataRangeTransport`（自定义 requestRange 回调接 `ctx.read`/`store.read`，token/SigV4/Basic 签名全在我们手里，各来源通用）。

**直连两形态确认与 URL 适配矩阵**（用户记忆属实：`tree/directS3.ts`/`directDav.ts` 为前端直发浏览器侧签名；proxy 挂载为后端代发、挂载根复用 `remote.ts` RemoteStore 机制）：

| 来源 | 全量物化+进度卡 | URL 通道可行性（若未来启用） |
| --- | --- | --- |
| R1 服务端 / R2 proxy（后端代发） | ✓ ctx.read（Bearer 在 store 层） | 可行：server 文件通道 + Authorization 静态头（Range RFC 已修 BUG-47），两形态同构 |
| R2 direct DAV（前端直发） | ✓ store.read（Basic） | 可行：Basic 静态头 `httpHeaders` |
| R2 direct S3（前端直发） | ✓ store.read（SigV4 逐请求重签） | **不可直接**：每次 Range 都要 SigV4 重签，pdfjs `httpHeaders` 给不了动态签名——需 presigned GET（时效/泄漏面）或 `PDFDataRangeTransport` 自签 |
| L1–L3 | —（数据在手） | 不适用 |

**裁决**：v1 全量物化+进度卡为唯一远端路径；URL 通道维持不启用（escape hatch 记档）；**vviewer pdf Range transport 转正为本批任务**（决策⑫，见 §6.6）。

**分来源细节**：
- **L1/L2（本地面）**：数据在手零物化成本；`Blob` 包裹 typed array 浏览器惰性物化，无深拷贝。大文件与本地其它渲染器同闸（512MB 防线）。
- **L3（归档面）**：条目解压即 Blob；嵌套归档（zip 内 zip）先由 archive 渲染器开条目成 tab，再落桥接渲染器，链路一致。边车文件在同归档内可经 zipStore 读兄弟条目（见边车回调）。
- **R1/R2（后端面）**：dispatcher 经 ctx.read 分块补拉全量，凭据在 RemoteStore 层；SSE watch 命中变更 → 既有 reload 链 = 桥接实例 destroy（unmount 上游实例）→ 重渲染，`RenderedInstance` 契约天然承载，无新机制。proxyOffsite 跨服务器防线在 store 层，不涉桥接。

**分渲染器数据画像分组**：

| 组 | 桥接渲染器 | 数据形态 | 特别处理 |
| --- | --- | --- | --- |
| A 整载组 | email / epub / fb2 / umd / ofd / chm / word 系 / presentation 系 / spreadsheet 系 / iwork / hangul / wordperfect / signature / eda / dicom / typst（源码→wasm 编译）/ midi / data（sqlite·parquet·avro·webarchive·字体·wasm）/ image 增强（tiff·heic 系） | 全量 bytes → File → 库内解析（多数 worker 化，transferable 由各库自管） | 无特殊；typst 输入为小体量文本 |
| B 嵌套附件组 | email（.eml/.msg） | 附件内嵌 buffer | 方案 A：嵌套回调 → **vviewer dispatcher byExtension** 承接（pdf/image/docx 等本地强项）；dispatcher 无渲染器的附件回落下载 |
| C 边车组 | geo（仅 `.shp`） | .shx/.dbf/.prj 兄弟文件 | **resolveSibling 统一回调**（见下） |
| D URL 通道 | （无） | — | v1 不启用，escape hatch 记档 |

**边车回调（对决策⑨的细化升级——本节裁决）**：桥接层提供 `resolveSibling(source, name)` 统一回调，实现为 `source.store.read(join(dirname(source.path), name))`。适用面核查：L1 目录树（dirHandle read）、R1 服务端（tree/file 通道按路径读）、R2 直连（key 读）、L3 zip（同归档兄弟条目）——**除「无 store 的裸单文件」外全部来源都能补齐边车**；裸单文件维持降级错误卡（「Shapefile 需同目录 .shx/.dbf/.prj」）。geo 其余格式（geojson/kml/gpx 单文件自足）与其余组零影响。

**大文件行为**：512MB 全局防线对全部桥接渲染器一致生效；可选增强=file-viewer `precheckFileViewerSource`（core/headless，签名/包结构快速校验）作打开前快速失败，v1 可选接入（实施者自由度，标 §9）。

### 6.5 逐包验收（每包同一模板）

- 桥接渲染器注册锚（byExtension）、默认面 open-as 双向切换锚（file-viewer ↔ vviewer 渲染器）。
- e2e：每包至少一个样例文件渲染锚（真实夹具入 `apps/web/e2e/fixtures/foreign/`）+ 一个错误文件错误卡片锚；计量锚（首屏耗时，预算宽松——懒加载形态首次含 chunk+资产拉取）。
- NOTICES 行、版本钉死（package.json 精确版本，随 file-viewer 上游升级策略另行决定）。
- 门禁：typecheck 0E / vitest 全绿 / cargo 不涉（纯前端批）/ playwright 全量零翻转 / foreign 预算门禁绿。

### 6.6 vviewer 自有增强：pdf Range transport（决策⑫，随批次三交付）

- `pdf.ts` 增加 transport 模式：pdf 渲染器声明 streaming（领取 head 探测字节 + StreamCtx）——**ctx 存在且 rangeCapable 且 size 已知** → pdfjs `PDFDataRangeTransport(head, size, requestRange → ctx.read)` 渐进加载；回退矩阵：size 未知 → memoizedFullRead 全量（现路径）、!rangeCapable → 全量、本地来源（数据在手）→ 现 `data` 路径零变化。
- 生命周期：reload/watch 变更走既有 destroy → `loadingTask.destroy()` + signal 取消在飞 requestRange；abort 对齐 `abortReadError` 身份层。
- 直连 S3 经 store.read 同样适用（SigV4 逐请求重签由 store 层负责）——Range transport 不挑 URL 适配性，这正是选 transport 而非 URL 通道的原因。
- e2e：远端 linearized 样例渐进锚（首屏渲染先于全量到达——以请求数/字节量下限断言）、回退三路锚、S3 直连形态锚（e2e-server 套件）；门禁归批次三收口。

## 7. 合规与台账

- NOTICES 逐包新增行：组件=包名、许可、用途、引入里程碑=file-viewer 批 T<n>；`@paged-media/introspect-wasm` 行显式注记「双许可取 MPL-2.0」。
- 随包非代码资产（design 系 Stet 内嵌 URW Base35 OFL-1.1 字体、ICC CC0 profile、assets-typst 内嵌字体等）保留上游声明文件随 dist 分发，NOTICES 表加汇总注记行。
- 构建期脚本校验：引入包的 license 字段白名单断言（npm 元数据 CI 校验，仿既有 --check 惯例），防上游换许可静默引入。

## 8. 风险与待核实项（实施时首任务）

1. file-viewer v3.3.3 浏览器 API 的实际挂载/销毁形态与宿主嵌套回调（`renderNestedBuffer`）的完整签名——桥接层第一包（email）落地时钉死模式，后续包复用。
2. **上游资产包 CDN 直链可行性（决定是否触发预案包）**：jsdelivr 对 `@file-viewer/assets-*@3.3.3/viewer/` 各文件的可用性（单文件 20MB 上限重点核 assets-typst 编译器 wasm、assets-drawing diagrams.net bundle）+ 资产 base URL 配置能否脱离 asset-installer 直接指 CDN 路径——任一不成立即触发 §6.2 预案包。
4. jxl、zipx 两扩展名的上游真实支持度（见 §6.3 序 14/排除清单）。
5. `.dot` 从 code 兜底改 graphviz 专有对既有 e2e 锚的影响面。
6. kroki-only 类型在 CI 无 krokiHost 时的 e2e 策略（mock host 或仅锚失败回退路径）。
7. 多包 npm 依赖树对 pnpm 锁文件与 minimumReleaseAge 类配置的影响（file-viewer 自家 lockfile 就有 minimumReleaseAgeExclude 先例，其依赖可能偏新）。
8. signature/eda/design 实验态渲染器的错误面（失败卡片文案与重试）。

## 9. 留给实施者的决策空间

- 桥接层对 file-viewer API 的具体包装形态（组合 vs 逐 renderer 包装）、目录与导出组织。
- 二次封装 pack 脚本的实现选型（自写 mjs vs 复用上游 asset-installer/copy-assets 逻辑）与 manifest 重组细节。
- 各 e2e 夹具的具体构造。
- chunk 规划细节（rolldown manualChunks/groups 既有机制下的具体分组）。
- 批次三内部逐包 commit 的粒度（按 §6.3 序号或合并小组，唯默认面转移必须随包原子完成）。

## 10. 实施顺序

批次一（半天级）→ 批次二（1-2 天级）→ 批次三（§6.3 序 1→21 逐包，core 桥接最先、design/eda/signature 等大尾包殿后）。每批收口跑全量门禁与更新版覆盖矩阵。
