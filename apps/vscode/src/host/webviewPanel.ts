// webviewPanel.ts — webview panel 生命周期 + 资产 URI 映射（spec H T2）。
//
// **vscode 只做 type-only import**（`import type * as vscode from 'vscode'`）：该模块在
// 运行时不 import vscode（运行时 API 由构造参数注入）→ 单测可直测其中的纯函数
// （评审订正⑧同款纪律：HTML 模板与纯逻辑必须 vscode-free 可直测）。
//
// webview 必需选项（评审订正④——两项缺一即近乎静默失效）：
// - `enableScripts: true`：不开则 webview 内脚本不执行 → 白屏
// - `localResourceRoots: [extensionUri/dist]`：asWebviewUri 资源必须落在 roots 内，否则
//   wasm/字体/grammar/worker 全 404（webview 无 console 回传 → 近乎静默）
//
// 资产 URI 三段自洽（RF 5）：`grammarsBase` / `queriesBase` / `runtimeDir` 与三个 worker
// URL **同族**（全为 `asWebviewUri` 绝对 URL），不得混用相对路径；queries 与 runtime 的
// 基址带尾斜杠（`fetch(`${dir}/${name}`)` 与 `joinPath(runtimeDir, 'tree-sitter.wasm')` 的
// 语义要求，core-parse.ts:484/:210）。
import type * as vscode from 'vscode';
import type { GrammarTable } from '@bhxch/vviewer-highlight';
import { errorMessage, readDocumentBytes } from './fileChannel';
import { composeStyleText, renderWebviewHtml } from './webviewHtml';
import { SETTING_KEYS, hasLanguageOverride, readWebviewSettings } from './settings';
import {
  createRequestIdFactory,
  isWebviewToHost,
  type AssetUris,
  type HostToWebview,
  type ThemePayload
} from './protocol';
import { t } from '../i18n/core';
import { kindCssVars } from '../webview/theme';
import { toGrammarTable } from '../webview/assets';

/** vscode 运行时（注入面——整命名空间注入，测试可换假实现） */
export type VscodeRuntime = typeof vscode;

/** custom editor 的 viewType（与 contributes.customEditors 的 viewType 同值） */
export const VIEW_TYPE = 'vviewer.viewer';

/**
 * 语言探测的文件大小上限：超过则**不**程序化打开文本文档取 languageId（避免大文件
 * 全量入内存，与「200MB 上限不读文件」的纪律同向）。低于此值时按扩展名取 languageId
 * （VSCode 无「不经打开即取 languageId」的公开 API）。
 */
export const LANGUAGE_PROBE_MAX_BYTES = 10 * 1024 * 1024;

/** 主题令牌快照（按 VSCode 活动主题的 kind 选亮/暗缺省值）
 *
 * 令牌表单源于 webview 侧的动态令牌面（`src/webview/theme.ts` 的 `kindCssVars`）——host 与
 * webview 共用同一份缺省值，避免两侧各抄一份而产生漂移。
 */
export function themeCssVars(kind: 'dark' | 'light'): Record<string, string> {
  return kindCssVars(kind);
}

/**
 * webview 必需选项（评审订正④的回归锚：`enableScripts: true` + `localResourceRoots` 含 dist）。
 *
 * @param extensionUri 扩展根 URI
 * @param joinPath `vscode.Uri.joinPath`（注入，便于单测）
 */
export function buildWebviewOptions(
  extensionUri: vscode.Uri,
  joinPath: (base: vscode.Uri, ...segments: string[]) => vscode.Uri
): vscode.WebviewOptions {
  return {
    // 不开则 webview 内脚本不执行 → 白屏
    enableScripts: true,
    // asWebviewUri 资源必须落在 roots 内，否则 wasm/字体/grammar/worker 全 404
    localResourceRoots: [joinPath(extensionUri, 'dist')]
  };
}

