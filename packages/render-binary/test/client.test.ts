// client.test.ts — BinaryClient 消息协议单测（fake Worker，不真起线程）。
import { describe, expect, it, vi } from 'vitest';
import { BinaryClient } from '../src/client';
import type { BinaryRequest, BinaryResponse } from '../src/binary.worker';

/** 记录请求、可手动回灌响应的 fake Worker */
function fakeWorker() {
  const requests: BinaryRequest[] = [];
  const worker = {
    onmessage: null as ((ev: MessageEvent) => void) | null,
    postMessage: vi.fn((req: BinaryRequest) => requests.push(req)),
    terminate: vi.fn(),
    respond(res: BinaryResponse): void {
      worker.onmessage?.({ data: res } as MessageEvent);
    }
  };
  return { worker, requests };
}

describe('BinaryClient', () => {
  it('请求 id 递增配对响应', async () => {
    const { worker, requests } = fakeWorker();
    const client = new BinaryClient(worker as unknown as Worker);
    const p1 = client.parseStruct(new Uint8Array([0x89, 0x50]), 100);
    const p2 = client.parseStruct(new Uint8Array([0x7f, 0x45]), 200);
    expect(requests.map((r) => r.id)).toEqual([1, 2]);
    expect(requests[1]!.budgetMs).toBe(200);
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
