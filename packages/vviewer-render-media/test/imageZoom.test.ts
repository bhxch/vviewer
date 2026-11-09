// imageZoom.test.ts — 独立图片查看器缩放/平移交互单测（布局缩放 + 容器滚动）。
// jsdom 无布局：installLayout 以最小布局桩模拟——容器视口 VIEW 固定；图片布局尺寸取
// style.width/height（未写时取 zoom=1 布局尺寸：raster=固有尺寸，无固有尺寸 SVG=
// layoutW/H）；小于视口时 margin:auto 居中；scrollLeft/Top 按 [0, 溢出量] 钳制；
// getBoundingClientRect 按上述推算（视口坐标，同真实浏览器口径）。
// 指针事件：jsdom 30 有 PointerEvent 构造（pointerId/pointerType 可用），无
// setPointerCapture（实现须容错）；DragEvent 未实现，dragstart 以可取消 Event 代派。
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FileSource, RenderedInstance } from '@bhxch/vviewer-core';
import { imageRenderer } from '../src/image';

/** 容器视口：左上 (10,20)、400×300（非原点以验证坐标换算不依赖 0 偏移） */
const VIEW = { left: 10, top: 20, cw: 400, ch: 300 };

interface Mounted {
  container: HTMLElement;
  img: HTMLImageElement;
  instance: RenderedInstance;
}

interface LayoutOpts {
  /** 固有尺寸（naturalWidth/Height；无固有尺寸 SVG 取 0） */
  nw: number;
  nh: number;
  /** zoom=1 布局尺寸（缺省=固有尺寸；无固有尺寸 SVG 的默认对象尺寸） */
  layoutW?: number;
  layoutH?: number;
}

function fakeSource(name: string): FileSource {
  return {
    storeId: 'localfiles:s', storeLabel: 's', path: name, name,
    store: { id: 'x', displayName: () => 'x', listChildren: async () => [], read: async () => new Uint8Array() }
  };
}

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return { left, top, width, height, x: left, y: top, right: left + width, bottom: top + height, toJSON: () => ({}) } as DOMRect;
}

function installLayout(container: HTMLElement, img: HTMLImageElement, o: LayoutOpts): void {
  const def = (el: object, key: string, get: () => number, set?: (v: number) => void): void => {
    Object.defineProperty(el, key, { configurable: true, get, set });
  };
  const w = (): number => parseFloat(img.style.width) || (o.layoutW ?? o.nw);
  const h = (): number => parseFloat(img.style.height) || (o.layoutH ?? o.nh);
  const maxX = (): number => Math.max(0, w() - VIEW.cw);
  const maxY = (): number => Math.max(0, h() - VIEW.ch);
  const clamp = (v: number, max: number): number => Math.min(max, Math.max(0, v));
  let sx = 0;
  let sy = 0;
  def(container, 'clientWidth', () => VIEW.cw);
  def(container, 'clientHeight', () => VIEW.ch);
  def(container, 'scrollWidth', () => Math.max(VIEW.cw, w()));
  def(container, 'scrollHeight', () => Math.max(VIEW.ch, h()));
  // 内容缩小后浏览器在布局时钳制滚动位置：getter 现算钳制值同构
  def(container, 'scrollLeft', () => clamp(sx, maxX()), (v) => { sx = clamp(v, maxX()); });
  def(container, 'scrollTop', () => clamp(sy, maxY()), (v) => { sy = clamp(v, maxY()); });
  container.getBoundingClientRect = () => rect(VIEW.left, VIEW.top, VIEW.cw, VIEW.ch);
  img.getBoundingClientRect = () => rect(
    VIEW.left + Math.max(0, (VIEW.cw - w()) / 2) - container.scrollLeft,
    VIEW.top + Math.max(0, (VIEW.ch - h()) / 2) - container.scrollTop,
    w(),
    h()
  );
  def(img, 'naturalWidth', () => o.nw);
  def(img, 'naturalHeight', () => o.nh);
}

