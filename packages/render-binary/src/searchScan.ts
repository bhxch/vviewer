// searchScan.ts — worker 搜索的分块纯函数（Task 2，spec H §2.2）。
// scanChunk：单块字节扫描（重叠区去重）；scanAll：分块调度（逐块进度回调、
// 累计命中截断、取消中止）。jsdom 单测直测；binary.worker 以薄壳调用（同
// handleRequest「核心纯函数 + serve」模式），大文件扫描不占主线程。

/** worker 搜索块大小（1MB）：每块扫描后回报进度并让出消息循环（取消即时生效） */
export const SEARCH_CHUNK_BYTES = 1 << 20;
/** 命中上限：块内即时判停（收满即 break），防巨型文件命中风暴——单字节 needle
 * 也不会在单块内超额收满（spec「1000 上限」精确成立） */
export const SEARCH_MAX_HITS = 1000;

/**
 * 单块扫描：data 为扫描窗（调用方在其前部拼入前块尾部 overlap 字节），baseOffset
 * 为 data[0] 的绝对偏移。返回命中 needle 起始的绝对 offset 列表（升序）。
 *
 * 去重语义：完全落在重叠区（data 前 overlap 字节）内的命中不再返回——该区域属前
 * 块扫描范围，前块已报；起点在重叠区、终点伸入新区域的跨界命中由本块恰报一次。
 * overlap = needle.length - 1 时，两块各自可报的命中起点区间不相交，天然不重不漏。
 *
 * maxHits 配额（块内即时判停）：收满即 break，不再扫完整块——调用方传「剩余配额」
 * （总量 - 已收），使累计恰好封顶；缺省不限。
 */
export function scanChunk(
  data: Uint8Array,
  needle: Uint8Array,
  baseOffset: number,
  overlap: number,
  maxHits = Number.POSITIVE_INFINITY
): number[] {
  const hits: number[] = [];
  const n = needle.length;
  if (n === 0 || data.length < n) return hits;
  const first = needle[0]!;
  for (let i = 0; i + n <= data.length; i++) {
    if (i + n <= overlap) continue; // 完全落在重叠区：前块已报
    if (data[i] !== first) continue;
    let matched = true;
    for (let j = 1; j < n; j++) {
      if (data[i + j] !== needle[j]) {
        matched = false;
        break;
      }
    }
    if (matched) {
      hits.push(baseOffset + i);
      if (hits.length >= maxHits) break; // 配额收满：即时判停
    }
  }
  return hits;
}

/** ASCII 字母折叠（大小写不敏感文本搜索；仅 A-Z↔a-z，多字节 UTF-8 序列不受影响） */
function foldBytes(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    out[i] = b >= 0x41 && b <= 0x5a ? b + 0x20 : b;
  }
  return out;
}

export interface ScanChunkInfo {
  /** 累计已扫描字节数 */
  scanned: number;
  /** 文件总字节数 */
  total: number;
  /** 本块新增命中数 */
  hits: number;
  /** 本块新增命中的绝对 offset（升序） */
  offsets: number[];
}

export interface ScanAllOptions {
  chunkSize?: number;
  maxHits?: number;
  /** 大小写不敏感（needle 与数据均做 ASCII 折叠后比较） */
  fold?: boolean;
  /** 每块扫描后回调（进度上报，不控制流程） */
  onChunk?: (info: ScanChunkInfo) => void;
  /** 每块开扫前检查（取消/新请求即时生效）；返回 false 即中止 */
  shouldContinue?: () => boolean;
}

export interface ScanAllResult {
  /** 命中绝对 offset 全量列表（升序） */
  offsets: number[];
  /** 累计命中达 maxHits 提前终止 */
  truncated: boolean;
  /** onChunk 返回 false 中止（取消） */
  aborted: boolean;
  scanned: number;
  total: number;
}

/**
 * 全量分块扫描：块间让出消息循环（setTimeout 0），取消/新搜索经 shouldContinue
 * 在下一块开扫前生效。块窗口向前块回借 needle.length - 1 字节（overlap），跨块
 * 命中由后块恰报一次。
 */
export async function scanAll(
  buffer: Uint8Array,
  needle: Uint8Array,
  opts: ScanAllOptions = {}
): Promise<ScanAllResult> {
  const total = buffer.length;
  const offsets: number[] = [];
  if (needle.length === 0 || total === 0) {
    return { offsets, truncated: false, aborted: false, scanned: 0, total };
  }
  const pin = opts.fold ? foldBytes(needle) : needle;
  // 块不小于 needle：保证 overlap（needle.length-1）不越出前块新区域，去重语义成立
  const chunkSize = Math.max(1, opts.chunkSize ?? SEARCH_CHUNK_BYTES, pin.length);
  const maxHits = Math.max(1, opts.maxHits ?? SEARCH_MAX_HITS);
  const overlap = pin.length - 1;
  let scanned = 0;
  for (let regionStart = 0; regionStart < total; regionStart += chunkSize) {
    // 让出消息循环：取消请求/新搜索得以插入，下一块开扫前即见
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    if (opts.shouldContinue?.() === false) {
      return { offsets, truncated: false, aborted: true, scanned, total };
    }
    const winStart = regionStart === 0 ? 0 : Math.max(0, regionStart - overlap);
    const winEnd = Math.min(total, regionStart + chunkSize);
    let win = buffer.subarray(winStart, winEnd);
    if (opts.fold) win = foldBytes(win);
    // 块内即时判停：传剩余配额（总量 - 已收），单块命中风暴恰好封顶 maxHits
    const chunkHits = scanChunk(win, pin, winStart, regionStart - winStart, maxHits - offsets.length);
    for (const h of chunkHits) offsets.push(h);
    scanned = winEnd;
    opts.onChunk?.({
      scanned,
      total,
      hits: chunkHits.length,
      offsets: chunkHits.slice()
    });
    if (offsets.length >= maxHits) {
      return { offsets, truncated: true, aborted: false, scanned, total };
    }
  }
  return { offsets, truncated: false, aborted: false, scanned, total };
}
