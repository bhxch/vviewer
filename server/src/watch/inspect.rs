//! 平台事件归集与文件系统诊断（BE-3 目录化自 watch.rs 迁入）：notify 事件 →
//! 按根归组的相对路径集合、/proc/self/mounts 的文件系统类型探测。

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use notify::Event as NotifyEvent;

#[cfg(target_os = "linux")]
use super::recovery::unescape_mount;

/// Linux：读 /proc/self/mounts 取覆盖 root 的最长挂载点文件系统类型（诊断用）。
#[cfg(target_os = "linux")]
pub(super) fn fs_type_of(path: &Path) -> Option<String> {
    let target = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let mounts = std::fs::read_to_string("/proc/self/mounts").ok()?;
    let mut best: Option<(usize, String)> = None;
    for line in mounts.lines() {
        let mut fields = line.split_whitespace();
        let Some(_device) = fields.next() else { continue };
        let Some(mount_point) = fields.next().and_then(unescape_mount) else { continue };
        let Some(fstype) = fields.next() else { continue };
        if target.starts_with(&mount_point) {
            let len = mount_point.as_os_str().len();
            if best.as_ref().is_none_or(|(l, _)| len > *l) {
                best = Some((len, fstype.to_string()));
            }
        }
    }
    best.map(|(_, t)| t)
}

#[cfg(not(target_os = "linux"))]
pub(super) fn fs_type_of(_path: &Path) -> Option<String> {
    None
}

/// notify 事件（成功态）→ 按根归组的相对路径集合（'/' 分隔，排序去重由
/// BTreeSet 保证；键 = 事件所属根索引）。窗口关闭时逐根发帧（见 session_loop）。
pub(super) fn collect_event(
    ev: &NotifyEvent,
    root_idx: usize,
    root: &Path,
    out: &mut BTreeMap<usize, BTreeSet<String>>,
) {
    // Access（打开/读取）不改变内容：过滤掉 watcher 自身的初始目录扫描事件，
    // 也避免 SSE 客户端查看文件（读操作）反过来触发一次无意义的变更推送
    if matches!(ev.kind, notify::EventKind::Access(_)) {
        return;
    }
    for p in &ev.paths {
        // 根外路径不进 changed 帧（防止绝对路径泄露给客户端）：直接跳过
        let Ok(rel) = p.strip_prefix(root) else { continue };
        // Windows 分隔符统一为 '/'，与 /api/tree、/api/file 的 path 参数一致
        out.entry(root_idx).or_default().insert(rel.to_string_lossy().replace('\\', "/"));
    }
}

/// 原始通道事件（含 Err）：错误事件不产生路径（由 session_loop 触发重建自愈）。
#[cfg(test)]
fn collect_paths(
    ev: &super::recovery::RawEvent,
    root_idx: usize,
    root: &Path,
    out: &mut BTreeMap<usize, BTreeSet<String>>,
) {
    let Ok(ev) = ev else { return };
    collect_event(ev, root_idx, root, out);
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use notify::event::{AccessKind, AccessMode, CreateKind, EventKind};

    use super::super::testkit::ev;
    use super::*;

    #[test]
    fn access_events_and_out_of_root_paths_are_dropped() {
        let root = PathBuf::from("/srv/root");
        let mut out: BTreeMap<usize, BTreeSet<String>> = BTreeMap::new();

        // Access 事件（如 watcher 自身初始扫描 / 客户端读文件）不构成变更
        collect_paths(
            &ev(
                EventKind::Access(AccessKind::Open(AccessMode::Any)),
                &["/srv/root/a.txt"],
            ),
            0,
            &root,
            &mut out,
        );
        assert!(out.is_empty(), "Access 事件应被过滤");

        // 根内路径转相对、归入对应根索引；根外绝对路径跳过（不泄露给客户端）
        collect_paths(
            &ev(
                EventKind::Create(CreateKind::File),
                &["/srv/root/sub/b.txt", "/etc/passwd"],
            ),
            0,
            &root,
            &mut out,
        );
        assert_eq!(
            out,
            BTreeMap::from([(0, BTreeSet::from(["sub/b.txt".to_string()]))])
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn fs_type_of_resolves_mount_of_tmp() {
        let fstype = fs_type_of(Path::new("/tmp")).expect("/tmp 应有挂载点条目");
        assert!(!fstype.is_empty(), "fstype 应非空: {fstype}");
    }
}
