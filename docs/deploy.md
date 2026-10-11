# vviewer server 部署指南

面向使用者的精简版：把 vviewer 文件服务器跑起来，让浏览器（本地或局域网）查看一个目录。
完整参数说明与安全细节见 [server/README.md](../server/README.md)。

## 三步部署

```bash
# 1. 构建（仓库根执行）
pnpm build:all        # = pnpm build（前端 → apps/web/build）+ cargo build --release（→ server/target/release/vviewer）

# 2. 启动（本机使用：无需 token）
./server/target/release/vviewer serve --root /path/to/your/data --web-dist apps/web/build

# 3. 打开 http://127.0.0.1:8321，点 TopBar「连接服务器」，输入地址后连接
```

发布物只需两个东西：`server/target/release/vviewer`（单二进制）和前端静态目录
`apps/web/build/`（`--web-dist` 指定）。

## 多数据根（--root 多值）

一个实例可同时暴露多个目录，`--root` 重复传参即可：

```bash
./server/target/release/vviewer serve \
  --root /srv/docs --root /srv/code --web-dist apps/web/build
```

多根语义（单根部署完全不受影响，API 形状与历史逐字节一致）：

- **目录树/文件**：`/api/tree`、`/api/file` 接受可选 `root=<n>` 参数（0 起），
  缺省 = 0 号根；前端在 workspace 里添加「后端路径」来源时可选择根与根内子目录。
- **跨根搜索**：`/api/search` 不带 `root`（且不带 `path`）时**缺省跨全部根**搜索，
  命中帧携带命中根索引 `"root": <idx>`，文件路径相对各自根；`root=<n>` 限定单根时
  帧不带 root 字段（此时才允许携带 `path`）。
- **SSE 变更推送**：多根部署的 `changed` 帧按根分组下发，每帧带 `"root": <idx>`；
  单根帧形状不变。
- **health 宣告**：多根部署 `GET /api/health` 附 `roots: <根数量>`（仅数量，不暴露
  根路径）；单根省略该字段。

根之间应是相互独立的目录：嵌套根（根 B 在根 A 内）的路径归属按索引序取首个命中
前缀，B 内路径会被归到 A——请避免嵌套。

跨文件搜索依赖 ripgrep（rg）——**可选**：缺失时自动降级系统 grep（功能差异：无大文件跳过、结果顺序不保证、正则为 ERE 方言、无列定位）；两者皆缺时搜索退回浏览器内执行。`GET /api/health` 经 `searchEngine` 字段宣告实际引擎。

## 局域网使用

```bash
./server/target/release/vviewer serve --root /path/to/data --web-dist apps/web/build \
  --allow-lan --token-gen
# 启动即打印随机令牌，如：a1b2c3…（64 位 hex）
```

其他设备访问 `http://<本机IP>:8321`，连接时填该地址 + 令牌。
`--allow-lan` 不配 token 会拒绝启动——局域网暴露必须鉴权。

## 纯 API 模式（前端托管在别处）

前端已经部署在静态站点（如 `https://viewer.example.com`）时，server 只出 API：

```bash
./server/target/release/vviewer serve --root /path/to/data --cors-origin https://viewer.example.com --token-gen
```

`--cors-origin` 填前端站点的精确 origin（协议+域名+端口）。前端 TopBar 里填本服务地址连接。

## systemd 常驻

```ini
# /etc/systemd/system/vviewer.service
[Unit]
Description=vviewer file server
After=network.target

[Service]
User=viewer
ExecStart=/opt/vviewer/vviewer serve --root /srv/vviewer-data --web-dist /opt/vviewer/web --token-gen
Restart=on-failure
NoNewPrivileges=true
ProtectSystem=strict

[Install]
WantedBy=multi-user.target
```

`--token-gen` 每次重启换新令牌（journal 里查）；要固定令牌见 server/README.md 的
Environment 传参写法。

## 日志与轮转

默认日志走 stdout（tracing 格式化）。默认过滤 `info,notify=error`：notify crate
的扫描 WARN（如数据根存在指向外部的 symlink、权限不足目录时的轮询报错）默认
静默，需要排查时用 `RUST_LOG` 覆盖：

```bash
RUST_LOG=info,notify=warn ./server/target/release/vviewer serve --root /path/to/data
```

长时间常驻二选一：

1. **systemd/journald（推荐）**：日志进 journald，自带大小上限与轮转
   （`journald.conf` 的 `SystemMaxUse` 等）；
2. **`--log-file <PATH>`**：服务端直接写文件，超过 10MB 自动滚动为
   `<PATH>.old`（单备份覆盖式）。

