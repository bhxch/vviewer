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
}

const DB = 'vviewer';
const STORE = 'kv';

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
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
