<script lang="ts">
  import { onMount } from 'svelte';
  import WorkspaceCreateModal from './WorkspaceCreateModal.svelte';
  import { closeTab, tabStore, workspacesView } from './openFlow.svelte';
  import { workspaceStore } from './workspaceStore';

  /** 工作区切换器（顶栏退役 spec Task 1 自 TopBar.svelte 内联块抽取的独立组件，
   * 顶栏退役第一步降耦；切换器本体源自 workspace 计划 T5）：无 props 自持全部
   * ws 逻辑——workspacesView/tabStore/closeTab（openFlow façade）与 workspaceStore
   * 直连，与 TopBar 原行为同源。DOM 契约逐字保留（e2e 锚，t-workspace/
   * b-wsx-recovery/b-layout-zen 等）：.vv-ws/.vv-ws-trigger/.vv-ws-pop(.narrow)/
   * .vv-ws-item/.vv-ws-name/.vv-ws-actions/.vv-ws-act/.vv-ws-rename/.vv-ws-new、
   * aria-label="切换工作区"、aria-expanded。样式零迁移：.vv-ws* 全段在 app.css
   * 全局（原 TopBar 内联块共用），组件无 <style>。新建模态（WorkspaceCreateModal）
   * 挂载随组件走：原 TopBar 末尾 {#if} 兄弟节点变为 header 内后代——落入
   * chrome-off（visibility:hidden）继承域由 app.css .vv-wscreate{visibility:
   * visible} 逃生门承接（该规则自本抽取起为实拦，非纯防御），fixed 包含块在
   * chrome-off 下的 translate 劫持面见 app.css 该段注释。≤600px（narrow）触发
   * 按钮收敛、下拉改同位 fixed 浮层：top 不再吃 app.css 硬编码 44px，打开时按
   * 触发按钮实际底缘内联计算（getBoundingClientRect().bottom + 4，与桌面
   * top:calc(100% + 4px) 同语义，顶栏换行/临时条形态下仍正确锚定）；桌面
   * absolute 定位零变化。 */
  let wsMenuOpen = $state(false);
  let createOpen = $state(false);
  let renamingId = $state<string | null>(null);
  let renameDraft = $state('');
  let wsAnchorEl = $state<HTMLElement | null>(null);
  let wsPopEl = $state<HTMLElement | null>(null);
  /** ≤600px 收进溢出：触发按钮收敛为图标、下拉改同位 fixed 浮层 */
  let narrow = $state(false);
  /** narrow 浮层内联 top（仅 narrow+打开时非空；桌面或关闭清空交还 app.css
   * absolute 语义——断点跨越时已开的下拉随重算无缝换轨） */
  let wsPopStyle = $state('');

  /** 当前 workspace（workspacesView 为 workspaceStore 的 runes 镜像） */
  const activeWorkspace = $derived(
    workspacesView.list.find((w) => w.id === workspacesView.activeId) ?? null
  );

  // ---------- workspace 切换器（T5） ----------

  function switchTo(id: string): void {
    workspaceStore.setActive(id);
    wsMenuOpen = false;
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
   * 一个自动建默认；删活动组时 remove 内部切到剩余组首）。 */
  function removeWorkspace(id: string, name: string): void {
    if (!window.confirm(`删除工作区「${name}」？将关闭其全部 tab。`)) return;
    for (const t of [...tabStore.tabsOf(id)]) closeTab(t.id);
    workspaceStore.remove(id);
    workspaceStore.ensureNonEmpty();
    if (renamingId === id) renamingId = null;
  }

  function openCreate(): void {
    wsMenuOpen = false;
    createOpen = true;
  }

  onMount(() => {
    // ≤600px 断点（spec E §2.3 切换器收进溢出）：matchMedia 驱动渲染分支；
    // 断点跨越时仅切换触发器形态，已展开的列表不强行收起
    const mq = window.matchMedia('(max-width: 600px)');
    const applyNarrow = (): void => {
      narrow = mq.matches;
    };
    applyNarrow();
    mq.addEventListener('change', applyNarrow);
    return () => {
      mq.removeEventListener('change', applyNarrow);
    };
  });

  $effect(() => {
    // narrow 浮层重锚（顶栏退役 Task 1，替代 app.css .vv-ws-pop.narrow 的
    // top:44px 硬编码）：打开且 narrow 时按触发按钮实际底缘 + 4px 间距内联计算。
    // effect 在 DOM 落定后运行，锚元素常驻挂载必在场；getBoundingClientRect 非
    // 响应式——打开瞬间计算一次，打开期间不追滚动/缩放（原 44px 亦静态，同档）
    if (!wsMenuOpen || !narrow) {
      wsPopStyle = '';
      return;
    }
    const anchor = wsAnchorEl;
    if (anchor === null) return;
    wsPopStyle = `top:${anchor.getBoundingClientRect().bottom + 4}px`;
  });

  $effect(() => {
    // 下拉外点关闭：pointerdown 落在触发按钮与浮层之外即收起（模态类浮层不做
    // 外点关——设置中心/全局搜索惯例，避免误触丢输入；仅菜单性浮层外点关）
    if (!wsMenuOpen) return;
    const onDown = (e: PointerEvent): void => {
      const t = e.target as Node | null;
      if (t === null) return;
      if (wsAnchorEl?.contains(t) === true || wsPopEl?.contains(t) === true) return;
      wsMenuOpen = false;
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  });

  $effect(() => {
    // Esc 关闭（GlobalSearchPanel 模式）：容器 keydown（.vv-ws-pop onkeydown，终审
    // I-2——此前仅 window 兜底，合成 Esc 的派发目标恰是 pop 本体被 contains 守卫
    // 挡下，移动端返回键 closeOverlay 空转成死循环；容器通道同时修复焦点在 pop 内
    // 时物理 Esc 无效的旧癖）覆盖浮层内焦点，window 兜底只处理 target 在浮层外的
    // 事件（同一事件只有一个 target，不会双触发）
    if (!wsMenuOpen) return;
    const onWinKey = (e: KeyboardEvent): void => {
      if (
        e.key === 'Escape' &&
        wsPopEl !== null &&
        (e.target instanceof Node ? !wsPopEl.contains(e.target) : true)
      ) {
        e.preventDefault();
        wsMenuOpen = false;
      }
    };
    window.addEventListener('keydown', onWinKey);
    return () => window.removeEventListener('keydown', onWinKey);
  });
</script>

<div class="vv-ws" bind:this={wsAnchorEl}>
  <button
    class="vv-ws-trigger"
    onclick={() => (wsMenuOpen = !wsMenuOpen)}
    aria-label="切换工作区"
    aria-expanded={wsMenuOpen}
    title="切换工作区（新建 / 重命名 / 删除）"
  >
    {narrow ? '工作区 ▾' : `${activeWorkspace?.name ?? '工作区'} ▾`}
  </button>
  {#if wsMenuOpen}
    <!-- 不用 role="menu"：条目均为原生 button（键盘可达），menu 角色反而要求
         tabindex/方向键管理（a11y_interactive_supports_focus 警告）；aria-expanded
         已在触发按钮上表达展开态 -->
    <!-- svelte-ignore a11y_no_static_element_interactions --><!-- 容器 Esc 同仓库
         dialog keydown 模式（设置中心/GlobalSearchPanel 等）：合成 Esc（移动端返回键
         closeTopOverlayForZen 派发）与浮层内焦点物理 Esc 的统一关闭通道。
         oncontextmenu（TabBarActions / TabContextMenu 同款）：浮层为 .vv-tabbar 后代，
         壳层 onShellContextMenu 会把右键条目当 tabbar 空白叠开 chrome 菜单——
         stopPropagation 截断冒泡；preventDefault 只对非输入元素（重命名框保留原生
         粘贴菜单，AppShell 同款守卫） -->
    <div
      class="vv-ws-pop"
      class:narrow
      style={wsPopStyle}
      bind:this={wsPopEl}
      oncontextmenu={(e) => {
        e.stopPropagation();
        if ((e.target as HTMLElement).closest('input, textarea, select') === null) e.preventDefault();
      }}
      onkeydown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          wsMenuOpen = false;
        }
      }}
    >
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
              aria-label="重命名工作区"
              spellcheck="false"
              onkeydown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault();
                  e.stopPropagation();
                  cancelRename();
                }
              }}
            />
            <button type="submit" aria-label="确认重命名" title="确认（Enter）">✓</button>
            <button type="button" aria-label="取消重命名" title="取消（Esc）" onclick={cancelRename}>✕</button>
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
                aria-label="重命名工作区 {w.name}"
                title="重命名"
                onclick={() => startRename(w.id, w.name)}>✎</button
              >
              <button
                type="button"
                class="vv-ws-act"
                aria-label="删除工作区 {w.name}"
                title="删除（将关闭其全部 tab）"
                onclick={() => removeWorkspace(w.id, w.name)}>✕</button
              >
            </span>
          </div>
        {/if}
      {/each}
      <button type="button" class="vv-ws-new" onclick={openCreate}>＋ 新建工作区…</button>
    </div>
  {/if}
</div>
{#if createOpen}
  <WorkspaceCreateModal onclose={() => (createOpen = false)} />
{/if}
