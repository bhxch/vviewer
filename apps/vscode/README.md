# VViewer（VSCode 扩展）

在 VSCode 内以 webview **只读**渲染文件：markdown 全效果（管线 / 图表 / katex / 灯箱 / 导出 HTML）、
代码（tree-sitter 离线高亮 + 大纲）、图片 / 音视频 / PDF / HTML / JSONL / hex 基础渲染器。

扩展不依赖外网 CDN：tree-sitter grammar / queries / runtime、pdfjs worker、katex 字体全部随扩展打包，
运行期经 `webview.asWebviewUri` 映射到本地资源。图表的外联服务（kroki / PlantUML）**默认关闭**。

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
    ├── katex.export.css    # 自包含导出样式（字体已转 data URI 内联）
    └── assets/             # grammar / queries / runtime / 主题表
```

## 本地调试

1. `pnpm --filter @bhxch/vviewer-vscode build`
2. 在 VSCode 中打开本仓的 `apps/vscode` 目录（作为扩展开发宿主），按 `F5` 启动 Extension Development Host。
3. 在开发宿主中打开受支持的文件（如 `README.md`、任意 `.py`、`.png`、`.pdf`），应直接进入 VViewer 渲染视图。

> **认领面（selector）两态**：源清单 `apps/vscode/package.json` 的
> `contributes.customEditors[].selector` 是**开发态通配**（`*`）——F5 开发宿主据此接管
> 任何文件（否则开发宿主不接管任何文件，本节步骤与下方人工冒烟清单均无法执行）；构建
> 产物清单（`dist/package.json`，进 VSIX 的那份）由 `scripts/gen-manifest.mjs` 用**实跑
> 真实注册表**的认领清单覆写（约 700 个扩展名，与渲染器安装序同源）。

## 命令

| 命令 | 作用 |
|---|---|
| `VViewer: Open with Native Editor` | 用 VSCode 原生编辑器打开当前文档（custom editor 自带的「用编辑器打开」亦可） |
| `VViewer: Reload` | 重新渲染当前文档 |
| `VViewer: Export as HTML` | 导出当前文档为自包含 HTML（宿主写盘） |

## 设置

全部设置在 `vviewer` 命名空间下（VSCode 设置界面搜 `VViewer`）：

| 键 | 类型 | 取值 | 缺省 | 作用域 | 说明 |
|---|---|---|---|---|---|
| `vviewer.toc.side` | string | `left` / `right` | `right` | window | 目录面板停靠侧 |
| `vviewer.toc.defaultCollapsed` | boolean | — | `true` | window | 目录面板默认收起（你最近一次手动切换优先；修改本设置会清除该手动状态） |
| `vviewer.code.highlightEngine` | string | `tree-sitter` / `hljs` / `plain` | `tree-sitter` | **language-overridable** | 代码高亮引擎 |
| `vviewer.markdown.diagramMode` | string | `local` / `kroki` / `off` | `local` | **language-overridable** | 图表渲染模式（`off` = 落源码块） |
| `vviewer.diagrams.allowRemoteServices` | boolean | — | `false` | window | 是否允许外联图表服务（kroki / PlantUML） |
| `vviewer.markdown.externalImages` | string | `blocked` / `manual` / `auto` | `blocked` | window | 外链图片策略 |
| `vviewer.markdown.externalImageAllowlist` | array\<string\> | — | `[]` | window | 外链图片域名白名单（`manual` 档生效） |

设置变更**实时生效**（不要求重开文件）：宿主订阅配置与主题变更，重算后推给已开 webview，
webview 侧重装渲染缝并全量重渲。

### 按语言覆盖（per-language）

`vviewer.code.highlightEngine` 与 `vviewer.markdown.diagramMode` 的作用域是
**`language-overridable`** —— 这是 VSCode 原生 per-language 覆盖生效的**前提**：
作用域不是 `language-overridable`（或 `resource`）时，VSCode 会**静默忽略**
`"[markdown]": { … }` 这类语言级配置（配了不生效且无提示）。

示例（只示范语言相关项——`vviewer.toc.side` 等 window 作用域项**不可**按语言覆盖）：

```jsonc
// settings.json（用户级或工作区级）
{
  "[python]": {
    "vviewer.code.highlightEngine": "plain"
  },
  "[markdown]": {
    "vviewer.code.highlightEngine": "tree-sitter",
    "vviewer.markdown.diagramMode": "off"
  }
}
```

生效验证：打开一个 `.py` 文件 → 目录面板头部徽标显示的引擎应为 `plain`；打开 `.md` 文件 →
图表围栏应直接显示源码块（`diagramMode: off`），且提示条提示「语言 markdown 的专属设置已生效」。

## 冒烟清单

逐条在 Extension Development Host 中人工验收（扩展面无自动化 e2e 门禁——spec §5 裁量）。

| # | 步骤 | 期望结果 |
|---|---|---|
| 1 | 打开 `README.md` | markdown 正常渲染：标题层级正确、**表格/列表/引用有排版**（样式面验收）、代码块有语法着色 |
| 2 | 在 md 里放一个 ```mermaid 围栏 | 图表以 SVG 渲染（非源码块）；切换 VSCode 主题后图表**随之重画** |
| 3 | 在 md 里放一个 `$$x^2$$` 数学围栏 | 公式以 katex 排印呈现（**非无排印的原始 HTML**——样式面验收） |
| 4 | 点击 md 里的图片 | 进入灯箱（overlay 可关闭；Esc 关闭） |
| 5 | 执行 `VViewer: Export as HTML` | 弹出保存对话框；落盘的 HTML **单文件自包含**（样式与 katex 字体已内联、图片转 data URI），用浏览器打开排版与预览一致 |
| 6 | 打开任意 `.py` 文件 | 代码有 **tree-sitter 高亮**（非纯文本）；右侧目录面板列出符号大纲，点击条目滚动到对应行 |
| 7 | 打开 `.png` / `.mp4` / `.pdf` | 图片可显示；音频/视频可播放（**不被 CSP 拦**——`media-src` 已显式放行）；PDF 分页可滚动 |
| 8 | 切换 VSCode 主题（深/浅） | 页面配色随主题变化（`--ui-*` 令牌整体替换），**无需重开文件**；mermaid 图重画 |
| 9 | 设置 `vviewer.toc.side` 为 `left` | 目录面板移到左侧；`vviewer.toc.defaultCollapsed` 决定初始折叠态；折叠钮的展开态同步 |
| 10 | 按上文示例配置 `"[python]": { "vviewer.code.highlightEngine": "plain" }` | 打开 `.py` 文件后引擎为 plain、`.md` 文件不受影响（**per-language 覆盖生效**）；提示条给出语言专属设置的提示 |
| 11 | **断开网络**后重复第 1~7 步 | 全部功能正常：markdown 渲染、图表（mermaid/katex 等本地引擎）、代码高亮（本地 grammar）、图片/音视频/PDF 均可用——**扩展零外网依赖** |
