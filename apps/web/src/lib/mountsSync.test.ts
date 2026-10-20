// mountsSync.test.ts — 代理挂载前端持久化与连接对账（目录挂载 spec 2026-10-19 §3，
// plan Task 2）。IndexedDB 用 fake-indexeddb（每用例全新库），网络面 stub 全局
// fetch 按 method+URL 路由；挂载根 watch 态判定（serverHealthCache.isMountRootStoreId）
// 与 session v3→v4 迁移用例按 brief 的 Task 2 测试清单就近收编本文件。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import {
  deleteDirectMount,
  displayEndpoint,
  listDirectMounts,
  listProxyMounts,
  mountFingerprintOf,
  saveDirectMount,
  saveProxyMount,
  syncMountsOnConnect,
  type DirectMountRecord,
  type MountManifestEntry,
  type ProxyMountRecord
} from './mountsSync';
import { isMountRootStoreId } from './serverHealthCache';

// ---------- fetch 路由桩 ----------

interface RecordedCall {
  method: string;
  url: string;
  body?: unknown;
  headers: Record<string, string>;
}

let calls: RecordedCall[] = [];
type FetchHandler = (method: string, url: string, body: unknown, headers: Record<string, string>) => Response | undefined;

/**
 * stubFetch：handler 按 method+url 返回 Response；返回 undefined 视为「未模拟
 * 请求」抛错（测试里断言不应发出的请求会以未模拟异常显式暴露）。
 */
function stubFetch(handler: FetchHandler): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const raw = init?.body;
      let body: unknown;
      if (typeof raw === 'string' && raw !== '') {
        try {
          body = JSON.parse(raw);
        } catch {
          body = raw;
        }
      }
      calls.push({ method, url, body, headers });
      const res = handler(method, url, body, headers);
      if (res === undefined) throw new Error(`unmocked ${method} ${url}`);
      return res;
    })
  );
}

