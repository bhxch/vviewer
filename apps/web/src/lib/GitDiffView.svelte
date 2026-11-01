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
  // 统计行 + 截断尾注（unifiedDiff 产出的 note 直显——常量进实现，UI 可见）。
  // GitSection 的 diff 折叠区与 log 条目展开的逐提交 diff 复用本组件（「复用 diff
  // 通道」裁决的渲染半边，数据半边是 unifiedDiff 纯函数）。
  import type { DiffResult } from './git/gitDiff';

  let { state }: { state: GitDiffUiState } = $props();
</script>

{#if state.s === 'loading'}
  <p class="vv-git-note">正在计算 diff…</p>
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
    <p class="vv-git-note">内容无差异（仅行尾/编码差异按归一口径不显示）</p>
  {:else}
    <!-- whitespace 抑制：行内无裸换行文本节点，行块由 display:block 呈现 -->
    <pre class="vv-git-diff">{#each state.diff.rows as row, i (i)}<span class="vv-git-diff-row vv-git-diff-row-{row.type}">{row.type === 'add' ? '+' : row.type === 'del' ? '-' : ' '} {row.text}</span>{/each}{#if state.diff.truncated}<span class="vv-git-diff-trunc">{state.diff.note}</span>{/if}</pre>
  {/if}
{/if}
