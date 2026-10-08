# vviewer E2E 测试报告（2026-10-08）

> 被测版本：`main` @ `a47148114dd4962b1b32bcf3fe190702356fb3c8`（commit 标题：docs: 记录 grammar 资产出库裁决（deviations #10），deploy 资产口径校准）
> 证据根目录：`.temp/e2e-data/`（测试数据集）、`.temp/e2e-artifacts/<域名>/`（各域截图）、`.temp/e2e-artifacts/verify/`（复核截图）
> 状态标记约定：**verified** = 经独立复核会话证实；**unconfirmed** = 未经独立复核证实（按规则保留并明确标注，不丢弃、不计入已证实缺陷）。

---

## 1. 执行摘要

### 1.1 完成度总评

本轮共 **106 个测试点**、覆盖 **10 个功能域**，全部实跑执行（无 skipped），其中 1 点受阻（SHELL-07，headless 无法驱动 FS Access 原生对话框）。结果分布：

| 结果 | 数量 | 占比 |
| --- | --- | --- |
| 通过（pass） | 72 | 67.9% |
| 部分通过（partial） | 24 | 22.6% |
| 未通过（fail） | 9 | 8.5% |
| 受阻（blocked） | 1 | 0.9% |

域级完成度评级：**完整 1 个**（theme-system）、**基本完整 6 个**（markdown-html-docs、in-file-search、media-office-viewer、binary-hex-archive、server-file-service、compute-global-search）、**部分实现 3 个**（app-shell-sources、code-highlight-degrade、pwa-mobile-performance）。若将 partial 计为部分达成，通过+部分通过合计 96/106（90.6%）。

### 1.2 缺陷计数

原始发现 34 条（33 个候选 + 1 个附带发现），去重合并 4 组共 12 个候选后，最终缺陷 **26 条**。按严重度 × 状态分布：

| 严重度 | verified | unconfirmed | 小计 |
| --- | --- | --- | --- |
| high | 1 | 0 | **1** |
| medium | 16 | 1 | **17** |
| low | 6 | 2 | **8** |
| **合计** | **23** | **3** | **26** |

- 唯一 high：**BUG-01**（HLS 分片被解析为无效 blob: URL 永不起播且静默无提示，.ts 被按代码文本渲染为乱码）——verified。
- unconfirmed 3 条：**BUG-08**（medium，服务器来源 tab 刷新后被误标为本地文件占位）、**BUG-25**（low，webkitdirectory 回退通道——复核判为误报）、**BUG-26**（low，触摸无惯性——复核不可复现）。三条均保留并标注。

### 1.3 一句话结论

**主干可用、声明能力存在系统性缺口**：文件服务契约、主题系统、Markdown/Office/压缩包查看与全局搜索主链路扎实可用（主题域 7/7 全过），但本地 tree-sitter wasm 高亮主路径整链失效（BUG-06）、HLS 完全不可用（BUG-01，唯一 high）、状态栏元数据与设置面板整体缺失（BUG-04/05）、PWA 离线承诺不达标（BUG-15/06 关联），拉低了三个域至「部分实现」。

---

## 2. 测试对象与环境

### 2.1 被测版本与构建

- git HEAD：`a47148114dd4962b1b32bcf3fe190702356fb3c8`（main 分支）。
- 构建：前端 production build 与 Rust release 二进制均构建成功（web ✓ / cargo ✓）；产物为 `apps/web/build`（19:24）与 `server/target/release/vviewer`（今日 18:43）。
- grammar 资产：测试前执行 `pnpm gen:grammars`（34 个语法缓存全命中，manifest 34 项写入 `apps/web/static/grammars/`，日志 `.temp/gen-grammars.log`）。此为偏差 #10 的强制前置（grammar wasm 资产不入库、构建期生成）。

### 2.2 运行形态（后端 `--compute`）

- 主服务：`vviewer serve --root .temp/e2e-data --web-dist apps/web/build --port 8391 --compute`，PID 242722（已写入 `.temp/e2e-server.pid`，日志 `.temp/e2e-server.log`）。
- `/api/health` 返回 `capabilities=["file-server","compute"]`；首页 HTTP 200（1545 字节）；`/api/tree` 根与 `samples/m1` 均正常。
- ripgrep 在 PATH（`/usr/sbin/rg`），无需降级路径即可测远程搜索。
- 端口处置：8391 起初被遗留孤儿进程占用（PID 221564，此前冒烟阶段产物，`--root` 指向 `.temp/e2e-smoke`），已按 PID kill 后重启（未用 pkill）；`.temp/e2e-smoke` 遗留目录未动。
- 辅助/自起实例（均测毕按 PID 清理，主实例 8391 保留）：8392/8393（CORS 静态服务器，已停）、8394（SRV-06 tmpfs root、CMP-09 无 rg 环境）、8395（SRV-10 `--token-gen`；CMP-10/11 纯前端 `python3 http.server`）、8396（`--hidden`）、8397（无 `--compute`）、8398（`--token e2e-test-token-42`）、8399（release 单二进制冒烟）。

### 2.3 测试数据集

数据根 `.temp/e2e-data/`，总量约 24MB，53 个常规文件 + 1 个 symlink（清单 54 项，全部造出、无跳过）：

| 类别 | 内容 | 说明 |
| --- | --- | --- |
| 基础样例 | `samples/m1~m6`（代码/markdown/html/office/子目录/GFM） | m1：generate.mjs、hello.js、notes.md、pixel.png；m2：sample.md/.pl/.rs/.ts；m3：demo.md、page.html；m4：9 件 office/二进制/归档；m5：sample.js、sub/inner.txt；m6：sample-gfm.md |
| 编码 5 件 | UTF-16LE/BE（带 BOM）、UTF-8（带 BOM）、CRLF、GB18030 | 均经 file(1) 验证；gb18030.txt 的 file(1) 误报 ISO-8859（GB18030 常见现象），已用 python `decode('gb18030')` 回读验证内容正确 |
| 体积 4 件 | minified-3mb.js（3,145,753B 单行）、big-20mb.txt（21,027,496B，>20MB 上限行为）、empty.txt（0B）、long-line.json（462KB 单行） | 实测字节数如上 |
| 语言 13 种 | py/rs/go/c/cpp/java/ts/js/vue/yaml/toml/sql/sh | 超出「至少 8 种」要求 |
| 归档 3 件 | nested-4-levels.zip（程序化逐层验证 4 层嵌套）、truncated.zip（243→121B 半截断，unzip -t 确认 EOCD 缺失，与仓库近期 EOCD 修复相关）、sample.tar.gz（含 src/a.txt、src/b.txt） | |
| symlink | `edge/symlink/escape-etc -> /etc` | /api/tree 呈现为 kind=dir（服务解析符号链接），逃逸防护断言应放在内容/fetch 类接口（该断言本轮未覆盖，见第 7 节） |
| 特殊文件名 3 件 | 空格、中文、emoji | /api/tree 均正常列出 |
| HTML/MD 3 件 | with-script.html（内联+外链 script）、with-event-attrs.html（on* 属性 + javascript: 链接）、deep-quotes.md（12 层嵌套 blockquote） | |

测试期间各域另造样例（存于 `.temp/e2e-data/domain-<域名>/`）：25MB 文本、3MB 长文本×2、1.9MB JS、多语言中文编码件、shebang 无扩展名文件、3/6 页 PDF、EXIF rot90 jpg、3s mp4、wav/mp3、HLS 切片、flv/ts、截断 mp4/pdf、ELF 二进制、3MB 随机 .bin、加密混合 zip、5 层嵌套 zip、2050 个 OPFS 小文件等，均经 file(1)/ffprobe/pdfinfo/ghostscript/unzip -t/zipinfo 等独立验证为合法格式。

### 2.4 已裁决偏差（不计缺陷）

| 偏差 | 内容 | 涉及域 |
| --- | --- | --- |
| #1 | HTML 沙箱实现为 `sandbox="allow-same-origin"`（无 allow-scripts）而非 opaque origin；脚本执行维度安全等价、父页面可读 contentDocument | markdown-html-docs |
| #2 | `?token=` URL 引导交换未实现，改为连接表单手动粘贴 token；凭据存 sessionStorage、重连需手动 | server-file-service |
| #3 | `/api/file` 仅下发 X-VV-Lang 与 X-VV-Encoding，X-VV-Type 头已裁决省去 | server-file-service |
| #4 | 移动端图片双指捏合缩放未实现，仅有滚轮缩放+双击复位，后置裁决维持 | media-office-viewer |
| #5 | 服务端高亮无 injection，带注入的 6 种语言在 auto 策略下留在本地执行 | compute-global-search |
| #6 | 服务端 comrak 不启用数学扩展、无数学掩码，数学内容远程渲染与本地 KaTeX 可能不一致 | compute-global-search |
| #7 | 服务端解包已裁决移 P2，压缩包一律前端 jszip/libarchive 本地解包 | binary-hex-archive |
| #8 | 不做 RustEmbed 内嵌前端产物，`--web-dist` 是唯一前端挂载通道 | server-file-service |
| #9 | 跨文件搜索结果列号（col）口径两端统一为 UTF-16 码元（实现约定记录） | compute-global-search |
| #10 | grammar wasm 资产不入库、构建期由 `pnpm gen:grammars` 生成（lite 集 36→34，yaml/vue 为 vendored 遗留产物），测试前必须先生成资产 | code-highlight-degrade |

---

## 3. 测试方法与覆盖范围

### 3.1 方法（四层）

1. **黑盒 GUI（agent-browser 独立会话）**：每个域使用独立浏览器会话逐测试点执行，DOM 断言、键盘/触摸输入、网络请求观测、截图存证（`.temp/e2e-artifacts/<域名>/`，其中 code-highlight-degrade 16 张、markdown-html-docs 16 张、in-file-search 14 张、compute-global-search 20 张、pwa-mobile-performance 12 件）。
2. **接口断言（curl）**：直打 `/api/health`、`/api/tree`、`/api/file`（Range 三态、X-VV 检测头、路径穿越/symlink 防护）、`/api/ticket`、`/api/events`（SSE 一次性 ticket 与 15s 心跳）、`/api/compute/highlight`、`/api/compute/markdown`、`/api/search`（NDJSON 流、glob 参数），以及启动参数矩阵（`--allow-lan`/`--token`/`--token-gen`/`--hidden`/无 rg PATH）。
3. **独立复核与仲裁**：关键缺陷经逐域 verify 会话（`vv-verify-<域>-<测试点>`）独立复现；仲裁按统一标尺调整严重度 4 处（SRV-06 high→medium、CMP-07 medium→low、CMP-03 medium→low、SHELL-01 medium→low；HL-05 high→medium 系复核已调、仲裁维持），均在对应 BUG 条目 note 中记录原判。复核同时纠正了原报告若干事实性误报：SHELL-11 的「Ctrl+Shift+F 无响应」实为正常（两次独立验证均打开全局搜索面板）；SHELL-09 探针键名纠正（须写单键对象 `vviewer:settings`，而非 `vviewer:settings.excludedPatterns`）；BIN-10 URL 入口症状差异（复核打开为「file」标签报「不支持的扩展名 .」，报告记为 code 乱码）；MEDIA-11 Reconnect 计数随时机不同（报告约 4s 后为 5，复核 2s 时为 2）；CMP-06 文件实为 801 行（报告写 800）、`.vv-viewer-scroll` 为虚拟渲染容器不构成滚动证据，复核改以「视口显示哪些行」独立证实；BUG-12 混合包构造方法纠正（`zip -P` 会加密全部条目，复核改用两阶段构造真混合包，结论反而加强）。
4. **仓库自带套件交叉验证**：`apps/web/e2e` Playwright 套件（chromium + mobile 两项目），结果见第 6 节。

### 3.2 覆盖范围

10 域 × 106 测试点全部实跑（无 skipped），1 点 blocked（SHELL-07）。覆盖矩阵见第 4 节，逐点明细见第 8 节附录。

### 3.3 环境限制（如实记录）

