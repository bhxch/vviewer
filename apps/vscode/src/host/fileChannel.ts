// fileChannel.ts — 文件字节通道（spec H T2）。
//
// 纯 .ts 模块：**零 `vscode` import**——`vscode.workspace.fs` 以结构类型注入，便于单测直测。
//
// 大文件闸（spec §7 ⑤）：上限 200MB（对齐 web 端 `PLAIN_MAX_BYTES`，
// packages/vviewer-render-text/src/code/strategy.ts:92）。**先 stat 判大小再决定是否读**——
// 超过上限即**不读文件**（避免大文件全量入内存），webview 侧按 `doc.size` 与共享阈值
// `MAX_BYTES` 判定并显示引导占位（文案走扩展 i18n 目录）。
//
// 失败面（RF 3「可见失败面」）：读失败如实上报错误（webview 无 console 出口，错误经
// `report` 通道上行），不静默吞掉。
import { MAX_BYTES } from './protocol';

/** 大文件上限（200MB） */
export { MAX_BYTES };

/** vscode.FileStat 的最小结构面 */
export interface FileStatLike {
  size: number;
}

/** vscode.workspace.fs 的最小结构面（注入用） */
export interface FileSystemLike {
  stat(uri: unknown): PromiseLike<FileStatLike>;
  readFile(uri: unknown): PromiseLike<Uint8Array>;
}

/** 读文件结果 */
export type ReadOutcome =
  | { ok: true; size: number; bytes: Uint8Array }
  /** 超过上限：**未读文件**（bytes 未取） */
  | { ok: false; reason: 'too-large'; size: number }
  | { ok: false; reason: 'error'; message: string };

/**
 * 读文档字节（先 stat 判大小，超限不读）。
 *
 * @param fs vscode.workspace.fs 的结构面（注入）
 * @param uri 文档 URI
 */
export async function readDocumentBytes(fs: FileSystemLike, uri: unknown): Promise<ReadOutcome> {
  let size: number;
  try {
    const stat = await fs.stat(uri);
    size = stat.size;
  } catch (e: unknown) {
    return { ok: false, reason: 'error', message: errorMessage(e) };
  }
  if (size > MAX_BYTES) {
    // 超限：不读文件（避免大文件全量入内存）
    return { ok: false, reason: 'too-large', size };
  }
  try {
    const bytes = await fs.readFile(uri);
    return { ok: true, size, bytes };
  } catch (e: unknown) {
    return { ok: false, reason: 'error', message: errorMessage(e) };
  }
}

/** 错误信息提取（Error 走 message，其余走 String） */
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
