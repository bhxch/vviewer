//! 共享变更广播中心装配（BE-3 目录化自 watch.rs 迁入）：ChangeHub 的
//! spawn/订阅/健康读取与销毁（stop 标志）。

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use tokio::sync::broadcast;
use tracing::{error, info};

use super::health::{HealthSlots, WatchHealth};
use super::inspect::fs_type_of;
use super::recovery::{RetryFactory, RetryPolicy, WatchFault, WatchSession, run_loop};

/// broadcast 队列深度：慢连接积压超过后直接丢帧（Lagged），客户端下次刷新自愈。
const CHANNEL_CAPACITY: usize = 64;

/// 共享变更广播中心：每根一个 watcher 线程 + 各自聚合循环，服务全部 SSE 连接。
/// watcher 句柄移入各自聚合线程（自愈重建需在错误现场执行），销毁经 stop 标志。
pub struct ChangeHub {
    tx: broadcast::Sender<String>,
    /// 每根一个健康槽位（线程各写各的），[`ChangeHub::health`] 读取时聚合。
    health: Arc<HealthSlots>,
    /// ChangeHub 销毁（最后一个 Arc 释放）时置位：各聚合线程停止建 watch 并退出。
    stop: Arc<AtomicBool>,
}

impl Drop for ChangeHub {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}

impl ChangeHub {
    /// 为每个根创建递归 watcher 并启动聚合线程（每根一个 watcher 线程，共享
    /// broadcast / health / stop）；失败不降级为永久静默（后台自愈接管）。
    /// `VV_WATCH_FAULT` 环境变量激活故障注入（见 [`WatchFault`]，仅 e2e 使用）。
    pub fn spawn(roots: &[PathBuf]) -> Arc<Self> {
        let fault = WatchFault::from_env();
        let factories: Vec<RetryFactory> = roots
            .iter()
            .map(|root| RetryFactory::notify(root.clone(), RetryPolicy::default(), fault))
            .collect();
        Self::spawn_with(roots, factories)
    }

    /// 注入工厂的 spawn：每根同步首建一次（不重试），spawn 返回时健康状态即确定
    /// （各根槽位按首建结果写入，任一根失败整体聚合为 Recovering），SSE 建连
    /// 快照无竞态；启动失败的退避重试与 PollWatcher 降级移交各自后台线程，
    /// 不拖慢服务器启动。测试注入 mock opener 驱动状态机各分支。
    pub(super) fn spawn_with(roots: &[PathBuf], mut factories: Vec<RetryFactory>) -> Arc<Self> {
        debug_assert_eq!(roots.len(), factories.len(), "每根一个工厂");
        let (tx, _) = broadcast::channel(CHANNEL_CAPACITY);
        let stop = Arc::new(AtomicBool::new(false));

        // 同步首建（每根一次）：各根槽位按首建结果初始化（不互相覆写）
        let mut initial: Vec<Option<WatchSession>> = Vec::with_capacity(roots.len());
        let mut initial_health: Vec<WatchHealth> = Vec::with_capacity(roots.len());
        for (root, factory) in roots.iter().zip(factories.iter_mut()) {
            // 诊断补丁（BUG-02）：数据根的文件系统类型，便于 e2e 环境判读（如 btrfs）
            info!(
                "[watch] root={} fstype={}",
                root.display(),
                fs_type_of(root).unwrap_or_else(|| "unknown".into())
            );
            match (factory.open_recommended)() {
                Ok((keep, rx, backend)) => {
                    info!("[watch] watcher established backend={backend} root={}", root.display());
                    initial.push(Some(WatchSession::new(keep, rx, backend, false)));
                    initial_health.push(WatchHealth::Ok);
                }
                Err(e) => {
                    // 含 OS 错误码（Debug 格式的 Os { code: .. }）与 root 路径
                    error!(
                        "[watch] watcher startup FAILED root={} err={e:?}; retrying in background (backoff x{}, then PollWatcher fallback)",
                        root.display(),
                        factory.policy.attempts
                    );
                    initial.push(None);
                    initial_health.push(WatchHealth::Recovering);
                }
            }
        }
        let health = Arc::new(HealthSlots::new(&initial_health));

        // 每根一个聚合/自愈线程：不持有 JoinHandle，ChangeHub drop → stop 置位后
        // 线程自行退出。多根时 changed 帧携带根索引，单根保持历史形状（无 root）。
        let total_roots = roots.len();
        for (root_idx, ((root, factory), session)) in roots
            .iter()
            .cloned()
            .zip(factories)
            .zip(initial)
            .enumerate()
        {
            let (thread_tx, thread_health, thread_stop) =
                (tx.clone(), health.clone(), stop.clone());
            std::thread::spawn(move || {
                run_loop(
                    session, factory, thread_tx, thread_health, thread_stop, root, root_idx,
                    total_roots,
                )
            });
        }
        Arc::new(Self { tx, health, stop })
    }

