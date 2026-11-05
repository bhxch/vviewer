# file-viewer 格式·包·许可证对照调研报告

- **调研日期**：2026-11-04（未决点查证收口同日，commit `7197292` → 本版）
- **调研对象**：[flyfish-dev/file-viewer](https://github.com/flyfish-dev/file-viewer) v3.3.3（本地检出 `/share/rw/repo/github/file-viewer`，经 npm registry 核实与线上最新版一致）
- **对照基线**：vviewer（本仓库）HEAD `5c26c59`
- **第一波回写增量**（2026-11-06，HEAD `1ab32ac`）：file-viewer 第一波桥接落地（10 组 41 扩展名，`a972bff`）后按实测注册面回写 §1/§3/§3.1/§4.2，并并账三笔基线后已落地增量——批次一绑定缺口（`5a6d53f`：hex/mpeg/weba/tsv）、批次二自有补绑（`32993c8`：archive 18 扩展名 + macho）、计划 1 图表文件渲染器（29 型 33 扩展名）
- **性质**：引用可行性调研的格式级细化。包家族与许可证面上的结论承接 2026-11-04 会话初步检查，本文给出 47 条渲染管线的逐行对照；初版三处未决点已全部查证并回写正文（见 §6）。

## 1. 结论摘要

1. file-viewer 为**模块化 npm 包家族**：60+ 个包（scope `@file-viewer`），统一版本 3.3.3，全部在售。注册 **275 个扩展名**（stable 225 / experimental 50）横跨 **47 条渲染管线**（表内实测去重后恰为 275，与头注一致；初版矩阵脚本的 278 含 3 个解析伪影已剔除）。扩展名清单逐字摘自其生成目录 `docs/generated/format-catalog.md`。
2. 许可证**主体 Apache-2.0**（`@file-viewer/doc` 为 MIT），与本项目引入约束（MIT / Apache-2.0 / BSD / ISC / MPL-2.0）兼容；但有两条**硬红线**：
   - **CAD 链是 AGPL-3.0-only**：`@file-viewer/renderer-cad` → `@flyfish-dev/cad-viewer@0.8.3`（npm 实查 AGPL-3.0-only），链上另有 `dwf-viewer`（AGPL-3.0-only）与 LibreDWG bindings（GPL-3.0-only）。上游自知此事，仓库内随附 `file-viewer-cad-corresponding-source` 源码快照合规包（`packages/build-support/cad-source-snapshots/3.3.3/README.md` 原文："CAD 0.8.3 and DWF 0.6.7 retain their AGPL-3.0-only terms; LibreDWG bindings 0.7.9 retain GPL-3.0-only terms"）。
   - **3D/STEP/IFC 链含 LGPL-2.1**：`@file-viewer/renderer-3d` → `occt-import-js@0.0.23`（npm 实查 LGPL-2.1），超出本项目允许清单。
   - 连带禁区：`preset-all`、`preset-engineering`、全部 `*-full` 组件壳均依赖 renderer-cad。
3. 与 vviewer 逐行对照（扩展名级全量矩阵，脚本核验，见 §3 表与 §6-②；2026-11-06 第一波回写后）：**✅ 同等或更广 20 条**（初版 5 条 pdf/markdown/code/video/binary-inspector + 第一波桥接/图表文件转正 15 条），**🟡 部分覆盖 13 条**（含 4 条带「code 文本兜底」接入成分：typ/typst、gltf、geojson/kml/gpx、sig），**❌ 完全缺口 14 条**。剩余缺口即第二波引用价值区，详见 §4.2/§4.3。
4. 顺带发现本仓库台账缺口：图表批次（2026-10-19 spec）引入的 `@viz-js/viz`、`nomnoml`、`pako` 未入 `THIRD_PARTY_NOTICES.md`，建议随引用工作一并补齐；另发现三个 vviewer 侧扩展名绑定小缺口（`.hex`、`.mpeg/.weba`、`.tsv`），见 §4.4。

## 2. file-viewer 包家族与许可证总览

### 2.1 分层结构（均为 3.3.3，private: false，npm 在售）

| 层 | 包 | 说明 |
| --- | --- | --- |
| 核心 | `@file-viewer/core`（Apache-2.0，运行时仅依赖 dompurify） | framework-neutral 契约与渲染引擎，分 `core/headless`（预检/契约）与 `core/browser`（DOM）入口 |
| 渲染器 | `renderer-word/-presentation/-spreadsheet/-pdf/-ofd/-hangul/-wordperfect/-iwork/-archive/-chm/-email/-eda/-cad/-3d/-geo/-drawing/-mindmap/-epub/-image/-media/-binary/-data/-design/-dicom/-signature/-text/-doc` | 每格式族一包，27 个 |
| 能力 | `capability-mermaid/-midi/-rtf/-streaming-media/-pptx-charts/-text-tools/-drawio-official/-pdf-identity-repair` | opt-in 增强，8 个 |
| 预设 | `preset-lite / preset-standard / preset-office / preset-engineering / preset-all` | 组合包 |
| 组件壳 | `web / svelte / react / react-legacy / vue3 / vue2.7 / vue2.6 / jquery` 及对应 `-full` | Svelte 壳 peerDeps `svelte >=3.59 <6`（覆盖 Svelte 5） |
| 资产 | `asset-installer` + `assets-standard/-cad/-chm/-data/-design/-drawing/-hangul/-iwork/-model/-ppt/-typst/-wordperfect` | Worker/WASM/字体自托管落盘 |
| 工具 | `cli`、`create-file-viewer`、`file-viewer-cli`、`vite-plugin`、`file-viewer-copy-assets`、`thumbnail`、`doc`（MIT）、`docx`、`ppt`、`pptx` | 工程化配套 |
| 别名兼容 | `file-viewer3`、`@flyfish-group/file-viewer*`、`msdoc-viewer` 等 | 历史兼容 |

**管线 → 实现包的权威映射**：`packages/tools/cli/catalog/catalog.json`（CLI 的 capability 清单，含 `capabilityId → packageName → rendererIds → formats` 与许可字段）。逐管线归属即以它为准（例：capability `spreadsheet` = `@file-viewer/renderer-spreadsheet`，含 `spreadsheet-openxml` 与 `spreadsheet-dbf` 两管线；capability `design` 单包含 10 条 design 管线；capability `epub` 含 epub/fb2/umd 三管线）。

### 2.2 许可证结论

| 对象 | 许可证 | 依据 |
| --- | --- | --- |
| 家族主体（core / 全部 renderer / capability / preset / 组件壳） | Apache-2.0 | 各 package.json `license` 字段 + npm registry 实查（2026-11-04） |
| `@file-viewer/doc` | MIT | 同上 |
| **CAD 引擎** `@flyfish-dev/cad-viewer@0.8.3` | **AGPL-3.0-only** | npm 实查；对应源码快照 README 原文（§1-2） |
| CAD 链上 `dwf-viewer@0.6.7` | AGPL-3.0-only | 同上 |
| CAD 链上 LibreDWG bindings 0.7.9 | GPL-3.0-only | 同上 |
| **3D 引擎** `occt-import-js@0.0.23` | **LGPL-2.1** | npm 实查 |
| **PDF 引擎** `pdfjs-dist@5.4.624` | Apache-2.0（引擎）+ 附属资产各带 LICENSE | `packages/build-support/licenses/asset-family-materials.json` materials[28..47]（cmaps/standard_fonts/wasm 全部钉 `pdfjs-dist@5.4.624`，来源 npm 同版本页）；vendor 于 `packages/renderers/pdf/dist/vendor/pdfjs/`，标准字体带 LICENSE_LIBERATION，wasm 解码器带 JBIG2/OpenJPEG/QCMS 各 LICENSE；`stage-pdfjs-runtime.mjs` 确定性钉版 |
| `@fontsource-variable/noto-sans-sc`（renderer-pdf 唯一 npm deps） | OFL-1.1 | npm 实查；字体资产，对代码无传染，但不在本项目许可白名单字面内 |
| bpmn-js（drawing 包 BPMN opt-in） | 「SEE LICENSE IN LICENSE」（bpmn.io 自有许可，含保留水印条款） | npm 实查 + catalog 注记 "The bpmn.io watermark is retained under the upstream license" |
| `@paged-media/introspect-wasm`（InDesign IDML） | **MPL-2.0 OR LicenseRef-PMEL**（双许可含自定义许可） | npm 实查；取 MPL-2.0 面可用，LicenseRef-PMEL 未公开定义需回避 |
| PostScript（EPS）渲染的 Stet WASM 运行时 | 运行时本体随包分发，**内嵌** URW Base35 字体（OFL-1.1）与 Compact ICC CMYK profile（CC0） | catalog `postscript-design` 行 Known limits 原文 |

**preset 组合的许可安全面**：`preset-standard`（deps 无 CAD/3D）、`preset-lite`、`preset-office` 干净；`preset-all` 与 `preset-engineering` 因含 `renderer-cad`/`renderer-3d` 整体踩线。

## 3. 格式对照总表（47 管线逐行）

扩展名清单**逐字摘自** `docs/generated/format-catalog.md`（该文件由 `scripts/generate-format-catalog.mjs` 生成，头注 "Do not edit directly"）。级别/状态两列合一。

**vviewer 状态图例**：✅ 支持且同等或更广；🟡 部分覆盖（专有渲染器覆盖部分扩展名，或经 code 文本兜底接入）；❌ 不支持。「code 兜底」指扩展名被 vviewer 生成物（`generated-extensions.ts`，670 项，helix languages.json fileTypes 全集）注册到 code 渲染器、以语法高亮文本形态打开；**「桥接」= 经 file-viewer 渲染器包桥接渲染（第一波 10 组 41 扩展名，`apps/web/src/lib/foreignRenderers.ts` 装配）**；**「缺」= 不在 vviewer 注册表，走运行时探测链（签名 → 文本性 → hex 字节）降级，非直接拒绝**。

**vviewer 渲染器绑定出处**：`markdownRenderer.ts:737`、`html.ts:80`、`code/index.ts:54`（内置 52 项）、`jsonl/index.ts:951`、`hex.ts:785`、`image.ts:99`、`av.ts:356`、`pptx.ts:19`、`docx.ts:31`、`xlsx.ts:91`、`pdf.ts:53`、`archive.ts:120`、`diagramFile.ts:59`（图表文件 29 型 33 扩展名，计划 1）、`apps/web/src/lib/foreignRenderers.ts:166`（file-viewer 桥接 10 组 41 扩展名，第一波）。

| # | 管线 ID | 格式族 | 扩展名（file-viewer） | 级别/状态 | file-viewer 实现包 | 关键引擎依赖（许可证） | vviewer | vviewer 实现（依赖·许可证） |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `office-word-openxml` | Word OpenXML | `.docx` `.docm` `.dotx` `.dotm` | high-fidelity / stable | renderer-word | @file-viewer/doc（MIT）、@file-viewer/docx（Apache-2.0）、jszip（MIT） | 🟡 | `.docx` 专有：mammoth（BSD-2）+jszip；docm/dotx/dotm 桥接 file-viewer renderer-word（第一波） |
| 2 | `office-word-binary` | Word 97-2003 | `.doc` `.dot` | structured / stable | renderer-word | 同上 | ✅ | `.doc` 桥接 file-viewer renderer-word（第一波）；`.dot` 落 diagram-graphviz 专有（计划 1 图表文件批次，viz-js/hpcc 本地渲染） |
| 3 | `office-presentation-binary` | PowerPoint 97-2003 | `.ppt` `.pot` | structured / stable | renderer-presentation | @file-viewer/ppt（Apache-2.0） | ✅ | ppt/pot 均桥接 file-viewer renderer-presentation（第一波，legacy 走 assets-ppt 运行时） |
| 4 | `office-presentation` | PowerPoint OpenXML | `.pptx` `.pptm` `.potx` `.potm` `.ppsx` `.ppsm` | high-fidelity / stable | renderer-presentation | @file-viewer/pptx（Apache-2.0；dingbat-to-unicode BSD-2、tinycolor2 MIT、utif MIT） | 🟡 | `.pptx` 专有：自研 OOXML 渲染（jszip MIT；`vviewer-render-doc/src/pptx.ts`+`ooxml.ts`）；pptm/potx/potm/ppsx/ppsm 桥接 file-viewer renderer-presentation（第一波） |
| 5 | `open-document` | RTF/OpenDocument | `.rtf` `.odt` `.odp` | structured / stable | renderer-word（ODT/ODP 读 content.xml；README:5）+ capability-rtf | rtf.js（MIT） | ✅ | 三者均桥接 file-viewer renderer-word + capability-rtf（第一波；rtf 经 rtf.js 懒加载器启用） |
| 6 | `spreadsheet-openxml` | 电子表格 | `.xlsx` `.xltx` `.xlsm` `.xlsb` `.xls` `.xlt` `.xla` `.xlam` `.xltm` `.csv` `.tsv` `.ods` `.fods` | structured / stable | renderer-spreadsheet | styled-exceljs（Apache-2.0）、e-virt-table（MIT）、@xmldom/xmldom（MIT）、utif（MIT）、tinycolor2（MIT） | 🟡 | `.xlsx/.xlsm/.xls` 专有（SheetJS Apache-2.0）；`.csv` 在 code 内置清单；xltx/xlsb/xlt/xla/xlam/xltm/ods/fods/tsv 桥接 file-viewer renderer-spreadsheet（第一波；tsv 已自 code 内置原子转移） |
| 7 | `apple-pages` | Apple Pages | `.pages` | high-fidelity / stable | renderer-iwork | keynote-archives（MIT）、styled-exceljs（Apache-2.0） | ✅ | 桥接 file-viewer renderer-iwork（第一波，worker 资产 assets-iwork） |
| 8 | `apple-numbers` | Apple Numbers | `.numbers` | high-fidelity / stable | renderer-iwork | 同上 | ✅ | 同行 7（第一波桥接） |
| 9 | `apple-keynote` | Apple Keynote | `.key` | high-fidelity / stable | renderer-iwork | 同上 | ✅ | 同行 7（第一波桥接） |
| 10 | `office-wordperfect` | WordPerfect | `.wpd` `.wp` `.wp5` `.wp6` | structured / stable | renderer-wordperfect | 零依赖自研 | ✅ | 桥接 file-viewer renderer-wordperfect（第一波，libwpd wasm 资产 assets-wordperfect） |
| 11 | `spreadsheet-dbf` | dBASE | `.dbf` | structured / stable | renderer-spreadsheet（CLI catalog capability `spreadsheet` 坐实，见 §6-①） | 同行 6 | ✅ | 桥接 file-viewer renderer-spreadsheet（第一波） |
| 12 | `pdf` | PDF | `.pdf` | high-fidelity / stable | renderer-pdf | **pdfjs-dist@5.4.624**（Apache-2.0）以 vendor 资产分发 + @fontsource-variable/noto-sans-sc（OFL-1.1） | ✅ | pdfjs-dist（Apache-2.0），含文本层（`pdfText.ts`） |
| 13 | `ofd` | OFD 版式 | `.ofd` | structured / stable | renderer-ofd | jszip（MIT），解析自研 | ✅ | 桥接 file-viewer renderer-ofd（第一波，无独立资产包） |
| 14 | `office-hangul` | 韩文 HWP | `.hwp` `.hwpx` | structured / stable | renderer-hangul | @ssabrojs/hwpxjs（MIT）、cfb（Apache-2.0） | ✅ | 桥接 file-viewer renderer-hangul（第一波，资产 assets-hangul） |
| 15 | `typst` | Typst | `.typ` `.typst` | high-fidelity / stable | renderer-typst | @myriaddreamin/typst-ts-web-compiler/-ts-renderer（均 Apache-2.0） | 🟡 | `.typ/.typst` 落 code 兜底（tree-sitter typst 语法高亮源码视图）；无渲染式预览（md 内数学为 katex，非 Typst） |
| 16 | `archive` | 压缩包 | `.zip` `.zipx` `.7z` `.rar` `.tar` `.gz` `.gzip` `.tgz` `.bz2` `.bzip2` `.tbz` `.tbz2` `.xz` `.txz` `.lzma` `.zst` `.tzst` `.cab` `.ar` `.cpio` `.iso` `.xar` `.lha` `.lzh` `.jar` `.war` `.ear` `.apk` `.cbz` `.cbr` | structured / stable | renderer-archive | jszip（MIT）、libarchive.js（MIT） | 🟡 | 27/29 专有：`zip/tar/gz/tgz/bz2/xz/7z/rar`（同两库，`archive.ts:120`）+ `.iso` 落 hex + jar/war/ear/apk/cbz/cbr/gzip/bzip2/tbz/tbz2/txz/lzma/cab/ar/cpio/xar/lha/lzh 补绑（`32993c8`，libarchive wasm 读侧实证）；zst/tzst 未注册（zstd 未编译进 wasm）、zipx 未注册（非独立格式） |
| 17 | `chm` | Compiled HTML Help | `.chm` | structured / stable | renderer-chm | 零依赖自研（ITSF + LZX 解压） | ✅ | 桥接 file-viewer renderer-chm（第一波，chm worker+wasm 资产 assets-chm） |
| 18 | `email` | 电子邮件 | `.eml` `.msg` `.mbox` | structured / stable | renderer-email | postal-mime（MIT-0）、@kenjiuno/msgreader（Apache-2.0） | ✅ | eml/msg/mbox 均桥接 file-viewer renderer-email（第一波；MIME 结构与附件渲染，嵌套附件经 renderNestedBuffer 转交 vviewer 分派） |
| 19 | `eda` | EDA 电路 | `.olb` `.dra` `.gds` `.oas` `.oasis` | structured / stable | renderer-eda | cfb（Apache-2.0）+ eda-layout/eda-orcad 自研 | ❌ | — |
| 20 | `cad` | CAD 图纸 | `.dxf` `.dwg` `.dwf` `.dwfx` `.xps` | high-fidelity / stable | renderer-cad | **@flyfish-dev/cad-viewer（AGPL-3.0-only）**；链上 dwf-viewer（AGPL-3.0-only）、LibreDWG bindings（GPL-3.0-only）、dxf-parser（MIT） | ❌ | 五者均未注册；**引用红线**（AGPL 会传染本项目） |
| 21 | `model` | 3D 模型 | `.glb` `.gltf` `.obj` `.stl` `.ply` `.fbx` `.dae` `.3ds` `.3mf` `.amf` `.usd` `.usda` `.usdc` `.usdz` `.kmz` `.step` `.stp` `.iges` `.igs` `.ifc` `.3dm` `.brep` `.pcd` `.wrl` `.vrml` `.xyz` `.vtk` `.vtp` | structured / stable | renderer-3d + geometry-engine | three（MIT）、**occt-import-js（LGPL-2.1）**、epsg-index（ISC） | 🟡 | 仅 `.gltf` 落 code 兜底（JSON 文本视图）；其余 27 个未注册；**引用红线**（LGPL 超出许可白名单） |
| 22 | `geo` | 地理数据 | `.geojson` `.kml` `.gpx` `.shp` | structured / stable | renderer-geo | maplibre-gl（BSD-3）、shpjs（MIT）、proj4（MIT）、@tmcw/togeojson（BSD-2） | 🟡 | geojson/kml/gpx 落 code 兜底（JSON/XML 文本视图）；`.shp` 未注册；无地图渲染 |
| 23 | `drawing` | 白板/图表文件 | `.excalidraw` `.drawio` `.dio` `.mermaid` `.mmd` `.plantuml` `.puml` | structured / stable | renderer-drawing | roughjs（MIT）、plantuml-encoder（MIT）、mermaid（MIT）；drawio 官方运行时经 assets-drawing | 🟡 | mermaid/mmd/plantuml/puml/excalidraw 落 diagram-file 专有渲染器（计划 1，三分发降级链）；同名图表**源码**在 markdown 围栏内可渲染；drawio/dio 未注册，无图形化文件预览 |
| 24 | `bpmn` | BPMN 2.0 | `.bpmn` | structured / experimental | renderer-drawing（opt-in） | bpmn-js（bpmn.io 自有许可，保留水印） | 🟡 | `.bpmn` 落 diagram-bpmn 专有渲染器（计划 1：bpmn-js NavigatedViewer CDN 引擎/kroki 分发降级链）；无 renderer-drawing 的 opt-in 装配面 |
| 25 | `mindmap` | 思维导图 | `.xmind` | structured / stable | renderer-mindmap | @ljheee/xmind-parser（MIT）、@panzoom/panzoom（MIT） | ❌ | — |
| 26 | `epub` | EPUB | `.epub` | high-fidelity / stable | renderer-epub | epubjs（BSD-2）以**包内离线资产**分发（README:49 原文）、pako（MIT AND Zlib） | ✅ | 桥接 file-viewer renderer-epub（第一波，epubjs 随 dist 打包） |
| 27 | `ebook-fb2` | FictionBook | `.fb2` | structured / stable | renderer-epub | 自研解析 | ✅ | 桥接 file-viewer renderer-epub（第一波） |
| 28 | `umd` | UMD 电子书 | `.umd` | structured / stable | renderer-epub | 自研 + pako（MIT AND Zlib） | ✅ | 桥接 file-viewer renderer-epub（第一波） |
| 29 | `image` | 图片 | `.gif` `.jpg` `.jpeg` `.bmp` `.tiff` `.tif` `.png` `.svg` `.webp` `.avif` `.ico` `.heic` `.heif` `.jxl` | high-fidelity / stable | renderer-image | heic2any（MIT）、utif（MIT） | 🟡 | 9/14 专有：`png/jpeg/jpg/gif/webp/avif/bmp/ico/svg`（原生 `<img>` + svg 消毒 + 自研 lightbox，`image.ts:99`）；tiff/tif/heic/heif/jxl 未注册 |
| 30 | `dicom` | 医学影像 | `.dcm` `.dicom` | basic / experimental | renderer-dicom | dicom-parser（MIT）、pako | ❌ | — |
| 31 | `signature` | 数字签名/证据容器 | `.p7m` `.p7s` `.p7c` `.p7b` `.pkcs7` `.cms` `.cmsc` `.tsd` `.tst` `.tsq` `.tsr` `.asics` `.scs` `.asice` `.sce` `.ers` `.asc` `.sig` `.pgp` `.gpg` `.jws` | structured / experimental | renderer-signature | jszip（MIT）+ 自研 CMS/ASiC/RFC3161/OpenPGP 结构检视 | 🟡 | 仅 `.sig` 落 code 兜底；其余 20 个未注册；无结构检视 |
| 32 | `markdown` | Markdown | `.md` `.markdown` | structured / stable | renderer-text | marked（MIT）、highlight.js（BSD-3）、dompurify（Apache-2.0） | ✅ | **更强**：markdown-it 15 + deflist/footnote/ins/mark/task-lists（MIT/ISC）、yaml front-matter（ISC）、katex 数学（MIT）、30 类图表注册表、五类 sanitize 防线、tree-sitter 代码块高亮（`markdownRenderer.ts:737`） |
| 33 | `code` | 代码/文本 | `.txt` `.lrc` `.json` `.js` `.mjs` `.cjs` `.css` `.java` `.py` `.html` `.htm` `.jsx` `.ts` `.tsx` `.xml` `.log` `.vue` `.yaml` `.yml` `.ini` `.sh` `.bash` `.sql` `.go` `.rs` `.php` `.c` `.cpp` `.cc` `.h` `.hpp` `.cs` `.diff` `.patch` `.bundle` `.bdl` `.jsonc` `.json5` `.ipynb` `.toml` `.proto` `.hcl` `.tex` `.gv` `.http` `.react` `.rb` `.swift` `.kt` | structured / stable | renderer-text | highlight.js（BSD-3）、prettier + @prettier/plugin-xml（MIT） | ✅ | **更广**：web-tree-sitter 0.25.10（MIT）301 语言全量对齐 helix（lite 集 34 wasm 内嵌）+ hljs 11 兜底；code 内置 52 项（`code/index.ts:54`）+ 生成物 670 项补空位 + html 专有渲染器。49 个中 38 个专有命中（35 builtin + html/htm 归专有沙箱渲染器 + gv 归 diagram-graphviz 专有）、6 个生成物兜底（cs/json5/ipynb/proto/hcl/tex）、**缺 5**：`lrc/bundle/bdl/http/react`（helix 语言表无此 token，生成器不产）。检测表 342 语言/685 扩展名；512MB 窗口流式 |
| 34 | `video` | 视频 | `.mp4` `.webm` `.m3u8` | high-fidelity / stable | renderer-media | 零依赖（浏览器原生） | ✅ | **更广**：`mp4/m4v/mov/webm/ogg/m3u8/flv/mp3/wav/flac/m4a/aac/oga/opus`（`av.ts:356`）；artplayer（MIT）+ hls.js（Apache-2.0）+ mpegts.js（Apache-2.0） |
| 35 | `audio` | 音频 | `.mp3` `.mpeg` `.wav` `.ogg` `.oga` `.opus` `.m4a` `.aac` `.flac` `.weba` `.midi` `.mid` | high-fidelity / stable | renderer-media + capability-midi | @tonejs/midi（MIT） | 🟡 | 10/12 专有（mp3/wav/ogg/oga/opus/m4a/aac/flac + mpeg/weba 别名已补绑，`5a6d53f`）；`.midi/.mid` 无（file-viewer 有专有 MIDI 检视 @tonejs/midi） |
| 36 | `photoshop-design` | Photoshop | `.psb` `.pdd` `.psdt` `.psd` | experimental | renderer-design | @webtoon/psd（MIT）、ag-psd（MIT） | ❌ | — |
| 37 | `illustrator-pdf-design` | Illustrator | `.ait` `.ai` | experimental | renderer-design | illustrator-pgf（MIT）、ag-psd（MIT）、fzstd（MIT）、saxes（ISC） | ❌ | — |
| 38 | `indesign-idml-design` | InDesign IDML | `.idml` | experimental | renderer-design | @paged-media/introspect-wasm（**MPL-2.0 OR LicenseRef-PMEL**） | ❌ | 双许可含自定义面，引用需回避 LicenseRef-PMEL |
| 39 | `indesign-exchange-design` | InCopy/IDMS/INX | `.icml` `.idms` `.inx` | experimental | renderer-design | 自研 | ❌ | — |
| 40 | `adobe-animate-xfl-design` | Animate XFL | `.fla` `.xfl` | experimental | renderer-design | 自研 | ❌ | — |
| 41 | `adobe-xd-design` | Adobe XD | `.xd` | experimental | renderer-design | 自研 | ❌ | — |
| 42 | `indesign-native-design` | InDesign 原生 | `.indd` `.indt` | experimental | renderer-design | 自研 | ❌ | — |
| 43 | `postscript-design` | EPS/PostScript | `.ps` `.eps` | experimental | renderer-design | Stet WASM（内嵌 URW Base35 OFL-1.1 字体、ICC profile CC0——catalog 注记） | ❌ | — |
| 44 | `adobe-palette-design` | Adobe 色板 | `.ase` `.aco` | structured / stable | renderer-design | 自研解析 | ❌ | — |
| 45 | `photoshop-resource-design` | PS 资源预设 | `.abr` `.csh` `.pat` `.grd` `.asl` | experimental | renderer-design | ag-psd（MIT） | ❌ | — |
| 46 | `data-asset` | 数据/字体资产 | `.ttf` `.otf` `.woff` `.woff2` `.psd` `.ai` `.eps` `.sqlite` `.wasm` `.parquet` `.avro` `.webarchive` | structured / stable | renderer-data | sql.js（MIT）、hyparquet（MIT）、ag-psd（MIT）、avsc（MIT） | 🟡 | `.wasm` 落 hex 专有；字体扩展名走「字体加载」通道（fonts store，应用字体而非查看器）；psd/ai/eps/sqlite/parquet/avro/webarchive 未注册 |
| 47 | `binary-inspector` | 二进制检视 | `.bin` `.hex` `.elf` `.exe` `.dll` `.class` `.macho` | structured / experimental | renderer-binary | 零依赖自研（模板目录检视，opt-in） | ✅ | 覆盖 bin/exe/dll/elf/class 且更广：`hex/bin/exe/dll/so/dylib/macho/elf/o/a/class/wasm/dat/img/iso/dmg`（`hex.ts:785`；hex/macho 补绑见 §4.4），含 worker 搜索/跳转/数据检查器。注：仅 `.macho` 曾缺（`32993c8` 补绑），现 7/7 全命中 |

### 3.1 扩展名级覆盖统计（脚本核验；2026-11-06 第一波回写，基线 dbebfd2 口径 + 四笔增量并账）

- file-viewer 47 管线去重后 **275 个扩展名**，vviewer 侧四桶：**专有渲染器命中 111**（初版 81 + 批次一 3〔hex→hex、mpeg/weba→av，`5a6d53f`〕+ 批次二 19〔macho→hex、archive 补绑 18，`32993c8`〕+ 计划 1 图表文件 8〔dot/mermaid/mmd/bpmn 自兜底转入、gv/plantuml/puml/excalidraw 自未注册转入〕），**file-viewer 桥接 41**（第一波 10 组，`a972bff`：eml/msg/mbox、epub/fb2/umd、ofd、chm、doc/docm/dotx/dotm/odt/odp/rtf、ppt/pot/pptm/potx/potm/ppsx/ppsm、xltx/xlsb/xlt/xla/xlam/xltm/ods/fods/dbf/tsv、pages/numbers/key、hwp/hwpx、wpd/wp/wp5/wp6），**code 文本兜底 13**（typ/typst/gltf/geojson/kml/gpx/sig/cs/json5/ipynb/proto/hcl/tex），**未注册 110**（含 file-viewer code 管线特有 4 个：lrc/bundle/bdl/http/react——gv 已归 diagram-graphviz 专有；其余如 zst/tzst/zipx、dicom/cad/eda 系、design 系 10 管线、shp、xmind、tiff/tif/heic/heif/jxl、midi/mid、sqlite/parquet/avro/webarchive 等）。111+41+13+110=275，与 catalog 头注吻合。
- **桥接 41 的来源构成**（逐项对 generated-extensions 670 项 + code 内置 52 项实测）：code 兜底转出 3（eml/pot/fods，均在 generated 内）+ 未注册转出 38（37 项直转 + tsv——批次一先入 code 内置、`a972bff` 原子转移至桥接）。未注册 174 − 38 − 4（gv/plantuml/puml/excalidraw）− 22（hex/mpeg/weba/macho + archive 18）= 110。
- 未注册 ≠ 打不开：vviewer 对未注册扩展名走运行时探测链（签名 → looksTextual → hex 字节），文本性内容仍可按 code/plain 打开，但**无专有渲染器**（结构化预览/表格/地图/邮件解析等能力缺失）。

## 4. 差距分析

### 4.1 vviewer 已覆盖且占优的面（file-viewer 无对应或明显更弱）

| 面 | vviewer | file-viewer |
| --- | --- | --- |
| HTML 预览 | 专有 `html/htm` 渲染器：DOMPurify 双层净化 + CSP + sandbox iframe（opaque origin） | 无独立管线（html/htm 归 code 文本高亮） |
| JSONL | 专有 `jsonl/ndjson` 渲染器：行卡片折叠、可变高度虚拟窗口、流式块级 | 无（归 code 文本） |
| hex 增强 | 稳定管线 + worker 搜索（hex/文本双模式）/0x 跳转/数据检查器/流式 64KB×8 LRU | 实验性 opt-in，模板目录检视定位 |
| 代码语法 | tree-sitter 301 语言全量（服务端+客户端）+ 214 主题 + VSCode 双主题/Seti 图标 | hljs 精简面 |
| markdown 图表 | 30 类注册表（对齐 kroki v0.33.0）：本地 mermaid/graphviz/nomnoml/math/svgbob，其余 Kroki 服务/CDN | mermaid 经 capability，无 kroki 矩阵 |
| 大文件 | IO 级流式（512MB 上限，hex/jsonl/code 三渲染器后台索引泵） | 未见对应机制（以单文件整载为主） |
| 架构 | 本地 FS Access + Rust 服务端（SSE watch/NDJSON search/range 流）+ S3/WebDAV 直连 + PWA 离线 + Tauri 桌面 + Cloudflare Workers | 纯前端单机形态（Workers/WASM 资产自托管） |

### 4.2 vviewer 完全缺口、且 file-viewer 许可干净（引用价值区）

（**第一波勾销**，2026-11-06：文档类〔Word 二进制 doc/dot——doc 桥接、dot 图表文件；PPT 97-2003 ppt/pot；RTF；ODT/ODP；dBASE；WordPerfect〕、阅读类〔EPUB/fb2/UMD〕、企业/区域格式〔OFD、CHM、Hangul、iWork 三件套〕、其他类中 Email 结构化渲染（msg/mbox）均已转 ✅，见 §3 对应行。）

- **数据类**：SQLite、Parquet、Avro、WebArchive（renderer-data 一包全含，sql.js/hyparquet/avsc 均 MIT）
- **其他**：geo 地图渲染（shp/shapefile）、DICOM、XMind、Typst 渲染式预览、签名/证据容器结构检视、字体文件查看（ttf/otf/woff 系）、图片增强（tiff/heic/heif/jxl）

（typ/typst/geojson/kml/gpx/gltf 等虽有 code 文本兜底，但缺的是**结构化渲染能力**，仍在引用价值区内；mermaid/mmd/bpmn 已由计划 1 图表文件管线转正、eml/msg/mbox 已由第一波桥接转正。）

### 4.3 引用建议（承接 2026-11-04 可行性结论）

1. **按格式挑包，不整装引入**：`@file-viewer/core` + §4.2 清单对应 renderer，逐个注册为 vviewer dispatch 的 fallback 渲染器；与 vviewer 已有自研面重叠的（text/markdown/image/media/archive/pdf/word/xlsx/pptx/hex）不引。
2. **禁引**：`renderer-cad`、`renderer-3d`、`preset-all`、`preset-engineering`、全部 `*-full` 壳（AGPL/LGPL 连带）；`renderer-design` 系若引，需就 `@paged-media/introspect-wasm` 双许可取 MPL-2.0 面并回避 LicenseRef-PMEL；drawing 的 bpmn-js 为自有许可，独立 `.bpmn` 文件支持建议维持 Kroki 兜底。
3. **集成成本点**：file-viewer 吃 File/Buffer/URL，vviewer Range 流式源需物化 Blob 再喂或走其 `mountViewer` URL 通道；Worker/WASM/字体资产经 `file-viewer-copy-assets`/`vite-plugin` 落盘后挂入 vviewer 现有三层资产链。
4. **合规义务**：引入即更新 `THIRD_PARTY_NOTICES.md`；顺带补现有台账缺口（`@viz-js/viz` MIT、`nomnoml` MIT、`pako` MIT AND Zlib——2026-10-19 图表批引入，均干净但未入账）。

### 4.4 连带发现的 vviewer 侧扩展名绑定缺口（引用前可顺手修）

1. **hex 渲染器未绑定 `.hex` 扩展名**（`hex.ts:785` 清单无此项）——hex 查看器不认 `.hex` 文件名，探测链下落 hex 字节视图结果一致但路径绕远，属反直觉缺口。
2. **av 渲染器未绑定 `.mpeg`/`.weba` 别名**（mp3/ogg 已绑，两常见别名漏绑）。
3. **`.tsv` 未在任何清单**（csv 在 code 内置清单，tsv 缺席；探测链可按文本打开但无专有归属）。

以上三项均为单行级修改，可另行立项随手清偿。

**已全部清偿（2026-11-06 核验）**：1/2 由 `5a6d53f` 补绑（hex→hex.ts、mpeg/weba→av.ts），`.macho` 由 `32993c8` 补绑；3 的 tsv 经第一波桥接归 renderer-spreadsheet（`a972bff` 自 code 内置原子转移）。

## 5. 信息来源与核验方法

| 事实 | 来源 |
| --- | --- |
| 275/225/50/47 与全部管线扩展名 | `file-viewer/docs/generated/format-catalog.md`（生成文件，58 行，头注 "Generated by scripts/generate-format-catalog.mjs. Do not edit directly."） |
| 管线 → 实现包权威映射 | `file-viewer/packages/tools/cli/catalog/catalog.json`（capability 清单：`spreadsheet`=renderer-spreadsheet 含 dbf；`design`/`epub`/`iwork`/`media`/`text`/`word` 的多管线归属一并坐实） |
| 各实现包与 engine deps | `file-viewer/packages/renderers/*/package.json` 及各包 README（word:5 确认 ODT/ODP 归属、rtf 经 capability；ebook:49 确认 epubjs 包内资产分发） |
| AGPL/LGPL/GPL 链 | npm registry 实查（`npm view <pkg> license`，2026-11-04，registry.npmjs.org）：`@flyfish-dev/cad-viewer@0.8.3`=AGPL-3.0-only、`occt-import-js@0.0.23`=LGPL-2.1；`file-viewer/packages/build-support/cad-source-snapshots/3.3.3/README.md`（dwf-viewer/LibreDWG 原文） |
| PDF 引擎版本 | `file-viewer/packages/build-support/licenses/asset-family-materials.json` materials[28..47]：`pdfjs-dist@5.4.624`（npm 同版本页为 source；cmaps/standard_fonts/wasm 全量钉版）；vendor 路径 `packages/renderers/pdf/dist/vendor/pdfjs/`；`stage-pdfjs-runtime.mjs` 确定性模板 |
| 全部第三方引擎许可证 | 同上 npm 批查（postal-mime/msgreader/sql.js/hyparquet/ag-psd/avsc/maplibre-gl/shpjs/proj4/togeojson/three/epsg-index/dxf-parser/xmldom/d3-format/noto-sans-sc/dingbat-to-unicode/introspect-wasm/fzstd/saxes/modern-screenshot/viz/nomnoml/pako/three/marked/prettier/heic2any/typst-ts 系/bpmn-js 等约 60 项） |
| vviewer 扩展名绑定与覆盖矩阵 | 绑定点见 §3 表头注；生成物 `packages/vviewer-core/src/registry/generated-extensions.ts`（670 项，实测）；覆盖矩阵为本报告 python 脚本核验（catalog 去重 275 × vviewer 专有绑定 + builtin 52 + generated 670），逐管线结果已回写 §3/§3.1；2026-11-06 增量对账源：`5a6d53f`/`32993c8`/`a972bff` commit 记录 + `packages/vviewer-render-text/src/diagramFile.ts:59` + `apps/web/src/lib/foreignRenderers.ts:166`（装配面实测） |
| vviewer 依赖许可台账 | 本仓库 `THIRD_PARTY_NOTICES.md`；依赖清单复核自各 `packages/vviewer-*/package.json` |
| 图表 30 类注册表 | `packages/vviewer-render-diagram/src/markdown/diagrams.ts:2`（对齐 kroki v0.33.0）及 `diagrams.test.ts` |
| 语法/检测规模口径 | README（301 语言全量对齐、lite 34 wasm、检测表 342 语言/685 扩展名）+ `tools/grammar-builder/gen-code-extensions.mjs`（生成物入库 + CI `--check`） |

## 6. 初版未决点查证结论（2026-11-04 收口）

**① `.dbf` 管线归属 → 已决**：`spreadsheet-dbf` 属 `@file-viewer/renderer-spreadsheet`（与 spreadsheet-openxml 同包同 capability `spreadsheet`）。证据：CLI catalog `packages/tools/cli/catalog/catalog.json` capabilities[23]（`rendererIds: ["spreadsheet-openxml","spreadsheet-dbf"]`、formats 含 `dbf`、license Apache-2.0/policy permissive）。解析引擎为包内自研（deps 无 dbf 专用库）。

**② code 管线 10 个存疑扩展名 → 已决（逐一核销）**：以 `generated-extensions.ts`（670 项实测）+ code 内置清单精确比对——
- **已被 vviewer 覆盖（4）**：`ipynb`、`tex`、`hcl`、`json5`（均落 code 兜底，有语法高亮）；
- **vviewer 完全没有（6）**：`lrc`、`bundle`、`bdl`、`gv`、`http`、`react`（helix languages.json 无此 token，生成器不产）。
连带产出全管线扩展名级覆盖矩阵（§3.1）：专有命中 81 / code 兜底 20 / 未注册 174（275 去重总数；初版口径，2026-11-06 已按批次一/二、计划 1 图表文件与第一波桥接增量回写，现值见 §3.1）。

**③ renderer-pdf 的 pdf 引擎版本 → 已决**：`pdfjs-dist@5.4.624`。证据链：`packages/build-support/licenses/asset-family-materials.json`（materials[28..47] 十余条目 component 字段统一 `pdfjs-dist@5.4.624`，source 指 npm 同版本页，含 cmaps/Liberation 标准字体/JBIG2/OpenJPEG/QCMS wasm 各资产许可证条目）+ `packages/renderers/pdf/scripts/stage-pdfjs-runtime.mjs`（确定性钉版模板）+ assets-standard README:5（资产自托管范围含 PDF）。引擎本体 Apache-2.0。
