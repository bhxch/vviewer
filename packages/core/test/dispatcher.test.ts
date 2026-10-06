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
    reg.install(mk('archive', ['zip'], {
      sniff: () => { archiveCalls++; return 'text'; }, // 即使再要求重定向也不再发生
      render: async () => { return { destroy() {} }; }
    }));
    const target = document.createElement('div');
    const { rendererId } = await createDispatcher(reg).dispatch(
      { storeId: 's', storeLabel: 's', path: 'a.txt', name: 'a.txt', store: {} as never },
      new TextEncoder().encode('hi'), target);
    expect(rendererId).toBe('archive');
    expect(zipCalls).toBe(1);
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
