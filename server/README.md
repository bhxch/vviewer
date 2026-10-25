# vviewer server

Rust + axum 实现的本地文件服务器（M5 档 1：file-server 能力）。把一个目录通过 HTTP
暴露给 vviewer 前端（或任何 HTTP 客户端）：目录树、Range 文件流、服务端语言/编码检测、
SSE 变更推送、Bearer token 鉴权与路径安全。全部接口只读。

## 架构：core/adapter 分层（多端发布阶段二）

业务逻辑与 HTTP 框架分离，依赖倒置方向单向：`vviewer`（axum 适配层）→ `vviewer-core`
（`server/core/`，框架无关业务核）。core 只产出纯类型响应（`CoreResponse { status,
headers, body }`，body 为聚合字节或 chunk 流），适配层统一经 `src/adapt.rs` 重建 axum
响应；core 不依赖 axum/tower-http/notify，compute 重依赖（comrak/tree-sitter 等）仅经
`native` feature 进入（见下 feature 矩阵）——worker 形态（阶段三）可复用 core 而不拖入
native 重依赖。

| 层 | 位置 | 职责 |
|---|---|---|
| 业务核 `vviewer-core` | `server/core/src/` | 全部业务 handler：`auth`（constant-time 比较）/`health`/`tree`/`file`（MIME/编码检测+窗读取）/`mounts`（挂载配置构造+三 API 业务体）/`search`（rg/grep 探测链+NDJSON pump）/`tickets`+`events`（SSE wire 编码+驱动）/`guard`（路径安全）/`compute`（markdown/highlight/diagrams，`native` 门控）；业务状态核 `CoreState`（配置/多根容器/运行时挂载容器） |
| 适配层 `vviewer`（lib） | `server/src/` | 路由声明与 feature 门控挂载（`routes/`，每 handler 只做参数提取→core 调用→响应重建）；HTTP 语义解析（Range 家族单源在 `vviewer-core::range`，适配层仅构造 416/304 响应）；中间件（`auth.rs` 头部提取/`lib.rs` no-cache）；tower-http 层（静态 ServeDir/SPA fallback/CORS/压缩/trace）；watch 广播中心（`watch/` 目录：hub/health/recovery/inspect，notify 域） |
| 装配根（lib） | `server/src/assembly.rs`+`config.rs`（bin 薄壳 `main.rs` 仅 clap CLI 解析） | CLI/TOML 配置解析合并、启动校验链（exit 2 契约）、bind/就绪行（`VV_READY`）、tokio runtime 装配——升 lib 面可测（单测随迁 + `tests/assembly.rs` 冒烟） |

feature 矩阵（`native` 默认开启；worker 形态 `--no-default-features` 裁剪）：

| 能力 | native（默认） | `--no-default-features` |
|---|---|---|
| watch + `/api/events`（notify） | 挂载；SSE 变更推送 | `watch.rs` 编译不存在；路由不挂载（watch=false 能力缺失） |
| compute `/api/compute/*`（comrak/tree-sitter/diagrams，core 侧同 feature） | `--compute` 时挂载 + health 宣告 compute/computeLanguages/diagrams | core compute 域编译不存在（build.rs 跳过 grammar 编译）；路由不挂载；health **即使 `--compute` 也不宣告**（编译期 × 运行时双重门） |
| search `/api/search`（rg/grep，依赖仅 tokio process） | 两形态一致：core handler 恒在，health `searchEngine` 按探测链宣告；worker 侧裁剪为阶段三政策（适配层不挂路由 + 宣告另置，机制挂点在 core::health） | 同左 |
| health/tree/file/mounts/ticket/auth | 恒在 | 恒在 |

