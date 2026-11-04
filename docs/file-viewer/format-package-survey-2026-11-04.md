# file-viewer 格式·包·许可证对照调研报告

- **调研日期**：2026-11-04
- **调研对象**：[flyfish-dev/file-viewer](https://github.com/flyfish-dev/file-viewer) v3.3.3（本地检出 `/share/rw/repo/github/file-viewer`，经 npm registry 核实与线上最新版一致）
- **对照基线**：vviewer（本仓库）HEAD `5c26c59`
- **性质**：引用可行性调研的格式级细化。包家族与许可证面上的结论承接 2026-11-04 会话初步检查，本文给出 47 条渲染管线的逐行对照。

## 1. 结论摘要

1. file-viewer 为**模块化 npm 包家族**：60+ 个包（scope `@file-viewer`），统一版本 3.3.3，全部在售。注册 **275 个扩展名**（stable 225 / experimental 50），横跨 **47 条渲染管线**（数字与逐行扩展名均出自其生成目录 `docs/generated/format-catalog.md`）。
2. 许可证**主体 Apache-2.0**（`@file-viewer/doc` 为 MIT），与本项目引入约束（MIT / Apache-2.0 / BSD / ISC / MPL-2.0）兼容；但有两条**硬红线**：
   - **CAD 链是 AGPL-3.0-only**：`@file-viewer/renderer-cad` → `@flyfish-dev/cad-viewer@0.8.3`（npm 实查 AGPL-3.0-only），链上另有 `dwf-viewer`（AGPL-3.0-only）与 LibreDWG bindings（GPL-3.0-only）。上游自知此事，仓库内随附 `file-viewer-cad-corresponding-source` 源码快照合规包（`packages/build-support/cad-source-snapshots/3.3.3/README.md` 原文："CAD 0.8.3 and DWF 0.6.7 retain their AGPL-3.0-only terms; LibreDWG bindings 0.7.9 retain GPL-3.0-only terms"）。
   - **3D/STEP/IFC 链含 LGPL-2.1**：`@file-viewer/renderer-3d` → `occt-import-js@0.0.23`（npm 实查 LGPL-2.1），超出本项目允许清单。
   - 连带禁区：`preset-all`、`preset-engineering`、全部 `*-full` 组件壳均依赖 renderer-cad。
3. 与 vviewer 逐行对照：**✅ 同等或更广 5 条**（pdf / markdown / code / video / binary-inspector），**🟡 部分覆盖 6 条**（Word·PPTx·Excel·archive·image·audio），**◐ 机制不同 3 条**（drawing / bpmn / data-asset——同名内容在 vviewer 经 markdown 图表或 hex 通道覆盖，独立文件不支持），**❌ 完全缺口 33 条**。缺口即引用价值区，详见 §4.3 挑包建议。
4. 顺带发现本仓库台账缺口：图表批次（2026-10-19 spec）引入的 `@viz-js/viz`、`nomnoml`、`pako` 未入 `THIRD_PARTY_NOTICES.md`，建议随引用工作一并补齐。

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

### 2.2 许可证结论

| 对象 | 许可证 | 依据 |
| --- | --- | --- |
| 家族主体（core / 全部 renderer / capability / preset / 组件壳） | Apache-2.0 | 各 package.json `license` 字段 + npm registry 实查（2026-11-04） |
| `@file-viewer/doc` | MIT | 同上 |
| **CAD 引擎** `@flyfish-dev/cad-viewer@0.8.3` | **AGPL-3.0-only** | npm 实查；对应源码快照 README 原文（§1-2） |
| CAD 链上 `dwf-viewer@0.6.7` | AGPL-3.0-only | 同上 |
| CAD 链上 LibreDWG bindings 0.7.9 | GPL-3.0-only | 同上 |
| **3D 引擎** `occt-import-js@0.0.23` | **LGPL-2.1** | npm 实查 |
| `@fontsource-variable/noto-sans-sc`（renderer-pdf 唯一 deps） | OFL-1.1 | npm 实查；字体资产，对代码无传染，但不在本项目许可白名单字面内 |
| bpmn-js（drawing 包 BPMN opt-in） | 「SEE LICENSE IN LICENSE」（bpmn.io 自有许可，含保留水印条款） | npm 实查 + catalog 注记 "The bpmn.io watermark is retained under the upstream license" |
| `@paged-media/introspect-wasm`（InDesign IDML） | **MPL-2.0 OR LicenseRef-PMEL**（双许可含自定义许可） | npm 实查；取 MPL-2.0 面可用，LicenseRef-PMEL 未公开定义需回避 |
| PostScript（EPS）渲染的 Stet WASM 运行时 | 运行时本体随包分发，**内嵌** URW Base35 字体（OFL-1.1）与 Compact ICC CMYK profile（CC0） | catalog `postscript-design` 行 Known limits 原文 |

**preset 组合的许可安全面**：`preset-standard`（deps 无 CAD/3D）、`preset-lite`、`preset-office` 干净；`preset-all` 与 `preset-engineering` 因含 `renderer-cad`/`renderer-3d` 整体踩线。

## 3. 格式对照总表（47 管线逐行）

扩展名清单**逐字摘自** `docs/generated/format-catalog.md`（该文件由 `scripts/generate-format-catalog.mjs` 生成，头注 "Do not edit directly"）。级别/状态两列合一。

**vviewer 状态图例**：✅ 支持且同等或更广；🟡 部分扩展名；◐ 机制不同（同类内容经其他通道覆盖，独立文件不支持）；❌ 不支持。vviewer 渲染器绑定出处见 §5。

| # | 管线 ID | 格式族 | 扩展名（file-viewer） | 级别/状态 | file-viewer 实现包 | 关键引擎依赖（许可证） | vviewer | vviewer 实现（依赖·许可证） |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `office-word-openxml` | Word OpenXML | `.docx` `.docm` `.dotx` `.dotm` | high-fidelity / stable | renderer-word | @file-viewer/doc（MIT）、@file-viewer/docx（Apache-2.0）、jszip（MIT） | 🟡 | 仅 `.docx`：mammoth（BSD-2）+jszip；docm/dotx/dotm 无 |
| 2 | `office-word-binary` | Word 97-2003 | `.doc` `.dot` | structured / stable | renderer-word | 同上 | ❌ | — |
| 3 | `office-presentation-binary` | PowerPoint 97-2003 | `.ppt` `.pot` | structured / stable | renderer-presentation | @file-viewer/ppt（Apache-2.0） | ❌ | — |
| 4 | `office-presentation` | PowerPoint OpenXML | `.pptx` `.pptm` `.potx` `.potm` `.ppsx` `.ppsm` | high-fidelity / stable | renderer-presentation | @file-viewer/pptx（Apache-2.0；dingbat-to-unicode BSD-2、tinycolor2 MIT、utif MIT） | 🟡 | 仅 `.pptx`：自研 OOXML 渲染（jszip MIT；`vviewer-render-doc/src/pptx.ts`+`ooxml.ts`），其余变体无 |
| 5 | `open-document` | RTF/OpenDocument | `.rtf` `.odt` `.odp` | structured / stable | renderer-word（ODT/ODP 读 content.xml；README:5）+ capability-rtf | rtf.js（MIT） | ❌ | — |
| 6 | `spreadsheet-openxml` | 电子表格 | `.xlsx` `.xltx` `.xlsm` `.xlsb` `.xls` `.xlt` `.xla` `.xlam` `.xltm` `.csv` `.tsv` `.ods` `.fods` | structured / stable | renderer-spreadsheet | styled-exceljs（Apache-2.0）、e-virt-table（MIT）、@xmldom/xmldom（MIT）、utif（MIT）、tinycolor2（MIT） | 🟡 | `.xlsx/.xlsm/.xls`：SheetJS xlsx 0.20.3（Apache-2.0）；`.csv/.tsv` 落 code 纯文本（无表格化）；其余变体无 |
| 7 | `apple-pages` | Apple Pages | `.pages` | high-fidelity / stable | renderer-iwork | keynote-archives（MIT）、styled-exceljs（Apache-2.0） | ❌ | — |
| 8 | `apple-numbers` | Apple Numbers | `.numbers` | high-fidelity / stable | renderer-iwork | 同上 | ❌ | — |
| 9 | `apple-keynote` | Apple Keynote | `.key` | high-fidelity / stable | renderer-iwork | 同上 | ❌ | — |
| 10 | `office-wordperfect` | WordPerfect | `.wpd` `.wp` `.wp5` `.wp6` | structured / stable | renderer-wordperfect | 零依赖自研 | ❌ | — |
| 11 | `spreadsheet-dbf` | dBASE | `.dbf` | structured / stable | （catalog 有此管线；实现包在 renderers 目录 rg 未定位到归属） | — | ❌ | — |
| 12 | `pdf` | PDF | `.pdf` | high-fidelity / stable | renderer-pdf | 包 deps 仅 @fontsource-variable/noto-sans-sc（OFL-1.1）；pdf 引擎以自托管资产分发 | ✅ | pdfjs-dist（Apache-2.0），含文本层（`pdfText.ts`） |
| 13 | `ofd` | OFD 版式 | `.ofd` | structured / stable | renderer-ofd | jszip（MIT），解析自研 | ❌ | — |
| 14 | `office-hangul` | 韩文 HWP | `.hwp` `.hwpx` | structured / stable | renderer-hangul | @ssabrojs/hwpxjs（MIT）、cfb（Apache-2.0） | ❌ | — |
| 15 | `typst` | Typst | `.typ` `.typst` | high-fidelity / stable | renderer-typst | @myriaddreamin/typst-ts-web-compiler/-ts-renderer（均 Apache-2.0） | ❌ | markdown 内数学为 katex（MIT），非 Typst |
| 16 | `archive` | 压缩包 | `.zip` `.zipx` `.7z` `.rar` `.tar` `.gz` `.gzip` `.tgz` `.bz2` `.bzip2` `.tbz` `.tbz2` `.xz` `.txz` `.lzma` `.zst` `.tzst` `.cab` `.ar` `.cpio` `.iso` `.xar` `.lha` `.lzh` `.jar` `.war` `.ear` `.apk` `.cbz` `.cbr` | structured / stable | renderer-archive | jszip（MIT）、libarchive.js（MIT） | 🟡 | 8/29：`zip/tar/gz/tgz/bz2/xz/7z/rar`（同两库，`vviewer-render-archive/src/archive.ts:120`）；zipx/iso/cab/lha/zst 系/jar/war/ear/apk/cbz/cbr 等无 |
| 17 | `chm` | Compiled HTML Help | `.chm` | structured / stable | renderer-chm | 零依赖自研（ITSF + LZX 解压） | ❌ | — |
| 18 | `email` | 电子邮件 | `.eml` `.msg` `.mbox` | structured / stable | renderer-email | postal-mime（MIT-0）、@kenjiuno/msgreader（Apache-2.0） | ❌ | — |
| 19 | `eda` | EDA 电路 | `.olb` `.dra` `.gds` `.oas` `.oasis` | structured / stable | renderer-eda | cfb（Apache-2.0）+ eda-layout/eda-orcad 自研 | ❌ | — |
| 20 | `cad` | CAD 图纸 | `.dxf` `.dwg` `.dwf` `.dwfx` `.xps` | high-fidelity / stable | renderer-cad | **@flyfish-dev/cad-viewer（AGPL-3.0-only）**；链上 dwf-viewer（AGPL-3.0-only）、LibreDWG bindings（GPL-3.0-only）、dxf-parser（MIT） | ❌ | **引用红线**（AGPL 会传染本项目） |
| 21 | `model` | 3D 模型 | `.glb` `.gltf` `.obj` `.stl` `.ply` `.fbx` `.dae` `.3ds` `.3mf` `.amf` `.usd` `.usda` `.usdc` `.usdz` `.kmz` `.step` `.stp` `.iges` `.igs` `.ifc` `.3dm` `.brep` `.pcd` `.wrl` `.vrml` `.xyz` `.vtk` `.vtp` | structured / stable | renderer-3d + geometry-engine | three（MIT）、**occt-import-js（LGPL-2.1）**、epsg-index（ISC） | ❌ | **引用红线**（LGPL 超出许可白名单） |
| 22 | `geo` | 地理数据 | `.geojson` `.kml` `.gpx` `.shp` | structured / stable | renderer-geo | maplibre-gl（BSD-3）、shpjs（MIT）、proj4（MIT）、@tmcw/togeojson（BSD-2） | ❌ | — |
| 23 | `drawing` | 白板/图表文件 | `.excalidraw` `.drawio` `.dio` `.mermaid` `.mmd` `.plantuml` `.puml` | structured / stable | renderer-drawing | roughjs（MIT）、plantuml-encoder（MIT）、mermaid（MIT）；drawio 官方运行时经 assets-drawing | ◐ | 独立文件不支持；同名图表**源码**在 markdown 围栏内可渲染（mermaid 本地、plantuml/excalidraw 经 Kroki，见 32/33 行与 §4.1） |
| 24 | `bpmn` | BPMN 2.0 | `.bpmn` | structured / experimental | renderer-drawing（opt-in） | bpmn-js（bpmn.io 自有许可，保留水印） | ◐ | markdown 围栏内 bpmn 经 Kroki；独立文件不支持 |
| 25 | `mindmap` | 思维导图 | `.xmind` | structured / stable | renderer-mindmap | @ljheee/xmind-parser（MIT）、@panzoom/panzoom（MIT） | ❌ | — |
| 26 | `epub` | EPUB | `.epub` | high-fidelity / stable | renderer-epub | epubjs（BSD-2）以**包内离线资产**分发（README:49 原文）、pako（MIT AND Zlib） | ❌ | — |
| 27 | `ebook-fb2` | FictionBook | `.fb2` | structured / stable | renderer-epub | 自研解析 | ❌ | — |
| 28 | `umd` | UMD 电子书 | `.umd` | structured / stable | renderer-epub | 自研 + pako（MIT AND Zlib） | ❌ | — |
| 29 | `image` | 图片 | `.gif` `.jpg` `.jpeg` `.bmp` `.tiff` `.tif` `.png` `.svg` `.webp` `.avif` `.ico` `.heic` `.heif` `.jxl` | high-fidelity / stable | renderer-image | heic2any（MIT）、utif（MIT） | 🟡 | 9/14：`png/jpeg/jpg/gif/webp/avif/bmp/ico/svg`（原生 `<img>` + svg 消毒 + 自研 lightbox，`image.ts:99`）；tiff/heic/heif/jxl 无 |
| 30 | `dicom` | 医学影像 | `.dcm` `.dicom` | basic / experimental | renderer-dicom | dicom-parser（MIT）、pako | ❌ | — |
| 31 | `signature` | 数字签名/证据容器 | `.p7m` `.p7s` `.p7c` `.p7b` `.pkcs7` `.cms` `.cmsc` `.tsd` `.tst` `.tsq` `.tsr` `.asics` `.scs` `.asice` `.sce` `.ers` `.asc` `.sig` `.pgp` `.gpg` `.jws` | structured / experimental | renderer-signature | jszip（MIT）+ 自研 CMS/ASiC/RFC3161/OpenPGP 结构检视 | ❌ | — |
| 32 | `markdown` | Markdown | `.md` `.markdown` | structured / stable | renderer-text | marked（MIT）、highlight.js（BSD-3）、dompurify（Apache-2.0） | ✅ | **更强**：markdown-it 15 + deflist/footnote/ins/mark/task-lists（MIT/ISC）、yaml front-matter（ISC）、katex 数学（MIT）、30 类图表注册表、五类 sanitize 防线、tree-sitter 代码块高亮（`markdownRenderer.ts:737`） |
| 33 | `code` | 代码/文本 | `.txt` `.lrc` `.json` `.js` `.mjs` `.cjs` `.css` `.java` `.py` `.html` `.htm` `.jsx` `.ts` `.tsx` `.xml` `.log` `.vue` `.yaml` `.yml` `.ini` `.sh` `.bash` `.sql` `.go` `.rs` `.php` `.c` `.cpp` `.cc` `.h` `.hpp` `.cs` `.diff` `.patch` `.bundle` `.bdl` `.jsonc` `.json5` `.ipynb` `.toml` `.proto` `.hcl` `.tex` `.gv` `.http` `.react` `.rb` `.swift` `.kt` | structured / stable | renderer-text | highlight.js（BSD-3）、prettier + @prettier/plugin-xml（MIT） | ✅ | **更强**：web-tree-sitter 0.25.10（MIT）301 语言全量对齐 helix（lite 集 34 wasm 内嵌）+ hljs 11 兜底；内置 60 扩展名（`code/index.ts:54`）+ 生成物 670 项补空位；检测表 342 语言/685 扩展名；512MB 窗口流式。少数扩展名差异（`.lrc/.bundle/.bdl/.ipynb/.tex/.gv/.http/.react/.hcl/.json5` 等）以生成物为准未逐一核对 |
| 34 | `video` | 视频 | `.mp4` `.webm` `.m3u8` | high-fidelity / stable | renderer-media | 零依赖（浏览器原生） | ✅ | **更广**：`mp4/m4v/mov/webm/ogg/m3u8/flv/mp3/wav/flac/m4a/aac/oga/opus`（`av.ts:356`）；artplayer（MIT）+ hls.js（Apache-2.0）+ mpegts.js（Apache-2.0） |
| 35 | `audio` | 音频 | `.mp3` `.mpeg` `.wav` `.ogg` `.oga` `.opus` `.m4a` `.aac` `.flac` `.weba` `.midi` `.mid` | high-fidelity / stable | renderer-media + capability-midi | @tonejs/midi（MIT） | 🟡 | 覆盖 mp3/wav/flac/m4a/aac/ogg/oga/opus（含 mpeg 别名面）；`.midi/.mid` 无 |
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
| 46 | `data-asset` | 数据/字体资产 | `.ttf` `.otf` `.woff` `.woff2` `.psd` `.ai` `.eps` `.sqlite` `.wasm` `.parquet` `.avro` `.webarchive` | structured / stable | renderer-data | sql.js（MIT）、hyparquet（MIT）、ag-psd（MIT）、avsc（MIT） | ◐ | `.wasm` 落 hex 查看器可检视字节；字体扩展名走「字体加载」通道（fonts store，应用字体而非查看器）；psd/ai/eps/sqlite/parquet/avro/webarchive 不支持 |
| 47 | `binary-inspector` | 二进制检视 | `.bin` `.hex` `.elf` `.exe` `.dll` `.class` `.macho` | structured / experimental | renderer-binary | 零依赖自研（模板目录检视，opt-in） | ✅ | 覆盖其中 bin/exe/dll/elf/class 且更广：`bin/exe/dll/so/dylib/elf/o/a/class/wasm/dat/img/iso/dmg`（`hex.ts:785`），含 worker 搜索/跳转/数据检查器；`.macho` 无 |

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

- **文档类**：Word 二进制（doc/dot）、PPT 97-2003（ppt/pot）、RTF、ODT/ODP、dBASE（dbf）、WordPerfect
- **阅读类**：EPUB、FictionBook（fb2）、UMD 电子书
- **企业/区域格式**：OFD、CHM、Hangul（hwp/hwpx）、iWork 三件套（pages/numbers/key）
- **数据类**：SQLite、Parquet、Avro、WebArchive（renderer-data 一包全含，sql.js/hyparquet/avsc 均 MIT）
- **其他**：Email（eml/msg/mbox）、geo（geojson/kml/gpx/shp）、DICOM、XMind、Typst、签名/证据容器族、字体文件查看（ttf/otf/woff 系）、图片增强（tiff/heic/heif/jxl）

### 4.3 引用建议（承接 2026-11-04 可行性结论）

1. **按格式挑包，不整装引入**：`@file-viewer/core` + §4.2 清单对应 renderer，逐个注册为 vviewer dispatch 的 fallback 渲染器；与 vviewer 已有自研面重叠的（text/markdown/image/media/archive/pdf/word/xlsx/pptx/hex）不引。
2. **禁引**：`renderer-cad`、`renderer-3d`、`preset-all`、`preset-engineering`、全部 `*-full` 壳（AGPL/LGPL 连带）；`renderer-design` 系若引，需就 `@paged-media/introspect-wasm` 双许可取 MPL-2.0 面并回避 LicenseRef-PMEL；drawing 的 bpmn-js 为自有许可，独立 `.bpmn` 文件支持建议维持 Kroki 兜底。
3. **集成成本点**：file-viewer 吃 File/Buffer/URL，vviewer Range 流式源需物化 Blob 再喂或走其 `mountViewer` URL 通道；Worker/WASM/字体资产经 `file-viewer-copy-assets`/`vite-plugin` 落盘后挂入 vviewer 现有三层资产链。
4. **合规义务**：引入即更新 `THIRD_PARTY_NOTICES.md`；顺带补现有台账缺口（`@viz-js/viz` MIT、`nomnoml` MIT、`pako` MIT AND Zlib——2026-10-19 图表批引入，均干净但未入账）。

## 5. 信息来源与核验方法

| 事实 | 来源 |
| --- | --- |
| 275/225/50/47 与全部管线扩展名 | `file-viewer/docs/generated/format-catalog.md`（生成文件，58 行，头注 "Generated by scripts/generate-format-catalog.mjs. Do not edit directly."） |
| 各实现包与 engine deps | `file-viewer/packages/renderers/*/package.json` 及各包 README（word:5 确认 ODT/ODP 归属、rtf 经 capability；ebook:49 确认 epubjs 包内资产分发） |
| AGPL/LGPL/GPL 链 | npm registry 实查（`npm view <pkg> license`，2026-11-04，registry.npmjs.org）：`@flyfish-dev/cad-viewer@0.8.3`=AGPL-3.0-only、`occt-import-js@0.0.23`=LGPL-2.1；`file-viewer/packages/build-support/cad-source-snapshots/3.3.3/README.md`（dwf-viewer/LibreDWG 原文） |
| 全部第三方引擎许可证 | 同上 npm 批查（postal-mime/msgreader/sql.js/hyparquet/ag-psd/avsc/maplibre-gl/shpjs/proj4/togeojson/three/epsg-index/dxf-parser/xmldom/d3-format/noto-sans-sc/dingbat-to-unicode/introspect-wasm/fzstd/saxes/modern-screenshot/viz/nomnoml/pako/three/marked/prettier/heic2any/typst-ts 系/bpmn-js 等约 60 项） |
| vviewer 渲染器绑定 | `packages/vviewer-core/src/registry/registry.ts`（注册机制）+ 各包绑定点：`markdownRenderer.ts:737`、`html.ts:80`、`code/index.ts:54`、`jsonl/index.ts:951`、`hex.ts:785`、`image.ts:99`、`av.ts:356`、`pptx.ts:19`、`docx.ts:31`、`xlsx.ts:91`、`pdf.ts:53`、`archive.ts:120` |
| vviewer 依赖许可台账 | 本仓库 `THIRD_PARTY_NOTICES.md`；依赖清单复核自各 `packages/vviewer-*/package.json` |
| 图表 30 类注册表 | `packages/vviewer-render-diagram/src/markdown/diagrams.ts:2`（对齐 kroki v0.33.0）及 `diagrams.test.ts` |
| 语法/检测规模口径 | README（301 语言全量对齐、lite 34 wasm、检测表 342 语言/685 扩展名）+ 生成扩展名 `tools` 的 gen-code-extensions 生成物（670 项） |

### 已知未决点

- 管线 `spreadsheet-dbf`（.dbf）的实现包在 `packages/renderers/*` 目录 rg 未定位（描述与 README 均未命中 dBASE 字样），引用前需向上游确认归属。
- file-viewer `code` 管线个别扩展名（`.lrc`、`.bundle/.bdl`、`.ipynb`、`.tex`、`.gv`、`.http`、`.react`、`.hcl`、`.json5`）在 vviewer 侧是否被 670 项生成物覆盖未逐一核对，引用前以 `gen-code-extensions` 生成物比对为准。
- `renderer-pdf` 的 pdf.js 引擎以资产形态分发（包 deps 仅字体），具体引擎版本需查 `assets-standard` 包内容后确认。
