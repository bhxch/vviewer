<script lang="ts">
  // WorkspaceList.svelte — 融合菜单「工作区」子菜单体（标签栏收敛 Task 1 自
  // WorkspaceSwitcher 列表体 :180-233 抽取）：列表 + 行内重命名（✎/Enter/✓/✕）
  // + ✕ 删除（confirm）+ ＋新建入口。ws 状态自持（workspacesView/tabStore/
  // closeTab 经 openFlow façade 与 workspaceStore 直连，原切换器同源，无数据面
  // props）；仅两个回调上交宿主 TabBarMenu——onclose（选中即关，原 switchTo 内
  // wsMenuOpen=false 同语义）与 oncreate（新建：先关菜单再开模态）——浮层
  // menuOpen 所有权在菜单浮层，本组件不持开合状态。列表条目类名零变更
  // （.vv-ws-item/.vv-ws-name/.vv-ws-actions/.vv-ws-act/.vv-ws-rename/.vv-ws-new，
  // e2e 锚红线，t-workspace/b-wsx-recovery 消费）；删除 confirm 文案逐字沿用。
  // WorkspaceCreateModal 挂载归 TabBarMenu 组件体（浮层 {#if} 之外）：本组件随
  // 子菜单区渲染在浮层 {#if} 内，「新建先关菜单」会卸载浮层连带本组件——模态
  // 若挂这里即被连带带走（spec §3.1 模态须在浮层 {#if} 之外的落位约束，挂点
  // 随单浮层架构上移宿主，语义不变）。重命名 input Esc stopPropagation 语义
  // 保留：仅取消重命名不关菜单（冒泡在 input handler 截断，浮层容器 Esc 通道
  // 收不到）。无触发钮/narrow mq/wsPopStyle 重锚/独立外点与 window Esc effect
  //（关闭通道全部归 TabBarMenu 浮层）。
  import { closeTab, tabStore, workspacesView } from './openFlow.svelte';
  import { workspaceStore } from './workspaceStore';
  // i18n（Task 4 域 A 抽取）：工作区子菜单文案入 tabs.ws.* 目录
  import { t } from './i18n/index.svelte';

  let { onclose, oncreate }: { onclose(): void; oncreate(): void } = $props();

  let renamingId = $state<string | null>(null);
  let renameDraft = $state('');

  // ---------- workspace 列表交互（T5 迁入，行为逐字） ----------

  function switchTo(id: string): void {
    workspaceStore.setActive(id);
    onclose(); // 选中即关（原 switchTo 内 wsMenuOpen=false 同语义，通道在宿主浮层）
  }

  function startRename(id: string, current: string): void {
    renamingId = id;
    renameDraft = current;
  }

  function commitRename(): void {
    if (renamingId !== null) {
      const v = renameDraft.trim();
      if (v !== '') workspaceStore.rename(renamingId, v);
    }
    renamingId = null;
  }

  function cancelRename(): void {
    renamingId = null;
  }

  /** 删除工作区：confirm → 关闭其全部 tab → remove（ensureNonEmpty 兜底，删最后
   * 一个自动建默认；删活动组时 remove 内部切到剩余组首）。菜单保持展开（原
   * removeWorkspace 不复位 wsMenuOpen 同语义，t-tab-actions TA 用例依赖）。 */
  function removeWorkspace(id: string, name: string): void {
    if (!window.confirm(t('tabs.ws.deleteConfirm', { name }))) return;
    for (const t of [...tabStore.tabsOf(id)]) closeTab(t.id);
    workspaceStore.remove(id);
    workspaceStore.ensureNonEmpty();
    if (renamingId === id) renamingId = null;
  }
</script>

{#each workspacesView.list as w (w.id)}
  {#if renamingId === w.id}
    <form
      class="vv-ws-rename"
      onsubmit={(e) => {
        e.preventDefault();
        commitRename();
      }}
    >
      <input
        bind:value={renameDraft}
        aria-label={t('tabs.ws.renameAria')}
        spellcheck="false"
        onkeydown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation(); // 仅取消重命名，不关菜单（浮层容器 Esc 通道收不到）
            cancelRename();
          }
        }}
      />
      <button type="submit" aria-label={t('tabs.ws.renameConfirmAria')} title={t('tabs.ws.renameConfirmTitle')}>✓</button>
      <button type="button" aria-label={t('tabs.ws.renameCancelAria')} title={t('tabs.ws.renameCancelTitle')} onclick={cancelRename}>✕</button>
    </form>
  {:else}
    <div class="vv-ws-item" class:active={w.id === workspacesView.activeId}>
      <button type="button" class="vv-ws-name" title={w.name} onclick={() => switchTo(w.id)}>
        {w.name}
      </button>
      <span class="vv-ws-actions">
        <button
          type="button"
          class="vv-ws-act"
          aria-label={t('tabs.ws.renameItemAria', { name: w.name })}
          title={t('tabs.ws.renameItemTitle')}
          onclick={() => startRename(w.id, w.name)}>✎</button
        >
        <button
          type="button"
          class="vv-ws-act"
          aria-label={t('tabs.ws.deleteItemAria', { name: w.name })}
          title={t('tabs.ws.deleteItemTitle')}
          onclick={() => removeWorkspace(w.id, w.name)}>✕</button
        >
      </span>
    </div>
  {/if}
{/each}
<!-- ＋ 新建工作区…：先关菜单再开模态（openCreate 原语义拆两步——关在宿主浮层
     oncreate 通道内一并完成，模态挂 TabBarMenu 组件体） -->
<button type="button" class="vv-ws-new" onclick={oncreate}>{t('tabs.ws.create')}</button>
