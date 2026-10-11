import type { TreeStore, FileSource } from '@vviewer/core';
import {
  createSingleFileStore,
  createUrlStore,
  createLocalFsStore,
  createLocalFilesStore,
  createRemoteStore,
  ensurePermission,
  getRemoteBase,
  normalizeServerBase,
  SESSION_LAST_SERVER_KEY,
  type LastServerRecord
} from '@vviewer/core';
import { ARCHIVE_OPEN_EVENT } from '@vviewer/render-archive';
import {
  saveDirHandle,
  saveWorkspaces,
  maxTabSeqOf,
  type TabSnapshot
} from './stores/session';
import type { WorkspacesSnapshot, Workspace, WorkspaceSource } from './workspaceStore';
import { sourceKindOf, workspaceStore } from './workspaceStore';
import { loadSettings } from './stores/settings';
import { releaseStoreIfLast } from './storeRelease';
import { saveSearchEngine } from './searchEngineCache';

export interface Tab {
  id: string;
  /** 所属工作区（workspaceStore.activeId 快照于入列时；作用域化 add/close/activate 的依据） */
  workspaceId: string;
  source: FileSource;
  scrollTop: number;
  active: boolean;
  /** 会话恢复的占位 tab：内容无法自动还原，需用户重新打开 */
  unrestorable?: boolean;
  /** 渲染代数：SSE 变更刷新自增（ViewerPane 渲染 effect 依赖它重跑）；不进会话快照 */
  rev?: number;
  /** C 项：手选打开方式（override 渲染器 id）。缺省 = 自动路由；写进会话快照 */
  overrideRenderer?: string;
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
    active: t.active,
    ...(t.overrideRenderer !== undefined ? { overrideRenderer: t.overrideRenderer } : {})
  };
}

async function persist(): Promise<void> {
  // 快照 v2：TabSnapshot 按所属 workspace 分组落 'workspaces' 键，activeTabId 记组内活动。
  // AppShell.restore 自 T4 起读 loadWorkspaces（v2 + 旧键迁移），旧 'tabs' 键的过渡期
  // 双写移除：迁移后只写 'workspaces'（旧键保留最后一次迁移副本，progress.md 裁决）
  await saveWorkspaces({
    activeId: workspaceStore.activeId,
    workspaces: workspaceStore.list.map((w) => {
      const tabs = tabStore.tabsOf(w.id);
      return {
        ...w,
        sources: [...w.sources],
        tabs: tabs.map(snapshot),
        activeTabId: tabs.find((t) => t.active)?.id ?? null
      };
    })
  });
}

/**
 * tabs 的 runes 状态封装。
 * Svelte 5 要求 $state 位于 .svelte.ts；模块级可重赋值导出不受支持，
 * 故以 class 字段承载 $state 数组，openFlow 的导出函数签名保持不变。
 */
class TabCollection {
  list = $state<Tab[]>([]);

  /** 当前工作区 id（委托 workspaceStore 单例；add/close/activate 的作用域来源） */
  get activeWorkspaceId(): string {
    return workspaceStore.activeId;
  }

  /** 某工作区的 tabs（全量 list 的过滤视图；元素仍是 $state 代理，写穿有效） */
  tabsOf(wsId: string): Tab[] {
    return this.list.filter((t) => t.workspaceId === wsId);
  }

  add(store: TreeStore, path: string, name: string): Tab {
    const tab: Tab = {
      id: `t${++seq}`,
      workspaceId: workspaceStore.activeId,
      source: { storeId: store.id, storeLabel: store.displayName(), path, name, store },
      scrollTop: 0,
      active: true
    };
    // 激活作用域收窄到所属 workspace：他组的活动 tab 不被顶掉
    //（单工作区时与旧的全局去活行为一致——新 tab 必成为组内唯一活动）
    for (const t of this.tabsOf(tab.workspaceId)) t.active = false;
    this.list.push(tab);
    activeStores.set(store.id, store); // 实例注册表（storeById 的数据源）
    void persist();
    // BUG-69：必须返回 $state 数组内元素（响应式代理）而非上面的裸对象 tab——
    // Svelte 5 $state 深代理的响应性按属性缓存（首读定值），add 内同步 persist 的
    // snapshot 首读之后，调用方对裸对象的属性写（AppShell.restore 透传
    // scrollTop/overrideRenderer、addPlaceholderTab 置 unrestorable、GlobalSearchPanel
    // 写 pendingLine）全部绕过 set trap 恒不生效（BUG-64 scrollTop 恢复恒 0 的真正根因）
    return this.list[this.list.length - 1]!;
  }

