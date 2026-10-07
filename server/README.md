# vviewer server

Rust + axum 实现的本地文件服务器（M5 档 1：file-server 能力）。把一个目录通过 HTTP
暴露给 vviewer 前端（或任何 HTTP 客户端）：目录树、Range 文件流、服务端语言/编码检测、
SSE 变更推送、Bearer token 鉴权与路径安全。全部接口只读。

## 快速开始

```bash
# 前端构建产物（--web-dist 指定后直接浏览器访问；省略则仅提供 API）
pnpm build

# 编译并启动（默认 127.0.0.1:8321，免鉴权）
cargo build --release --manifest-path server/Cargo.toml
./server/target/release/vviewer serve --root ./samples/m5 --web-dist apps/web/build
# 打开 http://127.0.0.1:8321 → TopBar「连接服务器」→ 输入地址连接
```

## CLI 参数

`vviewer serve <参数>`（子命令 `serve`；`--help` 查看内建帮助）：

| 参数 | 默认 | 说明 |
|---|---|---|
| `--root <DIR>` | （必填） | 要暴露的根目录；不是目录则拒绝启动（exit 2） |
| `--web-dist <DIR>` | 无 | 前端构建产物目录（SvelteKit adapter-static 的 `build/`），挂载于 `/`，未知路径 SPA fallback 到 index.html；省略时 `/` 返回占位页（纯 API 模式） |
| `--port <N>` | `8321` | 监听端口 |
| `--token <T>` | 无 | 访问令牌；请求需带 `Authorization: Bearer <T>`（constant-time 比较）。空串拒绝启动 |
| `--token-gen` | — | 生成随机 32 字节 hex 令牌，打印到 stdout 后启用鉴权（与 `--token` 互斥） |
| `--allow-lan` | — | 绑定 `0.0.0.0`（局域网可访问）；**必须**同时配置 `--token`/`--token-gen`，否则拒绝启动（exit 2） |
| `--hidden` | — | 目录列表隐藏 dot 开头条目（默认显示全部） |
| `--cors-origin <URL>` | 无 | 允许来自该精确 origin 的跨域 API 访问（见下文 CORS）；省略时不加 CORS 层 |

配置错误一律 exit code 2 并输出 `error: ...`（空 token、`--allow-lan` 无 token、root/web-dist 不存在、端口占用等）。

## HTTP API（5.10 档 1）

| 端点 | 鉴权 | 说明 |
|---|---|---|
| `GET /api/health` | 免 | 能力发现：`{"name":"vviewer","version":"…","capabilities":["file-server"]}` |
| `GET /api/tree?path=` | Bearer | 单层目录列表 `{entries:[{name,kind,size?,mtime?}]}`；目录优先 + 名称自然排序 |
| `GET /api/file?path=` | Bearer | 文件内容（支持 `Range: bytes=a-b`，206/416）；响应头 `X-VV-Lang`（helix 语言名）/`X-VV-Encoding`（utf-8/utf-16le/utf-16be/gb18030）为服务端检测结果 |
| `POST /api/ticket` | Bearer | 签发一次性 SSE 票据（30s 过期），供 EventSource 无法自带请求头时走 `?ticket=` 升级 |
| `GET /api/events?ticket=` | ticket | SSE 变更推送：`data: {"type":"changed","paths":[…]}`（相对 root，500ms debounce 聚合）；15s 心跳；watcher 建立失败降级为一条 `{"type":"watch-error"}` |

## 安全注意事项

- **token**：无 token 配置时全部放行——仅在接受「本机其他用户可读」时使用（默认绑定
  127.0.0.1）。对外暴露必须配 `--token` 或 `--token-gen`；`--allow-lan` 无 token 会拒绝启动。
- **路径安全**：`path` 参数拒绝绝对路径与 `..` 段；canonicalize 后越出 root 一律 403
  （含 symlink 指向 root 外的情形；root 内互相 symlink 可用）。已知接受的风险：
  canonicalize 与打开文件之间存在 TOCTOU 窗口（单用户只读场景可接受，多租户不可用此模式）。
- **symlink**：root 内目录被软链出 root 时，链上路径 403；watch（notify）不跟随出 root 的
  symlink。root 目录本身被删后 watcher 静默失效（已知限制，恢复需重启服务）。
- **只读**：全部接口只读；SSE 只推送变更通知，不含内容。
- **ticket**：一次性、30s 过期、仅用于 SSE 升级；被消费后立即失效，重放无效。

## CORS：纯前端静态托管连后端

前端可以不部署在本服务上（如静态托管在对象存储/Nginx），运行时在 TopBar 填后端地址连接。
此时浏览器跨源，需要后端放行：

```bash
vviewer serve --root /srv/data --cors-origin https://viewer.example.com --token-gen
```

- `--cors-origin` 为**精确 origin**（协议+域名+端口），命中才回显 `Access-Control-Allow-Origin`；
  放行方法 GET/POST 与 `Authorization`/`Content-Type` 头。
- 反之，前端与 server 同源部署（`--web-dist` 模式直接访问）时无需任何 CORS 配置。

## 构建说明

- `cargo build --release --manifest-path server/Cargo.toml` → 单二进制
  `server/target/release/vviewer`（发布物只需这一个文件 + 可选的前端静态目录）。
- `pnpm build`（仓库根）→ `apps/web/build/` 前端产物，用 `--web-dist` 指给 server。
  两者无构建期耦合：server 不嵌入前端资产，`--web-dist` 运行时读取，二者可独立升级。
- **RustEmbed 内嵌（后续评估项，M7）**：把 `apps/web/build` 在编译期嵌进二进制
  （`include_dir` vs `RustEmbed`，取舍：真·单文件发布 vs 每次前端改动都要重编 Rust）。
  M5 先落地 `--web-dist` 外挂模式。

## 部署示例（systemd）

```ini
# /etc/systemd/system/vviewer.service
[Unit]
Description=vviewer file server
After=network.target

[Service]
User=viewer
ExecStart=/opt/vviewer/vviewer serve --root /srv/vviewer-data --web-dist /opt/vviewer/web --port 8321 --token-gen
# --token-gen 每次启动换新令牌并打印到 journal：固定令牌场景改用 Environment 传参脚本
# ExecStart=/bin/sh -c 'exec /opt/vviewer/vviewer serve --root /srv/vviewer-data --web-dist /opt/vviewer/web --token "$VV_TOKEN"'
Environment=VV_TOKEN=change-me
Restart=on-failure
# 无需特权端口时保留 >1024；如需 80/443 建议前置 Nginx 反代而非 CapabilityBoundingSet
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/srv/vviewer-data

[Install]
WantedBy=multi-user.target
```

纯 API 模式（前端另托管）去掉 `--web-dist` 并加 `--cors-origin` 即可；只读服务，
`ProtectSystem=strict` 下不需要可写目录时 `ReadWritePaths` 可删。

## 开发

```bash
cargo test --manifest-path server/Cargo.toml   # 集成测试（tree/file/Range/安全/SSE/health）
pnpm server:dev                                # cargo run 起开发实例（root=.，:8321）
```
