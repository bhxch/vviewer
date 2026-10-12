// blockStream.test.ts — Task 1（io-streaming 计划 2）：blockStream 公共块流读取器单测。
// 语义覆盖：head 覆盖首块直取零 IO、size 已知末块精确短读 + atEnd、size 未知短读
// 探测 atEnd、ensureBlock 按序推进不跳读、Range-less 200 超长返回切全量（计划 1
// 终审 F3）、read 失败原样上抛。纯逻辑模块，fake ctx 记录每次请求区间。
import { describe, expect, it } from 'vitest';
import type { StreamCtx } from '@vviewer/core';
import { createBlockStream } from '../src/blockStream';

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
});
