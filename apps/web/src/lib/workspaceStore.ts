/**
 * workspace 多根模型（workspace 计划 T3）：纯逻辑 + 轻量订阅，非 runes
 * （普通 .ts 无法用 $state；模式仿 stores/settings.ts 的回调集合发布订阅，
 * 根 vitest 无 svelte 插件，本模块可被直接单测）。
 *
 * 职责边界：工作区的增删改/来源去重/至少一个不变式/快照迁移在这里；
 * tab 与工作区的归属（Tab.workspaceId）与作用域化在 openFlow.svelte.ts 的
 * TabCollection——本模块不感知 tab 实例，快照里的 tabs 字段仅在持久化层
 * 存在（replaceAll 读入时丢弃，由活动 tab 集合重新组织）。
 */
import type { TabSnapshot } from './stores/session';

/** 工作区来源类别：由 storeId 前缀推导（sourceKindOf）。 */
export type WorkspaceSourceKind = 'localfs' | 'localfiles' | 'remote' | 'single' | 'url';

/**
 * 工作区内一个数据来源（目录/服务器根）。rootIndex/basePath 服务多根服务器
 * （server /api/tree|file 的 root 参数与根内子目录前缀）；storeId 与
 * RemoteStore 编码一致（remote:<hash>[:rN[:hash]]）。
 */
export interface WorkspaceSource {
  kind: WorkspaceSourceKind;
  storeId: string;
  storeLabel: string;
  /** remote 来源的服务端 base（scheme+host+port），重连恢复用。 */
  storeBase?: string;
  /** 服务器多根下的根索引（缺省 0 = 默认根）。 */
  rootIndex?: number;
  /** 根内子目录前缀：源内路径相对该前缀。 */
  basePath?: string;
}

/** 工作区：命名的来源分组。tab 的归属由 Tab.workspaceId 指向本 id。 */
export interface Workspace {
  id: string;
  name: string;
  sources: WorkspaceSource[];
  createdAt: number;
}

/** 持久化项：模型字段 + 该组 tab 快照与组内活动 tab（'workspaces' 键，快照 v2）。 */
export interface WorkspaceSnapshotItem extends Workspace {
  tabs: TabSnapshot[];
  /** 组内活动 tab id；空组为 null。 */
  activeTabId: string | null;
}

/** workspaces 快照（session.ts 的 kv 键 'workspaces'）。 */
export interface WorkspacesSnapshot {
  activeId: string;
  workspaces: WorkspaceSnapshotItem[];
}

/** 订阅回调：收到 list/activeId 的防御性副本（改动不回灌）。 */
export interface WorkspacesListener {
  (state: { list: ReadonlyArray<Workspace>; activeId: string }): void;
}

/** storeId 前缀 → 来源类别（未识别前缀按单文件处理）。 */
export function sourceKindOf(storeId: string): WorkspaceSourceKind {
  if (storeId.startsWith('localfs:')) return 'localfs';
  if (storeId.startsWith('localfiles:')) return 'localfiles';
  if (storeId.startsWith('remote:')) return 'remote';
  if (storeId.startsWith('url:')) return 'url';
  return 'single';
}

/** 工作区 id（`w<序号>`）→ 序号；不匹配形态为 0。 */
export function workspaceSeqOf(id: string): number {
  const m = /^w(\d+)$/.exec(id);
  return m ? Number(m[1]) : 0;
}

/**
 * 旧扁平 tabs 快照 → 单默认 workspace 的 v2 快照（一次性迁移纯函数）。
 * sources 派生规则：仅 path==='' 的目录 tab 派生来源（storeId/storeLabel/
 * storeBase，kind 由 storeId 前缀推导，按 storeId 去重）；文件 tab 不产生。
 */
export function migrateLegacyTabs(tabs: ReadonlyArray<TabSnapshot>): WorkspacesSnapshot {
  const sources: WorkspaceSource[] = [];
  for (const t of tabs) {
    if (t.path !== '') continue; // 目录来源才派生 source
    if (sources.some((s) => s.storeId === t.storeId)) continue;
    sources.push({
      kind: sourceKindOf(t.storeId),
      storeId: t.storeId,
      storeLabel: t.storeLabel,
      ...(t.storeBase !== undefined ? { storeBase: t.storeBase } : {})
    });
  }
  return {
    activeId: 'w1',
    workspaces: [
      {
        id: 'w1',
        name: '默认',
        sources,
        createdAt: Date.now(),
        tabs: tabs.map((t) => ({ ...t })),
        activeTabId: tabs.find((t) => t.active)?.id ?? null
      }
    ]
  };
}

