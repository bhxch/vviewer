<script lang="ts">
  import type { TreeStore, TreeNode } from '@vviewer/core';
  import { showStatusNotice } from './openFlow.svelte';
  import Self from './TreeNodeRow.svelte';

  let { store, excludedPatterns = [], node, depth, onopen }: {
    store: TreeStore;
    excludedPatterns?: string[];
    node: TreeNode;
    depth: number;
    onopen: (e: { path: string; name: string }) => void;
  } = $props();

  let expanded = $state(false);
  let children = $state<TreeNode[] | null>(null);

  function excluded(name: string): boolean {
    return excludedPatterns.some((p) => name === p || (p.startsWith('*.') && name.endsWith(p.slice(1))));
  }

  async function toggle(): Promise<void> {
    if (node.kind !== 'dir') {
      onopen({ path: node.path, name: node.name });
      return;
    }
    expanded = !expanded;
    if (expanded && children === null) {
      try {
        const list = await store.listChildren(node.path);
        children = list.filter((n) => !excluded(n.name));
      } catch (err) {
        console.error(`加载目录 ${node.path} 失败`, err);
        // BUG-24：断网/服务器异常下展开未加载目录此前静默失败——复用既有状态栏
        // 一次性提示通道（与文件打开失败的错误卡片对照），保留 expanded 回滚
        const message = err instanceof Error ? err.message : String(err);
        showStatusNotice(`目录 ${node.name} 加载失败：${message}`);
        expanded = false; // 加载失败回滚展开态，避免出现空子树
      }
    }
  }
</script>

<li
  role="treeitem"
  aria-selected={false}
  aria-expanded={node.kind === 'dir' ? expanded : undefined}>
  <button class="vv-tree-row" onclick={() => void toggle()}>
    <span class="vv-tree-caret">{node.kind === 'dir' ? (expanded ? '▾' : '▸') : ''}</span>
    <span class="vv-tree-name">{node.name}</span>
  </button>
  {#if node.kind === 'dir' && expanded && children}
    <ul class="vv-tree" role="group">
      {#each children as child (child.path)}
        <Self {store} {excludedPatterns} node={child} depth={depth + 1} {onopen} />
      {/each}
    </ul>
  {/if}
</li>
