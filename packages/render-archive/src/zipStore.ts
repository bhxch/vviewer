// zipStore.ts — zip 的 TreeStore 实现（M4 Task 3 + e2e 修复 BUG-12）。
// jszip 动态 import（重依赖不进主包）；条目路径分段聚合为目录树，
// 目录优先 + naturalCompare 自然排序（core 公用）。递归预览深度以 parentChain 表达：
// 顶层 createZipStore(buf) → id 'zip:<name>'；内层传父链（由 source.storeId 的前导
// 'zip' 段经 zipChainOf 推导）→ id 'zip:zip:<name>'。
// depth ≥ MAX_ARCHIVE_DEPTH 的 store 仅拒绝再展开内嵌压缩包条目（read 抛"嵌套层数超限"），
// 普通条目照常可读。加密条目在 read 时捕获 jszip 错误转中文提示。
// BUG-12：jszip 对「任一加密条目」在 loadAsync（中心目录解析期）即整包抛错——捕获后
// 自解析中心目录（EOCD→CDH 遍历通用标志 bit0 与未压缩大小）仍产出完整条目树
// （TreeNode.encrypted 逐条标记），明文条目经 libarchive worker 兜底读取（动态
// import libarchiveStore 的 allowEncryptedEntries 档），加密条目 read 直接抛
// 「该条目已加密，无法解密预览」；中心目录解析失败（ZIP64/损坏）回退原错误卡片。
import type { TreeStore, TreeNode } from '@vviewer/core';
import { naturalCompare } from '@vviewer/core';

/** 递归预览允许的最大嵌套层数（顶层 depth=0；depth ≥3 的 store 内不能再展开压缩包） */
export const MAX_ARCHIVE_DEPTH = 3;
/** 归档输入大小上限（全内存解析） */
export const MAX_ZIP_INPUT_BYTES = 200 * 1024 * 1024;
/** 视为"内嵌压缩包"需拒展的扩展名（T4 起 tar 系/7z/rar 与 zip 同语义） */
export const ARCHIVE_EXTS = new Set(['zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar']);

/** 由 store id 提取内层压缩包应传的父链（= id 的前导归档段：'zip:a.zip' → 'zip'，
 * 'libarchive:inner.tar' → 'libarchive'，'zip:libarchive:mixed' → 'zip:libarchive'，
 * 非归档来源 → ''）。archiveRenderer 由此接线递归深度。 */
export function archiveChainOf(storeId: string): string {
  const segs = storeId.split(':');
  const chain: string[] = [];
  for (const s of segs) {
    if (s !== 'zip' && s !== 'libarchive') break;
    chain.push(s);
  }
  return chain.join(':');
}

/** zip 旧名兼容别名（T4 前 API；语义已泛化为归档链） */
export const zipChainOf = archiveChainOf;

export function isArchiveEntry(path: string): boolean {
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

/** 全量条目快照（路径 → 大小，目录为 -1 哨兵）下的直接子项列举：虚拟目录聚合，
 * 目录优先 + naturalCompare 自然排序。zip/libarchive 两个 store 共用；
 * encryptedPaths 提供时对应文件节点带 encrypted 标记（BUG-12 逐条锁形标记）。 */
export function listTreeChildren(
  sizes: Map<string, number>,
  path: string,
  encryptedPaths?: ReadonlySet<string>
): TreeNode[] {
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
      else files.push({ name: rest, path: p, kind: 'file', size, ...(encryptedPaths?.has(p) ? { encrypted: true } : {}) });
    } else {
      dirs.add(rest.slice(0, slash));
    }
  }
  const out: TreeNode[] = [];
  for (const d of dirs) out.push({ name: d, path: prefix + d, kind: 'dir' });
  out.push(...files);
  out.sort((a, b) => (a.kind === b.kind ? naturalCompare(a.name, b.name) : a.kind === 'dir' ? -1 : 1));
  return out;
}

// ---------- zip 中心目录最小自解析（BUG-12：混合加密包的条目树来源） ----------

/** 中心目录解析结果：路径 → 大小（目录 -1 哨兵）与加密文件路径集（通用标志 bit0） */
export interface ZipDirectory {
  sizes: Map<string, number>;
  encryptedPaths: Set<string>;
}

function readU16(b: Uint8Array, off: number): number {
  return b[off]! | (b[off + 1]! << 8);
}

function readU32(b: Uint8Array, off: number): number {
  return (b[off]! | (b[off + 1]! << 8) | (b[off + 2]! << 16) | (b[off + 3]! << 24)) >>> 0;
}

/** 从尾部扫描 EOCD 签名（PK\x05\x06）：固定 22 字节 + 注释（≤65535），注释可能含任意字节，从后向前找 */
function findEocdOffset(b: Uint8Array): number | null {
  const min = Math.max(0, b.length - 22 - 65535);
  for (let i = b.length - 22; i >= min; i--) {
    if (b[i] === 0x50 && b[i + 1] === 0x4b && b[i + 2] === 0x05 && b[i + 3] === 0x06) return i;
  }
  return null;
}

