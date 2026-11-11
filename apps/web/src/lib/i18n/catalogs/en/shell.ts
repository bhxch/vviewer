// catalogs/en/shell.ts — shell 域 en 目录（D15：全量覆盖，插值占位符与 zh 一致，
// 聚合机检锁键集/占位符逐 key 相等）。词汇表（Global Constraints）：专注模式
// Zen mode/属性 Properties/文件夹 Folder/连接 Connect/服务器 Server。
export const domain = 'shell' as const;

export const messages = {
  // —— zen 进出提示（shell.zen.*）——
  'shell.zen.toastDesktop': 'Entered Zen mode: press Esc or Ctrl+Alt+Z to exit',
  'shell.zen.toastMobile': 'Entered Zen mode: tap ✕ in the bottom-right corner or press Back to exit',
  'shell.zen.exit': 'Exit Zen mode',

  // —— chrome 右键菜单（shell.chrome.*）——
  'shell.chrome.hideTabbar': 'Hide tab bar',
  'shell.chrome.showTabbar': 'Show tab bar',
  'shell.chrome.exitZen': 'Exit Zen mode',
  'shell.chrome.enterZen': 'Enter Zen mode',

  // —— 状态栏一次性提示（shell.notice.*）——
  'shell.notice.noReopenable': 'No tabs to reopen',

  // —— 折叠竖条（shell.strip.*）——
  'shell.strip.expandTree': 'Expand file tree',
  'shell.strip.treeIcon': 'Tree',
  'shell.strip.collapseTree': 'Collapse file tree',
  'shell.strip.expandMeta': 'Expand properties panel',
  'shell.strip.collapseMeta': 'Collapse properties panel',

  // —— 移动端抽屉头部 zen 入口（shell.drawer.*）——
  'shell.drawer.zen': 'Zen mode',

  // —— 0 目录空态引导区（shell.empty.*）——
  // "No folder opened" shared by all three shells (Task 10 item 7): search/quickopen reuse this key
  'shell.empty.title': 'No folder opened',
  'shell.empty.openFolder': 'Open folder',
  'shell.empty.connectServer': 'Connect to server',
  'shell.empty.urlPlaceholder': 'Paste file URL',
  'shell.empty.urlAria': 'File URL',
  'shell.empty.open': 'Open',
  'shell.empty.dragHint': 'You can also drag files/folders here directly',

  // —— 中缝调宽把手（shell.colhandle.*）——
  'shell.colhandle.treeAria': 'Resize file tree',
  'shell.colhandle.metaAria': 'Resize properties panel',
  'shell.colhandle.title': 'Drag to resize (double-click to reset)',

  // —— 右面板分段切换器 / 抽屉浮钮（shell.right.* / shell.drawerToggle.*）——
  'shell.right.switchAria': 'Right panel view switch',
  'shell.right.toc': 'Contents',
  'shell.right.meta': 'Properties',
  'shell.drawerToggle.aria': 'Toggle sidebar',
  'shell.rightToggle.aria': 'Toggle contents and properties panels'
} as const satisfies Record<`${typeof domain}.${string}`, string>;