  close(id: string): void {
    const i = this.list.findIndex((t) => t.id === id);
    if (i >= 0) {
      const closed = this.list[i]!;
      const wasActive = closed.active;
      this.list.splice(i, 1);
      if (wasActive) {
        // 关闭活动 tab 时激活相邻 tab，避免出现无活动 tab 的空窗；
        // 多根下激活限同 workspace 组内（先右后左取最近邻），不跨组抢激活
        //（单工作区时右邻/左邻即旧的 list[min(i, len-1)]，行为一致）
        let neighbor: Tab | undefined;
        for (let j = i; j < this.list.length; j++) {
          if (this.list[j]!.workspaceId === closed.workspaceId) {
            neighbor = this.list[j];
            break;
          }
        }
        if (!neighbor) {
          for (let j = i - 1; j >= 0; j--) {
            if (this.list[j]!.workspaceId === closed.workspaceId) {
              neighbor = this.list[j];
              break;
            }
          }
        }
        if (neighbor) neighbor.active = true;
      }
      void persist();
      // 实例注册表清理：该 storeId 已无任何 tab 持有时摘除（与 releaseStoreIfLast
      // 的对象身份计数无关——注册表按 storeId 键控，同 id 换新实例由 add 重新覆盖）
      if (!this.list.some((t) => t.source.storeId === closed.source.storeId)) {
        activeStores.delete(closed.source.storeId);
      }
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
    const target = this.list.find((t) => t.id === id);
    if (!target) return;
    // 激活作用域限目标 tab 所属 workspace：组内唯一活动，他组活动保持记忆
    for (const t of this.tabsOf(target.workspaceId)) t.active = t.id === id;
    void persist();
  }

  /**
   * SSE 变更刷新（M5）：重读并重渲染命中 store+path 的 tab。
   * rev 自增使 ViewerPane 的渲染 effect（依赖 tab 代理）重跑；内容不在会话快照内，无需 persist。
   * 目录 tab（path=''）不在 paths 内：任何 changed 都视为树可能变化，一并自增——
   * AppShell 以目录 tab 的 rev 为 key 重建左栏 FileTree。
   */
  refreshPaths(storeId: string, paths: string[]): void {
    // M-2（T4 评审遗留）：任何变更推送/手动刷新都视为「源数据可能变化」信号——
    // 旧 treeKey 只聚合目录 tab rev，恢复的 remote 源没有目录 tab（重连不自动弹
    // 树）时左栏树不随 SSE 重建；storeRevisions 分桶自增与目录 tab 的「任何 changed
    // 无条件自增」语义对齐，且天然覆盖只有文件 tab 的源（T7 分桶：无关源不重建）
    storeRevisions[storeId] = (storeRevisions[storeId] ?? 0) + 1;
    for (const t of this.list) {
      if (t.source.storeId !== storeId) continue;
      if (t.source.path !== '' && paths.length > 0 && !paths.includes(t.source.path)) continue;
      t.rev = (t.rev ?? 0) + 1;
    }
  }

  /** 滚动位置即时写入内存，persist（saveWorkspaces 快照）走 300ms 尾随防抖 */
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

  /** C 项：手选打开方式。rev++ 复用 SSE 刷新的重渲染通道；persist 落快照。
   * 值未变化（同为空或同 id）时提前返回：重复手选同一方式/重复清除不 rev++、不落盘，
   * 避免无意义的重渲染与会话写盘。 */
  setRendererOverride(tabId: string, rendererId: string | null): void {
    const tab = this.list.find((t) => t.id === tabId);
    if (!tab) return;
    const unchanged =
      rendererId === null
        ? tab.overrideRenderer === undefined
        : tab.overrideRenderer === rendererId;
    if (unchanged) return;
    if (rendererId === null) delete tab.overrideRenderer;
    else tab.overrideRenderer = rendererId;
    tab.rev = (tab.rev ?? 0) + 1;
    void persist(); // 与 persistScroll 同款落盘入口（saveWorkspaces 快照）
  }
}

export const tabStore = new TabCollection();

/**
 * 活动 store 实例注册表：storeId → TreeStore（会话内尚有 tab 持有的实例）。
 * workspace.sources 只存 storeId/元数据（可持久化）；文件树/面板需要活实例时经
 * storeById 解析（AppShell.restore 也据它判断来源是否已重建）。
 * 刻意用普通 Map 而非 $state：注册表仅在 TabCollection.add/close 的同一同步调用内
 * 增删，UI 侧读 tabStore.list（$state）建立响应式依赖即可——list 变化是注册表
 * 变化的超集信号，且避免 $state 深代理包裹 store 实例引入的代理身份问题。
 */
const activeStores = new Map<string, TreeStore>();

/**
 * 活动 store 数据版本信号（M-2，T4 评审遗留；T7 分桶化）：TabCollection.refreshPaths
 * 按调用 storeId 分桶自增（SSE changed / 手动刷新 ↻）。AppShell treeKey 聚合
 * 「当前 workspace 全部源的版本」——单值全局 token（T5 形态）会使无关 workspace 的
 * 帧也重建当前树并丢 TreeNodeRow 展开态（严格超集语义的代价）；按 storeId 分桶后
 * 只有所涉源的变更才重建树。$state 对象承载的原因同 TabCollection（模块级可重赋值
 * 导出不受 Svelte 5 支持）。
 */
export const storeRevisions = $state<Record<string, number>>({});

/** storeId → 活动实例；无 tab 持有（未打开/已全部关闭）返回 null。 */
export function storeById(storeId: string): TreeStore | null {
  return activeStores.get(storeId) ?? null;
}

/**
 * workspaceStore 的 runes 镜像（workspaceStore 是普通发布订阅模块，Svelte 不可
 * 追踪）：模块级订阅先于任何组件挂载与 AppShell.restore 的 replaceAll，通知不丢；
 * UI 层（文件树/面板/T5 切换器/T6 TabBar 过滤）读本镜像建立响应式。
 */
export const workspacesView = $state<{ list: Workspace[]; activeId: string }>({
  list: [...workspaceStore.list],
  activeId: workspaceStore.activeId
});
workspaceStore.onWorkspacesChanged((s) => {
  workspacesView.list = s.list;
  workspacesView.activeId = s.activeId;
});

/**
 * SSE 变更推送健康状态（终审 B2）：服务端 watch-error（watcher 启动失败或运行期
 * 故障降级）到达即置位——状态栏一次性提示"自动刷新不可用"；下次连接成功复位。
 */
export const watchHealth = $state({ degraded: false });

/**
 * 状态栏一次性提示（遗留 U1）：空目录拖入等无法归属到单个 tab 的轻量异常。
 * 文本非空时 ViewerPane 状态栏显示，数秒后自动清除；与 watchHealth 同为模块级
 * runes 状态，openFlow 写入、UI 只读。
 */
export const statusNotice = $state({ text: '' });
let noticeTimer: ReturnType<typeof setTimeout> | null = null;

/** 显示一条临时状态栏提示（duration 后自动清除；连发时重置计时） */
export function showStatusNotice(text: string, duration = 4000): void {
  statusNotice.text = text;
  if (noticeTimer !== null) clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    noticeTimer = null;
    statusNotice.text = '';
  }, duration);
}

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
 * 快照 v2 兼容：workspace 快照从各 workspace.tabs 取最大序号。
 */
