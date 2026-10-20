//! vviewer 业务核（多端发布阶段二）：框架无关的纯类型请求/响应 + 按域 handler。
//!
//! 依赖倒置方向：`vviewer`（axum 适配层）→ 本 crate 单向。本 crate 不依赖
//! axum/tower-http/notify/comrak；tokio 生态仅经 `http`/`bytes` 类型面与
//! fs/IO 工具进入（axum 0.8 同源 http 1.x / bytes 1.x / tokio 1.x，适配层
//! 映射零转换成本）。watch/compute 等重依赖的 feature 门控随阶段二后续任务
//! 落地。
//!
//! 抽取模式（Task 1 锚定，后续域照此模式）：handler 业务体在本 crate 消费
//! [`state::CoreState`] 产出 [`CoreResponse`]；适配层把 axum Request 映射为
//! [`CoreRequest`]（或直接提取已解析参数）、调用域 handler、把 [`CoreResponse`]
//! 映射回 axum Response。对外 HTTP 行为逐字节等价（既有测试为行为锁）。
//! Task 2 已收编 tree/file/mounts 三域（Range 头解析属 HTTP 语义留适配层，
//! core 收已解析窗口）；Task 3 收编 search/tickets/events 三域（NDJSON 与 SSE
//! 皆经 [`CoreBody::Stream`] 流形态承载）与 compute 域（`native` feature 门控
//! ——`--no-default-features` 时编译不存在，health 不宣告 compute/diagrams）。

pub mod auth;
#[cfg(feature = "native")]
pub mod compute;
pub mod detect;
pub mod error;
pub mod events;
pub mod file;
pub mod guard;
pub mod health;
pub mod mounts;
pub mod search;
pub mod state;
pub mod tickets;
pub mod tree;

use std::pin::Pin;

use bytes::Bytes;
use futures_core::Stream;
use http::{header, HeaderMap, HeaderValue, StatusCode};

/// 框架无关请求类型（Task 2 的 tree/file 经适配层直接提取已解析参数消费，
/// 类型面预留；search 等随 Task 3 逐步消费）。body 为聚合字节。
#[derive(Debug, Clone)]
pub struct CoreRequest {
    pub method: http::Method,
    /// path+query（`/api/file?path=…` 原样；适配层从 uri 提取）。
    pub path: String,
    pub headers: HeaderMap,
    pub body: Bytes,
}

/// 流式字节体载体（core 内自定义，避免 axum 依赖——plan 风险裁决项）：
/// chunk 流形态同时覆盖文件 Range 字节窗（Task 2 `/api/file`，自 storage
/// ByteStream 包装）与 SSE 事件流（Task 3 `/api/events` 将消费同形态）。
pub type ByteStream = Pin<Box<dyn Stream<Item = std::io::Result<Bytes>> + Send>>;

/// 响应 body 形态：聚合字节（JSON/文本响应面）或流式字节（文件窗流；SSE 随
/// Task 3 消费同形态）。
pub enum CoreBody {
    Full(Bytes),
    /// 流式响应体：字节 chunk 流（错误面 io::Error 与存储读流一致）。
    Stream(ByteStream),
}

/// Debug 手工实现（Stream 内体不可检视——与 storage `FileRead` 的流占位同款
/// 形态；Full 保持派生期逐字节相同的输出）。
impl std::fmt::Debug for CoreBody {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Full(bytes) => f.debug_tuple("Full").field(bytes).finish(),
            Self::Stream(_) => f.debug_tuple("Stream").field(&"ByteStream(..)").finish(),
        }
    }
}

/// 框架无关响应类型：适配层据 status/headers/body 重建 axum Response。
#[derive(Debug)]
pub struct CoreResponse {
    pub status: StatusCode,
    pub headers: HeaderMap,
    pub body: CoreBody,
}

impl CoreResponse {
    /// JSON 响应构造：`content-type: application/json`（与 axum::Json 下发的
    /// 头逐字节同形——对外行为等价的前提）。serde 序列化失败不可能发生
    /// （响应结构均为无 fallible 序列化的 plain 数据），expect 即防御。
    pub fn json<T: serde::Serialize>(status: StatusCode, value: &T) -> Self {
        let body = serde_json::to_vec(value).expect("core response json serialize");
        let mut headers = HeaderMap::new();
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/json"),
        );
        Self { status, headers, body: CoreBody::Full(body.into()) }
    }
}
