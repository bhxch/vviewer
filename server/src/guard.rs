//! path 参数安全解析——适配层包装（多端发布阶段二 Task 2）。
//!
//! 业务体（清洗/canonicalize 越界校验/`%XX` 解码回退）已迁
//! `vviewer-core::guard`；tree/file 由 core 域 handler 内部直调，search/compute
//! 等未迁移域经本模块按迁移前签名消费（AppError 面，`e.into_response()` 可用）。

use std::path::{Path, PathBuf};

use crate::error::AppError;
use crate::state::AppState;

/// 将 `/api/tree`、`/api/file` 的相对 path 参数清洗为 root 下的路径（file 域
/// Task 2 内迁移完成前经此消费；业务体在 `vviewer-core::guard`）。
pub fn clean_relative(root: &Path, raw: Option<&str>) -> Result<PathBuf, AppError> {
    vviewer_core::guard::clean_relative(root, raw).map_err(AppError::from)
}

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
