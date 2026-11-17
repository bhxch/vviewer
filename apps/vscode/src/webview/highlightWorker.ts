/**
 * highlightWorker.ts — tree-sitter 高亮 worker 入口（spec H）。
 *
 * 包内 `serveWorker` 已含 WorkerGlobalScope 自启语义
 * （packages/vviewer-highlight/src/worker.ts:109）：真实 Worker 环境下首条消息为
 * `{ kind: 'init', ...WorkerInit }`，后续为高亮/大纲请求。
 *
 * 本文件是 esbuild worker bundle（IIFE 自包含，blob worker 前提）的 entry point：
 * worker 必须无 import（否则 blob worker 解析失败），故一切依赖在 bundle 内联。
 */
import { serveWorker } from '@bhxch/vviewer-highlight/worker';

serveWorker();