- headless Chromium 无法显示/驱动 FS Access 原生目录选择器与刷新后 `requestPermission` 权限弹窗（SHELL-07 blocked 的直接原因）。
- 合成拖拽事件的 `DataTransferItem.webkitGetAsEntry()` 恒为 null（规范限制），真实 OS 文件夹拖拽通道未覆盖。
- agent-browser device 仿真不启用触摸（`maxTouchPoints=0`），触摸交互以 CDP `Input.dispatchTouchEvent` 与 TouchEvent 派发替代；JS 派发 TouchEvent 不驱动原生滚动属浏览器安全设计，非产品缺陷。
- 对 36 万 span 超大 DOM 执行 agent-browser 无障碍 snapshot 曾两次致渲染进程无响应/CDP 超时（HL-03、THEME-06），判定为测试工具 AX 遍历副作用，不计应用缺陷，改用页内 eval 完成验证。

---

## 4. 功能完成度矩阵

统计口径（依仲裁记录）：passed 采用各域 results 字段值（个别域 summary 口径与字段有 ±1 出入，以字段为准）；failed/partial 细分尽量依各域 summary 明示口径；blocked 仅 SHELL-07 一条。

| 域 | 测试点数 | 通过 | 缺陷（fail / partial） | 受阻 | 评级 | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| app-shell-sources | 13 | 5 | 7（2 fail / 5 partial） | 1 | 部分实现 | 核心打开通道（服务器树/URL/打开文件/拖单文件）、tab 生命周期、未知类型兜底、响应式双断点、本地文件刷新占位均通过；三块系统性缺失拉低评级：键盘滚动/快速打开零实现（BUG-03）、状态栏元数据未实现（BUG-04）、设置面板整体缺失（BUG-05）；FS Access 真实 picker 链路受阻（SHELL-07）。failed=SHELL-11/12，partial=SHELL-01/03/08/09/13，blocked=SHELL-07 |
| code-highlight-degrade | 11 | 5 | 6（2 fail / 4 partial） | 0 | 部分实现 | 降级链下游扎实（hljs 兜底/分块零错位、25MB 虚拟滚动流畅行号正确、GB18030/UTF-16LE 解码正确、2MB 解析期 53fps）；但本地 tree-sitter wasm 主路径整链失效（零 .wasm 请求，BUG-06）与无扩展名文件直接拒绝预览（BUG-07）两条高严重度缺陷压低评级。failed=HL-01/05，partial=HL-04/06/07/10（划分依域 summary 的 4 pass/5 partial/2 fail 口径，passed 取字段值 5） |
| theme-system | 7 | 7 | 0 | 0 | 完整 | 7/7 全过：亮暗循环与记忆、跟随系统（prefers-color-scheme 双向仿真）、214 个 helix 主题零重解析（纯 CSS 变量替换，MutationObserver 实测 0.5~0.8ms 落 DOM、36 万 span 类名哈希不变）、codeTheme 双主题记忆与联动、markdown 同步、>2MB 分块路径主题跟随。域内观察到的 hljs 兜底/零 wasm 现象归属 BUG-06，不重复计 |
| markdown-html-docs | 13 | 12 | 1（0 fail / 1 partial） | 0 | 基本完整 | 五步管线（GFM 表格/任务列表/callout/KaTeX/mermaid/front matter/围栏高亮）、TOC 三断言、HTML 沙箱、源码/渲染双视图全部通过；唯一缺陷 MD-11 外部图片外泄网络请求（BUG-17，隐私类）。围栏高亮走 hljs 兜底现象归属 BUG-06 |
| in-file-search | 7 | 5 | 2（1 fail / 1 partial） | 0 | 基本完整 | 核心交互（/ 唤起、n/N 计数、Enter/Shift+Enter 循环、Esc）在代码/3MB 虚拟滚动/markdown 渲染/HTML 源码/PDF 五类视图全部精确工作（与 grep/pdftotext 吻合）；缺全部命中高亮（partial，BUG-18）与大小写开关（failed，BUG-23）。failed=FSEARCH-03、partial=FSEARCH-01（依域 summary 口径） |
| media-office-viewer | 11 | 9 | 2（1 fail / 1 partial） | 0 | 基本完整 | 图片缩放/双击复位、SVG 消毒、mp4 ArtPlayer（135ms 起播）、音频、EXIF 方向、PDF 懒渲染缩放、docx/xlsx/pptx 全过且远优于预算（媒体起播 40ms）；但 HLS 完全不可用（BUG-01，high，域内唯一 high）明显拉低实际体验，媒体损坏错误呈现不符（BUG-14）。样例均经 file/ffprobe/pdfinfo 独立验证为合法格式 |
| binary-hex-archive | 10 | 8 | 2（1 fail / 1 partial） | 0 | 基本完整 | hex 三列 dump、1MB 分页精确翻页、PNG/ELF 结构树（与 readelf/python 解析吻合）、zip/tar 条目树与递归预览、4 层嵌套超限拒绝全部通过；加密 zip 整包拒绝（BUG-12，加密语义正确但明文条目连带不可预览）与 magic 预检缺失（BUG-13，重定向从未发生） |
| server-file-service | 13 | 10 | 3（1 fail / 2 partial） | 0 | 基本完整 | HTTP 契约全部通过：health capabilities、Range 三态、路径穿越防护、allow-lan token 约束、hidden 过滤、SSE ticket 与 15s 心跳、中文名深层目录、自然排序；btrfs watcher 故障（BUG-02，主部署环境自动刷新不可用）与刷新设置/按钮缺失（并入 BUG-05）为主要扣分。SSE 功能链路本身经 /tmp 实例验证正常，故障特定于 btrfs 数据根 |
| compute-global-search | 12 | 7 | 5（0 fail / 5 partial） | 0 | 基本完整 | 搜索主链路与 compute 路由可用：能力宣告、本地/远程指示、auto 远程失败真实回退（网络层捕获 400→本地渲染）、无 rg 501 降级、1000 条/2000 文件上限、取消/重发、API 层 glob/正则/大小写全部有效；5 个 partial 均为可绕过的辅助功能缺失（全局跳转定位 BUG-09、remote 大文件阈值 BUG-10、超限引导 BUG-11、glob 无 UI BUG-21、执行位置指示 BUG-22） |
| pwa-mobile-performance | 9 | 4 | 5（1 fail / 4 partial） | 0 | 部分实现 | PWA 基础扎实（SW activated、precache 102 条含 manifest、离线壳导航可用、/api 严格网络优先）、移动视口无溢出、文本首帧与媒体起播远优于预算；但离线相关承诺密集不达标：离线 reload 落浏览器错误页（BUG-15）、离线高亮承诺不成立（BUG-06 关联）、hex 首屏超预算 3~9 倍（BUG-16）、断网静默失败（BUG-24）。failed=PWA-02、partial=PWA-03/04/06/08。触摸/惯性结论受仿真环境限制（BUG-26 unconfirmed） |
| **合计** | **106** | **72** | **33（9 fail / 24 partial）** | **1** | 完整 1 / 基本完整 6 / 部分实现 3 | 全部实跑，无 skipped |

---

## 5. 缺陷清单

> 26 条 = 23 verified + 3 unconfirmed。每条含：严重度、状态、涉及域与对应测试点、复现步骤、期望/实际、证据、仲裁备注。verified/unconfirmed 在标题中明确标注。

### BUG-01【high · verified】HLS（m3u8）分片被解析为无效 blob: URL 永不起播且静默无提示，.ts 被按代码文本渲染为乱码

- **严重度**：high｜**状态**：verified｜**涉及域**：media-office-viewer（对应测试点：MEDIA-04）
- **复现步骤**：文件树点击本地标准 HLS（video-hls.m3u8 + seg0-2.ts 同目录）等待 10s+；同法打开 video.ts；对照打开 video.flv。
- **期望**：m3u8 经 hls.js 起播、ts 走 mpegts.js 起播；资源不可达时给出可理解错误。
- **实际**：m3u8 播放列表经 /api/file 正常加载（200，duration=6 已解析），但分片请求全部指向无效 URL `blob:http://127.0.0.1:8391/seg0.ts` 并反复 XHR 重试（20s 内 7+ 次），video readyState 恒 0 永不起播，页面无任何错误卡片/alert，missing-seg.m3u8 同样静默挂起；video.ts 无任何视频播放路径（hasVideo=false），直接进入 vv-code 代码容器显示 MPEG-TS 二进制乱码（「G@…FFmpeg Service01…」）；仅 flv 正常播放（readyState=4，可播完）。
- **证据**：复核会话 vv-verify-media-office-viewer-MEDIA-04 独立复现：curl 证实服务端无问题（m3u8 200/166B、seg0.ts 200/41360B、不存在分片 404）；网络层捕获 blob:/seg0.ts XHR 反复重试、v.error=null、无 error UI、播放器显示 00:00/00:00；ts 打开后内容装进代码容器渲染乱码；flv 对照正常。截图 media04-m3u8-stuck.png、media04-ts-as-typescript.png、media04-flv-playing.png。
- **仲裁备注**：MEDIA-04 单点（m3u8/ts/flv 同属该测试点）。复核维持 high：HLS 这一声明媒体格式完全不可用且静默，ts 完全无播放路径输出乱码（错误结果），不满足可绕过条件。

### BUG-02【medium · verified】8391 主实例（btrfs 数据根）watcher 持续故障，SSE 变更推送与自动重读完全不可用且无自愈

- **严重度**：medium｜**状态**：verified｜**涉及域**：server-file-service（对应测试点：SRV-06）
- **复现步骤**：连接 8391 打开 samples/m5/sample.js；服务器侧 echo 追加一行；等待观察 tab 与状态栏；POST /api/ticket 取 ticket 后 `curl -sN /api/events?ticket=…` 同时写文件探测事件流。
- **期望**：保持 tab 前台，服务器侧写入后约 500ms debounce 自动重读显示新内容，滚动位置保留。
- **实际**：8391 上任何写入（既有文件 append、新建文件）仅推送 `{"type":"watch-error"}`，无任何 changed 事件，状态栏常驻「自动刷新不可用」（SSE 建连时即出现，非写触发），tab 永不自动重读，复测两次均复现；同一二进制在 /tmp tmpfs 自起实例上自动重读+滚动保留链路完整通过（append 后 3s 内自动 GET /api/file 200、scrollTop 保持 12000、新行渲染），故障特定于 btrfs 数据根实例。
- **证据**：复核会话独立复现：SSE 探测两次仅见 watch-error 与 `: ping`；8394 tmpfs 对照（同 release 二进制，8391 数据根经 `df -T` 确认 btrfs /dev/sda3）append 立即收到 `{"paths":[…],"type":"changed"}` 且浏览器自动重读、滚动保留、DOM 出现 1502 行；已排除 symlink 诱因。截图 03/04/05/06/07 号。
- **仲裁备注**：SRV-06 单点；多域状态栏出现的「自动刷新不可用」均为同一根因表征。复核员原判 high；按统一标尺（文件查看功能本身可用、可手动重开文件绕过、状态栏有明确警示文案）仲裁调整为 medium。btrfs 根因未定位，列入未覆盖范围。

### BUG-03【medium · verified】spec 5.11 键盘快捷键 j/k/gg/G/Ctrl+P 全部零响应（trusted 按键到达页面但无任何实现）

- **严重度**：medium｜**状态**：verified｜**涉及域**：app-shell-sources（对应测试点：SHELL-11）
- **复现步骤**：打开 301 行 long-code.js（虚拟滚动容器 scrollHeight 6040/clientHeight 473），在 CDP 点击代码区、focus 容器、blur 到 body 三种焦点状态下依次按 j×43、k、g、g、G、Ctrl+P；挂 window keydown 探针确认事件到达；按 / 对照验证监听链路。
- **期望**：j/k 逐行滚动、gg 跳顶 G 跳底、Ctrl+P 弹出快速打开面板可按文件名跳转（spec 5.11）。
- **实际**：trusted keydown 全部到达 window（探针逐条记录）但 `.vv-code-pre.scrollTop` 恒 0（G 后应为 5567）、无快速打开面板；eval 直接赋值 scrollTop=1000 可生效，证明容器可滚而应用未实现键盘滚动；/ 键正常唤起搜索面板，证明键盘监听链路与按键通路有效；docs/spec-deviations.md 无此项豁免。
- **证据**：复核会话 vv-verify-app-shell-sources-SHELL-11 独立复现（探针记录 `{key:'j',trusted:true}`、`{key:'p',ctrl:true,trusted:true}`；枚举所有 vv-* 面板为空）；同时纠正报告一处误报：Ctrl+Shift+F 实际两次独立验证均正常打开全局搜索面板。截图 9 张存 `.temp/e2e-artifacts/verify/SHELL-11-01~09.png`。
- **仲裁备注**：SHELL-11 单点。复核确认缺陷真实，报告中 Ctrl+Shift+F 无响应与「状态栏行列不变」两项为报告偏差（后者状态栏本就无行列显示），已在证据中剔除；severity medium（鼠标滚动、文件树、「打开文件」均可绕过，/ 搜索正常，非崩溃或错误结果）。

