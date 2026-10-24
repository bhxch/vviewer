//! `GET /api/file` 适配层：Range 头解析（BE-2 起单源 `vviewer-core::range`
//! ——本层只做头提取与 416 响应构造）+ 业务体委托 `vviewer-core::file`
//! （多端发布阶段二 Task 2 迁入：根寻址/guard/stat/MIME/编码/窗读取/响应头
//! 组装）。
//!
//! 文件打开/检测头/seek 定位已下沉 storage crate（`LocalFs::read_range` 单开
//! 形态，既有纯重构）；本模块只做参数提取、Range→窗口解析与响应映射。

use axum::extract::{Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;

use vviewer_core::range::{has_multiple_ranges, parse_range, parse_range_syntax};
use vviewer_storage::RangeSpec;

use crate::adapt;
use crate::error::AppError;
use crate::state::AppState;

#[derive(Deserialize)]
pub struct FileQuery {
    pub path: Option<String>,
    /// 多根索引（缺省 0 号根；越界 400）。
    pub root: Option<usize>,
}

/// 416 统一响应：Content-Range: bytes *\/size + JSON error。
fn range_not_satisfiable(size: u64) -> Response {
    (
        StatusCode::RANGE_NOT_SATISFIABLE,
        [(header::CONTENT_RANGE, format!("bytes */{size}"))],
        Json(serde_json::json!({ "error": "range not satisfiable" })),
    )
        .into_response()
}

/// 416（size 未知形态，1-2）：语法非法在 locate 之前即判，尚无 size 可回——
/// Content-Range 用 RFC 9110 §14.4 的 incomplete-length 形态 `bytes */*`。
fn range_not_satisfiable_unbounded() -> Response {
    (
        StatusCode::RANGE_NOT_SATISFIABLE,
        [(header::CONTENT_RANGE, "bytes */*")],
        Json(serde_json::json!({ "error": "range not satisfiable" })),
    )
        .into_response()
}

/// axum 适配：定位（core，stat/目录判定前置）→ Range 解析（HTTP 语义，本层）
/// → 窗读取与响应组装（core）→ CoreResponse 重建。
pub async fn file(
    State(state): State<AppState>,
    Query(q): Query<FileQuery>,
    headers: HeaderMap,
) -> Result<Response, AppError> {
    // If-Range（BUG-47）：本服务器从不下发 ETag/Last-Modified（验证器缺失），
    // 客户端携带的任何 If-Range 值（强/弱 ETag 或 HTTP-date）都不可能匹配当前
    // 资源 → 按 RFC 9110 §13.1.5，条件不满足即忽略 Range 回 200 全量。
    // 既有形态（忽略前回 206）会让第三方缓存把局部响应误当完整资源。
    let if_range_present = headers.contains_key(header::IF_RANGE);

    // 1-2 双重故障优先级：Range 语法非法与文件是否存在无关（RFC 9110 §14.2 的
    // 请求语法错误），在 stat/打开之前即 416（size 未知形态 `bytes */*`）
    if let Some(h) = headers.get(header::RANGE).and_then(|v| v.to_str().ok()) {
        if !if_range_present && !has_multiple_ranges(h) && parse_range_syntax(h).is_err() {
            return Ok(range_not_satisfiable_unbounded());
        }
    }

    let located =
        vviewer_core::file::locate(&state.core, q.root.unwrap_or(0), q.path.as_deref()).await?;
    let size = located.size();

    let range_header = if if_range_present {
        None
    } else {
        headers
            .get(header::RANGE)
            .and_then(|v| v.to_str().ok())
            // 多区间：忽略 Range（见 has_multiple_ranges 注），不进 206 分支
            .filter(|h| !has_multiple_ranges(h))
            .map(|h| parse_range(h, size))
    };
    // 已解析窗口（计划口径：core 收已解析 ResolvedRange/窗口参数）：
    // storage RangeSpec { start, len } 即路由层 Range 解析的产物类型
    let range = match range_header {
        None => None,
        Some(Ok(r)) => r,
        Some(Err(())) => return Ok(range_not_satisfiable(size)),
    };
    let window =
        range.map(|(start, len)| RangeSpec { start, len });

    Ok(adapt::to_axum(vviewer_core::file::read(located, window).await?))
}

