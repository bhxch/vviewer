<script lang="ts">
  // SearchPanel.svelte — 文件内搜索面板（Task 6）。ViewerPane 右上浮层：
  // 输入防抖 150ms 调实例 search，n/N 计数，上/下一个（Enter/Shift+Enter 同通道），
  // Esc 关闭（关闭时 search('') 通知实例退出搜索：markdown 还原 mark，code 清高亮）。
  // 实例不带 search（如图片/音视频渲染器）时显示"此视图不支持搜索"。
  import type { RenderedInstance, SearchMatch } from '@vviewer/core';

  let { instance, onclose }: { instance: RenderedInstance | null; onclose(): void } = $props();

  let query = $state('');
  let total = $state(0);
  /** 当前命中（1 起；0 = 无命中） */
  let current = $state(0);
  let inputEl = $state<HTMLInputElement | null>(null);
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  /** 竞态防护：慢的旧 search 响应不得覆盖新结果；面板关闭后不再写状态 */
  let searchSeq = 0;
  let closed = false;

  $effect(() => {
    inputEl?.focus();
    return () => {
      closed = true;
      if (debounceTimer !== null) clearTimeout(debounceTimer);
    };
  });

  async function runSearch(q: string): Promise<void> {
    const seq = ++searchSeq;
    let matches: SearchMatch[] = [];
    try {
      matches = instance?.search ? await instance.search(q) : [];
    } catch {
      // tab 已销毁（如 PDF destroy 竞态）会使 search reject，属正常关闭时序：静默置零
      if (!closed && seq === searchSeq) {
        total = 0;
        current = 0;
      }
      return;
    }
    if (closed || seq !== searchSeq) return;
    total = matches.length;
    if (total > 0) {
      current = 1;
      instance?.gotoMatch?.(0); // 新搜索自动跳到第一个命中
    } else {
      current = 0;
    }
  }

  function oninput(): void {
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => void runSearch(query), 150);
  }

  /** 上/下一个命中（环绕）；delta 为 +1/-1 */
  function step(delta: number): void {
    if (total === 0 || !instance?.gotoMatch) return;
    const next = (current - 1 + delta + total) % total;
    current = next + 1;
    instance.gotoMatch(next);
  }

  function close(): void {
    // 关闭前记录焦点：面板卸载后还原，键盘交互不中断；焦点元素随面板移除则回落查看器宿主
    const prev = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    void instance?.search?.(''); // 退出搜索语义：markdown 还原 mark / code 清缓存与行级高亮
    onclose();
    // Svelte 卸载 flush 在微任务，setTimeout 回调必然落在卸载之后
    setTimeout(() => {
      if (prev !== null && prev.isConnected) {
        prev.focus();
        return;
      }
      document.querySelector<HTMLElement>('.vv-viewer-host')?.focus();
    }, 0);
  }

  /** Esc 在面板内任意焦点（输入框/↑↓/✕ 按钮）均可关闭：keydown 绑容器，随冒泡覆盖全部子元素 */
  function onpanelkeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  }

  /** Enter/Shift+Enter 仅输入框语义（下一个/上一个）；按钮持焦时 Enter 保留其默认点击 */
  function oninputkeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter') {
      e.preventDefault();
      step(e.shiftKey ? -1 : 1);
    }
  }
</script>

<div class="vv-search-panel" role="search" aria-label="文件内搜索" onkeydown={onpanelkeydown}>
  <input
    bind:this={inputEl}
    bind:value={query}
    class="vv-search-input"
    type="text"
    placeholder="搜索（Enter 下一个）"
    aria-label="搜索内容"
    oninput={oninput}
    onkeydown={oninputkeydown}
  />
  <span class="vv-search-count">
    {#if !instance?.search}
      此视图不支持搜索
    {:else if total === 0}
      无结果
    {:else}
      {current}/{total}
    {/if}
  </span>
  <button type="button" class="vv-search-btn" aria-label="上一个" title="上一个（Shift+Enter）" onclick={() => step(-1)}>↑</button>
  <button type="button" class="vv-search-btn" aria-label="下一个" title="下一个（Enter）" onclick={() => step(1)}>↓</button>
  <button type="button" class="vv-search-btn" aria-label="关闭搜索" title="关闭（Esc）" onclick={close}>✕</button>
</div>
