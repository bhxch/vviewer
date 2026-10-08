<script lang="ts">
  import type { TocEntry } from '@vviewer/core';

  /** 目录组件（Task 5）：entries 由 ViewerPane 从渲染实例 getToc() 流入（AppShell 中转）。
   * 点击滚动到 heading（scrollIntoView，markdown 的滚动容器是外层 .vv-viewer-scroll）；
   * 滚动跟随用 IntersectionObserver：视口顶部 35% 带内"最贴近视口顶部的标题"为当前节
   * （遗留 U5 改语义，原为相交比例最高者）；带内无标题（滚过长段无标题正文）时
   * 保留最后 activeId 不清空，目录高亮不闪失。 */
  let { entries }: { entries: TocEntry[] } = $props();

  let activeId = $state<string | null>(null);
  let observer: IntersectionObserver | null = null;
  /** id → 最新回调时该标题 boundingClientRect.top（IO 回调维护；取最小 top 者为当前节） */
  let visible = new Map<string, number>();

  $effect(() => {
    // 依赖 entries：tab 切换/重渲染后 heading 是新节点，observer 按当前列表重建
    observer?.disconnect();
    visible = new Map();
    observer = new IntersectionObserver(
      (obsEntries) => {
        for (const e of obsEntries) {
          const id = (e.target as HTMLElement).id;
          if (e.isIntersecting) visible.set(id, e.boundingClientRect.top);
          else visible.delete(id);
        }
        // 跟随语义（遗留 U5）："视口顶部最近的标题"。原实现取相交比例最高者，长小节
        // 内滚动时比例钝化、节间切换滞后；带内取 top 最小者与阅读位置一致。
        let best: string | null = null;
        let bestTop = Number.POSITIVE_INFINITY;
        for (const [id, top] of visible) {
          if (top < bestTop) {
            bestTop = top;
            best = id;
          }
        }
        // 带内无任何标题（滚过长段无标题正文）：保留最后 activeId，不清空（U5）——
        // 目录高亮保持最后位置，滚回标题带即恢复跟随
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
