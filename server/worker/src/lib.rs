//! vviewer-worker：vviewer 的 Cloudflare Workers 适配层（多端发布阶段三
//! Task 2）。与 native 适配层（server crate，axum）同构：**参数直提 → core
//! 域 handler → CoreResponse → 框架响应重建**，对外 HTTP 行为与裁剪形态
//! （`--no-default-features`）对齐后再裁剪：
//!
//! | 路由 | worker 形态 | native 裁剪形态 |
//! |------|-------------|-----------------|
//! | GET /api/health | ✓（免鉴权） | ✓ |
//! | GET /api/tree?path&root | ✓（Bearer 组） | ✓ |
//! | GET /api/file?path&root | ✓（Bearer 组 + Range） | ✓ |
//! | GET/POST /api/mounts | ✓（Bearer 组；POST 64KB 闸） | ✓ |
//! | DELETE /api/mounts/{index} | ✓（Bearer 组） | ✓ |
//! | POST /api/search | 不挂载（wasm 无进程语义） | ✓（rg 501 链） |
//! | GET /api/events | 不挂载（watch=false） | 不挂载（feature 门） |
//! | POST /api/ticket | 不挂载（ticket 仅服务 SSE 升级） | ✓ |
//! | /api/compute/* | 不挂载（core 裁剪） | `--compute` 时挂载 |
//! | POST /api/kroki | ✓（Bearer 组；转发不算计算） | ✓（native 门控） |
//!
//! 数据面：**无 fs 根**（[`CoreState::mounts_only`] 构造不变式）——全部根 =
//! `VV_MOUNTS` env JSON 声明的 S3/WebDAV 挂载（静态段，rootIndex 从 0 起），
//! 存储唯一来源为挂载后端经 wasm [`crate::transport::FetchTransport`]。
//!
//! 平台事实（Task 2 实测裁决，详见任务报告）：workers-rs 无 tokio 运行时
//! 集成；tokio 在 wasm32-unknown-unknown 仅允许 sync/macros/io-util/rt/time
//! （fs/process 触发 compile_error!）——core/storage 的 fs/process 触点按
//! host 目标门控（`#[cfg(not(target_family = "wasm"))]`），字节流路径保留
//! tokio `ByteStream` 形态（纯 poll 语义，无需运行时）。

#[cfg(target_family = "wasm")]
mod entry;
#[cfg(target_family = "wasm")]
mod state;

/// VV_TOKEN fail-closed 装配纪律的纯函数面（终审 I-1，native 单测覆盖）。
pub mod env;
/// 纯 HTTP 语义件（跨目标编译、native 单测覆盖）：Range 头解析与 base-path
/// 裁剪——与 native 适配层 routes/file.rs 的 parse_range 语义逐行同源。
pub mod http;
/// kroki 转发的 wasm 传输实现（spec 2026-10-23 §8.2，binding fetch 接缝——
/// native routes/kroki.rs 的对应物；wasm only，与 transport 同款门控）。
#[cfg(target_family = "wasm")]
mod kroki;
/// VV_MOUNTS env JSON 解析（纯函数，native 单测覆盖）。
pub mod mounts;
/// CoreResponse → worker Response 映射（native 适配层 adapt.rs 的对应物）。
#[cfg(target_family = "wasm")]
mod response;
/// wasm HttpTransport：worker Fetch 实现 storage 纯 HTTP 接缝。
#[cfg(target_family = "wasm")]
mod transport;

/// fetch handler 主分发（wasm only；native 编译不进——worker 类型在 host
/// 目标只编译纯函数模块）。
#[cfg(target_family = "wasm")]
mod dispatch;
