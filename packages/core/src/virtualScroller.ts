// virtualScroller —— 固定行高虚拟滚动（零 DOM 依赖纯模块，自 render-text 上移：
// BUG-16 的 hex 行虚拟滚动与 render-text code 渲染器共用同一实现；render-text 原
// 路径保留一行 re-export shim，code.ts 的相对 import 与包 exports 均不变）。
export interface VirtualScrollerHandle {
  destroy(): void;
  /** force=true 时即使可视行范围未变也强制重绘（异步高亮结果到达后刷新用） */
  refresh(force?: boolean): void;
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
  function update(force = false): void {
    const scrollTop = container.scrollTop;
    const visible = Math.ceil(container.clientHeight / lineHeight);
    const f = Math.min(rowCount - 1, Math.max(0, Math.floor(scrollTop / lineHeight) - overscan));
    const l = Math.min(rowCount - 1, f + visible + overscan * 2);
    if (force || f !== first || l !== last) {
      first = f;
      last = l;
      viewport.style.transform = `translateY(${f * lineHeight}px)`;
      onRange(f, l, viewport);
    }
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
    refresh: (force = false) => update(force)
  };
}
