//! kroki 转发的 wasm 传输实现（spec 2026-10-23 §8.2）：worker binding fetch
//! 实现 core 的 [`KrokiHttp`] 接缝（native `ReqwestKrokiHttp` 的对应物）。
//! URL 拼接/lang 白名单/raw body 透传全在 core（core 单测覆盖），本模块只做
//! 出站 fetch 构造与错误映射。wasm 门控：binding fetch 类型面仅 wasm 可编译
//! （transport.rs 同款）。
//!
//! ## 错误映射（BE-2 单源）
//! 上游非 2xx 经 core [`vviewer_core::kroki::upstream_error`]（与 native 传输
//! 共用：4xx → bad_request、其余 → internal，消息透传上游 body 前 200 字节
//! ——字符边界安全截断）；网络错/构造错映射（消息源不同构）留本传输侧。
//!
//! ## 超时语义
//! workers-rs 出站 fetch 无请求级超时面——30s 兜底归 workerd 侧 fetch 语义
//! （native reqwest 30s 请求级超时的对应物，简报注记）。

use async_trait::async_trait;
use send_wrapper::SendWrapper;
use worker::{js_sys, web_sys, Fetch, Request};

use vviewer_core::error::CoreError;
use vviewer_core::kroki::KrokiHttp;

use crate::transport::js_err;

/// [`KrokiHttp`] 的 wasm 实现（binding fetch；unit struct 无状态——连接池由
/// Workers 运行时的 fetch 管线承担）。
pub struct FetchKrokiHttp;

#[async_trait]
impl KrokiHttp for FetchKrokiHttp {
    async fn post_text(&self, url: String, body: Vec<u8>) -> Result<Vec<u8>, CoreError> {
        // web_sys 直构（transport.rs 同款 Request/Headers 构造）：POST
        // text/plain、body = raw 源码（Uint8Array 载体）
        let init = web_sys::RequestInit::new();
        init.set_method("POST");
        let headers = web_sys::Headers::new()
            .map_err(|e| CoreError::internal(format!("kroki 请求构造失败: {}", js_err(e))))?;
        headers
            .set("content-type", "text/plain")
            .map_err(|e| CoreError::internal(format!("kroki 请求构造失败: {}", js_err(e))))?;
        init.set_headers(&headers);
        init.set_body(&js_sys::Uint8Array::from(body.as_slice()).into());
        let web_req = web_sys::Request::new_with_str_and_init(&url, &init)
            .map_err(|e| CoreError::internal(format!("kroki 请求构造失败: {}", js_err(e))))?;

        // JsValue 载体（!Send）即刻入桥：async_trait 生成的 future 钉 Send，
        // await 窗口内存活的 Response 同桥（transport.rs 同款语义——跨线程访问
        // 才 panic，Workers isolate 单线程永不触发）
        let fetch_call = Fetch::Request(Request::from(web_req));
        let fetch = SendWrapper::new(fetch_call.send());
        let mut resp = SendWrapper::new(
            fetch
                .await
                .map_err(|e| CoreError::internal(format!("kroki 请求失败: {e}")))?,
        );

        let status = resp.status_code();
        // bytes() 的 future 载 ByteStream（JsValue 面，!Send）——即刻入桥再
        // await（transport.rs 同款纪律：!Send 值不得裸跨 await 点）
        let bytes_fut = SendWrapper::new(resp.bytes());
        if !(200..300).contains(&status) {
            // 错误消息透传上游 body 前 200 字节；读体失败以空串兜底（状态码已足锚）
            let bytes = bytes_fut.await.unwrap_or_default();
            return Err(vviewer_core::kroki::upstream_error(status, &bytes));
        }
        bytes_fut
            .await
            .map_err(|e| CoreError::internal(format!("kroki 读响应失败: {e}")))
    }
}
