// RemoteStore rootIndex/basePath 扩展（workspace 多根 T3）：storeId 新编码、
// 旧格式解析兼容、request 拼合与 watch 帧换算。默认形态（根 0、无 basePath）
// 的行为回归由 treeRemote.test.ts 护航，本文件只锁扩展语义。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRemoteStore, parseRemoteStoreId } from '../src/tree/remote';

/** fetch 响应桩（tree 响应） */
function treeResponse(body: unknown, status = 200): unknown {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    headers: { get: () => null }
  };
}

/** fetch 响应桩（file 响应） */
function fileResponse(bytes: Uint8Array): unknown {
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    headers: { get: () => null }
  };
}

/** 按 URL 分流 tree/file 的 fetch 桩 */
function apiFetch(): ReturnType<typeof vi.fn> {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/tree')) {
      return treeResponse({ entries: [{ name: 'a.txt', kind: 'file', size: 1 }] });
    }
    return fileResponse(new Uint8Array([1]));
  });
}

/** EventSource 桩：记录实例与 URL，测试内手动 emit 驱动回调 */
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
}

/** ticket 响应桩 */
function ticketFetch(ticket: string): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/api/ticket')) {
      return { ok: true, status: 200, json: async () => ({ ticket }) };
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as unknown as typeof fetch;
}

/** 刷新微任务队列（ticket 桩立即 resolve，两轮宏任务足够开流） */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** 开一个带 watch 订阅的 store 并返回 EventSource 桩实例 */
async function openWatched(
  opts?: Parameters<typeof createRemoteStore>[3]
): Promise<{ emit: (data: string) => void; seen: string[][]; close: () => void }> {
  vi.stubGlobal('fetch', ticketFetch('tk'));
  vi.stubGlobal('EventSource', FakeEventSource);
  FakeEventSource.reset();
  const store = createRemoteStore('http://127.0.0.1:8399', null, 'srv', opts);
  const seen: string[][] = [];
  store.watch((paths) => seen.push(paths));
  await flush();
  const es = FakeEventSource.instances[0]!;
  return { emit: (data) => es.emit(data), seen, close: () => store.close() };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('RemoteStore storeId 编码（rootIndex/basePath）', () => {
  it('默认 opts（根 0、无 basePath）保持旧格式 remote:<hash8>（会话/资源表兼容）', () => {
    const store = createRemoteStore('http://127.0.0.1:8321', null, 'srv');
    expect(store.id).toMatch(/^remote:[0-9a-f]{8}$/);
    store.close();
  });

  it('rootIndex 编码为 :r<n>；basePath 追加 :<hash8(basePath)>；不同 opts 互异', () => {
    const r1 = createRemoteStore('http://127.0.0.1:8321', null, 'srv', { rootIndex: 1 });
    expect(r1.id).toMatch(/^remote:[0-9a-f]{8}:r1$/);
    const bp = createRemoteStore('http://127.0.0.1:8321', null, 'srv', { basePath: 'docs' });
    expect(bp.id).toMatch(/^remote:[0-9a-f]{8}:r0:[0-9a-f]{8}$/);
    const both = createRemoteStore('http://127.0.0.1:8321', null, 'srv', {
      rootIndex: 2,
      basePath: 'docs/sub'
    });
    expect(both.id).toMatch(/^remote:[0-9a-f]{8}:r2:[0-9a-f]{8}$/);
    // 同 base+label 不同 root/basePath → id 互异（资源表/快照不串源）
    expect(new Set([r1.id, bp.id, both.id]).size).toBe(3);
    r1.close();
    bp.close();
    both.close();
  });
});

describe('parseRemoteStoreId（旧格式解析兼容）', () => {
  it('旧格式：无 :r 段 = r0 无 basePath', () => {
    expect(parseRemoteStoreId('remote:abcd1234')).toEqual({ hash: 'abcd1234', rootIndex: 0 });
  });

  it('新格式：r 段与可选 basePath 哈希段解析', () => {
    expect(parseRemoteStoreId('remote:abcd1234:r3')).toEqual({ hash: 'abcd1234', rootIndex: 3 });
    expect(parseRemoteStoreId('remote:abcd1234:r0:deadbeef')).toEqual({
      hash: 'abcd1234',
      rootIndex: 0,
      basePathHash: 'deadbeef'
    });
  });

  it('非 remote id 返回 null', () => {
    expect(parseRemoteStoreId('localfs:demo')).toBeNull();
    expect(parseRemoteStoreId('placeholder:remote:abcd1234')).toBeNull();
    expect(parseRemoteStoreId('')).toBeNull();
  });

  it('编码→解析往返：hash 段与同 base+label 的旧格式一致（编码只追加后缀）', () => {
    const legacy = createRemoteStore('http://127.0.0.1:8321', null, 'srv');
    const store = createRemoteStore('http://127.0.0.1:8321', null, 'srv', {
      rootIndex: 1,
      basePath: 'docs'
    });
    const parts = parseRemoteStoreId(store.id);
    expect(parts).toEqual({
      hash: legacy.id.slice('remote:'.length),
      rootIndex: 1,
      basePathHash: expect.stringMatching(/^[0-9a-f]{8}$/)
    });
    legacy.close();
    store.close();
  });
});

describe('request 的 root 与 basePath 拼合', () => {
  it('rootIndex=0 不拼 root 参数（既有 URL 形状不变）', async () => {
    const fetchMock = apiFetch();
    vi.stubGlobal('fetch', fetchMock);
    const store = createRemoteStore('http://127.0.0.1:8321', null, 'srv');
    await store.listChildren('sub');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8321/api/tree?path=sub',
      expect.anything()
    );
    store.close();
  });

  it('rootIndex!=0 请求拼 &root=<n>（tree 与 file 同）', async () => {
    const fetchMock = apiFetch();
    vi.stubGlobal('fetch', fetchMock);
    const store = createRemoteStore('http://127.0.0.1:8321', null, 'srv', { rootIndex: 1 });
    await store.listChildren('sub');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8321/api/tree?path=sub&root=1',
      expect.anything()
    );
    await store.read('a.txt');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8321/api/file?path=a.txt&root=1',
      expect.anything()
    );
    store.close();
  });

  it('basePath：listChildren(\'\') 映射为前缀自身；子路径拼前缀；返回节点仍为源相对', async () => {
    const fetchMock = apiFetch();
    vi.stubGlobal('fetch', fetchMock);
    const store = createRemoteStore('http://127.0.0.1:8321', null, 'srv', { basePath: 'docs' });
    await store.listChildren('');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8321/api/tree?path=docs',
      expect.anything()
    );
    const nodes = await store.listChildren('sub');
    expect(fetchMock).toHaveBeenLastCalledWith(
      `http://127.0.0.1:8321/api/tree?path=${encodeURIComponent('docs/sub')}`,
      expect.anything()
    );
    // 服务器返回的 entries 名相对所查目录：节点 path 以调用方的源相对路径拼合
    expect(nodes).toEqual([{ name: 'a.txt', path: 'sub/a.txt', kind: 'file', size: 1 }]);
    store.close();
  });

  it('basePath+rootIndex 组合：前缀与 root 参数并存', async () => {
    const fetchMock = apiFetch();
    vi.stubGlobal('fetch', fetchMock);
    const store = createRemoteStore('http://127.0.0.1:8321', null, 'srv', {
      rootIndex: 2,
      basePath: 'docs'
    });
    await store.read('a.txt');
    expect(fetchMock).toHaveBeenCalledWith(
      `http://127.0.0.1:8321/api/file?path=${encodeURIComponent('docs/a.txt')}&root=2`,
      expect.anything()
    );
    store.close();
  });
});

