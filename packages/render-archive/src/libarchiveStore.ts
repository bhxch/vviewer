// libarchiveStore.ts — tar/tgz/tar.gz/tbz2/xz/7z/rar 的 TreeStore 实现（M4 Task 4）。
// libarchive.js（wasm，动态 import）解析；vitest/Node 环境走 worker_threads 入口
// （libarchive-node.mjs），浏览器走 worker bundle（apps/web 由 vite 插件拷贝静态资产，
// 启动时 configureLibarchive({ workerUrl }) 注入路径；未配置则 open 超时报中文错误）。
// 与 zipStore 同构：目录聚合 + naturalCompare（listTreeChildren 共用）、parentChain 深度链
// （前导 'zip'/'libarchive' 段计数，depth ≥ MAX_ARCHIVE_DEPTH 仅拒内嵌归档展开）、
// 加密/不支持格式抛中文错误（dispatcher 兜底错误卡）。worker 生命周期：extract 懒取需
// worker 存活，故 store 暴露可选 close()；T7 已接线——从未点开条目的 store 随 archive
// 实例 destroy 关闭，点开过条目的 store 由 openFlow 在最后一个持有 tab 关闭时关闭。
import type { TreeStore } from '@vviewer/core';
import { MAX_ARCHIVE_DEPTH, MAX_ZIP_INPUT_BYTES, isArchiveEntry, listTreeChildren } from './zipStore';

/** libarchive.js 的最窄使用面（主入口自带类型；node 子入口无类型，运行时同构） */
type ArchiveModule = typeof import('libarchive.js');
interface CompressedFileLike {
  name: string;
  size: number;
  extract(): Promise<File>;
}
interface ArchiveReaderLike {
  hasEncryptedData(): Promise<boolean | null>;
  getFilesObject(): Promise<object>;
  close(): Promise<void>;
}

/** 浏览器端 worker 注入（apps/web 启动时配置；未配置时 open 会因 worker 404 超时） */
export interface LibarchiveWorkerOptions {
  workerUrl?: string;
  getWorker?: () => Worker;
}
let workerOptions: LibarchiveWorkerOptions | null = null;

/** 浏览器端注入 libarchive worker 路径/工厂（node 环境无需，模块加载时已自配） */
export function configureLibarchive(opts: LibarchiveWorkerOptions): void {
  workerOptions = { ...opts };
}

/** 环境分流加载：无 Worker（Node/vitest jsdom）→ worker_threads 入口；浏览器 → 主入口 */
let libPromise: Promise<ArchiveModule> | null = null;
async function loadArchiveModule(): Promise<ArchiveModule> {
  libPromise ??= (async (): Promise<ArchiveModule> => {
    if (typeof Worker === 'undefined') {
      // 非字面量 specifier：避免浏览器构建把 worker_threads 依赖打进 bundle（仅 Node 分支执行）
      const nodeEntry = 'libarchive.js/dist/libarchive-node.mjs';
      return (await import(/* @vite-ignore */ nodeEntry)) as ArchiveModule;
    }
    const mod = await import('libarchive.js');
    if (workerOptions) {
      mod.Archive.init({
        workerUrl: workerOptions.workerUrl,
        getWorker: workerOptions.getWorker
      });
    }
    return mod;
  })();
  return libPromise;
}

/** jsdom 全局 File 非结构化克隆安全（comlink 经 worker_threads postMessage 传参），
 * Node 分支用 node:buffer 原生 File 构造 */
async function makeArchiveFile(buffer: Uint8Array, name: string): Promise<File> {
  const part = buffer as Uint8Array<ArrayBuffer>;
  if (typeof Worker === 'undefined') {
    const bufSpec = 'node:buffer';
    const { File: NodeFile } = (await import(/* @vite-ignore */ bufSpec)) as {
      File: new (parts: BlobPart[], name: string) => File;
    };
    return new NodeFile([part], name);
  }
  return new File([part], name);
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

const OPEN_TIMEOUT_MS = 20_000;
const LIST_TIMEOUT_MS = 60_000;

/** libarchive 错误 → 用户可读值（加密/格式/已关闭/ wasm 崩溃转中文，其余透传） */
export function normalizeLibarchiveError(err: unknown): unknown {
  if (err instanceof Error) {
    const m = err.message;
    if (/encrypt/i.test(m)) return new Error('该条目已加密，无法解密预览');
    if (/already closed/i.test(m)) return new Error('压缩包已关闭，无法再读取条目');
    if (
      /unrecognized|unknown format|format not|corrupt|invalid/i.test(m) ||
      err.name === 'RuntimeError' ||
      /table index|memory access|out of bounds|unreachable|abort/i.test(m)
    ) {
      // wasm 对垃圾输入可能直接 RuntimeError 崩溃，统一按格式错误呈现
      return new Error('无法识别的压缩包格式（支持 zip/tar/tar.gz/tgz/tbz2/xz/7z/rar）');
    }
    return err;
  }
  return err;
}

function truncateName(name: string): string {
  return name.length > 24 ? `${name.slice(0, 24)}…` : name;
}

function isCompressedFile(v: unknown): v is CompressedFileLike {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as { extract?: unknown }).extract === 'function' &&
    typeof (v as { size?: unknown }).size === 'number'
  );
}

