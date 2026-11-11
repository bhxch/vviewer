// catalogs/zh-CN/tree.ts — tree 域目录（Task 5 域 B：文件树源行 FileTree +
// 递归行 TreeNodeRow——源级折叠/移除入口、源移除 confirm、目录加载失败状态栏
// 提示）。zh 值与被移除字面量逐字节等价（D7；Task 2 aria 终值基线：源行
// role=treeitem + aria-expanded 上行，行内钮 aria-label「折叠/展开 {label}」
// 「移除来源 {label}」沿旧）。域目录契约（Interfaces 钉死）：key 三段
// `{域}.{模块}.{语义}`，satisfies 锁首段。
export const domain = 'tree' as const;

export const messages = {
  // —— FileTree 源行（tree.src.*）——
  'tree.src.loadFailed': '来源 {label} 加载失败：{message}',
  'tree.src.removeConfirm': '将关闭该来源下全部 tab，并从当前工作区移除来源「{name}」，确定？',
  'tree.src.toggleAria': '折叠/展开 {label}',
  'tree.src.removeAria': '移除来源 {label}',
  'tree.src.removeTitle': '移除该来源（将关闭该来源下全部 tab）',

  // —— TreeNodeRow 递归行（tree.node.*，BUG-24 状态栏提示通道）——
  'tree.node.loadFailed': '目录 {name} 加载失败：{message}'
} as const satisfies Record<`${typeof domain}.${string}`, string>;
