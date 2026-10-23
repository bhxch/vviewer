//! fetch handler 主分发：`/api/*` → 参数直提 → core 域 handler →
//! CoreResponse → worker Response。路由面与 native 适配层 `routes/mod.rs`
//! 的 api_router（裁剪形态）对齐后按能力矩阵裁剪（见 crate 文档路由表）。
//!
//! 鉴权（native auth_mw 同构）：health 免鉴权；tree/file/mounts 为 Bearer 组
//! ——要求 `Authorization: Bearer`（constant-time 比较在 core::auth）；OPTIONS
//! 预检放行。worker 形态装配 fail-closed（终审 I-1）后 core.token 恒有值，
//! native 的「无 token 部署免鉴权」分支在 worker 不可达。
//!
//! 资产面（Task 3）：run_worker_first=["/api/*"] 下命中资产由平台直出、worker
//! 不经手；进到本层的非 /api/* 请求即资产缺失（not_found_handling="none"）——
//! C1 前科纪律按扩展名分流（[`crate::http::is_asset_path`]）。

use futures_util::StreamExt;
use worker::{Env, Method, Request, Response};

use vviewer_core::auth;
use vviewer_core::error::CoreError;
use vviewer_core::state::CoreState;
use vviewer_core::{file, health, kroki as kroki_domain, mounts as mounts_domain, tree};
use vviewer_storage::RangeSpec;

use crate::http::{
    has_multiple_ranges, is_asset_path, parse_range, should_pre_reject_range, strip_base_path,
};
use crate::response::{json_error, to_worker};
use crate::state::WorkerState;

/// `POST /api/mounts` 的原始请求体上限（native MOUNTS_BODY_LIMIT 同款：
/// 挂载配置是字段级小型 JSON，64KB 已超合理形态数个数量级；超限 413 防
/// 无界 body 进 serde 解析——POST 是写面，显式限值即闸门）。
const MOUNTS_BODY_LIMIT: usize = 64 * 1024;

/// `POST /api/kroki` 的原始请求体上限（native KROKI_BODY_LIMIT 同款，spec
/// 2026-10-23 §8.2）：图源码文本 1MB 已超合理形态数个数量级；超限 413 防
/// 无界 body 转发上游。
const KROKI_BODY_LIMIT: usize = 1024 * 1024;

/// fetch 入口分发（entry.rs 调用）。
pub async fn handle(req: Request, env: &Env, state: &'static WorkerState) -> worker::Result<Response> {
    let url = req.url()?;
    let path = strip_base_path(&state.base_path, url.path()).to_owned();

    // 非 /api/* = 资产缺失面（Task 3 run_worker_first 后，命中资产平台直出、
    // 仅缺失路径进本分支）——C1 前科纪律：按扩展名分流，SPA fallback 只服务
    // 非资产路径。**鉴权门之前**：资产面无鉴权语义（native 形态 ServeDir 同样
    // 在 Bearer 组之外），404 不得以 401 伪装
    if path != "/api" && !path.starts_with("/api/") {
        // binding fetch 需绝对 URL（相对路径被 workerd fetch 语义拒绝——冒烟
        // 实证）；origin 取原请求的 ASCII 序列化（url 2.5.8 的 Origin 无 Display）
        let origin = url.origin().ascii_serialization();
        return assets_fallback(env, &origin, &path).await;
    }

    // 鉴权分组：health 免认证（其余 /api 全在 Bearer 组——events/ticket/
    // search 未挂载，不存在豁免面）
    let auth_gate = if path == "/api/health" {
        None
    } else {
        authorize(&req, &state.core)?
    };
    if let Some(res) = auth_gate {
        return Ok(res);
    }

    match req.method() {
        m if (m == Method::Get || m == Method::Head) && path == "/api/health" => {
            to_worker(health::handle(&state.core))
        }
        m if (m == Method::Get || m == Method::Head) && path == "/api/tree" => {
            let (p, root) = query_tree(&url)?;
            respond(tree::list(&state.core, root, p.as_deref()).await)
        }
        m if (m == Method::Get || m == Method::Head) && path == "/api/file" => {
            file(req, state).await
        }
        m if (m == Method::Get || m == Method::Head) && path == "/api/mounts" => {
            to_worker(mounts_domain::manifest(&state.core))
        }
        m if m == Method::Post && path == "/api/mounts" => mounts_register(req, state).await,
        // kroki 转发（spec 2026-10-23 §8.2）：转发不算计算——Bearer 组内
        // （鉴权门在 dispatch 入口统一），上游 host 只来自部署侧 VV_KROKI_HOST
        m if m == Method::Post && path == "/api/kroki" => kroki_proxy(req, state).await,
        m if m == Method::Delete && path.starts_with("/api/mounts/") => {
            let index = path["/api/mounts/".len()..]
                .parse::<usize>()
                .map_err(|_| worker::Error::RustError("invalid mount index".into()));
            match index {
                Ok(index) => to_worker(mounts_domain::unregister(&state.core, index)),
                Err(_) => json_error(400, "invalid mount index"),
            }
        }
        // /api 未匹配路径统一 JSON 404（native api_not_found 同构）；search/
        // events/ticket/compute 未挂载亦落此（能力矩阵：不挂载语义）
        _ => json_error(404, "not found"),
    }
}

