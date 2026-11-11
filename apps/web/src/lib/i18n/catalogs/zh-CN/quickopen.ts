// catalogs/zh-CN/quickopen.ts — quickopen 域目录（Task 5 域 B：Ctrl+P 快速打开
// 面板 QuickOpenPanel——容器/输入/关闭钮/状态行，+ 纯逻辑模块 quickOpen.ts 的
// 扫描告警文案（onWarn → 面板状态行透出，显示面）。zh 值与被移除字面量逐字节
// 等价（D7）。域目录契约（Interfaces 钉死）：key 三段 `{域}.{模块}.{语义}`，
// satisfies 锁首段。
export const domain = 'quickopen' as const;

export const messages = {
  // —— 面板容器 / 输入 / 关闭钮（quickopen.panel.* / quickopen.input.* / quickopen.close.*）——
  'quickopen.panel.aria': '快速打开',
  'quickopen.input.placeholder': '输入文件名过滤，↑↓ 选择，Enter 打开',
  'quickopen.input.aria': '快速打开文件',
  'quickopen.close.aria': '关闭快速打开',
  'quickopen.close.title': '关闭（Esc）',

  // —— 状态行（quickopen.status.*，aria-live=polite）——
  'quickopen.status.noFolder': '未打开文件夹',
  'quickopen.status.listing': '正在列出文件…',
  'quickopen.status.partial': '部分目录无法列出（{count} 个已跳过）：{message}',
  'quickopen.status.listFailed': '列出文件失败：{message}',
  'quickopen.status.noMatch': '无匹配文件',

  // —— 扫描告警（quickopen.warn.*，quickOpen.ts onWarn，BUG-27 降级透出面）——
  'quickopen.warn.listFailed': '目录 {path} 列举失败：{message}'
} as const satisfies Record<`${typeof domain}.${string}`, string>;
