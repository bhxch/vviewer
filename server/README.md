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
| `GET /api/health` | 免 | 能力发现：`{"name":"vviewer","version":"…","capabilities":["file-server"]}`；`--compute` 时 capabilities 追加 `"compute"` 并宣告 `computeLanguages`（服务端高亮支持的 canonical 语言排序清单，客户端 auto 策略据此路由：server-served 文件不限大小走服务端高亮、本地来源 >2MB 恒本地分块，语言未在宣告集合内时 auto 零请求直落本地；显式 remote 不做集合门控） |
| `GET /api/tree?path=` | Bearer | 单层目录列表 `{entries:[{name,kind,size?,mtime?}]}`；目录优先 + 名称自然排序 |
| `GET /api/file?path=` | Bearer | 文件内容（支持 `Range: bytes=a-b`，206/416）；响应头 `X-VV-Lang`（helix 语言名）/`X-VV-Encoding`（utf-8/utf-16le/utf-16be/gb18030）为服务端检测结果 |
| `POST /api/ticket` | Bearer | 签发一次性 SSE 票据（30s 过期），供 EventSource 无法自带请求头时走 `?ticket=` 升级 |
| `GET /api/events?ticket=` | ticket | SSE 变更推送：`data: {"type":"changed","paths":[…]}`（相对 root，500ms debounce 聚合）；15s 心跳；watcher 建立失败降级为一条 `{"type":"watch-error"}` |

## 响应压缩

`/api/compute/*` 响应按 `Accept-Encoding` 协商 gzip（`CompressionLayer`，BUG-10：highlight
intervals 可达十余 MB）；file/tree 等 Range 流端点不压缩——压缩会破坏字节区间语义。

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

## 资产分发：grammar wasm 三层解析链

前端 grammar 资产按 **同源 → 服务端 → CDN** 三层逐层 fetch 各自的
`grammars/manifest.json` 并 first-wins 合并（同名语言以更近层为准；单层失败仅
console.warn 跳层，不阻塞其余层。实现：`apps/web/src/lib/grammarLayers.ts`，spec §3）：

| 层 | base | 说明 |
|---|---|---|
| 同源 | `<页面源>/grammars/` | 页面部署自带的资产（如 GitHub Pages 上的 lite 集），恒在 |
| 服务端 | `<serverBase>/grammars/` | 本服务伺服：`--web-dist` 目录下的 `grammars/`（manifest.json 与 *.wasm **同目录**）。默认 web 构建仅含 lite 集；把全量 wasm 集（CI `grammar.yml` 的 `grammar-wasm` artifact，或 npm 包解包出的 `grammars/`）放入该目录即可升级本层语言覆盖 |
| CDN | jsdelivr npm 包 | 构建期注入（`VV_GRAMMAR_CDN`，以 `/grammars/` 结尾），形态 `https://cdn.jsdelivr.net/npm/<scope>/vviewer-grammars-full@<version>/grammars/` |

- **服务端层为连接时快照**：客户端只在启动时读一次「上次成功连接」的会话记录
  （sessionStorage `vviewer-last-server`）——会话中新连接的服务器不进入资产链，
  刷新页面生效（compute 路由为实时读取，与此不同）。
- **跨源组合必配 `--cors-origin`**：前端静态托管（Pages 等）+ 远程本服务时，浏览器对
  `<serverBase>/grammars/manifest.json` 与 `*.wasm` 的跨源 fetch 须 CORS 放行。CORS
  层作用于全部路由（含 `--web-dist` 静态文件），配精确页面源即可；缺配时服务端层整体
  跳过（console.warn 留痕），同源/CDN 层不受影响：
  `vviewer serve --root … --web-dist … --cors-origin https://<pages-host>`。
- **npm 发布运营清单（首次发布前一次性准备）**：
  1. 仓库 variable `NPM_SCOPE`（带 `@` 前缀，如 `@vviewer`）——release `web` / `publish-npm`
     两 job 的总开关，未配置时 npm 发布与 CDN 注入整体跳过（不影响其余 release 产物）；
  2. 仓库 secret `NPM_TOKEN`（npm automation token，publish 步注入 `NODE_AUTH_TOKEN`）；
  3. 首发走 tag：`publish-npm` 挂在 push `v*` 触发的 release 流程上（`npm view` 幂等门，
     已发布版本自动跳过可重跑）；GitHub Pages 的 CDN 注入仅 tag 构建生效（main 构建
     不注入，避免 jsdelivr `@main` 404 白打请求）。

## 构建前置（grammar 源树）

`cargo build` / `cargo test` 在构建期以源码编译全部 grammar（build.rs + cc/FFI，非
crates.io 预编 crate），需要先备好语法源树（一次性：全量 301 仓浅取，约 3-4GB 磁盘）：

```bash
node tools/grammar-builder/build.mjs --fetch
```

- 源树落在 `tools/grammar-builder/out/grammars/`（build.rs 默认读取位置）；源已存在时
  增量跳过，CI 由 `.github/actions/setup-grammars` 三层缓存覆盖。
- 源树位置可用环境变量 `VV_GRAMMAR_SOURCES` 覆盖（绝对路径或相对 server crate 路径）。
- **partial 构建语义**：源缺失的语言跳过编译、不阻塞构建（本地开发友好），但对应语言
  运行时 `/api/compute/*` 请求返回 400 unsupported language；CI 全源环境以
  `GENERATED_COUNT==301` 门禁收口（`full_registry_count_is_301`）。

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
