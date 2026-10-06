<script lang="ts">
  import type { RenderedInstance } from '@vviewer/core';
  import { showErrorCard } from '@vviewer/core';
  import type { Tab } from './openFlow.svelte';
  import { persistScroll } from './openFlow.svelte';
  import { dispatcher } from './viewer';
  import { cancelHighlight } from './highlightClient';

  let { tab }: { tab: Tab | null } = $props();

  let host = $state<HTMLElement | null>(null);
  let instance: RenderedInstance | null = null;
  let rafId = 0;
  /** code 渲染器的内部滚动容器（.vv-code-pre）；其余渲染器为 null（滚动在外层 .vv-viewer-scroll） */
  let scrollHost: HTMLElement | null = null;

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
        // 滚动恢复：目录树切换回该 tab 时回到上次位置。
        // code 渲染器滚动在内部 .vv-code-pre（外层不滚动），接 getScrollHost()；其余维持外层容器。
        const inner =
          'getScrollHost' in res.instance
            ? (res.instance as RenderedInstance & { getScrollHost(): HTMLElement }).getScrollHost()
            : null;
        if (inner) {
          scrollHost = inner;
          inner.addEventListener('scroll', onScroll);
        }
        const target: HTMLElement | null = inner ?? (host.closest('.vv-viewer-scroll') as HTMLElement | null);
        if (target && current.scrollTop > 0) {
          rafId = requestAnimationFrame(() => {
            if (cancelled) return;
            target.scrollTop = current.scrollTop;
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
      cancelAnimationFrame(rafId);
      scrollHost?.removeEventListener('scroll', onScroll);
      scrollHost = null;
      cancelHighlight(); // 取消未完成的 tree-sitter 高亮请求（Worker 不做无用功）
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
    /* 必须定高：父级 .vv-viewer-scroll 是 flex 定高滚动容器，
       min-height:100% 会让 .vv-code-pre 的 height:100% 解析为 0（overflow 裁剪成视觉空白） */
    height: 100%;
  }
</style>
