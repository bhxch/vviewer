/**
 * code.ts — @bhxch/vviewer-render-text 包入口 façade（FE-2 目录化拆分）。实现按域分块
 * 在 ./code/ 子模块（DAG 无环：strategy/chunks/lines/client 为底层，renderCode/
 * renderCodeWindowed 居中，index 装配在顶），本文件保持 package.json main 与
 * exports["."] 的入口不变——test/ 的 ../src/code 深导入、src/markdown 与 html/jsonl
 * 的 ../code、./code 深导入、apps/web 消费面全部零改动。符号集与拆分前的单体
 * code.ts 完全一致（export * 汇总 + 显式 type 再导出，无 default export）。
 */
export * from './code/index';

export type {
  HighlightInterval,
  HighlightStrategy,
  HLJS,
  LineSeg,
  LineAssignment,
  HighlightCallContext,
  CodeHighlightClient,
  LargeFileHighlightChunk,
  HighlightRouterFn,
  CodeEngine,
  CodeFileMeta,
  RenderCodeHandle,
  CodeRenderOptions
} from './code/index';
