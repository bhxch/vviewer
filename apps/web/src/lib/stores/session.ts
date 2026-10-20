import type { VscodeThemeJson } from '@vviewer/highlight';
import type { WorkspacesSnapshot } from '../workspaceStore';

export interface TabSnapshot {
  id: string;
  storeId: string;
  storeLabel: string;
  /** RemoteStore 的服务端 base（scheme+host+port）；仅 remote tab 携带，M7 重连恢复用。 */
  storeBase?: string;
  path: string;
  name: string;
  kind: 'restorable' | 'rename-only';
  scrollTop: number;
  active: boolean;
  /** C 项：手选打开方式（override 渲染器 id）；无手选时不写，restore 侧读回重建。 */
  overrideRenderer?: string;
  /** F 项：pinned tab（pinned 区靠左）；仅置位时写入（缺省 = 普通区），restore 侧读回。 */
  pinned?: boolean;
  /**
   * 项 3（遗留清偿波 3）：文件字节数（Tab.source.size 回环）——restore 链把它传回
   * addTab，恢复的远端文件 tab 免 head 探测 + size 未知路径（dispatcher 读策略直取
   * size，hex 亦不退全量）。未知大小（null/缺省）省略字段（对齐 pinned 的「仅置位
   * 写入」风格）；旧快照无该字段 → undefined → 既有探测路径，天然兼容（无需迁移）。
   */
  size?: number | null;
}

/** 导入主题（spec B §2.3）：id='imported:<随机8>'，applyAppearance 按 id 解析注入。 */
export interface ImportedTheme {
  id: string;
  name: string;
  kind: 'dark' | 'light';
  colors: Record<string, string>;
  tokenColors: VscodeThemeJson['tokenColors'];
  source: 'json' | 'vsix';
  addedAt: number;
}

const DB = 'vviewer';
const STORE = 'kv';
const THEMES = 'themes';
/** fonts store（字体系统 spec §5.1，Task 4）：网络字体记录，CRUD 在 fontsStore.ts。 */
export const FONTS = 'fonts';
/** mounts store（目录挂载 spec §3，阶段二 Task 2）：前端保存的代理挂载记录，
 * CRUD 与连接对账在 mountsSync.ts。 */
export const MOUNTS = 'mounts';
/** v2：补建 themes store；v3：补建 fonts store（字体系统 spec §5.1）；
 * v4：补建 mounts store（目录挂载 spec §3——顺延规则：fonts 已占 v3）。
 * 存量原样保留，onupgradeneeded 按需补建。 */
const DB_VERSION = 4;

/** 打开（必要时升级）vviewer 库（export：同库跨 store 的兄弟模块 fontsStore 复用连接）。 */
export function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE);
      if (!d.objectStoreNames.contains(THEMES)) d.createObjectStore(THEMES);
      if (!d.objectStoreNames.contains(FONTS)) d.createObjectStore(FONTS);
      if (!d.objectStoreNames.contains(MOUNTS)) d.createObjectStore(MOUNTS);
    };
    req.onsuccess = () => {
      const conn = req.result;
      // 多标签让路（T3 评审 Important）：他方标签页以更高版本 open 时本连接收到
      // versionchange，主动关闭避免对方 blocked 永挂（loadSession 停摆）。
      conn.onversionchange = () => conn.close();
      resolve(conn);
    };
    req.onerror = () => reject(req.error);
  });
}

async function kvGet<T>(key: string): Promise<T | null> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(STORE, 'readonly').objectStore(STORE).get(key);
    tx.onsuccess = () => resolve((tx.result as T) ?? null);
    tx.onerror = () => reject(tx.error);
  });
}

async function kvPut(key: string, value: unknown): Promise<void> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
  });
}

export async function saveTabs(tabs: TabSnapshot[]): Promise<void> { await kvPut('tabs', tabs); }
export async function saveDirHandle(h: FileSystemDirectoryHandle | null): Promise<void> { await kvPut('dirHandle', h); }

/**
 * 目录句柄（kv 'dirHandle' 单槽）：restore v2（AppShell）以 `localfs:<目录名>`
 * 与快照来源 storeId 匹配后重建对应 workspace 的 localfs 源——多来源时仅名字
 * 一致的那一个可恢复，其余落占位（localfs 句柄无法持久化多个）。
 */
export async function loadDirHandle(): Promise<FileSystemDirectoryHandle | null> {
  return (await kvGet<FileSystemDirectoryHandle>('dirHandle')) ?? null;
}

/**
 * workspaces 快照（v2，kv 键 'workspaces'）：与 'tabs' 并存的新键，
 * 不升 DB 版本（kv store 通吃）。
 */
export async function saveWorkspaces(s: WorkspacesSnapshot): Promise<void> { await kvPut('workspaces', s); }

/**
 * 读工作区快照：'workspaces' 缺失（旧版本会话）回落读旧 'tabs' 键——
 * 一次性迁移入口，旧键保留不删（降级/对照兜底，调用方以 migrateLegacyTabs 迁移）。
 */
export async function loadWorkspaces(): Promise<{ snapshot: WorkspacesSnapshot | null; legacyTabs: TabSnapshot[] }> {
  const [snapshot, legacyTabs] = await Promise.all([
    kvGet<WorkspacesSnapshot>('workspaces'),
    kvGet<TabSnapshot[]>('tabs')
  ]);
  return { snapshot: snapshot ?? null, legacyTabs: legacyTabs ?? [] };
}

/** 主题库列表（spec B §2.3）。 */
export async function listThemes(): Promise<ImportedTheme[]> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const req = d.transaction(THEMES, 'readonly').objectStore(THEMES).getAll();
    req.onsuccess = () => resolve((req.result as ImportedTheme[] | undefined) ?? []);
    req.onerror = () => reject(req.error);
  });
}

/** 入库/更新（themes store 无 keyPath，自管 id 键）。 */
export async function putTheme(t: ImportedTheme): Promise<void> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(THEMES, 'readwrite');
    tx.objectStore(THEMES).put(t, t.id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
  });
}

export async function deleteTheme(id: string): Promise<void> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(THEMES, 'readwrite');
    tx.objectStore(THEMES).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
  });
}

export async function loadSession(): Promise<{ tabs: TabSnapshot[]; lastDirHandle: FileSystemDirectoryHandle | null }> {
  const [tabs, lastDirHandle] = await Promise.all([kvGet<TabSnapshot[]>('tabs'), kvGet<FileSystemDirectoryHandle>('dirHandle')]);
  return { tabs: tabs ?? [], lastDirHandle: lastDirHandle ?? null };
}

/** tab id（`t<序号>`）→ 序号；不匹配形态为 0（快照损坏时按最小基线处理）。 */
export function tabSeqOf(id: string): number {
  const m = /^t(\d+)$/.exec(id);
  return m ? Number(m[1]) : 0;
}

/** 快照 id 列表中的最大序号（空列表为 0）：openFlow 以此为基推进新 tab 序号。 */
export function maxTabSeqOf(ids: ReadonlyArray<string>): number {
  return ids.reduce((max, id) => Math.max(max, tabSeqOf(id)), 0);
}
