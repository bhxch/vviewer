//! SSE 升级票据域（多端发布阶段二 Task 3 自适配层 state.rs 原样迁入）：
//! 一次性 ticket 表（内存态，30s 过期）与签发 handler 业务体。校验与消费在
//! [`crate::events`]（SSE 升级门）；适配层经原路径 re-export
//! （`vviewer::state::TicketStore`），既有调用点/测试零改动。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use http::StatusCode;

use crate::CoreResponse;

/// ticket 有效期：一次性、30s 过期（SSE 升级专用）。
pub const TICKET_TTL: Duration = Duration::from_secs(30);

/// 生成 32 字节随机 hex（CLI `--token-gen` 与 ticket 共用格式）。
pub fn generate_token() -> String {
    use rand::Rng;
    let mut buf = [0u8; 32];
    rand::rng().fill_bytes(&mut buf);
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

/// 内存 ticket 表：Arc 包裹使 AppState 克隆共享同一份。
#[derive(Clone, Default)]
pub struct TicketStore(Arc<Mutex<HashMap<String, Instant>>>);

impl TicketStore {
    /// 签发：随机 32B hex，顺带惰性清理过期项。
    pub fn issue(&self) -> String {
        self.sweep();
        let ticket = generate_token();
        self.0.lock().unwrap().insert(ticket.clone(), Instant::now() + TICKET_TTL);
        ticket
    }

    /// 一次性消费：无论有效与否都移除；过期返回 false。
    pub fn consume(&self, ticket: &str) -> bool {
        match self.0.lock().unwrap().remove(ticket) {
            Some(expiry) => expiry > Instant::now(),
            None => false,
        }
    }

    /// 惰性清理过期项（签发时触发；另有 main 内的定期 spawn 兜底）。
    pub fn sweep(&self) {
        let now = Instant::now();
        self.0.lock().unwrap().retain(|_, expiry| *expiry > now);
    }

    /// 直接注入指定过期时间的 ticket（测试专用）。
    pub fn insert_raw(&self, ticket: String, expiry: Instant) {
        self.0.lock().unwrap().insert(ticket, expiry);
    }
}

/// `POST /api/ticket`（Bearer 保护，鉴权在适配层中间件组）签发 handler：
/// 200 + `{"ticket": <32B hex>}`（content-type 与 axum::Json 下发逐字节同形）。
pub fn issue(tickets: &TicketStore) -> CoreResponse {
    CoreResponse::json(StatusCode::OK, &serde_json::json!({ "ticket": tickets.issue() }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::CoreBody;
    use std::time::Duration;

    /// 签发锚测：200 JSON、content-type 与 axum::Json 同形、ticket 为 64 位 hex
    /// 且一次性消费（二次消费 false）。
    #[test]
    fn issue_returns_json_and_ticket_consumes_once() {
        let tickets = TicketStore::default();
        let res = issue(&tickets);
        assert_eq!(res.status, StatusCode::OK);
        assert_eq!(
            res.headers.get("content-type").and_then(|v| v.to_str().ok()),
            Some("application/json")
        );
        let CoreBody::Full(bytes) = res.body else { panic!("ticket body must be full") };
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        let ticket = v["ticket"].as_str().expect("ticket 字段");
        assert_eq!(ticket.len(), 64, "32B 随机的 hex 形态: {ticket}");
        assert!(ticket.chars().all(|c| c.is_ascii_hexdigit()));
        assert!(tickets.consume(ticket), "首次消费有效");
        assert!(!tickets.consume(ticket), "一次性：二次消费失效");
    }

    /// 过期与清理语义（随域迁移的语义锚）：过期 ticket 消费 false；sweep 后
    /// 表内不留过期项；未过期项不受 sweep 影响。
    #[test]
    fn expired_ticket_fails_and_sweep_removes_only_expired() {
        let tickets = TicketStore::default();
        tickets.insert_raw("expired".into(), Instant::now() - Duration::from_secs(1));
        assert!(!tickets.consume("expired"), "过期即无效");
        tickets.insert_raw("live".into(), Instant::now() + TICKET_TTL);
        tickets.sweep();
        assert!(tickets.consume("live"), "未过期项不被清理");
        assert!(!tickets.consume("nope"), "未知 ticket 无效");
    }
}