async function mount(o: LayoutOpts & { svg?: boolean }): Promise<Mounted> {
  Object.defineProperty(URL, 'createObjectURL', { value: vi.fn(() => 'blob:mock-zoom'), configurable: true });
  Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true });
  // BUG-53 解码校验：桩 decode 立即 resolve 走主路径（同 renderMedia.test.ts）
  (HTMLImageElement.prototype as { decode?: unknown }).decode = () => Promise.resolve();
  const target = document.createElement('div');
  document.body.append(target);
  const buffer = o.svg
    ? new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 1"><rect width="2" height="1"/></svg>')
    : new Uint8Array(8);
  const instance = await imageRenderer.render(
    buffer, target, fakeSource(o.svg ? 'a.svg' : 'a.png'), { ext: o.svg ? 'svg' : 'png' } as never
  );
  const container = target.querySelector<HTMLElement>('.vv-image')!;
  const img = container.querySelector('img')!;
  installLayout(container, img, o);
  return { container, img, instance };
}

function wheel(el: EventTarget, deltaY: number, x: number, y: number): WheelEvent {
  const ev = new WheelEvent('wheel', { deltaY, clientX: x, clientY: y, bubbles: true, cancelable: true });
  el.dispatchEvent(ev);
  return ev;
}

function ptr(
  type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel' | 'pointerenter',
  el: EventTarget,
  x: number,
  y: number,
  init: PointerEventInit = {}
): PointerEvent {
  const ev = new PointerEvent(type, {
    pointerId: 1, pointerType: 'mouse', button: type === 'pointermove' ? -1 : 0,
    clientX: x, clientY: y, bubbles: type !== 'pointerenter', cancelable: true, ...init
  });
  el.dispatchEvent(ev);
  return ev;
}

const widthOf = (img: HTMLImageElement): number => parseFloat(img.style.width);
const heightOf = (img: HTMLImageElement): number => parseFloat(img.style.height);

afterEach(() => {
  vi.restoreAllMocks();
  delete (HTMLImageElement.prototype as { decode?: unknown }).decode;
  document.body.innerHTML = '';
});

describe('imageRenderer 缩放（布局缩放：改 img 尺寸，滚动区随之增长）', () => {
  it('初始 zoom=1：data-vv-zoom 暴露倍率（e2e 读数面），img 不写尺寸保持固有布局', async () => {
    const { img } = await mount({ nw: 200, nh: 100 });
    expect(img.dataset.vvZoom).toBe('1');
    expect(img.style.width).toBe('');
    expect(img.style.height).toBe('');
  });
  it('wheel 放大：img 宽高按 1.1× 增长（基于固有尺寸），缩小 0.9×，限幅 0.1–10', async () => {
    const { container, img } = await mount({ nw: 200, nh: 100 });
    const ev = wheel(container, -100, 50, 50);
    expect(ev.defaultPrevented, '滚轮缩放须阻止页面滚动').toBe(true);
    expect(widthOf(img)).toBeCloseTo(220, 9);
    expect(heightOf(img)).toBeCloseTo(110, 9);
    expect(img.dataset.vvZoom).toBe('1.1');
    for (let i = 0; i < 40; i += 1) wheel(container, -100, 50, 50);
    expect(img.dataset.vvZoom).toBe('10');
    expect(widthOf(img)).toBe(2000);
    expect(container.scrollWidth, '放大溢出：滚动区=图片布局宽').toBe(2000);
    for (let i = 0; i < 80; i += 1) wheel(container, 100, 50, 50);
    expect(img.dataset.vvZoom).toBe('0.1');
    expect(widthOf(img)).toBeCloseTo(20, 9);
  });

  it('wheel 以光标为锚：锚点下的图像像素缩放前后保持在原视口位置', async () => {
    const { container, img } = await mount({ nw: 800, nh: 600 });
    const cx = VIEW.left + 100;
    const cy = VIEW.top + 50;
    // 缩放前光标下图像像素 = (100, 50)
    wheel(container, -100, cx, cy);
    const r = img.getBoundingClientRect();
    expect((cx - r.left) / 1.1).toBeCloseTo(100, 6);
    expect((cy - r.top) / 1.1).toBeCloseTo(50, 6);
    expect(container.scrollLeft).toBeCloseTo(10, 6);
    expect(container.scrollTop).toBeCloseTo(5, 6);
  });

  it('SVG 无固有尺寸：以 zoom=1 时的布局尺寸为基准缩放', async () => {
    const { container, img } = await mount({ svg: true, nw: 0, nh: 0, layoutW: 300, layoutH: 150 });
    wheel(container, -100, 50, 50);
    expect(widthOf(img)).toBeCloseTo(330, 9);
    expect(heightOf(img)).toBeCloseTo(165, 9);
  });
});

