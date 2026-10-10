import { describe, expect, it } from 'vitest';
import {
  splitJsonlLines, parseJsonlLine, collapseFor,
  JSONL_COLLAPSE_LINES, JSONL_EXPAND_CAP_LINES,
} from '../src/jsonl/parse';

describe('splitJsonlLines', () => {
  it('strips BOM, drops blank lines, keeps content lines', () => {
    expect(splitJsonlLines('\uFEFF{"a":1}\n\n{"b":2}\n  \n')).toEqual(['{"a":1}', '{"b":2}']);
    expect(splitJsonlLines('')).toEqual([]);
  });
});

describe('parseJsonlLine', () => {
  it('ok: pretty-prints preserving key order', () => {
    const s = parseJsonlLine('{"b":1,"a":[1,2]}');
    expect(s).toMatchObject({ kind: 'ok' });
    if (s.kind === 'ok') {
      expect(s.pretty).toBe('{\n  "b": 1,\n  "a": [\n    1,\n    2\n  ]\n}');
      expect(s.prettyLines).toBe(8);
    }
  });
  it('failed: keeps raw and short reason', () => {
    const s = parseJsonlLine('{oops');
    expect(s.kind).toBe('failed');
    if (s.kind === 'failed') { expect(s.raw).toBe('{oops'); expect(s.reason.length).toBeLessThanOrEqual(120); }
  });
  it('oversize: >1MB raw truncated to 64KB with oversize kind', () => {
    const big = 'x'.repeat(1_048_577);
    const s = parseJsonlLine(big);
    expect(s.kind).toBe('oversize');
    if (s.kind === 'oversize') expect(s.raw.length).toBe(65_536);
  });
  it('oversize threshold equals 1MB exactly', () => {
    expect(parseJsonlLine('x'.repeat(1_048_576)).kind).toBe('oversize');
    expect(parseJsonlLine('x'.repeat(1_048_575)).kind).toBe('failed'); // 1MB-1 的 x 非 JSON
  });
});

describe('collapseFor', () => {
  it('short lines fully visible', () => {
    expect(collapseFor(8)).toEqual({ collapsed: false, visibleLines: 8, capped: false });
  });
  it('long lines collapse to 40 and cap expansion at 400', () => {
    expect(collapseFor(JSONL_COLLAPSE_LINES + 1))
      .toEqual({ collapsed: true, visibleLines: JSONL_COLLAPSE_LINES, capped: false });
    expect(collapseFor(JSONL_EXPAND_CAP_LINES + 50))
      .toEqual({ collapsed: true, visibleLines: JSONL_EXPAND_CAP_LINES, capped: true });
  });
});
