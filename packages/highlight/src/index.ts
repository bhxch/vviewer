export {
  expandQuery,
  expandQueryAsync,
  type AsyncQuerySource,
  type ExpandedQuery,
  type QueryAssets,
  type QueryFile,
} from './queries';
export { detectLanguage } from './langdetect';
export {
  captureToCssClass,
  captureToCssVar,
  resolveCapture,
  themeToCssVars,
  type ThemeStyle,
  type ThemeTable,
} from './theme';
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
