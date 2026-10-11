<script lang="ts">
  import type { Tab } from './openFlow.svelte';
  import type { WorkspaceSource } from './workspaceStore';
  import { activateTab, closeTab } from './openFlow.svelte';

  /**
   * tabs：AppShell 传当前 workspace 组内过滤值（tabStore.tabsOf(activeId)，T6）——
   * TabBar 只渲染本组标签，跨组总览/触达走「管理」面板。sources：当前组已登记
   * 来源（模型）；onmanage：右端「管理」按钮回调（AppShell 切换面板）。
   */
  let {
    tabs,
    sources,
    onmanage
  }: { tabs: Tab[]; sources: WorkspaceSource[]; onmanage(): void } = $props();

  /** 行内来源徽标（T6）：仅多源 workspace 显示（单源省略），且只给已登记来源的
   * tab——openFiles 的单文件 tab 不登记来源，无徽标（名称即身份）。 */
  function badgeOf(tab: Tab): string | null {
    if (sources.length < 2) return null;
    return sources.find((s) => s.storeId === tab.source.storeId)?.storeLabel ?? null;
  }
</script>

<div class="vv-tabbar" role="tablist">
  {#each tabs as tab (tab.id)}
    {@const badge = badgeOf(tab)}
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
        // 快捷键只认行本身：Enter/Space 聚焦在行内关闭钮上时不得被行吞掉
        //（按钮原生触发 closeTab，行级 preventDefault 会截胡——T6 评审移交）
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          activateTab(tab.id);
        }
      }}>
      <span class="vv-tab-name">{tab.source.name}</span>
      {#if badge !== null}
        <!-- 来源徽标（多源 workspace 才显示）：截短由 CSS ellipsis 承担，title 全名 -->
        <span class="vv-tab-src" title={badge}>{badge}</span>
      {/if}
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
  <!-- T6：tab 管理面板入口。data-vv-wspanel-trigger 供面板外点关闭豁免
       （pointerdown 先关 + click 切换会打架，见 WorkspaceTabsPanel 头注释） -->
  <button
    type="button"
    class="vv-tabbar-manage"
    data-vv-wspanel-trigger
    aria-label="管理标签"
    title="管理所有工作区的标签（Alt+W）"
    onclick={onmanage}>管理</button>
</div>
