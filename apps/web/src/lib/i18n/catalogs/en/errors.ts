// catalogs/en/errors.ts — errors 域 en 目录（D15：全量覆盖，占位符与 zh 一致；
// Task 10 域 G 收尾扩容同步）。
export const domain = 'errors' as const;

export const messages = {
  'errors.renderFailed': 'Render failed',

  // —— 高亮链（errors.highlight.*：computeResult 兜底 / highlightClient /
  //    highlightRouter 远程高亮错误）——
  'errors.highlight.remoteFailed': 'Remote highlighting failed',
  'errors.highlight.failed': 'Highlighting failed',
  'errors.highlight.noServer': 'Not connected to a server; remote highlighting unavailable',
  'errors.highlight.needsPath': 'Remote highlighting requires the file to have a server-side path',
  'errors.highlight.http': 'Remote highlighting failed: HTTP {status}',
  'errors.highlight.cacheMissing': 'Remote highlight cache hit but local session entry is missing',

  // —— Open VSX 安装/更新（errors.openvsx.*：openVsx.ts；{id} = publisher.extension）——
  'errors.openvsx.inputEmpty': 'Enter an Open VSX identifier (publisher.extension) or link',
  'errors.openvsx.inputUnparsable': 'Cannot parse input: {input}',
  'errors.openvsx.httpsOnly': 'Only https links are supported (open-vsx.org is always https): {input}',
  'errors.openvsx.hostOnly': 'Only open-vsx.org links are supported: {input}',
  'errors.openvsx.pageUnrecognized':
    'Unrecognized open-vsx.org link (supports /extension/{p}/{e}[/v] or a direct vsix link): {input}',
  'errors.openvsx.inputUnrecognized':
    'Unrecognized input (supports publisher.extension[@version] or an open-vsx.org link): {input}',
  'errors.openvsx.installNet': 'Open VSX install failed (needs network and CORS, or import the vsix manually)',
  'errors.openvsx.installFail': 'Open VSX install failed',
  'errors.openvsx.checkNet': 'Open VSX update check failed (needs network and CORS)',
  'errors.openvsx.checkFail': 'Open VSX update check failed',
  'errors.openvsx.updateNet': 'Open VSX update failed (needs network and CORS, or import the vsix manually)',
  'errors.openvsx.updateFail': 'Open VSX update failed',
  'errors.openvsx.detail': '{prefix}: {message}',
  'errors.openvsx.httpDetail': '{prefix}: HTTP {status} (GET {url})',
  'errors.openvsx.jsonDetail': '{prefix}: response is not valid JSON ({message})',
  'errors.openvsx.tooLarge': '{prefix}: vsix exceeds the {max}MB limit ({size}MB)',
  'errors.openvsx.noManifest': 'Open VSX install failed: metadata lacks the manifest file (extension packaged correctly?): {id}',
  'errors.openvsx.noThemes': 'This extension contains no themes (contributes.themes/iconThemes both missing): {id}',
  'errors.openvsx.noDownload': 'Open VSX install failed: metadata lacks the vsix download URL: {id}',
  'errors.openvsx.noVersion': 'Open VSX install failed: metadata lacks a version: {id}',
  'errors.openvsx.checkNoVersion': 'Open VSX update check failed: metadata lacks version: {id}',
  'errors.openvsx.updateNoVersion': 'Open VSX update failed: metadata lacks version: {id}',
  'errors.openvsx.updateNoDownload': 'Open VSX update failed: metadata lacks the vsix download URL: {id}',
  'errors.openvsx.updateNoOrigin': 'Theme "{name}" has no Open VSX origin info (local imports cannot be updated)',
  'errors.openvsx.updateFailedErrors': 'Open VSX update failed: {errors}',
  'errors.openvsx.updateNoNamedTheme':
    'Open VSX update failed: no theme named "{name}" found in the package (upstream may have renamed it; delete and reinstall)',

  // —— vsix 导入管线（errors.vsix.*：vsixImport.ts 逐条错误，UI errors 列表展示）——
  'errors.vsix.notFound': 'No theme found in the extension package',
  'errors.vsix.iconNotFound': 'No icon theme found in the extension package',
  'errors.vsix.jsonParse': '{name}: failed to parse theme JSON',
  'errors.vsix.jsonTooLarge': '{name}: theme JSON exceeds the 1MB limit, skipped',
  'errors.vsix.badType': '{name}: unsupported file type (.json / .vsix only)',
  'errors.vsix.fontMissing': '{name}: missing font file {base} (icon theme fonts must be provided together), skipped',
  'errors.vsix.fontTooLarge': '{name}: font {base} exceeds the 30MB limit, skipped',
  'errors.vsix.badTypeWithFonts': '{name}: unsupported file type (.json / .vsix / font files only)',

  // —— 字体管理（errors.fonts.*：stores/fontsStore.ts 用户可见错误，FontsSection
  //    错误通道展示）——
  'errors.fonts.quota': '{message} (storage quota exceeded: go to Settings→Storage & data to free up space and retry)',
  'errors.fonts.parseFailed': 'Failed to parse font (content is not a valid font?): {message}',
  'errors.fonts.nameComma': 'Font name cannot contain commas: "{name}" (commas separate family fallback levels)',
  'errors.fonts.nameExists': 'A font named "{name}" already exists; rename it or delete the original first',
  'errors.fonts.tooLarge': 'Font file exceeds the 30MB limit ({size}MB)',
  'errors.fonts.badUrl': 'Invalid font URL: {url}',
  'errors.fonts.httpsOnly': 'Only https font URLs are supported (mixed-content defense)',
  'errors.fonts.downloadFailed': 'Font download failed (the font source must enable CORS): {message}',
  'errors.fonts.recordMissing': 'Font record not found: {id}'
} as const satisfies Record<`${typeof domain}.${string}`, string>;
