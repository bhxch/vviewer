import type { TreeStore, TreeNode } from '../types';

/** 自然排序：数字段按数值比较 */
export function naturalCompare(a: string, b: string): number {
  const re = /(\d+)|(\D+)/g;
  const ax = a.match(re) ?? [];
  const bx = b.match(re) ?? [];
  for (let i = 0; i < Math.min(ax.length, bx.length); i++) {
    const an = ax[i]!, bn = bx[i]!;
    const anum = /^\d/.test(an), bnum = /^\d/.test(bn);
    if (anum && bnum) {
      const d = Number(an) - Number(bn);
      if (d !== 0) return d;
    } else if (an !== bn) {
      return an < bn ? -1 : 1;
    }
  }
  return ax.length - bx.length;
}

export function createLocalFilesStore(files: FileList | File[], label: string): TreeStore {
  const all = Array.from(files);
  const prefix = all[0]?.webkitRelativePath.split('/', 1)[0] ?? label;
  const byDir = new Map<string, File[]>();
  for (const f of all) {
    const rel = f.webkitRelativePath.split('/').slice(1).join('/'); // 去掉根目录名
    const dir = rel.split('/').slice(0, -1).join('/');
    const list = byDir.get(dir) ?? [];
    list.push(f);
    byDir.set(dir, list);
  }
  const dirIndex = new Set<string>();
  for (const [dir] of byDir) {
    dirIndex.add(dir);
    for (const f of byDir.get(dir) ?? []) {
      const segs = f.webkitRelativePath.split('/').slice(1);
      for (let i = 1; i < segs.length - 1; i++) dirIndex.add(segs.slice(0, i).join('/'));
    }
  }
  return {
    id: `localfiles:${prefix}`,
    displayName: () => prefix,
    async listChildren(path) {
      const out: TreeNode[] = [];
      for (const d of dirIndex) {
        if ((d.split('/').slice(0, -1).join('/') || '') === path && d)
          out.push({ name: d.split('/').pop()!, path: d, kind: 'dir' });
      }
      for (const f of byDir.get(path) ?? []) {
        const rel = f.webkitRelativePath.split('/').slice(1).join('/');
        out.push({ name: f.name, path: rel, kind: 'file', size: f.size, mtime: f.lastModified });
      }
      return out.sort((a, b) => (a.kind === b.kind ? naturalCompare(a.name, b.name) : a.kind === 'dir' ? -1 : 1));
    },
    async read(path) {
      const f = (byDir.get(path.split('/').slice(0, -1).join('/') ?? '') ?? []).find(
        (x) => x.webkitRelativePath.split('/').slice(1).join('/') === path
      );
      if (!f) throw new Error(`未知路径: ${path}`);
      return new Uint8Array(await f.arrayBuffer());
    }
  };
}
