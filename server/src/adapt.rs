//! CoreResponse → axum Response 映射（适配层薄映射的共用出口，多端发布阶段
//! 二 Task 1 锚定）。各域 handler 迁入 vviewer-core 后，axum 侧统一以此把
//! 框架无关响应重建为 axum 响应——status/headers/body 逐一映射，无业务逻辑。
//! 流式体（/api/file 字节窗流）经 `Body::from_stream` 重建，映射语义与聚合
//! 体一致。

use axum::body::Body;
use axum::response::Response;

use vviewer_core::{CoreBody, CoreResponse};

/// core 响应 → axum 响应。builder 失败仅发生于非法 status/header 组合，
/// CoreResponse 携带的是已校验的 `http` 类型，expect 不可达。
pub fn to_axum(res: CoreResponse) -> Response {
    let mut builder = Response::builder().status(res.status);
    for (name, value) in res.headers.iter() {
        builder = builder.header(name, value);
    }
    match res.body {
        CoreBody::Full(bytes) => builder
            .body(Body::from(bytes))
            .expect("core response reconstruction"),
        CoreBody::Stream(stream) => builder
            .body(Body::from_stream(stream))
            .expect("core response reconstruction"),
    }
}
