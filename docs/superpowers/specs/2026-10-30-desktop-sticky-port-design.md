# 桌面薄壳粘性端口（sticky port）设计

- 日期：2026-10-30
- 状态：待实现
- 前置讨论：brainstorm 调查（2026-10-30 会话）——随机端口的 origin 漂移诊断与三方案对比（粘性端口 / 自定义协议稳定 origin / 服务端持久化），裁决取方案 A。
- 关联：`docs/superpowers/plans/2026-10-19-desktop-tauri.md`（Global Constraints 与 1-14 就绪行收窄）、`docs/superpowers/specs/2026-10-19-multiplatform-release-design.md`（「薄壳导航：随机端口 spawn」既定决策，本设计为其修订）。

## 背景与动机

桌面薄壳以 `serve --port 0` 每次启动内核分配随机端口，窗口导航 `http://127.0.0.1:<port>/`。Web 平台的 HTTP cache、CacheStorage（Service Worker）、localStorage、IndexedDB 全部按 origin（scheme+host+**port**）隔离——端口每启动一变，等于每次都是全新 origin：

1. **用户状态每次归零**（最重）：设置存 localStorage（`vviewer:settings`）；自定义主题、字体、直连挂载记录、工作区状态存 IndexedDB（`apps/web/src/lib/stores/session.ts`）。桌面端改完设置重启即丢，冒烟清单未覆盖故未被发现。
2. **SW 缓存每次从零**：`registerSW({ immediate: true })` 每启动全新注册，workbox precache 全量重拉，`vv-grammars/vv-queries` 等运行时缓存（tree-sitter 语法 wasm、.scm 查询）全部 miss 重拉。
3. **webview 数据目录膨胀**：每启动遗留一整个 origin 的死数据（precache + grammar 缓存 + localStorage/IDB），无清理面，随启动次数线性增长。
4. HTTP cache 跨启动不命中（loopback 重拉，影响最小）。

方案对比裁决（详见 brainstorm 记录）：自定义协议稳定 origin（B）违反「无 tauri:// 面」薄壳纪律且 webkit2gtk Range/流式有已知坑，放弃；服务端持久化（C）改动面大，留作后续独立立项；**粘性端口（A）以最小改动让绝大多数启动 origin 稳定，根治 1–3 的主路径**。

## 目标

- 桌面端绝大多数启动落在同一 origin：设置/主题/字体/工作区/直连挂载、SW precache 与运行时缓存、HTTP cache 跨启动生效。
- 端口被占等冲突场景**永不导致启动失败**：自动回退随机端口，仅损失该次持久化。
- 薄壳纪律零破坏：server 依旧直出页面，无 IPC 面、无 tauri:// 面；安全基线（127.0.0.1、无 token、不加 --allow-lan）不变。

## 非目标

- 不迁移、不清理旧 origin 数据：首个粘性启动仍是空状态；webview 数据目录里既往随机端口的死数据不做清理（可选后续 storage hygiene 立项）。
- 不做端口配置 UI / 用户可见配置项。
- 不做回退发生的用户提示（静默降级）。
- 不做方案 C 的服务端持久化。

## 反目标（出现即失败）

- 端口冲突导致启动失败率上升（回退链必须兜底到 `--port 0`）。
- 薄壳职责扩张（代理/IPC 面）或既有 CLI/部署形态的输出行为变化（1-14 收窄语义对不加新 flag 的调用面必须原样）。

## 决策（已裁决部分）

| # | 决策 | 理由 |
| --- | --- | --- |
| D1 | 壳把上次成功端口持久化于自身配置，启动优先复用，bind 失败自动回退 `--port 0` | 业界惯例「至多持久化偏好端口，冲突永远回退随机」（Jupyter/code-server 固定端口先例；tauri-plugin-localhost 官方插件也需调用方自行传稳定端口） |
| D2 | 端口记忆落 `AppConfigDir` 下壳私有 JSON（Tauri `BaseDirectory::AppConfigDir`），形如 `{"port": <u16>}`；缺失/损坏/越界一律视同无粘性 | 壳自有的非 origin 存储，天然跨启动；损坏容错比原子写更重要（文件极小） |
| D3 | server 新增 `--emit-ready-line` flag：就绪行输出条件放宽为 `kernel_assigned \|\| flag`；壳**恒传**该 flag（两种端口形态同一路径） | 1-14 收窄语义（显式端口面向人读不多一行）对存量调用面原样保持；壳侧无条件传参最简、单一代码路径；wire 格式不变（`ready_line` 单测继续锁定） |
| D4 | 回退触发条件 = 粘性尝试下 `WaitFailure::Ended`（bind 失败 exit 2 → stdout EOF）→ 回退一次；`Timeout` 不重试直入既有错误窗 | bind 失败快速退出，回退代价小；Timeout 再等 15s 会把最坏启动拖到 30s+，不值 |
| D5 | 不探测不复用孤儿 sidecar：端口被孤儿占有时照常回退 | 孤儿参数（root/web-dist）不可信，复用有正确性风险；回退自愈（回退成功后写回新端口成为新粘性） |
| D6 | 写回时机：`start_and_wait` 成功返回后同步写实测端口（粘性命中与回退成功同路径） | 回退后新端口自然成为新粘性；失败路径不写（保留上次好端口） |
| D7 | 壳不新增日志面（命中/回退不打印） | 薄壳纪律；冒烟验证走端口观察与设置保留（见冒烟表） |
| D8 | 壳↔server 版本硬耦合照单接受：恒传 `--emit-ready-line` 遇旧版 sidecar（无此 flag）→ 粘性与回退双双 exit 2 → 既有错误窗（stderr 尾部可见 `unexpected argument`），不做针对性文案；`binaries/README.md` 补版本配套说明 | 发布形态同包无此问题，混装仅限 dev 手动拷贝形态；错误窗分类工作不成比例 |

