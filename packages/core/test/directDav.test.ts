// directDav.test.ts — WebDAV 直连 TreeStore（目录挂载 spec §4 阶段三，plan Task 1）。
// multistatus 解析走 DOMParser（命名空间感知——d:/D: 双前缀同解析）；PROPFIND
// Depth:1 自身条目跳过、集合双信号、Basic auth 头与 server/storage/src/webdav.rs
// 服务端语义同构；fetch mock 形态照 treeRemote.test.ts 先例。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { createDavDirectStore, davDirectStoreId, parseMultistatus } from '../src/tree/directDav';
import { contentRangeMatches } from '../src/tree/directS3';

// jsdom 环境的 crypto 可能缺 subtle（node webcrypto 兜底；与 directS3.test.ts
// 同防线，防模块内依赖漂移）
beforeEach(() => {
  if (!globalThis.crypto?.subtle) vi.stubGlobal('crypto', webcrypto);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const PROPFIND_XML = `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response><D:href>/dav/docs/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop></D:propstat></D:response>
  <D:response><D:href>/dav/docs/sub%20dir/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop></D:propstat></D:response>
  <d:response xmlns:d="DAV:"><d:href>/dav/docs/a%20b.txt</d:href><d:propstat><d:prop><d:resourcetype/><d:getcontentlength>33</d:getcontentlength><d:getlastmodified>Fri, 24 May 2013 00:00:00 GMT</d:getlastmodified></d:prop></d:propstat></d:response>
  <D:response><D:href>/dav/docs/taildir/</D:href><D:propstat><D:prop><D:resourcetype/></D:prop></D:propstat></D:response>
</D:multistatus>`;

function xmlResponse(xml: string, status = 207): unknown {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => xml,
    arrayBuffer: async () => new TextEncoder().encode(xml).buffer as ArrayBuffer,
    headers: { get: () => null }
  };
}

function bytesResponse(bytes: Uint8Array, status = 200, headers: Record<string, string> = {}): unknown {
  const map = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: status >= 200 && status < 300,
    status,
    arrayBuffer: async () =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    text: async () => '',
    headers: { get: (name: string) => map.get(name.toLowerCase()) ?? null }
  };
}

function testStore() {
  return createDavDirectStore({
    endpoint: 'http://127.0.0.1:8333/dav',
    prefix: 'docs',
    username: 'u',
    password: 'p',
    label: '文献库'
  });
}

describe('parseMultistatus（DOMParser 命名空间感知）', () => {
  it('双前缀解析：D: 与 d:（均绑定 DAV:）混合同解析；href 实体+百分号解码', () => {
    const entries = parseMultistatus(
      `<?xml version="1.0"?><ms xmlns:D="DAV:" xmlns:d="DAV:">` +
        `<D:response><D:href>/a&amp;b/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop></D:propstat></D:response>` +
        `<d:response><d:href>/a%20b.txt</d:href><d:propstat><d:prop><d:getcontentlength>3</d:getcontentlength><d:getlastmodified>Fri, 24 May 2013 00:00:00 GMT</d:getlastmodified></d:prop></d:propstat></d:response>` +
        `</ms>`
    );
    expect(entries).toEqual([
      { href: '/a&b/', isCollection: true },
      { href: '/a b.txt', isCollection: false, size: 3, mtime: 1_369_353_600_000 }
    ]);
  });

  it('病态 XML（parsererror）返回空数组不抛错', () => {
    expect(parseMultistatus('<not well-formed')).toEqual([]);
  });
});

