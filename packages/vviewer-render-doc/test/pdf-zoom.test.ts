// pdf-zoom.test.ts — PDF 缩放模式单测（问题 #2：手机上 100% 恒超宽，横向发票 PDF 看不到
// 左半边）。缩放三模式：
// - auto（默认）：适应宽度但不超过 100%，即 min(1, 适宽值)；
// - fit：工具条「适应宽度」按钮进入，精确适宽，可超过 100%；
// - manual：−/＋ 在预设档位间步进（从连续值出发取严格相邻档位）。
// 适宽值 = .vv-pdf-pages 内容可用宽（clientWidth 扣左右 padding）/ 首页 scale 1 的
// viewport 宽；clientWidth<=0（jsdom 未布局）回落 1——pdf-render.test.ts 的既有语义不变。
// jsdom 无布局：以原型 getter 桩只对 .vv-pdf-pages 生效的 clientWidth/offsetWidth；
// jsdom 无 ResizeObserver：以可手动触发的假实现替身（另有一例验证缺失时的守卫）；
// pdfjs 沿用 pdf-render.test.ts 的 vi.mock 形态，只保留 getDocument 面。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Detection, FileSource, RenderedInstance, TreeStore } from '@bhxch/vviewer-core';
import { pdfRenderer } from '../src/pdf';

const here = path.dirname(fileURLToPath(import.meta.url));

const getDocumentMock = vi.hoisted(() => vi.fn());

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: getDocumentMock,
  PDFDataRangeTransport: class {}
}));

// ---- 夹具 ----

/** 横向 A4（842×595pt）：手机竖屏下 100% 必然超宽的典型发票形态 */
const PAGE_W = 842;
const PAGE_H = 595;

const DET = { ext: 'pdf' } as Detection;
const SOURCE: FileSource = {
  storeId: 's-test',
  storeLabel: '测试 store',
  path: '/invoice.pdf',
  name: 'invoice.pdf',
  store: {} as TreeStore
};
const BYTES = Uint8Array.from([0x25, 0x50, 0x44, 0x46]); // %PDF（getDocument 已桩，内容不被解析）

/** getViewport 调用记录：渲染尺寸须取连续 scale（不再限于预设档位） */
const getViewportMock = vi.fn(({ scale }: { scale: number }) => ({ width: PAGE_W * scale, height: PAGE_H * scale }));

function makeDoc(numPages = 2): unknown {
  return { numPages, getPage: async () => ({ getViewport: getViewportMock }) };
}

/** .vv-pdf-pages 的模拟盒宽：client = 内容+padding（扣滚动条），offset = 边框盒（含滚动条） */
const box = { client: 0, offset: 0 };
function setHostWidth(w: number): void {
  box.client = w;
  box.offset = w;
}

/** 可手动触发的 ResizeObserver 替身（回调只读 pagesHost 当前盒宽，entries 不被消费） */
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  readonly observed: Array<{ target: Element; options?: ResizeObserverOptions }> = [];
  disconnected = false;
  constructor(private readonly cb: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this);
  }
  observe(target: Element, options?: ResizeObserverOptions): void {
    this.observed.push({ target, options });
  }
  unobserve(): void {}
  disconnect(): void {
    this.disconnected = true;
  }
  fire(): void {
    this.cb([], this as unknown as ResizeObserver);
  }
}

function lastRo(): FakeResizeObserver {
  const ro = FakeResizeObserver.instances.at(-1);
  expect(ro).toBeDefined();
  return ro!;
}

async function renderPdf(): Promise<{ host: HTMLElement; inst: RenderedInstance }> {
  const host = document.createElement('div');
  document.body.append(host);
  const inst = await pdfRenderer.render(BYTES, host, SOURCE, DET);
  // 冲刷首屏立即渲染（ensureRender 异步取页/取 viewport），后续断言与计数不受其残留干扰
  await new Promise((r) => setTimeout(r, 0));
  return { host, inst };
}

const label = (host: HTMLElement): string | null => host.querySelector('.vv-pdf-zoom-label')!.textContent;
const button = (host: HTMLElement, name: string): HTMLButtonElement =>
  host.querySelector<HTMLButtonElement>(`.vv-pdf-toolbar button[aria-label="${name}"]`)!;
/** 首页占位宽（px 数值）：渲染尺寸/占位尺寸随连续 scale 变化的可观测面 */
const pageWidth = (host: HTMLElement): number =>
  parseFloat(host.querySelector<HTMLElement>('.vv-pdf-page')!.style.width);
const pct = (scale: number): string => `${Math.round(scale * 100)}%`;

