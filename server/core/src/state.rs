//! 业务状态核：从 axum 侧 AppState 提取的非框架状态（配置/根列表/令牌），
//! 以及多根寻址的数据类型（RootSpec/MountMeta）与运行时挂载容器（Task 2 域
//! 抽取迁入：root_at 统一寻址 + register/unregister 幂等/tombstone 语义）。
//! axum 特有面（web_dist/cors_origin/watch hub/一次性 ticket 表）留在适配层
//! AppState。

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use vviewer_storage::StorageBackend;
#[cfg(not(target_family = "wasm"))]
use vviewer_storage::LocalFs;
use vviewer_storage::transport::HttpTransport;
// reqwest 唯一入口符号：native 门控内才存在（storage default-features = false，
// 终审 I-1）。门控纪律由 lib.rs source_anchors 锚测强制——新增引用必须同款
// 置于 `#[cfg(feature = "native")]` item 内。
#[cfg(feature = "native")]
use vviewer_storage::transport::ReqwestTransport;

use crate::mounts::{build_mount, MountConfig, RegistrationError, RuntimeMount, UnregisterError};

/// 挂载根的可宣告元信息：health 摘要与阶段二 `GET /api/mounts` 的数据源。
/// **凭据不入内**（spec §2 服务端纪律——不进 health/mounts 回显/日志），
/// Debug 派生安全。
#[derive(Clone, Debug)]
pub struct MountMeta {
    /// 后端类别字面（`"s3"` | `"webdav"`）。
    pub kind: &'static str,
    pub label: Option<String>,
    pub endpoint: String,
    /// S3 挂载的桶名；WebDAV 挂载为 None。
    pub bucket: Option<String>,
    /// 挂载子路径（配置原样；空串 = 端点根）。
    pub prefix: String,
}

/// 单个根的规格：原始路径 + canonicalize 结果（guard 越界校验基准）+ 存储后端。
#[derive(Clone)]
pub struct RootSpec {
    /// `--root` 原始路径；挂载根为展示形态（`s3:label` / `s3://endpoint`，无 fs 语义）。
    pub raw: PathBuf,
    /// canonicalize 结果（构造时一次，失败回退原路径）；挂载根与 raw 相同
    /// （guard 对挂载根不做 fs canonicalize，见 routes 的 mount 分支）。
    pub canonical: PathBuf,
    /// 该根的存储后端（fs 根 LocalFs；挂载根 S3/WebDAV）。
    pub backend: std::sync::Arc<dyn StorageBackend>,
    /// 挂载元信息；None = fs 根（根序 = fs 根 + 静态挂载序，spec §2）。
    pub mount: Option<MountMeta>,
}

impl RootSpec {
    /// fs 根构造：LocalFs 以 canonical 路径为基——路由层把 guard 解析出的
    /// canonical 绝对路径按根 strip 成相对路径传入，backend join 回来触达的
    /// 绝对路径与下沉前的直读形态逐字节一致。
    /// wasm（worker 形态）不编译：无文件系统（storage LocalFs 同门控）。
    #[cfg(not(target_family = "wasm"))]
    pub fn fs_root(raw: PathBuf, canonical: PathBuf, hidden: bool) -> Self {
        Self {
            backend: std::sync::Arc::new(LocalFs::new(canonical.clone(), hidden)),
            raw,
            canonical,
            mount: None,
        }
    }

    /// 挂载根构造：raw/canonical 为展示形态（无 fs 语义——guard 清洗 path 后
    /// 直接作为 backend 相对路径，不经 canonicalize/越界校验）。
    pub fn mount(meta: MountMeta, backend: std::sync::Arc<dyn StorageBackend>) -> Self {
        let raw = match &meta.label {
            Some(l) => PathBuf::from(format!("{}:{l}", meta.kind)),
            None => PathBuf::from(format!("{}://{}", meta.kind, meta.endpoint)),
        };
        Self { raw: raw.clone(), canonical: raw, backend, mount: Some(meta) }
    }
}

impl std::fmt::Debug for RootSpec {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // backend 为 dyn 存储（无 Debug 语义），只暴露路径面
        f.debug_struct("RootSpec")
            .field("raw", &self.raw)
            .field("canonical", &self.canonical)
            .finish_non_exhaustive()
    }
}