### BUG-04【medium · verified】状态栏通用元数据（编码/语言/大小/行列，spec L290）整体未实现——服务端检测头正确下发但 UI 不展示

- **严重度**：medium｜**状态**：verified｜**涉及域**：app-shell-sources、code-highlight-degrade、server-file-service（合并：SHELL-12 + HL-06 + HL-07 + SRV-05）
- **复现步骤**：依次打开代码文件（long-code.js/utf16le.txt/GB18030/UTF-8 中文）、图片（pixel.png）、视频（sample.mp4），读取 `.vv-statusbar` 的 innerText/outerHTML；`curl -I /api/file` 对照 x-vv-lang/x-vv-encoding 头；全页扫描编码/语言指示控件。
- **期望**：状态栏显示编码、语言、大小、行列；代码文件额外显示高亮引擎与执行位置（spec L290）。
- **实际**：代码文件状态栏仅「高亮: … · 执行: … · 自动刷新不可用」，outerHTML 中编码/语言/大小/行列四个字段均为 Svelte 条件占位 `<!---->` 未渲染；图片/视频仅「自动刷新不可用」；GB18030/UTF-8/UTF-16LE 文件均无编码显示，而服务端 x-vv-encoding 正确下发 gb18030/utf-8/utf-16le（Range 206 响应同样携带）、x-vv-lang 正确下发 javascript/python；全页检索无任何编码/语言字样与控件，属性面板仅占位「文件元数据（M4 接入）」。
- **证据**：三域独立复核均复现：SHELL-12（五类文件状态栏逐字对比+outerHTML 占位符）；HL-06/HL-07（curl 头正确+页面 gb18030/utf-16 零命中、BOM 消费正确码点 12298）；SRV-05（x-vv-lang: javascript + Range 206 仍带头，页面无语言/编码展示）。截图 SHELL-12-1~5、HL06/07-verify、srv05 系列。
- **仲裁备注**：合并同根因四项（均为 spec L290 状态栏元数据未实现）。HL-07/SRV-05 复核原判 low、SHELL-12/HL-06 原判 medium；按整体缺失口径（四字段全缺、信息性缺失但检测正确）合并定 medium。半项「引擎与执行位置」已实现（README:21 承诺范围），SHELL-12 复核已排除个例（补测 edge/langs/app.js 相同）。

### BUG-05【medium · verified】设置面板整体缺失：排除规则、自动刷新（自动/手动）开关、手动刷新按钮均无任何 UI 入口，引擎正常但用户不可达

- **严重度**：medium｜**状态**：verified｜**涉及域**：app-shell-sources、server-file-service（合并：SHELL-09 + SHELL-13 + SRV-07）
- **复现步骤**：连接服务器后遍历全部按钮/文本/dialog/右键/快捷键/路由/localStorage 寻找设置入口与刷新按钮；console 写入排除规则后刷新验证排除引擎。
- **期望**：设置中可启用排除预设（.git/node_modules）、切换自动/手动刷新，且有始终可用的手动刷新按钮（spec L262/L229、决策 Q8b/Q9）。
- **实际**：全页面无任何设置/排除/刷新控件（全量 button 枚举无一相关、checkbox/switch 为 0、无 dialog/menu、tab 右键无菜单、#settings 与 GET /settings 均为 SPA fallback、Ctrl+comma 无弹层）；排除引擎与刷新持久化经 localStorage 探针验证正常工作（写入后树中 .git/node_modules 消失且跨刷新持久）；计算策略与代码主题两项可改可恢复；但向已打开文件追加内容后用户无任何 UI 手段刷新内容（2.5s 后页面不含新行）。
- **证据**：三会话独立复核：SHELL-09（写 `{"excludedPatterns":[".git","node_modules"]}` 后 excl-demo 仅剩 src/keep.txt 且二次刷新仍生效；并纠正报告键名——'vviewer:settings.excludedPatterns' 无效，须写单键对象 'vviewer:settings'）；SHELL-13（计算策略/代码主题经 UI 修改后 localStorage 与刷新恢复逐字吻合，另两项确无控件）；SRV-07（22 个 button 穷举、行为验证追加不生效；报告「无刷新文本」一处不准确——状态栏有「自动刷新不可用」字样但非按钮，反而佐证）。截图 SHELL-09/SHELL-13/SRV-07 系列。
- **仲裁备注**：合并 SHELL-09 + SHELL-13 + SRV-07 同根因（设置面板不存在，excludedPatterns/autoRefresh/刷新模式/手动刷新按钮共用缺失入口）。severity medium：设置数据模型与引擎工作正常，仅用户入口缺失；主流程可用、可 devtools 手写存储绕过。

### BUG-06【medium · verified】本地 tree-sitter wasm 主路径完全失效：全会话零 .wasm 请求、34 项 grammar 资产零消费，仅远程策略可得 tree-sitter，离线高亮承诺不成立

- **严重度**：medium｜**状态**：verified｜**涉及域**：code-highlight-degrade、pwa-mobile-performance（合并：HL-01 + HL-10 + PWA-03）
- **复现步骤**：gen:grammars 后 curl 验证 /grammars/manifest.json、rust.wasm、tree-sitter.wasm、queries 均 200；自动/本地策略打开 sample.rs 观察状态栏与 ts-*/hljs-* span 数；切「远程」策略对照；在线经树打开 9 种语言文件后查 `caches.keys()` 与 performance entries；断网后 fetch 各 grammar wasm 并离线打开本地 .py。
- **期望**：本地主路径按需 fetch grammar wasm 显示 tree-sitter 高亮；wasm 按 CacheFirst 写入 vv-grammars-* 运行时缓存，断网后仍可 tree-sitter 高亮。
- **实际**：自动与本地策略下 sample.rs 均降级「hljs 兜底 · 执行: 本地」（ts-* span=0、hljs-*=36，等待 6.5s 与硬刷新均复现）；全会话零 .wasm 网络请求、仅 manifest fetch；manifest 34 项 abi 字段全为 null（疑为本地引擎门控依据）；仅「远程」策略经 POST /api/compute/highlight 获得 tree-sitter（rs=98 个 ts-* span）；sw.js 声明的 vv-grammars-* 运行时缓存从未创建（打开 9 语言后 caches 仅 precache），断网后 8 个 grammar wasm fetch 全部 Failed to fetch，离线打开代码文件降级 hljs 兜底。
- **证据**：HL-01 复核独立复现（自动/本地/远程三策略 ts-* span 0/0/98，network --filter wasm 为空，与报告数值逐字一致）；HL-10 复现（自动策略 rs 失败与 HL-01 同根因、ts=87/sh=23 远程正常，两轮干净 pass 的 .wasm 请求均为 0，高亮全部由服务端 POST 完成）；PWA-03 复现（CDP 网络层仅 1 条 manifest.json、IndexedDB 无 grammar 存储、断网 8 条 fetch 全 FAILED、离线 upload hello.py/lib.rs 均为 hljs 兜底；并发现在线本地文件模式也不显示 tree-sitter、在线 tree-sitter 覆盖 4/9 比报告更差）。截图 HL01/PWA03 系列。
- **仲裁备注**：合并 HL-01 + HL-10 + PWA-03 同根因（前端运行时从不请求/消费 grammar wasm，故 sw CacheFirst 无从命中，gen:grammars 产物整链闲置）。theme-system 域 summary 亦独立观察到同一现象（sample.rs/hello.js 走 hljs 兜底、零 .wasm 请求），列为佐证。三项复核均 medium（远程策略/hljs 兜底可绕过、无崩溃无错误结果），合并 medium。HL-10 复核补充操作要点：重开已打开文件不触发重载，需换文件中转。

### BUG-07【medium · verified】无扩展名文件被「不支持的扩展名 .」直接拒绝预览，shebang 语言识别无从发生

- **严重度**：medium｜**状态**：verified｜**涉及域**：code-highlight-degrade、app-shell-sources（合并：HL-05 主体 + SHELL-03 的无扩展名表现观察）
- **复现步骤**：文件树点击无扩展名文件 shebang-py（首行 `#!/usr/bin/env python3`，190B，file(1) 识别为 Python script）；对照打开同内容 .py 副本；curl 对照 /api/file 响应头。
- **期望**：shebang 检测识别为 python 并按 python 语法高亮预览（对齐 helix Loader）。
- **实际**：直接渲染错误页「无法预览此文件 / 不支持的扩展名 "." / shebang-py」，无任何代码渲染，语言识别未发生即被扩展名派发拦截；同内容 shebang-py-verify.py 正常渲染（服务端对其返回 x-vv-lang: python，对无扩展名文件不返回该头），排除环境/读取问题。
- **证据**：复核会话 vv-verify-code-highlight-degrade-HL-05 独立复现两次一致（HL05-verify-shebang-py.png 等）；curl 对照证实服务端 /api/file 对无扩展名文件返回 200 完整正文但无 x-vv-lang。app-shell-sources 的 SHELL-03 复核亦证实同一根因表征：合成 drop 无扩展名 File('drag-folder') 与 File('Makefile') 表现完全一致（同一「不支持的扩展名 "."」提示），属无扩展名文件的通用表现。
- **仲裁备注**：合并 HL-05（缺陷主体）与 SHELL-03 的无扩展名表现观察。SHELL-03 的文件夹拖拽通道本身为 blocked（合成事件 webkitGetAsEntry 恒 null，真实 OS 拖拽未测，见未覆盖说明），其复核结论为『不构成已证实的文件夹拖拽缺陷』，仅无扩展名表现并入本条。复核将 HL-05 由 high 调整为 medium：一类文件预览完全不可用但可经加扩展名副本绕过，其余文件预览正常、无崩溃。

### BUG-08【medium · unconfirmed】服务器来源 tab 刷新后被误标为「会话中的本地文件需要重新打开」占位，重连服务器后也不重载

- **严重度**：medium（暂按标尺，若复核证实可下调）｜**状态**：**unconfirmed**（未独立复核，保留并标注不丢弃）｜**涉及域**：app-shell-sources（来源：SHELL-07 blocked 条目的附带发现）
- **复现步骤**：连接服务器打开 long-code.js，scrollTop=2500 后 F5 刷新；观察 tab 占位文案；重连服务器后点击该 tab。
- **期望**：服务器文件可重新拉取，刷新后应自动重读并保留滚动位置（spec L262 要求打开的 tab 自动重读并保留滚动位置）。
- **实际**：刷新后该 tab 变为占位卡片「无法预览此文件 / 会话中的本地文件需要重新打开（浏览器不保留文件内容）」，重连服务器后点击该 tab 仍是占位（.vv-code-pre 不存在），服务器文件未被重读，滚动位置无从还原。
- **证据**：来源为 SHELL-07 blocked 条目的附带发现（测试员明确标注为附带观察到的行为缺陷），有明确 evidence 但无独立复核会话验证。
- **仲裁备注**：未独立复核，保留并标注不丢弃。本地文件刷新占位行为本身符合期望（SHELL-08 复核确认 pass），缺陷仅在服务器来源文件被误标为本地文件。severity 暂按标尺 medium（功能不符但可绕过：在树中重新点开文件即恢复），若复核证实可下调。

### BUG-09【medium · verified】全局搜索点击命中行仅打开文件，不滚动定位、无任何命中行高亮（文件内搜索同能力正常，跳转未接入）

