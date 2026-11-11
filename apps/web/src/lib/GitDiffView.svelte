<script module lang="ts">
  // UI 状态形状（GitSection diff 折叠区与 log 逐提交 diff 共用；GitDiffView 为
  // 唯一渲染面）。idle = 未拉取（折叠区收起的静止态）。
  export type GitDiffUiState =
    | { s: 'idle' }
    | { s: 'loading' }
    | { s: 'error'; message: string }
    | { s: 'empty'; note: string }
    | { s: 'ready'; diff: DiffResult };
</script>

<script lang="ts">
  // GitDiffView.svelte — diff 渲染面（git 信息面板 spec §3.3，Task 3）：+/- 行级
  // 着色 pre（自绘，不经 dispatcher 全链、不派发临时 tab；diff 语法高亮不做），
  // 统计行 + 截断尾注（Task 9 域 F 起 note 不在 unifiedDiff 产出——gitDiff.ts 被
  // worker 打包须零 i18n import——本组件以 truncated + 常量拼装 git.diff.
  // truncatedNote，渲染值与原字面量逐字节等价）。
  // GitSection 的 diff 折叠区与 log 条目展开的逐提交 diff 复用本组件（「复用 diff
  // 通道」裁决的渲染半边，数据半边是 unifiedDiff 纯函数）。
  import { DIFF_MAX_BYTES, DIFF_MAX_ROWS } from './git/gitDiff';
  import { t } from './i18n/index.svelte';
  import type { DiffResult } from './git/gitDiff';

  let { state }: { state: GitDiffUiState } = $props();

  /** 截断尾注（truncated 时直显；unifiedDiff 的 maxRows/maxBytes 用缺省常量——
   *  GitSection 三处调用均不传 opts，上限即 DIFF_MAX_ROWS/DIFF_MAX_BYTES）。 */
  const truncNote = $derived(
    state.s === 'ready' && state.diff.truncated
      ? t('git.diff.truncatedNote', {
          rows: DIFF_MAX_ROWS,
          kb: Math.round(DIFF_MAX_BYTES / 1024)
        })
      : ''
  );
</script>

{#if state.s === 'loading'}
  <p class="vv-git-note">{t('git.diff.computing')}</p>
{:else if state.s === 'error'}
  <p class="vv-git-error">{state.message}</p>
{:else if state.s === 'empty'}
  <p class="vv-git-note">{state.note}</p>
{:else if state.s === 'ready'}
  <p class="vv-git-diff-stat">
    <span class="vv-git-diff-plus">+{state.diff.addCount}</span>
    <span class="vv-git-diff-minus">−{state.diff.delCount}</span>
  </p>
  {#if state.diff.rows.length === 0}
    <p class="vv-git-note">{t('git.diff.noChanges')}</p>
  {:else}
    <!-- whitespace 抑制：行内无裸换行文本节点，行块由 display:block 呈现 -->
    <pre class="vv-git-diff">{#each state.diff.rows as row, i (i)}<span class="vv-git-diff-row vv-git-diff-row-{row.type}">{row.type === 'add' ? '+' : row.type === 'del' ? '-' : ' '} {row.text}</span>{/each}{#if truncNote !== ''}<span class="vv-git-diff-trunc">{truncNote}</span>{/if}</pre>
  {/if}
{/if}
