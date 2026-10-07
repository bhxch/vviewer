import type { TreeStore, FileSource } from '@vviewer/core';
import {
  createSingleFileStore,
  createUrlStore,
  createLocalFsStore,
  createLocalFilesStore,
  createRemoteStore,
  ensurePermission,
  getRemoteBase,
  normalizeServerBase
} from '@vviewer/core';
import { ARCHIVE_OPEN_EVENT } from '@vviewer/render-archive';
import { saveDirHandle, saveTabs, type TabSnapshot } from './stores/session';

export interface Tab {
  id: string;
  source: FileSource;
  scrollTop: number;
  active: boolean;
  /** 会话恢复的占位 tab：内容无法自动还原，需用户重新打开 */
  unrestorable?: boolean;
}

let seq = 0;

let persistTimer: ReturnType<typeof setTimeout> | null = null;

function snapshot(t: Tab): TabSnapshot {
  // remote tab 额外记服务端 base（显示名仍为 host）：M7 重连恢复需要 scheme+host+port
  const storeBase = getRemoteBase(t.source.storeId);
  return {
    id: t.id,
    storeId: t.source.storeId,
    storeLabel: t.source.storeLabel,
    ...(storeBase !== undefined ? { storeBase } : {}),
    path: t.source.path,
    name: t.source.name,
    kind: t.source.storeId.startsWith('localfs:') ? 'restorable' : 'rename-only',
    scrollTop: t.scrollTop,
    active: t.active
  };
}

async function persist(): Promise<void> {
  await saveTabs(tabStore.list.map(snapshot));
}

/**
 * tabs 的 runes 状态封装。
 * Svelte 5 要求 $state 位于 .svelte.ts；模块级可重赋值导出不受支持，
 * 故以 class 字段承载 $state 数组，openFlow 的导出函数签名保持不变。
 */
class TabCollection {
  list = $state<Tab[]>([]);

  add(store: TreeStore, path: string, name: string): Tab {
    const tab: Tab = {
      id: `t${++seq}`,
      source: { storeId: store.id, storeLabel: store.displayName(), path, name, store },
      scrollTop: 0,
      active: true
    };
    for (const t of this.list) t.active = false;
    this.list.push(tab);
    void persist();
    return tab;
  }

  close(id: string): void {
    const i = this.list.findIndex((t) => t.id === id);
    if (i >= 0) {
      const closed = this.list[i]!;
      const wasActive = closed.active;
      this.list.splice(i, 1);
      if (wasActive) {
        // 关闭活动 tab 时激活相邻 tab，避免出现无活动 tab 的空窗
        const next = this.list[Math.min(i, this.list.length - 1)];
        if (next) next.active = true;
      }
      void persist();
      this.releaseStoreIfLast(closed.source.store);
    }
  }

  /**
   * worker 型 store 的释放接线（M4 T7）：被关 tab 持有的 store 若实现了 close()
   * （libarchive：终止 worker + 释放 wasm 堆）且已无其他 tab 持有同一实例，则关闭之。
   * 以对象身份比较而非 storeId——同名归档会产生 id 相同的不同实例；
   * zip/localfiles 等 store 无 close，可选调用为 no-op。
   */
  private releaseStoreIfLast(store: TreeStore): void {
    if (typeof store.close !== 'function') return;
    if (this.list.some((t) => t.source.store === store)) return;
    store.close();
  }

  activate(id: string): void {
    for (const t of this.list) t.active = t.id === id;
    void persist();
  }

  /** 滚动位置即时写入内存，saveTabs 落盘走 300ms 尾随防抖 */
  persistScroll(id: string, top: number): void {
    const t = this.list.find((x) => x.id === id);
    if (!t) return;
    t.scrollTop = top;
    if (persistTimer !== null) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persistTimer = null;
      void persist();
    }, 300);
  }
}

export const tabStore = new TabCollection();

export function addTab(store: TreeStore, path: string, name: string): Tab {
  return tabStore.add(store, path, name);
}

export function closeTab(id: string): void {
  tabStore.close(id);
}

export function activateTab(id: string): void {
  tabStore.activate(id);
}

export async function persistScroll(id: string, top: number): Promise<void> {
  tabStore.persistScroll(id, top);
}

export function openFiles(files: File[]): void {
  for (const f of files) addTab(createSingleFileStore(f), f.name, f.name);
}

export async function openDirectoryViaPicker(): Promise<void> {
  const w = window as unknown as {
    showDirectoryPicker?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>;
  };
  if (typeof w.showDirectoryPicker !== 'function') {
    openDirectoryViaInputFallback();
    return;
  }
  let handle: FileSystemDirectoryHandle;
  try {
    handle = await w.showDirectoryPicker({ mode: 'read' });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return; // 用户取消选择
    throw err;
  }
  await saveDirHandle(handle);
  addDirStoreTab(createLocalFsStore(handle));
}

export function openDirectoryViaInput(files: FileList | File[]): void {
  const all = Array.from(files);
  const firstPath = all.find((f) => f.webkitRelativePath !== '')?.webkitRelativePath;
  const label = (firstPath ? firstPath.split('/', 1)[0] : undefined) ?? 'folder';
  // webkitdirectory 真实 input 的 File 必带 webkitRelativePath；
  // 其他通道缺失时用 `<label>/文件名` 兜底，避免空路径文件在 store 里变成僵尸条目
  const normalized = all.map((f) => {
    if (f.webkitRelativePath !== '') return f;
    const copy = new File([f], f.name, { type: f.type, lastModified: f.lastModified });
    Object.defineProperty(copy, 'webkitRelativePath', { value: `${label}/${f.name}`, configurable: true });
    return copy;
  });
  addDirStoreTab(createLocalFilesStore(normalized, label));
}

