//! watcher 健康面（BE-3 目录化自 watch.rs 迁入）：状态枚举的 SSE 快照帧语义
//! 与每根健康槽位的 worst-of 聚合。

use std::sync::atomic::{AtomicU8, Ordering};

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

/// 每根一个健康槽位，读取时聚合（worst-of）。多根下各 watcher 线程只写自己的
/// 槽位：共享单标量会被任一线程的成功转换覆写——首建部分失败时成功根首轮翻
/// Ok（坏根重试窗口内新连接拿不到降级快照、其变更静默），反向同理（先恢复的
/// 根置 Ok 会掩盖仍在重建窗口内的另一根）。槽位隔离让聚合在读取时计算，
/// 两类竞态一并消除。
pub(super) struct HealthSlots {
    slots: Vec<AtomicU8>,
}

impl HealthSlots {
    /// 按各根首建结果初始化（建会话 → Ok；失败 → Recovering）。
    pub(super) fn new(initial: &[WatchHealth]) -> Self {
        Self { slots: initial.iter().map(|h| AtomicU8::new(h.to_u8())).collect() }
    }

    pub(super) fn set(&self, root_idx: usize, v: WatchHealth) {
        self.slots[root_idx].store(v.to_u8(), Ordering::SeqCst);
    }

    pub(super) fn get(&self, root_idx: usize) -> WatchHealth {
        WatchHealth::from_u8(self.slots[root_idx].load(Ordering::SeqCst))
    }

    /// 聚合（worst-of）：任一根 Recovering（无 watcher、无事件）→ Recovering；
    /// 否则任一根 Degraded（轮询、事件非实时）→ Degraded；全 Ok → Ok。
    /// 快照帧只分 Ok / 非 Ok（watch-degraded），聚合序与帧语义一致。
    pub(super) fn aggregate(&self) -> WatchHealth {
        let mut worst = WatchHealth::Ok;
        for slot in &self.slots {
            match WatchHealth::from_u8(slot.load(Ordering::SeqCst)) {
                WatchHealth::Recovering => return WatchHealth::Recovering,
                WatchHealth::Degraded => worst = WatchHealth::Degraded,
                WatchHealth::Ok => {}
            }
        }
        worst
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_frame_matches_health_semantics() {
        assert_eq!(WatchHealth::Ok.snapshot_frame(), None);
        // Recovering/Degraded 统一发 watch-degraded：watch-error 在前端是终态
        // 语义（断开不重连），不得用于建连快照
        assert_eq!(WatchHealth::Recovering.snapshot_frame(), Some("watch-degraded"));
        assert_eq!(WatchHealth::Degraded.snapshot_frame(), Some("watch-degraded"));
    }
}
