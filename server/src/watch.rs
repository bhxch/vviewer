//! root 变更监听（notify 递归 watch）与 500ms debounce 聚合广播。
//!
//! watcher 在服务器启动时创建一次（`ChangeHub::spawn`，挂在 AppState 内），
//! 而非每个 SSE 连接各建一个：notify 事件 → std mpsc → 聚合线程把 500ms 窗口内
//! 的多事件合并为一条 `{"type":"changed","paths":[...]}`（相对 root、排序去重）
//! → tokio broadcast 分发给所有订阅的 SSE 连接。
//!
//! 全同步实现（聚合走 std 线程 + `recv_timeout`）：`AppState::new` 无需 tokio
//! runtime 也可构造（main 在进入 runtime 前构造 state，测试在任意上下文构造）。

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use notify::{Error as NotifyError, Event as NotifyEvent, RecursiveMode, Watcher};
use serde_json::json;
use tokio::sync::broadcast;

/// debounce 聚合窗口：首个事件到达后等这么久，窗口内的后续事件并入同一条 changed。
pub const DEBOUNCE_WINDOW: Duration = Duration::from_millis(500);

/// broadcast 队列深度：慢连接积压超过后直接丢帧（Lagged），客户端下次刷新自愈。
const CHANNEL_CAPACITY: usize = 64;

/// 共享变更广播中心：一个 watcher + 一个聚合线程，服务全部 SSE 连接。
pub struct ChangeHub {
    tx: broadcast::Sender<String>,
    /// 保持 watcher 存活（drop 即停止监听、聚合线程随之退出）。
    _watcher: Mutex<Option<notify::RecommendedWatcher>>,
    /// watcher 建立失败时为 false：SSE 连接降级为一条 watch-error 后静默。
    pub watcher_ok: bool,
}

impl ChangeHub {
    /// 创建递归 watcher 并启动聚合线程；失败不 panic（watcher_ok=false 降级）。
    pub fn spawn(root: &Path) -> Arc<Self> {
        let (tx, _) = broadcast::channel(CHANNEL_CAPACITY);
        let (raw_tx, raw_rx) = std::sync::mpsc::channel::<Result<NotifyEvent, NotifyError>>();
        let root_owned = root.to_path_buf();
        let watcher = notify::recommended_watcher(move |res| {
            let _ = raw_tx.send(res);
        })
        .ok()
        .and_then(|mut w| {
            w.watch(root, RecursiveMode::Recursive).map(|_| w).ok()
        });
        match watcher {
            Some(w) => {
                let tx_clone = tx.clone();
                // 聚合线程：随 raw_rx 断开（watcher drop）自然退出
                std::thread::spawn(move || debounce_loop(raw_rx, tx_clone, root_owned));
                Arc::new(Self {
                    tx,
                    _watcher: Mutex::new(Some(w)),
                    watcher_ok: true,
                })
            }
            None => Arc::new(Self {
                tx,
                _watcher: Mutex::new(None),
                watcher_ok: false,
            }),
        }
    }

    /// SSE 连接订阅：返回的 Receiver 被 drop 即代表连接断开、自动清理。
    pub fn subscribe(&self) -> broadcast::Receiver<String> {
        self.tx.subscribe()
    }
}

/// 聚合主循环：首个事件开窗，窗口内事件全部合并为一条 changed 帧。
fn debounce_loop(
    rx: std::sync::mpsc::Receiver<Result<NotifyEvent, NotifyError>>,
    tx: broadcast::Sender<String>,
    root: PathBuf,
) {
    while let Ok(first) = rx.recv() {
        let mut paths = BTreeSet::new();
        collect_paths(&first, &root, &mut paths);

        // 固定窗口：从首个事件起 DEBOUNCE_WINDOW 内继续吸收后续事件
        let deadline = Instant::now() + DEBOUNCE_WINDOW;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                break;
            }
            match rx.recv_timeout(remaining) {
                Ok(ev) => collect_paths(&ev, &root, &mut paths),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => break,
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return,
            }
        }

        // 窗口内全是 Access（或空事件）→ 无真实变更，不广播
        if paths.is_empty() {
            continue;
        }

        let payload = json!({ "type": "changed", "paths": paths.into_iter().collect::<Vec<_>>() });
        // 无订阅者时 send 失败属正常（无连接即丢弃）
        let _ = tx.send(payload.to_string());
    }
}

/// notify 事件 → 相对 root 的路径集合（'/' 分隔，排序去重由 BTreeSet 保证）。
fn collect_paths(
    ev: &Result<NotifyEvent, NotifyError>,
    root: &Path,
    out: &mut BTreeSet<String>,
) {
    let Ok(ev) = ev else { return };
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

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{AccessKind, AccessMode, CreateKind, EventKind};

    /// 构造带路径的 notify 事件（测试 collect_paths 的过滤语义）。
    fn ev(kind: EventKind, paths: &[&str]) -> Result<NotifyEvent, NotifyError> {
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
}
