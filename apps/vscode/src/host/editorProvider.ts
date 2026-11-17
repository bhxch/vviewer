// editorProvider.ts — custom editor provider（spec H T2）。
//
// 注册协议（spec §4.1）：custom editor（`contributes.customEditors`，viewType
// `vviewer.viewer`，`priority: "default"`）——「打开文件时直接渲染」；用户可切回 VSCode
// 原生编辑器（custom editor 自带切换）。
//
// **vscode 只做 type-only import**（运行时零 vscode 依赖）→ 单测可直测本模块。
//
// 只读语义：本扩展是**纯只读**渲染器（spec §3 反目标：webview 内编辑），故实现
// `CustomReadonlyEditorProvider`——不实现 `resolveCustomEditor` 的编辑面，也不注册
// `onDidChangeCustomDocument`。
import type * as vscode from 'vscode';
import type { PanelHost } from './webviewPanel';

/** VViewer 的只读 custom editor provider */
export class VViewerEditorProvider implements vscode.CustomReadonlyEditorProvider<vscode.CustomDocument> {
  constructor(private readonly host: PanelHost) {}

  /** 打开自定义文档（只读语义：仅承载 URI，无编辑面） */
  openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
    return {
      uri,
      dispose(): void {
        // 只读文档：无资源需释放
      }
    };
  }

  /** 解析编辑器：装配 webview（选项 + HTML + 消息通道 + init 推送） */
  async resolveCustomEditor(
    document: vscode.CustomDocument,
    webviewPanel: vscode.WebviewPanel
  ): Promise<void> {
    await this.host.attach(document, webviewPanel);
  }
}