/// core 域结局统一出口：Ok → 响应重建；Err → JSON 错误响应（native
/// `AppError: From<CoreError>` 的 IntoResponse 同构——状态与消息面原样）。
fn respond(res: Result<vviewer_core::CoreResponse, CoreError>) -> worker::Result<Response> {
    match res {
        Ok(res) => to_worker(res),
        Err(err) => json_error(err.0.as_u16(), err.1),
    }
}

/// 非 /api/* 的资产缺失兜底（Task 3，native `serve_index` 的 Workers 对应物）：
/// - 资产扩展名路径（.wasm/.scm/.mjs/.css）→ 404 不回 HTML（C1 前科：query
///   loader 只查 res.ok 误载 HTML 静默降级——200 index.html 兜底即复刻该缺陷）；
/// - 其余缺失路径 → 经 ASSETS binding 取 index.html 回退（SPA fallback）。
///   binding fetch 需绝对 URL（相对路径被 workerd fetch 语义拒绝——冒烟实证），
///   origin 取自原请求。响应**读体重建**：binding 返回的 Response 头不可变
///   （冒烟实证 TypeError），且 native 同款禁缓存纪律（BUG-15 server 子项：
///   磁盘缓存启发式命中会让 SW 离线缺陷被新鲜窗口掩盖）必须后置补头；
/// - 无 assets binding 的裸 worker 形态（Task 2 最小 wrangler.toml 之类）整体
///   404 JSON（资产面错误风格与本层一致）。
async fn assets_fallback(env: &Env, origin: &str, path: &str) -> worker::Result<Response> {
    if is_asset_path(path) {
        return json_error(404, "asset not found");
    }
    let Ok(assets) = env.assets("ASSETS") else {
        return json_error(404, "not found");
    };
    match assets.fetch(format!("{origin}/index.html"), None).await {
        Ok(mut res) if res.status_code() == 200 => {
            let bytes = res.bytes().await?;
            let mut res = Response::from_bytes(bytes)?;
            res.headers_mut()
                .set("content-type", "text/html; charset=utf-8")?;
            res.headers_mut().set("cache-control", "no-cache")?;
            Ok(res)
        }
        _ => json_error(404, "not found"),
    }
}

/// Bearer 鉴权（auth_mw 同构）：OPTIONS 预检放行；Some(res) = 401 短路响应。
/// token = None 全放行分支——装配 fail-closed（I-1）后不可达，纯类型面防御。
fn authorize(req: &Request, core: &CoreState) -> worker::Result<Option<Response>> {
    let Some(expected) = core.token.as_deref() else {
        return Ok(None);
    };
    if req.method() == Method::Options {
        return Ok(None);
    }
    let authorization = req.headers().get("authorization")?;
    let provided = authorization.as_deref().and_then(auth::bearer_token);
    if provided.is_some_and(|t| auth::check(t, expected)) {
        Ok(None)
    } else {
        let mut res = json_error(401, "unauthorized")?;
        res.headers_mut().set("www-authenticate", "Bearer")?;
        Ok(Some(res))
    }
}