/** provider 注册选项（`enableFindWidget` / `retainContextWhenHidden` 属 WebviewPanelOptions 面） */
export function buildProviderWebviewOptions(): vscode.WebviewPanelOptions {
  return { enableFindWidget: true, retainContextWhenHidden: true };
}

/** 资产 URI 映射的入参 */
export interface AssetUrisParams {
  webview: vscode.Webview;
  extensionUri: vscode.Uri;
  joinPath: (base: vscode.Uri, ...segments: string[]) => vscode.Uri;
  grammars: GrammarTable;
}

/**
 * 资产 URI 映射（RF 5：全为 `asWebviewUri` 绝对 URL，三段基址与三个 worker 同族）。
 */
export function buildAssetUris(params: AssetUrisParams): AssetUris {
  const { webview, extensionUri, joinPath, grammars } = params;
  const asset = (...segments: string[]): string =>
    webview.asWebviewUri(joinPath(extensionUri, 'dist', 'webview', ...segments)).toString();
  const base = (...segments: string[]): string => `${asset(...segments)}/`;
  return {
    grammarsBase: base('assets', 'grammars'),
    queriesBase: base('assets', 'queries'),
    runtimeDir: base('assets'),
    grammars,
    binaryWorkerUrl: asset('binary-worker.js'),
    pdfWorkerModernUrl: asset('pdf', 'pdf.worker.min.mjs'),
    pdfWorkerLegacyUrl: asset('pdf', 'pdf.worker.legacy.min.mjs'),
    fontsBase: base('fonts'),
    katexCssUrl: asset('katex.min.css'),
    katexExportCssUrl: asset('katex.export.css'),
    themesUrl: asset('assets', 'themes.json'),
    highlightWorkerSourceUrl: asset('highlight-worker.js')
  };
}

/**
 * 生成 CSP nonce（宿主内联样式块用）。
 *
 * 用全局 WebCrypto（Node 20+ / VSCode 1.90 的 Electron 32 恒有）而非 `node:crypto`
 * 导入——后者在 esbuild 的 node 平台 bundle 里是 external 记录，会触「产物无未解析
 * import」门（唯一豁免是 host bundle 的 vscode）。
 */
