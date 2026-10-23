//! vviewer 业务核（多端发布阶段二）：框架无关的纯类型请求/响应 + 按域 handler。
//!
//! 依赖倒置方向：`vviewer`（axum 适配层）→ 本 crate 单向。本 crate 不依赖
//! axum/tower-http/notify；compute 重依赖（comrak/tree-sitter/layout-rs/svgbob）
//! 经 `native` feature 以 optional dep 进入——裁剪形态（`--no-default-features`）
//! 下零重依赖编译；默认形态 compute 域实现体在本 crate（阶段二计划内有意例外，
//! 见 `Cargo.toml` feature 注记）。tokio 生态仅经 `http`/`bytes` 类型面与
//! fs/IO 工具进入（axum 0.8 同源 http 1.x / bytes 1.x / tokio 1.x，适配层
//! 映射零转换成本）。
//!
//! 抽取模式（Task 1 锚定，后续域照此模式）：handler 业务体在本 crate 消费
//! [`state::CoreState`] 产出 [`CoreResponse`]；适配层从框架 Request **直接提取
//! 已解析参数**调用域 handler、把 [`CoreResponse`] 映射回框架 Response。对外
//! HTTP 行为逐字节等价（既有测试为行为锁）。曾预留的聚合请求类型
//! `CoreRequest` 因八域 handler 全部消费已解析参数、零消费方而删除（阶段二
//! 终审 Minor-2 处置，阶段三 Task 1 落锤：worker 适配沿同模式直提参数，见
//! `docs/superpowers/plans/2026-10-19-workers.md` 风险裁决）。
//! Task 2 已收编 tree/file/mounts 三域（Range 头解析属 HTTP 语义留适配层，
//! core 收已解析窗口）；Task 3 收编 search/tickets/events 三域（NDJSON 与 SSE
//! 皆经 [`CoreBody::Stream`] 流形态承载）与 compute 域（`native` feature 门控
//! ——`--no-default-features` 时编译不存在，health 不宣告 compute/diagrams）。

pub mod auth;
#[cfg(feature = "native")]
pub mod compute;
pub mod detect;
pub mod error;
/// SSE events 域：worker 形态不挂载（能力矩阵裁剪），wasm 目标整体不编译
/// （台账 1-6：tokio broadcast/mpsc 在 wasm 可编译但驱动面有运行时 panic 触点
/// ——不可达论证成立后按模块级门控落死）。tickets 为纯表结构不随门。
#[cfg(not(target_family = "wasm"))]
pub mod events;
pub mod file;
pub mod guard;
pub mod health;
/// kroki 转发域（spec 2026-10-23 §8.2）：转发不算计算——不挂 feature 门，
/// native/worker 双形态恒编译进。
pub mod kroki;
pub mod mounts;
pub mod search;
pub mod state;
pub mod tickets;
pub mod tree;

use std::pin::Pin;

use bytes::Bytes;
use futures_core::Stream;
use http::{header, HeaderMap, HeaderValue, StatusCode};

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

#[cfg(test)]
mod source_anchors {
    //! 源码面门控纪律锚测（多端发布阶段三 Task 1，终审 I-1）：`ReqwestTransport`
    //! 是 reqwest 进依赖图的唯一入口符号，它在 core 源码中的每次**代码出现**必须
    //! 处于 `#[cfg(feature = "native")]` 门控的 item 内——worker 形态
    //! （`--no-default-features`，storage 无 native、reqwest 不进依赖图）下该
    //! 符号编译不存在，任何门控外引用都会破坏裁剪编译。本锚测（纯文本扫描，
    //! 两形态均运行）与编译门（`cargo check -p vviewer-core --no-default-features
    //! --all-targets`）互为冗余双保险：编译门证明当下，本锚在 native CI
    //! （`cargo test --workspace`）里拦住「事后加回未门控引用」的回归。
    //!
    //! 扫描器形态约束（受控代码库内成立）：门控属性独占一行且逐字为
    //! `#[cfg(feature = "native")]`；字符串字面量中的花括号行内自平衡（无跨行
    //! 花括号字符串）；注释/文档行不计为代码引用。
    use std::path::{Path, PathBuf};

    /// 收集 src 树下全部 .rs 文件（含子模块目录）。
    fn rust_sources(dir: &Path, out: &mut Vec<PathBuf>) {
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                rust_sources(&path, out);
            } else if path.extension().is_some_and(|e| e == "rs") {
                out.push(path);
            }
        }
    }

    #[test]
    fn reqwest_transport_code_refs_are_native_gated() {
        // 自引用消解：needle 经 concat 分片——本模块代码行不含连续符号字面量，
        // 扫描器不会绊在自己的实现上（文档注释行已被跳过，无需处理）。
        let needle = concat!("Reqwest", "Transport");
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut files = Vec::new();
        rust_sources(&src, &mut files);
        assert!(!files.is_empty(), "core src 树扫描为空——锚测自证失败");

        let mut gated_hits = 0usize;
        for file in &files {
            let text = std::fs::read_to_string(file).unwrap();
            // depth：花括号深度；pending_gate：上一非注释行是 native 门控属性；
            // gated_at：Some(外层深度) = 正处于某门控 item 内（行尾 `;` 的单行
            // item 即刻出闸，块 item 至花括号归位）。
            let mut depth = 0i32;
            let mut pending_gate = false;
            let mut gated_at: Option<i32> = None;
            for (idx, raw) in text.lines().enumerate() {
                let line = raw.trim();
                if line.is_empty() || line.starts_with("//") {
                    continue; // 注释/文档行不是代码引用，跳过（门控属性期待不失效）
                }
                if line == r#"#[cfg(feature = "native")]"# {
                    pending_gate = true;
                    continue;
                }
                if pending_gate {
                    pending_gate = false;
                    gated_at = Some(depth); // 属性后首个代码行 = 门控 item 首行
                }
                if line.contains(needle) {
                    assert!(
                        gated_at.is_some_and(|d| depth >= d),
                        "{}:{}: `{needle}` 代码引用在 native 门控之外——\
                         裁剪形态（worker）零 reqwest 编译将被破坏（I-1 锚）",
                        file.display(),
                        idx + 1,
                    );
                    gated_hits += 1;
                }
                depth += line.matches('{').count() as i32;
                depth -= line.matches('}').count() as i32;
                if let Some(gd) = gated_at {
                    if line.ends_with(';') || depth <= gd {
                        gated_at = None; // 单行 item 收尾 / 块 item 花括号归位
                    }
                }
            }
        }
        assert!(
            gated_hits >= 1,
            "全源码扫描未命中任何门控内的 {needle}——门控实现被整体移出 core 时本锚 \
             失去对象，请复核锚测形态（符号移出属合法演进，锚应随迁）"
        );
    }
}
