// catalogs/zh-CN/viewer.ts — viewer 域目录（Task 7 域 D：查看器 ViewerPane/
// MetaPanel/DownloadProgressCard/DownloadConfirmCard rendererLabel 兜底 + 纯层
// foreignRenderers（registry label 经 getter 派生）/viewer.ts 装配错误面/
// saveAs/openWith/downloadProgress + errors 域注入的渲染失败兜底文案）。
// zh 值与被移除字面量逐字节等价（D7）。域目录契约（Interfaces 钉死）：key 三段
// `{域}.{模块}.{语义}`，satisfies 锁首段。
// registry label（20 组 foreign 渲染器）为 D8 重点审计面：label 曾因 label-keyed
// each 撞名在 Svelte 5 prod 整页 500（each_key_duplicate）——现全部经 id 派生显示
// （消费点读 getter 现 t()），each key 一律渲染器 id（foreignRenderers.ts）。
export const domain = 'viewer' as const;

export const messages = {
  // —— registry label（viewer.renderer.*，20 组 foreign 渲染器，id 即键尾）——
  'viewer.renderer.foreign-email': '邮件',
  'viewer.renderer.foreign-epub': '电子书',
  'viewer.renderer.foreign-ofd': 'OFD 版式文档',
  'viewer.renderer.foreign-chm': 'CHM 帮助文档',
  'viewer.renderer.foreign-word': 'Word 文档（版式还原）',
  'viewer.renderer.foreign-presentation': '演示文稿',
  'viewer.renderer.foreign-spreadsheet': '电子表格',
  'viewer.renderer.foreign-iwork': 'iWork 文档',
  'viewer.renderer.foreign-hangul': 'Hangul 文档',
  'viewer.renderer.foreign-wordperfect': 'WordPerfect 文档',
  'viewer.renderer.foreign-data': '数据与字体',
  'viewer.renderer.foreign-design': 'Adobe 设计',
  'viewer.renderer.foreign-image': '扩展图片',
  'viewer.renderer.foreign-geo': '地理数据',
  'viewer.renderer.foreign-typst': 'Typst 排版',
  'viewer.renderer.foreign-dicom': 'DICOM 影像',
  'viewer.renderer.foreign-signature': '电子签名',
  'viewer.renderer.foreign-eda': 'EDA 电路',
  'viewer.renderer.foreign-drawing': 'Draw.io 图表',
  'viewer.renderer.foreign-midi': 'MIDI 音乐',

  // —— 打开方式候选面（viewer.openwith.*：状态栏浮层/MetaPanel 下拉/openWith.ts 首项）——
  'viewer.openwith.auto': '自动（按扩展名）',
  'viewer.openwith.more': '更多渲染器…',
  'viewer.openwith.less': '收起附加候选',
  'viewer.openwith.menuAria': '打开方式',

  // —— 状态栏（viewer.statusbar.*）——
  'viewer.statusbar.openwithLabel': '打开方式',
  'viewer.statusbar.openwithAria': '打开方式: {label}',
  'viewer.statusbar.openwithAriaExt': '打开方式: {label}（{ext}）',
  'viewer.statusbar.openwithTitle': '打开方式（点击切换渲染器）',
  'viewer.statusbar.exec': '执行: {where}',
  'viewer.statusbar.wrapTitle': '自动换行（Alt+Z）',
  'viewer.statusbar.wrapOn': '换行: 开',
  'viewer.statusbar.wrapOff': '换行: 关',
  'viewer.statusbar.watchMountUnsupported': '此源不支持变更推送',
  'viewer.statusbar.watchDegraded': '自动刷新不可用',

  // —— 状态栏引擎指示器（viewer.engine.*：code 五态 + markdown 两态）——
  'viewer.engine.pending': '高亮: 解析中…',
  'viewer.engine.treeSitter': '高亮: tree-sitter',
  'viewer.engine.hljs': '高亮: hljs 兜底',
  'viewer.engine.hljsBlock': '高亮: hljs 分块',
  'viewer.engine.plain': '纯文本',
  'viewer.engine.mdLocal': '渲染: 本地',
  'viewer.engine.mdRemote': '渲染: 远程',

  // —— 计算执行位置（viewer.compute.*，M6 状态栏段）——
  'viewer.compute.remote': '远程',
  'viewer.compute.local': '本地',

  // —— 状态栏元数据段（viewer.statusMeta.*，BUG-04「语言 · 编码 · 大小 · 行」）——
  'viewer.statusMeta.lang': '语言: {lang}',
  'viewer.statusMeta.encoding': '编码: {encoding}',
  'viewer.statusMeta.size': '大小: {size}',
  'viewer.statusMeta.lines': '行: {lines}',

  // —— 属性面板行（viewer.meta.*，MetaPanel）——
  'viewer.meta.title': '属性',
  'viewer.meta.empty': '未打开文件',
  'viewer.meta.nameRow': '名称',
  'viewer.meta.openWithRow': '打开方式',
  'viewer.meta.openWithAria': '打开方式',
  'viewer.meta.sizeRow': '大小',
  'viewer.meta.sizeBytes': '{size} 字节',
  'viewer.meta.encodingRow': '编码',
  'viewer.meta.langRow': '语言',
  'viewer.meta.linesRow': '行数',
  'viewer.meta.sourceRow': '来源',

  // —— 语言行/语言轻入口（viewer.lang.*：MetaPanel 语言行 + ViewerPane 浮层尾项）——
  'viewer.lang.auto': '自动',
  'viewer.lang.autoDetect': '自动（检测 {lang}）',
  'viewer.lang.autoDetected': '自动（{lang}）',
  'viewer.lang.manual': '{lang}（手动）',
  'viewer.lang.badgeManual': '（手动）',
  'viewer.lang.inputAria': '高亮语言（留空自动检测）',
  'viewer.lang.entry': '语言：{text}',

  // —— blame hover 浮层（viewer.blame.*，git-panel）——
  'viewer.blame.loading': '正在计算行归属…',
  'viewer.blame.uncommitted': '工作区未提交改动',
  'viewer.blame.truncated': '文件历史超 {limit} 提交，仅最近 {limit} 个参与归属',

  // —— 下载确认卡 rendererLabel 兜底（viewer.confirm.*，残余 A3 中性文案）——
  'viewer.confirm.autodetectExt': '自动识别（按扩展名）',
  'viewer.confirm.autodetect': '自动识别',

  // —— 下载进度/完成态卡（viewer.dl.*：DownloadProgressCard + downloadProgress.ts）——
  'viewer.dl.done': '下载完成',
  'viewer.dl.active': '正在下载',
  'viewer.dl.totalLine': '共 {total}',
  'viewer.dl.saveAs': '另存为',
  'viewer.dl.close': '关闭',
  'viewer.dl.progressAria': '下载进度',
  'viewer.dl.cancel': '取消',
  'viewer.dl.etaPending': '计算中',
  'viewer.dl.etaRemaining': '剩余 {eta}',
  'viewer.dl.loadedLine': '已下载 {loaded} / {total}',
  'viewer.dl.loadedLineUnknown': '已下载 {loaded}（总大小未知）',
  'viewer.dl.etaSeconds': '{n} 秒',
  'viewer.dl.etaMinutes': '{m} 分',
  'viewer.dl.etaMinSec': '{m} 分 {r} 秒',
  'viewer.dl.etaHours': '{h} 小时',
  'viewer.dl.etaHourMin': '{h} 小时 {m} 分',
  'viewer.dl.directWriteFailed': '直写落盘通道开启失败，已降级为普通下载',

  // —— 另存为（viewer.save.*：saveAs.ts 纯层单源）——
  'viewer.save.denied': '另存为未完成：浏览器拒绝了文件保存请求',
  'viewer.save.noFsWrite': '当前环境不支持文件句柄直写（无 showSaveFilePicker）',

  // —— 装配层远端计算错误（viewer.remote.*：viewer.ts diagramFileRemoteCall/remoteMarkdown）——
  'viewer.remote.diagramNoServer': '未连接服务器，无法服务端渲染图表',
  'viewer.remote.diagramHttp': '服务端图表渲染失败: HTTP {status}',
  'viewer.remote.mdNoServer': '未连接服务器，无法远程渲染 markdown',
  'viewer.remote.mdHttp': '远程 markdown 渲染失败: HTTP {status}',
  'viewer.remote.mdFailed': 'markdown 渲染失败',

  // —— 嵌套附件合成来源显示名（viewer.nested.*：viewer.ts foreignNestedDispatch）——
  'viewer.nested.storeLabel': '嵌套附件',

  // —— foreign 桥接错误面（viewer.foreign.*：foreignRenderers.ts）——
  'viewer.foreign.noHandler': 'file-viewer 渲染器无 ".{ext}" 处理器（{name}）',
  'viewer.foreign.shpGuard':
    'Shapefile 需同目录的 .shx/.dbf/.prj 边车文件，单文件来源无法读取；请改用包含这些文件的文件夹方式打开',

  // —— 数据检查器（viewer.inspector.*，MetaPanel hex 区块）——
  'viewer.inspector.title': '数据检查器',
  'viewer.inspector.endiannessAria': '字节序',
  'viewer.inspector.little': '小端',
  'viewer.inspector.big': '大端',

  // —— 导出动作区（viewer.export.*，MetaPanel）——
  'viewer.export.title': '导出',
  'viewer.export.html': '导出 HTML',
  'viewer.export.pdf': '导出 PDF',
  'viewer.export.snapshotUnavailable': '导出快照不可用，请重新打开文件后再试',
  'viewer.export.htmlDone': '已导出 HTML',
  'viewer.export.htmlFailed': '导出 HTML 失败：{message}',
  'viewer.export.printUnavailable': '当前环境无法唤起打印，请改用浏览器菜单打印并另存为 PDF',
  'viewer.export.printStarted': '已唤起系统打印，请在对话框中选择「另存为 PDF」',
  'viewer.export.pdfFailed': '导出 PDF 失败：{message}',

  // —— 查看器空态（viewer.empty.*，ViewerPane）——
  'viewer.empty.drop': '拖入文件/文件夹，或用标签栏 ＋ 打开',
  'viewer.empty.unrestorable': '此来源无法自动恢复，请重新打开文件夹',
  'viewer.empty.directory': '目录来源：文件在左侧树中打开',

  // —— 下载确认卡（viewer.confirm.*，DownloadConfirmCard——Task 10 域 G 收尾；
  //    取消钮与进度卡同词复用 viewer.dl.cancel）——
  'viewer.confirm.title': '确认下载',
  'viewer.confirm.size': '大小 {size}',
  'viewer.confirm.renderer': '目标渲染器：{renderer}',
  'viewer.confirm.impact': '下载期间文件将全量读入内存，超大文件可能造成卡顿或内存压力。',
  'viewer.confirm.start': '开始下载',
  'viewer.confirm.saveAs': '下载并另存为',

  // —— 代码大纲（viewer.outline.*：OutlineView + outlineTruncate 文案常量迁移；
  //    kind 展示名键分支——kind 是 tags.scm 捕获稳定标识符，未收录词形显示原词）——
  'viewer.outline.aria': '代码大纲',
  'viewer.outline.truncated': '大纲超过 {limit} 条，仅显示前 {limit} 条',
  'viewer.outline.expandAll': '全部展开',
  'viewer.outline.kind.function': '函数',
  'viewer.outline.kind.method': '方法',
  'viewer.outline.kind.class': '类',
  'viewer.outline.kind.struct': '结构体',
  'viewer.outline.kind.interface': '接口',
  'viewer.outline.kind.enum': '枚举',
  'viewer.outline.kind.type': '类型',
  'viewer.outline.kind.module': '模块',
  'viewer.outline.kind.namespace': '命名空间',
  'viewer.outline.kind.constant': '常量',
  'viewer.outline.kind.variable': '变量',
  'viewer.outline.kind.property': '属性',
  'viewer.outline.kind.field': '字段',
  'viewer.outline.kind.macro': '宏',
  'viewer.outline.kind.union': '联合',
  'viewer.outline.kind.trait': '特质',
  'viewer.outline.kind.object': '对象',
  'viewer.outline.kind.constructor': '构造函数',
  'viewer.outline.kind.section': '小节',
  'viewer.outline.kind.name': '符号',

  // —— 右栏目录（viewer.toc.*，Toc.svelte）——
  'viewer.toc.aria': '目录',
  'viewer.toc.empty': '无标题'
} as const satisfies Record<`${typeof domain}.${string}`, string>;
