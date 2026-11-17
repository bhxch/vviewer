/**
 * extension.ts — extension host 侧入口（spec H）。
 *
 * T1（骨架）：落 activate/deactivate 的最小骨架——本文件同时是 esbuild host bundle
 * （CJS，`vscode` 为 external）的 entry point。custom editor provider 注册、命令注册、
 * webview panel 与文件字节通道在 T2 填充。
 */
import type { ExtensionContext } from 'vscode';

/** 扩展激活（spec H T2 填充：注册 custom editor provider 与命令） */
export function activate(_context: ExtensionContext): void {
  // T2：window.registerCustomEditorProvider('vviewer.viewer', provider, {...})
}

/** 扩展停用（spec H T2 填充：释放 host 侧资源） */
export function deactivate(): void {
  // T2：清理
}