export function seedSeqFromSnapshots(snaps: ReadonlyArray<TabSnapshot> | WorkspacesSnapshot): void {
  const ids =
    'workspaces' in snaps
      ? snaps.workspaces.flatMap((w) => w.tabs.map((t) => t.id))
      : snaps.map((s) => s.id);
  seq = Math.max(seq, maxTabSeqOf(ids));
}

/**
 * boot 后是否已有用户操作（restore 快点击竞态防线，T7）：__vvOpenDirImpl 注入钩子
 * 与 TopBar 的打开入口在模块初始化即可用，早于 AppShell.restore 的异步 IndexedDB
 * 读取完成——并行加载/慢盘下，用户（或 e2e 注入）的打开会先于快照进入模型。
 * 启动基线是「单个默认组、无来源、无 tab」，故三者任一成立即发生过用户操作：
 * restore 据此分流——无活动照旧 replaceAll 整体恢复，有活动改 mergeSnapshot 合并
 * （replaceAll 会抹掉已登记的来源而 tab 留存，左栏树与 tab 集合脱节）。
 * 在决策点（await 之后、落模型之前）调用，天然覆盖等待期间到达的操作。
 */
export function hasUserActivity(): boolean {
  return (
    tabStore.list.length > 0 ||
    workspaceStore.list.length > 1 ||
    workspaceStore.list.some((w) => w.sources.length > 0)
  );
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
    // BUG-19：用户取消（headless/自动化下立即取消）此前零反馈——接入状态栏一次性提示
    if (err instanceof DOMException && err.name === 'AbortError') {
      showStatusNotice('已取消选择文件夹');
      return;
    }
    throw err;
  }
  await saveDirHandle(handle);
  addDirStoreTab(createLocalFsStore(handle));
}

