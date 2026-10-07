<script lang="ts">
  import { onMount } from 'svelte';
import { openFiles, openDirectoryViaPicker, openUrl, connectServer, loadLastServer } from './openFlow.svelte';
import { loadSettings, saveSettings, type Settings } from './stores/settings';
import { applyCodeTheme, effectiveMode, onSystemModeChange, themeOptions } from './theme';

  let settings = $state<Settings>(loadSettings());
  let urlValue = $state('');
  let fileInput = $state<HTMLInputElement | null>(null);
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
    // themeMode=system：OS 亮暗切换时按新槽位重应用代码主题（UI 配色由
    // prefers-color-scheme 媒体查询自动跟随，JS 注入的代码主题变量需要这一步）
    return onSystemModeChange((sysMode) => {
      if (settings.themeMode !== 'system') return;
      void applyCodeTheme(sysMode === 'dark' ? settings.codeThemeDark : settings.codeThemeLight, sysMode);
    });
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
</header>
