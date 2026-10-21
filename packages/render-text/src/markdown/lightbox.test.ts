// lightbox.test.ts — 灯箱模块单测：缩放/平移/导航状态机纯函数直测 + jsdom DOM
// 交互（打开/关闭语义、画廊导航、键盘集、归属代币、主题前缀）。
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PipelineCtx } from './pipeline';
import {
  clampZoom,
  collectGallery,
  LIGHTBOX_OVERLAY_ID,
  LIGHTBOX_OWNER_ATTR,
  navigate,
  openLightbox,
  removeLightboxOverlay,
  zoomAt,
} from './lightbox';

const noCtx = {} as PipelineCtx;

function docOf(html: string): Document {
  const doc = document.implementation.createHTMLDocument('');
  doc.body.innerHTML = html;
  return doc;
}

function overlayOf(doc: Document): HTMLElement {
  return doc.getElementById(LIGHTBOX_OVERLAY_ID) as HTMLElement;
}

/** 解析 stage 的 transform（实现格式：translate(Xpx, Ypx) scale(Z)）。 */
function viewOf(stage: HTMLElement): { tx: number; ty: number; zoom: number } {
  const m = /translate\(([-\d.e]+)px, ([-\d.e]+)px\) scale\(([-\d.e]+)\)/.exec(stage.style.transform);
  expect(m).not.toBeNull();
  return { tx: Number(m![1]), ty: Number(m![2]), zoom: Number(m![3]) };
}

describe('collectGallery', () => {
  it('收集 img 与图表 svg，跳过 <32px 与 KaTeX 内 img', () => {
    const doc = docOf([
      '<img src="a.png" alt="A" width="100" height="80">',
      '<img src="tiny.gif" width="10" height="10">',
      '<div class="katex"><img src="k.png"></div>',
      '<div class="md-diagram-view"><svg viewBox="0 0 10 10"></svg></div>',
    ].join(''));
    const g = collectGallery(doc.body);
    expect(g).toHaveLength(2);
    expect(g[0]).toEqual({ type: 'img', src: 'a.png', alt: 'A' });
    expect(g[1]!.type).toBe('svg');
    expect((g[1] as { src: string }).src).toContain('<svg');
  });
});

describe('缩放/平移/导航 状态机纯函数', () => {
  it('clampZoom 限幅 0.2–8', () => {
    expect(clampZoom(0.01)).toBe(0.2);
    expect(clampZoom(100)).toBe(8);
    expect(clampZoom(1)).toBe(1);
  });

  it('zoomAt 光标中心锚定：光标下内容点缩放后不动', () => {
    const s0 = { zoom: 1, tx: 0, ty: 0, index: 0 };
    // 光标 (150,50)：内容点 = (150/1 - 0) → 缩放 2 后该点仍在 (150,50)
    const s1 = zoomAt(s0, 2, 150, 50);
    expect(s1.zoom).toBe(2);
    const px = 150 * s0.zoom + s0.tx;
    const pxAfter = 150 * s1.zoom + s1.tx;
    expect(pxAfter).toBeCloseTo(px, 6);
    const py = 50 * s0.zoom + s0.ty;
    const pyAfter = 50 * s1.zoom + s1.ty;
    expect(pyAfter).toBeCloseTo(py, 6);
  });

  it('navigate 环绕', () => {
    expect(navigate({ index: 0, count: 3 }, -1).index).toBe(2);
    expect(navigate({ index: 2, count: 3 }, 1).index).toBe(0);
  });
});

