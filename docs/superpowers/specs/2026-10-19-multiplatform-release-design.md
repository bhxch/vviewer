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
- **CSP 为显式 null**：上文「CSP 采用 Tauri 默认」字面与落地不符——Tauri 的 CSP 注入仅作用于其自有协议面（tauri:// / IPC 页面），本壳页面是 sidecar 的 http 源（`http://127.0.0.1:<port>`）直链导航，不在该注入面内，无「默认 CSP + 放行清单」可配；`tauri.conf.json` 置 `csp: null`（默认值）即如实表达「壳不施加 CSP 面」。
- **externalBin/资源候选序（落地设计，原文未记）**：壳侧 sidecar 解析按「主程序目录裸名 → 主程序目录 triple 名 → `src-tauri/binaries` triple 名」候选序探测（Windows 全形态追加 `.exe`）；bundler 对 externalBin 落盘保留 triple 命名与平台扩展名（裸名为手动布局容错，bundler 不产出）。前端产物经 `resources` 的 `../../web/build/` 按官方净化规则落盘为 `$RESOURCE/_up_/_up_/web/build`，壳按该路径解析（源码树直跑回落仓库内路径，`VV_WEB_DIST` 显式覆盖优先）。

## 7. 阶段二实施注记（vviewer-core 抽取四任务落地校准，2026-10-19）

实现与 §3 的差异与裁决记录（详证见 `.superpowers/sdd/2026-10-19-server-core/` 各任务报告；行为锁 373→392 全程零翻转，13 个集成测试文件一行未动）：

- **域序 = 依赖序**（原文未定序）：Task 2 按 mounts→tree→file（`root_at` 统一寻址依赖运行时挂载容器先入核）；Task 3 按 search→tickets/events→compute+feature 门控。
- **file 域 locate/read 双段**：原文「core 收已解析 ResolvedRange」落为 `locate`（根寻址/guard/stat/目录 400，返回仅暴露 size）→ 适配层解析 Range/If-Range（HTTP 语义留适配层裁决的落实形态）→ `read(located, Option<RangeSpec>)`。窗口类型取既有 `vviewer_storage::RangeSpec`，不另造 `ResolvedRange`。既有顺序保真：目录 400 先于 Range 416。
- **`CoreBody::Stream` 提前至 Task 2 落地**（原文挂在 Task 3 SSE 名下；Global Constraints 本明示 Full/Stream 枚举且 file 域流式读即时需要）：chunk 流形态（`Stream<Item=io::Result<Bytes>>`）同时承载文件窗流、search NDJSON、SSE。
- **compute 域整体入核（含 build.rs grammar 编译链）**：原文「core 对应 handler 在无 feature 时返回能力缺失语义」实落为**编译期不存在**（`#[cfg(feature = "native")]`）+ 路由不挂载 + health 双重门（编译期 × `--compute` 运行时）——比 404/501 语义更强。随之「core 不依赖 comrak」约束**仅在裁剪形态严格成立**；默认形态 core 经 optional dep 持有重依赖属计划内有意例外（compute 域实现体入核是计划 Task 3 Files 明列要求），计划 Global Constraint 该行已同步改写（Task 4 收口）。
- **SSE wire 编码 core 自产**：复刻 axum 0.8.9 `Event` 字段布局（`data: <载荷>\n\n` / `: <注释>\n\n`）；`Sse::into_response` 自带的 `cache-control: no-cache` 并入 core 头表（迁移前 routes 手工 insert 为冗余位），wire 逐字节不变。
- **/api/ticket 与 /api/search 不随 native 裁剪**：ticket 域零 notify 依赖、search 依赖仅 tokio process——均非重依赖；阶段三 worker 的裁剪是适配层政策（不挂路由 + health 宣告另置，机制挂点即 core::health 的宣告行，与 compute 双重门同形可复制）。
- **测试面 native 门禁化**（Task 3 修复轮 M-1）：裁剪形态下死路径的集成测试断言面以文件级/函数级 `#[cfg(feature = "native")]` 门禁（compute_highlight/compute_markdown/events 整文件；health/security 各一函数）——断言零变化，native 形态照常全量编译运行；`cargo check --workspace --all-targets --no-default-features`自此为零红新门。
- **health 宣告缝演化**：Task 1 预埋 `compute_languages`/`search_engine` fn 指针注入缝，Task 3 域收编 core 后全部退役（core::health 直调同链，零注入；version 仍由适配层注入主 crate 版本杜绝双 crate 漂移）。
- **AppState 拆分与缝处置**：`CoreState` 持全部业务状态（配置/多根容器/令牌/引擎覆盖/运行时挂载容器），axum 特有面（web_dist/cors_origin/watch hub/ticket 表实例）留适配层。Deref 兼容缝经 Task 4 收口裁决**保留+注记**（auth/routes 与 builder 群为真实消费方，测试面零消费）；guard.rs 适配层包装缝无消费方，**撤除**（业务体在 core::guard 单一事实源）。
- **启动校验链留守 bin**（Global Constraints「启动校验逻辑全部入 core」未落地，偏差记录）：`validate_startup` 操作 bin 侧 `ServeArgs`（CLI/TOML 合并产物），core 无 CLI 面；worker 形态配置源独立（阶段三 env JSON），不复用该链。按「发现的独立问题记台账」纪律本阶段不改；阶段三若需共享校验再评估下沉 core。装配根职责（CLI 解析/logging/bind/就绪行）同理留守 bin，§3 未列为 core 域。

