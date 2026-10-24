//! 自愈状态机与聚合会话循环（BE-3 目录化自 watch.rs 迁入）：错误日志限频、
//! watcher 建立工厂（recommended 退避重试 → PollWatcher 降级 → 探试回归）、
//! 每根聚合/自愈主循环与 debounce 窗口聚合。

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::time::{Duration, Instant};

use notify::{
    Config as NotifyConfig, Error as NotifyError, Event as NotifyEvent, PollWatcher,
    RecommendedWatcher, RecursiveMode, Watcher,
};
use serde_json::json;
use tokio::sync::broadcast;
use tracing::{error, info, warn};

use super::health::{HealthSlots, WatchHealth};
use super::inspect::collect_event;

/// 运行期错误日志限频（BUG-68 抑制层）：同窗口内错误只记首条，过期后输出
/// 一条「n 条已抑制」摘要（n=0 时不输出空摘要，直接按新窗口首条），避免
/// 高频错误事件逐条刷日志。
struct ErrorLogGate {
    window: Duration,
    last_reset: Option<Instant>,
    suppressed: u64,
}

enum Admission {
    /// 窗口首条：直接记录（含窗口过期但期间无抑制、零摘要可输出的情形）
    First,
    /// 窗口内：静默累计
    Suppressed,
    /// 窗口过期后的首条：输出摘要（携带被抑制条数），并重开窗口
    Summary(u64),
}

impl ErrorLogGate {
    fn new(window: Duration) -> Self {
        Self { window, last_reset: None, suppressed: 0 }
    }

    fn admit(&mut self, now: Instant) -> Admission {
        match self.last_reset {
            None => {
                self.last_reset = Some(now);
                Admission::First
            }
            Some(t) if now.duration_since(t) >= self.window => {
                let n = self.suppressed;
                self.suppressed = 0;
                self.last_reset = Some(now);
                // 零抑制的过期窗口没有可摘要的内容，退化为首条语义，
                // 避免「0 suppressed」噪声行
                if n == 0 {
                    Admission::First
                } else {
                    Admission::Summary(n)
                }
            }
            Some(_) => {
                self.suppressed += 1;
                Admission::Suppressed
            }
        }
    }
}

/// debounce 聚合窗口：首个事件到达后等这么久，窗口内的后续事件并入同一条 changed。
pub const DEBOUNCE_WINDOW: Duration = Duration::from_millis(500);

pub(super) type RawEvent = Result<NotifyEvent, NotifyError>;

/// 一次成功建立的 watcher 会话：事件接收端 + 保活句柄（drop 即断流）。
pub(super) struct WatchSession {
    /// notify watcher（或 mock 的发送端）：保活 raw channel；drop 后 rx Disconnected。
    _keepalive: Box<dyn Send>,
    rx: std::sync::mpsc::Receiver<RawEvent>,
    /// 后端名（如 Inotify/Poll），日志与 watch-recovered/watch-degraded 帧携带。
    backend: String,
    /// true = 会话来自 PollWatcher 降级：健康状态记 Degraded 而非 Ok。
    degraded: bool,
}

impl WatchSession {
    pub(super) fn new(
        keepalive: Box<dyn Send>,
        rx: std::sync::mpsc::Receiver<RawEvent>,
        backend: String,
        degraded: bool,
    ) -> Self {
        Self { _keepalive: keepalive, rx, backend, degraded }
    }
}

/// 建立 watcher 的结果：保活句柄 + 事件接收端 + 后端名。
pub(super) type OpenOutcome =
    Result<(Box<dyn Send>, std::sync::mpsc::Receiver<RawEvent>, String), NotifyError>;
pub(super) type Opener = Box<dyn FnMut() -> OpenOutcome + Send>;

