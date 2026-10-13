// blockStream.test.ts — Task 1（io-streaming 计划 2）：blockStream 公共块流读取器单测。
// 语义覆盖：head 覆盖首块直取零 IO、size 已知末块精确短读 + atEnd、size 未知短读
// 探测 atEnd、ensureBlock 按序推进不跳读、Range-less 200 超长返回切全量（计划 1
// 终审 F3）、read 失败原样上抛；计划 3 Task 1 追加：maxBlocks LRU 有界化（B1）与
// STREAM_MAX_BYTES 统一裁决常量。纯逻辑模块，fake ctx 记录每次请求区间。
import { describe, expect, it } from 'vitest';
import type { StreamCtx } from '@vviewer/core';
import { STREAM_MAX_BYTES, createBlockStream } from '../src/blockStream';

/** 测试块大小：4 字节（区间小、便于手算端点） */
const B = 4;
/** 26 字节字母序列（'a'=0x61 … 'z'）：任一块内容可逐字节读出校验 */
const ALPHA = Uint8Array.from({ length: 26 }, (_, i) => 0x61 + i);

interface RangeCall {
  start: number;
  end: number;
}

/** fake ctx：content 为底层全量数据；ignoreRange=true 模拟 Range-less 服务器
 * （任何区间请求都回 200 全量）；calls 记录每次请求区间；failWith 挂抛错；
 * failCall 指定第 N 次 read 抛 failWith（一次性失败，后续调用正常——续读重试用）。 */
function fakeCtx(opts: {
  size: number | null;
  content: Uint8Array<ArrayBuffer>;
  head?: Uint8Array<ArrayBuffer>;
  ignoreRange?: boolean;
  calls?: RangeCall[];
  failWith?: unknown;
  failCall?: number;
}): StreamCtx {
  let n = 0;
  return {
    size: opts.size,
    head: opts.head ?? new Uint8Array(0),
    read: async (r) => {
      opts.calls?.push({ start: r.start, end: r.end });
      n += 1;
      if (opts.failCall !== undefined) {
        if (n === opts.failCall) throw opts.failWith; // 仅第 N 次失败（重试可过）
      } else if (opts.failWith !== undefined) {
        throw opts.failWith; // 恒失败（既有用例⑥口径）
      }
      if (opts.ignoreRange) return opts.content.slice();
      return opts.content.slice(r.start, r.end + 1);
    }
  };
}