/// 业务状态核（[`health::handle`] 等域 handler 的消费面）：配置 + 多根容器 +
/// 鉴权令牌。Clone 廉价（roots 内 backend 为 Arc 共享）。
#[derive(Clone)]
pub struct CoreState {
    /// `--root` 原始路径（兼容视图 = [`CoreState::roots`]）。
    pub root: PathBuf,
    /// root 的 canonicalize 结果（构造时一次），guard 越界校验基准（兼容视图 = roots[0]）。
    pub root_canonical: PathBuf,
    /// 多根列表（workspace 阶段 1 + 挂载阶段一）：**根序 = fs 根 + 静态挂载序**
    /// （spec §2）；单根部署时恒为 1 项。rootIndex < [`CoreState::fs_roots`]
    /// 为 fs 根，≥ 为挂载根。
    pub roots: Vec<RootSpec>,
    /// fs 根数量（roots 前缀段长度）：挂载根寻址边界（health.fsRoots 宣告源）。
    pub fs_roots: usize,
    /// 运行时挂载容器（阶段二 spec §3，Task 2 自适配层 AppState 迁入）：
    /// `POST /api/mounts` 注册的内存态挂载，重启失效。rootIndex =
    /// `roots.len()` + 槽位序（静态段之后的寻址段，经 [`CoreState::root_at`]
    /// 统一寻址）。**tombstone 容器**（`Option` 槽位）：删除只置 `None` 不压缩
    /// ——其余项 rootIndex 不移位（删非尾项不串扰已开 tab），被删索引进程内
    /// 恒不解析（重复 DELETE 404、tree/file 越界 400），「删除后移位/复用索引
    /// 串扰旧引用」两类窗口一并消灭；新注册不填充空洞
    /// （[`CoreState::register_mount`] 追加分配），重启才整体回收。
    pub runtime_mounts: Arc<Mutex<Vec<Option<RuntimeMount>>>>,
    /// 运行时注册用的 HTTP transport（注入优先，缺省懒构造随 native 门控——
    /// 见 [`CoreState::runtime_http_transport`]；全注册共享一个 Arc）。测试与
    /// worker 形态经 [`CoreState::with_transport`]（适配层 AppState 的
    /// with_runtime_transport 同款委托）注入 MockTransport/wasm transport。
    /// 私有面：仅 [`CoreState::register_mount`] 消费。
    runtime_transport: Arc<Mutex<Option<Arc<dyn HttpTransport>>>>,
    /// 访问令牌；None 表示免鉴权（仅默认 127.0.0.1 绑定时允许）。
    pub token: Option<String>,
    /// `--hidden`：隐藏 dot 开头条目。
    pub hidden: bool,
    /// `--compute`：启用服务端计算端点（/api/compute/*；health 能力追加 "compute"）。
    pub compute: bool,
    /// rg 可执行路径覆盖：None = 请求时 PATH 探测；Some(可执行) = 直接绑定；
    /// Some(不可执行) = rg 不可用（跳过 PATH 探测——测试模拟 rg 缺失，A 项降级链）。
    pub rg_path: Option<String>,
    /// grep 路径覆盖：语义同 `rg_path`（rg 不可用时的 fallback 引擎，探测链第二位）。
    pub grep_path: Option<String>,
    /// 服务端版本宣告（health.version 数据源）：由适配层注入 vviewer 主 crate
    /// 的 `CARGO_PKG_VERSION`——health 对外版本面随主 crate，不随本 crate。
    pub version: &'static str,
}

impl CoreState {
    /// fs 单根状态构造（与迁移前 AppState::new 的核内构造逐语句一致）。
    /// version 与两个宣告缝由适配层装配时注入。
    /// wasm（worker 形态）不编译：无文件系统，worker 以 [`Self::mounts_only`]
    /// 构造（本函数的 std::fs canonicalize 与 LocalFs 均为 host 语义）。
    #[cfg(not(target_family = "wasm"))]
    pub fn new(root: PathBuf, token: Option<String>, hidden: bool) -> Self {
        // main 启动前已校验目录存在；canonicalize 失败时退回原路径（保持可测）
        let root_canonical: PathBuf = std::fs::canonicalize(&root).unwrap_or_else(|_| root.clone());
        let roots = vec![RootSpec::fs_root(root.clone(), root_canonical.clone(), hidden)];
        Self {
            root,
            root_canonical,
            roots,
            fs_roots: 1,
            runtime_mounts: Arc::new(Mutex::new(Vec::new())),
            runtime_transport: Arc::new(Mutex::new(None)),
            token,
            hidden,
            compute: false,
            rg_path: None,
            grep_path: None,
            version: "",
        }
    }