/// 重试策略（启动失败与运行期重建共用）。
pub(super) struct RetryPolicy {
    /// recommended watcher 重试次数（不含 `ChangeHub::spawn` 的同步首建）。
    pub(super) attempts: u32,
    /// 第 n 次重试前的退避时长（按索引取，越界视为不再等待）。
    pub(super) backoffs: Vec<Duration>,
    /// 降级 PollWatcher 的轮询间隔（≥2s，权衡 CPU）。
    pub(super) poll_interval: Duration,
    /// PollWatcher 也失败后的兜底无限重试间隔。
    pub(super) fallback_backoff: Duration,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            attempts: 3,
            backoffs: vec![
                Duration::from_millis(500),
                Duration::from_secs(1),
                Duration::from_secs(2),
            ],
            poll_interval: Duration::from_secs(2),
            fallback_backoff: Duration::from_secs(5),
        }
    }
}

/// 降级后每隔 N 次 PollWatcher 重建探试一次 recommended：暂时性故障（如 inotify
/// ENOSPC）解除后可回归实时监听，避免永久停留在 2s 轮询。
const POLL_PROBE_EVERY: u32 = 5;

/// e2e 故障注入规格（SRV-06/2 验收 3/5：降级→changed 仍流动→自愈 recovered）。
/// 环境变量 `VV_WATCH_FAULT="rec_open_fails:poll_err_ms"`（仅显式设置且可解析
/// 时激活；生产部署不设即无注入）：
/// - `rec_open_fails`：recommended watcher 打开前 N 次注入合成失败——首建 +
///   3 次退避重试全败 → PollWatcher 降级（watch-degraded 路径）；
/// - `poll_err_ms`：>0 时每个 PollWatcher 会话建立该毫秒数后注入一次运行期
///   Err（真实事件随后照常透传）——重建链推进 `poll_rebuilds`，第
///   `POLL_PROBE_EVERY` 次重建探试 recommended（此时注入计数已耗尽）成功 →
///   watch-recovered（自愈路径）。e2e 用 `4:3000` 完整走通「降级→降级中
///   changed 流动→探试回归实时」三段，无需依赖不可移植的 chmod/errno 手法。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct WatchFault {
    rec_open_fails: u32,
    poll_err_ms: u64,
}

impl WatchFault {
    pub(super) fn from_env() -> Option<Self> {
        let spec = std::env::var("VV_WATCH_FAULT").ok()?;
        let (fails, err_ms) = spec.split_once(':')?;
        Some(Self {
            rec_open_fails: fails.trim().parse().ok()?,
            poll_err_ms: err_ms.trim().parse().ok()?,
        })
    }
}

/// watcher 建立工厂：recommended 退避重试 → PollWatcher 降级（并记忆偏好，
/// 每 POLL_PROBE_EVERY 次重建探试一次 recommended）→ 兜底无限重试（root 暂时
/// 不可达时，条件移除后自愈）。opener 可注入（测试用 mock 会话替换真实 notify
/// 构建）。
pub(super) struct RetryFactory {
    pub(super) root: PathBuf,
    pub(super) policy: RetryPolicy,
    /// 上次降级成功后优先重试 PollWatcher，避免每次重建空耗 recommended 重试窗口；
    /// 探试周期见 `POLL_PROBE_EVERY`。
    pub(super) prefer_poll: bool,
    /// prefer_poll 生效期间经历的重建次数（探试计数）。
    pub(super) poll_rebuilds: u32,
    pub(super) open_recommended: Opener,
    pub(super) open_poll: Opener,
}

