// pdf.test.ts — PDF 文本聚合搜索纯函数单测。
// jsdom 下 pdfjs 无法真渲染（无 canvas 位图后端），渲染/跳页走 T7 Playwright E2E；
// 此处只覆盖 search() 背后的纯函数：页文本拼接（extractPageText）与跨页扫描（searchPdfPages）。
import { describe, expect, it } from 'vitest';
import { extractPageText, searchPdfPages } from '../src/pdfText';

describe('extractPageText', () => {
  it('无 EOL 的相邻片段以空格连接', () => {
    expect(
      extractPageText([
        { str: 'vviewer', hasEOL: false },
        { str: 'pdf', hasEOL: false },
        { str: 'sample', hasEOL: false }
      ])
    ).toBe('vviewer pdf sample');
  });

  it('hasEOL 的片段以换行连接', () => {
    expect(
      extractPageText([
        { str: 'first', hasEOL: true },
        { str: 'second', hasEOL: false }
      ])
    ).toBe('first\nsecond');
  });

  it('空片段列表得空文本', () => {
    expect(extractPageText([])).toBe('');
  });
});

describe('searchPdfPages', () => {
  const pages = ['vviewer pdf sample', 'nothing here', 'sample twice, sample again'];

  it('返回跨页命中，line 为 0 起页号', () => {
    const hits = searchPdfPages(pages, 'sample');
    expect(hits.map((h) => h.line)).toEqual([0, 2, 2]);
  });

  it('start/end 为页文本内 UTF-16 偏移（不含端）', () => {
    const hits = searchPdfPages(pages, 'pdf');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.start).toBe(8);
    expect(hits[0]!.end).toBe(11);
  });

  it('同页多命中互不重叠按序推进', () => {
    const hits = searchPdfPages([pages[2]!], 'sample');
    expect(hits.map((h) => h.start)).toEqual([0, 14]);
  });

  it('默认大小写不敏感，caseSensitive 可关', () => {
    expect(searchPdfPages(['SAMPLE text'], 'sample')).toHaveLength(1);
    expect(searchPdfPages(['SAMPLE text'], 'sample', { caseSensitive: true })).toHaveLength(0);
  });

  it('空 query 返回 []（SearchPanel 退出搜索语义）', () => {
    expect(searchPdfPages(pages, '')).toEqual([]);
  });

  it('preview 携带命中上下文', () => {
    const hits = searchPdfPages(['the quick brown fox jumps over the lazy dog'], 'brown');
    expect(hits[0]!.preview).toContain('quick brown fox');
  });

  it('无命中返回空数组', () => {
    expect(searchPdfPages(pages, 'absent')).toEqual([]);
  });
});
