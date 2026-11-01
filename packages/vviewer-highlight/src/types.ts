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

/**
 * 代码大纲条目（tags.scm capture 配对产物，T2/T3 消费契约）：
 * - name/kind：符号名与 capture 全名（'definition.function' / 'reference.call'；
 *   信息无损，渲染端自行映射短名与过滤引用）。
 * - line：0 起，从 byteStart 对行号（engine 侧全文已知，线性扫行）。
 * - byteStart/byteEnd：UTF-16 偏移，取 definition/reference 节点范围（左闭右开）。
 * - depth：栈式嵌套深度（class 0 / 其内 function 1），供缩进树渲染。
 */
export interface OutlineEntry {
  name: string;
  kind: string;
  line: number;
  byteStart: number;
  byteEnd: number;
  depth: number;
}

/** outline 请求（kind 判别字段，与 init/HighlightRequest 共用同一消息通道；id 与 highlight 共享单调空间）。 */
export interface OutlineRequest {
  kind: 'outline';
  id: number;
  text: string;
  lang: string;
}

/** outline 响应。ok:false 时 error 有值（大纲为锦上添花，调用方 catch 静默空）。 */
export interface OutlineResponse {
  id: number;
  ok: boolean;
  entries?: OutlineEntry[];
  error?: string;
}
