import { describe, it, expect } from 'vitest';
import { SCROLL_EPS, arrowVisibility, dominantWheelDelta } from './tabScroll';

/**
 * tab 条优雅滚动纯函数（标签栏收敛 Task 2，spec §4.2/§4.3）：可见性三态与
 * wheel 归一数学在组件外单测钉死，组件只做接线。
 */

describe('arrowVisibility（spec §4.3：左钮 scrollLeft>1；右钮 scrollLeft+clientWidth<scrollWidth-1）', () => {
  it('①a 初态 scrollLeft=0：左不可见右可见', () => {
    // 200 可视 / 600 内容：右侧溢出 400px
    expect(arrowVisibility(0, 200, 600)).toEqual({ left: false, right: true });
  });

  it('①b 居中滚动：双钮可见', () => {
    // scrollLeft=200：左已滚入 200>1、右余 200>1
    expect(arrowVisibility(200, 200, 600)).toEqual({ left: true, right: true });
  });

  it('①c 滚到底：左可见右不可见', () => {
    expect(arrowVisibility(400, 200, 600)).toEqual({ left: true, right: false });
  });

  it('①d 无溢出（clientWidth≥scrollWidth）：双钮皆隐', () => {
    expect(arrowVisibility(0, 600, 600)).toEqual({ left: false, right: false });
    expect(arrowVisibility(0, 800, 600)).toEqual({ left: false, right: false });
  });

  it('①e eps 边界：恰差 1px 内视为已滚尽（SCROLL_EPS）', () => {
    expect(SCROLL_EPS).toBe(1);
    // 左侧恰滚 1px：1 > 1 不成立 → 不可见；2px 即翻可见
    expect(arrowVisibility(1, 200, 600).left).toBe(false);
    expect(arrowVisibility(2, 200, 600).left).toBe(true);
    // 右侧恰差 1px 滚尽：400+200 = 600-1 不小于 599 → 不可见；差 2px 即翻可见
    expect(arrowVisibility(399, 200, 600).right).toBe(false);
    expect(arrowVisibility(398, 200, 600).right).toBe(true);
  });
});

describe('dominantWheelDelta（spec §4.2：deltaMode 归一为 px；横向占优放行原生 → 0）', () => {
  it('②a deltaMode 0（像素）：原值直传', () => {
    expect(dominantWheelDelta({ deltaMode: 0, deltaX: 0, deltaY: 240 })).toBe(240);
  });

  it('②b deltaMode 1（行）：×16px/行归一', () => {
    expect(dominantWheelDelta({ deltaMode: 1, deltaX: 0, deltaY: 3 })).toBe(48);
  });

  it('②c 横向占优（|deltaX|>|deltaY|）：返回 0（组件放行原生横滚）', () => {
    expect(dominantWheelDelta({ deltaMode: 0, deltaX: -120, deltaY: 30 })).toBe(0);
  });

  it('②d 负值保号（向上滚 → 负 px，组件 scrollLeft += 负值左移）', () => {
    expect(dominantWheelDelta({ deltaMode: 0, deltaX: 0, deltaY: -240 })).toBe(-240);
    expect(dominantWheelDelta({ deltaMode: 1, deltaX: 0, deltaY: -2 })).toBe(-32);
  });
});
