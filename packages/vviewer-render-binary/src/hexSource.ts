// hexSource.ts — hex 窗口渲染的块缓存取数访问器（io-streaming Task 5，spec §4.1）。
// 纯逻辑模块（jsdom 单测直测，无 DOM 依赖）：size 已知来源按 64KB 块经 ctx.read
// 按需拉取，head（探测块）预置为初始块——首屏字节通常直取零 IO；LRU 上限 8 块
// 约束内存（512KB 封顶）。slice 同步返回（未就绪 null，调用方走「占位 + ensure +
// 重渲」路径）；ensure 合并同块并发请求，块读取返回不足按协议违约抛错（宁败勿
// 静默截断）。size 未知的来源不进本模块（hexRenderer 先做全量回退读，见 hex.ts）。
import type { ByteRange } from '@bhxch/vviewer-core';

/** 块大小：64KB（对齐拉取粒度；结构树尾窗 ≤64KB+22 至多跨 2 块） */
export const HEX_SOURCE_BLOCK_BYTES = 64 * 1024;
/** LRU 上限：8 块（滚回已看区间多数仍命中，超限按最旧逐出重拉） */
const LRU_MAX_BLOCKS = 8;

/**
 * Range-less 服务器专属错误（终审 F3）：块读取返回字节超出请求区间长度 =
 * 服务器忽略 Range 回 200 全量。携带全量响应字节——调用方（hex.ts）捕获后以
 * replaceWithFull 切换全量模式，而非把文件头 clamp 进错位块静默上屏。
 */
export class HexSourceRangeError extends Error {
  /** Range-less 响应的完整文件字节（任意区间请求的 200 响应体均为整文件） */
  readonly full: Uint8Array<ArrayBuffer>;
  constructor(full: Uint8Array<ArrayBuffer>, requested: number) {
    super(`hexSource：块读取返回 ${full.length} 字节，超出请求区间长度 ${requested}（服务器疑似忽略 Range）`);
    this.name = 'HexSourceRangeError';
    this.full = full;
  }
}

export interface HexSource {
  /** 文件总字节数（构造入参原样透出；status 行/rowCount 的事实来源） */
  readonly size: number;
  /**
   * 同步取 [start, end) 字节（end 不含，JS 惯例；调用方为行窗口换算）。命中返回
   * 字节（单块内为零拷贝视图，跨块为新拼装数组）；任一覆盖块未就绪返回 null
   * （不触发 IO——拉取一律显式走 ensure）。越界 clamp 到 [0, size]。
   */
  slice(start: number, end: number): Uint8Array | null;
  /**
   * 确保覆盖 [start, end) 的块全部就绪：缺哪些块拉哪些（一次多块并发），同块
   * 并发请求合并为单次 read；已就绪块仅做 LRU 触新。全部到位后 resolve；任一
   * 块读取失败则 reject（inflight 已清理，可重试）。
   */
  ensure(start: number, end: number): Promise<void>;
  /**
   * 切换全量模式（终审 F3）：以 Range-less 全量响应重建块底座——按 64KB 切分、
   * 全部块就绪，此后 slice 恒命中、ensure 零 IO。在途拉取一并作废（其超长响应
   * 已由 HexSourceRangeError 携出，残留 promise 对新请求不可见）。
   */
  replaceWithFull(full: Uint8Array): void;
  /**
   * Range-less 降级后持有的全量字节（M-2）：replaceWithFull 已发生则返回该全量，
   * 未降级返回 null。hex 无 Worker 搜索兜底据此复用已在 src 手里的全量，不再对
   * 同一件多付一次全量读（构造期 head 即全量的形态由调用方 buffer.length 判定，
   * 与本方法互补）。
   */
  degradedFull(): Uint8Array | null;
}

/**
 * 创建块缓存访问器。head 预置为初始块（探测块 8KB → block 0 部分就绪；≤1MB
 * 全量策略/非 rangeCapable 来源的 head 为全量 → 全部块就绪、read 永不触发）。
 * read 为 StreamCtx.read（ByteRange end 含），本模块按块端点换算区间。
 */
