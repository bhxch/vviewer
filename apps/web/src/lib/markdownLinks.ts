// markdownLinks.ts — spec D §3.2 markdown 相对链接站内解析（app 侧纯函数）。
// markdownImages.ts 抽出模式同款：无 $app 依赖可 vitest 直测；resolveInStorePath
// 复用自 ./markdownImages——链接与图片同一 join 语义单源。
import type { TreeStore } from '@bhxch/vviewer-core';
import type { RelativeLinkTarget } from '@bhxch/vviewer-markdown';
import { resolveInStorePath } from './markdownImages';

/**
 * 相对 href → store 内路径（spec D §3.2 解析式）：query/hash 剥离（跨文件 fragment
 * hash 丢弃——§6 落定 4 MVP 不自动定位）→ URL 解码（markdown-it 对 CJK href 百分号
 * 编码，decode 失败保留原串）→ resolveInStorePath join。`./`/`../` 逐段规范、越
 * store 根返回 null。前导 `/` = store 根相对（spec §3.2 拍板，与图片面 isAbsoluteSrc
 * 的「根相对不进 resolver」刻意不同权）：resolveInStorePath 以当前文件目录为基会把
 * 前导 `/` 当空段吞掉（`sub/a.md`+`/top.md` → `sub/top.md`），此处以空基（store 根）
 * 显式归一。
 */
export function resolveRelativeLinkPath(sourcePath: string, href: string): string | null {
  const stripped = href.replace(/[?#][\s\S]*$/, '');
  if (stripped === '') return null;
  let decoded = stripped;
  try {
    decoded = decodeURIComponent(stripped);
  } catch {
    /* 非法百分号序列：保留原串 */
  }
  const base = decoded.startsWith('/') ? '' : sourcePath;
  const p = resolveInStorePath(base, decoded);
  return p === '' ? null : p; // 空结果（'./' 弹空、纯根 '/' 等）非站内目标
}

/** 存在性探测（§6 落定 6）：listChildren(dir).find(path) 命中按 TreeNode.kind 返回；
 * listChildren 失败（平铺 store）→ read 兜底（成功=file；失败含目录目标一律 null）。 */
async function probeStorePath(store: TreeStore, path: string): Promise<'file' | 'dir' | null> {
  try {
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    const node = (await store.listChildren(dir)).find((n) => n.path === path);
    if (node) return node.kind;
    return null;
  } catch {
    try {
      await store.read(path);
      return 'file';
    } catch {
      return null; // read 失败（含目录目标/AbortError）= missing——渲染取消不误报
    }
  }
}

/**
 * 相对 href → RelativeLinkTarget（存在性探测 §6 落定 6）：listChildren(父目录).find
 * 命中即按 TreeNode.kind 分流 file/dir；未命中且末段无扩展名 → 试 `path+'.md'`
 * （wikilink `[[file]]` 无扩展名形态，变体探测递归一次）；listChildren 失败（平铺
 * store）→ read 兜底（成功=file；失败含目录目标=missing）。未命中返回
 * { kind: 'missing', path: 解析后完整路径 }（提示文案消费）；解析 null（越根/纯锚）
 * 返回 { kind: 'missing' }（无解析路径可示）。
 */
export async function resolveRelativeLinkTarget(
  store: TreeStore,
  sourcePath: string,
  href: string
): Promise<RelativeLinkTarget> {
  const path = resolveRelativeLinkPath(sourcePath, href);
  if (path === null) return { kind: 'missing' };
  const hit = await probeStorePath(store, path);
  if (hit === 'file') return { kind: 'file', storeId: store.id, path };
  if (hit === 'dir') return { kind: 'directory', storeId: store.id, path };
  const base = path.includes('/') ? path.slice(path.lastIndexOf('/') + 1) : path;
  if (!base.includes('.')) {
    const mdPath = `${path}.md`;
    const mdHit = await probeStorePath(store, mdPath);
    if (mdHit === 'file') return { kind: 'file', storeId: store.id, path: mdPath };
    if (mdHit === 'dir') return { kind: 'directory', storeId: store.id, path: mdPath };
  }
  return { kind: 'missing', path };
}
