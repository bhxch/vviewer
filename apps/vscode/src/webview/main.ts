// main.ts — webview 侧入口（spec H T3/T5）。
//
// 职责：消息协议接线 + 装配 + 渲染调度 + toc 面板 + 相对链接/图片 + 导出。
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
import { buildExportHtml, exportFileName } from './exportHtml';
import {
  resolveHighlightEngine,
  startHighlightRuntime,
  type HighlightRuntime
} from './highlight';
import {
  bindExternalLinkInterceptor,
  createImageResolver,
  createLinkOpener,
  createLinkResolver
} from './links';
import { applySettingsChange, applyThemeChange, type LiveUpdateDeps } from './liveUpdate';
import { Shell } from './shell';
import { bindTocClicks, scrollToHeadingIn, tocEntriesOf } from './toc';
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

// 折叠态变更 → 上报宿主（workspaceState 持久化——spec §4.2）
shell.onToggle = (collapsed) => {
  bridge.setTocCollapsed(collapsed);
};

let settings: WebviewSettings | null = null;
let theme: ThemePayload | null = null;
let assets: AssetUris | null = null;
let doc: { name: string; path: string; size: number; bytes: Uint8Array } | null = null;
let assembled: Assembled | null = null;
let highlight: HighlightRuntime | null = null;
let currentInstance: { destroy(): void } | null = null;
/** 动态令牌当前值（导出主题变量块用） */
let themeVars: Record<string, string> = {};
/** 当前文档的 languageId（语言级覆盖提示用） */
let currentLanguageId: string | undefined;

/** 代码行高（渲染器固定行高档——render-text/src/code/strategy.ts 的 LINE_HEIGHT=20） */
const CODE_LINE_HEIGHT_PX = 20;

window.addEventListener('message', (event: MessageEvent) => {
  const message = event.data as HostToWebview;
  if (!isHostToWebview(message)) return;
  void handleHostMessage(message);
});

/**
 * 就绪握手（评审 important ⑨）：webview 脚本加载即上报 `ready`，宿主据此投递 init。
 *
 * 此前宿主「设完 webview.html 立刻 postMessage(init)」——webview 的消息监听器尚未
 * 注册时该消息即丢 → 面板内容区空白且无任何提示（协议里预留的握手面本可消除该风险
 * 却两侧都没接线）。本侧在收到 init 前**定时重发 ready**（投递不保证不丢：宿主侧
 * 那次 postMessage 也可能丢），收到 init 即停表；重发有上限（宿主恒不应答时的兜底
 * ——避免无界刷消息）。
 */
const READY_RETRY_MS = 200;
const READY_MAX_ATTEMPTS = 50; // 10s 上限：宿主恒不应答即停（面板空白仍是宿主侧问题，非本侧可解）
let hostInitialized = false;
let readyAttempts = 0;
const readyTimer: ReturnType<typeof setInterval> = setInterval(() => {
  if (hostInitialized) return;
  readyAttempts += 1;
  if (readyAttempts >= READY_MAX_ATTEMPTS) {
    clearInterval(readyTimer);
    return;
  }
  bridge.ready();
}, READY_RETRY_MS);
bridge.ready();

