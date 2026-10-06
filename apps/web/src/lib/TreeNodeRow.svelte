<script lang="ts">
  import type { TreeStore, TreeNode } from '@vviewer/core';
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
      const list = await store.listChildren(node.path);
      children = list.filter((n) => !excluded(n.name));
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
