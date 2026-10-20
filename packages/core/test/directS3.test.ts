// directS3.test.ts — S3 直连 TreeStore（目录挂载 spec §4 阶段三，plan Task 1）。
// SigV4 纯函数以 AWS 官方向量锚定（与 server/storage/src/s3.rs Rust 实现同例
// 交叉锚：WebCrypto HMAC 输出与 Rust hmac 一致，期望值直接复用 Rust 测试里的
// 签名值）；ListObjectsV2 解析对齐服务端语义（parse_list_v2 字面结构同例）。
// fetch mock 形态照 treeRemote.test.ts 先例（仅含 store 用到的响应面）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import {
  createS3DirectStore,
  parseListV2,
  s3DirectStoreId,
  signS3Get,
  type S3Credentials
} from '../src/tree/directS3';

// jsdom 环境的 crypto 可能缺 subtle（node webcrypto 兜底；生产浏览器恒有）
beforeEach(() => {
  if (!globalThis.crypto?.subtle) vi.stubGlobal('crypto', webcrypto);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const AK = 'AKIAIOSFODNN7EXAMPLE';
const SK = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
const CREDS: S3Credentials = { accessKeyId: AK, secretAccessKey: SK };
/** AWS 官方向量的空载 SHA-256（GET/HEAD payload 恒空）。 */
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

/** XML 响应桩：text + arrayBuffer（ListObjectsV2 用）。 */
function xmlResponse(xml: string, status = 200): unknown {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => xml,
    arrayBuffer: async () => new TextEncoder().encode(xml).buffer as ArrayBuffer,
    headers: { get: () => null }
  };
}

/** 字节响应桩：arrayBuffer + 状态码（Range 206 判定用）。 */
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
  return createS3DirectStore({
    endpoint: 'http://127.0.0.1:9000',
    bucket: 'bkt',
    prefix: 'sub',
    accessKeyId: AK,
    secretAccessKey: SK,
    label: '样例桶'
  });
}

describe('signS3Get（AWS 官方向量交叉锚）', () => {
  it('GET Bucket Lifecycle 向量：authorization 与 Rust 实现同值', async () => {
    const headers = await signS3Get('https://examplebucket.s3.amazonaws.com?lifecycle', CREDS, {
      amzDate: '20130524T000000Z'
    });
    expect(headers.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, ' +
        'SignedHeaders=host;x-amz-content-sha256;x-amz-date, ' +
        'Signature=fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543'
    );
  });

  it('GET Bucket (List Objects) 向量：query 规范化排序（prefix=J&max-keys=2 → max-keys=2&prefix=J）', async () => {
    const headers = await signS3Get(
      'https://examplebucket.s3.amazonaws.com?prefix=J&max-keys=2',
      CREDS,
      { amzDate: '20130524T000000Z' }
    );
    expect(headers.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, ' +
        'SignedHeaders=host;x-amz-content-sha256;x-amz-date, ' +
        'Signature=34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7'
    );
  });

  it('注 x-amz-content-sha256=空载哈希 / x-amz-date / host（非默认端口含端口号）', async () => {
    const headers = await signS3Get('http://127.0.0.1:9000/bkt/a.txt', CREDS, {
      amzDate: '20130524T000000Z'
    });
    expect(headers['x-amz-content-sha256']).toBe(EMPTY_SHA256);
    expect(headers['x-amz-date']).toBe('20130524T000000Z');
    expect(headers.host).toBe('127.0.0.1:9000');
  });

  it('业务头（Range）参与签名：小写化入 SignedHeaders', async () => {
    const headers = await signS3Get('https://examplebucket.s3.amazonaws.com/a.txt', CREDS, {
      amzDate: '20130524T000000Z',
      extraHeaders: { Range: 'bytes=0-3' }
    });
    expect(headers.range).toBe('bytes=0-3');
    expect(headers.authorization).toMatch(
      /SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, /
    );
  });

  it('缺省 amzDate 生成当下 UTC 形态（YYYYMMDDThhmmssZ）', async () => {
    const headers = await signS3Get('https://examplebucket.s3.amazonaws.com', CREDS);
    expect(headers['x-amz-date']).toMatch(/^\d{8}T\d{6}Z$/);
  });
});

