# 设计：目录挂载增强（S3/WebDAV、双端配置、直连/代理、目录管理页）

- 日期：2026-10-19
- 状态：已评审（brainstorm 确认，待实施）
- 关联：`2026-10-11-workspace-tabs-design.md`（多根/rootIndex/basePath 机制）、`2026-10-12-io-streaming-design.md`（!rangeCapable 全量切片通道）、多端发布 spec（**HttpTransport 接缝为 wasm-on-workers 复用预留**：worker 侧以 fetch binding 实现 same trait）、字体系统 spec（IndexedDB 版本迁移排序协同）

## 1. 背景与目标

现状：服务端仅本地文件系统根（`--root` 多值，`AppState.roots: Vec<RootSpec>`），前端来源为 localfs/localfiles/remote/url/single/zip 六类；S3/WebDAV 完全不支持。

目标：S3 与 WebDAV 作为附加只读目录；后端配置（TOML）与前端配置（目录管理页）双入口；前端配置可选**前端直连**或**后端代理**两种访问方式；目录管理页聚合展示三类来源（服务端配置 / 前端配置 / FS Access 授权）。

### 已拍板的决策（brainstorm 记录）

| 决策点 | 结论 |
| --- | --- |
| 后端配置载体 | **TOML 配置文件**（`--config`），`[[mount]]` 节；凭据不进 CLI/env（ps 可见面）；服务端首次引入配置文件机制 |
| 代理挂载持久性 | **运行时注册**（内存态，重启失效）；前端 IndexedDB 记住自己的代理挂载，连接后对账重注册——服务端无状态、凭据不落服务端盘 |
| 直连凭据 | **IndexedDB 明文 + 管理页警示**；S3 需 bucket CORS 配置，WebDAV 直连大概率被 CORS 拦（UI 预检提示） |
| 复用约束（承接多端发布 spec） | 存储后端 HTTP 客户端走 `HttpTransport` trait 接缝（native=reqwest 实现；worker=wasm fetch 实现），S3 签名手写 SigV4（不引 object_store 等不可 wasm 化依赖） |
| 只读 | 全部挂载只读（vviewer 只读查看器语义），无写路径 |

### 非目标

- 不做写操作（上传/删除/改名）。
- 不做 S3 事件通知→watch（无推送面；挂载根 watch 能力=false）。
- 不做挂载根服务端搜索（rg 只对 fs 根；前端走既有浏览器内降级）。
- 不做凭据加密存储（IndexedDB 明文 + 警示已拍板）。
- 不做 WebDAV 集（collection）级缓存失效推送。

## 2. 阶段一：服务端存储抽象（vviewer-storage crate）

- 新 crate `server/storage`（workspace member）：`StorageBackend` trait——`list_dir(path) -> Vec<Entry{name, kind, size, mtime}>`、`read_range(path, Option<Range>) -> 字节流`、`stat(path)`、能力位 `{watch: bool, search: bool}`；全异步、只读。
- **LocalFs 实现**：现有 routes/file.rs、tree.rs 的 fs 遍历与 Range 读取下沉迁移（路由层改按根分发到 backend，行为零变化——纯重构，既有测试锁死）。
- **S3 实现**：手写 SigV4（AWS 官方测试向量校验）+ ListObjectsV2 `delimiter=/` 映射目录语义（CommonPrefixes=子目录、Contents=文件）；prefix 即挂载子路径；path-style 请求（MinIO/R2/主流 S3 兼容面），配置可切 virtual-hosted。
- **WebDAV 实现**：PROPFIND Depth:1 解析 multistatus（轻量 XML 提取，不引重解析器）+ GET；**Range 兼容防线**：部分 dav 服务器忽略 Range → 按 content-length 与请求窗校验，不符标记该根 `rangeCapable=false`，前端走 io-streaming 既有全量切片通道。
- **HttpTransport trait 接缝**：`async fn execute(method, url, headers, body) -> Response`；native 接线 = reqwest；**worker 侧 wasm fetch 实现留待多端发布 spec**（本 spec 只保证 trait 边界干净、不引 tokio-only 类型穿接口）。
- **TOML 配置文件**：`--config <path>`，全参数配置面见 §2.1；挂载用 `[[mount]]` 节 `{ kind='s3'|'webdav', label, endpoint, bucket, prefix, access_key_id, secret_access_key | username, password, path_style }`。

