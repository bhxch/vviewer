// main.ts — webview 侧入口（spec H T3）。
//
// 职责：消息协议接线 + 装配 + 渲染调度。
//
// 运行期形态：webview 内无 Node、无服务端、无 localStorage——一切外部输入经宿主消息
// 通道进来（文件字节 / 设置 / 主题 / 资产 URI），一切需要宿主能力的动作经消息通道出去
// （相对文件读 / 导出写盘 / 外链打开 / 相对链接导航 / 错误报告）。
//
// 样式供给：markdown 排版 + 壳样式由**宿主**内联进 HTML（单一 `<style nonce>`，T2 落）；
// 动态令牌（`--ui-*` / `--vv-ts-*`）与 katex 排印样式由**本侧**注入（主题变更需整体
// 替换；katex 样式在 esbuild 下不会自动注入——包内 `pipeline.ts:643` 的动态 CSS import
// 是 vite 专属形态）。
import { assembleViewer, type Assembled } from './assemble';
import { HostBridge } from './dispatchHost';
import { applyEngineState } from './engineBadge';
import {
  resolveHighlightEngine,
  startHighlightRuntime,
  type HighlightRuntime
} from './highlight';
import { Shell } from './shell';
import { applyTokenCss, buildTokenCss, injectKatexCss, kindCssVars, loadCaptureCss } from './theme';
import { createSingleFileSource } from './store';
import {
  isHostToWebview,
  MAX_BYTES,
  type AssetUris,
  type HostToWebview,
  type ThemePayload,
  type WebviewSettings
} from '../host/protocol';
import { pickLocale, setLocale, t } from '../i18n/core';
import type { MarkdownImageResolver, RelativeLinkOpener, RelativeLinkResolver } from '@bhxch/vviewer-markdown';

declare function acquireVsCodeApi<T = unknown>(): T;

interface WebviewApi {
  postMessage(message: unknown): void;
}

/** VSCode webview API（**只能取一次**——重复取用抛错） */
const api = acquireVsCodeApi<WebviewApi>();

// locale：webview 的 navigator.language 跟随 VSCode 显示语言（zh* → zh-CN，其余 → en）
setLocale(pickLocale(typeof navigator === 'undefined' ? undefined : navigator.language));

const shell = new Shell({
  root: document.getElementById('vv-root') ?? document.body,
  labels: {
    tocTitle: t('shell.panel.tocTitle'),
    tocToggle: t('shell.panel.tocToggle'),
    tocEmpty: t('shell.panel.tocEmpty'),
    engineBadge: t('shell.panel.engineBadge')
  }
});

const bridge = new HostBridge({ api });

let settings: WebviewSettings | null = null;
let theme: ThemePayload | null = null;
let assets: AssetUris | null = null;
let doc: { name: string; path: string; size: number; bytes: Uint8Array } | null = null;
let assembled: Assembled | null = null;
let highlight: HighlightRuntime | null = null;
let currentInstance: { destroy(): void } | null = null;

window.addEventListener('message', (event: MessageEvent) => {
  const message = event.data as HostToWebview;
  if (!isHostToWebview(message)) return;
  void handleHostMessage(message);
});

async function handleHostMessage(message: HostToWebview): Promise<void> {
  switch (message.kind) {
    case 'init':
      await onInit(message);
      return;
    case 'settings': {
      const previousTier = settings ? resolveHighlightEngine(settings) : null;
      settings = message.settings;
      if (settings && assets && theme) {
        // 引擎档位变了才重启 worker（否则每次设置变更都重拉 worker 源，浪费）
        if (resolveHighlightEngine(settings) !== previousTier) await startHighlight(settings);
        // 重新装配：十一处缝捕获的是装配期的设置 → 设置变更须重装缝（而非只重渲）
        assemble(settings);
      }
      await rerender();
      return;
    }
    case 'theme':
      theme = message.theme;
      await applyTheme();
      await rerender();
      return;
    case 'file-bytes':
    case 'export-result':
      bridge.handleMessage(message);
      return;
    default:
      return;
  }
}

