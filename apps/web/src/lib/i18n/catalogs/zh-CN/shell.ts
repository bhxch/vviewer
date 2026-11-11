// catalogs/zh-CN/shell.ts — shell 域目录（Task 4 域 A：AppShell 壳层——zen 进出
// 提示/chrome 右键菜单/折叠竖条与抽屉浮钮/0 目录空态引导区/调宽把手/右面板切换器）。
// zh 值与被移除字面量逐字节等价（D7）。域目录契约（Interfaces 钉死）：key 三段
// `{域}.{模块}.{语义}`，satisfies 锁首段。
export const domain = 'shell' as const;

export const messages = {
  // —— zen 进出提示（shell.zen.*）——
  'shell.zen.toastDesktop': '已进入专注模式：按 Esc 或 Ctrl+Alt+Z 退出',
  'shell.zen.toastMobile': '已进入专注模式：点右下角 ✕ 或按返回键退出',
  'shell.zen.exit': '退出专注模式',

  // —— chrome 右键菜单（shell.chrome.*）——
  'shell.chrome.hideTabbar': '隐藏标签栏',
  'shell.chrome.showTabbar': '显示标签栏',
  'shell.chrome.exitZen': '退出专注模式',
  'shell.chrome.enterZen': '进入专注模式',

  // —— 状态栏一次性提示（shell.notice.*）——
  'shell.notice.noReopenable': '没有可重新打开的标签页',

  // —— 折叠竖条（shell.strip.*）——
  'shell.strip.expandTree': '展开文件树',
  'shell.strip.treeIcon': '树',
  'shell.strip.collapseTree': '折叠文件树',
  'shell.strip.expandMeta': '展开属性面板',
  'shell.strip.collapseMeta': '折叠属性面板',

  // —— 移动端抽屉头部 zen 入口（shell.drawer.*）——
  'shell.drawer.zen': '专注模式',

  // —— 0 目录空态引导区（shell.empty.*）——
  // 「未打开文件夹」三壳同词并键（Task 10 移交项 7）：search/quickopen 状态条同词复用本键
  'shell.empty.title': '未打开文件夹',
  'shell.empty.openFolder': '打开文件夹',
  'shell.empty.connectServer': '连接服务器',
  'shell.empty.urlPlaceholder': '粘贴文件 URL',
  'shell.empty.urlAria': '文件 URL',
  'shell.empty.open': '打开',
  'shell.empty.dragHint': '也可直接拖入文件/文件夹',

  // —— 中缝调宽把手（shell.colhandle.*）——
  'shell.colhandle.treeAria': '调整文件树宽度',
  'shell.colhandle.metaAria': '调整属性面板宽度',
  'shell.colhandle.title': '拖拽调宽（双击重置）',

  // —— 右面板分段切换器 / 抽屉浮钮（shell.right.* / shell.drawerToggle.*）——
  'shell.right.switchAria': '右面板视图切换',
  'shell.right.toc': '目录',
  'shell.right.meta': '属性',
  'shell.drawerToggle.aria': '切换侧栏',
  'shell.rightToggle.aria': '切换目录与属性面板'
} as const satisfies Record<`${typeof domain}.${string}`, string>;