beforeEach(() => {
  setHostWidth(0);
  FakeResizeObserver.instances = [];
  getViewportMock.mockClear();
  getDocumentMock.mockReset();
  getDocumentMock.mockImplementation(() => ({ promise: Promise.resolve(makeDoc()), destroy: vi.fn(async () => {}) }));
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
      takeRecords(): unknown[] {
        return [];
      }
    }
  );
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  // jsdom 无 canvas 后端：getContext 恒 null（ensureRender 取完 viewport 后早退）
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  vi.spyOn(Element.prototype, 'clientWidth', 'get').mockImplementation(function (this: Element) {
    return this.classList.contains('vv-pdf-pages') ? box.client : 0;
  });
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('vv-pdf-pages') ? box.offset : 0;
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

describe('auto 模式（默认）：适应宽度但不超过 100%', () => {
  it('窄容器（375px，手机竖屏）首屏缩放 < 1：占位与渲染 viewport 均按适宽值', async () => {
    setHostWidth(375);
    const { host, inst } = await renderPdf();
    const fit = 375 / PAGE_W;
    expect(fit).toBeLessThan(1);
    expect(label(host)).toBe(pct(fit));
    expect(pageWidth(host)).toBeCloseTo(375, 6); // 页宽恰为容器内容宽，不再超宽
    // 立即渲染页以连续 scale 取 viewport（不再落在预设档位上）
    expect(getViewportMock).toHaveBeenCalledWith({ scale: fit });
    inst.destroy();
  });

  it('可用宽扣除 .vv-pdf-pages 左右 padding（读计算样式，与 app.css 同源）', async () => {
    const style = document.createElement('style');
    style.textContent = '.vv-pdf-pages { padding: 12px; }';
    document.head.append(style);
    setHostWidth(375);
    const { host, inst } = await renderPdf();
    const fit = (375 - 24) / PAGE_W;
    expect(label(host)).toBe(pct(fit));
    expect(pageWidth(host)).toBeCloseTo(351, 6);
    inst.destroy();
  });

  it('宽容器（1600px）封顶 100%（适宽值 > 1 也不放大）', async () => {
    setHostWidth(1600);
    const { host, inst } = await renderPdf();
    expect(label(host)).toBe('100%');
    expect(pageWidth(host)).toBe(PAGE_W);
    inst.destroy();
  });

  it('clientWidth 为 0（未布局）回落 100%', async () => {
    setHostWidth(0);
    const { host, inst } = await renderPdf();
    expect(label(host)).toBe('100%');
    expect(pageWidth(host)).toBe(PAGE_W);
    inst.destroy();
  });
});

describe('fit 模式：「适应宽度」按钮', () => {
  it('按钮带 aria-label/title「适应宽度」，点击后精确适宽且可超过 100%', async () => {
    setHostWidth(1600);
    const { host, inst } = await renderPdf();
    const fitBtn = button(host, '适应宽度');
    expect(fitBtn).not.toBeNull();
    expect(fitBtn.title).toBe('适应宽度');
    expect(label(host)).toBe('100%'); // auto 封顶
    fitBtn.click();
    const fit = 1600 / PAGE_W;
    expect(fit).toBeGreaterThan(1);
    expect(label(host)).toBe(pct(fit));
    expect(pageWidth(host)).toBeCloseTo(1600, 6);
    inst.destroy();
  });

  it('manual 步进后点适宽：回到精确适宽值', async () => {
    setHostWidth(375);
    const { host, inst } = await renderPdf();
    button(host, '放大').click();
    expect(label(host)).toBe('50%');
    button(host, '适应宽度').click();
    expect(label(host)).toBe(pct(375 / PAGE_W));
    inst.destroy();
  });
});

