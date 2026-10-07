<script lang="ts">
  import { onMount } from 'svelte';
  import TopBar from './TopBar.svelte';
  import TabBar from './TabBar.svelte';
  import ViewerPane from './ViewerPane.svelte';
  import FileTree from './FileTree.svelte';
  import Toc from './Toc.svelte';
  import MetaPanel from './MetaPanel.svelte';
  import GlobalSearchPanel from './GlobalSearchPanel.svelte';
  import type { TreeStore, TocEntry } from '@vviewer/core';
  import { tabStore, addTab, activateTab, tryRestoreDirectory, bindArchiveOpenEvents } from './openFlow.svelte';
  import { loadSession, saveDirHandle, type TabSnapshot } from './stores/session';
  import { loadSettings } from './stores/settings';

  const settings = loadSettings();
  let dirStore = $state<TreeStore | null>(null);
  let drawerOpen = $state(false);
  /** 活动渲染实例的目录（ViewerPane ontoc 回调上行；markdown tab 有数据，其余为空） */
  let tocEntries = $state<TocEntry[]>([]);
  /** 全局搜索面板开关（M6 T4）：Ctrl+Shift+F 打开，Esc 面板内关闭 */
  let globalSearchOpen = $state(false);

  // 左栏文件树跟随目录 tab（目录 tab 由 addDirStoreTab 替换语义保证至多一个）
  $effect(() => {
    const list = tabStore.list;
    dirStore = list.find((t) => t.source.path === '' && !t.unrestorable)?.source.store ?? null;
  });

  onMount(() => {
    document.documentElement.dataset.themeMode = settings.themeMode;
    // render-archive 包内树点击 → addTab（递归预览通道）
    const unbindArchive = bindArchiveOpenEvents();
    void restore();
    return unbindArchive;
  });

  async function restore(): Promise<void> {
    // 恢复失败（IndexedDB 异常、快照损坏等）不得阻断应用启动：降级为空会话
    try {
      const { tabs: saved, lastDirHandle } = await loadSession();
      let dirStoreAtRestore: TreeStore | null = null;
      if (lastDirHandle) {
        const ok = await tryRestoreDirectory(lastDirHandle);
        if (!ok) {
          await saveDirHandle(null); // 权限被拒：清除失效句柄，避免下次启动反复弹权限
        } else {
          dirStoreAtRestore = currentDirStore();
        }
      }
      for (const t of saved) {
        // 目录来源已由 tryRestoreDirectory 重建为目录 tab；快照中的目录条目
        // （path===''）若再恢复会每次启动累积一个，故跳过
        if (t.path === '') continue;
        if (t.kind === 'restorable' && dirStoreAtRestore) {
          const tab = addTab(dirStoreAtRestore, t.path, t.name);
          tab.scrollTop = t.scrollTop;
        } else {
          addPlaceholderTab(t);
        }
      }
      alignActive(saved);
    } catch (err) {
      console.error('会话恢复失败，已降级为空会话', err);
    }
  }

  function currentDirStore(): TreeStore | null {
    return tabStore.list.find((t) => t.source.path === '' && !t.unrestorable)?.source.store ?? null;
  }

  function addPlaceholderTab(t: TabSnapshot): void {
    // 占位 store：read 即抛错，ViewerPane 以错误卡片提示"需重新打开"
    const store: TreeStore = {
      id: `placeholder:${t.storeId}`,
      displayName: () => t.storeLabel,
      listChildren: async () => [],
      read: async () => {
        throw new Error('会话中的本地文件需要重新打开（浏览器不保留文件内容）');
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

  // Ctrl+Shift+F 切换全局搜索（非输入焦点时才接管——复用 M3 '/' 的 inField 判定）
  $effect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'f')) return;
      const t = e.target as HTMLElement | null;
      const inField =
        t !== null &&
        (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
      if (inField) return;
      e.preventDefault();
      globalSearchOpen = !globalSearchOpen;
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
</script>

<div class="vv-shell" class:drawer={drawerOpen}>
  <TopBar />
  <TabBar tabs={tabStore.list} />
  <div class="vv-body">
    <aside class="vv-side">
      {#if dirStore}
        <FileTree store={dirStore} excludedPatterns={settings.excludedPatterns} onopen={onTreeOpen} />
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
  {#if globalSearchOpen}
    <GlobalSearchPanel store={dirStore} onclose={() => (globalSearchOpen = false)} />
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
  .vv-drawer-toggle {
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
    /* 窄屏右栏并入同一抽屉（左侧文件树 + 右侧目录/属性从两端滑入） */
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
    .vv-shell.drawer .vv-side {
      transform: none;
    }
    .vv-shell.drawer .vv-right {
      transform: none;
    }
    .vv-drawer-toggle {
      display: block;
      position: fixed;
      left: 8px;
      bottom: 8px;
      z-index: 20;
    }
  }
</style>
