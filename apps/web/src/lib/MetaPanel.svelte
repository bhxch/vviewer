<script lang="ts">
  // 元数据面板（BUG-04 兑付 M4 占位）：读 metaStore 的模块级状态展示当前活动
  // 文件的名称/大小/编码/语言/行数/来源。数据由 ViewerPane 渲染实例的 getMeta
  // 写入（code 含行列；媒体/图片等渲染器至少大小与编码），错误卡片/tab 空时显示占位。
  import { fileMeta } from './metaStore.svelte';
</script>

<section class="meta-panel">
  <h2 class="meta-title">属性</h2>
  {#if fileMeta.name}
    <dl class="meta-list">
      <div class="meta-row"><dt>名称</dt><dd class="meta-name">{fileMeta.name}</dd></div>
      {#if fileMeta.size !== null}
        <div class="meta-row"><dt>大小</dt><dd>{fileMeta.size} 字节</dd></div>
      {/if}
      {#if fileMeta.encoding}
        <div class="meta-row"><dt>编码</dt><dd>{fileMeta.encoding}</dd></div>
      {/if}
      {#if fileMeta.lang}
        <div class="meta-row"><dt>语言</dt><dd>{fileMeta.lang}</dd></div>
      {/if}
      {#if fileMeta.lines !== null}
        <div class="meta-row"><dt>行数</dt><dd>{fileMeta.lines}</dd></div>
      {/if}
      {#if fileMeta.sourceLabel}
        <div class="meta-row"><dt>来源</dt><dd>{fileMeta.sourceLabel}</dd></div>
      {/if}
    </dl>
  {:else}
    <p class="meta-empty">未打开文件</p>
  {/if}
</section>

<style>
  .meta-list {
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
    font-size: 12px;
  }
  .meta-row {
    display: flex;
    gap: 6px;
    min-width: 0;
  }
  .meta-row dt {
    color: var(--ui-fg-muted);
    flex: none;
    width: 2.6em;
  }
  .meta-row dd {
    margin: 0;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .meta-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
