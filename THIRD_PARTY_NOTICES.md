# Third-Party Notices

本仓库运行时分发的第三方依赖及其许可。本项目的第三方引入约束：仅接受 MIT / Apache-2.0 / BSD / ISC 许可（双许可取其中之一）。

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

各组件的完整许可文本随其 npm 包分发（`node_modules/<pkg>/LICENSE`），构建产物不含许可文本裁剪。
