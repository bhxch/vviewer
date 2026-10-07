<script lang="ts">
  // GlobalSearchPanel.svelte — 全局跨文件搜索面板（M6 T4）。AppShell 以
  // Ctrl+Shift+F 挂载：输入防抖 300ms → runGlobalSearch 路由（远程 ripgrep /
  // 前端内存 grep）→ 按文件分组列表（行内 query 高亮）→ 点击 addTab 打开文件
  // （打开后行内定位为 P2）；Esc/✕ 关闭。代际防护：新输入使旧结果作废，
  // 本地 grep 经 canceled 提前自弃、远程经 AbortController 断流。
  import type { GrepMatch, TreeStore } from '@vviewer/core';
  import { matchRanges } from '@vviewer/core';
  import { addTab } from './openFlow.svelte';
  import { runGlobalSearch } from './globalSearch';

  let { store, onclose }: { store: TreeStore | null; onclose(): void } = $props();

  let query = $state('');
  let caseSensitive = $state(false);
  let regex = $state(false);
  let matches = $state<GrepMatch[]>([]);
  let truncated = $state(false);
  let degraded = $state(false);
  /** 状态条：搜索中 / 进度 / 摘要 / 错误 / 未打开目录 */
  let status = $state('');
  let running = $state(false);
  let inputEl = $state<HTMLInputElement | null>(null);

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  /** 代际防护：新输入/关闭使旧请求结果作废 */
  let gen = 0;
  let abort: AbortController | null = null;
  let closed = false;

  /** DOM 渲染行数上限（命中可能上千，列表只画头部并提示剩余） */
  const MAX_ROWS = 200;

  $effect(() => {
    // 本 effect 读取 inputEl（bind:this），而 bind:this 赋值可能晚于首轮 effect——
    // 重跑时 cleanup 会把 closed 置真并 gen++，body 必须复位，否则所有搜索结果
    // 被代际防护永久丢弃（状态条停在"搜索中…"）。
    closed = false;
    inputEl?.focus();
    return () => {
      closed = true;
      gen++;
      abort?.abort();
      if (debounceTimer !== null) clearTimeout(debounceTimer);
    };
  });

  /** 展示行（保持命中顺序；文件首行带 header 标记），截到 MAX_ROWS */
  const rows = $derived.by(() => {
    const out: Array<{ m: GrepMatch; header: boolean }> = [];
    let lastPath = '';
    for (const m of matches) {
      if (out.length >= MAX_ROWS) break;
      const header = m.path !== lastPath;
      lastPath = m.path;
      out.push({ m, header });
    }
    return out;
  });

  const counts = $derived.by(() => {
    const c = new Map<string, number>();
    for (const m of matches) c.set(m.path, (c.get(m.path) ?? 0) + 1);
    return c;
  });

  function oninput(): void {
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => void run(), 300);
  }

  async function run(): Promise<void> {
    const my = ++gen;
    abort?.abort();
    if (!store || query === '') {
      matches = [];
      truncated = false;
      degraded = false;
      status = store ? '' : '未打开文件夹';
      return;
    }
    const ac = new AbortController();
    abort = ac;
    const canceled = (): boolean => closed || my !== gen || ac.signal.aborted;
    running = true;
    status = '搜索中…';
    try {
      const res = await runGlobalSearch(
        store,
        query,
        { caseSensitive, regex },
        (done) => {
          // 进度节流：前 20 个实时，其后每 25 个刷一次
          if (!canceled() && (done < 20 || done % 25 === 0)) status = `已扫描 ${done} 个文件…`;
        },
        canceled,
        ac.signal
      );
      if (canceled()) return;
      matches = res.matches;
      truncated = res.truncated;
      degraded = res.degraded;
      status = matches.length === 0 ? '无结果' : `${matches.length} 个命中`;
    } catch (err) {
      if (canceled()) return;
      matches = [];
      status = err instanceof Error ? err.message : String(err);
    } finally {
      if (my === gen) running = false;
    }
  }

  /** 切换大小写/正则开关后立即重搜（跳过防抖） */
  function toggleOption(key: 'caseSensitive' | 'regex'): void {
    if (key === 'caseSensitive') caseSensitive = !caseSensitive;
    else regex = !regex;
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    void run();
  }

  function open(m: GrepMatch): void {
    if (!store) return;
    // 打开后滚动定位到命中行（P2）：addTab 激活 tab 即可
    addTab(store, m.path, m.path.split('/').pop() ?? m.path);
  }

  /** 预览行按当前 query 切段（hit 段渲染 <mark>）；非法正则等异常降级纯文本 */
  function segments(m: GrepMatch): Array<{ text: string; hit: boolean }> {
    let ranges: Array<{ start: number; end: number }>;
    try {
      ranges = matchRanges(m.preview, query, { caseSensitive, regex });
    } catch {
      return [{ text: m.preview, hit: false }];
    }
    const out: Array<{ text: string; hit: boolean }> = [];
    let pos = 0;
    for (const r of ranges) {
      if (r.start > pos) out.push({ text: m.preview.slice(pos, r.start), hit: false });
      out.push({ text: m.preview.slice(r.start, r.end), hit: true });
      pos = r.end;
    }
    if (pos < m.preview.length) out.push({ text: m.preview.slice(pos), hit: false });
    return out;
  }

  function close(): void {
    // 关闭前记录焦点：面板卸载后还原（与文件内 SearchPanel 同模式）
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

<div class="vv-gsearch" role="search" aria-label="全局搜索" onkeydown={onpanelkeydown}>
  <div class="vv-gsearch-bar">
    <input
      bind:this={inputEl}
      bind:value={query}
      class="vv-gsearch-input"
      type="text"
      placeholder="在打开的文件夹中搜索"
      aria-label="全局搜索内容"
      oninput={oninput}
    />
    <button
      type="button"
      class="vv-gsearch-btn"
      class:active={caseSensitive}
      aria-pressed={caseSensitive}
      title="区分大小写"
      onclick={() => toggleOption('caseSensitive')}>Aa</button
    >
    <button
      type="button"
      class="vv-gsearch-btn"
      class:active={regex}
      aria-pressed={regex}
      title="正则表达式"
      onclick={() => toggleOption('regex')}>.*</button
    >
    <button type="button" class="vv-gsearch-btn" aria-label="关闭全局搜索" title="关闭（Esc）" onclick={close}>✕</button>
  </div>
  <div class="vv-gsearch-status" aria-live="polite">
    <span class:running>
      {status}{truncated ? '（结果不完整，已达上限）' : ''}
    </span>
    {#if degraded}
      <span class="vv-gsearch-hint">服务器 ripgrep 不可用，已改用浏览器内搜索（可能较慢）</span>
    {/if}
  </div>
  {#if rows.length > 0}
    <div class="vv-gsearch-results">
      {#each rows as row (row.m.path + ':' + row.m.line + ':' + row.m.col)}
        {#if row.header}
          <div class="vv-gsearch-file">
            <span class="vv-gsearch-file-path">{row.m.path}</span>
            <span class="vv-gsearch-file-count">{counts.get(row.m.path)}</span>
          </div>
        {/if}
        {@const segs = segments(row.m)}
        <button type="button" class="vv-gsearch-row" onclick={() => open(row.m)} title={row.m.path}>
          <span class="vv-gsearch-lncol">{row.m.line}:{row.m.col}</span>
          <span class="vv-gsearch-preview">
            {#each segs as seg, i (i)}{#if seg.hit}<mark>{seg.text}</mark>{:else}{seg.text}{/if}{/each}
          </span>
        </button>
      {/each}
      {#if matches.length > rows.length}
        <div class="vv-gsearch-more">仅显示前 {rows.length} 条（共 {matches.length} 条）</div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .vv-gsearch {
    position: fixed;
    top: 44px;
    left: 50%;
    transform: translateX(-50%);
    width: min(720px, calc(100vw - 24px));
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
  .vv-gsearch-bar {
    display: flex;
    gap: 6px;
    padding: 8px 10px;
    border-bottom: 1px solid var(--ui-border);
    flex: none;
  }
  .vv-gsearch-input {
    flex: 1;
    min-width: 0;
  }
  .vv-gsearch-btn.active {
    color: var(--ui-accent);
    border-color: var(--ui-accent);
  }
  .vv-gsearch-status {
    display: flex;
    gap: 12px;
    align-items: baseline;
    padding: 4px 10px;
    color: var(--ui-fg-muted);
    font-size: 12px;
    border-bottom: 1px solid var(--ui-border);
    flex: none;
    min-height: 1.4em;
  }
  .vv-gsearch-status .running {
    color: var(--ui-accent);
  }
  .vv-gsearch-hint {
    color: #b58900;
  }
  .vv-gsearch-results {
    overflow: auto;
    min-height: 0;
    padding-bottom: 6px;
  }
  .vv-gsearch-file {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    padding: 6px 10px 2px;
    font-size: 12px;
    color: var(--ui-fg-muted);
    position: sticky;
    top: 0;
    background: var(--ui-side-bg);
  }
  .vv-gsearch-file-path {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .vv-gsearch-row {
    display: flex;
    gap: 8px;
    width: 100%;
    border: 0;
    background: none;
    text-align: left;
    padding: 2px 10px 2px 18px;
    font: inherit;
    color: var(--ui-fg);
    border-radius: 0;
  }
  .vv-gsearch-row:hover {
    background: var(--ui-side-bg);
  }
  .vv-gsearch-lncol {
    flex: none;
    width: 84px;
    color: var(--ui-fg-muted);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }
  .vv-gsearch-preview {
    white-space: pre;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .vv-gsearch-preview mark {
    background: rgb(255 213 0 / 55%);
    color: inherit;
    border-radius: 2px;
    padding: 0 1px;
  }
  .vv-gsearch-more {
    padding: 6px 10px;
    color: var(--ui-fg-muted);
    font-size: 12px;
  }
</style>
