import { describe, it, expect, afterEach, vi } from 'vitest';
import { serveWorker } from '../src/worker';
import type { HighlightRequest, HighlightResponse } from '../src/types';

/**
 * serveWorker 的 init 失败路径：真实 Worker 环境经 globalThis.self 绑定，
 * 这里注入 fake ctx 后手动派发消息（jsdom 无 WorkerGlobalScope，须一并 stub）。
 * init 失败用 vi.mock 桩掉 TreeSitterEngine.create——真实的 Parser.init 失败
 * 会经 emscripten 内部 promise 泄漏一个与本协议无关的 unhandledrejection，污染断言。
 */

vi.mock('../src/core-parse', () => ({
  TreeSitterEngine: {
    create: async () => {
      throw new Error('init boom');
    },
  },
}));

interface FakeCtx {
  onmessage: ((ev: { data: unknown }) => void) | null;
  postMessage: (msg: HighlightResponse) => void;
}

function installServeWorker(): { ctx: FakeCtx; posted: HighlightResponse[] } {
  const posted: HighlightResponse[] = [];
  const ctx: FakeCtx = {
    onmessage: null,
    postMessage: (msg) => posted.push(msg)
  };
  vi.stubGlobal('self', ctx);
  vi.stubGlobal('WorkerGlobalScope', class {});
  serveWorker();
  return { ctx, posted };
}

const req = (id: number): HighlightRequest => ({ id, text: 'a=1', lang: 'bash' });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('serveWorker init 失败路径', () => {
  it('init 失败且队列空：不产生 unhandledrejection，后续请求仍收到 ok:false', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown): void => {
      unhandled.push(e);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const { ctx, posted } = installServeWorker();
      ctx.onmessage?.({ data: { kind: 'init' } }); // 空队列 init → 失败
      await new Promise((r) => setTimeout(r, 20)); // 等 init promise 走完 reject 路径
      expect(unhandled).toHaveLength(0);
      // handler 保持 rejected：后续请求经 postError 收到错误响应（不被吞）
      ctx.onmessage?.({ data: req(7) });
      await new Promise((r) => setTimeout(r, 10));
      expect(posted).toHaveLength(1);
      expect(posted[0]).toMatchObject({ id: 7, ok: false });
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('init 失败：init 前排队的请求逐个收到 ok:false', async () => {
    const { ctx, posted } = installServeWorker();
    ctx.onmessage?.({ data: req(1) }); // 先于 init 到达 → 排队
    ctx.onmessage?.({ data: req(2) });
    ctx.onmessage?.({ data: { kind: 'init' } }); // init 失败 → 清队列报错
    await new Promise((r) => setTimeout(r, 20));
    expect(posted.map((p) => ({ id: p.id, ok: p.ok }))).toEqual([
      { id: 1, ok: false },
      { id: 2, ok: false }
    ]);
  });

  it('init 失败首错升级 console.error（BUG-06 可观测：显式标签 + 资产排查提示）', async () => {
    const errors: unknown[][] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args);
    });
    try {
      const { ctx } = installServeWorker();
      ctx.onmessage?.({ data: { kind: 'init' } });
      await new Promise((r) => setTimeout(r, 20));
      expect(errors).toHaveLength(1);
      const line = errors[0]!.join(' ');
      expect(line).toContain('tree-sitter worker init 失败');
      expect(line).toContain('404/MIME');
    } finally {
      spy.mockRestore();
    }
  });
});
