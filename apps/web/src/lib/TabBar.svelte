<script lang="ts">
  import type { Tab } from './openFlow.svelte';
  import { activateTab, closeTab } from './openFlow.svelte';

  let { tabs }: { tabs: Tab[] } = $props();
</script>

<div class="vv-tabbar" role="tablist">
  {#each tabs as tab (tab.id)}
    <!-- 遗留 U2：激活区与关闭钮拆为兄弟节点——button 内不得再嵌 span[role=button]
         （嵌套交互元素违反 a11y 嵌套交互规则）。外层 div[role=tab][tabindex] 键盘可达，
         Enter/Space 激活需手动接线（ARIA APG 的 tab 键盘约定）；关闭钮为真实 button，
         Tab 可达、Enter 原生触发。 -->
    <div
      class="vv-tab"
      class:active={tab.active}
      role="tab"
      tabindex="0"
      aria-selected={tab.active}
      onclick={() => activateTab(tab.id)}
      onkeydown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          activateTab(tab.id);
        }
      }}>
      <span class="vv-tab-name">{tab.source.name}</span>
      <button
        type="button"
        class="vv-tab-close"
        aria-label="关闭 {tab.source.name}"
        onclick={(e) => {
          e.stopPropagation();
          closeTab(tab.id);
        }}>×</button>
    </div>
  {/each}
</div>