- **严重度**：medium｜**状态**：verified｜**涉及域**：compute-global-search（对应测试点：CMP-06）
- **复现步骤**：Ctrl+Shift+F 搜 inner 检查分组；搜 treasure 点击 tall-hit.txt 的 751:1 命中行；读视口首行、751 行是否在视口、.vv-code-line className 与背景色（立即抓取+等 2.5s、find click 与 JS click 变体）；按 / 文件内搜索对照。
- **期望**：结果按文件分组；点击后打开该文件并滚动到命中行高亮。
- **实际**：分组与打开均正常（`<mark>` 预览高亮、按文件分组）；但点击后视口停在 1-2 行、751 行不在视口、所有已渲染行 className 仅 vv-code-line、背景透明、.vv-search-hit-line 数量 0（各变体均复现）；对照文件内搜索 / 则定位到位且 751 行带 vv-search-hit-line（rgba(255,213,0,0.18)），证明滚动定位+高亮能力存在而全局跳转未接入；POST /api/search 已返回 line/col（按钮标签 751:1）但点击未使用。仓库样例 sample-gfm.md 自标「搜索命中行定位（P2）」。
- **证据**：复核会话 vv-verify-compute-global-search-CMP-06 独立复现：指出 .vv-viewer-scroll 为虚拟渲染容器（scrollHeight==clientHeight==473）scrollTop 恒 0 不构成独立证据，改以「视口显示哪些行」独立证实未定位，与报告观察一致；文件 801 行（报告写 800，微小出入）。截图 01~06。
- **仲裁备注**：CMP-06 单点，medium 与仓库自标 P2 一致（功能不符但可绕过：文件内搜索可定位、手动滚动可达）。与 BUG-18 不同根因：本条是全局跳转未接入已有能力，BUG-18 是文件内搜索自身无全部命中高亮。

### BUG-10【medium · verified】显式 remote 策略下 >2MB 文件仍被本地阈值压制为 hljs 分块，状态栏不显示远程执行，缓存加速可忽略

- **严重度**：medium｜**状态**：verified｜**涉及域**：compute-global-search（对应测试点：CMP-02）
- **复现步骤**：计算策略切「计算: 远程」，树中打开 code-3mb.js（3,378,599B）读状态栏（关标签重开复验）；curl POST /api/compute/highlight 同文件多次对比耗时与响应；对照 <2MB 文件的 remote 表现。
- **期望**：remote 策略下约 3MB 代码文件远程执行、状态栏显示远程，缓存 (path,mtime,size) 使二次打开更快。
- **实际**：状态栏恒为「高亮: hljs 分块 · 执行: 本地」（复核 2 次、报告 3 次一致），页面网络层无任何 POST /api/compute/highlight；<2MB 的 sample.js 同策略显示「tree-sitter · 执行: 远程」证明 remote 通道正常、差异确由大小阈值触发；服务端 curl 实测可高亮该文件（200、17,394,967B intervals，时延 1.29~1.43s），二次仅快约 7.6~8% 且顺序间有波动，响应体无缓存相关字段，17MB 传输即 intervals 本体。
- **证据**：复核会话 vv-verify-compute-global-search-CMP-02 独立复现（size_download 恒 17,394,967B 与报告逐字节一致）；截图 cmp02-3mb-remote-localbar.png 等。
- **仲裁备注**：CMP-02 单点，medium（本地 hljs 分块着色完整无损、服务端接口可用，可绕过，非崩溃/错误结果）。与 BUG-06 不同根因：本条是 >2MB 阈值压过显式策略，BUG-06 是本地 wasm 主路径零消费。

### BUG-11【medium · verified】纯前端搜索超 2000 文件上限只提示「结果不完整，已达上限」，无 spec 要求的「建议改用服务器模式」引导

- **严重度**：medium｜**状态**：verified｜**涉及域**：compute-global-search（对应测试点：CMP-11）
- **复现步骤**：纯前端页向本地文件夹写入 bulk2/ 共 2050 个文件（41 个含 bulkword）；Ctrl+Shift+F 搜 bulkword 轮询至终态；核对命中清单与全部提示文案。
- **期望**：提示超限（truncated）并建议改用服务器模式（spec L257）。
- **实际**：2000 文件扫描上限与截断提示正常生效（「40 个命中（结果不完整，已达上限）」恰止于第 2000 个文件、第 2001 个含关键词文件缺席），但全程无任何服务器/切换后端引导文案；另状态栏从「已扫描 2 个文件…」起即过早携带上次搜索遗留的「（结果不完整，已达上限）」。
- **证据**：复核会话独立重建纯前端环境（python3 -m http.server 提供 build 产物，全程零 /api/ 请求）复现，经 `window.__vvOpenDirImpl`（项目 e2e 调试钩子，与真实 input change 同路径）注入同一 2050 文件夹；截图 cmp11-verify-06-final-truncated.png。
- **仲裁备注**：CMP-11 单点，medium（设计规定的超限引导功能性缺失，但截断提示本身正常、可经 TopBar「连接服务器」手动绕过）。附带发现的状态栏遗留文案问题记入本条证据。200MB 上限路径报告与复核均未覆盖，见未覆盖说明。

### BUG-12【medium · verified】含加密条目的 zip 在打开阶段整包拒绝，无包内条目树与逐条加密标记，混合包中明文条目连带无法预览

- **严重度**：medium｜**状态**：verified｜**涉及域**：binary-hex-archive（对应测试点：BIN-08）
- **复现步骤**：构造 ZipCrypto 混合包（plain/open.txt 明文 + secret/locked.txt 加密，zipinfo -v 与 `unzip -t -P` 验证）；树中点击 encrypted-entries.zip；观察 tab 内容与包内树；curl 对照服务端响应。
- **期望**：展示包内条目树，加密条目有明确标记（锁形图标/标注），点击加密条目时报「加密不支持」，其余明文条目可正常预览（spec L206、M4 计划 L38）。
- **实际**：zip 打开阶段即整包拒绝：错误卡片「无法预览此文件 / Encrypted zip are not supported / encrypted-entries.zip」，条目树不渲染（plain/、secret/ 均不出现），明文条目 plain/open.txt 一并无法预览；curl /api/file 返回 200 application/zip，整包拒绝发生在前端解析阶段。
- **证据**：复核独立从零复现，并以两阶段构造出真正的混合包（zipinfo 证实 plain=not encrypted、secret=encrypted）后缺陷依旧整包拒绝；对照组无加密 nested-5-levels.zip 正常渲染条目树，排除环境解析问题；M4 计划文档 L38 设计为逐条标记+read 抛错，spec-deviations.md 无整包拒绝裁决记录。截图 BIN-08-verify-encrypted-card.png。
- **仲裁备注**：BIN-08 单点。报告称单条 `zip -P` 可造混合包有误（该命令会加密全部条目），复核改用两阶段构造后结论加强。severity medium：确不解密、错误语义清晰，可本地解压后单独预览明文条目绕过。

### BUG-13【medium · verified】zip 改名为 .txt 后无 magic 预检重定向，树点击与文件 URL 两入口均以 code 渲染器显示二进制乱码

- **严重度**：medium｜**状态**：verified｜**涉及域**：binary-hex-archive（对应测试点：BIN-10）
- **复现步骤**：`cp samples/m4/sample.zip zip-as-txt.txt`（file(1) 鉴定仍为 Zip archive data，md5 一致，头部 504b0304）；分别经树点击与 TopBar「文件 URL」入口打开；观察渲染器类型与网络请求。
- **期望**：magic 预检识别 ZIP 签名后重定向到压缩包渲染器并展示包内条目树；签名不符时只重定向一次。
- **实际**：两入口均未发生任何 magic 探测/重定向：树点击后以 code 渲染器带行号显示 zip 原始字节乱码（可见「PK\u0003\u0004」「hello.txthello vviewer」等明文片段），网络层仅 4 次 GET /api/file、无探测类请求；「只重定向一次」因重定向从未发生无从验证。
- **证据**：复核独立复现树点击入口与报告逐字吻合（BIN-10-tree-click-tab.png）；URL 入口症状与报告不同——复核打开的是名为「file」的标签报「不支持的扩展名 "."」（BIN-10-zip-as-txt.png），报告记为 code 乱码，属报告对第二入口的描述偏差，不影响缺陷核心；对照组正常命名 nested-5-levels.zip 正常进入压缩包渲染器；curl 显示服务端以 text/plain + x-vv-encoding: gb18030 返回 zip 字节。
- **仲裁备注**：BIN-10 单点，medium（可改回 .zip 绕过，压缩包渲染器本身正常，缺陷限于改名文件的 magic 预检缺失）。与 BUG-07 相关但不同根因：BUG-07 是无扩展名被拒，本条是有扩展名但内容不符时不做内容嗅探，note 互见。

### BUG-14【medium · verified】媒体类损坏文件无统一错误卡片（仅黑屏+瞬时 Reconnect 计数），文档类错误卡片亦无重试/降级按钮

- **严重度**：medium｜**状态**：verified｜**涉及域**：media-office-viewer（对应测试点：MEDIA-11）
- **复现步骤**：`head -c 3000` 截断真 mp4、`head -c 500` 截断 PDF 后分别从树打开；观察 main 区域错误呈现与卡片内按钮；打开损坏文件后切换正常文件 tab。
- **期望**：统一错误卡片给出明确信息并含重试/降级提示，不阻塞其他 tab。
- **实际**：截断 mp4：video error code=4（MEDIA_ELEMENT_ERROR: Format error）但无任何错误卡片，仅黑色播放器（00:00/00:00）+ 瞬时「Reconnect: N」计数数秒后消失，无明确文案、无重试/降级；截断 PDF：有统一错误卡片（「无法预览此文件 / Invalid PDF structure.」）但卡片内无任何按钮（interactive=[]）；不阻塞其他 tab 达成（正常 mp4 打开后正常播放、currentTime 推进）。
- **证据**：复核自建截断文件（file 确认源为真 MP4/PDF）独立复现：video `{errorCode:4}`、卡片 btns=[]、切回损坏 tab 仍黑屏+瞬时计数；curl 证实服务端对损坏内容照常 200 完整返回（accept-ranges bytes），错误纯在浏览器解码层与呈现层。截图 media11 系列 6 张。
- **仲裁备注**：MEDIA-11 单点，medium（正常文件播放可用、可关闭 tab 绕过）。Reconnect 计数值随时机不同（报告约 4s 后为 5，复核采样 2s 时为 2），核心行为一致。

### BUG-15【medium · verified】离线（断网）reload 落到 chrome-error 浏览器错误页，仅重新导航才能打开离线应用壳

- **严重度**：medium｜**状态**：verified｜**涉及域**：pwa-mobile-performance（对应测试点：PWA-02）
- **复现步骤**：在线打开 http://127.0.0.1:8391 等待 SW activated（navigator.serviceWorker.controller=true）；set offline on（eval 确认 onLine=false）；执行 reload；对照离线下重新导航（地址栏回车）。
- **期望**：断网后刷新页面，应用壳从 precache 提供，界面完整打开不白屏。
- **实际**：离线 reload 稳定失败（2/2 次）：URL 变为 `chrome-error://chromewebdata/`，body 仅 121 字符的 ERR_INTERNET_DISCONNECTED 错误页；离线下重新导航成功（location 保持 8391、body 3060 字符、完整控件、controller=true）；在线 reload 基线正常，排除环境问题。
- **证据**：复核会话 vv-verify-pwa-mobile-performance-PWA-02 从零走完 steps 含在线基线对照；截图 pwa02-offline-reload-chromeerror.png、pwa02-offline-shell-nav.png；curl 辅证 /sw.js 与 /manifest.webmanifest 均 200。
- **仲裁备注**：PWA-02 单点，medium（离线应用壳本身可用、单次重新导航即可完全恢复，「刷新不白屏」这一测试点未达成，属功能不符可绕过）。

### BUG-16【medium · verified】1MB .bin 的 hex 首屏 1.4~1.8s，超桌面预算（200ms）约 7~9 倍、移动预算（500ms）约 3 倍

