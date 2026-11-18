// extension.ts — 扩展 host 侧入口（spec H T2）。
//
// 职责：激活时注册 custom editor provider（viewType `vviewer.viewer`）与命令；
// 停用时释放资源。
//
// 装配面（对照 apps/web/src/lib/viewer.ts 的 web 端装配单点）：扩展侧**只做**
// 「读文件 + 发设置 + 收写盘请求」——渲染与样式供给在 webview 侧（渲染器装配 T3）。
//
// i18n：扩展自有目录（`src/i18n/`），locale 由 `vscode.env.language` 选（`zh*` → zh-CN，
// 其余 → en）——**任何用户可见文案一律经 `t()` 取值，禁裸 CJK 字面量**（ESLint 覆盖块
// `apps/vscode/src/**` 执法）。
import * as vscode from 'vscode';
import { VViewerEditorProvider } from './host/editorProvider';
import { PanelHost, VIEW_TYPE, buildProviderWebviewOptions } from './host/webviewPanel';
import { pickLocale, setLocale } from './i18n/core';

/** 命令 id（与 contributes.commands 声明同值） */
export const COMMAND_OPEN_WITH_NATIVE = 'vviewer.openWithNative';
export const COMMAND_RELOAD = 'vviewer.reload';
export const COMMAND_EXPORT_HTML = 'vviewer.exportHtml';

/** 扩展激活 */
export function activate(context: vscode.ExtensionContext): void {
  // locale 选定（zh* → zh-CN，其余 → en）——扩展自有 i18n 目录
  setLocale(pickLocale(vscode.env.language));

  const host = new PanelHost(vscode, context);

  context.subscriptions.push(
    // custom editor 注册（spec §4.1）：「打开文件时直接渲染」
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, new VViewerEditorProvider(host), {
      supportsMultipleEditorsPerDocument: false,
      webviewOptions: buildProviderWebviewOptions()
    }),
    // 「用原生编辑器打开」：走 VSCode 原生命令（vscode.openWith + 'default' = 文本编辑器），
    // 不自建菜单（custom editor 自带「用编辑器打开」切换）
    vscode.commands.registerCommand(COMMAND_OPEN_WITH_NATIVE, async () => {
      const uri = host.activeDocumentUri();
      if (!uri) return;
      await vscode.commands.executeCommand('vscode.openWith', uri, 'default');
    }),
    // 「重新渲染」：向该文档的 panel 重推 init
    vscode.commands.registerCommand(COMMAND_RELOAD, async () => {
      const uri = host.activeDocumentUri();
      if (!uri) return;
      await host.reload(uri);
    }),
    // 「导出 HTML」：宿主命令 → webview 组装自包含 HTML → 回到宿主 showSaveDialog 写盘
    vscode.commands.registerCommand(COMMAND_EXPORT_HTML, async () => {
      const uri = host.activeDocumentUri();
      if (!uri) return;
      await host.requestExport(uri);
    }),
    // 配置/主题变更 → 实时生效（spec H T6：不要求重开文件；订阅面在 PanelHost 内）
    ...host.watchChanges(),
    host
  );
}

/** 扩展停用 */
export function deactivate(): void {
  // panel 与 provider 的释放由 context.subscriptions 承接
}
