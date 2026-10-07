// pdfText.ts — PDF 搜索背后的纯函数（无 DOM/pdfjs 依赖，jsdom 可直测）。
// 页文本由 pdf.ts 从各页 textContent 提取并缓存后喂给 searchPdfPages。
import type { SearchMatch } from '@vviewer/core';

/** pdf.js textContent.items 的最窄形状（避免引 pdfjs 类型进纯函数层）；hasEOL 缺省视为非行尾 */
export interface PdfTextItem {
  str: string;
  hasEOL?: boolean;
}

/**
 * PDF 搜索命中：core SearchMatch 的 render-doc 侧扩展（不改 core）。
 * PDF 无行概念，line 复用为 0 起页号（gotoMatch 按同序跳页），
 * start/end 为该页文本内的 UTF-16 偏移，preview 为命中上下文。
 */
export interface PdfSearchMatch extends SearchMatch {
  preview: string;
}

/** preview 在命中前后各保留的字符数（与 render-text search.ts 的取值一致） */
const PREVIEW_CONTEXT = 40;

/** 命中页文本截断前后 PREVIEW_CONTEXT 字符：截断侧加省略号 */
function makePreview(text: string, start: number, end: number): string {
  const from = Math.max(0, start - PREVIEW_CONTEXT);
  const to = Math.min(text.length, end + PREVIEW_CONTEXT);
  const prefix = from > 0 ? '…' : '';
  const suffix = to < text.length ? '…' : '';
  return `${prefix}${text.slice(from, to)}${suffix}`;
}

/**
 * pdf.js 单页 textContent.items → 页文本。
 * 片段按序连接：hasEOL 的片段后接换行，否则接空格（保留词间与换行结构，
 * 让搜索命中偏移在"查看文本"语义下可解释）。
 */
export function extractPageText(items: readonly PdfTextItem[]): string {
  let out = '';
  let prevEol = false; // pdf.js 语义：item.hasEOL 表示该片段自身结束于行尾
  for (const item of items) {
    if (out === '') {
      out = item.str;
    } else {
      out += (prevEol ? '\n' : ' ') + item.str;
    }
    prevEol = item.hasEOL === true;
  }
  return out;
}

export interface SearchOptions {
  /** 默认 false（大小写不敏感） */
  caseSensitive?: boolean;
}

/**
 * 跨页扫描：输入各页文本数组，返回全部命中（文档序 = 页序 + 页内序）。
 * 同页多命中互不重叠按序推进；空 query 返回 []（调用方以此为"退出搜索"语义）。
 */
export function searchPdfPages(
  pages: readonly string[],
  query: string,
  opts: SearchOptions = {}
): PdfSearchMatch[] {
  if (query === '') return [];
  const needle = opts.caseSensitive === true ? query : query.toLowerCase();
  const out: PdfSearchMatch[] = [];
  for (let page = 0; page < pages.length; page++) {
    const raw = pages[page] ?? '';
    const text = opts.caseSensitive === true ? raw : raw.toLowerCase();
    let from = 0;
    for (;;) {
      const idx = text.indexOf(needle, from);
      if (idx === -1) break;
      const start = idx;
      const end = idx + needle.length;
      out.push({ line: page, start, end, preview: makePreview(raw, start, end) });
      from = end; // 空 query 已排除，end > from 必然前进
    }
  }
  return out;
}
