// catalogs/en/viewer.ts — viewer 域 en 目录（D15：全量覆盖，插值占位符与 zh 一致，
// 聚合机检锁键集/占位符逐 key 相等）。词汇表（Global Constraints）：打开方式
// Open with/关闭 Close/删除 Delete/取消 Cancel/渲染器 Renderer/字体 Font/主题
// Theme/下载 Download/属性 Properties/重试 Retry。另存为 Save as 与 tabs.ctx
// （Task 4 交付形态）同词；「自动（按扩展名）」Auto (by extension) 与
// tabs.ctx.autoRenderer 同词（同一候选首项三壳一致的词汇表口径）。
export const domain = 'viewer' as const;

export const messages = {
  // —— registry label（20 组 foreign 渲染器）——
  'viewer.renderer.foreign-email': 'Email',
  'viewer.renderer.foreign-epub': 'Ebook',
  'viewer.renderer.foreign-ofd': 'OFD document',
  'viewer.renderer.foreign-chm': 'CHM help document',
  'viewer.renderer.foreign-word': 'Word document (layout)',
  'viewer.renderer.foreign-presentation': 'Presentation',
  'viewer.renderer.foreign-spreadsheet': 'Spreadsheet',
  'viewer.renderer.foreign-iwork': 'iWork document',
  'viewer.renderer.foreign-hangul': 'Hangul document',
  'viewer.renderer.foreign-wordperfect': 'WordPerfect document',
  'viewer.renderer.foreign-data': 'Data & fonts',
  'viewer.renderer.foreign-design': 'Adobe design',
  'viewer.renderer.foreign-image': 'Extended images',
  'viewer.renderer.foreign-geo': 'Geospatial data',
  'viewer.renderer.foreign-typst': 'Typst typesetting',
  'viewer.renderer.foreign-dicom': 'DICOM imaging',
  'viewer.renderer.foreign-signature': 'E-signatures',
  'viewer.renderer.foreign-eda': 'EDA circuits',
  'viewer.renderer.foreign-drawing': 'Draw.io diagrams',
  'viewer.renderer.foreign-midi': 'MIDI music',

  // —— 打开方式候选面 ——
  'viewer.openwith.auto': 'Auto (by extension)',
  'viewer.openwith.more': 'More renderers…',
  'viewer.openwith.less': 'Collapse extra candidates',
  'viewer.openwith.menuAria': 'Open with',

  // —— 状态栏 ——
  'viewer.statusbar.openwithLabel': 'Open with',
  'viewer.statusbar.openwithAria': 'Open with: {label}',
  'viewer.statusbar.openwithAriaExt': 'Open with: {label} ({ext})',
  'viewer.statusbar.openwithTitle': 'Open with (click to switch renderer)',
  'viewer.statusbar.exec': 'Exec: {where}',
  'viewer.statusbar.wrapTitle': 'Word wrap (Alt+Z)',
  'viewer.statusbar.wrapOn': 'Wrap: on',
  'viewer.statusbar.wrapOff': 'Wrap: off',
  'viewer.statusbar.watchMountUnsupported': 'Change push not supported for this source',
  'viewer.statusbar.watchDegraded': 'Auto-refresh unavailable',

  // —— 状态栏引擎指示器 ——
  'viewer.engine.pending': 'Highlight: parsing…',
  'viewer.engine.treeSitter': 'Highlight: tree-sitter',
  'viewer.engine.hljs': 'Highlight: hljs fallback',
  'viewer.engine.hljsBlock': 'Highlight: hljs chunked',
  'viewer.engine.plain': 'Plain text',
  'viewer.engine.mdLocal': 'Render: local',
  'viewer.engine.mdRemote': 'Render: remote',

  // —— 计算执行位置 ——
  'viewer.compute.remote': 'remote',
  'viewer.compute.local': 'local',

  // —— 状态栏元数据段 ——
  'viewer.statusMeta.lang': 'Language: {lang}',
  'viewer.statusMeta.encoding': 'Encoding: {encoding}',
  'viewer.statusMeta.size': 'Size: {size}',
  'viewer.statusMeta.lines': 'Lines: {lines}',

  // —— 属性面板行 ——
  'viewer.meta.title': 'Properties',
  'viewer.meta.empty': 'No file opened',
  'viewer.meta.nameRow': 'Name',
  'viewer.meta.openWithRow': 'Open with',
  'viewer.meta.openWithAria': 'Open with',
  'viewer.meta.sizeRow': 'Size',
  'viewer.meta.sizeBytes': '{size} bytes',
  'viewer.meta.encodingRow': 'Encoding',
  'viewer.meta.langRow': 'Language',
  'viewer.meta.linesRow': 'Lines',
  'viewer.meta.sourceRow': 'Source',

  // —— 语言行/语言轻入口 ——
  'viewer.lang.auto': 'Auto',
  'viewer.lang.autoDetect': 'Auto (detected {lang})',
  'viewer.lang.autoDetected': 'Auto ({lang})',
  'viewer.lang.manual': '{lang} (manual)',
  'viewer.lang.badgeManual': '(manual)',
  'viewer.lang.inputAria': 'Highlight language (leave empty for auto-detect)',
  'viewer.lang.entry': 'Language: {text}',

  // —— blame hover 浮层 ——
  'viewer.blame.loading': 'Computing line attribution…',
  'viewer.blame.uncommitted': 'Uncommitted working-tree change',
  'viewer.blame.truncated': 'File history exceeds {limit} commits; only the most recent {limit} participate in attribution',

  // —— 下载确认卡 rendererLabel 兜底 ——
  'viewer.confirm.autodetectExt': 'Auto-detected (by extension)',
  'viewer.confirm.autodetect': 'Auto-detected',

  // —— 下载进度/完成态卡 ——
  'viewer.dl.done': 'Download complete',
  'viewer.dl.active': 'Downloading',
  'viewer.dl.totalLine': 'Total {total}',
  'viewer.dl.saveAs': 'Save as',
  'viewer.dl.close': 'Close',
  'viewer.dl.progressAria': 'Download progress',
  'viewer.dl.cancel': 'Cancel',
  'viewer.dl.etaPending': 'Calculating',
  'viewer.dl.etaRemaining': '{eta} remaining',
  'viewer.dl.loadedLine': 'Downloaded {loaded} / {total}',
  'viewer.dl.loadedLineUnknown': 'Downloaded {loaded} (total size unknown)',
  'viewer.dl.etaSeconds': '{n} s',
  'viewer.dl.etaMinutes': '{m} min',
  'viewer.dl.etaMinSec': '{m} min {r} s',
  'viewer.dl.etaHours': '{h} h',
  'viewer.dl.etaHourMin': '{h} h {m} min',
  'viewer.dl.directWriteFailed': 'Failed to open the direct write stream; fell back to normal download',

  // —— 另存为 ——
  'viewer.save.denied': 'Save as not completed: the browser declined the file save request',
  'viewer.save.noFsWrite': 'Direct file-handle writes are not supported in this environment (no showSaveFilePicker)',

  // —— 装配层远端计算错误 ——
  'viewer.remote.diagramNoServer': 'Not connected to a server; server-side diagram rendering unavailable',
  'viewer.remote.diagramHttp': 'Server-side diagram rendering failed: HTTP {status}',
  'viewer.remote.mdNoServer': 'Not connected to a server; remote markdown rendering unavailable',
  'viewer.remote.mdHttp': 'Remote markdown rendering failed: HTTP {status}',
  'viewer.remote.mdFailed': 'Markdown rendering failed',

  // —— 嵌套附件合成来源显示名 ——
  'viewer.nested.storeLabel': 'Nested attachment',

  // —— foreign 桥接错误面 ——
  'viewer.foreign.noHandler': 'file-viewer renderer has no ".{ext}" handler ({name})',
  'viewer.foreign.shpGuard':
    'Shapefile needs sibling .shx/.dbf/.prj sidecar files, which a single-file source cannot provide; open it from a folder containing them instead',

  // —— 数据检查器 ——
  'viewer.inspector.title': 'Data inspector',
  'viewer.inspector.endiannessAria': 'Byte order',
  'viewer.inspector.little': 'Little-endian',
  'viewer.inspector.big': 'Big-endian',

  // —— 导出动作区 ——
  'viewer.export.title': 'Export',
  'viewer.export.html': 'Export HTML',
  'viewer.export.pdf': 'Export PDF',
  'viewer.export.snapshotUnavailable': 'Export snapshot unavailable; reopen the file and try again',
  'viewer.export.htmlDone': 'HTML exported',
  'viewer.export.htmlFailed': 'HTML export failed: {message}',
  'viewer.export.printUnavailable': 'Printing cannot be invoked in this environment; use the browser menu to print and save as PDF',
  'viewer.export.printStarted': 'System print dialog invoked; choose "Save as PDF" in the dialog',
  'viewer.export.pdfFailed': 'PDF export failed: {message}',

  // —— 查看器空态 ——
  'viewer.empty.drop': 'Drop files/folders here, or open via the ＋ button in the tab bar',
  'viewer.empty.unrestorable': 'This source cannot be restored automatically; reopen the folder',
  'viewer.empty.directory': 'Directory source: open files from the tree on the left',

  // —— 下载确认卡（viewer.confirm.*：DownloadConfirmCard——Task 10 域 G 收尾；
  //    取消钮与进度卡同词复用 viewer.dl.cancel）——
  'viewer.confirm.title': 'Confirm download',
  'viewer.confirm.size': 'Size {size}',
  'viewer.confirm.renderer': 'Target renderer: {renderer}',
  'viewer.confirm.impact':
    'The file will be fully read into memory during download; very large files may cause lag or memory pressure.',
  'viewer.confirm.start': 'Start download',
  'viewer.confirm.saveAs': 'Download and save as',

  // —— 代码大纲（viewer.outline.*：OutlineView + outlineTruncate 文案常量迁移；
  //    kind 展示名键分支——kind 是 tags.scm 捕获稳定标识符，未收录词形显示原词）——
  'viewer.outline.aria': 'Code outline',
  'viewer.outline.truncated': 'Outline exceeds {limit} entries; showing the first {limit}',
  'viewer.outline.expandAll': 'Expand all',
  'viewer.outline.kind.function': 'Function',
  'viewer.outline.kind.method': 'Method',
  'viewer.outline.kind.class': 'Class',
  'viewer.outline.kind.struct': 'Struct',
  'viewer.outline.kind.interface': 'Interface',
  'viewer.outline.kind.enum': 'Enum',
  'viewer.outline.kind.type': 'Type',
  'viewer.outline.kind.module': 'Module',
  'viewer.outline.kind.namespace': 'Namespace',
  'viewer.outline.kind.constant': 'Constant',
  'viewer.outline.kind.variable': 'Variable',
  'viewer.outline.kind.property': 'Property',
  'viewer.outline.kind.field': 'Field',
  'viewer.outline.kind.macro': 'Macro',
  'viewer.outline.kind.union': 'Union',
  'viewer.outline.kind.trait': 'Trait',
  'viewer.outline.kind.object': 'Object',
  'viewer.outline.kind.constructor': 'Constructor',
  'viewer.outline.kind.section': 'Section',
  'viewer.outline.kind.name': 'Symbol',

  // —— 右栏目录（viewer.toc.*，Toc.svelte）——
  'viewer.toc.aria': 'Table of contents',
  'viewer.toc.empty': 'No headings'
} as const satisfies Record<`${typeof domain}.${string}`, string>;
