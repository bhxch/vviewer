// catalogs/en/git.ts — git 域 en 目录（Task 9 域 F）：键集与 zh 全等、逐 key 占位符
// 一致（聚合机检 ③④）。词汇表落点：重试 Retry。
export const domain = 'git' as const;

export const messages = {
  // —— GitSection 面板壳 ——
  'git.title': 'Git info',
  'git.loading': 'Reading git info…',
  'git.retry': 'Retry',
  'git.clientUnavailable': 'git client unavailable',
  'git.clientUnavailableSsr': 'git client unavailable (not a browser environment)',

  // —— 信息卡字段行 ——
  'git.field.branch': 'Branch',
  'git.field.status': 'Status',
  'git.field.lastCommit': 'Last commit',
  'git.field.author': 'Author',
  'git.field.time': 'Time',
  'git.field.subject': 'Message',
  'git.field.committer': 'Committer',

  // —— 信息卡值 ——
  'git.detachedHead': '(detached HEAD)',
  'git.unavailable': 'Unavailable',
  'git.status.clean': 'No changes',
  'git.status.modified': 'Modified',
  'git.status.untracked': 'Untracked',
  'git.noCommit.untracked': 'None (untracked file)',

  // —— blame 说明行 ——
  'git.blameHint': 'Hover a code line to view commit attribution; when file history exceeds {limit} commits only the latest {limit} participate.',

  // —— diff 折叠钮 ——
  'git.diffLabel.base': 'Diff',
  'git.diffLabel.untracked': '(untracked file, no diff)',
  'git.diffLabel.worktreeVsHead': '(worktree vs HEAD)',
  'git.diffLabel.headVsParent': '(HEAD^ vs HEAD)',

  // —— diff 提示态 ——
  'git.diffEmpty.untracked': 'No diff for untracked file (path missing from HEAD tree)',
  'git.diffEmpty.noPath': 'Path missing from HEAD tree',
  'git.diffEmpty.notInCommit': 'File missing from this commit tree',

  // —— GitDiffView ——
  'git.diff.computing': 'Computing diff…',
  'git.diff.noChanges': 'No content changes (line-ending/encoding-only differences are normalized away)',
  'git.diff.truncatedNote': 'Diff too large, truncated (limit {rows} rows / {kb}KB); showing leading part only',

  // —— 文件历史 log ——
  'git.log.title': 'File history',
  'git.log.loading': 'Loading history…',
  'git.log.empty': 'No history (untracked file)',
  'git.log.truncated': 'Showing latest {n} only',
  'git.log.authorTime': '{author} ({time})',

  // —— gitUi 纯层 ——
  'git.subjectNone': '(no message)',
  'git.rel.now': 'just now',
  'git.rel.minutes': '{n} minutes ago',
  'git.rel.hours': '{n} hours ago',
  'git.rel.days': '{n} days ago',
  'git.blame.uncommitted': '(uncommitted)',

  // —— gitClient 主线程错误面 ——
  'git.canceled': 'git request cancelled',
  'git.client.scriptLoadFailed': 'script load failed',
  'git.client.workerError': 'worker error: {message}{file}',
  'git.client.errorFile': ' ({file})',
  'git.client.msgDeserializeFailed': 'worker message deserialization failed (onmessageerror)',
  'git.client.unavailable': 'git worker unavailable: {reason}',
  'git.client.unavailablePost': 'git worker unavailable: postMessage failed (worker terminated?)',
  'git.client.fsNoAdapter': 'fs supplier not registered: request settled or unknown (requestId={id})',

  // —— gitFs 适配层错误面 ——
  'git.fs.enoent': 'git fs ENOENT: {path}{detail}',
  'git.fs.causeDetail': ' ({message})',
  'git.fs.pathEscape': 'git fs path escapes repository root: {p}',
  'git.fs.pathEscapeCause': 'path escapes root',
  'git.fs.encoding': 'git fs readFile unsupported encoding: {encoding}',
  'git.fs.readlinkCause': 'store has no symlink semantics; git fs readlink unavailable',
  'git.fs.writeBanned': 'git fs read-only promise: {name} unavailable',
  'git.fs.dirListSuffix': ' (directory listing failed)',
  'git.fs.readlinkUnavailable': 'git fs readlink unavailable',

  // —— gitWorker 错误码映射目标键 ——
  'git.worker.unknownOp': 'unknown git request kind: {kind}',
  'git.worker.fsWriteBanned': 'git fs read-only promise: worker-side {name} unavailable',
  'git.worker.badFsReplyRead': 'fs read reply missing data',
  'git.worker.badFsReplyStat': 'fs stat reply missing stat',
  'git.worker.badFsReplyEntries': 'fs readdir reply missing entries'
} as const;
