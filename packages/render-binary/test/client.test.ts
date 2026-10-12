// client.test.ts — BinaryClient 消息协议单测（fake Worker，不真起线程）。
import { describe, expect, it, vi } from 'vitest';
import { BinaryClient, type SearchDoneInfo, type SearchProgressInfo } from '../src/client';
import type {
  BinaryRequest,
  BinaryWorkerMessage,
  ParseStructRequest,
  SearchChunkRequest,
  SearchRequest,
  SearchWindowRequest
} from '../src/binary.worker';

/** 记录请求、可手动回灌响应的 fake Worker */
function fakeWorker() {
  const requests: (BinaryRequest | SearchChunkRequest)[] = [];
  const worker = {
    onmessage: null as ((ev: MessageEvent) => void) | null,
    postMessage: vi.fn((req: BinaryRequest | SearchChunkRequest) => requests.push(req)),
    terminate: vi.fn(),
    respond(res: BinaryWorkerMessage): void {
      worker.onmessage?.({ data: res } as MessageEvent);
    }
  };
  return { worker, requests };
}

describe('BinaryClient', () => {
  it('请求 id 递增配对响应', async () => {
    const { worker, requests } = fakeWorker();
    const client = new BinaryClient(worker as unknown as Worker);
    const p1 = client.parseStruct(new Uint8Array([0x89, 0x50]), { budgetMs: 100 });
    const p2 = client.parseStruct(new Uint8Array([0x7f, 0x45]), { budgetMs: 200 });
    expect(requests.map((r) => r.id)).toEqual([1, 2]);
    expect((requests[1] as Partial<ParseStructRequest>).budgetMs).toBe(200);
    worker.respond({ id: 2, ok: true, root: { name: 'ELF', offset: 0, size: 4, value: '' }, truncated: false });
    worker.respond({ id: 1, ok: true, root: null, truncated: false });
    await expect(p2).resolves.toEqual({ root: { name: 'ELF', offset: 0, size: 4, value: '' }, truncated: false });
    await expect(p1).resolves.toEqual({ root: null, truncated: false });
    client.dispose();
  });

  it('错误响应 reject 为 Error', async () => {
    const { worker } = fakeWorker();
    const client = new BinaryClient(worker as unknown as Worker);
    const p = client.parseStruct(new Uint8Array(4));
    worker.respond({ id: 1, ok: false, error: 'boom' });
    await expect(p).rejects.toThrow('boom');
    client.dispose();
  });

  it('dispose 后未完成请求 reject 且终止 worker', async () => {
    const { worker } = fakeWorker();
    const client = new BinaryClient(worker as unknown as Worker);
    const p = client.parseStruct(new Uint8Array(4));
    client.dispose();
    await expect(p).rejects.toThrow('binary client 已释放');
    expect(worker.terminate).toHaveBeenCalled();
  });
});

// ---- Task 2：流式搜索（search/cancelSearch，id 失效语义）----

