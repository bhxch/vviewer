import type { TreeStore, TreeNode } from '../types';

export function createSingleFileStore(file: File): TreeStore {
  return {
    id: `single:${file.name}:${file.size}:${file.lastModified}`,
    displayName: () => file.name,
    async listChildren(): Promise<TreeNode[]> {
      return [{ name: file.name, path: file.name, kind: 'file', size: file.size, mtime: file.lastModified }];
    },
    async read(path) {
      if (path !== file.name) throw new Error(`未知路径: ${path}`);
      return new Uint8Array(await file.arrayBuffer());
    }
  };
}

export function createUrlStore(url: string): TreeStore {
  let bytes: Promise<Uint8Array> | null = null;
  const name = decodeURIComponent(url.split('/').pop() ?? url).split(/[?#]/, 1)[0] ?? url;
  const id = `url:${hash8(url)}`;
  return {
    id,
    displayName: () => url,
    async listChildren() {
      return [{ name, path: name, kind: 'file' }];
    },
    async read(path) {
      if (path !== name) throw new Error(`未知路径: ${path}`);
      bytes ??= fetch(url).then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status} 获取 ${url} 失败`);
        return new Uint8Array(await res.arrayBuffer());
      });
      return bytes;
    }
  };
}

function hash8(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}
