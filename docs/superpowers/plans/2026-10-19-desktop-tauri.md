# 多端发布阶段一：Tauri 桌面薄壳 Implementation Plan（spec 阶段一）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tauri 2 桌面薄壳（Windows/macOS/Linux）：spawn server sidecar（随机端口）→ 解析 `VV_READY port=<n>` → 窗口导航 `http://127.0.0.1:<port>/`；前端 dist 作为 Tauri resource 传 `--web-dist`；单实例；未签名产物三平台 CI。

**Architecture:** apps/desktop Tauri 2 项目——Rust shell 三职责：spawn sidecar（`src-tauri/binaries/vviewer-server-<target-triple>`）+ 捕获 stdout 解析就绪行 + WebView 导航；server 侧新增 `--port 0` 内核分配与 bind 后 `VV_READY port=<n>` stdout 机器可读行（listener.local_addr 实测端口）。应用退出回收子进程。前端零改动。

**Tech Stack:** Tauri 2（tauri ^2、tauri-plugin-single-instance）、clap 既有、GitHub Actions matrix（ubuntu/macos/windows）。

**Spec:** `docs/superpowers/specs/2026-10-19-multiplatform-release-design.md` 阶段一

## Global Constraints

- 薄壳纪律：无 IPC/无原生菜单/无托盘/无自动更新（非目标）；安全基线=sidecar 绑 127.0.0.1、无 token、不加 --allow-lan、CSP 采 Tauri 默认+放行 localhost 导航。
- 就绪协议：server 启动完成（bind 成功）向 stdout 输出恰好一行 `VV_READY port=<n>`（追加于现有启动日志后）；shell 15s 超时未捕获或子进程退出 → 原生错误窗+「重启服务」能力。
- 单实例：tauri-plugin-single-instance（二次启动唤起既有窗口）。
- 前端 dist 以 Tauri resource 打包，启动时经 resource 路径传 `--web-dist`。
- 未签名产物（macOS Gatekeeper/Windows SmartScreen 注记进 Release 文案）；签名留 CI secrets 后续接入。
- CI：release workflow 增 desktop matrix（ubuntu/macos-latest [x86_64+aarch64 分产物]/windows），产物 .AppImage+.deb / .dmg×2 / NSIS .exe。
- 每任务原子提交；本地无法跑 GUI——Tauri 壳验证=cargo check/clippy + 就绪协议解析单测 + 手动冒烟清单文档化。

---

### Task 1: server 侧就绪协议（--port 0 + VV_READY）

**Files:**
- Modify: `server/src/main.rs`（bind 后 listener.local_addr().port() → println!("VV_READY port={n}") 纯净行[无前缀装饰]；"listening on" 日志同步用实测端口；--port 0 语义确认）
- Modify: `server/src/main.rs` tests 或新集成测试（VV_READY 行输出断言——stdout 捕获形态按可测性取：逻辑提取为可测纯函数或集成测试起服读 stdout）

**Interfaces:**
- Produces: `--port 0` → 内核分配端口可被解析；stdout 含 `VV_READY port=<n>` 行（n=实测端口）；既有启动日志/校验链零变化。

- [ ] **Step 1: 写失败测试**（集成测试：spawn serve --port 0 → 读 stdout 至 VV_READY 行 → 解析端口 → 对该端口 GET /api/health 200。形态按既有集成测试 spawn 先例——若无 spawn 先例则以局部提取[bind 后端口获取函数]单测 + 手动冒烟清单替代，报告记录选择）。
- [ ] **Step 2: 确认失败**
- [ ] **Step 3: 实现**（local_addr 替换打印值；VV_READY println 用 `#[cfg(not(test))]` 或等价防测试噪声——取实现简者）。
- [ ] **Step 4: cargo 全量回归**
- [ ] **Step 5: Commit** `feat(server): --port 0 内核分配与 VV_READY 就绪行——桌面薄壳前提`

---

