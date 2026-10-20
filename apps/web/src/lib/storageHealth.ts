/**
 * storageHealth.ts — 存储用量计算与分类级清除共享模块（settings center spec
 * §2.1/§2.2，Task 4）。纯 .ts 无 runes（vitest 直测）；「关于」节（只读健康视图）
 * 与「存储与数据」节（操作面）共享本模块，互链跳转。
 *
 * 用量口径（spec §2.1）：
 * - navigator.storage.estimate() 的 quota/usage 为主，usageDetails 存在时透传细分，
 *   不支持（老 WebView）返回 null——UI 隐藏配额区仅显示本地估算行；
 * - localStorage 全键值 UTF-16 估算（键长+值长 ×2）；vviewer:settings 键单独计；
 * - IndexedDB 分 store 计数走 openKeyCursor 一次性遍历：fonts 用记录内 size 字段
 *   求和（spec 2 契约），kv/themes 以 JSON 序列化长度 ×2 估算（与 localStorage 同
 *   口径）；mounts store Spec 5 未落地，不进 StorageInfo（UI 禁用态占位）；
 * - 缓存清单 caches.keys() 原样透传（运行时缓存行显示名称清单，不显示体积——
 *   Response 尺寸遍历成本不成比例，spec §2.2）。
 *
 * 删除语义（spec §2.2 表格逐行）：设置=localStorage 键删除（重载由 UI 层承担，
 * 回落 DEFAULTS）；会话快照=kv 的 tabs/workspaces（保留 dirHandle）；目录授权句柄
 * =kv 的 dirHandle；导入主题=themes clear + appearance 槽位 imported 引用回落
 * default（saveSettings 订阅链生效）；网络字体=fonts 逐个 deleteFont（复用单项
 * 语义：document.fonts 注销）+ uiFamily/codeFamily 引用回落默认栈；挂载配置=
 * Spec 5 前占位 no-op；运行时缓存=非 precache 项逐个 caches.delete（precache
 * 保留——清了破坏离线且无自助重建时机）。恢复出厂=以上全部 + 清全部 Cache +
 * 注销 SW（重载由 UI 层承担）。persist 封装：requestPersistent/persistedState/
 * tryRequestPersistentSilent（字体新增成功回调的预授权钩子，失败静默）。
 */
import { db, FONTS } from './stores/session';
import { deleteFont, listFontRecords } from './stores/fontsStore';
import { loadSettings, saveSettings } from './stores/settings';

export const SETTINGS_KEY = 'vviewer:settings';

/** 会话快照与目录句柄的 kv 键（session.ts 的写入键；删除面按键精确圈定） */
const SNAPSHOT_KEYS = ['tabs', 'workspaces'] as const;
const DIR_HANDLE_KEY = 'dirHandle';

export interface UsageEstimate {
  quota: number;
  usage: number;
  /** Chromium usageDetails 细分（indexedDB/caches/serviceWorker…），缺失为 null */
  details: Record<string, number> | null;
}

export interface StoreStat {
  records: number;
  bytes: number;
}

export interface StorageInfo {
  estimate: UsageEstimate | null;
  /** navigator.storage.persisted()；不支持/异常为 null（UI 隐藏状态行） */
  persisted: boolean | null;
  localStorageBytes: number;
  /** vviewer:settings 单键字节 */
  settingsBytes: number;
  kv: StoreStat;
  themes: StoreStat;
  fonts: StoreStat;
  /** kv 内会话快照两键（tabs+workspaces）字节和（分类行占用估算） */
  kvSnapshotBytes: number;
  /** kv 内 dirHandle 键字节（分类行占用估算） */
  kvDirHandleBytes: number;
  cacheNames: string[];
}

export type StorageCategoryId =
  | 'settings'
  | 'sessions'
  | 'dirhandle'
  | 'themes'
  | 'fonts'
  | 'mounts'
  | 'runtime-cache';

export interface PurgeResult {
  deleted: number;
}

export interface FactoryResetResult {
  cachesCleared: number;
  swUnregistered: number;
}

// ---------- 用量计算（spec §2.1） ----------

/** UTF-16 估算口径：字符串长度 ×2 字节（localStorage 与序列化估算共用） */
const UTF16 = 2;

export function localStorageBytes(): number {
  try {
    let total = 0;
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key === null) continue;
      total += (key.length + (localStorage.getItem(key)?.length ?? 0)) * UTF16;
    }
    return total;
  } catch {
    return 0; // 存储不可用（隐私模式等）：仅缺本地估算行
  }
}

/** vviewer:settings 单键字节（「设置」分类行占用估算） */
export function settingsKeyBytes(): number {
  try {
    const v = localStorage.getItem(SETTINGS_KEY);
    if (v === null) return 0;
    return (SETTINGS_KEY.length + v.length) * UTF16;
  } catch {
    return 0;
  }
}

/**
 * 分 store 单次遍历取计数与体积（spec §2.1「openKeyCursor 一次性遍历」的语义
 * 落地：单游标一遍走完、不实时轮询。实现用 openCursor——key 游标不携带 value，
 * 而 fonts 的 size 求和与 kv/themes 的序列化估算都需要值；一遍 openCursor 同时
 * 拿计数与体积，等价且省一趟逐键 get）。bytesOf 决定体积口径：fonts 记录用已存
 * size 字段；kv/themes 用序列化长度估算。
 */