describe('imageRenderer 平移（Pointer Events 改容器滚动）', () => {
  it('鼠标 pointer 拖动改变 scrollLeft/scrollTop（右拖图随手右移即左滚），松手即停；非主键不拖', async () => {
    const { container, img } = await mount({ nw: 1000, nh: 800 });
    container.scrollLeft = 300;
    container.scrollTop = 200;
    ptr('pointerdown', img, 200, 200);
    ptr('pointermove', container, 150, 170);
    expect(container.scrollLeft).toBe(350);
    expect(container.scrollTop).toBe(230);
    ptr('pointermove', container, 250, 260); // 增量跟手：相对上一位置
    expect(container.scrollLeft).toBe(250);
    expect(container.scrollTop).toBe(140);
    ptr('pointerup', container, 250, 260);
    ptr('pointermove', container, 300, 300); // 松手后不再跟随
    expect(container.scrollLeft).toBe(250);
    expect(container.scrollTop).toBe(140);
    // 鼠标非主键（右键）不进入拖动
    ptr('pointerdown', img, 200, 200, { button: 2 });
    ptr('pointermove', container, 100, 100);
    expect(container.scrollLeft).toBe(250);
    ptr('pointerup', container, 100, 100, { button: 2 });
  });

  it('触屏 pointer 拖动同样平移；pointercancel 收尾', async () => {
    const { container, img } = await mount({ nw: 1000, nh: 800 });
    ptr('pointerdown', img, 300, 300, { pointerId: 11, pointerType: 'touch' });
    ptr('pointermove', container, 260, 250, { pointerId: 11, pointerType: 'touch' });
    expect(container.scrollLeft).toBe(40);
    expect(container.scrollTop).toBe(50);
    ptr('pointercancel', container, 260, 250, { pointerId: 11, pointerType: 'touch' });
    ptr('pointermove', container, 100, 100, { pointerId: 11, pointerType: 'touch' });
    expect(container.scrollLeft).toBe(40);
  });

  it('按下落在容器经典滚动条上（客户区外）不起平移：滚动条保留原生拖动；客户区内照常', async () => {
    const { container } = await mount({ nw: 1000, nh: 800 });
    // 15px 经典滚动条：容器边框盒比客户区宽/高 15
    container.getBoundingClientRect = () => rect(VIEW.left, VIEW.top, VIEW.cw + 15, VIEW.ch + 15);
    const onBar = { x: VIEW.left + VIEW.cw + 5, y: VIEW.top + 200 };
    ptr('pointerenter', container, onBar.x, onBar.y);
    ptr('pointerdown', container, onBar.x, onBar.y);
    ptr('pointermove', container, onBar.x, onBar.y - 100); // 若误起平移将下滚 100
    expect(container.scrollTop).toBe(0);
    expect(container.style.cursor, '未进入拖动态').toBe('grab');
    ptr('pointerup', container, onBar.x, onBar.y - 100);
    ptr('pointerdown', container, VIEW.left + 100, VIEW.top + 100);
    ptr('pointermove', container, VIEW.left + 80, VIEW.top + 90);
    expect(container.scrollLeft).toBe(20);
    expect(container.scrollTop).toBe(10);
    ptr('pointerup', container, VIEW.left + 80, VIEW.top + 90);
  });

  it('双指捏合：以两指中点为锚放大，同时随中点平移；抬一指后剩余指针接续平移不跳变', async () => {
    const { container, img } = await mount({ nw: 800, nh: 600 });
    const touch = (id: number): PointerEventInit => ({ pointerId: id, pointerType: 'touch' });
    ptr('pointerdown', img, VIEW.left + 100, VIEW.top + 100, touch(1));
    ptr('pointerdown', img, VIEW.left + 200, VIEW.top + 100, touch(2));
    // 指距 100 → 200（×2），中点视口 (160,120) → (210,120)
    ptr('pointermove', container, VIEW.left + 300, VIEW.top + 100, touch(2));
    expect(widthOf(img)).toBe(1600);
    expect(heightOf(img)).toBe(1200);
    expect(img.dataset.vvZoom).toBe('2');
    // 原中点下像素 (150,100) 落到新中点：left + 150×2 = 210 → scrollLeft 100；top 同理
    expect(container.scrollLeft).toBeCloseTo(100, 6);
    expect(container.scrollTop).toBeCloseTo(100, 6);
    ptr('pointerup', container, VIEW.left + 300, VIEW.top + 100, touch(2));
    ptr('pointermove', container, VIEW.left + 90, VIEW.top + 90, touch(1));
    expect(container.scrollLeft).toBeCloseTo(110, 6);
    expect(container.scrollTop).toBeCloseTo(110, 6);
    ptr('pointerup', container, VIEW.left + 90, VIEW.top + 90, touch(1));
  });
});