/// tree/file 的 Query 提取（path/root；未知参数忽略——serde_urlencoded 同
/// 语义）。root 非法（非数字）→ 400（axum Query 拒绝的 status 对齐，body
/// 形态取本层 JSON 错误风格）。
fn query_tree(url: &worker::Url) -> Result<(Option<String>, usize), worker::Error> {
    let mut path = None;
    let mut root = None;
    for (k, v) in url.query_pairs() {
        match &*k {
            "path" => path = Some(v.into_owned()),
            "root" => {
                root = Some(v.parse::<usize>().map_err(|_| {
                    worker::Error::RustError("invalid root query parameter".into())
                })?);
            }
            _ => {}
        }
    }
    Ok((path, root.unwrap_or(0)))
}

/// `GET /api/file`：头读取/If-Range → Range 语法 416 前置闸（should_pre_reject_range，
/// 定位前拒绝非法语法，size 未知形态 `bytes */*`）→ 定位 → Range 定界 →
/// 窗读取与响应组装（core）→ 流直通。
async fn file(req: Request, state: &'static WorkerState) -> worker::Result<Response> {
    let url = req.url()?;
    let (p, root) = query_tree(&url)?;

    // If-Range（BUG-47）：本服务器从不下发 ETag/Last-Modified，客户端携带的
    // 任何 If-Range 值都不可能匹配 → 按 RFC 9110 §13.1.5 忽略 Range 回 200
    let if_range_present = req.headers().has("if-range")?;
    let range_header = req.headers().get("range")?;

    // C2 parity（native 8c5fe16）：Range 语法非法与文件存在性无关（RFC 9110
    // §14.2 请求语法错误），locate 之前即 416——否则语法非法 + 缺失文件时 404
    // 抢答。size 未知形态 Content-Range: bytes */*。
    if should_pre_reject_range(if_range_present, range_header.as_deref()) {
        return range_not_satisfiable_unbounded();
    }

    let located = file::locate(&state.core, root, p.as_deref()).await;
    let located = match located {
        Ok(located) => located,
        Err(err) => return respond(Err(err)),
    };
    let size = located.size();

    let range: Option<(u64, u64)> = if if_range_present {
        None
    } else {
        match range_header
            .as_deref()
            .filter(|h| !has_multiple_ranges(h))
            .map(|h| parse_range(h, size))
        {
            None => None,
            Some(Ok(parsed)) => parsed,
            Some(Err(())) => return range_not_satisfiable(size),
        }
    };
    let window = range.map(|(start, len)| RangeSpec { start, len });

    respond(file::read(located, window).await)
}

/// 416 统一响应（native range_not_satisfiable 同构）：Content-Range:
/// bytes *\/size + JSON error。
fn range_not_satisfiable(size: u64) -> worker::Result<Response> {
    let mut res = json_error(416, "range not satisfiable")?;
    res.headers_mut()
        .set("content-range", &format!("bytes */{size}"))?;
    Ok(res)
}

/// 416（size 未知形态，C2 parity）：语法非法在 locate 之前即判，尚无 size 可
/// 回——Content-Range 用 RFC 9110 §14.4 的 incomplete-length 形态 `bytes */*`
/// （native range_not_satisfiable_unbounded 同构）。
fn range_not_satisfiable_unbounded() -> worker::Result<Response> {
    let mut res = json_error(416, "range not satisfiable")?;
    res.headers_mut().set("content-range", "bytes */*")?;
    Ok(res)
}

