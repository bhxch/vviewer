//! root 变更监听（notify 递归 watch）与 500ms debounce 聚合广播，含故障自愈。
//!
//! watcher 在服务器启动时由 `ChangeHub::spawn` 创建一次（挂在 AppState 内），
//! 而非每个 SSE 连接各建一个：workspace 多根下每根一个 watcher 线程（各自
//! notify 实例 + 自愈状态机，共享 broadcast 通道与 stop 标志；健康为每根
//! 槽位、读取时聚合，见 `HealthSlots`），
//! notify 事件 → std mpsc → 聚合线程把 500ms 窗口内的多事件按根合并为
//! `{"type":"changed","paths":[...]}`（相对所在根、排序去重；多根时帧携带
//! `"root": <idx>`，单根形状不变）→ tokio broadcast 分发给所有订阅的 SSE 连接。
//!
//! 自愈（BUG-02）：启动失败保留 Err 经 tracing 记日志（含 OS 错误码与 root 路径）
//! 并在后台线程退避重试，连续失败降级 `PollWatcher`（轮询，跨文件系统可用）继续
//! 广播 changed，之后周期性探试 recommended（暂时性故障解除后回归实时）；运行期
//! 错误丢弃当前 watcher 重建，恢复实时监听后广播 `{"type":"watch-recovered"}`。
//! 健康状态 `Ok / Recovering / Degraded` 经 `ChangeHub::health` 暴露（每根一个
//! 槽位，读取时取 worst-of 聚合——任一根 Recovering → Recovering，否则任一根
//! Degraded → Degraded），SSE 建连
//! 按快照发降级帧（非 Ok 统一 `watch-degraded`——`watch-error` 在前端是终态
//! 语义，见 `snapshot_frame`；运行期错误同样不广播它，自愈经状态帧与恢复的
//! changed 表达）。
//!
//! 全同步实现（聚合走 std 线程 + `recv_timeout`，watcher 重建同在聚合线程内）：
//! `AppState::new` 无需 tokio runtime 也可构造（main 在进入 runtime 前构造
//! state，测试在任意上下文构造）。
//!
//! 扫描不跟随 symlink（BUG-68）：notify 8.2 默认 `follow_symlinks=true` 会使
//! 递归扫描深入 root 外 symlink（如 → /etc），权限错误致建监听失败降级
//! PollWatcher 后，周期重扫每轮对每个被拒路径刷 WARN（实测 ≈47GB/天）。
//! `with_follow_symlinks(false)` 后两级后端都只在 root 内扫描；越界 symlink
//! 目标内的变更本就在 root 外（collect_event 既有口径剔除），语义不变。
//!
//! 目录化（BE-3，纯文件级移动）：本域按职责分四子模块——`health`（健康槽位
//! 与 SSE 快照帧语义）、`recovery`（自愈状态机/限频/会话循环）、`hub`（变更
//! 广播中心装配）、`inspect`（平台事件归集与文件系统诊断）；对外符号路径
//! （`crate::watch::ChangeHub` 等）经下方 `pub use` 零变化。

mod health;
mod hub;
mod inspect;
mod recovery;

pub use health::WatchHealth;
pub use hub::ChangeHub;
pub use recovery::DEBOUNCE_WINDOW;

/// 跨子模块共用的测试脚手（BE-3 目录化收敛：事件构造/factory 注入 opener/
/// 帧等待 helper 原散落单文件 tests 内，多域分居后提为共享）。
#[cfg(test)]
mod testkit {
    use std::path::PathBuf;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::mpsc::{Receiver, Sender};
    use std::time::Duration;

    use notify::event::EventKind;
    use notify::{Error as NotifyError, Event as NotifyEvent};
    use tokio::sync::broadcast;

    use super::recovery::{Opener, RawEvent, RetryFactory, RetryPolicy};

    /// 构造带路径的 notify 事件（测试 collect_paths 的过滤语义）。
    pub fn ev(kind: EventKind, paths: &[&str]) -> RawEvent {
        let mut e = NotifyEvent::new(kind);
        for p in paths {
            e = e.add_path(PathBuf::from(p));
        }
        Ok(e)
    }

    /// 极短退避：mock/真实故障注入测试毫秒级完成，不拖慢套件。
    pub fn fast_policy() -> RetryPolicy {
        RetryPolicy {
            attempts: 3,
            backoffs: vec![],
            poll_interval: Duration::from_millis(50),
            fallback_backoff: Duration::from_millis(2),
        }
    }

    /// 脚本式 opener：依次返回预置 mock 会话（事件通道 + 后端名）；脚本耗尽后
    /// 恒失败并计数（断言重试确有发生）。
    pub fn scripted_opener(
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

    pub fn factory(open_recommended: Opener, open_poll: Opener) -> RetryFactory {
        RetryFactory {
            root: PathBuf::from("/srv/root"),
            policy: fast_policy(),
            prefer_poll: false,
            poll_rebuilds: 0,
            open_recommended,
            open_poll,
        }
    }

    pub async fn next_frame(sub: &mut broadcast::Receiver<String>) -> String {
        tokio::time::timeout(Duration::from_secs(5), sub.recv())
            .await
            .expect("等待帧超时")
            .expect("broadcast 接收失败")
    }

    /// 每次调用都成功的 opener：每次新建事件通道（测试无需消费会话事件）。
    pub fn endless_ok_opener(backend: &'static str) -> Opener {
        Box::new(move || {
            let (tx, rx) = std::sync::mpsc::channel();
            Ok((Box::new(tx) as Box<dyn Send>, rx, backend.to_string()))
        })
    }

    /// 前 `n` 次调用失败并计数，之后返回预置 mock 会话（探试成功路径用）。
    pub fn fail_n_then_ok_opener(
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

    /// 构造「root 内含指向外部目录的 symlink，目标含 0o000 子目录」的场景。
    /// 修复前：inotify 建 watch 的 walkdir 深入 symlink 遇 EACCES → 建监听失败
    /// → 健康非 Ok（BUG-68 现场形态）；修复后（follow_symlinks=false）不深入 → Ok。
    /// chmod 0o000 仅对非 root 生效，测试以非 root 运行。
    #[cfg(unix)]
    pub fn make_root_with_escape_symlink(dir: &std::path::Path) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let root = dir.join("root");
        let target = dir.join("outside");
        std::fs::create_dir_all(target.join("locked")).unwrap();
        std::fs::set_permissions(target.join("locked"), PermissionsExt::from_mode(0o000)).unwrap();
        std::fs::create_dir_all(&root).unwrap();
        std::os::unix::fs::symlink(&target, root.join("escape")).unwrap();
        root
    }
}
