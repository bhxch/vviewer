// zipStore.ts — zip 的 TreeStore 实现（M4 Task 3）。
// jszip 动态 import（重依赖不进主包）；条目路径分段聚合为目录树，
// 目录优先 + naturalCompare 自然排序（core 公用）。递归预览深度以 parentChain 表达：
// 顶层 createZipStore(buf) → id 'zip:<name>'；内层传父链（由 source.storeId 的前导
// 'zip' 段经 zipChainOf 推导）→ id 'zip:zip:<name>'。
// depth ≥ MAX_ARCHIVE_DEPTH 的 store 仅拒绝再展开内嵌压缩包条目（read 抛"嵌套层数超限"），
// 普通条目照常可读。加密条目在 read 时捕获 jszip 错误转中文提示。
import type { TreeStore, TreeNode } from '@vviewer/core';
import { naturalCompare } from '@vviewer/core';

/** 递归预览允许的最大嵌套层数（顶层 depth=0；depth ≥3 的 store 内不能再展开压缩包） */
export const MAX_ARCHIVE_DEPTH = 3;
/** zip 输入大小上限（全内存解析） */
export const MAX_ZIP_INPUT_BYTES = 200 * 1024 * 1024;
/** 视为"内嵌压缩包"需拒展的扩展名（T4 扩展 tar 等） */
const ARCHIVE_EXTS = new Set(['zip']);

/** 由 store id 提取内层压缩包应传的父链（= id 的前导 'zip' 段：'zip:a.zip' → 'zip'，
 * 'zip:zip:inner.zip' → 'zip:zip'，非 zip 来源 → ''）。archiveRenderer 由此接线递归深度。 */
export function zipChainOf(storeId: string): string {
  const segs = storeId.split(':');
  const chain: string[] = [];
  for (const s of segs) {
    if (s !== 'zip') break;
    chain.push(s);
  }
  return chain.join(':');
}

function isArchiveEntry(path: string): boolean {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return ARCHIVE_EXTS.has(ext);
}

/** jszip read 错误 → 用户可读值（加密条目转换中文 Error，其余透传） */
export function normalizeZipError(err: unknown): unknown {
  if (err instanceof Error) {
    if (/encrypt/i.test(err.message)) return new Error('该条目已加密，无法解密预览');
    return err;
  }
  return err;
}

function truncateName(name: string): string {
  return name.length > 24 ? `${name.slice(0, 24)}…` : name;
}

/** jszip 的最窄使用面（export = 的 CJS 包，ESM 互操作下类挂在 default，避免与其类型纠缠） */
interface ZipEntry {
  dir: boolean;
  _data?: { uncompressedSize?: number };
}
interface ZipInstance {
  forEach(cb: (relPath: string, entry: ZipEntry) => void): void;
  file(name: string): { async(type: 'uint8array'): Promise<Uint8Array> } | null;
}
type ZipConstructor = { loadAsync(data: Uint8Array): Promise<ZipInstance> };

/**
 * 从 zip 字节构造 TreeStore（loadAsync 全内存）。
 * 目录条目 read 抛错；listChildren 返回目录优先、自然排序的直接子项（虚拟目录聚合，
 * 不要求 zip 内显式目录条目存在）。
 */
export async function createZipStore(
  buffer: Uint8Array,
  /**
   * 父级 zip 嵌套链：顶层不传；内层 zip 传父 store 的链（'zip' / 'zip:zip'，
   * 由父 store id 经 zipChainOf 提取）。depth = 链段数，depth ≥ MAX_ARCHIVE_DEPTH 时 read 拒绝。
   */
  parentChain?: string,
  /** zip 显示名（displayName 与 id 尾段）；默认 'archive' */
  name?: string
): Promise<TreeStore> {
  if (buffer.length > MAX_ZIP_INPUT_BYTES) {
    throw new Error(`zip 超过 200MB 上限（当前 ${(buffer.length / (1024 * 1024)).toFixed(0)}MB），不进行内存解析`);
  }
  const mod = await import('jszip');
  const JSZip = ((mod as { default?: ZipConstructor }).default ?? mod) as ZipConstructor;
  const zip = await JSZip.loadAsync(buffer);

  // 全量条目快照：路径 → 大小（文件记未压缩大小；目录条目记 -1 哨兵）
  const sizes = new Map<string, number>();
  zip.forEach((relPath, entry) => {
    const isDir = entry.dir || relPath.endsWith('/');
    const path = isDir ? relPath.replace(/\/+$/, '') : relPath;
    if (path !== '') sizes.set(path, isDir ? -1 : entry._data?.uncompressedSize ?? 0);
  });

  return {
    id: `zip${':zip'.repeat(parentChain ? parentChain.split(':').length : 0)}:${truncateName(name ?? 'archive')}`,
    displayName: () => name ?? 'archive',
    async listChildren(path) {
      const prefix = path === '' ? '' : `${path}/`;
      const dirs = new Set<string>();
      const files: TreeNode[] = [];
      for (const [p, size] of sizes) {
        if (!p.startsWith(prefix)) continue;
        const rest = p.slice(prefix.length);
        if (rest === '') continue;
        const slash = rest.indexOf('/');
        if (slash === -1) {
          if (size < 0) dirs.add(rest);
          else files.push({ name: rest, path: p, kind: 'file', size });
        } else {
          dirs.add(rest.slice(0, slash));
        }
      }
      const out: TreeNode[] = [];
      for (const d of dirs) out.push({ name: d, path: prefix + d, kind: 'dir' });
      out.push(...files);
      out.sort((a, b) => (a.kind === b.kind ? naturalCompare(a.name, b.name) : a.kind === 'dir' ? -1 : 1));
      return out;
    },
    async read(path) {
      const depth = parentChain ? parentChain.split(':').length : 0;
      if (sizes.get(path) === -1) throw new Error(`目录条目无法读取: ${path}`);
      // 深度限制只拦"再展开内嵌压缩包"：depth 届满的 store 里普通条目照常可读
      if (depth >= MAX_ARCHIVE_DEPTH && isArchiveEntry(path)) {
        throw new Error(`嵌套层数超限：递归预览最多 ${MAX_ARCHIVE_DEPTH} 层`);
      }
      const entry = zip.file(path);
      if (!entry) throw new Error(`未知路径: ${path}`);
      try {
        return await entry.async('uint8array');
      } catch (err) {
        throw normalizeZipError(err);
      }
    }
  };
}
