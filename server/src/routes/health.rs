//! `GET /api/health`：免鉴权能力发现。

use axum::Json;
use serde::Serialize;

#[derive(Serialize)]
pub struct Health {
    pub name: &'static str,
    pub version: &'static str,
    pub capabilities: Vec<&'static str>,
}

pub async fn health() -> Json<Health> {
    Json(Health {
        name: "vviewer",
        version: env!("CARGO_PKG_VERSION"),
        // M6 引入 compute 后按配置附加 "compute"
        capabilities: vec!["file-server"],
    })
}
