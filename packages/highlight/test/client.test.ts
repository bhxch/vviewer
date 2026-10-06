import { describe, it, expect, vi } from 'vitest';
import { HighlightClient } from '../src/client';
import type { HighlightInterval, HighlightRequest, HighlightResponse } from '../src/types';

const interval = (start: number, end: number, capture: string): HighlightInterval => ({
  start,
  end,
  capture,
});

/** 可脚本化回包的假 Worker：postMessage → 异步回发响应（init 握手单独记录）。 */
class FakeWorker {
  onmessage: ((ev: { data: HighlightResponse }) => void) | null = null;
  terminated = false;
  requests: HighlightRequest[] = [];
  inits: Array<{ kind: 'init' }> = [];
  /** 下一批响应脚本：收到请求时依次调用。 */
  responder: (req: HighlightRequest, reply: (res: Omit<HighlightResponse, 'id'>) => void) => void =
    (req, reply) => reply({ ok: true, intervals: [interval(0, req.text.length, 'x')], engine: 'tree-sitter' });

  postMessage(msg: HighlightRequest | { kind: 'init' }): void {
    if ((msg as { kind?: string }).kind === 'init') {
      this.inits.push(msg as { kind: 'init' });
      return;
    }
    const req = msg as HighlightRequest;
    this.requests.push(req);
    queueMicrotask(() => {
      if (this.terminated) return;
      this.responder(req, (res) => this.onmessage?.({ data: { ...res, id: req.id } }));
    });
  }
  terminate(): void {
    this.terminated = true;
  }
}

const fake = (): { worker: FakeWorker; client: HighlightClient } => {
  const worker = new FakeWorker();
  const client = new HighlightClient(worker as unknown as Worker);
  return { worker, client };
};

describe('HighlightClient', () => {
  it('highlight 返回区间并回传成功结果', async () => {
    const { client } = fake();
    const out = await client.highlight('echo hi', 'bash');
    expect(out).toEqual([interval(0, 7, 'x')]);
  });

  it('构造时发送 init 握手（携带 WorkerInit），且先于任何请求', async () => {
    const worker = new FakeWorker();
    const client = new HighlightClient(worker as unknown as Worker, {
      grammarsDir: '/x',
      maxInjectionDepth: 2,
    });
    try {
      await client.highlight('echo hi', 'bash');
      expect(worker.inits).toHaveLength(1);
      expect(worker.inits[0]).toMatchObject({ kind: 'init', grammarsDir: '/x', maxInjectionDepth: 2 });
      expect(worker.requests).toHaveLength(1);
    } finally {
      client.dispose();
    }
  });

  it('同 lang 连续请求：前一个未完成请求被取消（reject Canceled），后一个成功', async () => {
    const { worker, client } = fake();
    // 第一次请求挂起：responder 永不回包
    worker.responder = (req, reply) => {
      if (req.id === 1) return; // 挂起
      reply({ ok: true, intervals: [interval(0, 1, 'second')], engine: 'tree-sitter' });
    };
    const first = client.highlight('a=1', 'bash');
    await vi.waitFor(() => expect(worker.requests.length).toBe(1));
    const second = client.highlight('b=2', 'bash');
    await expect(first).rejects.toThrow();
    await expect(second).resolves.toEqual([interval(0, 1, 'second')]);
  });

  it('不同 lang 的未完成请求互不影响', async () => {
    const { client, worker } = fake();
    worker.responder = () => {}; // 全部挂起
    const p1 = client.highlight('a=1', 'bash');
    const p2 = client.highlight('x=1', 'python');
    const p3 = client.highlight('b=2', 'bash'); // 取消 p1
    await expect(p1).rejects.toThrow();
    expect(worker.requests.map((r) => r.lang)).toEqual(['bash', 'python', 'bash']);
    p2.catch(() => {});
    p3.catch(() => {});
    client.cancelAll();
    await expect(p2).rejects.toThrow();
    await expect(p3).rejects.toThrow();
  });

  it('worker 报 ok:false 时 highlight reject', async () => {
    const { worker, client } = fake();
    worker.responder = (_req, reply) => reply({ ok: false, error: 'no grammar' });
    await expect(client.highlight('x', 'zzz')).rejects.toThrow('no grammar');
  });

  it('cancelAll 后 dispose 终止 worker', async () => {
    const { worker, client } = fake();
    worker.responder = () => {};
    const p = client.highlight('a=1', 'bash');
    p.catch(() => {});
    client.cancelAll();
    await expect(p).rejects.toThrow();
    client.dispose();
    expect(worker.terminated).toBe(true);
    // dispose 后再调用直接 reject
    await expect(client.highlight('a=1', 'bash')).rejects.toThrow();
  });
});
