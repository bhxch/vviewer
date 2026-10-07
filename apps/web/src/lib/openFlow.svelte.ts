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
import { saveDirHandle, saveTabs, maxTabSeqOf, type TabSnapshot } from './stores/session';
import { releaseStoreIfLast } from './storeRelease';

export interface Tab {
  id: string;
  source: FileSource;
  scrollTop: number;
  active: boolean;
  /** 会话恢复的占位 tab：内容无法自动还原，需用户重新打开 */
  unrestorable?: boolean;
  /** 渲染代数：SSE 变更刷新自增（ViewerPane 渲染 effect 依赖它重跑）；不进会话快照 */
  rev?: number;
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
   * 判定逻辑在 storeRelease.ts（纯函数，可独立单测）。
   */
  private releaseStoreIfLast(store: TreeStore): void {
    releaseStoreIfLast(this.list, store);
  }

  activate(id: string): void {
    for (const t of this.list) t.active = t.id === id;
    void persist();
  }

  /**
   * SSE 变更刷新（M5）：重读并重渲染命中 store+path 的 tab。
   * rev 自增使 ViewerPane 的渲染 effect（依赖 tab 代理）重跑；内容不在会话快照内，无需 persist。
   * 目录 tab（path=''）不在 paths 内：任何 changed 都视为树可能变化，一并自增——
   * AppShell 以目录 tab 的 rev 为 key 重建左栏 FileTree。
   */
  refreshPaths(storeId: string, paths: string[]): void {
    for (const t of this.list) {
      if (t.source.storeId !== storeId) continue;
      if (t.source.path !== '' && paths.length > 0 && !paths.includes(t.source.path)) continue;
      t.rev = (t.rev ?? 0) + 1;
    }
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

/**
 * SSE 变更推送健康状态（终审 B2）：服务端 watch-error（watcher 启动失败或运行期
 * 故障降级）到达即置位——状态栏一次性提示"自动刷新不可用"；下次连接成功复位。
 */
export const watchHealth = $state({ degraded: false });

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

/**
 * 以会话快照的最大 tab id 为基推进 seq（终审 M7：占位 tab 防线）。
 * 恢复的占位 tab 保留快照旧 id（如 t5），seq 若从 0 重新计数，新 tab 的 t1/t2
 * 会与占位 id 撞车（activate/close 按 id 找首个匹配即错乱）。AppShell.restore
 * 在恢复循环前调用；id 解析（tabSeqOf/maxTabSeqOf）在 stores/session 可单测。
 */
export function seedSeqFromSnapshots(snaps: ReadonlyArray<TabSnapshot>): void {
  seq = Math.max(seq, maxTabSeqOf(snaps.map((s) => s.id)));
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

/** 连接时 health capabilities 的会话缓存键（M6 compute 路由的能力判定来源）。 */
const CAPABILITIES_KEY = 'vv:capabilities';

/** 读取会话能力缓存（无记录/损坏/非浏览器环境返回 []）。 */
export function loadCapabilities(): string[] {
  try {
    const raw = sessionStorage.getItem(CAPABILITIES_KEY);
    const v: unknown = raw ? JSON.parse(raw) : null;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

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
 * → POST /api/ticket 鉴权预检（health 免认证，需受保护端点实际验 token）
 * → createRemoteStore（watch 订阅 SSE 变更）→ addDirStoreTab（目录 tab 替换语义）
 * → 记入 sessionStorage。失败抛错给 UI 展示；连接句柄不可持久化，重连本期需手动（M7 恢复）。
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
  // 能力缓存（M6 compute 路由判定用）：compute 端点是否可用以连接时 health 为准
  try {
    sessionStorage.setItem(
      CAPABILITIES_KEY,
      JSON.stringify(caps.capabilities.filter((c): c is string => typeof c === 'string'))
    );
  } catch {
    // 存储不可用：连接本身不受影响，compute 路由回落本地
  }

  // 鉴权预检：health 免认证，错误 token 也能过能力校验——用 Bearer 保护的
  // ticket 端点实际验证令牌，避免"假连接成功后所有数据请求 401、目录树全空"
  let authRes: Response;
  try {
    authRes = await fetch(`${base}/api/ticket`, { method: 'POST', headers });
  } catch {
    throw new Error(`无法连接 ${base}：网络错误或地址不可达`);
  }
  if (!authRes.ok) {
    throw new Error(
      authRes.status === 401 ? '鉴权失败：令牌缺失或错误（HTTP 401）' : `服务器响应异常: HTTP ${authRes.status}`
    );
  }

  // 同 base 重连：先关闭同 base 的旧 remote tab（目录 + 文件）。旧 store 无 tab
  // 持有后经引用计数接线 close()（停 SSE + 清资源表），避免新旧两条事件流并行；
  // 其余目录 tab（本地文件夹）仍由 addDirStoreTab 的替换语义关闭
  for (const t of [...tabStore.list]) {
    if (getRemoteBase(t.source.storeId) === base) tabStore.close(t.id);
  }

  const store = createRemoteStore(base, tok, serverLabel(base));
  // SSE 变更订阅：服务端推送 changed → 命中 path 的 tab 重读重渲染 + 目录 tab 自增
  //（左栏树重建）；watch-error（watcher 降级）→ 状态栏一次性提示自动刷新不可用。
  // store 关闭（最后一个持有 tab 关闭 / 被新连接替换）由引用计数接线调 close() 停流
  watchHealth.degraded = false; // 新连接重置降级指示（上一次连接的降级不复用）
  store.watch(
    (paths) => tabStore.refreshPaths(store.id, paths),
    () => {
      watchHealth.degraded = true;
      console.warn('[vviewer] 服务器变更推送不可用，自动刷新已停用');
    }
  );
  addDirStoreTab(store);
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
