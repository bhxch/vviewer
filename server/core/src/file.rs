//! `GET /api/file` 业务体（多端发布阶段二 Task 2 自适配层 routes/file.rs 迁入）：
//! 根寻址（静态段 + 运行时段统一寻址）→ guard 解析 → stat 目录判定 → MIME/
//! 语言/编码判定 → StorageBackend 窗读取 → 响应头组装。
//!
//! Range 头解析属 HTTP 语义（计划裁决）留适配层：适配层把 Range 头解析为
//! [`RangeSpec`] 窗口（storage 既有的「路由层 Range 解析产物」类型），本域
//! handler 收已解析窗口——core 面不含头语法/If-Range/多区间判定。

use std::path::{Path, PathBuf};

use http::{header, HeaderMap, HeaderName, HeaderValue, StatusCode};

use tokio_util::io::ReaderStream;

use vviewer_storage::{EntryKind as BackendEntryKind, RangeSpec};

use crate::detect;
use crate::error::CoreError;
use crate::guard;
use crate::state::{CoreState, RootSpec};
use crate::{CoreBody, CoreResponse};

static X_VV_LANG: HeaderName = HeaderName::from_static("x-vv-lang");
static X_VV_ENCODING: HeaderName = HeaderName::from_static("x-vv-encoding");

/// Range 解析前置的定位产物（stat 业务面）：适配层据 [`Located::size`] 解析
/// Range 头，再以 `Some(located)` 消费窗读取。字段私有——适配层只见 size，
/// backend/相对路径面不出 core。
#[derive(Debug)]
pub struct Located {
    spec: RootSpec,
    rel: PathBuf,
    size: u64,
}

impl Located {
    /// stat 产物（`entry.size.unwrap_or(0)` 既有语义）。
    pub fn size(&self) -> u64 {
        self.size
    }
}

/// 定位（Range 解析前置段）：根寻址 → guard 解析 → stat → 目录 400。
/// 目录判定先于适配层的 Range 解析（既有顺序：目录 400 优先于 416）。
pub async fn locate(
    state: &CoreState,
    root_idx: usize,
    path: Option<&str>,
) -> Result<Located, CoreError> {
    // 静态段 + 运行时段统一寻址（阶段二）：root_at 对静态根行为与旧
    // roots.get() 逐位一致；运行时挂载根（rootIndex ≥ roots.len()）从容器取。
    let spec = state.root_at(root_idx).ok_or_else(|| guard::root_out_of_range(root_idx))?;
    // fs 根：guard 全链后 strip 成 backend 相对路径；挂载根（rootIndex ≥ fs_roots，
    // spec §2）：无 fs 语义——清洗安全面照旧，不做 fs canonicalize。
    let rel: PathBuf = match &spec.mount {
        None => {
            let p = guard::resolve_at(state, path, root_idx).await?;
            // guard 已保证 canonical 落在根内；strip 成 backend 相对路径（字节保真）
            p.strip_prefix(&spec.canonical).unwrap_or(Path::new("")).to_path_buf()
        }
        Some(_) => guard::clean_relative(Path::new(""), path)?,
    };

    let entry = spec.backend.stat(&rel).await?;
    if matches!(entry.kind, BackendEntryKind::Dir) {
        return Err(CoreError::bad_request("path is a directory"));
    }
    Ok(Located { spec, rel, size: entry.size.unwrap_or(0) })
}

