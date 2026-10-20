//! 统一 API 错误：JSON `{ "error": "..." }`。

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;

/// API 层错误：状态码 + 消息，序列化为 `{"error": msg}`。
#[derive(Debug)]
pub struct AppError(pub StatusCode, pub String);

impl AppError {
    pub fn not_found(msg: impl Into<String>) -> Self {
        Self(StatusCode::NOT_FOUND, msg.into())
    }

    pub fn bad_request(msg: impl Into<String>) -> Self {
        Self(StatusCode::BAD_REQUEST, msg.into())
    }

    pub fn payload_too_large(msg: impl Into<String>) -> Self {
        Self(StatusCode::PAYLOAD_TOO_LARGE, msg.into())
    }

    pub fn forbidden(msg: impl Into<String>) -> Self {
        Self(StatusCode::FORBIDDEN, msg.into())
    }

    pub fn unauthorized(msg: impl Into<String>) -> Self {
        Self(StatusCode::UNAUTHORIZED, msg.into())
    }

    pub fn internal(msg: impl Into<String>) -> Self {
        Self(StatusCode::INTERNAL_SERVER_ERROR, msg.into())
    }

    pub fn not_implemented(msg: impl Into<String>) -> Self {
        Self(StatusCode::NOT_IMPLEMENTED, msg.into())
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let body = serde_json::json!({ "error": self.1 });
        (self.0, Json(body)).into_response()
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} {}", self.0, self.1)
    }
}

impl std::error::Error for AppError {}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        match e.kind() {
            std::io::ErrorKind::NotFound => Self::not_found("not found"),
            _ => Self::internal(e.to_string()),
        }
    }
}

/// 存储后端错误 → API 错误（与 io 直读同款分类：NotFound → 404，其余 → 500
/// 且消息原样透传——文本面与下沉前一致）。
impl From<vviewer_storage::StorageError> for AppError {
    fn from(e: vviewer_storage::StorageError) -> Self {
        match e.kind() {
            vviewer_storage::StorageErrorKind::NotFound => Self::not_found("not found"),
            vviewer_storage::StorageErrorKind::Other => Self::internal(e.message().to_string()),
        }
    }
}

/// 核心域错误 → API 错误（多端发布阶段二 Task 2：域 handler 业务体迁
/// vviewer-core 后的适配映射——状态与消息面原样，JSON 形态由本类型
/// IntoResponse 统一构造）。
impl From<vviewer_core::error::CoreError> for AppError {
    fn from(e: vviewer_core::error::CoreError) -> Self {
        Self(e.0, e.1)
    }
}