⚠️ 不要用 `nohup … > file 2>&1` 裸重定向到文件：无轮转无上限。数据根内存在
越界 symlink / 不可读目录时，旧版本曾出现日志无界增长与 CPU 空转（BUG-68，
2026-10-10 已修复并默认过滤 notify 扫描告警）；即便修复后，裸重定向也使任何
未预期的日志增长直达磁盘。已知残留：root 内真实不可读目录（非 symlink）仍会
使 inotify 建监听失败并降级轮询——日志已被默认过滤与限频约束为有界，但轮询
扫描本身按树大小消耗 CPU。

## 常见问题

**连接提示「鉴权失败：令牌缺失或错误（HTTP 401）」**
服务器配了 `--token`/`--token-gen`，连接时必须填同样的令牌。`--token-gen` 的令牌在启动
stdout（systemd 下在 journal：`journalctl -u vviewer | grep -E '^[0-9a-f]{64}$'`）。

**连接提示「无法连接 …：网络错误或地址不可达」**
地址写全 `http://IP:端口`；确认服务在跑（`curl http://127.0.0.1:8321/api/health` 应返回
JSON）；跨设备访问检查防火墙放行端口。地址不带 scheme 会自动补 `http://`。

**目录树为空或看不到隐藏文件**
`--hidden` 会隐藏 dot 开头文件；默认显示全部。树为空检查 `--root` 是否指对目录。

**浏览器控制台 CORS 报错、连接不上**
前端与 server 不同源（静态托管 vs API）时，server 必须加
`--cors-origin <前端完整origin>`；同源部署（`--web-dist`）不需要。

**文件改了但页面没自动刷新**
自动刷新依赖 inotify（Linux）。网络文件系统（NFS/SMB 挂载目录）上 watcher 收不到事件，
刷新需手动重开 tab；root 目录本身被删后 watcher 失效，重启服务恢复。watcher 故障期间
服务器会推送 `watch-degraded` 降级帧（PollWatcher 轮询续推 changed）、恢复后推
`watch-recovered`，不再使用旧 `watch-error` 帧。

**升级/重新部署后高亮或离线行为异常（白屏、高亮全走 hljs、无 .wasm 请求）**
浏览器可能残留旧版本 Service Worker：旧 SW 与新构建产物失配时会静默吞掉全部运行时
路由（precache 有 html 键缺失的历史版本尤其如此）。**升级部署后请对站点做一次硬刷新
（Ctrl+Shift+R），异常仍存则在 DevTools → Application → Storage 清除站点数据后重开**。
干净环境下本地 tree-sitter 主路径已验证正常（复测记录见 docs/e2e/code-highlight-degrade.md §5）。

**Windows 上路径带 `\` 会怎样**
路径校验按 `/` 分段，`\` 不是分隔符：`..\` 穿越形态经 canonicalize 越界校验一律 403；
Windows 主机上合法反斜杠路径 canonicalize 正常解析返回 200；POSIX 主机上 `\` 按字面
文件名处理得 404。建议统一用 `/` 或直接从目录树点击导航。

**安全边界**
服务只读；路径穿越（`../`、编码绕过、symlink 出 root）一律 403。但请理解：给谁 token
就等于把 `--root` 下所有文件（含 `--hidden` 隐藏项）读权限交给他；TOCTOU 窗口在多用户
主机上不可忽略，敏感环境请用专用低权限账户运行。

## ADR：不做 RustEmbed 内嵌前端产物（M7 收官裁决）

**背景**：发布物当前为 `vviewer` 二进制 + `apps/web/build/` 静态目录（`--web-dist` 指定）。
社区常见做法是用 `rust-embed`/`include_dir` 把前端产物编译进二进制，得到真正的"单文件"分发。

**裁决：不做。** 理由：

1. **`--web-dist` 已满足单二进制分发语义**。发布即"一个可执行文件 + 一个静态目录"两个
   产物，拷贝/打包成本与单文件方案无实质差异；真正追求单文件的场景（如 curl | sh 一把梭）
   不是本项目的目标形态。
2. **内嵌引入构建顺序耦合**。cargo build 需要前置 `pnpm build`（产物进入编译期资源），
   `pnpm build:all` 的两步顺序从"约定"升级为"硬依赖"；开发期每次改前端都要重编 Rust 才能
   在二进制里看到效果（或引入 debug 期双路径读取逻辑），构建系统复杂度净增。
3. **收益面窄**。grammar wasm（lite 集 34 个 + 全量集，构建期生成）、libarchive wasm 等运行时资产本就无法全部内嵌
   （体积与按需加载设计），内嵌只省"拷贝一个目录"，改善有限。

**后果**：`--web-dist` 保持唯一前端挂载通道；未来若出现明确的单文件分发需求（如单文件
Demo 发布），再评估 include_dir 仅内嵌 index.html 占位页的折中方案。
