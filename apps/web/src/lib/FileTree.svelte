<script lang="ts">
  import type { TreeStore, TreeNode } from '@bhxch/vviewer-core';
  import TreeNodeRow from './TreeNodeRow.svelte';
  import { showStatusNotice } from './openFlow.svelte';

  let { sources, excludedPatterns = [], onopen, onremove }: {
    /** 当前 workspace 的全部可渲染来源（AppShell 由 workspace.sources × 活动实例解析） */
    sources: Array<{ label: string; store: TreeStore }>;
    excludedPatterns?: string[];
    /** TreeNodeRow 上行的打开事件附带命中来源的 store（AppShell 按源 addTab）；
     * size 随事件透传（io-streaming Task 4）写入 Tab.source.size */
    onopen: (e: { path: string; name: string; size?: number; store: TreeStore }) => void;
    /** 源级移除（confirm 在本组件内）；AppShell 关闭该组内该源全部 tab 并 removeSource */
    onremove?: (store: TreeStore) => void;
  } = $props();

  /** 各源根目录节点：一次 effect 全源加载；任一源失败该源为空列表，不拖垮其他源 */
  let roots = $state<Array<{ storeId: string; label: string; store: TreeStore; nodes: TreeNode[] }>>([]);

  function excluded(name: string): boolean {
    return excludedPatterns.some((p) => name === p || (p.startsWith('*.') && name.endsWith(p.slice(1))));
  }

  // 各源根目录懒加载；来源集或排除模式变化时重载（整树重建另有 AppShell 的 treeKey 通道）
  $effect(() => {
    const srcs = sources;
    let cancelled = false;
    Promise.all(
      srcs.map(async (src) => ({
        storeId: src.store.id,
        label: src.label,
        store: src.store,
        nodes: await src.store
          .listChildren('')
          .then((list) => list.filter((n) => !excluded(n.name)))
          .catch((err: unknown) => {
            // SUSP-07：根级加载失败不再静默——复用 BUG-24 状态栏提示通道
            //（TreeNodeRow 子目录展开失败同款），失败隔离语义保留（本源空列表
            // 不拖垮其他源）；轻量异常走状态栏一次性提示而非错误卡片
            const message = err instanceof Error ? err.message : String(err);
            showStatusNotice(`来源 ${src.label} 加载失败：${message}`);
            return [] as TreeNode[];
          })
      }))
    ).then((rs) => {
      if (!cancelled) roots = rs;
    });
    return () => {
      cancelled = true;
    };
  });

  /** 源级折叠（本 spec §2.1）：storeId → 是否折叠；局部 state 不持久化，
   *  {#key treeKey} 整树重建时随组件重建重置（TreeNodeRow 展开态同先例） */
  let collapsed = $state<Record<string, boolean>>({});
  function toggleCollapse(storeId: string): void {
    collapsed = { ...collapsed, [storeId]: !collapsed[storeId] };
  }

  function requestRemove(store: TreeStore): void {
    if (!confirm(`将关闭该来源下全部 tab，并从当前工作区移除来源「${store.displayName()}」，确定？`)) return;
    onremove?.(store);
  }
</script>

<div class="vv-tree" role="tree">
  {#each roots as src (src.storeId)}
    <div class="vv-tree-src">
      <button type="button" class="vv-tree-src-toggle" aria-label="折叠/展开 {src.label}"
        aria-expanded={!collapsed[src.storeId]}
        onclick={() => toggleCollapse(src.storeId)}>{collapsed[src.storeId] ? '▸' : '▾'}</button>
      <span class="vv-tree-src-label" title={src.label}>{src.label}</span>
      <button
        type="button"
        class="vv-tree-src-remove"
        aria-label="移除来源 {src.label}"
        title="移除该来源（将关闭该来源下全部 tab）"
        onclick={() => requestRemove(src.store)}
      >✕</button>
    </div>
    {#if !collapsed[src.storeId]}
      <ul class="vv-tree-group" role="group">
        {#each src.nodes as node (node.path)}
          <TreeNodeRow store={src.store} {excludedPatterns} {node} depth={0} onopen={(e) => onopen({ ...e, store: src.store })} />
        {/each}
      </ul>
    {/if}
  {/each}
</div>

<style>
  /* 顶层源名行（T4 多根）：源级标签 + 移除入口。嵌套子树的缩进/列表复位
     仍走 app.css 的 .vv-tree 规则（TreeNodeRow 的嵌套 ul.vv-tree） */
  .vv-tree-src {
    display: flex;
    align-items: center;
    gap: var(--vv-sp-4);
    padding: var(--vv-sp-4) var(--vv-sp-6) var(--vv-sp-2);
    /* 行右让位（本 spec 重叠修复本体）：侧栏折叠钮 .vv-collapse-left 在 app.css
       为 absolute top:6 right:6 24×24，浮置于本行右上——右缘 6px 偏移的
       24px 命中区，命中区左缘距行右缘 30px，34px 让位留 4px 余量，
       行内内容（移除钮）不再压进其命中区 */
    padding-right: 34px;
    font-size: var(--vv-fs-xs);
    color: var(--ui-fg-muted);
  }
  .vv-tree-src-toggle {
    flex: none;
    border: 0;
    background: none;
    font: inherit;
    padding: 0;
    cursor: pointer;
    color: var(--ui-fg-muted); /* 与 label 同色 */
  }
  .vv-tree-src-label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 600;
  }
  .vv-tree-src-remove {
    flex: none;
    border: 0;
    background: none;
    color: var(--ui-fg-muted);
    font: inherit;
    font-size: var(--vv-fs-2xs);
    padding: 0 var(--vv-sp-4);
    border-radius: var(--vv-radius-sm);
    cursor: pointer;
    opacity: 0; /* hover 揭示；键盘等价见 :focus-within */
    transition: opacity .12s;
  }
  .vv-tree-src:hover .vv-tree-src-remove,
  .vv-tree-src:focus-within .vv-tree-src-remove { opacity: 1; }
  /* 触屏无 hover（评审 Minor 2）：hover 媒介查询不触发的环境恒显，
     hover 设备仍走上方 hover/focus-within 揭示 */
  @media (hover: none) {
    .vv-tree-src-remove { opacity: 1; }
  }
  .vv-tree-src-remove:hover {
    color: var(--ui-fg);
    background: var(--ui-hover-bg); /* 与树行 hover 同语义（亮暗均与 side-bg 同值，零漂移） */
  }
  .vv-tree-group {
    list-style: none;
    margin: 0;
    padding: 0;
  }
</style>
