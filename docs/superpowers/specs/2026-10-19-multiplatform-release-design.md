# 设计：多端发布（Tauri 三桌面薄壳 + Cloudflare Workers 原生 wasm 部署）

- 日期：2026-10-19
- 状态：已评审（brainstorm 确认，待实施）
- 关联：`2026-10-19-directory-mounting-design.md`（HttpTransport 接缝/S3/WebDAV 后端——worker 存储唯一来源）、`2026-10-09-full-grammar-alignment-design.md`（compute 能力门控先例）、`2026-10-14` CI 修复轮（release.yml 结构）、Pages 部署经验（VV_BASE_PATH 链、SPA-fallback 语义）

## 1. 背景与目标

现状：发布面为 GitHub Release（linux server 二进制+web dist+grammar wasm）、npm grammar 包、GitHub Pages 前端。无桌面封装；后端不可部署到 CF Workers（axum/tokio/notify 直依赖本地 IO）。

目标：①Tauri 封装 Windows/macOS/Linux 三桌面端；②后端可部署 CF Workers（原生 worker，**复用 Rust 代码**，重构适配；存储经 HTTP 走 S3/WebDAV——承接目录挂载 spec 的 `HttpTransport` 接缝，不绑 R2 binding）。

### 已拍板的决策（brainstorm 记录）

| 决策点 | 结论 |
| --- | --- |
| CF Worker 路线 | **原生 Worker + Rust 复用**：业务逻辑抽框架无关 core crate，axum（native）与 workers-rs（wasm）双薄适配层；存储仅 S3/WebDAV（HTTP 语义，经 spec 5 接缝） |
| Tauri 形态 | **薄壳导航**：Tauri 窗口直接导航到本地 sidecar server（随机端口 spawn、退出回收）；前端零改动、PWA/SW 语义原样；无原生菜单/托盘/自动更新 |
| 签名 | **先未签名**（macOS Gatekeeper 手动放行、Windows SmartScreen 提示注记到 Release 文案）；签名待证书就绪后补 CI secrets |
| Worker 静态资产 | **Workers Assets binding**（官方标准，不计 CPU、无 10MB 顾虑）；Worker 脚本只承担 `/api/*` |

### 非目标

- 不做自动更新、系统托盘、原生菜单、文件关联（薄壳裁剪，后续可加）。
- Worker 上不做 watch（无文件系统通知源）、不做 rg 搜索（无进程 spawn）、**不做服务端 compute**（tree-sitter 301 语法 wasm 体积远超 worker 限制；comrak 随 compute feature 一并排除）——能力协商链（health capabilities）天然承载裁剪，前端已有逐项降级。
- 不做 iOS/Android。
- 不做签名/公证（上述拍板）。

## 2. 阶段一：Tauri 薄壳（apps/desktop）

- Tauri 2 项目：Rust shell 职责三件——spawn sidecar（`vviewer-server` 按 target-triple 预置 `src-tauri/binaries/`，前端 dist 作为 Tauri resource 打包）、解析 server 就绪端口、窗口导航到 `http://127.0.0.1:<port>/`；应用退出回收子进程。
- **就绪协议**：server 启动完成向 stdout 输出机器可读行 `VV_READY port=<n>`（追加于现有启动日志之后；`--port 0` 支持内核分配端口），shell 捕获解析后导航；超时（15s）或子进程退出 → 原生错误窗 +「重启服务」钮。
- 单实例：tauri single-instance 插件（二次启动唤起既有窗口）。
- 安全基线：sidecar 绑 127.0.0.1（不加 `--allow-lan`）、无 token 本机语义不变；CSP 采用 Tauri 默认+放行 localhost 导航。
- CI：release workflow 增 `desktop` matrix（ubuntu / macos-latest〔x86_64+aarch64 分产物〕/ windows），产物 .AppImage+.deb / .dmg / NSIS .exe；依赖既有 grammar/web 构建链；未签名直出。

## 3. 阶段二：Rust 复用重构（vviewer-core 抽取）

- 新 crate `server/core`：**框架无关请求/响应类型**（method/path/headers/body 流）+ 全部业务 handler（health/tree/file/mounts/search/ticket-events/storage 分发/鉴权 constant-time 比较），操作面全部经 `StorageBackend` trait（spec 5）。
- axum 适配层留在 `server/`（native）：axum Request↔core 类型双向映射 + tower-http 静态伺服/压缩/CORS 薄层；**纯重构**，现有 cargo 测试全绿为行为锁。
- cfg/feature 门控：`watch`（notify）与 `compute`（comrak/tree-sitter/build.rs grammar 编译；含服务端图表渲染 layout-rs/svgbob——markdown 对齐 spec §2.5 并入 `--compute` 的决策）为 native-only feature；core 对应 handler 在无 feature 时返回能力缺失语义（404/501 + health 不宣告）——与 `--compute` 既有可选语义同形。
- 本阶段不改任何对外行为；server 二进制功能与现状逐字节等价（启动校验/exit code 2 契约保留）。