describe('imageRenderer 复位与原生行为抑制', () => {
  it('双击复位：zoom 回 1、尺寸回固有布局、滚动归零；拖动收尾的 dblclick 不复位', async () => {
    const { container, img } = await mount({ nw: 800, nh: 600 });
    wheel(container, -100, VIEW.left + 100, VIEW.top + 50);
    expect(container.scrollLeft).toBeGreaterThan(0);
    // 拖动（越阈值）后的 dblclick：不复位
    ptr('pointerdown', img, 200, 200);
    ptr('pointermove', container, 180, 190);
    ptr('pointerup', container, 180, 190);
    container.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(img.dataset.vvZoom).toBe('1.1');
    // 原地双击：复位
    ptr('pointerdown', img, 200, 200);
    ptr('pointerup', container, 200, 200);
    img.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(img.dataset.vvZoom).toBe('1');
    expect(img.style.width).toBe('');
    expect(img.style.height).toBe('');
    expect(container.scrollLeft).toBe(0);
    expect(container.scrollTop).toBe(0);
  });

  it('原生图片拖拽被拦截：img draggable=false 且 dragstart 被 preventDefault', async () => {
    const { img } = await mount({ nw: 800, nh: 600 });
    expect(img.draggable).toBe(false);
    const ev = new Event('dragstart', { bubbles: true, cancelable: true });
    img.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
  });

  it('cursor：不可平移时不设、可平移时 grab、拖动中 grabbing', async () => {
    const { container, img } = await mount({ nw: 100, nh: 50 });
    ptr('pointerenter', container, 50, 50);
    expect(container.style.cursor).toBe('');
    for (let i = 0; i < 20; i += 1) wheel(container, -100, 50, 50); // 100×1.1^20 ≈ 673 > 视口 400
    expect(container.style.cursor).toBe('grab');
    ptr('pointerdown', img, 200, 200);
    expect(container.style.cursor).toBe('grabbing');
    ptr('pointerup', container, 200, 200);
    expect(container.style.cursor).toBe('grab');
    container.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(container.style.cursor).toBe('');
  });
});

describe('imageRenderer 交互监听生命周期', () => {
  it('destroy 移除全部交互监听：add/remove 成对且引用一致，destroy 后交互无效', async () => {
    const add = vi.spyOn(EventTarget.prototype, 'addEventListener');
    const remove = vi.spyOn(EventTarget.prototype, 'removeEventListener');
    const { container, img, instance } = await mount({ nw: 1000, nh: 800 });
    // 前置：交互确实生效（证明下方「无效」源于摘监听而非本就不响应）
    ptr('pointerdown', img, 200, 200);
    ptr('pointermove', container, 150, 150);
    ptr('pointerup', container, 150, 150);
    expect(container.scrollLeft).toBe(50);
    wheel(container, -100, 50, 50);
    const widthBefore = img.style.width;
    expect(widthBefore).not.toBe('');
    const scrollBefore = container.scrollLeft;

    instance.destroy();

    const callsOn = (spy: typeof add, el: EventTarget): Array<[string, unknown]> =>
      spy.mock.calls.flatMap((args, i) => (spy.mock.contexts[i] === el ? [[String(args[0]), args[1]] as [string, unknown]] : []));
    for (const el of [container, img]) {
      const removed = callsOn(remove, el);
      for (const pair of callsOn(add, el)) expect(removed, `${pair[0]} 监听未摘除`).toContainEqual(pair);
    }
    expect(callsOn(add, container).map(([t]) => t)).toEqual(
      expect.arrayContaining(['wheel', 'pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'dblclick', 'dragstart'])
    );

    wheel(container, -100, 50, 50);
    expect(img.style.width, 'destroy 后滚轮不再缩放').toBe(widthBefore);
    ptr('pointerdown', img, 200, 200);
    ptr('pointermove', container, 100, 100);
    expect(container.scrollLeft, 'destroy 后拖动不再平移').toBe(scrollBefore);
    const drag = new Event('dragstart', { bubbles: true, cancelable: true });
    img.dispatchEvent(drag);
    expect(drag.defaultPrevented, 'destroy 后不再拦 dragstart').toBe(false);
  });
});
