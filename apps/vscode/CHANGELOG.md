# Changelog

本文件记录 VViewer 扩展的变更。

## [0.1.0] - 未发布

### 扩展面（spec H）

- 扩展工程骨架：workspace 包 `@bhxch/vviewer-vscode` + esbuild 构建链
  （host CJS / webview ESM code splitting / worker IIFE×2）。
- Custom editor 注册：`contributes.customEditors`（viewType `vviewer.viewer`）——
  源清单为开发态通配 selector（F5 开发宿主据此接管任意文件），构建产物清单由生成脚本
  用实跑注册表的认领清单覆写（约 700 扩展名，与渲染器安装序同源）。
- webview 装配层：viewer.ts 无 app 依赖重写（9 类渲染器 + 十一处 setter 逐一接线：
  九渲染/文案缝 + pdf/hex worker URL provider + singleFile store）+ 动态令牌注入面 +
  katex CSS 自备注入面 + 壳（内容区/toc/顶部提示条，无状态栏）。
- 离线资产采集：tree-sitter grammar lite 集（34 语言）、queries、runtime wasm、
  pdfjs worker 双分支、katex 排印样式与字体、两条代码主题表、扩展图标、**svgbob wasm
  引擎产物**（wasm 入包——glue 的相对定位面同目录）。
- tree-sitter 离线高亮链路：blob worker（IIFE 自包含）+ 本地 grammar/queries/runtime
  资产（asWebviewUri 三段自洽）+ 引擎档位裁决与可见降级（顶部提示条与 toc 徽标指示，
  无状态栏）。
- 目录（toc）面板：停靠侧（`vviewer.toc.side`）+ 折叠态（`vviewer.toc.defaultCollapsed`
  决定初始折叠态，宿主持久化 workspaceState 记忆用户手动切换）+ 相对链接/图片解析 +
  导出 HTML 写盘（resolveImage）+ 图表外联闸（逐语言 modeOf 映射：闸关仅离线引擎族
  给 local、CDN 引擎族与 17 kroki-only 全 source、off→source、禁 hpcc 渲染器）。
- 设置面：`contributes.configuration` 七项（per-language 可覆盖项
  scope=language-overridable）+ 配置/主题变更实时生效（不要求重开文件；主题变更经
  重装装配层使图表主题随之更新）。
- 消息协议：host ↔ webview 双向通道 + **就绪握手**（webview 上报 ready，宿主据此投递
  init——投递不保证不丢，webview 侧未收到 init 前定时重发）+ 存在性探测通道
  （stat-file，只探测不读字节）。
- 打包门：`.vsix` 实包字节 <100MB + esbuild 产物无未解析 import；发布链
  （publish-vscode.yml）走 OVX/vsce 双渠道上传。
- svgbob glue 条件桩：未生成 wasm 引擎产物时构建不失败（运行期降级；生成产物入包时
  走完整 svgbob 能力）。
