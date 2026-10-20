//! HttpTransport 接缝与实现（Task 3）：纯 HTTP 语义 trait（Task 2 自 lib.rs
//! 迁入，接缝约束原样保留）、native [`ReqwestTransport`]（feature 门控）与
//! 三后端测试统一基建 [`MockTransport`]。
//!
//! ## 接缝约束（评审 Major-1，原样保留）
//! - **不得让 tokio/hyper 类型穿过本接口**：body 载体为 [`HttpByteStream`]
//!   = `futures-io::AsyncRead` trait 对象（futures-io 无运行时/平台依赖，
//!   wasm 可用）；
//! - [`ReqwestTransport`] 的 reqwest 字节流是 tokio 生态侧的类型：经
//!   tokio-util `StreamReader`（tokio AsyncRead）再 `compat()`（tokio →
//!   futures-io）落进接缝载体，reqwest/hyper 类型不外泄；
//! - 消费侧（S3/WebDAV 后端）反向经 `compat()` 把 futures-io body 转回
//!   tokio 流（[`crate::ByteStream`]）。

use std::pin::Pin;
use std::sync::Mutex;

use async_trait::async_trait;

#[cfg(feature = "native")]
use futures_util::StreamExt;

use crate::StorageError;

/// [`HttpTransport`] 接缝的 body 载体：wasm 可用的 futures-io trait 对象
/// （评审 Major-1：tokio::io 类型不得穿 HttpTransport 接缝——tokio::io 在
/// wasm 不可用；futures-io 为纯 trait 定义，无运行时/平台依赖）。
pub type HttpByteStream = Pin<Box<dyn futures_io::AsyncRead + Send>>;

/// 纯 HTTP 语义接缝（多端发布 spec 的 wasm 复用前提）：
/// method/url/headers/body → status/headers/字节流。native reqwest 实现
/// 为 [`ReqwestTransport`]（feature 门控）；**不得让 tokio/hyper 类型穿过
/// 本接口**。
#[async_trait]
pub trait HttpTransport: Send + Sync {
    async fn execute(&self, req: HttpRequest) -> Result<HttpResponse, StorageError>;
}

/// HTTP 请求描述（纯 HTTP 语义；method 为 "GET"/"PROPFIND" 等谓词字面）。
/// Debug 手工实现：authorization 头值脱敏（评审 Major-1 同 treatment——
/// 请求录制快照/日志常经 Debug 输出，明文签名串属泄漏面）。
#[derive(Clone)]
pub struct HttpRequest {
    pub method: String,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<Vec<u8>>,
}

impl std::fmt::Debug for HttpRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HttpRequest")
            .field("method", &self.method)
            .field("url", &self.url)
            .field("headers", &crate::redacted_headers(&self.headers))
            .field("body", &self.body)
            .finish()
    }
}

/// HTTP 响应描述（body 为 [`HttpByteStream`]——futures-io 载体，头按出现序保留）。
pub struct HttpResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: HttpByteStream,
}

/// 接缝类型形状的编译级锚（评审 Major-1）：HttpRequest/HttpResponse 可安全
/// Send 转移，body 字段载体钉死为 [`HttpByteStream`]（futures-io trait 对象）。
/// 若有人把 body 换回 tokio 类型，最后的 fn 签名断言即编译失败——tokio
/// AsyncRead 载体与 futures-io 载体非同一类型。
#[cfg(test)]
const _: () = {
    const fn assert_send_static<T: Send + 'static>() {}
    const fn assert_unpin<T: Unpin>() {}
    assert_send_static::<HttpRequest>();
    assert_send_static::<HttpResponse>();
    assert_send_static::<HttpByteStream>();
    assert_unpin::<HttpByteStream>();
};

impl std::fmt::Debug for HttpResponse {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HttpResponse")
            .field("status", &self.status)
            .field("headers", &self.headers)
            .field("body", &"HttpByteStream(..)")
            .finish()
    }
}

// ---------- ReqwestTransport（native，feature 门控） ----------

