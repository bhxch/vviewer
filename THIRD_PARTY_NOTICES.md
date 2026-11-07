# Third-Party Notices

本仓库运行时分发的第三方依赖及其许可。本项目的第三方引入约束：仅接受 MIT / Apache-2.0 / BSD / ISC / MPL-2.0 许可（双许可取其中之一）。MPL-2.0 组件以文件级 Copyleft 为边界：仅在分发的源文件上保留声明并标注修改（见 `packages/vviewer-highlight/assets/LICENSE-README.md`），不传染仓库其余代码。

| 组件 | 许可 | 用途 | 引入里程碑 |
| --- | --- | --- | --- |
| dompurify | MPL-2.0 OR Apache-2.0（取 Apache-2.0） | HTML/markdown 消毒 | M3 |
| highlight.js | BSD-3-Clause | 代码高亮兜底 | M2 |
| katex | MIT | LaTeX 数学公式渲染 | M3 |
| markdown-it | MIT | markdown 解析 | M3 |
| markdown-it-deflist | MIT | markdown 描述列表（`term`/`: def`→dl/dt/dd，comrak 扩展语法对齐本地半边） | md-katex T2 |
| markdown-it-footnote | MIT | markdown 脚注（与 comrak 服务端 GFM 能力对齐；本地引擎，M3 挂账终审补齐） | C 批 |
| markdown-it-ins | MIT | markdown 插入（`++x++`→ins，comrak 扩展语法对齐本地半边） | md-katex T2 |
| markdown-it-mark | MIT | markdown 高亮（`==x==`→mark，comrak 扩展语法对齐本地半边） | md-katex T2 |
| markdown-it-task-lists | ISC | markdown 任务列表 | M3 |
| mermaid | MIT | mermaid 图表渲染 | M3 |
| yaml | ISC | front-matter 解析 | M3 |
| web-tree-sitter | MIT | 代码高亮引擎 | M2 |
| pdfjs-dist | Apache-2.0 | PDF 渲染（render-doc 包） | M4 |
| jszip | MIT OR GPL-3.0（取 MIT） | zip 解析（render-archive 包） | M4 |
| libarchive.js | MIT | tar/tgz/tbz2/xz/7z/rar 解析（render-archive 包，wasm+worker 静态资产） | M4 |
| artplayer | MIT | 视频播放器（render-media 包，动态 import 不进主包） | M4 |
| buffer | MIT | Node Buffer 浏览器填充（apps/web 直依赖，isomorphic-git 浏览器面依赖闭包；023982b 起 base64-js/buffer 独立 chunk 组） | git 信息面板 35a94ef（台账补记：残余 A5） |
| isomorphic-git | MIT | 纯 JS git 实现（gitWorker 引擎 chunk，动态 import 不进 precache） | git 信息面板 35a94ef（台账补记：残余 A5） |
| chardet | MIT | 文件编码重探测（core 精判分层，动态 import 不进主包） | 议题三 T8 |
| hls.js | Apache-2.0 | HLS 流播放（render-media 包，仅 .m3u8 时动态 import） | M4 |
| mpegts.js | Apache-2.0 | FLV/TS 流播放（render-media 包，仅 .flv/.ts 时动态 import） | M4 |
| mammoth | BSD-2-Clause | docx 转 HTML（render-doc 包，动态 import 不进主包） | M4 |
| xlsx（SheetJS community） | Apache-2.0 | Excel 解析/表格渲染（render-doc 包，动态 import 不进主包） | M4 |
| @viz-js/viz | MIT | graphviz 本地渲染（render-diagram 包） | md-diagrams 批 |
| nomnoml | MIT | nomnoml 本地渲染（render-diagram 包） | md-diagrams 批 |
| pako | MIT AND Zlib | kroki URL deflate 编码（render-diagram 包） | md-diagrams 批 |
| @file-viewer/core | Apache-2.0 | file-viewer 渲染核心（桥接渲染器公共底座：mount 契约、资产 base 解析、sanitize 边界） | file-viewer 批 T1 |
| @file-viewer/capability-rtf | Apache-2.0 | rtf 渲染启用包（向 renderer-word 注册 rtf.js；其依赖 rtf.js 为 MIT） | file-viewer 批 T1 |
| @file-viewer/renderer-chm | Apache-2.0 | chm 编译 HTML 帮助文档渲染 | file-viewer 批 T1 |
| @file-viewer/renderer-email | Apache-2.0 | eml/msg/mbox 邮件渲染（依赖 postal-mime 为 MIT-0、@kenjiuno/msgreader 为 Apache-2.0；msgreader 传递依赖 iconv-lite 为 MIT、@kenjiuno/decompressrtf 为 BSD-2-Clause，随 renderer-email 同 chunk 分发） | file-viewer 批 T1 |
| @file-viewer/renderer-epub | Apache-2.0 | epub/fb2/umd 电子书渲染 | file-viewer 批 T1 |
| @file-viewer/renderer-hangul | Apache-2.0 | hwp/hwpx 韩文文档渲染 | file-viewer 批 T1 |
| @file-viewer/renderer-iwork | Apache-2.0 | pages/numbers/key（Apple iWork）渲染 | file-viewer 批 T1 |
| @file-viewer/renderer-ofd | Apache-2.0 | ofd 版式文档渲染 | file-viewer 批 T1 |
| @file-viewer/renderer-presentation | Apache-2.0 | ppt/pptm/potx/potm/ppsx/ppsm 演示文稿渲染 | file-viewer 批 T1 |
| @file-viewer/renderer-spreadsheet | Apache-2.0 | xlsx 系变体（xltx/xlsb/xlt/xla/xlam/xltm）/ods/fods/dbf/tsv 表格渲染 | file-viewer 批 T1 |
| @file-viewer/renderer-word | Apache-2.0 | doc/docm/dotx/dotm/odt/odp 文字文档渲染（odt/odp 归属本包，按其 README；其依赖 @file-viewer/doc 为 MIT） | file-viewer 批 T1 |
| @file-viewer/renderer-wordperfect | Apache-2.0 | wpd/wp/wp5/wp6（Corel WordPerfect）渲染 | file-viewer 批 T1 |
| @file-viewer/capability-drawio-official | Apache-2.0 | diagrams.net 官方查看运行时 opt-in 启用包（大体积运行时经 assets-drawing 资产系分发） | file-viewer 批 W2-T1 |
| @file-viewer/capability-midi | Apache-2.0 | MIDI 检视 opt-in 启用包（其依赖 @tonejs/midi 为 MIT） | file-viewer 批 W2-T1 |
| @file-viewer/renderer-data | Apache-2.0 | 数据/字体资产渲染（SQLite/Parquet/Avro/WebArchive/PSD/AI/EPS 预览与 WASM 模块结构、字体文件查看面；依赖 sql.js/hyparquet/avsc/ag-psd 均 MIT） | file-viewer 批 W2-T1 |
| @file-viewer/renderer-design | Apache-2.0 | Adobe 设计文档渲染（Photoshop/Illustrator/InDesign/XD/Animate FLA 等 24 扩展名；传递依赖 @paged-media/introspect-wasm 双许可 MPL-2.0 OR LicenseRef-PMEL，取 MPL-2.0 面） | file-viewer 批 W2-T1 |
| @file-viewer/renderer-dicom | Apache-2.0 | DICOM Part 10 医学影像渲染（依赖 dicom-parser 为 MIT） | file-viewer 批 W2-T1 |
| @file-viewer/renderer-drawing | Apache-2.0 | 白板/图表文件渲染（Draw.io/Excalidraw/Mermaid/PlantUML；BPMN 查看为 opt-in peer bpmn-js，本仓不启用，.bpmn 维持 diagram-bpmn 渲染器） | file-viewer 批 W2-T1 |
| @file-viewer/renderer-eda | Apache-2.0 | EDA 电路文件渲染（OLB/DRA/GDSII/OASIS；依赖 cfb 为 Apache-2.0，eda-layout/eda-orcad 自研） | file-viewer 批 W2-T1 |
| @file-viewer/renderer-geo | Apache-2.0 | 地理数据渲染（GeoJSON/KML/GPX/SHP 解析与 MapLibre 叠加；依赖 maplibre-gl 为 BSD-3，shpjs/proj4 为 MIT，@tmcw/togeojson 为 BSD-2） | file-viewer 批 W2-T1 |
| @file-viewer/renderer-image | Apache-2.0 | 图片渲染（原生格式预览+多页 TIFF 与 HEIC/HEIF 转换；依赖 utif/heic2any 均 MIT） | file-viewer 批 W2-T1 |
| @file-viewer/renderer-media | Apache-2.0 | 原生音视频渲染宿主（媒体扩展名本仓不注册——vviewer av 链占优；MIDI 检视经 capability-midi） | file-viewer 批 W2-T1 |
| @file-viewer/renderer-signature | Apache-2.0 | 数字签名/证据容器结构检视（CMS/CAdES/时间戳/ASiC/JWS/OpenPGP；依赖 jszip 为 MIT） | file-viewer 批 W2-T1 |
| @file-viewer/renderer-typst | Apache-2.0 | Typst 排版渲染（浏览器 WASM 编译+渲染；依赖 @myriaddreamin/typst-ts-* 均 Apache-2.0） | file-viewer 批 W2-T1 |
| helix-editor/helix | MPL-2.0 | `packages/vviewer-highlight/assets/themes.json`（214 主题派生自 `runtime/themes`，格式转换修改）与 `languages.json`（派生自 `languages.toml`）、`packages/vviewer-highlight/assets/queries/`（vendored 拷贝）；溯源见 `tools/helix-assets/README.md` | M2 |
| microsoft/vscode | MIT | `packages/vviewer-highlight/assets/vscode/dark_modern.json`、`light_modern.json`（theme-defaults 扩展主题，JSONC 规范化与 include 内联后 vendor，色值未改动） | B |
| microsoft/vscode（extensions/theme-seti） | MIT | `packages/vviewer-highlight/assets/vscode-icons/seti/`（Seti 图标主题，清单 JSONC 规范化与格式改写后 vendor、`seti.woff` 原样拷贝；字形上游 jesseweed/seti-ui 同 MIT），溯源与修改明细见 `packages/vviewer-highlight/assets/vscode-icons/README.md` | 图标主题 T4 |

各组件的完整许可文本随其 npm 包分发（`node_modules/<pkg>/LICENSE`），构建产物不含许可文本裁剪。
