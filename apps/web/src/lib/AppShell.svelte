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
  import { loadSettings, onSettingsChanged } from './stores/settings';

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
    // 设置变更（TopBar/SettingsPanel 经 saveSettings 写入）→ 刷新响应式副本：
    // 排除规则变化经下方 {#key} 重建 FileTree（BUG-05）
    const offSettings = onSettingsChanged((s) => (settings = s));
    // render-archive 包内树点击 → addTab（递归预览通道）
    const unbindArchive = bindArchiveOpenEvents();
    void restore();
    return () => {
      offSettings();
      unbindArchive();
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
      const [{ snapshot, legacyTabs }, dirHandle] = await Promise.all([loadWorkspaces(), loadDirHandle()]);
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
              const store = await tryRestoreDirectory(dirHandle, wsItem.id);
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
            if (store !== null) rebuilt.set(src.storeId, store);
          }
        }
        // —— 再逐 tab 恢复；目录条目（path===''）已由来源重建，跳过防每次启动
        // 累积一个（与旧 restore 同款）。来源未重建成功的 tab 落占位 ——
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
            const tab = addTab(store, t.path, t.name);
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

  function onTreeOpen(e: { path: string; name: string; store: TreeStore }): void {
    addTab(e.store, e.path, e.name);
  }

  // 全局键位（BUG-03，场景 SHELL-11）：Ctrl+Shift+F 全局搜索（既有）、Ctrl+P
  // 快速打开、Alt+W tab 管理面板（T6）、Alt+Shift+T 撤销关闭 tab（F 项 T3）、
  // j/k 逐行滚、gg 顶、G 底。统一走 inField
  // 判定（非输入焦点才接管——与 M3 '/' 的惯例同源），组合键均 preventDefault。
  // 行高 20px 与 render-text code.ts 的 LINE_HEIGHT 同源（计划包 5 依赖说明：
  // 不 import 包 2 文件，常量复制需注释同源）。
  const CODE_LINE_HEIGHT = 20;
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
    const onKey = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement | null;
      const inField =
        t !== null &&
        (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
      if (inField) return;
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
      if (key === 'j') target.scrollTop += CODE_LINE_HEIGHT;
      else if (key === 'k') target.scrollTop -= CODE_LINE_HEIGHT;
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
    return () => window.removeEventListener('keydown', onKey);
  });
</script>

<div class="vv-shell" class:drawer={drawerOpen} class:rightopen={rightOpen}>
  <TopBar />
  <TabBar
    tabs={activeTabs}
    sources={activeWorkspace?.sources ?? []}
    onmanage={() => (wsPanelOpen = !wsPanelOpen)}
  />
  <div class="vv-body">
    <aside class="vv-side">
      {#if sources.length > 0}
        <!-- 整树重建 key：源数量 | 各源数据版本 storeRevisions | 排除规则（BUG-05 通道，T4 多源化，M-2 修正，T7 分桶） -->
        {#key treeKey}
          <FileTree {sources} excludedPatterns={settings.excludedPatterns} onopen={onTreeOpen} onremove={removeSource} />
        {/key}
      {:else}
        <div class="vv-side-empty">未打开文件夹</div>
      {/if}
    </aside>
    <main class="vv-main">
      <ViewerPane
        tab={activeTabs.find((t) => t.active) ?? null}
        ontoc={(entries) => (tocEntries = entries)}
      />
    </main>
    <aside class="vv-right">
      <MetaPanel />
      {#if tocEntries.length > 0}
        <Toc entries={tocEntries} />
      {/if}
    </aside>
  </div>
  <button class="vv-drawer-toggle" aria-label="切换侧栏" onclick={() => (drawerOpen = !drawerOpen)}>☰</button>
  <button class="vv-right-toggle" aria-label="切换目录与属性面板" onclick={() => (rightOpen = !rightOpen)}>ℹ</button>
  {#if globalSearchOpen}
    <GlobalSearchPanel {sources} onclose={() => (globalSearchOpen = false)} />
  {/if}
  {#if quickOpenOpen}
    <QuickOpenPanel {sources} onclose={() => (quickOpenOpen = false)} />
  {/if}
  {#if wsPanelOpen}
    <WorkspaceTabsPanel onclose={() => (wsPanelOpen = false)} />
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
    width: 260px;
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
    width: 230px;
    flex: none;
    display: flex;
    flex-direction: column;
    overflow: auto;
    border-left: 1px solid var(--ui-border);
    background: var(--ui-side-bg);
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
</style>
