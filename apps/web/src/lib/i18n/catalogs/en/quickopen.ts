// catalogs/en/quickopen.ts — quickopen 域 en 目录（D15：全量覆盖，插值占位符与
// zh 一致，聚合机检锁键集/占位符逐 key 相等）。词汇表（Global Constraints）：
// 快速打开 Quick open/文件夹 Folder/关闭 Close/打开 Open。
export const domain = 'quickopen' as const;

export const messages = {
  // —— 面板容器 / 输入 / 关闭钮（quickopen.panel.* / quickopen.input.* / quickopen.close.*）——
  'quickopen.panel.aria': 'Quick open',
  'quickopen.input.placeholder': 'Type a file name to filter, ↑↓ to select, Enter to open',
  'quickopen.input.aria': 'Quick open file',
  'quickopen.close.aria': 'Close quick open',
  'quickopen.close.title': 'Close (Esc)',

  // —— 状态行（quickopen.status.*）——
  'quickopen.status.listing': 'Listing files…',
  'quickopen.status.partial': 'Some directories could not be listed ({count} skipped): {message}',
  'quickopen.status.listFailed': 'Failed to list files: {message}',
  'quickopen.status.noMatch': 'No matching files',

  // —— 扫描告警（quickopen.warn.*）——
  'quickopen.warn.listFailed': 'Failed to list directory {path}: {message}'
} as const satisfies Record<`${typeof domain}.${string}`, string>;
