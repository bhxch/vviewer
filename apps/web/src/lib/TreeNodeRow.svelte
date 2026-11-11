<script lang="ts">
  import type { TreeStore, TreeNode } from '@bhxch/vviewer-core';
  import { matchIconTheme } from '@bhxch/vviewer-highlight';
  import { showStatusNotice } from './openFlow.svelte';
  import Self from './TreeNodeRow.svelte';
  import FileIcon from './FileIcon.svelte';
  import { iconThemeState } from './iconTheme.svelte';
  import { t } from './i18n/index.svelte';

  let { store, excludedPatterns = [], node, depth, iconEnabled = false, onopen }: {
    store: TreeStore;
    excludedPatterns?: string[];
    node: TreeNode;
    depth: number;
    /** 图标主题 tree 作用域门（图标主题 spec §3.1/§3.3，Task 4）：本组件无 settings
     * 访问路径，由 FileTree（AppShell 响应式副本）逐层下传布尔；FileIcon 自对
     * runtime null 零渲染，本门只承担 scopes 语义 */
    iconEnabled?: boolean;
    /** size：TreeNode.size 透传（io-streaming Task 4），缺省 = 条目无大小信息 */
    onopen: (e: { path: string; name: string; size?: number }) => void;
  } = $props();

  let expanded = $state(false);
  let children = $state<TreeNode[] | null>(null);

  /**
   * caret 替代判定（spec §3.3，Task 4）：主题有 folder 图标（folderNames 非空或
   * _folder 回退键在——hidesExplorerArrows 单独为真而无 folder 图标时不替换，维持
   * 纯 caret）且 hidesExplorerArrows=true 时，目录行 caret（▾/▸）由 folder/
   * folderExpanded 图标替代——展开态已知（本地 $state），变体双向直出；本行名字
   * 无匹配字形 → 回退纯 caret（防替代后空槽丢失展开指示，零位移原则同源）。
   * fontsOk 旗标（评审 Minor）：主题任一字体 FontFace 注册失败（解析损坏/缺字节）
   * → 字形栈残缺，folder 替代可能落空丢展开指示，整体回退纯 caret。
   */
  const caretReplaced = $derived.by(() => {
    if (!iconEnabled || node.kind !== 'dir' || iconThemeState.runtime === null) return false;
    const runtime = iconThemeState.runtime;
    if (!runtime.hidesExplorerArrows || (runtime.folderNames.size === 0 && runtime._folder === undefined)) return false;
    if (runtime.fontsOk === false) return false;
    return matchIconTheme(runtime, { kind: expanded ? 'folderExpanded' : 'folder', name: node.name }) !== null;
  });

  function excluded(name: string): boolean {
    return excludedPatterns.some((p) => name === p || (p.startsWith('*.') && name.endsWith(p.slice(1))));
  }

  async function toggle(): Promise<void> {
    if (node.kind !== 'dir') {
      onopen({ path: node.path, name: node.name, size: node.size });
      return;
    }
    expanded = !expanded;
    if (expanded && children === null) {
      try {
        const list = await store.listChildren(node.path);
        children = list.filter((n) => !excluded(n.name));
      } catch (err) {
        console.error(`[vviewer] tree: failed to load directory ${node.path}`, err);
        // BUG-24：断网/服务器异常下展开未加载目录此前静默失败——复用既有状态栏
        // 一次性提示通道（与文件打开失败的错误卡片对照），保留 expanded 回滚
        const message = err instanceof Error ? err.message : String(err);
        showStatusNotice(t('tree.node.loadFailed', { name: node.name, message }));
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
    {#if caretReplaced}
      <!-- 图标替代 caret（spec §3.3）：展开变体随本行状态切换，单一图标位不并存 -->
      <FileIcon kind={expanded ? 'folderExpanded' : 'folder'} name={node.name} />
    {:else}
      <span class="vv-tree-caret">{node.kind === 'dir' ? (expanded ? '▾' : '▸') : ''}</span>
      {#if iconEnabled}
        <!-- 文件行 file / 目录行 folder（folderNames 命中名回 _folder；Seti 无
             folder 图标 → null 不渲染，目录维持纯 caret） -->
        <FileIcon kind={node.kind === 'dir' ? 'folder' : 'file'} name={node.name} />
      {/if}
    {/if}
    <span class="vv-tree-name">{node.name}</span>
  </button>
  {#if node.kind === 'dir' && expanded && children}
    <ul class="vv-tree" role="group">
      {#each children as child (child.path)}
        <Self {store} {excludedPatterns} node={child} depth={depth + 1} iconEnabled={iconEnabled} {onopen} />
      {/each}
    </ul>
  {/if}
</li>
