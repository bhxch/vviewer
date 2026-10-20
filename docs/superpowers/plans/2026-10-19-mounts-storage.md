# 目录挂载阶段一：服务端存储抽象与全参配置 Implementation Plan（spec §2+§2.1）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** vviewer-storage crate（StorageBackend trait + LocalFs/S3/WebDAV 三实现 + HttpTransport wasm 接缝）；`--config` TOML 全参配置文件（serve 全参数+[[mount]]，CLI>文件、未知键报错）；根装配 fs 根+静态挂载，路由按根分发。

**Architecture:** 新 crate `server/storage`（workspace member）；`StorageBackend` trait（list_dir/read_range/stat+能力位）与 `HttpTransport` trait（method/url/headers/body→Response——native=reqwest 实现，wasm fetch 留多端发布 spec）；S3=手写 SigV4+ListObjectsV2 delimiter=/；WebDAV=PROPFIND Depth:1 multistatus 轻解析+GET。LocalFs 从 routes/file.rs、tree.rs 下沉迁移（行为锁=既有 cargo 测试全绿零改动）。配置文件解析为新 `server/src/config.rs`。

**Tech Stack:** reqwest（既有依赖面内新增 transport 实现用）、percent-encoding（S3 key 编码）、hmac/sha2（SigV4）、手写 XML tag 扫描（不引解析器）。

**Spec:** `docs/superpowers/specs/2026-10-19-directory-mounting-design.md` §2+§2.1

## Global Constraints

- 只读：StorageBackend 无写路径；能力位 `{ watch: bool, search: bool }` 仅 LocalFs=true。
- S3：SigV4（AWS 官方向量校验）；ListObjectsV2 `delimiter=/`（CommonPrefixes=子目录）；path-style URL（`{endpoint}/{bucket}/{key}`）；prefix=挂载子路径。
- WebDAV：PROPFIND Depth:1；**Range 防线**——GET 响应 length/content-range 与请求窗不符时该挂载标记 rangeCapable=false（前端走既有全量切片通道）；集合尾斜杠语义（collection 有尾斜杠）。
- HttpTransport trait 接缝纯 HTTP 语义：**不得让 tokio/hyper 类型穿接口**（多端发布 spec 的 wasm 复用前提）。
- TOML 配置（§2.1）：全参数 root/web_dist/port/token/allow_lan/hidden/cors_origin/compute/log_file + [[mount]]；**优先级 CLI>文件**；`--root` 整体替换不合并；`--token-gen` 不进配置；**未知键报错 exit 2**；合并后走同一条启动校验链（allow_lan 无 token 拒/CORS 通配拒/root 空拒/路径非目录拒）。
- worker 形态 VV_MOUNTS env JSON 为 native-only 配置文件的对应物（多端发布 spec），本计划不实现 env 侧。
- 每任务原子提交；cargo 测试勿与 vitest 并发；实现细节冲突以 spec 为权威。

---

### Task 1: TOML 全参配置文件

**Files:**
- Modify: `server/Cargo.toml`（+toml crate）
- Create: `server/src/config.rs`（解析/合并/校验前置）
- Modify: `server/src/main.rs`（--config 参数与合并链）
- Create: `server/src/config.rs` mod tests

**Interfaces:**
- Produces: `pub struct FileConfig { root: Vec<String>, web_dist: Option<String>, port: Option<u16>, token: Option<String>, allow_lan: Option<bool>, hidden: Option<bool>, cors_origin: Option<String>, compute: Option<bool>, log_file: Option<String>, mounts: Vec<MountConfig> }`；`pub struct MountConfig { kind, label, endpoint, bucket, prefix, access_key_id, secret_access_key, username, password, path_style }`；`load_file_config(path) -> Result<FileConfig, String>`（未知键报错）；`resolve_config(cli: ServeArgs, file: Option<FileConfig>) -> Result<ResolvedConfig, String>`（合并+启动校验前置，错误消息含字段名）。
- main.rs 消费 ResolvedConfig 构造既有 ServeArgs 流（行为契约：无 --config 时零变化）。

