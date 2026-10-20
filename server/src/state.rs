//! 共享应用状态与 ticket 存储。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Deserialize;
use vviewer_core::state::CoreState;
use vviewer_storage::display_endpoint;
use vviewer_storage::s3::{S3Backend, S3MountConfig};
use vviewer_storage::transport::{HttpTransport, ReqwestTransport};
use vviewer_storage::webdav::{WebDavBackend, WebDavMountConfig};
use vviewer_storage::StorageBackend;

use crate::generate_token;

// 业务数据类型随 Task 1 core 抽取迁入 vviewer-core::state（多端发布阶段二）；
// 原 `crate::state` 路径 re-export 保持既有调用点/测试零改动。
pub use vviewer_core::state::{MountMeta, RootSpec};

/// ticket 有效期：一次性、30s 过期（SSE 升级专用）。
pub const TICKET_TTL: Duration = Duration::from_secs(30);

/// 内存 ticket 表：Arc 包裹使 AppState 克隆共享同一份。
#[derive(Clone, Default)]
pub struct TicketStore(Arc<Mutex<HashMap<String, Instant>>>);

impl TicketStore {
    /// 签发：随机 32B hex，顺带惰性清理过期项。
    pub fn issue(&self) -> String {
        self.sweep();
        let ticket = generate_token();
        self.0.lock().unwrap().insert(ticket.clone(), Instant::now() + TICKET_TTL);
        ticket
    }

    /// 一次性消费：无论有效与否都移除；过期返回 false。
    pub fn consume(&self, ticket: &str) -> bool {
        match self.0.lock().unwrap().remove(ticket) {
            Some(expiry) => expiry > Instant::now(),
            None => false,
        }
    }

    /// 惰性清理过期项（签发时触发；另有 main 内的定期 spawn 兜底）。
    pub fn sweep(&self) {
        let now = Instant::now();
        self.0.lock().unwrap().retain(|_, expiry| *expiry > now);
    }

    /// 直接注入指定过期时间的 ticket（测试专用）。
    pub fn insert_raw(&self, ticket: String, expiry: Instant) {
        self.0.lock().unwrap().insert(ticket, expiry);
    }
}

/// 挂载根装配产物（main 装配链产出、测试注入共用形态）：已构造 backend +
/// 可宣告元信息。测试可注入 MockTransport 构造的后端（[`AppState::with_mounts`]）。
pub struct MountRoot {
    pub backend: Arc<dyn StorageBackend>,
    pub meta: MountMeta,
}

impl std::fmt::Debug for MountRoot {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // backend 为 dyn 存储（无 Debug 语义），只暴露元信息面（凭据不入 MountMeta）
        f.debug_struct("MountRoot")
            .field("meta", &self.meta)
            .finish_non_exhaustive()
    }
}

// ---------- 挂载配置与后端构造（阶段二自 bin 侧 config.rs/main.rs 下沉） ----------
//
// `MountKind`/`MountConfig` 原属 bin 的 config.rs、`build_mount` 原属 main.rs：
// 运行时注册（routes/mounts.rs → [`AppState::register_mount`]）与静态 TOML 装配
// （main.rs build_mount_roots）必须消费同一构造，否则两路 backend 行为会漂移。
// 下沉 lib 后 config.rs/main.rs 转为 re-export/委托，静态装配行为零变化。

/// `[[mount]].kind` / `POST /api/mounts` 的 `kind`（spec §2：s3 | webdav）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MountKind {
    /// S3 兼容对象存储
    S3,
    /// WebDAV
    WebDav,
}

/// 挂载配置节：TOML `[[mount]]` 与 `POST /api/mounts` 请求体同一形态（spec §3：
/// body = 阶段一 MountConfig 形态）。除 `kind`（枚举，解析期把关合法值）外全部
/// 可选：per-kind 必填校验在 [`build_mount`]。
#[derive(Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MountConfig {
    pub kind: MountKind,
    pub label: Option<String>,
    pub endpoint: Option<String>,
    pub bucket: Option<String>,
    pub prefix: Option<String>,
    pub access_key_id: Option<String>,
    pub secret_access_key: Option<String>,
    pub username: Option<String>,
    pub password: Option<String>,
    pub path_style: Option<bool>,
}

