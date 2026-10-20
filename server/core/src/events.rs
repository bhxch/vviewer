//! `GET /api/events?ticket=`：SSE 变更推送流（多端发布阶段二 Task 3 自适配层
//! routes/events.rs 业务体原样迁入——axum 侧只留 Query 提取与响应重建）。
//!
//! 一次性 ticket 校验通过后升级为 `text/event-stream`：每连接一个驱动任务把
//! 变更广播的聚合变更翻译成 `data:` 帧，另以 15s 心跳注释 `: ping` 保活；
//! 客户端断开时发送端 `send` 失败（或 Receiver drop）即结束任务，无需额外清理。
//! watcher 建连快照：健康状态非 Ok（Recovering/Degraded）时先发一条
//! `watch-degraded` 帧——前端未知 type 天然忽略、连接保持（不可用 `watch-error`：
//! 前端按终态处理断开不重连，会令 Recovering 窗口建连的 tab 永久失联）；
//! watcher 自愈的 `watch-recovered` 帧与 changed 帧照常经广播流过本连接。
//!
//! 依赖倒置缝：变更广播中心（watch/notify 域）留适配层，经 `subscribe` 闭包
//! 注入「健康快照 + 广播接收端」（ticket 校验之后才调用——建连快照时序与迁移
//! 前逐语句一致）。SSE wire 编码由本模块自产（axum `Event` 的字段布局复刻：
//! `data: <载荷>\n\n` / `: ping\n\n`，见 `data_frame`/`comment_frame`）；body 经
//! [`CoreBody::Stream`] 承载（帧逐 chunk 下发，与 axum SseBody 每事件一帧的
//! chunk 划分一致）。

use std::pin::Pin;
use std::time::Duration;

use bytes::Bytes;
use futures_core::Stream;
use http::{header, HeaderMap, HeaderValue, StatusCode};
use tokio::sync::broadcast::error::RecvError;
use tokio::sync::{broadcast, mpsc};

use crate::error::CoreError;
use crate::tickets::TicketStore;
use crate::{CoreBody, CoreResponse};

/// 心跳间隔。
pub const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(15);

/// 每连接 frame channel 深度：该连接消费跟不上且积压满时 send 失败 →
/// 驱动任务退出（连接即断，客户端重连自愈），不无界积压内存。
const FRAME_CHANNEL: usize = 256;

/// SSE events 域 handler（业务体自适配层原样迁入）：ticket 门（缺失/无效/
/// 过期 → 401）→ 订阅广播 → 驱动任务翻译帧 → 流式响应。`subscribe` 在 ticket
/// 校验之后调用，返回 (watcher 健康快照帧, 变更广播接收端)。
pub fn handle(
    tickets: &TicketStore,
    ticket: Option<String>,
    subscribe: impl FnOnce() -> (Option<&'static str>, broadcast::Receiver<String>),
) -> Result<CoreResponse, CoreError> {
    // ticket 校验（一次性，沿用 T3 语义）：缺失/无效/过期 → 401。
    let valid = ticket.as_deref().is_some_and(|t| tickets.consume(t));
    if !valid {
        return Err(CoreError::unauthorized("missing or invalid ticket"));
    }

    let (watch_health, mut rx) = subscribe();

    // 每连接一个驱动任务：broadcast → SSE 帧（事件 + 心跳），body drop 即退出
    let (frame_tx, frame_rx) = mpsc::channel::<String>(FRAME_CHANNEL);
    tokio::spawn(async move {
        // 建连快照：watcher 非 Ok（Recovering/Degraded）发一条 watch-degraded
        // （前端忽略、连接保持）；此后自愈状态帧/changed 照常流动
        if let Some(t) = watch_health {
            let _ = frame_tx
                .send(data_frame(&serde_json::json!({ "type": t }).to_string()))
                .await;
        }
        let mut ticker = tokio::time::interval(HEARTBEAT_INTERVAL);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tokio::select! {
                _ = ticker.tick() => {
                    // SSE 注释行，EventSource 客户端忽略；充当代心跳
                    if frame_tx.send(comment_frame("ping")).await.is_err() {
                        break;
                    }
                }
                res = rx.recv() => {
                    match res {
                        Ok(payload) => {
                            if frame_tx.send(data_frame(&payload)).await.is_err() {
                                break; // 客户端断开（body 已 drop）或积压满（连接跟不上）
                            }
                        }
                        Err(RecvError::Lagged(n)) => {
                            // 慢连接丢帧：补发一条 resync 帧（遗留 T7）。前端 SSE handler
                            // 只认 changed/watch-error，未知 type 忽略——天然安全，此处
                            // 留作诊断线索与未来客户端按需全量刷新的挂点。
                            let _ = frame_tx
                                .send(data_frame(&format!(
                                    r#"{{"type":"resync","missed":{n}}}"#
                                )))
                                .await;
                        }
                        Err(RecvError::Closed) => break, // hub 已销毁
                    }
                }
            }
        }
    });

    // SSE 流不允许缓存：显式 no-cache，防中间层缓存握手响应导致收不到推送
    //（头序与迁移前 Sse::into_response 一致：content-type → cache-control）
    let mut headers = HeaderMap::new();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("text/event-stream"));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    Ok(CoreResponse {
        status: StatusCode::OK,
        headers,
        body: CoreBody::Stream(Box::pin(ReceiverStream { rx: frame_rx })),
    })
}

