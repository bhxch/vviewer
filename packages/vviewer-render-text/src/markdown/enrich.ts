// enrich.ts — 转出口（shim）：markdown DOM 增强（callout/wikilink/任务列表/脚注等
// enrichMarkdownDom）实现已随 @bhxch/vviewer-markdown 组合包迁出（packages/vviewer-markdown/
// src/enrich.ts，自本包原样迁入），本文件 re-export 保持 test/（../src/markdown/
// enrich 相对 import）的符号面不变。
export { enrichMarkdownDom } from '@bhxch/vviewer-markdown';