impl RetryFactory {
    /// 生产 opener 组装：recommended（inotify 等）与固定间隔 PollWatcher。
    /// `fault` 非 None 时包装注入（[`WatchFault`]）。
    pub(super) fn notify(root: PathBuf, policy: RetryPolicy, fault: Option<WatchFault>) -> Self {
        let rec_root = root.clone();
        let poll_root = root.clone();
        let poll_interval = policy.poll_interval;
        let rec_injected = Arc::new(AtomicU32::new(0));
        Self {
            root,
            policy,
            prefer_poll: false,
            poll_rebuilds: 0,
            open_recommended: Box::new(move || {
                let injected = match fault {
                    Some(f) => rec_injected.fetch_add(1, Ordering::SeqCst) < f.rec_open_fails,
                    None => false,
                };
                if injected {
                    return Err(NotifyError::io(std::io::Error::other(format!(
                        "injected: recommended open failure {} of {}",
                        rec_injected.load(Ordering::SeqCst),
                        fault.map_or(0, |f| f.rec_open_fails)
                    ))));
                }
                let (w, rx) = open_recommended(&rec_root)?;
                let backend = backend_name(&w);
                Ok((Box::new(w) as Box<dyn Send>, rx, backend))
            }),
            open_poll: Box::new(move || {
                let (w, raw_rx) = open_poll(&poll_root, poll_interval)?;
                // 会话内延迟运行期 Err 注入：中间通道 + 转发线程（先 Err 后透传
                // 真实事件）。会话被聚合线程丢弃后 keepalive watcher 随之 drop、
                // raw_rx 断开，转发线程自行退出。
                let inject_err_ms = fault.map(|f| f.poll_err_ms).unwrap_or(0);
                if inject_err_ms > 0 {
                    let (mid_tx, mid_rx) = std::sync::mpsc::channel::<RawEvent>();
                    std::thread::spawn(move || {
                        // 实时透传真实事件（recv_timeout 轮转，不积压——积压会
                        // 让 Err 先于缓冲事件到达，会话被杀时丢变更）；deadline
                        // 到达后注入一次 Err，此后继续透传直到通道断开（会话被
                        // 聚合线程丢弃 → keepalive watcher drop → raw_rx 断开）。
                        let deadline = std::time::Instant::now() + Duration::from_millis(inject_err_ms);
                        loop {
                            let remain = deadline.saturating_duration_since(std::time::Instant::now());
                            if remain.is_zero() {
                                let _ = mid_tx.send(Err(NotifyError::io(std::io::Error::other(
                                    "injected: poll session runtime error",
                                ))));
                                while let Ok(ev) = raw_rx.recv() {
                                    if mid_tx.send(ev).is_err() {
                                        break;
                                    }
                                }
                                return;
                            }
                            match raw_rx.recv_timeout(remain) {
                                Ok(ev) => {
                                    if mid_tx.send(ev).is_err() {
                                        return; // 会话已被丢弃（重建竞态）
                                    }
                                }
                                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return,
                            }
                        }
                    });
                    return Ok((Box::new(w) as Box<dyn Send>, mid_rx, "Poll".to_string()));
                }
                Ok((Box::new(w) as Box<dyn Send>, raw_rx, "Poll".to_string()))
            }),
        }
    }

