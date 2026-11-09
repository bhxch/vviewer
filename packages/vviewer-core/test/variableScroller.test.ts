// variableScroller.test.ts —— 可变行高虚拟滚动 + RowHeights 前缀模型（core 纯模块，jsdom 直测）。
// 布局打桩同 virtualScroller.test.ts 惯例：jsdom 无 ResizeObserver，stub 之；无布局时
// offsetHeight 恒 0（滚动器自动测高跳过 0 值），测高由用例经 measure 显式注入。
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { RowHeights, SCROLL_PX_CAP, variableScroller, virtualScroller } from '../src/virtualScroller';

describe('RowHeights（分块前缀和）', () => {
  it('未测行按估算外推；offsetOf/total/heightOf 一致', () => {
    const m = new RowHeights((i) => 10 + (i % 3));
    m.setRowCount(1000);
    let acc = 0;
    for (let i = 0; i < 1000; i++) {
      expect(m.offsetOf(i)).toBe(acc);
      expect(m.heightOf(i)).toBe(10 + (i % 3));
      acc += 10 + (i % 3);
    }
    expect(m.total()).toBe(acc);
    expect(m.offsetOf(1000)).toBe(acc); // 越尾即总高
  });

  it('measure 替换估算并返回差值；同值/越界/非正值忽略', () => {
    const m = new RowHeights(() => 20);
    m.setRowCount(600);
    expect(m.measure(300, 60)).toBe(40);
    expect(m.measure(300, 60)).toBe(0);
    expect(m.measure(600, 99)).toBe(0);
    expect(m.measure(5, 0)).toBe(0);
    expect(m.offsetOf(301)).toBe(301 * 20 + 40);
    expect(m.total()).toBe(600 * 20 + 40);
  });

  it('rowAt：y 所在行（前缀 ≤ y 的最大行），越界钳 [0, n-1]', () => {
    const m = new RowHeights(() => 20);
    m.setRowCount(1000);
    m.measure(0, 100);
    expect(m.rowAt(-5)).toBe(0);
    expect(m.rowAt(0)).toBe(0);
    expect(m.rowAt(99)).toBe(0);
    expect(m.rowAt(100)).toBe(1);
    expect(m.rowAt(100 + 20 * 600 + 3)).toBe(601); // 跨块
    expect(m.rowAt(1e12)).toBe(999);
  });

  it('setRowCount 增长保留测高、新行估算；缩容截断', () => {
    const m = new RowHeights(() => 20);
    m.setRowCount(10);
    m.measure(3, 50);
    m.setRowCount(700);
    expect(m.heightOf(3)).toBe(50);
    expect(m.total()).toBe(700 * 20 + 30);
    m.setRowCount(2);
    expect(m.total()).toBe(40);
    expect(m.rowCount).toBe(2);
  });

  it('invalidate：清全部测高并按（可能已变的）估算重估', () => {
    let est = 20;
    const m = new RowHeights(() => est);
    m.setRowCount(300);
    m.measure(1, 80);
    est = 40;
    m.invalidate();
    expect(m.heightOf(1)).toBe(40);
    expect(m.total()).toBe(300 * 40);
  });

  it('setRowCount 增长：边界块的新行改用增长时刻的估算（不残留旧前缀缓存）', () => {
    const lengths: number[] = [];
    const m = new RowHeights((i) => (lengths[i] === undefined ? 20 : 20 * lengths[i]!));
    m.setRowCount(10);
    expect(m.total()).toBe(200); // 前缀已缓存（行 0..9 估算 20）
    for (let i = 10; i < 20; i++) lengths[i] = 2; // 窗口流式：新索引行字节长到货
    m.setRowCount(20);
    expect(m.total()).toBe(10 * 20 + 10 * 40);
    expect(m.offsetOf(15)).toBe(200 + 5 * 40);
  });

  it('百万行：测高 + 千次 rowAt/offsetOf 查询不退化为每次 O(n)', () => {
    const m = new RowHeights(() => 20);
    m.setRowCount(1_000_000);
    const t0 = performance.now();
    for (let k = 0; k < 1000; k++) {
      const row = (k * 997) % 1_000_000;
      m.measure(row, 60);
      expect(m.rowAt(m.offsetOf(row))).toBe(row);
    }
    expect(performance.now() - t0).toBeLessThan(2000);
  });
});

