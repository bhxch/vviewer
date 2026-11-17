# Changelog

本文件记录 VViewer 扩展的变更。

## [0.1.0] - 未发布

- 扩展工程骨架：workspace 包 `@bhxch/vviewer-vscode` + esbuild 构建链
  （host CJS / webview ESM code splitting / worker IIFE×2）。
- 离线资产采集：tree-sitter grammar lite 集（34 语言）、queries、runtime wasm、
  pdfjs worker 双分支、katex 排印样式与字体、两条代码主题表、扩展图标。
- svgbob glue 条件桩：未生成 wasm 引擎产物时构建不失败（运行期降级）。
- 打包门：`.vsix` 实包字节 <100MB + esbuild 产物无未解析 import。
