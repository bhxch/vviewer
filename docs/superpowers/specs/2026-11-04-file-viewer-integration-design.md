# file-viewer 引入增强 · 设计文档

- 日期：2026-11-04
- 状态：待用户批准（brainstorm 产物，获批后转 writing-plans）
- 调研依据：`docs/file-viewer/format-package-survey-2026-11-04.md`（47 管线逐行对照、许可证红线、覆盖矩阵）
- 用户决策记录（brainstorm 两轮四题+三题+builder check 收口，全部拍板）：①引入范围=全量（npm 引入、不进主包；LicenseRef-PMEL 取 MPL-2.0 面；bpmn-js 排除 npm 依赖——md 管线既有运行时 CDN 加载姿态不变）；②data-asset=引 data 包，wasm 与字体查看都开；③音频=补别名+引 capability-midi；④图片=引 renderer-image 仅新 5 扩展名；⑤图表拆分=全集（29 型，builder check 补漏 7 型后收口）；⑥默认模式=默认渲染失败回退源码，引擎形态以 vviewer 图表注册表实态为准（七类 CDN 本地引擎非 kroki）；⑦drawio=引官方运行时；⑧**部署=大资产不进本项目 dist，参考 tree-sitter 语法包前例二次封装为 vviewer 自有 npm 资产包走 CDN**（Pages/Workers/桌面均不背重资产，按形态裁剪方案作废）；⑨**桥接契约=方案 A**（嵌套附件回调走 vviewer dispatcher；.shp 边车 v1 降级报错）。

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
- 桥接渲染器声明 `streaming: false` → dispatcher 自动走全量物化路径（回退矩阵既有契约），512MB 防线照旧；Range 流式源在 dispatcher 层补拉，桥接层零感知。
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

### 5.1 类型与扩展名映射（全集 29 型 / 31 扩展名）

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

- 落位：`packages/vviewer-render-diagram/src/file/`（新模块，复用既有 resolveDiagramType/引擎加载/kroki 编码/服务端分发），每类型导出一个 Renderer 实例（id `diagram-<type>`），装配点统一安装。
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
- **嵌套回调（方案 A）**：桥接层向 file-viewer 宿主契约提供嵌套渲染回调（对应其 `renderNestedBuffer` 缝，`file-viewer/packages/core/src/contracts/types.ts:971`）——附件 buffer 经 **vviewer 既有 dispatcher（byExtension）** 承接（pdf/image/docx 等全是 vviewer 强项，零新依赖）；dispatcher 无对应渲染器的附件回落下载。邮件附件内嵌预览因此开箱可用，不重做桥接面。
- **`.shp` 边车 v1 降级**：单 buffer 契约拿不到 .shx/.dbf/.prj 兄弟文件——缺边车时渲染器落错误卡片提示「Shapefile 需同目录 .shx/.dbf/.prj」；基于 `source.store.read` 的边车补读列后续候选（不进本 spec）。
- file-viewer 侧入口以其 README 为准（`@file-viewer/core/browser` 的 `mountViewer`/组件化 API；`core/headless` 的 `precheckFileViewerSource` 可选用于预检），实施时按其 v3.3.3 实际 API 适配——此处只钉死桥接方向与契约映射，具体 API 调用形态是实施者自由度。
- 不支持 SearchMatch：MetaPanel 搜索入口对桥接渲染器 tab 显示「当前渲染器不支持检索」禁用态（复用既有状态通道，不新增机制）。
- opts.signal 透传：destroy/取消时调 file-viewer 的销毁路径；abort 语义对齐 vviewer `abortReadError` 分类（批次外的既有错误身份层）。

### 6.2 资产部署（大资产不进本项目 dist，npm 二次封装 + CDN，用户拍板）

**原则**：file-viewer 的 JS 代码包走常规 npm 依赖 + rolldown 动态 import（chunk 分离进 dist，mammoth 先例）；**Worker/WASM/字体/vendor 大资产不进 dist、不进 PWA precache、Pages/Workers/桌面三形态都不背**——参考 tree-sitter 语法包前例（@bhxch/vviewer-grammars-full：单包聚合、manifest 与资产同目录、contentHash 去重门、OIDC Trusted Publisher、jsdelivr 精确版本钉死、客户端三层资产解析链 同源 dist→服务端 origin→CDN、pages 不背资产）二次封装发布。

**需要新增的 npm 包（vviewer 侧发布，仅 1 个）**：

| 包 | 内容 | 说明 |
| --- | --- | --- |
| `@bhxch/vviewer-foreign-assets` | 聚合上游 7 个资产包产物：@file-viewer/assets-standard / -data / -design / -drawing / -hangul / -iwork / -typst（CAD 系排除；chm/wordperfect/eda 无资产包） | 二次封装：重组 manifest（路由键=资产组/文件名），发布链照 grammars 前例全套（pack 脚本 contentHash、去重门 SKIP 复用、provenance、Trusted Publisher 配置）。客户端解析链 env（如 VV_FOREIGN_ASSETS_CDN）默认指向 jsdelivr 该包精确版本；三层链同源/服务端位保留空位（部署方愿自托管可填）。**拆分预案**：grammars 前例已验证 npm 单包解包 228MB 可行；若本包解包实测量级显著超出且 jsdelivr 单文件 20MB 上限有触碰（typst 编译器 wasm、diagrams.net bundle 需实测），按资产组拆子包（-standard/-typst/-design/…），manifest 路由支持多 base——实施期 pack 时实测后定，默认单包 |

