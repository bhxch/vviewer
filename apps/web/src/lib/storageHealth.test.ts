// storageHealth.test.ts — 存储用量计算与分类清除（settings center spec §2.1/§2.2，
// Task 4）。storageHealth.ts 为纯 .ts 模块（无 runes）vitest 直测：jsdom 缺
// navigator.storage/caches/FontFace——全部全局桩（fontsStore.test.ts 同形态先例），
// IndexedDB 用 fake-indexeddb 每用例全新库实例。七分类删除语义逐行（spec §2.2
// 表格）、恢复出厂全序列（SW 注销 mock）、persist granted/denied/异常状态机。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import {
  collectStorageInfo,
  factoryReset,
  formatBytes,
  isPrecacheCacheName,
  persistedState,
  purgeCategory,
  requestPersistent,
  tryRequestPersistentSilent
} from './storageHealth';
import { addFontFromFile } from './stores/fontsStore';
import { loadSettings } from './stores/settings';

// ---- jsdom 缺口桩（fontsStore.test.ts 同款） ----

let faces: FakeFontFace[] = [];

class FakeFontFace {
  constructor(
    public family: string,
    public source: ArrayBuffer
  ) {
    faces.push(this);
  }
  load(): Promise<FakeFontFace> {
    return Promise.resolve(this);
  }
}

let fontSet: { added: FakeFontFace[]; removed: FakeFontFace[] };

function stubFontWorld(): void {
  fontSet = { added: [], removed: [] };
  vi.stubGlobal('FontFace', FakeFontFace);
  Object.defineProperty(document, 'fonts', {
    value: {
      add: (f: FakeFontFace) => fontSet.added.push(f),
      delete: (f: FakeFontFace) => fontSet.removed.push(f)
    },
    configurable: true
  });
}

/** navigator 桩：jsdom 的 navigator 为只读访问器，整体替换（未给 storage 时
 * 显式置 undefined——模拟「无 Storage Manager 的老 WebView」降级路径） */
function stubNavigator(extra: { storage?: unknown; serviceWorker?: unknown } = {}): void {
  vi.stubGlobal('navigator', { ...extra });
}

function stubCaches(names: string[]): { deleted: string[] } {
  const deleted: string[] = [];
  vi.stubGlobal('caches', {
    keys: async () => [...names],
    delete: async (name: string) => {
      deleted.push(name);
      return true;
    }
  });
  return { deleted };
}

// ---- IndexedDB 种子（绕过各 store 的业务函数直写，隔离被测面） ----

