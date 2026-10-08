//! root 变更监听（notify 递归 watch）与 500ms debounce 聚合广播，含故障自愈。
//!
//! watcher 在服务器启动时由 `ChangeHub::spawn` 创建一次（挂在 AppState 内），
//! 而非每个 SSE 连接各建一个：notify 事件 → std mpsc → 聚合线程把 500ms 窗口内
//! 的多事件合并为一条 `{"type":"changed","paths":[...]}`（相对 root、排序去重）
//! → tokio broadcast 分发给所有订阅的 SSE 连接。
//!
//! 自愈（BUG-02）：启动失败保留 Err 写 stderr 日志（含 OS 错误码与 root 路径）
//! 并在后台线程退避重试，连续失败降级 `PollWatcher`（轮询，跨文件系统可用）继续
//! 广播 changed，之后周期性探试 recommended（暂时性故障解除后回归实时）；运行期
//! 错误丢弃当前 watcher 重建，恢复实时监听后广播 `{"type":"watch-recovered"}`。
//! 健康状态 `Ok / Recovering / Degraded` 经 `ChangeHub::health` 暴露，SSE 建连
//! 按快照发降级帧（非 Ok 统一 `watch-degraded`——`watch-error` 在前端是终态
//! 语义，见 `snapshot_frame`；运行期错误同样不广播它，自愈经状态帧与恢复的
//! changed 表达）。
//!
//! 全同步实现（聚合走 std 线程 + `recv_timeout`，watcher 重建同在聚合线程内）：
//! `AppState::new` 无需 tokio runtime 也可构造（main 在进入 runtime 前构造
//! state，测试在任意上下文构造）。

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use notify::{
    Config as NotifyConfig, Error as NotifyError, Event as NotifyEvent, PollWatcher,
    RecommendedWatcher, RecursiveMode, Watcher,
};
use serde_json::json;
use tokio::sync::broadcast;

/// debounce 聚合窗口：首个事件到达后等这么久，窗口内的后续事件并入同一条 changed。
pub const DEBOUNCE_WINDOW: Duration = Duration::from_millis(500);

/// broadcast 队列深度：慢连接积压超过后直接丢帧（Lagged），客户端下次刷新自愈。
const CHANNEL_CAPACITY: usize = 64;

/// watcher 健康状态：SSE 建连快照帧与运行期状态帧的依据。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WatchHealth {
    /// 实时 watcher 正常，changed 实时推送。
    Ok,
    /// watcher 故障，正在退避重建（期间 watch-error 只广播一次）。
    Recovering,
    /// 实时 watcher 不可用，已降级 PollWatcher 轮询（changed 仍广播，非实时）。
    Degraded,
}

impl WatchHealth {
    fn to_u8(self) -> u8 {
        self as u8
    }

    fn from_u8(v: u8) -> Self {
        match v {
            0 => WatchHealth::Ok,
            1 => WatchHealth::Recovering,
            _ => WatchHealth::Degraded,
        }
    }

    /// SSE 建连快照帧 type：Ok 无帧；Recovering/Degraded 均发 `watch-degraded`。
    /// 不可用 `watch-error`：前端 remote.ts 对其按终态处理（断开且不重连），
    /// 会令 Recovering 窗口内建连的 tab 永久失联、服务端随后的
    /// watch-recovered/changed 全部无效。`watch-degraded` 是前端未知 type，
    /// 天然忽略、连接保持：服务端自愈后 changed 自然恢复流动，同时留作
    /// 诊断线索与未来客户端展示降级/恢复提示的挂点。
    pub fn snapshot_frame(self) -> Option<&'static str> {
        match self {
            WatchHealth::Ok => None,
            WatchHealth::Recovering | WatchHealth::Degraded => Some("watch-degraded"),
        }
    }
}

/// 共享变更广播中心：一个 watcher + 一个聚合线程，服务全部 SSE 连接。
/// watcher 句柄移入聚合线程（自愈重建需在错误现场执行），销毁经 stop 标志。
pub struct ChangeHub {
    tx: broadcast::Sender<String>,
    health: Arc<AtomicU8>,
    /// ChangeHub 销毁（最后一个 Arc 释放）时置位：聚合线程停止建 watch 并退出。
    stop: Arc<AtomicBool>,
}

