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
刷新需手动重开 tab；root 目录本身被删后 watcher 失效，重启服务恢复。

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