/// Debug 手工实现：凭证字段脱敏（原 config.rs 实现原样下沉——FileConfig/
/// ResolvedConfig 均 derive Debug，嵌套打印配置是常见排障形态，明文凭据不得
/// 经 Debug 外泄；脱敏值保留 Some/None 存在性供排障）。非敏感字段原样。
impl std::fmt::Debug for MountConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let redacted = |v: &Option<String>| v.as_ref().map(|_| "[redacted]");
        f.debug_struct("MountConfig")
            .field("kind", &self.kind)
            .field("label", &self.label)
            .field("endpoint", &self.endpoint)
            .field("bucket", &self.bucket)
            .field("prefix", &self.prefix)
            .field("access_key_id", &redacted(&self.access_key_id))
            .field("secret_access_key", &redacted(&self.secret_access_key))
            .field("username", &redacted(&self.username))
            .field("password", &redacted(&self.password))
            .field("path_style", &self.path_style)
            .finish()
    }
}

/// 配置指纹（plan Global Constraints：kind+endpoint+bucket/prefix+label 规范化
/// 串）：字段 trim 后以单元分隔符（U+001F）拼接，直接串比较（免 hash 碰撞面）。
/// **凭据（access_key_id/secret_access_key/username/password）不入指纹**——指纹
/// 是对账键（前端 IndexedDB 持久化配置与服务端清单比对），语义是「同一挂载
/// 目标」而非「同一份凭据」。
pub fn mount_fingerprint(cfg: &MountConfig) -> String {
    let kind = match cfg.kind {
        MountKind::S3 => "s3",
        MountKind::WebDav => "webdav",
    };
    [
        kind,
        cfg.endpoint.as_deref().unwrap_or("").trim(),
        cfg.bucket.as_deref().unwrap_or("").trim(),
        cfg.prefix.as_deref().unwrap_or("").trim(),
        cfg.label.as_deref().unwrap_or("").trim(),
    ]
    .join("\u{1f}")
}

/// 挂载后端构造（spec §2/§3 共用）：MountConfig → (backend, 元信息)。per-kind
/// 必填校验在此——错误消息含字段名、不含凭据值（spec §6 错误面纪律）。静态
/// 装配（main.rs build_mount_roots，配置错误 exit 2）与运行时注册
/// （[`AppState::register_mount`]，配置错误 400）消费同一函数。
pub fn build_mount(
    cfg: &MountConfig,
    transport: Arc<dyn HttpTransport>,
) -> Result<MountRoot, String> {
    /// Option 字段必填校验（错误消息含字段名）。
    fn required<T>(field: Option<T>, name: &str, kind: &str) -> Result<T, String> {
        field.ok_or_else(|| format!("{kind} mount: missing required field `{name}`"))
    }
    match cfg.kind {
        MountKind::S3 => {
            let kind = "s3";
            let endpoint = required(cfg.endpoint.clone(), "endpoint", kind)?;
            let bucket = required(cfg.bucket.clone(), "bucket", kind)?;
            let access_key_id = required(cfg.access_key_id.clone(), "access_key_id", kind)?;
            let secret_access_key =
                required(cfg.secret_access_key.clone(), "secret_access_key", kind)?;
            let prefix = cfg.prefix.clone().unwrap_or_default();
            // path_style 缺省 true（Global Constraints 的 path-style URL 形态）
            let path_style = cfg.path_style.unwrap_or(true);
            let backend = S3Backend::new(
                S3MountConfig {
                    endpoint: endpoint.clone(),
                    bucket: bucket.clone(),
                    prefix: prefix.clone(),
                    access_key_id,
                    secret_access_key,
                    path_style,
                },
                transport,
            );
            Ok(MountRoot {
                backend: Arc::new(backend),
                meta: MountMeta {
                    kind: "s3",
                    label: cfg.label.clone(),
                    // 展示面脱敏（评审 M1）；连接面（上方 backend）用原值
                    endpoint: display_endpoint(&endpoint),
                    bucket: Some(bucket),
                    prefix,
                },
            })
        }
        MountKind::WebDav => {
            let kind = "webdav";
            let endpoint = required(cfg.endpoint.clone(), "endpoint", kind)?;
            let username = required(cfg.username.clone(), "username", kind)?;
            let password = required(cfg.password.clone(), "password", kind)?;
            let prefix = cfg.prefix.clone().unwrap_or_default();
            let backend = WebDavBackend::new(
                WebDavMountConfig {
                    endpoint: endpoint.clone(),
                    prefix: prefix.clone(),
                    username,
                    password,
                },
                transport,
            );
            Ok(MountRoot {
                backend: Arc::new(backend),
                meta: MountMeta {
                    kind: "webdav",
                    label: cfg.label.clone(),
                    // 展示面脱敏（评审 M1）；连接面（上方 backend）用原值
                    endpoint: display_endpoint(&endpoint),
                    bucket: None,
                    prefix,
                },
            })
        }
    }
}