impl Drop for ChangeHub {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}

impl ChangeHub {
    /// 创建递归 watcher 并启动聚合线程；失败不降级为永久静默（后台自愈接管）。
    pub fn spawn(root: &Path) -> Arc<Self> {
        Self::spawn_with(
            root,
            RetryFactory::notify(root.to_path_buf(), RetryPolicy::default()),
        )
    }

    /// 注入工厂的 spawn：同步首建一次（不重试），spawn 返回时健康状态即确定，
    /// SSE 建连快照无竞态；启动失败的退避重试与 PollWatcher 降级移交后台线程，
    /// 不拖慢服务器启动。测试注入 mock opener 驱动状态机各分支。
    fn spawn_with(root: &Path, mut factory: RetryFactory) -> Arc<Self> {
        let (tx, _) = broadcast::channel(CHANNEL_CAPACITY);
        let health = Arc::new(AtomicU8::new(WatchHealth::Recovering.to_u8()));
        let stop = Arc::new(AtomicBool::new(false));

        // 诊断补丁（BUG-02）：数据根的文件系统类型，便于 e2e 环境判读（如 btrfs）
        eprintln!(
            "[watch] root={} fstype={}",
            root.display(),
            fs_type_of(root).unwrap_or_else(|| "unknown".into())
        );

        let initial = match (factory.open_recommended)() {
            Ok((keep, rx, backend)) => {
                eprintln!("[watch] watcher established backend={backend} root={}", root.display());
                health.store(WatchHealth::Ok.to_u8(), Ordering::SeqCst);
                Some(WatchSession::new(keep, rx, backend, false))
            }
            Err(e) => {
                // 含 OS 错误码（Debug 格式的 Os { code: .. }）与 root 路径
                eprintln!(
                    "[watch] watcher startup FAILED root={} err={e:?}; retrying in background (backoff x{}, then PollWatcher fallback)",
                    root.display(),
                    factory.policy.attempts
                );
                None
            }
        };
        let thread_root = root.to_path_buf();
        // 不持有 JoinHandle：ChangeHub drop → stop 置位后线程自行退出
        let (thread_tx, thread_health, thread_stop) = (tx.clone(), health.clone(), stop.clone());
        std::thread::spawn(move || {
            run_loop(initial, factory, thread_tx, thread_health, thread_stop, thread_root)
        });
        Arc::new(Self { tx, health, stop })
    }

    /// SSE 连接订阅：返回的 Receiver 被 drop 即代表连接断开、自动清理。
    pub fn subscribe(&self) -> broadcast::Receiver<String> {
        self.tx.subscribe()
    }

    /// 当前 watcher 健康状态（SSE 建连快照用）。
    pub fn health(&self) -> WatchHealth {
        WatchHealth::from_u8(self.health.load(Ordering::SeqCst))
    }
}

type RawEvent = Result<NotifyEvent, NotifyError>;

/// 一次成功建立的 watcher 会话：事件接收端 + 保活句柄（drop 即断流）。
struct WatchSession {
    /// notify watcher（或 mock 的发送端）：保活 raw channel；drop 后 rx Disconnected。
    _keepalive: Box<dyn Send>,
    rx: std::sync::mpsc::Receiver<RawEvent>,
    /// 后端名（如 Inotify/Poll），日志与 watch-recovered/watch-degraded 帧携带。
    backend: String,
    /// true = 会话来自 PollWatcher 降级：健康状态记 Degraded 而非 Ok。
    degraded: bool,
}

impl WatchSession {
    fn new(
        keepalive: Box<dyn Send>,
        rx: std::sync::mpsc::Receiver<RawEvent>,
        backend: String,
        degraded: bool,
    ) -> Self {
        Self { _keepalive: keepalive, rx, backend, degraded }
    }
}

