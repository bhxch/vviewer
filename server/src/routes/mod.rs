//! HTTP 路由（多端发布阶段二 Task 3：compute/events 域随 native feature 门控
//! ——`--no-default-features` 时 compute 路由不挂（`--compute` 旗标失效于无
//! 实现体）、/api/events 不挂载（watch=false 能力缺失）；health 宣告由
//! core::health 同名 feature 协同门控）。

#[cfg(feature = "native")]
pub mod compute;
#[cfg(feature = "native")]
pub mod events;
pub mod file;
pub mod health;
#[cfg(feature = "native")]
pub mod kroki;
pub mod mounts;
pub mod search;
pub mod ticket;
pub mod tree;

use axum::extract::DefaultBodyLimit;
use axum::middleware;
use axum::routing::{delete, get, post};
use axum::Router;
#[cfg(feature = "native")]
use tower_http::compression::CompressionLayer;

use crate::auth;

/// /api/compute/* 的原始请求体上限：略高于应用层 5MB（给 JSON 包装留余量），
/// 超限直接 413，防止 handler 解析超大 body。text 字段的精确 5MB 判定在 handler。
#[cfg(feature = "native")]
const COMPUTE_BODY_LIMIT: usize = 6 * 1024 * 1024;

/// /api/compute/highlight 的原始请求体上限：应用层判定是 20MB（UTF-8 字节），
/// 但 JSON 转义最坏情况（\n、\"、\\ 各翻倍）可到 40MB+，给足余量防 tower 层
/// 抢先 413 拿不到 JSON error body；精确 20MB 在 handler 判。
#[cfg(feature = "native")]
const COMPUTE_HIGHLIGHT_BODY_LIMIT: usize = 48 * 1024 * 1024;

/// /api/mounts POST 的原始请求体上限：挂载配置是字段级小型 JSON（endpoint/
/// 凭据等十来个短字段），64KB 已超合理形态数个数量级；超限直接 413，防无界
/// body 进入 serde 解析——POST 在无 token 部署免鉴权（spec 字面口径），显式
/// 限值即写面闸门。GET 清单无 body，不挂限（layer 只作用于 POST 槽）。
const MOUNTS_BODY_LIMIT: usize = 64 * 1024;

/// /api/kroki POST 的原始请求体上限（spec 2026-10-23 §8.2）：图源码文本 1MB
/// 已超合理形态数个数量级；超限直接 413，防无界 body 转发上游（本服务即
/// 上游的敞开代理面）。随 kroki 路由同 native 门控。
#[cfg(feature = "native")]
const KROKI_BODY_LIMIT: usize = 1024 * 1024;

/// `/api` 子路由；未匹配的 API 路径统一返回 JSON 404。
///
/// 鉴权分组：tree/file/ticket/compute 在 Bearer 中间件组内；
/// health 免认证；events 用一次性 ticket 自证（EventSource 无法带头）。
pub fn api_router(state: crate::state::AppState) -> Router {
    let protected = Router::new()
        .route("/tree", get(tree::tree))
        .route("/file", get(file::file))
        .route("/ticket", post(ticket::issue_ticket))
        // 跨文件搜索：file-server 基础能力（不要求 --compute；rg 缺失时 501）
        .route("/search", post(search::search))
        // 阶段二运行时挂载三 API（spec §3）：Bearer 门与 tree/file 同组（豁免面
        // health/events 不变）；无 token 部署免鉴权 = spec 字面口径（风险注记见
        // mounts.rs 模块文档与任务报告）
        .route(
            "/mounts",
            // POST 挂显式 body 闸门（MethodRouter::layer 只包已注册方法槽，其后
            // 链上的 .get 不受影响——axum method_routing.rs layer 映射语义）
            post(mounts::register)
                .layer(DefaultBodyLimit::max(MOUNTS_BODY_LIMIT))
                .get(mounts::manifest),
        )
        .route("/mounts/{index}", delete(mounts::remove));
    // --compute 才暴露计算端点；未启用时路径不存在（统一 JSON 404）。双重门：
    // 编译期 native feature（实现体在 vviewer-core::compute，worker 形态裁剪）
    // × 运行时 --compute 旗标。CompressionLayer（BUG-10 收尾）：highlight
    // intervals 响应可达十余 MB，gzip 按 Accept-Encoding 协商压缩（浏览器默认
    // 携带）；仅作用于 compute 端点，不入 file 路由——Range 流被压缩会破坏字节
    // 区间语义。
    #[cfg(feature = "native")]
    let protected = if state.compute {
        protected
            .route(
                "/compute/markdown",
                post(compute::markdown).layer(DefaultBodyLimit::max(COMPUTE_BODY_LIMIT)),
            )
            .route(
                "/compute/highlight",
                post(compute::highlight)
                    .layer(DefaultBodyLimit::max(COMPUTE_HIGHLIGHT_BODY_LIMIT)),
            )
            .layer(CompressionLayer::new())
    } else {
        protected
    };
    // kroki 转发（spec 2026-10-23 §8.2）：转发不算计算——compute 门控之外
    // （不要求 --compute），Bearer 组内（下方 auth_mw 之后的链）。body 1MB
    // 闸门只包 POST 槽（MethodRouter::layer 语义，mounts 同款）。
    #[cfg(feature = "native")]
    let protected = protected.route(
        "/kroki",
        post(kroki::proxy).layer(DefaultBodyLimit::max(KROKI_BODY_LIMIT)),
    );
    let protected = protected
        .layer(middleware::from_fn_with_state(
            state.clone(),
            auth::auth_mw,
        ))
        .with_state(state.clone());

    let public = Router::new().route("/health", get(health::health));
    // SSE events：ticket 自证升级流；消费 watch 广播中心（notify 域）——随
    // native feature 门控，worker 形态（watch=false 能力缺失）该路由不存在
    #[cfg(feature = "native")]
    let public = public.route("/events", get(events::events));
    public
        .merge(protected)
        .fallback(crate::api_not_found)
        .with_state(state)
}
