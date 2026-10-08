# vviewer

网页版**只读**文件查看器：在浏览器里查看一个目录下的代码、Markdown、HTML、图片、音视频、PDF、压缩包、Office 文档与二进制文件（hex/结构树），不做任何编辑功能。面向自用与内网小团队场景，按开源工程标准建设（测试、E2E、license 合规）。

## 两种形态

| 形态 | 组成 | 适合 |
| --- | --- | --- |
| **纯前端** | SvelteKit 静态站点（`apps/web/build`），任意静态托管即可 | 查看本地文件（File System Access API / 拖拽），无需后端 |
| **后端单二进制** | `vviewer serve`（Rust + axum）+ 前端静态目录（`--web-dist`） | 浏览服务器上的目录；局域网共享（token 鉴权 / `--allow-lan`） |

后端两档能力，由 `/api/health` 的 `capabilities` 宣告，前端自动适配：

- **档 1 file-server**：目录树、Range 文件流、服务端语言/编码检测、SSE 变更推送（文件修改自动刷新）、Bearer token 路径安全。
- **档 2 `--compute`**：在档 1 上追加服务端计算——tree-sitter / comrak 远程高亮与渲染、ripgrep 全局搜索（`TopBar` 计算策略可切换 本地/远程/自动）。

## 功能矩阵

| 格式 | 能力 |
| --- | --- |
| 代码/文本 | tree-sitter 预编译 36 语言（wasm 按需加载，22 个查询可用；14 个查询/ABI 失配自动降级）+ highlight.js 全量兜底（语言检测表对齐 helix 264 语言清单）；>2MB 自动切 hljs 分块、≤20MB；utf-8/utf-16/gb18030 编码；虚拟滚动；状态栏实时显示引擎与执行位置 |
| Markdown | 本地管线：GFM 表格/任务列表、callout、KaTeX 公式、mermaid 图表、围栏代码高亮、TOC 侧栏、图片灯箱；后端版可切远程 comrak 渲染（双引擎样式归一） |
| HTML | 沙箱 iframe 预览（sandbox 无 `allow-scripts`）+ DOMPurify 净化，源码/渲染双视图 |
| 图片 | 常见位图/矢量格式 + markdown 图片灯箱 |
| 音视频 | ArtPlayer 集成：mp4/webm 直接播，`.m3u8` 按需加载 hls.js、`.flv/.ts` 按需加载 mpegts.js |
| PDF | pdfjs canvas 渲染 + 文件内文本搜索定位 |
| 二进制 | hex 三列 dump（偏移/hex/ASCII）+ 结构树（PNG/IHDR 等字段展开） |
| 压缩包 | zip（jszip）/ tar·tgz·tbz2·7z·rar（libarchive wasm）：包内树 + 条目递归预览（嵌套深度限 3 层，超限拒绝） |
| Office | docx（mammoth 转 HTML）、xlsx（SheetJS，多 sheet 页签、>200 行截断）、pptx（文本提纲卡片） |
| 搜索 | 文件内（`/`）+ 全局（`Ctrl+Shift+F`）双实现：浏览器内 grep / 远程 ripgrep（server 缺 rg 时 501 → 前端自动降级本地 grep） |
| 会话 | IndexedDB tab 快照恢复 + 目录句柄权限记忆（本地文件内容不保留，刷新后以占位提示重开） |
| PWA | manifest + Service Worker：静态资产预缓存，grammar wasm/查询文件运行时缓存，离线可用（已缓存范围） |
| 外观 | helix 代码主题体系 + 亮/暗双模式记忆，hljs 兜底着色近似跟随代码主题 |
| 移动 | 601-900px 文件树收进抽屉（右栏保留），≤600px 右栏（目录/属性）再收进独立抽屉，触摸滚动可用 |

## 快速开始

### 后端单二进制（推荐）

```bash
pnpm install
pnpm build:all        # 前端 → apps/web/build + cargo build --release → server/target/release/vviewer

./server/target/release/vviewer serve --root /path/to/data --web-dist apps/web/build
# 打开 http://127.0.0.1:8321（本机免鉴权；局域网加 --allow-lan --token-gen）
```

需要服务端计算（远程高亮/comrak/ripgrep 搜索）时追加 `--compute`（要求 PATH 内有 `rg`）。

### 纯前端（静态托管）

```bash
pnpm install
pnpm --filter web build
# 将 apps/web/build/ 整目录部署到任意静态托管（Nginx/对象存储/GitHub Pages 等）
```

打开页面后拖入或选择本地文件夹即可浏览；`file://` 直开不可用（worker/模块限制），需经 HTTP 访问。

## 架构概览

pnpm workspace monorepo：

```
packages/
  core/             TreeStore/TabStore 抽象、格式派发器、编码检测（框架无关）
  highlight/        web-tree-sitter Worker 管线、helix 查询继承/injection、主题
  render-text/      代码（虚拟滚动/降级链）、markdown 管线、HTML 沙箱、文件内搜索
  render-doc/       pdfjs、docx/xlsx/pptx
  render-binary/    hex dump、结构树
  render-media/     ArtPlayer/hls.js/mpegts.js、图片
  render-archive/   jszip/libarchive 包内树与递归预览
apps/web/           SvelteKit 5 + adapter-static 壳（TopBar/FileTree/TabBar/ViewerPane）、PWA
server/             Rust axum：tree/file/events SSE/ticket/search/compute 端点，只读
```

设计与实施文档（含各里程碑验收标准与实测数据）：

- 设计 spec：`docs/superpowers/specs/2026-10-06-vviewer-design.md`
- 实施计划：`docs/superpowers/plans/2026-10-07-m1-skeleton.md` … `2026-10-07-m7-pwa-polish.md`（M1 骨架 / M2 高亮 / M3 markdown+HTML / M4 二进制媒体 / M5 server / M6 compute+搜索 / M7 PWA+打磨）
- 部署细节：`docs/deploy.md`；server 参数与安全：`server/README.md`

## 开发

```bash
pnpm test                     # vitest 全仓单元测试
cargo test --manifest-path server/Cargo.toml   # Rust 单元/集成测试
cd apps/web && npx playwright test             # E2E（chromium + mobile 双 project）
pnpm typecheck                # TS 类型检查
```

E2E 覆盖：桌面 chromium 全量 m1-m7 场景 + 移动视口（375×667 触摸）冒烟；`apps/web/e2e/` 内各 spec 对应里程碑。

## License

本项目以 Apache-2.0 许可发布。运行时分发的第三方组件及其许可清单见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)（仅接受 MIT / Apache-2.0 / BSD / ISC 引入；完整许可文本随各 npm 包分发）。