/// 建立 watcher 的结果：保活句柄 + 事件接收端 + 后端名。
type OpenOutcome = Result<(Box<dyn Send>, std::sync::mpsc::Receiver<RawEvent>, String), NotifyError>;
type Opener = Box<dyn FnMut() -> OpenOutcome + Send>;

/// 重试策略（启动失败与运行期重建共用）。
struct RetryPolicy {
    /// recommended watcher 重试次数（不含 `ChangeHub::spawn` 的同步首建）。
    attempts: u32,
    /// 第 n 次重试前的退避时长（按索引取，越界视为不再等待）。
    backoffs: Vec<Duration>,
    /// 降级 PollWatcher 的轮询间隔（≥2s，权衡 CPU）。
    poll_interval: Duration,
    /// PollWatcher 也失败后的兜底无限重试间隔。
    fallback_backoff: Duration,
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

/// watcher 建立工厂：recommended 退避重试 → PollWatcher 降级（并记忆偏好，
/// 每 POLL_PROBE_EVERY 次重建探试一次 recommended）→ 兜底无限重试（root 暂时
/// 不可达时，条件移除后自愈）。opener 可注入（测试用 mock 会话替换真实 notify
/// 构建）。
struct RetryFactory {
    root: PathBuf,
    policy: RetryPolicy,
    /// 上次降级成功后优先重试 PollWatcher，避免每次重建空耗 recommended 重试窗口；
    /// 探试周期见 `POLL_PROBE_EVERY`。
    prefer_poll: bool,
    /// prefer_poll 生效期间经历的重建次数（探试计数）。
    poll_rebuilds: u32,
    open_recommended: Opener,
    open_poll: Opener,
}

impl RetryFactory {
    /// 生产 opener 组装：recommended（inotify 等）与固定间隔 PollWatcher。
    fn notify(root: PathBuf, policy: RetryPolicy) -> Self {
        let rec_root = root.clone();
        let poll_root = root.clone();
        let poll_interval = policy.poll_interval;
        Self {
            root,
            policy,
            prefer_poll: false,
            poll_rebuilds: 0,
            open_recommended: Box::new(move || {
                let (w, rx) = open_recommended(&rec_root)?;
                let backend = backend_name(&w);
                Ok((Box::new(w) as Box<dyn Send>, rx, backend))
            }),
            open_poll: Box::new(move || {
                let (w, rx) = open_poll(&poll_root, poll_interval)?;
                Ok((Box::new(w) as Box<dyn Send>, rx, "Poll".to_string()))
            }),
        }
    }