describe('parseListV2（与服务端 parse_list_v2 同例对齐）', () => {
  it('字面结构锚：Contents/CommonPrefixes/IsTruncated/NextContinuationToken + 实体反转义', () => {
    const xml = `<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
      <IsTruncated>true</IsTruncated>
      <NextContinuationToken>tok/1=</NextContinuationToken>
      <Contents><Key>sub/a.txt</Key><LastModified>2019-02-19T21:48:39.000Z</LastModified><Size>314</Size></Contents>
      <Contents><Key>sub/b&amp;c.txt</Key></Contents>
      <Contents><Key>sub/m/</Key><Size>0</Size></Contents>
      <CommonPrefixes><Prefix>sub/dir/</Prefix></CommonPrefixes>
    </ListBucketResult>`;
    const page = parseListV2(xml);
    expect(page.files).toEqual([
      { key: 'sub/a.txt', size: 314, mtime: 1_550_612_919_000 },
      { key: 'sub/b&c.txt' },
      { key: 'sub/m/', size: 0 }
    ]);
    expect(page.dirs).toEqual(['sub/dir/']);
    expect(page.isTruncated).toBe(true);
    expect(page.nextToken).toBe('tok/1=');
  });

  it('Contents 缺 Key 抛错（对齐服务端语义）', () => {
    expect(() => parseListV2('<Contents><Size>1</Size></Contents>')).toThrow(/missing <Key>/);
  });
});

