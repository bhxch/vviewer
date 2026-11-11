// catalogs/zh-CN/git.ts — git 域目录（Task 9 域 F：Git 信息面板）。覆盖 GitSection/
// GitDiffView 组件面、gitUi 纯层（相对时间/subject 兜底/blame 未提交 author）、
// gitClient 主线程错误面、gitFs 适配层错误面、gitWorker 错误码映射目标键（Worker
// 内零 i18n——worker 以 GitWorkerErrorCode 枚举上行，gitClient.WORKER_ERROR_KEYS
// 按码映射到本域键，主线程事件时刻 t() 翻译）。zh 值与被移除字面量逐字节等价
// （D7）。日志面（console）串不入目录——已英文化（Task 4 I-1 推广政策）。
export const domain = 'git' as const;

export const messages = {
  // —— GitSection 面板壳（aria 与可见标题分立：可见 h2 'Git' 为非 CJK 零改动）——
  'git.title': 'Git 信息',
  'git.loading': '正在读取 git 信息…',
  'git.retry': '重试',
  'git.clientUnavailable': 'git 客户端不可用',
  'git.clientUnavailableSsr': 'git 客户端不可用（非浏览器环境）',

  // —— 信息卡字段行（dl dt）——
  'git.field.branch': '分支',
  'git.field.status': '状态',
  'git.field.lastCommit': '末次提交',
  'git.field.author': '作者',
  'git.field.time': '时间',
  'git.field.subject': '说明',
  'git.field.committer': '提交者',

  // —— 信息卡值（分支/状态行）——
  'git.detachedHead': '（游离 HEAD）',
  'git.unavailable': '不可用',
  'git.status.clean': '无改动',
  'git.status.modified': '已修改',
  'git.status.untracked': '未跟踪',
  'git.noCommit.untracked': '无（未跟踪文件）',

  // —— blame 说明行（{limit} 同名双现——interpolate replaceAll 双现替换）——
  'git.blameHint': '悬停代码行可查看提交归属；文件历史超 {limit} 提交仅最近 {limit} 参与归属。',

  // —— diff 折叠钮（base 与三态模式标注拼接）——
  'git.diffLabel.base': '差异',
  'git.diffLabel.untracked': '（未跟踪文件无 diff）',
  'git.diffLabel.worktreeVsHead': '（工作区 vs HEAD）',
  'git.diffLabel.headVsParent': '（末次提交 HEAD^ vs HEAD）',

  // —— diff 提示态（GitDiffUiState empty note）——
  'git.diffEmpty.untracked': '未跟踪文件无 diff（HEAD 树无此路径）',
  'git.diffEmpty.noPath': 'HEAD 树无此路径',
  'git.diffEmpty.notInCommit': '该提交树内无此文件',

  // —— GitDiffView（ready 态零行/截断尾注——尾注移至 UI 层拼装，unifiedDiff 纯函数
  // 不再产文案：gitDiff.ts 被 worker 打包，零 i18n import 约束）——
  'git.diff.computing': '正在计算 diff…',
  'git.diff.noChanges': '内容无差异（仅行尾/编码差异按归一口径不显示）',
  'git.diff.truncatedNote': 'diff 过大已截断（上限 {rows} 行 / {kb}KB），仅显示前段',

  // —— 文件历史 log ——
  'git.log.title': '文件历史',
  'git.log.loading': '正在加载历史…',
  'git.log.empty': '无历史（未跟踪文件）',
  'git.log.truncated': '仅显示最近 {n} 条',
  'git.log.authorTime': '{author}（{time}）',

  // —— gitUi 纯层：subject 兜底 / 相对时间（M-3）/ blame 未提交 author 哨兵显示值 ——
  'git.subjectNone': '（无说明）',
  'git.rel.now': '刚刚',
  'git.rel.minutes': '{n} 分钟前',
  'git.rel.hours': '{n} 小时前',
  'git.rel.days': '{n} 天前',
  'git.blame.uncommitted': '（未提交）',

  // —— gitClient 主线程错误面（reject message 经 GitSection 错误行上屏）——
  'git.canceled': 'git 请求已取消',
  'git.client.scriptLoadFailed': '脚本加载失败',
  'git.client.workerError': 'worker 错误：{message}{file}',
  'git.client.errorFile': '（{file}）',
  'git.client.msgDeserializeFailed': 'worker 消息反序列化失败（onmessageerror）',
  'git.client.unavailable': 'git worker 不可用：{reason}',
  'git.client.unavailablePost': 'git worker 不可用：postMessage 失败（worker 已终止？）',
  'git.client.fsNoAdapter': 'fs 供数无登记：请求已结算或未知（requestId={id}）',

  // —— gitFs 适配层错误面（ENOENT 转写经 isogit 探测链常被消化，但 log/blame 非
  // NotFound 上抛路径会经 worker error 帧回屏——上屏链路存在即进目录，Task 8 口径）——
  'git.fs.enoent': 'git fs ENOENT: {path}{detail}',
  'git.fs.causeDetail': '（{message}）',
  'git.fs.pathEscape': 'git fs 路径越界（逃出仓库根）: {p}',
  'git.fs.pathEscapeCause': '路径越界',
  'git.fs.encoding': 'git fs readFile 不支持的 encoding: {encoding}',
  'git.fs.readlinkCause': 'store 无符号链接语义，git fs readlink 不可用',
  'git.fs.writeBanned': 'git fs 只读承诺：{name} 不可用',
  'git.fs.dirListSuffix': '（目录列表失败）',
  'git.fs.readlinkUnavailable': 'git fs readlink 不可用',

  // —— gitWorker 错误码映射目标键（WORKER_ERROR_KEYS 消费；worker 文件零 i18n，
  // 枚举/参数上行后此处翻译；zh 值与被移除的 worker 字面量逐字节等价）——
  'git.worker.unknownOp': '未知 git 请求 kind: {kind}',
  'git.worker.fsWriteBanned': 'git fs 只读承诺：worker 侧 {name} 不可用',
  'git.worker.badFsReplyRead': 'fs read 回帧缺 data',
  'git.worker.badFsReplyStat': 'fs stat 回帧缺 stat',
  'git.worker.badFsReplyEntries': 'fs readdir 回帧缺 entries'
} as const;
