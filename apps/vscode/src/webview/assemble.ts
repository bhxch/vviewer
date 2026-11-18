// assemble.ts — webview 装配层（spec H T3）。
//
// 本模块是 `apps/web/src/lib/viewer.ts`（web 端装配单点）的**无 app 依赖重写**：
// 零 `$app`/`import.meta.env`/IndexedDB/i18n 目录依赖——扩展无服务端、无应用壳、无
// 本地存储；一切外部输入经入参注入。
//
// 注册表（与 web 端同序，差别仅是跳过 diagram/foreign/Office 三块——裁量 3：
// archive 裁剪、foreign 20 组与 Office 三件套不在 MVP 范围）：
// code → markdown → html → image → av → pdf → hex → jsonl → generated 兜底。
//
// **十一处 setter 逐一接线**（计划 T3 缝表；缝只注入一次，重复注入即语义漂移）：
// ①~⑦ markdown 组合包（7）｜⑧ sanitize 包｜⑨ core 包｜⑩⑪ 两个渲染包的 worker URL 缝。
// 返回值里的 `seams` 暴露本层注入的函数，供单测逐条断言（getter 形态比对）。
import {
  createDispatcher,
  createRegistry,
  GENERATED_EXTENSIONS,
  setRenderFailedText,
  type Dispatcher,
  type Registry
} from '@bhxch/vviewer-core';
import { codeRenderer } from '@bhxch/vviewer-render-text';
import { htmlRenderer } from '@bhxch/vviewer-render-text/html';
import { jsonlRenderer } from '@bhxch/vviewer-render-text/jsonl';
import { fenceToHtml } from '@bhxch/vviewer-render-text/markdown/markdownRenderer';
import {
  markdownRenderer,
  renderMarkdownBody,
  setDiagramOptions,
  setHighlightFence,
  setMarkdownBackend,
  setMarkdownImageResolver,
  setRelativeLinkOpener,
  setRelativeLinkResolver,
  setResolveRemoteBase,
  DEFAULT_KROKI_HOST,
  type DiagramRenderOptions,
  type MarkdownBackend,
  type MarkdownImageResolver,
  type RelativeLinkOpener,
  type RelativeLinkResolver,
  type ResolveRemoteBase
} from '@bhxch/vviewer-markdown';
import { imageRenderer } from '@bhxch/vviewer-render-media';
import { avRenderer } from '@bhxch/vviewer-render-media/av';
import { pdfRenderer, preferModernBuild, setPdfWorkerUrlProvider } from '@bhxch/vviewer-render-doc';
import { hexRenderer, setHexWorkerUrlProvider } from '@bhxch/vviewer-render-binary';
import { setExternalImagePolicyProvider } from '@bhxch/vviewer-sanitize';
import type { AssetUris, WebviewSettings } from '../host/protocol';
import type { MessageKey } from '../i18n/core';

/** 装配入参（一切外部输入经此注入——装配层自身零框架依赖） */
export interface AssembleDeps {
  /** 当前设置（归一后） */
  settings: WebviewSettings;
  /** 资产 URI（worker URL 等） */
  assets: AssetUris;
  /** 活动主题（决定 mermaid 主题与动态令牌） */
  themeKind: 'dark' | 'light';
  /** 相对图片 → blob URL（spec §7 ②） */
  resolveImage: MarkdownImageResolver;
  /** 相对链接解析（spec §7 ①） */
  resolveLink: RelativeLinkResolver;
  /** 相对链接打开 */
  openLink: RelativeLinkOpener;
  /** 文案取值（错误面走目录） */
  text: (key: MessageKey) => string;
}

/** 本层注入的缝（供单测逐条断言——getter 形态比对） */
export interface InjectedSeams {
  highlightFence: typeof fenceToHtml;
  markdownBackend: MarkdownBackend;
  resolveRemoteBase: ResolveRemoteBase;
  markdownImageResolver: MarkdownImageResolver;
  relativeLinkResolver: RelativeLinkResolver;
  relativeLinkOpener: RelativeLinkOpener;
  diagramOptions: () => DiagramRenderOptions;
  externalImagePolicyProvider: () => { policy: WebviewSettings['externalImages']; allowlist: string[] };
  renderFailedText: () => string;
  pdfWorkerUrlProvider: () => string;
  hexWorkerUrlProvider: () => string;
}

/** 装配产物 */
export interface Assembled {
  registry: Registry;
  dispatcher: Dispatcher;
  seams: InjectedSeams;
}