双形态门禁：`cargo test --workspace` + `cargo check --workspace --all-targets
--no-default-features`（裁剪形态含测试面编译）。

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
| `--log-file <PATH>` | stdout | 日志写文件（ANSI 关闭），超 10MB 滚动为 `<PATH>.old` 单备份；不可用则拒绝启动（exit 2） |
| `--kroki-host <URL>` | `https://kroki.io` | kroki 转发上游 host（`POST /api/kroki` 的服务端代发）。仅接受非空 `http(s)://` 绝对 URL，非法值拒绝启动（exit 2）——SSRF 防线：上游只来自部署侧配置 |

配置错误一律 exit code 2 并输出 `error: ...`（空 token、`--allow-lan` 无 token、root/web-dist 不存在、端口占用等）。

### 就绪行（VV_READY）

`serve` 绑定成功后向 stdout 输出恰好一行 `VV_READY port=<n>`（`<n>` 为实测端口，
`--port 0` 时为内核分配值；先于该行有日志输出）。1-14 收窄：仅 `--port 0`（内核
分配，桌面薄壳唯一机器消费面）输出，显式端口面向人读不再多一行。该行是协议
面（桌面壳按行首精确匹配解析），勿加前缀装饰或改格式。

## 配置文件（--config）

`vviewer serve --config <PATH>`：TOML 配置文件承载 serve 全部参数，是完整的服务端配置面：

- **优先级 CLI > 文件**：文件提供默认值，显式 CLI 参数覆盖；`--root` 为整体替换语义（CLI 出现任一 `--root` 即忽略文件 `root` 数组，不合并）。
- **未知键报错 exit 2**：拼错静默忽略是安全反模式（`token` 误拼致无鉴权裸奔启动）；值类型不符同此。
- `--token-gen` 为动作型参数不进配置；文件含 `token` 且 CLI 给 `--token-gen` 时按覆盖语义生成新 token。
- 合并产物走同一条启动校验链（`allow_lan` 无 token 拒、CORS 通配拒、root 空拒、路径非目录拒）。

```toml
# vviewer.toml —— 全参数配置面（省略的键取默认）
root = ["/data/docs", "/data/books"]    # 对应 --root（数组，首个为 0 号根）
web_dist = "./dist"                     # 对应 --web-dist
port = 8321                             # 对应 --port
token = "..."                           # 对应 --token
allow_lan = false                       # 对应 --allow-lan
hidden = false                          # 对应 --hidden
cors_origin = "https://a.example.com"   # 对应 --cors-origin
compute = false                         # 对应 --compute
log_file = "./vviewer.log"              # 对应 --log-file

[kroki]                                 # kroki 转发上游（节可选；对应 --kroki-host）
host = "https://kroki.io"               # 非空 http(s):// URL，非法值拒绝启动

[[mount]]                               # 附加挂载：S3 兼容对象存储（只读）
kind = "s3"
label = "docs"                          # 可选；工作区展示名
endpoint = "http://127.0.0.1:9000"
bucket = "b1"
prefix = "sub"                          # 可选；缺省 = 端点根
access_key_id = "ak"
secret_access_key = "sk"
path_style = true                       # 可选；缺省 true（path-style 请求）
region = "us-east-1"                    # 可选；S3 签名 region，缺省 us-east-1（台账 3-17）

[[mount]]                               # 附加挂载：WebDAV（只读）
kind = "webdav"
endpoint = "https://dav.example.com"
username = "u"
password = "p"
```

**权限建议 600**：配置文件含 `token` 与挂载凭据（S3 密钥对 / WebDAV 密码）——
`chmod 600 vviewer.toml`，凭据不进 CLI/env（ps 可见面）。运行时凭据不进日志、
health/mounts 回显与错误信息（误把凭据写进 endpoint 时展示面自动剥除 userinfo）。

## HTTP API（5.10 档 1）