/// 运行时注册错误分类（handler 映射 HTTP 状态）：Invalid → 400（请求侧配置
/// 缺陷：缺必填字段，消息仅含字段名）；Transport → 500（服务端 HTTP 客户端
/// 初始化失败，非请求方可修复）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RegistrationError {
    Invalid(String),
    Transport(String),
}

/// 运行时删除错误分类：Static → 405（fs 根/静态 TOML 挂载不可删——该资源类
/// 不支持 DELETE，响应补 `Allow` 头）；NotFound → 404（运行时段越界或已删
/// tombstone 空洞）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnregisterError {
    Static,
    NotFound,
}

/// 运行时挂载项（spec §3）：`POST /api/mounts` 注册的内存态挂载，重启失效
/// （服务端无状态、凭据不落盘——spec 已拍板决策）。fingerprint 无凭据面，
/// Debug 派生安全。
#[derive(Debug)]
pub struct RuntimeMount {
    /// [`mount_fingerprint`] 规范化串：幂等对账键（同指纹重注册返回既有项）。
    pub fingerprint: String,
    /// 装配产物（backend + 脱敏 meta）——root 寻址与 GET 清单共用。
    pub root: MountRoot,
}

/// 传给所有 axum handler 的共享状态（适配层面）：业务状态核 [`CoreState`]
/// （多端发布阶段二迁入 vviewer-core）+ axum 特有面。经 Deref 直达核字段
/// （`state.roots`/`state.token` 等既有调用点零改动——迁移期兼容缝，Task 2/3
/// 域抽取逐步把消费方迁到 core 后再评估收紧）。
#[derive(Clone)]
pub struct AppState {
    /// 业务状态核（vviewer-core::state）：配置/多根容器/令牌/引擎覆盖 +
    /// health 宣告缝注入面。
    pub core: CoreState,
    /// `--web-dist` 前端静态产物目录；未指定时 `/` 返回占位页。
    pub web_dist: Option<PathBuf>,
    /// `--cors-origin` 精确 origin；None = 不加 CORS 层。
    pub cors_origin: Option<String>,
    /// 运行时挂载容器（阶段二 spec §3）：`POST /api/mounts` 注册的内存态挂载，
    /// 重启失效。rootIndex = `roots.len()` + 槽位序（静态段之后的寻址段，经
    /// [`AppState::root_at`] 统一寻址）。**tombstone 容器**（`Option` 槽位）：
    /// 删除只置 `None` 不压缩——其余项 rootIndex 不移位（删非尾项不串扰已开
    /// tab），被删索引进程内恒不解析（重复 DELETE 404、tree/file 越界 400），
    /// 「删除后移位/复用索引串扰旧引用」两类窗口一并消灭；新注册不填充空洞
    /// （[`AppState::register_mount`] 追加分配），重启才整体回收。
    pub runtime_mounts: Arc<Mutex<Vec<Option<RuntimeMount>>>>,
    /// 运行时注册用的 HTTP transport（懒初始化：首次注册构建 reqwest 连接池，
    /// 全注册共享；测试经 [`AppState::with_runtime_transport`] 注入
    /// MockTransport——`AppState::new` 不付 reqwest Client 构建成本，既有测试
    /// 零影响）。私有面：仅 [`AppState::register_mount`] 消费。
    runtime_transport: Arc<Mutex<Option<Arc<dyn HttpTransport>>>>,
    /// 一次性 ticket 表（SSE 升级用）。
    pub tickets: TicketStore,
    /// root 变更广播中心（启动时创建一次，共享 watcher + debounce 聚合）。
    pub changes: Arc<crate::watch::ChangeHub>,
}

