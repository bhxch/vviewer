// zh-CN.ts — 扩展 i18n 目录（中文侧）。spec H T2。
//
// key 纪律（沿 docs/design/frontend-conventions.md §3.1）：三段 `{域}.{模块}.{语义}`；
// 域为扩展自有四域（shell / viewer / notice / errors）——**不复用 apps/web 的 12 域全集**
// （扩展是独立运行时，无目录树/标签栏/设置中心等面对应域）。
//
// 占位符纪律：占位符 `{name}` 双侧同名；未提供的占位符保留原样（漏参可发现）。
//
// 本文件在 ESLint 覆盖块的 ignores 内（apps/vscode/src/i18n/**）——catalog 本体含 CJK
// 键值是合法的「直读点」，其余消费方一律经 i18n/core 门面。
export const zhCN = {
  // shell —— webview 壳（内容区 / toc 面板 / 顶部提示条）
  'shell.panel.tocTitle': '目录',
  'shell.panel.tocToggle': '目录面板',
  'shell.panel.tocEmpty': '本文档没有目录',
  'shell.panel.engineBadge': '高亮引擎：{engine}',
  'shell.engine.workerFailed': '高亮引擎不可用，已降级为 hljs（{reason}）',
  'shell.engine.initTimeout': '高亮引擎初始化超时，已降级为 hljs',
  'shell.engine.noGrammar': '语言 {lang} 无本地 grammar，已降级为 hljs',

  // viewer —— 文档渲染面
  'viewer.document.tooLarge': '文件超过 {limit}，建议改用 VSCode 原生编辑器打开',
  'viewer.document.loading': '正在加载…',
  'viewer.document.reload': '重新渲染',
  'viewer.document.openWithNative': '用 VSCode 原生编辑器打开',

  // notice —— 一次性反馈（顶部提示条）
  'notice.export.saved': '已导出到 {path}',
  'notice.export.failed': '导出失败：{reason}',
  'notice.export.cancelled': '已取消导出',
  'notice.file.missing': '找不到文件：{path}',

  // errors —— 错误面
  'errors.render.failed': '渲染失败',
  'errors.file.readFailed': '读取文件失败',
  'errors.export.failed': '导出失败',
  'errors.link.openExternalFailed': '无法打开外部链接',
  'errors.common.unknown': '发生未知错误'
} as const;
