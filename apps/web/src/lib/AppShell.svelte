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
  import type { TreeStore, TocEntry } from '@vviewer/core';
  import { createRemoteStore } from '@vviewer/core';
  import {
    tabStore,
    addTab,
    activateTab,
    tryRestoreDirectory,
    bindArchiveOpenEvents,
    seedSeqFromSnapshots,
    loadLastServer,
    watchHealth
  } from './openFlow.svelte';
  import { loadSession, saveDirHandle, type TabSnapshot } from './stores/session';
  import { loadSettings, onSettingsChanged } from './stores/settings';

  // 响应式副本：onSettingsChanged 订阅刷新（BUG-05）。此前是非响应式快照，
  // 设置面板改排除规则后 FileTree 拿不到新值
  let settings = $state(loadSettings());
  let dirStore = $state<TreeStore | null>(null);
  /** 目录 tab 的 rev（SSE changed 自增）：作 FileTree 的重建 key（左栏树刷新） */
  let dirRev = $state(0);
  let drawerOpen = $state(false);
  /** 右栏（MetaPanel/TOC）抽屉开关：仅 ≤600px 断点生效（见样式媒体查询） */
  let rightOpen = $state(false);
  /** 活动渲染实例的目录（ViewerPane ontoc 回调上行；markdown tab 有数据，其余为空） */
  let tocEntries = $state<TocEntry[]>([]);
  /** 全局搜索面板开关（M6 T4）：Ctrl+Shift+F 打开，Esc 面板内关闭 */
  let globalSearchOpen = $state(false);
  /** 快速打开面板开关（BUG-03）：Ctrl+P 切换，Esc 面板内关闭 */
  let quickOpenOpen = $state(false);

  // 左栏文件树跟随目录 tab（目录 tab 由 addDirStoreTab 替换语义保证至多一个）
  $effect(() => {
    const list = tabStore.list;
    const dirTab = list.find((t) => t.source.path === '' && !t.unrestorable);
    dirStore = dirTab?.source.store ?? null;
    dirRev = dirTab?.rev ?? 0;
  });

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

  async function restore(): Promise<void> {
    // 恢复失败（IndexedDB 异常、快照损坏等）不得阻断应用启动：降级为空会话
    try {
      const { tabs: saved, lastDirHandle } = await loadSession();
      // 新 tab id 以快照最大序号为基：占位 tab 保留快照旧 id，seq 从 0 重计数会撞车
      seedSeqFromSnapshots(saved);
      let dirStoreAtRestore: TreeStore | null = null;
      if (lastDirHandle) {
        const ok = await tryRestoreDirectory(lastDirHandle);
        if (!ok) {
          await saveDirHandle(null); // 权限被拒：清除失效句柄，避免下次启动反复弹权限
        } else {
          dirStoreAtRestore = currentDirStore();
        }
      }
      // BUG-08（方案 A）：remote 快照（快照带 storeBase）且与会话内上次成功连接
      // （loadLastServer，sessionStorage 跨 F5 存活）base 一致时，restore 期自动
      // 重建 RemoteStore 恢复内容与滚动位置；重建失败（不可达）落服务器来源占位。
      // 同 base 只探测一次；health 探测 3s 超时，失败不重试、不阻塞启动
      const last = loadLastServer();
      const reconnected = new Map<string, Promise<TreeStore | null>>();
      const reconnectOf = (base: string, token: string | null): Promise<TreeStore | null> => {
        let p = reconnected.get(base);
        if (p === undefined) {
          p = reconnectRemoteStore(base, token);
          reconnected.set(base, p);
        }
        return p;
      };
      for (const t of saved) {
        // 目录来源已由 tryRestoreDirectory 重建为目录 tab；快照中的目录条目
        // （path===''）若再恢复会每次启动累积一个，故跳过
        if (t.path === '') continue;
        if (t.kind === 'restorable' && dirStoreAtRestore) {
          const tab = addTab(dirStoreAtRestore, t.path, t.name);
          tab.scrollTop = t.scrollTop;
          continue;
        }
        if (t.kind === 'rename-only' && t.storeBase !== undefined && last !== null && last.baseUrl === t.storeBase) {
          let store: TreeStore | null = null;
          try {
            store = await reconnectOf(t.storeBase, last.token);
          } catch (err) {
            // 重连通道意外抛错：与不可达同待遇——落占位，绝不让单 tab 拖垮整个恢复
            console.error(`恢复服务器 ${t.storeBase} 的 tab 失败`, err);
          }
          if (store !== null) {
            const tab = addTab(store, t.path, t.name);
            tab.scrollTop = t.scrollTop;
            continue;
          }
        }
        addPlaceholderTab(t);
      }
      alignActive(saved);
    } catch (err) {
      console.error('会话恢复失败，已降级为空会话', err);
    }
  }

  /**
   * BUG-08：restore 期自动重连（connectServer 的精简恢复路径）——health 探测
   * 3s 超时判可达，可达即 createRemoteStore + SSE watch 订阅接线（与 connectServer
   * 同模式：autoRefresh 关闭时回调过滤、watch-error 置降级指示）；不可达返回 null
   * 交由调用方落占位。不发目录 tab（不自动弹树），只服务快照 tab 的内容恢复。
   */
  async function reconnectRemoteStore(base: string, token: string | null): Promise<TreeStore | null> {
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
    let label = base;
    try {
      label = new URL(base).host;
    } catch {
      // base 非法（极端）：显示名退回原串
    }
    const store = createRemoteStore(base, token, label);
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

  function currentDirStore(): TreeStore | null {
    return tabStore.list.find((t) => t.source.path === '' && !t.unrestorable)?.source.store ?? null;
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
  }

  /** addTab 总是激活新 tab，恢复完成后需对齐快照记录的活动 tab */
  function alignActive(saved: TabSnapshot[]): void {
    const want = saved.find((t) => t.active);
    if (!want) return;
    // rename-only 占位的 storeId 为 placeholder:${快照 storeId}，需一并匹配
    const match = tabStore.list.find(
      (t) => t.source.path === want.path
        && (t.source.storeId === want.storeId || t.source.storeId === `placeholder:${want.storeId}`)
    );
    if (match) activateTab(match.id);
  }

  function onTreeOpen(e: { path: string; name: string }): void {
    if (dirStore) addTab(dirStore, e.path, e.name);
  }

  // 全局键位（BUG-03，场景 SHELL-11）：Ctrl+Shift+F 全局搜索（既有）、Ctrl+P
  // 快速打开、j/k 逐行滚、gg 顶、G 底。统一走 inField 判定（非输入焦点才接管
  // ——与 M3 '/' 的惯例同源），组合键均 preventDefault。
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
  <TabBar tabs={tabStore.list} />
  <div class="vv-body">
    <aside class="vv-side">
      {#if dirStore}
        <!-- 排除规则变更也重建整棵树（含已懒加载的子目录），与 dirRev（SSE）同一 key 通道（BUG-05） -->
        {#key `${dirRev}|${JSON.stringify(settings.excludedPatterns)}`}
          <FileTree store={dirStore} excludedPatterns={settings.excludedPatterns} onopen={onTreeOpen} />
        {/key}
      {:else}
        <div class="vv-side-empty">未打开文件夹</div>
      {/if}
    </aside>
    <main class="vv-main">
      <ViewerPane
        tab={tabStore.list.find((t) => t.active) ?? null}
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
    <GlobalSearchPanel store={dirStore} onclose={() => (globalSearchOpen = false)} />
  {/if}
  {#if quickOpenOpen}
    <QuickOpenPanel store={dirStore} onclose={() => (quickOpenOpen = false)} />
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
