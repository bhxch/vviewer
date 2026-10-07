import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRemoteStore, getRemoteBase, getRemoteMeta, normalizeServerBase } from '../src/tree/remote';

/** fetch 响应桩（tree 响应）：仅含 store 用到的 ok/status/json/headers.get */
function treeResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {}
): unknown {
  const map = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    headers: { get: (name: string) => map.get(name.toLowerCase()) ?? null }
  };
}

/** fetch 响应桩（file 响应）：arrayBuffer + X-VV-* 检测头 */
function fileResponse(bytes: Uint8Array, headers: Record<string, string> = {}): unknown {
  const map = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    headers: { get: (name: string) => map.get(name.toLowerCase()) ?? null }
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createRemoteStore', () => {
  it('derives id from base+label hash and reports dirLabel', () => {
    const store = createRemoteStore('http://127.0.0.1:8321/', null, '样例');
    expect(store.id).toMatch(/^remote:[0-9a-f]{8}$/);
    expect(store.displayName()).toBe('样例');
  });

  it('records the server base for the created store (M7 reconnect recovery)', () => {
    const store = createRemoteStore('http://127.0.0.1:8321/', null, 'srv');
    expect(getRemoteBase(store.id)).toBe('http://127.0.0.1:8321');
    expect(getRemoteBase('localfs:nope')).toBeUndefined();
  });

  it('listChildren GETs /api/tree with Bearer and maps nodes', async () => {
    const fetchMock = vi.fn(async () =>
      treeResponse({
        entries: [
          { name: 'sample.js', kind: 'file', size: 3, mtime: 123 },
          { name: 'sub', kind: 'dir' }
        ]
      })
    );
    vi.stubGlobal('fetch', fetchMock);
    const store = createRemoteStore('http://127.0.0.1:8321', 'tok-1', 'srv');
    const nodes = await store.listChildren('sub');
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:8321/api/tree?path=sub', {
      headers: { authorization: 'Bearer tok-1' }
    });
    expect(nodes).toEqual([
      { name: 'sample.js', path: 'sub/sample.js', kind: 'file', size: 3, mtime: 123 },
      { name: 'sub', path: 'sub/sub', kind: 'dir' }
    ]);
  });

  it('omits authorization header when token is null', async () => {
    const fetchMock = vi.fn(async () => treeResponse({ entries: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const store = createRemoteStore('http://127.0.0.1:8321', null, 'srv');
    await store.listChildren('');
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:8321/api/tree?path=', {
      headers: {}
    });
  });

  it('percent-encodes the path parameter', async () => {
    const fetchMock = vi.fn(async () => treeResponse({ entries: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const store = createRemoteStore('http://127.0.0.1:8321', null, 'srv');
    await store.listChildren('a b/中文.txt');
    expect(fetchMock).toHaveBeenCalledWith(
      `http://127.0.0.1:8321/api/tree?path=${encodeURIComponent('a b/中文.txt')}`,
      { headers: {} }
    );
  });

  it.each([401, 403, 404])('throws with status code on HTTP %d', async (status) => {
    vi.stubGlobal('fetch', vi.fn(async () => treeResponse({ error: 'nope' }, status)));
    const store = createRemoteStore('http://127.0.0.1:8321', 'tok', 'srv');
    await expect(store.listChildren('x')).rejects.toThrow(`HTTP ${status}`);
  });

  it('read GETs /api/file, returns bytes, and stores X-VV meta', async () => {
    const fetchMock = vi.fn(async () =>
      fileResponse(new Uint8Array([1, 2, 3]), { 'X-VV-Lang': 'python', 'X-VV-Encoding': 'gb18030' })
    );
    vi.stubGlobal('fetch', fetchMock);
    const store = createRemoteStore('http://127.0.0.1:8321', 'tok', 'meta-srv');
    const bytes = await store.read('a.py');
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:8321/api/file?path=a.py', {
      headers: { authorization: 'Bearer tok' }
    });
    expect(bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(getRemoteMeta(store.id, 'a.py')).toEqual({ lang: 'python', encoding: 'gb18030' });
  });

  it('read without X-VV headers leaves no meta', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fileResponse(new Uint8Array([9]))));
    const store = createRemoteStore('http://127.0.0.1:8321', null, 'nometa-srv');
    await store.read('plain.txt');
    expect(getRemoteMeta(store.id, 'plain.txt')).toBeUndefined();
  });

  it('read with lang-only header stores partial meta', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => fileResponse(new Uint8Array([9]), { 'x-vv-lang': 'rust' }))
    );
    const store = createRemoteStore('http://127.0.0.1:8321', null, 'langonly-srv');
    await store.read('Makefile');
    expect(getRemoteMeta(store.id, 'Makefile')).toEqual({ lang: 'rust' });
  });

  it('read errors carry the status code', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 404,
        json: async () => ({ error: 'path not found' }),
        headers: { get: () => null }
      }))
    );
    const store = createRemoteStore('http://127.0.0.1:8321', null, 'err-srv');
    await expect(store.read('missing.txt')).rejects.toThrow('HTTP 404');
  });
});

describe('normalizeServerBase', () => {
  it('prepends http:// when scheme missing and strips trailing slashes', () => {
    expect(normalizeServerBase('127.0.0.1:8321')).toBe('http://127.0.0.1:8321');
    expect(normalizeServerBase('localhost:8321/')).toBe('http://localhost:8321');
    expect(normalizeServerBase(' http://a.b:80/ ')).toBe('http://a.b:80');
    expect(normalizeServerBase('https://example.com')).toBe('https://example.com');
  });
});
