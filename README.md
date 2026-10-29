# vviewer

网页版**只读**文件查看器：在浏览器里查看一个目录下的代码、Markdown、HTML、图片、音视频、PDF、压缩包、Office 文档与二进制文件（hex/结构树），不做任何编辑功能。面向自用与内网小团队场景，按开源工程标准建设（测试、E2E、license 合规）。

## 两种形态

| 形态 | 组成 | 适合 |
| --- | --- | --- |
| **纯前端** | SvelteKit 静态站点（`apps/web/build`），任意静态托管即可 | 查看本地文件（File System Access API / 拖拽），无需后端 |
| **后端单二进制** | `vviewer serve`（Rust + axum）+ 前端静态目录（`--web-dist`） | 浏览服务器上的目录；局域网共享（token 鉴权 / `--allow-lan`） |
| **桌面应用** | Tauri 2 薄壳（`apps/desktop`）：窗口 + 内嵌 server sidecar | 三平台装即用：无需 Node/静态托管，退出自动回收服务进程 |
| **Cloudflare Workers** | `server/worker`（workers-rs wasm 适配，业务核复用）+ Workers Assets 静态前端 | 无服务器部署：S3/WebDAV 挂载为文件来源（`VV_MOUNTS`）；无 watch/搜索/compute，前端自动降级；图表 kroki 代发端点可配（`VV_KROKI_HOST`） |

后端两档能力，由 `/api/health` 的 `capabilities` 宣告，前端自动适配：

- **档 1 file-server**：目录树、Range 文件流、服务端语言/编码检测、SSE 变更推送（文件修改自动刷新）、Bearer token 路径安全。
- **档 2 `--compute`**：在档 1 上追加服务端计算——tree-sitter / comrak 远程高亮与渲染（`TopBar` 计算策略可切换 本地/远程/自动）+ Markdown 图表单图服务端渲染（graphviz/svgbob 原生引擎，health `diagrams` 宣告，图表按语言模式可切「服务端」档）。
- **kroki 代发 `--kroki-host`**（独立于 `--compute`）：配置 kroki 上游（默认 `https://kroki.io`）后 health 宣告 `kroki-proxy`，图表 kroki 通道改经 `/api/kroki` 服务端代发内联 svg（浏览器不直连 kroki.io；上游 host 只来自部署侧配置，SSRF 防线收口在服务端），代发不可用时自动回落浏览器直发。

跨文件搜索依赖 ripgrep（rg）——**可选**：缺失时自动降级系统 grep（功能差异：无大文件跳过、结果顺序不保证、正则为 ERE 方言、无列定位）；两者皆缺时搜索退回浏览器内执行。`GET /api/health` 经 `searchEngine` 字段宣告实际引擎。Workers 部署（配置/secrets/资产纪律/体积门禁/CI）见 [`server/README.md`](server/README.md)「Workers 部署」。

## 功能矩阵

