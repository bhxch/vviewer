import { describe, expect, it } from 'vitest';
import { HeightModel, visibleRange, JSONL_ESTIMATED_CARD_HEIGHT } from '../src/jsonl/window';

describe('HeightModel', () => {
  it('estimates unknown rows and corrects after measure', () => {
    const m = new HeightModel();
    expect(m.total(10)).toBe(10 * JSONL_ESTIMATED_CARD_HEIGHT);
    m.measure(2, 300);
    expect(m.total(10)).toBe(9 * JSONL_ESTIMATED_CARD_HEIGHT + 300);
    expect(m.offsetOf(3)).toBe(2 * JSONL_ESTIMATED_CARD_HEIGHT + 300);
    expect(m.dirty).toBe(true);
  });
  it('rowAt maps y through measured and estimated segments', () => {
    const m = new HeightModel();
    for (let r = 0; r < 5; r++) m.measure(r, 100); // 前 5 行实测 100px
    expect(m.rowAt(0, 20)).toBe(0);
    expect(m.rowAt(450, 20)).toBe(4);   // 400..500 属第 5 行（0 起）
    expect(m.rowAt(5 * 100 + 10, 20)).toBe(5); // 进入估算段
  });
  it('visibleRange pads with overscan and clamps', () => {
    const m = new HeightModel();
    for (let r = 0; r < 50; r++) m.measure(r, 100);
    expect(visibleRange(m, 0, 250, 50, 5)).toEqual({ first: 0, last: 7 });
    expect(visibleRange(m, 10_000, 250, 50, 5)).toEqual({ first: 44, last: 49 });
  });
});
