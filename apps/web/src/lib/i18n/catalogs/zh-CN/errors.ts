// catalogs/zh-CN/errors.ts — errors 域目录（Task 7 域 D：core dispatch 错误面
// 兜底文案；Task 10 域 G 收尾扩容：高亮链/Open VSX/vsix 导入/字体管理错误——
// 用户可见错误消息单点入本域）。vviewer-core 包保持零 i18n 依赖（依赖方向
// apps/web → core 不反转），errorMessageOf 的空文案兜底经注入缝（setRenderFailedText，
// apps/web viewer.ts 装配时注入 translate getter）从本目录取值；core 独立消费
// （无人注入）回落包内英文缺省 'Render failed'（非显示面契约，apps/web 恒注入故
// 渲染输出恒走本目录）。
// 拼接形态裁决（Task 10）：fetch 薄封装的 `{前缀}：{详情}` 复合串拆前缀键 + 结构
// 键两段（detail/httpDetail/jsonDetail/tooLarge 占位符承接前缀），完整句键不再
// 复制前缀文案（installNet 等 6 前缀单点）；完整句 throw 处（noManifest 等）直接
// 整串单键，不拼接。
export const domain = 'errors' as const;

export const messages = {
  'errors.renderFailed': '渲染失败',

  // —— 高亮链（errors.highlight.*：computeResult 兜底 / highlightClient /
  //    highlightRouter 远程高亮错误）——
  'errors.highlight.remoteFailed': '远程高亮失败',
  'errors.highlight.failed': '高亮失败',
  'errors.highlight.noServer': '未连接服务器，无法远程高亮',
  'errors.highlight.needsPath': '远程高亮需要文件的服务端 path',
  'errors.highlight.http': '远程高亮失败: HTTP {status}',
  'errors.highlight.cacheMissing': '远程高亮缓存命中但本地会话条目缺失',

  // —— Open VSX 安装/更新（errors.openvsx.*：openVsx.ts；{id} = publisher.extension）——
  'errors.openvsx.inputEmpty': '请输入 Open VSX 标识（publisher.extension）或链接',
  'errors.openvsx.inputUnparsable': '无法解析输入：{input}',
  'errors.openvsx.httpsOnly': '仅支持 https 链接（open-vsx.org 恒 https）：{input}',
  'errors.openvsx.hostOnly': '仅支持 open-vsx.org 链接：{input}',
  'errors.openvsx.pageUnrecognized': '无法识别的 open-vsx.org 链接（支持 /extension/{p}/{e}[/v] 或 vsix 直链）：{input}',
  'errors.openvsx.inputUnrecognized': '无法识别的输入（支持 publisher.extension[@version] 或 open-vsx.org 链接）：{input}',
  'errors.openvsx.installNet': 'Open VSX 安装失败（需网络与 CORS，或改用手动导入 vsix）',
  'errors.openvsx.installFail': 'Open VSX 安装失败',
  'errors.openvsx.checkNet': 'Open VSX 检查更新失败（需网络与 CORS）',
  'errors.openvsx.checkFail': 'Open VSX 检查更新失败',
  'errors.openvsx.updateNet': 'Open VSX 更新失败（需网络与 CORS，或改用手动导入 vsix）',
  'errors.openvsx.updateFail': 'Open VSX 更新失败',
  'errors.openvsx.detail': '{prefix}：{message}',
  'errors.openvsx.httpDetail': '{prefix}：HTTP {status}（GET {url}）',
  'errors.openvsx.jsonDetail': '{prefix}：响应不是有效 JSON（{message}）',
  'errors.openvsx.tooLarge': '{prefix}：vsix 超过 {max}MB 上限（{size}MB）',
  'errors.openvsx.noManifest': 'Open VSX 安装失败：元数据缺少 manifest 文件（扩展未正确打包？）：{id}',
  'errors.openvsx.noThemes': '该扩展不含主题（contributes.themes/iconThemes 均缺失）：{id}',
  'errors.openvsx.noDownload': 'Open VSX 安装失败：元数据缺少 vsix 下载地址：{id}',
  'errors.openvsx.noVersion': 'Open VSX 安装失败：元数据缺少版本号：{id}',
  'errors.openvsx.checkNoVersion': 'Open VSX 检查更新失败：元数据缺少 version：{id}',
  'errors.openvsx.updateNoVersion': 'Open VSX 更新失败：元数据缺少 version：{id}',
  'errors.openvsx.updateNoDownload': 'Open VSX 更新失败：元数据缺少 vsix 下载地址：{id}',
  'errors.openvsx.updateNoOrigin': '主题「{name}」无 Open VSX 来源信息（本地导入不支持更新）',
  'errors.openvsx.updateFailedErrors': 'Open VSX 更新失败：{errors}',
  'errors.openvsx.updateNoNamedTheme': 'Open VSX 更新失败：包内未找到同名主题「{name}」（上游可能已改名，可删除后重装）',

  // —— vsix 导入管线（errors.vsix.*：vsixImport.ts 逐条错误，UI errors 列表展示）——
  'errors.vsix.notFound': '扩展包内未找到主题',
  'errors.vsix.iconNotFound': '扩展包内未找到图标主题',
  'errors.vsix.jsonParse': '{name}: 主题 JSON 解析失败',
  'errors.vsix.jsonTooLarge': '{name}: 主题 JSON 超过 1MB 上限，已跳过',
  'errors.vsix.badType': '{name}: 不支持的文件类型（仅 .json / .vsix）',
  'errors.vsix.fontMissing': '{name}: 缺少字体文件 {base}（图标主题字体须同批提供），已跳过',
  'errors.vsix.fontTooLarge': '{name}: 字体 {base} 超过 30MB 上限，已跳过',
  'errors.vsix.badTypeWithFonts': '{name}: 不支持的文件类型（仅 .json / .vsix / 字体文件）',

  // —— 字体管理（errors.fonts.*：stores/fontsStore.ts 用户可见错误，FontsSection
  //    错误通道展示）——
  'errors.fonts.quota': '{message}（存储空间不足：前往 设置→存储与数据 清理空间后重试）',
  'errors.fonts.parseFailed': '字体解析失败（内容不是有效字体？）：{message}',
  'errors.fonts.nameComma': '字体名称不能包含逗号：「{name}」（逗号是 family 多级回退分隔符）',
  'errors.fonts.nameExists': '已存在同名字体「{name}」，请改名或先删除原字体',
  'errors.fonts.tooLarge': '字体文件超过 30MB 上限（{size}MB）',
  'errors.fonts.badUrl': '非法字体地址：{url}',
  'errors.fonts.httpsOnly': '仅支持 https 字体地址（混合内容防线）',
  'errors.fonts.downloadFailed': '字体下载失败（字体源需开启 CORS）：{message}',
  'errors.fonts.recordMissing': '字体记录不存在：{id}'
} as const satisfies Record<`${typeof domain}.${string}`, string>;
