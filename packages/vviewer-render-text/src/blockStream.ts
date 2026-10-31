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
// 不回退），atEnd 由 nextBlock 推导、head 预置末块（可短）同作 EOF 证据（fix
// round 1 F1 disjunct）、shortSeen 一经置位锁存——逐出与重拉均不翻转 EOF 事实。
import type { StreamCtx } from '@bhxch/vviewer-core';

/**
 * 流式尺寸防线（spec §4.3 防线换代）：流式渲染器索引/块表常驻内存的统一上限口径，
 * jsonl 与 code（计划 3 Task 4）共享。超限方停止续读并以非失败态提示「建议以 hex
 * 打开」——取代全量渲染时代的 PLAIN_MAX_BYTES「全量解码失控」前提。
 */
export const STREAM_MAX_BYTES = 512 * 1024 * 1024;

/**
 * 守卫补拉记忆（遗留清偿项 6，retry 免重拉）：非 UTF-8 回退/全量守卫的
 * {0, MAX} 全量补拉以模块级 WeakMap 按 ctx 记忆——错误卡片 retry 重入 render
 * （同一 ctx）不再重复全量下载；ctx 无引用后条目随 GC 回收，无手动清理面。
 * 成功即记忆（字节终态）；失败即刻出表（防毒化：retry 需可重新发起）。
 */
const fullReadMemo = new WeakMap<StreamCtx, Promise<Uint8Array<ArrayBuffer>>>();

export function memoizedFullRead(ctx: StreamCtx): Promise<Uint8Array<ArrayBuffer>> {
  const memo = fullReadMemo.get(ctx);
  if (memo !== undefined) return memo;
  const p = ctx.read({ start: 0, end: Number.MAX_SAFE_INTEGER });
  fullReadMemo.set(ctx, p);
  p.catch(() => {
    fullReadMemo.delete(ctx); // 失败不记忆：下次 render 重入可重试
  });
  return p;
}

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
  /**
   * 并行预取（遗留清偿 A1）：确保块 [0..lastBlock] 全部就绪——对 [nextBlock..lastBlock]
   * 中未驻留整块的块并发发起 fetch，全部 settle 后按升序提交推进（取块并行化、提交
   * 升序，0..nextBlock-1 恒终态块不变量不破；块字节的同步消费在就绪后才发生，并行
   * 落表先后无关紧要）。失败语义：等全部 settle 后按块序最靠前的失败上抛，nextBlock
   * 停在该块（已成功块字节已在块表，重试经驻留跳过不重拉）。size 未知退化为逐块
   * 顺序 ensureBlock 等价（短读 EOF 依赖顺序发现，不并行）。lastBlock 越过实际末块
   * 钳到末块/EOF——预取是「尽力确保」提示面，首屏「前 2 块」在不足两块的文件上不是
   * 错误；非法下标仍按 ensureBlock 口径抛错。并发去重经既有 in-flight 表（预取发起
   * 时 set，与 ensureBlock 共享同一 fetch）。
   */
  prefetchThrough(lastBlock: number): Promise<void>;
  /** 已确认末块（短读或 size 精确到达） */
  atEnd(): boolean;
}