/// [`HttpTransport`] 的 native 实现（reqwest + rustls）：wasm 侧以
/// `default-features = false` 构建本 crate 裁掉本实现，仅复用 trait。
#[cfg(feature = "native")]
pub struct ReqwestTransport {
    client: reqwest::Client,
}

#[cfg(feature = "native")]
impl ReqwestTransport {
    pub fn new() -> Result<Self, StorageError> {
        let client = reqwest::Client::builder()
            .build()
            .map_err(|e| StorageError::other(format!("http client build: {e}")))?;
        Ok(Self { client })
    }
}

#[cfg(feature = "native")]
#[async_trait]
impl HttpTransport for ReqwestTransport {
    async fn execute(&self, req: HttpRequest) -> Result<HttpResponse, StorageError> {
        let method = reqwest::Method::from_bytes(req.method.as_bytes())
            .map_err(|e| StorageError::other(format!("bad http method {:?}: {e}", req.method)))?;

        let mut builder = self.client.request(method, &req.url);
        for (name, value) in &req.headers {
            builder = builder.header(name.as_str(), value.as_str());
        }
        if let Some(body) = req.body {
            builder = builder.body(body);
        }

        // 请求失败的错误消息脱敏（评审 I1，spec §6「凭据不进错误信息」——
        // StorageError 文本经 AppError 进 500 JSON 响应体与日志）：两条通道
        // 一并收口——本行不再拼原始 URL（改用剥除 userinfo 的展示形态）；reqwest
        // 0.12 的错误 Display 自身会内嵌完整请求 URL（`for url (..)`，userinfo
        // 原样），出现即替换为同一展示形态（文本不含时 replace 为无操作）。
        let resp = builder.send().await.map_err(|e| {
            let display = crate::display_endpoint(&req.url);
            let text = e.to_string().replace(&req.url, &display);
            StorageError::other(format!("http transport {display}: {text}"))
        })?;

        let status = resp.status().as_u16();
        let headers: Vec<(String, String)> = resp
            .headers()
            .iter()
            .map(|(k, v)| (k.as_str().to_owned(), v.to_str().unwrap_or_default().to_owned()))
            .collect();

        // reqwest 字节流（Stream<Item=Result<Bytes>>，tokio 侧）→ 错误统一
        // 映射 io::Error → StreamReader（tokio AsyncRead）→ compat()（futures-io
        // 载体）——hyper/reqwest 类型全部封在 Pin<Box<..>> 内，不外泄接缝。
        let stream = resp.bytes_stream().map(|chunk| {
            chunk.map_err(|e| std::io::Error::other(format!("http body stream: {e}")))
        });
        let reader = tokio_util::io::StreamReader::new(Box::pin(stream));
        let body: HttpByteStream =
            Box::pin(tokio_util::compat::TokioAsyncReadCompatExt::compat(reader));

        Ok(HttpResponse { status, headers, body })
    }
}

// ---------- MockTransport（三后端测试统一基建） ----------

/// 测试基建：三后端（S3/WebDAV + 后续形态）共享的内存 mock transport——
/// 按注册序取第一个 method/url 均命中的路由。不参与生产路径。
pub struct MockTransport {
    routes: Vec<MockRoute>,
    recorded: Mutex<Vec<HttpRequest>>,
}

struct MockRoute {
    /// 谓词字面（大小写不敏感）；"*" 匹配任意。
    method: String,
    /// URL 子串匹配（够三后端测试定位 bucket/key 用，不做完整 URL 解析）。
    url_contains: String,
    responder: Box<dyn Fn(&HttpRequest) -> HttpResponse + Send + Sync>,
}

impl MockTransport {
    pub fn new() -> Self {
        Self { routes: Vec::new(), recorded: Mutex::new(Vec::new()) }
    }

    /// 注册一条路由（builder 链式）：`with_route("GET", "bucket", |req| ..)`。
    /// method 传 `"*"` 匹配任意谓词。
    pub fn with_route(
        mut self,
        method: &str,
        url_contains: &str,
        responder: impl Fn(&HttpRequest) -> HttpResponse + Send + Sync + 'static,
    ) -> Self {
        self.routes.push(MockRoute {
            method: method.to_ascii_uppercase(),
            url_contains: url_contains.to_owned(),
            responder: Box::new(responder),
        });
        self
    }

