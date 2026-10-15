import type { TreeStore, TreeNode, ByteRange } from '../types';
import { naturalCompare } from './localFiles';

type AnyHandle = FileSystemHandle & {
  kind: 'file' | 'directory';
  getFile?: () => Promise<File>;
};

/** 请求/确认目录句柄读权限；拒绝返回 false */
export async function ensurePermission(handle: FileSystemDirectoryHandle, read = true): Promise<boolean> {
  const mode = read ? 'read' : 'readwrite';
  const desc = { handle, mode } as unknown as PermissionDescriptor & { handle: unknown };
  const query = await navigator.permissions.query(desc);
  if (query.state === 'granted') return true;
  if (query.state === 'denied') return false;
  const req = handle as FileSystemDirectoryHandle & {
    requestPermission?: (d: { mode: string }) => Promise<PermissionState>;
  };
  if (!req.requestPermission) return false;
  return (await req.requestPermission({ mode })) === 'granted';
}

export function createLocalFsStore(handle: FileSystemDirectoryHandle): TreeStore {
  async function findValue(dir: AnyHandle, name: string): Promise<AnyHandle | undefined> {
    for await (const h of (dir as unknown as FileSystemDirectoryHandle).values()) {
      if (h.name === name) return h as AnyHandle;
    }
    return undefined;
  }
  async function resolve(path: string): Promise<AnyHandle> {
    let cur: AnyHandle = handle as unknown as AnyHandle;
    if (path === '') return cur;
    for (const seg of path.split('/')) {
      if (cur.kind !== 'directory') throw new Error(`路径 ${path} 中 ${seg} 的父级不是目录`);
      const next = await findValue(cur, seg);
      if (!next) throw new Error(`路径不存在: ${path}`);
      cur = next;
    }
    return cur;
  }
  return {
    id: `localfs:${handle.name}`,
    displayName: () => handle.name,
    async listChildren(path) {
      const dir = await resolve(path);
      if (dir.kind !== 'directory') throw new Error(`${path} 不是目录`);
      const out: TreeNode[] = [];
      for await (const h of (dir as unknown as FileSystemDirectoryHandle).values()) {
        if (h.kind === 'file') {
          const f = await (h as unknown as FileSystemFileHandle).getFile();
          out.push({ name: h.name, path: path ? `${path}/${h.name}` : h.name, kind: 'file', size: f.size, mtime: f.lastModified });
        } else {
          out.push({ name: h.name, path: path ? `${path}/${h.name}` : h.name, kind: 'dir' });
        }
      }
      return out.sort((a, b) => (a.kind === b.kind ? naturalCompare(a.name, b.name) : a.kind === 'dir' ? -1 : 1));
    },
    async read(path, opts) {
      // 降级语义（流式硬化，localFiles 同款）：File.slice().arrayBuffer() 无 signal
      // 参数，取消只能在入口截断——aborted 即 reject；晚 abort 由调用方丢弃结果。
      // 错误身份统一（deferred 清偿 Task 5 合批）：DOMException AbortError 对齐
      // localFiles/singleFile——isAbortError 同源判定（name 判别）恒静默不误吞读失败
      if (opts?.signal?.aborted) throw new DOMException('读取已取消', 'AbortError');
      const h = await resolve(path);
      if (h.kind !== 'file' || !h.getFile) throw new Error(`${path} 不是文件`);
      const file = await h.getFile();
      if (opts?.range) {
        const { start, end } = opts.range as ByteRange;
        return new Uint8Array(await file.slice(start, end + 1).arrayBuffer());
      }
      return new Uint8Array(await file.arrayBuffer());
    },
    // 能力标记（spec §2.3）：read 的 opts.range 分支已实现（File.slice，end 含）
    rangeCapable: true
  };
}