- **严重度**：medium｜**状态**：verified｜**涉及域**：pwa-mobile-performance（对应测试点：PWA-08）
- **复现步骤**：先点参照文件重置 pane，再以 performance.now() 为起点点击树内 perf-1mb.bin（1,048,576B），MutationObserver 检测 hex 内容首现、双 rAF 后为绘制终点，桌面多轮+移动视口补测；对照 long-3mb.txt 文本首帧。
- **期望**：≤10MB 文件点击到首帧 <300ms（移动 <800ms）；1MB .bin hex 首屏 <200ms（移动 <500ms）。
- **实际**：文本 3MB 首帧中位 192~208ms 达标（冷态首轮偶超）；hex 首屏桌面 paintMs 1404~1781ms（复核 4 轮，与报告 1570/1781/1601ms 同量级），移动 1523~1738ms；即使取最宽松的 hex 头 DOM 首现口径（351~472ms）仍超桌面预算 1.8~2.4 倍，远超环境噪声。
- **证据**：复核独立复现数值与报告几乎重合（pwa08-desktop-hex-1mb.png、pwa08-mobile-hex-1mb.png 为 hex 视图实拍）；pane textContent 约 505 万字符的全量 hex 渲染，内容正确。
- **仲裁备注**：PWA-08 单点，medium（hex 最终渲染成功且内容正确、功能可用，属明显性能不达标而非功能损坏）。本地 upload 路径首帧未测，见未覆盖说明。

### BUG-17【medium · verified】markdown/HTML 渲染视图中外部 http 图片仍被浏览器实际发起 GET 请求（跟踪像素可回传访客 IP）

- **严重度**：medium｜**状态**：verified｜**涉及域**：markdown-html-docs（对应测试点：MD-11）
- **复现步骤**：打开含内联 script、外部图片（onerror）、javascript: 链接、外链 https 的 danger.html；eval 读 iframe.contentDocument 统计 script/on* 属性/hrefs/imgSrc；network requests 检索 external.example；清空日志重开二次验证。
- **期望**：脚本/事件属性/javascript: 净化，且外部资源（http 图片、外链脚本）不发起任何网络加载。
- **实际**：高危向量全部达标（script=0、on* 属性=0、javascript: href 被移除、正文无 alert 文本）；但 img src=http://external.example.com/track.png 保留在 DOM 且浏览器实际发起 GET (Image)，紧跟该页 /api/file 请求之后，清空日志后重开二次复现；对照 with-script.html 外链脚本无任何 cdn 请求。
- **证据**：复核会话 vv-verify-markdown-html-docs-MD-11 独立复现，统计结果与报告完全一致（md11-danger-dom.png）；external.example.com 为不可解析保留域名、DNS 失败无状态码，与报告记录形态一致，不影响「请求被浏览器实际发起」的结论。
- **仲裁备注**：MD-11 单点，medium（脚本执行/事件导航等高危向量已正确阻断，残余为图片类隐私外泄，净化策略对图片类资源未达声明标准，非崩溃/核心不可用/错误结果）。

### BUG-18【medium · verified】文件内搜索无全部命中高亮与词级高亮，仅当前命中行有行级淡黄背景

- **严重度**：medium｜**状态**：verified｜**涉及域**：in-file-search（对应测试点：FSEARCH-01）
- **复现步骤**：打开 sample.ts（`grep -o Point | wc -l` = 4）按 / 搜索；TreeWalker 检查 4 个命中文本节点父元素样式与全 DOM mark/搜索类元素；Enter×4、Shift+Enter、Esc 验证计数与导航。
- **期望**：全部 4 处命中可见高亮，n/N 计数正确，Enter 下一个/Shift+Enter 上一个/Esc 关闭。
- **实际**：计数（1/4 与 grep 精确吻合）与键盘导航循环全部正确、Esc 正常关闭；但 4 个 Point 文本节点父元素均为纯语法高亮 span（背景透明、无搜索类），全 DOM 无 mark/词级高亮元素，仅当前命中行有 vv-search-hit-line（rgba(255,213,0,0.18)）行级背景，其余 3 个命中行完全无高亮。
- **证据**：复核会话独立复现，行级类名与色值与报告分毫不差（01-search-point-1of4.png、04-nav-3of4.png）；一次中间查询 hit-line=0 的瞬态疑为防抖/虚拟滚动重渲染时序，重做干净流程后稳定复现，不影响结论。
- **仲裁备注**：FSEARCH-01 单点，medium（搜索唤起/计数/导航/当前行定位全部可用，可经 n/N 逐个跳转绕过，非错误结果）。

### BUG-19【low · verified】「打开文件夹」按钮点击后无任何用户可见反馈（headless/自动化环境下静默），回退通道是否存在两次复核结论相反

- **严重度**：low（由复核的 medium 按低估原则下调）｜**状态**：verified（含两条相互矛盾的复核证据）｜**涉及域**：app-shell-sources（对应测试点：SHELL-01）
- **复现步骤**：点击 TopBar「打开文件夹」；点击前后 eval 探针对比 file input 数/webkitdirectory/dialog/DOM 字节数/network requests；eval 直调 `window.showDirectoryPicker({mode:'read'})`。
- **期望**：弹出 FS Access 目录选择器（或回退/报错提示）。
- **实际**：SHELL-01 复核：点击后 3s 内六项指标全部零变化、无新网络请求、无 toast/error（medium 依据）；但 SHELL-08 复核以 createElement hook 得出相反结论：点击后捕获 input[type=file][webkitdirectory=true] 创建（500ms 后属性就位、未连接 DOM）、input.click() 被调用、cancel 事件 +1ms 触发——webkitdirectory 回退通道存在且可达，headless 下选择器立即取消属自动化环境特性，弱探针（只查 DOM 连接或创建瞬间属性）会误判为无反应。eval 直调返回 SecurityError（需用户手势）佐证函数存在。
- **证据**：两次独立复核证据并存：SHELL-01 会话（截图 vv-01~vv-04，DOM/network 零变化）与 SHELL-08 会话（hook 记录 input-click-invoked + cancel、三次点击桌面 2+Pixel 9 仿真 1 一致、无 JS 错误，截图 SHELL-08-folder-fallback-verified.png）。服务器树打开通道（「连接服务器」）经同场景验证全部正常（目录优先、a2 排 a10 前）。
- **仲裁备注**：SHELL-01 单点。两次复核对「回退通道是否存在」结论相反（SHELL-08 复核的 hook 证据更细：input 从未连接 DOM、属性系后置设置），且真实桌面 Chromium 的 FS Access 行为本次无法验证；按低估原则由复核的 medium 降为 low，缺陷焦点收窄为「点击后 cancel 无任何用户反馈」。真机端到端行为待补测（见未覆盖说明）；SHELL-08 原始报告的同主题误报另立 BUG-25（unconfirmed）。

### BUG-20【low · verified】>20MB 纯文本降级为虚拟滚动后无任何明确超限提示（spec L175 要求「纯文本虚拟滚动+提示」）

- **严重度**：low｜**状态**：verified｜**涉及域**：code-highlight-degrade（对应测试点：HL-04）
- **复现步骤**：打开 big-25mb.txt（26,214,435B）；在打开后 1.2s、2 分钟、切走再重开 1.3s 三个时点抓 body.innerText 检索超限类文案并清点 toast/banner/alert 类元素；滚到底读末行行号。
- **期望**：按纯文本虚拟滚动渲染并出现超限提示，滚动到底不卡死。
- **实际**：渲染/滚动/行号全部正常（scrollTop 一步到底 8,065,527px 无卡死、末内容行号 403,299 与字节数吻合），但三个时点全文均无「超限/上限/20MB/过大」类文案、浮层元素为 0，仅状态栏隐式显示「纯文本」；/api/tree 已返回 size=26214435（前端可得知超限但未提示）。
- **证据**：复核会话独立复现三时点检索零命中（HL04-verify-top.png、HL04-big25mb-bottom.png 目检行号与状态栏）；curl 辅证 /api/file Range 206 仅带 x-vv-encoding 无上限元数据。
- **仲裁备注**：HL-04 单点，low（纯信息性文案缺失，状态栏已隐式标明降级，无功能损失或误导性结果）。

### BUG-21【low · verified】全局搜索 glob 限定无任何 UI 入口（前缀语法均按字面量处理），仅 API 层支持

- **严重度**：low（复核原判 medium，仲裁下调）｜**状态**：verified｜**涉及域**：compute-global-search（对应测试点：CMP-07）
- **复现步骤**：Ctrl+Shift+F 面板枚举全部控件；先验证基线 20 命中、Aa 开关（20→7）与 .* 正则开关正常；尝试 'hello glob:*.txt'、'*.txt hello'、'hello|*.txt' 三种语法；curl POST /api/search 带/不带 glob 参数对照。
- **期望**：启用 glob 限定（如 *.txt）后结果随参数正确过滤。
- **实际**：大小写与正则开关均正常工作；但面板仅输入框+Aa+.*+关闭按钮，全页 51 个控件扫描无任何 glob/筛选入口，三种语法均「无结果」（按字面量处理）；而 API 层 glob 真实有效（带 glob 仅返回 case-test.txt 两行小写命中，去掉 glob 返回 7 行跨 .ex/.js/.txt/.md）。
- **证据**：复核会话 vv-verify-compute-global-search-CMP-07 独立复现全部数值；文档核对：设计规格将 glob 定位为 /api/search 的 API 参数，UI 仅承诺面板打开+分组+跳转，未承诺 glob 控件。截图 01~06。
- **仲裁备注**：CMP-07 单点。复核原判 medium；因规格未对 UI 承诺 glob 入口（actual 与现行设计吻合，测试期望超前于规格），按标尺与低估原则仲裁调整为 low（体验缺失，可经 API 绕过，无错误结果）。

### BUG-22【low · verified】auto 策略执行位置指示不符期望路由：md 文档级渲染显示「渲染: 远程」、html 渲染/源码视图无执行位置段

- **严重度**：low（报告 suggested low、复核升 medium，仲裁低估取 low）｜**状态**：verified｜**涉及域**：compute-global-search（对应测试点：CMP-03）
- **复现步骤**：auto 策略打开 rust-fence.md 读状态栏并 eval 检查 pre code.className；打开 with-script.html 切「源码」视图读状态栏；遍历 edge/langs 13 种语言记录路由矩阵。
- **期望**：auto 下 html 与含围栏 md 留在本地执行（带 injection 的语言留本地保二级高亮）。
- **实际**：rust-fence.md 状态栏「渲染: 远程」（围栏仍由本地 hljs 着色：language-rust hljs + 8 span，二级高亮保留）；with-script.html 渲染/源码视图状态栏均无高亮/执行段（源码完整着色不白屏）；13 语言路由矩阵稳定（py/ts/yaml/toml/sh→tree-sitter·远程，rs/go/c/cpp/java/js/vue/sql→hljs 兜底·本地）。
- **证据**：复核会话 vv-verify-compute-global-search-CMP-03 独立复现逐字一致（cmp03-01~05）；查看功能完全无损，可手动切「计算: 本地」绕过。
- **仲裁备注**：CMP-03 单点。按标尺（纯状态栏指示文案与期望路由不符、渲染与着色功能无损、无错误结果）仲裁低估取 low。

### BUG-23【low · verified】文件内搜索面板无大小写敏感开关，搜索固定大小写不敏感

- **严重度**：low｜**状态**：verified｜**涉及域**：in-file-search（对应测试点：FSEARCH-03）
- **复现步骤**：/ 唤起面板 snapshot 枚举全部控件；在 case-test.txt（AlphaCase×2/alphacase×2/ALPHACASE×1/AlPhAcAsE×1）上以四种大小写形式查询对比计数；3MB 文件上全大写/全小写对照；阴性对照验证搜索本身工作。
- **期望**：存在大小写敏感开关，开/关时命中数变化。
- **实际**：面板仅 input+计数+3 按钮，无任何开关控件；四种查询均返回 1/6（若区分应为 2/2/1/1），3MB 样例上 zzneedleqz/ZZNEEDLEQZ/ZzNeedleQz 均 1/10；阴性对照 nonexistentzz 无结果，证明搜索工作但固定不敏感。
- **证据**：复核会话 vv-verify-in-file-search-FSEARCH-03 独立复现（rg 与 curl 确认基准 6 处）；文档核对：README:30 未承诺文件内搜索有大小写开关，设计规格 L256 的大小写开关针对全局搜索（全局面板实有 Aa 开关且工作正常）。截图 5 张。
- **仲裁备注**：FSEARCH-03 单点，low（结果为不误导的超集、核心搜索可用，文档未对该功能承诺开关，属体验/细节级缺失）。与 BUG-21 不同面板不同缺陷（全局搜索有大小写开关而缺 glob，文件内搜索反之）。

