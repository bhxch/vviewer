//! 共享应用状态与 ticket 存储。
//!
//! 多端发布阶段二：业务状态核已迁 vviewer-core::state（Task 1 数据类型 +
//! Task 2 运行时挂载容器/register/unregister/root_at 与挂载配置构造面）；本
//! 模块持有 axum 特有面（静态/前端目录、CORS、watch hub、ticket 表）并保留
//! builder 与既有路径 re-export（调用点/测试零改动）。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use vviewer_core::state::CoreState;
use vviewer_storage::transport::HttpTransport;

use crate::generate_token;

// 业务数据类型与挂载域随 Task 1/2 core 抽取迁入 vviewer-core（多端发布阶段
// 二）；原 `crate::state` 路径 re-export 保持既有调用点/测试零改动。
pub use vviewer_core::state::{MountMeta, RootSpec};
pub use vviewer_core::mounts::{
    build_mount, mount_fingerprint, MountConfig, MountKind, MountRoot, RegistrationError,
    RuntimeMount, UnregisterError,
};

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

/// 传给所有 axum handler 的共享状态（适配层面）：业务状态核 [`CoreState`]
/// （多端发布阶段二迁入 vviewer-core）+ axum 特有面。经 Deref 直达核字段
/// （`state.roots`/`state.token` 等既有调用点零改动——迁移期兼容缝，Task 2/3
/// 域抽取逐步把消费方迁到 core 后再评估收紧）。
#[derive(Clone)]
pub struct AppState {
    /// 业务状态核（vviewer-core::state）：配置/多根容器/令牌/引擎覆盖 +
    /// 运行时挂载容器（Task 2 迁入）+ health 宣告缝注入面。
    pub core: CoreState,
    /// `--web-dist` 前端静态产物目录；未指定时 `/` 返回占位页。
    pub web_dist: Option<PathBuf>,
    /// `--cors-origin` 精确 origin；None = 不加 CORS 层。
    pub cors_origin: Option<String>,
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

    /// builder：注入运行时注册用 transport（测试注入 MockTransport，免真实
    /// 网络；未注入时首次注册懒建 reqwest）。容器在核 [`CoreState`]（Task 2
    /// 迁入），此处经核字段注入。
    pub fn with_runtime_transport(self, transport: Arc<dyn HttpTransport>) -> Self {
        *self.core.runtime_transport.lock().unwrap() = Some(transport);
        self
    }

    /// builder：预置运行时挂载项（测试注入；与 [`CoreState::register_mount`]
    /// 同一容器，rootIndex 寻址语义一致——静态段之后按槽位序）。
    pub fn with_runtime_mounts(self, mounts: Vec<RuntimeMount>) -> Self {
        self.core.runtime_mounts.lock().unwrap().extend(mounts.into_iter().map(Some));
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