export function openDirectoryViaInput(files: FileList | File[]): void {
  const all = Array.from(files);
  if (all.length === 0) {
    // 空目录（input webkitdirectory 选空文件夹 / 拖入空目录）：此前静默无反馈，
    // 状态栏一次性提示说明原因（遗留 U1）
    showStatusNotice('所选文件夹为空');
    return;
  }
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
  // BUG-19：webkitdirectory 回退通道的用户取消此前零反馈——cancel 事件接同一文案
  input.oncancel = () => showStatusNotice('已取消选择文件夹');
  input.click();
}

// ---------- 服务器连接（M5） ----------

/**
 * 会话内上次成功连接的服务器（sessionStorage，不做持久）。
 * 键名与值形状的权威定义在 @vviewer/core（SESSION_LAST_SERVER_KEY/LastServerRecord）：
 * render-media av.ts 的 HLS 直连 XHR 鉴权读同一键，形状改动须走 core 单点。
 */
export type LastServer = LastServerRecord;

const LAST_SERVER_KEY = SESSION_LAST_SERVER_KEY;

/** 连接时 health capabilities 的会话缓存键（M6 compute 路由的能力判定来源）。 */
const CAPABILITIES_KEY = 'vv:capabilities';

/** 连接时 health computeLanguages 的会话缓存键（BUG-06c：auto 策略远程路由的
 * 服务端语言集合依据；空/缺失 = 未知，路由保持既有先试远程行为）。 */
const COMPUTE_LANGUAGES_KEY = 'vv:compute-languages';