async function onInit(message: Extract<HostToWebview, { kind: 'init' }>): Promise<void> {
  doc = {
    name: message.doc.name,
    path: message.doc.path,
    size: message.doc.size,
    bytes: message.doc.bytes
  };
  settings = message.settings;
  theme = message.theme;
  assets = message.assets;

  await applyTheme();
  await injectKatexCss(document, assets.katexCssUrl, assets.fontsBase);

  // 高亮链路先起（代码渲染器的首次渲染即用得上 tree-sitter）
  await startHighlight(settings);
  assemble(settings);

  await rerender();
}

/** 起高亮运行时（worker 起活 + client attach + 引擎态可见） */
async function startHighlight(current: WebviewSettings): Promise<void> {
  if (!assets) return;
  highlight?.dispose();
  highlight = await startHighlightRuntime({
    assets,
    settings: current,
    onDegraded: (state) => applyEngineState(shell, state)
  });
  applyEngineState(shell, highlight.state);
}

/** 装配渲染层（设置变更时重装——缝捕获装配期的设置） */
function assemble(current: WebviewSettings): void {
  if (!assets || !theme) return;
  assembled = assembleViewer({
    settings: current,
    assets,
    themeKind: theme.kind,
    resolveImage,
    resolveLink,
    openLink,
    text: (key) => t(key)
  });
}

/** 应用动态令牌（`--ui-*` + `--vv-ts-*`）——整体替换面 */
async function applyTheme(): Promise<void> {
  if (!theme || !assets) return;
  const uiVars = { ...kindCssVars(theme.kind), ...theme.cssVars };
  const captureCss = await loadCaptureCss(assets.themesUrl, theme.kind);
  applyTokenCss(document, buildTokenCss(uiVars, captureCss));
}

/** 渲染调度（装配 → dispatch → toc 归一） */
async function rerender(): Promise<void> {
  if (!doc || !assembled || !settings) return;
  currentInstance?.destroy();
  currentInstance = null;
  shell.elements.main.replaceChildren();

  // 大文件闸：超限不渲染（宿主侧亦不读文件），显示引导占位
  if (doc.size > MAX_BYTES) {
    shell.setNotice(t('viewer.document.tooLarge', { limit: '200MB' }), 'warn');
    return;
  }

  try {
    const source = createSingleFileSource(doc.bytes, doc.name, doc.path);
    const result = await assembled.dispatcher.dispatch(
      source,
      doc.bytes as Uint8Array<ArrayBuffer>,
      shell.elements.main
    );
    currentInstance = result.instance;
    shell.setToc(tocEntriesOf(result.instance));
  } catch (e: unknown) {
    shell.setNotice(e instanceof Error ? e.message : t('errors.common.unknown'), 'error');
  }
}

/** toc 归一（markdown heading 与 code symbol 合流） */
function tocEntriesOf(instance: {
  getToc?(): Array<{ level: number; text: string; id: string }>;
  getOutline?(): Array<{ name: string; startRow?: number }>;
}): Array<{ id: string; label: string; level: number; kind: 'heading' | 'symbol' }> {
  const toc = instance.getToc?.() ?? [];
  if (toc.length > 0) {
    return toc.map((entry) => ({
      id: entry.id,
      label: entry.text,
      level: entry.level,
      kind: 'heading' as const
    }));
  }
  const outline = instance.getOutline?.() ?? [];
  return outline.map((entry, index) => ({
    id: String(index),
    label: entry.name,
    level: 1,
    kind: 'symbol' as const
  }));
}

/** 相对图片 → blob URL（spec §7 ②；blob 生命周期由包内视图托管 revoke） */
const resolveImage: MarkdownImageResolver = async (src) => {
  const bytes = await bridge.readFile(src);
  if (!bytes) return null;
  return URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>]));
};

/** 相对链接解析（spec §7 ①；经宿主往返探测） */
const resolveLink: RelativeLinkResolver = async (href) => {
  const bytes = await bridge.readFile(href);
  if (!bytes) return { kind: 'missing', path: href };
  return { kind: 'file', storeId: 'single', path: href };
};

/** 相对链接打开（file → 请求宿主切文档；missing → 顶部提示条） */
const openLink: RelativeLinkOpener = (target, href) => {
  if (target.kind === 'file') {
    bridge.navigate(target.path);
    return;
  }
  shell.setNotice(t('notice.file.missing', { path: target.path ?? href }), 'warn');
};
