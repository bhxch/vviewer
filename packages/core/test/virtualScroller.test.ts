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

  // ---- BUG-55：总行高超 Chromium 滚动域上限（SCROLL_PX_CAP）——spacer 钳制 + 滚动域映射 ----
  const LH = 20;
  const ROWS = 2_000_000; // 40,000,000px > 33,554,428px
  const CAP = 33_554_428;

  it('超上限：spacer 钳到 SCROLL_PX_CAP（不再声明总行高），未超限用例不受影响', () => {
    const c = host();
    const h = virtualScroller(c, ROWS, LH, () => {});
    const spacer = c.querySelector('.vv-virtual-spacer') as HTMLElement;
    expect(spacer.style.height).toBe(`${CAP}px`);
    h.destroy();
    c.remove();
  });

  it('超上限：滚动域 scrollTop 按比例张到虚拟域取行——置底即达末行窗口（jsdom clientH=0 口径）', () => {
    const c = host();
    const ranges: Array<[number, number]> = [];
    const h = virtualScroller(c, ROWS, LH, (f, l) => ranges.push([f, l]));
    // 置底：scrollTop 钳制值 = spacer 高（jsdom 无布局不钳，直接给上限值）
    c.scrollTop = CAP;
    c.dispatchEvent(new Event('scroll'));
    const virtualY = (CAP / CAP) * (ROWS * LH); // = 40,000,000
    const fExpected = Math.floor(virtualY / LH) - 10; // overscan=10
    expect(ranges[ranges.length - 1]).toEqual([fExpected, ROWS - 1]); // 末行在窗口内
    // viewport transform 带压缩补偿：translateY(f*lh - (virtualY - scrollTop))
    const vp = c.querySelector('.vv-virtual-viewport') as HTMLElement;
    expect(vp.style.transform).toBe(`translateY(${fExpected * LH - (virtualY - CAP)}px)`);
    // 中段抽查：scrollTop 半程 → 虚拟 y 约半程
    c.scrollTop = Math.floor(CAP / 2);
    c.dispatchEvent(new Event('scroll'));
    expect(ranges[ranges.length - 1]![0]).toBe(
      Math.floor(Math.floor((ROWS * LH) / 2 / LH)) - 10
    );
    h.destroy();
    c.remove();
  });

  it('超上限：scrollTo 以虚拟坐标定位（toScroll 逆映射），未超限恒等直写', () => {
    const c = host();
    const h = virtualScroller(c, ROWS, LH, () => {});
    const targetVirtual = 30_000_000;
    h.scrollTo(targetVirtual);
    const expected = (targetVirtual / (ROWS * LH)) * CAP; // jsdom clientH=0 逆映射
    expect(c.scrollTop).toBeCloseTo(expected, 5);
    h.destroy();
    c.remove();

    const c2 = host();
    const h2 = virtualScroller(c2, 1000, 20, () => {});
    h2.scrollTo(50 * 20);
    expect(c2.scrollTop).toBe(1000); // 未超限：与直写 scrollTop 等价
    h2.destroy();
    c2.remove();
  });
});
