//! path 参数安全解析——适配层包装（多端发布阶段二 Task 2）。
//!
//! 业务体（清洗/canonicalize 越界校验/`%XX` 解码回退）已迁
//! `vviewer-core::guard`；tree/file/search/highlight 各域 handler 均已在
//! core 内部直调（Task 2/3）。本模块保留迁移前签名包装与 `root_out_of_range`
//! 原路径——适配层/测试的兼容缝，Task 4 收口时评估去留。

use std::path::PathBuf;

use crate::error::AppError;
use crate::state::AppState;

/// root 越界 400 的单一事实源（WSX 观察 1）——core guard 构造的 AppError 映射。
pub fn root_out_of_range(idx: usize) -> AppError {
    vviewer_core::guard::root_out_of_range(idx).into()
}

/// [`resolve_at`] 的多根参数化形态：按 `root_idx` 选择基准根（业务体在
/// `vviewer-core::guard`；此处仅 AppState→CoreState 传递与错误面映射）。
pub async fn resolve_at(
    state: &AppState,
    raw: Option<&str>,
    root_idx: usize,
) -> Result<PathBuf, AppError> {
    vviewer_core::guard::resolve_at(&state.core, raw, root_idx)
        .await
        .map_err(AppError::from)
}

/// 完整解析（0 号根）：清洗 → canonicalize（不存在 → 404）→ 越出 root → 403。
pub async fn resolve(state: &AppState, raw: Option<&str>) -> Result<PathBuf, AppError> {
    resolve_at(state, raw, 0).await
}