    /// 纯挂载状态构造（多端发布阶段三 Task 2，worker 形态）：**无 fs 根**——
    /// roots 全部为挂载根（静态段 = VV_MOUNTS env 装配序），fs_roots = 0，
    /// rootIndex 寻址面从 0 起即挂载段。worker 无 `--hidden`/`--compute` 旗标，
    /// rg/grep 探测在 wasm 无进程语义（health 的 searchEngine 宣告链 PATH
    /// 探测自然落空不宣告，见 health.rs）。version 由 worker 适配层注入。
    /// host 目标同样可用（无行为耦合；挂载段构造复用 [`RootSpec::mount`]）。
    pub fn mounts_only(mounts: Vec<RootSpec>, token: Option<String>) -> Self {
        Self {
            root: PathBuf::new(),
            root_canonical: PathBuf::new(),
            roots: mounts,
            fs_roots: 0,
            runtime_mounts: Arc::new(Mutex::new(Vec::new())),
            runtime_transport: Arc::new(Mutex::new(None)),
            token,
            hidden: false,
            compute: false,
            rg_path: None,
            grep_path: None,
            version: "",
        }
    }

    /// 注入运行时注册用 transport（builder 形态；与适配层 AppState 的
    /// with_runtime_transport 同一槽位语义——无条件覆盖）。worker 形态的构造
    /// 路径：wasm HttpTransport 由此进入（裁剪形态无 reqwest，未注入时注册
    /// 即配置错误）；native 形态可注入 MockTransport 免真实网络（既有测试
    /// 零改动——适配层 builder 委托至此）。
    pub fn with_transport(self, transport: Arc<dyn HttpTransport>) -> Self {
        *self.runtime_transport.lock().unwrap() = Some(transport);
        self
    }

    // ---------- 运行时挂载（阶段二 spec §3：POST/GET/DELETE /api/mounts） ----------
    //
    // Task 2 自适配层 AppState 原样迁入（多端发布阶段二）：方法体/锁纪律
    // （锁内不做任何 IO/await）与 tombstone/幂等语义逐语句保真。

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

    /// 运行时挂载注册：backend 构造（复用 [`crate::mounts::build_mount`]，与
    /// 静态 TOML 装配同一函数）+ 指纹幂等 + 容器登记。返回 (rootIndex,
    /// created)——同指纹命中既有项返回其 rootIndex 且 created=false（handler
    /// 200），新分配 created=true（handler 201）。
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
        let fingerprint = crate::mounts::mount_fingerprint(cfg);
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

    /// 运行时注册用 HTTP transport 取用：注入槽位优先（[`CoreState::with_transport`]）；
    /// 空槽时走缺省构造——native 形态懒初始化（首次注册构建 reqwest 连接池并
    /// 缓存进槽位，全注册共享——与 main.rs 静态装配的共享形态同款，既有行为
    /// 零变化）；worker 形态无 reqwest，空槽即配置错误（指引注入面）。
    fn runtime_http_transport(&self) -> Result<Arc<dyn HttpTransport>, RegistrationError> {
        let mut guard = self.runtime_transport.lock().unwrap();
        if let Some(t) = guard.as_ref() {
            return Ok(t.clone());
        }
        let t = self.default_transport()?;
        *guard = Some(t.clone());
        Ok(t)
    }

    /// 缺省 transport 构造（native：reqwest）。core 源码内 `ReqwestTransport`
    /// 硬编码符号的**唯一容身点**（lib.rs source_anchors 锚测强制门控纪律；
    /// 适配层 main.rs 静态装配的同形构造为其镜像，worker 不复用本 crate 的
    /// native 面）。
    #[cfg(feature = "native")]
    fn default_transport(&self) -> Result<Arc<dyn HttpTransport>, RegistrationError> {
        let t: Arc<dyn HttpTransport> = Arc::new(ReqwestTransport::new().map_err(|e| {
            RegistrationError::Transport(format!("http transport init: {}", e.message()))
        })?);
        Ok(t)
    }

    /// 缺省 transport 构造（裁剪形态：无 reqwest，必须注入）——worker 形态
    /// 以 [`CoreState::with_transport`] 注入 wasm HttpTransport 后注册链可用
    /// （见 tests::worker_form 专测）。
    #[cfg(not(feature = "native"))]
    fn default_transport(&self) -> Result<Arc<dyn HttpTransport>, RegistrationError> {
        Err(RegistrationError::Transport(
            "http transport not configured: inject one via CoreState::with_transport \
             (worker form builds without the native reqwest transport)"
                .into(),
        ))
    }
}

