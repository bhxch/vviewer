/**
 * lines.test.ts — 包内直测 src/lines.ts（区间→行 HTML 生态）。
 * 原 render-text 侧 lines 系用例分散于 code.test.ts/jsonl-render.test.ts（经
 * '../src/code' 中转），迁移后本文件直接消费 src/lines.ts；overlaySearchHits 的
 * 期望串与 render-text/test/code.test.ts 既有断言一致（迁移前后行为锁同）。
 */
import { describe, expect, it } from 'vitest';
import {
  assignIntervalsToLines,
  escapeHtml,
  flattenIntervals,
  lineOf,
  mergeChunkLines,
  overlaySearchHits,
  renderLineHtml,
  splitHighlightedLines
} from '../src/lines';
import type { HighlightInterval } from '../src/types';
import {
  CAPTURE_CLASS_PREFIX,
  CAPTURE_VAR_PREFIX,
  captureToCssClass,
  captureToCssVar
} from '../src/theme';

describe('escapeHtml', () => {
  it('转义 & < >，不动引号', () => {
    expect(escapeHtml('a & b < c > d "e"')).toBe('a &amp; b &lt; c &gt; d "e"');
    expect(escapeHtml('plain')).toBe('plain');
  });
});

describe('splitHighlightedLines（hljs HTML 按行切分）', () => {
  it('无 span 纯文本逐行', () => {
    expect(splitHighlightedLines('a\nb\nc', 3)).toEqual(['a', 'b', 'c']);
  });

  it('跨行 span 在行末全闭合、下行按原序重开', () => {
    const html = '<span class="ts-string">a\nb</span>';
    expect(splitHighlightedLines(html, 2)).toEqual([
      '<span class="ts-string">a</span>',
      '<span class="ts-string">b</span>'
    ]);
  });

  it('嵌套 span 跨行重开保持原序', () => {
    const html = '<span class="ts-string"><span class="ts-escape">x\ny</span></span>';
    expect(splitHighlightedLines(html, 2)).toEqual([
      '<span class="ts-string"><span class="ts-escape">x</span></span>',
      '<span class="ts-string"><span class="ts-escape">y</span></span>'
    ]);
  });

  it('lineCount 截断：超出行不再产出', () => {
    expect(splitHighlightedLines('a\nb\nc', 2)).toEqual(['a', 'b']);
  });
});

describe('lineOf（二分最大 l 使 offsets[l] <= pos）', () => {
  const offsets = [0, 5, 10];
  it('边界与内部点', () => {
    expect(lineOf(offsets, 0)).toBe(0);
    expect(lineOf(offsets, 4)).toBe(0);
    expect(lineOf(offsets, 5)).toBe(1);
    expect(lineOf(offsets, 9)).toBe(1);
    expect(lineOf(offsets, 10)).toBe(2);
    expect(lineOf(offsets, 100)).toBe(2);
  });
});

describe('flattenIntervals（嵌套展平，内层优先）', () => {
  it('嵌套：内层裁开外层，间隙回落外层', () => {
    const iv: HighlightInterval[] = [
      { start: 0, end: 10, capture: 'function' },
      { start: 2, end: 5, capture: 'string' }
    ];
    expect(flattenIntervals(iv)).toEqual([
      { start: 0, end: 2, capture: 'function' },
      { start: 2, end: 5, capture: 'string' },
      { start: 5, end: 10, capture: 'function' }
    ]);
  });

  it('相邻同 capture 段合并', () => {
    const iv: HighlightInterval[] = [
      { start: 0, end: 3, capture: 'comment' },
      { start: 3, end: 6, capture: 'comment' }
    ];
    expect(flattenIntervals(iv)).toEqual([{ start: 0, end: 6, capture: 'comment' }]);
  });

  it('零长区间不产出', () => {
    expect(flattenIntervals([{ start: 5, end: 5, capture: 'x' }])).toEqual([]);
  });

  it('tie：更短（更内层）区间优先', () => {
    const iv: HighlightInterval[] = [
      { start: 0, end: 10, capture: 'a' },
      { start: 2, end: 6, capture: 'b' },
      { start: 3, end: 5, capture: 'c' }
    ];
    expect(flattenIntervals(iv)).toEqual([
      { start: 0, end: 2, capture: 'a' },
      { start: 2, end: 3, capture: 'b' },
      { start: 3, end: 5, capture: 'c' },
      { start: 5, end: 6, capture: 'b' },
      { start: 6, end: 10, capture: 'a' }
    ]);
  });
});

describe('assignIntervalsToLines（区间→行分配）', () => {
  it('区间跨行：按行切片，segs 相对行首', () => {
    // 文本 "aaaa\nbbbb\n"：行 0 偏移 [0,4)、行 1 [4,8)
    const offsets = [0, 4, 8];
    expect(assignIntervalsToLines([{ start: 1, end: 6, capture: 'kw' }], offsets)).toEqual([
      { line: 0, segs: [{ start: 1, end: 3, capture: 'kw' }] },
      { line: 1, segs: [{ start: 0, end: 2, capture: 'kw' }] }
    ]);
  });

  it('区间到行尾：不含换行符（行内容终点 = 下一行起点 - 1）', () => {
    const offsets = [0, 4, 8];
    expect(assignIntervalsToLines([{ start: 0, end: 8, capture: 'c' }], offsets)).toEqual([
      { line: 0, segs: [{ start: 0, end: 3, capture: 'c' }] },
      { line: 1, segs: [{ start: 0, end: 3, capture: 'c' }] }
    ]);
  });

  it('空区间或空行表返回 []', () => {
    expect(assignIntervalsToLines([], [0])).toEqual([]);
    expect(assignIntervalsToLines([{ start: 0, end: 1, capture: 'c' }], [])).toEqual([]);
  });
});

