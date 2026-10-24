//! 统一 API 错误：JSON `{ "error": "..." }`。
//!
//! 薄壳单源（BE-1）：错误数据面（状态码 + 消息）与全部构造器/分类映射的
//! 唯一源是 [`vviewer_core::error::CoreError`]；本类型只保留 axum
//! `IntoResponse` 适配——orphan rule 禁止为外部类型（core 的 `CoreError`）
//! 在本 crate 外 impl axum 的 `IntoResponse`，而 core 禁 axum 依赖，壳必须
//! 留在适配层。构造一律 `CoreError::*(...)` 经 [`From`] 自动包装（`?`
//! 通道），适配层不复刻构造器与 `From<StorageError>`/`From<io::Error>`
//! 分类（双份维护漂移根治）。

use axum::response::{IntoResponse, Response};
use axum::Json;

/// API 层错误壳：包 [`vviewer_core::error::CoreError`]（状态码 + 消息），
/// 序列化为 `{"error": msg}`。
#[derive(Debug)]
pub struct AppError(pub vviewer_core::error::CoreError);

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let body = serde_json::json!({ "error": self.0.1 });
        (self.0.0, Json(body)).into_response()
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} {}", self.0.0, self.0.1)
    }
}

impl std::error::Error for AppError {}

/// 核心域错误 → API 错误壳（`?` 通道：handler 内 `CoreError` 经此自动包装，
/// 状态与消息面原样）。
impl From<vviewer_core::error::CoreError> for AppError {
    fn from(e: vviewer_core::error::CoreError) -> Self {
        Self(e)
    }
}
