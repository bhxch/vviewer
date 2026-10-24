//! 核心域错误（多端发布阶段二 Task 2 随 tree/file/mounts 域抽取下沉）：状态码
//! + 消息的数据面，适配层映射为 JSON `{"error": msg}` 响应。
//!
//! 与适配层 `AppError` 同构（字段同序 `(StatusCode, String)`、构造器同语义、
//! `From<StorageError>` 分类逐语句一致）——对外错误 JSON 形态/状态码逐字节
//! 等价的前提。axum 依赖留适配层：core 只产出错误数据，不做响应构造。

use http::StatusCode;

/// 核心域错误：状态码 + 消息（对外序列化为 `{"error": msg}`）。
#[derive(Debug)]
pub struct CoreError(pub StatusCode, pub String);

impl CoreError {
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

/// 存储后端错误 → 核心域错误（与适配层 AppError 同款分类：NotFound → 404，
/// 其余 → 500 且消息原样透传——文本面与下沉前一致）。
impl From<vviewer_storage::StorageError> for CoreError {
    fn from(e: vviewer_storage::StorageError) -> Self {
        match e.kind() {
            vviewer_storage::StorageErrorKind::NotFound => Self::not_found("not found"),
            vviewer_storage::StorageErrorKind::Other => Self::internal(e.message().to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `From<StorageError>` 分类锁测（BE-1 补）：NotFound → 404 "not found"、
    /// Other → 500 且消息原样透传——适配层错误壳（AppError）单源依赖此映射，
    /// 对外 JSON `{"error": msg}` 形态与状态码的行为锚。
    #[test]
    fn from_storage_error_maps_not_found_and_passes_other_through() {
        let e: CoreError = vviewer_storage::StorageError::not_found("missing dir").into();
        assert_eq!(e.0, StatusCode::NOT_FOUND);
        assert_eq!(e.1, "not found");

        let e: CoreError = vviewer_storage::StorageError::other("boom: disk").into();
        assert_eq!(e.0, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(e.1, "boom: disk");
    }
}
