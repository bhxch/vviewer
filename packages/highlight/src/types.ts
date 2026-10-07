/** 单个高亮区间：UTF-16 偏移（JS 字符串索引），左闭右开。 */
export interface HighlightInterval {
  start: number;
  end: number;
  /** 捕获名（无 `@` 前缀，如 `string`、`function.builtin`）。 */
  capture: string;
}

/** Worker 请求。injectionsDepth 为当前注入深度（默认 0，≤3 层内递归）。 */
export interface HighlightRequest {
  id: number;
  text: string;
  lang: string;
  injectionsDepth?: number;
}

/** Worker 响应。ok:false 时 error 有值，由上层决定降级 hljs。 */
export interface HighlightResponse {
  id: number;
  ok: boolean;
  intervals?: HighlightInterval[];
  error?: string;
  engine?: 'tree-sitter' | 'hljs';
}