/** maxBlocks LRU 选项：块表驻留上界（块数）。缺省 = 无界（调用方自管时兼容现状）。 */
export interface BlockStreamOptions {
  maxBlocks?: number;
  /** 构造期传入的取消信号：透传给每次 ctx.read——宿主实例 destroy 时 abort 在飞读 */
  signal?: AbortSignal;
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
  // 流式硬化 Task 2：构造期取消信号——透传给每次 ctx.read（fetchBlock 与 200-回退
  // 全量重取），abort reject 走 ctx.read 契约（AbortError）经既有失败清理路径原样上抛
  const externalSignal = opts?.signal;
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
  // 200-回退全量重取的在途去重（A1 并行预取）：同批多块同时收到超长 200 时共享
  // 单次全量 read（重复全量下载对字节事实无害但成倍浪费 IO）；失败即刻出表可重试
  let fullReload: Promise<Uint8Array<ArrayBuffer>> | null = null;

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
    const chunk = await ctx.read({ start: i * blockSize, end: i * blockSize + cap - 1 }, externalSignal);
    if (chunk.length > cap) {
      // 超长返回 = Range-less 200 全量（终审 F3）：抛弃流式缓冲，重取全量
      //（端点钳制语义）——subarray 钳制会把文件头错位当本块，宁切全量不错位上屏。
      // 重取在途去重（A1）：并行预取同批多块同时触发时共享单次全量 read
      fullReload ??= ctx
        .read({ start: 0, end: Number.MAX_SAFE_INTEGER }, externalSignal)
        .catch((err: unknown) => {
          fullReload = null; // 失败出表：重试可重新发起（memoizedFullRead 同纪律）
          throw err;
        });
      const full = await fullReload;
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

  /**
   * 并行预取（遗留清偿 A1，语义见接口注）：确保块 [0..lastBlock] 全部就绪。
   * size 未知：逐块顺序 ensureBlock 等价（直接循环 await，不并行——短读 EOF 发现
   * 依赖顺序，跳读会在 EOF 附近读到错位/空区间）；短读确认后剩余块不存在即已就绪
   *（EOF 容忍——预取是「尽力确保」提示面，与 size 已知的末块钳取同口径，不上抛）。
   * size 已知：越界钳到实际末块；对 [nextBlock..lastBlock] 中未驻留整块的块并发
   * 发起 fetchBlock（发起序=块序；fetchBlock 首个 await 前同步调用 ctx.read，夹持
   * 断言可在任一放行前观测到全部请求已发出），失败吸收进 failures 不短路（其余
   * 在途块照常落表），全部 settle 后升序提交推进。
   * 推进与 fetch 成功绑定的不变量在此以「升序 commit」维持（而非 ensureOne 的
   * 逐块成功即推进）：nextBlock 逐块推进到 last+1，遇块序最靠前的失败停在该块并
   * 上抛——已成功块的字节已在块表（并行落表的「先落表后推进」中间态无害：同步
   * 取数面在提交完成后才被消费），重试经驻留跳过不重拉。
   * 并发去重经既有 in-flight 表：预取发起时 set 原始 promise（重叠 ensureBlock 收到
   * 同一真实 resolve/reject），重叠方已发起的块复用不重复 IO。
   */
  const prefetchThrough = async (lastBlock: number): Promise<void> => {
    if (!Number.isInteger(lastBlock) || lastBlock < 0) {
      throw new Error(`blockStream：块下标须为非负整数，收到 ${lastBlock}`);
    }
    if (fullData !== null) return; // 全量底座：一切块已就绪，零 IO
    if (!sizeKnown) {
      while (nextBlock <= lastBlock && !shortSeen) {
        await ensureBlock(nextBlock);
        if (fullData !== null) return; // 途中 200-回退：全量底座就绪
      }
      return;
    }
    const last = Math.min(lastBlock, blockCount - 1); // 越界钳到实际末块（空文件 last=-1 即空转）
    const start = nextBlock;
    const failures = new Map<number, unknown>(); // 块号 → 失败原因（升序提交裁决用）
    const targets: number[] = [];
    for (let i = start; i <= last; i++) {
      const b = blocks.get(i);
      if (b !== undefined && b.length === blockSize) continue; // 已驻留整块：跳过（重试不重拉）
      targets.push(i);
    }
    if (targets.length > 0) {
      const jobs: Array<Promise<void>> = [];
      for (const i of targets) {
        const existing = inflight.get(i);
        if (existing !== undefined) {
          // 既有在途（重叠 ensureBlock 已发起）：复用共享单次 fetch；推进由 ensureOne
          // 自带，失败同样记入参与升序裁决
          jobs.push(
            existing.then(
              () => {},
              (err: unknown) => {
                failures.set(i, err);
              }
            )
          );
          continue;
        }
        const raw = fetchBlock(i);
        inflight.set(i, raw); // 共享表存原始 promise：重叠 ensureBlock 收到同一真实拒绝
        jobs.push(
          raw.then(
            () => {
              inflight.delete(i);
            },
            (err: unknown) => {
              inflight.delete(i);
              failures.set(i, err);
            }
          )
        );
      }
      await Promise.all(jobs); // 等全部 settle（拒绝已吸收，不短路其余在途块）
    }
    if (fullData !== null) return; // 并行途中 200-回退：全量底座就绪，无推进面
    // 升序提交推进：nextBlock 逐块推进到 last+1，遇块序最靠前的失败停在该块并上抛
    for (let i = start; i <= last; i++) {
      const err = failures.get(i);
      if (err !== undefined) throw err;
      nextBlock = Math.max(nextBlock, i + 1);
    }
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
    prefetchThrough,
    atEnd() {
      if (fullData !== null) return true; // 全量即末块已知
      if (shortSeen) return true; // 短读确认 EOF
      // size 已知：末块就绪 = nextBlock 精确到达（空文件 0 块，构造即 atEnd），
      // 或末块已由 head 预置——head 触达文件尾即 EOF 证据（!rangeCapable 全量
      // 视图 / capable≤1MB 直读形态，末块可短：head 未必落在块边界，fix round 1
      // F1 disjunct）。优先 nextBlock 推进事实：LRU 逐出末块不翻转 EOF（atEnd 单调）
      return sizeKnown
        ? blockCount === 0 || nextBlock >= blockCount || blocks.has(blockCount - 1)
        : false;
    }
  };
}

// ---------------------------------------------------------------------------
// 项 1（遗留清偿波 3）：流式逐块 UTF-8 嗅探（head 误判 utf-8 的收口）
// ---------------------------------------------------------------------------
// 窗口模式仅以探测头判编码：head 干净、尾部 GB18030 等非 UTF-8 时流式解码产出
// U+FFFD/mojibake。嗅探在喂块面（jsonl/code 的 pullBlock，每块一次性判定）对原始
// 字节做严格 UTF-8 合法性计数，单块超阈判非 UTF-8 → 切全量重渲（「判出的非 UTF-8」
// 入口回退同路径）。公共判定面放本模块（块字节层，jsonl/code 共享）；降级出口在
// 各渲染器（source/det 与全量重渲入口都在渲染器层）。判据同 packages/vviewer-core detect
// 的 isStrictUtf8（RFC 3629，overlong/代理对拒绝）——布尔版首败即 false 无法计数，
// 流式嗅探需「处数」与阈值比较，故此处实现同判据的计数变体（注释互引，判据同源）。

/** 单块非法序列计数的判定阈值（处）：≥ 此值判非 UTF-8（合法 UTF-8 零非法，阈值
 * 只为容忍假阳性边缘——截断安全前缀已剔除块切口悬挂序列，其余非法必真） */
export const UTF8_SNIFF_ILLEGAL_MIN = 8;

/** 严格 UTF-8 合法性计数（isStrictUtf8 同判据的计数变体）：返回 [0, len) 内非法
 * 序列处数。失配后按字节推进重同步——只影响脏块的计数偏多（判非方向），合法块
 * 恒零不计，无假阳性面 */
function countIllegalUtf8(b: Uint8Array, len: number): number {
  let i = 0;
  let bad = 0;
  while (i < len) {
    const c = b[i]!;
    if (c < 0x80) {
      i += 1;
      continue;
    }
    let seqLen: number;
    let min: number;
    let cp: number;
    if ((c & 0xe0) === 0xc0) {
      seqLen = 2;
      min = 0x80;
      cp = c & 0x1f;
    } else if ((c & 0xf0) === 0xe0) {
      seqLen = 3;
      min = 0x800;
      cp = c & 0x0f;
    } else if ((c & 0xf8) === 0xf0) {
      seqLen = 4;
      min = 0x10000;
      cp = c & 0x07;
    } else {
      bad += 1; // 非法 lead（含孤立延续字节）
      i += 1;
      continue;
    }
    if (i + seqLen > len) {
      bad += 1; // 防御（len 已截断安全，正常不可达）
      i += 1;
      continue;
    }
    let ok = true;
    for (let k = 1; k < seqLen; k++) {
      const cc = b[i + k]!;
      if ((cc & 0xc0) !== 0x80) {
        ok = false;
        break;
      }
      cp = (cp << 6) | (cc & 0x3f);
    }
    if (!ok || cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
      bad += 1; // 延续字节失配 / overlong / 越界 / 代理区：isStrictUtf8 同判据
      i += 1;
      continue;
    }
    i += seqLen;
  }
  return bad;
}

/** 截断安全前缀长：块切口可能切开多字节字符（悬挂 lead/延续字节跨块），剔除块尾
 * 悬挂序列防合法块误判——悬挂的合法 lead 由下一块（含其延续字节）续判；悬挂的
 * 非法 lead（不可能构成任何合法序列的字节）保留在判定面照常计数 */
function sniffSafeLen(b: Uint8Array): number {
  const n = b.length;
  let end = n;
  while (end > 0 && (b[end - 1]! & 0xc0) === 0x80) end--; // 回退尾部延续字节
  if (end === 0) return 0; // 整块皆延续字节：无可判定前缀（理论形态，防御）
  const lead = b[end - 1]!;
  if ((lead & 0x80) === 0) return n; // ASCII 收尾：整块可判
  let seqLen: number;
  if ((lead & 0xe0) === 0xc0) seqLen = 2;
  else if ((lead & 0xf0) === 0xe0) seqLen = 3;
  else if ((lead & 0xf8) === 0xf0) seqLen = 4;
  else return n; // 非法 lead：本身可判（计数面计入非法）
  return end - 1 + seqLen <= n ? n : end - 1; // 序列完整整块可判；悬挂剔除
}

/**
 * 单块流内嗅探（纯函数，jsonl/code 窗口模式喂块面共享）：截断安全前缀内非法序列
 * ≥8 处或 ≥ 块字节 1% → 判非 UTF-8。零非法 = 合法块（每块一次性判定，不重复嗅探）。
 */
export function isSuspiciousUtf8Block(bytes: Uint8Array): boolean {
  const len = sniffSafeLen(bytes);
  if (len === 0) return false;
  const bad = countIllegalUtf8(bytes, len);
  return bad >= UTF8_SNIFF_ILLEGAL_MIN || bad * 100 >= len;
}
