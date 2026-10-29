<script lang="ts">
  // WorkspaceTabsPanel.svelte — tab 管理覆盖层面板（workspace T6）。AppShell 以 Alt+W /
  // TabBar「管理」按钮挂载（GlobalSearchPanel 的 {#if} 浮层模式）：
  //   搜索框按 tab 名称/路径 contains 大小写不敏感过滤 → 按 workspace 分组列表
  //   （活动组在前、组头 = 名称 + tab 数、可折叠）→ 行（名称/来源徽标/路径）点击
  //   激活（跨组先 setActive 再 activateTab——激活限组内必须先切组；激活后关面板）；
  //   行悬停出快捷关闭（stopPropagation，只关 tab 不切组）。空 workspace 显示
  //   来源数与添加引导文案。
  // 来源徽标只在多源 workspace（sources.length > 1）显示，且只给已登记来源的 tab
  // （openFiles 的单文件 tab 不登记来源、无徽标——名称即身份）；截短由 CSS
  // ellipsis 承担（title 全名），比首字母徽标信息量更高、实现更简。
  // 组尾「＋ 添加来源」：先 setActive(该组) 再展开来源区块——三个入口全部复用
  // openFlow 既有导出（openDirectoryViaPicker / openFiles / RemoteSourceModal→
  // openRemoteSource 均归当前活动组），无需 openFlow 新导出；OS 选择器为模态、
  // 打开期间无法切组，click 时锚定无落组竞态。
  // Esc/外点关闭仿 GlobalSearchPanel 双 handler（容器 keydown + window 兜底，
  // target 互斥不双触发）；外点关豁免带 data-vv-wspanel-trigger 的触发按钮
  // （TabBar「管理」自身 toggle——否则 pointerdown 先关、click 再切换，按钮永远关不上面板）。
  import {
    activateTab,
    closeTab,
    openDirectoryViaPicker,
    openFiles,
    tabStore,
    workspacesView,
    type Tab
  } from './openFlow.svelte';
  import { workspaceStore, type Workspace } from './workspaceStore';
  import RemoteSourceModal from './RemoteSourceModal.svelte';

  let { onclose }: { onclose(): void } = $props();

  let query = $state('');
  /** 组折叠状态（本地 UI 态；默认全展开） */
  let collapsed = $state<Record<string, boolean>>({});
  /** 「＋ 添加来源」展开中的 workspace id（null = 全部收起） */
  let addingFor = $state<string | null>(null);
  /** 后端路径浏览层（RemoteSourceModal 内嵌，WorkspaceCreateModal 同款视图切换） */
  let remoteBrowse = $state(false);
  let inputEl = $state<HTMLInputElement | null>(null);
  let fileInputEl = $state<HTMLInputElement | null>(null);
  let panelEl = $state<HTMLElement | null>(null);

  $effect(() => {
    inputEl?.focus();
  });

  /** 分组视图行：ws 组 + 过滤后的行 + 多源徽标表（单源组为空表 = 行省略徽标） */
  interface GroupView {
    ws: Workspace;
    rows: Tab[];
    badges: Map<string, string>;
  }

  /**
   * 分组派生：workspacesView（runes 镜像）× tabStore.tabsOf（list $state 过滤），
   * 两个读点都在派生内建立响应式依赖（关 tab / 切组 / 改名即时反映）。
   * 活动组排最前（其余保持登记顺序）；搜索时行按名称/路径 contains 过滤、
   * 无匹配的组整组隐藏（空态引导只在非搜索态出现）。
   */
  const groups = $derived.by(() => {
    const q = query.trim().toLowerCase();
    const activeFirst: Workspace[] = [];
    const rest: Workspace[] = [];
    for (const w of workspacesView.list) {
      (w.id === workspacesView.activeId ? activeFirst : rest).push(w);
    }
    const out: GroupView[] = [];
    for (const ws of [...activeFirst, ...rest]) {
      const all = tabStore.tabsOf(ws.id);
      const rows =
        q === ''
          ? all
          : all.filter(
              (t) =>
                t.source.name.toLowerCase().includes(q) || t.source.path.toLowerCase().includes(q)
            );
      if (q !== '' && rows.length === 0) continue;
      const badges = new Map<string, string>();
      if (ws.sources.length > 1) {
        for (const s of ws.sources) badges.set(s.storeId, s.storeLabel);
      }
      out.push({ ws, rows, badges });
    }
    return out;
  });

  /** 来源落组锚定：打开通道一律归当前活动组，先把目标组置活（幂等） */
  function anchor(ws: Workspace): void {
    if (workspaceStore.activeId !== ws.id) workspaceStore.setActive(ws.id);
  }

  function toggleCollapsed(id: string): void {
    collapsed[id] = !collapsed[id];
  }

  function toggleAdd(ws: Workspace): void {
    if (addingFor === ws.id) {
      addingFor = null;
      return;
    }
    anchor(ws);
    addingFor = ws.id;
  }

  function addFolder(ws: Workspace): void {
    anchor(ws);
    void openDirectoryViaPicker(); // 含 webkitdirectory 回退通道（openFlow 内部）
  }

  function addFiles(ws: Workspace): void {
    anchor(ws);
    fileInputEl?.click();
  }

  function onFilesPick(e: Event): void {
    const input = e.currentTarget as HTMLInputElement;
    if (input.files !== null && input.files.length > 0) openFiles([...input.files]);
    input.value = '';
  }

  function openRemote(ws: Workspace): void {
    anchor(ws);
    remoteBrowse = true;
  }

  /** 行点击激活：跨组先 setActive 再 activateTab（激活限组内，顺序不可倒）；
   * 激活后关面板回内容区（QuickOpen 的「选中即走」语义） */
  function activateRow(ws: Workspace, tab: Tab): void {
    anchor(ws);
    activateTab(tab.id);
    close();
  }

  $effect(() => {
    // Esc window 兜底（GlobalSearchPanel 模式）+ 外点关闭（TopBar 切换器同款
    // pointerdown 模式；触发按钮经 data-vv-wspanel-trigger 豁免，见文件头注释）
    const onWinKey = (e: KeyboardEvent): void => {
      if (
        e.key === 'Escape' &&
        panelEl !== null &&
        (e.target instanceof Node ? !panelEl.contains(e.target) : true)
      ) {
        e.preventDefault();
        close();
      }
    };
    const onDown = (e: PointerEvent): void => {
      const t = e.target as Node | null;
      if (t === null || panelEl === null) return;
      if (panelEl.contains(t)) return;
      if (t instanceof Element && t.closest('[data-vv-wspanel-trigger]') !== null) return;
      close();
    };
    window.addEventListener('keydown', onWinKey);
    document.addEventListener('pointerdown', onDown);
    return () => {
      window.removeEventListener('keydown', onWinKey);
      document.removeEventListener('pointerdown', onDown);
    };
  });

  function close(): void {
    // 关闭前记录焦点：面板卸载后还原（GlobalSearchPanel 同模式）
    const prev = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    onclose();
    setTimeout(() => {
      if (prev !== null && prev.isConnected) {
        prev.focus();
        return;
      }
      document.querySelector<HTMLElement>('.vv-viewer-host')?.focus();
    }, 0);
  }

  /** Esc 在面板内任意焦点均可关闭（keydown 绑容器，随冒泡覆盖子元素） */
  function onpanelkeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  }