## 行为规格

### 启动编排（`start_and_wait` 改造）

```
读 sticky（AppConfigDir/desktop-shell.json）→ Some(p) 且 p 合法
  ├─ 尝试 `serve --port p --emit-ready-line …`
  │    ├─ 就绪 → 写回 p → 成功（origin 稳定路径）
  │    ├─ Ended（含 bind 失败 exit 2）→ 走回退
  │    └─ Timeout → kill 子进程 → 既有错误窗（不回退）
  └─ None → 直接走回退
回退：`serve --port 0 --emit-ready-line …`
  ├─ 就绪 → 写回实测端口 → 成功（本次随机，下次粘住）
  └─ 失败（Ended/Timeout）→ 既有错误窗（「重启服务」重走全链）
```

- 错误窗「重启服务」（`restart_async`）复用同一 `start_and_wait`，无需特判。
- 合法端口域：`1..=65535`（0 视同无粘性，交内核分配）。

### server 侧（`--emit-ready-line`）

- clap `Serve` 子命令新增 `#[arg(long)] emit_ready_line: bool`，进 `ServeArgs`；TOML config 文件键 `emit-ready-line` 同名可用（合并优先级 CLI > 文件，既有链路）。
- `assembly.rs` 就绪行门：`if kernel_assigned || args.emit_ready_line`（测试构建整体静默的 `#[cfg(not(test))]` 语义不变）。
- 不加 flag 的存量调用（人读 CLI、脚本、e2e、既有测试）输出零变化。

### 壳侧新增（`sticky.rs` 或等价模块）

- 读：`read_sticky_port(dir) -> Option<u16>`——文件缺失/JSON 损坏/字段缺失/越界 → `None`，不 panic 不告警噪音。
- 写：`write_sticky_port(dir, port)`——成功就绪后调用；写失败静默（持久化是优化不是依赖）。
- 两者为可单测纯函数（路径入参），编排层只做接线。

### 冒烟清单增补（`apps/desktop/README.md`）

| # | 步骤 | 预期 |
| --- | --- | --- |
| 8 | 改一项设置 → 完全退出 → 重启 | 设置保留（origin 稳定生效）；`ss -tlnp`/`lsof -iTCP -sTCP:LISTEN`（Windows 用 `netstat -ano`）可见 vviewer-server 监听端口与上次一致 |
| 9 | 人为占用粘性端口（如 `nc -l 127.0.0.1 <port>`）→ 启动 | 应用正常可用（回退随机端口）、无错误窗；旧粘性端口的既往设置本次不可见；本会话新改的设置在下次启动保留（回退端口已写回成为新粘性，D6） |

## 测试策略

- **server**：集成测试——`--port <显式> --emit-ready-line` 输出就绪行且可 `GET /api/health`；`--port <显式>` 无 flag 不输出（锁 1-14）；`ready_line` wire 单测原样通过。
- **壳**：sticky 读/写纯函数单测（缺失/损坏/越界/合法/写后读回）；回退编排的可测半边如实注记（headless 限制照 2-6 先例：纯函数 + 既有 `start_and_wait` 结构约束，GUI 面靠冒烟清单）。
- **回归**：server 与 src-tauri 各自 `cargo` 全量（check/clippy/test）；桌面 CI 三平台出包不回归。
- **验证边界**：端口复用后的「设置跨重启保留」只能在真实 GUI 冒烟确认（headless CI 无窗口系统）。

## 安全注记

粘性端口使下次启动端口可预测（读配置文件即知）。威胁模型不变：server 只绑 127.0.0.1、无 token 是既有口径；本机同用户进程本可读同一配置文件与既有日志中的端口。TOCTOU 竞争（他进程抢先占粘性端口）与任何固定端口本地服务等同，且后果仅是回退随机端口。

## 留给实现者的裁量

- JSON 文件名与字段名（建议 `desktop-shell.json` / `port`，不强制）；
- `sticky.rs` 模块划分与测试文件组织；
- 回退逻辑的代码形态（`start_and_wait` 内循环 vs 外层两段调用），以可读性优先。

## 裁决补记（builder check 2026-10-30，均为主/designer 裁决非用户裁决）

- D3 的 flag 命名从裁量区移除已定（`--emit-ready-line`，D8 接受版本耦合）；
- 冒烟 8/9 预期按 D6/D7 修正（原稿「stderr/日志可见同端口复用」无观察通道、「该次设置不跨下次保留」与 D6 写回语义矛盾）；
- 实现者自行决定的已确认面：壳 crate 需补 `serde_json` 直依赖（现无）；集成测试沿用 `server/tests/ready_protocol.rs` 的 spawn 先例；回退两次 spawn 间的僵尸回收沿用既有 `kill_server` 纪律。