### BUG-24【low · verified】断网时展开未加载的树目录静默失败，无任何错误提示（对照：文件打开失败有明确提示）

- **严重度**：low｜**状态**：verified｜**涉及域**：pwa-mobile-performance（对应测试点：PWA-04）
- **复现步骤**：在线连接展开树确认在线展开正常；set offline on；点击子节点未加载的折叠目录（samples/m5/edge 交叉验证）；检查 aria-expanded、子节点数与 toast/alert；恢复在线重载后按报告精确场景重做。
- **期望**：/api/* 一律走网络不读缓存（成立）；断网操作失败处给出明确错误提示。
- **实际**：/api/* 不缓存成立（fetch 失败、caches 无任何 /api 条目）；文件打开失败提示明确（「无法预览此文件 / Failed to fetch」）；但断网点击折叠目录 aria-expanded 保持 false、子节点 0，无任何 toast/alert/dialog（3s 与 9s 采样一致，三个目录交叉验证）。
- **证据**：复核会话 vv-verify-pwa-mobile-performance-PWA-04 独立复现含对照组：先前已在线加载子节点的目录断网时折叠/展开为纯客户端切换可正常 toggle，静默失败仅发生在需请求 /api 的目录，与报告场景一致（pwa04-verify-offline-dir-expand-silent.png）。
- **仲裁备注**：PWA-04 单点，low（断网下目录展开本不可能成功，缺陷仅为失败处缺少提示，对比文件打开有提示，属体验细节）。报告引用的 query.sql 不存在系样例缺失，复核已自建辅助文件验证。

### BUG-25【low · unconfirmed · 复核判误报】报告称非 FS Access 下「打开文件夹」的 webkitdirectory 回退通道不存在

- **严重度**：low｜**状态**：**unconfirmed**（复核未能复现报告缺陷并判定为误报；按规则保留标注不丢弃）｜**涉及域**：app-shell-sources（对应测试点：SHELL-08 原始报告）
- **复现步骤**：移除/模拟缺失 showDirectoryPicker 模拟非 FS Access 浏览器；点「打开文件夹」；createElement 探针检查是否创建 webkitdirectory input；另测本地文件刷新占位。
- **期望**：回退创建 webkitdirectory input 并弹出目录选择；本地文件刷新后占位提示重开。
- **实际**：报告称无任何 input 创建、按钮无反应、无错误提示。复核（confirmed=false）推翻：hook createElement 后点击捕获 input[type=file][webkitdirectory=true] 创建（500ms 后属性就位、connected:false 未连 DOM）、input.click() 被调用、cancel 事件 +1ms 触发——回退通道存在且可达，真实非 FS Access 浏览器中用户会看到目录选择对话框，headless 立即 cancel 属自动化特性；报告探针疑因只查 DOM 连接状态或只读创建瞬间属性（属性系后置设置）而误判。占位部分复核确认 pass（文案与 spec 一致、无崩溃）。
- **证据**：复核 3 次点击（桌面 2 + Pixel 9 仿真 1）均捕获完整事件链且无 JS 错误；截图 SHELL-08-folder-fallback-verified.png、SHELL-08-placeholder-after-reload-verify.png。
- **仲裁备注**：复核未能复现报告缺陷并判定为误报；按规则保留标注不丢弃。与 BUG-19（SHELL-01）同一按钮且两次复核矛盾，详见 BUG-19 note；真实非 FS Access 浏览器（iOS Safari/Firefox 等）端到端仍未验证。

### BUG-26【low · unconfirmed · 复核不可复现】报告称移动端触摸滑动 touchend 后无惯性续滚

- **严重度**：low｜**状态**：**unconfirmed**（复核未能复现、判定不成立；保留标注）｜**涉及域**：pwa-mobile-performance（对应测试点：PWA-06）
- **复现步骤**：375×667 移动视口（iPhone UA）经文件树打开 long-3mb.txt；CDP `Input.dispatchTouchEvent` 慢滑 300px 与快滑 480px（12 步×40px/8ms）；touchend 后多次采样 scrollTop。
- **期望**：触摸滑动驱动虚拟滚动、scrollTop 1:1 变化，且 touchend 后含惯性续滚。
- **实际**：报告称 1:1 跟手成立但 touchend 后 8×200ms 采样恒定无惯性（并自注可能为合成输入限制）。复核（confirmed=false）：跟手与虚拟渲染数字一致复现（30000→30285、行号 20px/行），但同参数快滑 5 次中后 4 次出现典型衰减曲线惯性（~400ms 内续滚 ~250-280px：613→718→737 等），「无惯性」仅为 1/5 偶发，疑为报告会话首滑手势/合成器时序；另报告未提 dispatchTouchEvent 需先经 `Emulation.setTouchEmulationEnabled` 开启触摸模拟。
- **证据**：复核自写 CDP 脚本直连 ws 采集（`/tmp/vv-verify-pwa06/touch-scroll.mjs`；pwa06-after-fling-verify.png）；慢滑无惯性属低于 fling 速度阈值的正常表现。
- **仲裁备注**：复核未能复现「无惯性」缺陷、判定不成立；保留标注。即使按报告视角亦仅为体验类且报告自注无法完全归因产品，维持 low。真机触摸行为未测，见未覆盖说明。

---

## 6. 交叉验证：仓库自带 Playwright 套件结果与解读

**结果**：`apps/web/e2e` 套件运行退出码 **0**，耗时 35.8s；**72 项测试：64 passed、1 flaky、7 skipped**。

**flaky 项**：`[mobile] › e2e/m3-search.spec.ts:107` 「关闭后重开：搜索面板 closed 标志复位，重新搜索计数恢复（终审-M6）」，失败于 `m3-search.spec.ts:124:50` 的 `.vv-search-input` toBeFocused 断言。套件注记明确：**该计时型 flaky 预先存在，失败时需区分，勿直接归为新缺陷**。与黑盒结论不矛盾：黑盒实测文件内搜索面板可唤起、计数与键盘导航全部精确工作（FSEARCH 系列，5 pass），该 flaky 属焦点时序问题而非功能缺失。

**skipped 7 项**：退出摘要仅给出计数，具体项未在所提供的输出尾中列出，无法在此逐一指认。

**通过项覆盖（依输出尾可见的测试名）**：m3（markdown 渲染与搜索）、m4（tar/libarchive 树渲染与条目可读、office docx/xlsx/pptx、ArtPlayer mp4 就绪）、m5（token 错误连接被拒提示、连接→目录树→sample.js 高亮→修改文件 SSE 自动刷新）、m6（--compute health capabilities、policy=remote 高亮/markdown 走服务端并显示执行位置「远程」、≈1.5MB 大文件同为远程、Ctrl+Shift+F 全局搜索 inner 命中 sub/inner.txt 并打开、comrak GFM 直连断言、policy=local 回退显示「本地」）、m7（SW 注册与 workbox precache、hljs 近似映射真实级联）、mobile（抽屉开合、文件夹打开→树→md 渲染、触摸滑动 markdown 正文 scrollTop 前移、主题三态循环写 data-theme-mode、视频播放页不崩、ℹ 右栏 TOC/属性抽屉开合）。

**WebServer 日志观察**：测试期间反复出现 `GET /queries/typescript/injections.scm`、`/queries/_typescript/injections.scm`、`/queries/prolog/injections.scm` 404——前端对带 injection 语言的 queries 资产探测落空（与偏差 #5「服务端高亮无 injection」的背景一致）。仅记录现象，输入材料未给出进一步定性。

**解读**：仓库自带套件的主链路结论（SSE 自动刷新、remote 高亮/渲染与执行位置指示、全局搜索打开命中文件、office/ArtPlayer 渲染、SW precache、移动抽屉/触摸/主题）与本次黑盒各域 pass 结论互相印证；同时该套件未覆盖本次黑盒发现的主要缺陷面（HLS blob 分片、btrfs watcher、状态栏元数据缺失、设置面板缺失、本地 wasm 主路径失效、离线 reload 等），两套验证互补而非冗余。m3-search 的 flaky 再次印证了测试点口径需与已知问题区分的要求。

---

## 7. 未覆盖范围与后续建议

### 7.1 未覆盖范围（10 项，依仲裁记录）

1. **FS Access 真实链路**（SHELL-07，唯一 blocked）：真实桌面 Chromium 的原生目录选择器与刷新后 requestPermission 权限弹窗无法在 headless 驱动，「打开本地文件夹→刷新恢复文件树/双 tab/滚动位置」整条未覆盖；已验证的仅是 IndexedDB tab 快照恢复。
2. **「打开文件夹」在真实浏览器中的端到端行为**：两次独立复核对 webkitdirectory 回退是否存在结论相反（BUG-19 vs BUG-25），且真实桌面 Chromium 的 FS Access 行为完全未测，必须真机补测定论。
3. **真实 OS 文件夹拖拽**（webkitGetAsEntry 通道，SHELL-03）：合成事件下 entry 恒为 null，headless 无法构造真实拖拽，该通道行为未覆盖。
4. **btrfs watcher 故障（BUG-02）根因与影响面**：仅在 8391 主实例（btrfs /dev/sda3）复现、tmpfs 正常；ext4/xfs/NFS、macOS/Windows 文件通知机制、watcher 故障后的重试/自愈/重启恢复均未测。
5. **symlink 逃逸的内容层防护**：escape-etc（-> /etc）在 /api/tree 呈现为 dir、逃逸防护断言应放在内容/fetch 类接口上，但无任何域对 `/api/file?path=…/escape-etc/…` 的越权读取做过断言（仅覆盖了常规路径穿越）。
6. **纯前端搜索 200MB 累计上限路径**：CMP-11 报告与复核均只覆盖 2000 文件上限，200MB 分支未测。
7. **本地 upload 路径的首帧/性能**（PWA-08 注明仅测服务器 /api/file 路径）；PWA-08 文本冷态首轮 437ms 偶超 300ms 的冷启动表现仅单次采样。
8. **远程 tree-sitter 覆盖矩阵**仅抽样少数语言（py/ts/sh/rs/yaml/toml 等，34 项资产的其余未逐一验证）；HL-10 中 rust 在自动策略下服务端高亮失败的具体原因（无任何 highlight POST）未定位；manifest 34 项 abi 全 null 与本地门控的因果关系仅停留在相关性记录。
9. **移动端真机**：本次全部为桌面 headless + 设备仿真（仿真不启用 maxTouch，触摸靠 CDP Input.dispatchTouchEvent 替代），真实触摸/惯性/移动 UA wheel 表现未在真机验证；hex 性能数字亦含 headless 容器噪声。
10. **SSE 长时稳定性**：15s 心跳与断线重连仅在短窗口验证，长时间运行、大量文件变更风暴下的推送及时性与内存表现未测。

### 7.2 后续建议（均对应上列未覆盖项或已证实缺陷）

1. **优先修复 BUG-01**（唯一 high）：HLS 分片 URL 解析错误导致声明格式完全不可用且静默。
2. **定位本地 grammar wasm 门控失效根因**（BUG-06 + 未覆盖项 8）：manifest 34 项 abi 全 null 与本地引擎零请求的因果关系需读源码定位；同时补齐远程 tree-sitter 全语言矩阵验证。
3. **排查 btrfs watcher 故障**（BUG-02 + 未覆盖项 4）：先在 ext4/xfs 复测圈定文件系统相关性，再定位 inotify/watcher 初始化与自愈逻辑。
4. **真机补测**（未覆盖项 1/2/3/9）：FS Access 全链路、「打开文件夹」回退之争（BUG-19/25）、真实文件夹拖拽、移动端触摸/惯性，一次性定论。
5. **补 symlink 内容层越权读取断言**（未覆盖项 5）：对 `/api/file` 经 escape-etc 的读取路径补 403 断言。
6. **补测试分支**（未覆盖项 6/7/10）：纯前端 200MB 上限、本地 upload 首帧性能、SSE 长时稳定性。
7. **兑现 spec 声明的 UI 面**（BUG-03/04/05）：键盘快捷键、状态栏元数据四字段、设置面板（排除规则/刷新模式/手动刷新按钮）——三者均为「引擎已在、入口缺失」或「spec 明确承诺」项，修复收益明确。

---

## 8. 附录：逐测试点明细表

> 结果口径：pass / partial / fail / blocked。截图默认位于 `.temp/e2e-artifacts/<域名>/`（复核截图在 `.temp/e2e-artifacts/verify/`），下表仅列文件名；无截图者给出一行关键实测摘要。

### 8.1 app-shell-sources（13 点：5 pass / 5 partial / 2 fail / 1 blocked）

| 编号 | 测试点 | 结果 | 证据摘要 |
| --- | --- | --- | --- |
| SHELL-01 | 打开文件夹出现文件树，目录优先、自然排序（a2<a10） | partial | sort-demo 树序 sub→a2→a10→b ✓（经服务器树验证）；「打开文件夹」点击无反应（BUG-19）→ SHELL-01-tree.png |
| SHELL-02 | 点击树中文件新建激活 tab，再点其他文件追加 tab | pass | tab 新建/追加/激活态与渲染均正确 → SHELL-02-hello-tab.png |
| SHELL-03 | 拖入单文件开 tab、拖入文件夹建树 | partial | 单文件 drop 开 tab 渲染 ✓；文件夹 entry 通道环境受限（BUG-07 并入无扩展名表现）→ SHELL-03-folder-drop.png |
| SHELL-04 | URL 框打开：成功渲染、404 与 CORS 失败均给出原因 | pass | 成功/404/CORS 三场景均有明确提示 → SHELL-04-url-error.png |
| SHELL-05 | .xyz 未知类型显示错误卡片（文件名+扩展名） | pass | 「不支持的扩展名 ".xyz" / unknown.xyz」 → SHELL-05-unknown-xyz.png |
| SHELL-06 | 3 个 tab 切换内容跟随，逐个关闭后显示空态 | pass | 切换/逐个关闭 remaining 递减/空态文案正确 → SHELL-06-empty-state.png |
| SHELL-07 | FS Access 打开后刷新恢复文件树/双 tab/滚动位置 | blocked | 原生对话框无法驱动；IndexedDB tab 恢复 ✓；附带发现 BUG-08 → SHELL-08-placeholder-after-reload.png |
| SHELL-08 | webkitdirectory 打开后刷新显示重开占位 | partial | 本地文件刷新占位 ✓；回退通道两次复核结论相反（BUG-19/25）→ SHELL-08-placeholder-after-reload.png、SHELL-08-folder-fallback-verified.png |
| SHELL-09 | 默认显示 .git/node_modules，启用排除后消失且刷新持久 | partial | 默认树 ✓、排除引擎+持久化 ✓（localStorage 探针）；设置 UI 不存在（BUG-05）→ SHELL-09-default-tree.png、SHELL-09-excluded.png |
| SHELL-10 | 601-900px 树收抽屉、≤600px 右栏也收独立抽屉 | pass | 800px/550px 双断点抽屉行为符合 → SHELL-10-800px-firstload.png、SHELL-10-550px-drawers.png |
| SHELL-11 | j/k 逐行滚动、gg/G 跳顶底、Ctrl+P 快速打开 | fail | trusted 按键到达但零响应，/ 对照正常（BUG-03）→ 复核截图 verify/SHELL-11-01~09.png |
| SHELL-12 | 状态栏显示编码/语言/大小/行列，代码文件加引擎与执行位置 | fail | 五类文件状态栏均无编码/语言/大小/行列（BUG-04）；引擎与执行位置两项已实现 |
| SHELL-13 | 设置修改后从 localStorage 完整恢复 | partial | 计算策略/代码主题修改→恢复 ✓；排除/自动刷新无 UI（BUG-05）→ 复核截图 SHELL-13 系列 |

### 8.2 code-highlight-degrade（11 点：5 pass / 4 partial / 2 fail）

| 编号 | 测试点 | 结果 | 证据摘要 |
| --- | --- | --- | --- |
| HL-01 | tree-sitter 主路径（sample.rs） | fail | 自动/本地均 hljs 兜底、零 .wasm 请求、manifest abi 全 null；远程 98 个 ts-* span（BUG-06）→ HL01-sample-rs.png 等 |
| HL-02 | hljs 兜底（sample.pl） | pass | 19 hljs-keyword/共 50 hljs-* span、无错误卡片 → HL02-sample-pl.png |
| HL-03 | hljs 分块 3MB + 虚拟滚动正确性 | pass | 50%/75%/100% 三处零错位；minified-3mb 362,525 span 保持响应 → HL03-repeat3mb-bottom.png、HL03-minified3mb.png |
| HL-04 | >20MB 超限 | partial | 25MB 纯文本滚到底 800ms、末行 403,299 正确；无超限文案（BUG-20）→ HL04-big25mb-bottom.png |
| HL-05 | shebang 语言识别 | fail | 无扩展名被「不支持的扩展名 "."」拒绝（BUG-07）→ HL05-shebang-py.png |
| HL-06 | GB18030/UTF-8 编码 | partial | 中文渲染正常、X-VV-Encoding 正确；状态栏无编码（BUG-04）→ HL06-gb18030.png、HL06-utf8.png |
| HL-07 | UTF-16LE BOM | partial | BOM 消费正确（首字符码点 12298）；状态栏无编码（BUG-04）→ HL07-utf16le.png |
| HL-08 | 3MB 滚动到底再回顶 | pass | 末行 54237 与 wc -l 一致；四次折返无白屏 → HL08-long3mb-top.png |
| HL-09 | 2MB 解析中切 tab | pass | 切换无报错、新文件正常渲染、无残留错误卡片 → HL09-big2mb-after-switch.png |
| HL-10 | rust/ts/bash 三语言 tree-sitter | partial | 远程三语言全过（rs98/ts87/sh23）；自动 rust 失败；零 wasm 请求（BUG-06）→ HL10-deploy-sh-auto.png、HL10-rs-remote.png |
| HL-11 | 解析期间 UI 响应性 | pass | 解析期交互 1ms、rAF 实测 53fps 不冻结 |

### 8.3 theme-system（7 点：7 pass）

| 编号 | 测试点 | 结果 | 证据摘要 |
| --- | --- | --- | --- |
| THEME-01 | 主题按钮循环跟随系统→亮→暗，刷新后保持 | pass | 三态循环+localStorage themeMode 记忆 → THEME01-dark-shell.png |
| THEME-02 | 跟随系统模式下系统切暗色，整壳变暗 | pass | prefers-color-scheme 双向仿真验证 → THEME02-system-dark.png、THEME02-system-light.png |
| THEME-03 | sample.rs 切换 helix 代码主题零重解析 | pass | 214 主题即时切换、36 span 类名哈希不变、scrollTop=100000 保持 → THEME03-longrs-mocha-scrolled.png |
| THEME-04 | 亮/暗模式各自记忆代码主题 | pass | codeThemeLight/Dark 双记忆、来回切换互不串扰 → THEME04-dark-gruvbox.png |
| THEME-05 | markdown rust 围栏随主题与独立文件同步 | pass | 围栏与独立文件同主题同色 → THEME05-md-fence-github-light.png |
| THEME-06 | >2MB hljs 分块路径 9 个 --hljs-* 变量跟随 | pass | tokyonight 色板全量更新、36 万 span 计算色同步 → THEME06-3mb-tokyonight.png |
| THEME-07 | DevTools 证据：仅 style#vv-code-theme 内容变化 | pass | DOM 结构签名/类名哈希不变，style 落 DOM 0.8ms → THEME07-3mb-github-dark.png |

### 8.4 markdown-html-docs（13 点：12 pass / 1 partial）

| 编号 | 测试点 | 结果 | 证据摘要 |
| --- | --- | --- | --- |
| MD-01 | demo.md GFM 表格/任务列表/删除线 | pass | 表格×1、checkbox×2 disabled、del 渲染 → md01-demo.png、md01-strikethrough.png |
| MD-02 | callout 卡片 ≥6 类型 + 默认 | pass | 5 类型+caution 各异色边+未知类型灰色兜底 → md02-callouts.png |
| MD-03 | KaTeX 行内/块级 + 非法公式容错 | pass | .katex×2 渲染；非法公式原文保留不崩 → md03-math.png、md03-math-invalid.png |
| MD-04 | mermaid 正常块 svg / 非法块容错且管线不受阻 | pass | svg.flowchart 渲染；非法块错误样式、复制按钮不受阻 → md04-mermaid-ok.png、md04-mermaid-bad.png |
| MD-05 | rust 围栏代码块高亮降级链 | pass | language-rust hljs + 8 span（tree-sitter 未生效归 BUG-06）→ md05-rust.png |
| MD-06 | YAML front matter 剥离 / 非法容错 | pass | 元数据不出现于正文；非法时原文渲染不崩 → md06-front-matter.png、md06-front-matter-invalid.png |
| MD-07 | TOC 项数一致/点击滚动/滚动高亮跟随 | pass | TOC×9 对应 h1-h4；点击 scrollTop 0→1623；active 随滚动 → md07-toc-active.png |
| MD-08 | 代码块复制按钮写入剪贴板 | pass | hook writeText 捕获 98 字符与代码块 textContent 去尾换行一致 |
| MD-09 | 图片灯箱打开/Esc/遮罩关闭 | pass | overlay 开/关三路径全通过 → md09-lightbox-open.png |
| MD-10 | page.html 沙箱 iframe：脚本不执行、无 allow-scripts | pass | sandbox=allow-same-origin（偏差 #1）、script=0、行内样式保留 → md10-page-html.png |
| MD-11 | 危险 HTML 净化：外部图片仍发起网络请求 | partial | script/on*/javascript: 净化 ✓；外部图片 GET 实际发起（BUG-17）→ md11-danger-dom.png |
| MD-12 | HTML 渲染/源码视图切换与源码搜索 | pass | 源码 / 搜索 1/7→2/7 行高亮；渲染视图恒无结果（low 瑕疵已记录）→ md12-source-search.png |
| MD-13 | 媒体链接增强：.mp4/.mp3 渲染为内联占位 | pass | video/audio controls 内联、原链接不再以 a 存在 → md13-media.png |