| 端点 | 鉴权 | 说明 |
|---|---|---|
| `GET /api/health` | 免 | 能力发现：`{"name":"vviewer","version":"…","capabilities":["file-server","kroki-proxy"]}`；`--compute` 时 capabilities 追加 `"compute"` 并宣告 `computeLanguages`（服务端高亮支持的 canonical 语言排序清单，客户端 auto 策略据此路由：server-served 文件不限大小走服务端高亮、本地来源 >2MB 恒本地分块，语言未在宣告集合内时 auto 零请求直落本地；显式 remote 不做集合门控） |
| `GET /api/tree?path=` | Bearer | 单层目录列表 `{entries:[{name,kind,size?,mtime?}]}`；目录优先 + 名称自然排序 |
| `GET /api/file?path=` | Bearer | 文件内容（支持 `Range: bytes=a-b`，206/416）；响应头 `X-VV-Lang`（helix 语言名）/`X-VV-Encoding`（utf-8/utf-16le/utf-16be/gb18030）为服务端检测结果 |
| `POST /api/ticket` | Bearer | 签发一次性 SSE 票据（30s 过期），供 EventSource 无法自带请求头时走 `?ticket=` 升级 |
| `GET /api/events?ticket=` | ticket | SSE 变更推送：`data: {"type":"changed","paths":[…]}`（相对 root，500ms debounce 聚合）；15s 心跳；watcher 建立失败降级为一条 `{"type":"watch-error"}` |
| `POST /api/mounts` | Bearer | 注册运行时挂载（内存态，重启失效）；同指纹幂等。见下节 |
| `GET /api/mounts` | Bearer | 挂载清单（静态 TOML 段 + 运行时段 + 全量汇总，脱敏无凭据）。见下节 |
| `DELETE /api/mounts/{index}` | Bearer | 删除运行时挂载；静态项 405。见下节 |
| `POST /api/kroki` | Bearer | 图表渲染代发：`{"lang":"svgbob","source":"…"}` → `{"svg":"…"}`。上游 = `--kroki-host`（默认 https://kroki.io），lang 白名单 `[a-z0-9-]`，body 上限 1MB；转发不算计算（不要求 `--compute`），上游错误按 4xx→400/5xx→500 透传消息前 200 字节 |
| `POST /api/compute/markdown` | Bearer | Markdown → HTML 服务端整篇渲染（需 `--compute`）：`{"text":"…","options":{"wikilinks":true?}}` → `{"html":"…"}`；text 应用层上限 5MB（413），路由原始 body 闸门 6MB |
| `POST /api/compute/highlight` | Bearer | 服务端语法高亮（需 `--compute`）：`{"path?":"…","text?":"…","lang":"…","range?":[a,b],"cacheId?":"…"}` → `{"intervals":[…],"captures":[…],"baseLine":n,"cacheId?":"…"}`；text 应用层上限 20MB（413），处理超时 504；响应按 Accept-Encoding 协商 gzip |
| `POST /api/compute/diagram` | Bearer | 图表单图渲染（需 `--compute`）：`{"lang":"…","source":"…"}` → `{"svg":"…"}`。NATIVE 子集 graphviz/svgbob；非 NATIVE/渲染失败 400；body 闸门 6MB |

## 运行时挂载三 API

TOML `[[mount]]` 是启动期静态装配；三 API 在**运行时**增删内存态挂载（重启失效，
凭据不落盘）。鉴权与 tree/file 同一 Bearer 门：**有 token 时需 Bearer，无 token
部署免鉴权**（spec 字面口径；无 token 部署下的写面风险见「安全注意事项」）。

### POST /api/mounts —— 注册

```json
{
  "kind": "s3",
  "label": "docs",
  "endpoint": "http://127.0.0.1:9000",
  "bucket": "b1",
  "prefix": "sub",
  "access_key_id": "ak",
  "secret_access_key": "sk",
  "path_style": true
}
```

- body 形态与 TOML `[[mount]]` 完全一致：`kind` 必填（`s3` | `webdav`），其余
  per-kind 必填——S3 需 `endpoint`/`bucket`/`access_key_id`/`secret_access_key`，
  WebDAV 需 `endpoint`/`username`/`password`；缺必填 400（错误消息仅含字段名）；
  未知字段 4xx（防拼错键静默忽略）；**请求体上限 64KB，超限 413**。