impl std::ops::Deref for AppState {
    type Target = CoreState;
    fn deref(&self) -> &CoreState {
        &self.core
    }
}

impl std::ops::DerefMut for AppState {
    fn deref_mut(&mut self) -> &mut CoreState {
        &mut self.core
    }
}

/// health `searchEngine` 宣告注入（core 依赖倒置缝的适配侧实现——rg/grep 探测
/// 链随 search 域 Task 3 收编 core 前，宣告由适配层提供；与 /api/search 消费
/// 同一选择链 [`crate::routes::search::announce_engine`]，零漂移）。
fn health_search_engine(cs: &CoreState) -> Option<&'static str> {
    crate::routes::search::announce_engine(cs.rg_path.as_deref(), cs.grep_path.as_deref())
}

impl AppState {
    pub fn new(
        root: PathBuf,
        web_dist: Option<PathBuf>,
        token: Option<String>,
        hidden: bool,
        cors_origin: Option<String>,
    ) -> Self {
        let mut core = CoreState::new(root, token, hidden);
        // health 宣告装配：版本随主 crate；两个能力缝注入适配侧实现（core 不
        // 依赖 tree-sitter/探测链——依赖倒置方向单向）
        core.version = env!("CARGO_PKG_VERSION");
        core.compute_languages = crate::compute::queries::supported_languages;
        core.search_engine = health_search_engine;
        // 多根聚合 watch：每根一个 watcher 线程（单根即历史单 watcher 形状）
        let canonicals: Vec<PathBuf> = core.roots.iter().map(|r| r.canonical.clone()).collect();
        Self {
            core,
            web_dist,
            cors_origin,
            runtime_mounts: Arc::new(Mutex::new(Vec::new())),
            runtime_transport: Arc::new(Mutex::new(None)),
            tickets: TicketStore::default(),
            changes: crate::watch::ChangeHub::spawn(&canonicals),
        }
    }

    /// builder：覆盖多根列表（workspace 阶段 1 地基）。逐个 canonicalize，
    /// 失败回退原路径——与 [`AppState::new`] 同款；`root`/`root_canonical`
    /// 兼容视图同步为 0 号根。ChangeHub 重建为挂载全部根（旧 hub 随 drop 停止）。
    pub fn with_roots(mut self, roots: Vec<PathBuf>) -> Self {
        // M4 顺序防御：本方法**整体重建** roots 为纯 fs 根列表——若此前已追加
        // 挂载段（with_mounts 先行），挂载会被静默丢弃。以「当前 roots 全为 fs
        // 根」为不变式在 debug 构建即炸（正常装配链 with_roots 先行，或从未
        // with_mounts，恒满足；with_mounts 为纯追加可重复调用，无需断言）。
        debug_assert_eq!(
            self.fs_roots,
            self.roots.len(),
            "with_roots 会整体重建 fs 根列表并丢弃已追加挂载，须在 with_mounts 之前调用"
        );
        debug_assert!(!roots.is_empty(), "roots 不得为空：至少需要一个根");
        self.roots = roots
            .into_iter()
            .map(|raw| {
                let canonical =
                    std::fs::canonicalize(&raw).unwrap_or_else(|_| raw.clone());
                RootSpec::fs_root(raw, canonical, self.hidden)
            })
            .collect();
        if let Some(first) = self.roots.first() {
            // 先克隆再赋值：字段经 DerefMut 直达核，赋值窗口内不得同时持根借用
            let raw = first.raw.clone();
            let canonical = first.canonical.clone();
            self.root = raw;
            self.root_canonical = canonical;
        }
        self.fs_roots = self.roots.len();
        let canonicals: Vec<PathBuf> = self.roots.iter().map(|r| r.canonical.clone()).collect();
        self.changes = crate::watch::ChangeHub::spawn(&canonicals);
        self
    }

