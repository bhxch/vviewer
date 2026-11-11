// catalogs/en/tabs.ts — tabs 域 en 目录（D15：全量覆盖，插值占位符与 zh 一致，
// 聚合机检锁键集/占位符逐 key 相等）。词汇表（Global Constraints）：标签页 Tab/
// 工作区 Workspace/打开方式 Open with/关闭 Close/固定 Pin/专注模式 Zen mode/
// 刷新 Refresh/挂载 Mount/服务器 Server/文件夹 Folder/渲染器 Renderer。
export const domain = 'tabs' as const;

export const messages = {
  // —— TabBar 右键菜单（tabs.ctx.*）——
  'tabs.ctx.close': 'Close',
  'tabs.ctx.closeOthers': 'Close others',
  'tabs.ctx.closeRight': 'Close right',
  'tabs.ctx.unpin': 'Unpin',
  'tabs.ctx.pin': 'Pin',
  'tabs.ctx.duplicate': 'Duplicate tab',
  'tabs.ctx.reopen': 'Reopen closed tab',
  'tabs.ctx.openWith': 'Open with',
  'tabs.ctx.moreRenderers': 'More renderers',
  'tabs.ctx.autoRenderer': 'Auto (by extension)',
  'tabs.ctx.lang': 'Language: {lang} (edit in Properties panel)',
  'tabs.ctx.langManual': '{lang} (manual)',
  'tabs.ctx.langAuto': 'Auto',
  'tabs.ctx.saveAs': 'Save as',
  'tabs.ctx.saveAsFetching': 'Fetching full content for save-as…',
  'tabs.ctx.saveAsConfirm':
    '"{name}" is about {size}, exceeding the remote download confirm threshold: fetching starts after confirmation, then saves as. Continue?',
  'tabs.ctx.saveAsSaved': 'Saved as {name}',
  'tabs.ctx.saveAsFailed': 'Save as failed: {message}',

  // —— TabBar 滚动箭头 / 管理钮（tabs.arrow.* / tabs.manage.*）——
  'tabs.arrow.left': 'Scroll tabs left',
  'tabs.arrow.right': 'Scroll tabs right',
  'tabs.manage.aria': 'Manage tabs',
  'tabs.manage.title': 'Manage tabs of all workspaces (Alt+W)',

  // —— TabBarMenu 融合菜单（tabs.menu.*）——
  'tabs.menu.triggerAria': 'Workspace: {name}',
  'tabs.menu.workspaceFallback': 'Workspace',
  'tabs.menu.triggerTitle': 'Workspace and global actions menu',
  'tabs.menu.workspace': 'Workspace',
  'tabs.menu.open': 'Open',
  'tabs.menu.openFile': 'Open file',
  'tabs.menu.openFolder': 'Open folder',
  'tabs.menu.pasteUrl': 'Paste URL',
  'tabs.menu.urlPlaceholder': 'Paste file URL',
  'tabs.menu.urlAria': 'File URL',
  'tabs.menu.urlSubmit': 'Open',
  'tabs.menu.refresh': 'Refresh current file',
  'tabs.menu.refreshTitle':
    'Manually refresh the current file and directory tree (shortcut Ctrl+, opens Settings where auto refresh can be turned off)',
  'tabs.menu.connectServer': 'Connect to server',
  'tabs.menu.theme': 'Theme',
  'tabs.menu.themeSystem': 'Follow system',
  'tabs.menu.themeLight': 'Light',
  'tabs.menu.themeDark': 'Dark',
  'tabs.menu.mounts': 'Mounts',
  'tabs.menu.mountsTitle': 'Mounts (Ctrl+Alt+M): server mount / frontend direct & proxy / local authorization',
  'tabs.menu.settings': 'Settings',
  'tabs.menu.settingsTitle':
    'Settings (Ctrl+,): appearance / fonts / diagrams / search & exclusions / auto refresh / compute',
  'tabs.menu.zenExit': 'Exit Zen mode',
  'tabs.menu.zenEnter': 'Enter Zen mode',
  'tabs.menu.zenExitTitle': 'Exit Zen mode (Esc or Ctrl+Alt+Z)',
  'tabs.menu.zenEnterTitle':
    'Zen mode (Ctrl+Alt+Z): hides the tab bar and side panels; press Esc or Ctrl+Alt+Z to exit',
  'tabs.menu.zenExitText': 'Exit zen',
  'tabs.menu.zenEnterText': 'Zen',

  // —— WorkspaceList 工作区子菜单（tabs.ws.*）——
  'tabs.ws.deleteConfirm': 'Delete workspace "{name}"? All of its tabs will be closed.',
  'tabs.ws.renameAria': 'Rename workspace',
  'tabs.ws.renameConfirmAria': 'Confirm rename',
  'tabs.ws.renameConfirmTitle': 'Confirm (Enter)',
  'tabs.ws.renameCancelAria': 'Cancel rename',
  'tabs.ws.renameCancelTitle': 'Cancel (Esc)',
  'tabs.ws.renameItemAria': 'Rename workspace {name}',
  'tabs.ws.renameItemTitle': 'Rename',
  'tabs.ws.deleteItemAria': 'Delete workspace {name}',
  'tabs.ws.deleteItemTitle': 'Delete (closes all of its tabs)',
  'tabs.ws.create': '＋ New workspace…',

  // —— tabsModel 占位 tab / SSE 变更提示（tabs.model.*）——
  'tabs.model.placeholderRemote':
    'File from server {host}, recoverable after reconnect (the session does not retain server file contents)',
  'tabs.model.placeholderLocal':
    'Local files in the session need to be reopened (the browser does not retain file contents)',
  'tabs.model.sseChanged': 'File changed: {name}'
} as const satisfies Record<`${typeof domain}.${string}`, string>;
