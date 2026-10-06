export interface VirtualScrollerHandle {
  destroy(): void;
  refresh(): void;
}

/**
 * 固定行高虚拟滚动：container 内含 spacer（总高 = rows*lineHeight）与常驻 viewport。
 * onRange(first, last, viewport) 为闭区间；滚动定位由本模块用 viewport transform 完成，
 * 调用方只负责向 viewport 填充 [first..last] 的行 DOM（viewport.replaceChildren）。
 */
export function virtualScroller(
  container: HTMLElement,
  rowCount: number,
  lineHeight: number,
  onRange: (first: number, last: number, viewport: HTMLElement) => void,
  overscan = 10
): VirtualScrollerHandle {
  container.classList.add('vv-virtual');
  const spacer = document.createElement('div');
  spacer.className = 'vv-virtual-spacer';
  spacer.style.height = `${rowCount * lineHeight}px`;
  const viewport = document.createElement('div');
  viewport.className = 'vv-virtual-viewport';
  // viewport 常驻：只在 init 时 replaceChildren 一次，之后仅做 transform 定位
  container.replaceChildren(spacer, viewport);
  let first = -1;
  let last = -1;
  function update(): void {
    const scrollTop = container.scrollTop;
    const visible = Math.ceil(container.clientHeight / lineHeight);
    const f = Math.min(rowCount - 1, Math.max(0, Math.floor(scrollTop / lineHeight) - overscan));
    const l = Math.min(rowCount - 1, f + visible + overscan * 2);
    if (f !== first || l !== last) {
      first = f;
      last = l;
      viewport.style.transform = `translateY(${f * lineHeight}px)`;
      onRange(f, l, viewport);
    }
  }
  container.addEventListener('scroll', update, { passive: true });
  const ro = new ResizeObserver(update);
  ro.observe(container);
  update();
  return {
    destroy() {
      ro.disconnect();
      container.removeEventListener('scroll', update);
    },
    refresh: update
  };
}
