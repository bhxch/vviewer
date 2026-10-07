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

/** EventSource 桩：记录实例与 URL，测试内手动 emit/fail 驱动回调 */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  static reset(): void {
    FakeEventSource.instances = [];
  }
  url: string;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  close(): void {
    this.closed = true;
  }
  emit(data: string): void {
    if (!this.closed) this.onmessage?.({ data });
  }
  fail(): void {
    if (!this.closed) this.onerror?.();
  }
}

/** ticket 响应桩：区分 /api/ticket 与其他请求 */
function ticketFetch(ticket: string | null): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/api/ticket')) {
      if (ticket === null) return { ok: false, status: 500, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ ticket }) };
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as unknown as typeof fetch;
}

/** 刷新微任务队列（ticket fetch 桩立即 resolve，两轮宏任务足够开流） */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('createRemoteStore watch/close（M5 SSE 变更订阅）', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('watch 换票（带 Bearer）后开 /api/events 流，changed 帧通知监听器', async () => {
    const fetchMock = vi.fn(ticketFetch('tk-1'));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('EventSource', FakeEventSource);
    FakeEventSource.reset();
    const store = createRemoteStore('http://127.0.0.1:8399', 'e2etoken', 'srv');
    const seen: string[][] = [];
    store.watch((paths) => seen.push(paths));
    await flush();
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:8399/api/ticket', {
      method: 'POST',
      headers: { authorization: 'Bearer e2etoken' }
    });
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0]!.url).toBe('http://127.0.0.1:8399/api/events?ticket=tk-1');
    FakeEventSource.instances[0]!.emit('{"type":"changed","paths":["sample.js","sub/inner.txt"]}');
    expect(seen).toEqual([['sample.js', 'sub/inner.txt']]);
    store.close();
  });

  it('无 token 时换票请求不带 authorization 头', async () => {
    const fetchMock = vi.fn(ticketFetch('tk-0'));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('EventSource', FakeEventSource);
    FakeEventSource.reset();
    const store = createRemoteStore('http://127.0.0.1:8399', null, 'srv');
    store.watch(() => {});
    await flush();
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:8399/api/ticket', {
      method: 'POST',
      headers: {}
    });
    store.close();
  });

  it('换票失败退避重试；错误帧后手动重开并换新票（ticket 一次性，原生重连会永远 401）', async () => {
    vi.useFakeTimers();
    // 首次换票失败，之后每次发新票
    const tickets: (string | null)[] = [null, 'tk-2', 'tk-3'];
    const fetchMock = vi.fn((async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/ticket')) {
        const t = tickets.length > 0 ? tickets.shift()! : 'tk-late'; // 注意 ?? 会把队列里的 null 也吃掉
        if (t === null) return { ok: false, status: 500, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => ({ ticket: t }) };
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch);
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('EventSource', FakeEventSource);
    FakeEventSource.reset();
    const store = createRemoteStore('http://127.0.0.1:8399', null, 'srv');
    store.watch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeEventSource.instances).toHaveLength(0); // 首次换票失败：不开流
    await vi.advanceTimersByTimeAsync(1000); // 1s 退避后重试，这次成功
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(FakeEventSource.instances).toHaveLength(1);
    const first = FakeEventSource.instances[0]!;
    expect(first.url).toBe('http://127.0.0.1:8399/api/events?ticket=tk-2');
    first.emit('{"type":"changed","paths":["a.txt"]}');
    first.fail(); // 连接断开：应关掉并重新换票开新流
    expect(first.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeEventSource.instances).toHaveLength(2); // 新票新流
    expect(FakeEventSource.instances[1]!.url).toBe('http://127.0.0.1:8399/api/events?ticket=tk-3');
    store.close();
  });

  it('watch-error 帧（服务端 watch 降级）断流且不再重连', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(ticketFetch('tk-w')));
    vi.stubGlobal('EventSource', FakeEventSource);
    FakeEventSource.reset();
    const store = createRemoteStore('http://127.0.0.1:8399', null, 'srv');
    store.watch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    const es = FakeEventSource.instances[0]!;
    es.emit('{"type":"watch-error"}');
    expect(es.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeEventSource.instances).toHaveLength(1); // 无重连
    store.close();
  });

  it('解绑后不再通知；close() 关流且阻断重连', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(ticketFetch('tk-c')));
    vi.stubGlobal('EventSource', FakeEventSource);
    FakeEventSource.reset();
    const store = createRemoteStore('http://127.0.0.1:8399', null, 'srv');
    const seen: string[][] = [];
    const un = store.watch((paths) => seen.push(paths));
    await vi.advanceTimersByTimeAsync(0);
    const es = FakeEventSource.instances[0]!;
    un();
    es.emit('{"type":"changed","paths":["x.txt"]}');
    expect(seen).toEqual([]);
    store.close();
    expect(es.closed).toBe(true);
    es.fail(); // close 后连接错误也不得重连
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeEventSource.instances).toHaveLength(1);
  });
});
