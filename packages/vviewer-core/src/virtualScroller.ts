// virtualScroller —— 固定行高虚拟滚动（零 DOM 依赖纯模块，自 render-text 上移：
// BUG-16 的 hex 行虚拟滚动与 render-text code 渲染器共用同一实现；render-text 原
// 路径保留一行 re-export shim，code.ts 的相对 import 与包 exports 均不变）。
export interface VirtualScrollerHandle {
  destroy(): void;
  /** force=true 时即使可视行范围未变也强制重绘（异步高亮结果到达后刷新用） */
  refresh(force?: boolean): void;
  /**
   * 按虚拟内容坐标（行号×lineHeight 语义，与 onRange 同域）定位滚动。
   * 调用方一律经此跳转，不得直写 container.scrollTop——总高超
   * SCROLL_PX_CAP 后滚动域被压缩，scrollTop 与虚拟坐标不再恒等（BUG-55）。
   */
  scrollTo(y: number): void;
}

/**
 * Chromium 单元素高度/可滚动区域上限（px）：2^25-4，实测同钳（元素与 scroller
 * 滚动域分别验证：>该值的单元素高度与分段多元素的 scrollHeight 均停在 ~2^25）。
 * BUG-55：spacer 单元素定高超限被钳制 → 滚动区间缩短、尾部不可达。
 */
export const SCROLL_PX_CAP = 33_554_428;

/**
 * 固定行高虚拟滚动：container 内含 spacer（总高 = rows*lineHeight）与常驻 viewport。
 * onRange(first, last, viewport) 为闭区间；滚动定位由本模块用 viewport transform 完成，
 * 调用方只负责向 viewport 填充 [first..last] 的行 DOM（viewport.replaceChildren）。
 *
 * 超上限处理（BUG-55）：总行高 > SCROLL_PX_CAP 时 spacer 钳到上限——浏览器可滚动
 * 区域本身亦在该值附近钳制（分段多元素不解除），故改走「滚动域↔虚拟域线性映射」：
 * scrollTop∈[0, cap-clientH] 按比例张到虚拟域 [0, total-clientH]，可视行号与 viewport
 * transform 均以虚拟坐标计算后再折回滚动域（transform 补偿量 = 虚拟y - scrollTop）。
 * 未超限时映射恒等，行为与原实现逐像素一致。
 */
export function virtualScroller(
  container: HTMLElement,
  rowCount: number,
  lineHeight: number,
  onRange: (first: number, last: number, viewport: HTMLElement) => void,
  overscan = 10
): VirtualScrollerHandle {
  container.classList.add('vv-virtual');
  const totalHeight = rowCount * lineHeight;
  const capped = totalHeight > SCROLL_PX_CAP;
  const spacer = document.createElement('div');
  spacer.className = 'vv-virtual-spacer';
  spacer.style.height = `${Math.min(totalHeight, SCROLL_PX_CAP)}px`;
  const viewport = document.createElement('div');
  viewport.className = 'vv-virtual-viewport';
  // viewport 常驻：只在 init 时 replaceChildren 一次，之后仅做 transform 定位
  container.replaceChildren(spacer, viewport);
  let first = -1;
  let last = -1;
  /** 滚动域 scrollTop → 虚拟内容 y（未超限恒等） */
  function toVirtual(scrollTop: number): number {
    if (!capped) return scrollTop;
    const scrollable = Math.max(1, SCROLL_PX_CAP - container.clientHeight);
    return (scrollTop / scrollable) * Math.max(1, totalHeight - container.clientHeight);
  }
  /** 虚拟内容 y → 滚动域 scrollTop（toVirtual 的逆映射，未超限恒等） */
  function toScroll(y: number): number {
    if (!capped) return y;
    const virtual = Math.max(1, totalHeight - container.clientHeight);
    return (y / virtual) * Math.max(1, SCROLL_PX_CAP - container.clientHeight);
  }
  function update(force = false): void {
    const scrollTop = container.scrollTop;
    const virtualY = toVirtual(scrollTop);
    const shift = virtualY - scrollTop; // capped 时视口在压缩滚动域内的补偿量（未超限=0）
    const visible = Math.ceil(container.clientHeight / lineHeight);
    const f = Math.min(rowCount - 1, Math.max(0, Math.floor(virtualY / lineHeight) - overscan));
    const l = Math.min(rowCount - 1, f + visible + overscan * 2);
    if (force || f !== first || l !== last) {
      first = f;
      last = l;
      onRange(f, l, viewport);
    }
    // transform 恒刷：capped 模式 shift 随 scrollTop 连续变化，f/l 未变的滚动也须
    // 补偿；未超限时 shift=0，退化为原实现 f*lineHeight。
    viewport.style.transform = `translateY(${f * lineHeight - shift}px)`;
  }
  const onUpdate = (): void => update();
  container.addEventListener('scroll', onUpdate, { passive: true });
  const ro = new ResizeObserver(onUpdate);
  ro.observe(container);
  update();
  return {
    destroy() {
      ro.disconnect();
      container.removeEventListener('scroll', onUpdate);
    },
    refresh: (force = false) => update(force),
    scrollTo: (y: number) => {
      container.scrollTop = toScroll(Math.max(0, y));
    }
  };
}
