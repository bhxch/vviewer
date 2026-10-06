import { describe, it, expect, vi, afterEach } from 'vitest';
import { HighlightCanceledError } from '@vviewer/highlight';
import {
  buildLineIndex,
  buildLineOffsets,
  splitHighlightedLines,
  resolveStrategy,
  assignIntervalsToLines,
  renderLineHtml,
  renderCode,
  attachHighlightClient,
  TREE_SITTER_MAX_BYTES,
  HLJS_MAX_BYTES,
  type HighlightInterval,
} from '../src/code';

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

describe('resolveStrategy（降级链阈值）', () => {
  it('≤5MB → tree-sitter', () => {
    expect(resolveStrategy(0)).toBe('tree-sitter');
    expect(resolveStrategy(1024)).toBe('tree-sitter');
    expect(resolveStrategy(TREE_SITTER_MAX_BYTES)).toBe('tree-sitter');
  });
  it('5MB–20MB → hljs-block', () => {
    expect(resolveStrategy(TREE_SITTER_MAX_BYTES + 1)).toBe('hljs-block');
    expect(resolveStrategy(HLJS_MAX_BYTES)).toBe('hljs-block');
  });
  it('>20MB → plain', () => {
    expect(resolveStrategy(HLJS_MAX_BYTES + 1)).toBe('plain');
  });
});

describe('buildLineOffsets', () => {
  it('累计偏移含换行符（UTF-16 偏移）', () => {
    expect(buildLineOffsets(['ab', 'cd', 'e'])).toEqual([0, 3, 6]);
    expect(buildLineOffsets([''])).toEqual([0]);
    expect(buildLineOffsets(['a', ''])).toEqual([0, 2]); // 'a\n' 长度 2，'' 起点 2
  });
});

describe('assignIntervalsToLines（区间 → 行分配）', () => {
  // 文本 "ab\ncd\n" → 行偏移 [0, 3, 6]，行长 2/2/0
  const offsets = [0, 3, 6];

  it('单行内区间给出相对行首的段', () => {
    const out = assignIntervalsToLines([{ start: 0, end: 2, capture: 'keyword' }], offsets);
    expect(out).toEqual([{ line: 0, segs: [{ start: 0, end: 2, capture: 'keyword' }] }]);
  });

  it('跨行区间拆到各行', () => {
    const out = assignIntervalsToLines([{ start: 1, end: 5, capture: 'string' }], offsets);
    expect(out).toEqual([
      { line: 0, segs: [{ start: 1, end: 2, capture: 'string' }] },
      { line: 1, segs: [{ start: 0, end: 2, capture: 'string' }] },
    ]);
  });

  it('重叠区间已覆盖跳过（父区间吞并子区间）', () => {
    const intervals: HighlightInterval[] = [
      { start: 0, end: 5, capture: 'parent' },
      { start: 1, end: 3, capture: 'child' }, // 完全被覆盖 → 跳过
    ];
    const out = assignIntervalsToLines(intervals, offsets);
    expect(out).toEqual([{ line: 0, segs: [{ start: 0, end: 2, capture: 'parent' }] }, { line: 1, segs: [{ start: 0, end: 2, capture: 'parent' }] }]);
  });

  it('部分重叠被裁剪（从前沿接续）', () => {
    const intervals: HighlightInterval[] = [
      { start: 0, end: 4, capture: 'a' },
      { start: 2, end: 6, capture: 'b' }, // [2,4) 已被 a 覆盖，只出 [4,6)
    ];
    const out = assignIntervalsToLines(intervals, offsets);
    expect(out).toEqual([
      { line: 0, segs: [{ start: 0, end: 2, capture: 'a' }] },
      { line: 1, segs: [
        { start: 0, end: 1, capture: 'a' }, // 偏移 [3,4)：行 1 的 "c"
        { start: 1, end: 2, capture: 'b' }, // 偏移 [4,6) 裁剪后：行 1 的 "d"
      ] },
    ]);
  });

  it('空输入返回空', () => {
    expect(assignIntervalsToLines([], offsets)).toEqual([]);
    expect(assignIntervalsToLines([{ start: 0, end: 1, capture: 'x' }], [])).toEqual([]);
  });
});