### 2.1 全参数 TOML 配置文件（审阅反馈轮扩容）

`--config` 不只承载 mount——**serve 全部既有可配置参数一并纳入**，配置文件成为完整服务端配置面（服务端首个配置文件机制由此统一落地）：

```toml
root = ["/data/docs", "/data/books"]    # 对应 --root（数组，首个为 0 号根）
web_dist = "./dist"                     # 对应 --web-dist
port = 8321                             # 对应 --port
token = "..."                           # 对应 --token（敏感项，文件权限建议 600）
allow_lan = false                       # 对应 --allow-lan
hidden = false                          # 对应 --hidden
cors_origin = "https://a.example.com"   # 对应 --cors-origin
compute = false                         # 对应 --compute
log_file = "./vviewer.log"              # 对应 --log-file

[[mount]]                               # 附加挂载（§2 原有语义）
kind = "s3"
```

- **优先级：CLI > 配置文件**——文件提供默认值，显式 CLI 参数覆盖；`--root` 为**整体替换语义**（CLI 出现任一 `--root` 即忽略文件 `root` 数组，不合并，杜绝部分覆盖歧义）。
- `--token-gen` 不进配置（动作型参数非配置值）；文件含 `token` 且 CLI 给 `--token-gen` 时按覆盖语义生成新 token。
- **未知键报错 exit 2**：拼错静默忽略是安全反模式（如 `token` 误拼致无鉴权裸奔启动）；值类型不符/必填缺失同现状 exit code 2。
- 合并后走**同一条启动校验链**（`allow_lan` 无 token 拒、CORS 通配拒、root 空拒、路径非目录拒——现有校验零改动，仅数据来源多一路）。
- README 补配置文件示例与 600 权限建议。
- worker 形态无文件系统：全参数配置文件为 **native-only**；worker 侧挂载仍走 `VV_MOUNTS` env JSON（结构对齐 `[[mount]]`，见多端发布 spec）。
- **根序**：rootIndex = fs 根（--root 依序）+ 静态挂载（配置序）；单根兼容视图不变。health 扩展：`fsRoots: N`（fs 根数边界）+ 挂载根摘要（脱敏，无凭据）；per-root 能力（watch/search）随 `GET /api/mounts` 宣告。

## 3. 阶段二：后端代理挂载 API 与前端接入

- **API**（有 token 时需 Bearer）：
  - `POST /api/mounts`：注册运行时挂载（S3/WebDAV 参数+凭据）→ 返回分配的 rootIndex；内存 `RwLock<Vec<...>>` 追加。
  - `GET /api/mounts`：列出静态+运行时挂载（**凭据永不回显**，脱敏 endpoint/bucket/label/kind/rootIndex）。
  - `DELETE /api/mounts/:index`：仅可删运行时注册项；引用它的活跃 tab 收 watch 失效帧（复用 store 释放语义）。
- **前端对账重注册**：连接服务器后拉 `GET /api/mounts` 与 IndexedDB 中本前端保存的代理挂载按配置指纹比对，缺失者自动 `POST` 重注册（幂等）；注册失败静默标记待重试（服务端无此能力时如 Pages+无后端场景降级为不可用提示）。
- **RemoteStore 复用**：挂载根即 `rootIndex ≥ fsRoots` 的 remote store，storeId/快照恢复/`&root=N` 通道全部既有机制零改动；挂载根 SSE 无 changed 帧（能力 false → watch 面板「此源不支持变更推送」态）；搜索对该根走既有 501→浏览器内降级（大目录性能注记）。
- `/api/file`、`/api/compute/*` 经 backend 分发对挂载根**自然可用**（高亮/markdown 计算无需特判）。

## 4. 阶段三：前端直连 store