/// SSE data 帧 wire 编码（axum `Event::data` 复刻）：`data: <载荷>\n\n`。
/// 本域载荷均为 serde_json 紧凑 JSON（无原生换行），axum 按载荷内 `\r`/`\n`
/// 重排多 `data:` 行的逻辑不触发，单行帧即逐字节等价。
fn data_frame(payload: &str) -> String {
    format!("data: {payload}\n\n")
}

/// SSE 注释帧 wire 编码（axum `Event::comment` 复刻）：`:<注释>\n\n`。
fn comment_frame(comment: &str) -> String {
    format!(": {comment}\n\n")
}

/// mpsc Receiver → Stream 适配（tokio mpsc 的 `poll_recv` 是公开 API，
/// 无需引入 tokio-stream 依赖）。响应 body 被 drop 时 Receiver 随之 drop，
/// 驱动任务的 send 失败即退出。帧为 `io::Result<Bytes>`（`CoreBody::Stream`
/// 错误面；驱动任务恒产 Ok——SSE 帧无 io 语义）。
struct ReceiverStream {
    rx: mpsc::Receiver<String>,
}

impl Stream for ReceiverStream {
    type Item = std::io::Result<Bytes>;

    fn poll_next(
        mut self: Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Self::Item>> {
        match self.rx.poll_recv(cx) {
            std::task::Poll::Ready(Some(frame)) => {
                std::task::Poll::Ready(Some(Ok(Bytes::from(frame))))
            }
            std::task::Poll::Ready(None) => std::task::Poll::Ready(None),
            std::task::Poll::Pending => std::task::Poll::Pending,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::future::poll_fn;

    /// 限时收集流字节（SSE 流不主动结束——驱动任务随 body drop 退出，生产侧
    /// 由适配层重建 axum Body，此处锚测帧面；不 drain 到 None，按窗口截断）。
    async fn collect_window(body: CoreBody, window: Duration) -> String {
        let CoreBody::Stream(mut stream) = body else { panic!("events body must be stream") };
        let mut out = Vec::new();
        let _ = tokio::time::timeout(window, async {
            loop {
                let chunk = poll_fn(|cx| stream.as_mut().poll_next(cx)).await;
                match chunk {
                    Some(Ok(bytes)) => out.extend_from_slice(&bytes),
                    Some(Err(e)) => panic!("stream error: {e}"),
                    None => return,
                }
            }
        })
        .await;
        String::from_utf8(out).expect("sse frames utf-8")
    }

    /// 订阅缝打标器：闭包被调用即置位（供「校验先于订阅」断言）。
    fn subscribe_tracking(
        flag: &mut bool,
    ) -> impl FnOnce() -> (Option<&'static str>, broadcast::Receiver<String>) + '_ {
        move || {
            *flag = true;
            (None, broadcast::channel(1).1)
        }
    }

    /// ticket 门锚测：缺失/未知/过期一律 401，消息文本与迁移前逐字一致；
    /// 订阅闭包不得被调用（校验先于订阅——迁移前时序）。
    #[test]
    fn invalid_ticket_is_unauthorized_before_subscribe() {
        let tickets = TicketStore::default();
        let mut s1 = false;
        let err = handle(&tickets, None, subscribe_tracking(&mut s1)).unwrap_err();
        assert_eq!(err.0, StatusCode::UNAUTHORIZED);
        assert_eq!(err.1, "missing or invalid ticket");
        let mut s2 = false;
        let err = handle(&tickets, Some("stale".into()), subscribe_tracking(&mut s2)).unwrap_err();
        assert_eq!(err.0, StatusCode::UNAUTHORIZED);
        assert_eq!(err.1, "missing or invalid ticket");
        assert!(!s1 && !s2, "ticket 校验失败不得触碰广播中心");
    }

    /// wire 编码锚测：建连快照帧 + 心跳注释帧的逐字节形状（axum Event 复刻）。
    #[tokio::test]
    async fn snapshot_and_heartbeat_frames_are_byte_exact() {
        let tickets = TicketStore::default();
        let ticket = tickets.issue();
        let (tx, rx) = broadcast::channel(8);
        let res = handle(&tickets, Some(ticket), || (Some("watch-degraded"), rx)).unwrap();
        // 发送端保活（hub 存活）：连接保持打开，快照帧后应收到心跳注释帧
        let _keep = tx;
        assert_eq!(res.status, StatusCode::OK);
        assert_eq!(
            res.headers.get("content-type").and_then(|v| v.to_str().ok()),
            Some("text/event-stream")
        );
        assert_eq!(
            res.headers.get("cache-control").and_then(|v| v.to_str().ok()),
            Some("no-cache")
        );

        // 首字节窗口内应收到：watch-degraded 快照帧 + interval 首拍立即触发的
        // `: ping` 心跳（迁移前同一时序——interval 首拍不等待）
        let frames = collect_window(res.body, Duration::from_secs(2)).await;
        assert!(
            frames.contains("data: {\"type\":\"watch-degraded\"}\n\n"),
            "快照帧逐字节: {frames:?}"
        );
        assert!(frames.contains(": ping\n\n"), "心跳注释帧逐字节: {frames:?}");
    }

    /// 广播载荷经 `data: ` 帧下发；发送端全体 drop（hub 销毁）后驱动任务退出、
    /// 流结束（None 提前返回路径——collect_window 不等满窗口即返回）。
    #[tokio::test]
    async fn broadcast_payload_flows_and_stream_ends_when_hub_drops() {
        let tickets = TicketStore::default();
        let ticket = tickets.issue();
        let (tx, rx) = broadcast::channel(8);
        let res = handle(&tickets, Some(ticket), || (None, rx)).unwrap();
        tx.send(r#"{"type":"changed","paths":["a.txt"]}"#.to_string()).unwrap();
        // 100ms 后销毁发送端（hub 销毁）：驱动任务 recv Closed → 退出 → 流 None
        let started = std::time::Instant::now();
        let dropper = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(100)).await;
            drop(tx);
        });
        let frames = collect_window(res.body, Duration::from_secs(5)).await;
        dropper.await.unwrap();
        assert!(
            frames.contains("data: {\"type\":\"changed\",\"paths\":[\"a.txt\"]}\n\n"),
            "changed 载荷逐字节: {frames:?}"
        );
        // 流随 hub 销毁提前结束：不等满 5s 窗口，也不等 15s 心跳（None 即返回）
        assert!(
            started.elapsed() < Duration::from_secs(3),
            "流应随 hub 销毁结束，实测 {:?}",
            started.elapsed()
        );
    }
}