## 4. 阶段三：Workers 适配（server/worker）

- workers-rs fetch handler → core dispatch；`HttpTransport` 的 wasm 实现（worker Fetch binding）接入 StorageBackend——挂载根成为 worker 上唯一文件来源。
- **挂载配置来源**：无文件系统 → `VV_MOUNTS` 环境变量 JSON（结构同 spec 5 TOML `[[mount]]`，凭据走 Wrangler Secrets）；health/mounts API 语义与 native 一致（脱敏回显）。
- 静态资产：wrangler `assets` binding 指向前端 dist；`run_worker_first: ["/api/*"]`；SPA fallback=缺失路径回 index.html，但 **`.wasm`/`.scm`/`.mjs` 等资产缺失必须 404 不回 HTML**（C1 SPA-fallback 前科：loader 嗅探 HTML 才暴露——assets binding 按扩展名精确匹配 + not_found_handling 配置，e2e 锁定）。`VV_BASE_PATH` 构建注入链复用。
- health 宣告：`file-server` + mounts 摘要；无 watch/search/compute → 前端既有降级链（搜索 501→浏览器内、watch 不可用提示、无 compute 提示）自动生效，无需前端改动。
- 响应流：`/api/file` Range 经 S3/WebDAV GET body **直通流式**（ReadableStream 穿透，不整块缓冲）；gzip 压缩层不做（worker 出口自带压缩语义差异，注记）。
- 部署：`wrangler deploy`；CI 新 `deploy-worker` workflow（手动 dispatch + tag 触发可选），secrets：CF account id/API token；部署后 canary 探活（health 断言）。
- 体积门禁：CI 编译 wasm32-unknown-unknown（无 compute feature）并断言 worker 脚本产物 < 5MB（限额内裕量）。

## 5. 测试

- 阶段二：cargo 全量既有测试零改动全绿（行为锁）；core 单测直接以纯类型 handler 为对象（无 axum 依赖，测试更快更稳）。
- 阶段一：CI 三平台构建产物存在性门禁；本地手动冒烟清单（spawn→导航→打开目录→退出回收）；就绪协议解析单测。
- 阶段三：core mock-transport 单测覆盖 worker 形态能力裁剪（health 宣告/挂载读写/Range 直通）；`wrangler dev` 冒烟脚本（health/tree/file 三断言）；资产 fallback e2e（.wasm 缺失 404、路由回 index.html）；部署 canary。

## 6. 阶段一实施注记（Task 2/3 落地校准，2026-10-19）

实现与上文 §2 的差异与裁决记录：

- **macOS 双 arch runner 映射**：原文「macos-latest〔x86_64+aarch64 分产物〕」。macos-13（末代 Intel runner）已于 2025-12 退役，落地为 `macos-15`（aarch64）+ `macos-15-intel`（x86_64）双 runner 原生编译——server build.rs 手动 g++ 链不带 `-arch`，单 runner 交叉编 x86_64 不可行，双 host 是必要而非偏好。
- **前端 dist 复用**：desktop job 以 `needs: [web]` 下载 web job artifact 解包至 `apps/web/build`（resources 源路径），而非 job 内重建——grammar wasm self-build 全仓只跑一次，「依赖既有 grammar/web 构建链」的落实形态。
- **tauri-action 不引入**：打包走 tauri CLI（`pnpm --filter desktop exec tauri build`），desktop 只产 artifact，聚合 release job 单一写权限点的既有结构不变；版本经 `--config '{"version":"<tag 去 v>"}'` 覆盖合并烙进产物文件名（conf 静态 0.1.0 仅本地开发用）。
- **server build.rs 跨平台工具链垫片**：C++ scanner 手法依赖外部 g++/ar/objcopy——windows 垫片为预装 mingw64 入 PATH（mingw 对象 × msvc 链接的 C++ 运行时面是主要校准点），macOS 垫片为 Xcode llvm-objcopy（binutils 兜底）。CI 首跑校准，必要时后续小轮 build.rs cc-cpp 化收编。
- **Linux runner 钉定 ubuntu-22.04**：deb/AppImage 的 glibc 兼容面取受支持最老 LTS（webkit2gtk-4.1 可用）。
