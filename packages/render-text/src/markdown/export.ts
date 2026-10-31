// export.ts — 转出口（shim）：导出装配纯函数（collectExportHtml/collectPrintHtml/
// exportBaseCss）实现已随 @vviewer/markdown 组合包迁出（packages/markdown/src/
// export.ts；共享规则段改由包内 css.ts 单源引用，签名与拆分前逐符号一致）。本文件
// re-export 保持 '@vviewer/render-text/markdown/export' 子路径导出符号面不变
// （apps/web MetaPanel 触发壳的既有 import 零感知）。
export {
  collectExportHtml,
  collectPrintHtml,
  exportBaseCss,
  type ExportHtmlOptions,
  type PrintPage
} from '@vviewer/markdown';