describe('overlay 打开/关闭语义', () => {
  it('openLightbox：单例 overlay + img 内容 + 计数徽标 + owner 代币', () => {
    const doc = docOf('<img src="a.png" alt="A"><img src="b.png" alt="B">');
    openLightbox(doc.querySelector('img')!, noCtx, collectGallery(doc.body));
    const overlay = overlayOf(doc);
    expect(overlay).toBeTruthy();
    expect(doc.querySelectorAll('#' + LIGHTBOX_OVERLAY_ID)).toHaveLength(1);
    expect(overlay.querySelector('img.md-lightbox')!.getAttribute('src')).toBe('a.png');
    expect(overlay.querySelector('.md-lightbox-count')!.textContent).toBe('1/2');
    expect(overlay.getAttribute(LIGHTBOX_OWNER_ATTR)).toBe('');
    // 二次打开换图共享单例，owner 覆盖
    openLightbox(doc.querySelectorAll('img')[1]!, { lightboxOwner: 'md-render-7' } as PipelineCtx, collectGallery(doc.body));
    expect(doc.querySelectorAll('#' + LIGHTBOX_OVERLAY_ID)).toHaveLength(1);
    expect(overlay.getAttribute(LIGHTBOX_OWNER_ATTR)).toBe('md-render-7');
    expect(overlay.querySelector('img.md-lightbox')!.getAttribute('src')).toBe('b.png');
    removeLightboxOverlay(doc);
    expect(overlayOf(doc)).toBeNull();
  });

  it('点击背景（overlay 本体或 stage 空白）关闭；点击内容与控制件不关；关闭钮关闭', () => {
    const doc = docOf('<img src="a.png" alt="A"><img src="b.png" alt="B">');
    openLightbox(doc.querySelector('img')!, noCtx, collectGallery(doc.body));
    const overlay = overlayOf(doc);
    // 点击内容 img：不关
    overlay.querySelector('img.md-lightbox')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(overlayOf(doc)).not.toBeNull();
    // 点击控制钮（zoom-in）：不关且生效
    overlay.querySelector<HTMLButtonElement>('.md-lightbox-btn-zoom-in')!.click();
    expect(overlayOf(doc)).not.toBeNull();
    expect(viewOf(overlay.querySelector('.md-lightbox-stage')!).zoom).toBeGreaterThan(1);
    // 点击 stage 空白（内容容器本体）：关
    overlay.querySelector('.md-lightbox-stage')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(overlayOf(doc)).toBeNull();
    // 重开后点击关闭钮：关
    openLightbox(doc.querySelector('img')!, noCtx, collectGallery(doc.body));
    overlayOf(doc).querySelector<HTMLButtonElement>('.md-lightbox-btn-close')!.click();
    expect(overlayOf(doc)).toBeNull();
  });

  it('点击图不在画廊中（微缩图等被收集规则跳过）→ 退化为单条画廊且导航件隐藏', () => {
    const doc = docOf('<img src="tiny.gif" width="10" height="10">');
    const g = collectGallery(doc.body);
    openLightbox(doc.querySelector('img')!, noCtx, g);
    const overlay = overlayOf(doc);
    expect(overlay.querySelector('.md-lightbox-count')!.textContent).toBe('1/1');
    expect(overlay.querySelector('img.md-lightbox')!.getAttribute('src')).toBe('tiny.gif');
    expect(overlay.querySelector('.md-lightbox-btn-prev')!.hasAttribute('hidden')).toBe(true);
    expect(overlay.querySelector('.md-lightbox-btn-next')!.hasAttribute('hidden')).toBe(true);
  });

  it('同 src 两图点第二张：按元素身份定位开第二张（非首 src 匹配，5-5）', () => {
    const doc = docOf('<img src="a.png" alt="first"><img src="a.png" alt="second">');
    const imgs = doc.querySelectorAll('img');
    openLightbox(imgs[1]!, noCtx, collectGallery(doc.body));
    const overlay = overlayOf(doc);
    expect(overlay.querySelector('.md-lightbox-count')!.textContent).toBe('2/2');
    expect(overlay.querySelector('img.md-lightbox')!.getAttribute('alt')).toBe('second');
    removeLightboxOverlay(doc);
  });

  it('svg 条目按元素身份定位：点 svg 直接开 svg（img 在前不抢位，5-4/5-5）', () => {
    const doc = docOf('<img src="a.png" alt="A"><div class="md-diagram-view"><svg viewBox="0 0 10 10"></svg></div>');
    openLightbox(doc.querySelector('.md-diagram-view svg')!, noCtx, collectGallery(doc.body));
    const overlay = overlayOf(doc);
    expect(overlay.querySelector('.md-lightbox-count')!.textContent).toBe('2/2');
    expect(overlay.querySelector('.md-lightbox-svg')!.hasAttribute('hidden')).toBe(false);
    expect(overlay.querySelector('.md-lightbox-svg')!.querySelector('svg')).not.toBeNull();
    expect(overlay.querySelector('img.md-lightbox')!.hasAttribute('hidden')).toBe(true);
    removeLightboxOverlay(doc);
  });

  it('svg 画廊条目：内容容器注入 outerHTML，img/svg 宿主按条目切换', () => {
    const doc = docOf('<img src="a.png" alt="A"><div class="md-diagram-view"><svg viewBox="0 0 10 10"></svg></div>');
    openLightbox(doc.querySelector('img')!, noCtx, collectGallery(doc.body));
    const overlay = overlayOf(doc);
    const svgHost = overlay.querySelector('.md-lightbox-svg')!;
    expect(svgHost.hasAttribute('hidden')).toBe(true);
    overlay.querySelector<HTMLButtonElement>('.md-lightbox-btn-next')!.click();
    expect(svgHost.hasAttribute('hidden')).toBe(false);
    expect(svgHost.querySelector('svg')).not.toBeNull();
    expect(overlay.querySelector('img.md-lightbox')!.hasAttribute('hidden')).toBe(true);
    removeLightboxOverlay(doc);
  });

  it('removeLightboxOverlay owner 校验：非 owner 不摘、owner 摘（U3 语义直测）', () => {
    const doc = docOf('<img src="a.png" alt="A">');
    openLightbox(doc.querySelector('img')!, { lightboxOwner: 'A' } as PipelineCtx, collectGallery(doc.body));
    removeLightboxOverlay(doc, 'B');
    expect(overlayOf(doc)).not.toBeNull();
    removeLightboxOverlay(doc, 'A');
    expect(overlayOf(doc)).toBeNull();
  });

  it('themeClassPrefix 前缀画廊类名', () => {
    const doc = docOf('<img src="a.png" alt="A">');
    openLightbox(doc.querySelector('img')!, { themeClassPrefix: 'dark-' } as PipelineCtx, collectGallery(doc.body));
    const overlay = overlayOf(doc);
    expect(overlay.classList.contains('dark-md-lightbox-overlay')).toBe(true);
    expect(overlay.querySelector('.dark-md-lightbox-stage')).not.toBeNull();
    expect(overlay.querySelector('.dark-md-lightbox-btn-next')).not.toBeNull();
    removeLightboxOverlay(doc);
  });
});

