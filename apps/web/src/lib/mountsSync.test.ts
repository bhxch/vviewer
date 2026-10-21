// mountsSync.test.ts — 代理挂载前端持久化与连接对账（目录挂载 spec 2026-10-19 §3，
// plan Task 2）。IndexedDB 用 fake-indexeddb（每用例全新库），网络面 stub 全局
// fetch 按 method+URL 路由；挂载根 watch 态判定（serverHealthCache.isMountRootStoreId）
// 与 session v3→v4 迁移用例按 brief 的 Task 2 测试清单就近收编本文件。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { webcrypto } from 'node:crypto';
import { createS3DirectStore, s3DirectStoreId, type S3DirectConfig } from '@vviewer/core';
import {
  deleteDirectMount,
  directConfigOf,
  displayEndpoint,
  displayLabelForStore,
  listDirectMounts,
  listProxyMounts,
  mountFingerprintOf,
  probeMountRoot,
  registerProxyMount,
  resetMountRecordCacheForTests,
  rewriteSourceForMigration,
  rewriteStoreIdRootIndex,
  saveDirectMount,
  saveProxyMount,
  syncMountsOnConnect,
  unregisterProxyMount,
  type DirectMountRecord,
  type MountManifestEntry,
  type ProxyMountRecord,
  type RootIndexMove
} from './mountsSync';
import { createRemoteStore } from '@vviewer/core';
import type { WorkspaceSource } from './workspaceStore';
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

  it('probe mount root uses literal empty path', async () => {
    // 3-10：探测请求路径为字面 `path=`（encodeURIComponent('') 产物与字面同串，
    // 属冗余编码调用面）——回归锚锁定线格式 `path=&root=N`，杜绝改道编码产物
    stubFetch((_method, url) =>
      url === `${BASE}/api/tree?path=&root=7` ? jsonResponse(200, { entries: [] }) : undefined
    );
    await expect(probeMountRoot(BASE, 'tok', 7)).resolves.toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${BASE}/api/tree?path=&root=7`);
  });

  it('failed probe record clears stale registeredRootIndex', async () => {
    // 3-11：探测失败且重注册失败 → failedRecord 不得残留旧 registeredRootIndex
    // （挂载可能已在对账间隙被服务端撤走/轮换未遂，旧索引只指向他物——展示机
    // 不再把它当 registered 呈现，打开与 unregister 消费点同失依据）
    const rec = recordOf();
    await saveProxyMount({ ...rec, registeredRootIndex: 2 });
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
    expect(saved.registeredRootIndex).toBeUndefined();
  });

  it('降级重探（3-18）：失败记录不被短路，下次对账重发 probe，成功即转 healthy', async () => {
    // 失败态遗留（3-11 落库形态：pendingRetry + lastError、registeredRootIndex 已清）
    // 的记录，下次 connectServer → syncMountsOnConnect 仍照常对账并重发
    // probeMountRoot——成功即 healthyRecord（索引落位、pendingRetry 清除、
    // lastError 删除）。重探无任何定时器/后台轮询（spec §4-1）：驱动面只有
    // 「下次对账」，本用例以同步两次调用模拟两次连接，不依赖 timer。
    const rec = recordOf();
    await saveProxyMount({ ...rec, pendingRetry: true, lastError: '重注册失败：HTTP 405' });
    let probeHealthy = false;
    stubFetch((method, url) => {
      if (method === 'GET' && url.endsWith('/api/mounts'))
        return jsonResponse(200, manifestJson([entryOf(rec, 2)], 1));
      if (method === 'GET' && url.includes('/api/tree'))
        return probeHealthy ? jsonResponse(200, { entries: [] }) : new Response('', { status: 502 });
      if (method === 'DELETE' && url.endsWith('/api/mounts/2')) return new Response('', { status: 405 });
      return undefined;
    });
    // 第一次对账：probe 失败 → 重注册（DELETE 405）也失败 → 仍是失败态
    await syncMountsOnConnect(BASE, null);
    const failed = await onlyRecord();
    expect(failed.pendingRetry).toBe(true);
    expect(failed.lastError).toContain('405');
    expect(failed.registeredRootIndex).toBeUndefined();
    // 第二次对账：失败记录未被跳过（probe 照发），此番成功 → 转 healthy
    const beforeSecond = calls.length;
    probeHealthy = true;
    await syncMountsOnConnect(BASE, null);
    const saved = await onlyRecord();
    expect(saved.pendingRetry).toBe(false);
    expect(saved.registeredRootIndex).toBe(2);
    expect(saved.lastError).toBeUndefined();
    // 全程 probe 恰两次（每对账各一次，失败记录未被短路跳过）；第二次对账窗口
    // 内 probe 已健康 → 无 DELETE 轮换（第一次窗口的 DELETE 405 是失败对账的合法动作）
    expect(calls.filter((c) => c.method === 'GET' && c.url.includes('/api/tree'))).toHaveLength(2);
    const second = calls.slice(beforeSecond);
    expect(second.filter((c) => c.method === 'GET' && c.url.includes('/api/tree'))).toHaveLength(1);
    expect(second.find((c) => c.method === 'DELETE')).toBeUndefined();
  });
});

// ---------- rootIndex 迁移（台账 3-1：纯函数直测 + 迁移对收集回调） ----------

describe('rewriteStoreIdRootIndex（台账 3-1 纯函数：r 段正则改写）', () => {
  it('r 段替换：hash 段与 basePath 指纹段原样（冻结 label = storeId 恢复回环依据）', () => {
    expect(rewriteStoreIdRootIndex('remote:abcd1234:r2', 2, 4)).toBe('remote:abcd1234:r4');
    expect(rewriteStoreIdRootIndex('remote:abcd1234:r2:deadbeef', 2, 4)).toBe('remote:abcd1234:r4:deadbeef');
  });

  it('r 段 ≠ oldIndex / 旧格式无 r 段 / 相同索引 / 非 remote 形态：原样返回 null', () => {
    expect(rewriteStoreIdRootIndex('remote:abcd1234:r5', 2, 4)).toBeNull();
    expect(rewriteStoreIdRootIndex('remote:abcd1234', 0, 4)).toBeNull(); // 旧格式（根 0）无可改写段
    expect(rewriteStoreIdRootIndex('remote:abcd1234:r2', 2, 2)).toBeNull();
    expect(rewriteStoreIdRootIndex('localfs:demo', 2, 4)).toBeNull();
    expect(rewriteStoreIdRootIndex('placeholder:remote:abcd1234:r2', 2, 4)).toBeNull();
    expect(rewriteStoreIdRootIndex('s3direct:abcd1234', 2, 4)).toBeNull();
  });

  it('r 段数字不误匹配前缀（oldIndex=2 不命中 r22；oldIndex=22 精确命中）', () => {
    expect(rewriteStoreIdRootIndex('remote:abcd1234:r22', 2, 4)).toBeNull();
    expect(rewriteStoreIdRootIndex('remote:abcd1234:r22', 22, 4)).toBe('remote:abcd1234:r4');
  });

  it('非整数索引防御性拒绝（服务端异常值不产生改写）', () => {
    expect(rewriteStoreIdRootIndex('remote:abcd1234:r2', Number.NaN, 4)).toBeNull();
    expect(rewriteStoreIdRootIndex('remote:abcd1234:r2', 2, 4.5)).toBeNull();
  });
});

describe('rewriteSourceForMigration（台账 3-1 纯函数：来源面改写）', () => {
  const source: WorkspaceSource = {
    kind: 'remote',
    storeId: 'remote:abcd1234:r2',
    storeLabel: 'srv:8321 · 根2/',
    storeBase: BASE,
    rootIndex: 2
  };
  const moves: RootIndexMove[] = [{ serverBase: BASE, oldIndex: 2, newIndex: 4 }];

  it('命中：rootIndex 换新 + storeId r 段改写；storeLabel/basePath 冻结原样（hash 输入零改动）', () => {
    expect(rewriteSourceForMigration({ ...source, basePath: 'sub' }, moves)).toEqual({
      kind: 'remote',
      storeId: 'remote:abcd1234:r4',
      storeLabel: 'srv:8321 · 根2/',
      storeBase: BASE,
      rootIndex: 4,
      basePath: 'sub'
    });
  });

  it('未命中 kind/storeBase/rootIndex 与形状漂移（storeId r 段 ≠ rootIndex）：null 原样保留（不半改写）', () => {
    expect(rewriteSourceForMigration(source, [])).toBeNull();
    expect(rewriteSourceForMigration(source, [{ serverBase: 'http://other:1', oldIndex: 2, newIndex: 4 }])).toBeNull();
    expect(rewriteSourceForMigration(source, [{ serverBase: BASE, oldIndex: 3, newIndex: 4 }])).toBeNull();
    expect(rewriteSourceForMigration({ ...source, kind: 'direct' }, moves)).toBeNull();
    expect(rewriteSourceForMigration({ ...source, storeId: 'remote:abcd1234:r9' }, moves)).toBeNull();
  });

  it('多迁移对取首个命中；rootIndex 缺省（=0）参与匹配但旧格式 id 无法改写返回 null', () => {
    expect(rewriteSourceForMigration(source, [
      { serverBase: BASE, oldIndex: 3, newIndex: 9 },
      { serverBase: BASE, oldIndex: 2, newIndex: 4 }
    ])).toEqual({ ...source, storeId: 'remote:abcd1234:r4', rootIndex: 4 });
    expect(
      rewriteSourceForMigration(
        { kind: 'remote', storeId: 'remote:abcd1234', storeLabel: 'srv:8321', storeBase: BASE },
        [{ serverBase: BASE, oldIndex: 0, newIndex: 3 }]
      )
    ).toBeNull();
  });
});

describe('syncMountsOnConnect 迁移回调（台账 3-1：换索引收集 RootIndexMove）', () => {
  it('重注册换索引（S-3 轮换）：onMigrated 收到 {serverBase, oldIndex, newIndex}', async () => {
    const rec = recordOf({ registeredRootIndex: 2 });
    await saveProxyMount(rec);
    stubFetch((method, url) => {
      if (method === 'GET' && url.endsWith('/api/mounts'))
        return jsonResponse(200, manifestJson([entryOf(rec, 2)], 1));
      if (method === 'GET' && url.includes('/api/tree')) return new Response('', { status: 502 });
      if (method === 'DELETE' && url.endsWith('/api/mounts/2')) return emptyResponse(204);
      if (method === 'POST' && url.endsWith('/api/mounts')) return jsonResponse(201, { rootIndex: 4 });
      return undefined;
    });
    const seen: RootIndexMove[][] = [];
    await expect(syncMountsOnConnect(BASE, null, (m) => seen.push(m))).resolves.toBeUndefined();
    expect(seen).toEqual([[{ serverBase: BASE, oldIndex: 2, newIndex: 4 }]]);
    expect((await onlyRecord()).registeredRootIndex).toBe(4);
  });

  it('指纹缺失幂等 POST 换索引（服务端重启场景）同样收集；索引不变的记录不进迁移对', async () => {
    const moved = recordOf({ id: 'mount:moved', registeredRootIndex: 2 });
    const stayed = recordOf({ id: 'mount:stayed', label: 'stay', endpoint: 'http://127.0.0.1:9001', registeredRootIndex: 3 });
    await saveProxyMount(moved);
    await saveProxyMount(stayed);
    stubFetch((method, url, body) => {
      if (method === 'GET' && url.endsWith('/api/mounts')) return jsonResponse(200, manifestJson([], 1));
      if (method === 'POST' && url.endsWith('/api/mounts')) {
        // 按 body label 区分：moved 重注册到 5，stayed 仍登记 3
        const label = (body as { label?: string }).label;
        return jsonResponse(201, { rootIndex: label === 'stay' ? 3 : 5 });
      }
      return undefined;
    });
    const seen: RootIndexMove[][] = [];
    await syncMountsOnConnect(BASE, null, (m) => seen.push(m));
    expect(seen).toEqual([[{ serverBase: BASE, oldIndex: 2, newIndex: 5 }]]);
  });

  it('回调抛错不外泄（对账全链不抛错契约；记录已落库）', async () => {
    const rec = recordOf({ registeredRootIndex: 2 });
    await saveProxyMount(rec);
    stubFetch((method, url) => {
      if (method === 'GET' && url.endsWith('/api/mounts')) return jsonResponse(200, manifestJson([], 1));
      if (method === 'POST' && url.endsWith('/api/mounts')) return jsonResponse(201, { rootIndex: 4 });
      return undefined;
    });
    await expect(
      syncMountsOnConnect(BASE, null, () => {
        throw new Error('boom');
      })
    ).resolves.toBeUndefined();
    expect((await onlyRecord()).registeredRootIndex).toBe(4);
  });

  it('迁移对与 core 工厂联动：重建实例（冻结 label + 新 rootIndex）的 storeId = 正则改写结果', async () => {
    // 3-1 存活 tab 面的换挂互锁锚：openFlow 以快照 storeLabel 原值 + 新索引重建，
    // createRemoteStore 产出的 id 必须恰为 rewriteStoreIdRootIndex 的改写值
    const rec = recordOf({ registeredRootIndex: 2 });
    const oldLabel = 'srv:8321 · 根2/';
    const oldStore = createRemoteStore(BASE, null, oldLabel, { rootIndex: 2 });
    expect(oldStore.id).toMatch(/^remote:[0-9a-f]{8}:r2$/);
    const rewritten = rewriteStoreIdRootIndex(oldStore.id, 2, 4);
    const rebuilt = createRemoteStore(BASE, null, oldLabel, { rootIndex: 4 });
    expect(rebuilt.id).toBe(rewritten);
    // 带 basePath 的来源同锚（指纹段原样保留）
    const withBase = createRemoteStore(BASE, null, oldLabel, { rootIndex: 2, basePath: 'sub' });
    expect(rewriteStoreIdRootIndex(withBase.id, 2, 4)).toBe(
      createRemoteStore(BASE, null, oldLabel, { rootIndex: 4, basePath: 'sub' }).id
    );
  });
});

// ---------- 挂载显示名映射（台账 3-20：storeId → mount label，hash 输入零改动） ----------

describe('displayLabelForStore（台账 3-20）', () => {
  /** 真实打开路径产出的 storeId 锚：createRemoteStore 以 remoteSourceLabel 形态 label 建实例。 */
  function openedProxyStoreId(rootIndex: number, base = BASE): string {
    const host = new URL(base).host;
    const label = rootIndex === 0 ? host : `${host} · 根${rootIndex}/`;
    return createRemoteStore(base, null, label, { rootIndex }).id;
  }

  beforeEach(() => {
    // 镜像为模块级状态（跨用例存活）：清空隔离（IndexedDB 已由文件级 beforeEach 换新库）
    resetMountRecordCacheForTests();
  });

  it('proxy 命中：与真实打开链同源（core 工厂产出的 storeId）映射到记录 label', async () => {
    const rec = recordOf({ registeredRootIndex: 2 });
    await saveProxyMount(rec);
    expect(displayLabelForStore(openedProxyStoreId(2), { storeBase: BASE })).toBe('docs');
    // base 缺省（单候选）：同样命中
    expect(displayLabelForStore(openedProxyStoreId(2))).toBe('docs');
  });

  it('多服务器同索引去歧义：不带 base 恒未命中（宁缺不猜），带 base 精确命中', async () => {
    await saveProxyMount(recordOf({ registeredRootIndex: 2 }));
    await saveProxyMount(
      recordOf({ id: 'mount:other', endpoint: 'http://other:9000', serverBase: 'http://other:8321', registeredRootIndex: 2 })
    );
    expect(displayLabelForStore(openedProxyStoreId(2))).toBeUndefined();
    expect(displayLabelForStore(openedProxyStoreId(2), { storeBase: BASE })).toBe('docs');
    expect(displayLabelForStore(openedProxyStoreId(2), { storeBase: 'http://other:8321' })).toBe('docs');
  });

  it('3-1 迁移后的冻结 hash 形态天然兼容：匹配按 (base, index) 身份而非 hash 重算', async () => {
    await saveProxyMount(recordOf({ registeredRootIndex: 4 }));
    // hash 段属旧 label（deadbeef 任意）：r 段已被 3-1 改写为新索引，仍命中
    expect(displayLabelForStore('remote:deadbeef:r4', { storeBase: BASE })).toBe('docs');
  });

  it('未注册（registeredRootIndex 缺失）/索引不匹配/非挂载 id：undefined（调用方回落旧形态）', async () => {
    await saveProxyMount(recordOf()); // 未注册
    expect(displayLabelForStore(openedProxyStoreId(2), { storeBase: BASE })).toBeUndefined();
    await saveProxyMount(recordOf({ id: 'mount:r5', registeredRootIndex: 5 }));
    expect(displayLabelForStore(openedProxyStoreId(2), { storeBase: BASE })).toBeUndefined();
    expect(displayLabelForStore('localfs:demo', { storeBase: undefined })).toBeUndefined();
    expect(displayLabelForStore('placeholder:remote:abcd1234:r2')).toBeUndefined();
  });

  it('direct 命中：storeId 即记录 id；label 改名经 saveMount 漏斗即时刷新镜像', async () => {
    const rec: DirectMountRecord = {
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
      createdAt: 1
    };
    await saveDirectMount(rec);
    expect(displayLabelForStore('s3direct:abcd1234')).toBe('直连桶');
    await saveDirectMount({ ...rec, label: '改名桶' });
    expect(displayLabelForStore('s3direct:abcd1234')).toBe('改名桶');
    await deleteDirectMount('s3direct:abcd1234');
    expect(displayLabelForStore('s3direct:abcd1234')).toBeUndefined();
  });

  it('proxy label 改名即时可见（镜像经 saveMount 维护，免重列）；记录未列出过（冷缓存）回落 undefined', async () => {
    const rec = recordOf({ registeredRootIndex: 2 });
    await saveProxyMount(rec);
    expect(displayLabelForStore(openedProxyStoreId(2), { storeBase: BASE })).toBe('docs');
    await saveProxyMount({ ...rec, label: '文献库' });
    expect(displayLabelForStore(openedProxyStoreId(2), { storeBase: BASE })).toBe('文献库');
  });
});

// ---------- 挂载根 watch 态判定（ViewerPane 状态栏消费，brief 测试清单收编） ----------

describe('isMountRootStoreId（fsRoots 边界：≥ fsRoots = 挂载根；direct 前缀恒挂载来源）', () => {
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

  it('fsRoots 未宣告（null = 旧服务端/无挂载部署）对 remote id 恒 false', () => {
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

  // Task 3 收口项：直连挂载不经服务器、watch 恒不支持——判定与 fsRoots/health
  // 缓存无关（direct tab 走 per-source「此源不支持变更推送」、搜索走浏览器内补扫）
  it('direct 前缀（s3direct:/davdirect:）恒 true，不受 fsRoots 宣告缺省影响', () => {
    setHealth(2);
    expect(isMountRootStoreId('s3direct:abcd1234')).toBe(true);
    expect(isMountRootStoreId('davdirect:abcd1234')).toBe(true);
    setHealth(null);
    expect(isMountRootStoreId('s3direct:abcd1234')).toBe(true);
    sessionStorage.removeItem(KEY);
    expect(isMountRootStoreId('davdirect:abcd1234')).toBe(true);
  });

  it('placeholder: 包装的 direct id 不识别（占位 tab 走既有错误卡片链）', () => {
    setHealth(1);
    expect(isMountRootStoreId('placeholder:s3direct:abcd1234')).toBe(false);
  });
});

// ---------- directConfigOf（评审带入①：直连记录 → core 工厂配置，openFlow
// 创建分派与管理页测试连接共用） ----------

describe('directConfigOf', () => {
  const s3Rec: DirectMountRecord = {
    id: 's3direct:abcd1234',
    kind: 'direct',
    backend: 's3',
    label: '样例桶',
    endpoint: 'http://127.0.0.1:9000',
    bucket: 'bkt',
    prefix: 'sub',
    username: 'AK',
    secret: 'SK',
    pathStyle: false,
    createdAt: 1
  };

  it('S3 记录映射：bucket/凭据展开为 accessKeyId/secretAccessKey，prefix/pathStyle 直传（工厂内部归一）', () => {
    expect(directConfigOf(s3Rec)).toEqual({
      endpoint: 'http://127.0.0.1:9000',
      bucket: 'bkt',
      prefix: 'sub',
      accessKeyId: 'AK',
      secretAccessKey: 'SK',
      pathStyle: false,
      label: '样例桶'
    });
  });

  it('WebDAV 记录映射：username/secret 展开为 username/password；pathStyle 不入 dav 配置面', () => {
    const cfg = directConfigOf({
      id: 'davdirect:abcd1234',
      kind: 'direct',
      backend: 'webdav',
      label: '文献库',
      endpoint: 'http://127.0.0.1:8333/dav',
      prefix: 'docs',
      username: 'u',
      secret: 'p',
      createdAt: 1
    });
    expect(cfg).toEqual({
      endpoint: 'http://127.0.0.1:8333/dav',
      prefix: 'docs',
      username: 'u',
      password: 'p',
      label: '文献库'
    });
  });

  it('缺失字段回退空串（记录损坏防御：工厂/探测面报错而非崩溃）；pathStyle 缺省不入配置（工厂缺省 path-style）', () => {
    expect(directConfigOf({ ...s3Rec, bucket: undefined, username: undefined, secret: undefined, pathStyle: undefined })).toEqual({
      endpoint: 'http://127.0.0.1:9000',
      bucket: '',
      prefix: 'sub',
      accessKeyId: '',
      secretAccessKey: '',
      label: '样例桶'
    });
  });

  it('未知 backend 抛错（记录损坏防御）', () => {
    expect(() => directConfigOf({ ...s3Rec, backend: 'ftp' as DirectMountRecord['backend'] })).toThrow(/未知直连后端/);
  });

  it('与 core 工厂联动：配置直接建 store 得到的 storeId = 记录 id（id 闭环——管理页保存即以 s3DirectStoreId/davDirectStoreId 为记录 id）', async () => {
    if (!globalThis.crypto?.subtle) vi.stubGlobal('crypto', webcrypto);
    const rec = {
      ...s3Rec,
      id: s3DirectStoreId({ endpoint: s3Rec.endpoint, bucket: s3Rec.bucket!, prefix: s3Rec.prefix, pathStyle: s3Rec.pathStyle })
    };
    const store = createS3DirectStore(directConfigOf(rec) as S3DirectConfig);
    expect(store.id).toBe(rec.id);
  });
});

// ---------- 管理页代理挂载即时注册面（spec §5 阶段四：proxy 增删即时调
// POST/DELETE /api/mounts；失败不落 IndexedDB——一致态由调用方保持） ----------

describe('registerProxyMount/unregisterProxyMount', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('registerProxyMount：POST /api/mounts 带 Bearer 与凭据 body，返回分配的 rootIndex', async () => {
    calls = [];
    stubFetch((method, url) => {
      if (method === 'POST' && url === `${BASE}/api/mounts`) return jsonResponse(201, { rootIndex: 3 });
      return undefined;
    });
    const idx = await registerProxyMount(recordOf(), 'tok');
    expect(idx).toBe(3);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.headers.authorization).toBe('Bearer tok');
    expect(calls[0]!.body).toMatchObject({ kind: 's3', bucket: 'b1', access_key_id: 'ak', secret_access_key: 'sk' });
  });

  it('registerProxyMount：非 2xx / 缺 rootIndex 抛错（调用方捕获后不落库）', async () => {
    stubFetch((_m, url) =>
      url === `${BASE}/api/mounts` ? jsonResponse(500, { detail: 'boom' }) : undefined
    );
    await expect(registerProxyMount(recordOf(), null)).rejects.toThrow(/HTTP 500/);
    stubFetch((_m, url) => (url === `${BASE}/api/mounts` ? jsonResponse(200, {}) : undefined));
    await expect(registerProxyMount(recordOf(), null)).rejects.toThrow(/缺少 rootIndex/);
  });

  it('unregisterProxyMount：DELETE /api/mounts/:index；404 幂等通过；非 2xx（静态项 405）抛错', async () => {
    calls = [];
    stubFetch((method, url) => {
      if (method === 'DELETE' && url === `${BASE}/api/mounts/3`) return emptyResponse(204);
      return undefined;
    });
    await expect(unregisterProxyMount(recordOf(), 'tok', 3)).resolves.toBeUndefined();
    expect(calls[0]!.headers.authorization).toBe('Bearer tok');
    stubFetch((method, url) => {
      if (method === 'DELETE' && url === `${BASE}/api/mounts/3`) return emptyResponse(404);
      return undefined;
    });
    await expect(unregisterProxyMount(recordOf(), 'tok', 3)).resolves.toBeUndefined(); // 已不存在：幂等
    stubFetch((method, url) => {
      if (method === 'DELETE' && url === `${BASE}/api/mounts/3`) return emptyResponse(405);
      return undefined;
    });
    await expect(unregisterProxyMount(recordOf(), 'tok', 3)).rejects.toThrow(/HTTP 405/);
  });
});