async function handleHostMessage(message: HostToWebview): Promise<void> {
  switch (message.kind) {
    case 'init':
      await onInit(message);
      return;
    case 'settings':
      settings = await applySettingsChange(liveUpdateDeps(), settings, message);
      return;
    case 'theme':
      theme = message.theme;
      await applyThemeChange(liveUpdateDeps());
      return;
    case 'export-request':
      await exportCurrentDocument();
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
  // 握手完成：停掉 ready 重发（宿主已投递 init——重复 ready 会触发宿主重推 init）
  hostInitialized = true;
  clearInterval(readyTimer);
  doc = {
    name: message.doc.name,
    path: message.doc.path,
    size: message.doc.size,
    bytes: message.doc.bytes
  };
  settings = message.settings;
  theme = message.theme;
  assets = message.assets;
  currentLanguageId = message.doc.languageId;

  await applyTheme();
  await injectKatexCss(document, assets.katexCssUrl, assets.fontsBase);

  // 高亮链路先起（代码渲染器的首次渲染即用得上 tree-sitter）
  await startHighlight(settings);
  assemble(settings);

  // toc 面板：停靠侧（`vviewer.toc.side`）+ 折叠态（宿主持久化值优先于设置缺省）
  shell.setSide(settings.tocSide);
  shell.setCollapsed(message.toc.collapsed);

  await rerender();
}

// toc 面板：条目点击 → 滚动到目标（markdown heading id / code 符号行号）。
// **模块级绑定一次**——每次 init 消息都绑一次会让监听器累积（一次点击触发 N 次滚动）。
bindTocClicks(shell, {
  scrollToHeading: (id) => {
    scrollToHeadingIn(shell.elements.main, id);
  },
  scrollToLine: (line) => {
    const scrollHost = (currentInstance as { getScrollHost?(): HTMLElement } | null)?.getScrollHost?.();
    if (scrollHost) {
      scrollHost.scrollTop = line * CODE_LINE_HEIGHT_PX;
      return;
    }
    shell.elements.main.scrollTop = line * CODE_LINE_HEIGHT_PX;
  }
});

// 外链点击拦截：webview 内导航会丢掉整个应用 → 交宿主原生 open（相对链接由包内
// wireRelativeLinks 接管，绝对外链走本通道）
bindExternalLinkInterceptor(document, (url) => bridge.openExternal(url));

/** 实时生效的动作面（liveUpdate.ts 消费——便于单测） */
function liveUpdateDeps(): LiveUpdateDeps {
  return {
    assets,
    theme,
    currentLanguageId,
    currentSettings: () => settings,
    applyTheme,
    applyMermaidTheme,
    reAssemble: (next) => {
      assemble(next);
      // toc 停靠侧随设置即时生效（`vviewer.toc.side`）
      shell.setSide(next.tocSide);
    },
    engineTier: resolveHighlightEngine,
    restartHighlight: startHighlight,
    reRender: rerender,
    notice: (text, level) => shell.setNotice(text, level),
    text: (key, params) => t(key, params)
  };
}

/** mermaid 主题就地重画（markdown 实例面 applyTheme——鸭子探测，缺席即无动作） */
function applyMermaidTheme(): void {
  const mermaidTheme = theme?.kind === 'dark' ? 'dark' : 'default';
  const instance = currentInstance as
    | { applyTheme?: (opts: { mermaidTheme?: string }) => void }
    | null;
  instance?.applyTheme?.({ mermaidTheme });
}

/** 装配渲染层（设置变更时重装——缝捕获装配期的设置） */
function assemble(current: WebviewSettings): void {
  if (!assets || !theme) return;
  assembled = assembleViewer({
    settings: current,
    assets,
    themeKind: theme.kind,
    resolveImage: createImageResolver(bridge),
    resolveLink: createLinkResolver(bridge),
    openLink: createLinkOpener(bridge, (path) => {
      shell.setNotice(t('notice.file.missing', { path }), 'warn');
    }),
    text: (key) => t(key)
  });
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

/** 应用动态令牌（`--ui-*` + `--vv-ts-*`）——整体替换面 */
async function applyTheme(): Promise<void> {
  if (!theme || !assets) return;
  themeVars = { ...kindCssVars(theme.kind), ...theme.cssVars };
  const captureCss = await loadCaptureCss(assets.themesUrl, theme.kind);
  for (const line of captureCss.split('\n')) {
    const [name, ...rest] = line.split(':');
    if (name && rest.length > 0) themeVars[name.trim()] = rest.join(':').replace(/;$/, '').trim();
  }
  applyTokenCss(document, buildTokenCss(themeVars, captureCss));
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

/** 导出当前文档（宿主命令触发 → 自包含 HTML → 宿主写盘 → 提示条反馈） */
async function exportCurrentDocument(): Promise<void> {
  if (!doc || !assets) return;
  try {
    const katexCss = await fetchText(assets.katexExportCssUrl);
    const html = await buildExportHtml(shell.elements.main, {
      title: doc.name,
      themeCss: buildTokenCss(themeVars),
      katexCss
    });
    const path = await bridge.exportHtml(html, exportFileName(doc.name));
    shell.setNotice(
      path ? t('notice.export.saved', { path }) : t('notice.export.cancelled'),
      path ? 'info' : 'warn'
    );
  } catch (e: unknown) {
    shell.setNotice(
      t('notice.export.failed', { reason: e instanceof Error ? e.message : String(e) }),
      'error'
    );
  }
}

/** 读文本资源（失败返回空串——排印样式缺失不阻断导出） */
async function fetchText(url: string): Promise<string> {
  try {
    const response = await fetch(url);
    if (!response.ok) return '';
    return await response.text();
  } catch {
    return '';
  }
}
