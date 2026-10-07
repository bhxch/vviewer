import { describe, it, expect } from 'vitest';
import { createRegistry } from '../src/registry/registry';
import { createDispatcher } from '../src/dispatch/dispatcher';
import type { Renderer } from '../src/types';

const mk = (id: string, exts: string[], over: Partial<Renderer> = {}): Renderer => ({
  id, label: id, extensions: exts, render: async () => ({ destroy() {} }), ...over
});

describe('dispatcher', () => {
  it('routes by extension', async () => {
    const reg = createRegistry();
    let called = '';
    reg.install(mk('text', ['txt'], { render: async () => { called = 'text'; return { destroy() {} }; } }));
    const target = document.createElement('div');
    const { rendererId } = await createDispatcher(reg).dispatch(
      { storeId: 's', storeLabel: 's', path: 'a.txt', name: 'a.txt', store: {} as never },
      new TextEncoder().encode('hi'), target);
    expect(rendererId).toBe('text');
    expect(called).toBe('text');
  });
  it('sniff redirect happens once', async () => {
    const reg = createRegistry();
    let zipCalls = 0;
    reg.install(mk('fake', ['txt'], {
      sniff: () => { zipCalls++; return 'archive'; }
    }));
    let archiveCalls = 0;
    let archiveRendered = false;
    reg.install(mk('archive', ['zip'], {
      // 二次 sniff 返回已注册的 'text'：若派发器错误地二次改派，rendererId 会漂到 text——
      // 该用例钉住「第二次 sniff 可解析但不改派」（M1 deferred minor）
      sniff: () => { archiveCalls++; return 'text'; },
      render: async () => { archiveRendered = true; return { destroy() {} }; }
    }));
    let textRendered = false;
    reg.install(mk('text', ['log'], {
      render: async () => { textRendered = true; return { destroy() {} }; }
    }));
    const target = document.createElement('div');
    const { rendererId } = await createDispatcher(reg).dispatch(
      { storeId: 's', storeLabel: 's', path: 'a.txt', name: 'a.txt', store: {} as never },
      new TextEncoder().encode('hi'), target);
    expect(rendererId).toBe('archive');
    expect(archiveRendered).toBe(true);
    expect(textRendered).toBe(false);
    expect(zipCalls).toBe(1);
    // 恰一次：redirect 后为最终 renderer 补充 sniff 元数据的调用，返回值被忽略
    expect(archiveCalls).toBe(1);
  });
  it('falls back to error renderer for unknown ext', async () => {
    const reg = createRegistry();
    const target = document.createElement('div');
    const { rendererId } = await createDispatcher(reg).dispatch(
      { storeId: 's', storeLabel: 's', path: 'x.unknownext', name: 'x.unknownext', store: {} as never },
      new Uint8Array([1,2,3]), target);
    expect(rendererId).toBe('error');
    expect(target.textContent).toContain('unknownext');
  });
  it('falls back to error renderer when render throws', async () => {
    const reg = createRegistry();
    reg.install(mk('boom', ['txt'], { render: async () => { throw new Error('boom'); } }));
    const target = document.createElement('div');
    const { rendererId } = await createDispatcher(reg).dispatch(
      { storeId: 's', storeLabel: 's', path: 'a.txt', name: 'a.txt', store: {} as never },
      new TextEncoder().encode('hi'), target);
    expect(rendererId).toBe('error');
    expect(target.textContent).toContain('boom');
  });
});
