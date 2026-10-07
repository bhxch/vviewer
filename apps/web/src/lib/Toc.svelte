<script lang="ts">
  import type { TocEntry } from '@vviewer/core';

  /** 目录组件（Task 5）：entries 由 ViewerPane 从渲染实例 getToc() 流入（AppShell 中转）。
   * 点击滚动到 heading（scrollIntoView，markdown 的滚动容器是外层 .vv-viewer-scroll）；
   * 滚动跟随用 IntersectionObserver（视口上带高亮最近可见节）。 */
  let { entries }: { entries: TocEntry[] } = $props();

  let activeId = $state<string | null>(null);
  let observer: IntersectionObserver | null = null;
  /** id → 与视口的相交比例（IO 回调维护；取比例最高者为当前节） */
  let visible = new Map<string, number>();

  $effect(() => {
    // 依赖 entries：tab 切换/重渲染后 heading 是新节点，observer 按当前列表重建
    observer?.disconnect();
    visible = new Map();
    observer = new IntersectionObserver(
      (obsEntries) => {
        for (const e of obsEntries) {
          const id = (e.target as HTMLElement).id;
          if (e.isIntersecting) visible.set(id, e.intersectionRatio);
          else visible.delete(id);
        }
        let best: string | null = null;
        let bestRatio = 0;
        for (const [id, ratio] of visible) {
          if (ratio > bestRatio) {
            bestRatio = ratio;
            best = id;
          }
        }
        if (best) activeId = best;
      },
      // 只把视口顶部 35% 带内的标题视为"当前"（贴近阅读位置，避免半屏标题全亮）
      { rootMargin: '0px 0px -65% 0px', threshold: [0, 0.25, 0.5, 0.75, 1] }
    );
    for (const entry of entries) {
      const el = document.getElementById(entry.id);
      if (el) observer.observe(el);
    }
    return () => {
      observer?.disconnect();
      observer = null;
    };
  });

  function jump(entry: TocEntry): void {
    activeId = entry.id;
    document.getElementById(entry.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
</script>

<nav class="toc" aria-label="目录">
  {#if entries.length === 0}
    <p class="toc-empty">无标题</p>
  {:else}
    <ul>
      {#each entries as e (e.id)}
        <li class="level-{e.level}">
          <button type="button" class:active={activeId === e.id} title={e.text} onclick={() => jump(e)}>
            {e.text}
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</nav>
