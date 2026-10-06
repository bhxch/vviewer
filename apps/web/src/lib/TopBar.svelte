<script lang="ts">
  import { onMount } from 'svelte';
  import { openFiles, openDirectoryViaPicker, openUrl } from './openFlow.svelte';
  import { loadSettings, saveSettings, type Settings } from './stores/settings';
  import { applyCodeTheme, effectiveMode, themeOptions } from './theme';

  let settings = $state<Settings>(loadSettings());
  let urlValue = $state('');
  let fileInput = $state<HTMLInputElement | null>(null);
  const codeThemeOptions = themeOptions();

  /** 当前生效亮暗（system 按 prefers-color-scheme 解析），决定下拉读写哪个记忆槽 */
  let mode = $derived(effectiveMode(settings.themeMode));
  let currentCodeTheme = $derived(mode === 'dark' ? settings.codeThemeDark : settings.codeThemeLight);

  function applyCurrentCodeTheme(): void {
    applyCodeTheme(currentCodeTheme, mode);
  }

  onMount(applyCurrentCodeTheme);

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
    applyCodeTheme(name, mode);
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
</script>

<header class="vv-topbar">
  <span class="vv-brand">vviewer</span>
  <button onclick={() => fileInput?.click()}>打开文件</button>
  <input type="file" multiple hidden bind:this={fileInput} onchange={onPick} />
  <button onclick={() => void openDirectoryViaPicker()}>打开文件夹</button>
  <form onsubmit={submit}>
    <input placeholder="粘贴文件 URL" bind:value={urlValue} aria-label="文件 URL" />
  </form>
  <button onclick={cycleTheme}>
    主题：{settings.themeMode === 'system' ? '跟随系统' : settings.themeMode === 'light' ? '亮' : '暗'}
  </button>
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