    /// builder：追加静态挂载根（**须在 `with_roots` 之后调用**——`with_roots`
    /// 整体重建 fs 根列表；顺序契约以 debug_assert 锚定）。根序 = fs 根 + 挂载序
    /// （spec §2）；ChangeHub 不重建
    /// （挂载根 watch 能力 = false，无事件面）。注入形态为已构造 backend + 元
    /// 信息——测试可注入 MockTransport 构造的 S3/WebDAV（与 with_roots 的既有
    /// builder 模式同款）；无调用 = 纯 fs 部署，形状零变化。
    pub fn with_mounts(mut self, mounts: Vec<MountRoot>) -> Self {
        self.roots.extend(
            mounts
                .into_iter()
                .map(|m| RootSpec::mount(m.meta, m.backend)),
        );
        self
    }

    // ---------- 运行时挂载（阶段二 spec §3：POST/GET/DELETE /api/mounts） ----------

    /// rootIndex → 根规格（静态段 + 运行时段统一寻址）：tree/file 的分发入口。
    /// 越界 None（handler 400）；运行时段已删槽位（tombstone `None`）同返回
    /// None——被删索引自然失效（下次访问 400 越界，无内容串扰）。RootSpec 含
    /// Arc backend，clone 廉价；运行时段短暂持锁克隆即释放（锁内不做任何
    /// IO/await）。
    pub fn root_at(&self, index: usize) -> Option<RootSpec> {
        if let Some(spec) = self.roots.get(index) {
            return Some(spec.clone());
        }
        let guard = self.runtime_mounts.lock().unwrap();
        guard
            .get(index - self.roots.len())
            .and_then(|slot| slot.as_ref())
            .map(|m| RootSpec::mount(m.root.meta.clone(), m.root.backend.clone()))
    }

    /// 运行时挂载注册：backend 构造（复用 [`build_mount`]，与静态 TOML 装配
    /// 同一函数）+ 指纹幂等 + 容器登记。返回 (rootIndex, created)——同指纹
    /// 命中既有项返回其 rootIndex 且 created=false（handler 200），新分配
    /// created=true（handler 201）。
    ///
    /// 分配语义（tombstone 纪律，锁测见 tests/mounts_api.rs）：**追加分配**——
    /// 新项恒接在容器尾，不填充已删槽位（空洞）。已删索引因此进程内恒不解析，
    /// 「删除后新注册复用索引串扰旧引用」的复用窗口彻底消灭（递延项销账）；
    /// 空洞由重启整体回收（运行时挂载本为内存态，重启清零）。
    ///
    /// 幂等语义注记：指纹无凭据面——同指纹换凭据的重注册返回既有项、不重建
    /// backend（凭据轮换需先 DELETE 再注册，或重启；对账场景指纹来自前端
    /// IndexedDB 持久化配置，「同一挂载目标」即幂等）。注册的凭据仅存于
    /// backend 连接面（内存），不入 meta/指纹/清单/日志（spec §6 三不纪律）。
    pub fn register_mount(&self, cfg: &MountConfig) -> Result<(usize, bool), RegistrationError> {
        let fingerprint = mount_fingerprint(cfg);
        if let Some(idx) = self.find_runtime(&fingerprint) {
            return Ok((idx, false));
        }
        let transport = self.runtime_http_transport()?;
        // 构造在锁外（纯同步、无共享态；失败不触容器——错误消息仅字段名）
        let root = build_mount(cfg, transport).map_err(RegistrationError::Invalid)?;
        let mut guard = self.runtime_mounts.lock().unwrap();
        // 双检：构造窗口内并发注册同指纹——命中即弃置已建 backend（无全局态泄漏）
        if let Some(pos) = guard
            .iter()
            .position(|m| m.as_ref().is_some_and(|rm| rm.fingerprint == fingerprint))
        {
            return Ok((self.roots.len() + pos, false));
        }
        guard.push(Some(RuntimeMount { fingerprint, root }));
        Ok((self.roots.len() + guard.len() - 1, true))
    }