**需要直接引入的 npm 包（file-viewer 侧，代码依赖，23 个）**：

- 核心：`@file-viewer/core`
- 渲染器：`@file-viewer/renderer-email` `-epub` `-ofd` `-chm` `-word` `-presentation` `-spreadsheet` `-iwork` `-hangul` `-wordperfect` `-data` `-design` `-image` `-geo` `-typst` `-dicom` `-signature` `-eda` `-drawing` `-media`（最后者为 capability-midi 宿主，其媒体扩展名不注册）
- 能力：`@file-viewer/capability-rtf` `-midi` `-drawio-official`

（版本一律精确钉死；file-viewer 上游升级策略——批量追平 vs 锁定——本 spec 不裁，默认锁定 3.3.3。）

**运行时**：各桥接渲染器首次打开对应扩展名时经三层链按需 fetch 资产；SW 对 CDN/该前缀设 CacheFirst（运行时缓存，不进 precache）。

**门禁**：新增 foreign 预算门禁（仿 `tools/diagram-budget.mjs`）——主 chunk 与 precache 清单断言不含 `@file-viewer/*` 代码面误入主 chunk（动态 import 面）、dist 不含 `file-viewer-assets/` 目录。

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

**排除（不引，理由记档）**：`renderer-cad`（AGPL）、`renderer-3d`（LGPL）、`renderer-text`/`renderer-pdf`/`renderer-ppt`（对应管线 vviewer 占优）、`renderer-archive`（同库 libarchive.js 已在；其 29 格式多出的 21 个扩展名改为 **vviewer archive 渲染器补绑定**——libarchive.js 本身支持 tbz/tbz2/txz/tzst/lzma/zst/cab/ar/cpio/xar/lha/lzh/jar/war/ear/apk/cbz/cbr/gzip/bzip2 等，属 vviewer 自有增强任务随本批落一个子任务；zipx 支持与否实施时核实）、`renderer-binary`（vviewer hex 占优；`.macho` 改为 vviewer hex 补绑扩展名，Mach-O 结构解析列入 hex 增强后续候选而非引包）、`bpmn-js`（自有许可）。

**默认面校验**：批次收口时以脚本重跑调研报告 §3.1 覆盖矩阵，「未注册 174」应归零（除 jxl/zipx 两个待核实项外），产出更新版矩阵回写报告。

### 6.4 逐包验收（每包同一模板）

- 桥接渲染器注册锚（byExtension）、默认面 open-as 双向切换锚（file-viewer ↔ vviewer 渲染器）。
- e2e：每包至少一个样例文件渲染锚（真实夹具入 `apps/web/e2e/fixtures/foreign/`）+ 一个错误文件错误卡片锚；计量锚（首屏耗时，预算宽松——懒加载形态首次含 chunk+资产拉取）。
- NOTICES 行、版本钉死（package.json 精确版本，随 file-viewer 上游升级策略另行决定）。
- 门禁：typecheck 0E / vitest 全绿 / cargo 不涉（纯前端批）/ playwright 全量零翻转 / foreign 预算门禁绿。

## 7. 合规与台账

- NOTICES 逐包新增行：组件=包名、许可、用途、引入里程碑=file-viewer 批 T<n>；`@paged-media/introspect-wasm` 行显式注记「双许可取 MPL-2.0」。
- 随包非代码资产（design 系 Stet 内嵌 URW Base35 OFL-1.1 字体、ICC CC0 profile、assets-typst 内嵌字体等）保留上游声明文件随 dist 分发，NOTICES 表加汇总注记行。
- 构建期脚本校验：引入包的 license 字段白名单断言（npm 元数据 CI 校验，仿既有 --check 惯例），防上游换许可静默引入。

## 8. 风险与待核实项（实施时首任务）

1. file-viewer v3.3.3 浏览器 API 的实际挂载/销毁形态与宿主嵌套回调（`renderNestedBuffer`）的完整签名——桥接层第一包（email）落地时钉死模式，后续包复用。
2. `@bhxch/vviewer-foreign-assets` 打包实测：7 个上游资产包聚合后的解包体积（grammars 前例 228MB 量级是否被超出）、单文件是否触碰 jsdelivr 20MB 上限（assets-typst 编译器 wasm、assets-drawing diagrams.net bundle 重点）——超限即触发 §6.2 拆分预案。
3. 上游 assets 包产物能否脱离 asset-installer 独立伺服（manifest 结构为 installer 设计的部分——receipt 字段等——在二次封装 manifest 中如何取舍）。
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