/**
 * 图表渲染选项（T3 的粗粒度版本）。
 *
 * T5 将其替换为**逐语言**的外联闸映射（`diagramGate.ts`：闸关时仅离线引擎族给
 * 'local'，其余 'source'；'off' → 'source'）。本版只做「设置枚举 → 模式」的直映射，
 * 图表外联闸的逐语言判定留 T5。
 */
export function diagramOptionsOf(deps: AssembleDeps): DiagramRenderOptions {
  const mode = deps.settings.diagramMode;
  return {
    krokiHost: DEFAULT_KROKI_HOST,
    mermaidTheme: deps.themeKind === 'dark' ? 'dark' : 'default',
    modeOf: () => (mode === 'off' ? 'source' : mode === 'kroki' ? 'kroki' : 'local'),
    // graphviz 默认 viz-js（离线）；'hpcc' 走 CDN 外联渲染器——恒不选（T5 的闸口径）
    rendererOf: () => undefined
  };
}

/** 装配 webview 渲染层（注册表 + 十一处 setter + dispatcher） */
export function assembleViewer(deps: AssembleDeps): Assembled {
  const registry = createRegistry();

  // 装序铁律：专有渲染器先于 generated 兜底安装（installFallbackExtensions 遇已认领
  // 扩展名即跳过——md/markdown 归 markdown 渲染器、html/htm 归 html 渲染器）
  registry.install(codeRenderer);
  registry.install(markdownRenderer);
  registry.install(htmlRenderer);
  registry.install(imageRenderer);
  registry.install(avRenderer);
  registry.install(pdfRenderer);
  registry.install(hexRenderer);
  registry.install(jsonlRenderer);
  registry.installFallbackExtensions('code', GENERATED_EXTENSIONS);

  // ① 围栏高亮桥（唯一注入点=T3；T4 只做 client 适配与 attach，不重复注入）
  setHighlightFence(fenceToHtml);

  // ② markdown 正文引擎恒本地（扩展无服务端——compute/watch/mounts 全不适用）
  const markdownBackend: MarkdownBackend = async ({ text }) => ({
    html: renderMarkdownBody(text),
    where: 'local'
  });
  setMarkdownBackend(markdownBackend);

  // ③ 远程计算来源恒 null（扩展无远程 store）
  const resolveRemoteBase: ResolveRemoteBase = () => null;
  setResolveRemoteBase(resolveRemoteBase);

  // ④⑤⑥ 相对图片 / 相对链接（spec §7 ①②）
  setMarkdownImageResolver(deps.resolveImage);
  setRelativeLinkResolver(deps.resolveLink);
  setRelativeLinkOpener(deps.openLink);

  // ⑦ 图表渲染选项（T3 粗粒度版；逐语言外联闸在 T5 落）
  // 记忆化：同一次装配内返回同一份对象（设置变更时 host 侧重新装配，不在装配内改）
  let cachedDiagramOptions: DiagramRenderOptions | null = null;
  const diagramOptions = (): DiagramRenderOptions =>
    (cachedDiagramOptions ??= diagramOptionsOf(deps));
  setDiagramOptions(diagramOptions);

  // ⑧ 外链图片三档 + 白名单（spec D §3.1）
  const externalImagePolicyProvider = () => ({
    policy: deps.settings.externalImages,
    allowlist: deps.settings.externalImageAllowlist
  });
  setExternalImagePolicyProvider(externalImagePolicyProvider);

  // ⑨ 错误卡空文案兜底（包内缺省英文；扩展恒注入目录值）
  const renderFailedText = () => deps.text('errors.render.failed');
  setRenderFailedText(renderFailedText);

  // ⑩ pdfjs worker URL（双分支按能力选支——选支在 webview 侧：worker 与主模块同构建）
  const pdfWorkerUrlProvider = () =>
    preferModernBuild() ? deps.assets.pdfWorkerModernUrl : deps.assets.pdfWorkerLegacyUrl;
  setPdfWorkerUrlProvider(pdfWorkerUrlProvider);

  // ⑪ hex 解析 worker URL（不注入即 404 异步失败 → 渲染挂死）
  const hexWorkerUrlProvider = () => deps.assets.binaryWorkerUrl;
  setHexWorkerUrlProvider(hexWorkerUrlProvider);

  return {
    registry,
    dispatcher: createDispatcher(registry),
    seams: {
      highlightFence: fenceToHtml,
      markdownBackend,
      resolveRemoteBase,
      markdownImageResolver: deps.resolveImage,
      relativeLinkResolver: deps.resolveLink,
      relativeLinkOpener: deps.openLink,
      diagramOptions,
      externalImagePolicyProvider,
      renderFailedText,
      pdfWorkerUrlProvider,
      hexWorkerUrlProvider
    }
  };
}