    /// 已处理请求快照（按处理序），供测试断言签名头/查询参数/Range 请求头。
    pub fn recorded_requests(&self) -> Vec<HttpRequest> {
        self.recorded.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }
}

impl Default for MockTransport {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl HttpTransport for MockTransport {
    async fn execute(&self, req: HttpRequest) -> Result<HttpResponse, StorageError> {
        self.recorded
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .push(req.clone());

        let route = self.routes.iter().find(|r| {
            (r.method == "*" || r.method == req.method.to_ascii_uppercase())
                && req.url.contains(&r.url_contains)
        });
        match route {
            Some(r) => Ok((r.responder)(&req)),
            None => Err(StorageError::other(format!(
                "mock transport: no route for {} {}",
                req.method, req.url
            ))),
        }
    }
}

/// 测试响应构造助手：内存字节 → [`HttpByteStream`]（futures-io 载体经
/// tokio-util compat 从 tokio Cursor 转制，与生产桥同一条互转通路）。
pub fn http_response(status: u16, headers: &[(&str, &str)], body: impl Into<Vec<u8>>) -> HttpResponse {
    HttpResponse {
        status,
        headers: headers
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect(),
        body: Box::pin(tokio_util::compat::TokioAsyncReadCompatExt::compat(
            std::io::Cursor::new(body.into()),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 谓词大小写不敏感；"*" 通配；按注册序取首个命中。
    #[tokio::test]
    async fn route_matches_method_and_url_substring() {
        let t = MockTransport::new()
            .with_route("HEAD", "bucket", |_| http_response(200, &[], b"head"))
            .with_route("*", "bucket", |_| http_response(204, &[], b"any"));
        let req = |m: &str, u: &str| HttpRequest {
            method: m.into(),
            url: u.into(),
            headers: vec![],
            body: None,
        };

        assert_eq!(t.execute(req("GET", "https://x/bucket")).await.unwrap().status, 204);
        assert_eq!(t.execute(req("head", "https://x/bucket")).await.unwrap().status, 200);
        assert!(t.execute(req("GET", "https://x/other")).await.is_err());
    }

    /// HttpRequest Debug 脱敏（评审 Major-1 同 treatment）：authorization
    /// 值不得出现在 Debug 输出，其余头原样。
    #[test]
    fn debug_redacts_authorization_header() {
        let req = HttpRequest {
            method: "GET".into(),
            url: "https://x/bucket".into(),
            headers: vec![
                ("Authorization".into(), "AWS4-HMAC-SHA256 Signature=topsecret".into()),
                ("range".into(), "bytes=0-1".into()),
            ],
            body: None,
        };
        let dbg = format!("{req:?}");
        assert!(dbg.contains("[redacted]"), "{dbg}");
        assert!(!dbg.contains("topsecret"), "{dbg}");
        assert!(dbg.contains("bytes=0-1"), "{dbg}");
    }

    /// I1：请求失败的 StorageError 消息不得携带 userinfo 凭据（错误文本经
    /// AppError 进 500 JSON 响应体——spec §6「凭据不进错误信息」）；host 保留
    /// 供排障定位。本机回环必定拒绝的端口（1，非特权进程无法监听）触发 send
    /// 失败，把 reqwest 错误 Display 内嵌 URL 的渠道一并锚死。
    #[cfg(feature = "native")]
    #[tokio::test]
    async fn send_failure_error_message_strips_userinfo() {
        let t = ReqwestTransport::new().unwrap();
        let err = t
            .execute(HttpRequest {
                method: "GET".into(),
                url: "http://user:topsecret@127.0.0.1:1/x".into(),
                headers: vec![],
                body: None,
            })
            .await
            .unwrap_err();
        let msg = err.message();
        assert!(!msg.contains("topsecret"), "{msg}");
        assert!(!msg.contains("user:"), "{msg}");
        assert!(msg.contains("127.0.0.1:1"), "{msg}");
    }
}
