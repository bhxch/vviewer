# hex 查看器选型 spike：集成开源库 vs 自研增强

- 日期：2026-10-11
- 性质：spike 结论（选型调研，无代码产出）
- 关联：`docs/superpowers/specs/2026-10-11-workspace-tabs-design.md` 同批 brainstorm 需求第 7 项

## 1. 背景与问题

用户需求原文：hex 方式有没有好看的查看器，集成一个许可证允许、功能丰富的开源 hex 查看器。vviewer 现状：自研只读 hex 查看器（`packages/render-binary`），三列 dump + 结构树（ELF/ZIP）+ 虚拟滚动 + worker 化，性能达标（1MB 首屏桌面中位 38ms，BUG-16 口径）；**缺口是搜索、跳转 offset、数据检查器**。

## 2. 候选调研（2026-10-11 实测核实）

| 候选 | 许可 | 形态 | 关键能力 | 结论 |
| --- | --- | --- | --- | --- |
| [microsoft/vscode-hexeditor](https://github.com/microsoft/vscode-hexeditor) | **MIT** | VSCode 扩展（webview，TS + esbuild，活跃维护） | 数据检查器（int/float/bool 解码，grid/hover/sidebar 三模式）、查找替换、undo/redo、decoded text | **最佳借鉴源**；但 webview 核心与 VSCode API/宿主耦合，整块拆出嵌入 Svelte 应用适配成本高于自研 |
| [@imccc/hex-viewer-js](https://github.com/ImChrisChen/hex-viewer) | **MIT** | 可嵌入组件（WebGPU 单纹理 + OffscreenCanvas worker，零依赖，JS/Vue3/React 绑定） | 虚拟滚动、选择/复制/键盘导航、亮暗主题；无搜索 | **WebGPU 硬依赖**（兼容面收窄）+ 极早期项目（7 star / 20 commits，维护风险）+ 只解决渲染（我们已解决且达标） |
| [Lekensteyn/hex-viewer](https://github.com/Lekensteyn/hex-viewer) | **MIT** | 独立 web 应用（纯 JS） | hex+ASCII、**位级注释**（bit annotation） | 基本停滞（2014 年代，26 commits）；位级注释是可借鉴的功能点子，不可集成 |
| [HexEd.it](https://hexed.it) | 未见开源（站点无仓库链接） | 闭源免费 web 应用 | 功能丰富 | 排除（无源码） |
| [ImHex](https://github.com/WerWolv/ImHex) | **GPL-2.0-only**（libimhex/plugins 为 LGPL 例外） | 桌面应用 + 官方 wasm web 版 | 功能最强（pattern language 等） | 排除：GPL 传染与本项目分发不兼容；独立应用架构非库；web 版只能当独立工具 |
| [HexFiend](https://github.com/HexFiend/HexFiend) | BSD | macOS 原生（Swift） | — | 非 web，排除 |

## 3. 结论与推荐

**推荐：不集成外部库，自研增强现有 hex 查看器。**

理由：

1. 外部库主要解决「渲染」，而渲染（虚拟滚动/worker/大文件）是我们已经解决且实测达标的自研部分；真正缺口（搜索/跳转/检查器）是纯逻辑功能，自研无依赖、体积小、可控。
2. 可嵌入候选各有硬伤：WebGPU 硬依赖 + 维护风险（hex-viewer-js）、宿主耦合（vscode-hexeditor）、停滞（Lekensteyn）；功能最强的 ImHex 是 GPL 且非库形态。
3. MIT 的 vscode-hexeditor 允许合法借鉴其设计与代码片段（数据检查器的类型集、查找高亮交互），降低自研的设计成本。

## 4. 后续（若采纳，立实现 spec）

在 `packages/render-binary` 基础上按优先级增量实施（全部 worker 内增量扫描/解析，不破坏既有虚拟滚动）：

1. **跳转 offset**：地址栏输入（hex/dec），定位滚动。
2. **搜索**：hex 字节串 + UTF-8/ASCII 字符串两种模式，worker 增量扫描 + 命中高亮 + 上/下命中导航 + 命中列表；大文件按块扫描保持响应性。
3. **数据检查器**：光标/选区处解码面板（int8..64 / uint / float16/32/64 / bool / UTF-8 片段），对齐 vscode-hexeditor 类型集。
4. 远期可借鉴：位级注释（Lekensteyn 模式）。
