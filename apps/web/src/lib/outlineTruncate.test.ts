import { describe, expect, it } from 'vitest';
import type { OutlineEntry } from '@bhxch/vviewer-highlight';
import {
  OUTLINE_EXPAND_ALL_TEXT,
  OUTLINE_TRUNCATE_LIMIT,
  OUTLINE_TRUNCATE_TEXT,
  outlineDisplaySlice
} from './outlineTruncate';

function entry(line: number): OutlineEntry {
  return { name: `sym${line}`, kind: 'definition.function', line, byteStart: line, byteEnd: line + 1, depth: 0 };
}

describe('outlineDisplaySlice（大纲门限截断显示集）', () => {
  it('门限常量 = 2000（e2e/消费方对齐锚：常量自诞生即导出，B10 教训）', () => {
    expect(OUTLINE_TRUNCATE_LIMIT).toBe(2000);
  });

  it('截断文案含门限数值，「全部展开」文案在册', () => {
    expect(OUTLINE_TRUNCATE_TEXT).toContain(String(OUTLINE_TRUNCATE_LIMIT));
    expect(OUTLINE_EXPAND_ALL_TEXT).toBe('全部展开');
  });

  it('未超门限：原数组透传（引用稳定，零切片开销）', () => {
    const entries = [entry(0), entry(1)];
    expect(outlineDisplaySlice(entries, false)).toBe(entries);
  });

  it('恰等于门限：不截断（边界）', () => {
    const entries = Array.from({ length: OUTLINE_TRUNCATE_LIMIT }, (_, i) => entry(i));
    expect(outlineDisplaySlice(entries, false)).toBe(entries);
  });

  it('超门限未展开：恰取前 OUTLINE_TRUNCATE_LIMIT 条（首尾即原集前缀端点）', () => {
    const entries = Array.from({ length: OUTLINE_TRUNCATE_LIMIT + 500 }, (_, i) => entry(i));
    const out = outlineDisplaySlice(entries, false);
    expect(out).toHaveLength(OUTLINE_TRUNCATE_LIMIT);
    expect(out[0]).toBe(entries[0]);
    expect(out.at(-1)).toBe(entries[OUTLINE_TRUNCATE_LIMIT - 1]);
  });

  it('展开态：超门限也全量透传', () => {
    const entries = Array.from({ length: OUTLINE_TRUNCATE_LIMIT + 1 }, (_, i) => entry(i));
    expect(outlineDisplaySlice(entries, true)).toBe(entries);
  });

  it('输入数组不被改写（切片非原地）', () => {
    const entries = Array.from({ length: OUTLINE_TRUNCATE_LIMIT + 1 }, (_, i) => entry(i));
    outlineDisplaySlice(entries, false);
    expect(entries).toHaveLength(OUTLINE_TRUNCATE_LIMIT + 1);
  });
});
