<script lang="ts">
  import type { Tab } from './openFlow.svelte';
  import type { WorkspaceSource } from './workspaceStore';
  import { activateTab, closeTab, closedStackSize, reopenClosed, tabStore } from './openFlow.svelte';
  import { reorderIds } from './tabOrder';
  import TabContextMenu, { type TabCtxAction } from './TabContextMenu.svelte';

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

  // ---------- F 项 T2：右键菜单 / 中键关闭 / 拖拽重排 / pinned 态 ----------

  /** 右键菜单态：目标 tab + 触发视口坐标（null = 关）。actions 每次开菜单重新组装。 */
  let ctx = $state<{ x: number; y: number; tab: Tab } | null>(null);

  function openMenu(e: MouseEvent, tab: Tab): void {
    e.preventDefault(); // 阻止浏览器默认菜单，自绘浮层取而代之
    ctx = { x: e.clientX, y: e.clientY, tab };
  }

  /**
   * 菜单六动作组装（随菜单开合经 $derived 重算）：置灰态按 spec §2.2——
   * 「关闭右侧」按「右侧无普通 tab」判定、「复制标签页」unrestorable、「重新打开
   * 已关闭标签」撤销栈空（调用时查询：菜单每次打开重组即拿到最新栈深，无需响应式）；
   * pinned 动态换「固定 / 取消固定」标签。
   */
  const ctxActions: TabCtxAction[] = $derived.by(() => {
    if (ctx === null) return [];
    const tab = ctx.tab;
    const at = tabs.findIndex((t) => t.id === tab.id);
    const normalRight = at >= 0 ? tabs.slice(at + 1).filter((t) => !t.pinned).length : 0;
    return [
      { label: '关闭', onClick: () => tabStore.close(tab.id) },
      { label: '关闭其他', onClick: () => tabStore.closeOthers(tab.id) },
      { label: '关闭右侧', disabled: normalRight === 0, onClick: () => tabStore.closeRight(tab.id) },
      tab.pinned === true
        ? { label: '取消固定', onClick: () => tabStore.unpin(tab.id) }
        : { label: '固定', onClick: () => tabStore.pin(tab.id) },
      {
        label: '复制标签页',
        disabled: tab.unrestorable === true,
        onClick: () => tabStore.duplicate(tab.id)
      },
      {
        label: '重新打开已关闭标签',
        disabled: closedStackSize() === 0,
        onClick: () => reopenClosed()
      }
    ];
  });

  /** 中键关闭（spec §1 决策表：auxclick button 1）——closeTab 默认 undoable，入撤销栈。 */
  function onaux(e: MouseEvent, tab: Tab): void {
    if (e.button !== 1) return; // auxclick 对所有非主键派发（右键在此放过，走 contextmenu）
    e.preventDefault(); // 防默认行为（brief：防中键滚动）
    closeTab(tab.id);
  }

  // 拖拽源 id（组件变量而非 dataTransfer 读回：dragover/drop 与 dragstart 同处本组件，
  // 直接持有更简；dataTransfer 仅按 Firefox 要求写入占位数据启动 drag）。
  let dragFromId: string | null = null;
  /** 拖拽落点指示（渲染 .vv-tab-dragover 与前后沿内嵌线）：仅受理落点会置值。 */
  let dragOver = $state<{ id: string; before: boolean } | null>(null);

  function ondragstart(e: DragEvent, tab: Tab): void {
    dragFromId = tab.id;
    const dt = e.dataTransfer;
    if (dt === null) return;
    dt.setData('text/plain', tab.id); // Firefox：空 dataTransfer 不启动 drag
    dt.effectAllowed = 'move';
  }

  /**
   * 落点是否被拒：直接用 tabOrder.reorderIds 纯函数判定（与 drop 时 dragReorder 同一
   * 数学，不复制 pinned 边界条件）——普通 tab 插入 pinned 区内 / pinned tab 越区尾 /
   * 拖回自身 → 拒，dragover 显示禁止光标且不置落点指示。
   */
  function dropRejected(tab: Tab, before: boolean): boolean {
    if (dragFromId === null) return true;
    return (
      reorderIds(
        tabs.map((t) => t.id),
        dragFromId,
        tab.id,
        before,
        new Set(tabs.filter((t) => t.pinned).map((t) => t.id))
      ) === null
    );
  }

  function ondragover(e: DragEvent, tab: Tab): void {
    if (dragFromId === null) return;
    e.preventDefault(); // 允许 drop（HTML5 dnd 默认 = 禁止）
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const before = e.clientX < rect.left + rect.width / 2; // 中点前 = 插到目标之前
    if (dropRejected(tab, before)) {
      if (e.dataTransfer !== null) e.dataTransfer.dropEffect = 'none'; // 禁止光标
      dragOver = null;
      return;
    }
    if (e.dataTransfer !== null) e.dataTransfer.dropEffect = 'move';
    dragOver = { id: tab.id, before };
  }

  function ondragleave(e: DragEvent, tab: Tab): void {
    // 行内子元素间移动同样触发 dragleave：落点还在本行内则不清指示
    const to = e.relatedTarget;
    if (to instanceof Node && (e.currentTarget as HTMLElement).contains(to)) return;
    if (dragOver?.id === tab.id) dragOver = null;
  }

  function ondrop(e: DragEvent, tab: Tab): void {
    e.preventDefault();
    const from = dragFromId;
    const over = dragOver;
    dragFromId = null;
    dragOver = null;
    if (from === null || over === null || over.id !== tab.id) return;
    // 受理性已在 dragover 用同一数学判定（拒收落点 dragOver 已置 null，不会到达这里）；
    // dragReorder 对越界返回 false 不动作，双保险
    tabStore.dragReorder(from, tab.id, over.before);
  }

  function ondragend(): void {
    // drop 成功 / 拖出取消 / Esc 释放统一清理（drop 内也清一次，防个别宿主缺 dragend）
    dragFromId = null;
    dragOver = null;
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
      class:vv-tab-pinned={tab.pinned === true}
      data-pinned={tab.pinned === true ? 'true' : undefined}
      class:vv-tab-dragover={dragOver?.id === tab.id}
      data-drop-before={dragOver?.id === tab.id ? String(dragOver.before) : undefined}
      role="tab"
      tabindex="0"
      aria-selected={tab.active}
      draggable="true"
      onclick={() => activateTab(tab.id)}
      oncontextmenu={(e) => openMenu(e, tab)}
      onauxclick={(e) => onaux(e, tab)}
      onmousedown={(e) => {
        // 中键自动滚动由 mousedown 默认行为启动（auxclick 的 preventDefault 已迟）——
        // 仅拦中键，左键默认（聚焦/文本选择）不动；auxclick 仍照常派发，关闭在其上接线
        if (e.button === 1) e.preventDefault();
      }}
      ondragstart={(e) => ondragstart(e, tab)}
      ondragover={(e) => ondragover(e, tab)}
      ondragleave={(e) => ondragleave(e, tab)}
      ondrop={(e) => ondrop(e, tab)}
      ondragend={ondragend}
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
  {#if ctx !== null}
    <!-- 右键菜单浮层（fixed 定位不随 tabbar 横向滚动；关闭路径收敛在组件内） -->
    <TabContextMenu
      x={ctx.x}
      y={ctx.y}
      tab={ctx.tab}
      actions={ctxActions}
      onclose={() => (ctx = null)}
    />
  {/if}
</div>
