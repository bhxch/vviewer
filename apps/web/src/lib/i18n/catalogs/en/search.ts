// catalogs/en/search.ts — search 域 en 目录（Task 9 域 F）：键集与 zh 全等、逐 key
// 占位符一致（聚合机检 ③④）。词汇表落点：搜索 Search、关闭 Close、连接 Connect、
// 服务器 Server。
export const domain = 'search' as const;

export const messages = {
  // —— 全局搜索面板壳 ——
  'search.panelAria': 'Global search',
  'search.placeholder': 'Search in opened folders',
  'search.inputAria': 'Global search query',
  'search.caseTitle': 'Match case',
  'search.regexTitle': 'Regular expression',
  'search.closeAria': 'Close global search',
  'search.closeTitle': 'Close (Esc)',

  // —— 状态条 ——
  'search.searching': 'Searching…',
  'search.scanned': 'Scanned {done} files…',
  'search.noResults': 'No results',
  'search.hitCount': '{n} matches',
  'search.truncatedSuffix': ' (results incomplete, limit reached)',
  'search.failed': 'Search failed',

  // —— 状态条提示 ——
  'search.degradedHint': 'Server ripgrep unavailable; fell back to in-browser search (may be slower)',
  'search.mountDegradedHint': 'This root cannot be searched server-side; switched to in-browser search',
  'search.serverHint': 'Scan limit reached (2000 files / 200MB total); connect a server from the tab bar to use server-side search',
  'search.engineGrepTitle': 'Degraded engine: no column positions, order not guaranteed, ERE dialect regex',
  'search.engineLabel': 'Server search: {engine}',
  'search.moreRows': 'Showing first {rows} of {total} matches',

  // —— globalSearch 路由纯层错误 ——
  'search.notConnected': 'Not connected to a server; remote search unavailable',

  // —— 文件内搜索面板 ——
  'search.infileAria': 'In-file search',
  'search.infilePlaceholder': 'Search (Enter for next)',
  'search.infileInputAria': 'Search query',
  'search.unsupportedView': 'This view does not support search',
  'search.prevAria': 'Previous match',
  'search.prevTitle': 'Previous (Shift+Enter)',
  'search.nextAria': 'Next match',
  'search.nextTitle': 'Next (Enter)',
  'search.closeSearchAria': 'Close search'
} as const;
