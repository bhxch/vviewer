//! `GET /api/file` 适配层：Range 头解析（HTTP 语义——计划裁决留本层：头语法/
//! If-Range/多区间判定）+ 业务体委托 `vviewer-core::file`（多端发布阶段二
//! Task 2 迁入：根寻址/guard/stat/MIME/编码/窗读取/响应头组装）。
//!
//! 文件打开/检测头/seek 定位已下沉 storage crate（`LocalFs::read_range` 单开
//! 形态，既有纯重构）；本模块只做参数提取、Range→窗口解析与响应映射。

use axum::extract::{Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;

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

/// 多区间 Range 检测（BUG-47）：`bytes=` 后含多个非空区间即视为多区间。
/// 服务器不实现 multipart/byteranges：按 RFC 9110 §14.2 允许的「忽略 Range」
/// 回 200 全量，不再静默丢弃第二区间伪装成单区间 206。
fn has_multiple_ranges(h: &str) -> bool {
    match h.strip_prefix("bytes=") {
        Some(spec) => spec.split(',').filter(|p| !p.trim().is_empty()).count() > 1,
        None => false,
    }
}

/// 解析 Range 头（单区间；多区间取第一个）→ Some((start, len))。
/// None = 无 Range；Err = 非法或越界（→ 416）。
/// 语义：bytes=a-b / a- / -suffix；end 超界钳制；start ≥ size、suffix 0、
/// 起止倒挂、非数字均不可满足。
fn parse_range(h: &str, size: u64) -> Result<Option<(u64, u64)>, ()> {
    let spec = h.strip_prefix("bytes=").ok_or(())?;
    let first = spec.split(',').next().ok_or(())?.trim();
    let (start_s, end_s) = first.split_once('-').ok_or(())?;
    let (start_s, end_s) = (start_s.trim(), end_s.trim());

    let (start, end) = if start_s.is_empty() {
        // -suffix
        let suffix: u64 = end_s.parse().map_err(|_| ())?;
        if suffix == 0 || size == 0 {
            return Err(());
        }
        (size.saturating_sub(suffix), size - 1)
    } else {
        let start: u64 = start_s.parse().map_err(|_| ())?;
        if start >= size {
            return Err(());
        }
        if end_s.is_empty() {
            (start, size - 1)
        } else {
            let end: u64 = end_s.parse().map_err(|_| ())?;
            if start > end {
                return Err(());
            }
            (start, end.min(size - 1))
        }
    };
    Ok(Some((start, end - start + 1)))
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

/// axum 适配：定位（core，stat/目录判定前置）→ Range 解析（HTTP 语义，本层）
/// → 窗读取与响应组装（core）→ CoreResponse 重建。
pub async fn file(
    State(state): State<AppState>,
    Query(q): Query<FileQuery>,
    headers: HeaderMap,
) -> Result<Response, AppError> {
    let located =
        vviewer_core::file::locate(&state.core, q.root.unwrap_or(0), q.path.as_deref()).await?;
    let size = located.size();

    // If-Range（BUG-47）：本服务器从不下发 ETag/Last-Modified（验证器缺失），
    // 客户端携带的任何 If-Range 值（强/弱 ETag 或 HTTP-date）都不可能匹配当前
    // 资源 → 按 RFC 9110 §13.1.5，条件不满足即忽略 Range 回 200 全量。
    // 既有形态（忽略前回 206）会让第三方缓存把局部响应误当完整资源。
    let if_range_present = headers.contains_key(header::IF_RANGE);

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

#[cfg(test)]
mod tests {
    use super::*;

    /// BUG-47 多区间检测锁测：两段/中置空段均视为多区间；单区间、尾逗号
    /// （仅一个有效区间，与 parse_range 取首区间兼容）、非 bytes 单位不算多区间。
    #[test]
    fn multiple_range_specs_are_detected() {
        assert!(has_multiple_ranges("bytes=0-1,3-4"));
        assert!(has_multiple_ranges("bytes=100-105,200-205"));
        assert!(has_multiple_ranges("bytes=0-1,,3-4"));
        assert!(!has_multiple_ranges("bytes=0-1"));
        assert!(!has_multiple_ranges("bytes=0-1,"));
        assert!(!has_multiple_ranges("bytes=-4"));
        assert!(!has_multiple_ranges("bytes=0-"));
        assert!(!has_multiple_ranges("items=0-1,3-4"));
    }

    /// 单区间解析既有语义锁测（BUG-47 修复的护栏：多区间/If-Range 改在
    /// handler 层忽略，parse_range 自身行为不变）。
    #[test]
    fn parse_range_single_range_semantics_unchanged() {
        assert_eq!(parse_range("bytes=0-1", 256), Ok(Some((0, 2))));
        assert_eq!(parse_range("bytes=-4", 256), Ok(Some((252, 4))));
        assert_eq!(parse_range("bytes=250-", 256), Ok(Some((250, 6))));
        // end 超界钳制
        assert_eq!(parse_range("bytes=250-999", 256), Ok(Some((250, 6))));
        // start ≥ size / suffix 0 / 倒挂 / 非法：不可满足（→ 416）
        assert_eq!(parse_range("bytes=256-", 256), Err(()));
        assert_eq!(parse_range("bytes=-0", 256), Err(()));
        assert_eq!(parse_range("bytes=5-4", 256), Err(()));
        assert_eq!(parse_range("bytes=x-y", 256), Err(()));
        assert_eq!(parse_range("units=0-1", 256), Err(()));
    }
}
