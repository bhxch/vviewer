//! `GET /api/health`：免鉴权能力发现。

use axum::extract::State;
use axum::Json;
use serde::Serialize;

use crate::state::AppState;

#[derive(Serialize)]
pub struct Health {
    pub name: &'static str,
    pub version: &'static str,
    pub capabilities: Vec<&'static str>,
}

/// 能力宣告：`file-server` 恒有；`--compute` 时追加 `compute`
/// （前端连接时缓存，compute 路由据此判定是否走远程）。
pub async fn health(State(state): State<AppState>) -> Json<Health> {
    let mut capabilities = vec!["file-server"];
    if state.compute {
        capabilities.push("compute");
    }
    Json(Health {
        name: "vviewer",
        version: env!("CARGO_PKG_VERSION"),
        capabilities,
    })
}
