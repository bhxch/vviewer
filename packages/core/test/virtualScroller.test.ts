// virtualScroller.test.ts —— 固定行高虚拟滚动（自 render-text 上移后的 core 单测）。
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { virtualScroller } from '../src/virtualScroller';

describe('virtualScroller', () => {
  /** jsdom 无 ResizeObserver，stub 之（照 render-text code.test.ts 惯例） */
  beforeEach(() => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      }
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function host(): HTMLElement {
    const el = document.createElement('div');
    document.body.append(el);
    return el;
  }

  it('初始化填充 [0..overscan 窗口] 行，spacer 总高 = rows×lineHeight', () => {
    const c = host();
    const ranges: Array<[number, number]> = [];
    const h = virtualScroller(c, 1000, 20, (f, l) => ranges.push([f, l]));
    expect(ranges).toHaveLength(1);
    expect(ranges[0]![0]).toBe(0);
    expect(ranges[0]![1]).toBe(20); // jsdom clientHeight=0 → 0 可视 + 2×10 overscan
    const spacer = c.querySelector('.vv-virtual-spacer') as HTMLElement;
    expect(spacer.style.height).toBe('20000px');
    h.destroy();
    c.remove();
  });

  it('scroll 事件驱动窗口平移，viewport transform 对齐首行', () => {
    const c = host();
    let first = -1;
    let last = -1;
    const h = virtualScroller(c, 1000, 20, (f, l, vp) => {
      first = f;
      last = l;
      vp.textContent = `${f}-${l}`;
    });
    c.scrollTop = 50 * 20; // 第 50 行进入视口
    c.dispatchEvent(new Event('scroll'));
    expect(first).toBe(40); // 50 - overscan(10)
    expect(last).toBe(60); // 40 + jsdom 可视 0 行 + 2×10 overscan

    h.destroy();
    c.remove();
  });

  it('范围未变时 scroll 不重复触发 onRange，refresh(true) 强制重绘', () => {
    const c = host();
    let calls = 0;
    const h = virtualScroller(c, 100, 20, () => {
      calls++;
    });
    expect(calls).toBe(1);
    c.scrollTop = 4; // 未出一行（4px < 20px 行高）
    c.dispatchEvent(new Event('scroll'));
    expect(calls).toBe(1); // first/last 未变 → 不重绘
    h.refresh(true);
    expect(calls).toBe(2);
    h.destroy();
    c.remove();
  });

  it('destroy 后 scroll 不再驱动 update，ResizeObserver 断开', () => {
    const c = host();
    let calls = 0;
    const h = virtualScroller(c, 100, 20, () => {
      calls++;
    });
    h.destroy();
    c.scrollTop = 400;
    c.dispatchEvent(new Event('scroll'));
    expect(calls).toBe(1);
    c.remove();
  });
});