describe('manual 模式：−/＋ 从连续值步进到严格相邻档位', () => {
  it('auto 45% 起：＋ → 50% → 75%；− → 50% → 25%（档位表含 0.25）', async () => {
    setHostWidth(375); // 375/842 ≈ 0.445
    const { host, inst } = await renderPdf();
    expect(label(host)).toBe('45%');
    button(host, '放大').click();
    expect(label(host)).toBe('50%');
    expect(pageWidth(host)).toBe(PAGE_W * 0.5);
    button(host, '放大').click();
    expect(label(host)).toBe('75%');
    button(host, '缩小').click();
    expect(label(host)).toBe('50%');
    button(host, '缩小').click();
    expect(label(host)).toBe('25%');
    inst.destroy();
  });

  it('auto 起点直接 −：取严格小于当前值的最大档位', async () => {
    setHostWidth(375);
    const { host, inst } = await renderPdf();
    button(host, '缩小').click();
    expect(label(host)).toBe('25%');
    inst.destroy();
  });

  it('当前值恰在档位上：步进到相邻档、不原地踏步（100% → ＋150% → −100% → −75%）', async () => {
    setHostWidth(1600); // auto 封顶恰为 1
    const { host, inst } = await renderPdf();
    button(host, '放大').click();
    expect(label(host)).toBe('150%');
    button(host, '缩小').click();
    expect(label(host)).toBe('100%');
    button(host, '缩小').click();
    expect(label(host)).toBe('75%');
    inst.destroy();
  });

  it('与档位差不足半个百分点视为同档：标签同显 100% 时 ＋ 直达 150%、− 直达 75%（无标签不变的空步）', async () => {
    setHostWidth(840); // 840/842 ≈ 0.9976，标签显示 100%
    const first = await renderPdf();
    expect(label(first.host)).toBe('100%');
    button(first.host, '放大').click();
    expect(label(first.host)).toBe('150%');
    first.inst.destroy();

    const second = await renderPdf();
    expect(label(second.host)).toBe('100%');
    button(second.host, '缩小').click();
    expect(label(second.host)).toBe('75%');
    second.inst.destroy();
  });

  it('禁用态：最小档 25% 时 − 禁用；300% 时 ＋ 禁用', async () => {
    setHostWidth(1600);
    const { host, inst } = await renderPdf();
    const zoomOut = button(host, '缩小');
    const zoomIn = button(host, '放大');
    expect(zoomOut.disabled).toBe(false);
    expect(zoomIn.disabled).toBe(false);
    zoomOut.click(); // 75%
    zoomOut.click(); // 50%
    zoomOut.click(); // 25%
    expect(label(host)).toBe('25%');
    expect(zoomOut.disabled).toBe(true);
    expect(zoomIn.disabled).toBe(false);
    for (let i = 0; i < 6; i++) zoomIn.click(); // 50/75/100/150/200/300
    expect(label(host)).toBe('300%');
    expect(zoomIn.disabled).toBe(true);
    expect(zoomOut.disabled).toBe(false);
    inst.destroy();
  });

  it('禁用态按连续值判定：auto 低于最小档时 − 禁用；fit 高于最大档时 ＋ 禁用、− 回落 300%', async () => {
    setHostWidth(100); // 100/842 ≈ 0.119 < 0.25
    const { host, inst } = await renderPdf();
    expect(label(host)).toBe('12%');
    expect(button(host, '缩小').disabled).toBe(true);
    expect(button(host, '放大').disabled).toBe(false);
    inst.destroy();

    setHostWidth(3000); // fit = 3000/842 ≈ 3.56 > 3
    const second = await renderPdf();
    button(second.host, '适应宽度').click();
    expect(label(second.host)).toBe(pct(3000 / PAGE_W));
    expect(button(second.host, '放大').disabled).toBe(true);
    button(second.host, '缩小').click();
    expect(label(second.host)).toBe('300%');
    second.inst.destroy();
  });
});