- 新 store 类型：`s3direct:<hash8(config)>` / `davdirect:<hash8(config)>`，实现与 RemoteStore 同 TreeStore 接口（listChildren/read/watch）。
- **S3 直连**：TS 手写 SigV4 签名 fetch（只 GET/List，只读；不引依赖）；bucket 需配置 CORS（允许来源+GET+Range/expose 头），连接测试对 CORS 失败给出特征化错误文案（TypeError+0 字节响应→「bucket CORS 未配置或网络不可达」）。
- **WebDAV 直连**：fetch PROPFIND/GET + Basic；UI 预检明确提示服务器需配 CORS（大概率被拦，知情使用）。
- Range 不可用（不回 Content-Range/长度超请求窗）→ `rangeCapable=false` 全量切片通道（与阶段一同语义）。
- watch：不支持（能力 false 常量）。
- **凭据持久化**：IndexedDB `mounts` store `{ id, kind, mode: 'direct'|'proxy', label, endpoint, bucket, prefix, username, secret, createdAt }`；管理页明文警示（浏览器存储可被同源脚本与本机用户提取）；DB 版本与字体系统 spec 的 fonts store 迁移**协同顺延**（实施时先落地者为 v3，后者 v4，两侧 spec 注记）。

## 5. 阶段四：目录管理页

- 全屏 overlay（TopBar 入口 + `Ctrl+Alt+M`，与工作区面板同交互模型）；三组展示：
  1. **服务端根与挂载**：fs 根（rootPaths 若宣告）+ 静态挂载（config）+ 运行时代理挂载——只读展示（kind/label/endpoint 脱敏/rootIndex/能力徽标），操作：「在树中打开」（addDirStoreTab 指定 rootIndex）。
  2. **前端配置挂载**：IndexedDB 列表（direct/proxy 徽标、kind、endpoint、凭据已存指示、健康态）——操作：新增（kind→参数表单→测试连接→保存）/编辑/删除/测试/打开；proxy 项显示「已注册 rootIndex=N / 待注册」状态。
  3. **本机授权来源**：localfs 句柄（名称+授权状态）与 localfiles 会话来源——操作：打开/清除句柄（清除后快照 localfs 恢复随之失效，提示）。
- 新增/编辑表单按 kind 切换字段集，必填校验 + 「测试连接」实际发一次 list_dir 探测并回显根条目数与延迟。
  - 勘误（终审 I-4）：「list_dir 探测」的字面语义（服务器出口探测）与实现不符——direct 与 proxy 的「测试连接」同为**浏览器侧探测**（直接打目标 endpoint：S3=ListObjectsV2 / WebDAV=PROPFIND，与直连挂载打开后同一条链路）。对 proxy 记录，浏览器 CORS 拦截会把「代理链路可用」误报为不可用（目标可达性≠浏览器可达性）；代理链路的真实可用性以服务器出口为准（保存注册后由对账健康探测覆盖，§3）。UI 在 proxy 模式表单固定渲染该边界文案。
- proxy 挂载增删即时调 `POST/DELETE /api/mounts`；失败不落 IndexedDB（保持一致态）。

## 6. 安全注记

- 服务端三条纪律：挂载凭据不进 tracing 日志、不进 health/mounts 回显、不进错误信息（上游 S3/dav 错误脱敏转译）。
- TOML 文件权限建议 600 写入 README；运行时注册凭据仅内存。
- 直连凭据警示文案固定出现在新增表单与列表项详情。

## 7. 测试

- Rust 单测：SigV4 AWS 官方向量、S3 list→tree 映射（delimiter/CommonPrefixes 边界）、dav multistatus 解析（含编码路径/集合尾斜杠）、Range 防线判定、全参数 TOML 解析与校验（CLI>文件优先级合并/`--root` 整体替换/未知键报错/`--token-gen` 覆盖/合并后统一校验链）、HttpTransport mock 三后端全接口——**trait 接缝使 mock 无需真实网络**。
- Rust 集成：LocalFs 下沉迁移后既有 file/tree/watch 测试全绿（行为零变化锚）。
- 前端单测：直连签名向量、凭据 CRUD 与版本迁移、对账重注册幂等、`rangeCapable=false` 切片通道。
- e2e：mock S3（本地伺服最小 S3 语义）/mock dav 伺服下管理页三组增删改查、代理挂载注册→重连幂等→删除失效帧、直连 CORS 失败文案、挂载根打开/浏览/高亮/compute 链路、watch 不可用提示。
