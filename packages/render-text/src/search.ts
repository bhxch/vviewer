// search.ts — 文件内搜索纯函数（Task 6）。行级扫描：输入是已存在的行数组
// （code.ts 的 buildLineIndex 产物），大文件天然分块、无额外 IO。
// 大小写折叠用 toLowerCase（简单折叠）：个别 Unicode 字符折叠后长度会变
// （如 'İ' → 'i̇' 两个码元），此时行内偏移可能偏移——编辑器惯例同此，不做映射修正。
import type { SearchMatch } from '@vviewer/core';

/**
 * 带上下文的命中：core SearchMatch 的 render-text 侧扩展（不改 core）。
 * - code/html 源码视图（searchCode）：line/start/end 为行号与行内 UTF-16 偏移，
 *   preview 为命中行截断命中前后各 40 字符的上下文。
 * - markdown 渲染视图：渲染 DOM 无行概念，line 复用为文档序命中序号
 *   （gotoMatch 按同序定位），start/end 恒 0，preview 为命中文本节点的
 *   前后 40 字符上下文。
 */
export interface SearchMatchWithPreview extends SearchMatch {
  preview: string;
}

export interface SearchOptions {
  /** 默认 false（大小写不敏感） */
  caseSensitive?: boolean;
}

/** preview 在命中前后各保留的字符数 */
export const PREVIEW_CONTEXT = 40;

/** 命中行截断前后 PREVIEW_CONTEXT 字符：截断侧加省略号，未截断侧不加 */
export function makePreview(line: string, start: number, end: number): string {
  const from = Math.max(0, start - PREVIEW_CONTEXT);
  const to = Math.min(line.length, end + PREVIEW_CONTEXT);
  const prefix = from > 0 ? '…' : '';
  const suffix = to < line.length ? '…' : '';
  return `${prefix}${line.slice(from, to)}${suffix}`;
}

/**
 * 行数组扫描：返回全部命中（行号 + 行内偏移 + 上下文 preview），文档序。
 * 同行多命中互不重叠按序推进；空 query 快速返回 []（调用方以此为"退出搜索"语义）。
 */
export function searchCode(
  lines: string[],
  query: string,
  opts: SearchOptions = {}
): SearchMatchWithPreview[] {
  if (query === '') return [];
  const needle = opts.caseSensitive === true ? query : query.toLowerCase();
  const out: SearchMatchWithPreview[] = [];
  for (let line = 0; line < lines.length; line++) {
    const raw = lines[line] ?? '';
    const text = opts.caseSensitive === true ? raw : raw.toLowerCase();
    let from = 0;
    for (;;) {
      const idx = text.indexOf(needle, from);
      if (idx === -1) break;
      const start = idx;
      const end = idx + needle.length;
      out.push({ line, start, end, preview: makePreview(raw, start, end) });
      from = end; // 空 query 已排除，end > from 必然前进
    }
  }
  return out;
}
