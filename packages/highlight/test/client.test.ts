import { describe, it, expect, vi, afterEach } from 'vitest';
import { HighlightClient } from '../src/client';
import { serveWorker } from '../src/worker';
import type { HighlightInterval, HighlightRequest, HighlightResponse } from '../src/types';

// —— init-progress 探针（Task 9 spike）测试装置 ——
// serveWorker 直调形态（worker.test.ts 同款）：stub self/WorkerGlobalScope 后手动驱动，
// TreeSitterEngine.create 以可换装桩代替（真实 Parser.init 走 wasm，非本组用例关注点）。
const engineCreate = vi.hoisted(() => ({
  impl: (..._args: unknown[]): Promise<unknown> => Promise.reject(new Error('engine create 桩未安装')),
}));

vi.mock('../src/core-parse', () => ({
  TreeSitterEngine: {
    create: (...args: unknown[]) => engineCreate.impl(...args),
  },
}));

const interval = (start: number, end: number, capture: string): HighlightInterval => ({
  start,
  end,
  capture,
});

/** 可脚本化回包的假 Worker：postMessage → 异步回发响应（init 握手单独记录）。 */
class FakeWorker {
  onmessage: ((ev: { data: HighlightResponse }) => void) | null = null;
  onerror: ((ev: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
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

  it('第三参 ctx.chunk 透传请求载荷；缺省请求不带 chunk 字段', async () => {
    const { worker, client } = fake();
    await client.highlight('a=1', 'json', { chunk: { startLine: 3, lineCount: 2 } });
    await client.highlight('b=2', 'json');
    // 缺省请求须「无 chunk 键」而非「chunk: undefined」——wire 契约钉死（JSON 序列化
    // 丢弃 undefined 键，服务端旧版兼容判 in 字段而非值）
    expect(worker.requests[0]).toHaveProperty('chunk', { startLine: 3, lineCount: 2 });
    expect(worker.requests[1]).not.toHaveProperty('chunk');
    client.dispose();
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

  describe('初始化看门狗（终审 B3：worker 静默 15s → reject 接通 hljs 兜底）', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('worker 从不回包：15s 后在途请求以普通 Error reject（hljs 兜底），后续请求短路', async () => {
      vi.useFakeTimers();
      const { worker, client } = fake();
      worker.responder = () => {}; // 全部挂起（worker 静默）
      const p = client.highlight('a=1', 'bash');
      const assertion = expect(p).rejects.toThrow('初始化超时');
      await vi.advanceTimersByTimeAsync(15_000);
      await assertion;
      // 短路：后续请求不进 worker、立即失败（普通 Error，非 Canceled）
      await expect(client.highlight('b=2', 'bash')).rejects.toThrow('初始化超时');
      expect(worker.requests).toHaveLength(1);
      client.dispose();
    });

    it('worker 回过任意消息（含 ok:false 报错）后看门狗解除，静默请求不被超时拒绝', async () => {
      const { client, worker } = fake();
      // 先来一次失败回包（真实微任务）：证明 worker 存活
      worker.responder = (_req, reply) => reply({ ok: false, error: 'boom' });
      await expect(client.highlight('x', 'zzz')).rejects.toThrow('boom');
      // 之后挂起 15s（假计时）：不触发初始化超时，仍安静等待（取消归 cancelAll/dispose）
      vi.useFakeTimers();
      worker.responder = () => {};
      let rejectReason: unknown = 'unset';
      void client.highlight('a=1', 'bash').catch((e: unknown) => {
        rejectReason = e;
      });
      await vi.advanceTimersByTimeAsync(15_000);
      expect(rejectReason).toBe('unset');
      client.dispose(); // 收尾：挂起请求以 Canceled reject，worker 终止
      vi.useRealTimers();
    });
  });

  describe('worker 错误可观测（BUG-06：onerror/onmessageerror → 上报 + reject 在途 + 短路）', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('worker.onerror：onWorkerError 收到带 filename 的原因，在途请求 reject，后续请求短路', async () => {
      const worker = new FakeWorker();
      worker.responder = () => {}; // 请求挂起
      const reported: string[] = [];
      const client = new HighlightClient(worker as unknown as Worker, undefined, (r) => reported.push(r));
      const p = client.highlight('a=1', 'bash');
      await vi.waitFor(() => expect(worker.requests).toHaveLength(1));
      worker.onerror?.({
        message: 'worker 脚本崩溃',
        filename: '/_app/immutable/workers/ts-worker-x.js',
      } as ErrorEvent);
      await expect(p).rejects.toThrow('worker 脚本崩溃');
      expect(reported).toHaveLength(1);
      expect(reported[0]).toContain('worker 脚本崩溃');
      expect(reported[0]).toContain('ts-worker-x.js');
      // 短路：worker 已死，后续请求不再发往 worker
      await expect(client.highlight('b=2', 'bash')).rejects.toThrow();
      expect(worker.requests).toHaveLength(1);
      client.dispose();
    });

    it('worker.onmessageerror：在途请求 reject 且原因含 onmessageerror，上报一次', async () => {
      const worker = new FakeWorker();
      worker.responder = () => {};
      const reported: string[] = [];
      const client = new HighlightClient(worker as unknown as Worker, undefined, (r) => reported.push(r));
      const p = client.highlight('a=1', 'bash');
      await vi.waitFor(() => expect(worker.requests).toHaveLength(1));
      worker.onmessageerror?.();
      await expect(p).rejects.toThrow('onmessageerror');
      expect(reported).toHaveLength(1);
      client.dispose();
    });

    it('onerror 后看门狗解除：15s 到点不重复上报、不重复 reject', async () => {
      vi.useFakeTimers();
      const worker = new FakeWorker();
      worker.responder = () => {};
      const reported: string[] = [];
      const client = new HighlightClient(worker as unknown as Worker, undefined, (r) => reported.push(r));
      const p = client.highlight('a=1', 'bash');
      await vi.advanceTimersByTimeAsync(0); // 冲刷微任务让请求入列
      worker.onerror?.({ message: 'script 404' } as ErrorEvent);
      await expect(p).rejects.toThrow('script 404');
      await vi.advanceTimersByTimeAsync(15_000);
      expect(reported).toHaveLength(1); // 看门狗已被首错清除，无双报
      client.dispose();
    });
  });
});

/** serveWorker 桥接 Worker：postMessage 喂 worker 侧 ctx.onmessage（微任务异步，贴近真实消息时序）。 */
class BridgeWorker {
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminated = false;
  /** client → worker 已发消息记录（含 init 握手）：断言线上字节形（debug 键有无）。 */
  sent: unknown[] = [];
  private readonly ctx: { onmessage: ((ev: { data: unknown }) => void) | null };

