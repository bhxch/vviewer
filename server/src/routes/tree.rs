//! `GET /api/tree`：单层目录列表（目录优先 + 自然排序）。

use std::time::UNIX_EPOCH;

use axum::extract::{Query, State};
use axum::Json;
use serde::{Deserialize, Serialize};

use crate::error::AppError;
use crate::guard;
use crate::state::AppState;

#[derive(Deserialize)]
pub struct TreeQuery {
    pub path: Option<String>,
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

pub async fn tree(
    State(state): State<AppState>,
    Query(q): Query<TreeQuery>,
) -> Result<Json<TreeResponse>, AppError> {
    let dir = guard::resolve(&state, q.path.as_deref()).await?;

    if !tokio::fs::metadata(&dir).await.map_err(AppError::from)?.is_dir() {
        return Err(AppError::not_found("not a directory"));
    }

    let mut rd = tokio::fs::read_dir(&dir).await.map_err(AppError::from)?;
    let mut entries: Vec<TreeEntry> = Vec::new();
    while let Some(e) = rd.next_entry().await.map_err(AppError::from)? {
        let name = e.file_name().to_string_lossy().into_owned();
        if state.hidden && name.starts_with('.') {
            continue;
        }
        // 跟随 symlink 取目标 metadata：symlink 目录按 dir 呈现（进入时仍有 canonicalize 守卫）
        let md = match tokio::fs::metadata(e.path()).await {
            Ok(md) => md,
            Err(_) => continue, // 竞态删除等瞬时错误：跳过该条目
        };
        let mtime = md
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64);
        let (kind, size) = if md.is_dir() {
            (EntryKind::Dir, None)
        } else {
            (EntryKind::File, Some(md.len()))
        };
        entries.push(TreeEntry { name, kind, size, mtime });
    }

    entries.sort_by(|a, b| {
        let rank = |e: &TreeEntry| if matches!(e.kind, EntryKind::Dir) { 0u8 } else { 1 };
        rank(a).cmp(&rank(b)).then_with(|| natural_cmp(&a.name, &b.name))
    });

    Ok(Json(TreeResponse { entries }))
}

/// 自然排序比较：数字段按数值比较（a2 < a10），其余按字节比较
/// （UTF-8 字节序即码点序，非 ASCII 名字稳定）。
pub fn natural_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    use std::cmp::Ordering;

    let (mut ab, mut bb) = (a.as_bytes(), b.as_bytes());
    loop {
        match (ab.first(), bb.first()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(&x), Some(&y)) => {
                if x.is_ascii_digit() && y.is_ascii_digit() {
                    let (a_digits, a_rest) = split_digits(ab);
                    let (b_digits, b_rest) = split_digits(bb);
                    // 去前导零后：先比长度再比字典序 == 数值比较
                    let at = strip_leading_zeros(a_digits);
                    let bt = strip_leading_zeros(b_digits);
                    match at.len().cmp(&bt.len()).then_with(|| at.cmp(bt)) {
                        Ordering::Equal => {
                            // 数值相等时前导零多者在前（保持确定性）
                            let zeros = a_digits.len().cmp(&b_digits.len());
                            if zeros != Ordering::Equal {
                                return zeros;
                            }
                            ab = a_rest;
                            bb = b_rest;
                        }
                        ord => return ord,
                    }
                } else {
                    match x.cmp(&y) {
                        Ordering::Equal => {
                            ab = &ab[1..];
                            bb = &bb[1..];
                        }
                        ord => return ord,
                    }
                }
            }
        }
    }
}

fn split_digits(b: &[u8]) -> (&[u8], &[u8]) {
    let end = b.iter().position(|c| !c.is_ascii_digit()).unwrap_or(b.len());
    (&b[..end], &b[end..])
}

fn strip_leading_zeros(d: &[u8]) -> &[u8] {
    let first_non_zero = d.iter().position(|&c| c != b'0').unwrap_or(d.len());
    &d[first_non_zero..]
}
