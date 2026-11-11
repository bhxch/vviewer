// catalogs/en/settings.ts — settings 域 en 目录（D15：全量覆盖，插值占位符与 zh
// 一致，聚合机检锁键集/占位符逐 key 相等）。词汇表（Global Constraints）：设置
// Settings/打开方式 Open with/渲染器 Renderer/字体 Font/主题 Theme/布局 Layout/
// 专注模式 Zen mode/刷新 Refresh/删除 Delete/确认 Confirm/取消 Cancel/排除
// Excluded/快速打开 Quick open/目录 Directory；语言名走原生名惯例（en 目录中
// 「简体中文」选项仍显示「简体中文」）。
export const domain = 'settings' as const;

export const messages = {
  // —— 通用（settings.common.*）——
  'settings.common.listSep': ', ',

  // —— 左导航组名（settings.nav.*）——
  'settings.nav.appearance': 'Appearance',
  'settings.nav.languageA11y': 'Language & accessibility',
  'settings.nav.fonts': 'Fonts',
  'settings.nav.code': 'Code view',
  'settings.nav.diagrams': 'Diagrams',
  'settings.nav.renderers': 'Open with',
  'settings.nav.layout': 'Layout',
  'settings.nav.search': 'Search & exclusions',
  'settings.nav.autorefresh': 'Auto-refresh',
  'settings.nav.compute': 'Compute',
  'settings.nav.storage': 'Storage & data',
  'settings.nav.about': 'About',

  // —— 中心骨架（settings.center.*）——
  'settings.center.title': 'Settings',
  'settings.center.viewForm': 'Form',
  'settings.center.dirty': 'Unapplied',
  'settings.center.apply': 'Apply',
  'settings.center.applyTitle': 'Apply (writes back and takes effect immediately)',
  'settings.center.discard': 'Discard',
  'settings.center.discardTitle': 'Discard unapplied changes',
  'settings.center.closeAria': 'Close settings',
  'settings.center.closeTitle': 'Close (Esc)',
  'settings.center.navAria': 'Settings groups',
  'settings.center.exportTitle': 'Export all settings to a JSON file (vviewer-settings-date.json)',
  'settings.center.export': 'Export…',
  'settings.center.importFileTitle': 'Import settings from a JSON file',
  'settings.center.import': 'Import…',
  'settings.center.jsonHint':
    'Full settings JSON (shares the draft with the form): form changes reflect here immediately; parsed and validated before apply — invalid input stays highlighted and the text is kept.',
  'settings.center.jsonAreaAria': 'Settings JSON',
  'settings.center.importModal': 'Import settings',
  'settings.center.noDiffs': 'The imported file has no differences from the current settings',
  'settings.center.mergeMode': 'Merge (missing keys keep current values)',
  'settings.center.replaceMode': 'Replace (overwrite everything with imported values)',
  'settings.center.assetsHint':
    'Import does not carry content assets such as themes/fonts (each has its own import channel)',
  'settings.center.importApply': 'Import and apply',
  'settings.center.cancel': 'Cancel',
  'settings.center.importErrorAria': 'Import settings error',
  'settings.center.importErrorTitle': 'Import failed (no changes applied)',
  'settings.center.close': 'Close',
  'settings.center.confirmAria': 'Unapplied changes',
  'settings.center.confirmText': 'You have unapplied changes',
  'settings.center.applyAndClose': 'Apply and close',
  'settings.center.discardAndClose': 'Discard and close',
  'settings.center.keepEditing': 'Keep editing',

  // —— JSON 视图语法错误（settings.json.*）——
  'settings.json.syntaxError': 'JSON syntax error{at}: {msg}',
  'settings.json.atLine': ' (near line {line})',

  // —— 校验问题文案（settings.issue.*）——
  'settings.issue.mustBeNumber': 'Must be a number',
  'settings.issue.outOfRange': 'Out of range {min}–{max}; will be clamped to {clamped}',
  'settings.issue.rootMustBeObject': 'Settings JSON must be an object',
  'settings.issue.unknownField': 'Unknown field (outside the allowlist; not persisted)',
  'settings.issue.mustBeOneOf': 'Must be one of {values}',
  'settings.issue.appearanceSlot': "Must be 'default', 'vscode:<builtin name>' or 'imported:<id>'",
  'settings.issue.mustBeStringTheme': 'Must be a string (theme key)',
  'settings.issue.mustBeStringArray': 'Must be an array of strings',
  'settings.issue.mustBeBoolean': 'Must be a boolean',
  'settings.issue.mustBeObject': 'Must be an object',
  'settings.issue.krokiHost': 'Must be an http(s):// URL or empty (empty = default service)',
  'settings.issue.krokiVia':
    "Must be 'client' or 'server' (client = direct from the frontend, server = relayed by the server)",
  'settings.issue.mermaidTheme':
    "Must be 'auto' (follows light/dark) or one of default / neutral / dark / forest / base",
  'settings.issue.unknownDiagramType': 'Unknown diagram type (not in the registry)',
  'settings.issue.diagramMode': 'Render mode must be one of {values}',
  'settings.issue.unsupportedRenderer': 'This type does not support that renderer',
  'settings.issue.fontFamily': 'Must be a string (family stack; empty string = default stack)',
  'settings.issue.iconTheme': "Must be one of 'none' / 'seti' / 'imported:<id>'",
  'settings.issue.layoutSanitized': 'Invalid or out of range; will be corrected to {value}',
  'settings.issue.rendererDefaultsShape': 'Must be an object (extension → renderer id)',
  'settings.issue.rendererExt': 'Keys must be lowercase extensions (no dot)',
  'settings.issue.rendererId': "Values must be renderer ids ('' = built-in default)",

  // —— 导入文件解析（settings.import.*）——
  'settings.import.notObject': 'The import file must be a JSON object',
  'settings.import.missingSchema': 'Missing schemaVersion; treated as the current version',
  'settings.import.badSchema': 'Invalid schemaVersion ({value}); treated as the current version',
  'settings.import.newerSchema':
    'The import file has a newer version (schemaVersion {version} > {current}); merging best-effort, compatibility risk possible',
  'settings.import.missingSettings': 'The import file is missing the settings object',
  'settings.import.unknownFieldWarn': '{path}: unknown field (outside the allowlist; not persisted)',

  // —— 「外观」节（settings.appearance.*）——
  'settings.appearance.modeLabel': 'Light-dark mode',
  'settings.appearance.modeRow': 'Theme mode',
  'settings.appearance.followSystem': 'Follow system',
  'settings.appearance.light': 'Light',
  'settings.appearance.dark': 'Dark',
  'settings.appearance.mismatchLightSlot':
    'The selected theme is dark and does not match the current light slot (it still applies)',
  'settings.appearance.mismatchDarkSlot':
    'The selected theme is light and does not match the current dark slot (it still applies)',
  'settings.appearance.modeHint':
    'The ⋯ tab-bar menu "Theme" quick-switch buttons write the same field; when following the system it resolves by the OS light-dark preference.',
  'settings.appearance.themeLabel': 'Appearance theme',
  'settings.appearance.themeHint':
    'VSCode appearance themes also take over code colors (light/dark remembered separately, following the tab-bar theme mode); the code theme select is disabled while non-default.',
  'settings.appearance.lightAria': 'Light appearance theme',
  'settings.appearance.darkAria': 'Dark appearance theme',
  'settings.appearance.optionLabel': '{name} ({kind})',
  'settings.appearance.kindDark': 'dark',
  'settings.appearance.kindLight': 'light',
  'settings.appearance.builtinDefault': 'Default',
  'settings.appearance.importBusy': 'Importing…',
  'settings.appearance.importTheme': 'Import themes…',
  'settings.appearance.importedCount': 'Imported ({count})',
  'settings.appearance.importedThemes': 'Imported {ok} themes',
  'settings.appearance.importedIconThemes': 'Imported {ok} icon themes',
  'settings.appearance.importedPartial': 'Imported {ok}, {failed} failed',
  'settings.appearance.importFailed': 'Import failed',
  'settings.appearance.deleteThemeConfirm': 'Delete imported theme "{name}"?',
  'settings.appearance.deleteIconThemeConfirm': 'Delete imported icon theme "{name}"?',
  'settings.appearance.ovsxPlaceholder': 'Install from Open VSX: publisher.extension or paste a link',
  'settings.appearance.ovsxInstallColorAria': 'Install a color theme from Open VSX',
  'settings.appearance.ovsxInstallIconAria': 'Install an icon theme from Open VSX',
  'settings.appearance.install': 'Install',
  'settings.appearance.installBusy': 'Installing…',
  'settings.appearance.ovsxInstalled': 'Installed {ok} themes from Open VSX',
  'settings.appearance.installedPartial': 'Installed {ok}, {failed} failed',
  'settings.appearance.ovsxInstallFailed': 'Open VSX install failed',
  'settings.appearance.ovsxUpdateFailed': 'Open VSX update failed',
  'settings.appearance.ovsxSourceTitle': 'Open VSX: {publisher}.{extension}',
  'settings.appearance.checkAllColorAria': 'Check all color themes for updates',
  'settings.appearance.checkAllIconAria': 'Check all icon themes for updates',
  'settings.appearance.checkAll': 'Check all',
  'settings.appearance.updateAria': 'Update theme {name} to {version}',
  'settings.appearance.updateIconAria': 'Update icon theme {name} to {version}',
  'settings.appearance.updateBusy': 'Updating…',
  'settings.appearance.updateTo': 'Update to {version}',
  'settings.appearance.checkAria': 'Check theme {name} for updates',
  'settings.appearance.checkIconAria': 'Check icon theme {name} for updates',
  'settings.appearance.checkBusy': 'Checking…',
  'settings.appearance.checkUpdate': 'Check for updates',
  'settings.appearance.deleteThemeAria': 'Delete imported theme {name}',
  'settings.appearance.deleteIconThemeAria': 'Delete imported icon theme {name}',
  'settings.appearance.deleteTitle': 'Delete',
  'settings.appearance.noThemes': 'No imported themes',
  'settings.appearance.noIconThemes': 'No imported icon themes',
  'settings.appearance.iconThemeLabel': 'Icon theme',
  'settings.appearance.iconRow': 'Theme',
  'settings.appearance.iconNone': 'None',
  'settings.appearance.iconOptionLabel': '{name} ({source})',
  'settings.appearance.iconHint':
    'Single-select and does not follow light-dark; shown in the file tree by default.',
  'settings.appearance.scopesAria': 'Icon theme visibility scopes',
  'settings.appearance.scopeAria': 'Icon theme visibility scope: {scope}',
  'settings.appearance.scopeTree': 'File tree',
  'settings.appearance.scopeTabs': 'Tab bar',
  'settings.appearance.scopeQuickOpen': 'Quick open',
  'settings.appearance.scopeSearch': 'Global search',
  'settings.appearance.importIconTheme': 'Import icon themes…',
  'settings.appearance.iconJsonHint':
    'JSON import requires selecting the theme manifest and font files (woff/woff2/ttf/otf) together; VSIX is unpacked automatically.',
  'settings.appearance.hasUpdate': '"{name}" has an update: {version} → {latest}',
  'settings.appearance.upToDate': '"{name}" is up to date ({latest})',
  'settings.appearance.noOvsx': 'No themes from Open VSX (locally imported ones have no update channel)',
  'settings.appearance.checkAllDonePartial':
    'All checks done ({total}): {updatable} updatable, {failed} failed',
  'settings.appearance.checkAllDone': 'All checks done ({total}): {updatable} updatable',
  'settings.appearance.updatedTo': 'Updated "{name}" to v{version}',
  'settings.appearance.codeThemeLabel': 'Code theme',
  'settings.appearance.highlightRow': 'Highlight colors',
  'settings.appearance.takeOverTitle':
    'Taken over by the appearance theme (switch back to "Default" in the appearance theme area to change)',

  // —— 「语言与辅助功能」节（settings.language.*，Task 3 首批）——
  'settings.language.label': 'Interface language',
  'settings.language.zhCN': '简体中文',
  'settings.language.en': 'English',
  'settings.language.hint':
    'UI text and git date formats follow the selected language; takes effect on "Apply".',

  // —— 「字体」节（settings.fonts.*）——
  'settings.fonts.label': 'Fonts',
  'settings.fonts.familyHint':
    'The family accepts comma-separated fallbacks (e.g. JetBrains Mono, monospace); fonts missing locally fall back via the browser.',
  'settings.fonts.uiFamilyRow': 'UI font',
  'settings.fonts.uiSelectAria': 'UI font family',
  'settings.fonts.uiCustomRow': 'UI custom',
  'settings.fonts.familyPlaceholder': 'Family names, comma-separated fallbacks',
  'settings.fonts.uiCustomAria': 'Custom UI font family',
  'settings.fonts.uiSizeRow': 'UI font size',
  'settings.fonts.uiSizeAria': 'UI font size (px)',
  'settings.fonts.codeFamilyRow': 'Code font',
  'settings.fonts.codeSelectAria': 'Code font family',
  'settings.fonts.codeCustomRow': 'Code custom',
  'settings.fonts.codeCustomAria': 'Custom code font family',
  'settings.fonts.codeSizeRow': 'Code font size',
  'settings.fonts.codeSizeAria': 'Code font size (px)',
  'settings.fonts.sizeHint':
    'Changing the code font size updates line height in lockstep; open files reflow at the new line height automatically.',
  'settings.fonts.webLabel': 'Web fonts',
  'settings.fonts.webHint':
    'https direct links or local upload of .ttf/.otf/.woff/.woff2 (single file ≤30MB); enabled fonts join the two slot dropdowns above, disabling removes them from the dropdowns (referenced slots fall back via the browser), and deletion does not keep them in IndexedDB.',
  'settings.fonts.urlAria': 'Web font URL',
  'settings.fonts.add': 'Add',
  'settings.fonts.namePlaceholder': 'Font name (optional; defaults to the URL last segment / file name)',
  'settings.fonts.nameAria': 'Web font name (optional)',
  'settings.fonts.busy': 'Working…',
  'settings.fonts.upload': 'Upload font…',
  'settings.fonts.enableAria': 'Enable web font {name}',
  'settings.fonts.deleteAria': 'Delete web font {name}',
  'settings.fonts.deleteTitle': 'Delete',
  'settings.fonts.retryAria': 'Retry adding web font {name}',
  'settings.fonts.retry': 'Retry',
  'settings.fonts.dismissAria': 'Ignore web font {name}',
  'settings.fonts.dismissTitle': 'Ignore',
  'settings.fonts.empty': 'No web fonts',
  'settings.fonts.added': 'Added font "{name}"',
  'settings.fonts.deleteConfirm': 'Delete web font "{name}"?',
  'settings.fonts.removedWithFallback':
    'Deleted "{name}"; {slots} fell back to the default font',
  'settings.fonts.removed': 'Deleted "{name}"',

  // —— 字体预设 label（settings.fonts.preset.*：fonts.ts 清单 label 键化——Task 10
  //    域 G；value（family 名）是存入 settings 的数据值不翻译，label 双侧同键；
  //    字体产品名双语并列保留原文，括注修饰语译英）——
  'settings.fonts.preset.systemUi': 'system-ui (default sans-serif)',
  'settings.fonts.preset.microsoftYaHei': '微软雅黑 Microsoft YaHei',
  'settings.fonts.preset.pingFangSc': 'PingFang SC',
  'settings.fonts.preset.notoSansCjkSc': 'Noto Sans CJK SC',
  'settings.fonts.preset.sourceHanSans': '思源黑体 Source Han Sans',
  'settings.fonts.preset.segoeUi': 'Segoe UI (Windows)',
  'settings.fonts.preset.roboto': 'Roboto (Android)',
  'settings.fonts.preset.helveticaNeue': 'Helvetica Neue (macOS)',
  'settings.fonts.preset.defaultMono': 'Default monospace stack',
  'settings.fonts.preset.jetbrainsMono': 'JetBrains Mono',
  'settings.fonts.preset.firaCode': 'Fira Code',
  'settings.fonts.preset.cascadiaCode': 'Cascadia Code (Windows 11)',
  'settings.fonts.preset.consolas': 'Consolas (Windows)',
  'settings.fonts.preset.menlo': 'Menlo (macOS)',
  'settings.fonts.preset.sfMono': 'SF Mono (macOS)',
  'settings.fonts.preset.sourceCodePro': 'Source Code Pro',
  'settings.fonts.preset.sarasaMonoSc': 'Sarasa Mono SC',
  'settings.fonts.preset.notoSansMonoCjkSc': 'Noto Sans Mono CJK SC',
  'settings.fonts.preset.default': 'Default',
  'settings.fonts.preset.custom': 'Custom…',
  'settings.fonts.preset.network': '{name} (network)',

  // —— 「代码视图」节（settings.code.*）——
  'settings.code.wordWrap': 'Word wrap',
  'settings.code.hint':
    'Long lines wrap within the view width instead of scrolling horizontally. Also toggle anytime via the code view status bar "Wrap" switch or Alt+Z.',
  'settings.code.themeGroupCurated': 'Curated',
  'settings.code.themeGroupAll': 'All',

  // —— 「图表」节（settings.diagrams.*）——
  'settings.diagrams.label': 'Diagrams',
  'settings.diagrams.krokiRow': 'Kroki service',
  'settings.diagrams.krokiAria': 'Kroki service URL',
  'settings.diagrams.krokiHint':
    'An http(s):// URL; leave empty for the default https://kroki.io. When the default service fails, plantuml/C4 fall back to the official PlantUML server automatically; custom URLs do not fall back.',
  'settings.diagrams.viaRow': 'Kroki channel',
  'settings.diagrams.viaAria': 'Kroki channel',
  'settings.diagrams.viaClient': 'Direct from browser',
  'settings.diagrams.viaServer': 'Relay via server',
  'settings.diagrams.viaHint':
    '"Relay via server" requires kroki forwarding on the deployment side: the option is disabled when disconnected or the capability is missing, and an existing selection falls back to "Direct from browser".',
  'settings.diagrams.mermaidRow': 'Mermaid theme',
  'settings.diagrams.mermaidAria': 'Mermaid theme',
  'settings.diagrams.mermaidAuto': 'Auto (follow light-dark)',
  'settings.diagrams.mermaidDefault': 'Default',
  'settings.diagrams.mermaidNeutral': 'Neutral',
  'settings.diagrams.mermaidDark': 'Dark',
  'settings.diagrams.mermaidForest': 'Forest',
  'settings.diagrams.mermaidBase': 'Base',
  'settings.diagrams.mermaidHint':
    '"Auto" follows the appearance light-dark; an explicit theme redraws open documents immediately.',
  'settings.diagrams.modesRow': 'Render mode',
  'settings.diagrams.rendererAria': '{id} renderer',
  'settings.diagrams.modeAria': '{id} render mode',
  'settings.diagrams.modeLocal': 'Local',
  'settings.diagrams.modeServer': 'Server',
  'settings.diagrams.modeOfficial': 'Official server',
  'settings.diagrams.modeSource': 'Source',
  'settings.diagrams.gridHint':
    'Each language lists only the modes it actually supports (options without a matching engine/channel do not appear). Local engines load from a CDN on demand (the d2 engine is heavy; Kroki by default); "Server" hands the diagram to the connected server, falling back to local/Kroki when disconnected or unsupported; "Official server" (plantuml/C4 only) renders against the official PlantUML server, falling back to Kroki on failure. graphviz optional renderers (viz-js default / hpcc); except Mermaid theme instant redraw, other changes apply to open documents after reopening.',

  // —— 「打开方式」节（settings.renderers.*）——
  'settings.renderers.label': 'Default renderer',
  'settings.renderers.selectAria': '.{ext} default renderer',
  'settings.renderers.builtinOption': '{label} (built-in default)',
  'settings.renderers.emptyHint': 'No formats with multiple renderers available.',
  'settings.renderers.hint':
    'Only formats with multiple renderers are listed. Changes apply to files opened afterwards; a single tab can still switch temporarily via the status bar or the tab context menu "Open with".',

  // —— 「布局」节（settings.layout.*）——
  'settings.layout.label': 'Layout',
  'settings.layout.hint':
    'Changes go into the draft and take effect on "Apply" (top right; the subscription chain refreshes the whole UI); pane collapsing and drag-resize take effect immediately in the UI, sharing the same stored fields as this section.',
  'settings.layout.tabBar': 'Show tab bar',
  'settings.layout.leftCollapse': 'Collapse file tree (left pane)',
  'settings.layout.rightCollapse': 'Collapse properties panel (right pane)',
  'settings.layout.leftWidthRow': 'Left pane width (px, {min}–{max})',
  'settings.layout.leftWidthAria': 'Left pane width (px)',
  'settings.layout.rightWidthRow': 'Right pane width (px, {min}–{max})',
  'settings.layout.rightWidthAria': 'Right pane width (px)',
  'settings.layout.zenLabel': 'Zen mode',
  'settings.layout.zenNote':
    'The current draft is in Zen mode (overrides tab bar/two-pane display); other layout fields keep their values.',
  'settings.layout.zenResetAria': 'Reset Zen mode',
  'settings.layout.zenReset': 'Reset Zen mode (applies on Apply)',
  'settings.layout.zenHint':
    'Zen mode is entered via the context menu or the mobile floating button; this section only provides the reset.',

  // —— 「搜索与排除」节（settings.search.*）——
  'settings.search.label': 'Excluded patterns',
  'settings.search.hint':
    'Files/directories whose names match are hidden from the file tree and Quick open (e.g. .git, node_modules; *.log excludes all .log files).',
  'settings.search.removeAria': 'Delete excluded pattern {pattern}',
  'settings.search.deleteTitle': 'Delete',
  'settings.search.empty': 'No excluded patterns',
  'settings.search.placeholder': 'Add a name or *.suffix',
  'settings.search.addAria': 'Add excluded pattern',
  'settings.search.add': 'Add',
  'settings.search.presetAria': 'Add preset excluded pattern {pattern}',

  // —— 「自动刷新」节（settings.autorefresh.*）——
  'settings.autorefresh.label': 'Auto-refresh',
  'settings.autorefresh.hint':
    'Content changes re-read automatically while connected to a server; when off, file tree sync is disabled — use the tab bar ↻ to manually refresh the current file and the file tree.',

  // —— 「计算」节（settings.compute.*）——
  'settings.compute.row': 'Compute policy',
  'settings.compute.selectAria': 'Compute policy',
  'settings.compute.selectTitle':
    'Compute policy: whether highlighting and other compute runs locally or on the server',
  'settings.compute.auto': 'Compute: auto',
  'settings.compute.local': 'Compute: local',
  'settings.compute.remote': 'Compute: remote',
  'settings.compute.hint':
    'Whether highlighting and other compute runs locally or on the server: auto = remote files prefer remote compute (falls back to local on failure); local/remote are explicit. Takes effect on the next compute call.',

  // —— 「存储与数据」节（settings.storage.*）——
  'settings.storage.label': 'Storage & data',
  'settings.storage.hint':
    'The browser "Clear site data" wipes the whole site; this section deletes by category, paired with the usage display in the "About" section to locate usage.',
  'settings.storage.usageLink': 'View storage usage →',
  'settings.storage.thresholdRow': 'Remote download confirm threshold',
  'settings.storage.thresholdAria': 'Remote download confirm threshold (MB)',
  'settings.storage.thresholdHint':
    'Downloads from remote sources above this threshold (MB, 1–4096) ask for confirmation first: the confirm card shows file name/size/target renderer and memory impact, and the pump starts only after confirming (informed consent, no separate hard cap); downloads of unknown size (indeterminate) are exempt. Takes effect for the next download right after "Apply".',
  'settings.storage.catSettings': 'Settings',
  'settings.storage.catSettingsDesc':
    'localStorage (appearance/fonts/diagrams/layout/excluded patterns and all other settings)',
  'settings.storage.catSessions': 'Session snapshots',
  'settings.storage.catSessionsDesc': 'IndexedDB kv (tabs/workspace layout)',
  'settings.storage.catDirhandle': 'Directory grants',
  'settings.storage.catDirhandleDesc':
    'IndexedDB kv (auto-restore credentials for localfs sources)',
  'settings.storage.catThemes': 'Imported themes',
  'settings.storage.catThemesDesc': 'IndexedDB themes ({count} records)',
  'settings.storage.catIconThemes': 'Imported icon themes',
  'settings.storage.catIconThemesDesc': 'IndexedDB iconThemes ({count} records)',
  'settings.storage.catFonts': 'Web fonts',
  'settings.storage.catFontsDesc': 'IndexedDB fonts ({count} records)',
  'settings.storage.catMounts': 'Mount configuration',
  'settings.storage.catMountsDesc': 'A directory mount management page is planned (coming soon)',
  'settings.storage.catMountsDisabledTitle':
    'Directory mount management (Spec 5) not implemented; nothing to purge yet',
  'settings.storage.catRuntime': 'Runtime cache',
  'settings.storage.catRuntimeDesc':
    'Cache Storage (runtime cache for syntax wasm/media etc.; precache kept)',
  'settings.storage.purge': 'Purge',
  'settings.storage.usageCaches': '{count} caches',
  'settings.storage.consequenceSettings':
    'Deletes all settings and reloads the page: light-dark mode/appearance/code theme/icon theme/fonts/diagrams/layout/excluded patterns/auto-refresh/compute policy all fall back to defaults.',
  'settings.storage.consequenceSessions':
    'Deletes tab and workspace snapshots: the current in-memory session is unaffected and the next start is an empty session; directory grants are kept.',
  'settings.storage.consequenceDirhandle':
    'Deletes directory grant handles: localfs sources no longer auto-restore on the next start and need re-granting; the snapshot restore fallback chain stays as is.',
  'settings.storage.consequenceThemes':
    'Deletes all imported themes: appearance slots referencing them fall back to "Default" (effective immediately, no reload); built-in themes are unaffected. Single deletion is in the "Appearance" section.',
  'settings.storage.consequenceIconThemes':
    'Deletes all imported icon themes: theme slots referencing them fall back to "None" (effective immediately, no reload); the built-in Seti is unaffected. Single deletion is in the "Appearance" section.',
  'settings.storage.consequenceFonts':
    'Deletes all web fonts and unregisters them: slots referencing them fall back to the default font stack (effective immediately). Single deletion is in the "Fonts" section.',
  'settings.storage.consequenceMounts':
    'Mount configuration management is not yet available (a directory mount management page is planned).',
  'settings.storage.consequenceRuntime':
    'Clears the runtime cache (syntax wasm/media etc.): precache is kept and offline capability is unaffected.',
  'settings.storage.consequenceFactory':
    'Factory reset: deletes all settings, session snapshots, directory grants, imported themes, imported icon themes and web fonts, clears all caches (including offline precache), unregisters the Service Worker and reloads the page. This cannot be undone.',
  'settings.storage.purgeSettings': 'Purge settings',
  'settings.storage.purgeSessions': 'Purge session snapshots',
  'settings.storage.purgeDirhandle': 'Purge directory grants',
  'settings.storage.purgeThemes': 'Delete imported themes',
  'settings.storage.purgeIconThemes': 'Delete imported icon themes',
  'settings.storage.purgeFonts': 'Delete web fonts',
  'settings.storage.purgeMounts': 'Purge mount configuration',
  'settings.storage.purgeRuntime': 'Purge runtime cache',
  'settings.storage.factory': 'Factory reset',
  'settings.storage.confirmAria': 'Confirm {label}',
  'settings.storage.factoryConfirmLabel': '⚠ Factory reset',
  'settings.storage.purging': 'Purging…',
  'settings.storage.confirmFactory': 'Confirm factory reset (irreversible)',
  'settings.storage.confirmPurge': 'Confirm purge',
  'settings.storage.cancel': 'Cancel',
  'settings.storage.factoryHint':
    'A fallback action separate from the category list: all categories + unregister the Service Worker + clear all caches + reload.',
  'settings.storage.factoryButton': 'Factory reset…',
  'settings.storage.counting': 'Counting…',
  'settings.storage.refreshStats': 'Refresh stats',
  'settings.storage.factoryDone':
    'Factory reset done (cleared {caches} caches, unregistered {sw} Service Workers); reloading…',
  'settings.storage.runtimePurged': 'Cleared {count} runtime caches (precache kept)',
  'settings.storage.itemsPurged': 'Cleared {count} items',
  'settings.storage.purgeFailed': 'Purge failed: {message}',

  // —— 「关于」节（settings.about.*）——
  'settings.about.projectLabel': 'Project info',
  'settings.about.appKey': 'App',
  'settings.about.frontendKey': 'Frontend version',
  'settings.about.devBuild': 'Development build',
  'settings.about.serverKey': 'Server version',
  'settings.about.notConnected': 'Not connected',
  'settings.about.mismatch': 'Frontend ({front}) and server ({server}) versions differ',
  'settings.about.capsKey': 'Capabilities',
  'settings.about.engineKey': 'Search engine',
  'settings.about.notDeclared': 'Not declared',
  'settings.about.rootsKey': 'Data roots',
  'settings.about.rootsCount': '{count}',
  'settings.about.repoKey': 'Repository',
  'settings.about.licenseKey': 'License',
  'settings.about.noticesKey': 'Third-party notices',
  'settings.about.usageLabel': 'Storage usage & quota',
  'settings.about.quotaHint':
    'The quota is a browser estimate (Chrome is coarse-grained, Firefox reports about 10% of disk); to free space, see',
  'settings.about.storageLink': 'Storage & data →',
  'settings.about.usedQuotaKey': 'Used / quota',
  'settings.about.noQuotaHint':
    'The current browser does not support quota estimation (only local estimates are shown).',
  'settings.about.lsKey': 'localStorage estimate',
  'settings.about.kvKey': 'IndexedDB · kv (sessions/handles)',
  'settings.about.themesKey': 'IndexedDB · themes (imported themes)',
  'settings.about.iconThemesKey': 'IndexedDB · iconThemes (imported icon themes)',
  'settings.about.fontsKey': 'IndexedDB · fonts (web fonts)',
  'settings.about.mountsKey': 'IndexedDB · mounts (mount configuration)',
  'settings.about.mountsDisabled': 'Not available',
  'settings.about.recordsBytes': '{records} records · {bytes}',
  'settings.about.refresh': 'Refresh',
  'settings.about.persistLabel': 'Persistent storage',
  'settings.about.statusKey': 'Status',
  'settings.about.persisted': 'Persisted',
  'settings.about.notPersisted':
    'Not persisted (best-effort; may be cleared when disk is tight)',
  'settings.about.noPersistHint':
    'The current browser does not support persistent storage queries.',
  'settings.about.persistHint':
    'Persistence is origin-level: one request protects the whole origin (fonts/themes/session snapshots/offline cache); it is also attempted silently when a font is added successfully.',
  'settings.about.requestPersist': 'Request persistent storage',
  'settings.about.persistGranted':
    'Persistent storage granted: fonts/themes/session snapshots/offline cache are no longer evicted under disk pressure',
  'settings.about.persistDenied':
    'Not granted: the browser decides heuristically (site engagement/notifications/installing as a PWA raise the grant rate) — installing as a PWA usually persists automatically'
} as const satisfies Record<`${typeof domain}.${string}`, string>;
