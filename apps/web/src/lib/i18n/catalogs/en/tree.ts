// catalogs/en/tree.ts — tree 域 en 目录（D15：全量覆盖，插值占位符与 zh 一致，
// 聚合机检锁键集/占位符逐 key 相等）。词汇表（Global Constraints）：目录 Directory。
export const domain = 'tree' as const;

export const messages = {
  // —— FileTree 源行（tree.src.*）——
  'tree.src.loadFailed': 'Failed to load source {label}: {message}',
  'tree.src.removeConfirm':
    'All tabs under this source will be closed, and the source "{name}" will be removed from the current workspace. Continue?',
  'tree.src.toggleAria': 'Collapse/expand {label}',
  'tree.src.removeAria': 'Remove source {label}',
  'tree.src.removeTitle': 'Remove this source (closes all tabs under it)',

  // —— TreeNodeRow 递归行（tree.node.*）——
  'tree.node.loadFailed': 'Failed to load directory {name}: {message}'
} as const satisfies Record<`${typeof domain}.${string}`, string>;
