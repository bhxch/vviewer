//! vviewer 业务核（多端发布阶段二）：框架无关的纯类型请求/响应 + 按域 handler。
//!
//! 依赖倒置方向：`vviewer`（axum 适配层）→ 本 crate 单向。本 crate 不依赖
//! axum/tower-http/notify/comrak；tokio 生态仅经 `http`/`bytes` 类型面进入
//! （axum 0.8 同源 http 1.x，适配层映射零转换成本）。watch/compute 等重依赖
//! 的 feature 门控随阶段二后续任务落地。
//!
//! 抽取模式（Task 1 锚定，后续域照此模式）：handler 业务体在本 crate 消费
//! [`state::CoreState`] 产出 [`CoreResponse`]；适配层把 axum Request 映射为
//! [`CoreRequest`]（或直接提取已解析参数）、调用域 handler、把 [`CoreResponse`]
//! 映射回 axum Response。对外 HTTP 行为逐字节等价（既有测试为行为锁）。

pub mod auth;
pub mod error;
pub mod guard;
pub mod health;
pub mod mounts;
pub mod state;
pub mod tree;

use bytes::Bytes;
use http::{header, HeaderMap, HeaderValue, StatusCode};

/// 框架无关请求类型（Task 2/3 的 tree/file/search 等域逐步消费；health 免参
/// 仅需 state）。body 为聚合字节——流式形态（SSE events）随 Task 3 扩展。
#[derive(Debug, Clone)]
pub struct CoreRequest {
    pub method: http::Method,
    /// path+query（`/api/file?path=…` 原样；适配层从 uri 提取）。
    pub path: String,
    pub headers: HeaderMap,
    pub body: Bytes,
}

/// 响应 body 形态：聚合字节（Task 1 全覆盖）；SSE 流变体随 Task 3 events 域
/// 抽取时扩展（core 内自定义流类型，避免 axum 依赖——plan 风险裁决预留）。
#[derive(Debug, Clone)]
pub enum CoreBody {
    Full(Bytes),
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
        let body = serde_json::to_vec(value).expect("health json serialize");
        let mut headers = HeaderMap::new();
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/json"),
        );
        Self { status, headers, body: CoreBody::Full(body.into()) }
    }
}
