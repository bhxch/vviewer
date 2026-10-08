<script lang="ts">
  // QuickOpenPanel.svelte — 快速打开面板（BUG-03，Ctrl+P，场景 SHELL-11）。
  // AppShell 以 Ctrl+P 挂载：打开时递归 listChildren（应用排除规则，逻辑在
  // quickOpen.ts 可单测）列文件 → 输入子串过滤（文件名命中优先）→ ↑↓ 选择、
  // Enter 经 addTab 打开 → Esc/✕ 关闭。浮层/焦点管理对齐 GlobalSearchPanel。
  import type { TreeStore } from '@vviewer/core';
  import { addTab } from './openFlow.svelte';
  import { loadSettings } from './stores/settings';
  import { fileNameOf, filterFiles, listFilesRecursively } from './quickOpen';

  let { store, onclose }: { store: TreeStore | null; onclose(): void } = $props();

  let query = $state('');
  let files = $state<string[]>([]);
  /** 状态条：列文件中 / 失败 / 未打开目录 / 无匹配 */
  let status = $state('');
  let active = $state(0);
  let inputEl = $state<HTMLInputElement | null>(null);
  let panelEl = $state<HTMLElement | null>(null);
  let listEl = $state<HTMLElement | null>(null);

  /** 列表渲染上限（列文件本身另有 5000 封顶，见 quickOpen.ts） */
  const MAX_RESULTS = 100;

  const results = $derived(filterFiles(files, query, MAX_RESULTS));

  $effect(() => {
    inputEl?.focus();
  });

  // 打开时列一次文件；store 卸载/替换后代际防护（stale 丢弃过期结果）
  $effect(() => {
    const s = store;
    if (!s) {
      status = '未打开文件夹';
      return;
    }
    let stale = false;
    status = '正在列出文件…';
    listFilesRecursively(s, loadSettings().excludedPatterns)
      .then((list) => {
        if (stale) return;
        files = list;
        status = '';
      })
      .catch((err) => {
        if (stale) return;
        status = `列出文件失败：${err instanceof Error ? err.message : String(err)}`;
      });
    return () => {
      stale = true;
    };
  });

  $effect(() => {
    // 输入变化重置选中项到首条；同时夹紧越界（结果集缩小时）
    query;
    active = 0;
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

  function scrollActiveIntoView(): void {
    listEl?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }

  function oninputkey(e: KeyboardEvent): void {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      active = Math.min(active + 1, results.length - 1);
      scrollActiveIntoView();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      active = Math.max(active - 1, 0);
      scrollActiveIntoView();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const path = results[active];
      if (path !== undefined) open(path);
    }
  }

  function open(path: string): void {
    if (!store) return;
    addTab(store, path, fileNameOf(path));
    close();
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

<div class="vv-quickopen" role="dialog" aria-label="快速打开" tabindex="-1" bind:this={panelEl} onkeydown={onpanelkeydown}>
  <div class="vv-quickopen-bar">
    <input
      bind:this={inputEl}
      bind:value={query}
      class="vv-quickopen-input"
      type="text"
      placeholder="输入文件名过滤，↑↓ 选择，Enter 打开"
      aria-label="快速打开文件"
      spellcheck="false"
      onkeydown={oninputkey}
    />
    <button type="button" class="vv-quickopen-btn" aria-label="关闭快速打开" title="关闭（Esc）" onclick={close}>✕</button>
  </div>
  <div class="vv-quickopen-status" aria-live="polite">
    {status}{#if !status && files.length > 0 && results.length === 0}无匹配文件{/if}
  </div>
  {#if results.length > 0}
    <ul class="vv-quickopen-list" bind:this={listEl}>
      {#each results as path, i (path)}
        <li>
          <button
            type="button"
            class="vv-quickopen-row"
            class:active={i === active}
            data-active={i === active}
            title={path}
            onclick={() => open(path)}
            onmousemove={() => (active = i)}
          >
            <span class="vv-quickopen-name">{fileNameOf(path)}</span>
            <span class="vv-quickopen-path">{path}</span>
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .vv-quickopen {
    position: fixed;
    top: 44px;
    left: 50%;
    transform: translateX(-50%);
    width: min(560px, calc(100vw - 24px));
    max-height: min(70vh, 640px);
    display: flex;
    flex-direction: column;
    background: var(--ui-bg);
    border: 1px solid var(--ui-border);
    border-radius: 8px;
    box-shadow: 0 8px 28px rgb(0 0 0 / 22%);
    z-index: 30;
    overflow: hidden;
  }
  .vv-quickopen-bar {
    display: flex;
    gap: 6px;
    padding: 8px 10px;
    border-bottom: 1px solid var(--ui-border);
    flex: none;
  }
  .vv-quickopen-input {
    flex: 1;
    min-width: 0;
  }
  .vv-quickopen-status {
    padding: 4px 10px;
    color: var(--ui-fg-muted);
    font-size: 12px;
    min-height: 1.4em;
    border-bottom: 1px solid var(--ui-border);
    flex: none;
  }
  .vv-quickopen-list {
    list-style: none;
    margin: 0;
    padding: 4px 0;
    overflow: auto;
    min-height: 0;
  }
  .vv-quickopen-row {
    display: flex;
    gap: 8px;
    width: 100%;
    border: 0;
    background: none;
    text-align: left;
    padding: 3px 10px;
    font: inherit;
    color: var(--ui-fg);
    border-radius: 0;
  }
  .vv-quickopen-row.active {
    background: var(--ui-side-bg);
  }
  .vv-quickopen-name {
    flex: none;
    max-width: 60%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .vv-quickopen-path {
    color: var(--ui-fg-muted);
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
