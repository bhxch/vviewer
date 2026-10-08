<script lang="ts">
  // SettingsPanel.svelte — 设置面板浮层（BUG-05，SHELL-09/13 + SRV-07）。
  // TopBar 以 ⚙ 挂载（Ctrl+comma 切换）：排除规则编辑（条目删除/手动添加/预设
  // 一键加入）、autoRefresh 开关（关闭后目录树 SSE 自动同步停用，手动刷新 ↻
  // 不受影响）。修改即时经 saveSettings 持久化，AppShell 经 onSettingsChanged
  // 订阅刷新响应式副本（FileTree 随排除规则重建）。Esc / ✕ 关闭。
  import { loadSettings, saveSettings } from './stores/settings';

  let { onclose }: { onclose(): void } = $props();

  /** 面板本地草稿：打开时从 localStorage 读一次；保存时合并最新持久值 */
  let patterns = $state<string[]>([...loadSettings().excludedPatterns]);
  let autoRefresh = $state(loadSettings().autoRefresh);
  let draft = $state('');
  let inputEl = $state<HTMLInputElement | null>(null);
  let panelEl = $state<HTMLElement | null>(null);

  /** 常用排除预设：一键加入（重复添加幂等） */
  const PRESETS: readonly string[] = ['.git', 'node_modules'];

  $effect(() => {
    inputEl?.focus();
  });

  $effect(() => {
    // Esc 全局化兜底（与 GlobalSearchPanel 同模式）：焦点落到面板外时 Esc 也关闭
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
    window.addEventListener('keydown', onWinKey);
    return () => window.removeEventListener('keydown', onWinKey);
  });

  /**
   * 保存：读最新持久值只覆盖本面板管的两个字段——面板打开期间 TopBar 若改了
   * 主题/计算策略，不被面板的旧草稿覆盖。
   */
  function persist(): void {
    const fresh = loadSettings();
    fresh.excludedPatterns = [...patterns];
    fresh.autoRefresh = autoRefresh;
    saveSettings(fresh);
  }

  function addPattern(raw: string): void {
    const v = raw.trim();
    if (v === '' || patterns.includes(v)) return;
    patterns = [...patterns, v];
    persist();
  }

  function removePattern(p: string): void {
    patterns = patterns.filter((x) => x !== p);
    persist();
  }

  function submit(e: SubmitEvent): void {
    e.preventDefault();
    addPattern(draft);
    draft = '';
  }

  function toggleAutoRefresh(): void {
    autoRefresh = !autoRefresh;
    persist();
  }

  function close(): void {
    // 关闭前记录焦点：面板卸载后还原（与 GlobalSearchPanel 同模式）
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

  function onpanelkeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  }
</script>

<div class="vv-settings" role="dialog" aria-label="设置" tabindex="-1" bind:this={panelEl} onkeydown={onpanelkeydown}>
  <div class="vv-settings-head">
    <span class="vv-settings-title">设置</span>
    <button type="button" class="vv-settings-close" aria-label="关闭设置" title="关闭（Esc）" onclick={close}>✕</button>
  </div>

  <section class="vv-settings-sec">
    <div class="vv-settings-label">排除规则</div>
    <div class="vv-settings-hint">命中名称的文件/目录不显示在文件树与快速打开中（如 .git、node_modules；*.log 排除所有 .log 文件）</div>
    {#if patterns.length > 0}
      <ul class="vv-settings-patterns">
        {#each patterns as p (p)}
          <li class="vv-settings-pattern">
            <code>{p}</code>
            <button
              type="button"
              class="vv-settings-remove"
              aria-label="删除排除规则 {p}"
              title="删除"
              onclick={() => removePattern(p)}>✕</button
            >
          </li>
        {/each}
      </ul>
    {:else}
      <div class="vv-settings-empty">暂无排除规则</div>
    {/if}
    <form class="vv-settings-add" onsubmit={submit}>
      <input
        bind:this={inputEl}
        bind:value={draft}
        placeholder="添加名称或 *.后缀"
        aria-label="添加排除规则"
        spellcheck="false"
      />
      <button type="submit" disabled={draft.trim() === ''}>添加</button>
    </form>
    <div class="vv-settings-presets">
      {#each PRESETS as p (p)}
        <button
          type="button"
          disabled={patterns.includes(p)}
          aria-label="加入预设排除规则 {p}"
          onclick={() => addPattern(p)}>+ {p}</button
        >
      {/each}
    </div>
  </section>

  <section class="vv-settings-sec">
    <label class="vv-settings-toggle">
      <input type="checkbox" checked={autoRefresh} onchange={toggleAutoRefresh} />
      <span>自动刷新</span>
    </label>
    <div class="vv-settings-hint">
      连接服务器时内容变更自动重读；关闭后目录树同步停用，可用顶栏 ↻ 手动刷新当前文件与目录树
    </div>
  </section>
</div>

<style>
  .vv-settings {
    position: fixed;
    top: 44px;
    right: 8px;
    width: min(340px, calc(100vw - 16px));
    max-height: min(75vh, 560px);
    overflow: auto;
    background: var(--ui-bg);
    border: 1px solid var(--ui-border);
    border-radius: 8px;
    box-shadow: 0 8px 28px rgb(0 0 0 / 22%);
    z-index: 30;
    padding: 10px 12px;
  }
  .vv-settings-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 6px;
  }
  .vv-settings-title {
    font-weight: 600;
  }
  .vv-settings-sec {
    padding: 8px 0;
    border-top: 1px solid var(--ui-border);
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .vv-settings-label {
    font-weight: 600;
    font-size: 13px;
  }
  .vv-settings-hint {
    color: var(--ui-fg-muted);
    font-size: 12px;
  }
  .vv-settings-patterns {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .vv-settings-pattern {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    border: 1px solid var(--ui-border);
    border-radius: 12px;
    padding: 1px 4px 1px 8px;
    font-size: 12px;
  }
  .vv-settings-remove {
    border: 0;
    background: none;
    padding: 0 3px;
    cursor: pointer;
    color: var(--ui-fg-muted);
  }
  .vv-settings-remove:hover {
    color: var(--ui-fg);
  }
  .vv-settings-empty {
    color: var(--ui-fg-muted);
    font-size: 12px;
  }
  .vv-settings-add {
    display: flex;
    gap: 6px;
  }
  .vv-settings-add input {
    flex: 1;
    min-width: 0;
  }
  .vv-settings-presets {
    display: flex;
    gap: 6px;
  }
  .vv-settings-presets button {
    font-size: 12px;
  }
  .vv-settings-presets button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .vv-settings-toggle {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
    cursor: pointer;
  }
</style>