/**
 * 自解析 zip 中心目录（EOCD → CDH 遍历）：取通用标志 bit0（加密）与未压缩大小。
 * 仅支持常规 zip；ZIP64（条目数/偏移/大小的 0xFFFF/0xFFFFFFFF 哨兵）抛错——
 * 调用方（createZipStore 加密分支）回退原「Encrypted zip」错误（不劣于现状）。
 */
export function parseZipCentralDirectory(buffer: Uint8Array): ZipDirectory {
  const eocd = findEocdOffset(buffer);
  if (eocd === null) throw new Error('无法定位 zip 中心目录');
  const total = readU16(buffer, eocd + 10);
  const cdOffset = readU32(buffer, eocd + 16);
  if (total === 0xffff || cdOffset === 0xffffffff) {
    throw new Error('ZIP64 格式的加密 zip 暂不支持');
  }
  const sizes = new Map<string, number>();
  const encryptedPaths = new Set<string>();
  let off = cdOffset;
  for (let i = 0; i < total; i++) {
    if (off + 46 > buffer.length || readU32(buffer, off) !== 0x02014b50) {
      throw new Error('zip 中心目录损坏');
    }
    const flags = readU16(buffer, off + 8);
    const uncompSize = readU32(buffer, off + 24);
    const nameLen = readU16(buffer, off + 28);
    const extraLen = readU16(buffer, off + 30);
    const commentLen = readU16(buffer, off + 32);
    if (uncompSize === 0xffffffff) throw new Error('ZIP64 格式的加密 zip 暂不支持');
    const name = new TextDecoder().decode(buffer.subarray(off + 46, off + 46 + nameLen));
    const isDir = name.endsWith('/');
    const path = isDir ? name.replace(/\/+$/, '') : name;
    if (path !== '') {
      sizes.set(path, isDir ? -1 : uncompSize);
      if (!isDir && (flags & 1) !== 0) encryptedPaths.add(path);
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  return { sizes, encryptedPaths };
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
 * 含加密条目的混合包：jszip 整包拒绝后转中心目录自解析 + libarchive 兜底读取
 * （明文可读、加密逐条标记并拦截，见 parseZipCentralDirectory/createEncryptedZipStore）。
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
  let zip: ZipInstance;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch (err) {
    // BUG-12：jszip 在中心目录解析期对任一加密条目整包抛错（jszip lib/zipEntry.js
    // "Encrypted zip are not supported"），read 期的逐条转换到不了——转混合包路径
    if (err instanceof Error && /encrypt/i.test(err.message)) {
      return createEncryptedZipStore(buffer, parentChain, name, err);
    }
    throw err;
  }

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
      return listTreeChildren(sizes, path);
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

/**
 * 混合加密包 store（BUG-12）：条目树来自中心目录自解析（完整、含逐条加密标记），
 * 明文条目 read 转发 libarchive worker（allowEncryptedEntries 档构造不整包拒绝），
 * 加密条目 read 直接拦截报错。libarchive 也打不开（非 zip 假签名等）时回退原
 * jszip 错误（不劣于现状）。id/displayName 与普通 zip store 同构（嵌套链推导一致）。
 */
async function createEncryptedZipStore(
  buffer: Uint8Array,
  parentChain: string | undefined,
  name: string | undefined,
  cause: Error
): Promise<TreeStore> {
  let dir: ZipDirectory;
  try {
    dir = parseZipCentralDirectory(buffer);
  } catch {
    throw cause; // ZIP64/损坏目录：维持原「Encrypted zip」错误（错误卡片兜底，不劣于现状）
  }
  if (dir.sizes.size === 0) throw cause;
  const lib = await import('./libarchiveStore');
  let libStore: TreeStore & { close?(): void };
  try {
    libStore = await lib.createLibarchiveStore(buffer, parentChain, name, { allowEncryptedEntries: true });
  } catch {
    throw cause;
  }
  const depth = parentChain ? parentChain.split(':').length : 0;
  // close 幂等（与 libarchiveStore 同防线）：archiveRenderer 引用计数接线可能双调
  let closed = false;
  return {
    id: `zip${':zip'.repeat(parentChain ? parentChain.split(':').length : 0)}:${truncateName(name ?? 'archive')}`,
    displayName: () => name ?? 'archive',
    async listChildren(path) {
      return listTreeChildren(dir.sizes, path, dir.encryptedPaths);
    },
    async read(path) {
      if (dir.sizes.get(path) === -1) throw new Error(`目录条目无法读取: ${path}`);
      // 深度限制语义与普通 zip store 一致：仅拦再展开内嵌压缩包
      if (depth >= MAX_ARCHIVE_DEPTH && isArchiveEntry(path)) {
        throw new Error(`嵌套层数超限：递归预览最多 ${MAX_ARCHIVE_DEPTH} 层`);
      }
      if (dir.encryptedPaths.has(path)) throw new Error('该条目已加密，无法解密预览');
      return libStore.read(path);
    },
    close() {
      if (closed) return;
      closed = true;
      libStore.close?.(); // 加密 zip 走 libarchive worker：close 接线语义与 libarchive store 一致
    }
  };
}