describe('mergeChunkLines（chunk 相对行 +shift 平移）', () => {
  it('分配结果统一平移到绝对行号', () => {
    const byLine = mergeChunkLines([{ start: 0, end: 2, capture: 'kw' }], [0, 4], 100);
    expect([...byLine.entries()]).toEqual([[100, [{ start: 0, end: 2, capture: 'kw' }]]]);
  });

  it('空区间返回空 Map', () => {
    expect(mergeChunkLines([], [0], 0).size).toBe(0);
  });
});

describe('overlaySearchHits（搜索命中叠加）', () => {
  it('空 hits 原样返回', () => {
    expect(overlaySearchHits('<span class="ts-keyword">let</span>', [])).toBe(
      '<span class="ts-keyword">let</span>'
    );
  });

  it('默认类名 vv-search-hit（宿主既有样式类，迁移前行为不变）', () => {
    expect(overlaySearchHits('alpha beta', [{ start: 6, end: 10 }])).toBe(
      'alpha <mark class="vv-search-hit">beta</mark>'
    );
  });

  it('hitClass 选项参数化命中类名', () => {
    expect(
      overlaySearchHits('alpha beta', [{ start: 6, end: 10 }], { hitClass: 'my-hit' })
    ).toBe('alpha <mark class="my-hit">beta</mark>');
  });

  it('命中边界处 span 闭合、命中后按原序重开', () => {
    const base = '<span class="ts-keyword">abcd</span>';
    expect(overlaySearchHits(base, [{ start: 1, end: 3 }])).toBe(
      '<span class="ts-keyword">a</span><mark class="vv-search-hit">bc</mark><span class="ts-keyword">d</span>'
    );
    expect(
      overlaySearchHits(base, [{ start: 1, end: 3 }], { hitClass: 'my-hit' })
    ).toBe(
      '<span class="ts-keyword">a</span><mark class="my-hit">bc</mark><span class="ts-keyword">d</span>'
    );
  });

  it('文本实体解码后切分、输出统一重新转义', () => {
    expect(overlaySearchHits('a &amp; b', [{ start: 2, end: 3 }])).toBe(
      'a <mark class="vv-search-hit">&amp;</mark> b'
    );
  });

  it('多处命中各自成 mark', () => {
    expect(overlaySearchHits('xaxax', [{ start: 1, end: 2 }, { start: 3, end: 4 }])).toBe(
      'x<mark class="vv-search-hit">a</mark>x<mark class="vv-search-hit">a</mark>x'
    );
  });
});

describe('renderLineHtml（行文本 + 段落 → 行 HTML）', () => {
  it('无 segs 回落纯转义', () => {
    expect(renderLineHtml('a < b', undefined)).toBe('a &lt; b');
    expect(renderLineHtml('a < b', [])).toBe('a &lt; b');
  });

  it('seg 包 ts- 前缀 span（CAPTURE_CLASS_PREFIX 拼装，行为锁同）', () => {
    expect(renderLineHtml('let x', [{ start: 0, end: 3, capture: 'keyword' }])).toBe(
      '<span class="ts-keyword">let</span> x'
    );
  });

  it('capture 先归约 CODE_CAPTURES 最近语义父级再点转 -', () => {
    // 清单内 capture 恒等（keyword.control.conditional 本身在 CODE_CAPTURES）
    expect(
      renderLineHtml('if', [{ start: 0, end: 2, capture: 'keyword.control.conditional' }])
    ).toBe('<span class="ts-keyword-control-conditional">if</span>');
    // 未入清单的细粒度子捕获归约到最近语义父级
    expect(
      renderLineHtml('1', [{ start: 0, end: 1, capture: 'constant.numeric.integer' }])
    ).toBe('<span class="ts-constant-numeric">1</span>');
    expect(
      renderLineHtml('mut', [{ start: 0, end: 3, capture: 'keyword.storage.modifier.mut' }])
    ).toBe('<span class="ts-keyword">mut</span>');
    expect(renderLineHtml('x', [{ start: 0, end: 1, capture: 'not.in.list' }])).toBe(
      '<span class="ts-not-in-list">x</span>'
    );
  });

  it('seg 越界夹紧到行文本长度；间隙文本原样转义', () => {
    expect(renderLineHtml('abc', [{ start: 0, end: 10, capture: 'keyword' }])).toBe(
      '<span class="ts-keyword">abc</span>'
    );
    expect(
      renderLineHtml('abcd', [
        { start: 0, end: 1, capture: 'keyword' },
        { start: 3, end: 4, capture: 'string' }
      ])
    ).toBe('<span class="ts-keyword">a</span>bc<span class="ts-string">d</span>');
  });
});

describe('前缀常量收敛（类名/变量名唯一来源）', () => {
  it('常量值锁定：ts- 与 --vv-ts-', () => {
    expect(CAPTURE_CLASS_PREFIX).toBe('ts-');
    expect(CAPTURE_VAR_PREFIX).toBe('--vv-ts-');
  });

  it('captureToCssVar 由常量拼装，行为与迁移前一致', () => {
    expect(captureToCssVar('string.special')).toBe('--vv-ts-string-special');
    expect(captureToCssVar('string')).toBe(`${CAPTURE_VAR_PREFIX}${captureToCssClass('string')}`);
  });
});