- [ ] **Step 1: 写失败测试**（全参数解析/未知键报错含键名/类型错误报错/CLI>文件优先级矩阵[root 整体替换/token 覆盖/port 覆盖]/--token-gen 与文件 token 共存语义/空文件/文件不存在错误消息）。
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**（serde Deserialize + 手写未知键检测——serde deny_unknown_fields 对扁平结构可用则用之，[[mount]] 节单独结构；resolve 返回合并后各字段 Option 语义=CLI 显式值优先）。
- [ ] **Step 4: 跑测试确认通过 + 全量 cargo 回归**
- [ ] **Step 5: Commit** `feat(server): TOML 全参配置文件——CLI>文件优先级与未知键报错`

---

### Task 2: vviewer-storage crate 骨架 + LocalFs 下沉

**Files:**
- Create: `server/storage/Cargo.toml`（crate vviewer-storage；workspace member 声明于根 Cargo.toml workspace 或 server Cargo.toml path 依赖——按仓库现有 workspace 结构取）
- Create: `server/storage/src/lib.rs`（StorageBackend trait + Entry/MountCapabilities 类型 + HttpTransport trait + LocalFs）
- Modify: `server/src/routes/file.rs`、`tree.rs`（fs 直读改经 backend 分发——**行为锁：既有 cargo 测试全绿零改动**）
- Test: `server/storage/tests/localfs.rs`（集成：tempfile 既有先例）

**Interfaces:**
- Produces: `trait StorageBackend { async fn list_dir(&self, path: &str) -> Result<Vec<Entry>>; async fn read_range(&self, path: &str, range: Option<RangeSpec>) -> Result<ByteStream>; async fn stat(&self, path: &str) -> Result<Entry>; fn capabilities(&self) -> Capabilities; }`（async 形态以仓库现状取——server 用 tokio，trait 用 async_trait 或 RPITIT 以编译器能力定）；`Entry { name, kind: Dir|File, size, mtime }`；`LocalFs::new(root: PathBuf)`。
- 路由分发：`AppState.roots: Vec<RootSpec>` 扩展 `backend: Arc<dyn StorageBackend>`（RootSpec 现为 raw+canonical——扩展而非替换，兼容视图 root/root_canonical 恒 0 号根不变）。

- [ ] **Step 1: 写失败测试**（trait 形状编译锚 + LocalFs list_dir 语义=现有 tree 扫描输出对齐【hidden 过滤/排序/目录树形态】+ read_range 语义=现有 file Range 解析输出对齐【206 语义在路由层还是 backend 层——以现状职责划分为准：backend 返回字节流+total_size，Range 解析留路由层或下沉，取迁移改动最小者并报告】）。
- [ ] **Step 2: 确认失败**
- [ ] **Step 3: 实现**（下沉=搬移现有 fs 遍历/Range 读取代码进 LocalFs，routes 改调用——**纯重构**，diff 审查重点是搬运保真）。
- [ ] **Step 4: 跑全部 cargo 测试确认通过（行为锁全绿零改动）**
- [ ] **Step 5: Commit** `refactor(server): LocalFs 下沉 vviewer-storage——StorageBackend trait 与路由分发`

---

### Task 3: HttpTransport + S3 后端

**Files:**
- Create: `server/storage/src/s3.rs`（SigV4 + ListObjectsV2 解析 + GET）
- Create: `server/storage/src/transport.rs`（HttpTransport trait + ReqwestTransport native 实现）
- Modify: `server/storage/Cargo.toml`（+hmac/sha2/hex 或既有等价、percent-encoding；reqwest 若 server 依赖面外则加）
- Test: `server/storage/tests/s3.rs`（mock transport）

**Interfaces:**
- Produces: `S3Backend::new(cfg: S3MountConfig, transport: Arc<dyn HttpTransport>)`实现 StorageBackend；`sign_request(method, url, headers, payload, creds, region, service) -> SignedHeaders` 纯函数（向量锚）。
- mock transport：`MockTransport::with_route(method_pattern, url_pattern, responder)`——三后端测试的统一基建。