describe('createS3DirectStore', () => {
  it('storeId 形态 s3direct:<hash8>，凭据不参与（轮换不改 id）；displayName 取 label', () => {
    const store = testStore();
    expect(store.id).toMatch(/^s3direct:[0-9a-f]{8}$/);
    expect(store.displayName()).toBe('样例桶');
    const rotated = createS3DirectStore({
      endpoint: 'http://127.0.0.1:9000',
      bucket: 'bkt',
      prefix: 'sub',
      accessKeyId: 'other',
      secretAccessKey: 'other',
      label: '样例桶'
    });
    expect(rotated.id).toBe(store.id);
    const other = s3DirectStoreId({
      endpoint: 'http://127.0.0.1:9000',
      bucket: 'bkt2',
      prefix: 'sub'
    });
    expect(other).not.toBe(store.id);
    expect(s3DirectStoreId({ endpoint: 'http://127.0.0.1:9000', bucket: 'bkt', prefix: 'sub' })).toBe(
      store.id
    );
  });

  it('listChildren：分页聚合 + 目录标记对象不浮现 + 目录优先自然序 + prefix 剥离', async () => {
    const page1 = `<ListBucketResult>
      <IsTruncated>true</IsTruncated>
      <NextContinuationToken>tok/1=</NextContinuationToken>
      <Contents><Key>sub/b.txt</Key><LastModified>2019-02-19T21:48:39.000Z</LastModified><Size>314</Size></Contents>
      <Contents><Key>sub/marker/</Key><Size>0</Size></Contents>
      <CommonPrefixes><Prefix>sub/dir2/</Prefix></CommonPrefixes>
      <CommonPrefixes><Prefix>sub/dir10/</Prefix></CommonPrefixes>
    </ListBucketResult>`;
    const page2 = `<ListBucketResult>
      <IsTruncated>false</IsTruncated>
      <Contents><Key>sub/a.txt</Key><Size>7</Size></Contents>
      <Contents><Key>sub/b&amp;c.txt</Key><Size>1</Size></Contents>
    </ListBucketResult>`;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) =>
      String(input).includes('continuation-token') ? xmlResponse(page2) : xmlResponse(page1)
    );
    vi.stubGlobal('fetch', fetchMock);
    const nodes = await testStore().listChildren('');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url1, init1] = fetchMock.mock.calls[0]!;
    const headers1 = init1!.headers as Record<string, string>;
    expect(url1).toBe('http://127.0.0.1:9000/bkt?list-type=2&delimiter=%2F&prefix=sub%2F');
    expect(headers1['x-amz-content-sha256']).toBe(EMPTY_SHA256);
    expect(headers1.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\//);
    const [url2] = fetchMock.mock.calls[1]!;
    expect(url2).toBe(
      'http://127.0.0.1:9000/bkt?list-type=2&delimiter=%2F&prefix=sub%2F&continuation-token=tok%2F1%3D'
    );
    expect(nodes).toEqual([
      { name: 'dir2', path: 'dir2', kind: 'dir' },
      { name: 'dir10', path: 'dir10', kind: 'dir' },
      { name: 'a.txt', path: 'a.txt', kind: 'file', size: 7 },
      { name: 'b&c.txt', path: 'b&c.txt', kind: 'file', size: 1 },
      { name: 'b.txt', path: 'b.txt', kind: 'file', size: 314, mtime: 1_550_612_919_000 }
    ]);
  });

  it('listChildren 子目录路径拼入 list prefix；virtual-host 形态（pathStyle: false）', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      xmlResponse('<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>')
    );
    vi.stubGlobal('fetch', fetchMock);
    const store = createS3DirectStore({
      endpoint: 'http://127.0.0.1:9000',
      bucket: 'bkt',
      accessKeyId: AK,
      secretAccessKey: SK,
      label: 'vhost',
      pathStyle: false
    });
    await store.listChildren('dir/sub');
    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      'http://bkt.127.0.0.1:9000?list-type=2&delimiter=%2F&prefix=dir%2Fsub%2F'
    );
  });

  it('read 全量：GET 对象 URL，字节原样交付，无 Range 头；初始 rangeCapable=true', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => bytesResponse(new Uint8Array([1, 2, 3])));
    vi.stubGlobal('fetch', fetchMock);
    const store = testStore();
    expect(store.rangeCapable).toBe(true);
    const bytes = await store.read('a.txt');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://127.0.0.1:9000/bkt/sub/a.txt');
    expect((init!.headers as Record<string, string>).range).toBeUndefined();
    expect((init!.headers as Record<string, string>).authorization).toBeDefined();
    expect(init!.signal).toBeDefined();
    expect(bytes).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('read Range 206：区间字节原样交付，rangeCapable 保持 true', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      bytesResponse(new Uint8Array([3, 4, 5]), 206, { 'Content-Range': 'bytes 2-4/9' })
    );
    vi.stubGlobal('fetch', fetchMock);
    const store = testStore();
    const bytes = await store.read('a.txt', { range: { start: 2, end: 4 } });
    const [, init] = fetchMock.mock.calls[0]!;
    expect((init!.headers as Record<string, string>).range).toBe('bytes=2-4');
    expect(bytes).toEqual(new Uint8Array([3, 4, 5]));
    expect(store.rangeCapable).toBe(true);
  });

  it('read Range 非 206：从全量响应切出请求窗交付，rangeCapable 翻 false（后续走全量切片通道）', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => bytesResponse(new Uint8Array([1, 2, 3, 4, 5]), 200));
    vi.stubGlobal('fetch', fetchMock);
    const store = testStore();
    const bytes = await store.read('a.txt', { range: { start: 2, end: 4 } });
    expect(bytes).toEqual(new Uint8Array([3, 4, 5]));
    expect(store.rangeCapable).toBe(false);
  });

  it('非 2xx：抛含状态码与错误体片段的 Error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
        xmlResponse('<?xml version="1.0"?><Error><Code>NoSuchKey</Code></Error>', 404)
      )
    );
    await expect(testStore().read('nope.txt')).rejects.toThrow(/HTTP 404.*NoSuchKey/s);
  });

  it('CORS TypeError 特征化：网络层失败报「bucket CORS 未配置或网络不可达」', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      throw new TypeError('Failed to fetch');
    }));
    await expect(testStore().read('a.txt')).rejects.toThrow(
      'S3 直连失败：bucket CORS 未配置或网络不可达'
    );
  });

  it('watch 恒不支持：立即通知 onError，listener 不触发，解绑函数可安全调用', async () => {
    const onError = vi.fn();
    const listener = vi.fn();
    const store = testStore();
    const unsubscribe = store.watch(listener, onError);
    expect(onError).toHaveBeenCalledTimes(1);
    unsubscribe();
    expect(listener).not.toHaveBeenCalled();
  });
});