    /// 运行时挂载删除：index 落在静态段（fs 根 + 静态 TOML 挂载）拒删
    /// [`UnregisterError::Static`]；运行时段越界或已删（tombstone 空洞）
    /// [`UnregisterError::NotFound`]。成功即**槽位置 `None` 不压缩**——其余项
    /// rootIndex 不移位（删非尾项不串扰已开 tab 的旧 rootIndex），被删索引
    /// 进程内恒不解析：tree/file 访问自然 400 越界、重复 DELETE 404、清单
    /// 不含已删项（manifest 跳过空洞）。（活跃 tab 失效帧降级路径：不推送
    /// SSE 失效帧，挂载根本无事件面，前端凭 GET 清单对账——裁决记录任务报告。）
    pub fn unregister_mount(&self, index: usize) -> Result<(), UnregisterError> {
        let mut guard = self.runtime_mounts.lock().unwrap();
        if index < self.roots.len() {
            return Err(UnregisterError::Static);
        }
        let pos = index - self.roots.len();
        match guard.get_mut(pos) {
            Some(slot @ Some(_)) => {
                *slot = None;
                Ok(())
            }
            _ => Err(UnregisterError::NotFound),
        }
    }

    fn find_runtime(&self, fingerprint: &str) -> Option<usize> {
        let guard = self.runtime_mounts.lock().unwrap();
        guard
            .iter()
            .position(|m| m.as_ref().is_some_and(|rm| rm.fingerprint == fingerprint))
            .map(|pos| self.roots.len() + pos)
    }

    /// 运行时注册用 HTTP transport：懒初始化（首次注册构建 reqwest 连接池，
    /// 全注册共享一个 Arc——与 main.rs 静态装配的共享形态同款）。
    fn runtime_http_transport(&self) -> Result<Arc<dyn HttpTransport>, RegistrationError> {
        let mut guard = self.runtime_transport.lock().unwrap();
        if let Some(t) = guard.as_ref() {
            return Ok(t.clone());
        }
        let t: Arc<dyn HttpTransport> = Arc::new(ReqwestTransport::new().map_err(|e| {
            RegistrationError::Transport(format!("http transport init: {}", e.message()))
        })?);
        *guard = Some(t.clone());
        Ok(t)
    }

    /// builder：注入运行时注册用 transport（测试注入 MockTransport，免真实
    /// 网络；未注入时首次注册懒建 reqwest）。
    pub fn with_runtime_transport(self, transport: Arc<dyn HttpTransport>) -> Self {
        *self.runtime_transport.lock().unwrap() = Some(transport);
        self
    }

    /// builder：预置运行时挂载项（测试注入；与 [`AppState::register_mount`]
    /// 同一容器，rootIndex 寻址语义一致——静态段之后按槽位序）。
    pub fn with_runtime_mounts(self, mounts: Vec<RuntimeMount>) -> Self {
        self.runtime_mounts.lock().unwrap().extend(mounts.into_iter().map(Some));
        self
    }

    /// builder：`--compute` 启用服务端计算端点（new 默认 false，既有测试零改动）。
    pub fn with_compute(mut self, compute: bool) -> Self {
        self.compute = compute;
        self
    }

    /// builder：注入 ripgrep 路径（None = PATH 探测；测试注入不存在路径模拟 501）。
    pub fn with_rg_path(mut self, rg_path: Option<String>) -> Self {
        self.rg_path = rg_path;
        self
    }

    /// builder：注入 grep 路径（None = PATH 探测；测试注入不存在路径模拟 grep 缺失）。
    pub fn with_grep_path(mut self, grep_path: Option<String>) -> Self {
        self.grep_path = grep_path;
        self
    }
}

/// 供 Path 转发的便捷引用。
impl AsRef<Path> for AppState {
    fn as_ref(&self) -> &Path {
        &self.root
    }
}
