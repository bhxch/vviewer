// searchScan.test.ts — Task 2（hex 增强 spec H §2.2）：worker 搜索分块纯函数
// （scanChunk 跨块重叠去重 / scanAll 分块调度、进度、1000 截断、取消中止）
// + binary.worker search 流协议（fake ctx，不真起线程）。
import { describe, expect, it } from 'vitest';
import { scanChunk, scanAll, SEARCH_MAX_HITS, type ScanChunkInfo } from '../src/searchScan';
import {
  serveBinaryWorker,
  type BinaryRequest,
  type BinaryWorkerMessage,
  type SearchDoneMessage,
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

function post(ctx: { onmessage: ((ev: MessageEvent) => void) | null }, req: BinaryRequest): void {
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