| 格式 | 能力 |
| --- | --- |
| 代码/文本 | tree-sitter 高亮：34 语言 lite 集 wasm 随包内置，其余 helix 301 语言经「同源 → 服务端 → CDN」三层资产链按需加载（查询资产与 helix 版本对齐）；≤2MB 整文件高亮（失败 hljs 整文件兜底），>2MB 可视区懒高亮（chunk 失败行级 hljs 兜底，非流式来源 >200MB 降纯文本）；语言检测表对齐 helix（342 语言/685 扩展名），支持手动指定高亮语言（属性面板语言行 datalist / Tab 右键 / 状态栏浮层轻入口，检测值回显 placeholder，「（手动）」徽标标生效态，随会话快照恢复、复制标签页继承，置空回自动）；编码：BOM 识别 UTF-8/16/32（UTF-32 定长解码），严格 UTF-8 失败文本经 chardet 精判（Shift-JIS/Big5/EUC 系/windows-125x/KOI8-R 等白名单高置信采纳，低置信/映射外维持 gb18030 兜底——永不比今天更差；服务端 `X-VV-Encoding` 头仍最优先）；虚拟滚动；状态栏实时显示引擎与执行位置 |
| JSON Lines | .jsonl/.ndjson 行卡片视图：逐行 JSON 美化 + 卡片级懒高亮、可变高度虚拟滚动、长行折叠、失败行计数随滚动渐进统计；窗口流式渐进加载（「已加载 N 行」，滚动到底才确定总行数）；非流式来源 >200MB 委托 code 纯文本 |
| Markdown | 本地管线：GFM 表格/任务列表、callout、KaTeX 公式、围栏代码高亮、TOC 侧栏、图片灯箱（图+图表 svg 共画廊导航 ←/→、缩放滚轮/+/−/按钮、拖拽平移、r/f 重置）；图表矩阵（按语言模式设置 + 运行时回退链）：本地打包引擎 mermaid/graphviz/nomnoml/svgbob（wasm 产物入包）+ CDN 直链引擎 excalidraw/bpmn/vega/vegalite/wavedrom/bytefield/dbml/d2（jsdelivr 按需动态 import，graphviz 渲染器可切 viz-js/hpcc）+ kroki 通道 30 类与源码模式，本地/CDN 引擎失败自动降 kroki img、再落错误卡+源码；mermaid 主题设置（auto 跟随外观）切换即时重画已开文档；--compute 时 graphviz/svgbob 可切服务端渲染、kroki 通道可经服务端代发（health `diagrams`/`kroki-proxy` 宣告）；math 围栏、图/源码切换；扩展语法 ==高亮==/++插入++/描述列表/行内脚注 ^[注]、callout 折叠后缀（[!note]- 收起 / [!note]+ 展开）、wikilink 页内锚跳与图片嵌入（[[#标题]] / ![[图\|宽]]）、代码块语言徽标（点击徽标即复制代码）、\(..\)/\[..\] 数学定界符与 \ce{} 化学式；导出：属性面板一键导出自包含单文件 HTML（交互壳剥离、图片 data URI 内联、KaTeX 排印样式全内联、mermaid svg 成品、静态目录）或经隐藏 iframe 打印模板唤起系统打印另存 PDF（@page A4、分页保护、mermaid 浅色重画）；后端版可切远程 comrak 渲染（双引擎样式归一） |
| HTML | 沙箱 iframe 预览（sandbox 无 `allow-scripts`）+ DOMPurify 净化，源码/渲染双视图 |
| 图片 | 常见位图/矢量格式 + markdown 图片灯箱 |
| 音视频 | ArtPlayer 集成：mp4/webm 直接播，`.m3u8` 按需加载 hls.js、`.flv/.ts` 按需加载 mpegts.js |
| PDF | pdfjs canvas 渲染 + 文件内文本搜索定位 |
| 二进制 | hex 三列 dump（偏移/hex/ASCII）+ 结构树（PNG/IHDR 等字段展开）；offset 跳转、hex/UTF-8 双模式搜索（进度可取消、1000 命中截断）、字节检查器（属性面板展示，类型/字节序可切） |
| 压缩包 | zip（jszip）/ tar·tgz·tbz2·7z·rar（libarchive wasm）：包内树 + 条目递归预览（嵌套深度限 3 层，超限拒绝） |
| Office | docx（mammoth 转 HTML）、xlsx（SheetJS，多 sheet 页签、>200 行截断）、pptx（文本提纲卡片） |
| 大文件 | hex / JSON Lines / 代码文本窗口流式：首屏仅拉头部 + 首窗口，滚动续读/回看，块缓存 LRU 内存有界；本地文件 slice、后端 Range 分块拉取（压缩包条目等全量来源不流式）；code/jsonl 流式仅 UTF-8，非 UTF-8 自动回退全量；512MB 流式上限，到限提示转 hex |
| 打开方式 | 内容探测链：magic 签名（mp4 族品牌表/webm/webp/wav/flac/ogg/bmp/ico/gz/7z/rar 等——无扩展名或改名文件直达真渲染器；「二进制扩展名 + 签名不符」不参与改派防误伤）→ 文本嗅探 → hex 兜底；「打开方式」三入口——属性面板下拉 / 状态栏浮层 / Tab 右键子菜单——受限候选 + 「更多渲染器…」就地展开全量 12 渲染器（per-tab 手动改派进会话快照，（手动）徽标），markdown 恒在候选兜底（.txt 可强制 markdown 渲染）；错误卡片快捷动作同链 |
| 搜索 | 文件内（`/`）+ 全局（`Ctrl+Shift+F`）双实现：浏览器内 grep / 远程搜索（rg 可选：缺 rg 自动降级系统 grep，皆缺时 501 → 前端退回浏览器内 grep）；大文件文件内搜索为后台全文扫描（进度提示、可取消、结果随扫描累积） |
| 会话 | IndexedDB tab 快照恢复 + 目录句柄权限记忆（本地文件内容不保留，刷新后以占位提示重开） |
| 工作区 | 命名工作区分组管理数据来源（本地文件夹 / 后端路径，支持服务器多根 `--root` 与根内子目录）：tab 按组隔离，顶栏切换器与管理面板（`Alt+W`）创建/切换/搜索，刷新后组结构与远端来源自动恢复 |
| 目录挂载 | 目录管理页（📁 / `Ctrl+Alt+M`）三组聚合：服务端根与静态/运行时挂载（能力徽标 + 在树中打开）、前端配置挂载（S3/WebDAV 直连或代理经服务器——新增→测试连接→保存、编辑、删除、打开；代理配置与服务器清单按指纹对账幂等重注册）、本机授权来源（localfs 句柄授权态 / 会话来源）；直连 = 浏览器内 SigV4 签名 fetch / PROPFIND 直访 S3/WebDAV（只读），**前置：目标端需配好 CORS**——S3 bucket 允许本站来源 GET + Range/expose 头，WebDAV 需放行 PROPFIND/GET（大概率被拦，表单有预检提示），未配置时给出特征化报错文案；直连凭据明文存浏览器 IndexedDB（管理页新增表单与列表双处警示）；挂载根与直连源不支持变更推送（状态栏按源标示），全局搜索对其走浏览器内扫描 |
| PWA | manifest + Service Worker：静态资产预缓存，grammar wasm/查询文件运行时缓存，离线可用（已缓存范围） |
| 外观 | helix 代码主题体系 + VSCode 主题导入（JSON/VSIX，亮/暗双槽独立记忆、IndexedDB 存储），hljs 兜底着色近似跟随代码主题 |
| 字体 | 界面/代码双槽字体族（18 项预设 + 手输多级回退栈）与字号（界面字号 10–28px / 代码字号 9–28px），代码字号驱动行高联动（虚拟滚动行高与 j/k 步长随动，已打开文件自动重排）；网络字体库：https 直链或本地上传 .ttf/.otf/.woff/.woff2（单文件 ≤30MB，先装载验证后入库），IndexedDB 持久化 + 启停/删除/样张预览 + 启动自动恢复，已启用项进两槽下拉（与预设撞车/哨兵名自动避让），删除时引用槽位回落默认 |
| 布局 | 双栏自由化：文件树/属性面板折叠（28px 竖条带展开钮）、中缝拖拽调宽（实时预览、松手落盘、双击重置默认，左 180–480px / 右 160–420px clamp）；顶栏/标签栏右键隐藏 + 边缘悬停临时条（半透覆盖形态，移开 1.5s 自动收回、右键重显），桌面专属（≤900px 抽屉机制不变）；折叠/宽度/可见性随设置持久化，刷新/重启还原 |
| 专注模式 | 全屏阅读 zen：桌面 `Ctrl+Alt+Z` 或顶栏「专注」按钮进出（zen 态按钮切「退出专注」，进入时 Toast 提示退出方式，桌面/移动端文案随断点分支）、`Esc` 逐层退出（面板打开时只关面板）、隐藏条右键菜单退出；与显式布局正交（进出不改写折叠/宽度/可见性字段，退出即还原），刷新后仍落 zen；移动端 ☰ 抽屉头部进入（iOS Safari 无长按菜单的回落入口）、右下浮钮退出（44px 触控标准）、系统返回键先关面板再退 zen（history 守卫项承接，不劫持正常前进后退） |
| 设置 | 统一设置中心（⚙ / `Ctrl+,`，全屏页九组：外观/字体/图表/布局/搜索与排除/自动刷新/计算/存储与数据/关于）；草稿模型：表单/JSON 双视图共享草稿（非法 JSON 标红停留、文本不丢），改动统一「应用」经订阅链一次生效、脏态关闭确认；导入/导出（schemaVersion 文件、合并=缺项保留现状 / 替换=整体覆盖、变更摘要逐组 diff）；存储与数据：七分类用量估算与精细清除（设置/会话快照/目录授权/导入主题/网络字体/挂载配置/运行时缓存）+ 恢复出厂（全分类+清缓存+注销 Service Worker）；关于：双端版本、存储用量与配额（usage 细分）、持久化存储申请 |
| 移动 | 601-900px 文件树收进抽屉（右栏保留），≤600px 右栏（目录/属性）再收进独立抽屉，触摸滚动可用 |

## 快速开始

### 后端单二进制（推荐）

```bash
pnpm install
pnpm build:all        # 前端 → apps/web/build + cargo build --release → server/target/release/vviewer

./server/target/release/vviewer serve --root /path/to/data --web-dist apps/web/build
# 打开 http://127.0.0.1:8321（本机免鉴权；局域网加 --allow-lan --token-gen）
```

需要服务端计算（远程高亮/comrak 渲染/图表服务端渲染）时追加 `--compute`；kroki 图表通道需服务端代发时追加 `--kroki-host <上游>`（独立于 `--compute`）；跨文件搜索除外：属文件服务基础能力，无需 `--compute`——rg 可选，缺失时自动降级系统 grep（差异与引擎宣告见上）。全部参数可改用 TOML 配置文件承载（`--config`，含 S3/WebDAV 附加挂载 `[[mount]]` 与 kroki 上游节）：全参示例与 600 权限建议见 [`server/README.md`](server/README.md)「配置文件」。

### 桌面应用（Tauri 薄壳）

tag（`v*`）推送后 release workflow 在 GitHub Release 附三平台安装包（**未签名直出**，
安装时多一步手动放行）：

| 平台 | 产物 | 安装与放行 |
| --- | --- | --- |
| Windows | `.exe`（NSIS 安装器） | 双击安装；SmartScreen 弹「已保护你的电脑」→ **更多信息 → 仍要运行** |
| macOS | `.dmg`×2（Apple silicon / Intel 分产物） | 挂载拖入 Applications；首次启动被 Gatekeeper 拦截 → **系统设置 → 隐私与安全性 → 仍要打开**（只首次需要；右键 → 打开仅旧版 macOS 有效，macOS 15 起已移除） |
| Linux | `.AppImage` / `.deb` | AppImage `chmod +x` 后直跑；发行版缺 libfuse2 报「dlopen libfuse.so.2 失败」时 `sudo apt install libfuse2`，或以 `./VViewer*.AppImage --appimage-extract-and-run` 免 fuse 兜底运行；deb `sudo dpkg -i *.deb` |

应用为单实例薄壳：启动时内嵌 server sidecar（只绑 127.0.0.1、内核随机端口，无
token、`--allow-lan` 未开），就绪后窗口导航本机页面，退出自动回收子进程。发布前
按[手动冒烟清单](apps/desktop/README.md#手动冒烟清单)（含发布前必过的故障路径
抽查）逐项过一遍；从源码
本地运行/打包见 [`apps/desktop/README.md`](apps/desktop/README.md)「本地开发」。

### 纯前端（静态托管）

```bash
pnpm install
pnpm --filter web build
# 将 apps/web/build/ 整目录部署到任意静态托管（Nginx/对象存储/GitHub Pages 等）
```

**GitHub Pages**：推送到 main（前端面变更）时 `pages-deploy.yml` 自动构建并部署到
`gh-pages` 分支——项目站点会自动注入子路径 base（`VV_BASE_PATH=/<repo>/`，贯通
SvelteKit 路由、PWA manifest 与高亮资产路径；`<owner>.github.io` 用户站点自动按根
路径）。首次启用需在 Settings → Pages 把 Source 设为 `gh-pages` 分支。自建托管需
子路径部署时同样以 `VV_BASE_PATH=/前缀 pnpm --filter web build` 构建。

打开页面后拖入或选择本地文件夹即可浏览；`file://` 直开不可用（worker/模块限制），需经 HTTP 访问。

## 架构概览

pnpm workspace monorepo：

```
packages/
  core/             TreeStore/TabStore 抽象、格式派发器与流式读上下文（StreamCtx）、编码检测（框架无关）
  highlight/        web-tree-sitter Worker 管线、helix 查询继承/injection、语法资产三层解析链（同源→服务端→CDN）、主题
  render-text/      代码（虚拟滚动/降级链/窗口流式）、markdown 管线、HTML 沙箱、文件内搜索
  render-doc/       pdfjs、docx/xlsx/pptx
  render-binary/    hex dump（窗口流式/搜索/检查器）、结构树
  render-media/     ArtPlayer/hls.js/mpegts.js、图片
  render-archive/   jszip/libarchive 包内树与递归预览
apps/web/           SvelteKit 5 + adapter-static 壳（TopBar/FileTree/TabBar/ViewerPane）、PWA
apps/desktop/       Tauri 2 桌面薄壳：spawn server sidecar（VV_READY 就绪导航/单实例/退出回收）
server/             Rust axum：tree/file/events SSE/ticket/search/compute（高亮·渲染·图表单图）/kroki 代发端点，只读
```

设计与实施文档（含各里程碑验收标准与实测数据）：

- 设计 spec：`docs/superpowers/specs/2026-10-06-vviewer-design.md`
- 实施计划：`docs/superpowers/plans/2026-10-07-m1-skeleton.md` … `2026-10-07-m7-pwa-polish.md`（M1 骨架 / M2 高亮 / M3 markdown+HTML / M4 二进制媒体 / M5 server / M6 compute+搜索 / M7 PWA+打磨）
- 后续特性 spec/plan 同目录按日期排列：rg 缺失降级 grep、格式覆盖与打开方式、JSON Lines 查看器、VSCode 主题、工作区多根、tab 动作、hex 增强、IO 级流式、外观订阅中心化、渲染器/语言手动指定、图表 CDN 引擎与服务端图表、渲染器自选展开×签名扩表×编码探测等
- E2E 场景文档：`docs/e2e/`；历轮测试报告：`docs/report/e2e/`
- 部署细节：`docs/deploy.md`；server 参数与安全：`server/README.md`

## 开发

```bash
pnpm test                     # vitest 全仓单元测试
cargo test --manifest-path server/Cargo.toml   # Rust 单元/集成测试
cd apps/web && npx playwright test             # E2E 默认通道（chromium + mobile 双 project）
cd apps/web && npx playwright test -c playwright.server.config.ts   # E2E 服务端通道（需先 pnpm build:all）
pnpm typecheck                # TS 类型检查（含 svelte-check）
cargo clippy --manifest-path server/Cargo.toml --workspace --all-targets -- -D warnings   # clippy 门（CI 同款，警告即失败）
```

E2E 双通道（Playwright/chromium）：默认通道 `apps/web/e2e/`（桌面全量场景 + 移动视口 375×667 触摸冒烟，mock 数据经 vite preview 伺服）；服务端通道 `apps/web/e2e-server/`（release 二进制伺服真实后端）。各域场景说明见 `docs/e2e/`，历轮测试报告见 `docs/report/e2e/`。

桌面 crate（`apps/desktop/src-tauri`，独立 manifest）不在 CI 门禁内（仅 release 打包触达）：涉及提交请本地跑 `cargo clippy` 自查。

## License

本项目以 Apache-2.0 许可发布。运行时分发的第三方组件及其许可清单见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)（仅接受 MIT / Apache-2.0 / BSD / ISC 引入；完整许可文本随各 npm 包分发）。
