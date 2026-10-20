//! `GET /api/tree`：单层目录列表（目录优先 + 自然排序）。
//!
//! 扫描/hidden 过滤/排序/保真名已下沉 storage crate（`vviewer_storage::LocalFs`，
//! Task 2 纯重构）；本 handler 只做 guard 解析与 backend 分发。

use std::path::{Path, PathBuf};

use axum::extract::{Query, State};
use axum::Json;
use serde::{Deserialize, Serialize};

use vviewer_storage::EntryKind as BackendEntryKind;

use crate::error::AppError;
use crate::guard;
use crate::state::AppState;

#[derive(Deserialize)]
pub struct TreeQuery {
    pub path: Option<String>,
    /// 多根索引（缺省 0 号根；越界 400）。
    pub root: Option<usize>,
}

#[derive(Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EntryKind {
    Dir,
    File,
}

#[derive(Serialize)]
pub struct TreeEntry {
    pub name: String,
    pub kind: EntryKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mtime: Option<u64>,
}

#[derive(Serialize)]
pub struct TreeResponse {
    pub entries: Vec<TreeEntry>,
}

/// 自然排序比较（实现下沉 storage crate；re-export 保持既有 API 路径不变）。
pub use vviewer_storage::natural_cmp;

/// 既有 BUG-48 锁测的兼容包装：实现已下沉 [`vviewer_storage::file_name_fidelity`]，
/// 生产路径经 LocalFs.list_dir 使用。
#[cfg(test)]
fn file_name_fidelity(name: &std::ffi::OsStr) -> String {
    vviewer_storage::file_name_fidelity(name)
}

pub async fn tree(
    State(state): State<AppState>,
    Query(q): Query<TreeQuery>,
) -> Result<Json<TreeResponse>, AppError> {
    let root_idx = q.root.unwrap_or(0);
    // 静态段 + 运行时段统一寻址（阶段二）：root_at 对静态根行为与旧
    // roots.get() 逐位一致；运行时挂载根（rootIndex ≥ roots.len()）从容器取。
    let spec = state.root_at(root_idx).ok_or_else(|| guard::root_out_of_range(root_idx))?;
    // fs 根：guard 全链（清洗 → canonicalize → 越界 403）后 strip 成 backend 相对
    // 路径；挂载根（rootIndex ≥ fs_roots，spec §2）：无 fs 语义——清洗安全面照旧
    //（绝对/`..`/NUL 拒），不做 fs canonicalize，清洗产物即 backend 相对路径。
    let rel: PathBuf = match &spec.mount {
        None => {
            let dir = guard::resolve_at(&state, q.path.as_deref(), root_idx).await?;
            // guard 已保证 canonical 落在根内；strip 成 backend 相对路径（字节保真，
            // BUG-48 非法 UTF-8 名经 canonicalize 后仍按原始字节承载）
            dir.strip_prefix(&spec.canonical).unwrap_or(Path::new("")).to_path_buf()
        }
        Some(_) => guard::clean_relative(Path::new(""), q.path.as_deref())?,
    };

    // 目录判定（下沉前：metadata is_dir → 404 "not a directory"）
    let entry = spec.backend.stat(&rel).await?;
    if !matches!(entry.kind, BackendEntryKind::Dir) {
        return Err(AppError::not_found("not a directory"));
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

    Ok(Json(TreeResponse { entries }))
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