### 8.5 in-file-search（7 点：5 pass / 1 partial / 1 fail）

| 编号 | 测试点 | 结果 | 证据摘要 |
| --- | --- | --- | --- |
| FSEARCH-01 | sample.ts 搜索：唤起/计数/导航/Esc/全部命中高亮 | partial | 计数 1/4 与 grep 吻合、Enter/Shift+Enter/Esc ✓；仅当前行行级高亮（BUG-18）→ 01-search-point-1of4.png、01b-only-current-line-highlight.png、01-after-esc.png |
| FSEARCH-02 | 3MB 文本稀疏 10 命中：分块搜索兼容虚拟滚动 | pass | 计数 1/10；Enter 步进 ≈70700px 与样例间距逐一吻合 → 02-3mb-open.png、02-hit-10of10.png |
| FSEARCH-03 | 大小写敏感开/关切换 | fail | 无开关控件、固定不敏感（BUG-23）→ 03-case-insensitive.png |
| FSEARCH-04 | markdown 渲染视图搜索：mark 高亮/滚动/退出还原 | pass | 6 个 mark、active 转移、Esc 后还原无损 → 04-md-mark-active.png |
| FSEARCH-05 | HTML 源码视图搜索标签名 | pass | 计数 1/3 与 grep -c 吻合、跳转正常 → 05-html-source-search.png |
| FSEARCH-06 | PDF 内搜索命中计数与页跳转 | pass | 计数与 pdftotext 吻合；3 页 PDF 跨页跳转到位 → 06-pdf-1of1.png、06b-multipage-gamma.png |
| FSEARCH-07 | 无命中不报错与清空恢复 | pass | 「无结果」+Enter 无异常；清空恢复、Esc 关闭 → 07-no-hit.png、07-after-clear.png |

### 8.6 media-office-viewer（11 点：9 pass / 2 partial，域统计口径 1 fail + 1 partial）

