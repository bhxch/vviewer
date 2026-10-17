//! `GET /api/tree`：单层目录列表（目录优先 + 自然排序）。

use std::ffi::OsStr;
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

/// 文件名保真转换（BUG-48）：合法 UTF-8 名原样返回；含非法字节的名把非法
/// 字节 percent-encode 为 `%XX`（合法段原样），产出「可列出且可寻址」的可逆
/// 形态。此前 `to_string_lossy` 把非法字节替换为 U+FFFD——替换名与磁盘真实
/// 字节不匹配，该文件一旦被列出便无法经任何 HTTP 路径寻址（guard 侧配套
/// `%XX` 解码回退见 guard.rs）。
fn file_name_fidelity(name: &OsStr) -> String {
    match std::str::from_utf8(name.as_encoded_bytes()) {
        Ok(s) => s.to_string(),
        Err(_) => encode_invalid_utf8(name.as_encoded_bytes()),
    }
}

/// 非法 UTF-8 字节序列的 percent-encode：`std::str::from_utf8` 逐段校验，
/// 合法段原样拼接、错误处按 `error_len`（None = 不完整尾部，取剩余全部）
/// 逐字节 `%XX`。与 guard 的解码回退互为逆变换。
fn encode_invalid_utf8(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() + 8);
    let mut rest = bytes;
    loop {
        match std::str::from_utf8(rest) {
            Ok(s) => {
                out.push_str(s);
                return out;
            }
            Err(e) => {
                let valid = e.valid_up_to();
                // valid_up_to 保证前缀合法；unwrap 只在切片越界时不可能发生
                out.push_str(std::str::from_utf8(&rest[..valid]).unwrap_or(""));
                let bad = e.error_len().unwrap_or(rest.len() - valid);
                for b in &rest[valid..valid + bad] {
                    out.push_str(&format!("%{b:02X}"));
                }
                rest = &rest[valid + bad..];
            }
        }
    }
}

pub async fn tree(
    State(state): State<AppState>,
    Query(q): Query<TreeQuery>,
) -> Result<Json<TreeResponse>, AppError> {
    let dir = guard::resolve_at(&state, q.path.as_deref(), q.root.unwrap_or(0)).await?;

    if !tokio::fs::metadata(&dir).await.map_err(AppError::from)?.is_dir() {
        return Err(AppError::not_found("not a directory"));
    }

    let mut rd = tokio::fs::read_dir(&dir).await.map_err(AppError::from)?;
    let mut entries: Vec<TreeEntry> = Vec::new();
    while let Some(e) = rd.next_entry().await.map_err(AppError::from)? {
        let name = file_name_fidelity(e.file_name().as_os_str());
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

#[cfg(test)]
mod tests {
    use super::*;

    /// BUG-48 保真列出锁测：合法 UTF-8（含空格/中文/emoji）原样透传；
    /// 非法字节按 `%XX` 大写十六进制编码、合法段保持原样（与 guard 解码
    /// 回退互为逆变换）。
    #[test]
    fn file_name_fidelity_passes_utf8_and_encodes_invalid_bytes() {
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
