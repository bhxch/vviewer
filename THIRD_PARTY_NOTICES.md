# Third-Party Notices

本仓库运行时分发的第三方依赖及其许可。本项目的第三方引入约束：仅接受 MIT / Apache-2.0 / BSD / ISC / MPL-2.0 许可（双许可取其中之一）。MPL-2.0 组件以文件级 Copyleft 为边界：仅在分发的源文件上保留声明并标注修改（见 `packages/highlight/assets/LICENSE-README.md`），不传染仓库其余代码。

| 组件 | 许可 | 用途 | 引入里程碑 |
| --- | --- | --- | --- |
| dompurify | MPL-2.0 OR Apache-2.0（取 Apache-2.0） | HTML/markdown 消毒 | M3 |
| highlight.js | BSD-3-Clause | 代码高亮兜底 | M2 |
| katex | MIT | LaTeX 数学公式渲染 | M3 |
| markdown-it | MIT | markdown 解析 | M3 |
| markdown-it-task-lists | ISC | markdown 任务列表 | M3 |
| mermaid | MIT | mermaid 图表渲染 | M3 |
| yaml | ISC | front-matter 解析 | M3 |
| web-tree-sitter | MIT | 代码高亮引擎 | M2 |
| pdfjs-dist | Apache-2.0 | PDF 渲染（render-doc 包） | M4 |
| jszip | MIT OR GPL-3.0（取 MIT） | zip 解析（render-archive 包） | M4 |
| libarchive.js | MIT | tar/tgz/tbz2/xz/7z/rar 解析（render-archive 包，wasm+worker 静态资产） | M4 |
| artplayer | MIT | 视频播放器（render-media 包，动态 import 不进主包） | M4 |
| hls.js | Apache-2.0 | HLS 流播放（render-media 包，仅 .m3u8 时动态 import） | M4 |
| mpegts.js | Apache-2.0 | FLV/TS 流播放（render-media 包，仅 .flv/.ts 时动态 import） | M4 |
| mammoth | BSD-2-Clause | docx 转 HTML（render-doc 包，动态 import 不进主包） | M4 |
| xlsx（SheetJS community） | Apache-2.0 | Excel 解析/表格渲染（render-doc 包，动态 import 不进主包） | M4 |
| helix-editor/helix | MPL-2.0 | `packages/highlight/assets/themes.json`（214 主题派生自 `runtime/themes`，格式转换修改）与 `languages.json`（派生自 `languages.toml`）、`packages/highlight/assets/queries/`（vendored 拷贝）；溯源见 `tools/helix-assets/README.md` | M2 |

各组件的完整许可文本随其 npm 包分发（`node_modules/<pkg>/LICENSE`），构建产物不含许可文本裁剪。