    /// 阻塞直到成功建立会话或 stop 置位（返回 None）。每次尝试失败写 stderr 日志。
    fn build(&mut self, stop: &AtomicBool) -> Option<WatchSession> {
        if self.prefer_poll {
            if stop.load(Ordering::SeqCst) {
                return None;
            }
            self.poll_rebuilds = self.poll_rebuilds.saturating_add(1);
            if self.poll_rebuilds % POLL_PROBE_EVERY == 0 {
                match (self.open_recommended)() {
                    Ok((keep, rx, backend)) => {
                        self.prefer_poll = false;
                        eprintln!(
                            "[watch] recommended probe succeeded, restored realtime watcher backend={backend} root={}",
                            self.root.display()
                        );
                        return Some(WatchSession::new(keep, rx, backend, false));
                    }
                    Err(e) => {
                        eprintln!(
                            "[watch] recommended probe failed (next probe in {POLL_PROBE_EVERY} rebuilds) root={} err={e:?}",
                            self.root.display()
                        );
                    }
                }
            }
            match (self.open_poll)() {
                Ok((keep, rx, backend)) => return Some(WatchSession::new(keep, rx, backend, true)),
                Err(e) => {
                    eprintln!(
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
                    eprintln!(
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
                eprintln!(
                    "[watch] degraded to PollWatcher (interval {:?}) root={}",
                    self.policy.poll_interval,
                    self.root.display()
                );
                return Some(WatchSession::new(keep, rx, backend, true));
            }
            Err(e) => {
                eprintln!(
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
                    eprintln!(
                        "[watch] watcher established after {misses} fallback failures root={}",
                        self.root.display()
                    );
                    return Some(WatchSession::new(keep, rx, backend, false));
                }
                Err(e) => {
                    misses += 1;
                    if misses == 1 || misses % 12 == 0 {
                        eprintln!(
                            "[watch] watcher still unavailable ({misses} failures) root={} err={e:?}",
                            self.root.display()
                        );
                    }
                }
            }
        }
    }
}

/// 聚合与自愈主循环：建立会话 → 聚合事件直到错误/停止 → 重建。状态转换时
/// 广播对应帧（各一次）：降级发 `watch-degraded`、恢复实时发 `watch-recovered`，
/// changed 帧照常。会话异常只把健康置为 Recovering、不广播帧——`watch-error`
/// 在前端是终态语义（断开不重连），广播会令全部存量活跃连接永久失联、自愈
/// 帧到不了任何存活客户端；自愈表达为恢复后的 watch-recovered/watch-degraded
/// 与 changed 恢复流动。重建重试循环（build 内）不发帧。
fn run_loop(
    initial: Option<WatchSession>,
    mut factory: RetryFactory,
    tx: broadcast::Sender<String>,
    health: Arc<AtomicU8>,
    stop: Arc<AtomicBool>,
    root: PathBuf,
) {
    let mut session = initial;
    let mut prev = WatchHealth::from_u8(health.load(Ordering::SeqCst));
    loop {
        let sess = match session.take() {
            Some(s) => s,
            None => match factory.build(&stop) {
                Some(s) => s,
                None => return, // stop：ChangeHub 已销毁
            },
        };

        // 建立成功：更新健康状态，状态变化才发帧（重试期间不重复发）。
        // prev 不在此处更新：错误分支（或优雅退出）是循环内唯一的后续路径，
        // 下一轮比较用到的是 Recovering——重复发帧由「状态变化才发」天然抑制。
        let next = if sess.degraded { WatchHealth::Degraded } else { WatchHealth::Ok };
        health.store(next.to_u8(), Ordering::SeqCst);
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

        let errored = session_loop(sess, &root, &tx, &stop);
        if !errored || stop.load(Ordering::SeqCst) {
            return; // 优雅退出（stop / watcher 句柄被丢弃）
        }
        // 运行期错误：进入 Recovering。不广播 "watch-error"——前端对其按终态
        // 处理（断开不重连），广播会令全部存量活跃连接永久失联、自愈后的
        // watch-recovered/changed 到不了任何存活客户端；状态经 health 快照
        // （新连接 watch-degraded 帧）与恢复后的状态帧表达
        prev = WatchHealth::Recovering;
        health.store(WatchHealth::Recovering.to_u8(), Ordering::SeqCst);
    }
}

/// 单会话聚合循环：首个事件开窗，窗口内事件全部合并为一条 changed 帧。
/// 返回 true = 会话异常（收到运行期 Err，调用方应重建）；false = 优雅退出
/// （stop 置位或 watcher 句柄被丢弃致通道断开）。
fn session_loop(
    session: WatchSession,
    root: &Path,
    tx: &broadcast::Sender<String>,
    stop: &AtomicBool,
) -> bool {
    let WatchSession { _keepalive, rx, .. } = session;
    loop {
        // 以 DEBOUNCE_WINDOW 作为空闲等待：每窗醒一次检查 stop（销毁信号）
        match rx.recv_timeout(DEBOUNCE_WINDOW) {
            Ok(Err(e)) => {
                eprintln!("[watch] runtime error, will rebuild: {e:?}");
                return true;
            }
            Ok(Ok(first)) => {
                let mut paths = BTreeSet::new();
                collect_event(&first, root, &mut paths);

                // 固定窗口：从首个事件起 DEBOUNCE_WINDOW 内继续吸收后续事件
                let deadline = Instant::now() + DEBOUNCE_WINDOW;
                loop {
                    let remaining = deadline.saturating_duration_since(Instant::now());
                    if remaining.is_zero() {
                        break;
                    }
                    match rx.recv_timeout(remaining) {
                        Ok(Ok(ev)) => collect_event(&ev, root, &mut paths),
                        // 窗口内混入错误同样按会话异常处理：若故障仅以这一个 Err
                        // 事件表现（此后无事件），不重建会卡在空转
                        Ok(Err(_)) => return true,
                        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => break,
                        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return false,
                    }
                }

                // 窗口内全是 Access（或空事件）→ 无真实变更，不广播
                if paths.is_empty() {
                    continue;
                }

                let payload =
                    json!({ "type": "changed", "paths": paths.into_iter().collect::<Vec<_>>() });
                // 无订阅者时 send 失败属正常（无连接即丢弃）
                let _ = tx.send(payload.to_string());
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
    let mut watcher = notify::recommended_watcher(move |res| {
        let _ = raw_tx.send(res);
    })?;
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
        NotifyConfig::default().with_poll_interval(poll_interval),
    )?;
    watcher.watch(root, RecursiveMode::Recursive)?;
    Ok((watcher, raw_rx))
}

/// 从 watcher 的 Debug 形式提取后端名（如 `Inotify(...)` → "Inotify"），诊断用。
fn backend_name(w: &impl std::fmt::Debug) -> String {
    format!("{w:?}")
        .split(|c: char| c == '(' || c == ' ')
        .next()
        .unwrap_or("unknown")
        .to_string()
}

/// Linux：读 /proc/self/mounts 取覆盖 root 的最长挂载点文件系统类型（诊断用）。
#[cfg(target_os = "linux")]
fn fs_type_of(path: &Path) -> Option<String> {
    let target = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let mounts = std::fs::read_to_string("/proc/self/mounts").ok()?;
    let mut best: Option<(usize, String)> = None;
    for line in mounts.lines() {
        let mut fields = line.split_whitespace();
        let Some(_device) = fields.next() else { continue };
        let Some(mount_point) = fields.next().and_then(unescape_mount) else { continue };
        let Some(fstype) = fields.next() else { continue };
        if target.starts_with(&mount_point) {
            let len = mount_point.as_os_str().len();
            if best.as_ref().map_or(true, |(l, _)| len > *l) {
                best = Some((len, fstype.to_string()));
            }
        }
    }
    best.map(|(_, t)| t)
}

#[cfg(not(target_os = "linux"))]
fn fs_type_of(_path: &Path) -> Option<String> {
    None
}

/// /proc/self/mounts 的挂载点含八进制转义（\040 空格等），解码为原始路径。
/// 内核输出的是 UTF-8 字节序列转义（如 é 为 \303\251 两个字节），故按字节
/// 累积、行结束后整体按 UTF-8 还原（非 UTF-8 字节经 lossy 替换，仅诊断用途）。
#[cfg(target_os = "linux")]
fn unescape_mount(s: &str) -> Option<PathBuf> {
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

/// notify 事件（成功态）→ 相对 root 的路径集合（'/' 分隔，排序去重由 BTreeSet 保证）。
fn collect_event(ev: &NotifyEvent, root: &Path, out: &mut BTreeSet<String>) {
    // Access（打开/读取）不改变内容：过滤掉 watcher 自身的初始目录扫描事件，
    // 也避免 SSE 客户端查看文件（读操作）反过来触发一次无意义的变更推送
    if matches!(ev.kind, notify::EventKind::Access(_)) {
        return;
    }
    for p in &ev.paths {
        // root 外路径不进 changed 帧（防止绝对路径泄露给客户端）：直接跳过
        let Ok(rel) = p.strip_prefix(root) else { continue };
        // Windows 分隔符统一为 '/'，与 /api/tree、/api/file 的 path 参数一致
        out.insert(rel.to_string_lossy().replace('\\', "/"));
    }
}

/// 原始通道事件（含 Err）：错误事件不产生路径（由 session_loop 触发重建自愈）。
#[cfg(test)]
fn collect_paths(ev: &RawEvent, root: &Path, out: &mut BTreeSet<String>) {
    let Ok(ev) = ev else { return };
    collect_event(ev, root, out);
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc::{Receiver, Sender};
    use std::sync::atomic::AtomicUsize;

    use super::*;
    use notify::event::{AccessKind, AccessMode, CreateKind, EventKind};

    /// 构造带路径的 notify 事件（测试 collect_paths 的过滤语义）。
    fn ev(kind: EventKind, paths: &[&str]) -> RawEvent {
        let mut e = NotifyEvent::new(kind);
        for p in paths {
            e = e.add_path(PathBuf::from(p));
        }
        Ok(e)
    }

    #[test]
    fn access_events_and_out_of_root_paths_are_dropped() {
        let root = PathBuf::from("/srv/root");
        let mut out = BTreeSet::new();

        // Access 事件（如 watcher 自身初始扫描 / 客户端读文件）不构成变更
        collect_paths(
            &ev(
                EventKind::Access(AccessKind::Open(AccessMode::Any)),
                &["/srv/root/a.txt"],
            ),
            &root,
            &mut out,
        );
        assert!(out.is_empty(), "Access 事件应被过滤");

        // root 内路径转相对；root 外绝对路径跳过（不泄露给客户端）
        collect_paths(
            &ev(
                EventKind::Create(CreateKind::File),
                &["/srv/root/sub/b.txt", "/etc/passwd"],
            ),
            &root,
            &mut out,
        );
        assert_eq!(out, BTreeSet::from(["sub/b.txt".to_string()]));
    }

    #[test]
    fn snapshot_frame_matches_health_semantics() {
        assert_eq!(WatchHealth::Ok.snapshot_frame(), None);
        // Recovering/Degraded 统一发 watch-degraded：watch-error 在前端是终态
        // 语义（断开不重连），不得用于建连快照
        assert_eq!(WatchHealth::Recovering.snapshot_frame(), Some("watch-degraded"));
        assert_eq!(WatchHealth::Degraded.snapshot_frame(), Some("watch-degraded"));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn fs_type_of_resolves_mount_of_tmp() {
        let fstype = fs_type_of(Path::new("/tmp")).expect("/tmp 应有挂载点条目");
        assert!(!fstype.is_empty(), "fstype 应非空: {fstype}");
    }

    /// 极短退避：mock/真实故障注入测试毫秒级完成，不拖慢套件。
    fn fast_policy() -> RetryPolicy {
        RetryPolicy {
            attempts: 3,
            backoffs: vec![],
            poll_interval: Duration::from_millis(50),
            fallback_backoff: Duration::from_millis(2),
        }
    }

    /// 脚本式 opener：依次返回预置 mock 会话（事件通道 + 后端名）；脚本耗尽后
    /// 恒失败并计数（断言重试确有发生）。
    fn scripted_opener(
        sessions: Vec<(Sender<RawEvent>, Receiver<RawEvent>, &'static str)>,
        fails: Arc<AtomicUsize>,
    ) -> Opener {
        let mut queue = sessions.into_iter();
        Box::new(move || {
            if let Some((keep, rx, backend)) = queue.next() {
                return Ok((Box::new(keep) as Box<dyn Send>, rx, backend.to_string()));
            }
            fails.fetch_add(1, Ordering::SeqCst);
            Err(NotifyError::io(std::io::Error::other("mock session exhausted")))
        })
    }

    fn factory(open_recommended: Opener, open_poll: Opener) -> RetryFactory {
        RetryFactory {
            root: PathBuf::from("/srv/root"),
            policy: fast_policy(),
            prefer_poll: false,
            poll_rebuilds: 0,
            open_recommended,
            open_poll,
        }
    }

    async fn next_frame(sub: &mut broadcast::Receiver<String>) -> String {
        tokio::time::timeout(Duration::from_secs(5), sub.recv())
            .await
            .expect("等待帧超时")
            .expect("broadcast 接收失败")
    }

    /// 每次调用都成功的 opener：每次新建事件通道（测试无需消费会话事件）。
    fn endless_ok_opener(backend: &'static str) -> Opener {
        Box::new(move || {
            let (tx, rx) = std::sync::mpsc::channel();
            Ok((Box::new(tx) as Box<dyn Send>, rx, backend.to_string()))
        })
    }

    /// 前 `n` 次调用失败并计数，之后返回预置 mock 会话（探试成功路径用）。
    fn fail_n_then_ok_opener(
        n: usize,
        keep: Sender<RawEvent>,
        rx: Receiver<RawEvent>,
        backend: &'static str,
        fails: Arc<AtomicUsize>,
    ) -> Opener {
        let mut rx = Some(rx);
        Box::new(move || {
            if fails.fetch_add(1, Ordering::SeqCst) < n {
                return Err(NotifyError::io(std::io::Error::other("mock not ready yet")));
            }
            let Some(rx) = rx.take() else {
                return Err(NotifyError::io(std::io::Error::other("mock session exhausted")));
            };
            Ok((Box::new(keep.clone()) as Box<dyn Send>, rx, backend.to_string()))
        })
    }

    /// 运行期错误 → 重建成功 → watch-recovered → changed 照常。不广播
    /// watch-error（前端终态语义，会令存量连接永久断开）。
    #[tokio::test]
    async fn runtime_error_recovers_via_rebuilt_watcher() {
        let (tx1, rx1) = std::sync::mpsc::channel();
        let (tx2, rx2) = std::sync::mpsc::channel();
        let factory = factory(
            scripted_opener(
                vec![(tx1.clone(), rx1, "mock-a"), (tx2.clone(), rx2, "mock-b")],
                Arc::new(AtomicUsize::new(0)),
            ),
            scripted_opener(vec![], Arc::new(AtomicUsize::new(0))),
        );
        let hub = ChangeHub::spawn_with(Path::new("/srv/root"), factory);
        assert_eq!(hub.health(), WatchHealth::Ok);
        let mut sub = hub.subscribe();

        tx1.send(Err(NotifyError::io(std::io::Error::other("watch removed")))).unwrap();

        // 会话错误不发帧（连接保持）；重建（mock-b）成功 → recovered（携带
        // 后端名）→ 健康回 Ok。health 的 Recovering 中间态窗口极短（mock 重建
        // 毫秒级完成），不在此断言——稳定停留 Recovering 由持续失败用例覆盖。
        let f1 = next_frame(&mut sub).await;
        assert!(f1.contains("watch-recovered"), "应收到恢复帧: {f1}");
        assert!(!f1.contains("watch-error"), "不得广播前端终态的 watch-error: {f1}");
        assert!(f1.contains("mock-b"), "恢复帧应携带新后端名: {f1}");
        assert_eq!(hub.health(), WatchHealth::Ok);

        // 恢复后 changed 照常广播（自愈不是降级）
        tx2.send(ev(EventKind::Create(CreateKind::File), &["/srv/root/a.txt"])).unwrap();
        let f2 = next_frame(&mut sub).await;
        assert!(f2.contains("changed") && f2.contains("a.txt"), "恢复后应照常 changed: {f2}");
    }

    /// 重建持续失败：不广播任何帧（watch-error 前端终态语义；Recovering 经
    /// health 快照表达），健康停留 Recovering，recommended 重试与 PollWatcher
    /// 降级尝试确有发生。
    #[tokio::test]
    async fn repeated_build_failures_stay_silent_in_recovering() {
        let (tx1, rx1) = std::sync::mpsc::channel();
        let rec_fails = Arc::new(AtomicUsize::new(0));
        let poll_fails = Arc::new(AtomicUsize::new(0));
        let factory = factory(
            scripted_opener(vec![(tx1.clone(), rx1, "mock-a")], rec_fails.clone()),
            scripted_opener(vec![], poll_fails.clone()),
        );
        let hub = ChangeHub::spawn_with(Path::new("/srv/root"), factory);
        assert_eq!(hub.health(), WatchHealth::Ok);
        let mut sub = hub.subscribe();

        tx1.send(Err(NotifyError::io(std::io::Error::other("watch removed")))).unwrap();

        // 300ms 内（fast_policy 兜底循环 2ms 一轮，重试几十次）连接保持静默：
        // 存量连接不断开，服务端恢复后 changed 自然恢复流动
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(sub.try_recv().is_err(), "Recovering 期间不应广播任何帧");
        assert_eq!(hub.health(), WatchHealth::Recovering);
        assert!(
            rec_fails.load(Ordering::SeqCst) >= 3,
            "recommended 应至少重试 attempts 次: {}",
            rec_fails.load(Ordering::SeqCst)
        );
        assert!(poll_fails.load(Ordering::SeqCst) >= 1, "应尝试过 PollWatcher 降级");
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

    /// recommended 持续失败 → 降级 PollWatcher：健康 Degraded、发 watch-degraded 帧、
    /// 轮询会话的变更照常聚合为 changed 帧。
    #[tokio::test]
    async fn poll_fallback_marks_degraded_and_keeps_changed_flow() {
        let rec_fails = Arc::new(AtomicUsize::new(0));
        let (txp, rxp) = std::sync::mpsc::channel();
        let factory = factory(
            scripted_opener(vec![], rec_fails.clone()),
            scripted_opener(vec![(txp.clone(), rxp, "mock-poll")], Arc::new(AtomicUsize::new(0))),
        );
        let hub = ChangeHub::spawn_with(Path::new("/srv/root"), factory);
        assert_ne!(hub.health(), WatchHealth::Ok, "首建失败不应为 Ok");
        let mut sub = hub.subscribe();

        // 重建：recommended 3 连败 → PollWatcher 降级成功 → watch-degraded 帧
        let f1 = next_frame(&mut sub).await;
        assert!(f1.contains("watch-degraded"), "降级应发 watch-degraded 帧: {f1}");
        assert!(f1.contains("mock-poll"), "降级帧应携带后端名: {f1}");
        assert_eq!(hub.health(), WatchHealth::Degraded);

        // 降级模式下变更照常广播（自动刷新实际可用，非实时）
        txp.send(ev(EventKind::Create(CreateKind::File), &["/srv/root/a.txt"])).unwrap();
        let f2 = next_frame(&mut sub).await;
        assert!(f2.contains("changed") && f2.contains("a.txt"), "降级后仍应 changed: {f2}");
        assert!(rec_fails.load(Ordering::SeqCst) >= 3, "降级前应重试完 recommended");
    }

    /// 真实不可 watch 的 root：同步首建失败 → health 非 Ok；后台重试/降级全败后
    /// 仍不得转为 Ok（兜底无限重试接管）。
    #[test]
    fn unwatchable_root_never_becomes_ok() {
        let root = PathBuf::from("/nonexistent-vviewer-watch-root-xyz");
        let hub = ChangeHub::spawn_with(&root, RetryFactory::notify(root.clone(), fast_policy()));
        assert_ne!(hub.health(), WatchHealth::Ok, "首建失败即非 Ok");
        std::thread::sleep(Duration::from_millis(300));
        assert_ne!(hub.health(), WatchHealth::Ok, "不可 watch 的 root 不应转为 Ok");
        // drop 触发 stop：兜底无限重试循环随之退出（不 join，随进程回收）
    }

    /// 真实文件系统端到端：inotify watcher 建立（健康 Ok）→ 写文件 → 3s 内
    /// 广播 changed（相对路径）。本机 tmpfs/ext4 对照回归（验收 3）。
    #[tokio::test]
    async fn real_fs_change_broadcasts_changed() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        std::fs::write(root.join("seed.txt"), "seed").unwrap();

        let hub = ChangeHub::spawn(&root);
        assert_eq!(hub.health(), WatchHealth::Ok, "真实可 watch 的 root 应为 Ok");
        let mut sub = hub.subscribe();

        std::fs::write(root.join("seed.txt"), "changed").unwrap();
        let frame = tokio::time::timeout(Duration::from_secs(3), sub.recv())
            .await
            .expect("3s 内应收到 changed 帧")
            .expect("broadcast 接收失败");
        assert!(
            frame.contains("changed") && frame.contains("seed.txt"),
            "changed 帧应含相对路径 seed.txt: {frame}"
        );
    }
}