describe('variableScroller', () => {
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

  function model(n: number, est: (i: number) => number): RowHeights {
    const m = new RowHeights(est);
    m.setRowCount(n);
    return m;
  }

  it('初始窗口 [0..2×overscan]，spacer = 估算总高', () => {
    const c = host();
    const ranges: Array<[number, number]> = [];
    const h = variableScroller(c, model(500, () => 40), (f, l) => ranges.push([f, l]));
    expect(ranges).toEqual([[0, 20]]); // jsdom clientHeight=0 → 0 可视 + 2×10 overscan
    expect((c.querySelector('.vv-virtual-spacer') as HTMLElement).style.height).toBe('20000px');
    h.destroy();
    c.remove();
  });

  it('滚动按前缀定位首可视行：测高后同一 scrollTop 落到真实行', () => {
    const c = host();
    const m = model(100, () => 20);
    let first = -1;
    const h = variableScroller(c, m, (f) => {
      first = f;
    }, 0);
    for (let i = 0; i < 30; i++) h.measure(i, 100);
    h.refresh();
    c.scrollTop = 1050; // 前缀 [0..10)=1000 → 行 10
    c.dispatchEvent(new Event('scroll'));
    expect(first).toBe(10);
    expect(h.firstVisibleRow()).toBe(10);
    expect((c.querySelector('.vv-virtual-viewport') as HTMLElement).style.transform).toBe('translateY(1000px)');
    h.destroy();
    c.remove();
  });

  it('measure + refresh：spacer 随测高更新；范围未变不重绘，refresh(true) 强制重绘', () => {
    const c = host();
    let calls = 0;
    const h = variableScroller(c, model(10, () => 20), () => {
      calls++;
    });
    expect(calls).toBe(1);
    h.measure(3, 80);
    h.refresh();
    expect(calls).toBe(1);
    expect((c.querySelector('.vv-virtual-spacer') as HTMLElement).style.height).toBe('260px'); // 9×20 + 80
    h.refresh(true);
    expect(calls).toBe(2);
    h.destroy();
    c.remove();
  });

  it('渲染后自动测高（data-line 行的 offsetHeight）：视口首行之上的行变高时滚动补偿，首可视行不跳', () => {
    const c = host();
    const m = model(200, () => 20);
    // jsdom 无布局：桩 offsetHeight——行 ≥40 实际 60px（估算 20，模拟长行折行），
    // 其余与估算一致（初始窗口测高零变化）
    const proto = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get(this: HTMLElement) {
        const line = this.dataset.line;
        if (line === undefined) return 0;
        return Number(line) >= 40 ? 60 : 20;
      }
    });
    try {
      const h = variableScroller(
        c,
        m,
        (f, l, vp) => {
          vp.replaceChildren(
            ...Array.from({ length: l - f + 1 }, (_, k) => {
              const row = document.createElement('div');
              row.dataset.line = String(f + k);
              return row;
            })
          );
        },
        5
      );
      // 估算域滚到行 50（50×20=1000）：渲染 [45..65]（锚 50 - overscan 5，+2×5），自动测得 60px
      c.scrollTop = 1000;
      c.dispatchEvent(new Event('scroll'));
      // 锚定首可视行 50：其上 45..49 由 20→60 共变高 200px，scrollTop 同步补偿至 1200
      expect(m.heightOf(47)).toBe(60);
      expect(h.firstVisibleRow()).toBe(50);
      expect(c.scrollTop).toBe(1200);
      h.destroy();
    } finally {
      if (proto) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', proto);
      c.remove();
    }
  });

  it('scrollTo 取虚拟坐标（与 offsetOf 同域）', () => {
    const c = host();
    const h = variableScroller(c, model(100, () => 20), () => {});
    for (let i = 0; i <= 60; i++) h.measure(i, 50);
    h.scrollTo(h.offsetOf(50));
    expect(c.scrollTop).toBe(2500);
    h.destroy();
    c.remove();
  });

  it('总高超 SCROLL_PX_CAP 走压缩滚动域线性映射：滚到底落末行', () => {
    const c = host();
    let last = -1;
    const n = 90;
    const h = variableScroller(c, model(n, () => 400_000), (_f, l) => {
      last = l;
    }, 0);
    expect((c.querySelector('.vv-virtual-spacer') as HTMLElement).style.height).toBe(`${SCROLL_PX_CAP}px`);
    Object.defineProperty(c, 'clientHeight', { configurable: true, value: 400_000 });
    c.scrollTop = SCROLL_PX_CAP - 400_000;
    c.dispatchEvent(new Event('scroll'));
    expect(last).toBe(n - 1);
    h.destroy();
    c.remove();
  });
});

describe('variableScroller 宽度变化（折行全变）', () => {
  let roCallbacks: Array<() => void> = [];
  beforeEach(() => {
    roCallbacks = [];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: () => void) {
          roCallbacks.push(cb);
        }
        observe(): void {}
        disconnect(): void {}
      }
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it('容器变宽：onWidthChange 先行（消费方更新估算参数）→ 测高作废按新估算重估，首可视行保持', () => {
    const c = document.createElement('div');
    document.body.append(c);
    let width = 400;
    Object.defineProperty(c, 'clientWidth', { configurable: true, get: () => width });
    let rowsPerLine = 3; // 估算：窄容器每行折 3 视觉行
    const m = new RowHeights(() => 20 * rowsPerLine);
    m.setRowCount(100);
    const widthChanges: number[] = [];
    const h = variableScroller(c, m, () => {}, 0, () => {
      widthChanges.push(width);
      rowsPerLine = 1; // 变宽后不再折行
    });
    h.measure(5, 200);
    h.scrollTo(h.offsetOf(10)); // 首可视行 10
    c.dispatchEvent(new Event('scroll'));
    expect(h.firstVisibleRow()).toBe(10);
    // 仅高度变化：不触发重估
    for (const cb of roCallbacks) cb();
    expect(widthChanges).toEqual([]);
    width = 800;
    for (const cb of roCallbacks) cb();
    expect(widthChanges).toEqual([800]);
    expect(m.heightOf(5)).toBe(20); // 旧测高作废、新估算生效
    expect(h.firstVisibleRow()).toBe(10);
    expect(c.scrollTop).toBe(200); // 行 10 新前缀 10×20
    h.destroy();
    c.remove();
  });
});

describe('virtualScroller 行几何方法（与 variableScroller 同接口）', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class {
      observe(): void {}
      disconnect(): void {}
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('offsetOf/heightOf/rowAt 为固定行高算式；firstVisibleRow 随 scrollTop', () => {
    const c = document.createElement('div');
    document.body.append(c);
    const h = virtualScroller(c, 100, 20, () => {});
    expect(h.offsetOf(7)).toBe(140);
    expect(h.heightOf(7)).toBe(20);
    expect(h.rowAt(141)).toBe(7);
    c.scrollTop = 400;
    expect(h.firstVisibleRow()).toBe(20);
    h.destroy();
    c.remove();
  });
});
