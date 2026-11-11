// catalogs/zh-CN/search.ts — search 域目录（Task 9 域 F：搜索——全局跨文件搜索面板
// + 文件内搜索面板 + globalSearch 路由纯层提示/错误串）。「未打开文件夹」（Task 5
// 遗留 M 面）入 search.noFolder。zh 值与被移除字面量逐字节等价（D7）。globalSearch
// 的两个提示常量改函数（挂载时刻锁 locale 问题，Task 7/8 裁决同款），键落本域。
export const domain = 'search' as const;

export const messages = {
  // —— 全局搜索面板壳（GlobalSearchPanel）——
  'search.panelAria': '全局搜索',
  'search.placeholder': '在打开的文件夹中搜索',
  'search.inputAria': '全局搜索内容',
  'search.caseTitle': '区分大小写',
  'search.regexTitle': '正则表达式',
  'search.closeAria': '关闭全局搜索',
  'search.closeTitle': '关闭（Esc）',

  // —— 状态条（aria-live：搜索中/进度/摘要/错误/未打开目录）——
  'search.noFolder': '未打开文件夹',
  'search.searching': '搜索中…',
  'search.scanned': '已扫描 {done} 个文件…',
  'search.noResults': '无结果',
  'search.hitCount': '{n} 个命中',
  'search.truncatedSuffix': '（结果不完整，已达上限）',
  'search.failed': '搜索失败',

  // —— 状态条提示（降级/引擎徽标/引导）——
  'search.degradedHint': '服务器 ripgrep 不可用，已改用浏览器内搜索（可能较慢）',
  'search.mountDegradedHint': '该根不可服务端搜索，已切换浏览器内搜索',
  'search.serverHint': '已触达扫描上限（2000 文件 / 200MB 累计），建议在标签栏连接服务器后使用服务器端搜索',
  'search.engineGrepTitle': '降级引擎：无列定位、结果顺序不保证、正则为 ERE 方言',
  'search.engineLabel': '服务端搜索：{engine}',
  'search.moreRows': '仅显示前 {rows} 条（共 {total} 条）',

  // —— globalSearch 路由纯层错误（throw → 面板 status 上屏）——
  'search.notConnected': '未连接服务器，无法远程搜索',

  // —— 文件内搜索面板（SearchPanel；区分大小写/关闭（Esc）与全局面板同值同键复用）——
  'search.infileAria': '文件内搜索',
  'search.infilePlaceholder': '搜索（Enter 下一个）',
  'search.infileInputAria': '搜索内容',
  'search.unsupportedView': '此视图不支持搜索',
  'search.prevAria': '上一个',
  'search.prevTitle': '上一个（Shift+Enter）',
  'search.nextAria': '下一个',
  'search.nextTitle': '下一个（Enter）',
  'search.closeSearchAria': '关闭搜索'
} as const;
