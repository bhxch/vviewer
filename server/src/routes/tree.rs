//! `GET /api/tree` 适配层：Query 提取 → `vviewer-core::tree::list`（业务体，
//! 多端发布阶段二 Task 2 迁入：根寻址/guard 解析/StorageBackend 分发/条目
//! 形态）→ CoreResponse → axum Response。
//!
//! 扫描/hidden 过滤/排序/保真名已下沉 storage crate（`vviewer_storage::LocalFs`，
//! 既有纯重构）；本 handler 只做参数提取与响应映射。

use axum::extract::{Query, State};
use axum::response::Response;
use serde::Deserialize;

use crate::adapt;
use crate::error::AppError;
use crate::state::AppState;

/// 自然排序比较（实现下沉 storage crate；re-export 保持既有 API 路径不变）。
pub use vviewer_storage::natural_cmp;

#[derive(Deserialize)]
pub struct TreeQuery {
    pub path: Option<String>,
    /// 多根索引（缺省 0 号根；越界 400）。
    pub root: Option<usize>,
}

/// axum 适配：Query 参数（path/root）以已解析原语传入 core 域 handler。
pub async fn tree(
    State(state): State<AppState>,
    Query(q): Query<TreeQuery>,
) -> Result<Response, AppError> {
    let res = vviewer_core::tree::list(&state.core, q.root.unwrap_or(0), q.path.as_deref()).await?;
    Ok(adapt::to_axum(res))
}
