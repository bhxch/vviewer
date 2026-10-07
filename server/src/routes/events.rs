//! `GET /api/events?ticket=`：SSE 变更推送流。
//!
//! 一次性 ticket 校验通过后升级为 `text/event-stream`：每连接一个驱动任务把
//! ChangeHub 广播的聚合变更翻译成 `data:` 帧，另以 15s 心跳注释 `: ping` 保活；
//! 客户端断开时发送端 `send` 失败（或 Receiver drop）即结束任务，无需额外清理。
//! watcher 建立失败时降级：先发一条 `{"type":"watch-error"}` 后保持连接静默。

use std::convert::Infallible;
use std::pin::Pin;
use std::task::{Context, Poll};
use std::time::Duration;

use axum::extract::{Query, State};
use axum::http::HeaderValue;
use axum::response::sse::{Event, Sse};
use axum::response::{IntoResponse, Response};
use futures_core::Stream;
use serde::Deserialize;
use tokio::sync::broadcast::error::RecvError;
use tokio::sync::mpsc::Receiver;

use crate::error::AppError;

/// 心跳间隔。
pub const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(15);

/// 每连接 frame channel 深度：该连接消费跟不上且积压满时 send 失败 →
/// 驱动任务退出（连接即断，客户端重连自愈），不无界积压内存。
const FRAME_CHANNEL: usize = 256;

#[derive(Deserialize)]
pub struct EventsQuery {
    pub ticket: Option<String>,
}

/// ticket 校验（一次性，沿用 T3 语义）：缺失/无效/过期 → 401。
pub async fn events(
    State(state): State<crate::state::AppState>,
    Query(q): Query<EventsQuery>,
) -> Result<Response, AppError> {
    let valid = q
        .ticket
        .as_deref()
        .is_some_and(|t| state.tickets.consume(t));
    if !valid {
        return Err(AppError::unauthorized("missing or invalid ticket"));
    }

    let watch_ok = state.changes.watcher_ok;
    let mut rx = state.changes.subscribe();

    // 每连接一个驱动任务：broadcast → SSE 帧（事件 + 心跳），body drop 即退出
    let (frame_tx, frame_rx) = tokio::sync::mpsc::channel::<Result<Event, Infallible>>(FRAME_CHANNEL);
    tokio::spawn(async move {
        if !watch_ok {
            // 降级：一条 watch-error 后保持连接（仅心跳），不再有数据帧
            let _ = frame_tx.send(Ok(Event::default().data(r#"{"type":"watch-error"}"#))).await;
        }
        let mut ticker = tokio::time::interval(HEARTBEAT_INTERVAL);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tokio::select! {
                _ = ticker.tick() => {
                    // SSE 注释行，EventSource 客户端忽略；充当代心跳
                    if frame_tx.send(Ok(Event::default().comment("ping"))).await.is_err() {
                        break;
                    }
                }
                res = rx.recv() => {
                    match res {
                        Ok(payload) => {
                            if frame_tx.send(Ok(Event::default().data(payload))).await.is_err() {
                                break; // 客户端断开（body 已 drop）或积压满（连接跟不上）
                            }
                        }
                        Err(RecvError::Lagged(_)) => continue, // 慢连接丢帧：跳过
                        Err(RecvError::Closed) => break,      // hub 已销毁
                    }
                }
            }
        }
    });

    let mut response = Sse::new(ReceiverStream { rx: frame_rx }).into_response();
    // SSE 流不允许缓存：显式 no-cache，防中间层缓存握手响应导致收不到推送
    response
        .headers_mut()
        .insert("cache-control", HeaderValue::from_static("no-cache"));
    Ok(response)
}

/// mpsc Receiver → Stream 适配（tokio mpsc 的 `poll_recv` 是公开 API，
/// 无需引入 tokio-stream 依赖）。
struct ReceiverStream {
    rx: Receiver<Result<Event, Infallible>>,
}

impl Stream for ReceiverStream {
    type Item = Result<Event, Infallible>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        self.rx.poll_recv(cx)
    }
}