describe('renderLineHtml（行 HTML 渲染）', () => {
  it('无段落时转义整行', () => {
    expect(renderLineHtml('<a> & "b"', undefined)).toBe('&lt;a&gt; &amp; "b"');
  });

  it('段落包 ts-<capture> span（点转 -），段外文本转义', () => {
    const html = renderLineHtml('let x = "<s>"', [
      { start: 0, end: 3, capture: 'keyword' },
      { start: 8, end: 13, capture: 'string.special' },
    ]);
    expect(html).toContain('<span class="ts-keyword">let</span>');
    expect(html).toContain('<span class="ts-string-special">');
    expect(html).toContain('&lt;s&gt;');
    expect(html.startsWith('&nbsp;') || html.includes(' x = ')).toBe(true);
  });

  it('段越界（超过行尾）被裁剪', () => {
    const html = renderLineHtml('ab', [{ start: 1, end: 99, capture: 'x' }]);
    expect(html).toBe('a<span class="ts-x">b</span>');
  });
});

describe('renderCode（tree-sitter 主路径，fake client）', () => {
  afterEach(() => {
    attachHighlightClient(null);
    document.body.innerHTML = '';
  });

  /** jsdom 无 ResizeObserver，stub 之 */
  function stubResizeObserver(): void {
    vi.stubGlobal('ResizeObserver', class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    });
  }

  it('区间渲染为 .ts-<capture> span', async () => {
    stubResizeObserver();
    attachHighlightClient({
      highlight: async () => [{ start: 0, end: 3, capture: 'keyword' }],
    });
    const host = document.createElement('div');
    document.body.append(host);
    const handle = renderCode(new TextEncoder().encode('let x'), host, { ext: 'rs', lang: 'rust' });
    await vi.waitFor(() => {
      expect(host.querySelectorAll('.ts-keyword').length).toBeGreaterThan(0);
    });
    expect(host.querySelector('.ts-keyword')?.textContent).toBe('let');
    expect(handle.getScrollHost().className).toContain('vv-code-pre'); // virtualScroller 会加 vv-virtual
    handle.destroy();
  });

  it('client reject（非取消）→ 降级 hljs 整文件', async () => {
    stubResizeObserver();
    attachHighlightClient({
      highlight: async () => {
        throw new Error('boom');
      },
    });
    const host = document.createElement('div');
    document.body.append(host);
    const handle = renderCode(new TextEncoder().encode('const a = 1'), host, { ext: 'js', lang: 'javascript' });
    await vi.waitFor(() => {
      // highlightAuto 的具体类名取决于识别出的语言，断言出现了任一 hljs 高亮 span
      expect(host.querySelectorAll('[class*="hljs-"]').length).toBeGreaterThan(0);
    });
    handle.destroy();
  });

  it('取消错误静默放弃（不降级）', async () => {
    stubResizeObserver();
    attachHighlightClient({
      highlight: async () => {
        throw new HighlightCanceledError(); // 真实 client 取消时抛的类型
      },
    });
    const host = document.createElement('div');
    document.body.append(host);
    const handle = renderCode(new TextEncoder().encode('let x'), host, { ext: 'rs', lang: 'rust' });
    await new Promise((r) => setTimeout(r, 10));
    expect(host.querySelectorAll('[class*="hljs-"]').length).toBe(0);
    handle.destroy();
  });

  it('plain 策略不做任何高亮', async () => {
    stubResizeObserver();
    const spy = vi.fn(async () => [] as HighlightInterval[]);
    attachHighlightClient({ highlight: spy });
    const host = document.createElement('div');
    document.body.append(host);
    const handle = renderCode(new TextEncoder().encode('let x'), host, { highlight: false, ext: 'rs' });
    await new Promise((r) => setTimeout(r, 10));
    expect(spy).not.toHaveBeenCalled();
    expect(host.querySelector('.vv-code-body')?.textContent).toBe('let x');
    handle.destroy();
  });
});