    /// 阻塞直到成功建立会话或 stop 置位（返回 None）。每次尝试失败经 tracing 记日志。
    fn build(&mut self, stop: &AtomicBool) -> Option<WatchSession> {
        if self.prefer_poll {
            if stop.load(Ordering::SeqCst) {
                return None;
            }
            self.poll_rebuilds = self.poll_rebuilds.saturating_add(1);
            if self.poll_rebuilds.is_multiple_of(POLL_PROBE_EVERY) {
                match (self.open_recommended)() {
                    Ok((keep, rx, backend)) => {
                        self.prefer_poll = false;
                        info!(
                            "[watch] recommended probe succeeded, restored realtime watcher backend={backend} root={}",
                            self.root.display()
                        );
                        return Some(WatchSession::new(keep, rx, backend, false));
                    }
                    Err(e) => {
                        warn!(
                            "[watch] recommended probe failed (next probe in {POLL_PROBE_EVERY} rebuilds) root={} err={e:?}",
                            self.root.display()
                        );
                    }
                }
            }
            match (self.open_poll)() {
                Ok((keep, rx, backend)) => return Some(WatchSession::new(keep, rx, backend, true)),
                Err(e) => {
                    warn!(
                        "[watch] preferred PollWatcher failed root={} err={e:?}",
                        self.root.display()
                    );
                    self.prefer_poll = false;
                }
            }
        }
        for attempt in 0..self.policy.attempts {
            if stop.load(Ordering::SeqCst) {
                return None;
            }
            match (self.open_recommended)() {
                Ok((keep, rx, backend)) => return Some(WatchSession::new(keep, rx, backend, false)),
                Err(e) => {
                    warn!(
                        "[watch] watcher establish failed (retry {}/{}) root={} err={e:?}",
                        attempt + 1,
                        self.policy.attempts,
                        self.root.display()
                    );
                }
            }
            if let Some(d) = self.policy.backoffs.get(attempt as usize) {
                if !d.is_zero() {
                    std::thread::sleep(*d);
                }
            }
        }
        // 降级 PollWatcher（轮询，跨文件系统可用）；探试计数从降级时点重新计
        match (self.open_poll)() {
            Ok((keep, rx, backend)) => {
                self.prefer_poll = true;
                self.poll_rebuilds = 0;
                warn!(
                    "[watch] degraded to PollWatcher (interval {:?}) root={}",
                    self.policy.poll_interval,
                    self.root.display()
                );
                return Some(WatchSession::new(keep, rx, backend, true));
            }
            Err(e) => {
                error!(
                    "[watch] PollWatcher fallback failed root={} err={e:?}",
                    self.root.display()
                );
            }
        }
        // 兜底：无限退避重试 recommended，直到 stop（日志限频防刷屏）
        let mut misses: u32 = 0;
        loop {
            if stop.load(Ordering::SeqCst) {
                return None;
            }
            if !self.policy.fallback_backoff.is_zero() {
                std::thread::sleep(self.policy.fallback_backoff);
            }
            match (self.open_recommended)() {
                Ok((keep, rx, backend)) => {
                    info!(
                        "[watch] watcher established after {misses} fallback failures root={}",
                        self.root.display()
                    );
                    return Some(WatchSession::new(keep, rx, backend, false));
                }
                Err(e) => {
                    misses += 1;
                    if misses == 1 || misses.is_multiple_of(12) {
                        warn!(
                            "[watch] watcher still unavailable ({misses} failures) root={} err={e:?}",
                            self.root.display()
                        );
                    }
                }
            }
        }
    }
}

/// 聚合与自愈主循环（每根一个）：建立会话 → 聚合事件直到错误/停止 → 重建。
/// 状态转换时广播对应帧（各一次）：降级发 `watch-degraded`、恢复实时发
/// `watch-recovered`，changed 帧照常。会话异常只把本根槽位置为 Recovering、
/// 不广播帧——`watch-error` 在前端是终态语义（断开不重连），广播会令全部存量
/// 活跃连接永久失联、自愈帧到不了任何存活客户端；自愈表达为恢复后的
/// watch-recovered/watch-degraded 与 changed 恢复流动。重建重试循环（build 内）
/// 不发帧。多根部署时各根独立运行本循环：只写本根健康槽位（聚合在读取时
/// 计算，任一根的建立/故障不覆写其余根），changed 帧按 `root_idx` 标注
/// （`total_roots` = 1 时保持历史形状，不带 root 字段）。
#[allow(clippy::too_many_arguments)]
pub(super) fn run_loop(
    initial: Option<WatchSession>,
    mut factory: RetryFactory,
    tx: broadcast::Sender<String>,
    health: Arc<HealthSlots>,
    stop: Arc<AtomicBool>,
    root: PathBuf,
    root_idx: usize,
    total_roots: usize,
) {
    let mut session = initial;
    // prev 以自身会话健康初始化（spawn_with 已按首建结果写入本根槽位）：
    // 首建成功的根首轮无状态转换（不发帧），也不会把他根槽位/聚合推向 Ok
    let mut prev = health.get(root_idx);
    // 运行期错误日志限频：跨会话共享一个窗口（BUG-68 抑制层，防高频错误刷日志）
    let mut gate = ErrorLogGate::new(Duration::from_secs(60));
    loop {
        let sess = match session.take() {
            Some(s) => s,
            None => match factory.build(&stop) {
                Some(s) => s,
                None => return, // stop：ChangeHub 已销毁
            },
        };

        // 建立成功：只写本根槽位（聚合在读取时计算），状态变化才发帧
        //（重试期间不重复发）。prev 不在此处更新：错误分支（或优雅退出）是
        // 循环内唯一的后续路径，下一轮比较用到的是 Recovering——重复发帧由
        // 「状态变化才发」天然抑制。
        let next = if sess.degraded { WatchHealth::Degraded } else { WatchHealth::Ok };
        health.set(root_idx, next);
        if next != prev {
            let payload = match next {
                WatchHealth::Ok => json!({ "type": "watch-recovered", "backend": sess.backend }),
                WatchHealth::Degraded => {
                    json!({ "type": "watch-degraded", "backend": sess.backend })
                }
                // 建立只产生 Ok/Degraded；Recovering 仅在错误分支设置
                WatchHealth::Recovering => unreachable!(),
            };
            let _ = tx.send(payload.to_string());
        }

        let errored = session_loop(sess, root_idx, &root, total_roots, &tx, &stop, &mut gate);
        if !errored || stop.load(Ordering::SeqCst) {
            return; // 优雅退出（stop / watcher 句柄被丢弃）
        }
        // 运行期错误：进入 Recovering。不广播 "watch-error"——前端对其按终态
        // 处理（断开不重连），广播会令全部存量活跃连接永久失联、自愈后的
        // watch-recovered/changed 到不了任何存活客户端；状态经 health 快照
        // （新连接 watch-degraded 帧）与恢复后的状态帧表达
        prev = WatchHealth::Recovering;
        health.set(root_idx, WatchHealth::Recovering);
    }
}