async function storeStat(
  store: string,
  bytesOf: (value: unknown) => number
): Promise<StoreStat> {
  try {
    const d = await db();
    if (!d.objectStoreNames.contains(store)) return { records: 0, bytes: 0 };
    return await new Promise<StoreStat>((resolve, reject) => {
      const stat: StoreStat = { records: 0, bytes: 0 };
      const req = d.transaction(store, 'readonly').objectStore(store).openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor === null) {
          resolve(stat);
          return;
        }
        stat.records++;
        stat.bytes += bytesOf(cursor.value);
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
    });
  } catch {
    return { records: 0, bytes: 0 }; // 存储不可用：分 store 行归零不阻塞
  }
}

const serializedBytes = (v: unknown): number => (JSON.stringify(v)?.length ?? 0) * UTF16;
const fontRecordBytes = (v: unknown): number =>
  typeof v === 'object' && v !== null && typeof (v as { size?: unknown }).size === 'number'
    ? (v as { size: number }).size
    : 0;

/** kv 单键字节（分类行占用估算；键缺失为 0） */
async function kvKeyBytes(key: string): Promise<number> {
  try {
    const d = await db();
    if (!d.objectStoreNames.contains('kv')) return 0;
    return await new Promise<number>((resolve, reject) => {
      const req = d.transaction('kv', 'readonly').objectStore('kv').get(key);
      req.onsuccess = () => resolve(req.result === undefined ? 0 : serializedBytes(req.result));
      req.onerror = () => reject(req.error);
    });
  } catch {
    return 0;
  }
}

/** 聚合入口（spec §2.1 口径；进分节时调用一次，手动「刷新」重算——不实时轮询） */
export async function collectStorageInfo(): Promise<StorageInfo> {
  const storage = (typeof navigator !== 'undefined' ? navigator.storage : undefined) ?? undefined;
  let estimate: UsageEstimate | null = null;
  let persisted: boolean | null = null;
  if (typeof storage?.estimate === 'function') {
    try {
      // usageDetails 是 Chromium 扩展（lib.dom 的 StorageEstimate 未收录），交叉类型补形
      const e = (await storage.estimate()) as StorageEstimate & { usageDetails?: Record<string, number> };
      if (e && typeof e.quota === 'number' && typeof e.usage === 'number') {
        estimate = {
          quota: e.quota,
          usage: e.usage,
          details: e.usageDetails && typeof e.usageDetails === 'object' ? e.usageDetails : null
        };
      }
    } catch {
      estimate = null; // 异常按不支持降级
    }
  }
  if (typeof storage?.persisted === 'function') {
    try {
      persisted = await storage.persisted();
    } catch {
      persisted = null;
    }
  }
  const [kv, themes, fonts, snapshotBytes, dirHandleBytes] = await Promise.all([
    storeStat('kv', serializedBytes),
    storeStat('themes', serializedBytes),
    storeStat(FONTS, fontRecordBytes),
    kvKeyBytes('tabs').then(async (tabs) => tabs + (await kvKeyBytes('workspaces'))),
    kvKeyBytes(DIR_HANDLE_KEY)
  ]);
  let cacheNames: string[] = [];
  try {
    cacheNames = typeof caches !== 'undefined' ? await caches.keys() : [];
  } catch {
    cacheNames = [];
  }
  return {
    estimate,
    persisted,
    localStorageBytes: localStorageBytes(),
    settingsBytes: settingsKeyBytes(),
    kv,
    themes,
    fonts,
    kvSnapshotBytes: snapshotBytes,
    kvDirHandleBytes: dirHandleBytes,
    cacheNames
  };
}

