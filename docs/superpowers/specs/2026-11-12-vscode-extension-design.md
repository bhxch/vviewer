# VSCode 插件：webview 只读渲染扩展 — 设计

日期：2026-11-12　状态：待用户审阅

## 1. 背景与动机（用户诉求，已拍板）

- 「render 是不是组件化的，能不能做成 vscode 插件，使得通过 vscode 插件打开文件时直接渲染，不需要当前的左侧目录」；
- 「右侧内容默认也该收起来。toc 位置可选左右」；
- 「其他的设置应该用 vscode 的设置能力，支持分语言配置」。

**拍板（2026-11-12）**：做，MVP 范围=核心渲染器（markdown 全效果 + code/tree-sitter 离线高亮 + 图片/音视频/PDF 等基础渲染器），Open VSX + MS Marketplace **双渠道**发布。

**侦察结论（可行性）**：组件化已完成——`@bhxch/vviewer-markdown` 单包即完整 markdown 效果（pipeline/enrich/lightbox/export + CSS 单源 markdown.css + 主题令牌注入面 + applyTheme 钩子）；`@bhxch/vviewer-highlight` 直接消费 VSCode 主题 JSON（vscode.ts themeToCssVars）与图标主题（vscodeIcon.ts）；**packages 零 SvelteKit/IndexedDB/i18n 依赖**（注入缝齐全）。真实障碍集中在 apps/web 装配层（见 §4.4）。

## 2. 现状锚点