describe('watch 帧换算（root 过滤 + basePath 剥离）', () => {
  it('rootIndex!=0：带 root 异根帧不回调；无 root 帧（单根服务器省略）照常回调', async () => {
    const w = await openWatched({ rootIndex: 1 });
    w.emit('{"type":"changed","root":0,"paths":["a.txt"]}');
    w.emit('{"type":"changed","root":2,"paths":["a.txt"]}');
    expect(w.seen).toEqual([]);
    // 单根服务器帧省略 root（历史形状）：不过滤——preflight 契约「单根省略=全部接受」
    //（旧半成品按根 0 过滤丢弃，与 brief「带 root 参数的帧才过滤」相悖，已修正）
    w.emit('{"type":"changed","paths":["a.txt","b/c.txt"]}');
    expect(w.seen).toEqual([['a.txt', 'b/c.txt']]);
    w.emit('{"type":"changed","root":1,"paths":["r1.txt"]}');
    expect(w.seen).toEqual([['a.txt', 'b/c.txt'], ['r1.txt']]);
    w.close();
  });

  it('rootIndex=0：异根帧不回调；无 root 帧（单根历史形状）照常回调', async () => {
    const w = await openWatched();
    w.emit('{"type":"changed","root":1,"paths":["a.txt"]}');
    expect(w.seen).toEqual([]);
    w.emit('{"type":"changed","root":0,"paths":["r0.txt"]}');
    w.emit('{"type":"changed","paths":["legacy.txt"]}'); // 单根服务器不带 root
    expect(w.seen).toEqual([['r0.txt'], ['legacy.txt']]);
    w.close();
  });

  it('basePath：路径剥离前缀；前缀不匹配丢弃；前缀自身 → \'\'（目录变更信号）', async () => {
    const w = await openWatched({ basePath: 'docs' });
    w.emit(
      '{"type":"changed","paths":["docs/a.txt","other/b.txt","docsx/c.txt","docs","docs/sub/d.txt"]}'
    );
    // other/ 与 docsx/ 前缀不匹配丢弃；'docs' 自身剥离为空串
    expect(w.seen).toEqual([['a.txt', '', 'sub/d.txt']]);
    w.close();
  });

  it('basePath+rootIndex 组合：先按 root 过滤再剥离前缀', async () => {
    const w = await openWatched({ rootIndex: 1, basePath: 'docs' });
    w.emit('{"type":"changed","root":0,"paths":["docs/a.txt"]}'); // 异根：整体丢弃
    expect(w.seen).toEqual([]);
    w.emit('{"type":"changed","root":1,"paths":["docs/a.txt","x.txt"]}');
    // 同根内：docs/a.txt 剥离为 a.txt；x.txt 前缀不匹配丢弃
    expect(w.seen).toEqual([['a.txt']]);
    w.close();
  });
});
