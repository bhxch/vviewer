# VViewer（VSCode 扩展）

在 VSCode 内以 webview **只读**渲染文件：markdown 全效果（管线 / 图表 / katex / 灯箱 / 导出 HTML）、
代码（tree-sitter 离线高亮 + 大纲）、图片 / 音视频 / PDF / HTML / JSONL / hex 基础渲染器。

扩展不依赖外网 CDN：tree-sitter grammar / queries / runtime、pdfjs worker、katex 字体全部随扩展打包，
运行期经 `webview.asWebviewUri` 映射到本地资源。

## 构建

前置（本仓 grammar 构建链产物不入库，新克隆需先生成）：

```bash
pnpm gen:sources                                        # 生成语言清单与 generated-extensions.ts
node tools/grammar-builder/build.mjs --fetch --lite     # 拉取 lite 集 grammar wasm
node tools/grammar-builder/build.mjs --self-build        # 生成 manifest.json 与 runtime wasm
```

随后：

```bash
pnpm install
pnpm --filter @bhxch/vviewer-vscode build
```

构建产物在 `apps/vscode/dist/`（同时是 `.vsix` 的打包根）：

```
dist/
├── package.json            # VSIX manifest（name 无 scope、main 重写为 ./extension.js）
├── extension.js            # extension host 侧 bundle（CJS，vscode 为 external）
├── .vscodeignore           # 构建脚本写出（vsce 从包根读取）
├── media/icon.png          # 扩展图标（manifest 的 icon 字段指向它）
└── webview/
    ├── main.js             # webview 入口（ESM，动态 chunk 同目录）
    ├── highlight-worker.js # tree-sitter 高亮 worker（IIFE 自包含）
    ├── binary-worker.js    # hex 解析 worker（IIFE 自包含）
    ├── pdf/                # pdfjs worker 双分支（modern / legacy）
    ├── katex.min.css       # katex 排印样式（字体同目录 fonts/）
    └── assets/             # grammar / queries / runtime / 主题表
```

## 本地调试

1. `pnpm --filter @bhxch/vviewer-vscode build`
2. 在 VSCode 中打开本仓的 `apps/vscode` 目录（作为扩展开发宿主），按 `F5` 启动 Extension Development Host。
3. 在开发宿主中打开受支持的文件（如 `README.md`、任意 `.py`、`.png`、`.pdf`），应直接进入 VViewer 渲染视图。

设置项、per-language 覆盖示例与冒烟清单将在后续版本补入本文件。
