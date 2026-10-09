/** 单个高亮区间：UTF-16 偏移（JS 字符串索引），左闭右开。 */
export interface HighlightInterval {
  start: number;
  end: number;
  /** 捕获名（无 `@` 前缀，如 `string`、`function.builtin`）。 */
  capture: string;
}

/**
 * chunk 语义标注：text 为文件自 startLine（0 起）行起共 lineCount 行的子文本
 * （懒高亮可视区窗口，spec §5.1 子文本 parse 裁决）。
 */
export interface HighlightChunk {
  startLine: number;
  lineCount: number;
}

/** highlight 调用上下文：字段均为语义标注，不改变引擎行为（返回区间相对 text 本身）。 */
export interface HighlightContext {
  chunk?: HighlightChunk;
}

/** Worker 请求。injectionsDepth 为当前注入深度（默认 0，≤3 层内递归）；chunk 为子文本窗口语义标注（透传 engine）。 */
export interface HighlightRequest {
  id: number;
  text: string;
  lang: string;
  injectionsDepth?: number;
  chunk?: HighlightChunk;
}

/** Worker 响应。ok:false 时 error 有值，由上层决定降级 hljs。 */
export interface HighlightResponse {
  id: number;
  ok: boolean;
  intervals?: HighlightInterval[];
  error?: string;
  engine?: 'tree-sitter' | 'hljs';
}
