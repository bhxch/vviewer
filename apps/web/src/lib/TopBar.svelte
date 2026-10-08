<script lang="ts">
  import { onMount } from 'svelte';
  import SettingsPanel from './SettingsPanel.svelte';
  import { openFiles, openDirectoryViaPicker, openUrl, connectServer, loadLastServer, tabStore } from './openFlow.svelte';
  import { loadSettings, saveSettings, onSettingsChanged, type Settings } from './stores/settings';
  import { applyCodeTheme, effectiveMode, onSystemModeChange, themeOptions } from './theme';

  let settings = $state<Settings>(loadSettings());
  let urlValue = $state('');
  let fileInput = $state<HTMLInputElement | null>(null);
  // 设置面板浮层开关（BUG-05）：⚙ 按钮挂载，Ctrl+comma 切换
  let settingsOpen = $state(false);
  // 主题表经动态 import 惰性加载（不进主 chunk），下拉选项挂载后异步填充
  let codeThemeOptions = $state<Awaited<ReturnType<typeof themeOptions>>>([]);

  // 连接服务器：内联展开表单（地址/token/连接/错误），不用对话框组件
  let serverOpen = $state(false);
  let serverUrl = $state('');
  let serverToken = $state('');
  let serverError = $state<string | null>(null);
  let connecting = $state(false);

  /** 当前生效亮暗（system 按 prefers-color-scheme 解析），决定下拉读写哪个记忆槽 */
  let mode = $derived(effectiveMode(settings.themeMode));
  let currentCodeTheme = $derived(mode === 'dark' ? settings.codeThemeDark : settings.codeThemeLight);

  function applyCurrentCodeTheme(): void {
    void applyCodeTheme(currentCodeTheme, mode);
  }

  onMount(() => {
    void themeOptions().then((opts) => (codeThemeOptions = opts));
    applyCurrentCodeTheme();
    // 订阅设置变更保持本副本最新：设置面板（SettingsPanel）改的排除/自动刷新，
    // 以及合并保存的其余字段，都同步回来——本组件后续 saveSettings(settings)
    // 写完整对象时不会把面板刚改的值写回旧值
    const offSettings = onSettingsChanged((s) => (settings = s));
    // themeMode=system：OS 亮暗切换时按新槽位重应用代码主题（UI 配色由
    // prefers-color-scheme 媒体查询自动跟随，JS 注入的代码主题变量需要这一步）
    const offSystem = onSystemModeChange((sysMode) => {
      if (settings.themeMode !== 'system') return;
      void applyCodeTheme(sysMode === 'dark' ? settings.codeThemeDark : settings.codeThemeLight, sysMode);
    });
    return () => {
      offSettings();
      offSystem();
    };
  });

  function cycleTheme(): void {
    const order: Settings['themeMode'][] = ['system', 'light', 'dark'];
    settings.themeMode = order[(order.indexOf(settings.themeMode) + 1) % 3]!;
    saveSettings(settings);
    // 'system' 模式的暗色由 app.css 的 @media prefers-color-scheme 处理，无需 JS
    document.documentElement.dataset.themeMode = settings.themeMode;
    // 亮暗切换联动：重应用对应记忆槽的代码主题（零重解析，只换 CSS 变量）
    applyCurrentCodeTheme();
  }

  function onCodeThemeChange(e: Event): void {
    const name = (e.currentTarget as HTMLSelectElement).value;
    if (mode === 'dark') settings.codeThemeDark = name;
    else settings.codeThemeLight = name;
    saveSettings(settings);
    void applyCodeTheme(name, mode);
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
  <select value={currentCodeTheme} onchange={onCodeThemeChange} aria-label="代码主题" title="代码主题">
    {#each codeThemeOptions as { group, themes } (group)}
      <optgroup label={group}>
        {#each themes as t (t)}
          <option value={t}>{t}</option>
        {/each}
      </optgroup>
    {/each}
  </select>
  <button onclick={() => (settingsOpen = !settingsOpen)} aria-label="设置" title="设置（Ctrl+,）：排除规则 / 自动刷新">
    ⚙
  </button>
</header>
{#if settingsOpen}
  <SettingsPanel onclose={() => (settingsOpen = false)} />
{/if}