- [ ] **Step 1: 写失败测试**（SigV4 AWS 官方向量【GET object us-east-1 经典例】逐 header 断言；ListObjectsV2 响应 XML→Entries 映射【Contents/CommonPrefixes/Delimiter/prefix 拼接】；list_dir 分页 marker 透传；GET Range 请求头与响应流；错误映射【403/404→Error 语义】）。
- [ ] **Step 2: 确认失败**
- [ ] **Step 3: 实现**（SigV4 规范请求：canonical uri percent-encode key、canonical query 排序、canonical headers 排序、payload hash、authorization header；ListObjectsV2 `list-type=2&delimiter=/&prefix=…&continuation-token=…`；XML 提取只认 `<Contents><Key>…</Key><Size>…</Size></Contents>` 与 `<CommonPrefixes><Prefix>…</Prefix>` 字面结构——svgbob 教训：对上游固定格式做字面结构解析并注释版本耦合）。
- [ ] **Step 4: 跑测试确认通过**
- [ ] **Step 5: Commit** `feat(storage): HttpTransport 接缝与 S3 后端——SigV4/ListObjectsV2/Range`

---

### Task 4: WebDAV 后端

**Files:**
- Create: `server/storage/src/webdav.rs`
- Test: `server/storage/tests/webdav.rs`（mock transport）

**Interfaces:**
- Produces: `WebDavBackend::new(cfg: WebDavMountConfig, transport)`实现 StorageBackend；PROPFIND Depth:1 multistatus 轻解析（`<d:response>`/`<D:response>` 命名空间双形态+href 解码+集合尾斜杠判定）；Range 防线判定（响应长度>请求窗或无 Content-Range 时 rangeCapable 降级标记）。

- [ ] **Step 1: 写失败测试**（multistatus 解析：命名空间前缀两形态/文件与集合区分【尾斜杠+resourcetype】/href percent 解码/中文路径；Range 防线：忽略 Range 全量响应→降级标记；GET with Range 头）。
- [ ] **Step 2: 确认失败**
- [ ] **Step 3: 实现**
- [ ] **Step 4: 跑测试确认通过**
- [ ] **Step 5: Commit** `feat(storage): WebDAV 后端——PROPFIND 解析与 Range 防线`

---

### Task 5: 根装配与挂载接入

**Files:**
- Modify: `server/src/state.rs`（RootSpec 扩展 backend/挂载元信息；mounts 运行时容器预留【阶段二用，本任务仅静态挂载】）
- Modify: `server/src/main.rs`（FileConfig.mounts → 后端构造接入装配链）
- Modify: `server/src/routes/health.rs`（fsRoots 字段+挂载根摘要【脱敏 endpoint/bucket/label/kind】——spec §2 health 扩展；本计划先落 fsRoots+count，per-root 能力宣告在阶段二 API 任务）
- Modify: `server/src/routes/tree.rs`、`file.rs`（rootIndex 路由到对应 backend——Task 2 已有分发骨架）
- Test: 集成（server/tests/ 新 mounts 文件——mock transport 注入 AppState？AppState 构造接受 backend 注入点【测试可注入 MockTransport 构造的 S3】——按 AppState 既有 with_* builder 模式加 with_mounts）

**Interfaces:**
- Produces: 根序=fs 根+静态挂载序；`/api/tree|file?root=N` 对 N≥fsRoots 走挂载 backend；health.fsRoots。

- [ ] **Step 1: 写失败测试**（集成：--config 含 s3 mount【mock transport】→ tree 查询挂载根返回 S3 列表/file Range 读取/错误降级；fs 根行为零变化回归）。
- [ ] **Step 2: 确认失败**
- [ ] **Step 3: 实现**
- [ ] **Step 4: 跑全部 cargo 测试确认通过**
- [ ] **Step 5: Commit** `feat(server): 根装配接入挂载后端——fsRoots 宣告与按根分发`

---

### 实施风险与裁决预留

- async trait 形态（async_trait crate vs RPITIT）——以工具链能力与仓库风格定，报告记录。
- LocalFs 下沉的职责划分（Range 解析在路由层 or backend 层）——取迁移改动最小者，报告记录。
- sigV4 的 payload hash 对 GET 为空串 SHA256——向量锚定。
- layout-rs/svgbob 教训：对上游 crate/服务的输出格式做字面结构解析时，单测锚定格式样本并注记版本耦合。
- reqwest 是否已在依赖面——rg 后定；HttpTransport 的 native 实现若 reqwest 未在用则引入为 storage crate 依赖（wasm 复用前提：trait 干净即可，native 实现允许用 reqwest）。
- Cargo.lock 增量（svgbob 前科 +727 行）——如实提交。
