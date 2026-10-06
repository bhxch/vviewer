<script lang="ts">
  import { onMount } from 'svelte';
  import TopBar from './TopBar.svelte';
  import TabBar from './TabBar.svelte';
  import ViewerPane from './ViewerPane.svelte';
  import FileTree from './FileTree.svelte';
  import type { TreeStore } from '@vviewer/core';
  import { tabStore, addTab, activateTab, tryRestoreDirectory } from './openFlow.svelte';
  import { loadSession, saveDirHandle, type TabSnapshot } from './stores/session';
  import { loadSettings } from './stores/settings';

  const settings = loadSettings();
  let dirStore = $state<TreeStore | null>(null);
  let drawerOpen = $state(false);

  // 左栏文件树跟随目录 tab（优先 localfs 来源；会话占位不充当目录来源）
  $effect(() => {
    const list = tabStore.list;
    const dirTab = list.find((t) => t.source.path === '' && !t.unrestorable && t.source.storeId.startsWith('localfs:'))
      ?? list.find((t) => t.source.path === '' && !t.unrestorable);
    dirStore = dirTab?.source.store ?? null;
  });

  onMount(() => {
    document.documentElement.dataset.themeMode = settings.themeMode;
    void restore();
  });

  async function restore(): Promise<void> {
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
      if (t.kind === 'restorable' && dirStoreAtRestore) {
        const tab = addTab(dirStoreAtRestore, t.path, t.name);
        tab.scrollTop = t.scrollTop;
      } else {
        addPlaceholderTab(t);
      }
    }
    alignActive(saved);
  }

  function currentDirStore(): TreeStore | null {
    const list = tabStore.list;
    const dirTab = list.find((t) => t.source.path === '' && !t.unrestorable && t.source.storeId.startsWith('localfs:'))
      ?? list.find((t) => t.source.path === '' && !t.unrestorable);
    return dirTab?.source.store ?? null;
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
    const match = tabStore.list.find((t) => t.source.storeId === want.storeId && t.source.path === want.path);
    if (match) activateTab(match.id);
  }

  function onTreeOpen(e: { path: string; name: string }): void {
    if (dirStore) addTab(dirStore, e.path, e.name);
  }
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
      <ViewerPane tab={tabStore.list.find((t) => t.active) ?? null} />
    </main>
  </div>
  <button class="vv-drawer-toggle" aria-label="切换文件树" onclick={() => (drawerOpen = !drawerOpen)}>☰</button>
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
  }
</style>