describe('createDavDirectStore', () => {
  it('storeId 形态 davdirect:<hash8>，凭据不参与；displayName 取 label', () => {
    const store = testStore();
    expect(store.id).toMatch(/^davdirect:[0-9a-f]{8}$/);
    expect(store.displayName()).toBe('文献库');
    expect(
      davDirectStoreId({ endpoint: 'http://127.0.0.1:8333/dav', prefix: 'docs' })
    ).toBe(store.id);
    expect(
      davDirectStoreId({ endpoint: 'http://127.0.0.1:8333/dav', prefix: 'other' })
    ).not.toBe(store.id);
  });

  it('listChildren：PROPFIND Depth:1 + Basic 头 + propfind body；自身条目跳过、集合双信号、目录优先', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => xmlResponse(PROPFIND_XML));
    vi.stubGlobal('fetch', fetchMock);
    const nodes = await testStore().listChildren('');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://127.0.0.1:8333/dav/docs/');
    expect(init!.method).toBe('PROPFIND');
    const headers = init!.headers as Record<string, string>;
    expect(headers.depth).toBe('1');
    expect(headers['content-type']).toBe('application/xml');
    expect(headers.authorization).toBe('Basic dTpw'); // base64('u:p')
    expect(String(init!.body)).toContain('<d:propfind xmlns:d="DAV:">');
    expect(nodes).toEqual([
      { name: 'sub dir', path: 'sub dir', kind: 'dir' },
      { name: 'taildir', path: 'taildir', kind: 'dir' },
      { name: 'a b.txt', path: 'a b.txt', kind: 'file', size: 33, mtime: 1_369_353_600_000 }
    ]);
  });

  it('listChildren 子路径拼入集合 URL 且逐段编码', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => xmlResponse(PROPFIND_XML));
    vi.stubGlobal('fetch', fetchMock);
    await testStore().listChildren('x y');
    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://127.0.0.1:8333/dav/docs/x%20y/');
  });

  it('read 全量：GET 资源 URL + Basic 头，字节原样交付；初始 rangeCapable=true', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => bytesResponse(new Uint8Array([9, 8, 7])));
    vi.stubGlobal('fetch', fetchMock);
    const store = testStore();
    expect(store.rangeCapable).toBe(true);
    const bytes = await store.read('a b.txt');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://127.0.0.1:8333/dav/docs/a%20b.txt');
    expect(init!.method).toBe('GET');
    expect((init!.headers as Record<string, string>).authorization).toBe('Basic dTpw');
    expect(init!.signal).toBeDefined();
    expect(bytes).toEqual(new Uint8Array([9, 8, 7]));
  });

  it('read Range 206：区间字节原样交付；rangeCapable 保持 true', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      bytesResponse(new Uint8Array([3, 4, 5]), 206, { 'Content-Range': 'bytes 2-4/9' })
    );
    vi.stubGlobal('fetch', fetchMock);
    const store = testStore();
    const bytes = await store.read('f.bin', { range: { start: 2, end: 4 } });
    const [, init] = fetchMock.mock.calls[0]!;
    expect((init!.headers as Record<string, string>).range).toBe('bytes=2-4');
    expect(bytes).toEqual(new Uint8Array([3, 4, 5]));
    expect(store.rangeCapable).toBe(true);
  });

  it('read Range 非 206：从全量响应切出请求窗，rangeCapable 翻 false', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => bytesResponse(new Uint8Array([9, 8, 7, 6, 5]), 200));
    vi.stubGlobal('fetch', fetchMock);
    const store = testStore();
    const bytes = await store.read('f.bin', { range: { start: 1, end: 3 } });
    expect(bytes).toEqual(new Uint8Array([8, 7, 6]));
    expect(store.rangeCapable).toBe(false);
  });

  it('read Range 206 + Content-Range 可读但窗段不符：重取全量切窗交付，rangeCapable 翻 false（M1 防线，评审带入②）', async () => {
    // dav 部分服务器忽略/错答 Range 的病态面：206 + 窗段与请求不符（可读头）
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      (init!.headers as Record<string, string>).range !== undefined
        ? bytesResponse(new Uint8Array([9, 9, 9]), 206, { 'Content-Range': 'bytes 0-2/9' })
        : bytesResponse(new Uint8Array([9, 8, 7, 6, 5]), 200)
    );
    vi.stubGlobal('fetch', fetchMock);
    const store = testStore();
    const bytes = await store.read('f.bin', { range: { start: 1, end: 3 } });
    expect(bytes).toEqual(new Uint8Array([8, 7, 6])); // 重取全量后切出正确窗
    expect(store.rangeCapable).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, init2] = fetchMock.mock.calls[1]!;
    expect((init2!.headers as Record<string, string>).range).toBeUndefined(); // 重取无 Range
  });

  it('read Range 206 + Content-Range 不可读（CORS 未 expose）：保持 status 判定（既有行为零变化）', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      bytesResponse(new Uint8Array([3, 4, 5]), 206)
    );
    vi.stubGlobal('fetch', fetchMock);
    const store = testStore();
    expect(await store.read('f.bin', { range: { start: 2, end: 4 } })).toEqual(new Uint8Array([3, 4, 5]));
    expect(store.rangeCapable).toBe(true);
  });

  it('contentRangeMatches 复用 directS3 同一纯函数（双端同口径）', () => {
    expect(contentRangeMatches('bytes 1-3/9', 1, 3)).toBe(true);
    expect(contentRangeMatches(null, 1, 3)).toBeNull();
  });

  it('PROPFIND 401：抛含 401 与认证提示的 Error', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => xmlResponse('<error/>', 401)));
    await expect(testStore().listChildren('')).rejects.toThrow(/401.*认证/s);
  });

  it('CORS TypeError 特征化：网络层失败报 CORS 未配置或网络不可达', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      throw new TypeError('Failed to fetch');
    }));
    await expect(testStore().read('a.txt')).rejects.toThrow(/CORS 未配置或网络不可达/);
  });

  it('watch 恒不支持：立即通知 onError，listener 不触发，解绑函数可安全调用', () => {
    const onError = vi.fn();
    const listener = vi.fn();
    const unsubscribe = testStore().watch(listener, onError);
    expect(onError).toHaveBeenCalledTimes(1);
    unsubscribe();
    expect(listener).not.toHaveBeenCalled();
  });
});