  constructor(ctx: { onmessage: ((ev: { data: unknown }) => void) | null }) {
    this.ctx = ctx;
  }

  postMessage(msg: unknown): void {
    this.sent.push(msg);
    queueMicrotask(() => this.ctx.onmessage?.({ data: msg }));
  }

  terminate(): void {
    this.terminated = true;
  }
}

/** 安装 serveWorker 并桥接双向消息；返回 worker 桥与 worker → client 帧记录。 */
function installBridge(): { worker: BridgeWorker; frames: unknown[] } {
  const frames: unknown[] = [];
  const ctx: { onmessage: ((ev: { data: unknown }) => void) | null; postMessage: (msg: unknown) => void } = {
    onmessage: null,
    postMessage: () => {},
  };
  const worker = new BridgeWorker(ctx);
  ctx.postMessage = (msg: unknown): void => {
    frames.push(msg);
    worker.onmessage?.({ data: msg });
  };
  vi.stubGlobal('self', ctx);
  vi.stubGlobal('WorkerGlobalScope', class {});
  serveWorker();
  return { worker, frames };
}

describe('init-progress 探针（vvWorkerDebug spike：打点通道，非存活证据）', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('debug 开关下 worker 阶段帧依序透传为 console.debug；进度帧不计存活（看门狗语义不变）', async () => {
    vi.useFakeTimers();
    const debugCalls: unknown[][] = [];
    const spy = vi.spyOn(console, 'debug').mockImplementation((...args: unknown[]) => {
      debugCalls.push(args);
    });
    engineCreate.impl = async (...args: unknown[]) => {
      const opts = args[0] as { onInitProgress?: (p: { stage: string; detail?: string }) => void } | undefined;
      const report = opts?.onInitProgress;
      report?.({ stage: 'wasm-fetch', detail: 'runtimeDir=/x/' });
      report?.({ stage: 'parser-init' });
      report?.({ stage: 'assets', detail: 'queries=2' });
      report?.({ stage: 'ready' });
      // query 逐文件帧（Task 4 细口径）：真实链路在 ready 后首次高亮的远程 fetch 完成时
      // 出现——桩在 highlight 调用时补发，覆盖 ready 之后帧的同通道透传与非存活同口径
      return {
        highlight: (): Promise<never> => {
          report?.({ stage: 'query-loaded', detail: 'bash/highlights.scm' });
          return new Promise(() => {});
        },
      };
    };
    const { worker, frames } = installBridge();
    const client = new HighlightClient(worker as unknown as Worker, { grammarsDir: '/x', debug: true });
    // 握手带 debug: true 键（探针开关上线）
    expect(worker.sent[0]).toStrictEqual({ kind: 'init', grammarsDir: '/x', debug: true });
    const p = client.highlight('a=1', 'bash');
    const watchdog = expect(p).rejects.toThrow('初始化超时');
    await vi.advanceTimersByTimeAsync(0); // 冲刷微任务：init 链跑完、四帧到达、请求派发补发 query-loaded
    // 断言 1：create 各阶段回调 → onInitProgress 依序到达（wasm-fetch/parser-init/assets/ready），
    // 随后请求派发触发 highlight 桩补发 query-loaded（ready 之后的逐文件帧）
    expect(frames.map((f) => (f as { kind?: string }).kind)).toEqual([
      'init-progress',
      'init-progress',
      'init-progress',
      'init-progress',
      'init-progress',
    ]);
    expect(frames[2]).toStrictEqual({ kind: 'init-progress', stage: 'assets', detail: 'queries=2' });
    // query-loaded 帧（每 query 文件一帧，spec §8 细口径）：同一帧类型同一分流
    expect(frames[4]).toStrictEqual({ kind: 'init-progress', stage: 'query-loaded', detail: 'bash/highlights.scm' });
    expect(debugCalls.map((c) => c[1])).toEqual(['wasm-fetch', 'parser-init', 'assets', 'ready', 'query-loaded']);
    expect(debugCalls[0]).toEqual(['[vviewer-worker]', 'wasm-fetch', 'runtimeDir=/x/']);
    expect(debugCalls[2]).toEqual(['[vviewer-worker]', 'assets', 'queries=2']);
    // 进度帧不计为存活证据：markWorkerAlive 未触发，15s 到点看门狗照常拒绝
    await vi.advanceTimersByTimeAsync(15_000);
    await watchdog;
    client.dispose();
    spy.mockRestore();
  });

  it('无 debug 开关：engine 收不到 onInitProgress、线上握手无 debug 键、零探针帧零 console.debug', async () => {
    const debugCalls: unknown[][] = [];
    const spy = vi.spyOn(console, 'debug').mockImplementation((...args: unknown[]) => {
      debugCalls.push(args);
    });
    let seenOpts: unknown;
    engineCreate.impl = async (opts?: unknown) => {
      seenOpts = opts;
      return { highlight: async () => ({ ok: true as const, intervals: [] }) };
    };
    const { worker, frames } = installBridge();
    const client = new HighlightClient(worker as unknown as Worker, { grammarsDir: '/x' });
    await client.highlight('echo hi', 'bash');
    // 断言 2：无 debug 开关时 onInitProgress/onQueryLoaded 恒不被注入——engine 侧回调缺位
    //（键不存在；onQueryLoaded 由 initWorker 仅在 debug 回调注入时派生，缺省零键零打点）
    expect(seenOpts).not.toHaveProperty('onInitProgress');
    expect(seenOpts).not.toHaveProperty('onQueryLoaded');
    // 线上握手无 debug 键（缺省省略而非 debug:false）——协议逐字节不变
    expect(worker.sent[0]).toStrictEqual({ kind: 'init', grammarsDir: '/x' });
    expect(frames.some((f) => (f as { kind?: string }).kind === 'init-progress')).toBe(false);
    expect(debugCalls).toHaveLength(0);
    client.dispose();
    spy.mockRestore();
  });
});
