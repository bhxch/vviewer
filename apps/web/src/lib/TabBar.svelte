<script lang="ts">
  import type { Tab } from './openFlow.svelte';
  import { activateTab, closeTab } from './openFlow.svelte';

  let { tabs }: { tabs: Tab[] } = $props();
</script>

<div class="vv-tabbar" role="tablist">
  {#each tabs as tab (tab.id)}
    <button
      class="vv-tab"
      class:active={tab.active}
      role="tab"
      aria-selected={tab.active}
      onclick={() => activateTab(tab.id)}>
      <span class="vv-tab-name">{tab.source.name}</span>
      <span
        class="vv-tab-close"
        role="button"
        tabindex={0}
        aria-label="关闭 {tab.source.name}"
        onclick={(e) => {
          e.stopPropagation();
          closeTab(tab.id);
        }}
        onkeydown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.stopPropagation();
            e.preventDefault();
            closeTab(tab.id);
          }
        }}>×</span>
    </button>
  {/each}
</div>