- 成功 `201 {"rootIndex": N}`（N 自 fsRoots+静态挂载之后起算，**追加分配**：
  新项恒接在活项之后，已删索引不填充复用——见 DELETE 一节）；**同指纹重复注册
  → `200` 返回既有 rootIndex，不重复分配**（幂等，面向前端对账重注册）。指纹 =
  kind+endpoint+bucket/prefix+label（各 trim 规范化），**不含凭据**——凭据轮换
  不产生新指纹。
- `endpoint` 携带 userinfo（`http://user:pass@host`）时用于连接但展示面自动剥除；
  凭据不进清单、不进错误消息、不进日志。

### GET /api/mounts —— 脱敏清单

```json
{
  "fsRoots": 1,
  "staticMounts": [],
  "runtimeMounts": [],
  "mounts": []
}
```

- `staticMounts`：TOML `[[mount]]` 装配项（rootIndex 自 fsRoots 起算）；
  `runtimeMounts`：本 API 注册项（接在静态段之后）；`mounts`：全量汇总
  （静态 + 运行时，rootIndex 升序）——前端对账比对此段。**运行时段寻址起点 =
  `fsRoots + staticMounts.length`**（静态挂载的 rootIndex 同样 ≥ fsRoots，客户端
  区分静态/运行时归属须以该起点分界，不能单以 fsRoots 判定）。
- 条目形态 `{rootIndex, kind, label?, endpoint, bucket?, prefix, capabilities:
  {watch, search}}`；挂载根能力恒 `watch:false, search:false`。结构面即无凭据
  字段（凭据永不回显）。

### DELETE /api/mounts/{index} —— 删除

- 运行时项 `204` 并删除（**tombstone 语义，不压缩**：槽位保留置空，其余项
  `rootIndex` 不移位——删非尾项不串扰已开 tab 的旧索引；被删索引进程内恒不
  解析：`tree`/`file` 访问返回越界 400、重复 DELETE 返回 `404`、清单不含已删
  项；新注册不填充空洞，重启整体回收。引用该根的活跃 tab 下次访问自然失效，
  无静默内容串扰）；
- fs 根 / 静态 TOML 挂载 `405`（静态资源类不支持 DELETE——重启即复现，删配置
  才是真删除；响应带 `Allow: GET, POST` 头）；越界或已删 `404`。

## 响应压缩

`/api/compute/*` 响应按 `Accept-Encoding` 协商 gzip（`CompressionLayer`，BUG-10：highlight
intervals 可达十余 MB）；file/tree 等 Range 流端点不压缩——压缩会破坏字节区间语义。

## 高亮 range 协议（compute）

`POST /api/compute/highlight` 的 path 模式支持可视区分块请求（大文件懒高亮，spec
`docs/superpowers/specs/2026-10-09-full-grammar-alignment-design.md` §5.1）：

```json
// 请求：range 有值才带字段（缺省 = 整文件 text 模式，行为与旧版完全一致）
{ "path": "big.json", "lang": "json", "range": { "startLine": 1200, "lineCount": 200 } }
// 响应：intervals 为 [start, end, capture 下标] 三元组（相对 chunk 首行 baseLine
// 的 UTF-16 区间），captures 为去重捕获名表
{ "intervals": [ [ 0, 5, 0 ] ], "captures": [ "keyword" ], "baseLine": 1200 }
```

- **校验**：`lineCount ∈ 1..=5000`；range 仅接受 path 模式（`text`+`range` → 400）；
  `startLine ≥ 实际行数`（含空文件 0 行）→ 400 携带实际行数；`lineCount` 越文件尾
  自然截断 200；行号 0 基。非 UTF-8 文件 → 400（与整文件路径平价）。
