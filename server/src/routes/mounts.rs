//! 阶段二运行时挂载三 API（spec §3）适配层：POST/GET/DELETE /api/mounts。
//!
//! 业务体（注册指纹幂等/tombstone 删除/脱敏清单构造）随多端发布阶段二 Task 2
//! 迁入 `vviewer-core::mounts`；本模块只留 axum 适配：提取（State/Json/Path）
//! → core handler → CoreResponse → axum Response。
//!
//! 鉴权口径（spec §3 字面，台账裁决）：与 tree/file 同一 Bearer 中间件组——
//! **有 token 时需 Bearer；无 token 部署免鉴权**。⚠ 风险注记：无 token 部署
//! （LAN 信任模型）下本组是写面（注册/删除内存态挂载），同网段未认证对端可
//! 调用——按 spec 字面实现、不另设门，风险在任务报告显著记录。
//!
//! 脱敏：GET 清单与 health mounts 摘要同源（[`MountMeta`] 结构面即无凭据字段，
//! endpoint 已在构造期剥 userinfo）——脱敏摘要构造在 core::mounts，凭据三不
//! 纪律面见该模块文档。

use axum::extract::{Path, State};
use axum::response::Response;
use axum::Json;

use crate::adapt;
use crate::error::AppError;
use crate::state::{AppState, MountConfig};

/// POST /api/mounts 适配：Json 提取（body 闸门 64KB 挂路由层）→ core 注册
/// （指纹幂等，201/200）。
pub async fn register(
    State(state): State<AppState>,
    Json(cfg): Json<MountConfig>,
) -> Result<Response, AppError> {
    Ok(adapt::to_axum(vviewer_core::mounts::register(&state.core, cfg)?))
}

/// GET /api/mounts 适配：脱敏清单（静态 + 运行时）。
pub async fn manifest(State(state): State<AppState>) -> Response {
    adapt::to_axum(vviewer_core::mounts::manifest(&state.core))
}

/// DELETE /api/mounts/{index} 适配：运行时项 204 tombstone / 静态项 405（带
/// `Allow` 头）/ 越界或已删 404——分支与响应形态构造在 core::mounts::unregister。
pub async fn remove(State(state): State<AppState>, Path(index): Path<usize>) -> Response {
    adapt::to_axum(vviewer_core::mounts::unregister(&state.core, index))
}
