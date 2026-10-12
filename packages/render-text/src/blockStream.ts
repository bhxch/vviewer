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
// 原子推进与并发（fix round 1/2）：nextBlock 仅在 fetch 成功后推进（含短读末块，
// 0..nextBlock-1 恒为终态块——短读后合法末块可达、越界报错块号恒为实际末块）；
// 同块并发 ensureBlock 经 in-flight 表合并为单次 fetch（hexSource 并发去重先例），
// 各调用方共享同一 resolve/reject（非伪拒绝）。
// 块表 LRU 有界化（计划 3 Task 1，计划 2 终审 B1）：可选 maxBlocks 约束块表驻留
// 上界——head 预置块同样计入，命中触新（删除重插）、超限逐出表首（最旧），与
// hexSource 同语义；被逐出块再访问 = block 同步抛未就绪 / ensureBlock 重拉（已被
// 确认的块内容视为终态，重拉同字节）。nextBlock 与 confirmedBytes 均单调（重拉
// 不回退），atEnd 由 nextBlock 推导（逐出不影响 EOF 判定）、shortSeen 一经置位锁存。
import type { StreamCtx } from '@vviewer/core';

/**
 * 流式尺寸防线（spec §4.3 防线换代）：流式渲染器索引/块表常驻内存的统一上限口径，
 * jsonl 与 code（计划 3 Task 4）共享。超限方停止续读并以非失败态提示「建议以 hex
 * 打开」——取代全量渲染时代的 PLAIN_MAX_BYTES「全量解码失控」前提。
 */
export const STREAM_MAX_BYTES = 512 * 1024 * 1024;

export interface BlockStream {
  readonly blockSize: number;
  /** 已确认的文件字节数（size 已知时= size；未知时随短读探测推进，单调不减） */
  readonly confirmedBytes: number;
  /** 200-回退已触发：ctx 交付过全量（此时 readBlock 为全量切片） */
  readonly degradedToFull: boolean;
  /** 第 i 块字节（末块短读）；i 必须已 ensure */
  block(i: number): Uint8Array<ArrayBuffer>;
  /** 块 i 是否驻留块表（degraded 全量底座按文件范围判定）。渲染侧「可见行 ⊆ 驻留
   * 块」把关用：缺块行走占位 + ensureBlock 重拉（maxBlocks LRU 逐出后的补块面）。 */
  has(i: number): boolean;
  /** 确保第 i 块就绪；返回该块字节。i > 当前已确认块数时仅按序推进（不跳读）；
   * 已确认但被 LRU 逐出的块按 hexSource 同语义重拉（零跳读、坐标不变） */
  ensureBlock(i: number): Promise<Uint8Array<ArrayBuffer>>;
  /** 已确认末块（短读或 size 精确到达） */
  atEnd(): boolean;
}

/** maxBlocks LRU 选项：块表驻留上界（块数）。缺省 = 无界（调用方自管时兼容现状）。 */
export interface BlockStreamOptions {
  maxBlocks?: number;
}

