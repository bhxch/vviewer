# VViewer Desktop（Tauri 2 薄壳）

三平台桌面端：Rust 壳 spawn server sidecar（随机端口）→ 解析 `VV_READY port=<n>`
就绪行 → 窗口导航 `http://127.0.0.1:<n>/`。前端构建产物以 Tauri resource 打包，
启动时经 `--web-dist` 传给 server；单实例；退出回收子进程。

薄壳纪律：无 IPC、无原生菜单、无托盘、无自动更新；sidecar 只绑 127.0.0.1、
无 token。前端页面由 server 伺服（非 tauri:// 协议面）。

## 目录

```
apps/desktop/
├── package.json            # @tauri-apps/cli devDep（pnpm tauri 入口）
└── src-tauri/
    ├── tauri.conf.json     # externalBin sidecar / resources web-dist / 产物矩阵
    ├── Cargo.toml          # 独立 workspace（锁文件同目录入库）
    ├── build.rs            # tauri-build + 注入 VV_TARGET_TRIPLE
    ├── src/main.rs         # 启动编排（spawn/就绪/导航/错误窗/单实例/回收）
    ├── src/ready.rs        # 就绪协议解析与等待（TDD 单测 15 例）
    ├── binaries/           # sidecar 落位（见其 README.md；产物不入库）
    └── icons/              # 占位图标（正式图标可用 `pnpm tauri icon` 重制）
```

## 本地开发

前置：Rust、pnpm、[Tauri 2 系统依赖](https://v2.tauri.app/start/prerequisites/)
（Linux 需 webkit2gtk-4.1 开发包）。

```sh
# 1. 前端构建产物（resource 与 --web-dist 都指向它）
pnpm --filter web build
# 2. server 构建并复制为 sidecar 命名（triple 以本机为准）
cargo build --release --manifest-path server/Cargo.toml
cp server/target/release/vviewer \
   apps/desktop/src-tauri/binaries/vviewer-server-$(rustc --print host-tuple)
# 3. 起桌面壳
pnpm --filter desktop dev
```

打包 release 产物：`pnpm --filter desktop build`（Linux 出 .AppImage+.deb /
macOS 出 .dmg / Windows 出 NSIS .exe；跨平台 targets 列表由 bundler 按宿主
过滤，未支持目标仅告警跳过）。

## 运行期路径解析

| 项 | 候选序 |
| --- | --- |
| server sidecar | ① `<主程序目录>/vviewer-server`（手动布局兜底；bundler 实际不产出此名，安装名保留 triple+扩展名）② `<主程序目录>/vviewer-server-<triple>`（release 打包形态）③ `src-tauri/binaries/vviewer-server-<triple>`（dev）——Windows 全形态追加 `.exe` |
| 前端产物 | ① `VV_WEB_DIST` 环境变量 ② `$RESOURCE/_up_/_up_/web/build`（resources 打包形态：`../../web/build/` 中 `..` 按官方规则净化为 `_up_`）③ 仓库内 `apps/web/build`（dev） |
| 浏览根 | `HOME`（无则 `USERPROFILE`） |

server 额外参数固定：`serve --port 0`（内核分配随机端口）。

## 手动冒烟清单

七步主路径 + 故障路径抽查，GUI 无法在 CI 内验证，发布前按下表人工冒烟（dev 与
打包产物各过一遍）：

| # | 步骤 | 预期 |
| --- | --- | --- |
| 1 | 启动应用（`pnpm --filter desktop dev` 或安装产物后启动） | 窗口出现并加载页面；启动期间无空白卡死（就绪上限 15s） |
| 2 | 观察窗口地址内容 | 页面来自 `http://127.0.0.1:<随机端口>/`，标题 VViewer |
| 3 | 在页面中打开一个本地目录 | 目录列表正常渲染（浏览根=家目录） |
| 4 | `j`/`k` 上下移动条目 | 键位导航生效 |
| 5 | 不关窗，再次启动同一应用 | 不出现第二个实例，既有窗口被唤起置前（单实例） |
| 6 | 关闭窗口退出 | `pgrep -f vviewer-server` 无残留（子进程被回收） |
| 7 | 启动后 `kill -TERM <壳pid>`（unix-only；Windows 的 ctrlc 只映射 CTRL_C/CTRL_BREAK，无 SIGTERM 面） | 应用退出且 `pgrep vviewer-server` 无残留（信号路径回收子进程） |

故障路径抽查（**发布前必过项**，非可选）：

> 这是 C1/C2 类运行期缺陷（插件未注册、平台路径解析落空等——编译期与
> 单测均无法暴露、只在目标平台真实运行时触发）的唯一抓取手段。门禁：
> **至少 Linux 一平台本地必过**；**Windows/macOS 每平台 CI 首跑出包后人工
> 过一遍**（此后回归可抽查）。

- 临时改名为 sidecar 缺失 → 启动弹原生错误窗（含 stderr 摘要），「重启服务」
  恢复改名后可重启成功；「退出」则应用退出且无残留进程。点击后错误窗立即可
  交互（异步重启），就绪后原窗导航。
- `pkill -f vviewer-server`（模拟运行中崩溃）→ 错误窗弹出，可重启恢复。