export function createHexSource(
  size: number,
  head: Uint8Array,
  read: (r: ByteRange) => Promise<Uint8Array<ArrayBuffer>>
): HexSource {
  // 块表：Map 插入序即 LRU 新近序（命中 touch = 删除重插；超限逐出首项）
  const blocks = new Map<number, Uint8Array>();
  // 块下标 → 在途拉取 promise（并发去重；失败在 finally 清理，可重试）
  const inflight = new Map<number, Promise<void>>();
  // head 按 64KB 切分预置（短 head → block 0 部分就绪；全量 head → 覆盖至文件头若干块）。
  // ≤1MB 全 head 策略下预置可达 16 项（1MB / 64KB），字面超出 LRU_MAX_BLOCKS 8 块口径——
  // 内存仍被 FULL_LIMIT（1MB）有界且 read 永不触发（一切块已就绪），首次拉取触发 evict
  // 即恢复上界，属设计内例外（终审 M1）
  for (let i = 0; i * HEX_SOURCE_BLOCK_BYTES < head.length; i++) {
    blocks.set(i, head.subarray(i * HEX_SOURCE_BLOCK_BYTES, (i + 1) * HEX_SOURCE_BLOCK_BYTES));
  }

  /** 块标称长度：满块 64KB，EOF 块为文件尾余量 */
  const blockCap = (index: number): number =>
    Math.min(HEX_SOURCE_BLOCK_BYTES, size - index * HEX_SOURCE_BLOCK_BYTES);

  /** LRU 触新：删除重插挪到表尾 */
  const touch = (index: number): void => {
    const b = blocks.get(index);
    if (b === undefined) return;
    blocks.delete(index);
    blocks.set(index, b);
  };

  /** 超限逐出最旧（首项）——在途块不在 blocks 表内，不受影响 */
  const evict = (): void => {
    while (blocks.size > LRU_MAX_BLOCKS) {
      const oldest = blocks.keys().next();
      if (oldest.done === true) break;
      blocks.delete(oldest.value);
    }
  };

  /** 覆盖 [start, end) 的块下标闭区间 */
  const blockRange = (start: number, end: number): { first: number; last: number } => ({
    first: Math.floor(start / HEX_SOURCE_BLOCK_BYTES),
    last: Math.floor((end - 1) / HEX_SOURCE_BLOCK_BYTES)
  });

  /** 拉取单块（读整块标称区间，端点换算为 ByteRange end 含），入表并逐出超限 */
  const loadBlock = (index: number): Promise<void> => {
    const existing = inflight.get(index);
    if (existing !== undefined) return existing; // 同块并发合并
    const cap = blockCap(index);
    const run = async (): Promise<void> => {
      const chunk = await read({ start: index * HEX_SOURCE_BLOCK_BYTES, end: index * HEX_SOURCE_BLOCK_BYTES + cap - 1 });
      if (chunk.length < cap) {
        // 短读 = 读闭包违约（正常来源按 ByteRange 精确返回，EOF 已由端点钳制）：
        // 宁可失败重试也不静默截断（截断渲染正是本任务要消除的活面）
        throw new Error(`hexSource：块 ${index} 读取返回 ${chunk.length} 字节，不足 ${cap}`);
      }
      if (chunk.length > cap) {
        // 超返回（终审 F3）= 服务器忽略 Range 回 200 全量：subarray clamp 会把
        // 文件头当本块缓存（错位数据静默上屏）——抛专属错误携全量 bytes，调用方
        //（hex.ts）捕获后切换全量模式
        throw new HexSourceRangeError(chunk, cap);
      }
      blocks.set(index, chunk);
      evict();
    };
    const p = run().finally(() => {
      if (inflight.get(index) === p) inflight.delete(index);
    });
    inflight.set(index, p);
    return p;
  };

  const clamp = (start: number, end: number): { start: number; end: number } => ({
    start: Math.max(0, start),
    end: Math.min(size, end)
  });

  /** 全量底座重建（终审 F3）：清作废在途与旧块表，按 64KB 切分全量、全部就绪。
   * 原始全量另存一份引用（M-2：degradedFull 供无 Worker 搜索兜底零读复用——块表
   * 仅存 subarray 视图且受 LRU 逐出，不可替代） */
  let degraded: Uint8Array | null = null;
  const replaceWithFull = (full: Uint8Array): void => {
    degraded = full;
    inflight.clear();
    blocks.clear();
    for (let i = 0; i * HEX_SOURCE_BLOCK_BYTES < full.length; i++) {
      blocks.set(i, full.subarray(i * HEX_SOURCE_BLOCK_BYTES, (i + 1) * HEX_SOURCE_BLOCK_BYTES));
    }
  };

  return {
    size,
    replaceWithFull,
    degradedFull: () => degraded,
    slice(start, end) {
      const c = clamp(start, end);
      if (c.start >= c.end) return new Uint8Array(0);
      const { first, last } = blockRange(c.start, c.end);
      for (let i = first; i <= last; i++) {
        const b = blocks.get(i);
        if (b === undefined) return null;
        const needEnd = Math.min(c.end, (i + 1) * HEX_SOURCE_BLOCK_BYTES) - i * HEX_SOURCE_BLOCK_BYTES;
        if (b.length < needEnd) return null; // 预置部分块（如 8KB head）未拉满
      }
      const only = first === last;
      if (only) {
        const b = blocks.get(first)!;
        const off = c.start - first * HEX_SOURCE_BLOCK_BYTES;
        touch(first);
        return b.subarray(off, off + (c.end - c.start));
      }
      const out = new Uint8Array(c.end - c.start);
      let filled = 0;
      for (let i = first; i <= last; i++) {
        const b = blocks.get(i)!;
        const from = Math.max(c.start, i * HEX_SOURCE_BLOCK_BYTES) - i * HEX_SOURCE_BLOCK_BYTES;
        const to = Math.min(c.end, (i + 1) * HEX_SOURCE_BLOCK_BYTES) - i * HEX_SOURCE_BLOCK_BYTES;
        out.set(b.subarray(from, to), filled);
        filled += to - from;
        touch(i);
      }
      return out;
    },
    async ensure(start, end) {
      const c = clamp(start, end);
      if (c.start >= c.end) return;
      const { first, last } = blockRange(c.start, c.end);
      const jobs: Promise<void>[] = [];
      for (let i = first; i <= last; i++) {
        const b = blocks.get(i);
        if (b !== undefined && b.length >= blockCap(i)) {
          touch(i); // 已就绪（含全量 head 预置的块）：仅触新
          continue;
        }
        jobs.push(loadBlock(i));
      }
      await Promise.all(jobs);
    }
  };
}
