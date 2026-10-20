//! 共享应用状态与 ticket 存储。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use vviewer_storage::{LocalFs, StorageBackend};

use crate::generate_token;

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

/// 单个根的规格：原始路径 + canonicalize 结果（guard 越界校验基准）+ 存储后端。
#[derive(Clone)]
pub struct RootSpec {
    /// `--root` 原始路径；挂载根为展示形态（`s3:label` / `s3://endpoint`，无 fs 语义）。
    pub raw: PathBuf,
    /// canonicalize 结果（构造时一次，失败回退原路径）；挂载根与 raw 相同
    /// （guard 对挂载根不做 fs canonicalize，见 routes 的 mount 分支）。
    pub canonical: PathBuf,
    /// 该根的存储后端（fs 根 LocalFs；挂载根 S3/WebDAV）。
    pub backend: Arc<dyn StorageBackend>,
    /// 挂载元信息；None = fs 根（根序 = fs 根 + 静态挂载序，spec §2）。
    pub mount: Option<MountMeta>,
}

impl RootSpec {
    /// fs 根构造：LocalFs 以 canonical 路径为基——路由层把 guard 解析出的
    /// canonical 绝对路径按根 strip 成相对路径传入，backend join 回来触达的
    /// 绝对路径与下沉前的直读形态逐字节一致。
    pub fn fs_root(raw: PathBuf, canonical: PathBuf, hidden: bool) -> Self {
        Self {
            backend: Arc::new(LocalFs::new(canonical.clone(), hidden)),
            raw,
            canonical,
            mount: None,
        }
    }

    /// 挂载根构造：raw/canonical 为展示形态（无 fs 语义——guard 清洗 path 后
    /// 直接作为 backend 相对路径，不经 canonicalize/越界校验）。
    pub fn mount(meta: MountMeta, backend: Arc<dyn StorageBackend>) -> Self {
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

/// 传给所有 handler 的共享状态。
#[derive(Clone)]
pub struct AppState {
    /// `--root` 原始路径（兼容视图 = [`AppState::roots`][0]）。
    pub root: PathBuf,
    /// root 的 canonicalize 结果（构造时一次），guard 越界校验基准（兼容视图 = roots[0]）。
    pub root_canonical: PathBuf,
    /// 多根列表（workspace 阶段 1 + 挂载阶段一）：**根序 = fs 根 + 静态挂载序**
    /// （spec §2）；单根部署时恒为 1 项，形状与历史一致。rootIndex < [`AppState::fs_roots`]
    /// 为 fs 根，≥ 为挂载根。
    pub roots: Vec<RootSpec>,
    /// fs 根数量（roots 前缀段长度）：挂载根寻址边界（health.fsRoots 宣告源）。
    pub fs_roots: usize,
    /// `--web-dist` 前端静态产物目录；未指定时 `/` 返回占位页。
    pub web_dist: Option<PathBuf>,
    /// 访问令牌；None 表示免鉴权（仅默认 127.0.0.1 绑定时允许）。
    pub token: Option<String>,
    /// `--hidden`：隐藏 dot 开头条目。
    pub hidden: bool,
    /// `--cors-origin` 精确 origin；None = 不加 CORS 层。
    pub cors_origin: Option<String>,
    /// `--compute`：启用服务端计算端点（/api/compute/*；health 能力追加 "compute"）。
    pub compute: bool,
    /// rg 可执行路径覆盖：None = 请求时 PATH 探测；Some(可执行) = 直接绑定；
    /// Some(不可执行) = rg 不可用（跳过 PATH 探测——测试模拟 rg 缺失，A 项降级链）。
    pub rg_path: Option<String>,
    /// grep 路径覆盖：语义同 `rg_path`（rg 不可用时的 fallback 引擎，探测链第二位）。
    pub grep_path: Option<String>,
    /// 一次性 ticket 表（SSE 升级用）。
    pub tickets: TicketStore,
    /// root 变更广播中心（启动时创建一次，共享 watcher + debounce 聚合）。
    pub changes: Arc<crate::watch::ChangeHub>,
}

impl AppState {
    pub fn new(
        root: PathBuf,
        web_dist: Option<PathBuf>,
        token: Option<String>,
        hidden: bool,
        cors_origin: Option<String>,
    ) -> Self {
        // main 启动前已校验目录存在；canonicalize 失败时退回原路径（保持可测）
        let root_canonical: PathBuf = std::fs::canonicalize(&root).unwrap_or_else(|_| root.clone());
        let roots = vec![RootSpec::fs_root(root.clone(), root_canonical.clone(), hidden)];
        // 多根聚合 watch：每根一个 watcher 线程（单根即历史单 watcher 形状）
        let canonicals: Vec<PathBuf> = roots.iter().map(|r| r.canonical.clone()).collect();
        Self {
            root: root.clone(),
            root_canonical: root_canonical.clone(),
            roots,
            fs_roots: 1,
            web_dist,
            token,
            hidden,
            cors_origin,
            compute: false,
            rg_path: None,
            grep_path: None,
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
            self.root = first.raw.clone();
            self.root_canonical = first.canonical.clone();
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