describe('画廊导航与键盘集', () => {
  it('next/prev 按钮环绕导航：计数/内容切换且视图重置', () => {
    const doc = docOf('<img src="a.png" alt="A"><img src="b.png" alt="B"><img src="c.png" alt="C">');
    openLightbox(doc.querySelector('img')!, noCtx, collectGallery(doc.body));
    const overlay = overlayOf(doc);
    const stage = overlay.querySelector<HTMLElement>('.md-lightbox-stage')!;
    const clone = overlay.querySelector('img.md-lightbox')!;
    // 先放大，导航后视图应重置
    overlay.querySelector<HTMLButtonElement>('.md-lightbox-btn-zoom-in')!.click();
    expect(viewOf(stage).zoom).toBe(1.25);
    overlay.querySelector<HTMLButtonElement>('.md-lightbox-btn-next')!.click();
    expect(overlay.querySelector('.md-lightbox-count')!.textContent).toBe('2/3');
    expect(clone.getAttribute('src')).toBe('b.png');
    expect(viewOf(stage)).toEqual({ tx: 0, ty: 0, zoom: 1 });
    overlay.querySelector<HTMLButtonElement>('.md-lightbox-btn-prev')!.click();
    overlay.querySelector<HTMLButtonElement>('.md-lightbox-btn-prev')!.click();
    expect(overlay.querySelector('.md-lightbox-count')!.textContent).toBe('3/3');
    overlay.querySelector<HTMLButtonElement>('.md-lightbox-btn-prev')!.click();
    expect(overlay.querySelector('.md-lightbox-count')!.textContent).toBe('2/3');
    overlay.querySelector<HTMLButtonElement>('.md-lightbox-btn-next')!.click();
    overlay.querySelector<HTMLButtonElement>('.md-lightbox-btn-next')!.click();
    expect(overlay.querySelector('.md-lightbox-count')!.textContent).toBe('1/3');
  });

  it('键盘：←/→ 导航、+/-/= 中心缩放、r 重置、Escape 关闭、其余键不动', () => {
    const doc = docOf('<img src="a.png" alt="A"><img src="b.png" alt="B">');
    openLightbox(doc.querySelector('img')!, noCtx, collectGallery(doc.body));
    const overlay = overlayOf(doc);
    const stage = overlay.querySelector<HTMLElement>('.md-lightbox-stage')!;
    const press = (key: string): void => { doc.dispatchEvent(new KeyboardEvent('keydown', { key })); };
    press('ArrowRight');
    expect(overlay.querySelector('.md-lightbox-count')!.textContent).toBe('2/2');
    press('ArrowRight');
    expect(overlay.querySelector('.md-lightbox-count')!.textContent).toBe('1/2');
    press('+');
    expect(viewOf(stage).zoom).toBe(1.25);
    press('=');
    expect(viewOf(stage).zoom).toBe(1.5625);
    press('-');
    expect(viewOf(stage).zoom).toBeCloseTo(1.25, 10);
    press('r');
    expect(viewOf(stage)).toEqual({ tx: 0, ty: 0, zoom: 1 });
    press('Enter');
    expect(overlayOf(doc)).not.toBeNull();
    press('Escape');
    expect(overlayOf(doc)).toBeNull();
  });

  it('输入守卫：input/contenteditable 内按键直通——不关灯箱、不导航、不缩放（5-2）', () => {
    const doc = docOf('<img src="a.png" alt="A"><img src="b.png" alt="B"><input type="text"><div contenteditable="true"></div>');
    openLightbox(doc.querySelector('img')!, noCtx, collectGallery(doc.body));
    const overlay = overlayOf(doc);
    const stage = overlay.querySelector<HTMLElement>('.md-lightbox-stage')!;
    const input = doc.querySelector('input')!;
    const editable = doc.querySelector('[contenteditable]')!;
    const press = (el: Element, key: string): void => {
      el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    };
    press(input, 'ArrowRight');
    expect(overlay.querySelector('.md-lightbox-count')!.textContent).toBe('1/2'); // 未导航
    press(input, 'Escape');
    expect(overlayOf(doc)).not.toBeNull(); // 未关闭
    press(editable, '+');
    expect(viewOf(stage).zoom).toBe(1); // 未缩放
    press(editable, 'Escape');
    expect(overlayOf(doc)).not.toBeNull();
    // 焦点不在输入控件时键集照常（守卫仅对控件内按键直通）
    press(doc.documentElement, 'ArrowRight');
    expect(overlay.querySelector('.md-lightbox-count')!.textContent).toBe('2/2');
    press(doc.documentElement, 'Escape');
    expect(overlayOf(doc)).toBeNull();
  });

  it('Esc 关闭：document 级 keydown 监听真被移除且引用匹配（spyOn 判别）', () => {
    const doc = docOf('<img src="a.png" alt="A">');
    const addSpy = vi.spyOn(doc, 'addEventListener');
    const removeSpy = vi.spyOn(doc, 'removeEventListener');
    try {
      openLightbox(doc.querySelector('img')!, noCtx, collectGallery(doc.body));
      const added = addSpy.mock.calls.find(([type]) => type === 'keydown');
      expect(added).toBeDefined();
      doc.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      expect(overlayOf(doc)).toBeNull();
      // 监听真被摘除：removeEventListener 恰一次，且移除的正是挂入的那个引用
      expect(removeSpy).toHaveBeenCalledTimes(1);
      expect(removeSpy).toHaveBeenCalledWith('keydown', added![1]);
      // 关闭后再按键无残留副作用（不重复移除、无 overlay 可操作）
      doc.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      expect(removeSpy).toHaveBeenCalledTimes(1);
      expect(overlayOf(doc)).toBeNull();
    } finally {
      addSpy.mockRestore();
      removeSpy.mockRestore();
    }
  });
});