describe('createBlockStream', () => {
  it('① head 覆盖首块直取不触发 read；未 ensure 的块同步取抛错', () => {
    const calls: RangeCall[] = [];
    // head 8B 覆盖块 0/1（B=4）；size 未知
    const bs = createBlockStream(fakeCtx({ size: null, head: ALPHA.slice(0, 8), content: ALPHA, calls }), B);
    expect(bs.blockSize).toBe(B);
    expect(bs.degradedToFull).toBe(false);
    expect(bs.confirmedBytes).toBe(8); // head 即已确认字节
    expect(bs.block(0)).toEqual(ALPHA.slice(0, 4)); // head 直取
    expect(bs.block(1)).toEqual(ALPHA.slice(4, 8));
    expect(calls).toStrictEqual([]); // 零 IO
    expect(bs.atEnd()).toBe(false); // head 短于 blockSize 不构成 EOF 证据（探测帽歧义），此处 head 恰为整块
    expect(() => bs.block(2)).toThrow(); // 同步契约：未 ensure 的块不存在于块表
  });

  it('② size 已知：末块端点钳制精确短读，末块就绪后 atEnd', async () => {
    const calls: RangeCall[] = [];
    const bs = createBlockStream(fakeCtx({ size: 10, content: ALPHA, calls }), B);
    expect(bs.confirmedBytes).toBe(10); // size 已知即全量确认
    expect(bs.atEnd()).toBe(false); // 末块未取
    const last = await bs.ensureBlock(2); // 3 块：4+4+2
    expect(calls).toStrictEqual([
      { start: 0, end: 3 },
      { start: 4, end: 7 },
      { start: 8, end: 9 } // 末块端点钳到 size-1
    ]);
    expect(last).toEqual(ALPHA.slice(8, 10)); // 末块 2 字节短读
    expect(bs.atEnd()).toBe(true); // size 精确到达
    expect(bs.block(0)).toEqual(ALPHA.slice(0, 4));
  });

  it('③ size 未知：短读探测标记 atEnd 与 confirmedBytes，之后 ensureBlock 越界抛错', async () => {
    const calls: RangeCall[] = [];
    const data = ALPHA.slice(0, 10); // "文件"仅 10 字节
    const bs = createBlockStream(fakeCtx({ size: null, content: data, calls }), B);
    const last = await bs.ensureBlock(2);
    expect(calls).toStrictEqual([
      { start: 0, end: 3 },
      { start: 4, end: 7 },
      { start: 8, end: 11 } // 满请求（不预钳——EOF 靠返回短读发现）
    ]);
    expect(last).toEqual(data.slice(8, 10)); // 短于 blockSize → EOF
    expect(bs.atEnd()).toBe(true);
    expect(bs.confirmedBytes).toBe(10);
    await expect(bs.ensureBlock(3)).rejects.toThrow(/块 3/); // 末块之后无块
  });

  it('④ 逐块顺序推进：ensureBlock(2) 前置拉 0/1；已确认块不再重拉', async () => {
    const calls: RangeCall[] = [];
    const bs = createBlockStream(fakeCtx({ size: 16, content: ALPHA.slice(0, 16), calls }), B);
    await bs.ensureBlock(2); // 跳读禁止：0/1 先行
    expect(calls).toStrictEqual([
      { start: 0, end: 3 },
      { start: 4, end: 7 },
      { start: 8, end: 11 }
    ]);
    expect(bs.atEnd()).toBe(false); // 还有块 3
    calls.length = 0;
    expect(await bs.ensureBlock(1)).toEqual(ALPHA.slice(4, 8)); // 已确认：零 IO 返回
    expect(calls).toStrictEqual([]);
    await bs.ensureBlock(3); // 补末块
    expect(calls).toStrictEqual([{ start: 12, end: 15 }]);
    expect(bs.atEnd()).toBe(true);
  });

  it('⑤ 超长返回（Range-less 200）→ 抛弃流式缓冲重取全量：degradedToFull + 全量切片 + atEnd', async () => {
    const calls: RangeCall[] = [];
    const bs = createBlockStream(fakeCtx({ size: 10, content: ALPHA, calls, ignoreRange: true }), B);
    const b0 = await bs.ensureBlock(0); // 请求 {0,3} 却收到 26B 全量 → 200 回退
    expect(bs.degradedToFull).toBe(true);
    expect(bs.atEnd()).toBe(true);
    expect(bs.confirmedBytes).toBe(26); // 全量到手，字节数事实修正
    // 二跳：先区间请求（暴露超长），再全量重取（端点钳制语义）
    expect(calls).toStrictEqual([{ start: 0, end: 3 }, { start: 0, end: Number.MAX_SAFE_INTEGER }]);
    expect(b0).toEqual(ALPHA.slice(0, 4)); // 全量切片（非超长原始响应错位上屏）
    // 此后一切块零 IO 全量切片（含末块钳制短切片），不再触发任何 read
    expect(await bs.ensureBlock(2)).toEqual(ALPHA.slice(8, 12));
    expect(bs.block(6)).toEqual(ALPHA.slice(24, 26));
    expect(calls).toStrictEqual([{ start: 0, end: 3 }, { start: 0, end: Number.MAX_SAFE_INTEGER }]);
    await expect(bs.ensureBlock(7)).rejects.toThrow(); // 26B 共 7 块（0..6），越界抛错
  });

  it('⑥ read 失败原样上抛（错误实例身份不变，调用方按 DispatchReadError 口径处理）', async () => {
    const boom = new Error('网络炸了');
    const bs = createBlockStream(fakeCtx({ size: 100, content: ALPHA, failWith: boom }), B);
    await expect(bs.ensureBlock(0)).rejects.toBe(boom);
  });

  it('⑦ head 不足整块：块 0 部分预置，ensureBlock(0) 重拉整块替换（T3 主路径：8KB head/64KB 块）', async () => {
    const calls: RangeCall[] = [];
    const bs = createBlockStream(fakeCtx({ size: null, head: ALPHA.slice(0, 2), content: ALPHA, calls }), B);
    expect(bs.block(0)).toEqual(ALPHA.slice(0, 2)); // 预置部分字节可见（未 ensure 契约下不完整）
    expect(bs.confirmedBytes).toBe(2);
    expect(bs.atEnd()).toBe(false); // head 短不构成 EOF 证据
    const b0 = await bs.ensureBlock(0);
    expect(calls).toStrictEqual([{ start: 0, end: 3 }]); // 重拉整块
    expect(b0).toEqual(ALPHA.slice(0, 4)); // 整块替换部分预置
    expect(bs.confirmedBytes).toBe(4);
  });

  it('⑧ 块读取失败：nextBlock 仅成功后推进——重试同块，序列完整不错位（fix round 1 原子性）', async () => {
    const boom = new Error('块 1 网络抖动');
    const calls: RangeCall[] = [];
    const bs = createBlockStream(fakeCtx({
      size: 16,
      content: ALPHA.slice(0, 16),
      calls,
      failWith: boom,
      failCall: 2 // 第 2 次 read（块 1）失败一次
    }), B);
    await expect(bs.ensureBlock(2)).rejects.toBe(boom);
    expect(calls).toStrictEqual([{ start: 0, end: 3 }, { start: 4, end: 7 }]);
    // 重试：块 0 已确认零 IO，重拉同一块 1（旧实现 nextBlock 先 ++ 后 await，失败
    // 跳块 → 块 1 永久缺位、后续块字节错位拼进缺失坐标位）
    expect(await bs.ensureBlock(2)).toEqual(ALPHA.slice(8, 12));
    expect(calls).toStrictEqual([
      { start: 0, end: 3 },
      { start: 4, end: 7 },
      { start: 4, end: 7 }, // 同块重试（不跳块）
      { start: 8, end: 11 }
    ]);
    expect(bs.block(1)).toEqual(ALPHA.slice(4, 8)); // 块 1 内容就位（序列完整）
    await bs.ensureBlock(3); // 补末块（ensureBlock(2) 只到块 2，atEnd 依赖末块就绪）
    expect(bs.block(3)).toEqual(ALPHA.slice(12, 16));
    expect(bs.atEnd()).toBe(true);
  });

  it('⑨ 短读分支推进不变量：短读后合法末块仍可达（零重拉）、越界报错块号正确（fix round 2）', async () => {
    const calls: RangeCall[] = [];
    const data = ALPHA.slice(0, 6); // 6 字节：块 0=4B 满、块 1=2B 短读（EOF）
    const bs = createBlockStream(fakeCtx({ size: null, content: data, calls }), B);
    await expect(bs.ensureBlock(3)).rejects.toThrow(/已在块 1 结束/); // 报错块号 = 实际末块 1
    // 合法末块（刚确认的短块）可达：0..nextBlock-1 恒终态块，零 IO 直取
    expect(await bs.ensureBlock(1)).toEqual(data.slice(4, 6));
    expect(await bs.ensureBlock(0)).toEqual(data.slice(0, 4));
    expect(calls).toStrictEqual([
      { start: 0, end: 3 },
      { start: 4, end: 7 } // 无任何重拉
    ]);
    expect(bs.atEnd()).toBe(true);
    await expect(bs.ensureBlock(2)).rejects.toThrow(/已在块 1 结束/); // 越界报错块号正确
  });

  it('⑩ 并发 ensureBlock 同块去重：单次 fetch、双调用方同字节 resolve（fix round 2）', async () => {
    const calls: RangeCall[] = [];
    const bs = createBlockStream(fakeCtx({ size: 16, content: ALPHA.slice(0, 16), calls }), B);
    const [a, b] = await Promise.all([bs.ensureBlock(1), bs.ensureBlock(1)]);
    expect(calls).toStrictEqual([
      { start: 0, end: 3 },
      { start: 4, end: 7 } // 块 0/1 各恰一次（并发不重复 IO）
    ]);
    expect(a).toEqual(ALPHA.slice(4, 8)); // 双调用方同字节 resolve
    expect(b).toEqual(ALPHA.slice(4, 8));
    expect(bs.atEnd()).toBe(false); // 块 2/3 未取
  });

  it('⑪ 并发失败共享：双调用方收同一真实拒绝（非伪拒绝），重试同块成功', async () => {
    const boom = new Error('块 0 抖动');
    const calls: RangeCall[] = [];
    const bs = createBlockStream(fakeCtx({
      size: 16,
      content: ALPHA.slice(0, 16),
      calls,
      failWith: boom,
      failCall: 1 // 第 1 次 read（块 0）失败一次
    }), B);
    const results = await Promise.allSettled([bs.ensureBlock(2), bs.ensureBlock(2)]);
    expect(results[0]?.status).toBe('rejected');
    expect(results[1]?.status).toBe('rejected'); // 败者也拒绝（非伪成功/伪拒绝）
    expect((results[0] as PromiseRejectedResult).reason).toBe(boom); // 同一错误实例
    expect((results[1] as PromiseRejectedResult).reason).toBe(boom);
    expect(await bs.ensureBlock(2)).toEqual(ALPHA.slice(8, 12)); // 在途表已清：重试成功
    expect(calls).toStrictEqual([
      { start: 0, end: 3 }, // 失败尝试（共享单次）
      { start: 0, end: 3 }, // 重试
      { start: 4, end: 7 },
      { start: 8, end: 11 }
    ]);
  });

  // —— 计划 3 Task 1：maxBlocks LRU 有界化（计划 2 终审 B1）——

  it('⑫ maxBlocks LRU 逐出：head 预置计入，第 N+1 块入表逐出最旧；被逐出块 ensureBlock 重拉同字节，nextBlock/confirmed 不回退', async () => {
    const calls: RangeCall[] = [];
    const bs = createBlockStream(
      fakeCtx({ size: null, head: ALPHA.slice(0, 8), content: ALPHA, calls }), B, { maxBlocks: 2 });
    expect(bs.has(0)).toBe(true); // head 预置块计入 LRU 表
    expect(bs.has(1)).toBe(true);
    await bs.ensureBlock(2); // 块 2 入表 → 超 2 逐出最旧（块 0）
    expect(bs.has(0)).toBe(false);
    expect(bs.has(2)).toBe(true);
    expect(() => bs.block(0)).toThrow(/未就绪/); // 同步契约不变：被逐出块不可直取
    expect(await bs.ensureBlock(0)).toEqual(ALPHA.slice(0, 4)); // 重拉（hexSource 同语义）
    expect(calls).toStrictEqual([{ start: 8, end: 11 }, { start: 0, end: 3 }]);
    expect(bs.confirmedBytes).toBe(12); // size 未知来源：重拉不回退已确认字节
    expect(bs.atEnd()).toBe(false);
    await bs.ensureBlock(3); // 前向推进不受重拉影响（nextBlock 不回退——不重复拉 1/2）
    expect(calls).toStrictEqual([
      { start: 8, end: 11 },
      { start: 0, end: 3 },
      { start: 12, end: 15 }
    ]);
  });

  it('⑬ LRU 触新：命中块挪到表尾，逐出对象随之改变（非 FIFO）', async () => {
    const calls: RangeCall[] = [];
    const bs = createBlockStream(
      fakeCtx({ size: null, head: ALPHA.slice(0, 8), content: ALPHA, calls }), B, { maxBlocks: 2 });
    await bs.ensureBlock(2); // 表 {1,2}（逐出 0）
    bs.block(1); // 触新块 1 → 序 {2,1}
    await bs.ensureBlock(3); // 入表超限逐出最旧 = 块 2（块 1 因触新存活）
    expect(bs.has(1)).toBe(true);
    expect(bs.has(2)).toBe(false);
    expect(bs.block(1)).toEqual(ALPHA.slice(4, 8));
    expect(calls).toStrictEqual([{ start: 8, end: 11 }, { start: 12, end: 15 }]);
  });

  it('⑭ 逐出与短读 EOF 并存：末块短读后重拉被逐出块，atEnd 锁存维持、confirmed 单调', async () => {
    const calls: RangeCall[] = [];
    const data = ALPHA.slice(0, 6); // 块 0=4B 满、块 1=2B 短读（EOF）
    const bs = createBlockStream(fakeCtx({ size: null, content: data, calls }), B, { maxBlocks: 1 });
    await bs.ensureBlock(0);
    await bs.ensureBlock(1); // 短读 EOF；块 1 入表逐出块 0
    expect(bs.atEnd()).toBe(true);
    expect(bs.has(0)).toBe(false);
    expect(await bs.ensureBlock(0)).toEqual(data.slice(0, 4)); // EOF 后重拉仍可达
    expect(bs.atEnd()).toBe(true); // shortSeen 锁存不因重拉翻转
    expect(bs.confirmedBytes).toBe(6); // 单调：重拉满块不回退已确认字节
    expect(calls).toStrictEqual([
      { start: 0, end: 3 },
      { start: 4, end: 7 },
      { start: 0, end: 3 }
    ]);
    await expect(bs.ensureBlock(2)).rejects.toThrow(/已在块 1 结束/); // EOF 越界面不变
  });

  it('⑮ degraded 全量底座：has 按文件范围判定（一切块视为驻留，LRU 不参与）', async () => {
    const bs = createBlockStream(fakeCtx({ size: 10, content: ALPHA, ignoreRange: true }), B);
    await bs.ensureBlock(0);
    expect(bs.degradedToFull).toBe(true);
    expect(bs.has(0)).toBe(true);
    expect(bs.has(6)).toBe(true); // 26B 共 7 块（0..6）
    expect(bs.has(7)).toBe(false);
    expect(bs.has(-1)).toBe(false);
  });

  it('⑯ maxBlocks 须为正整数', () => {
    const ctx = fakeCtx({ size: 10, content: ALPHA });
    expect(() => createBlockStream(ctx, B, { maxBlocks: 0 })).toThrow(/maxBlocks/);
    expect(() => createBlockStream(ctx, B, { maxBlocks: 1.5 })).toThrow(/maxBlocks/);
    expect(() => createBlockStream(ctx, B, { maxBlocks: -1 })).toThrow(/maxBlocks/);
  });

  it('⑰ STREAM_MAX_BYTES = 512MB（流式尺寸防线常量，jsonl/code 统一裁决共享）', () => {
    expect(STREAM_MAX_BYTES).toBe(512 * 1024 * 1024);
  });

  it('⑱ head 覆盖全文件 + 尺寸非块对齐（F1）：部分预置末块即 EOF 证据，atEnd 构造期为真', async () => {
    const data = ALPHA.slice(0, 6); // 6B：块 0=4B 满、块 1=2B 部分预置（head=全量、尺寸非对齐）
    const calls: RangeCall[] = [];
    const bs = createBlockStream(fakeCtx({ size: 6, content: data, head: data, calls }), B);
    expect(bs.atEnd()).toBe(true); // nextBlock 停在 blockCount-1（末块非整块不推进）——disjunct blocks.has(末块) 恢复证据
    expect(bs.confirmedBytes).toBe(6);
    // atEnd 为真不越契约⑦：部分预置末块经 ensureBlock 仍恰一次整块重拉（短读端点精确）
    expect(await bs.ensureBlock(1)).toEqual(data.slice(4, 6));
    expect(calls).toStrictEqual([{ start: 4, end: 5 }]);
    expect(bs.atEnd()).toBe(true);
  });

  it('⑲ head 部分块 × 并发去重组合：双并发 ensureBlock(0) 恰一次重拉、双方同字节 resolve（⑦×⑩ 组合面）', async () => {
    const calls: RangeCall[] = [];
    // head 2B 仅部分覆盖块 0（nextBlock 停在 0）：重拉与并发合并在同一块上叠加
    const bs = createBlockStream(fakeCtx({ size: null, head: ALPHA.slice(0, 2), content: ALPHA, calls }), B);
    const [a, b] = await Promise.all([bs.ensureBlock(0), bs.ensureBlock(0)]);
    expect(calls).toStrictEqual([{ start: 0, end: 3 }]); // 在途表合并：部分预置块恰一次整块重拉
    expect(a).toEqual(ALPHA.slice(0, 4)); // 双调用方同字节（部分预置已被整块替换）
    expect(b).toEqual(ALPHA.slice(0, 4));
    expect(bs.confirmedBytes).toBe(4); // 重拉推进确认字节（2 → 4）
    expect(bs.atEnd()).toBe(false); // 满块非短读：size 未知下 EOF 未确认
  });

  it('⑳ size 已知短读违约：read 返回短于端点钳制请求 → ensureBlock 抛「短读违约」（宁败勿静默截断，非「已在块 N 结束」EOF 口径）', async () => {
    const calls: RangeCall[] = [];
    // size 声明 10B（3 块）而实际内容仅 6B：块 1 请求 {4,7}（cap=4）只回 2 字节 = 违约。
    // 对照⑨（size 未知：短读即 EOF 证据，越界报「已在块 N 结束」）——size 已知来源按
    // ByteRange 契约精确返回，短读只能解释为读闭包违约（文件中途收缩），恒抛错
    const bs = createBlockStream(fakeCtx({ size: 10, content: ALPHA.slice(0, 6), calls }), B);
    await expect(bs.ensureBlock(2)).rejects.toThrow(/短读违约/); // 实际末块（数据 6B）之后的越界请求
    expect(calls).toStrictEqual([{ start: 0, end: 3 }, { start: 4, end: 7 }]); // 按序推进至块 1 即违约
    expect(bs.atEnd()).toBe(false); // 违约 ≠ EOF 证据：不静默当作文件终点
  });
});