- **413 上限与深窗口语义**：chunk 产出窗口的字节量超 `HIGHLIGHT_MAX_BYTES`（复用
  20MB）→ 413 `too_large`，不截断（截断会让请求窗口无声缩水）；跳行距离不受该上限
  约束——字节上限只约束产出窗口，超大文件深处的窄窗口（如 26MB 文件
  `startLine=500000` 的 10 行）正常 200。单行超长（如 >20MB 的 minified 单行）仍 413。
- **LRU 缓存**：键为 `(canonical_path, mtime_ms, size, lang, startLine, lineCount)`；
  无 range 请求占位 `(0, u64::MAX)`，与具体 range 键互不命中。10s 超时与预算机制沿用。

## 安全注意事项


- **token**：无 token 配置时全部放行——仅在接受「本机其他用户可读」时使用（默认绑定
  127.0.0.1）。对外暴露必须配 `--token` 或 `--token-gen`；`--allow-lan` 无 token 会拒绝启动。
- **运行时挂载写面（阶段二）**：`POST`/`DELETE /api/mounts` 按 spec 字面与 tree/file
  同一 Bearer 门——**无 token 部署下是免鉴权写面**（同网段未认证对端可注册/删除
  内存态挂载；缓解面：内存态重启即清零、凭据不落盘、请求体 64KB 闸门）。LAN 信任
  模型部署请自行评估；不可信网络必须配 token。
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
  3. 首发走 tag：`publish-npm` 挂在 push `v*` 触发的 release 流程上（**内容哈希去重**：
     打包时计算 `contentHash` 与线上 latest 对比——前端-only 变更零发包、复用线上
     latest 版本；grammar 资产变化才发新版本，版本号即当时的 tag）；publish 带
     `--provenance` 供应链签名（publish-npm job 持 `id-token: write`，npm 页面展示
     "Published with provenance"）；gh-pages 每次部署自解析 npm latest 注入 CDN
     （包未首发时自动缺席），发布成功后 release 会重触发一次 Pages 部署确保即时生效。

## 构建前置（grammar 源树）

`cargo build` / `cargo test` 在构建期以源码编译全部 grammar（build.rs + cc/FFI，非
crates.io 预编 crate），需要先备好语法源树（一次性：全量 301 仓浅取，约 3-4GB 磁盘）。
阶段二起 grammar 编译链随 compute 域入业务核（`server/core/build.rs`）：`--no-default-features`
（worker 形态）整体跳过 grammar 编译与 C/C++ 工具链依赖；`VV_GRAMMAR_SOURCES` 相对路径
仍以 server crate 为基准：

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

## Workers 部署（CF Workers，多端发布阶段三）

`server/worker/`（crate `vviewer-worker`）：workers-rs 适配——fetch handler→core
dispatch，与 native 共用业务核。**能力矩阵**：health/tree/file/mounts 三 API 可用
（存储唯一来源 = VV_MOUNTS 声明的 S3/WebDAV 挂载，wasm 无 fs）；`POST /api/kroki`
转发可用（上游 = VV_KROKI_HOST，缺省 https://kroki.io，health 宣告 kroki-proxy）；
watch（events）、search、compute 不挂载且 health 不宣告——前端既有逐项降级链自动
生效，无需配置。

### 部署步骤

```bash
# 1. 前端产物（assets binding 的目录源；子路径部署见下「base 约定」）
pnpm install && pnpm --filter web build

# 2. wasm 工具链（一次性）
rustup target add wasm32-unknown-unknown
cargo install worker-build

# 3. 本地冒烟（workerd 本地运行时；VV_MOUNTS 与必填 VV_TOKEN 放
#    server/worker/.dev.vars——缺 VV_TOKEN 时装配失败关闭，全部请求 500）
cd server/worker && npx wrangler dev

# 4. 部署（需 CF 账号；wrangler deploy 自动跑 [build] command）
cd server/worker && npx wrangler deploy

# 5. 体积门禁（CI 同款；<5MB 断言，产物在 server/worker/build/）
node tools/worker-budget.mjs
```