async function rawOpen(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    // v3 直开 + onupgradeneeded 建三 store（session.ts 形态）：fresh IDBFactory 下
    // 裸 open 得 v1 空库，rawPut 无处落键
    const req = indexedDB.open('vviewer', 3);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
      if (!d.objectStoreNames.contains('themes')) d.createObjectStore('themes');
      if (!d.objectStoreNames.contains('fonts')) d.createObjectStore('fonts');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function rawPut(store: string, key: string, value: unknown): Promise<void> {
  const d = await rawOpen();
  await new Promise<void>((resolve, reject) => {
    const tx = d.transaction(store, 'readwrite');
    tx.objectStore(store).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  d.close();
}

async function rawKeys(store: string): Promise<string[]> {
  const d = await rawOpen();
  const keys = await new Promise<string[]>((resolve, reject) => {
    const req = d.transaction(store, 'readonly').objectStore(store).getAllKeys();
    req.onsuccess = () => resolve(req.result as string[]);
    req.onerror = () => reject(req.error);
  });
  d.close();
  return keys;
}

const fileOf = (name: string): File => new File([new Uint8Array(8)], name);

beforeEach(() => {
  faces = [];
  localStorage.clear();
  vi.stubGlobal('indexedDB', new IDBFactory()); // 每用例全新库
  stubFontWorld();
  stubNavigator({}); // 缺省无 storage/caches/serviceWorker（降级路径）
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('formatBytes（用量显示口径）', () => {
  it('B/KB/MB/GB 换算（KB 起一位小数）', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe('3.0 GB');
  });
});

describe('collectStorageInfo（spec §2.1 口径）', () => {
  it('estimate 缺失降级：estimate=null、persisted=null，本地估算行仍可用', async () => {
    const info = await collectStorageInfo();
    expect(info.estimate).toBeNull();
    expect(info.persisted).toBeNull();
    expect(info.localStorageBytes).toBe(0);
  });

  it('estimate/persisted 在场：quota/usage 透传，usageDetails 存在与缺失两态', async () => {
    stubNavigator({
      storage: {
        estimate: async () => ({ quota: 1_000_000_000, usage: 500_000, usageDetails: { indexedDB: 400_000 } }),
        persisted: async () => true
      }
    });
    let info = await collectStorageInfo();
    expect(info.estimate).toEqual({ quota: 1_000_000_000, usage: 500_000, details: { indexedDB: 400_000 } });
    expect(info.persisted).toBe(true);
    stubNavigator({
      storage: { estimate: async () => ({ quota: 8, usage: 2 }), persisted: async () => false }
    });
    info = await collectStorageInfo();
    expect(info.estimate).toEqual({ quota: 8, usage: 2, details: null });
    expect(info.persisted).toBe(false);
  });

  it('estimate 抛异常按不支持降级（不抛出）', async () => {
    stubNavigator({ storage: { estimate: async () => Promise.reject(new Error('boom')) } });
    const info = await collectStorageInfo();
    expect(info.estimate).toBeNull();
  });

  it('localStorage UTF-16 估算求和（键+值长度 ×2）；settingsBytes 只算 vviewer:settings 键', async () => {
    localStorage.setItem('vviewer:settings', '{"autoRefresh":true}');
    localStorage.setItem('other:key', 'xy');
    const info = await collectStorageInfo();
    const settingsLen = 'vviewer:settings'.length + '{"autoRefresh":true}'.length;
    const otherLen = 'other:key'.length + 'xy'.length;
    expect(info.settingsBytes).toBe(settingsLen * 2);
    expect(info.localStorageBytes).toBe((settingsLen + otherLen) * 2);
  });

  it('IndexedDB 分 store 计数与体积：kv/themes 序列化长度估算 ×2，fonts 用记录 size 求和', async () => {
    const tabs = [{ id: 't1' }];
    const workspaces = { activeId: 'w1', workspaces: [] };
    await rawPut('kv', 'tabs', tabs);
    await rawPut('kv', 'workspaces', workspaces);
    await rawPut('kv', 'dirHandle', { name: 'docs' });
    await rawPut('kv', 'user:key', 'v');
    await rawPut('themes', 'imported:a', { id: 'imported:a', colors: {} });
    await rawPut('themes', 'imported:b', { id: 'imported:b', colors: {} });
    await rawPut('fonts', 'font:a', { name: 'A', size: 100 });
    await rawPut('fonts', 'font:b', { name: 'B', size: 250 });
    const info = await collectStorageInfo();
    expect(info.kv.records).toBe(4);
    expect(info.kv.bytes).toBe(
      (JSON.stringify(tabs).length + JSON.stringify(workspaces).length + JSON.stringify({ name: 'docs' }).length + JSON.stringify('v').length) * 2
    );
    expect(info.kvSnapshotBytes).toBe((JSON.stringify(tabs).length + JSON.stringify(workspaces).length) * 2);
    expect(info.kvDirHandleBytes).toBe(JSON.stringify({ name: 'docs' }).length * 2);
    expect(info.themes).toEqual({ records: 2, bytes: (JSON.stringify({ id: 'imported:a', colors: {} }).length + JSON.stringify({ id: 'imported:b', colors: {} }).length) * 2 });
    expect(info.fonts).toEqual({ records: 2, bytes: 350 });
  });

  it('cacheNames 列运行时缓存清单（caches 缺失为空数组）', async () => {
    expect((await collectStorageInfo()).cacheNames).toEqual([]);
    stubCaches(['workbox-precache-v2-x', 'vv-queries-1']);
    expect((await collectStorageInfo()).cacheNames).toEqual(['workbox-precache-v2-x', 'vv-queries-1']);
  });
});

describe('persist 状态机（spec §2.1：granted/denied/异常/缺失）', () => {
  it('requestPersistent：granted=true / denied=false / 异常与缺失=false', async () => {
    stubNavigator({ storage: { persist: async () => true } });
    expect(await requestPersistent()).toBe(true);
    stubNavigator({ storage: { persist: async () => false } });
    expect(await requestPersistent()).toBe(false);
    stubNavigator({ storage: { persist: async () => Promise.reject(new Error('boom')) } });
    expect(await requestPersistent()).toBe(false);
    stubNavigator({});
    expect(await requestPersistent()).toBe(false);
  });

  it('persistedState：在场透传；异常/缺失=null（UI 隐藏状态行）', async () => {
    stubNavigator({ storage: { persisted: async () => true } });
    expect(await persistedState()).toBe(true);
    stubNavigator({ storage: { persisted: async () => Promise.reject(new Error('boom')) } });
    expect(await persistedState()).toBeNull();
    stubNavigator({});
    expect(await persistedState()).toBeNull();
  });

  it('静默尝试：任何形态都不抛出（fire-and-forget）', async () => {
    stubNavigator({});
    expect(() => tryRequestPersistentSilent()).not.toThrow();
    stubNavigator({ storage: { persist: async () => Promise.reject(new Error('boom')) } });
    expect(() => tryRequestPersistentSilent()).not.toThrow();
    await vi.waitFor(() => expect(requestPersistent).toBeDefined());
  });

  it('字体新增成功回调触发静默 persist 尝试（spec §2.1 预授权钩子）', async () => {
    const persist = vi.fn(async () => true);
    stubNavigator({ storage: { persist } });
    await addFontFromFile(fileOf('Foo.ttf'));
    expect(persist).toHaveBeenCalledTimes(1);
  });
});

describe('isPrecacheCacheName（运行时缓存清除保留 precache）', () => {
  it('workbox precache 保留、运行时缓存清除', () => {
    expect(isPrecacheCacheName('workbox-precache-v2-http://localhost/')).toBe(true);
    expect(isPrecacheCacheName('vv-queries-abc')).toBe(false);
  });
});

describe('purgeCategory 七分类删除语义（spec §2.2 表格逐行）', () => {
  it('设置：删 localStorage vviewer:settings 键（其余键不动；重载由 UI 层承担）', async () => {
    localStorage.setItem('vviewer:settings', '{"autoRefresh":false}');
    localStorage.setItem('vv:capabilities', '["file-server"]');
    const r = await purgeCategory('settings');
    expect(r.deleted).toBe(1);
    expect(localStorage.getItem('vviewer:settings')).toBeNull();
    expect(localStorage.getItem('vv:capabilities')).toBe('["file-server"]');
  });

  it('会话快照：删 kv 的 tabs/workspaces 两键，dirHandle 保留', async () => {
    await rawPut('kv', 'tabs', []);
    await rawPut('kv', 'workspaces', { activeId: 'w', workspaces: [] });
    await rawPut('kv', 'dirHandle', { name: 'docs' });
    const r = await purgeCategory('sessions');
    expect(r.deleted).toBe(2);
    expect(await rawKeys('kv')).toEqual(['dirHandle']);
  });

  it('目录授权句柄：删 kv 的 dirHandle 键，快照保留', async () => {
    await rawPut('kv', 'tabs', []);
    await rawPut('kv', 'dirHandle', { name: 'docs' });
    const r = await purgeCategory('dirhandle');
    expect(r.deleted).toBe(1);
    expect(await rawKeys('kv')).toEqual(['tabs']);
  });

  it('导入主题：themes clear + appearance 槽位引用回落 default（订阅链落盘），内置引用不动', async () => {
    await rawPut('themes', 'imported:abc', { id: 'imported:abc' });
    localStorage.setItem(
      'vviewer:settings',
      JSON.stringify({ appearanceLight: 'imported:abc', appearanceDark: 'vscode:Dark Modern' })
    );
    const r = await purgeCategory('themes');
    expect(r.deleted).toBe(1);
    expect(await rawKeys('themes')).toEqual([]);
    const s = loadSettings();
    expect(s.appearanceLight).toBe('default'); // imported 引用回落
    expect(s.appearanceDark).toBe('vscode:Dark Modern'); // 内置引用不动
    expect(JSON.parse(localStorage.getItem('vviewer:settings')!).appearanceLight).toBe('default');
  });

  it('网络字体：fonts 逐个删除（document.fonts 注销）+ uiFamily/codeFamily 引用回落默认栈', async () => {
    await addFontFromFile(fileOf('Foo.ttf'));
    await addFontFromFile(fileOf('Bar.ttf'));
    localStorage.setItem(
      'vviewer:settings',
      JSON.stringify({ fonts: { uiFamily: 'Foo', codeFamily: 'Bar' } })
    );
    expect(fontSet.added).toHaveLength(2);
    const r = await purgeCategory('fonts');
    expect(r.deleted).toBe(2);
    expect(await rawKeys('fonts')).toEqual([]);
    expect(fontSet.removed).toHaveLength(2); // 逐个注销（faceCache 命中）
    const s = loadSettings();
    expect(s.fonts.uiFamily).toBe('');
    expect(s.fonts.codeFamily).toBe('');
  });

  it('挂载配置：Spec 5 未落地占位——no-op 零删除（UI 禁用态）', async () => {
    const r = await purgeCategory('mounts');
    expect(r.deleted).toBe(0);
  });

  it('运行时缓存：caches.delete 逐个清除非 precache 项，precache 保留', async () => {
    const { deleted } = stubCaches(['workbox-precache-v2-x', 'vv-queries-abc', 'vv-media']);
    const r = await purgeCategory('runtime-cache');
    expect(r.deleted).toBe(2);
    expect(deleted.sort()).toEqual(['vv-media', 'vv-queries-abc']);
  });

  it('运行时缓存：caches 缺失降级零删除不抛', async () => {
    const r = await purgeCategory('runtime-cache');
    expect(r.deleted).toBe(0);
  });
});

describe('恢复出厂（spec §2.2：全部分类+注销 SW+清全部 Cache Storage）', () => {
  it('全序列：设置/快照/句柄/主题/字体全清；全部缓存（含 precache）清除；SW 注销', async () => {
    localStorage.setItem('vviewer:settings', '{"themeMode":"dark"}');
    localStorage.setItem('other:key', 'keep-unrelated? no—kv 清库即可');
    await rawPut('kv', 'tabs', []);
    await rawPut('kv', 'workspaces', { activeId: 'w', workspaces: [] });
    await rawPut('kv', 'dirHandle', { name: 'docs' });
    await rawPut('themes', 'imported:abc', { id: 'imported:abc' });
    await addFontFromFile(fileOf('Foo.ttf'));
    const { deleted } = stubCaches(['workbox-precache-v2-x', 'vv-queries-abc']);
    const unregister = vi.fn(async () => true);
    stubNavigator({
      storage: {},
      serviceWorker: { getRegistrations: async () => [{ unregister }] }
    });
    const r = await factoryReset();
    expect(localStorage.getItem('vviewer:settings')).toBeNull();
    expect(await rawKeys('kv')).toEqual([]);
    expect(await rawKeys('themes')).toEqual([]);
    expect(await rawKeys('fonts')).toEqual([]);
    expect(deleted.sort()).toEqual(['vv-queries-abc', 'workbox-precache-v2-x']); // 全部含 precache
    expect(unregister).toHaveBeenCalledTimes(1);
    expect(r).toEqual({ cachesCleared: 2, swUnregistered: 1 });
  });

  it('serviceWorker 缺失降级：swUnregistered=0 不抛', async () => {
    stubCaches([]);
    const r = await factoryReset();
    expect(r.swUnregistered).toBe(0);
  });
});