// ---------------------------------------------------------------------------
// 项 1（遗留清偿波 3）：流式逐块 UTF-8 嗅探判定面（纯函数）。head 误判 utf-8
//（头部干净、尾部 GB18030 等）时窗口模式流式解码产出 U+FFFD——嗅探在喂块面计数
// 非法序列，超阈判非 UTF-8 切全量重渲。判据与 packages/core detect 的 isStrictUtf8
// 同源（RFC 3629，overlong/代理对拒绝），计数变体支持「处数/占比」双阈值；块切口
// 悬挂的多字节序列必须剔除出判定面，防合法块误判。
// ---------------------------------------------------------------------------
import { UTF8_SNIFF_ILLEGAL_MIN, isSuspiciousUtf8Block } from '../src/blockStream';

describe('isSuspiciousUtf8Block（项 1 流内嗅探，纯函数）', () => {
  /** 256KB ASCII 底（真实窗口块口径，1% 阈值 = 2621 处不干扰处数阈值的用例） */
  const asciiBlock = (): Uint8Array<ArrayBuffer> => new Uint8Array(256 * 1024).fill(0x61);

  it('纯 ASCII/合法 UTF-8（含完整多字节与文字 U+FFFD 字符）：零误报', () => {
    const b = new TextEncoder().encode('const a = 1;\n中文🎉\n\uFFFD literal\n');
    expect(isSuspiciousUtf8Block(b)).toBe(false);
    expect(isSuspiciousUtf8Block(asciiBlock())).toBe(false);
  });

  it('块尾悬挂多字节序列（lead/延续字节骑切口）：剔除不误判（下一块续判）', () => {
    const b = Uint8Array.from([...new TextEncoder().encode('x'), 0xe4, 0xb8]); // '中' 前 2 字节悬挂
    expect(isSuspiciousUtf8Block(b)).toBe(false);
    expect(isSuspiciousUtf8Block(new Uint8Array([0xe4, 0xb8, 0xad, 0x61]))).toBe(false); // 完整序列放行
  });

  it(`单块非法序列 ≥${UTF8_SNIFF_ILLEGAL_MIN} 处判非 UTF-8，阈值以下放行（0xBA 为孤立延续字节=非法）`, () => {
    const withBad = (n: number): Uint8Array<ArrayBuffer> => {
      const b = asciiBlock();
      for (let i = 0; i < n; i++) b[i] = 0xba;
      return b;
    };
    expect(isSuspiciousUtf8Block(withBad(UTF8_SNIFF_ILLEGAL_MIN))).toBe(true);
    expect(isSuspiciousUtf8Block(withBad(UTF8_SNIFF_ILLEGAL_MIN - 1))).toBe(false);
  });

  it('非法占比 ≥ 块字节 1% 亦判非（处数阈下的短块占比路径：7 处 <8 处但占比超 1%）', () => {
    // 小块（400B）上处数阈不触发、占比阈触发——1% 分支的独立钉（256KB 真实块口径
    // 下 1%=2621 处恒晚于处数阈触发，两阈值取或即 GB18030 密集块必判真）
    const b = new Uint8Array(400).fill(0x61);
    for (let i = 0; i < 7; i++) b[i] = 0xba; // 7/400 = 1.75% ≥ 1%
    expect(isSuspiciousUtf8Block(b)).toBe(true);
    expect(isSuspiciousUtf8Block(new Uint8Array(400).fill(0x61))).toBe(false);
  });
});
