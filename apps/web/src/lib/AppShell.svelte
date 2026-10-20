<script lang="ts">
  import { onMount } from 'svelte';
  import TopBar from './TopBar.svelte';
  import TabBar from './TabBar.svelte';
  import ViewerPane from './ViewerPane.svelte';
  import FileTree from './FileTree.svelte';
  import Toc from './Toc.svelte';
  import MetaPanel from './MetaPanel.svelte';
  import GlobalSearchPanel from './GlobalSearchPanel.svelte';
  import QuickOpenPanel from './QuickOpenPanel.svelte';
  import WorkspaceTabsPanel from './WorkspaceTabsPanel.svelte';
  import SettingsCenter from './SettingsCenter.svelte';
  import type { TreeStore, TocEntry } from '@vviewer/core';
  import { createRemoteStore } from '@vviewer/core';
  import {
    tabStore,
    addTab,
    activateTab,
    closeTab,
    tryRestoreDirectory,
    bindArchiveOpenEvents,
    seedSeqFromSnapshots,
    addDirTabForRestore,
    createDirectMountStore,
    hasUserActivity,
    loadLastServer,
    registryVersion,
    registerStore,
    reopenClosed,
    showStatusNotice,
    storeById,
    storeRevisions,
    workspacesView,
    watchHealth
  } from './openFlow.svelte';
  import {
    loadDirHandle,
    loadWorkspaces,
    saveDirHandle,
    type TabSnapshot
  } from './stores/session';
  import { migrateLegacyTabs, workspaceStore, type WorkspaceSnapshotItem, type WorkspaceSource } from './workspaceStore';
  import { loadSettings, onSettingsChanged, saveSettings } from './stores/settings';
  import {
    chromeVisible,
    clampWidth,
    DEFAULT_LAYOUT,
    enterZen,
    exitZen,
    zenEscAction,
    zenPopAction,
    type LayoutSide,
    type LayoutSettings
  } from './layout';
  import { codeLineHeight } from './theme';
  import { loadEnabledFontFaces } from './stores/fontsStore';
  import { syncMountsOnConnect, listDirectMounts } from './mountsSync';

  /** 文件树/面板的来源条目：workspace.sources（模型）× storeById（活动实例）的合成。
   * rootIndex/basePath 随模型透传（GlobalSearchPanel → globalSearch 的远程命中
   * 跨根归属依据；FileTree/QuickOpenPanel 不消费、结构多余字段无感）。 */
  interface TreeSource {
    label: string;
    store: TreeStore;
    rootIndex?: number;
    basePath?: string;
  }

  // 响应式副本：onSettingsChanged 订阅刷新（BUG-05）。此前是非响应式快照，
  // 设置面板改排除规则后 FileTree 拿不到新值
  let settings = $state(loadSettings());
  let drawerOpen = $state(false);
  /** 右栏（MetaPanel/TOC）抽屉开关：仅 ≤600px 断点生效（见样式媒体查询） */
  let rightOpen = $state(false);
  /** 活动渲染实例的目录（ViewerPane ontoc 回调上行；markdown tab 有数据，其余为空） */
  let tocEntries = $state<TocEntry[]>([]);
  /** 全局搜索面板开关（M6 T4）：Ctrl+Shift+F 打开，Esc 面板内关闭 */
  let globalSearchOpen = $state(false);
  /** 快速打开面板开关（BUG-03）：Ctrl+P 切换，Esc 面板内关闭 */
  let quickOpenOpen = $state(false);
  /** tab 管理覆盖层面板开关（T6）：Alt+W / TabBar「管理」切换，Esc/外点面板内关闭 */
  let wsPanelOpen = $state(false);
  /** 统一设置中心开关（settings center spec §2）：TopBar ⚙（onsettings 回调）与
   * Ctrl+, 双入口切换，Esc 面板内关闭（SettingsPanel 弹层退役，挂点归 AppShell
   * ——与其余 overlay 面板同层，TopBar 隐藏态 Ctrl+, 可达不变式保持）。
   * settingsCenterEl 为组件实例引用：关闭统一走组件导出的 requestClose()——
   * 脏态由组件内弹确认裁决（spec §3），Ctrl+,/⚙ 关闭路径不直翻开关绕过确认。 */
  let settingsCenterOpen = $state(false);
  let settingsCenterEl: { requestClose(): void } | null = $state(null);

  function toggleSettingsCenter(): void {
    if (!settingsCenterOpen) {
      settingsCenterOpen = true;
      return;
    }
    settingsCenterEl?.requestClose();
  }

  // ---------- 布局自由化（spec 2026-10-19 §2）：折叠/调宽 ----------
  // settings.layout 是唯一事实源：折叠/宽度变更即时 saveSettings 落盘（既有链路
  // onSettingsChanged → settings 副本刷新），刷新/重启由 loadSettings 恢复。

  const layout = $derived(settings.layout);

  /** 局部合并写回 layout 节：读最新持久值只改目标字段（同 SettingsPanel.persist
   * 惯例——TopBar 等其他订阅方管理的字段不被本组件旧副本覆盖）。 */
  function updateLayout(patch: Partial<LayoutSettings>): void {
    const fresh = loadSettings();
    fresh.layout = { ...fresh.layout, ...patch };
    saveSettings(fresh);
  }

  /** 拖拽调宽会话（null = 未拖拽）：startX/startW 锚定增量数学，dragW 为实时
   * 预览宽（clamp 后）；松手才 updateLayout 落盘（拖拽途中学不写 localStorage）。 */
  let drag = $state<{ side: LayoutSide; startX: number; startW: number } | null>(null);
  let dragW = $state(0);

  /** 渲染宽 = 拖拽中的预览值，否则持久值（拖拽实时预览、松手落盘，spec §2）。 */
  const leftW = $derived(drag?.side === 'left' ? dragW : layout.leftWidth);
  const rightW = $derived(drag?.side === 'right' ? dragW : layout.rightWidth);

  function startDrag(side: LayoutSide, e: PointerEvent): void {
    // 抽屉断点（≤900px）不调宽：与 onTreeOpen 的 matchMedia 同引擎同条件
    if (window.matchMedia('(max-width: 900px)').matches) return;
    e.preventDefault(); // 防拖拽启动文本选择
    drag = { side, startX: e.clientX, startW: side === 'left' ? layout.leftWidth : layout.rightWidth };
    dragW = drag.startW;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function moveDrag(e: PointerEvent): void {
    if (drag === null) return;
    const dx = e.clientX - drag.startX;
    // 左栏向右拖增宽、右栏向左拖增宽（同一条增量数学取反）
    dragW = clampWidth(drag.side, drag.side === 'left' ? drag.startW + dx : drag.startW - dx);
  }

  function endDrag(): void {
    const d = drag;
    drag = null;
    if (d === null) return;
    updateLayout(d.side === 'left' ? { leftWidth: dragW } : { rightWidth: dragW });
  }

  // ---------- chrome 隐藏与 zen（spec 2026-10-19 §2/§3，Task 2） ----------

  /** chrome 有效可见性（chromeVisible 纯函数）：zen 全件覆盖，非 zen 按显式字段 */
  const vis = $derived(chromeVisible(settings.layout));

  /**
   * 顶栏/标签栏「临时条」态（spec §2 隐藏唤出 / §3 zen 退出条共用机制，取实现
   * 简者——临时条就是真实 TopBar/TabBar 本体的半透覆盖形态，不渲染第二份组件，
   * 避免双实例快捷键/状态漂移）：隐藏后对应边缘悬停唤出，移开 1.5s 再隐；zen 下
   * 顶栏临时条右键菜单即退出通道。定时器在退出 zen 与组件卸载时清理。
   */
  let topTemp = $state(false);
  let tabTemp = $state(false);
  let topTempTimer: ReturnType<typeof setTimeout> | null = null;
  let tabTempTimer: ReturnType<typeof setTimeout> | null = null;

  function summonTemp(bar: 'top' | 'tab'): void {
    if (bar === 'top') {
      if (topTempTimer !== null) clearTimeout(topTempTimer);
      topTempTimer = null;
      topTemp = true;
    } else {
      if (tabTempTimer !== null) clearTimeout(tabTempTimer);
      tabTempTimer = null;
      tabTemp = true;
    }
  }

  /** 立即收回临时态并清定时器（L1：右键置可见分支同步调用——条已常显，残留
   * temp 类会使半透/覆盖形态滞留，残留定时器会在常显条上误触发隐藏竞态）。 */
  function dismissTemp(bar: 'top' | 'tab'): void {
    if (bar === 'top') {
      if (topTempTimer !== null) clearTimeout(topTempTimer);
      topTempTimer = null;
      topTemp = false;
    } else {
      if (tabTempTimer !== null) clearTimeout(tabTempTimer);
      tabTempTimer = null;
      tabTemp = false;
    }
  }

  function scheduleHideTemp(bar: 'top' | 'tab'): void {
    if (bar === 'top') {
      if (topTempTimer !== null) clearTimeout(topTempTimer);
      topTempTimer = setTimeout(() => {
        topTemp = false;
        topTempTimer = null;
      }, 1500);
    } else {
      if (tabTempTimer !== null) clearTimeout(tabTempTimer);
      tabTempTimer = setTimeout(() => {
        tabTemp = false;
        tabTempTimer = null;
      }, 1500);
    }
  }

  function clearTempTimers(): void {
    dismissTemp('top');
    dismissTemp('tab');
  }

  /**
   * zen 进出（spec §3）：enterZen/exitZen 只翻 zen 字段（正交性——其余字段不被
   * 改写，退出即还原）；持久化复用 updateLayout。viaPopstate=退出由返回键 popstate
   * 触发——守卫历史项已被该次回退弹出，history 补偿跳过（updateZenHistory）。
   */
  function toggleZen(viaPopstate = false): void {
    const fresh = loadSettings();
    const zen = !fresh.layout.zen;
    fresh.layout = zen ? enterZen(fresh.layout) : exitZen(fresh.layout);
    saveSettings(fresh);
    if (!zen) clearTempTimers();
    updateZenHistory(zen, viaPopstate);
  }

  // ---------- zen 移动端（spec §3.1，Task 4）：返回键拦截 / 浮钮 / 抽屉入口 ----------

  /** 抽屉断点（≤900px，与既有抽屉/调宽判定同一条件同引擎）：移动端 zen 行为
   * （守卫压入）以此为门；浮钮/抽屉头部的视觉开关用同一断点的媒体查询（CSS，
   * 改断点两处同步）。桌面断点不压守卫——桌面无返回键语义，history 保持纯净。 */
  function isDrawerBreakpoint(): boolean {
    return window.matchMedia('(max-width: 900px)').matches;
  }

  /**
   * zen 守卫历史项（spec §3.1 返回键拦截）：移动端进 zen 时压入 {vvZen:1}，Android
   * 返回键触发 popstate 时按 zenPopAction 分派（与桌面 Esc 同一状态机的第二触发源
   * ——面板开先关面板、无面板退 zen）。不变式：移动断点下 zen 在场即守卫在当前
   * 历史项——closeOverlay 消费守卫后重新压入（onPopstate）；非 popstate 通道退出
   * （浮钮/菜单/Esc/快捷键）时 history.back() 消费之，返回键语义回归原生（不劫持
   * 正常导航）。守卫项跨 reload 存活（history.state 持久），reload 落 zen 时由
   * onMount 认领或补压（浮钮即在场 + 返回键仍可退出，无困死路径）。
   */
  let zenGuardArmed = false;

  function armZenGuard(): void {
    history.pushState({ vvZen: 1 }, '');
    zenGuardArmed = true;
  }

  function updateZenHistory(zen: boolean, viaPopstate: boolean): void {
    if (zen) {
      if (isDrawerBreakpoint()) armZenGuard();
      return;
    }
    if (!zenGuardArmed) return;
    zenGuardArmed = false;
    if (!viaPopstate) history.back(); // 守卫项仍在栈顶：回退消费（popstate 分支已弹过）
  }

  /**
   * 关闭最上层 overlay（返回键承接桌面「Esc 先关面板」优先级，一次一个）：chrome
   * 菜单 > AppShell 自有面板（状态直关）> 外组件面板（设置/文件内搜索/远端源等）
   * ——后者对检测到的面板根派发合成 Esc，由各面板自带关闭处理器动作（仓库统一
   * dialog 容器 keydown 模式；window 兜底监听经 bubbles 到达），与桌面同一关闭
   * 通道。Svelte DOM 刷新在微任务批量落地，同步冒泡到 window 的 AppShell Esc
   * 分支仍见面板在 DOM（zenEscAction → closeOverlay 不叠加），不会级联退 zen
   * （桌面物理 Esc 同机制）。
   */
  function closeTopOverlayForZen(): void {
    if (chromeMenu !== null) {
      chromeMenu = null;
      return;
    }
    if (globalSearchOpen) {
      globalSearchOpen = false;
      return;
    }
    if (quickOpenOpen) {
      quickOpenOpen = false;
      return;
    }
    if (wsPanelOpen) {
      wsPanelOpen = false;
      return;
    }
    document.querySelector(OVERLAY_SELECTOR)?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
    );
  }

  function onPopstate(): void {
    // chromeMenu 不在 OVERLAY_SELECTOR（AppShell Esc 分支同序：菜单 > overlay > zen）
    const action = zenPopAction({
      guardArmed: zenGuardArmed,
      overlaysOpen: anyOverlayOpen() || chromeMenu !== null,
      zen: layout.zen
    });
    if (action === 'ignore') return; // 守卫不在场：正常导航，放行
    if (action === 'exitZen') {
      zenGuardArmed = false; // 本次回退已弹出守卫项，toggleZen 不再 history.back
      toggleZen(true);
      return;
    }
    // closeOverlay：返回键先关面板、zen 保持；守卫项已被本次回退消费，关面板后
    // 重新压入——维持「zen 在场即守卫在顶」不变式，下次返回继续承接
    closeTopOverlayForZen();
    armZenGuard();
  }

  /** chrome 右键菜单（spec §2 隐藏入口 / §3 TopBar 布局菜单项）：bar 标识菜单
   * 归属（顶栏/标签栏），条目按当前 layout 状态计算显示/隐藏与 zen 标签。 */
  let chromeMenu = $state<{ x: number; y: number; bar: 'top' | 'tab' } | null>(null);
  let chromeMenuEl = $state<HTMLElement | null>(null);

  function onShellContextMenu(e: MouseEvent): void {
    const t = e.target as HTMLElement;
    // 输入元素保留原生菜单（粘贴/拼写检查）；tab 行放行给 TabBar 自有右键菜单
    if (t.closest('input, textarea, select') !== null) return;
    const top = t.closest('.vv-topbar');
    const tabbar = t.closest('.vv-tabbar');
    if (top === null && tabbar === null) return;
    if (tabbar !== null && t.closest('.vv-tab') !== null) return;
    e.preventDefault();
    // 视口收敛（菜单 min-width 10em / 两项 ~80px 高）
    chromeMenu = {
      x: Math.min(e.clientX, window.innerWidth - 170),
      y: Math.min(e.clientY, window.innerHeight - 110),
      bar: top !== null ? 'top' : 'tab'
    };
  }

  function menuToggleVisible(bar: 'top' | 'tab'): void {
    if (bar === 'top') {
      const show = !layout.topBarVisible;
      updateLayout({ topBarVisible: show });
      if (show) dismissTemp('top'); // L1：从临时条右键重显，temp 态与定时器同步清
    } else {
      const show = !layout.tabBarVisible;
      updateLayout({ tabBarVisible: show });
      if (show) dismissTemp('tab');
    }
  }

  $effect(() => {
    // 菜单外点关闭（TopBar ws 菜单同模式：pointerdown 命中菜单内不关，避免
    // pointerdown 先关导致条目 click 丢失）
    if (chromeMenu === null) return;
    const onDown = (e: PointerEvent): void => {
      const t = e.target as Node | null;
      if (t !== null && chromeMenuEl?.contains(t) === true) return;
      chromeMenu = null;
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  });

  /**
   * overlay 开合判定的最准信号（台账裁决点）：各覆盖层面板均为 {#if} 条件挂载，
   * 在 DOM 即开——实时查询比在多处镜像 $state 布尔更准（设置中心 settingsCenterOpen
   * 虽为 AppShell 自有状态、文件内搜索存 ViewerPane，判定统一走 DOM 实读更不易漂移；
   * 类名清单 = 各面板根类，新面板接入时在此追加）。
   * 消费方：移动端 popstate（onPopstate，面板不被该事件关闭、实时读安全）与
   * 桌面 Esc 的 capture 相快照（snapOverlay——keydown 冒泡相面板已被其自带
   * handler 同步移除，实时读不可用，见 snapOverlay 注释）。
   */
  const OVERLAY_SELECTOR = [
    '.vv-settings-center',
    '.vv-gsearch',
    '.vv-quickopen',
    '.vv-wspanel',
    '.vv-search-panel',
    '.vv-wscreate',
    '.vv-remotesrc',
    '.vv-tabctx',
    '.vv-ws-pop',
    '.vv-status-picker'
  ].join(', ');

  function anyOverlayOpen(): boolean {
    return document.querySelector(OVERLAY_SELECTOR) !== null;
  }

  /** 当前 workspace（workspacesView 为 openFlow 维护的 workspaceStore runes 镜像）。 */
  const activeWorkspace = $derived(
    workspacesView.list.find((w) => w.id === workspacesView.activeId) ?? null
  );

  /**
   * 当前 workspace 的组内 tabs（T6）：TabBar 与 ViewerPane 的取数源——
   * 派生内读 tabStore.list（$state）+ workspacesView.activeId（runes 镜像），
   * 关 tab / 切组即时反映。活动 tab 查找随之收窄到组内（激活是组内作用域，
   * 全量 find(t.active) 会命中他组的活动 tab——跨组激活后面板/标签栏/查看区
   * 必须一致指向当前组）。单 workspace 时与全量过滤等价（组即全集）。
   */
  const activeTabs = $derived(tabStore.tabsOf(workspacesView.activeId));

  /**
   * 左栏文件树的来源列表（多根 T4）：当前 workspace 的每个来源解析出活动 store
   * 实例；无实例（localfiles 恢复不可达 / remote 重连失败 / 已被移除）的来源不渲染。
   * activeStores 注册表是普通 Map 不可追踪，实例增删的响应式依赖经读
   * registryVersion.n 建立（openFlow doc——「list 变化是注册表变化的超集信号」的
   * 旧假设在 restore 重连下不成立）；读 tabStore.list 只服务于「来源是否有 tab」
   * 过滤本身，不是注册表变化的信号。
   */
  const sources = $derived.by(() => {
    const ws = activeWorkspace;
    if (ws === null) return [] as TreeSource[];
    const tabs = tabStore.list;
    registryVersion.n; // 注册表版本依赖：activeStores 为普通 Map 不可追踪（openFlow doc）
    const out: TreeSource[] = [];
    for (const s of ws.sources) {
      const store = storeById(s.storeId);
      if (store !== null && tabs.some((t) => t.source.storeId === s.storeId)) {
        out.push({
          label: s.storeLabel,
          store,
          ...(s.rootIndex !== undefined ? { rootIndex: s.rootIndex } : {}),
          ...(s.basePath !== undefined ? { basePath: s.basePath } : {})
        });
      }
    }
    return out;
  });

  /**
   * 整树重建 key（BUG-05 通道，T4 多源化；M-2 修正；T7 分桶化）：源数量 +
   * 各源数据版本（openFlow.storeRevisions 按 storeId 分桶——仅当前 workspace
   * 所涉源的 SSE changed/手动刷新才重建，无关 workspace 的帧不再丢 TreeNodeRow
   * 展开态）+ 排除规则。旧逐源目录 tab rev 聚合：恢复的 remote 源只有文件
   * tab（重连不自动弹树，T4 裁决）时恒 'x' 占位不重建；分桶 token 天然覆盖
   * 无目录 tab 的源。
   */
  const treeKey = $derived(
    `${sources.length}|${sources.map((s) => storeRevisions[s.store.id] ?? 0).join(',')}|${JSON.stringify(settings.excludedPatterns)}`
  );

  onMount(() => {
    document.documentElement.dataset.themeMode = settings.themeMode;
    // 设置变更（TopBar/设置中心经 saveSettings 写入）→ 刷新响应式副本 + html 打标：
    // 排除规则变化经下方 {#key} 重建 FileTree（BUG-05）；themeMode 变化经设置中心
    // 「亮暗模式」控件应用时，data-theme-mode 也须同步（此前唯一运行时写入点在
    // TopBar cycleTheme——设置中心路径漏打标，壳层配色不切换，Task 5 e2e SC-03 补出）
    const offSettings = onSettingsChanged((s) => {
      settings = s;
      document.documentElement.dataset.themeMode = s.themeMode;
    });
    // render-archive 包内树点击 → addTab（递归预览通道）
    const unbindArchive = bindArchiveOpenEvents();
    // 网络字体启动恢复（字体系统 spec §5.2，Task 5）：enabled 项从 IndexedDB 重建
    // FontFace 并注册 document.fonts——与 dirHandle 会话恢复同层（onMount 启动期、
    // 不阻断启动）；单项失败已在 store 内 warn 不阻断，整体失败（库不可用）仅告警
    void loadEnabledFontFaces().catch((err: unknown) => console.warn('[fonts] 启动字体恢复失败', err));
    // zen 返回键拦截（spec §3.1）：reload 落 zen 时守卫项跨 reload 存活在当前历史项
    // （history.state 持久）——认领之；当前项无守卫（上个会话经浮钮退出后 reload 等）
    // 且在移动断点则补压——reload 后浮钮即在场 + 返回键仍先于离页退出 zen（无困死路径）
    if (layout.zen) {
      if ((history.state as { vvZen?: unknown } | null)?.vvZen === 1) zenGuardArmed = true;
      else if (isDrawerBreakpoint()) armZenGuard();
    }
    window.addEventListener('popstate', onPopstate);
    void restore();
    return () => {
      offSettings();
      unbindArchive();
      window.removeEventListener('popstate', onPopstate);
      clearTempTimers(); // 临时条 1.5s 定时器不跨卸载存活（spec §2 定时器清理）
    };
  });

  /**
   * 会话恢复 v2（workspace 多根 T4）：loadWorkspaces 读 'workspaces' 快照（缺失则
   * migrateLegacyTabs 一次性迁移旧 'tabs' 键），组/来源结构入模型后逐 workspace
   * 重建——先按来源类别重建 store（localfs 重授权 / remote 重连 / 其余类别无会话
   * 句柄不重建），再逐 tab 恢复（归属由恢复循环的逐组 setActive 锚定）+ 组内对齐
   * 活动 tab；最后回设活动组。恢复失败（IndexedDB 异常、快照损坏等）不得阻断
   * 应用启动：降级为空会话。
   *
   * 快点击竞态（T7 52+ e2e 失败根因）：__vvOpenDirImpl 注入钩子与用户操作可先于
   * 本函数的 IndexedDB 读取完成——此前无条件 replaceAll 会用快照（测试环境为空
   * 默认，生产为上次会话）整体覆盖已入模型的用户态：source 被抹掉而 tab 留存
   * （TabBar 按 workspaceId 过滤仍显示）→ 左栏树消失。故在 await 之后按
   * hasUserActivity() 分流：无活动照旧整体恢复；有活动改 mergeSnapshot 合并
   * （缺失组/来源并入，用户已建数据为先），且活动组保持用户当前所在——快照的
   * activeId 属上个会话，不得把刚操作完的用户拽走。
   */
  async function restore(): Promise<void> {
    try {
      // 直连挂载记录（目录挂载 spec §4）：快照 direct 来源按 storeId（= 记录 id）
      // 查此表重建；库不可用回落空表（全部 direct 来源落占位，不阻断启动）
      const [{ snapshot, legacyTabs }, dirHandle, directRecords] = await Promise.all([
        loadWorkspaces(),
        loadDirHandle(),
        listDirectMounts().catch(() => [])
      ]);
      const directById = new Map(directRecords.map((r) => [r.id, r]));
      // 旧会话（无 'workspaces' 键）：迁移成单默认 workspace 的 v2 形状走同一恢复路径
      const snap = snapshot ?? migrateLegacyTabs(legacyTabs);
      // 决策点在 await 之后：等待期间到达的注入/用户操作同样被识别（决策到落模型
      // 之间为同步代码，无新的竞态窗口）
      const merging = hasUserActivity();
      const userActiveId = workspaceStore.activeId;
      // 新 tab id 以快照最大序号为基：占位 tab 保留快照旧 id，seq 从 0 重计数会撞车
      //（seq 为 max 语义，合并路径已有用户 tab 的序号在 add 时已推进，天然覆盖）
      seedSeqFromSnapshots(snap);
      // 组/来源结构入 workspace 模型；快照 tabs 字段被丢弃，由下方逐组重建
      if (merging) workspaceStore.mergeSnapshot(snap);
      else workspaceStore.replaceAll(snap);
      // BUG-08（方案 A）：remote 来源且与会话内上次成功连接（loadLastServer，
      // sessionStorage 跨 F5 存活）base 一致时，restore 期自动重建 RemoteStore。
      // 同 base+root+basePath 只探测一次（多 workspace 共享同一来源时复用实例，
      // 避免同 id 双 SSE 流）；health 探测 3s 超时，失败不重试、不阻塞启动
      const last = loadLastServer();
      const reconnected = new Map<string, Promise<TreeStore | null>>();
      const reconnectOf = (src: WorkspaceSource): Promise<TreeStore | null> => {
        const key = `${src.storeBase}|${src.rootIndex ?? 0}|${src.basePath ?? ''}`;
        let p = reconnected.get(key);
        if (p === undefined) {
          // storeLabel 原值回环（I-1）：label 参与 storeId hash，快照 sources[].storeLabel
          // 必须原样传入，重算 host 会使多根/basePath 来源的重建 storeId ≠ 快照 storeId
          p = reconnectRemoteStore(
            src.storeBase ?? '',
            last?.token ?? null,
            src.storeLabel,
            { rootIndex: src.rootIndex, basePath: src.basePath }
          );
          reconnected.set(key, p);
        }
        return p;
      };
      for (const wsItem of snap.workspaces) {
        // 组归属锚定：addTab 按 workspaceStore.activeId 归组，逐组 setActive 后组内
        // addTab 全部归属本组。恢复通道的目录 tab（addDirTabForRestore）无激活/切换
        // 语义，不会在循环中途改写 activeId 造成串组
        workspaceStore.setActive(wsItem.id);
        // —— 先重建各来源的 store ——
        const rebuilt = new Map<string, TreeStore>();
        for (const src of wsItem.sources) {
          if (src.kind === 'localfs') {
            // dirHandle 为全局单槽：仅当句柄目录名与来源 storeId（localfs:<目录名>）
            // 一致才可重建；同名多 workspace 共享同一来源，addDirTabForRestore 去重
            if (dirHandle !== null && `localfs:${dirHandle.name}` === src.storeId) {
              // M-5：pinned 目录 tab 读回——目录条目不进文件 tab 循环，pinned 须
              // 在来源重建时经 addDirTabForRestore 一并传入
              const dirSnap = wsItem.tabs.find((t) => t.path === '' && t.storeId === src.storeId);
              const store = await tryRestoreDirectory(dirHandle, wsItem.id, {
                pinned: dirSnap?.pinned === true
              });
              if (store !== null) {
                rebuilt.set(src.storeId, store);
              } else {
                // 权限被拒：清除失效句柄，避免下次启动反复弹权限
                await saveDirHandle(null);
              }
            }
          } else if (src.kind === 'remote' && src.storeBase !== undefined && last !== null && last.baseUrl === src.storeBase) {
            // basePath 指纹约束（T3 评审遗留）：storeId 中 basePath 段是 32 位 FNV
            // 指纹不可反解——重建必须以快照 sources[].rootIndex/basePath 传入，
            // 绝不从 storeId 反解（parseRemoteStoreId 只能给出指纹，给不出原路径）
            let store: TreeStore | null = null;
            try {
              store = await reconnectOf(src);
            } catch (err) {
              // 重连通道意外抛错：与不可达同待遇——落占位，绝不让单来源拖垮整个恢复
              console.error(`恢复服务器 ${src.storeBase} 的来源失败`, err);
            }
            if (store !== null) {
              rebuilt.set(src.storeId, store);
              // M-5：快照有该来源的目录条目（path===''）则按快照忠实恢复目录 tab
              //（含 pinned 读回）——远端重连默认不弹树（BUG-08）不变，用户刷新前
              // 开着目录 tab 才重建
              const dirSnap = wsItem.tabs.find((t) => t.path === '' && t.storeId === src.storeId);
              if (dirSnap !== undefined) {
                addDirTabForRestore(wsItem.id, store, { pinned: dirSnap.pinned === true });
              }
            }
          } else if (src.kind === 'direct') {
            // 直连挂载恢复（目录挂载 spec §4 阶段三，评审带入①恢复链路同点）：
            // storeId 即 mounts store 记录 id（凭据引用）——按 id 查记录经
            // createDirectMountStore 重建（watch 不可用降级接线在工厂内）。记录已
            // 删除（用户删了挂载）→ 不重建，tab 落占位（既有降级链，plan 裁决预留）。
            // 快照有目录条目则一并恢复目录 tab（remote 侧同款 M-5 语义）。
            const rec = directById.get(src.storeId);
            if (rec !== undefined) {
              let store: TreeStore | null = null;
              try {
                store = createDirectMountStore(rec);
              } catch (err) {
                // 记录损坏（backend 不识别等）：落占位，不让单来源拖垮恢复
                console.warn(`恢复直连挂载 ${src.storeId} 失败`, err);
              }
              if (store !== null) {
                registerStore(store); // 恢复链入册：不依赖目录 tab 的 addTab 时序（registerStore doc）
                rebuilt.set(src.storeId, store);
                const dirSnap = wsItem.tabs.find((t) => t.path === '' && t.storeId === src.storeId);
                if (dirSnap !== undefined) {
                  addDirTabForRestore(wsItem.id, store, { pinned: dirSnap.pinned === true });
                }
              }
            }
          }
        }
        // —— 再逐 tab 恢复；目录条目（path===''）已由来源重建（M-5：remote 侧
        // 快照有目录条目才重建），跳过防每次启动累积一个（与旧 restore 同款）。
        // 来源未重建成功的 tab 落占位 ——
        for (const t of wsItem.tabs) {
          if (t.path === '') continue;
          // merge 路径快点击窗口查重：merging 判定到本循环之间有权限弹窗/重连
          // 探测两处 await，窗口内用户/注入钩子可能已打开同一文件（目录 tab 有
          // addDirTabForRestore 去重防线，文件 tab 此前没有）——按 storeId+path
          // 跳过，快照条目让位于用户已开 tab（merge 契约：用户已建数据为先）
          const exists = tabStore
            .tabsOf(wsItem.id)
            .some((t2) => t2.source.path === t.path && t2.source.storeId === t.storeId);
          if (exists) continue;
          const store = rebuilt.get(t.storeId);
          if (store !== undefined) {
            // 项 3：size 读回（与运行期 addTab 同参位）——恢复的远端文件 tab 免 head
            // 探测 + size 未知路径；旧快照无该字段 → undefined → null（既有探测路径）
            const tab = addTab(store, t.path, t.name, t.size ?? null);
            tab.scrollTop = t.scrollTop;
            if (t.overrideRenderer !== undefined) tab.overrideRenderer = t.overrideRenderer; // C 项读回
            if (t.pinned) tab.pinned = true; // F 项读回：快照序 pinned 靠左，add 顺序保持区不变式
            continue;
          }
          addPlaceholderTab(t);
        }
        alignActiveOfGroup(wsItem);
      }
      // 恢复循环逐组 setActive，最后回设活动组：整体恢复路径用快照记录的活动组；
      // 合并路径保持用户当前所在（恢复循环的逐组锚定会把活动组拨到快照末组，需拨回）
      workspaceStore.setActive(merging ? userActiveId : snap.activeId);
    } catch (err) {
      console.error('会话恢复失败，已降级为空会话', err);
    }
  }

  /**
   * BUG-08：restore 期自动重连（connectServer 的精简恢复路径）——health 探测
   * 3s 超时判可达，可达即 createRemoteStore + SSE watch 订阅接线（与 connectServer
   * 同模式：autoRefresh 关闭时回调过滤、watch-error 置降级指示）；不可达返回 null
   * 交由调用方落占位。不发目录 tab（不自动弹树），只服务快照 tab 的内容恢复。
   * 多根（T4）：rootIndex/basePath 由调用方从快照 sources[] 显式传入——storeId 的
   * basePath 段是 32 位 FNV 指纹不可反解（T3 评审约束），恢复链路绝不从 storeId 反解。
   * label 回环（T5 评审 I-1）：label 参与 storeId hash（hash8(`${base}:${label}`)），
   * 必须用快照 sources[].storeLabel 原值重建——与运行期 createRemoteStore 用同一
   * 字符串才能精确复现快照 storeId；重算 host 会使多根/basePath 来源（label 为
   * 尾段/文件名/「host · 根N/x」形态）得到不同 storeId，恢复链 storeId 回环断裂
   * （树行消失/tab 分叉/二次重启落占位/来源复用防线失效）。
   */
  async function reconnectRemoteStore(
    base: string,
    token: string | null,
    storeLabel: string,
    opts?: { rootIndex?: number; basePath?: string }
  ): Promise<TreeStore | null> {
    const headers: Record<string, string> = {};
    if (token) headers.authorization = `Bearer ${token}`;
    try {
      const res = await fetch(`${base}/api/health`, {
        headers,
        signal: typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(3000) : undefined
      });
      if (!res.ok) return null;
    } catch {
      return null; // 网络不可达/超时：恢复降级为占位，不阻塞启动
    }
    // 不重算 host：label 用快照原值（见函数 doc——label 参与 storeId hash）
    const store = createRemoteStore(base, token, storeLabel, opts);
    registerStore(store); // 重连即入册：不依赖其 tab 的 addTab 时序（registerStore doc）
    watchHealth.degraded = false;
    store.watch(
      (paths) => {
        if (!loadSettings().autoRefresh) return; // 与 connectServer 的 SSE 回调同口径
        tabStore.refreshPaths(store.id, paths);
      },
      () => {
        watchHealth.degraded = true;
        console.warn('[vviewer] 服务器变更推送不可用，自动刷新已停用');
      }
    );
    // 代理挂载对账（目录挂载 spec §3）：restore 重连成功同样触发幂等重注册——
    // connectServer 已覆盖新鲜连接面，这里补「刷新恢复」面（服务端重启后前端
    // 存档的代理挂载在重连时自动回填）。fire-and-forget 不阻塞恢复主链；内部
    // 全量吞错（失败静默标记待重试）。同 base 多来源（多根快照）会重复触发，
    // 对账幂等（同指纹命中即登记、服务端不重复分配）无副作用。
    void syncMountsOnConnect(base, token).catch(() => {});
    return store;
  }

  /** 组内活动 tab 对齐：addTab 总是激活新 tab，恢复完一组后按快照 activeTabId 对齐。
   * 恢复的 tab 不保留快照 id（新 id 顺延），按 path+storeId 匹配；占位来源的
   * storeId 为 placeholder:${快照 storeId}，需一并匹配（沿袭旧 alignActive）。 */
  function alignActiveOfGroup(wsItem: WorkspaceSnapshotItem): void {
    const want = wsItem.tabs.find((t) => t.id === wsItem.activeTabId);
    if (!want) return;
    const match = tabStore.tabsOf(wsItem.id).find(
      (t) => t.source.path === want.path
        && (t.source.storeId === want.storeId || t.source.storeId === `placeholder:${want.storeId}`)
    );
    if (match) activateTab(match.id);
  }

  function addPlaceholderTab(t: TabSnapshot): void {
    // 占位 store：read 即抛错，ViewerPane 以错误卡片提示"需重新打开"。
    // BUG-08：服务器来源（快照带 storeBase）的占位文案指向服务器——
    // 不得再出现「本地文件」字样误导（SHELL-14 验收）
    const remote = t.storeBase !== undefined;
    let host = t.storeBase ?? '';
    if (remote) {
      try {
        host = new URL(t.storeBase ?? '').host;
      } catch {
        // base 非法：显示名退回原串
      }
    }
    const message = remote
      ? `服务器 ${host} 的文件，重连后可恢复（会话不保留服务器文件内容）`
      : '会话中的本地文件需要重新打开（浏览器不保留文件内容）';
    const store: TreeStore = {
      id: `placeholder:${t.storeId}`,
      displayName: () => t.storeLabel,
      listChildren: async () => [],
      read: async () => {
        throw new Error(message);
      }
    };
    const tab = addTab(store, t.path, t.name);
    tab.unrestorable = true;
    if (t.pinned) tab.pinned = true; // F 项读回：占位 tab 的 pinned 态一并恢复（保快照序区不变式）
  }

  /**
   * 源级移除（FileTree 源行按钮，confirm 在组件内）：关闭当前 workspace 内该来源
   * 的全部 tab，并把来源从当前 workspace 移除。移除是组内操作——其他 workspace
   * 若共享同一 storeId，其来源与 tab 不受影响（store 实例仍被其 tab 持有）。
   */
  function removeSource(store: TreeStore): void {
    const ws = activeWorkspace;
    if (ws === null) return;
    for (const t of [...tabStore.tabsOf(ws.id)]) {
      if (t.source.storeId === store.id) closeTab(t.id);
    }
    workspaceStore.removeSource(ws.id, store.id);
  }

  function onTreeOpen(e: { path: string; name: string; size?: number; store: TreeStore }): void {
    addTab(e.store, e.path, e.name, e.size ?? null);
    // BUG-61：≤900px 抽屉断点下点树文件后自动收起抽屉——固定定位的 300px 抽屉
    // 会继续遮挡主阅读区，此前唯一收起途径是再点 ☰。断点经 matchMedia 求值，
    // 与下方 @media (max-width: 900px) 同引擎同一条件（e2e/drawer.ts 同款约定，
    // 改断点两处同步）。
    if (drawerOpen && window.matchMedia('(max-width: 900px)').matches) drawerOpen = false;
  }

  // 全局键位（BUG-03，场景 SHELL-11）：Ctrl+Shift+F 全局搜索（既有）、Ctrl+P
  // 快速打开、Alt+W tab 管理面板（T6）、Alt+Shift+T 撤销关闭 tab（F 项 T3）、
  // j/k 逐行滚、gg 顶、G 底。统一走 inField
  // 判定（非输入焦点才接管——与 M3 '/' 的惯例同源），组合键均 preventDefault。
  // j/k 步长=代码行高：按现 settings 即时计算（codeLineHeight 纯函数与 theme.ts
  // --vv-code-line-height 注入、render-text opts.lineMetrics 同一公式），字号设置
  // 变更后无需重启即随动（台账 M2：原先 20px 固定常量不随字号联动）。
  /** gg 序列：上一次 g 的按下时刻（500ms 内两击判顶跳，防单 g 误触） */
  let lastGAt = 0;

  /**
   * 滚动目标（计划 §1.4 裁决 1）：code 渲染器内部滚动容器 .vv-code-pre 优先，
   * 其余渲染器回落外层 .vv-viewer-scroll——与 spec「活动实例 getScrollHost()
   * 否则外层容器」语义等价的 DOM 查询实现（不改包 2 独占的 ViewerPane）。
   */
  function scrollTarget(): HTMLElement | null {
    return (
      document.querySelector<HTMLElement>('.vv-viewer-host .vv-code-pre') ??
      document.querySelector<HTMLElement>('.vv-viewer-scroll')
    );
  }

  $effect(() => {
    // Escape 优先级快照（spec §3，Svelte 5 同步 flush 修正，Task 5 e2e 发现）：
    // 面板容器的 Esc handler 关面板时 Svelte 5 把 DOM 更新同步落地（事件驱动的
    // 更新不批量到微任务——实测面板在同一 keydown 冒泡到 window 前已被移除），
    // 下方 onKey 冒泡相的 DOM 实读将恒 false，一次 Esc 会「关面板 + 退 zen」
    // 双动作，违反「面板优先只关面板」。capture 相监听先于一切 target/bubble
    // 阶段 handler 执行，在任何面板 handler 动手前记录「本事件开始时」面板是否
    // 在 DOM，onKey 据此分派。chrome 菜单无自有 Esc handler（onKey 直读状态即可），
    // 不入快照；移动端 popstate 通道不经 keydown（onPopstate 直读不受影响）。
    let escOverlayAtStart = false;
    const snapOverlay = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') escOverlayAtStart = anyOverlayOpen();
    };
    window.addEventListener('keydown', snapOverlay, true);
    const onKey = (e: KeyboardEvent): void => {
      // zen 进出（spec §3）：Ctrl+Alt+Z 切换。键位冲突复核（2026-10-19 实读取，
      // 全仓库 rg KeyZ / ctrl+alt 组合）：既有键位仅 Ctrl/Cmd+Shift+F、Ctrl/Cmd+P、
      // Ctrl+, 、Alt+W(KeyW)、Alt+Shift+T(KeyT)、j/k/g/G 与各面板 Esc——Ctrl+Alt+Z
      // 无占用，浏览器亦无默认行为。
      // 评审 L2：本分支与 Esc 分支置于 inField 判定之前（Ctrl+P 组合键放行先例
      // 同款）——zen 快捷键/退出不被输入焦点拦截；overlay 优先级在 Esc 分支内
      // 闭环（面板容器 keydown 先于 window 关面板，此处实读 DOM 判 closeOverlay
      // 不叠加，语义不因前移改变）。
      if ((e.ctrlKey || e.metaKey) && e.altKey && !e.shiftKey && e.code === 'KeyZ') {
        e.preventDefault();
        toggleZen();
        return;
      }
      // Esc 优先级状态机（spec §3，zenEscAction 纯函数分派）：chrome 右键菜单 >
      // overlay（设置/搜索/快速打开等，面板自带 Esc 关闭处理器在同一事件上动作，
      // 此处不叠加）> 退 zen。overlay 判定 = capture 相快照 escOverlayAtStart
      // （见 snapOverlay 注释：面板 handler 同步 flush 后此处实时查询已不可见）。
      if (e.key === 'Escape') {
        if (chromeMenu !== null) {
          chromeMenu = null;
          return;
        }
        const action = zenEscAction({ overlaysOpen: escOverlayAtStart, zen: layout.zen });
        if (action === 'exitZen') {
          e.preventDefault();
          toggleZen();
        }
        return;
      }
      const t = e.target as HTMLElement | null;
      const inField =
        t !== null &&
        (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
      if (inField) {
        // BUG-31：快速打开面板输入框自动聚焦，本分支提前 return 会吞掉 Ctrl+P
        // toggle（面板已开时再按不关闭、不 preventDefault → 真实浏览器触发打印）。
        // 组合键例外放行：Ctrl/Cmd+P 恒走 toggle（VSCode 同惯例）；其余按键维持
        // inField 不接管语义（j/k/gg/G、单键面）。
        if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'p') {
          e.preventDefault();
          quickOpenOpen = !quickOpenOpen;
        }
        return;
      }
      // Ctrl+comma 切换设置中心（settings center spec §2，自 TopBar 迁入——原
      // 语义保持：非输入焦点才接管，inField 分支提前 return 已拦截输入态按键）
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key === ',') {
        e.preventDefault();
        toggleSettingsCenter();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        globalSearchOpen = !globalSearchOpen;
        return;
      }
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        quickOpenOpen = !quickOpenOpen;
        return;
      }
      // Alt+W 切换 tab 管理面板（T6）：浏览器无默认占用（关闭标签页是 Ctrl+W，
      // 与 Alt+W 无关）；inField 拦截沿用本 handler 顶部的统一判定。
      // 按 e.code 判定（T6 评审移交）：macOS Option+W 产出 e.key='∑'，按 key 判恒失效
      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.code === 'KeyW') {
        e.preventDefault();
        wsPanelOpen = !wsPanelOpen;
        return;
      }
      // Alt+Shift+T 撤销关闭 tab（F 项 T3）：出栈重建最近关闭的一个（LIFO 单个——
      // 批量关闭是逐个入栈，多次按键逐个恢复）。e.code 判定同 Alt+W（macOS Option
      // 修饰的 key 变体口径一致）；浏览器无默认占用。栈空以状态栏一次性提示反馈
      // （BUG-19「已取消选择文件夹」同通道），不静默——空按必须有可感知结果。
      if (e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyT') {
        e.preventDefault();
        if (reopenClosed() === null) showStatusNotice('没有可重新打开的标签页');
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const key = e.key;
      if (key !== 'j' && key !== 'k' && key !== 'g' && key !== 'G') return;
      const target = scrollTarget();
      if (target === null) return;
      e.preventDefault();
      if (key === 'j') target.scrollTop += codeLineHeight(loadSettings().fonts.codeSize);
      else if (key === 'k') target.scrollTop -= codeLineHeight(loadSettings().fonts.codeSize);
      else if (key === 'g') {
        const now = Date.now();
        if (now - lastGAt <= 500) {
          lastGAt = 0;
          target.scrollTop = 0;
        } else {
          lastGAt = now;
        }
      } else {
        target.scrollTop = target.scrollHeight - target.clientHeight;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', snapOverlay, true);
      window.removeEventListener('keydown', onKey);
    };
  });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions --><!-- contextmenu 为 chrome
     布局菜单入口（shell 级代理，按 target 归属分流），shell 容器无 AT 交互角色 -->
