// searchScan.test.ts — Task 2（hex 增强 spec H §2.2）：worker 搜索分块纯函数
// （scanChunk 跨块重叠去重 / scanAll 分块调度、进度、1000 截断、取消中止）
// + binary.worker search 流协议（fake ctx，不真起线程）。
import { describe, expect, it } from 'vitest';
import { scanChunk, scanAll, SEARCH_MAX_HITS, type ScanChunkInfo } from '../src/searchScan';
import {
  serveBinaryWorker,
  type BinaryRequest,
  type BinaryWorkerMessage,
  type SearchChunkRequest,
  type SearchDoneMessage,
  type SearchNeedMessage,
  type SearchProgressMessage
} from '../src/binary.worker';

function enc(s: string): Uint8Array {
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

describe('scanChunk', () => {
  it('返回绝对 offset（baseOffset 换算），首/中/尾命中都在列', () => {
    expect(scanChunk(enc('abXab'), enc('ab'), 100, 0)).toEqual([100, 103]);
    expect(scanChunk(enc('abc'), enc('abc'), 50, 0)).toEqual([50]); // 整块恰为 needle
  });

  it('needle 空或长于 data → 空列表', () => {
    expect(scanChunk(enc('abc'), new Uint8Array(0), 0, 0)).toEqual([]);
    expect(scanChunk(enc('ab'), enc('abc'), 0, 0)).toEqual([]);
  });

  it('overlap 去重：完全落在重叠区的命中跳过（前块已报），跨界命中保留', () => {
    // 窗口 = 前 2 字节重叠区（绝对 100..101）+ 新区域；'ab'@100 完全在重叠区 → 跳过；
    // 'bc'@101 起点在重叠区、终点伸入新区域 → 本块恰报一次；'cd' 照常
    const data = enc('abcdXbcd'); // 绝对 100..107
    expect(scanChunk(data, enc('ab'), 100, 2)).toEqual([]);
    expect(scanChunk(data, enc('bc'), 100, 2)).toEqual([101, 105]);
    expect(scanChunk(data, enc('cd'), 100, 2)).toEqual([102, 106]);
  });

  it('maxHits 配额：块内收满即停（即时判停），不扫完整块', () => {
    // 6 个连续 'a'，配额 3：收满即 break——单字节 needle 命中风暴不再全块收满
    expect(scanChunk(enc('aaaaaa'), enc('a'), 0, 0, 3)).toEqual([0, 1, 2]);
    expect(scanChunk(enc('aaaaaa'), enc('a'), 500, 0, 3)).toEqual([500, 501, 502]);
  });
});

describe('scanAll', () => {
  it('needle 恰跨块边界：两块拼接处命中恰计一次（overlap 不重复计）', async () => {
    const data = enc('abccdefg'); // chunkSize=4 → 块界 4；'cd'@3 跨界（块 0 截断不可见）
    expect((await scanAll(data, enc('cd'), { chunkSize: 4 })).offsets).toEqual([3]);
    expect((await scanAll(data, enc('ef'), { chunkSize: 4 })).offsets).toEqual([5]); // 块内命中照常
  });

  it('首尾命中端到端（默认 overlap 数学，多块）', async () => {
    const data = enc('abXXab'); // chunkSize=3 → 两块
    expect((await scanAll(data, enc('ab'), { chunkSize: 3 })).offsets).toEqual([0, 4]);
  });

  it('1000 截断：累计达 SEARCH_MAX_HITS 即停且 truncated:true（块粒度）', async () => {
    const data = new Uint8Array(SEARCH_MAX_HITS * 2).fill(0x61); // 2000 个 'a'
    const res = await scanAll(data, enc('a'), { chunkSize: 100 }); // 每块 100 命中
    expect(res.offsets).toHaveLength(SEARCH_MAX_HITS); // 第 10 块后达限，停扫
    expect(res.truncated).toBe(true);
    expect(res.offsets[0]).toBe(0);
  });

  it('单块命中风暴：块内即时判停，恰好收满 maxHits（不再超额收满整块）', async () => {
    // 旧语义（块后检查）：单字节 needle + 单大块一次性收满 2048 才停——超 maxHits；
    // 新语义：块内配额判停，恰 1000（spec「1000 上限」精确成立）
    const data = new Uint8Array(2048).fill(0x61); // 2048 个 'a'，默认 1MB 块为单块
    const res = await scanAll(data, enc('a'));
    expect(res.offsets).toHaveLength(SEARCH_MAX_HITS);
    expect(res.truncated).toBe(true);
    expect(res.offsets[SEARCH_MAX_HITS - 1]).toBe(SEARCH_MAX_HITS - 1);
  });

  it('无命中 / 空 needle：空列表、不截断、不中止', async () => {
    expect(await scanAll(enc('abc'), enc('zz'))).toMatchObject({
      offsets: [], truncated: false, aborted: false, scanned: 3, total: 3
    });
    expect((await scanAll(enc('abc'), new Uint8Array(0))).offsets).toEqual([]);
  });

  it('onChunk 每块回报进度（scanned 累计 / 本块 offsets），shouldContinue false 即中止', async () => {
    const chunks: ScanChunkInfo[] = [];
    const res = await scanAll(enc('ab'.repeat(6)), enc('ab'), {
      chunkSize: 4,
      onChunk: (info) => {
        chunks.push({ ...info, offsets: [...info.offsets] });
      },
      shouldContinue: () => (chunks[chunks.length - 1]?.scanned ?? 0) < 8
    });
    expect(chunks.map((c) => c.scanned)).toEqual([4, 8]);
    expect(chunks.map((c) => c.hits)).toEqual([2, 2]);
    expect(chunks[1]!.offsets).toEqual([4, 6]);
    expect(res).toMatchObject({ offsets: [0, 2, 4, 6], truncated: false, aborted: true, scanned: 8 });
  });

  it('fold：大小写不敏感（ASCII 折叠）按字节同值命中；默认大小写敏感', async () => {
    expect((await scanAll(enc('aBcXabc'), enc('ABC'), { fold: true })).offsets).toEqual([0, 4]);
    expect((await scanAll(enc('aBc'), enc('ABC'))).offsets).toEqual([]);
  });
});

// ---- binary.worker search 流协议（fake ctx：postMessage 收集、onmessage 手动灌入）----

function fakeCtx(): { ctx: { onmessage: ((ev: MessageEvent) => void) | null; postMessage: (msg: BinaryWorkerMessage) => void }; out: BinaryWorkerMessage[] } {
  const out: BinaryWorkerMessage[] = [];
  const ctx = {
    onmessage: null as ((ev: MessageEvent) => void) | null,
    postMessage: (msg: BinaryWorkerMessage): void => {
      out.push(msg);
    }
  };
  return { ctx, out };
}

function post(
  ctx: { onmessage: ((ev: MessageEvent) => void) | null },
  req: BinaryRequest | SearchChunkRequest
): void {
  ctx.onmessage?.({ data: req } as MessageEvent);
}

async function drain(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

describe('serveBinaryWorker：search 流（fake ctx）', () => {
  it('search：逐块 progress + done；parse-struct 透传不受影响（向后兼容）', async () => {
    const { ctx, out } = fakeCtx();
    serveBinaryWorker(ctx, { chunkSize: 4 });
    post(ctx, { id: 1, kind: 'parse-struct', head: new Uint8Array(4) });
    post(ctx, { id: 7, kind: 'search', data: enc('abababab'), needle: enc('ab') });
    await drain();
    const progress = out.filter((m): m is SearchProgressMessage => 'type' in m && m.type === 'search-progress');
    expect(progress.map((m) => m.scanned)).toEqual([4, 8]);
    expect(progress.map((m) => m.hits)).toEqual([2, 2]);
    expect(progress[0]).toMatchObject({ id: 7, offsets: [0, 2] });
    const done = out.find((m): m is SearchDoneMessage => 'type' in m && m.type === 'search-done');
    expect(done).toEqual({ id: 7, type: 'search-done', truncated: false });
    expect(out[0]).toMatchObject({ id: 1, ok: true });
  });

  it('search：累计达 maxHits 提前终止（truncated:true）', async () => {
    const { ctx, out } = fakeCtx();
    serveBinaryWorker(ctx, { chunkSize: 4, maxHits: 3 });
    post(ctx, { id: 1, kind: 'search', data: enc('abababab'), needle: enc('ab') });
    await drain();
    expect(out.filter((m): m is SearchProgressMessage => 'type' in m && m.type === 'search-progress')).toHaveLength(2);
    expect(out.find((m): m is SearchDoneMessage => 'type' in m && m.type === 'search-done')).toEqual({
      id: 1,
      type: 'search-done',
      truncated: true
    });
  });

  it('search-cancel 使 id 失效：后续块停扫、无 done', async () => {
    const { ctx, out } = fakeCtx();
    serveBinaryWorker(ctx, { chunkSize: 1 });
    post(ctx, { id: 9, kind: 'search', data: enc('abababab'), needle: enc('ab') });
    await new Promise((r) => setTimeout(r, 0)); // 首块扫描完成（1 条 progress 已出）
    post(ctx, { id: 9, kind: 'search-cancel' });
    await drain();
    expect(out.filter((m): m is SearchProgressMessage => 'type' in m && m.type === 'search-progress')).toHaveLength(1);
    expect(out.some((m): m is SearchDoneMessage => 'type' in m && m.type === 'search-done')).toBe(false);
  });

  it('新 search 请求自动失效旧 id：旧任务停扫不发 done，新任务照常', async () => {
    const { ctx, out } = fakeCtx();
    serveBinaryWorker(ctx, { chunkSize: 1 });
    post(ctx, { id: 1, kind: 'search', data: enc('abababab'), needle: enc('ab') });
    await new Promise((r) => setTimeout(r, 0));
    post(ctx, { id: 2, kind: 'search', data: enc('ab'), needle: enc('ab') });
    await drain();
    expect(out.filter((m): m is SearchDoneMessage => 'type' in m && m.type === 'search-done')).toEqual([
      { id: 2, type: 'search-done', truncated: false }
    ]);
  });
});

// ---- binary.worker search 窗口协议（io-streaming Task 6）：无 data 请求 →
// search-need 逐块要数 → search-chunk 回灌，scanChunk 语义与 data 模式一致 ----

describe('serveBinaryWorker：search 窗口协议（need/chunk 握手，fake ctx）', () => {
  it('无 data 请求 → search-need 逐块驱动，chunk 回灌后照常 progress/done', async () => {
    const { ctx, out } = fakeCtx();
    serveBinaryWorker(ctx, { chunkSize: 4 });
    post(ctx, { id: 7, kind: 'search', needle: enc('ab'), size: 8 }); // 无 data（窗口模式）
    await drain();
    // 首条 need：[0, 4)（chunkSize 步进）；未供数前无 progress/done
    expect(out).toEqual([{ id: 7, type: 'search-need', start: 0, end: 4 }]);
    post(ctx, { id: 7, type: 'search-chunk', start: 0, bytes: enc('abab') });
    await drain();
    post(ctx, { id: 7, type: 'search-chunk', start: 4, bytes: enc('abab') });
    await drain();
    const progress = out.filter((m): m is SearchProgressMessage => 'type' in m && m.type === 'search-progress');
    expect(progress.map((m) => [m.scanned, m.total, m.hits, m.offsets])).toEqual([
      [4, 8, 2, [0, 2]],
      [8, 8, 2, [4, 6]]
    ]);
    expect(out.find((m): m is SearchDoneMessage => 'type' in m && m.type === 'search-done')).toEqual({
      id: 7,
      type: 'search-done',
      truncated: false
    });
  });

  it('overlap 跨块命中恰报一次（前块尾 overlap 回借组窗，语义同 scanAll）', async () => {
    const { ctx, out } = fakeCtx();
    serveBinaryWorker(ctx, { chunkSize: 3 });
    post(ctx, { id: 1, kind: 'search', needle: enc('Xa'), size: 6 }); // 数据逐块供给 'abX' + 'abX'
    await drain();
    expect(out).toEqual([{ id: 1, type: 'search-need', start: 0, end: 3 }]);
    post(ctx, { id: 1, type: 'search-chunk', start: 0, bytes: enc('abX') });
    await drain();
    post(ctx, { id: 1, type: 'search-chunk', start: 3, bytes: enc('abX') });
    await drain();
    const progress = out.filter((m): m is SearchProgressMessage => 'type' in m && m.type === 'search-progress');
    // 'Xa'@2 起点在前块区域、终点伸入后块：前块截断不可见，后块组窗（尾 1 字节 +
    // 本块）恰报一次——'ab'@0、'ab'@3 等非跨界命中不受 overlap 影响
    expect(progress.map((m) => [m.scanned, m.offsets])).toEqual([[3, []], [6, [2]]]);
    expect(out.find((m): m is SearchDoneMessage => 'type' in m && m.type === 'search-done')).toEqual({
      id: 1,
      type: 'search-done',
      truncated: false
    });
  });

  it('maxHits 提前终止：配额收满即 done(truncated:true)，块内即时判停、不再发 need', async () => {
    const { ctx, out } = fakeCtx();
    serveBinaryWorker(ctx, { chunkSize: 2, maxHits: 3 });
    post(ctx, { id: 2, kind: 'search', needle: enc('a'), size: 6 }); // 供给 'aaaaaa'
    await drain();
    expect(out).toEqual([{ id: 2, type: 'search-need', start: 0, end: 2 }]);
    post(ctx, { id: 2, type: 'search-chunk', start: 0, bytes: enc('aa') });
    await drain();
    expect(out.at(-1)).toMatchObject({ id: 2, type: 'search-need', start: 2, end: 4 });
    post(ctx, { id: 2, type: 'search-chunk', start: 2, bytes: enc('aa') });
    await drain();
    const progress = out.filter((m): m is SearchProgressMessage => 'type' in m && m.type === 'search-progress');
    // 第二块配额仅剩 1（3-2）：块内即时判停恰收满 maxHits
    expect(progress.map((m) => [m.scanned, m.hits])).toEqual([[2, 2], [4, 1]]);
    expect(out.find((m): m is SearchDoneMessage => 'type' in m && m.type === 'search-done')).toEqual({
      id: 2,
      type: 'search-done',
      truncated: true
    });
    expect(out.some((m) => (m as SearchNeedMessage).type === 'search-need' && (m as SearchNeedMessage).start === 4)).toBe(false);
  });

  it('末块钳制：size 非块整数倍时 need.end 钳到 size，末块供给后 done', async () => {
    const { ctx, out } = fakeCtx();
    serveBinaryWorker(ctx, { chunkSize: 4 });
    post(ctx, { id: 3, kind: 'search', needle: enc('zz'), size: 6 }); // 数据 'abab' + 'zz'
    await drain();
    expect(out[0]).toMatchObject({ id: 3, type: 'search-need', start: 0, end: 4 });
    post(ctx, { id: 3, type: 'search-chunk', start: 0, bytes: enc('abab') });
    await drain();
    expect(out.at(-1)).toMatchObject({ id: 3, type: 'search-need', start: 4, end: 6 }); // 末块钳制
    post(ctx, { id: 3, type: 'search-chunk', start: 4, bytes: enc('zz') });
    await drain();
    const progress = out.filter((m): m is SearchProgressMessage => 'type' in m && m.type === 'search-progress');
    expect(progress[1]).toMatchObject({ scanned: 6, total: 6, hits: 1, offsets: [4] });
    expect(out.find((m): m is SearchDoneMessage => 'type' in m && m.type === 'search-done')).toEqual({
      id: 3,
      type: 'search-done',
      truncated: false
    });
  });

  it('search-cancel 使窗口任务失效：不再发 need，迟到 chunk 丢弃', async () => {
    const { ctx, out } = fakeCtx();
    serveBinaryWorker(ctx, { chunkSize: 2 });
    post(ctx, { id: 9, kind: 'search', needle: enc('a'), size: 4 });
    await drain();
    post(ctx, { id: 9, kind: 'search-cancel' });
    post(ctx, { id: 9, type: 'search-chunk', start: 0, bytes: enc('aa') }); // 取消后的迟到块
    await drain();
    expect(out).toEqual([{ id: 9, type: 'search-need', start: 0, end: 2 }]); // 仅首条 need，无 progress/done
  });

  it('新窗口搜索自动失效旧任务：旧 chunk 丢弃，新任务照常完成', async () => {
    const { ctx, out } = fakeCtx();
    serveBinaryWorker(ctx, { chunkSize: 2 });
    post(ctx, { id: 1, kind: 'search', needle: enc('a'), size: 4 });
    await drain();
    post(ctx, { id: 2, kind: 'search', needle: enc('b'), size: 2 });
    await drain();
    post(ctx, { id: 1, type: 'search-chunk', start: 0, bytes: enc('aa') }); // 旧任务迟到块
    await drain();
    expect(out.at(-1)).toMatchObject({ id: 2, type: 'search-need', start: 0, end: 2 });
    post(ctx, { id: 2, type: 'search-chunk', start: 0, bytes: enc('bb') });
    await drain();
    const done = out.filter((m): m is SearchDoneMessage => 'type' in m && m.type === 'search-done');
    expect(done).toEqual([{ id: 2, type: 'search-done', truncated: false }]);
  });

  it('空 needle / size 0：不发 need 直接 done（同 scanAll 空集语义）', async () => {
    const { ctx, out } = fakeCtx();
    serveBinaryWorker(ctx, { chunkSize: 4 });
    post(ctx, { id: 1, kind: 'search', needle: new Uint8Array(0), size: 8 });
    post(ctx, { id: 2, kind: 'search', needle: enc('a'), size: 0 });
    await drain();
    expect(out).toEqual([
      { id: 1, type: 'search-done', truncated: false },
      { id: 2, type: 'search-done', truncated: false }
    ]);
  });

  it('caseInsensitive 折叠在窗口模式同样生效（数据与 needle 均折叠）', async () => {
    const { ctx, out } = fakeCtx();
    serveBinaryWorker(ctx, { chunkSize: 4 });
    post(ctx, { id: 5, kind: 'search', needle: enc('AB'), caseInsensitive: true, size: 6 }); // 供给 'aBab' + 'AB'
    await drain();
    post(ctx, { id: 5, type: 'search-chunk', start: 0, bytes: enc('aBab') });
    await drain();
    post(ctx, { id: 5, type: 'search-chunk', start: 4, bytes: enc('AB') });
    await drain();
    const progress = out.filter((m): m is SearchProgressMessage => 'type' in m && m.type === 'search-progress');
    expect(progress.map((m) => m.offsets)).toEqual([[0, 2], [4]]);
    expect(out.find((m): m is SearchDoneMessage => 'type' in m && m.type === 'search-done')).toMatchObject({
      id: 5,
      truncated: false
    });
  });
});
