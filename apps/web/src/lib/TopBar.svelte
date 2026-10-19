<script lang="ts">
  import { onMount } from 'svelte';
  import SettingsPanel from './SettingsPanel.svelte';
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
  import { applyAppearanceFromSettings, applyFontsFromSettings, onSystemModeChange, themeOptions } from './theme';
  import { reactToFontsChange } from './fontsReaction';

  let settings = $state<Settings>(loadSettings());
  let urlValue = $state('');
  let fileInput = $state<HTMLInputElement | null>(null);
  // 设置面板浮层开关（BUG-05）：⚙ 按钮挂载，Ctrl+comma 切换
  let settingsOpen = $state(false);
  // workspace 切换器（T5）：下拉开关 + 新建模态挂载 + 行内重命名草稿
  let wsMenuOpen = $state(false);
  let createOpen = $state(false);
  let renamingId = $state<string | null>(null);
  let renameDraft = $state('');
  let wsAnchorEl = $state<HTMLElement | null>(null);
  let wsPopEl = $state<HTMLElement | null>(null);
  /** ≤600px 收进溢出：触发按钮收敛为图标、下拉改 SettingsPanel 同位 fixed 浮层 */
  let narrow = $state(false);
  // 主题表经动态 import 惰性加载（不进主 chunk），下拉选项挂载后异步填充
  let codeThemeOptions = $state<Awaited<ReturnType<typeof themeOptions>>>([]);

  // 连接服务器：内联展开表单（地址/token/连接/错误），不用对话框组件
  let serverOpen = $state(false);
  let serverUrl = $state('');
  let serverToken = $state('');
  let serverError = $state<string | null>(null);
  let connecting = $state(false);

  /** OS 亮暗响应式镜像（BUG-49）：matchMedia 非响应式信号，effectiveMode 每次实时读
   * matchMedia 但 OS 切换不触发重算——以 change 事件写入 $state 闭合 mode 的依赖链。 */
  let osDark = $state(
    typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches
  );
  /** 当前生效亮暗（system 按 prefers-color-scheme 解析），决定下拉读写哪个记忆槽。
   * 不直调 effectiveMode（内部 matchMedia 读非响应式，OS 切换后 mode 陈旧——BUG-49）；
   * 无 matchMedia 环境（jsdom/SSR）osDark 初值 false → 回落 light，与 effectiveMode 同口径。 */
  let mode = $derived(
    settings.themeMode === 'system' ? (osDark ? 'dark' : 'light') : settings.themeMode
  );
  let currentCodeTheme = $derived(mode === 'dark' ? settings.codeThemeDark : settings.codeThemeLight);
  let currentAppearance = $derived(mode === 'dark' ? settings.appearanceDark : settings.appearanceLight);
  /** 外观接管（spec B §2.3）：当前 mode 槽非 default 时代码配色由外观 tokenColors 决定 */
  let appearanceTakesOver = $derived(currentAppearance !== 'default');

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
    void themeOptions().then((opts) => (codeThemeOptions = opts));
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
    // themeMode=system：OS 亮暗切换不经 saveSettings，effectiveMode 随之变化命中
    // diff（UI 配色由 prefers-color-scheme 媒体查询自动跟随，JS 注入变量需要这步）
    const offSystem = onSystemModeChange((m) => {
      osDark = m === 'dark'; // BUG-49：同步响应式镜像，mode 的 derived 随 OS 切换重算
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
    // 外点关——SettingsPanel 惯例，避免误触丢输入；仅菜单性浮层外点关）
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
    // Esc 关闭（GlobalSearchPanel 模式）：容器 keydown 覆盖面板内焦点，window
    // 兜底只处理 target 在浮层外的事件（同一事件只有一个 target，不会双触发）
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

  function onCodeThemeChange(e: Event): void {
    const name = (e.currentTarget as HTMLSelectElement).value;
    if (mode === 'dark') settings.codeThemeDark = name;
    else settings.codeThemeLight = name;
    saveSettings(settings); // 注入由订阅 diff（codeTheme 变化）触发，此处不直调
  }

  /** 计算策略三态（M6）：下次高亮/渲染调用即生效（router 每次实时读 settings） */
  function onComputePolicyChange(e: Event): void {
    const v = (e.currentTarget as HTMLSelectElement).value;
    if (v === 'auto' || v === 'local' || v === 'remote') settings.computePolicy = v;
    saveSettings(settings);
  }

  function onPick(e: Event): void {
    const input = e.currentTarget as HTMLInputElement;
    if (input.files) openFiles([...input.files]);
    input.value = '';
  }

  /**
   * 手动刷新（BUG-05，SRV-07）：复用 SSE 的 refreshPaths 通道（rev++ 驱动重读）。
   * 活动为文件 tab 时 [path] 同时刷新该文件与目录树（refreshPaths 对目录 tab
   * 恒自增）；活动为目录 tab 时空 paths 刷新整个 store。不受 autoRefresh 开关
   * 限制（开关只过滤 SSE 推送，手动刷新语义即用户显式要求）。
   */
  function manualRefresh(): void {
    const t = tabStore.list.find((x) => x.active);
    if (!t) return;
    tabStore.refreshPaths(t.source.storeId, t.source.path === '' ? [] : [t.source.path]);
  }

  // Ctrl+comma 切换设置面板（BUG-05）：非输入焦点时才接管——与 Ctrl+Shift+F 的
  // inField 判定同惯例
  $effect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key === ',')) return;
      const t = e.target as HTMLElement | null;
      const inField =
        t !== null &&
        (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
      if (inField) return;
      e.preventDefault();
      settingsOpen = !settingsOpen;
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

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

<header class="vv-topbar">
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
      <div class="vv-ws-pop" class:narrow bind:this={wsPopEl}>
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
  <select
    value={settings.computePolicy}
    onchange={onComputePolicyChange}
    aria-label="计算策略"
    title="计算策略：决定高亮等计算在本地还是服务器执行"
  >
    <option value="auto">计算: 自动</option>
    <option value="local">计算: 本地</option>
    <option value="remote">计算: 远程</option>
  </select>
  <select
    value={currentCodeTheme}
    onchange={onCodeThemeChange}
    aria-label="代码主题"
    title={appearanceTakesOver ? '由外观主题接管（设置面板界面主题区选回「默认」后可换）' : '代码主题'}
    disabled={appearanceTakesOver}
  >
    {#each codeThemeOptions as { group, themes } (group)}
      <optgroup label={group}>
        {#each themes as t (t)}
          <option value={t}>{t}</option>
        {/each}
      </optgroup>
    {/each}
  </select>
  <button onclick={() => (settingsOpen = !settingsOpen)} aria-label="设置" title="设置（Ctrl+,）：排除规则 / 自动刷新 / 界面主题">
    ⚙
  </button>
</header>
{#if settingsOpen}
  <SettingsPanel onclose={() => (settingsOpen = false)} />
{/if}
{#if createOpen}
  <WorkspaceCreateModal onclose={() => (createOpen = false)} />
{/if}