### Task 2: Tauri 壳项目

**Files:**
- Create: `apps/desktop/`（package.json + src-tauri/{tauri.conf.json, Cargo.toml, src/main.rs, binaries/README}）
- Modify: 根 pnpm-workspace.yaml（apps/desktop 入 workspace——如 Tauri CLI 经 pnpm）
- Modify: `server/src/main.rs`（无需改——web-dist 资源路径经 CLI 传）

**Interfaces:**
- shell 行为：spawn sidecar（target-triple 后缀二进制）→ 15s 读 VV_READY → 导航 `http://127.0.0.1:<port>/`；子进程退出/超时 → 错误窗（含 stderr 摘要）+ 重启按钮；应用退出 kill 子进程；single-instance。
- web-dist：Tauri resource 打包 `apps/web/build`（构建产物路径），spawn 时 `--web-dist <resource path>`。

- [ ] **Step 1: 测试先行**（就绪行解析器纯函数 `parse_ready_line(line) -> Option<u16>` 提取到 shell crate 并单测：正常行/带前缀噪声行/超时语义/非数字容错）。
- [ ] **Step 2: 确认失败**
- [ ] **Step 3: 实现**（tauri.conf.json：externalBin sidecar 命名/resources dist 路径/windows NSAIS|linux deb+AppImage/mac dmg——按 Global Constraints 产物矩阵；main.rs：Command spawn+stdout BufReader lines 解析+tauri WebviewWindow navigation_url+exit handler kill；single-instance 插件）。
- [ ] **Step 4: cargo check/clippy（apps/desktop/src-tauri）+ tauri conf lint（如可）**
- [ ] **Step 5: Commit** `feat(desktop): Tauri 薄壳——sidecar 就绪协议/错误窗/单实例`

---

### Task 3: CI desktop matrix 与文档

**Files:**
- Modify: `.github/workflows/release.yml`（desktop job：matrix [ubuntu-22.04, macos-latest, windows-latest]；步骤=checkout/pnpm/构建 web dist/cargo build server 复制为 sidecar 命名/tauri-action 或 tauri CLI build/上传 artifacts）
- Modify: `README.md`（桌面端章节：三平台产物/未签名安装说明[Gatekeeper 右键打开/SmartScreen]/手动冒烟清单[spawn→导航→打开目录→退出回收]）
- Modify: `docs/superpowers/specs/2026-10-19-multiplatform-release-design.md`（如实现与 spec 有偏差注记）

- [ ] **Step 1: workflow 语法与矩阵核对**（actionlint 如可用；tauri-action 官方 action 版本钉定；产物命名约定）
- [ ] **Step 2: 本地可验证面**（Linux 本机 tauri build 或 cargo check；就绪协议端到端：spawn server --port 0 → 解析 → health 200 的脚本化验证[替代 GUI]）
- [ ] **Step 3: Commit** `ci(desktop): 三平台 Tauri 构建矩阵与桌面端文档`

---

### 实施风险与裁决预留

- Tauri 2 CLI 生态在本仓库 pnpm 版本下的安装形态（@tauri-apps/cli devDep vs cargo tauri）——取与 CI 矩阵兼容者，报告记录。
- macOS 产物 arch 拆分（x86_64/aarch64 分 dmg）与 runner 映射——CI 实测校准。
- resource 路径在 dev/release 形态的差异（tauri dev vs build）——shell 代码兼容两形态。
- 前端 dist 的构建时机：desktop job 内先构建 web（pnpm --filter web build）再打包——与 release workflow 既有 web job 的产物复用取实现简者。
- server 二进制 per-target 交叉编译：macOS aarch64/x86_64 双 host 原生编译即可（runner 映射）；不引入 cross 工具链（YAGNI，spec 未要求 musl）。
- GUI 无法本地验证——手动冒烟清单（README）为本任务验收的一部分：spawn→导航→打开本地目录→j/k→退出回收，六步。
