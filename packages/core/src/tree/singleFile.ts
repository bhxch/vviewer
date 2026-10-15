import type { TreeStore, TreeNode } from '../types';

export function createSingleFileStore(file: File): TreeStore {
  return {
    id: `single:${file.name}:${file.size}:${file.lastModified}`,
    displayName: () => file.name,
    async listChildren(): Promise<TreeNode[]> {
      return [{ name: file.name, path: file.name, kind: 'file', size: file.size, mtime: file.lastModified }];
    },
    async read(path, opts) {
      if (opts?.signal?.aborted) throw new Error('读取已取消');
      if (path !== file.name) throw new Error(`未知路径: ${path}`);
      return new Uint8Array(await file.arrayBuffer());
    }
  };
}

export function createUrlStore(url: string): TreeStore {
  let bytes: Promise<Uint8Array<ArrayBuffer>> | null = null;
  const name = decodeURIComponent(url.split('/').pop() ?? url).split(/[?#]/, 1)[0] ?? url;
  const id = `url:${hash8(url)}`;
  return {
    id,
    displayName: () => url,
    async listChildren() {
      return [{ name, path: name, kind: 'file' }];
    },
    async read(path, opts) {
      if (path !== name) throw new Error(`未知路径: ${path}`);
      if (opts?.signal?.aborted) throw new Error('读取已取消');
      // 缓存键不含 signal：取消后重试走新 fetch（取消的尝试不留缓存）
      bytes ??= fetch(url, { signal: opts?.signal }).then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status} 获取 ${url} 失败`);
        return new Uint8Array(await res.arrayBuffer());
      });
      // 取消/失败的尝试即出表（memoizedFullRead 同纪律）：仅当缓存仍是本次尝试时
      // 清空——不误清并发后到的重试；catch 已挂链，无未处理 rejection
      const attempt = bytes;
      void attempt.catch(() => {
        if (bytes === attempt) bytes = null;
      });
      return bytes;
    }
  };
}

/** FNV-1a 8 位十六进制摘要：store id 派生共用（single/url/remote store）。 */
export function hash8(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}
