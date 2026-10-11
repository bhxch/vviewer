// client.test.ts — BinaryClient 消息协议单测（fake Worker，不真起线程）。
import { describe, expect, it, vi } from 'vitest';
import { BinaryClient, type SearchDoneInfo, type SearchProgressInfo } from '../src/client';
import type { BinaryRequest, BinaryWorkerMessage, ParseStructRequest, SearchRequest } from '../src/binary.worker';

/** 记录请求、可手动回灌响应的 fake Worker */
function fakeWorker() {
  const requests: BinaryRequest[] = [];
  const worker = {
    onmessage: null as ((ev: MessageEvent) => void) | null,
    postMessage: vi.fn((req: BinaryRequest) => requests.push(req)),
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

function enc(s: string): Uint8Array {
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
