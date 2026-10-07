//! `GET /api/file`：流式文件响应（单区间 Range + 服务端检测头）。

use std::path::Path;

use axum::body::Body;
use axum::extract::{Query, State};
use axum::http::{header, HeaderMap, HeaderName, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio_util::io::ReaderStream;

use crate::detect;
use crate::error::AppError;
use crate::guard;
use crate::state::AppState;

static X_VV_LANG: HeaderName = HeaderName::from_static("x-vv-lang");
static X_VV_ENCODING: HeaderName = HeaderName::from_static("x-vv-encoding");

#[derive(Deserialize)]
pub struct FileQuery {
    pub path: Option<String>,
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

/// 读文件头 ≤8KB（循环填满，容忍短读）。
async fn read_head(f: &mut tokio::fs::File) -> Vec<u8> {
    let mut buf = vec![0u8; detect::ENCODING_HEAD_BYTES];
    let mut filled = 0;
    while filled < buf.len() {
        match f.read(&mut buf[filled..]).await {
            Ok(0) => break,
            Ok(n) => filled += n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
    }
    buf.truncate(filled);
    buf
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
    let path = guard::resolve(&state, q.path.as_deref()).await?;

    let meta = tokio::fs::metadata(&path).await.map_err(AppError::from)?;
    if meta.is_dir() {
        return Err(AppError::bad_request("path is a directory"));
    }
    let size = meta.len();
    let mime = mime_for_path(&path);
    let lang = detect::lang_for_path(&path);

    let mut f = tokio::fs::File::open(&path).await.map_err(AppError::from)?;
    let head = read_head(&mut f).await;
    let encoding = detect::detect_encoding(&head);

    let range_header = headers
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
        .map(|h| parse_range(h, size));
    let range = match range_header {
        None => None,
        Some(Ok(r)) => r,
        Some(Err(())) => return Ok(range_not_satisfiable(size)),
    };

    let (status, start, len) = match range {
        Some((start, len)) => (StatusCode::PARTIAL_CONTENT, Some(start), len),
        None => (StatusCode::OK, None, size),
    };

    // 读 head 消耗了读取位置（小文件可能已读空），统一回到响应起点
    f.seek(std::io::SeekFrom::Start(start.unwrap_or(0)))
        .await
        .map_err(AppError::from)?;
    let stream = ReaderStream::new(f.take(len));

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