| 编号 | 测试点 | 结果 | 证据摘要 |
| --- | --- | --- | --- |
| MEDIA-01 | 图片滚轮缩放与双击复位 | pass | 1.1x 倍进、上限 10/下限 0.1、dblclick 复位 1 → media01-zoom-test-zoomed.png |
| MEDIA-02 | SVG 消毒 | pass | script 整段移除、onload 剥除、探针变量均 false → media02-svg-sanitized.png |
| MEDIA-03 | mp4 ArtPlayer 播放 | pass | readyState=4、135ms 出 video、播放推进 → media03-mp4-artplayer.png |
| MEDIA-04 | m3u8/flv/ts 按需加载与错误处理 | partial | flv ✓；m3u8 分片 blob: 死循环静默、ts 乱码（BUG-01，域统计计 fail）→ media04-flv-playing.png、media04-m3u8-stuck.png、media04-ts-as-typescript.png |
| MEDIA-05 | mp3/wav 原生音频控件 | pass | readyState=4、播放推进、暂停生效 → media05-mp3-audio.png |
| MEDIA-06 | EXIF Orientation 方向显示 | pass | Orientation=6 按 90° CW 应用（natural 200x400）→ media06-exif-rot90.png |
| MEDIA-07 | PDF 翻页缩放与懒渲染 | pass | 6 页、200%、canvas 懒渲染+回收、页码随动 → media07-pdf-multipage-success.png（URL 表单相对路径问题另记 low 观察） |
| MEDIA-08 | docx 正文 HTML 呈现 | pass | 4 个 p 与源 document.xml 4 个 w:t 一一对应 |
| MEDIA-09 | xlsx 多 sheet 页签与超 200 行截断 | pass | 2 sheet 切换正常；250 行仅显示前 200 行+提示 → media09-xlsx-sheet2.png、media09-xlsx-large-truncated.png |
| MEDIA-10 | pptx 文本提纲卡片 | pass | 2 张 slide 卡片、页码齐全、文本与源一致 → media10-pptx-outline-cards.png |
| MEDIA-11 | 损坏/截断媒体错误呈现 | partial | mp4 黑屏+瞬时 Reconnect、PDF 卡片无按钮；不阻塞其他 tab（BUG-14）→ media11-broken-mp4.png、media11-broken-mp4-reconnect.png |

### 8.7 binary-hex-archive（10 点：8 pass / 1 partial / 1 fail）

| 编号 | 测试点 | 结果 | 证据摘要 |
| --- | --- | --- | --- |
| BIN-01 | sample.bin 经典三列 hex dump | pass | 首行 PNG 签名 hex、末偏移与 4129 字节吻合 → BIN-01-hexdump.png |
| BIN-02 | >1MB .bin 默认 1MB + 加载更多翻页 | pass | 1→2→3MB 精确翻页、末偏移 0x2ffff0、按钮消失 → BIN-02-load-more-3mb.png |
| BIN-03 | PNG 改名 .bin 后结构树识别 magic | pass | IHDR width=32/height=8 与 python struct 解析一致 → BIN-03-png-struct-tree-visible.png |
| BIN-04 | ELF 结构树字段且不白屏 | pass | magic/class/endian/type/machine/entry 与 readelf -h 全吻合 → BIN-04-elf-struct-tree.png |
| BIN-05 | sample.zip 包内条目树层级 | pass | 条目与 unzip -l 逐项一致 → BIN-05-zip-entry-tree.png |
| BIN-06 | zip 包内条目递归 code 预览 | pass | hello.txt/inner.txt 均开独立 code tab、内容正确 → BIN-06-inner-txt-code.png |
| BIN-07 | 嵌套 zip 第 4 层被拒（深度限 3） | pass | 3 层可进、第 4 层报「嵌套层数超限：递归预览最多 3 层」 → BIN-07-depth-limit.png、BIN-07-l3-opened.png |
| BIN-08 | 含加密条目的 zip | partial | 整包拒绝「Encrypted zip are not supported」、无条目树、明文连带不可预览（BUG-12）→ BIN-08-encrypted-tree.png |
| BIN-09 | sample.tar 条目树与包内文本预览 | pass | 条目与 tar -tvf 一致、hello.txt code 渲染（libarchive 路径，偏差 #7）→ BIN-09-tar-preview.png |
| BIN-10 | 改名 .txt 的 zip magic 预检重定向 | fail | 两入口均无重定向、code 渲染二进制乱码（BUG-13）→ BIN-10-zip-as-txt.png |

### 8.8 server-file-service（13 点：10 pass / 2 partial / 1 fail）

| 编号 | 测试点 | 结果 | 证据摘要 |
| --- | --- | --- | --- |
| SRV-01 | release 单二进制冒烟（8399） | pass | capabilities=[file-server]、首页 200、树懒加载正常 → srv01-smoke-tree.png |
| SRV-02 | /api/health capabilities 随 --compute 变化 | pass | 无 compute=[file-server]；有 compute 追加 "compute" 于尾部（curl 对照） |
| SRV-03 | 前端连接服务器 + 目录树出现 | pass | 空 token/token 两种场景连接成功、懒加载树展开正常（偏差 #2 已知） |
| SRV-04 | 错误 token 前端明确提示；接口 401 | pass | 接口 401 unauthorized + www-authenticate；前端「鉴权失败：令牌缺失或错误（HTTP 401）」→ srv04-wrong-token.png、srv04-wrong-token-same-origin.png |
| SRV-05 | 打开 sample.js：状态栏语言/编码来自 X-VV 头 | partial | 高亮 ✓、x-vv-lang/x-vv-encoding 正确下发；状态栏不展示（BUG-04）→ srv05-samplejs-open.png、srv05-hello-py.png |
| SRV-06 | SSE 变更推送：约 500ms 自动重读且滚动保留 | partial | /tmp 实例全链路 ✓（scrollTop 12000 保持）；8391 btrfs watcher 故障 watch-error（BUG-02）→ 复核截图 03~07 号 |
| SRV-07 | 设置切换刷新自动/手动 + 手动刷新按钮 | fail | 全 UI 穷举无刷新设置与按钮（并入 BUG-05）；spec 262 行明确要求 → 复核截图 SRV-07 系列 |
| SRV-08 | /api/file Range 三态 | pass | 206/416/后缀 206 三态+非法 Range 416 严格拒绝（curl 实测） |
| SRV-09 | 路径穿越与越界 symlink 防护 | pass | ../ 与 %2e%2e%2f → 400；root 内外链 symlink → 403（curl 实测） |
| SRV-10 | --allow-lan 无 token 拒绝启动；--token-gen 可启动 | pass | exit=2 明确报错；加 --token-gen 正常启动、stdout 打印 64 位 token |
| SRV-11 | dot 文件默认显示、--hidden 过滤 | pass | 默认全显示；--hidden 实例仅 visible.txt（8391/8396 对照） |
| SRV-12 | 中文名深层嵌套目录 + 排序 | pass | 4 层懒加载展开正常；目录优先+自然排序 file1<file2<file10 → srv12-chinese-deep.png |
| SRV-13 | SSE 一次性 ticket + 15s ping 心跳 | pass | ticket 一次性 ✓、Bearer 不可用于 events ✓、心跳间隔精确 15s（时间戳实录） |

### 8.9 compute-global-search（12 点：7 pass / 5 partial）

| 编号 | 测试点 | 结果 | 证据摘要 |
| --- | --- | --- | --- |
| CMP-01 | --compute capabilities + 状态栏执行位置指示 | pass | capabilities 含 compute；本地/远程指示可见 → cmp01-statusbar-local.png |
| CMP-02 | 3MB 文件 remote 远程执行+缓存加速 | partial | >2MB 阈值压制为本地 hljs 分块；服务端可高亮、二次仅快约 8%（BUG-10）→ cmp02-3mb-local-hljs.png、cmp02-samplejs-remote2.png |
| CMP-03 | auto 策略 html/含围栏 md 留本地执行 | partial | md 显示「渲染: 远程」、html 无执行段；围栏本地 hljs 着色保留（BUG-22）→ cmp03-html-source-view.png |
| CMP-04 | 服务端高亮失败：auto 回退 / remote 错误卡片 | pass | auto 网络层捕获 400→本地兜底；remote 报「远程高亮失败: HTTP 400」→ cmp04-php-auto.png、cmp04-php-remote.png、cmp04-ex-auto.png |
| CMP-05 | sample-gfm.md remote comrak 与本地一致 | pass | remote/local DOM 指纹一致；curl 服务端 GFM 输出验证 → cmp05-gfm-remote.png、cmp05-gfm-local.png |
| CMP-06 | 全局搜索点击命中行打开并滚动高亮 | partial | 分组/打开 ✓；不滚动定位、无命中行高亮（BUG-09）→ cmp06-click-jump.png、cmp06-tall-no-scroll.png、cmp06-contrast-infile-highlight.png、cmp06-after-close.png |
| CMP-07 | glob 限定/大小写开关/正则开关 | partial | Aa 与 .* ✓；glob 无 UI 入口、API 层有效（BUG-21）→ cmp07-regex-on.png |
| CMP-08 | 命中数 >1000 截断并提示 | pass | 「1000 个命中（结果不完整，已达上限）」+ NDJSON truncated 终帧 → cmp08-truncated.png |
| CMP-09 | 无 rg 时 501 + 前端降级本地 grep | pass | 501 明确报错；前端降级提示「服务器 ripgrep 不可用，已改用浏览器内搜索」→ cmp09-fallback-norg.png |
| CMP-10 | 纯前端打开本地文件夹后全局搜索可用 | pass | OPFS stub 打开、5 命中按文件分组、<2MB 与二进制过滤 ✓ → cmp10-pureweb-search.png |
| CMP-11 | 纯前端超 2000 文件提示超限 | partial | 2000 文件上限+truncated 提示 ✓；无「建议改用服务器模式」（BUG-11）→ cmp11-final-truncated.png |
| CMP-12 | 搜索取消/重发无报错堆积 | pass | 全部 POST 200、无 canceled/failed、无 rg 进程残留（间接验证） |

### 8.10 pwa-mobile-performance（9 点：4 pass / 4 partial / 1 fail）

| 编号 | 测试点 | 结果 | 证据摘要 |
| --- | --- | --- | --- |
| PWA-01 | SW 注册成功且 precache>10 | pass | activated、controller=true、precache 102 条含 manifest → pwa01-sw-precache.png |
| PWA-02 | 断网后应用壳离线可用、刷新不白屏 | partial | 重新导航离线壳可用 ✓；reload 落 chrome-error（BUG-15）→ pwa02-offline-shell-nav.png、pwa02-offline-shell.png |
| PWA-03 | grammar wasm 命中运行时缓存，断网仍高亮 | fail | vv-grammars-* 缓存从未创建、断网 8 个 wasm 全 FAILED、离线降级 hljs（BUG-06）→ pwa03-offline-local-py.png、pwa03-offline-sql-highlight.png、pwa03-open-go.har |
| PWA-04 | 断网时 /api/* 网络优先不缓存、失败有提示 | partial | 不缓存 ✓、文件打开提示明确 ✓；目录展开静默失败（BUG-24）→ pwa04-offline-api-error.png |
| PWA-05 | 375×667 移动视口抽屉→文件夹→树→md 流程 | pass | 无横向溢出、抽屉开合、12 层 blockquote 渲染 → pwa05-drawer-open.png、pwa05-md-rendered.png |
| PWA-06 | 移动视口大文本触摸滚动跟手 | partial | CDP 触摸 1:1 跟手、虚拟渲染正常；惯性结论复核不可复现（BUG-26 unconfirmed）→ pwa06-virtual-scroll.png |
| PWA-07 | 移动视口打开 mp4：不崩溃、播放器、全屏 API | pass | ArtPlayer 挂载、trusted click 全屏进入/退出成功 → pwa07-mp4-player.png、pwa07-fullscreen.png |
| PWA-08 | ≤10MB 首帧 <300ms；1MB .bin hex <200ms | partial | 文本中位 208ms 达标；hex 1404~1781ms 超预算 3~9 倍（BUG-16）→ 复核 pwa08-desktop-hex-1mb.png、pwa08-mobile-hex-1mb.png |
| PWA-09 | 本地音视频打开到起播 <1s | pass | mp4 40ms、mp3 36ms 起播，远优于预算 |

---

*报告完。所有数字、结论与证据路径均转录自本轮测试与仲裁的输入材料；verified 与 unconfirmed 全程明确区分；除本文档外未改动任何文件。*