/// 供 Path 转发的便捷引用（迁移前位于适配层 AppState 的同款形态）。
impl AsRef<std::path::Path> for CoreState {
    fn as_ref(&self) -> &std::path::Path {
        &self.root
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_creates_single_fs_root_with_canonical_fallback() {
        // canonicalize 失败（不存在路径）回退原路径——与迁移前 AppState::new 同款
        let raw = PathBuf::from("/nonexistent/vviewer-core-test-root");
        let cs = CoreState::new(raw.clone(), Some("tok".into()), false);
        assert_eq!(cs.roots.len(), 1);
        assert_eq!(cs.fs_roots, 1);
        assert_eq!(cs.root_canonical, raw);
        assert_eq!(cs.token.as_deref(), Some("tok"));
        assert!(!cs.compute);
    }

    // ---------- worker 形态 mounts_only 构造锚测（阶段三 Task 2） ----------
    //
    // 无 fs 根不变式：roots 全挂载段、fs_roots=0、rootIndex 从 0 起即挂载序；
    // 注入 transport 后运行时注册追加在静态挂载之后（root_at 统一寻址）。
    // host 上即可运行（构造函数跨目标存在），wasm 侧由编译门覆盖。
    mod mounts_only_form {
        use super::*;
        use crate::mounts::{self, MountConfig, MountKind};
        use vviewer_storage::transport::MockTransport;

        fn s3_cfg() -> MountConfig {
            MountConfig {
                kind: MountKind::S3,
                label: Some("docs".into()),
                endpoint: Some("http://127.0.0.1:9000".into()),
                bucket: Some("b1".into()),
                prefix: None,
                access_key_id: Some("ak".into()),
                secret_access_key: Some("sk".into()),
                username: None,
                password: None,
                path_style: None,
                region: None,
            }
        }

        fn state_with_static_mount() -> CoreState {
            let transport: Arc<dyn HttpTransport> = Arc::new(MockTransport::new());
            let root = mounts::build_mount(&s3_cfg(), transport).unwrap();
            let mut cs = CoreState::mounts_only(vec![RootSpec::mount(root.meta, root.backend)], None);
            cs.version = "0.1.0";
            cs
        }

        #[test]
        fn mount_only_state_has_no_fs_root_and_addresses_mounts_from_zero() {
            let cs = state_with_static_mount();
            assert_eq!(cs.fs_roots, 0);
            assert_eq!(cs.roots.len(), 1);
            assert!(cs.roots[0].mount.is_some());
            // rootIndex 0 即首个挂载根；越界 1 → None
            let spec = cs.root_at(0).expect("挂载根可寻址");
            assert_eq!(spec.mount.as_ref().unwrap().kind, "s3");
            assert!(cs.root_at(1).is_none());
        }

        #[test]
        fn runtime_register_appends_after_static_mounts() {
            let cs = state_with_static_mount()
                .with_transport(Arc::new(MockTransport::new()));
            let (idx, created) = cs.register_mount(&s3_cfg()).expect("注册应成功");
            assert!(created);
            assert_eq!(idx, 1, "运行时挂载 rootIndex = 静态挂载数(1) + 槽位序");
            assert!(cs.root_at(idx).unwrap().mount.is_some());
        }
    }

    // ---------- worker 形态（--no-default-features）注入构造链专测 ----------
    //
    // 裁剪形态无 reqwest（终审 I-1）：运行时注册的 transport 只能来自注入
    // （Task 2 worker 侧注入 wasm HttpTransport）。native 形态不编译本模块
    // （native 懒构造路径由既有注册测试覆盖）；编译面由裁剪 all-targets check
    // 锚定，`cargo test -p vviewer-core --no-default-features` 实际运行。
    #[cfg(not(feature = "native"))]
    mod worker_form {
        use super::*;
        use vviewer_storage::transport::MockTransport;

        fn s3_cfg() -> MountConfig {
            MountConfig {
                kind: crate::mounts::MountKind::S3,
                label: Some("docs".into()),
                endpoint: Some("http://127.0.0.1:9000".into()),
                bucket: Some("b1".into()),
                prefix: None,
                access_key_id: Some("ak".into()),
                secret_access_key: Some("sk".into()),
                username: None,
                password: None,
                path_style: None,
                region: None,
            }
        }

        #[test]
        fn with_transport_injection_enables_runtime_register() {
            let cs = CoreState::new(PathBuf::from("/nonexistent-worker-root"), None, false)
                .with_transport(Arc::new(MockTransport::new()));
            let (idx, created) = cs.register_mount(&s3_cfg()).expect("注入 transport 后注册应成功");
            assert!(created);
            assert_eq!(idx, 1, "rootIndex = fs 根数(1) + 运行时段首槽");
            assert_eq!(cs.root_at(idx).unwrap().mount.as_ref().unwrap().kind, "s3");
        }

        #[test]
        fn register_without_injected_transport_reports_configuration_error() {
            let cs = CoreState::new(PathBuf::from("/nonexistent-worker-root"), None, false);
            let err = cs.register_mount(&s3_cfg()).expect_err("未注入 transport 应报配置错误");
            assert_eq!(
                err,
                RegistrationError::Transport(
                    "http transport not configured: inject one via CoreState::with_transport \
                     (worker form builds without the native reqwest transport)"
                        .into()
                )
            );
        }
    }
}