describe('缩放平移交互（wheel/拖拽 pan/拖拽吞 click）', () => {
  it('wheel 缩放以光标为中心且限幅（deltaY<0 放大）', () => {
    const doc = docOf('<img src="a.png" alt="A">');
    openLightbox(doc.querySelector('img')!, noCtx, collectGallery(doc.body));
    const overlay = overlayOf(doc);
    const stage = overlay.querySelector<HTMLElement>('.md-lightbox-stage')!;
    const wheel = (deltaY: number, clientX = 150, clientY = 50): void => {
      overlay.dispatchEvent(new WheelEvent('wheel', { deltaY, clientX, clientY, cancelable: true }));
    };
    // 光标 (150,50) 锚定：zoom 1→1.25，t = c − 1.25·c = (−37.5, −12.5)，光标下内容点不动
    wheel(-120);
    expect(viewOf(stage)).toEqual({ tx: -37.5, ty: -12.5, zoom: 1.25 });
    // 连滚超上限 clamp 到 8；再反方向滚穿下限 clamp 到 0.2
    for (let i = 0; i < 30; i += 1) wheel(-120);
    expect(viewOf(stage).zoom).toBe(8);
    for (let i = 0; i < 60; i += 1) wheel(120);
    expect(viewOf(stage).zoom).toBe(0.2);
  });

  it('拖拽 pan：位移写入 tx/ty（增量相对按下点；恒允许，zoom=1 亦可拖），松手即停', () => {
    const doc = docOf('<img src="a.png" alt="A">');
    openLightbox(doc.querySelector('img')!, noCtx, collectGallery(doc.body));
    const overlay = overlayOf(doc);
    const stage = overlay.querySelector<HTMLElement>('.md-lightbox-stage')!;
    const mouse = (type: string, x: number, y: number): void => {
      const Target = type === 'mousedown' ? stage : doc;
      Target.dispatchEvent(new MouseEvent(type, { button: 0, clientX: x, clientY: y, bubbles: true }));
    };
    expect(stage.classList.contains('md-lightbox-dragging')).toBe(false);
    mouse('mousedown', 100, 100);
    expect(stage.classList.contains('md-lightbox-dragging')).toBe(true);
    mouse('mousemove', 160, 140);
    expect(viewOf(stage)).toEqual({ tx: 60, ty: 40, zoom: 1 });
    mouse('mousemove', 130, 120); // 第二段增量相对按下点，不叠加
    expect(viewOf(stage)).toEqual({ tx: 30, ty: 20, zoom: 1 });
    mouse('mouseup', 130, 120);
    expect(stage.classList.contains('md-lightbox-dragging')).toBe(false);
    mouse('mousemove', 200, 200); // 松手后不再跟随
    expect(viewOf(stage)).toEqual({ tx: 30, ty: 20, zoom: 1 });
  });

  it('T2 裁决：拖拽（位移超阈值）后的收尾 click 不误关 overlay，随后的真点背景仍关', () => {
    const doc = docOf('<img src="a.png" alt="A">');
    openLightbox(doc.querySelector('img')!, noCtx, collectGallery(doc.body));
    const overlay = overlayOf(doc);
    const stage = overlay.querySelector<HTMLElement>('.md-lightbox-stage')!;
    // 拖拽序列：mousedown（stage）→ 大位移 mousemove → mouseup（落点经冒泡到 overlay）
    stage.dispatchEvent(new MouseEvent('mousedown', { button: 0, clientX: 100, clientY: 100, bubbles: true }));
    doc.dispatchEvent(new MouseEvent('mousemove', { clientX: 160, clientY: 140, bubbles: true }));
    doc.dispatchEvent(new MouseEvent('mouseup', { clientX: 160, clientY: 140, bubbles: true }));
    overlay.dispatchEvent(new MouseEvent('click', { bubbles: true })); // 拖拽收尾 click
    expect(overlayOf(doc)).not.toBeNull(); // 不得意外关闭
    overlay.dispatchEvent(new MouseEvent('click', { bubbles: true })); // 真正点背景
    expect(overlayOf(doc)).toBeNull();
  });

  it('微动（未超阈值）不视为拖拽：收尾 click 仍按点击语义关背景', () => {
    const doc = docOf('<img src="a.png" alt="A">');
    openLightbox(doc.querySelector('img')!, noCtx, collectGallery(doc.body));
    const overlay = overlayOf(doc);
    const stage = overlay.querySelector<HTMLElement>('.md-lightbox-stage')!;
    stage.dispatchEvent(new MouseEvent('mousedown', { button: 0, clientX: 100, clientY: 100, bubbles: true }));
    doc.dispatchEvent(new MouseEvent('mousemove', { clientX: 101, clientY: 101, bubbles: true })); // Manhattan 2 ≤ 3
    doc.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    overlay.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(overlayOf(doc)).toBeNull();
  });
});