/// 单会话聚合循环：首个事件开窗，窗口内事件全部合并为一条 changed 帧。
/// 返回 true = 会话异常（收到运行期 Err，调用方应重建）；false = 优雅退出
/// （stop 置位或 watcher 句柄被丢弃致通道断开）。`gate` 为错误日志限频器，
/// 跨会话由 `run_loop` 持有（重建不重置窗口）。聚合按根归组
/// （`BTreeMap<根索引, 路径集合>`），窗口关闭时逐根发帧——单根时帧与历史
/// 形状逐字节一致，多根时每帧携带 `"root": <idx>`。
fn session_loop(
    session: WatchSession,
    root_idx: usize,
    root: &Path,
    total_roots: usize,
    tx: &broadcast::Sender<String>,
    stop: &AtomicBool,
    gate: &mut ErrorLogGate,
) -> bool {
    let WatchSession { _keepalive, rx, .. } = session;
    loop {
        // 以 DEBOUNCE_WINDOW 作为空闲等待：每窗醒一次检查 stop（销毁信号）
        match rx.recv_timeout(DEBOUNCE_WINDOW) {
            Ok(Err(e)) => {
                match gate.admit(Instant::now()) {
                    Admission::First => warn!("[watch] runtime error, will rebuild: {e:?}"),
                    Admission::Suppressed => {}
                    Admission::Summary(n) => {
                        warn!("[watch] runtime error window: {n} suppressed, latest: {e:?}")
                    }
                }
                return true;
            }
            Ok(Ok(first)) => {
                let mut paths: BTreeMap<usize, BTreeSet<String>> = BTreeMap::new();
                collect_event(&first, root_idx, root, &mut paths);

                // 固定窗口：从首个事件起 DEBOUNCE_WINDOW 内继续吸收后续事件
                let deadline = Instant::now() + DEBOUNCE_WINDOW;
                loop {
                    let remaining = deadline.saturating_duration_since(Instant::now());
                    if remaining.is_zero() {
                        break;
                    }
                    match rx.recv_timeout(remaining) {
                        Ok(Ok(ev)) => collect_event(&ev, root_idx, root, &mut paths),
                        // 窗口内混入错误同样按会话异常处理：若故障仅以这一个 Err
                        // 事件表现（此后无事件），不重建会卡在空转
                        Ok(Err(_)) => {
                            // 该分支不含错误详情：First/Suppressed 静默（无处记
                            // 详情）；Summary 仍须输出无详情摘要——窗口恰在此
                            // 过期时 admit 已清零计数，丢弃返回值会使被抑制的
                            // n 条永不进入任何摘要
                            match gate.admit(Instant::now()) {
                                Admission::Summary(n) => {
                                    warn!("[watch] runtime error window: {n} suppressed")
                                }
                                Admission::First | Admission::Suppressed => {}
                            }
                            return true;
                        }
                        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => break,
                        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return false,
                    }
                }

                // 窗口内全是 Access（或空事件）→ 无真实变更，不广播
                if paths.is_empty() {
                    continue;
                }

                // 逐根发帧：BTreeMap 迭代序 = 根索引升序，帧序确定
                for (idx, set) in paths {
                    let mut payload =
                        json!({ "type": "changed", "paths": set.into_iter().collect::<Vec<_>>() });
                    if total_roots > 1 {
                        payload["root"] = json!(idx);
                    }
                    // 无订阅者时 send 失败属正常（无连接即丢弃）
                    let _ = tx.send(payload.to_string());
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                if stop.load(Ordering::SeqCst) {
                    return false;
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return false,
        }
    }
}

/// 创建 recommended watcher 并递归 watch root；事件经 raw channel 交给聚合线程。
fn open_recommended(
    root: &Path,
) -> Result<(RecommendedWatcher, std::sync::mpsc::Receiver<RawEvent>), NotifyError> {
    let (raw_tx, raw_rx) = std::sync::mpsc::channel::<RawEvent>();
    let mut watcher = RecommendedWatcher::new(
        move |res: RawEvent| {
            let _ = raw_tx.send(res);
        },
        // BUG-68：扫描不跟随 symlink——越界 symlink（如 → /etc）内的权限错误
        // 不再使建监听失败/重扫报错；symlink 条目自身的增删改仍上报
        NotifyConfig::default().with_follow_symlinks(false),
    )?;
    watcher.watch(root, RecursiveMode::Recursive)?;
    Ok((watcher, raw_rx))
}

/// 创建 PollWatcher（轮询，跨文件系统可用）并递归 watch root。
fn open_poll(
    root: &Path,
    poll_interval: Duration,
) -> Result<(PollWatcher, std::sync::mpsc::Receiver<RawEvent>), NotifyError> {
    let (raw_tx, raw_rx) = std::sync::mpsc::channel::<RawEvent>();
    let mut watcher = PollWatcher::new(
        move |res| {
            let _ = raw_tx.send(res);
        },
        // 同 open_recommended：poll 扫描也不跟随 symlink（BUG-68）
        NotifyConfig::default()
            .with_poll_interval(poll_interval)
            .with_follow_symlinks(false),
    )?;
    watcher.watch(root, RecursiveMode::Recursive)?;
    Ok((watcher, raw_rx))
}

/// 从 watcher 的 Debug 形式提取后端名（如 `Inotify(...)` → "Inotify"），诊断用。
fn backend_name(w: &impl std::fmt::Debug) -> String {
    format!("{w:?}")
        .split(['(', ' '])
        .next()
        .unwrap_or("unknown")
        .to_string()
}

/// /proc/self/mounts 的挂载点含八进制转义（\040 空格等），解码为原始路径。
/// 内核输出的是 UTF-8 字节序列转义（如 é 为 \303\251 两个字节），故按字节
/// 累积、行结束后整体按 UTF-8 还原（非 UTF-8 字节经 lossy 替换，仅诊断用途）。
#[cfg(target_os = "linux")]
pub(super) fn unescape_mount(s: &str) -> Option<PathBuf> {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        // \NNN 三位八进制转义；预检后续 3 字节均为 ASCII 数字（保证 str 切片
        // 边界安全），from_str_radix 拒绝 8/9 时按字面量回退
        if bytes[i] == b'\\'
            && i + 4 <= bytes.len()
            && bytes[i + 1..i + 4].iter().all(u8::is_ascii_digit)
        {
            let oct = &s[i + 1..i + 4];
            if let Ok(v) = u8::from_str_radix(oct, 8) {
                out.push(v);
                i += 4;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    Some(PathBuf::from(String::from_utf8_lossy(&out).into_owned()))
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::time::{Duration, Instant};

    use notify::Error as NotifyError;

    use super::super::ChangeHub;
    use super::super::testkit::{
        endless_ok_opener, factory, fail_n_then_ok_opener, fast_policy, scripted_opener,
    };
    #[cfg(unix)]
    use super::super::testkit::make_root_with_escape_symlink;
    use super::*;

    /// 限频器：窗口首条直记（First）；窗口内后续静默累计（Suppressed）；窗口过期后
    /// 的首条以摘要形式输出累计数（Summary(n)）并重开窗口（该条即新窗口首条语义）。
    #[test]
    fn error_log_gate_first_suppress_then_summary() {
        let t0 = Instant::now();
        let mut gate = ErrorLogGate::new(Duration::from_secs(60));
        assert!(matches!(gate.admit(t0), Admission::First));
        for i in 1..=5 {
            assert!(matches!(gate.admit(t0 + Duration::from_secs(i)), Admission::Suppressed));
        }
        // 窗口（60s）过期后的首条：Summary(5) 并重开窗口
        assert!(matches!(gate.admit(t0 + Duration::from_secs(61)), Admission::Summary(5)));
        // 新窗口内继续静默
        assert!(matches!(gate.admit(t0 + Duration::from_secs(62)), Admission::Suppressed));
    }

    /// 窗口过期但期间零抑制：按新窗口首条（First）重开，而非 Summary(0)——
    /// 避免输出「0 suppressed」噪声摘要行。
    #[test]
    fn error_log_gate_expired_window_without_suppression_reopens_as_first() {
        let t0 = Instant::now();
        let mut gate = ErrorLogGate::new(Duration::from_secs(60));
        assert!(matches!(gate.admit(t0), Admission::First));
        // 窗口内无任何被抑制的错误，过期后的下一条应为首条语义（非空摘要）
        assert!(matches!(gate.admit(t0 + Duration::from_secs(61)), Admission::First));
        // 重开的窗口内继续静默累计，摘要数值正确
        assert!(matches!(gate.admit(t0 + Duration::from_secs(62)), Admission::Suppressed));
        assert!(matches!(gate.admit(t0 + Duration::from_secs(125)), Admission::Summary(1)));
    }

    /// 降级后每 POLL_PROBE_EVERY 次重建探试一次 recommended：探试失败回落
    /// PollWatcher，暂时性故障解除后探试成功即回归实时（不再永久降级）。
    #[test]
    fn prefer_poll_probes_recommended_periodically() {
        let stop = AtomicBool::new(false);
        let rec_fails = Arc::new(AtomicUsize::new(0));
        // 探试失败路径：recommended 恒败
        let mut f = factory(
            scripted_opener(vec![], rec_fails.clone()),
            endless_ok_opener("mock-poll"),
        );
        // build#1：recommended 3 连败 → poll 降级（prefer_poll=true, 计数清零）
        let s1 = f.build(&stop).unwrap();
        assert!(s1.degraded, "首次降级应为 poll 会话");
        // build#2..#6：prefer 分支计数到 5（POLL_PROBE_EVERY）时触发探试
        // （recommended 恒败 → 回落 poll）
        for i in 1..=5 {
            let s = f.build(&stop).unwrap();
            assert!(s.degraded, "探试失败应回落 poll 会话（build #{})", i + 1);
        }
        assert_eq!(
            rec_fails.load(Ordering::SeqCst),
            3 + 1,
            "recommended 应被调用 3（首次重试）+1（探试）次"
        );
        assert!(f.prefer_poll, "探试失败应维持降级偏好");

        // 探试成功路径：recommended 第 4 次调用起成功（build#1 耗 3 次，
        // build#7 探试即第 4 次调用成功 → 回归实时）
        let (tx, rx) = std::sync::mpsc::channel();
        let rec_fails2 = Arc::new(AtomicUsize::new(0));
        let mut f2 = factory(
            fail_n_then_ok_opener(3, tx.clone(), rx, "mock-rec", rec_fails2.clone()),
            endless_ok_opener("mock-poll"),
        );
        let s = f2.build(&stop).unwrap(); // #1: rec x3 失败 → poll 降级
        assert!(s.degraded);
        for _ in 0..4 {
            assert!(f2.build(&stop).unwrap().degraded, "#2..#5 应为 poll 会话");
        }
        let s = f2.build(&stop).unwrap(); // #6: 探试（rec 第 4 次调用）成功
        assert!(!s.degraded, "探试成功应回归实时会话: degraded={}", s.degraded);
        assert_eq!(s.backend, "mock-rec");
        assert!(!f2.prefer_poll, "探试成功应清除降级偏好");
        // 此后重建走 recommended 正常分支（与 build#1 同一代码路径，不再断言）
    }

    /// 真实不可 watch 的 root：同步首建失败 → health 非 Ok；后台重试/降级全败后
    /// 仍不得转为 Ok（兜底无限重试接管）。
    #[test]
    fn unwatchable_root_never_becomes_ok() {
        let root = PathBuf::from("/nonexistent-vviewer-watch-root-xyz");
        let hub = ChangeHub::spawn_with(
            std::slice::from_ref(&root),
            vec![RetryFactory::notify(root.clone(), fast_policy(), None)],
        );
        assert_ne!(hub.health(), WatchHealth::Ok, "首建失败即非 Ok");
        std::thread::sleep(Duration::from_millis(300));
        assert_ne!(hub.health(), WatchHealth::Ok, "不可 watch 的 root 不应转为 Ok");
        // drop 触发 stop：兜底无限重试循环随之退出（不 join，随进程回收）
    }

    /// 降级路径（PollWatcher）同样不深入 symlink：强制降级后，root 内真实文件的
    /// 变更仍能经 pollscan 聚合为 changed（越界 symlink 不阻断扫描、不产生错误事件）。
    #[cfg(unix)]
    #[test]
    fn poll_session_over_escape_symlink_still_delivers_changed() {
        let dir = tempfile::tempdir().unwrap();
        let root = make_root_with_escape_symlink(dir.path());
        let stop = AtomicBool::new(false);
        let rec_fails = Arc::new(AtomicUsize::new(0));
        let poll_root = root.clone();
        let open_rec: Opener = Box::new(move || {
            rec_fails.fetch_add(1, Ordering::SeqCst);
            Err(NotifyError::io(std::io::Error::other("forced degrade")))
        });
        let open_poll: Opener = Box::new(move || {
            let (w, rx) = open_poll(&poll_root, Duration::from_millis(50))?;
            Ok((Box::new(w) as Box<dyn Send>, rx, "Poll".to_string()))
        });
        let mut factory = factory(open_rec, open_poll);
        let session = factory.build(&stop).expect("降级 poll 会话应建立成功");
        assert!(session.degraded);
        // 写一个真实文件，等 ≥2 个轮询周期，断言收到该路径的事件（无 Err 事件）
        std::fs::write(root.join("seed.txt"), "x").unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        let mut saw_seed = false;
        while Instant::now() < deadline {
            match session.rx.recv_timeout(Duration::from_millis(100)) {
                Ok(Ok(ev)) => {
                    let mut out: BTreeMap<usize, BTreeSet<String>> = BTreeMap::new();
                    collect_event(&ev, 0, &root, &mut out);
                    if out.get(&0).is_some_and(|s| s.iter().any(|p| p.contains("seed.txt"))) {
                        saw_seed = true;
                        break;
                    }
                }
                Ok(Err(_)) => panic!("poll 会话不得产生错误事件（BUG-68 刷屏源应消失）"),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
                Err(_) => panic!("事件通道意外断开"),
            }
        }
        assert!(saw_seed, "3s 内应收到 seed.txt 的变更事件");
        drop(session);
        std::fs::set_permissions(
            dir.path().join("outside/locked"),
            std::os::unix::fs::PermissionsExt::from_mode(0o700),
        )
        .ok();
    }
}
