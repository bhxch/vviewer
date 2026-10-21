//! fetch handler 主分发：`/api/*` → 参数直提 → core 域 handler →
//! CoreResponse → worker Response。路由面与 native 适配层 `routes/mod.rs`
//! 的 api_router（裁剪形态）对齐后按能力矩阵裁剪（见 crate 文档路由表）。
//!
//! 鉴权（native auth_mw 同构）：health 免鉴权；tree/file/mounts 为 Bearer 组
//! ——有 token 时要求 `Authorization: Bearer`（constant-time 比较在
//! core::auth），无 token 部署免鉴权；OPTIONS 预检放行。

use worker::{Method, Request, Response};

use vviewer_core::auth;
use vviewer_core::error::CoreError;
use vviewer_core::state::CoreState;
use vviewer_core::{file, health, mounts as mounts_domain, tree};
use vviewer_storage::RangeSpec;

use crate::http::{has_multiple_ranges, parse_range, strip_base_path};
use crate::response::{json_error, to_worker};
use crate::state::WorkerState;

/// `POST /api/mounts` 的原始请求体上限（native MOUNTS_BODY_LIMIT 同款：
/// 挂载配置是字段级小型 JSON，64KB 已超合理形态数个数量级；超限 413 防
/// 无界 body 进 serde 解析——POST 在无 token 部署免鉴权，显式限值即写面闸门）。
const MOUNTS_BODY_LIMIT: usize = 64 * 1024;

/// fetch 入口分发（entry.rs 调用）。
pub async fn handle(req: Request, state: &'static WorkerState) -> worker::Result<Response> {
    let url = req.url()?;
    let path = strip_base_path(&state.base_path, url.path()).to_owned();

    // 非 /api/* 交 Assets binding（Task 3 run_worker_first 后生产不可达；
    // 本兜底供裸 worker/dev 形态）——**鉴权门之前**：资产面无鉴权语义
    // （native 形态 ServeDir 同样在 Bearer 组之外），404 不得以 401 伪装
    if path != "/api" && !path.starts_with("/api/") {
        return json_error(404, "not found");
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
        m if m == Method::Get && path == "/api/mounts" => {
            to_worker(mounts_domain::manifest(&state.core))
        }
        m if m == Method::Post && path == "/api/mounts" => mounts_register(req, state).await,
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

/// Bearer 鉴权（auth_mw 同构）：无 token 配置全放行；OPTIONS 预检放行；
/// Some(res) = 401 短路响应。
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

/// `GET /api/file`：定位（stat/目录判定前置）→ Range 解析（HTTP 语义，本层，
/// 与 native routes/file.rs 同序同语义）→ 窗读取与响应组装（core）→ 流直通。
async fn file(req: Request, state: &'static WorkerState) -> worker::Result<Response> {
    let url = req.url()?;
    let (p, root) = query_tree(&url)?;

    let located = file::locate(&state.core, root, p.as_deref()).await;
    let located = match located {
        Ok(located) => located,
        Err(err) => return respond(Err(err)),
    };
    let size = located.size();

    // If-Range（BUG-47）：本服务器从不下发 ETag/Last-Modified，客户端携带的
    // 任何 If-Range 值都不可能匹配 → 按 RFC 9110 §13.1.5 忽略 Range 回 200
    let if_range_present = req.headers().has("if-range")?;
    let range: Option<(u64, u64)> = if if_range_present {
        None
    } else {
        match req
            .headers()
            .get("range")?
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

/// `POST /api/mounts`：body 闸门（64KB → 413）→ JSON 解析（失败 400）→
/// core 注册（指纹幂等，201/200）。
async fn mounts_register(mut req: Request, state: &'static WorkerState) -> worker::Result<Response> {
    let body = req.text().await?;
    if body.len() > MOUNTS_BODY_LIMIT {
        return json_error(413, "payload too large");
    }
    let cfg: vviewer_core::mounts::MountConfig = match serde_json::from_str(&body) {
        Ok(cfg) => cfg,
        // axum Json 拒绝的 status 对齐（400）；消息含 serde 字段名（配置值
        // 可能携带凭据，不回显）
        Err(e) => return json_error(400, format!("invalid mount config: {e}")),
    };
    respond(mounts_domain::register(&state.core, cfg))
}
