import { describe, it, expect, vi, afterEach } from 'vitest';
import { createSingleFileStore } from '../src/tree/singleFile';
import { createUrlStore } from '../src/tree/singleFile';

describe('createSingleFileStore', () => {
  it('reads file bytes and lists single root node', async () => {
    const file = new File([new Uint8Array([1, 2, 3])], 'a.bin');
    const store = createSingleFileStore(file);
    expect(store.id.startsWith('single:a.bin:3:')).toBe(true);
    expect(store.displayName()).toBe('a.bin');
    const nodes = await store.listChildren('');
    // 注：实现携带 mtime（File.lastModified），比 brief 原测试多断言该字段
    expect(nodes).toEqual([
      { name: 'a.bin', path: 'a.bin', kind: 'file', size: 3, mtime: file.lastModified }
    ]);
    expect(await store.read('a.bin')).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('rejects unknown path', async () => {
    const store = createSingleFileStore(new File([new Uint8Array([1])], 'a.bin'));
    await expect(store.read('b.bin')).rejects.toThrow('未知路径: b.bin');
  });
});

describe('createUrlStore', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches bytes lazily and derives node name from url', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => new Uint8Array([9, 8, 7]).buffer
    }));
    vi.stubGlobal('fetch', fetchMock);
    const store = createUrlStore('https://example.com/dir/log%20file.txt?v=1');
    expect(store.id).toMatch(/^url:[0-9a-f]{8}$/);
    expect(store.displayName()).toBe('https://example.com/dir/log%20file.txt?v=1');
    expect(await store.listChildren('')).toEqual([
      { name: 'log file.txt', path: 'log file.txt', kind: 'file' }
    ]);
    expect(await store.read('log file.txt')).toEqual(new Uint8Array([9, 8, 7]));
    expect(fetchMock).toHaveBeenCalledWith('https://example.com/dir/log%20file.txt?v=1');
  });

  it('throws with reason on http failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) }))
    );
    const store = createUrlStore('https://example.com/missing.txt');
    await expect(store.read('missing.txt')).rejects.toThrow('HTTP 404');
  });
});
