<script lang="ts">
  import { onMount } from 'svelte';
  import WorkspaceCreateModal from './WorkspaceCreateModal.svelte';
  import {
    openFiles,
    openDirectoryViaPicker,
    openUrl,
    connectServer,
    loadLastServer,
    closeTab,
    tabStore,
    workspacesView
  } from './openFlow.svelte';
  import { workspaceStore } from './workspaceStore';
  import { loadSettings, saveSettings, onSettingsChanged, type Settings } from './stores/settings';
  import { applyAppearanceFromSettings, applyFontsFromSettings, onSystemModeChange } from './theme';
  import { reactToFontsChange } from './fontsReaction';

  /** chrome 隐藏/临时条形态（spec 2026-10-19 §2/§3，AppShell 传值）：hidden=移出
   * 视口的隐藏态（组件保持挂载，设置中心入口回调 onsettings 不失效）；temp=边缘
   * 悬停唤出的半透条。onenter/onleave 供 AppShell 做「重入取消隐藏定时/移开 1.5s
   * 再隐」——组件不持有 layout 状态（所有权在 AppShell）。设置中心（⚙/Ctrl+,，
   * spec 2026-10-19 设置中心 §2）与目录管理页（📁/Ctrl+Alt+M，目录挂载 spec §5
   * 阶段四）开关状态归 AppShell，本组件只发回调。 */
  let {
    temp = false,
    hidden = false,
    onenter,
    onleave,
    onsettings,
    onmounts
  }: {
    temp?: boolean;
    hidden?: boolean;
    onenter?: () => void;
    onleave?: () => void;
    onsettings(): void;
    onmounts(): void;
  } = $props();
  let urlValue = $state('');
  let fileInput = $state<HTMLInputElement | null>(null);
  // workspace 切换器（T5）：下拉开关 + 新建模态挂载 + 行内重命名草稿
  let wsMenuOpen = $state(false);
  let createOpen = $state(false);
  let renamingId = $state<string | null>(null);
  let renameDraft = $state('');
  let wsAnchorEl = $state<HTMLElement | null>(null);
  let wsPopEl = $state<HTMLElement | null>(null);
  /** ≤600px 收进溢出：触发按钮收敛为图标、下拉改同位 fixed 浮层 */
  let narrow = $state(false);
  let settings = $state<Settings>(loadSettings());

  // 连接服务器：内联展开表单（地址/token/连接/错误），不用对话框组件
  let serverOpen = $state(false);
  let serverUrl = $state('');
  let serverToken = $state('');
  let serverError = $state<string | null>(null);
  let connecting = $state(false);

  /** OS 亮暗响应式镜像（BUG-49）：matchMedia 非响应式信号——OS 切换时经
   * onSystemModeChange 订阅在 themeMode=system 下补一发注入（UI 配色由
   * prefers-color-scheme 媒体查询自动跟随，JS 注入变量需要这步）。高亮配色槽位
   * 读写已迁设置中心外观节（AppearanceSection 自带同款镜像）。 */

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
    applyAppearanceFromSettings(settings); // 首次注入：签名初值 null 必命中
    applyFontsFromSettings(settings); // 首次字体注入（style#vv-font；返回值忽略——挂载期无活动渲染实例）
    // 订阅设置变更保持本副本最新（防本组件 saveSettings 写回旧值），同时作为
    // 注入的唯一触发通道：diff 四元组、槽相关变化才注入（spec 2026-10-12 §2.4）
    const offSettings = onSettingsChanged((s) => {
      settings = s;
      applyAppearanceFromSettings(s);
      // fonts 变更 → style#vv-font 重注入 + 激活 tab rev++ 重渲染（行高联动，
      // 字体系统 spec §2.3/§3，Task 2；无关字段变化零触发）
      reactToFontsChange(s, () => tabStore.touchActiveTab());
    });
    // themeMode=system：OS 亮暗切换不经 saveSettings（BUG-49，见上注释）
    const offSystem = onSystemModeChange(() => {
      if (settings.themeMode !== 'system') return;
      applyAppearanceFromSettings(settings);
    });
    // ≤600px 断点（spec E §2.3 切换器收进溢出）：matchMedia 驱动渲染分支；
    // 断点跨越时仅切换触发器形态，已展开的列表不强行收起
    const mq = window.matchMedia('(max-width: 600px)');
    const applyNarrow = (): void => {
      narrow = mq.matches;
    };
    applyNarrow();
    mq.addEventListener('change', applyNarrow);
    return () => {
      offSettings();
      offSystem();
      mq.removeEventListener('change', applyNarrow);
    };
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

  function cycleTheme(): void {
    const order: Settings['themeMode'][] = ['system', 'light', 'dark'];
    settings.themeMode = order[(order.indexOf(settings.themeMode) + 1) % 3]!;
    saveSettings(settings);
    // 'system' 模式的暗色由 app.css 的 @media prefers-color-scheme 处理，无需 JS
    document.documentElement.dataset.themeMode = settings.themeMode;
    // 注入不在此直调：saveSettings → onSettingsChanged 订阅 → effectiveMode
    // 变化命中 diff（spec 2026-10-12 §2.4）
  }

  function onPick(e: Event): void {
    const input = e.currentTarget as HTMLInputElement;
    if (input.files) openFiles([...input.files]);
    input.value = '';
  }

  /** 手动刷新（BUG-05，SRV-07）：复用 SSE 的 refreshPaths 通道（rev++ 驱动重读）。
   * 活动为文件 tab 时 [path] 同时刷新该文件与目录树（refreshPaths 对目录 tab
   * 恒自增）；活动为目录 tab 时空 paths 刷新整个 store。不受 autoRefresh 开关
   * 限制（开关只过滤 SSE 推送，手动刷新语义即用户显式要求）。 */
  function manualRefresh(): void {
    const t = tabStore.list.find((x) => x.active);
    if (!t) return;
    tabStore.refreshPaths(t.source.storeId, t.source.path === '' ? [] : [t.source.path]);
  }

  function submit(e: SubmitEvent): void {
    e.preventDefault();
    const url = urlValue.trim();
    if (url) {
      openUrl(url);
      urlValue = '';
    }
  }

  function toggleServerPanel(): void {
    serverOpen = !serverOpen;
    serverError = null;
    // 展开时用会话内上次成功连接的服务器预填（本期不做自动重连）
    if (serverOpen && serverUrl === '') {
      const last = loadLastServer();
      if (last) {
        serverUrl = last.baseUrl;
        serverToken = last.token ?? '';
      }
    }
  }

  async function connect(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    if (connecting) return;
    const url = serverUrl.trim();
    if (!url) {
      serverError = '请输入服务器地址';
      return;
    }
    connecting = true;
    serverError = null;
    try {
      await connectServer(url, serverToken.trim() === '' ? null : serverToken.trim());
      serverOpen = false;
      serverUrl = '';
      serverToken = '';
    } catch (err) {
      serverError = err instanceof Error ? err.message : String(err);
    } finally {
      connecting = false;
    }
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions --><!-- pointerenter/leave 是
     视觉唤出通道（临时条），无 AT 语义，header 不宜加交互角色 -->
<header
  class="vv-topbar"
  class:vv-chrome-temp={temp}
  class:vv-chrome-off={hidden}
  onpointerenter={() => onenter?.()}
  onpointerleave={() => onleave?.()}
>
  <span class="vv-brand">vviewer</span>
  <button onclick={() => fileInput?.click()}>打开文件</button>
  <input type="file" multiple hidden bind:this={fileInput} onchange={onPick} />
  <button onclick={() => void openDirectoryViaPicker()}>打开文件夹</button>
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
           closeTopOverlayForZen 派发）与浮层内焦点物理 Esc 的统一关闭通道 -->
      <div
        class="vv-ws-pop"
        class:narrow
        bind:this={wsPopEl}
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
  <form onsubmit={submit}>
    <input placeholder="粘贴文件 URL" bind:value={urlValue} aria-label="文件 URL" />
  </form>
  <button onclick={toggleServerPanel}>连接服务器</button>
  <button onclick={manualRefresh} aria-label="刷新当前文件" title="手动刷新当前文件与目录树（快捷键 Ctrl+, 打开设置可关自动刷新）">↻</button>
  {#if serverOpen}
    <form class="vv-server-form" onsubmit={connect}>
      <input
        placeholder="http://127.0.0.1:8321"
        bind:value={serverUrl}
        aria-label="服务器地址"
        spellcheck="false"
      />
      <input
        type="password"
        placeholder="访问令牌（可空）"
        bind:value={serverToken}
        aria-label="访问令牌"
      />
      <button type="submit" disabled={connecting}>{connecting ? '连接中…' : '连接'}</button>
      {#if serverError}
        <span class="vv-server-error" role="alert">{serverError}</span>
      {/if}
    </form>
  {/if}
  <button onclick={cycleTheme}>
    主题：{settings.themeMode === 'system' ? '跟随系统' : settings.themeMode === 'light' ? '亮' : '暗'}
  </button>
  <button onclick={onsettings} aria-label="设置" title="设置（Ctrl+,）：外观 / 字体 / 图表 / 搜索与排除 / 自动刷新 / 计算">
    ⚙
  </button>
  <button
    onclick={onmounts}
    aria-label="目录管理"
    title="目录管理（Ctrl+Alt+M）：服务端挂载 / 前端直连与代理 / 本机授权"
  >
    📁
  </button>
</header>
{#if createOpen}
  <WorkspaceCreateModal onclose={() => (createOpen = false)} />
{/if}