/// `POST /api/mounts`：body 闸门（64KB → 413）→ JSON 解析（失败 400）→
/// core 注册（指纹幂等，201/200）。
async fn mounts_register(mut req: Request, state: &'static WorkerState) -> worker::Result<Response> {
    // 1-10：显式 Content-Length 超限先拒（不读 body）；分块面走流式累计闸。
    // worker::Headers::get 即 Result<Option<String>>（无 HeaderValue 折叠面）
    if let Some(len) = req
        .headers()
        .get("content-length")?
        .and_then(|v| v.parse::<usize>().ok())
    {
        if len > MOUNTS_BODY_LIMIT {
            return json_error(413, "payload too large");
        }
    }
    // 流式累计闸：块到即判，超限不再先全读 body（worker 0.8.7 实测：
    // Request::stream() → ByteStream = Stream<Item = Result<Vec<u8>>>）。
    // stream() 对无 body 请求报错而旧 text() 面解析为空串——按无 body=空
    // 缓冲对齐旧语义（serde 400），不 5xx 短路
    let mut acc = 0usize;
    let mut buf: Vec<u8> = Vec::new();
    if let Ok(mut stream) = req.stream() {
        while let Some(chunk) = stream.next().await {
            let chunk = chunk?;
            if !crate::http::payload_fits(&mut acc, chunk.len(), MOUNTS_BODY_LIMIT) {
                return json_error(413, "payload too large");
            }
            buf.extend_from_slice(&chunk);
        }
    }
    let body = String::from_utf8_lossy(&buf).into_owned();
    let cfg: vviewer_core::mounts::MountConfig = match serde_json::from_str(&body) {
        Ok(cfg) => cfg,
        // axum Json 拒绝的 status 对齐（400）；消息含 serde 字段名（配置值
        // 可能携带凭据，不回显）
        Err(e) => return json_error(400, format!("invalid mount config: {e}")),
    };
    respond(mounts_domain::register(&state.core, cfg))
}

/// `POST /api/kroki`（spec 2026-10-23 §8.2）：body 闸门（1MB → 413，
/// mounts_register 同款双闸）→ JSON 解析 `{lang, source}`（失败 400）→ core
/// 转发（lang 白名单 + host 拼接 + binding fetch，见 [`crate::kroki`]）→
/// JSON `{svg}`；core 错误出口 `json_error` 形态（状态与消息面原样，与
/// `respond` 的 `From<CoreError>` 映射同构）。
async fn kroki_proxy(mut req: Request, state: &'static WorkerState) -> worker::Result<Response> {
    // body 闸门（mounts_register 同款：显式 Content-Length 超限先拒 + 流式累计闸）
    if let Some(len) = req
        .headers()
        .get("content-length")?
        .and_then(|v| v.parse::<usize>().ok())
    {
        if len > KROKI_BODY_LIMIT {
            return json_error(413, "payload too large");
        }
    }
    let mut acc = 0usize;
    let mut buf: Vec<u8> = Vec::new();
    if let Ok(mut stream) = req.stream() {
        while let Some(chunk) = stream.next().await {
            let chunk = chunk?;
            if !crate::http::payload_fits(&mut acc, chunk.len(), KROKI_BODY_LIMIT) {
                return json_error(413, "payload too large");
            }
            buf.extend_from_slice(&chunk);
        }
    }
    let body = String::from_utf8_lossy(&buf).into_owned();
    let parsed: crate::kroki::KrokiRequest = match serde_json::from_str(&body) {
        Ok(parsed) => parsed,
        // axum Json 拒绝的 status 对齐（400）；消息含 serde 字段名（源码本体
        // 不回显——与 mounts 的凭据不回显同纪律）
        Err(e) => return json_error(400, format!("invalid kroki request: {e}")),
    };
    let rendered =
        kroki_domain::render(&state.kroki, &parsed.lang, parsed.source.as_bytes()).await;
    let svg = match rendered {
        Ok(svg) => svg,
        Err(err) => return json_error(err.0.as_u16(), err.1),
    };
    // 上游 SVG 字节即响应面：非 UTF-8 以 500 短路（native handler 同款消息）
    let svg = match String::from_utf8(svg) {
        Ok(svg) => svg,
        Err(_) => return json_error(500, "kroki 响应非 UTF-8"),
    };
    Response::from_json(&serde_json::json!({ "svg": svg }))
}
