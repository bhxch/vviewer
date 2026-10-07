//! 服务端计算模块（M6）：markdown 渲染等纯计算端点的实现体。
//!
//! 路由挂载在 routes::api_router 的 Bearer 组内，且仅当 `--compute` 启用；
//! 未启用时路径不存在（统一 JSON 404）。

pub mod highlight;
pub mod markdown;
pub mod queries;
