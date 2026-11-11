// catalogs/en/mounts.ts — mounts 域 en 目录（Task 8 域 E）。键集与 zh 全等（聚合
// 机检 ③）、逐 key 占位符集合相等（④）。词汇表落点：挂载 Mount / 连接 Connect /
// 服务器 Server / 文件夹 Folder / 删除 Delete / 取消 Cancel / 关闭 Close /
// 重试 Retry / 工作区 Workspace；「目录管理」面板题沿 tabs.menu.mounts 的 en 定值
// 'Mounts'（Task 4 M-3 同词，单一概念单词不双形）。
export const domain = 'mounts' as const;

export const messages = {
  // —— 面板壳 ——
  'mounts.title': 'Mounts',
  'mounts.subtitle': 'Server mounts / browser direct & proxy / local authorization',
  'mounts.close': 'Close mounts manager',
  'mounts.closeTitle': 'Close (Esc)',

  // —— 组①：服务端根与挂载 ——
  'mounts.group.server': 'Server roots & mounts',
  'mounts.server.notConnected':
    'Not connected to a server — connect via "Connect to server" and fs roots plus static/runtime mounts will appear here.',
  'mounts.server.unrecognized': 'Unrecognized manifest shape (old server?)',
  'mounts.server.listLoading': 'Loading manifest…',
  'mounts.server.listEmpty': 'Manifest is empty.',
  'mounts.server.openInTree': 'Open in tree',
  'mounts.caps.noWatch': 'no watch',
  'mounts.caps.noSearch': '·no search',
  'mounts.segment.fs': 'fs root',
  'mounts.segment.static': 'Static mount',
  'mounts.segment.runtime': 'Runtime',
  'mounts.title.fsRoot': 'Root {n}',
  'mounts.title.mount': '{kind} mount',

  // —— 组②：前端配置挂载 ——
  'mounts.group.configured': 'Frontend configured mounts',
  'mounts.add': '＋ Add mount',
  'mounts.config.empty': 'No frontend configured mounts yet.',
  'mounts.mode.direct': 'Direct',
  'mounts.mode.proxy': 'Proxy',
  'mounts.credStored': '· credential stored',
  'mounts.state.registered': 'Registered rootIndex={n}',
  'mounts.state.offsite': 'Registered on another server',
  'mounts.state.pending': 'Pending registration',
  'mounts.state.pendingError': 'Pending registration ({error})',
  'mounts.state.unregistered': 'Not registered',
  'mounts.open': 'Open',
  'mounts.test': 'Test',
  'mounts.edit': 'Edit',
  'mounts.delete': 'Delete',
  'mounts.probing': 'Probing…',
  'mounts.badge.session': 'Session',

  // —— 新增/编辑表单 ——
  'mounts.form.titleCreate': 'Add mount',
  'mounts.form.titleEdit': 'Edit mount: {label}',
  'mounts.form.mode': 'Access mode',
  'mounts.form.modeDirect': 'Direct (browser accesses the target directly)',
  'mounts.form.modeProxy': 'Proxy (accessed via the server)',
  'mounts.form.serverBaseRequired': 'Proxy mounts require a server connection first',
  'mounts.form.backend': 'Type',
  'mounts.form.label': 'Display name',
  'mounts.form.bucket': 'Bucket',
  'mounts.form.pathStyle': 'path-style addressing',
  'mounts.form.pathStyleHint': 'When off, virtual-host style (bucket.host) is used',
  'mounts.form.prefix': 'Sub-path (prefix, optional)',
  'mounts.form.username': 'Username',
  'mounts.form.secret': 'Password',
  'mounts.form.proxyProbeHint':
    '"Test connection" probes from the browser (direct to the target endpoint): a CORS block does not mean the proxy path is unusable — proxy access goes through the server egress and is verified by reconciliation health probes after the registration is saved.',
  'mounts.form.test': 'Test connection',
  'mounts.form.saving': 'Saving…',
  'mounts.form.save': 'Save',
  'mounts.cancel': 'Cancel',
  'mounts.form.required': 'Required',
  'mounts.form.endpointUserinfo': 'Use an endpoint without credentials; fill credentials in the fields below',

  // —— 警示常量 ——
  'mounts.warn.credential':
    'Direct-mount credentials are stored in plain text in browser IndexedDB and can be extracted by same-origin scripts and local users; do not store high-privilege credentials on shared devices.',
  'mounts.warn.webdavCors':
    'The WebDAV server needs CORS configured (allow this origin + PROPFIND/GET methods), otherwise browser direct access will be blocked.',

  // —— 测试连接回显 ——
  'mounts.probe.ok': 'Connected: root has {entries} entries, latency {ms} ms',
  'mounts.probe.fail': 'Connection failed: {error}',

  // —— 删除确认族 ——
  'mounts.delete.usage': 'Currently in use by {n} workspace(s); ',
  'mounts.delete.offsiteNote':
    'This mount is registered on server {host}, which differs from the current connection: a forced local delete will be performed (only the locally saved config is removed; the registration on that server remains — connect to that server to delete it later, or let it expire on its restart).',
  'mounts.delete.confirm':
    'Delete mount "{label}"? {detail}{scope}After deleting, refreshing the page means related tabs will no longer restore automatically.',
  'mounts.delete.forceLocalSuffix': ' (forced local delete)',
  'mounts.delete.unregisterFailed': 'Server unregistration failed: {message} (local record not deleted)',

  // —— 编辑注册阻断 ——
  'mounts.edit.offsiteBlock':
    'This mount is registered on {host}, which differs from the connected server — unregister/re-register cannot run with the current token; connect to that server before editing the registration.',

  // —— 组③：本机授权来源 ——
  'mounts.group.local': 'Local authorized sources',
  'mounts.local.authorize': 'Pick a folder to authorize',
  'mounts.local.empty': 'No local authorized sources yet.',
  'mounts.local.clearAuth': 'Clear authorization',
  'mounts.local.clearConfirm':
    'Clear the saved folder authorization? localfs sources in session snapshots will no longer restore automatically (a folder must be re-picked next time).',
  'mounts.local.cleared': 'Folder authorization cleared',
  'mounts.local.granted': 'Authorized (session restore available)',
  'mounts.local.needsReauth': 'Re-authorization needed (restoring after a refresh will show a permission prompt)',
  'mounts.local.sessionDetail': 'Session source (file contents are not persistent; re-open after a refresh)',

  // —— 连接域 ——
  'mounts.connect.unreachable': 'Cannot connect to {base}: network error or address unreachable',
  'mounts.connect.httpError': 'Server responded abnormally: HTTP {status}',
  'mounts.connect.healthJson': 'health response is not valid JSON',
  'mounts.connect.notFileServer': 'Target is not a vviewer file server (missing file-server capability)',
  'mounts.connect.authFailed': 'Authentication failed: token missing or wrong (HTTP 401)',
  'mounts.connect.closedStaleTabs': 'Closed {n} old tab(s) (server reconnected)',
  'mounts.connect.addressRequired': 'Enter a server address',
  'mounts.connect.addressAria': 'Server address',
  'mounts.connect.tokenPlaceholder': 'Access token (optional)',
  'mounts.connect.tokenAria': 'Access token',
  'mounts.connect.connecting': 'Connecting…',
  'mounts.connect.connect': 'Connect',

  // —— 对账/注册错误族 ——
  'mounts.sync.listFailed': 'Failed to fetch manifest: {reason}',
  'mounts.sync.listUnrecognized': 'Unrecognized manifest shape',
  'mounts.sync.registerFailed': 'Registration failed: {message}',
  'mounts.sync.reregisterFailed': 'Re-registration failed: {message}',
  'mounts.sync.reregisterDeleteFailed': 'Re-registration DELETE failed: {message}',
  'mounts.sync.reregisterPostFailed': 'Re-registration POST failed: {message}',
  'mounts.sync.reregisterNoIndex': 'Re-registration response missing rootIndex',
  'mounts.sync.registerNoIndex': 'Registration response missing rootIndex',
  'mounts.sync.unregisterFailed': 'Unregistration failed: {message}',
  'mounts.sync.responseNoIndex': 'Response missing rootIndex',

  // —— 新建工作区 ——
  'mounts.wscreate.defaultName': 'Workspace {n}',
  'mounts.wscreate.title': 'New workspace',
  'mounts.wscreate.close': 'Close new-workspace dialog',
  'mounts.wscreate.closeTitle': 'Finish creation (Esc)',
  'mounts.wscreate.nameLabel': 'Name',
  'mounts.wscreate.nameAria': 'Workspace name',
  'mounts.wscreate.addSources': 'Add sources (optional)',
  'mounts.src.folder': 'Local folder…',
  'mounts.src.files': 'Local files…',
  'mounts.src.remote': 'Backend path…',
  'mounts.wscreate.hint':
    'Sources will join this workspace; after creation you can keep adding via the tab bar ＋/⋯ menu "Open folder / Connect to server".',
  'mounts.wscreate.finish': 'Create & activate',
  'mounts.wscreate.folderCancelled': 'Folder selection cancelled',
  'mounts.wscreate.folderAdded': 'Added folder source "{name}"; add more or finish creating',
  'mounts.wscreate.filesAdded': 'Added {n} file(s); add more or finish creating',
  'mounts.wscreate.remoteAdded': 'Added a backend path source; add more or finish creating',

  // —— 后端路径浏览 ——
  'mounts.remote.dialogAria': 'Add backend path source',
  'mounts.remote.title': 'Backend path source',
  'mounts.remote.close': 'Close backend path browser',
  'mounts.remote.noServer':
    'No server connected. Connect first via the tab bar ⋯ menu "Connect to server", then add the backend path source.',
  'mounts.remote.multiRoot': 'This server has multiple data roots — pick one first:',
  'mounts.remote.rootsOnly': 'The server only declares the root count (no root paths); shown by index.',
  'mounts.remote.rootBack': '← Re-pick root (current: {current})',
  'mounts.remote.crumbsAria': 'Path breadcrumbs',
  'mounts.remote.crumbRoot': 'Root',
  'mounts.remote.pickCurrent': 'Use current directory as source ({current})',
  'mounts.remote.retry': 'Retry',
  'mounts.remote.loading': 'Loading…',
  'mounts.remote.emptyDir': '(empty directory)',
  'mounts.remote.pickDir': 'Use as source',
  'mounts.remote.pickDirTitle': 'Use this directory as source: {path}',
  'mounts.remote.pickFile': 'Use this file as source',
  'mounts.remote.pickFileTitle': 'Use this file as source: {path}',
  'mounts.remote.treeTimeout': 'Server request timed out (30s): {base}/api/tree',
  'mounts.remote.treeFailed': 'Server request failed: HTTP {status}{detail}',
  'mounts.remote.treeJson': 'tree response is not valid JSON',

  // —— 直连错误特征化（注入缝消费）——
  'mounts.err.s3WebCrypto': 'WebCrypto unavailable: S3 direct signing requires HTTPS or a localhost environment',
  'mounts.err.s3Cors': 'S3 direct mount failed: bucket CORS not configured or network unreachable',
  'mounts.err.directTimeout': 'Direct request timed out (30s): {url}',
  'mounts.err.httpFailed': '{label} request failed: HTTP {status}{detail}',
  'mounts.err.davCors': 'WebDAV direct mount failed: server CORS not configured or network unreachable',
  'mounts.err.davAuth': ' (authentication failed: check username/password)'
} as const satisfies Record<`${typeof domain}.${string}`, string>;