/** 读取会话级服务端高亮语言集合（BUG-06c；无记录/损坏/非数组返回 [] 表示未知）。 */
export function loadComputeLanguages(): string[] {
  try {
    const raw = sessionStorage.getItem(COMPUTE_LANGUAGES_KEY);
    const v: unknown = raw ? JSON.parse(raw) : null;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

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
 * → createRemoteStore（watch 订阅 SSE 变更）→ addDirStoreTab（目录 tab 加入当前
 * workspace，同 storeId 去重激活）
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
  let caps: { capabilities?: unknown; computeLanguages?: unknown; searchEngine?: unknown };
  try {
    caps = (await res.json()) as {
      capabilities?: unknown;
      computeLanguages?: unknown;
      searchEngine?: unknown;
    };
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
  // 服务端高亮语言集合缓存（BUG-06c）：compute 宣告则缓存，未宣告（旧服务端）
  // 清除旧缓存表示未知，路由保持既有先试远程行为
  try {
    if (Array.isArray(caps.computeLanguages)) {
      sessionStorage.setItem(
        COMPUTE_LANGUAGES_KEY,
        JSON.stringify(caps.computeLanguages.filter((x): x is string => typeof x === 'string'))
      );
    } else {
      sessionStorage.removeItem(COMPUTE_LANGUAGES_KEY);
    }
  } catch {
    // 存储不可用：路由回落既有行为，连接不受影响
  }
  // 搜索引擎宣告缓存（A 项）：旧服务端无字段 → 清缓存，徽标不显示
  saveSearchEngine(caps.searchEngine);

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
  // 持有后经引用计数接线 close()（停 SSE + 清资源表），避免新旧两条事件流并行
  for (const t of [...tabStore.list]) {
    if (getRemoteBase(t.source.storeId) === base) tabStore.close(t.id);
  }

  const store = createRemoteStore(base, tok, serverLabel(base));
  // SSE 变更订阅：服务端推送 changed → 命中 path 的 tab 重读重渲染 + 目录 tab 自增
  //（左栏树重建）；watch-error（watcher 降级）→ 状态栏一次性提示自动刷新不可用。
  // store 关闭（最后一个持有 tab 关闭 / 被新连接替换）由引用计数接线调 close() 停流
  watchHealth.degraded = false; // 新连接重置降级指示（上一次连接的降级不复用）
  store.watch(
    (paths) => {
      // BUG-05：设置面板 autoRefresh 关闭时停用目录树/文件的自动重读
      //（手动刷新 ↻ 不受影响）；实时读 settings，面板开关即时生效
      if (!loadSettings().autoRefresh) return;
      tabStore.refreshPaths(store.id, paths);
    },
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

/**
 * TreeStore → workspace 来源登记项（kind 由 storeId 前缀推导；storeBase 仅 remote 有）。
 * rootIndex/basePath 不在此派生：storeId 中 basePath 段是 32 位 FNV 指纹不可反解
 * （T3 评审约束），运行期经本函数登记的来源只有根 0/无 basePath 形态；多根远端
 * 来源由 T5 的 openRemoteSource 显式携带 rootIndex/basePath 构造后调 addSource。
 */
function sourceOf(store: TreeStore): WorkspaceSource {
  const base = getRemoteBase(store.id);
  return {
    kind: sourceKindOf(store.id),
    storeId: store.id,
    storeLabel: store.displayName(),
    ...(base !== undefined ? { storeBase: base } : {})
  };
}

/** 目录来源以一个"目录 tab"表达：path=''，ViewerPane 显示引导提示，文件树渲染在左栏。
 * 多根工作区（T4）：来源先登记进当前 workspace（workspace.sources 是文件树/
 * QuickOpen/全局搜索的数据锚，addSource 按 storeId 组内去重）；目录 tab 跨 workspace
 * 全局去重（T3 遗留裁决）：同 storeId 已有目录 tab 则激活之并切换到其所在 workspace
 * ——用户点树/连接里一个已打开的目录 = 回到它，不重复建。
 * T5：source 可显式传入（openRemoteSource 携带 rootIndex/basePath——sourceOf 派生
 * 不出多根字段，storeId 的 basePath 段是 32 位 FNV 指纹不可反解）；缺省走 sourceOf。
 * 去重命中切换 workspace 后对目标组补登记：addSource 按 storeId 去重，目标组已有
 * （含完整多根字段）为 no-op，缺了才补——不会丢 rootIndex/basePath。 */
export function addDirStoreTab(store: TreeStore, source: WorkspaceSource = sourceOf(store)): void {
  const existing = tabStore.list.find((t) => t.source.path === '' && t.source.storeId === store.id);
  if (existing) {
    if (existing.workspaceId !== workspaceStore.activeId) {
      workspaceStore.setActive(existing.workspaceId);
    }
    tabStore.activate(existing.id);
    workspaceStore.addSource(workspaceStore.activeId, source);
    return;
  }
  workspaceStore.addSource(workspaceStore.activeId, source);
  addTab(store, '', store.displayName());
}

/**
 * 后端路径来源（T5）：多根服务器的指定根/根内子目录（或根内单文件）作为来源——
 * createRemoteStore 显式携带 rootIndex/basePath（storeId 的 basePath 段是 32 位
 * FNV 指纹，恢复链路从快照 sources[] 读取，绝不反解）+ addSource + 目录 tab
 * （path=''，basePath 为源根）；file 提供时为单文件来源（spec：远端来源仅目录或
 * 单文件）——底层模型仍以 basePath 目录为源（RemoteStore 以目录为粒度），额外
 * 打开该文件的 tab；同目录多个单文件来源共享同一 storeId（addSource 去重）。
 * 重复打开防线：先按 storeBase+rootIndex+basePath 查各 workspace 已登记来源，
 * 命中且实例存活（storeById）直接复用——再 createRemoteStore 会得到同 id 新实例
 * 而旧实例 SSE 流未关（双流）；实例已随最后一个 tab 关闭释放时才走新建
 * （close() 已清资源表，新实例重新登记）。
 */
export function openRemoteSource(
  base: string,
  token: string | null,
  rootIndex: number,
  basePath: string,
  file?: string
): void {
  const normBase = normalizeServerBase(base);
  const normPath = basePath.replace(/^\/+|\/+$/g, ''); // 与 RemoteStore 内部归一同款
  for (const w of workspacesView.list) {
    const src = w.sources.find(
      (s) =>
        s.kind === 'remote' &&
        s.storeBase === normBase &&
        (s.rootIndex ?? 0) === rootIndex &&
        (s.basePath ?? '') === normPath
    );
    if (src === undefined) continue;
    const store = storeById(src.storeId);
    if (store === null) continue; // 该来源的 tab 已全部关闭：走新建
    const source: WorkspaceSource = {
      kind: 'remote',
      storeId: store.id,
      storeLabel: store.displayName(),
      storeBase: normBase,
      ...(rootIndex !== 0 ? { rootIndex } : {}),
      ...(normPath !== '' ? { basePath: normPath } : {})
    };
    if (file === undefined) addDirStoreTab(store, source);
    else {
      workspaceStore.addSource(workspaceStore.activeId, source);
      addTab(store, file, file.split('/').pop() ?? file);
    }
    return;
  }
  const label = remoteSourceLabel(normBase, rootIndex, normPath, file);
  const store = createRemoteStore(normBase, token, label, {
    rootIndex,
    ...(normPath !== '' ? { basePath: normPath } : {})
  });
  // SSE 接线与 connectServer 同款：autoRefresh 关闭时回调过滤（手动刷新 ↻ 不受影响）、
  // watch-error 置状态栏降级指示
  watchHealth.degraded = false;
  store.watch(
    (paths) => {
      if (!loadSettings().autoRefresh) return;
      tabStore.refreshPaths(store.id, paths);
    },
    () => {
      watchHealth.degraded = true;
      console.warn('[vviewer] 服务器变更推送不可用，自动刷新已停用');
    }
  );
  // 登记显式携带 rootIndex/basePath（sourceOf 派生不出多根字段——T3 指纹约束）；
  // 根 0 无 basePath 时省略两字段：与 connectServer 登记形状一致，快照迁移/恢复兼容
  const source: WorkspaceSource = {
    kind: 'remote',
    storeId: store.id,
    storeLabel: label,
    storeBase: normBase,
    ...(rootIndex !== 0 ? { rootIndex } : {}),
    ...(normPath !== '' ? { basePath: normPath } : {})
  };
  if (file === undefined) addDirStoreTab(store, source);
  else {
    workspaceStore.addSource(workspaceStore.activeId, source);
    addTab(store, file, file.split('/').pop() ?? file);
  }
}

/**
 * 远端来源显示名：单文件来源取文件名；目录来源取 basePath 尾段（根整体为源时
 * 取 host）。根 0 且无 basePath 必须与 connectServer 同 label（host）——storeId
 * hash 含 label，异 label 会为同一来源造出第二个 storeId（双 SSE 流/双树行）。
 */
function remoteSourceLabel(base: string, rootIndex: number, basePath: string, file?: string): string {
  if (file !== undefined) return file.split('/').pop() ?? file;
  const host = serverLabel(base);
  if (rootIndex === 0 && basePath === '') return host;
  const tail = basePath.split('/').pop() ?? basePath;
  return rootIndex === 0 ? `${host}/${tail}` : `${host} · 根${rootIndex}/${tail}`;
}

/**
 * restore 通道的目录 tab（passive）：目标组显式传参（配合恢复循环的逐组
 * setActive 归属）、不激活不切换；跨组去重命中（多 workspace 共享同一来源）
 * 只跳过——恢复期切换活动组会让后续 addTab 串组。来源登记与运行时通道同款
 * （addSource 组内去重，replaceAll 已登记的来源为 no-op）。
 */
export function addDirTabForRestore(wsId: string, store: TreeStore): void {
  if (tabStore.list.some((t) => t.source.path === '' && t.source.storeId === store.id)) return;
  workspaceStore.addSource(wsId, sourceOf(store));
  addTab(store, '', store.displayName());
}

/**
 * localfs 会话恢复（AppShell.restore 专用）：重授权成功经 addDirTabForRestore 建
 * 目录 tab 并返回 store 实例，供同源文件 tab 挂靠与来源-实例配对；权限被拒返回
 * null（调用方清除失效句柄，其余来源 tab 落占位）。wsId 为目标 workspace（恢复
 * 循环逐组调用）。非 restore 场景的目录打开走 openDirectoryViaPicker 等运行时通道。
 */
export async function tryRestoreDirectory(
  handle: FileSystemDirectoryHandle,
  wsId: string
): Promise<TreeStore | null> {
  if (!(await ensurePermission(handle))) return null;
  const store = createLocalFsStore(handle);
  addDirTabForRestore(wsId, store);
  return store;
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
