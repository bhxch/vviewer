// catalogs/zh-CN/mounts.ts — mounts 域目录（Task 8 域 E：挂载与连接——MountsManager
// 面板三组、mountsManager 纯逻辑（校验/装配/探测回显/警示常量）、mountsSync 对账
// lastError 族（组②待注册 badge 上屏）、serverConnect/ServerConnectForm 连接域、
// WorkspaceCreateModal/RemoteSourceModal 新建工作区与后端路径浏览、core directS3/
// directDav 直连错误特征化文案（apps/web 注入缝消费，core 缺省英文）。zh 值与被
// 移除字面量逐字节等价（D7）。域目录契约（Interfaces 钉死）：key 三段
// `{域}.{模块}.{语义}`，satisfies 锁首段。日志面（console）串不入目录——已英文化
// （Task 4 I-1 推广政策）。
export const domain = 'mounts' as const;

export const messages = {
  // —— 面板壳（MountsManager.svelte；aria 与可见标题同键保证 label-content 一致）——
  'mounts.title': '目录管理',
  'mounts.subtitle': '服务端挂载 / 前端直连与代理 / 本机授权',
  'mounts.close': '关闭目录管理',
  'mounts.closeTitle': '关闭（Esc）',

  // —— 组①：服务端根与挂载 ——
  'mounts.group.server': '服务端根与挂载',
  'mounts.server.notConnected': '未连接服务器——通过「连接服务器」连接后，此处显示 fs 根与静态/运行时挂载。',
  'mounts.server.unrecognized': '清单形态不识别（旧服务端？）',
  'mounts.server.listLoading': '清单加载中…',
  'mounts.server.listEmpty': '清单为空。',
  'mounts.server.openInTree': '在树中打开',
  'mounts.caps.noWatch': '无推送',
  'mounts.caps.noSearch': '·无搜索',
  'mounts.segment.fs': 'fs 根',
  'mounts.segment.static': '静态挂载',
  'mounts.segment.runtime': '运行时',
  'mounts.title.fsRoot': '根 {n}',
  'mounts.title.mount': '{kind} 挂载',

  // —— 组②：前端配置挂载 ——
  'mounts.group.configured': '前端配置挂载',
  'mounts.add': '＋ 新增挂载',
  'mounts.config.empty': '暂无前端配置挂载。',
  'mounts.mode.direct': '直连',
  'mounts.mode.proxy': '代理',
  'mounts.credStored': '· 凭据已存',
  'mounts.state.registered': '已注册 rootIndex={n}',
  'mounts.state.offsite': '注册于他机',
  'mounts.state.pending': '待注册',
  'mounts.state.pendingError': '待注册（{error}）',
  'mounts.state.unregistered': '未注册',
  'mounts.open': '打开',
  'mounts.test': '测试',
  'mounts.edit': '编辑',
  'mounts.delete': '删除',
  'mounts.probing': '探测中…',
  'mounts.badge.session': '会话',

  // —— 新增/编辑表单 ——
  'mounts.form.titleCreate': '新增挂载',
  'mounts.form.titleEdit': '编辑挂载：{label}',
  'mounts.form.mode': '访问方式',
  'mounts.form.modeDirect': '直连（浏览器直接访问）',
  'mounts.form.modeProxy': '代理（经服务器访问）',
  'mounts.form.serverBaseRequired': '代理挂载需先连接服务器',
  'mounts.form.backend': '类型',
  'mounts.form.label': '显示名',
  'mounts.form.bucket': '存储桶（bucket）',
  'mounts.form.pathStyle': 'path-style 寻址',
  'mounts.form.pathStyleHint': '关闭则使用 virtual-host 形态（bucket.host）',
  'mounts.form.prefix': '子路径（prefix，可空）',
  'mounts.form.username': '用户名',
  'mounts.form.secret': '密码',
  'mounts.form.proxyProbeHint':
    '「测试连接」为浏览器侧探测（直连目标端点）：被 CORS 拦截不代表代理链路不可用——代理访问以服务器出口为准，保存注册后由对账健康探测验证。',
  'mounts.form.test': '测试连接',
  'mounts.form.saving': '保存中…',
  'mounts.form.save': '保存',
  'mounts.cancel': '取消',
  'mounts.form.required': '必填',
  'mounts.form.endpointUserinfo': '请使用不含凭据的 endpoint，凭据在下方字段填写',

  // —— 警示常量（spec §6 双处渲染；原模块常量改函数——Task 7 saveDeniedNotice 先例，
  //   装载时刻锁定 locale 会破坏 en 态）——
  'mounts.warn.credential':
    '直连凭据以明文保存在浏览器 IndexedDB，可被同源脚本与本机用户提取；请勿在共享设备保存高权限凭据。',
  'mounts.warn.webdavCors':
    'WebDAV 服务器需配置 CORS（允许本站来源 + PROPFIND/GET 方法），否则浏览器直连会被拦截。',

  // —— 测试连接回显 ——
  'mounts.probe.ok': '连接成功：根目录 {entries} 个条目，延迟 {ms} ms',
  'mounts.probe.fail': '连接失败：{error}',

  // —— 删除确认族（window.confirm 上屏）——
  'mounts.delete.usage': '当前 {n} 个工作区正在使用此挂载；',
  'mounts.delete.offsiteNote':
    '该挂载注册于服务器 {host}，与当前连接不一致：将强制本地删除（仅删本机保存的配置，服务器上的注册保留，可连接该服务器后再删除或待其重启失效）。',
  'mounts.delete.confirm': '删除挂载「{label}」？{detail}{scope}删除后刷新页面，相关标签页将无法自动恢复。',
  'mounts.delete.forceLocalSuffix': '（强制本地删除）',
  'mounts.delete.unregisterFailed': '服务端注销失败：{message}（本地记录未删除）',

  // —— 编辑注册阻断（评审 M1）——
  'mounts.edit.offsiteBlock':
    '该挂载注册于 {host}，与当前连接的服务器不一致——注销/重注册无法以当前令牌执行；请先连接该服务器再编辑注册。',

  // —— 组③：本机授权来源 ——
  'mounts.group.local': '本机授权来源',
  'mounts.local.authorize': '选择文件夹授权',
  'mounts.local.empty': '暂无本机授权来源。',
  'mounts.local.clearAuth': '清除授权',
  'mounts.local.clearConfirm': '清除已保存的文件夹授权？会话快照中的 localfs 来源将无法自动恢复（下次需重新选择文件夹）。',
  'mounts.local.cleared': '已清除文件夹授权',
  'mounts.local.granted': '已授权（会话恢复可用）',
  'mounts.local.needsReauth': '需重新授权（刷新后恢复将弹出权限提示）',
  'mounts.local.sessionDetail': '会话来源（文件内容不持久，刷新后需重新打开）',

  // —— 连接域（serverConnect.svelte.ts + ServerConnectForm.svelte；RemoteSourceModal
  //   错误族同值同键复用——Task 4 AppShell 侧重复串同键复用先例）——
  'mounts.connect.unreachable': '无法连接 {base}：网络错误或地址不可达',
  'mounts.connect.httpError': '服务器响应异常: HTTP {status}',
  'mounts.connect.healthJson': 'health 响应不是有效 JSON',
  'mounts.connect.notFileServer': '目标不是 vviewer 文件服务器（缺少 file-server 能力）',
  'mounts.connect.authFailed': '鉴权失败：令牌缺失或错误（HTTP 401）',
  'mounts.connect.closedStaleTabs': '已关闭 {n} 个旧标签页（服务器已重新连接）',
  'mounts.connect.addressRequired': '请输入服务器地址',
  'mounts.connect.addressAria': '服务器地址',
  'mounts.connect.tokenPlaceholder': '访问令牌（可空）',
  'mounts.connect.tokenAria': '访问令牌',
  'mounts.connect.connecting': '连接中…',
  'mounts.connect.connect': '连接',

  // —— 对账/注册错误族（mountsSync.ts；lastError 落库后在组② badge「待注册（…）」
  //   上屏，故进目录；事件时刻取值、落库为快照——Task 4 statusNotice 同口径。
  //   listFailed 与组①清单错误行同值同键复用——Task 4 AppShell 侧重复串同键先例）——
  'mounts.sync.listFailed': '清单获取失败：{reason}',
  'mounts.sync.listUnrecognized': '清单形态不识别',
  'mounts.sync.registerFailed': '注册失败：{message}',
  'mounts.sync.reregisterFailed': '重注册失败：{message}',
  'mounts.sync.reregisterDeleteFailed': '重注册 DELETE 失败：{message}',
  'mounts.sync.reregisterPostFailed': '重注册 POST 失败：{message}',
  'mounts.sync.reregisterNoIndex': '重注册响应缺少 rootIndex',
  'mounts.sync.registerNoIndex': '注册响应缺少 rootIndex',
  'mounts.sync.unregisterFailed': '注销失败：{message}',
  'mounts.sync.responseNoIndex': '响应缺少 rootIndex',

  // —— 新建工作区（WorkspaceCreateModal.svelte；三来源按钮 WorkspaceTabsPanel
  //   同文案待 Task 10 复用同键）——
  'mounts.wscreate.defaultName': '工作区 {n}',
  'mounts.wscreate.title': '新建工作区',
  'mounts.wscreate.close': '关闭新建工作区',
  'mounts.wscreate.closeTitle': '完成创建（Esc）',
  'mounts.wscreate.nameLabel': '名称',
  'mounts.wscreate.nameAria': '工作区名称',
  'mounts.wscreate.addSources': '添加来源（可跳过）',
  'mounts.src.folder': '本地文件夹…',
  'mounts.src.files': '本地文件…',
  'mounts.src.remote': '后端路径…',
  'mounts.wscreate.hint': '来源将加入本工作区；创建后也可用标签栏 ＋/⋯ 菜单「打开文件夹 / 连接服务器」继续添加。',
  'mounts.wscreate.finish': '创建并激活',
  'mounts.wscreate.folderCancelled': '已取消选择文件夹',
  'mounts.wscreate.folderAdded': '已添加文件夹来源「{name}」，可继续添加或完成创建',
  'mounts.wscreate.filesAdded': '已添加 {n} 个文件，可继续添加或完成创建',
  'mounts.wscreate.remoteAdded': '已添加后端路径来源，可继续添加或完成创建',

  // —— 后端路径浏览（RemoteSourceModal.svelte）——
  'mounts.remote.dialogAria': '添加后端路径来源',
  'mounts.remote.title': '后端路径来源',
  'mounts.remote.close': '关闭后端路径浏览',
  'mounts.remote.noServer': '尚未连接服务器。请先在标签栏 ⋯ 菜单「连接服务器」建立连接，再添加后端路径来源。',
  'mounts.remote.multiRoot': '该服务器有多数据根，请先选择根：',
  'mounts.remote.rootsOnly': '服务器仅宣告根数量（无根路径），以序号表示。',
  'mounts.remote.rootBack': '← 重选根（当前：{current}）',
  'mounts.remote.crumbsAria': '路径面包屑',
  'mounts.remote.crumbRoot': '根',
  'mounts.remote.pickCurrent': '将当前目录作为来源（{current}）',
  'mounts.remote.retry': '重试',
  'mounts.remote.loading': '加载中…',
  'mounts.remote.emptyDir': '（空目录）',
  'mounts.remote.pickDir': '作为来源',
  'mounts.remote.pickDirTitle': '将此目录作为来源：{path}',
  'mounts.remote.pickFile': '将此文件作为来源',
  'mounts.remote.pickFileTitle': '将此文件作为来源：{path}',
  'mounts.remote.treeTimeout': '服务器请求超时（30s）: {base}/api/tree',
  'mounts.remote.treeFailed': '服务器请求失败: HTTP {status}{detail}',
  'mounts.remote.treeJson': 'tree 响应不是有效 JSON',

  // —— 直连错误特征化（core directS3/directDav 注入缝消费；core 缺省英文，
  //   apps/web 恒注入故直连面恒走本目录——Task 7 setRenderFailedText 先例）——
  'mounts.err.s3WebCrypto': 'WebCrypto 不可用：S3 直连签名需要 HTTPS 或 localhost 环境',
  'mounts.err.s3Cors': 'S3 直连失败：bucket CORS 未配置或网络不可达',
  'mounts.err.directTimeout': '直连请求超时（30s）: {url}',
  'mounts.err.httpFailed': '{label}请求失败: HTTP {status}{detail}',
  'mounts.err.davCors': 'WebDAV 直连失败：服务器 CORS 未配置或网络不可达',
  'mounts.err.davAuth': '（认证失败：检查用户名/密码）'
} as const satisfies Record<`${typeof domain}.${string}`, string>;
