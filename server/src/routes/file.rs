//! `GET /api/file`：流式文件响应（单区间 Range + 服务端检测头）。
//!
//! 文件打开/检测头/seek 定位已下沉 storage crate（`LocalFs::read_range` 单开
//! 形态，Task 2 纯重构）；Range 头解析（parse_range/多区间/If-Range 等 HTTP
//! 语义）与响应头组装留本层。

use std::path::Path;

use axum::body::Body;
use axum::extract::{Query, State};
use axum::http::{header, HeaderMap, HeaderName, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use tokio_util::io::ReaderStream;

use vviewer_storage::{EntryKind as BackendEntryKind, RangeSpec};

use crate::detect;
use crate::error::AppError;
use crate::guard;
use crate::state::AppState;

static X_VV_LANG: HeaderName = HeaderName::from_static("x-vv-lang");
static X_VV_ENCODING: HeaderName = HeaderName::from_static("x-vv-encoding");

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

/// 扩展名 → MIME（文本类不带 charset，前端以 X-VV-Encoding 为准）。
fn mime_for_ext(ext: &str) -> &'static str {
    match ext {
        "txt" | "log" | "diff" | "patch" | "text" => "text/plain",
        "md" | "markdown" => "text/markdown",
        "rst" => "text/x-rst",
        "html" | "htm" => "text/html",
        "css" => "text/css",
        "js" | "mjs" | "cjs" => "text/javascript",
        "json" | "jsonc" | "map" => "application/json",
        "xml" => "application/xml",
        "svg" => "image/svg+xml",
        "yaml" | "yml" => "text/yaml",
        "toml" => "text/toml",
        "ini" | "cfg" | "conf" | "properties" | "env" => "text/plain",
        "csv" => "text/csv",
        "tsv" => "text/tab-separated-values",
        "py" => "text/x-python",
        "rb" => "text/x-ruby",
        "rs" => "text/x-rust",
        "go" => "text/x-go",
        "java" => "text/x-java-source",
        "kt" => "text/x-kotlin",
        "swift" => "text/x-swift",
        "c" | "h" => "text/x-c",
        "cpp" | "cc" | "cxx" | "hpp" | "hh" => "text/x-c++",
        "cs" => "text/x-csharp",
        "go.mod" => "text/plain",
        "sh" | "bash" | "zsh" | "fish" => "text/x-shellscript",
        "ps1" => "text/x-powershell",
        "lua" => "text/x-lua",
        "pl" | "pm" => "text/x-perl",
        "php" => "text/x-php",
        "r" => "text/x-r",
        "sql" => "text/x-sql",
        "ts" => "text/typescript",
        "tsx" => "text/typescript",
        "jsx" => "text/jsx",
        "vue" => "text/x-vue",
        "svelte" => "text/x-svelte",
        "vim" => "text/x-vim",
        "hs" => "text/x-haskell",
        "ml" | "mli" => "text/x-ocaml",
        "ex" | "exs" => "text/x-elixir",
        "erl" | "hrl" => "text/x-erlang",
        "clj" | "cljs" | "edn" => "text/x-clojure",
        "scala" => "text/x-scala",
        "dart" => "text/x-dart",
        "zig" => "text/x-zig",
        "nix" => "text/x-nix",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "ico" | "cur" => "image/x-icon",
        "avif" => "image/avif",
        "pdf" => "application/pdf",
        "wasm" => "application/wasm",
        "zip" => "application/zip",
        "tar" => "application/x-tar",
        "gz" | "tgz" | "gzip" => "application/gzip",
        "bz2" => "application/x-bzip2",
        "xz" => "application/x-xz",
        "7z" => "application/x-7z-compressed",
        "rar" => "application/vnd.rar",
        "zst" => "application/zstd",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" | "oga" => "audio/ogg",
        "opus" => "audio/opus",
        "flac" => "audio/flac",
        "m4a" => "audio/mp4",
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mkv" => "video/x-matroska",
        "mov" => "video/quicktime",
        "avi" => "video/x-msvideo",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "eot" => "application/vnd.ms-fontobject",
        _ => "application/octet-stream",
    }
}

fn mime_for_path(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()) {
        Some(ext) => mime_for_ext(&ext.to_ascii_lowercase()),
        None => "application/octet-stream",
    }
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

pub async fn file(
    State(state): State<AppState>,
    Query(q): Query<FileQuery>,
    headers: HeaderMap,
) -> Result<Response, AppError> {
    let root_idx = q.root.unwrap_or(0);
    let spec = state
        .roots
        .get(root_idx)
        .ok_or_else(|| guard::root_out_of_range(root_idx))?;
    let path = guard::resolve_at(&state, q.path.as_deref(), root_idx).await?;
    // guard 已保证 canonical 落在根内；strip 成 backend 相对路径（字节保真）
    let rel = path.strip_prefix(&spec.canonical).unwrap_or(Path::new(""));

    let entry = spec.backend.stat(&rel).await?;
    if matches!(entry.kind, BackendEntryKind::Dir) {
        return Err(AppError::bad_request("path is a directory"));
    }
    let size = entry.size.unwrap_or(0);
    let mime = mime_for_path(&path);
    let lang = detect::lang_for_path(&path);

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
    let range = match range_header {
        None => None,
        Some(Ok(r)) => r,
        Some(Err(())) => return Ok(range_not_satisfiable(size)),
    };

    let (status, start, len) = match range {
        Some((start, len)) => (StatusCode::PARTIAL_CONTENT, Some(start), len),
        None => (StatusCode::OK, None, size),
    };

    // 读取（下沉前：open → read_head 检测采样 → seek 回窗起点 → take 窗长流）；
    // backend 单开形态，窗为路由层已解析的 (start, len)
    let read = spec
        .backend
        .read_range(
            &rel,
            range.map(|(win_start, win_len)| RangeSpec {
                start: win_start,
                len: win_len,
            }),
            detect::ENCODING_HEAD_BYTES,
        )
        .await?;
    let encoding = detect::detect_encoding(&read.head);
    let stream = ReaderStream::new(read.stream);

    let mut res = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, HeaderValue::from_static(mime))
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_LENGTH, len)
        .header(X_VV_ENCODING.clone(), HeaderValue::from_static(encoding));
    if let Some(lang) = lang {
        res = res.header(X_VV_LANG.clone(), HeaderValue::from_static(lang));
    }
    if status == StatusCode::PARTIAL_CONTENT {
        let start = start.unwrap_or(0);
        res = res.header(
            header::CONTENT_RANGE,
            format!("bytes {start}-{}/{size}", start + len - 1),
        );
    }
    res.body(Body::from_stream(stream))
        .map_err(|e| AppError::internal(e.to_string()))
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