## 8. 阶段三实施注记（Workers 适配四任务落地校准，2026-10-19）

实现与 §4 的差异与裁决记录（详证见 `.superpowers/sdd/2026-10-19-workers/` 各任务报告；native 行为锁 392→403 全程零翻转，既有测试零改动）：

- **前置项（终审 I-1）兑现形态**：`vviewer-core`/`vviewer-storage` 以 `default-features = false` 进 wasm 构建图（compute/reqwest 全家不进）；CoreState 懒构造 `ReqwestTransport::new()` 硬编码挪出为 `with_transport` 注入——worker 形态注入 wasm FetchTransport，native 构造路径行为零变化（402 测试零改动锚）。
- **wasm 流桥裁决**（预声明关键风险实测落锤）：workers-rs 0.8.7 无 tokio 运行时集成（`experimental_tokio` 仅 emscripten 生效）；ByteStream 抽象化不必要——tokio 的 io-util/compat 面在 wasm 允许集内且纯 poll 语义，不可用的 fs/process/net 按目标收口（`#[cfg(not(target_family = "wasm"))]`）；JsValue 载体 !Send 面以 SendWrapper 在流叶端入桥（storage 接缝 `HttpByteStream` Send 锚跨目标零改动）。
- **without_url 遗留核销**（阶段一终审遗留，本计划 Task 4「直接修」项）：rg 全仓与全历史 `without_url` 零命中——该符号不存在；其关切（错误消息携带原始 URL/凭据）已由挂载终审修复 I1/I2 收口（`display_endpoint` pub 下沉 storage crate，transport 错误路径与展示面共用剥 userinfo 口径）。无需代码改动，本条为处置记录。
- **体积门禁实绩**：worker-build（release + wasm-opt）产物 ≈0.90MB（index_bg.wasm 889KB + index.js 24KB），<5MB 预算余量 ~5.5×；`tools/worker-budget.mjs` 为 CI 断言（deploy-worker.yml dry-run 产物后置门）。
- **能力裁剪终态**：events（watch）与 search 路由**不挂载**（取不挂载而非 501——与阶段二 events 同形），health 相应不宣告（searchEngine 靠 wasm PATH 探测自然落空，零特判代码）；compute 随 `default-features = false` 编译期不存在（build.rs grammar 编译链整体跳过）。mounts 三 API 与 file/tree 经 S3/WebDAV 全链可用（wrangler dev 冒烟全矩阵，含 PROPFIND 谓词直通与 Range 206 流直通）。gzip 不做（§4 原文注记维持：worker 出口压缩语义归平台）。台账 Minor-1 顺带收口：HEAD /api/mounts 200（GET 路由单条件追加 Head——native axum `get()` 派生 HEAD 的对应物）。
- **资产纪律落锤（C1 前科）**：`run_worker_first: ["/api/*"]` + `not_found_handling = "none"`——不用 single-page-application（其缺失路径无条件回 200 index.html，恰为 C1 要防的形态）；缺失路径进 worker 按扩展名分流：`.wasm`/`.scm`/`.mjs`/`.css` 404 不回 HTML（native `serve_index` 为 `.scm`/`.wasm` 双层修之 server 层，worker 侧取计划纪律全集），其余回 index.html（SPA fallback 禁缓存，BUG-15 同款）。binding fetch 两条实测校准：需绝对 URL（相对路径被 workerd fetch 语义拒绝）、返回响应头不可变（读体重建后置补头）。
- **base 约定核实**（§4「VV_BASE_PATH 构建注入链复用」）：Workers Assets 按完整请求路径匹配资产、不做前缀剥离——worker 形态取根路径部署（workers.dev，base 全链留空）或前置剥前缀反代（前端构建注入 `VV_BASE_PATH=/前缀`，与 Pages 同一 vite 注入口）；worker 侧 env 仅服务 dispatch 剥前缀面，不与资产面混用。
- **部署链**：`deploy-worker.yml` 手动 dispatch（ref 选择器即可选 tag），steps = web build→wasm build（dry-run 触发 worker-build）→体积门禁→wrangler deploy→canary health（断言 200 + `file-server` 宣告）；secrets `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID` 未配置时 deploy/canary 两步自动跳过（构建与门禁照跑）——真实部署不在本计划范围（无 secrets），workflow 首跑校准同 grammar CI 先例口径。