function enc(s: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

describe('BinaryClient.search', () => {
  it('search 请求携带数据副本与 needle，progress/done 回调按序触发', () => {
    const { worker, requests } = fakeWorker();
    const client = new BinaryClient(worker as unknown as Worker);
    const progress: SearchProgressInfo[] = [];
    let done: SearchDoneInfo | null = null;
    const data = enc('abab');
    client.search(enc('ab'), {
      data,
      onProgress: (p) => progress.push(p),
      onDone: (r) => {
        done = r;
      }
    });
    expect(requests).toHaveLength(1);
    const req = requests[0] as SearchRequest;
    expect(req.kind).toBe('search');
    expect(req.id).toBe(1);
    expect(req.data).toEqual(enc('abab'));
    expect(req.data).not.toBe(data); // 独立副本：调用方原件不被 transfer detach
    expect(data).toEqual(enc('abab'));
    worker.respond({ id: 1, type: 'search-progress', scanned: 2, total: 4, hits: 1, offsets: [0] });
    worker.respond({ id: 1, type: 'search-progress', scanned: 4, total: 4, hits: 1, offsets: [2] });
    worker.respond({ id: 1, type: 'search-done', truncated: false });
    expect(progress.map((p) => p.scanned)).toEqual([2, 4]);
    expect(done).toEqual({ truncated: false, offsets: [0, 2] }); // 全量命中由 client 累积
    client.dispose();
  });

  it('cancelSearch 发出取消请求，旧 id 的迟到消息被丢弃', () => {
    const { worker, requests } = fakeWorker();
    const client = new BinaryClient(worker as unknown as Worker);
    const seen: number[] = [];
    let doneCount = 0;
    client.search(enc('ab'), {
      data: enc('abab'),
      onProgress: (p) => seen.push(...p.offsets),
      onDone: () => {
        doneCount++;
      }
    });
    client.cancelSearch();
    expect(requests[1]).toEqual({ id: 1, kind: 'search-cancel' });
    worker.respond({ id: 1, type: 'search-progress', scanned: 4, total: 4, hits: 2, offsets: [0, 2] });
    worker.respond({ id: 1, type: 'search-done', truncated: false });
    expect(seen).toEqual([]);
    expect(doneCount).toBe(0);
    client.dispose();
  });

  it('新搜索自动取消旧任务：旧 id 消息静默丢弃，新搜索正常收尾', () => {
    const { worker, requests } = fakeWorker();
    const client = new BinaryClient(worker as unknown as Worker);
    let doneA: SearchDoneInfo | null = null;
    let doneB: SearchDoneInfo | null = null;
    client.search(enc('a'), { data: enc('aa'), onDone: (r) => (doneA = r) });
    client.search(enc('b'), { data: enc('bb'), onDone: (r) => (doneB = r) });
    expect(requests.map((r) => r.id)).toEqual([1, 2]);
    worker.respond({ id: 1, type: 'search-progress', scanned: 2, total: 2, hits: 2, offsets: [0, 1] });
    worker.respond({ id: 1, type: 'search-done', truncated: false });
    expect(doneA).toBeNull(); // 旧任务已被取代，回调不再触发
    worker.respond({ id: 2, type: 'search-done', truncated: true });
    expect(doneB).toEqual({ truncated: true, offsets: [] });
    client.dispose();
  });

  it('worker 错误响应终结搜索：onDone 以已累计 offsets 收尾（不悬挂取消按钮）', () => {
    const { worker } = fakeWorker();
    const client = new BinaryClient(worker as unknown as Worker);
    let done: SearchDoneInfo | null = null;
    client.search(enc('ab'), {
      data: enc('abab'),
      onDone: (r) => {
        done = r;
      }
    });
    worker.respond({ id: 1, type: 'search-progress', scanned: 2, total: 4, hits: 1, offsets: [0] });
    worker.respond({ id: 1, ok: false, error: 'worker boom' });
    expect(done).toEqual({ truncated: false, offsets: [0] });
    client.dispose();
  });

  it('dispose 终止后 activeSearch 清空（terminate 即无后续回调）', () => {
    const { worker } = fakeWorker();
    const client = new BinaryClient(worker as unknown as Worker);
    let fired = 0;
    client.search(enc('a'), {
      data: enc('aa'),
      onDone: () => {
        fired++;
      }
    });
    client.dispose();
    expect(worker.terminate).toHaveBeenCalled();
    worker.respond({ id: 1, type: 'search-done', truncated: false });
    expect(fired).toBe(0);
  });
});

// ---- io-streaming Task 6：窗口模式搜索（need/chunk 供数，无 data 请求）----

/** 微任务排空：read 闭包（async）落定并走到 postMessage/abort 回调 */
async function flushMicro(): Promise<void> {
  for (let i = 0; i < 4; i++) await Promise.resolve();
}

describe('BinaryClient.search 窗口模式（need/chunk 握手）', () => {
  it('无 data 请求只带 needle/size；search-need 经 read（end 含换算）回灌 search-chunk', async () => {
    const { worker, requests } = fakeWorker();
    const client = new BinaryClient(worker as unknown as Worker);
    const FULL = enc('aabbccdd');
    const reads: Array<{ start: number; end: number }> = [];
    client.search(enc('bb'), {
      size: FULL.length,
      read: async (r) => {
        reads.push(r);
        return FULL.slice(r.start, r.end + 1);
      }
    });
    const req = requests[0] as SearchWindowRequest;
    expect('data' in req).toBe(false); // 窗口模式：无全量副本
    expect(req).toMatchObject({ id: 1, kind: 'search', needle: enc('bb'), size: 8 });
    // worker 需要前 4 字节 → read 区间按 end 含换算（0..3）
    worker.respond({ id: 1, type: 'search-need', start: 0, end: 4 });
    await flushMicro();
    expect(reads).toEqual([{ start: 0, end: 3 }]);
    expect(requests[1]).toEqual({ id: 1, type: 'search-chunk', start: 0, bytes: enc('aabb') });
    client.dispose();
  });

  it('read 返回超请求量：钳制到 need 区间长度（同 hexSource cap 语义）', async () => {
    const { worker, requests } = fakeWorker();
    const client = new BinaryClient(worker as unknown as Worker);
    const FULL = enc('aabbccdd');
    client.search(enc('bb'), {
      size: FULL.length,
      read: async (r) => FULL.slice(r.start) // 从区间起点起但尾部超量返回（来源无视 end）
    });
    worker.respond({ id: 1, type: 'search-need', start: 2, end: 6 });
    await flushMicro();
    expect(requests[1]).toEqual({ id: 1, type: 'search-chunk', start: 2, bytes: enc('bbcc') });
    client.dispose();
  });

  it('读失败 → abort：post search-cancel 且 onDone 携 error 与已累计 offsets', async () => {
    const { worker, requests } = fakeWorker();
    const client = new BinaryClient(worker as unknown as Worker);
    let done: SearchDoneInfo | null = null;
    client.search(enc('bb'), {
      size: 8,
      read: async () => {
        throw new Error('io gone');
      },
      onProgress: () => {},
      onDone: (r) => {
        done = r;
      }
    });
    worker.respond({ id: 1, type: 'search-progress', scanned: 0, total: 8, hits: 1, offsets: [2] }); // 预置部分命中
    worker.respond({ id: 1, type: 'search-need', start: 0, end: 4 });
    await flushMicro();
    expect(requests[1]).toEqual({ id: 1, kind: 'search-cancel' }); // worker 侧停发 need
    expect(done).toEqual({ truncated: false, offsets: [2], error: 'io gone' });
    client.dispose();
  });

  it('短读（返回不足请求数）视为读失败 abort', async () => {
    const { worker, requests } = fakeWorker();
    const client = new BinaryClient(worker as unknown as Worker);
    let errMsg: string | undefined;
    client.search(enc('bb'), {
      size: 8,
      read: async () => new Uint8Array(2), // 请求 4 字节只回 2
      onDone: (r) => {
        errMsg = r.error;
      }
    });
    worker.respond({ id: 1, type: 'search-need', start: 0, end: 4 });
    await flushMicro();
    expect(requests.filter((r) => 'type' in r && r.type === 'search-chunk')).toHaveLength(0); // 未回灌 chunk
    expect(requests[1]).toEqual({ id: 1, kind: 'search-cancel' }); // abort 发 cancel
    expect(errMsg).toContain('短读');
    client.dispose();
  });

  it('need 等待超时 → abort（cancel + onDone error）', async () => {
    const { worker, requests } = fakeWorker();
    const client = new BinaryClient(worker as unknown as Worker);
    let errMsg: string | undefined;
    client.search(enc('bb'), {
      size: 8,
      read: () => new Promise<Uint8Array<ArrayBuffer>>(() => {}), // 永不落定（悬挂 read）
      needTimeoutMs: 5, // 测试注入小值
      onDone: (r) => {
        errMsg = r.error;
      }
    });
    worker.respond({ id: 1, type: 'search-need', start: 0, end: 4 });
    await new Promise((r) => setTimeout(r, 25));
    expect(requests[1]).toEqual({ id: 1, kind: 'search-cancel' });
    expect(errMsg).toContain('超时');
    client.dispose();
  });

  it('供给落定前被新搜索取代：迟到 read 结果不回灌、旧回调不再触发', async () => {
    let release: (b: Uint8Array<ArrayBuffer>) => void = () => {};
    const { worker, requests } = fakeWorker();
    const client = new BinaryClient(worker as unknown as Worker);
    let doneA = 0;
    client.search(enc('a'), {
      size: 4,
      read: () => new Promise<Uint8Array<ArrayBuffer>>((res) => (release = res)),
      onDone: () => {
        doneA++;
      }
    });
    worker.respond({ id: 1, type: 'search-need', start: 0, end: 2 });
    client.search(enc('b'), { size: 2, read: async () => new Uint8Array(2), onDone: () => {} }); // 取代旧任务
    release(enc('aa')); // 旧任务供给迟到落定
    await flushMicro();
    expect(requests.some((r) => 'type' in r && r.type === 'search-chunk' && r.id === 1)).toBe(false);
    expect(doneA).toBe(0);
    client.dispose();
  });
});