describe('ResizeObserver：auto/fit 模式跟随容器宽变化', () => {
  it('观察 pagesHost 的边框盒（滚动条出没不改变边框盒，不触发重算）', async () => {
    setHostWidth(375);
    const { host, inst } = await renderPdf();
    const ro = lastRo();
    expect(ro.observed).toHaveLength(1);
    expect(ro.observed[0]!.target).toBe(host.querySelector('.vv-pdf-pages'));
    expect(ro.observed[0]!.options).toEqual({ box: 'border-box' });
    inst.destroy();
  });

  it('auto：容器变宽 → 防抖 150ms 后重算；超过 100% 时封顶', async () => {
    setHostWidth(375);
    const { host, inst } = await renderPdf();
    vi.useFakeTimers();
    const ro = lastRo();
    expect(label(host)).toBe(pct(375 / PAGE_W));
    setHostWidth(600);
    ro.fire();
    vi.advanceTimersByTime(149);
    expect(label(host)).toBe(pct(375 / PAGE_W)); // 防抖窗口内不重排
    vi.advanceTimersByTime(1);
    expect(label(host)).toBe(pct(600 / PAGE_W));
    expect(pageWidth(host)).toBeCloseTo(600, 6);
    setHostWidth(2000);
    ro.fire();
    vi.advanceTimersByTime(150);
    expect(label(host)).toBe('100%');
    inst.destroy();
  });

  it('连续通知只按最后一次宽度重算一次（防抖合并）', async () => {
    setHostWidth(375);
    const { host, inst } = await renderPdf();
    vi.useFakeTimers();
    const ro = lastRo();
    getViewportMock.mockClear();
    setHostWidth(500);
    ro.fire();
    vi.advanceTimersByTime(100);
    setHostWidth(700);
    ro.fire();
    vi.advanceTimersByTime(100);
    expect(label(host)).toBe(pct(375 / PAGE_W)); // 第二次通知重置了防抖计时
    vi.advanceTimersByTime(50);
    expect(label(host)).toBe(pct(700 / PAGE_W));
    // 只重排了一次：立即重渲染页（前 2 页）各取一次 viewport，且都取最终 scale
    await vi.waitFor(() => expect(getViewportMock).toHaveBeenCalled());
    for (const [arg] of getViewportMock.mock.calls) expect(arg).toEqual({ scale: 700 / PAGE_W });
    inst.destroy();
  });

  it('变化不超过 0.5% 不重排', async () => {
    setHostWidth(375);
    const { host, inst } = await renderPdf();
    vi.useFakeTimers();
    const before = host.querySelector<HTMLElement>('.vv-pdf-page')!.style.width;
    setHostWidth(376); // +0.27%
    lastRo().fire();
    vi.advanceTimersByTime(150);
    expect(host.querySelector<HTMLElement>('.vv-pdf-page')!.style.width).toBe(before);
    expect(label(host)).toBe(pct(375 / PAGE_W));
    inst.destroy();
  });

  it('仅 clientWidth 变化（滚动条出没、边框盒宽不变）不重排，避免适宽与滚动条互相触发', async () => {
    setHostWidth(375);
    const { host, inst } = await renderPdf();
    vi.useFakeTimers();
    box.client = 360; // 竖向滚动条出现：内容宽缩 15px，边框盒宽仍为 375
    lastRo().fire();
    vi.advanceTimersByTime(150);
    expect(label(host)).toBe(pct(375 / PAGE_W));
    inst.destroy();
  });

  it('容器暂不可见（clientWidth 归 0）不重排：保持当前缩放，不回落 100%', async () => {
    setHostWidth(375);
    const { host, inst } = await renderPdf();
    vi.useFakeTimers();
    setHostWidth(0);
    lastRo().fire();
    vi.advanceTimersByTime(150);
    expect(label(host)).toBe(pct(375 / PAGE_W));
    inst.destroy();
  });

  it('manual 模式不跟随容器宽；点适宽进入 fit 后恢复跟随（且可超过 100%）', async () => {
    setHostWidth(375);
    const { host, inst } = await renderPdf();
    vi.useFakeTimers();
    const ro = lastRo();
    button(host, '放大').click(); // manual 50%
    setHostWidth(2000);
    ro.fire();
    vi.advanceTimersByTime(150);
    expect(label(host)).toBe('50%');
    button(host, '适应宽度').click();
    expect(label(host)).toBe(pct(2000 / PAGE_W));
    setHostWidth(1000);
    ro.fire();
    vi.advanceTimersByTime(150);
    expect(label(host)).toBe(pct(1000 / PAGE_W));
    expect(pageWidth(host)).toBeCloseTo(1000, 6);
    inst.destroy();
  });

  it('destroy 断开 ResizeObserver，在途防抖不再落地', async () => {
    setHostWidth(375);
    const { host, inst } = await renderPdf();
    vi.useFakeTimers();
    const ro = lastRo();
    setHostWidth(600);
    ro.fire();
    inst.destroy();
    expect(ro.disconnected).toBe(true);
    getViewportMock.mockClear();
    vi.advanceTimersByTime(150);
    expect(getViewportMock).not.toHaveBeenCalled();
    expect(host.querySelector('.vv-pdf')).toBeNull();
  });

  it('环境无 ResizeObserver（jsdom/旧浏览器）：守卫跳过，渲染与缩放照常', async () => {
    vi.stubGlobal('ResizeObserver', undefined);
    setHostWidth(375);
    const { host, inst } = await renderPdf();
    expect(label(host)).toBe(pct(375 / PAGE_W));
    button(host, '放大').click();
    expect(label(host)).toBe('50%');
    inst.destroy();
  });
});

describe('页宽超过容器时横向溢出可达（app.css 契约锚）', () => {
  // jsdom 无布局、溢出方向无法实测，故钉住 CSS 形态：容器若以 align-items:center 居中，
  // 页宽超容器时页向左右对称溢出，左侧落进负滚动区永远滚不到；居中改由页自身
  // 左右 auto margin 承担（flex 交叉轴 auto margin 在负余量时归零，溢出只向右）
  const css = readFileSync(path.join(here, '../../../apps/web/src/app.css'), 'utf8');
  /** 取行首选择器恰为 selector 的规则体（`.vv-pdf-page` 不会误中 `.vv-pdf-pages`/`.vv-pdf-page canvas`） */
  const ruleBody = (selector: string): string => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css);
    expect(m, `app.css 缺少 ${selector} 规则`).not.toBeNull();
    return m![1]!;
  };

  it('.vv-pdf-pages 不用 align-items:center 居中', () => {
    expect(ruleBody('.vv-pdf-pages')).not.toMatch(/align-items\s*:\s*center/);
  });

  it('.vv-pdf-page 以左右 auto margin 居中（不用 margin-inline：旧 Safari 不支持）', () => {
    expect(ruleBody('.vv-pdf-page')).toMatch(/margin-left\s*:\s*auto/);
    expect(ruleBody('.vv-pdf-page')).toMatch(/margin-right\s*:\s*auto/);
  });
});
