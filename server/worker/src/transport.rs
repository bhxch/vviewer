//! wasm [`HttpTransport`]：worker Fetch 实现 storage 的纯 HTTP 接缝（阶段一
//! 预留接缝的第三个实现体——native [`ReqwestTransport`] 与测试
//! [`MockTransport`] 之外）。
//!
//! ## wasm 单线程语义桥（Task 2 实测裁决，报告记录）
//! worker Fetch 的响应体流以 JsValue（ReadableStream）为载体——**!Send**；
//! 而 storage 的 [`HttpByteStream`] 接缝钉死 `Send`（与 native reqwest 实现
//! 共用类型，编译锚 `assert_send_static`）。[`send_wrapper::SendWrapper`]
//! 在流的**叶端**（worker ByteStream，其 `futures` feature 提供 `Stream`
//! 实现）把 JsValue 面包进 `Send`——跨线程 poll 即 panic，Workers isolate
//! 单线程模型下永不触发（wasm-bindgen 生态的标准桥法）。其上 StreamReader→
//! compat 全链由 Send 传递性自然成立，接缝类型跨目标零改动，native 锚与
//! S3/WebDAV 消费链（`into_tokio` compat 桥）不受影响。
//!
//! ## 方法直通（web_sys 直构）
//! worker crate 的 `Method` 是封闭枚举（未知谓词静默折返 Get——WebDAV
//! PROPFIND 会被吞）。因此出站请求经 `web_sys::RequestInit`（method 为任意
//! 字符串）直构 `web_sys::Request` 再入 `worker::Request`/`Fetch`——谓词
//! 面与 native reqwest 链同宽。
//!
//! 字节流通路（与 ReqwestTransport 同一条互转链，方向一致）：
//! `worker ByteStream（Stream<Item=Result<Vec<u8>>>）→ 错误映射 io::Error →
//! StreamReader（tokio AsyncRead）→ compat() → HttpByteStream`——纯 poll
//! 语义，无需 tokio 运行时（wasm 允许集内的 io-util 面）。

use std::pin::Pin;

use async_trait::async_trait;
use futures_util::{Stream, StreamExt};
use send_wrapper::SendWrapper;

use bytes::Bytes;
use vviewer_storage::display_endpoint;
use vviewer_storage::transport::{
    HttpByteStream, HttpTransport, HttpRequest, HttpResponse,
};
use vviewer_storage::StorageError;
use worker::{js_sys, wasm_bindgen, web_sys, Fetch, Request};

/// JsValue 异常 → 字符串（web_sys 裸调用返回 JsValue；取 message 或字符串
/// 化——错误面仅进脱敏后的 StorageError 文本）。`pub(crate)`：kroki 转发域的
/// wasm 传输（kroki.rs）复用同一 JsValue 错误字符串化。
pub(crate) fn js_err(e: wasm_bindgen::JsValue) -> String {
    use wasm_bindgen::JsCast;
    match e.dyn_into::<js_sys::Error>() {
        Ok(err) => err.to_string().into(),
        Err(e) => format!("{e:?}"),
    }
}

/// 错误消息脱敏（与 ReqwestTransport 同 treatment，评审 I1/spec §6「凭据不
/// 进错误信息」）：不拼原始 URL（改用剥 userinfo 的展示形态）；fetch 错误
/// 文本若内嵌 URL 一并替换。
fn transport_error(req_url: &str, err: impl std::fmt::Display) -> StorageError {
    let display = display_endpoint(req_url);
    let text = err.to_string().replace(req_url, &display);
    StorageError::other(format!("http transport {display}: {text}"))
}

/// [`HttpTransport`] 的 wasm 实现（worker Fetch；unit struct 无状态——连接
/// 池由 Workers 运行时的 fetch 管线承担）。
pub struct FetchTransport;

#[async_trait]
impl HttpTransport for FetchTransport {
    async fn execute(&self, req: HttpRequest) -> Result<HttpResponse, StorageError> {
        // web_sys 直构（谓词任意：S3 GET/HEAD、WebDAV PROPFIND 等）
        let init = web_sys::RequestInit::new();
        init.set_method(&req.method);
        let headers =
            web_sys::Headers::new().map_err(|e| transport_error(&req.url, js_err(e)))?;
        for (name, value) in &req.headers {
            headers
                .set(name, value)
                .map_err(|e| transport_error(&req.url, js_err(e)))?;
        }
        init.set_headers(&headers);
        if let Some(body) = req.body {
            // WebDAV PROPFIND 携带 XML 请求体：Uint8Array 载体
            init.set_body(&js_sys::Uint8Array::from(body.as_slice()).into());
        }
        let web_req = web_sys::Request::new_with_str_and_init(&req.url, &init)
            .map_err(|e| transport_error(&req.url, js_err(e)))?;

        // JsValue 载体（!Send）即刻入桥：async_trait 生成的 future 钉 Send，
        // await 窗口内存活的 Response 同桥（跨线程访问才 panic，单线程永不）
        // fetch 的 future 载 JsValue（!Send）——future 本身同桥再 await
        // （SendWrapper: Future，futures feature），execute 的 future 才钉得住 Send
        let fetch_call = Fetch::Request(Request::from(web_req));
        let fetch = SendWrapper::new(fetch_call.send());
        let mut resp = SendWrapper::new(fetch.await.map_err(|e| transport_error(&req.url, e))?);

        let status = resp.status_code();
        // 头借出即转纯数据（clone 面），不随桥进入流消费链
        let headers: Vec<(String, String)> = resp.headers().into_iter().collect();
        // 流叶端入桥：worker ByteStream（JsValue 载体）→ Send 包装。body 形态
        // 分流——HEAD/stat 等无体响应（body=None → ResponseBody::Empty）没有
        // ReadableStream，`stream()` 会报错：回空流（读即 EOF，S3 stat 只消
        // 头面；与 reqwest 链「HEAD 响应体为空」语义一致）。
        let raw: Pin<Box<dyn Stream<Item = worker::Result<Vec<u8>>>>> = match resp.body() {
            worker::ResponseBody::Stream(_) => {
                Box::pin(resp.stream().map_err(|e| transport_error(&req.url, e))?)
            }
            _ => Box::pin(futures_util::stream::empty()),
        };
        let byte_stream = SendWrapper::new(raw);
        drop(resp);

        // ByteStream（Item = Result<Vec<u8>>）→ 错误统一映射 io::Error + 载体
        // 收敛为 Bytes（StreamReader 要求 Buf）→ StreamReader → compat() →
        // 接缝载体（Send 由桥的传递性成立，无需再包）
        let stream = byte_stream.map(|chunk| {
            chunk
                .map(Bytes::from)
                .map_err(|e| std::io::Error::other(format!("http body stream: {e}")))
        });
        let reader = tokio_util::io::StreamReader::new(Box::pin(stream));
        let body: HttpByteStream =
            Box::pin(tokio_util::compat::TokioAsyncReadCompatExt::compat(reader));

        Ok(HttpResponse { status, headers, body })
    }
}