- 包接口：vviewer-markdown exports `.` + `./markdown.css`（src/index.ts:8-102：createMarkdownView/runPipeline/collectExportHtml/exportBaseCss/MARKDOWN_CSS + 五组注入缝 setter/getter）；CSS 设计令牌全 `var(--token, 默认值)` 形态，宿主注入覆盖；katex css 管线内动态 `import('katex/dist/katex.min.css')`（pipeline.ts:642，无 bundler 宿主需自带——打包形态下 esbuild 处理）。
- highlight 独立使用：`serveWorker()`（worker.ts:109，WorkerGlobalScope 自启）+ `HighlightClient`；wasm 资产不在包内——需自备 grammar 目录（manifest 与 wasm 同目录布局契约）+ web-tree-sitter runtime wasm；grammarLayers 概念在 apps/web 层，独立使用单层即可。
- AppShell.svelte 1791 行 / ViewerPane.svelte 1319 行——一体化 UI（树/tab/搜索/设置/另存为 FS Access），**不做整体迁移**；渲染器注册表+dispatcher（packages/vviewer-core，registry.ts 98 行纯 Map，dispatcher 仅依赖 detect/errors）在 webview 环境直接可用。
- viewer.ts（apps/web/src/lib/viewer.ts）是渲染器装配单点（~30 渲染器入册 + 五注入缝），但 import `$app/env`、i18n、settings、serverCapsCache、markdownImages（store 遍历）——**需重写纯 TS 装配层**。
- foreign 渲染器（@file-viewer/* 20 组）：foreignWorkerBridge + 静态资产 URI 映射 + libarchive worker bundle——MVP 不做。
- VSCode webview：CSP、localResourceRoots、`asWebviewUri`、worker 支持（webview 内 Worker 可用）。

## 3. 目标 / 非目标 / 反目标

- 目标：VSCode 中打开支持的文件 → webview 直接渲染（自定义编辑器协议）；无目录树无 tab 条；toc 面板默认收起、位置可选左右；设置走 contributes.configuration 且支持 VSCode 原生分语言覆盖；离线可用（grammar/主题打包）。
- 非目标：目录树/多 tab/全局搜索/设置中心迁移/另存为/挂载体系；foreign 20 组渲染器；移动端形态；webview 内编辑能力（纯只读）。
- 反目标：把 AppShell 塞进 webview；在扩展内做任何服务端依赖（compute/watch/mounts 全部不适用）；运行时外网 CDN 依赖（grammar/主题本地打包， kroki 等外联图表服务默认关闭可设置开启）。

## 4. 设计

### 4.1 形态与工程位置

- `apps/vscode/`（monorepo 内），TypeScript + esbuild/rolldown 打包（extension host 侧 + webview 侧双 bundle）；`@bhxch/vviewer-markdown`、`@bhxch/vviewer-highlight`、`@bhxch/vviewer-core`、`@bhxch/vviewer-detect`、`@bhxch/vviewer-lightbox` 等以 workspace 依赖引入打包。publisher `bhxch`；`ovsx publish` + `vsce publish` 双渠道 CI job（secrets：OVSX_PAT / VSCE_PAT，用户配置；release.yml 或独立 publish-vscode.yml）。
- 注册协议：**custom editor**（`customEditors` contribution，viewType `vviewer.viewer`，优先级 default=true 对支持扩展名接管）——「打开文件时直接渲染」。支持扩展名清单从包注册表派生（markdown/code/image/av/pdf/html/text/jsonl/hex 的扩展集，构建期生成常量）。
- 用户可改用 VSCode 原生编辑器（custom editor 自带「用编辑器打开」切换）。

### 4.2 webview 壳（精简）

- 布局：内容区 + toc 面板（`vviewer.toc.side: 'left'|'right'`，默认 `right`；`vviewer.toc.defaultCollapsed: true`——**「右侧内容默认收起」即 toc 面板默认收起**）；toc 数据面 MVP 只接 markdown getToc 与 code getOutline（复用包接口）；折叠态记忆 workspaceState。
- 无 FileTree/TabBar/状态栏；单文档单 panel（同文件复用 panel，`WebviewPanelSerializer` 做布局恢复——restore 到已关闭文件的 panel 显示占位，裁量可先不做 serializer）。
- 主题联动：extension host 侧读 activeColorTheme（kind dark/light + theme id）→ 若是文本主题可取 theme JSON（vscode.extensions API 拿 theme path 读盘，裁量：MVP 先按 kind 注入 dark/light 缺省令牌，theme JSON 精确注入列为增强）；webview 侧 themeToCssVars + applyTheme 钩子（mermaid 重画）。

### 4.3 数据通道（extension host ↔ webview）

- extension host：`vscode.workspace.fs.readFile` 读文件 bytes → postMessage 到 webview（单文件全量；不做 Range/流式）；worker 依赖（git/isogit、foreign、libarchive）均不适用 MVP。
- webview 侧：TreeStore 用 singleFile 型注入 dispatcher（core 已有 singleFile 先例）；`resolveRemoteBase` 恒 null；图片 resolver 恒缺省（相对图片 MVP 不解析，外链图走 spec④ 三档档位读取 VSCode 设置映射）。
- CSP：`default-src 'none'; img-src data: blob: https:; script-src <nonce>; style-src <nonce/unsafe-inline 视打包形态>; worker-src blob:; font-src <resourceRoot>`——mermaid/graphviz 本地引擎动态 import 打包 chunk；kroki/plantuml 外联 img 由 `vviewer.diagrams.allowRemoteServices`（默认 false）控制。

### 4.4 MVP 渲染器面与装配层

- 纯 TS 装配层 `apps/vscode/src/webview/assemble.ts`（viewer.ts 的无 app 依赖重写）：注册 markdown/code/image/av/pdf/html/text/jsonl/hex(+archive 视依赖复杂度裁量裁剪) 渲染器；注入缝：setHighlightFence（本地 worker：grammar lite 集 wasm 46MB 级 + queries + tree-sitter.wasm 打包进扩展，`extensionUri` asWebviewUri 单层 base）+ setMarkdownBackend 恒本地 + i18n 文案内置中文/英文按 VSCode locale（包零 i18n 依赖，ui 选项注入）。
- **知识裁决**：lite 集 34 语言在扩展离线场景的取舍——打包 lite 集（46.4MiB，Marketplace 上限 100MB 内）；`vviewer.code.highlightEngine: 'tree-sitter'|'hljs'|'plain'`。
- markdown 图表：mermaid/katex/viz/nomnoml 打包内动态 chunk（esbuild code splitting）；kroki/官方服务器四类仅 kroki 通道类型默认回落源码块（离线优先）。

### 4.5 设置面（contributes.configuration）

- `vviewer.toc.side` / `vviewer.toc.defaultCollapsed` / `vviewer.code.highlightEngine` / `vviewer.markdown.diagramMode`（local/kroki/off） / `vviewer.diagrams.allowRemoteServices` / `vviewer.markdown.externalImages`（映射 spec④ 三档+白名单）。
- **分语言**：VSCode 原生 per-language 语法（`"[markdown]": { "vviewer.code.highlightEngine": … }`）——extension host 侧 `workspace.getConfiguration('vviewer', { languageId })` 读取即天然支持，无需自研机制；README 记载示例。

## 5. 验收锚点

- 打包门：`vsce package` 体积 <100MB（lite wasm 46MB + 代码 ~10MB 量级预核）；esbuild 产物无未解析 import。
- 手工冒烟清单（README，发布门禁）：md（图表/math/灯箱/导出 HTML）、py（tree-sitter 高亮+outline）、png/mp4/pdf、主题切换联动、toc 左右/收起、per-language 覆盖、离线（断网）全功能。
- 自动化裁量：MVP 以编译门+冒烟清单为主；e2e（@vscode/test-electron）列为增强非门禁。
- 发布门：OVSX 双渠道 job 首跑（secrets 由用户配置后实测）。

## 6. 留给 builder 的裁量

- 打包器选型与 chunk 策略；serializer/panel 复用策略；archive 渲染器取舍（libarchive wasm 打包成本 vs 价值）；theme JSON 精确注入的实现时机；扩展名清单的生成脚本形态（复用 gen-code-extensions 派生面）；双渠道 workflow 与 release.yml 的编排关系；i18n 文案集。
