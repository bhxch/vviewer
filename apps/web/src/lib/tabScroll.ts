/**
 * tab 条优雅滚动纯函数（标签栏收敛 Task 2，spec §4.2/§4.3）：可见性判定与
 * wheel 归一数学独立成模块——组件（TabBar.svelte）只做接线，数值边界在此单测。
 */

/** 边界容差（px）：距滚尽/未滚入 ≤1px 视为已到位，防亚像素抖动致箭头闪烁。 */
export const SCROLL_EPS = 1;

/**
 * 箭头可见性（spec §4.3 逐字口径）：左钮 `scrollLeft > SCROLL_EPS`；右钮
 * `scrollLeft + clientWidth < scrollWidth - SCROLL_EPS`。无溢出（clientWidth ≥
 * scrollWidth）时两式均不成立，双 false 无需特判分支。
 */
export function arrowVisibility(
  scrollLeft: number,
  clientWidth: number,
  scrollWidth: number
): { left: boolean; right: boolean } {
  return {
    left: scrollLeft > SCROLL_EPS,
    right: scrollLeft + clientWidth < scrollWidth - SCROLL_EPS
  };
}

/**
 * wheel 位移归一为横向 px（spec §4.2）：deltaMode 1（行）按 16px/行折算（Chromium
 * 行高惯例）；横向占优（|deltaX|>|deltaY|）时返回 0——调用方据此放行原生横滚不
 * preventDefault。竖向分量保号返回（负值 = 向上滚 → scrollLeft 左移）。
 */
export function dominantWheelDelta(e: { deltaMode: number; deltaX: number; deltaY: number }): number {
  if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return 0;
  return e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
}
