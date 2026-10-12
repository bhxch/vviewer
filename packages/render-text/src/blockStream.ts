// blockStream.ts — 公共块流读取器（io-streaming 计划 2 Task 1）。StreamCtx→块序列
// 的统一抽象，供 jsonl（Task 3）与后续 code 渲染器（计划 3）复用：只管块序列按序
// 读取/atEnd 探测/200-回退全量切换，不管 LRU 渲染缓存（hex 的 hexSource 职责不同：
// 窗口缓存 + 超长抛错由调用方切全量，见 render-binary/hexSource.ts）。
// 语义：
// ① ctx.size 已知：块数 = ceil(size/blockSize)，末块请求端点钳到 size-1 精确短读；
// ② size 未知：逐块满请求（不预钳），返回短于 blockSize 即确认 EOF（atEnd）；
// ③ 任一 read 返回超出请求长度 = 服务器忽略 Range 回 200 全量（计划 1 终审 F3）：
//    抛弃流式缓冲、向 ctx 重取全量 read({ start: 0, end: Number.MAX_SAFE_INTEGER })
//   （端点钳制语义，P1 已验证），degradedToFull 置位——此后一切块为全量切片、
//    atEnd 恒真。不再契约信任服务器尊重 Range；
// ④ ctx.read 失败原样上抛（读失败面交调用方按 DispatchReadError 口径处理）。
// head 预置：ctx.head 按 blockSize 切分预置前若干块（探测 head 通常整覆盖块 0，
// 首屏直取零 IO）；head 不足整块时该块保留部分字节，首次 ensureBlock 重拉整块
// 替换（T3 主路径：8KB head / 64KB 块 → 块 0 部分）。head 短于 blockSize 不构成
// EOF 证据（探测帽长度与真实 EOF 不可区分），atEnd 只由显式读探测产生。
// ensureBlock 越界部分按序推进（不跳读）：size 未知时块边界靠逐块短读发现，跳读
// 会在 EOF 附近读到错位/空区间；size 已知时同口径，保持单一推进语义。
import type { StreamCtx } from '@vviewer/core';

export interface BlockStream {
  readonly blockSize: number;
  /** 已确认的文件字节数（size 已知时= size；未知时随短读探测推进） */
  readonly confirmedBytes: number;
  /** 200-回退已触发：ctx 交付过全量（此时 readBlock 为全量切片） */
  readonly degradedToFull: boolean;
  /** 第 i 块字节（末块短读）；i 必须已 ensure */
  block(i: number): Uint8Array<ArrayBuffer>;
  /** 确保第 i 块就绪；返回该块字节。i > 当前已确认块数时仅按序推进（不跳读） */
  ensureBlock(i: number): Promise<Uint8Array<ArrayBuffer>>;
  /** 已确认末块（短读或 size 精确到达） */
  atEnd(): boolean;
}

