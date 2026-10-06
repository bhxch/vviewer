import { describe, it, expect } from 'vitest';
import { buildLineIndex, splitHighlightedLines } from '../src/code';

describe('buildLineIndex', () => {
  it('splits keeping line count', () => {
    expect(buildLineIndex('a\nb\nc')).toEqual(['a', 'b', 'c']);
    expect(buildLineIndex('a\nb\n')).toEqual(['a', 'b', '']);
    expect(buildLineIndex('')).toEqual(['']);
  });
});

describe('splitHighlightedLines', () => {
  it('splits hljs html preserving spans across lines', () => {
    const html = '<span class="hljs-keyword">const</span> <span class="hljs-params">a</span>';
    const lines = splitHighlightedLines(html, 1);
    expect(lines).toHaveLength(1);
  });
  it('multi-line: reopening spans per line', () => {
    const html = '<span class="hljs-keyword">func\nbody</span>';
    const lines = splitHighlightedLines(html, 2);
    expect(lines[0]).toContain('hljs-keyword');
    expect(lines[1]).toContain('hljs-keyword'); // 第二行重新打开 span
    expect(lines[1]).toContain('</span>');
  });
});
