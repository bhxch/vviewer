// index.ts — @bhxch/vviewer-markdown 包根导出面：markdown 完整渲染组合包（引擎→sanitize
// →enrich→五步管线→挂载→TOC→导出装配），自 render-text/src/markdown 迁出参数化。
// 高层入口 createMarkdownView 引入即完整效果（默认 tree-sitter 高亮器 + katex +
// diagram + lightbox + sanitize 全开）；低层面（runPipeline 五步/enrich/导出纯函数/
// markdown 引擎转出口）保持与 render-text 原导出同形，供细粒度组装与测试。
// 本包不依赖 @bhxch/vviewer-core / apps/* / render-text——宿主 core 值以结构类型传入
// （见 src/types.ts）。
export {
  createMarkdownView,
  markdownRenderer,
  type MarkdownView,
  type MarkdownViewOptions,
  type MarkdownRenderer,
  type MarkdownRenderedInstance,
  type MarkdownDegradedInstance,
  type MarkdownEngineState,
  type MarkdownFileMeta,
  type MarkdownBackend,
  type MarkdownBackendCall,
  type MarkdownImageResolver,
  type DiagramRenderOptions,
  type ResolveRemoteBase,
  type RenderOversize,
  assignHeadingIds,
  remapHeadingHashLinks,
  extractToc,
  slugifyHeading,
  renderMarkdownBody,
  collectTextNodes,
  MARKUP_MAX_BYTES,
  // 注入缝（模块级单例；视图路径可经 options 按实例覆盖）
  setHighlightFence,
  getHighlightFence,
  setMarkdownBackend,
  getMarkdownBackend,
  setResolveRemoteBase,
  getResolveRemoteBase,
  setMarkdownImageResolver,
  getMarkdownImageResolver,
  setDiagramOptions,
  getDiagramOptions
} from './markdownRenderer';
export {
  runPipeline,
  runSteps,
  getPipelineSteps,
  resolveUiTexts,
  DEFAULT_UI_TEXTS,
  type PipelineCtx,
  type PipelineStep,
  type PipelineUiTexts
} from './pipeline';
export { enrichMarkdownDom } from './enrich';
export {
  collectExportHtml,
  collectPrintHtml,
  exportBaseCss,
  type ExportHtmlOptions,
  type PrintPage
} from './export';
// CSS 单源：MARKDOWN_CSS（常量）与 './markdown.css' 子路径（<link>/CSS import）同源，
// 镜像等价由 test/cssMirror.test.ts 锁定
export { MARKDOWN_CSS } from './css';
export {
  createDefaultHighlightFence,
  normalizeGrammarsBase,
  deriveQueriesBase,
  DEFAULT_GRAMMARS_BASE_URL,
  DEFAULT_RUNTIME_DIR,
  DEFAULT_LITE_LANGUAGES,
  type DefaultHighlighterOptions
} from './highlightDefault';
// markdown 引擎转出口（@bhxch/vviewer-markdown-engine 原样透传）
export {
  createMarkdownEngine,
  renderMarkdownToHtml,
  protectLatexDelimiters,
  GfmAnchorizer,
  type MarkdownEngine,
  type MarkdownRenderResult
} from '@bhxch/vviewer-markdown-engine';
export { parseFrontMatter, type FrontMatterResult } from '@bhxch/vviewer-markdown-engine';
// 灯箱三导出转出口（@bhxch/vviewer-lightbox；runPipeline 亦 re-export 同组符号）
export {
  removeLightboxOverlay,
  LIGHTBOX_OVERLAY_ID,
  LIGHTBOX_OWNER_ATTR
} from '@bhxch/vviewer-lightbox';
// 图表注册表便利出口（kroki 默认 host；注册表全集经 @bhxch/vviewer-render-diagram 查询）
export { DEFAULT_KROKI_HOST } from '@bhxch/vviewer-render-diagram';
// 结构类型面（core 同形自持，宿主 core 值直接传入）
export {
  ENCODING_VALUES,
  type Encoding,
  type DetectionLike,
  type FileSourceLike,
  type SearchMatch,
  type TocEntry,
  type ComputeSource,
  type ComputeWhere,
  type HighlightFence
} from './types';
