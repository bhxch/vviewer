export interface TabSnapshot {
  id: string;
  storeId: string;
  storeLabel: string;
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
    const tx = d.transaction(STORE, 'readwrite').objectStore(STORE).put(value, key);
    tx.onsuccess = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function saveTabs(tabs: TabSnapshot[]): Promise<void> { await kvPut('tabs', tabs); }
export async function saveDirHandle(h: FileSystemDirectoryHandle | null): Promise<void> { await kvPut('dirHandle', h); }

export async function loadSession(): Promise<{ tabs: TabSnapshot[]; lastDirHandle: FileSystemDirectoryHandle | null }> {
  const [tabs, lastDirHandle] = await Promise.all([kvGet<TabSnapshot[]>('tabs'), kvGet<FileSystemDirectoryHandle>('dirHandle')]);
  return { tabs: tabs ?? [], lastDirHandle: lastDirHandle ?? null };
}