<div class="vv-shell" class:drawer={drawerOpen} class:rightopen={rightOpen} class:zen={layout.zen} oncontextmenu={onShellContextMenu}>
  <!-- 顶栏/标签栏：hidden=zen 或显式隐藏（chromeVisible 覆盖语义）；temp=边缘悬停
       临时条（半透覆盖形态）。组件保持挂载——Ctrl+, 设置中心入口（AppShell 自有
       状态）与 TopBar 的订阅注入链不因隐藏失效（spec §2 全件可隐但功能可达） -->
  {#if !vis.topBar}
    <!-- 边缘唤出热区（spec §2/§3，评审 M1）：shell flex 流内插槽锚定各自自然槽位
         （本条在 TopBar 槽位前、tab 条在 TopBar/TabBar 之间）——单/双隐藏组合均
         不错位，零测量。悬停唤出真实条本体（temp 形态），移开 1.5s 再隐。
         zen 下顶栏热区即退出条入口（临时条右键菜单「退出专注模式」） -->
    <!-- svelte-ignore a11y_no_static_element_interactions --><!-- 边缘悬停热区：纯
         指针唤出通道，无键盘/AT 等价物（zen 退出另有 Esc/快捷键/菜单通道）。
         pointerleave 也是「移开」语义锚点（终审 I-1）：临时条 fixed top:0 压住可见
         邻条时（TopBar 可见+TabBar 隐藏组合），指针从热区直入内容不经过条本体，
         条自带 onleave 不触发——热区移开即排定 1.5s 收回，对所有隐藏组合成立 -->
    <div
      class="vv-edge"
      data-edge="top"
      onpointerenter={() => summonTemp('top')}
      onpointerleave={() => scheduleHideTemp('top')}
    ></div>
  {/if}
  <TopBar
    temp={topTemp}
    hidden={!vis.topBar && !topTemp}
    onsettings={() => toggleSettingsCenter()}
    onenter={() => {
      if (!vis.topBar) summonTemp('top'); // 正常可见态的划过不置临时态
    }}
    onleave={() => {
      if (topTemp) scheduleHideTemp('top');
    }}
  />
  {#if !vis.tabBar}
    <!-- svelte-ignore a11y_no_static_element_interactions --><!-- pointerleave 同上（终审 I-1） -->
    <div
      class="vv-edge"
      data-edge="tab"
      onpointerenter={() => summonTemp('tab')}
      onpointerleave={() => scheduleHideTemp('tab')}
    ></div>
  {/if}
  <TabBar
    tabs={activeTabs}
    sources={activeWorkspace?.sources ?? []}
    onmanage={() => (wsPanelOpen = !wsPanelOpen)}
    temp={tabTemp}
    hidden={!vis.tabBar && !tabTemp}
    onenter={() => {
      if (!vis.tabBar) summonTemp('tab');
    }}
    onleave={() => {
      if (tabTemp) scheduleHideTemp('tab');
    }}
  />
  <div class="vv-body">
    {#if layout.leftCollapsed}
      <!-- 折叠竖条（spec §2：~28px，展开钮+所属面板图标），桌面断点专属（app.css）；
           ≤900px 抽屉机制不动，竖条不渲染进视觉（display:none） -->
      <div class="vv-strip" data-side="left">
        <button type="button" class="vv-strip-expand" aria-label="展开文件树" title="展开文件树"
          onclick={() => updateLayout({ leftCollapsed: false })}>»</button>
        <span class="vv-strip-icon" aria-hidden="true">🌳</span>
      </div>
    {/if}
    <aside class="vv-side" class:vv-side-off={layout.leftCollapsed} style="--vv-side-w: {leftW}px">
      <!-- 抽屉头部「专注模式」入口（spec §3.1 移动端回落挂点：iOS Safari 不派发
           contextmenu，长按布局菜单在 iOS 不可达）：桌面隐藏（媒体查询）；点击切
           zen 不动抽屉开合态——zen 隐抽屉本体，退出还原进入前开合（spec「恢复原
           开合状态」）；与桌面 chrome 菜单同源 toggleZen -->
      <div class="vv-drawer-head">
        <button type="button" class="vv-drawer-zen" onclick={() => toggleZen()}>专注模式</button>
      </div>
      <button type="button" class="vv-collapse-btn vv-collapse-left" aria-label="折叠文件树"
        title="折叠文件树" onclick={() => updateLayout({ leftCollapsed: true })}>‹</button>
      {#if sources.length > 0}
        <!-- 整树重建 key：源数量 | 各源数据版本 storeRevisions | 排除规则（BUG-05 通道，T4 多源化，M-2 修正，T7 分桶） -->
        {#key treeKey}
          <FileTree {sources} excludedPatterns={settings.excludedPatterns} onopen={onTreeOpen} onremove={removeSource} />
        {/key}
      {:else}
        <div class="vv-side-empty">未打开文件夹</div>
      {/if}
    </aside>
    {#if !layout.leftCollapsed}
      <!-- 中缝调宽把手（spec §2）：6px 热区，拖动实时预览、松手落盘、双击重置默认宽 -->
      <div
        class="vv-colhandle"
        class:vv-dragging={drag?.side === 'left'}
        data-side="left"
        role="separator"
        aria-orientation="vertical"
        aria-label="调整文件树宽度"
        title="拖拽调宽（双击重置）"
        onpointerdown={(e) => startDrag('left', e)}
        onpointermove={moveDrag}
        onpointerup={endDrag}
        onpointercancel={endDrag}
        onlostpointercapture={endDrag}
        ondblclick={() => updateLayout({ leftWidth: DEFAULT_LAYOUT.leftWidth })}
      ></div>
    {/if}
    <main class="vv-main">
      <ViewerPane
        tab={activeTabs.find((t) => t.active) ?? null}
        ontoc={(entries) => (tocEntries = entries)}
      />
    </main>
    {#if !layout.rightCollapsed}
      <div
        class="vv-colhandle"
        class:vv-dragging={drag?.side === 'right'}
        data-side="right"
        role="separator"
        aria-orientation="vertical"
        aria-label="调整属性面板宽度"
        title="拖拽调宽（双击重置）"
        onpointerdown={(e) => startDrag('right', e)}
        onpointermove={moveDrag}
        onpointerup={endDrag}
        onpointercancel={endDrag}
        onlostpointercapture={endDrag}
        ondblclick={() => updateLayout({ rightWidth: DEFAULT_LAYOUT.rightWidth })}
      ></div>
    {/if}
    <aside class="vv-right" class:vv-right-off={layout.rightCollapsed} style="--vv-right-w: {rightW}px">
      <button type="button" class="vv-collapse-btn vv-collapse-right" aria-label="折叠属性面板"
        title="折叠属性面板" onclick={() => updateLayout({ rightCollapsed: true })}>›</button>
      <MetaPanel />
      {#if tocEntries.length > 0}
        <Toc entries={tocEntries} />
      {/if}
    </aside>
    {#if layout.rightCollapsed}
      <div class="vv-strip" data-side="right">
        <button type="button" class="vv-strip-expand" aria-label="展开属性面板" title="展开属性面板"
          onclick={() => updateLayout({ rightCollapsed: false })}>«</button>
        <span class="vv-strip-icon" aria-hidden="true">ℹ</span>
      </div>
    {/if}
  </div>
  <button class="vv-drawer-toggle" aria-label="切换侧栏" onclick={() => (drawerOpen = !drawerOpen)}>☰</button>
  <button class="vv-right-toggle" aria-label="切换目录与属性面板" onclick={() => (rightOpen = !rightOpen)}>ℹ</button>
  {#if layout.zen}
    <!-- zen 退出浮钮（spec §3.1 移动端）：hover 退出条的触屏替身，桌面无此钮
         （媒体查询隐藏）。≥44px 触控标准、半透不遮内容；右下角定于状态栏上方
         （状态栏 zen 保留，浮钮避让其高度）；z-index 低于面板层 30——面板在场时
         返回键先关面板，浮钮被压住即「面板优先」的视觉一致 -->
    <button type="button" class="vv-zen-exit" aria-label="退出专注模式" title="退出专注模式"
      onclick={() => toggleZen()}>✕</button>
  {/if}
  {#if globalSearchOpen}
    <GlobalSearchPanel {sources} onclose={() => (globalSearchOpen = false)} />
  {/if}
  {#if quickOpenOpen}
    <QuickOpenPanel {sources} onclose={() => (quickOpenOpen = false)} />
  {/if}
  {#if wsPanelOpen}
    <WorkspaceTabsPanel onclose={() => (wsPanelOpen = false)} />
  {/if}
  {#if settingsCenterOpen}
    <SettingsCenter bind:this={settingsCenterEl} onclose={() => (settingsCenterOpen = false)} />
  {/if}
  {#if chromeMenu !== null}
    {@const bar = chromeMenu.bar}
    <!-- chrome 右键菜单（spec §2「隐藏」入口 / §3 TopBar 布局菜单项；隐藏态临时
         条上右键同菜单反向勾选显示）。条目随 layout 状态即时计算 -->
    <div class="vv-chromemenu" role="menu" bind:this={chromeMenuEl} style="left:{chromeMenu.x}px; top:{chromeMenu.y}px">
      <button
        type="button"
        role="menuitem"
        onclick={() => {
          menuToggleVisible(bar);
          chromeMenu = null;
        }}>
        {bar === 'top' ? (layout.topBarVisible ? '隐藏顶栏' : '显示顶栏') : (layout.tabBarVisible ? '隐藏标签栏' : '显示标签栏')}
      </button>
      <button
        type="button"
        role="menuitem"
        onclick={() => {
          toggleZen();
          chromeMenu = null;
        }}>
        {layout.zen ? '退出专注模式' : '进入专注模式'}
      </button>
    </div>
  {/if}
</div>

<style>
  .vv-shell {
    display: flex;
    flex-direction: column;
    height: 100vh;
  }
  .vv-body {
    display: flex;
    flex: 1;
    min-height: 0;
  }
  .vv-side {
    /* 宽度经 CSS 变量（内联 --vv-side-w / --vv-right-w 供值，拖拽实时预览与持久值
       同一通道）；≤900px 媒体查询在本文件更后处覆写 width（抽屉机制不动） */
    width: var(--vv-side-w, 260px);
    position: relative;
    overflow: auto;
    border-right: 1px solid var(--ui-border);
    background: var(--ui-side-bg);
  }
  .vv-main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .vv-right {
    width: var(--vv-right-w, 230px);
    flex: none;
    position: relative;
    display: flex;
    flex-direction: column;
    overflow: auto;
    border-left: 1px solid var(--ui-border);
    background: var(--ui-side-bg);
  }
  /* 折叠态桌面隐藏本体（残留竖条由 .vv-strip 承担）；≤900px 抽屉不受折叠影响，
     故 off 规则限定桌面断点（移动端无折叠语义，spec 非目标） */
  @media (min-width: 901px) {
    .vv-side.vv-side-off,
    .vv-right.vv-right-off {
      display: none;
    }
  }
  .vv-side-empty {
    padding: 2rem;
    color: var(--ui-fg-muted);
  }
  .vv-drawer-toggle,
  .vv-right-toggle {
    display: none;
  }
  @media (max-width: 900px) {
    .vv-side {
      position: fixed;
      inset: 0 auto 0 0;
      width: min(80vw, 300px);
      transform: translateX(-100%);
      transition: transform 0.2s;
      z-index: 10;
      background: var(--ui-bg);
      box-shadow: 0 0 12px rgb(0 0 0 / 25%);
    }
    .vv-shell.drawer .vv-side {
      transform: none;
    }
    .vv-drawer-toggle {
      display: block;
      position: fixed;
      left: 8px;
      bottom: 8px;
      z-index: 20;
    }
    /* 平板段（601-900px）只把文件树收进抽屉：右栏（230px 固定宽）保留在主区
       流式布局内——原先两栏同时滑入抽屉、单按钮同开同关，600px 档两栏合计
       600px 几乎盖满视口（终审 M7「双栏并存遮挡」）。 */
    /* 手机宽度（≤600px）：主区放不下 230px 右栏，MetaPanel/TOC 收进右侧抽屉，
       独立 toggle 入口（终审 M7「手机无右栏入口、TOC 不可达」） */
    @media (max-width: 600px) {
      .vv-right {
        position: fixed;
        inset: 0 0 0 auto;
        width: min(80vw, 300px);
        transform: translateX(100%);
        transition: transform 0.2s;
        z-index: 10;
        background: var(--ui-bg);
        box-shadow: 0 0 12px rgb(0 0 0 / 25%);
      }
      .vv-shell.rightopen .vv-right {
        transform: none;
      }
      .vv-right-toggle {
        display: block;
        position: fixed;
        right: 8px;
        bottom: 8px;
        z-index: 20;
      }
    }
  }
  /* zen 移动端（spec §3.1，Task 4）：退出浮钮 + 抽屉头部「专注模式」入口——基线
     display:none（桌面无此钮/无此项，spec「桌面无此钮」），≤900px 抽屉断点
     （与 isDrawerBreakpoint 同一条件，改断点两处同步）内才渲染视觉 */
  .vv-zen-exit,
  .vv-drawer-head {
    display: none;
  }
  @media (max-width: 900px) {
    .vv-drawer-head {
      display: flex;
      justify-content: flex-end;
      padding: 4px 8px;
      border-bottom: 1px solid var(--ui-border);
    }
    .vv-drawer-zen {
      background: none;
      border: 1px solid var(--ui-border);
      border-radius: 6px;
      padding: 6px 12px;
      font: inherit;
      font-size: 13px;
      cursor: pointer;
    }
    /* 退出浮钮：44px 触控标准、半透 0.55（不遮内容，hover/聚焦提亮）；右下角
       bottom 34px 避让状态栏（~22px 高，zen 保留，spec §3.1「浮钮定位避开状态栏」）；
       z-index 25 低于面板层 30——面板在场时返回键先关面板的视觉一致 */
    .vv-zen-exit {
      display: block;
      position: fixed;
      right: 12px;
      bottom: 34px;
      z-index: 25;
      width: 44px;
      height: 44px;
      border-radius: 50%;
      border: 1px solid var(--ui-border);
      background: var(--ui-tab-active-bg);
      color: var(--ui-fg);
      font-size: 18px;
      line-height: 1;
      cursor: pointer;
      opacity: 0.55;
    }
    .vv-zen-exit:hover,
    .vv-zen-exit:focus-visible {
      opacity: 1;
    }
  }
</style>