/// 读取（Range 解析后置段）：MIME/语言按文件名扩展判定 → backend 窗读取
/// （单开形态：head 检测采样 + 已定位窗起点流）→ 检测头/响应头组装。
///
/// - `window`：适配层已解析的读取窗（None = 全量 200；Some = 206 局部）；
/// - 流式响应体经 [`CoreBody::Stream`] 承载，适配层统一重建 axum 响应。
pub async fn read(located: Located, window: Option<RangeSpec>) -> Result<CoreResponse, CoreError> {
    let Located { spec, rel, size } = located;
    // MIME/语言按文件名扩展判定：挂载根用清洗后的相对名（与 fs 根的 canonical
    // 绝对路径同扩展，判定结果一致）
    let mime = mime_for_path(&rel);
    let lang = detect::lang_for_path(&rel);

    let (status, start, len) = match window {
        Some(w) => {
            // 1-3：路由层解析产物不变式——窗口非空（len=0 窗是上游解析缺陷，
            // 静默产出空 206 会污染缓存语义）
            debug_assert!(w.len >= 1, "empty window from route layer: {w:?}");
            (StatusCode::PARTIAL_CONTENT, Some(w.start), w.len)
        }
        None => (StatusCode::OK, None, size),
    };

    // 读取（下沉前：open → read_head 检测采样 → seek 回窗起点 → take 窗长流）；
    // backend 单开形态，窗为路由层已解析的 (start, len)
    let read = spec.backend.read_range(&rel, window, detect::ENCODING_HEAD_BYTES).await?;
    let encoding = detect::detect_encoding(&read.head);

    let mut headers = HeaderMap::new();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static(mime));
    headers.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    headers.insert(header::CONTENT_LENGTH, HeaderValue::from(len));
    headers.insert(X_VV_ENCODING.clone(), HeaderValue::from_static(encoding));
    if let Some(lang) = lang {
        headers.insert(X_VV_LANG.clone(), HeaderValue::from_static(lang));
    }
    if status == StatusCode::PARTIAL_CONTENT {
        let start = start.unwrap_or(0);
        // Content-Range 值恒为合法 header 字节（start/end/size 均为数字字面量）
        headers.insert(
            header::CONTENT_RANGE,
            HeaderValue::from_str(&format!("bytes {start}-{}/{size}", start + len - 1))
                .expect("content-range value"),
        );
    }
    Ok(CoreResponse {
        status,
        headers,
        body: CoreBody::Stream(Box::pin(ReaderStream::new(read.stream))),
    })
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::future::poll_fn;

    /// 排空 [`CoreBody::Stream`] 收集全部字节（锚测用；生产侧由适配层把流
    /// 重建为 axum Body，不经此处）。
    async fn drain(body: CoreBody) -> Vec<u8> {
        let CoreBody::Stream(mut stream) = body else { panic!("file body must be stream") };
        let mut out = Vec::new();
        loop {
            let chunk = poll_fn(|cx| stream.as_mut().poll_next(cx)).await;
            match chunk {
                Some(Ok(bytes)) => out.extend_from_slice(&bytes),
                Some(Err(e)) => panic!("stream error: {e}"),
                None => return out,
            }
        }
    }

    /// MIME 判定锚测（迁移前 handler 内联表抽测面）：文本类小写化命中、
    /// 未知扩展回退 application/octet-stream、无扩展同回退。
    #[test]
    fn mime_for_ext_maps_lowercase_and_falls_back() {
        assert_eq!(mime_for_path(Path::new("a/b.TXT")), "text/plain");
        assert_eq!(mime_for_path(Path::new("x.rs")), "text/x-rust");
        assert_eq!(mime_for_path(Path::new("img.PNG")), "image/png");
        assert_eq!(mime_for_path(Path::new("noext")), "application/octet-stream");
        assert_eq!(mime_for_path(Path::new("what.xyzzy")), "application/octet-stream");
    }

    /// 域 handler 锚测（locate→read 双段，含适配层解析出的窗口参数）：
    /// 全量 200（Content-Length 全长 + x-vv-encoding utf-8 + 流体逐字节）与
    /// 206 窗（Content-Range/局部 Content-Length + 窗内字节）。
    #[tokio::test]
    async fn read_serves_full_and_windowed_responses() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("f.txt"), b"hello world").unwrap();
        let cs = CoreState::new(dir.path().to_path_buf(), None, false);

        // 全量 200
        let located = locate(&cs, 0, Some("f.txt")).await.unwrap();
        assert_eq!(located.size(), 11);
        let res = read(located, None).await.unwrap();
        assert_eq!(res.status, StatusCode::OK);
        assert_eq!(
            res.headers.get(header::CONTENT_LENGTH).and_then(|v| v.to_str().ok()),
            Some("11")
        );
        assert_eq!(
            res.headers.get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()),
            Some("text/plain")
        );
        assert_eq!(
            res.headers.get("x-vv-encoding").and_then(|v| v.to_str().ok()),
            Some("utf-8")
        );
        assert!(res.headers.get("x-vv-lang").is_none());
        assert_eq!(drain(res.body).await, b"hello world");

        // 206 窗（适配层已解析：bytes=6- → start 6, len 5）
        let located = locate(&cs, 0, Some("f.txt")).await.unwrap();
        let res = read(located, Some(RangeSpec { start: 6, len: 5 })).await.unwrap();
        assert_eq!(res.status, StatusCode::PARTIAL_CONTENT);
        assert_eq!(
            res.headers.get(header::CONTENT_RANGE).and_then(|v| v.to_str().ok()),
            Some("bytes 6-10/11")
        );
        assert_eq!(
            res.headers.get(header::CONTENT_LENGTH).and_then(|v| v.to_str().ok()),
            Some("5")
        );
        assert_eq!(drain(res.body).await, b"world");
    }

    /// 目录 400（既有顺序：stat 目录判定先于适配层 Range 解析）。
    #[tokio::test]
    async fn locate_rejects_directory() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("sub")).unwrap();
        let cs = CoreState::new(dir.path().to_path_buf(), None, false);
        let err = locate(&cs, 0, Some("sub")).await.unwrap_err();
        assert_eq!(err.0, StatusCode::BAD_REQUEST);
        assert_eq!(err.1, "path is a directory");
    }
}