    /// SSE 连接订阅：返回的 Receiver 被 drop 即代表连接断开、自动清理。
    pub fn subscribe(&self) -> broadcast::Receiver<String> {
        self.tx.subscribe()
    }

    /// 当前 watcher 健康状态（SSE 建连快照用）：各根槽位的 worst-of 聚合。
    pub fn health(&self) -> WatchHealth {
        self.health.aggregate()
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    use notify::event::{CreateKind, EventKind};
    use notify::Error as NotifyError;

    use super::super::testkit::{
        ev, factory, make_root_with_escape_symlink, next_frame, scripted_opener,
    };
    use super::*;

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
        let hub = ChangeHub::spawn_with(&[PathBuf::from("/srv/root")], vec![factory]);
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
        let hub = ChangeHub::spawn_with(&[PathBuf::from("/srv/root")], vec![factory]);
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
        let hub = ChangeHub::spawn_with(&[PathBuf::from("/srv/root")], vec![factory]);
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

    /// 双根部分失败（I-1 回归）：一根可 watch、一根不可。坏根的整个后台重试
    /// 窗口内共享健康必须保持非 Ok（新 SSE 连接拿得到 watch-degraded 快照），
    /// 好根的变更照常推送。撤修复（首建成功线程以共享标量为 prev 并无条件
    /// 覆写 Ok）时本用例红：好根首轮即翻 Ok 并伪发 watch-recovered。
    #[tokio::test]
    async fn partial_root_failure_keeps_shared_health_non_ok_and_good_root_flows() {
        let good = tempfile::tempdir().unwrap();
        let root = good.path().to_path_buf();
        std::fs::write(root.join("seed.txt"), "seed").unwrap();
        let bad = PathBuf::from("/nonexistent-vviewer-watch-root-xyz");

        let hub = ChangeHub::spawn(&[root.clone(), bad]);
        assert_ne!(hub.health(), WatchHealth::Ok, "任一根首建失败整体应为非 Ok");
        let mut sub = hub.subscribe();

        // 失败窗口内好根事件照常推送（坏根静默只属失败根自身，不牵连好根）
        std::fs::write(root.join("seed.txt"), "changed").unwrap();
        let frame = tokio::time::timeout(Duration::from_secs(3), sub.recv())
            .await
            .expect("好根变更应在失败窗口内照常推送")
            .expect("broadcast 接收失败");
        assert!(
            frame.contains("changed") && frame.contains("seed.txt"),
            "失败窗口内首帧应为好根 changed（不得被伪 watch-recovered 占先）: {frame}"
        );

        // 好根线程首建成功不得把共享健康覆写为 Ok（坏根仍在重试窗口）
        std::thread::sleep(Duration::from_millis(300));
        assert_ne!(hub.health(), WatchHealth::Ok, "坏根重试窗口内共享健康应保持非 Ok");
        assert_eq!(
            hub.health().snapshot_frame(),
            Some("watch-degraded"),
            "失败窗口内建连应拿到降级快照帧"
        );
        // drop 触发 stop：坏根兜底无限重试线程退出（不 join，随进程回收）
    }

    /// 真实文件系统端到端：inotify watcher 建立（健康 Ok）→ 写文件 → 3s 内
    /// 广播 changed（相对路径）。本机 tmpfs/ext4 对照回归（验收 3）。
    /// 单根形状逐字节等价：changed 帧只有 type/paths 两个键（无 root 字段）。
    #[tokio::test]
    async fn real_fs_change_broadcasts_changed() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        std::fs::write(root.join("seed.txt"), "seed").unwrap();

        let hub = ChangeHub::spawn(std::slice::from_ref(&root));
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
        let v: serde_json::Value = serde_json::from_str(&frame).unwrap();
        let obj = v.as_object().expect("changed 帧应为 JSON 对象");
        assert_eq!(
            obj.len(),
            2,
            "单根 changed 帧只有 type/paths 两个键（逐字节等价 = 不新增字段）: {frame}"
        );
        assert!(obj.contains_key("type") && obj.contains_key("paths"));
    }

    /// BUG-68 根因回归：root 含越界 symlink（目标含不可读目录）时 watcher 健康应为
    /// Ok——扫描不深入 symlink，不再因目标内权限错误致建监听失败。
    #[cfg(unix)]
    #[test]
    fn escape_symlink_root_watches_ok() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let root = make_root_with_escape_symlink(dir.path());
        let hub = ChangeHub::spawn(std::slice::from_ref(&root));
        assert_eq!(hub.health(), WatchHealth::Ok, "含越界 symlink 的 root 应健康 Ok");
        // 后台重试/降级稳定后仍为 Ok（不因运行期问题翻转为 Recovering/Degraded）
        std::thread::sleep(Duration::from_millis(300));
        assert_eq!(hub.health(), WatchHealth::Ok);
        drop(hub); // stop 置位，聚合线程退出
        // 恢复权限便于 tempdir 清理
        std::fs::set_permissions(dir.path().join("outside/locked"), PermissionsExt::from_mode(0o700))
            .ok();
    }
}
