export {
  expandQuery,
  expandQueryAsync,
  type AsyncQuerySource,
  type ExpandedQuery,
  type QueryAssets,
  type QueryFile,
} from './queries';
export { detectLanguage, detectableLanguageNames } from './langdetect';
export {
  CAPTURE_CLASS_PREFIX,
  CAPTURE_VAR_PREFIX,
  CODE_CAPTURES,
  captureToCssClass,
  captureToCssVar,
  resolveCapture,
  resolveCaptureClass,
  themeToCssVars,
  type ThemeStyle,
  type ThemeTable,
} from './theme';
export {
  assignIntervalsToLines,
  escapeHtml,
  flattenIntervals,
  lineOf,
  mergeChunkLines,
  overlaySearchHits,
  renderLineHtml,
  splitHighlightedLines,
  type LineAssignment,
  type LineSeg,
  type SearchHitOverlayOptions,
} from './lines';
export type {
  HighlightChunk,
  HighlightContext,
  HighlightInterval,
  HighlightRequest,
  HighlightResponse,
} from './types';
export {
  TreeSitterEngine,
  type EngineInitProgress,
  type EngineOptions,
  type GrammarTable,
  type HighlightResult,
  type VirtualQueries,
} from './core-parse';
export { HighlightClient, HighlightCanceledError } from './client';
export {
  colorsToUiVars,
  TEXTMATE_TO_CAPTURE,
  themeKind,
  tokenColorsToThemeTable,
  validateVscodeTheme,
  type VscodeThemeJson,
} from './vscode';
export {
  createHandler,
  initWorker,
  serveWorker,
  type InitMessage,
  type InitProgressFrame,
  type WorkerInit
} from './worker';