CI：`.github/workflows/deploy-worker.yml`（手动 dispatch，ref 选择器可选 tag）。
预备项——仓库 secrets：`CLOUDFLARE_API_TOKEN`（CF API token，权限 Account ·
Workers Scripts: Edit）、`CLOUDFLARE_ACCOUNT_ID`；可选 var `WORKER_URL`（canary
探活默认地址，dispatch input 可覆盖）。未配 secrets 时 deploy/canary 两步自动
跳过（web/wasm 构建与体积门禁照跑）；探活断言 `/api/health` 200 且宣告
`file-server`。

### 配置面（env var / Wrangler Secret）

| 变量 | 通道 | 说明 |
|---|---|---|
| `VV_MOUNTS` | 建议 Secret（含凭据） | 静态挂载 JSON 数组，元素与 TOML `[[mount]]` 同构（kind/endpoint/bucket/…，见「配置文件」节示例）；读取通道 var→secret 依次兜底 |
| `VV_TOKEN` | **必填** Secret | Bearer 鉴权（health 免鉴权）。缺失/空串 → worker 拒绝装配，全部请求 500——**fail-closed**（终审 I-1）：Workers 天然公网可达，「无 token」按误配置处理而非静默放行，与 native「`--allow-lan` 必须 token 否则拒绝启动」是等价精神的不同实现 |
| `VV_BASE_PATH` | var | 部署形态 base 约定，见下 |
| `VV_KROKI_HOST` | var | kroki 转发上游 host（`POST /api/kroki`；默认 `https://kroki.io`）。仅接受非空 `http(s)://` 绝对 URL，显式非法值（空白串/缺前缀）→ worker 拒绝装配（全部请求 500）——fail-closed 与 VV_TOKEN 同纪律（SSRF 防线：上游只来自部署侧配置） |

```bash
wrangler secret put VV_MOUNTS   # 粘贴 JSON 数组（凭据不入 vars/wrangler.toml/代码库）
wrangler secret put VV_TOKEN
```

### base 约定（VV_BASE_PATH 与资产面）

- **根路径部署**（workers.dev / zone 根，标准形态）：`VV_BASE_PATH` 全链留空。
- **子路径部署**：Workers Assets 按完整请求路径匹配资产，**不做前缀剥离**——
  需前置反向代理剥前缀（worker/资产面均见剥后路径）；前端构建注入
  `VV_BASE_PATH=/前缀`（与 Pages 同链：HTML 内的 `_app/`、grammars 资产引用带
  前缀，代理按前缀路由到 worker）。worker 侧 env `VV_BASE_PATH` 仅供 dispatch
  剥前缀（无剥前缀代理的 /api 面形态），资产面不支持该形态——勿混用。
- Pages（`/<repo>/` 子路径）是 Pages 平台原生挂载，与 worker 形态互不适用。

### 资产纪律（C1 SPA-fallback 前科）

`wrangler.toml` 的 assets binding：命中资产平台直出（worker 不经手）；缺失路径
进 worker 分流——`.wasm`/`.scm`/`.mjs`/`.css` 缺失 **404 不回 HTML**（终审 C1：
query loader 只查 res.ok 误载 HTML → tree-sitter 静默降级 hljs；native 侧
`serve_index` 为 `.scm`/`.wasm` 双层修之 server 层，worker 侧取计划纪律全集）；
其余缺失路径回 index.html（SPA fallback，`cache-control: no-cache` 禁缓存，
native BUG-15 同款）。`run_worker_first: ["/api/*"]` 保证 API 恒经 worker。
不取 `not_found_handling = "single-page-application"`：其缺失路径无条件回 200
index.html，恰为本纪律要防的形态。

## 开发

```bash
cargo test --manifest-path server/Cargo.toml   # 集成测试（tree/file/Range/安全/SSE/health）
pnpm server:dev                                # cargo run 起开发实例（root=.，:8321）
```
