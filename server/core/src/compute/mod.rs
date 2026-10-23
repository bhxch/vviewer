//! 服务端计算模块（M6）：markdown 渲染等纯计算端点的实现体。
//!
//! 多端发布阶段二 Task 3 自适配层 `vviewer/src/compute` 整体迁入（git mv 保
//! 溯源），`#[cfg(feature = "native")]` 门控——`--no-default-features`（worker
//! 形态）时本模块编译不存在（comrak/tree-sitter/layout-rs/svgbob 重依赖一并
//! 裁剪，路由不挂载、health 不宣告 compute/diagrams，由适配层与 core::health
//! 的门控语义协同）。
//!
//! 路由挂载在适配层 routes::api_router 的 Bearer 组内，且仅当 `--compute` 启用
//! （运行时旗标）+ native feature（编译期门）；未启用时路径不存在（统一 JSON 404）。

pub mod diagrams;
pub mod highlight;
pub mod markdown;
pub mod queries;