/**
 * 从归档字节构造 TreeStore（libarchive.js wasm 解析，支持 tar/tgz/tar.gz/tbz2/xz/7z/rar；
 * zip 建议走 createZipStore）。懒提取：构造只列条目，read 时经 worker 解压单条目。
 * 目录条目 read 抛错；加密归档构造即抛；深度语义与 zipStore 一致（parentChain 为
 * archiveChainOf 提取的前导归档段链，depth ≥ MAX_ARCHIVE_DEPTH 拒展内嵌归档）。
 * 可选 close() 终止 worker——T7 已接线：从未点开过条目的 store 在 archiveRenderer 实例
 * destroy 时关闭；点开过条目的 store 由 openFlow 在最后一个持有它的 tab 关闭时关闭。
 */
export async function createLibarchiveStore(
  buffer: Uint8Array,
  /**
   * 父级归档嵌套链：顶层不传；内层归档传父 store 的链（'zip' / 'libarchive' / 'zip:libarchive'…，
   * 由父 store id 经 archiveChainOf 提取）。
   */
  parentChain?: string,
  /** 归档显示名（displayName 与 id 尾段）；默认 'archive' */
  name?: string
): Promise<TreeStore & { close?(): void }> {
  if (buffer.length > MAX_ZIP_INPUT_BYTES) {
    throw new Error(`归档超过 200MB 上限（当前 ${(buffer.length / (1024 * 1024)).toFixed(0)}MB），不进行内存解析`);
  }
  const mod = await loadArchiveModule();
  const file = await makeArchiveFile(buffer, name ?? 'archive.bin');
  let reader: ArchiveReaderLike;
  try {
    reader = (await withTimeout(
      mod.Archive.open(file),
      OPEN_TIMEOUT_MS,
      `打开压缩包超时（${OPEN_TIMEOUT_MS / 1000}s）：libarchive worker 初始化失败或格式解析卡死`
    )) as unknown as ArchiveReaderLike;
  } catch (err) {
    throw normalizeLibarchiveError(err);
  }

  try {
    const encrypted = await withTimeout(reader.hasEncryptedData(), LIST_TIMEOUT_MS, '加密检测超时');
    if (encrypted === true) {
      void reader.close();
      throw new Error('该压缩包已加密，无法预览（请先解密解压）');
    }

    // 全量条目快照：路径 → 大小（文件记原始大小；目录为 -1 哨兵）+ 懒提取句柄。
    // getFilesObject 返回嵌套对象（键为名称，文件叶为 CompressedFile，目录为普通对象，
    // 空目录为 {}），递归 walk 摊平。
    const content = (await withTimeout(reader.getFilesObject(), LIST_TIMEOUT_MS, '条目列举超时')) as object;
    const sizes = new Map<string, number>();
    const handles = new Map<string, CompressedFileLike>();
    const walk = (node: object, prefix: string): void => {
      for (const [key, val] of Object.entries(node)) {
        const p = prefix + key;
        if (isCompressedFile(val)) {
          sizes.set(p, val.size);
          handles.set(p, val);
        } else if (typeof val === 'object' && val !== null) {
          sizes.set(p, -1);
          walk(val, `${p}/`);
        }
      }
    };
    walk(content, '');

    // 空快照：合法空 tar 极罕见且无预览价值，而垃圾字节流经 libarchive 也常得到空列表，
    // 统一按"无法识别"拒绝，避免渲染一棵无解释的空树
    if (sizes.size === 0) {
      void reader.close();
      throw new Error('无法识别的压缩包格式（支持 zip/tar/tar.gz/tgz/tbz2/xz/7z/rar）或归档为空');
    }

    const depth = parentChain ? parentChain.split(':').length : 0;
    return {
      id: `libarchive${parentChain ? `:${parentChain}` : ''}:${truncateName(name ?? 'archive')}`,
      displayName: () => name ?? 'archive',
      async listChildren(path) {
        return listTreeChildren(sizes, path);
      },
      async read(path) {
        if (sizes.get(path) === -1) throw new Error(`目录条目无法读取: ${path}`);
        // 深度限制只拦"再展开内嵌压缩包"：depth 届满的 store 里普通条目照常可读
        if (depth >= MAX_ARCHIVE_DEPTH && isArchiveEntry(path)) {
          throw new Error(`嵌套层数超限：递归预览最多 ${MAX_ARCHIVE_DEPTH} 层`);
        }
        const entry = handles.get(path);
        if (!entry) throw new Error(`未知路径: ${path}`);
        try {
          const extracted = await withTimeout(
            entry.extract(),
            LIST_TIMEOUT_MS,
            `条目解压超时: ${path}`
          );
          return new Uint8Array(await extracted.arrayBuffer());
        } catch (err) {
          throw normalizeLibarchiveError(err);
        }
      },
      close() {
        void reader.close();
      }
    };
  } catch (err) {
    void reader.close();
    throw err instanceof Error && /加密|无法识别|超时/.test(err.message) ? err : normalizeLibarchiveError(err);
  }
}
