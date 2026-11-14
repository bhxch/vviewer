// touchProfile.test.ts — 触屏档案生效判定纯函数（spec B §3.1，Task 2）。
// resolveTouchActive 三态 × coarse/fine × touchPoints 矩阵（spec §4 单测锚）：
// auto = any-pointer:coarse 且 maxTouchPoints>0（双条件缺一不可）；touch 恒 true
// （fine pointer 强启）；desktop 恒 false（coarse 在场仍回收 hover 语义）。
// 纯 .ts 直测（runes 单例 touchProfile.svelte.ts 不入本文件——iconTheme 先例，
// 运行时面由 Task 4 TP 域 e2e 收口）。
import { describe, expect, it } from 'vitest';
import { resolveTouchActive } from './touchProfile';
import type { TouchMode } from './layout';

describe('resolveTouchActive 生效矩阵（spec B §3.1 拍板公式）', () => {
  it('auto：coarse 且 touchPoints>0 → true（1 点与多点均生效）', () => {
    expect(resolveTouchActive('auto', true, 1)).toBe(true);
    expect(resolveTouchActive('auto', true, 5)).toBe(true);
  });

  it('auto：coarse 但 touchPoints=0 → false（触点条件缺一不可）', () => {
    expect(resolveTouchActive('auto', true, 0)).toBe(false);
  });

  it('auto：coarse=false → false（fine pointer 不吃档案；touchPoints>0 也不翻转——触屏笔记本外接键鼠后回桌面语义）', () => {
    expect(resolveTouchActive('auto', false, 0)).toBe(false);
    expect(resolveTouchActive('auto', false, 3)).toBe(false);
  });

  it('touch 强制档恒 true（fine pointer + 零触点也强启——spec §3.4）', () => {
    expect(resolveTouchActive('touch', true, 5)).toBe(true);
    expect(resolveTouchActive('touch', false, 5)).toBe(true);
    expect(resolveTouchActive('touch', false, 0)).toBe(true);
  });

  it('desktop 强制档恒 false（coarse 在场仍回收——spec §3.4 恢复 hover 语义）', () => {
    expect(resolveTouchActive('desktop', true, 5)).toBe(false);
    expect(resolveTouchActive('desktop', true, 0)).toBe(false);
    expect(resolveTouchActive('desktop', false, 0)).toBe(false);
  });

  it('三态 × 代表组合全矩阵（表格驱动；TOUCH_MODES 新增档位漏配对即红）', () => {
    const cases: Array<[TouchMode, boolean, number, boolean]> = [
      ['auto', true, 1, true],
      ['auto', true, 0, false],
      ['auto', false, 3, false],
      ['auto', false, 0, false],
      ['touch', true, 5, true],
      ['touch', false, 0, true],
      ['desktop', true, 5, false],
      ['desktop', false, 0, false]
    ];
    for (const [mode, coarse, touchPoints, expected] of cases) {
      expect(resolveTouchActive(mode, coarse, touchPoints)).toBe(expected);
    }
  });
});
