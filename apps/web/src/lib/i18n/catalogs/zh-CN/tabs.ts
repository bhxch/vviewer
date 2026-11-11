// catalogs/zh-CN/tabs.ts — tabs 域目录（Task 4 域 A：标签栏融合菜单/TabBar 右键
// 菜单与滚动箭头/工作区子菜单列表/占位 tab 恢复文案）。zh 值与被移除字面量逐字节
// 等价（D7；Task 2 aria 终值基线：触发钮 aria-label 动态「工作区：{name}」）。
// 域目录契约（Interfaces 钉死）：key 三段 `{域}.{模块}.{语义}`，satisfies 锁首段。
export const domain = 'tabs' as const;

export const messages = {
  // —— TabBar 右键菜单（tabs.ctx.*）——
  'tabs.ctx.close': '关闭',
  'tabs.ctx.closeOthers': '关闭其他',
  'tabs.ctx.closeRight': '关闭右侧',
  'tabs.ctx.unpin': '取消固定',
  'tabs.ctx.pin': '固定',
  'tabs.ctx.duplicate': '复制标签页',
  'tabs.ctx.reopen': '重新打开已关闭标签',
  'tabs.ctx.openWith': '打开方式',
  'tabs.ctx.moreRenderers': '更多渲染器',
  'tabs.ctx.autoRenderer': '自动（按扩展名）',
  'tabs.ctx.lang': '语言：{lang}（在属性面板中修改）',
  'tabs.ctx.langManual': '{lang}（手动）',
  'tabs.ctx.langAuto': '自动',
  'tabs.ctx.saveAs': '另存为',
  'tabs.ctx.saveAsFetching': '正在拉取全量以另存为…',
  'tabs.ctx.saveAsConfirm': '「{name}」约 {size}，超过远端下载确认阈值：确认后开始拉取并另存。继续？',
  'tabs.ctx.saveAsSaved': '已另存为 {name}',
  'tabs.ctx.saveAsFailed': '另存为失败：{message}',

  // —— TabBar 滚动箭头 / 管理钮（tabs.arrow.* / tabs.manage.*）——
  'tabs.arrow.left': '向左滚动标签',
  'tabs.arrow.right': '向右滚动标签',
  'tabs.manage.aria': '管理标签',
  'tabs.manage.title': '管理所有工作区的标签（Alt+W）',

  // —— TabBarMenu 融合菜单（tabs.menu.*）——
  'tabs.menu.triggerAria': '工作区：{name}',
  'tabs.menu.workspaceFallback': '工作区',
  'tabs.menu.triggerTitle': '工作区与全局功能菜单',
  'tabs.menu.workspace': '工作区',
  'tabs.menu.open': '打开',
  'tabs.menu.openFile': '打开文件',
  'tabs.menu.openFolder': '打开文件夹',
  'tabs.menu.pasteUrl': '粘贴 URL',
  'tabs.menu.urlPlaceholder': '粘贴文件 URL',
  'tabs.menu.urlAria': '文件 URL',
  'tabs.menu.urlSubmit': '打开',
  'tabs.menu.refresh': '刷新当前文件',
  'tabs.menu.refreshTitle': '手动刷新当前文件与目录树（快捷键 Ctrl+, 打开设置可关自动刷新）',
  'tabs.menu.connectServer': '连接服务器',
  'tabs.menu.theme': '主题',
  'tabs.menu.themeSystem': '跟随系统',
  'tabs.menu.themeLight': '亮',
  'tabs.menu.themeDark': '暗',
  'tabs.menu.mounts': '目录管理',
  'tabs.menu.mountsTitle': '目录管理（Ctrl+Alt+M）：服务端挂载 / 前端直连与代理 / 本机授权',
  'tabs.menu.settings': '设置',
  'tabs.menu.settingsTitle': '设置（Ctrl+,）：外观 / 字体 / 图表 / 搜索与排除 / 自动刷新 / 计算',
  'tabs.menu.zenExit': '退出专注模式',
  'tabs.menu.zenEnter': '进入专注模式',
  'tabs.menu.zenExitTitle': '退出专注模式（Esc 或 Ctrl+Alt+Z）',
  'tabs.menu.zenEnterTitle': '专注模式（Ctrl+Alt+Z）：隐藏标签栏与两侧面板，进入后按 Esc 或 Ctrl+Alt+Z 退出',
  'tabs.menu.zenExitText': '退出专注',
  'tabs.menu.zenEnterText': '专注',

  // —— WorkspaceList 工作区子菜单（tabs.ws.*）——
  'tabs.ws.deleteConfirm': '删除工作区「{name}」？将关闭其全部 tab。',
  'tabs.ws.renameAria': '重命名工作区',
  'tabs.ws.renameConfirmAria': '确认重命名',
  'tabs.ws.renameConfirmTitle': '确认（Enter）',
  'tabs.ws.renameCancelAria': '取消重命名',
  'tabs.ws.renameCancelTitle': '取消（Esc）',
  'tabs.ws.renameItemAria': '重命名工作区 {name}',
  'tabs.ws.renameItemTitle': '重命名',
  'tabs.ws.deleteItemAria': '删除工作区 {name}',
  'tabs.ws.deleteItemTitle': '删除（将关闭其全部 tab）',
  'tabs.ws.create': '＋ 新建工作区…',

  // —— tabsModel 占位 tab / SSE 变更提示（tabs.model.*）——
  'tabs.model.placeholderRemote': '服务器 {host} 的文件，重连后可恢复（会话不保留服务器文件内容）',
  'tabs.model.placeholderLocal': '会话中的本地文件需要重新打开（浏览器不保留文件内容）',
  'tabs.model.sseChanged': '文件已变更：{name}'
} as const satisfies Record<`${typeof domain}.${string}`, string>;
