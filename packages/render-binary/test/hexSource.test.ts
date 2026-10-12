// hexSource.test.ts — Task 5（io-streaming）：hex 窗口取数访问器单测。
// 块缓存语义：head 预置直取、未就绪 slice → null、ensure 拉块（64KB 对齐、跨块
// 一次多块、同块并发去重、LRU 上限 8 块逐出最旧）。纯逻辑，fake read 记录区间。
import { describe, expect, it } from 'vitest';
import { createHexSource, HexSourceRangeError, HEX_SOURCE_BLOCK_BYTES } from '../src/hexSource';

/** fake 全量数据：字节值 = 偏移 mod 256，任一区间可逐字节校验 */
const FULL = Uint8Array.from({ length: 200_000 }, (_, i) => i & 0xff);
const BLOCK = 64 * 1024;

/** fake read：按 ByteRange（end 含）从 FULL 切片，记录每次请求区间 */
function fakeRead(calls: Array<{ start: number; end: number }>, content: Uint8Array = FULL) {
  return async (r: { start: number; end: number }): Promise<Uint8Array<ArrayBuffer>> => {
    calls.push({ start: r.start, end: r.end });
    return content.slice(r.start, r.end + 1);
  };
}

function expectBytes(bytes: Uint8Array, start: number, len: number): void {
  expect(bytes.length).toBe(len);
  for (let i = 0; i < len; i++) expect(bytes[i]).toBe(FULL[start + i]);
}