/** 工作区状态工厂：闭包承载可变状态，getters 只读暴露。 */
export function createWorkspaceState(): {
  readonly list: ReadonlyArray<Workspace>;
  readonly activeId: string;
  add(name?: string, sources?: WorkspaceSource[]): Workspace;
  rename(id: string, name: string): void;
  remove(id: string): void;
  setActive(id: string): void;
  addSource(wsId: string, source: WorkspaceSource): WorkspaceSource;
  removeSource(wsId: string, storeId: string): void;
  /** 至少一个不变式：空态建默认工作区（幂等）。 */
  ensureNonEmpty(): void;
  /** 下一工作区 id：'w1' 起序，取既有最大序号+1（快照恢复的非连续 id 安全）。 */
  nextId(): string;
  /** 迁移/恢复入口：整体覆写为快照内容（tabs/activeTabId 字段丢弃，属活动 tab 层）。 */
  replaceAll(snapshot: WorkspacesSnapshot): void;
  onWorkspacesChanged(cb: WorkspacesListener): () => void;
} {
  let list: Workspace[] = [];
  let activeId = '';
  const listeners = new Set<WorkspacesListener>();

  function copyOf(w: Workspace): Workspace {
    return { ...w, sources: w.sources.map((s) => ({ ...s })) };
  }

  function notify(): void {
    const state = { list: list.map(copyOf), activeId };
    for (const cb of listeners) cb(state);
  }

  /** 内核：空则建默认（不通知）；replaceAll/单例初始化等组合操作复用。 */
  function ensureNonEmptyInternal(): boolean {
    if (list.length > 0) return false;
    const w: Workspace = { id: nextIdInternal(), name: '默认', sources: [], createdAt: Date.now() };
    list = [w];
    activeId = w.id;
    return true;
  }

  function nextIdInternal(): string {
    const max = list.reduce((m, w) => Math.max(m, workspaceSeqOf(w.id)), 0);
    return `w${max + 1}`;
  }

  return {
    get list(): ReadonlyArray<Workspace> {
      return list;
    },
    get activeId(): string {
      return activeId;
    },
    add(name = '默认', sources = []): Workspace {
      const w: Workspace = { id: nextIdInternal(), name, sources: sources.map((s) => ({ ...s })), createdAt: Date.now() };
      list = [...list, w];
      activeId = w.id; // 新建即激活（T4 工作区切换的预期行为）
      notify();
      return copyOf(w);
    },
    rename(id: string, name: string): void {
      const w = list.find((x) => x.id === id);
      if (!w || w.name === name) return;
      list = list.map((x) => (x.id === id ? { ...x, name } : x));
      notify();
    },
    remove(id: string): void {
      if (!list.some((x) => x.id === id)) return;
      if (list.length === 1) {
        // 删最后一个：先建默认再删，保持至少一个工作区
        const fresh: Workspace = { id: nextIdInternal(), name: '默认', sources: [], createdAt: Date.now() };
        list = [fresh];
        activeId = fresh.id;
      } else {
        list = list.filter((x) => x.id !== id);
        if (activeId === id) activeId = list[0]!.id;
      }
      notify();
    },
    setActive(id: string): void {
      if (!list.some((x) => x.id === id) || activeId === id) return;
      activeId = id;
      notify();
    },
    addSource(wsId: string, source: WorkspaceSource): WorkspaceSource {
      const w = list.find((x) => x.id === wsId);
      if (!w) throw new Error(`未知工作区: ${wsId}`);
      const existing = w.sources.find((s) => s.storeId === source.storeId);
      if (existing) return existing; // storeId 去重：重复入组返回既有
      const stored: WorkspaceSource = { ...source };
      w.sources.push(stored);
      notify();
      return stored;
    },
    removeSource(wsId: string, storeId: string): void {
      const w = list.find((x) => x.id === wsId);
      if (!w || !w.sources.some((s) => s.storeId === storeId)) return;
      w.sources = w.sources.filter((s) => s.storeId !== storeId);
      notify();
    },
    ensureNonEmpty(): void {
      if (ensureNonEmptyInternal()) notify();
    },
    nextId(): string {
      return nextIdInternal();
    },
    replaceAll(snapshot: WorkspacesSnapshot): void {
      // 显式字段拾取：快照附加字段（tabs/activeTabId）与未知字段不进内存模型
      list = snapshot.workspaces.map((item) => ({
        id: item.id,
        name: item.name,
        sources: item.sources.map((s) => ({ ...s })),
        createdAt: item.createdAt
      }));
      activeId = list.some((w) => w.id === snapshot.activeId) ? snapshot.activeId : (list[0]?.id ?? '');
      ensureNonEmptyInternal();
      if (!list.some((w) => w.id === activeId)) activeId = list[0]!.id;
      notify();
    },
    onWorkspacesChanged(cb: WorkspacesListener): () => void {
      listeners.add(cb);
      return () => listeners.delete(cb);
    }
  };
}

/**
 * 应用级单例：启动即保证至少一个默认工作区——T4 接管恢复前，openFlow 的
 * add/persist 已依赖非空（所有 tab 归入 w1）；迁移/恢复经 replaceAll 整体覆写。
 */
export const workspaceStore = createWorkspaceState();
workspaceStore.ensureNonEmpty();