/** 无 body 响应（204 等——undici Response 构造器拒绝带 body 的 204）。 */
function emptyResponse(status: number): Response {
  return new Response(null, { status });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

/** 唯一记录读取（断言恰好一条后返回，消解索引访问的 undefined 严格性）。 */
async function onlyRecord(): Promise<ProxyMountRecord> {
  const all = await listProxyMounts();
  expect(all).toHaveLength(1);
  return all[0]!;
}

// ---------- 记录/清单构造 ----------

const BASE = 'http://srv:8321';

function recordOf(overrides: Partial<ProxyMountRecord> = {}): ProxyMountRecord {
  const rec: ProxyMountRecord = {
    id: 'mount:abcd1234',
    kind: 'proxy',
    backend: 's3',
    label: 'docs',
    endpoint: 'http://127.0.0.1:9000',
    bucket: 'b1',
    prefix: 'sub',
    username: 'ak',
    secret: 'sk',
    fingerprint: '',
    serverBase: BASE,
    createdAt: 1700000000000
  };
  rec.fingerprint = mountFingerprintOf(rec);
  return { ...rec, ...overrides };
}

/** 服务端清单条目（指纹按 manifest 展示面 endpoint 计算——与 mountsSync 比对侧同口径）。 */
function entryOf(rec: ProxyMountRecord, rootIndex: number, overrides: Partial<MountManifestEntry> = {}): MountManifestEntry {
  return {
    rootIndex,
    kind: rec.backend,
    label: rec.label,
    endpoint: displayEndpoint(rec.endpoint),
    bucket: rec.bucket,
    prefix: rec.prefix,
    capabilities: { watch: false, search: false },
    ...overrides
  };
}

function manifestJson(
  entries: MountManifestEntry[],
  fsRoots = 1,
  staticMounts: MountManifestEntry[] = []
): unknown {
  // 运行时段 = mounts 中不在 staticMounts 段的条目（server MountsManifest 同构：
  // staticMounts 的 rootIndex 自 fsRoots 起算，运行时段起点 = fsRoots+staticLen）
  const staticSet = new Set(staticMounts);
  return {
    fsRoots,
    staticMounts,
    runtimeMounts: entries.filter((e) => !staticSet.has(e)),
    mounts: entries
  };
}

/** 与任务 1 server 端 mount_fingerprint 对齐的期望值（手工展开断言指纹串形状）。 */
const FSEP = '\u{1f}';

beforeEach(() => {
  calls = [];
  vi.stubGlobal('indexedDB', new IDBFactory()); // 每用例全新库（fontsStore.test.ts 同款）
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------- 指纹与展示面 endpoint（服务端对齐纯函数） ----------

describe('mountFingerprintOf（server mount_fingerprint 镜像）', () => {
  it('kind+endpoint+bucket/prefix/label 规范化串拼接', () => {
    const fp = mountFingerprintOf({ backend: 's3', endpoint: 'http://h:9000', bucket: 'b', prefix: 'p', label: 'l' });
    expect(fp).toBe(['s3', 'http://h:9000', 'b', 'p', 'l'].join(FSEP));
  });

  it('字段 trim 归一：空白差异不产生新指纹（与 server 端对齐）', () => {
    const a = mountFingerprintOf({ backend: 's3', endpoint: ' http://h:9000 ', bucket: 'b', prefix: 'p', label: 'l' });
    const b = mountFingerprintOf({ backend: 's3', endpoint: 'http://h:9000', bucket: ' b\t', prefix: ' p ', label: ' l ' });
    expect(a).toBe(b);
  });

  it('缺省 bucket/prefix/label 与空串同指纹（server 端 None 归一口径）', () => {
    expect(mountFingerprintOf({ backend: 'webdav', endpoint: 'http://d' })).toBe(
      mountFingerprintOf({ backend: 'webdav', endpoint: 'http://d', bucket: '', prefix: '', label: '' })
    );
  });
});

describe('displayEndpoint（server display_endpoint 镜像：展示面 userinfo 剥除）', () => {
  it('authority 段 userinfo 剥除，path 原样', () => {
    expect(displayEndpoint('https://user:pass@dav.example.com/dav')).toBe('https://dav.example.com/dav');
  });

  it('path 段 @ 不误剥；无 userinfo 原样；无 scheme 原样', () => {
    expect(displayEndpoint('https://dav.example.com/sub@x')).toBe('https://dav.example.com/sub@x');
    expect(displayEndpoint('http://plain.example.com:9000')).toBe('http://plain.example.com:9000');
    expect(displayEndpoint('plain-host')).toBe('plain-host');
  });

  it('空 userinfo（https://@host）原样；多 @ 按 authority 最后一个剥', () => {
    expect(displayEndpoint('https://@host')).toBe('https://@host');
    expect(displayEndpoint('http://a@b@c')).toBe('http://c');
  });
});

// ---------- v3→v4 迁移（session.ts DB_VERSION 顺延） ----------

describe('mounts store 持久化与 v3→v4 迁移', () => {
  it('v3 库（kv/themes/fonts 存量）打开升 v4：mounts store 补建，存量原样保留', async () => {
    // 造 v3 库：三 store 各存一条（session.ts v3 形态）
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open('vviewer', 3);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
        if (!d.objectStoreNames.contains('themes')) d.createObjectStore('themes');
        if (!d.objectStoreNames.contains('fonts')) d.createObjectStore('fonts');
      };
      req.onsuccess = () => {
        const d = req.result;
        const tx = d.transaction(['fonts'], 'readwrite');
        tx.objectStore('fonts').put({ id: 'font:x', name: 'keep' }, 'font:x');
        tx.oncomplete = () => {
          d.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
      req.onerror = () => reject(req.error);
    });
    // mountsSync 以 v4 打开触发升级
    const rec = recordOf();
    await saveProxyMount(rec);
    expect(await listProxyMounts()).toEqual([rec]);
    // 存量 fonts 数据原样保留（迁移不清洗）
    const kept = await new Promise<unknown>((resolve, reject) => {
      const req = indexedDB.open('vviewer', 4);
      req.onsuccess = () => {
        const d = req.result;
        const tx = d.transaction('fonts', 'readonly');
        const r = tx.objectStore('fonts').get('font:x');
        r.onsuccess = () => {
          d.close();
          resolve(r.result);
        };
        r.onerror = () => reject(r.error);
      };
      req.onerror = () => reject(req.error);
    });
    expect(kept).toEqual({ id: 'font:x', name: 'keep' });
  });

  it('save/list/delete 往返（无 keyPath 自管 id 键，fontsStore 同模式）', async () => {
    const a = recordOf({ id: 'mount:a' });
    const b = recordOf({ id: 'mount:b', backend: 'webdav', bucket: undefined, username: 'u', secret: 'p' });
    await saveProxyMount(a);
    await saveProxyMount(b);
    expect((await listProxyMounts()).map((r) => r.id)).toEqual(['mount:a', 'mount:b']);
    const { deleteProxyMount } = await import('./mountsSync');
    await deleteProxyMount('mount:a');
    expect((await listProxyMounts()).map((r) => r.id)).toEqual(['mount:b']);
  });
});

// ---------- 直连挂载记录（spec §4 阶段四：kind 'direct'，同 store 分段） ----------

describe('direct 挂载记录（kind direct 与 proxy 同 store 分段隔离）', () => {
  function directOf(overrides: Partial<DirectMountRecord> = {}): DirectMountRecord {
    return {
      id: 's3direct:abcd1234',
      kind: 'direct',
      backend: 's3',
      label: '直连桶',
      endpoint: 'http://127.0.0.1:9000',
      bucket: 'b1',
      prefix: '',
      username: 'ak',
      secret: 'sk',
      pathStyle: true,
      createdAt: 1700000000001,
      ...overrides
    };
  }

  it('save/list/delete 往返；listDirectMounts 只见 direct、listProxyMounts 只见 proxy', async () => {
    const d1 = directOf();
    const d2 = directOf({
      id: 'davdirect:eeee1111',
      backend: 'webdav',
      bucket: undefined,
      pathStyle: undefined,
      label: '直连 dav',
      createdAt: 1700000000002
    });
    const proxy = recordOf();
    await saveDirectMount(d1);
    await saveDirectMount(d2);
    await saveProxyMount(proxy);
    expect((await listDirectMounts()).map((r) => r.id)).toEqual(['s3direct:abcd1234', 'davdirect:eeee1111']);
    expect((await listProxyMounts()).map((r) => r.id)).toEqual(['mount:abcd1234']);
    await deleteDirectMount('s3direct:abcd1234');
    expect((await listDirectMounts()).map((r) => r.id)).toEqual(['davdirect:eeee1111']);
    // proxy 记录不受 direct 删除影响
    expect((await listProxyMounts()).map((r) => r.id)).toEqual(['mount:abcd1234']);
  });
});

// ---------- 连接对账（syncMountsOnConnect） ----------

describe('syncMountsOnConnect（spec §3 前端对账重注册）', () => {
  it('指纹缺失才 POST：缺失记录发一次 POST（凭据映射进 body），成功后登记 rootIndex 且清除待重试', async () => {
    const rec = recordOf();
    await saveProxyMount(rec);
    stubFetch((method, url) => {
      if (method === 'GET' && url.endsWith('/api/mounts')) return jsonResponse(200, manifestJson([], 1));
      if (method === 'POST' && url.endsWith('/api/mounts')) return jsonResponse(201, { rootIndex: 1 });
      return undefined;
    });
    await expect(syncMountsOnConnect(BASE, null)).resolves.toBeUndefined();
    const post = calls.find((c) => c.method === 'POST');
    expect(post).toBeDefined();
    expect(post!.body).toEqual({
      kind: 's3',
      label: 'docs',
      endpoint: 'http://127.0.0.1:9000',
      prefix: 'sub',
      bucket: 'b1',
      access_key_id: 'ak',
      secret_access_key: 'sk'
    });
    const saved = await onlyRecord();
    expect(saved.registeredRootIndex).toBe(1);
    expect(saved.pendingRetry).toBe(false);
    expect(saved.lastError).toBeUndefined();
  });

  it('webdav 记录 POST body 映射 username/password', async () => {
    await saveProxyMount(recordOf({ backend: 'webdav', bucket: undefined, username: 'u', secret: 'p' }));
    stubFetch((method, url) => {
      if (method === 'GET' && url.endsWith('/api/mounts')) return jsonResponse(200, manifestJson([], 1));
      if (method === 'POST' && url.endsWith('/api/mounts')) return jsonResponse(201, { rootIndex: 2 });
      return undefined;
    });
    await syncMountsOnConnect(BASE, null);
    const post = calls.find((c) => c.method === 'POST');
    expect(post!.body).toMatchObject({ kind: 'webdav', username: 'u', password: 'p' });
    expect(post!.body).not.toHaveProperty('bucket');
  });

  it('已注册（指纹命中清单）不重复 POST：登记 manifest rootIndex', async () => {
    const rec = recordOf();
    await saveProxyMount(rec);
    stubFetch((method, url) => {
      if (method === 'GET' && url.endsWith('/api/mounts'))
        return jsonResponse(200, manifestJson([entryOf(rec, 2)], 1));
      if (method === 'GET' && url.includes('/api/tree')) return jsonResponse(200, { entries: [] });
      return undefined;
    });
    await syncMountsOnConnect(BASE, null);
    expect(calls.find((c) => c.method === 'POST')).toBeUndefined();
    const saved = await onlyRecord();
    expect(saved.registeredRootIndex).toBe(2);
    expect(saved.pendingRetry).toBe(false);
  });

  it('凭据不同的同目标配置不重复注册（指纹不含凭据）：探测健康即只登记', async () => {
    const rec = recordOf({ username: 'rotated-ak', secret: 'rotated-sk' });
    await saveProxyMount(rec);
    stubFetch((method, url) => {
      if (method === 'GET' && url.endsWith('/api/mounts'))
        return jsonResponse(200, manifestJson([entryOf(rec, 3)], 1));
      if (method === 'GET' && url.includes('/api/tree')) return jsonResponse(200, { entries: [] });
      return undefined;
    });
    await syncMountsOnConnect(BASE, null);
    expect(calls.find((c) => c.method === 'POST')).toBeUndefined();
    expect(calls.find((c) => c.method === 'DELETE')).toBeUndefined();
  });

  it('注册失败静默标记待重试：POST 500 不抛错，pendingRetry+lastError 落库', async () => {
    await saveProxyMount(recordOf());
    stubFetch((method, url) => {
      if (method === 'GET' && url.endsWith('/api/mounts')) return jsonResponse(200, manifestJson([], 1));
      if (method === 'POST' && url.endsWith('/api/mounts')) return jsonResponse(500, { error: 'boom' });
      return undefined;
    });
    await expect(syncMountsOnConnect(BASE, null)).resolves.toBeUndefined();
    const saved = await onlyRecord();
    expect(saved.pendingRetry).toBe(true);
    expect(saved.lastError).toContain('500');
    expect(saved.registeredRootIndex).toBeUndefined();
  });

  it('清单不可达（404/网络失败）：全部记录静默标记待重试，不发起 POST（旧服务端无此 API 同口径）', async () => {
    await saveProxyMount(recordOf({ id: 'mount:a' }));
    await saveProxyMount(recordOf({ id: 'mount:b', endpoint: 'http://other:9000', label: 'x' }));
    stubFetch((method, url) => {
      if (method === 'GET' && url.endsWith('/api/mounts')) return new Response('', { status: 404 });
      return undefined;
    });
    await expect(syncMountsOnConnect(BASE, null)).resolves.toBeUndefined();
    const saved = await listProxyMounts();
    expect(saved).toHaveLength(2);
    for (const r of saved) {
      expect(r.pendingRetry).toBe(true);
      expect(r.lastError).toContain('404');
    }
    expect(calls.find((c) => c.method === 'POST')).toBeUndefined();
  });

  it('指纹命中但健康探测失败：DELETE+POST 重注册（凭据轮换），登记新 rootIndex', async () => {
    const rec = recordOf();
    await saveProxyMount(rec);
    stubFetch((method, url) => {
      if (method === 'GET' && url.endsWith('/api/mounts'))
        return jsonResponse(200, manifestJson([entryOf(rec, 2)], 1));
      if (method === 'GET' && url.includes('/api/tree')) return new Response('', { status: 502 });
      if (method === 'DELETE' && url.endsWith('/api/mounts/2')) return emptyResponse(204);
      if (method === 'POST' && url.endsWith('/api/mounts')) return jsonResponse(201, { rootIndex: 4 });
      return undefined;
    });
    await syncMountsOnConnect(BASE, null);
    expect(calls.find((c) => c.method === 'DELETE')).toBeDefined();
    const post = calls.find((c) => c.method === 'POST');
    expect(post).toBeDefined();
    const saved = await onlyRecord();
    expect(saved.registeredRootIndex).toBe(4);
    expect(saved.pendingRetry).toBe(false);
  });

  it('探测按「非 200」判定失败（Q-1）：400/404/5xx 一律触发重注册路径，无状态码特判', async () => {
    for (const probeStatus of [400, 404, 501, 503]) {
      calls = [];
      vi.stubGlobal('indexedDB', new IDBFactory());
      const rec = recordOf();
      await saveProxyMount(rec);
      stubFetch((method, url) => {
        if (method === 'GET' && url.endsWith('/api/mounts'))
          return jsonResponse(200, manifestJson([entryOf(rec, 1)], 1));
        if (method === 'GET' && url.includes('/api/tree')) return new Response('', { status: probeStatus });
        if (method === 'DELETE' && url.endsWith('/api/mounts/1')) return emptyResponse(204);
        if (method === 'POST' && url.endsWith('/api/mounts')) return jsonResponse(201, { rootIndex: 2 });
        return undefined;
      });
      await syncMountsOnConnect(BASE, null);
      expect(calls.find((c) => c.method === 'DELETE'), `status=${probeStatus}`).toBeDefined();
      expect(calls.find((c) => c.method === 'POST'), `status=${probeStatus}`).toBeDefined();
    }
  });

  it('静态挂载同指纹（真实形态：staticMounts 段、rootIndex ≥ fsRoots）：登记但不 DELETE 不探测（静态项 DELETE 405，无可轮换面）', async () => {
    const rec = recordOf();
    await saveProxyMount(rec);
    // server 真实清单形态：静态 TOML 挂载 rootIndex=fsRoots（≥ fsRoots，但不
    // 在运行时段）——分流须按 fsRoots+staticMounts.length 判定，否则此处会误
    // 探测（500）→ DELETE 405 → 永久待重试误态
    stubFetch((method, url) => {
      if (method === 'GET' && url.endsWith('/api/mounts'))
        return jsonResponse(200, manifestJson([entryOf(rec, 1)], 1, [entryOf(rec, 1)]));
      return undefined;
    });
    await syncMountsOnConnect(BASE, null);
    expect(calls.find((c) => c.method === 'GET' && c.url.includes('/api/tree'))).toBeUndefined();
    expect(calls.find((c) => c.method === 'DELETE')).toBeUndefined();
    const saved = await onlyRecord();
    expect(saved.registeredRootIndex).toBe(1);
    expect(saved.pendingRetry).toBe(false);
  });

  it('分流边界 = fsRoots+staticMounts.length：静态段条目不探测，运行时段起点（恰为边界值）照常探测', async () => {
    const staticRec = recordOf({ id: 'mount:static' });
    const runtimeRec = recordOf({ id: 'mount:rt', label: 'live', endpoint: 'http://127.0.0.1:9001' });
    await saveProxyMount(staticRec);
    await saveProxyMount(runtimeRec);
    // 静态挂载 rootIndex=1（≥ fsRoots=1 但 < 1+1=2）；运行时挂载恰落在运行时段
    // 起点 2（= fsRoots+staticLen）——边界两侧同用例锁定
    stubFetch((method, url) => {
      if (method === 'GET' && url.endsWith('/api/mounts'))
        return jsonResponse(
          200,
          manifestJson([entryOf(staticRec, 1), entryOf(runtimeRec, 2)], 1, [entryOf(staticRec, 1)])
        );
      if (method === 'GET' && url.includes('/api/tree')) return jsonResponse(200, { entries: [] });
      return undefined;
    });
    await syncMountsOnConnect(BASE, null);
    expect(calls.find((c) => c.method === 'GET' && c.url.endsWith('root=1')), '静态项不探测').toBeUndefined();
    expect(calls.find((c) => c.method === 'GET' && c.url.endsWith('root=2')), '运行时段起点探测').toBeDefined();
    expect(calls.find((c) => c.method === 'DELETE')).toBeUndefined();
    const all = await listProxyMounts();
    const staticSaved = all.find((r) => r.id === 'mount:static')!;
    expect(staticSaved.registeredRootIndex).toBe(1);
    expect(staticSaved.pendingRetry).toBe(false);
    const rtSaved = all.find((r) => r.id === 'mount:rt')!;
    expect(rtSaved.registeredRootIndex).toBe(2);
    expect(rtSaved.pendingRetry).toBe(false);
  });

  it('重注册失败（DELETE 抛错/POST 失败）静默标记待重试', async () => {
    const rec = recordOf();
    await saveProxyMount(rec);
    stubFetch((method, url) => {
      if (method === 'GET' && url.endsWith('/api/mounts'))
        return jsonResponse(200, manifestJson([entryOf(rec, 2)], 1));
      if (method === 'GET' && url.includes('/api/tree')) return new Response('', { status: 500 });
      if (method === 'DELETE' && url.endsWith('/api/mounts/2')) return new Response('', { status: 405 });
      return undefined;
    });
    await expect(syncMountsOnConnect(BASE, null)).resolves.toBeUndefined();
    const saved = await onlyRecord();
    expect(saved.pendingRetry).toBe(true);
    expect(saved.lastError).toContain('405');
  });

  it('serverBase 隔离：他服务器的记录不参与本连接对账', async () => {
    await saveProxyMount(recordOf({ serverBase: 'http://other:8321' }));
    stubFetch(() => undefined); // 任何请求都视为未模拟（本用例不应发出任何请求）
    await expect(syncMountsOnConnect(BASE, null)).resolves.toBeUndefined();
    expect(calls).toHaveLength(0);
    const saved = await onlyRecord();
    expect(saved.pendingRetry).toBeUndefined();
  });

  it('无保存记录时不发任何请求（早退）', async () => {
    stubFetch(() => undefined);
    await expect(syncMountsOnConnect(BASE, null)).resolves.toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('Bearer 头随 token 注入（GET/POST/DELETE 三面）', async () => {
    await saveProxyMount(recordOf());
    stubFetch((method, url) => {
      if (method === 'GET' && url.endsWith('/api/mounts')) return jsonResponse(200, manifestJson([], 1));
      if (method === 'POST' && url.endsWith('/api/mounts')) return jsonResponse(201, { rootIndex: 1 });
      return undefined;
    });
    await syncMountsOnConnect(BASE, 'tok-1');
    for (const c of calls) expect(c.headers.authorization).toBe('Bearer tok-1');
  });

  it('幂等：连续两次对账（缺失→已注册）第二次不再 POST', async () => {
    const rec = recordOf();
    await saveProxyMount(rec);
    let registered = false;
    stubFetch((method, url) => {
      if (method === 'GET' && url.endsWith('/api/mounts'))
        return jsonResponse(200, manifestJson(registered ? [entryOf(rec, 1)] : [], 1));
      if (method === 'GET' && url.includes('/api/tree')) return jsonResponse(200, { entries: [] });
      if (method === 'POST' && url.endsWith('/api/mounts')) {
        registered = true;
        return jsonResponse(201, { rootIndex: 1 });
      }
      return undefined;
    });
    await syncMountsOnConnect(BASE, null);
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    await syncMountsOnConnect(BASE, null);
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('userinfo 形态 endpoint：比对按展示面剥除后与清单命中（不误发重复 POST）', async () => {
    const rec = recordOf({ backend: 'webdav', endpoint: 'http://user:pass@dav.example.com/dav', bucket: undefined });
    await saveProxyMount(rec);
    stubFetch((method, url) => {
      if (method === 'GET' && url.endsWith('/api/mounts'))
        return jsonResponse(
          200,
          manifestJson([entryOf(rec, 5)], 1) // 清单 endpoint 已是剥除形态
        );
      if (method === 'GET' && url.includes('/api/tree')) return jsonResponse(200, { entries: [] });
      return undefined;
    });
    await syncMountsOnConnect(BASE, null);
    expect(calls.find((c) => c.method === 'POST')).toBeUndefined();
    const saved = await onlyRecord();
    expect(saved.registeredRootIndex).toBe(5);
  });
});

// ---------- 挂载根 watch 态判定（ViewerPane 状态栏消费，brief 测试清单收编） ----------

describe('isMountRootStoreId（fsRoots 边界：≥ fsRoots = 挂载根）', () => {
  const KEY = 'vv:server-health';

  function setHealth(fsRoots: number | null): void {
    sessionStorage.setItem(KEY, JSON.stringify({ version: '1.0', capabilities: ['file-server'], fsRoots }));
  }

  afterEach(() => {
    sessionStorage.removeItem(KEY);
  });

  it('rootIndex ≥ fsRoots 判挂载根；< fsRoots 与旧格式 id（隐含根 0）非挂载根', () => {
    setHealth(2);
    expect(isMountRootStoreId('remote:abcd1234:r2')).toBe(true);
    expect(isMountRootStoreId('remote:abcd1234:r1')).toBe(false);
    expect(isMountRootStoreId('remote:abcd1234')).toBe(false);
  });

  it('fsRoots 未宣告（null = 旧服务端/无挂载部署）恒 false', () => {
    setHealth(null);
    expect(isMountRootStoreId('remote:abcd1234:r9')).toBe(false);
    sessionStorage.removeItem(KEY);
    expect(isMountRootStoreId('remote:abcd1234:r9')).toBe(false);
  });

  it('非 remote id（localfs/placeholder 等）恒 false', () => {
    setHealth(1);
    expect(isMountRootStoreId('localfs:docs')).toBe(false);
    expect(isMountRootStoreId('placeholder:remote:abcd1234:r3')).toBe(false);
  });
});