</script>

<div class="vv-wspanel" role="dialog" aria-label="标签管理" tabindex="-1" bind:this={panelEl} onkeydown={onpanelkeydown}>
  {#if remoteBrowse}
    <!-- 后端路径浏览层：WorkspaceCreateModal 同款内嵌视图切换（RemoteSourceModal
         自带 Esc stopPropagation，不会连关本面板） -->
    <div class="vv-wspanel-remote">
      <RemoteSourceModal onclose={() => (remoteBrowse = false)} onpicked={() => (remoteBrowse = false)} />
    </div>
  {:else}
    <div class="vv-wspanel-search">
      <input
        bind:this={inputEl}
        bind:value={query}
        type="text"
        placeholder="按名称 / 路径过滤所有工作区的标签"
        aria-label="过滤标签"
        spellcheck="false"
      />
      <button type="button" aria-label="关闭标签管理" title="关闭（Esc）" onclick={close}>✕</button>
    </div>
    <div class="vv-wspanel-body">
      {#each groups as group (group.ws.id)}
        {@const isCollapsed = collapsed[group.ws.id] === true}
        <!-- 组头为原生 button（键盘可达）；aria-expanded 表达折叠态 -->
        <button
          type="button"
          class="vv-wspanel-group"
          class:active={group.ws.id === workspacesView.activeId}
          aria-expanded={!isCollapsed}
          onclick={() => toggleCollapsed(group.ws.id)}
        >
          <span class="vv-wspanel-caret">{isCollapsed ? '▸' : '▾'}</span>
          <span class="vv-wspanel-gname">{group.ws.name}</span>
          <span class="vv-wspanel-gcount">{group.rows.length}</span>
        </button>
        {#if !isCollapsed}
          {#each group.rows as tab (tab.id)}
            {@const badge = group.badges.get(tab.source.storeId) ?? null}
            <!-- 行为 div[role=button]（TabBar U2 同款：行内还有真实关闭 button，
                 外层不得再是 button——嵌套交互元素违规）；Enter/Space 激活手动接线 -->
            <div
              class="vv-wspanel-row"
              class:active={tab.active}
              role="button"
              tabindex="0"
              onclick={() => activateRow(group.ws, tab)}
              onkeydown={(e) => {
                // 快捷键只认行本身：Enter/Space 聚焦在行内关闭钮上时不得被行吞掉
                //（按钮原生触发 closeTab，行级 preventDefault 会截胡——T6 评审移交）
                if (e.target !== e.currentTarget) return;
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  activateRow(group.ws, tab);
                }
              }}
            >
              {#if tab.pinned === true}
                <!-- F 项 T3：pinned 徽标（spec 附件裁决最简形态：仅显示、无右键入口；
                     锁形字符与 TabBar .vv-tab-pinned 的 ::before 同源，样式零新增） -->
                <span class="vv-wspanel-pin" title="已固定">🔒</span>
              {/if}
              <span class="vv-wspanel-name">{tab.source.name}</span>
              {#if badge !== null}
                <span class="vv-wspanel-badge" title={badge}>{badge}</span>
              {/if}
              <span class="vv-wspanel-path">{tab.source.path === '' ? '（目录来源）' : tab.source.path}</span>
              <button
                type="button"
                class="vv-wspanel-close"
                aria-label="关闭 {tab.source.name}"
                onclick={(e) => {
                  e.stopPropagation(); // 快捷关闭不触发行激活/不切组
                  closeTab(tab.id);
                }}>✕</button>
            </div>
          {/each}
          {#if group.rows.length === 0}
            <div class="vv-wspanel-empty">
              暂无标签 · 已登记来源 {group.ws.sources.length} 个。用下方「＋ 添加来源」，或顶栏「打开文件 / 打开文件夹 / 连接服务器」添加。
            </div>
          {/if}
          <button type="button" class="vv-wspanel-addbtn" onclick={() => toggleAdd(group.ws)}>
            {addingFor === group.ws.id ? '收起来源入口' : '＋ 添加来源'}
          </button>
          {#if addingFor === group.ws.id}
            <div class="vv-wspanel-add">
              <button type="button" onclick={() => addFolder(group.ws)}>本地文件夹…</button>
              <button type="button" onclick={() => addFiles(group.ws)}>本地文件…</button>
              <button type="button" onclick={() => openRemote(group.ws)}>后端路径…</button>
            </div>
          {/if}
        {/if}
      {/each}
      {#if groups.length === 0}
        <div class="vv-wspanel-empty">无匹配标签</div>
      {/if}
    </div>
    <input type="file" multiple hidden bind:this={fileInputEl} onchange={onFilesPick} />
  {/if}
</div>

<style>
  /* G3 三面板行密度统一（设计系统 §4.3/§10-G3）：结果行 padding 统一 3px 10px。
     原 app.css 的 20px 左缩进由伪元素定宽占位承接（行 display:flex，text-indent
     不可用）——行 gap 8px，故伪元素宽 2px：10(padding) + 2(::before) + 8(gap) =
     20px，行内容起点与现状逐像素对位，零漂移。scoped 规则带哈希类，特异性
     (0,2,0) 压过 app.css 同名单类规则（公共层本组不编辑，见组交付 notes）。 */
  .vv-wspanel-row {
    padding: 3px 10px;
  }
  .vv-wspanel-row::before {
    content: '';
    flex: none;
    width: 2px;
  }
  /* 来源徽标 pill 化（§10-G3/§5.1：--vv-radius-full）+ 徽标字号随 chrome 字阶
     （§12.1 #27：--vv-fs-2xs，U=16px 时 11px 与现值等值） */
  .vv-wspanel-badge {
    border-radius: var(--vv-radius-full);
    font-size: var(--vv-fs-2xs);
  }
</style>