describe('createHexSource', () => {
  it('head 覆盖区间 slice 直取（不触发 read）', async () => {
    const calls: Array<{ start: number; end: number }> = [];
    const src = createHexSource(FULL.length, FULL.slice(0, 8192), fakeRead(calls));
    expect(src.size).toBe(FULL.length);
    const win = src.slice(0, 100);
    expect(win).not.toBeNull();
    expectBytes(win!, 0, 100);
    expect(calls).toStrictEqual([]); // head 直取，零 IO
    // 尾部对齐 head 边界同样直取
    const win2 = src.slice(8100, 8192);
    expectBytes(win2!, 8100, 92);
    expect(calls).toStrictEqual([]);
    await Promise.resolve(); // 保持 async 语义对齐（无副作用）
  });

  it('未就绪区间 slice → null，ensure 后 slice 返回正确字节（read 记录覆盖块区间）', async () => {
    const calls: Array<{ start: number; end: number }> = [];
    const src = createHexSource(FULL.length, FULL.slice(0, 8), fakeRead(calls));
    expect(src.slice(10, 20)).toBeNull(); // block 0 仅有 head 前 8 字节
    await src.ensure(10, 20);
    // ensure 拉取整块（64KB 对齐、ByteRange end 含）
    expect(calls).toStrictEqual([{ start: 0, end: BLOCK - 1 }]);
    const win = src.slice(10, 20);
    expectBytes(win!, 10, 10);
    // head 区间与拉块区间拼接均正确
    expectBytes(src.slice(0, 8)!, 0, 8);
  });

  it('块对齐：区间拉取覆盖块（64KB 对齐），跨块区间一次 ensure 多块', async () => {
    const calls: Array<{ start: number; end: number }> = [];
    const src = createHexSource(FULL.length, new Uint8Array(0), fakeRead(calls));
    await src.ensure(100, 200);
    expect(calls).toStrictEqual([{ start: 0, end: BLOCK - 1 }]); // [100,200) 落 block 0
    // 全新访问器跨块区间：一次 ensure 并发拉齐两块（block 0/1 各整块）
    const calls2: Array<{ start: number; end: number }> = [];
    const src2 = createHexSource(FULL.length, new Uint8Array(0), fakeRead(calls2));
    await src2.ensure(BLOCK - 10, BLOCK + 10); // 跨 block 0/1 边界
    expect(calls2).toStrictEqual([
      { start: 0, end: BLOCK - 1 },
      { start: BLOCK, end: 2 * BLOCK - 1 }
    ]);
    const win = src2.slice(BLOCK - 10, BLOCK + 10);
    expectBytes(win!, BLOCK - 10, 20);
    // 已就绪块不重拉：同一访问器再跨同界只补缺块
    calls.length = 0;
    await src.ensure(BLOCK - 10, BLOCK + 10);
    expect(calls).toStrictEqual([{ start: BLOCK, end: 2 * BLOCK - 1 }]);
    // EOF 块：区间拉到文件尾，read 端点钳制为 size-1
    calls.length = 0;
    await src.ensure(FULL.length - 10, FULL.length);
    expect(calls).toStrictEqual([{ start: Math.floor((FULL.length - 10) / BLOCK) * BLOCK, end: FULL.length - 1 }]);
    expectBytes(src.slice(FULL.length - 10, FULL.length)!, FULL.length - 10, 10);
  });

  it('LRU：第 9 个不相交块进入后最旧块被逐出（slice → null 且再次 ensure 重新拉取）', async () => {
    const calls: Array<{ start: number; end: number }> = [];
    const CONTENT = Uint8Array.from({ length: 9 * BLOCK }, (_, i) => i & 0xff); // 与文件等长
    // head 置空：9 个块全部经 ensure 进入，逐出判定不被 head 预置干扰
    const src = createHexSource(9 * BLOCK, new Uint8Array(0), fakeRead(calls, CONTENT));
    for (let i = 0; i < 9; i++) await src.ensure(i * BLOCK, (i + 1) * BLOCK);
    expect(calls).toHaveLength(9);
    // 第 9 块（index 8）进入 → 最旧的 block 0 被逐出
    expect(src.slice(0, 1)).toBeNull();
    expect(src.slice(8 * BLOCK, 8 * BLOCK + 1)).not.toBeNull(); // 新块仍在
    const before = calls.length;
    await src.ensure(0, 1); // 再次访问 block 0：重新拉取
    expect(calls.length).toBe(before + 1);
    expect(calls[calls.length - 1]).toStrictEqual({ start: 0, end: BLOCK - 1 });
    expect(src.slice(0, 1)).not.toBeNull();
  });

  it('同块并发 ensure 去重为单次 read（并发计数断言）', async () => {
    const calls: Array<{ start: number; end: number }> = [];
    let resolveRead!: () => void;
    const gate = new Promise<void>((r) => {
      resolveRead = r;
    });
    const src = createHexSource(
      FULL.length,
      new Uint8Array(0),
      async (r) => {
        calls.push({ start: r.start, end: r.end });
        await gate; // 挂起首个读，制造并发窗口
        return FULL.slice(r.start, r.end + 1);
      }
    );
    const a = src.ensure(10, 20);
    const b = src.ensure(30, 40); // 同块（block 0）并发请求
    resolveRead();
    await Promise.all([a, b]);
    expect(calls).toStrictEqual([{ start: 0, end: BLOCK - 1 }]); // 去重为单次 read
    expectBytes(src.slice(10, 40)!, 10, 30);
    // 去重不吞错：块读失败后 inflight 清理，后续 ensure 可重试
    let fail = true;
    const src2 = createHexSource(FULL.length, new Uint8Array(0), async (r) => {
      if (fail) {
        fail = false;
        throw new Error('io gone');
      }
      return FULL.slice(r.start, r.end + 1);
    });
    await expect(src2.ensure(0, 8)).rejects.toThrow('io gone');
    await src2.ensure(0, 8); // 重试成功
    expect(src2.slice(0, 8)).not.toBeNull();
  });

  it('退化面：size 0 空文件 slice 为空数组、ensure 直达 resolve；区间越界 clamp 到 size', async () => {
    const calls: Array<{ start: number; end: number }> = [];
    const src = createHexSource(0, new Uint8Array(0), fakeRead(calls));
    expect(src.slice(0, 10)).toStrictEqual(new Uint8Array(0));
    await src.ensure(0, 10);
    expect(calls).toStrictEqual([]);
    const win = src.slice(-5, FULL.length + 5); // 越界 clamp（FULL 版本）
    expect(win).not.toBeNull();
  });

  it('块大小常量 = 64KB（对齐口径锁定）', () => {
    expect(HEX_SOURCE_BLOCK_BYTES).toBe(65536);
  });

  // ---- 终审 F3：Range-less 服务器（超返回）宁败勿静默 clamp 错位块 ----

  it('Range-less 超返回：ensure reject HexSourceRangeError 携全量 bytes，错位数据不入缓存', async () => {
    const calls: Array<{ start: number; end: number }> = [];
    const src = createHexSource(FULL.length, new Uint8Array(0), async (r) => {
      calls.push({ start: r.start, end: r.end });
      return FULL.slice(0); // 忽略 Range：任意区间请求回 200 全量
    });
    const err: unknown = await src.ensure(BLOCK + 10, BLOCK + 20).then(
      () => null,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(HexSourceRangeError);
    expect((err as HexSourceRangeError).full).toEqual(FULL); // 全量响应随错误携出（调用方切换全量用）
    // 错位数据未入缓存：目标块仍视为未就绪（slice → null），且 inflight 已清理可重试
    expect(src.slice(BLOCK + 10, BLOCK + 20)).toBeNull();
    await expect(src.ensure(BLOCK + 10, BLOCK + 20)).rejects.toThrow(HexSourceRangeError);
  });

  it('replaceWithFull：装载全量后 slice 恒命中（含尾块）、ensure 零 IO', async () => {
    const calls: Array<{ start: number; end: number }> = [];
    const src = createHexSource(FULL.length, FULL.slice(0, 8), fakeRead(calls));
    expect(src.slice(BLOCK, BLOCK + 1)).toBeNull(); // 切换前 block 1 未就绪
    src.replaceWithFull(FULL);
    expectBytes(src.slice(BLOCK, BLOCK + 10)!, BLOCK, 10);
    expectBytes(src.slice(FULL.length - 10, FULL.length)!, FULL.length - 10, 10);
    calls.length = 0;
    await src.ensure(0, FULL.length); // 全量块全部就绪：零读
    expect(calls).toStrictEqual([]);
  });
});
