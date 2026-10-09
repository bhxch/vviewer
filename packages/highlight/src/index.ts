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
  type EngineOptions,
  type GrammarTable,
  type HighlightResult,
  type VirtualQueries,
} from './core-parse';
export { HighlightClient, HighlightCanceledError } from './client';
export { createHandler, initWorker, serveWorker, type InitMessage, type WorkerInit } from './worker';