export function createBlockStream(
  ctx: StreamCtx,
  blockSize: number,
  opts?: BlockStreamOptions
): BlockStream {
  if (!Number.isInteger(blockSize) || blockSize <= 0) {
    throw new Error(`blockStream：blockSize 须为正整数，收到 ${blockSize}`);
  }
  const maxBlocks = opts?.maxBlocks;
  if (maxBlocks !== undefined && (!Number.isInteger(maxBlocks) || maxBlocks < 1)) {
    throw new Error(`blockStream：maxBlocks 须为正整数，收到 ${maxBlocks}`);
  }
  const sizeKnown = ctx.size !== null;
  // 已知 size 的块总数（空文件为 0）；未知 size 以 Infinity 占位（边界靠短读发现）
  const blockCount = sizeKnown ? Math.ceil(ctx.size / blockSize) : Number.POSITIVE_INFINITY;

  // 块表：head 按 blockSize 切分预置（末块可短——head 未必落在块边界）。
  // Map 插入序即 LRU 新近序（hexSource 同款）：命中触新 = 删除重插挪表尾，
  // 超限逐出表首（最旧）。
  const blocks = new Map<number, Uint8Array<ArrayBuffer>>();
  for (let i = 0; i * blockSize < ctx.head.length; i++) {
    blocks.set(i, ctx.head.subarray(i * blockSize, (i + 1) * blockSize));
  }
  // 下一个待拉块下标：首个非整块的预置块（重拉替换），否则已预置块数。
  // 不变量：0..nextBlock-1 均为终态整块（或已知末块的精确短块），不再重拉——
  // （maxBlocks 逐出后语义微调：坐标仍终态，字节缺失经 ensureBlock 重拉补齐）
  let nextBlock = 0;
  while (nextBlock < blocks.size && blocks.get(nextBlock)!.length === blockSize) nextBlock++;

  /** LRU 触新：命中块删除重插挪到表尾（hexSource 同款） */
  const touch = (i: number): void => {
    const b = blocks.get(i);
    if (b === undefined) return;
    blocks.delete(i);
    blocks.set(i, b);
  };

  /** 超限逐出表首（最旧）。恰插入的新块在表尾，maxBlocks ≥ 1 下不会被自逐出 */
  const evictOverflow = (): void => {
    while (blocks.size > (maxBlocks ?? Number.POSITIVE_INFINITY)) {
      const oldest = blocks.keys().next().value;
      if (oldest === undefined) break;
      blocks.delete(oldest);
    }
  };
  evictOverflow(); // head 预置超限（如 !rangeCapable 全量视图预置全部块）同样有界

  let confirmed = sizeKnown ? ctx.size : ctx.head.length; // 已确认字节数
  let shortSeen = false; // size 未知：短读已确认 EOF（一经置位锁存）
  let fullData: Uint8Array<ArrayBuffer> | null = null; // 200-回退全量底座（非 null 即 degraded）

  /** 同步取块：degraded 时为全量切片（越界抛错），否则查块表（未就绪抛错）；命中触新 */
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
    touch(i);
    return b;
  };

  /** 块 i 是否驻留：degraded 按文件范围判定（一切块可零 IO 切片），否则查块表 */
  const has = (i: number): boolean => {
    const full = fullData;
    if (full !== null) return i >= 0 && i * blockSize < full.length;
    return blocks.has(i);
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
    evictOverflow(); // 入表后保持 LRU 上界（恰插入块在表尾，不会被自逐出）
    if (sizeKnown) {
      if (chunk.length < cap) {
        // size 已知来源按 ByteRange 契约精确返回（EOF 已由端点钳制表达）：
        // 短读 = 读闭包违约（文件可能在读取中途收缩），宁败勿静默截断（hexSource 同口径）
        throw new Error(`blockStream：块 ${i} 读取返回 ${chunk.length} 字节，不足 ${cap}（size 已知来源的短读违约）`);
      }
    } else {
      // 单调确认（LRU 重拉安全）：重拉已确认区间时不得回退 confirmed——末次短读
      // 探测值是 EOF 事实，被更早块的重拉覆盖会让 atEnd/maybeFinish 误判未达
      confirmed = Math.max(confirmed, i * blockSize + chunk.length);
      if (chunk.length < blockSize) shortSeen = true; // 短读确认 EOF
    }
  };

  // 在途拉取表：块号 → fetch promise（fix round 2 并发去重——对齐 hexSource 的
  // 并发合并先例：同块并发 ensureBlock 共享单次 fetch，不重复 IO；败者与胜者
  // await 同一结果，收到同一真实 resolve/reject（非伪拒绝/伪成功））
  const inflight = new Map<number, Promise<void>>();

  /**
   * 确保单块就绪（fetch + 确认推进的原子单元）：成功回调里推进 nextBlock——推进
   * 与 fetch 绑定（并发调用方各自跑主循环时不会重复推进），且成功即推进（含短读
   * 末块），维持「0..nextBlock-1 恒为终态块」不变量——短读确认后合法末块仍可达
   * （零重拉），越界报错块号（nextBlock-1）恒为实际末块。失败清在途表后原样上抛
   * （后续重试重新发起）。LRU 重拉安全：重拉被逐出的已确认块不得回退 nextBlock
   * （否则前向推进错位、后续块重复 IO）。
   */
  const ensureOne = (target: number): Promise<void> => {
    const existing = inflight.get(target);
    if (existing !== undefined) return existing;
    const p = fetchBlock(target).then(
      () => {
        inflight.delete(target);
        nextBlock = Math.max(nextBlock, target + 1);
      },
      (err: unknown) => {
        inflight.delete(target);
        throw err;
      }
    );
    inflight.set(target, p);
    return p;
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
    // 按序推进（不跳读）：逐块 await——后一块的合法性依赖前一块未短读。
    // 原子性（fix round 1）：推进在 ensureOne 内与 fetch 成功绑定——read 失败
    // 上抛时停在原块，重试（调用方再 ensure）拉同一块；旧实现先 ++ 后 await，
    // 失败块永久缺位、后续块字节错位拼进缺失坐标位。
    // 短读检查（fix round 2）：fetch 成功即推进（含短读末块）后再判——刚取回的
    // 短块计入已确认段（0..nextBlock-1 恒终态块），短读后合法末块仍可达（零重拉），
    // 越界报错块号（nextBlock-1）恒为实际末块
    while (nextBlock <= i) {
      await ensureOne(nextBlock);
      if (fullData !== null) return block(i); // 途中 200-回退：直接切全量切片
      if (shortSeen && nextBlock - 1 < i) {
        throw new Error(`blockStream：文件已在块 ${nextBlock - 1} 结束（短读确认），块 ${i} 不存在`);
      }
    }
    if (!blocks.has(i)) {
      // 已确认坐标但被 maxBlocks LRU 逐出：重拉补齐（hexSource 同语义）。ensureOne
      // 复用并发去重；成功后 nextBlock/confirmed 均单调（见上），坐标与字节不变。
      await ensureOne(i);
      if (fullData !== null) return block(i); // 途中 200-回退：直接切全量切片
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
    has,
    ensureBlock,
    atEnd() {
      if (fullData !== null) return true; // 全量即末块已知
      if (shortSeen) return true; // 短读确认 EOF
      // size 已知：末块就绪 = nextBlock 精确到达（空文件 0 块，构造即 atEnd）。
      // 用 nextBlock 而非查块表：末块被 LRU 逐出不翻转 EOF 事实（atEnd 单调）
      return sizeKnown ? blockCount === 0 || nextBlock >= blockCount : false;
    }
  };
}