function openDirectoryViaInputFallback(): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.webkitdirectory = true;
  input.onchange = () => {
    if (input.files) openDirectoryViaInput(input.files);
  };
  input.click();
}

// ---------- 服务器连接（M5） ----------

/** 会话内上次成功连接的服务器（sessionStorage，不做持久）。 */
export interface LastServer {
  baseUrl: string;
  token: string | null;
}

const LAST_SERVER_KEY = 'vviewer-last-server';

/** 目录 tab 显示名：取地址 host（解析失败退回原串）。 */
function serverLabel(base: string): string {
  try {
    return new URL(base).host;
  } catch {
    return base;
  }
}

/**
 * 连接 vviewer 文件服务器：GET /api/health 校验（capabilities 须含 file-server）
 * → createRemoteStore → addDirStoreTab（目录 tab 替换语义）→ 记入 sessionStorage。
 * 失败抛错给 UI 展示；连接句柄不可持久化，重连本期需手动（M7 恢复）。
 */
export async function connectServer(baseUrl: string, token: string | null): Promise<void> {
  const base = normalizeServerBase(baseUrl); // 缺 scheme 补 http://、去尾部斜杠
  const tok = token?.trim() ? token.trim() : null;

  const headers: Record<string, string> = {};
  if (tok) headers.authorization = `Bearer ${tok}`;
  let res: Response;
  try {
    res = await fetch(`${base}/api/health`, { headers });
  } catch {
    throw new Error(`无法连接 ${base}：网络错误或地址不可达`);
  }
  if (!res.ok) throw new Error(`服务器响应异常: HTTP ${res.status}`);
  let caps: { capabilities?: unknown };
  try {
    caps = (await res.json()) as { capabilities?: unknown };
  } catch {
    throw new Error('health 响应不是有效 JSON');
  }
  if (!Array.isArray(caps.capabilities) || !caps.capabilities.includes('file-server')) {
    throw new Error('目标不是 vviewer 文件服务器（缺少 file-server 能力）');
  }

  addDirStoreTab(createRemoteStore(base, tok, serverLabel(base)));
  try {
    sessionStorage.setItem(
      LAST_SERVER_KEY,
      JSON.stringify({ baseUrl: base, token: tok } satisfies LastServer)
    );
  } catch {
    // 存储不可用（隐私模式等）：连接本身不受影响
  }
}

/** 读取会话内上次成功连接的服务器（供连接表单预填；无记录/损坏返回 null）。 */
export function loadLastServer(): LastServer | null {
  try {
    const raw = sessionStorage.getItem(LAST_SERVER_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<LastServer>;
    if (typeof v.baseUrl !== 'string' || v.baseUrl === '') return null;
    return { baseUrl: v.baseUrl, token: typeof v.token === 'string' && v.token !== '' ? v.token : null };
  } catch {
    return null;
  }
}

/** 目录来源以一个"目录 tab"表达：path=''，ViewerPane 显示引导提示，文件树渲染在左栏 */
function addDirStoreTab(store: TreeStore): void {
  // spec 不做多根工作区，采用替换语义：添加新目录 tab 前先关闭既有目录 tab，
  // 避免连续打开第二个文件夹后文件树仍钉在第一个目录
  for (const t of [...tabStore.list]) {
    if (t.source.path === '') tabStore.close(t.id);
  }
  addTab(store, '', store.displayName());
}

export async function tryRestoreDirectory(handle: FileSystemDirectoryHandle): Promise<boolean> {
  if (!(await ensurePermission(handle))) return false;
  addDirStoreTab(createLocalFsStore(handle));
  return true;
}

export function openUrl(url: string): void {
  let name = url.split('/').pop() ?? url;
  name = name.split(/[?#]/, 1)[0] ?? name;
  try {
    name = decodeURIComponent(name);
  } catch {
    // 非法百分号编码：保留原样作为显示名
  }
  addTab(createUrlStore(url), name, name);
}

/**
 * 监听 render-archive 的包内文件点击事件（ARCHIVE_OPEN_EVENT）→ addTab 派发器自然路由。
 * AppShell onMount 调用一次；返回解绑函数（HMR/卸载用）。
 */
export function bindArchiveOpenEvents(): () => void {
  const handler = (ev: Event): void => {
    const detail = (ev as CustomEvent<{ store: TreeStore; path: string; name: string }>).detail;
    if (!detail || typeof detail.path !== 'string') return;
    addTab(detail.store, detail.path, detail.name);
  };
  window.addEventListener(ARCHIVE_OPEN_EVENT, handler);
  return () => window.removeEventListener(ARCHIVE_OPEN_EVENT, handler);
}

// E2E 调试钩子：webkitdirectory input 与 FS Access 均无法被 Playwright 自动化，
// 测试在 page.evaluate 内构造带 webkitRelativePath 的 File 数组后经此注入，
// 走与真实 input change 完全相同的 openDirectoryViaInput 通道。生产环境无调用方，无害。
if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__vvOpenDirImpl = (files: FileList | File[]) =>
    openDirectoryViaInput(files);
}