export function createBlockStream(ctx: StreamCtx, blockSize: number): BlockStream {
  if (!Number.isInteger(blockSize) || blockSize <= 0) {
    throw new Error(`blockStream：blockSize 须为正整数，收到 ${blockSize}`);
  }
  const sizeKnown = ctx.size !== null;
  // 已知 size 的块总数（空文件为 0）；未知 size 以 Infinity 占位（边界靠短读发现）
  const blockCount = sizeKnown ? Math.ceil(ctx.size / blockSize) : Number.POSITIVE_INFINITY;

  // 块表：head 按 blockSize 切分预置（末块可短——head 未必落在块边界）
  const blocks = new Map<number, Uint8Array<ArrayBuffer>>();
  for (let i = 0; i * blockSize < ctx.head.length; i++) {
    blocks.set(i, ctx.head.subarray(i * blockSize, (i + 1) * blockSize));
  }
  // 下一个待拉块下标：首个非整块的预置块（重拉替换），否则已预置块数。
  // 不变量：0..nextBlock-1 均为终态整块（或已知末块的精确短块），不再重拉。
  let nextBlock = 0;
  while (nextBlock < blocks.size && blocks.get(nextBlock)!.length === blockSize) nextBlock++;

  let confirmed = sizeKnown ? ctx.size : ctx.head.length; // 已确认字节数
  let shortSeen = false; // size 未知：短读已确认 EOF
  let fullData: Uint8Array<ArrayBuffer> | null = null; // 200-回退全量底座（非 null 即 degraded）

  /** 同步取块：degraded 时为全量切片（越界抛错），否则查块表（未就绪抛错） */
  const block = (i: number): Uint8Array<ArrayBuffer> => {
    const full = fullData;
    if (full !== null) {
      if (i < 0 || i * blockSize >= full.length) {
        throw new Error(`blockStream：块 ${i} 超出全量底座（${full.length} 字节）`);
      }
      return full.subarray(i * blockSize, (i + 1) * blockSize);
    }
    const b = blocks.get(i);
    if (b === undefined) throw new Error(`blockStream：块 ${i} 未就绪（block(i) 前须先 ensureBlock(i)）`);
    return b;
  };

  /** 拉取块 i（替换任何预置部分块）；处理超长 200-回退/短读 EOF/满块三态 */
  const fetchBlock = async (i: number): Promise<void> => {
    const cap = sizeKnown ? Math.min(blockSize, ctx.size - i * blockSize) : blockSize;
    const chunk = await ctx.read({ start: i * blockSize, end: i * blockSize + cap - 1 });
    if (chunk.length > cap) {
      // 超长返回 = Range-less 200 全量（终审 F3）：抛弃流式缓冲，重取全量
      //（端点钳制语义）——subarray 钳制会把文件头错位当本块，宁切全量不错位上屏
      const full = await ctx.read({ start: 0, end: Number.MAX_SAFE_INTEGER });
      blocks.clear();
      fullData = full;
      confirmed = full.length;
      return;
    }
    blocks.set(i, chunk);
    if (sizeKnown) {
      if (chunk.length < cap) {
        // size 已知来源按 ByteRange 契约精确返回（EOF 已由端点钳制表达）：
        // 短读 = 读闭包违约（文件可能在读取中途收缩），宁败勿静默截断（hexSource 同口径）
        throw new Error(`blockStream：块 ${i} 读取返回 ${chunk.length} 字节，不足 ${cap}（size 已知来源的短读违约）`);
      }
    } else {
      confirmed = i * blockSize + chunk.length;
      if (chunk.length < blockSize) shortSeen = true; // 短读确认 EOF
    }
  };

  const ensureBlock = async (i: number): Promise<Uint8Array<ArrayBuffer>> => {
    if (!Number.isInteger(i) || i < 0) {
      throw new Error(`blockStream：块下标须为非负整数，收到 ${i}`);
    }
    if (fullData !== null) return block(i); // 全量底座：一切块已就绪，零 IO
    if (i >= blockCount) {
      throw new Error(`blockStream：块 ${i} 超出末块（size ${ctx.size} 共 ${blockCount} 块）`);
    }
    if (shortSeen && i >= nextBlock) {
      // EOF 已在既往探测中确认：nextBlock 之前的块仍在，之后不存在
      throw new Error(`blockStream：文件已在块 ${nextBlock - 1} 结束（短读确认），块 ${i} 不存在`);
    }
    // 按序推进（不跳读）：逐块 await——后一块的合法性依赖前一块未短读
    while (nextBlock <= i) {
      const idx = nextBlock++;
      await fetchBlock(idx);
      if (fullData !== null) return block(i); // 途中 200-回退：直接切全量切片
      if (shortSeen && idx < i) {
        throw new Error(`blockStream：文件已在块 ${idx} 结束（短读确认），块 ${i} 不存在`);
      }
    }
    return block(i);
  };

  return {
    blockSize,
    get confirmedBytes() {
      return confirmed;
    },
    get degradedToFull() {
      return fullData !== null;
    },
    block,
    ensureBlock,
    atEnd() {
      if (fullData !== null) return true; // 全量即末块已知
      if (shortSeen) return true; // 短读确认 EOF
      // size 已知：末块就绪 = size 精确到达（空文件 0 块，构造即 atEnd）
      return sizeKnown ? blockCount === 0 || blocks.has(blockCount - 1) : false;
    }
  };
}
