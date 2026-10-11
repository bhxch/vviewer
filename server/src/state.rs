//! 共享应用状态与 ticket 存储。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

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

/// 单个根的规格：原始路径 + canonicalize 结果（guard 越界校验基准）。
#[derive(Clone, Debug)]
pub struct RootSpec {
    /// `--root` 原始路径。
    pub raw: PathBuf,
    /// canonicalize 结果（构造时一次，失败回退原路径）。
    pub canonical: PathBuf,
}

/// 传给所有 handler 的共享状态。
#[derive(Clone)]
pub struct AppState {
    /// `--root` 原始路径（兼容视图 = [`AppState::roots`][0]）。
    pub root: PathBuf,
    /// root 的 canonicalize 结果（构造时一次），guard 越界校验基准（兼容视图 = roots[0]）。
    pub root_canonical: PathBuf,
    /// 多根列表（workspace 阶段 1）：单根部署时恒为 1 项，形状与历史一致。
    pub roots: Vec<RootSpec>,
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
        let roots = vec![RootSpec { raw: root.clone(), canonical: root_canonical.clone() }];
        // 多根聚合 watch：每根一个 watcher 线程（单根即历史单 watcher 形状）
        let canonicals: Vec<PathBuf> = roots.iter().map(|r| r.canonical.clone()).collect();
        Self {
            root: root.clone(),
            root_canonical: root_canonical.clone(),
            roots,
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
        debug_assert!(!roots.is_empty(), "roots 不得为空：至少需要一个根");
        self.roots = roots
            .into_iter()
            .map(|raw| {
                let canonical =
                    std::fs::canonicalize(&raw).unwrap_or_else(|_| raw.clone());
                RootSpec { raw, canonical }
            })
            .collect();
        if let Some(first) = self.roots.first() {
            self.root = first.raw.clone();
            self.root_canonical = first.canonical.clone();
        }
        let canonicals: Vec<PathBuf> = self.roots.iter().map(|r| r.canonical.clone()).collect();
        self.changes = crate::watch::ChangeHub::spawn(&canonicals);
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
