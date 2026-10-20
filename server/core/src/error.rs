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

    pub fn forbidden(msg: impl Into<String>) -> Self {
        Self(StatusCode::FORBIDDEN, msg.into())
    }

    pub fn internal(msg: impl Into<String>) -> Self {
        Self(StatusCode::INTERNAL_SERVER_ERROR, msg.into())
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
