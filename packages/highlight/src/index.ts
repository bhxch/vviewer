export {
  expandQuery,
  type ExpandedQuery,
  type QueryAssets,
  type QueryFile,
} from './queries';
export {
  captureToCssVar,
  resolveCapture,
  themeToCssVars,
  type ThemeStyle,
  type ThemeTable,
} from './theme';
export type { HighlightInterval, HighlightRequest, HighlightResponse } from './types';
export {
  TreeSitterEngine,
  type EngineOptions,
  type GrammarTable,
  type HighlightResult,
  type VirtualQueries,
} from './core-parse';
export { HighlightClient, HighlightCanceledError } from './client';
export { createHandler, initWorker, serveWorker, type WorkerInit } from './worker';
