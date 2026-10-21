//! CoreResponse → worker Response 映射（native 适配层 `adapt.rs::to_axum`
//! 的 Workers 对应物）：status/headers/body 逐一映射，无业务逻辑。
//!
//! - 聚合体（JSON/错误面）：[`ResponseBuilder::fixed`]（**不经 from_bytes**
//!   ——其会无条件覆盖 content-type 为 application/octet-stream，core 下发的
//!   `application/json` 头必须保序保值）；
//! - 流体（/api/file 字节窗）：[`ResponseBuilder::from_stream`] → JS
//!   ReadableStream——**直通不整块缓冲**（plan Global Constraints 的 Range
//!   直通语义）；chunk 错误映射 `io::Error → worker::Error`。

use worker::{Headers, Response, ResponseBuilder};

use vviewer_core::{CoreBody, CoreResponse};

/// core 响应 → worker 响应。header 值经 `HeaderValue::to_str`（core 面全部
/// 为可见 ASCII——from_static/from_str 构造），异常值空串兜底不中断映射。
pub fn to_worker(res: CoreResponse) -> worker::Result<Response> {
    let headers = Headers::new();
    for (name, value) in res.headers.iter() {
        headers.append(name.as_str(), value.to_str().unwrap_or_default())?;
    }
    let builder = ResponseBuilder::new()
        .with_status(res.status.as_u16())
        .with_headers(headers);
    match res.body {
        CoreBody::Full(bytes) => Ok(builder.fixed(bytes.to_vec())),
        CoreBody::Stream(stream) => {
            let stream = futures_util::StreamExt::map(stream, |chunk| {
                chunk.map_err(|e| worker::Error::RustError(format!("response body stream: {e}")))
            });
            builder.from_stream(stream)
        }
    }
}

/// 统一 JSON 错误响应（native 适配层 AppError::into_response 同构：
/// `{"error": msg}`）。
pub fn json_error(status: u16, msg: impl Into<String>) -> worker::Result<Response> {
    Response::from_json(&serde_json::json!({ "error": msg.into() }))
        .map(|r| r.with_status(status))
}