export function createNonce(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** panel 宿主：面板复用 + 消息通道 + init 推送 */
export class PanelHost implements vscode.Disposable {
  private readonly panels = new Map<string, vscode.WebviewPanel>();
  /** panel → 当前文档元信息（相对链接导航后基准随之切换；languageId 供 per-language 设置解析） */
  private readonly panelMeta = new Map<vscode.WebviewPanel, { uri: vscode.Uri; languageId?: string }>();
  private readonly nextRequestId = createRequestIdFactory();
  private activeKey: string | null = null;

  constructor(
    private readonly vscode: VscodeRuntime,
    private readonly context: vscode.ExtensionContext
  ) {}

  /** 扩展根 URI（dist/ 在其下） */
  get extensionUri(): vscode.Uri {
    return this.context.extensionUri;
  }

  /** 面板复用：同文档再次打开 → reveal 既有 panel（不重开）；文档关闭 → 清映射 */
  async attach(document: vscode.CustomDocument, panel: vscode.WebviewPanel): Promise<void> {
    const key = document.uri.toString();
    const existing = this.panels.get(key);
    if (existing && existing !== panel) {
      existing.reveal();
      return;
    }
    this.panels.set(key, panel);
    this.panelMeta.set(panel, { uri: document.uri });
    this.activeKey = key;
    panel.onDidDispose(() => {
      if (this.panels.get(key) === panel) this.panels.delete(key);
      this.panelMeta.delete(panel);
      if (this.activeKey === key) this.activeKey = null;
    });
    panel.onDidChangeViewState(() => {
      if (panel.active) this.activeKey = key;
    });

    const webview = panel.webview;
    webview.options = buildWebviewOptions(this.context.extensionUri, (base, ...segments) =>
      this.vscode.Uri.joinPath(base, ...segments)
    );
    const nonce = createNonce();
    webview.html = renderWebviewHtml({
      cspSource: webview.cspSource,
      nonce,
      scriptUri: webview
        .asWebviewUri(this.vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'main.js'))
        .toString(),
      styleText: composeStyleText(),
      title: documentName(document.uri),
      lang: this.vscode.env.language
    });

    webview.onDidReceiveMessage((message: unknown) => {
      void this.handleMessage(this.panelMeta.get(panel)?.uri ?? document.uri, panel, message);
    });

    await this.sendInit(document.uri, panel);
  }

  /** 重渲染（`vviewer.reload` 命令面）：向该文档的 panel 重推 init */
  async reload(uri: vscode.Uri): Promise<boolean> {
    const panel = this.panels.get(uri.toString());
    if (!panel) return false;
    await this.sendInit(uri, panel);
    return true;
  }

  /**
   * 订阅设置与主题变更（spec H T6 实时生效——不要求重开文件）。
   *
   * 订阅面收敛在本方法内（宿主入口只登记 disposable）→ 订阅行为可单测（注入假
   * vscode 运行时触发事件即可断言推送路径）。
   */
  watchChanges(): vscode.Disposable[] {
    return [
      this.vscode.workspace.onDidChangeConfiguration((event) => {
        if (!event.affectsConfiguration('vviewer')) return;
        void this.pushSettings();
      }),
      this.vscode.window.onDidChangeActiveColorTheme(() => {
        void this.pushTheme();
      })
    ];
  }

  /**
   * 向所有已开 panel 推送设置（spec H T6 实时生效：配置变更 → 不要求重开文件）。
   *
   * 每个 panel 按**各自文档的 languageId** 解析 per-language 覆盖（RF 9）——
   * 不同语言的文件可同时持有不同的引擎/图表档位。
   */
  async pushSettings(): Promise<void> {
    for (const [panel, meta] of this.panelMeta) {
      const configuration = this.vscode.workspace.getConfiguration(
        'vviewer',
        meta.languageId ? { languageId: meta.languageId } : undefined
      );
      const settings = readWebviewSettings(this.vscode.workspace, meta.languageId);
      const languageOverride = hasLanguageOverride(
        configuration,
        SETTING_KEYS.highlightEngine,
        meta.languageId
      );
      const message: HostToWebview = { kind: 'settings', settings, languageOverride };
      await panel.webview.postMessage(message);
    }
  }

  /** 向所有已开 panel 推送主题令牌（VSCode 活动主题变化 → 动态令牌整体替换 + mermaid 重画） */
  async pushTheme(): Promise<void> {
    const theme = this.currentTheme();
    const message: HostToWebview = { kind: 'theme', theme };
    for (const panel of this.panelMeta.keys()) {
      await panel.webview.postMessage(message);
    }
  }

  /** 请求宿主触发导出（宿主命令面 → webview 组装自包含 HTML → 回到宿主写盘） */
  async requestExport(uri: vscode.Uri): Promise<boolean> {
    const panel = this.panels.get(uri.toString());
    if (!panel) return false;
    const message: HostToWebview = { kind: 'export-request' };
    await panel.webview.postMessage(message);
    return true;
  }

  /** 当前活动 panel 的文档 URI（无则 undefined） */
  activeDocumentUri(): vscode.Uri | undefined {
    if (this.activeKey === null) return undefined;
    const panel = this.panels.get(this.activeKey);
    return panel ? this.vscode.Uri.parse(this.activeKey) : undefined;
  }

  dispose(): void {
    for (const panel of this.panels.values()) panel.dispose();
    this.panels.clear();
    this.activeKey = null;
  }

  /** 推送 init（文档字节 + 设置 + 主题 + 资产 URI） */
  private async sendInit(uri: vscode.Uri, panel: vscode.WebviewPanel): Promise<void> {
    const outcome = await readDocumentBytes(this.vscode.workspace.fs, uri);
    const size = outcome.ok ? outcome.size : outcome.reason === 'too-large' ? outcome.size : 0;
    const bytes = outcome.ok ? outcome.bytes : new Uint8Array(0);
    const languageId = await this.resolveLanguageId(uri, size);
    const message: HostToWebview = {
      kind: 'init',
      doc: { name: documentName(uri), path: uri.path, size, bytes, languageId },
      theme: this.currentTheme(),
      settings: readWebviewSettings(this.vscode.workspace, languageId),
      assets: await this.buildAssets(panel.webview)
    };
    // 记 languageId——设置变更推送时按各自文档的语言解析 per-language 覆盖
    const meta = this.panelMeta.get(panel);
    if (meta) meta.languageId = languageId;
    await panel.webview.postMessage(message);
  }

  /** 当前主题（kind + `--ui-*` 令牌快照） */
  private currentTheme(): ThemePayload {
    const kind =
      this.vscode.window.activeColorTheme.kind === this.vscode.ColorThemeKind.Dark ? 'dark' : 'light';
    return { kind, cssVars: themeCssVars(kind) };
  }

  /** 资产 URI（含 grammar 清单读取） */
  private async buildAssets(webview: vscode.Webview): Promise<AssetUris> {
    return buildAssetUris({
      webview,
      extensionUri: this.context.extensionUri,
      joinPath: (base, ...segments) => this.vscode.Uri.joinPath(base, ...segments),
      grammars: await this.readGrammarTable()
    });
  }

  /** 读 grammar 清单（manifest 的 grammars 键集）——缺件即空表（webview 侧可见降级） */
  private async readGrammarTable(): Promise<GrammarTable> {
    const uri = this.vscode.Uri.joinPath(
      this.context.extensionUri,
      'dist',
      'webview',
      'assets',
      'grammars',
      'manifest.json'
    );
    try {
      const bytes = await this.vscode.workspace.fs.readFile(uri);
      const manifest = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
      // 映射单源：manifest → GrammarTable 的规则只在 webview/assets.ts 一处实现
      // （条目显式丢弃 base——带 base 会绕开 grammarsBase 打到错误源）
      return toGrammarTable(manifest);
    } catch {
      return {};
    }
  }

  /**
   * 取文档 languageId（per-language 设置覆盖的前提，RF 9）。
   *
   * 优先取已打开的文本文档（零成本）；否则在文件较小时程序化打开文本文档取 languageId
   * （VSCode 无「不经打开即取 languageId」的公开 API）。超限文件不打开（避免大文件入内存）。
   */
  private async resolveLanguageId(uri: vscode.Uri, size: number): Promise<string | undefined> {
    const opened = this.vscode.workspace.textDocuments.find(
      (doc) => doc.uri.toString() === uri.toString()
    );
    if (opened) return opened.languageId;
    if (size > LANGUAGE_PROBE_MAX_BYTES) return undefined;
    try {
      const doc = await this.vscode.workspace.openTextDocument(uri);
      return doc.languageId;
    } catch {
      return undefined;
    }
  }

  /** webview → host 消息路由 */
  private async handleMessage(
    documentUri: vscode.Uri,
    panel: vscode.WebviewPanel,
    message: unknown
  ): Promise<void> {
    if (!isWebviewToHost(message)) return;
    switch (message.kind) {
      case 'ready':
        return;
      case 'read-file':
        await this.handleReadFile(documentUri, panel, message.id, message.path);
        return;
      case 'export-html':
        await this.handleExportHtml(
          documentUri,
          panel,
          message.id,
          message.html,
          message.suggestedName
        );
        return;
      case 'open-external':
        await this.handleOpenExternal(message.url);
        return;
      case 'navigate':
        await this.handleNavigate(documentUri, panel, message.path);
        return;
      case 'report':
        this.handleReport(message.level, message.message);
        return;
    }
  }

  /** 按路径读文件（相对链接/相对图片探测面，spec §7 ①） */
  private async handleReadFile(
    documentUri: vscode.Uri,
    panel: vscode.WebviewPanel,
    id: number,
    path: string
  ): Promise<void> {
    const target = this.resolveRelative(documentUri, path);
    const outcome = await readDocumentBytes(this.vscode.workspace.fs, target);
    const message: HostToWebview = outcome.ok
      ? { kind: 'file-bytes', id, bytes: outcome.bytes }
      : { kind: 'file-bytes', id, bytes: null, error: outcome.reason };
    await panel.webview.postMessage(message);
  }

  /** 导出 HTML 写盘（showSaveDialog + fs.writeFile → export-result 回执） */
  private async handleExportHtml(
    documentUri: vscode.Uri,
    panel: vscode.WebviewPanel,
    id: number,
    html: string,
    suggestedName: string
  ): Promise<void> {
    try {
      const target = await this.vscode.window.showSaveDialog({
        defaultUri: this.suggestedExportUri(documentUri, suggestedName)
      });
      if (!target) {
        await panel.webview.postMessage({ kind: 'export-result', id, ok: false, error: 'cancelled' });
        return;
      }
      await this.vscode.workspace.fs.writeFile(target, new TextEncoder().encode(html));
      await panel.webview.postMessage({ kind: 'export-result', id, ok: true, path: target.fsPath });
    } catch (e: unknown) {
      await panel.webview.postMessage({
        kind: 'export-result',
        id,
        ok: false,
        error: errorMessage(e)
      });
    }
  }

  /** 相对链接导航（spec §7 ①）：切到目标文档并重推 init（面板复用，不新开） */
  private async handleNavigate(
    documentUri: vscode.Uri,
    panel: vscode.WebviewPanel,
    path: string
  ): Promise<void> {
    const target = this.resolveRelative(documentUri, path);
    const outcome = await readDocumentBytes(this.vscode.workspace.fs, target);
    if (!outcome.ok) {
      // 缺件/超限 → 可见失败面（提示条由 webview 侧呈现；此处走 host 错误通道）
      void this.vscode.window.showErrorMessage(t('notice.file.missing', { path }));
      return;
    }
    const previousKey = documentUri.toString();
    this.panels.delete(previousKey);
    this.panels.set(target.toString(), panel);
    this.panelMeta.set(panel, { uri: target });
    panel.title = documentName(target);
    await this.sendInit(target, panel);
  }

  /** 打开外部链接（走 VSCode 原生 open——不经 webview 导航） */
  private async handleOpenExternal(url: string): Promise<void> {
    try {
      await this.vscode.commands.executeCommand('vscode.open', this.vscode.Uri.parse(url));
    } catch (e: unknown) {
      console.warn(`[vviewer] ${t('errors.link.openExternalFailed')}: ${errorMessage(e)}`);
    }
  }

  /** webview 报告（webview 无 console 出口 → 走 host 通道；host 侧 console 兜底可见） */
  private handleReport(level: 'warn' | 'error', message: string): void {
    const text = `[vviewer] ${message}`;
    if (level === 'error') {
      console.error(text);
      void this.vscode.window.showErrorMessage(message);
    } else {
      console.warn(text);
    }
  }

  /** 建议的导出路径（工作区首目录优先，回落文档所在目录） */
  private suggestedExportUri(documentUri: vscode.Uri, suggestedName: string): vscode.Uri {
    const folder = this.vscode.workspace.workspaceFolders?.[0]?.uri ?? this.vscode.Uri.joinPath(documentUri, '..');
    return this.vscode.Uri.joinPath(folder, suggestedName);
  }

  /** 相对路径解析（相对文档所在目录） */
  private resolveRelative(documentUri: vscode.Uri, path: string): vscode.Uri {
    const cleaned = path.replace(/^\/+/, '').replace(/^\.\//, '');
    return this.vscode.Uri.joinPath(documentUri, '..', cleaned);
  }
}

/** 文档名（文件名，含扩展名） */
export function documentName(uri: vscode.Uri): string {
  const segments = uri.path.split('/');
  return segments[segments.length - 1] ?? uri.path;
}