// a11y 基线（5-3）走全局 document：jsdom 对 defaultView 为 null 的文档（如
// implementation.createHTMLDocument）focus 是 no-op，焦点断言须有浏览上下文
describe('a11y 基线（role/aria-modal/焦点入出/aria-live）', () => {
  afterEach(() => {
    removeLightboxOverlay(document);
    document.body.innerHTML = '';
  });

  it('overlay role=dialog + aria-modal + tabindex=-1；开启焦点入 overlay，关闭还原触发元素；计数 aria-live', () => {
    // 触发元素带 tabindex（img/svg 默认不可聚焦，focus 还原仅对可聚焦触发元素生效）
    const host = document.createElement('div');
    host.innerHTML = '<img src="a.png" alt="A" tabindex="-1"><img src="b.png" alt="B">';
    document.body.appendChild(host);
    const trigger = host.querySelector('img')!;
    openLightbox(trigger, noCtx, collectGallery(host));
    const overlay = document.getElementById(LIGHTBOX_OVERLAY_ID)!;
    expect(overlay.getAttribute('role')).toBe('dialog');
    expect(overlay.getAttribute('aria-modal')).toBe('true');
    expect(overlay.getAttribute('tabindex')).toBe('-1');
    expect(document.activeElement).toBe(overlay); // 焦点入 overlay
    expect(overlay.querySelector('.md-lightbox-count')!.getAttribute('aria-live')).toBe('polite');
    removeLightboxOverlay(document);
    expect(document.activeElement).toBe(trigger); // 关闭还原到触发元素
  });
});
