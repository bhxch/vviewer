//! `GET /api/tree` 业务体（多端发布阶段二 Task 2 自适配层 routes/tree.rs 迁入）：
//! 根寻址（静态段 + 运行时段统一寻址）→ guard 解析 → StorageBackend 分发
//! （stat 目录判定 + list_dir）→ 条目响应形态。Range 无涉；axum 面仅 Query
//! 参数提取。
//!
//! 扫描/hidden 过滤/排序/保真名已下沉 storage crate（`vviewer_storage::LocalFs`，
//! 既有纯重构）；本域只做 guard 解析与 backend 分发。

use std::path::{Path, PathBuf};

use http::StatusCode;
use serde::Serialize;

use vviewer_storage::EntryKind as BackendEntryKind;

use crate::error::CoreError;
use crate::guard;
use crate::state::CoreState;
use crate::CoreResponse;

/// 单层目录条目（`name` 为保真名：合法 UTF-8 原样，非法字节 `%XX` 编码）。
#[derive(Serialize)]
pub struct TreeEntry {
    pub name: String,
    pub kind: EntryKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mtime: Option<u64>,
}

/// 条目类别（HTTP 形态：小写字面 dir/file）。
#[derive(Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EntryKind {
    Dir,
    File,
}

#[derive(Serialize)]
pub struct TreeResponse {
    pub entries: Vec<TreeEntry>,
}

/// `GET /api/tree`：单层目录列表（目录优先 + 自然排序）。
///
/// - `root_idx`：多根索引（适配层已按 Query 缺省 0 号根；越界 400）；
/// - `path`：相对所选根的路径（None = 根自身）。
pub async fn list(
    state: &CoreState,
    root_idx: usize,
    path: Option<&str>,
) -> Result<CoreResponse, CoreError> {
    // 静态段 + 运行时段统一寻址（阶段二）：root_at 对静态根行为与旧
    // roots.get() 逐位一致；运行时挂载根（rootIndex ≥ roots.len()）从容器取。
    let spec = state.root_at(root_idx).ok_or_else(|| guard::root_out_of_range(root_idx))?;
    // fs 根：guard 全链（清洗 → canonicalize → 越界 403）后 strip 成 backend 相对
    // 路径；挂载根（rootIndex ≥ fs_roots，spec §2）：无 fs 语义——清洗安全面照旧
    //（绝对/`..`/NUL 拒），不做 fs canonicalize，清洗产物即 backend 相对路径。
    let rel: PathBuf = match &spec.mount {
        None => {
            let dir = guard::resolve_at(state, path, root_idx).await?;
            // guard 已保证 canonical 落在根内；strip 成 backend 相对路径（字节保真，
            // BUG-48 非法 UTF-8 名经 canonicalize 后仍按原始字节承载）
            dir.strip_prefix(&spec.canonical).unwrap_or(Path::new("")).to_path_buf()
        }
        Some(_) => guard::clean_relative(Path::new(""), path)?,
    };

    // 目录判定（下沉前：metadata is_dir → 404 "not a directory"）
    let entry = spec.backend.stat(&rel).await?;
    if !matches!(entry.kind, BackendEntryKind::Dir) {
        return Err(CoreError::not_found("not a directory"));
    }

    let entries: Vec<TreeEntry> = spec
        .backend
        .list_dir(&rel)
        .await?
        .into_iter()
        .map(|e| TreeEntry {
            name: e.name,
            kind: match e.kind {
                BackendEntryKind::Dir => EntryKind::Dir,
                BackendEntryKind::File => EntryKind::File,
            },
            size: e.size,
            mtime: e.mtime,
        })
        .collect();

    Ok(CoreResponse::json(StatusCode::OK, &TreeResponse { entries }))
}

/// 既有 BUG-48 锁测的兼容包装：实现在 [`vviewer_storage::file_name_fidelity`]，
/// 生产路径经 LocalFs.list_dir 使用。
#[cfg(test)]
fn file_name_fidelity(name: &std::ffi::OsStr) -> String {
    vviewer_storage::file_name_fidelity(name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::CoreBody;

    /// BUG-48 保真列出锁测：合法 UTF-8（含空格/中文/emoji）原样透传；
    /// 非法字节按 `%XX` 大写十六进制编码、合法段保持原样（与 guard 解码
    /// 回退互为逆变换）。
    #[test]
    fn file_name_fidelity_passes_utf8_and_encodes_invalid_bytes() {
        use std::ffi::OsStr;
        use std::os::unix::ffi::OsStrExt;
        assert_eq!(file_name_fidelity(OsStr::new("ok.txt")), "ok.txt");
        assert_eq!(file_name_fidelity(OsStr::new("空格 名.txt")), "空格 名.txt");
        assert_eq!(file_name_fidelity(OsStr::new("emoji😀.txt")), "emoji😀.txt");
        // 磁盘形态：bad ff fe 6e... → bad%FF%FEname.txt
        let raw = OsStr::from_bytes(b"bad\xff\xfename.txt");
        assert_eq!(file_name_fidelity(raw), "bad%FF%FEname.txt");
        // 前缀 + 不完整多字节尾：合法段保留、尾字节逐个编码
        let raw = OsStr::from_bytes(b"\xe4\xb8\xad\xff.txt");
        assert_eq!(file_name_fidelity(raw), "中%FF.txt");
    }

    /// 域 handler 锚测：经 CoreState → LocalFs 分发产出目录优先 + 自然序的
    /// JSON 形态（dir 字面小写；列表语义细面由 storage crate 测试锁定）。
    #[tokio::test]
    async fn list_returns_dir_first_natural_order_json() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a2.txt"), b"two").unwrap();
        std::fs::write(dir.path().join("a10.txt"), b"ten").unwrap();
        std::fs::create_dir(dir.path().join("sub")).unwrap();

        let cs = CoreState::new(dir.path().to_path_buf(), None, false);
        let res = list(&cs, 0, None).await.unwrap();
        assert_eq!(res.status, StatusCode::OK);
        assert_eq!(
            res.headers.get("content-type").and_then(|v| v.to_str().ok()),
            Some("application/json")
        );
        // CoreBody 当前仅 Full 变体（流形态随 file 域落地）；届时改 let-else
        let CoreBody::Full(bytes) = res.body;
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        let names: Vec<&str> =
            v["entries"].as_array().unwrap().iter().map(|e| e["name"].as_str().unwrap()).collect();
        // 目录优先 + 自然序（2 < 10，按数值不按字典序）
        assert_eq!(names, vec!["sub", "a2.txt", "a10.txt"]);
        assert_eq!(v["entries"][0]["kind"], "dir");
        assert_eq!(v["entries"][1]["kind"], "file");
    }

    /// 非 directory 路径 → 404 "not a directory"（业务面与迁移前 handler 一致）。
    #[tokio::test]
    async fn list_on_file_returns_not_a_directory() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("f.txt"), b"x").unwrap();
        let cs = CoreState::new(dir.path().to_path_buf(), None, false);
        let err = list(&cs, 0, Some("f.txt")).await.unwrap_err();
        assert_eq!(err.0, StatusCode::NOT_FOUND);
        assert_eq!(err.1, "not a directory");
    }
}