/** 用量显示格式化（B/KB/MB/GB；KB 起一位小数） */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'] as const;
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v.toFixed(1)} ${units[u]}`;
}

// ---------- 分类级删除（spec §2.2 表格逐行） ----------

async function kvDeleteKeys(keys: readonly string[]): Promise<number> {
  const d = await db();
  const present = new Set(
    await new Promise<string[]>((resolve, reject) => {
      const req = d.transaction('kv', 'readonly').objectStore('kv').getAllKeys();
      req.onsuccess = () => resolve(req.result as string[]);
      req.onerror = () => reject(req.error);
    })
  );
  const hits = keys.filter((k) => present.has(k));
  if (hits.length === 0) return 0;
  await new Promise<void>((resolve, reject) => {
    const tx = d.transaction('kv', 'readwrite');
    for (const k of hits) tx.objectStore('kv').delete(k);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
  });
  return hits.length;
}

async function storeClear(store: string): Promise<number> {
  const d = await db();
  if (!d.objectStoreNames.contains(store)) return 0;
  const count = await new Promise<number>((resolve, reject) => {
    const req = d.transaction(store, 'readonly').objectStore(store).count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  await new Promise<void>((resolve, reject) => {
    const tx = d.transaction(store, 'readwrite');
    tx.objectStore(store).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
  });
  return count;
}

/** workbox precache 判定（恢复出厂清全部、分类清只清非 precache） */
export function isPrecacheCacheName(name: string): boolean {
  return name.includes('workbox-precache');
}

async function cacheNames(): Promise<string[]> {
  try {
    return typeof caches !== 'undefined' ? await caches.keys() : [];
  } catch {
    return [];
  }
}

/**
 * 分类清除（spec §2.2 表格逐行）。确认弹窗（红色危险调+列明后果）由 UI 层承担；
 * 删除即时生效项（主题/字体）走 saveSettings 订阅链实时回退，无需重载；
 * settings 分类删除后由 UI 层 location.reload() 回落 DEFAULTS（订阅链重初始化）。
 */
export async function purgeCategory(cat: StorageCategoryId): Promise<PurgeResult> {
  switch (cat) {
    case 'settings': {
      const had = localStorage.getItem(SETTINGS_KEY) !== null;
      localStorage.removeItem(SETTINGS_KEY);
      return { deleted: had ? 1 : 0 };
    }
    case 'sessions':
      return { deleted: await kvDeleteKeys(SNAPSHOT_KEYS) };
    case 'dirhandle':
      return { deleted: await kvDeleteKeys([DIR_HANDLE_KEY]) };
    case 'themes': {
      const deleted = await storeClear('themes');
      // 引用联动：appearance 槽位引用 imported 主题的回落 default（订阅链生效），
      // 内置（default/vscode:）不受影响
      const s = loadSettings();
      let changed = false;
      if (s.appearanceLight.startsWith('imported:')) {
        s.appearanceLight = 'default';
        changed = true;
      }
      if (s.appearanceDark.startsWith('imported:')) {
        s.appearanceDark = 'default';
        changed = true;
      }
      if (changed) saveSettings(s);
      return { deleted };
    }
    case 'fonts': {
      // 复用单项删除语义扩到批量（spec §2.2）：deleteFont 负责 document.fonts
      // 注销；uiFamily/codeFamily 引用已删字体的槽位回落默认栈（空串）
      const records = await listFontRecords();
      const names = new Set(records.map((r) => r.name));
      for (const rec of records) await deleteFont(rec.id);
      const s = loadSettings();
      let changed = false;
      if (names.has(s.fonts.uiFamily)) {
        s.fonts.uiFamily = '';
        changed = true;
      }
      if (names.has(s.fonts.codeFamily)) {
        s.fonts.codeFamily = '';
        changed = true;
      }
      if (changed) saveSettings(s);
      return { deleted: records.length };
    }
    case 'mounts':
      // Spec 5（目录挂载管理）未落地：mounts store 不存在，分类行以禁用态渲染，
      // 此处 no-op 占位（前向兼容裁决，Spec 5 落地后补 DELETE /api/mounts 尝试）
      return { deleted: 0 };
    case 'runtime-cache': {
      const names = (await cacheNames()).filter((n) => !isPrecacheCacheName(n));
      let deleted = 0;
      for (const name of names) {
        try {
          if (await caches.delete(name)) deleted++;
        } catch {
          // 单项失败不阻断其余
        }
      }
      return { deleted };
    }
  }
}

/**
 * 恢复出厂（spec §2.2 分节底部最高危动作）：全部分类 + 清全部 Cache Storage
 * （含 precache）+ 注销全部 Service Worker。重载由 UI 层承担（二次确认后）。
 */
export async function factoryReset(): Promise<FactoryResetResult> {
  await purgeCategory('sessions');
  await purgeCategory('dirhandle');
  await purgeCategory('themes');
  await purgeCategory('fonts');
  localStorage.removeItem(SETTINGS_KEY);
  let cachesCleared = 0;
  for (const name of await cacheNames()) {
    try {
      if (await caches.delete(name)) cachesCleared++;
    } catch {
      // 单项失败不阻断注销 SW
    }
  }
  let swUnregistered = 0;
  try {
    const regs = (await navigator.serviceWorker?.getRegistrations?.()) ?? [];
    for (const reg of regs) {
      if (await reg.unregister()) swUnregistered++;
    }
  } catch {
    // SW 不可用（非安全上下文等）：数据面已清，重载即全新会话
  }
  return { cachesCleared, swUnregistered };
}

// ---------- 持久化存储（spec §2.1：origin 级 persist 封装） ----------

/** 用户手势内申请持久化存储；拒绝/异常/不支持一律 false（UI 解释常见原因） */
export async function requestPersistent(): Promise<boolean> {
  try {
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}

/** 当前持久化状态；不支持/异常为 null（UI 隐藏状态行） */
export async function persistedState(): Promise<boolean | null> {
  try {
    return (await navigator.storage?.persisted?.()) ?? null;
  } catch {
    return null;
  }
}

/**
 * 静默尝试（fire-and-forget，不抛不打扰）：字体新增成功回调处调用（数据投入
 * 时刻申请是浏览器推荐姿势，spec §2.1 预授权）；结果仅反映在后续状态行。
 */
export function tryRequestPersistentSilent(): void {
  void requestPersistent().catch(() => {});
}
