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
import { releaseStoreIfLast, storeRetained } from './storeRelease';
import { saveSearchEngine } from './searchEngineCache';
import {
  CLOSED_STACK_MAX,
  ClosedStack,
  reorderIds,
  regroupPinned,
  type ClosedTabEntry
} from './tabOrder';

export interface Tab {
  id: string;
  /** 所属工作区（workspaceStore.activeId 快照于入列时；作用域化 add/close/activate 的依据） */
  workspaceId: string;
  source: FileSource;
  scrollTop: number;
  active: boolean;
  /** 会话恢复的占位 tab：内容无法自动还原，需用户重新打开 */
  unrestorable?: boolean;
  /** F 项：浏览器式固定 tab（pinned 区靠左连续）；不参与 rev 刷新机制，随会话快照持久化 */
  pinned?: boolean;
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
    ...(t.overrideRenderer !== undefined ? { overrideRenderer: t.overrideRenderer } : {}),
    ...(t.pinned ? { pinned: true } : {})
  };
}

/**
 * 占位 storeId（`placeholder:<原 storeId>`）剥回原 id：撤销重建占位 tab 时不叠加前缀
 * （关闭的占位 tab 快照 storeId 已带 placeholder: 前缀，直接再包一层会得到双前缀 id）。
 */
function originStoreIdOf(snap: TabSnapshot): string {
  return snap.storeId.startsWith('placeholder:')
    ? snap.storeId.slice('placeholder:'.length)
    : snap.storeId;
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
    registryVersion.n++;
    void persist();
    // BUG-69：必须返回 $state 数组内元素（响应式代理）而非上面的裸对象 tab——
    // Svelte 5 $state 深代理的响应性按属性缓存（首读定值），add 内同步 persist 的
    // snapshot 首读之后，调用方对裸对象的属性写（AppShell.restore 透传
    // scrollTop/overrideRenderer、addPlaceholderTab 置 unrestorable、GlobalSearchPanel
    // 写 pendingLine）全部绕过 set trap 恒不生效（BUG-64 scrollTop 恢复恒 0 的真正根因）
    return this.list[this.list.length - 1]!;
  }

  close(id: string, opts: { undoable?: boolean } = {}): void {
    const i = this.list.findIndex((t) => t.id === id);
    if (i >= 0) {
      const closed = this.list[i]!;
      const wasActive = closed.active;
      // F 项撤销栈：所有用户关闭路径（单关/批量 closeOthers·closeRight/面板）统一入栈——
      // 元素为关闭瞬间的会话快照 + 所属 workspace + 存活实例捕获，reopenClosed 出栈重建；
      // 批量关闭经本方法的循环逐个入栈，与单关语义一致。
      // 系统替换动作豁免（fix round 1 Concern 1）：connectServer 同 base 重连的清扫
      // 非用户关闭——入栈会淹没容量 10 的栈，且撤销会复活用户未关的 tab 制造重复
      // （评审 fix round 1 Concern 1：系统替换动作豁免）
      if (opts.undoable !== false) {
        pushClosed({
          ...snapshot(closed),
          workspaceId: closed.workspaceId,
          // I-1：捕获非 worker 型存活实例——本方法稍后会把 storeId 从注册表摘除
          //（storeById 必 null），撤销重建靠此引用拿回内容；worker 型（实现 close）
          // 已被/将被 releaseStoreIfLast 终结，跳过，撤销走占位/重连路径
          ...(storeRetained(closed.source.store) ? { store: closed.source.store } : {})
        });
      }
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
        registryVersion.n++;
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

  // ---------- F 项：浏览器式 tab 动作（T1，全部组内作用域 + persist） ----------

  /** 组内 id 序 + pinned 集合（动作数学 reorderIds/regroupPinned 的输入形状）。 */
  private groupOrderOf(wsId: string): { ids: string[]; pinned: Set<string> } {
    const group = this.tabsOf(wsId);
    return {
      ids: group.map((t) => t.id),
      pinned: new Set(group.filter((t) => t.pinned).map((t) => t.id))
    };
  }

  /**
   * 组内 tabs 按 order 重排落 $state：组内槽位重写为 order 序，其余组的相对位不动。
   * 写入的是 tabsOf 取出的同一批 $state 代理（元素身份不变，写穿有效——BUG-69 惯例）。
   */
  private rewriteGroupOrder(wsId: string, order: string[]): void {
    const slotOf = new Map(order.map((id, i) => [id, i] as const));
    const group = this.tabsOf(wsId).sort((a, b) => slotOf.get(a.id)! - slotOf.get(b.id)!);
    let k = 0;
    for (let i = 0; i < this.list.length; i++) {
      if (this.list[i]!.workspaceId === wsId) this.list[i] = group[k++]!;
    }
  }

  /**
   * 批量关闭（F 项 closeOthers）：组内除自身与 pinned 外全关。
   * 复用单关 close() 循环——releaseStoreIfLast 与 pushClosed（每个被关 tab 逐个入
   * 撤销栈）语义与逐个关完全一致；激活落点在循环后显式对齐（级联激活的中间态不可靠）。
   */
  closeOthers(tabId: string): void {
    const anchor = this.list.find((t) => t.id === tabId);
    if (!anchor) return;
    const wsId = anchor.workspaceId;
    const before = this.tabsOf(wsId);
    const prevActive = before.find((t) => t.active);
    for (const v of before.filter((t) => t.id !== tabId && !t.pinned)) this.close(v.id);
    this.alignActivationAfterBatch(wsId, before, prevActive);
  }

  /** 批量关闭（F 项 closeRight）：组内该 tab 右侧的非 pinned 全关（pinned 豁免）。 */
  closeRight(tabId: string): void {
    const anchor = this.list.find((t) => t.id === tabId);
    if (!anchor) return;
    const wsId = anchor.workspaceId;
    const before = this.tabsOf(wsId);
    const prevActive = before.find((t) => t.active);
    const at = before.findIndex((t) => t.id === tabId);
    for (const v of before.slice(at + 1).filter((t) => !t.pinned)) this.close(v.id);
    this.alignActivationAfterBatch(wsId, before, prevActive);
  }

  /**
   * 批量关闭后的激活对齐：原活动 tab 已在批量中关闭时，激活其组内最近存活邻位
   * （按关闭前的组序先右后左，与单关 close() 的邻位语义一致）；原活动仍存活则不动。
   */
  private alignActivationAfterBatch(wsId: string, before: Tab[], prevActive: Tab | undefined): void {
    if (prevActive === undefined || this.list.some((t) => t.id === prevActive.id)) return;
    const survivors = new Set(this.tabsOf(wsId).map((t) => t.id));
    const ids = before.map((t) => t.id);
    const from = ids.indexOf(prevActive.id);
    let neighbor: string | null = null;
    for (let j = from + 1; j < ids.length; j++) {
      if (survivors.has(ids[j]!)) {
        neighbor = ids[j]!;
        break;
      }
    }
    if (neighbor === null) {
      for (let j = from - 1; j >= 0; j--) {
        if (survivors.has(ids[j]!)) {
          neighbor = ids[j]!;
          break;
        }
      }
    }
    if (neighbor !== null) this.activate(neighbor);
  }

  /** pin（F 项）：置位 + 组内重排——pinned 区靠左（区内相对序保持），新 tab 落 pinned 区尾。 */
  pin(tabId: string): void {
    const tab = this.list.find((t) => t.id === tabId);
    if (!tab || tab.pinned) return;
    tab.pinned = true;
    this.regroupAfterPinFlip(tab, true);
    void persist();
  }

  /** unpin（F 项）：去位 + 组内重排——落普通区首位（整个 pinned 区之后第一位）。 */
  unpin(tabId: string): void {
    const tab = this.list.find((t) => t.id === tabId);
    if (!tab || !tab.pinned) return;
    delete tab.pinned;
    this.regroupAfterPinFlip(tab, false);
    void persist();
  }

  /** 置位/去位后的组内重排（数学在 tabOrder.regroupPinned，此处落 $state）。 */
  private regroupAfterPinFlip(tab: Tab, nowPinned: boolean): void {
    const { ids, pinned } = this.groupOrderOf(tab.workspaceId);
    this.rewriteGroupOrder(tab.workspaceId, regroupPinned(ids, tab.id, nowPinned, pinned));
  }

  /**
   * 复制 tab（F 项）：同 source 新 tab 插入原 tab 右侧并激活（add 落组尾后 splice 回
   * 原位 +1）。unrestorable 占位的内容不可重建：返回 null 不动作。pinned/手选渲染方式
   * 随原 tab（原 tab pinned 而副本不 pinned 会把普通 tab 插进 pinned 区，破区不变式）；
   * 滚动位置不复制（新视图从头看）。
   */
  duplicate(tabId: string): Tab | null {
    const src = this.list.find((t) => t.id === tabId);
    if (!src || src.unrestorable) return null;
    // M-1 防御（fix round 1）：副本经 add 落「当前活动组」，原 tab 在非活动组时
    // 副本会错组（无法落原 tab 右侧）——拒绝不动作（调用方后续经切组重试）
    if (src.workspaceId !== workspaceStore.activeId) return null;
    const tab = this.add(src.source.store, src.source.path, src.source.name);
    if (src.pinned) tab.pinned = true;
    if (src.overrideRenderer !== undefined) tab.overrideRenderer = src.overrideRenderer;
    this.list.splice(this.list.indexOf(tab), 1);
    this.list.splice(this.list.indexOf(src) + 1, 0, tab);
    void persist(); // add 已按组尾序落盘；归位后再落一次保序
    return tab;
  }

  /**
   * 组内拖拽重排（F 项）：插入到 toId 之前/之后由 UI 传 before；跨 pinned 区边界拒绝
   * 返回 false——普通 tab 的插入点在 pinned 区内不受理（截断到 pinned 区尾之后的
   * 第一个普通位语义，即仅区尾边界受理），pinned tab 越区尾同理。数学见 tabOrder.reorderIds。
   */
  dragReorder(fromId: string, toId: string, before: boolean): boolean {
    const from = this.list.find((t) => t.id === fromId);
    if (!from) return false;
    const { ids, pinned } = this.groupOrderOf(from.workspaceId);
    const next = reorderIds(ids, fromId, toId, before, pinned);
    if (next === null) return false;
    this.rewriteGroupOrder(from.workspaceId, next);
    void persist();
    return true;
  }

  /**
   * 撤销关闭（F 项，撤销栈消费端）：出栈重建——目标 workspace 仍在 → 落回原组尾；
   * 已删除 → 当前活动组。store 实例优先复用（I-1）：注册表命中或撤销栈捕获的存活
   * 实例（close 摘注册表项后的「关唯一 tab → 撤销」高频路径靠后者拿回内容；worker
   * 型已被终结不在捕获之列）→ 不存活落占位（与 AppShell.restore 的 addPlaceholderTab
   * 同语义：read 即抛错 + unrestorable）。栈空返回 null。快照携带的 pinned 落回后
   * 归位 pinned 区尾（保区不变式）。
   */
  reopenClosed(): Tab | null {
    const snap = closedStack.pop();
    if (snap === null) return null;
    const targetWs = workspaceStore.list.some((w) => w.id === snap.workspaceId)
      ? snap.workspaceId
      : workspaceStore.activeId;
    workspaceStore.setActive(targetWs); // add 按 activeId 归组：先拨组再入列（落回原组尾）
    const originId = originStoreIdOf(snap);
    // I-1：注册表摘除后靠撤销栈捕获的存活实例拿回内容；捕获到占位实例（撤销的是
    // 占位 tab）不复用——占位须重经 addPlaceholder 置 unrestorable（直接复用会丢置位）
    const captured = snap.store?.id.startsWith('placeholder:') ? null : (snap.store ?? null);
    const alive = storeById(originId) ?? captured;
    if (alive !== null) {
      // 来源幂等补挂（removeSource 连带关闭 / 原组被删后落活动组等来源缺口场景）：
      // addSource 按 storeId 去重，已登记为 no-op。形状优先抄其他组同 storeId 的
      // 既有来源（M-3：多根 rootIndex/basePath 的 FNV 指纹不可反解，sourceOf 只能
      // 派生根 0 形态——快照 sources[] 是唯一可信出处）
      const known = workspaceStore.list
        .flatMap((w) => w.sources)
        .find((s) => s.storeId === originId);
      workspaceStore.addSource(targetWs, known ?? sourceOf(alive));
    }
    const tab = alive !== null ? this.add(alive, snap.path, snap.name) : this.addPlaceholder(snap);
    tab.scrollTop = snap.scrollTop;
    if (snap.overrideRenderer !== undefined) tab.overrideRenderer = snap.overrideRenderer;
    if (snap.pinned) {
      tab.pinned = true;
      this.regroupAfterPinFlip(tab, true); // 组尾落位会破 pinned 区不变式：归位区尾
    }
    void persist(); // add 的落盘是组尾/无回填态：此处统一再落最终形态
    return tab;
  }

  /**
   * 占位 tab（reopenClosed 专用，与 AppShell.restore 的 addPlaceholderTab 同语义）：
   * read 即抛错的占位 store——ViewerPane 以错误卡片提示"需重新打开"；文案按快照是否
   * 携带服务端 base 区分（SHELL-14 同款）。
   */
  private addPlaceholder(snap: TabSnapshot): Tab {
    const remote = snap.storeBase !== undefined;
    let host = snap.storeBase ?? '';
    if (remote) {
      try {
        host = new URL(snap.storeBase ?? '').host;
      } catch {
        // base 非法：显示名退回原串
      }
    }
    const message = remote
      ? `服务器 ${host} 的文件，重连后可恢复（会话不保留服务器文件内容）`
      : '会话中的本地文件需要重新打开（浏览器不保留文件内容）';
    const store: TreeStore = {
      id: `placeholder:${originStoreIdOf(snap)}`,
      displayName: () => snap.storeLabel,
      listChildren: async () => [],
      read: async () => {
        throw new Error(message);
      }
    };
    const tab = this.add(store, snap.path, snap.name);
    tab.unrestorable = true;
    return tab;
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
 * 撤销关闭栈（F 项 T1，模块级）：容量 CLOSED_STACK_MAX 的 LIFO，元素为关闭瞬间的
 * 会话快照 + 所属 workspace（tabOrder.ClosedStack 纯结构，tabActions.test.ts 直测）。
 * 所有 close 路径统一 pushClosed；reopenClosed 出栈消费。会话级内存态：不持久化
 * （重启后撤销历史清空）。
 */
const closedStack = new ClosedStack<ClosedTabEntry>(CLOSED_STACK_MAX);

/**
 * 活动 store 实例注册表：storeId → TreeStore（会话内尚有 tab 持有的实例）。
 * workspace.sources 只存 storeId/元数据（可持久化）；文件树/面板需要活实例时经
 * storeById 解析（AppShell.restore 也据它判断来源是否已重建）。
 * 刻意用普通 Map 而非 $state：避免 $state 深代理包裹 store 实例引入的代理身份
 * 问题（releaseStoreIfLast 等按对象身份比较）。响应式经 registryVersion 版本
 * 计数器承载——旧设计假设「list 变化是注册表变化的超集信号」在 restore 重连
 * （registerStore 注册时无任何 list 变化）与 close→recreate 窗口下不成立，
 * 读侧漏更新曾致恢复后左栏树恒空（CMP-04 实测）：读 registryVersion.n 建立
 * 依赖，注册表任何增删必然触发消费者重算。
 */
const activeStores = new Map<string, TreeStore>();

/** 注册表版本计数（随 activeStores 增删自增）：消费侧读它建立响应式依赖。 */
export const registryVersion = $state({ n: 0 });

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
 * 显式注册 store 实例（AppShell.restore 重连通道专用）：重连创建的 store 此前
 * 依赖「其 tab 的 addTab」间接入册——注册与 tab 重建分处两步，窗口内 sources
 * derived（storeById 门）看不到存活实例；source 快照只有目录 tab（恢复循环跳过
 * 目录 tab 不重建）时该窗口成为永久态。重连成功即入册，注册表恒指向存活实例。
 */
export function registerStore(store: TreeStore): void {
  activeStores.set(store.id, store);
  registryVersion.n++;
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

/**
 * 撤销关闭入栈（F 项）：快照级元素（TabSnapshot + workspaceId）。所有 close 路径
 * （单关/批量 closeOthers·closeRight/面板）统一经 TabCollection.close 调用本函数。
 */
export function pushClosed(entry: ClosedTabEntry): void {
  closedStack.push(entry);
}

/** 撤销关闭（F 项）：出栈重建——原组在落回原组尾，原组已删落当前活动组；栈空返回 null。 */
export function reopenClosed(): Tab | null {
  return tabStore.reopenClosed();
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

  // 存活实例复用（与 openRemoteSource 同一防线）：restore 重连通道重建的同源
  // store 实例仍在注册表存活时，重复连接直接复用之——不再走「关闭同 base 全部
  // tab → 重建」路径。该路径存在两重代价：①左栏树经 sources derived 的
  // 「源 × 注册表 × tab 持有」三条件在 close→addTab 窗口内瞬态为空（FileTree
  // 卸载重挂、树闪烁）；②restore 重连实例的 SSE 流未被关闭前，新实例构成双流
  // （openRemoteSource 的复用裁决即为此）。复用条件对齐 restore 重连的构造输入
  //（base + 会话 last-server 的 token——重连以它建 store），token 不一致（用户
  // 换令牌重连）回退既有关闭重建路径。connectServer 恒为根 0/整根形态。
  const last = loadLastServer();
  if (last !== null && last.baseUrl === base && (last.token ?? null) === tok) {
    for (const w of workspacesView.list) {
      const src = w.sources.find(
        (s) =>
          s.kind === 'remote' &&
          s.storeBase === base &&
          (s.rootIndex ?? 0) === 0 &&
          s.basePath === undefined
      );
      if (src === undefined) continue;
      const alive = storeById(src.storeId);
      if (alive === null) continue; // 实例不存活（tab 已全部关闭）：走关闭重建
      addDirStoreTab(alive);
      try {
        sessionStorage.setItem(
          LAST_SERVER_KEY,
          JSON.stringify({ baseUrl: base, token: tok } satisfies LastServer)
        );
      } catch {
        // 存储不可用：连接本身不受影响
      }
      return;
    }
  }

  // 同 base 重连：先关闭同 base 的旧 remote tab（目录 + 文件）。旧 store 无 tab
  // 持有后经引用计数接线 close()（停 SSE + 清资源表），避免新旧两条事件流并行。
  // undoable:false（fix round 1 Concern 1）：系统替换动作非用户关闭——入栈会淹没
  // 容量 10 的撤销栈，且撤销会复活用户未关的 tab 制造重复 tab
  for (const t of [...tabStore.list]) {
    if (getRemoteBase(t.source.storeId) === base) tabStore.close(t.id, { undoable: false });
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
