<script lang="ts">
  import type { RenderedInstance } from '@vviewer/core';
  import { showErrorCard } from '@vviewer/core';
  import type { Tab } from './openFlow.svelte';
  import { persistScroll } from './openFlow.svelte';
  import { dispatcher } from './viewer';

  let { tab }: { tab: Tab | null } = $props();

  let host = $state<HTMLElement | null>(null);
  let instance: RenderedInstance | null = null;

  $effect(() => {
    if (!host || !tab || tab.source.path === '') return;
    const current = tab;
    let cancelled = false;
    void (async () => {
      instance?.destroy();
      instance = null;
      try {
        const buffer = await current.source.store.read(current.source.path);
        if (cancelled || !host) return;
        const res = await dispatcher.dispatch(current.source, buffer, host);
        if (cancelled) {
          res.instance.destroy();
          return;
        }
        instance = res.instance;
        // 滚动恢复：目录树切换回该 tab 时回到上次位置（外层滚动容器）
        const scroller = host.closest('.vv-viewer-scroll') as HTMLElement | null;
        if (scroller && current.scrollTop > 0) {
          requestAnimationFrame(() => {
            scroller.scrollTop = current.scrollTop;
          });
        }
      } catch (err) {
        // store.read 失败（如会话占位 tab、句柄失效）也走错误卡片
        if (cancelled || !host) return;
        const message = err instanceof Error ? err.message : String(err);
        instance = showErrorCard(host, message, current.source);
      }
    })();
    return () => {
      cancelled = true;
      instance?.destroy();
      instance = null;
    };
  });

  function onScroll(e: Event): void {
    const t = tab;
    if (!t) return;
    void persistScroll(t.id, (e.currentTarget as HTMLElement).scrollTop);
  }
</script>

<div class="vv-viewer-scroll" onscroll={onScroll}>
  {#if !tab}
    <div class="vv-empty">拖入文件/文件夹，或使用顶栏打开</div>
  {:else if tab.unrestorable && tab.source.path === ''}
    <div class="vv-empty">此来源无法自动恢复，请重新打开文件夹</div>
  {:else if tab.source.path === ''}
    <div class="vv-empty">目录来源：文件在左侧树中打开</div>
  {:else}
    <div class="vv-viewer-host" bind:this={host}></div>
  {/if}
</div>

<style>
  .vv-viewer-scroll {
    flex: 1;
    overflow: auto;
    min-height: 0;
  }
  .vv-empty {
    padding: 2rem;
    color: var(--ui-fg-muted);
  }
  .vv-viewer-host {
    min-height: 100%;
  }
</style>
