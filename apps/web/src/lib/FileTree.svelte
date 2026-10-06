<script lang="ts">
  import type { TreeStore, TreeNode } from '@vviewer/core';
  import TreeNodeRow from './TreeNodeRow.svelte';

  let { store, excludedPatterns = [], onopen }: {
    store: TreeStore;
    excludedPatterns?: string[];
    onopen: (e: { path: string; name: string }) => void;
  } = $props();

  let nodes = $state<TreeNode[]>([]);

  function excluded(name: string): boolean {
    return excludedPatterns.some((p) => name === p || (p.startsWith('*.') && name.endsWith(p.slice(1))));
  }

  // 根目录懒加载；store 或排除模式变化时重载
  $effect(() => {
    const s = store;
    const patterns = excludedPatterns;
    let cancelled = false;
    s.listChildren('')
      .then((list) => {
        if (!cancelled) nodes = list.filter((n) => !excluded(n.name));
      })
      .catch(() => {
        if (!cancelled) nodes = [];
      });
    return () => {
      cancelled = true;
    };
  });
</script>

<ul class="vv-tree" role="tree">
  {#each nodes as node (node.path)}
    <TreeNodeRow {store} {excludedPatterns} {node} depth={0} {onopen} />
  {/each}
</ul>
