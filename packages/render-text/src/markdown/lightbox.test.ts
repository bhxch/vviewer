// lightbox.test.ts — 灯箱模块单测：缩放/平移/导航状态机纯函数直测 + jsdom DOM
// 交互（打开/关闭语义、画廊导航、键盘集、归属代币、主题前缀）。
import { describe, expect, it } from 'vitest';
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

  it('Esc 关闭后 document 级键盘监听随之摘除（重建不累积）', () => {
    const doc = docOf('<img src="a.png" alt="A">');
    const press = (key: string): void => { doc.dispatchEvent(new KeyboardEvent('keydown', { key })); };
    for (let round = 0; round < 2; round += 1) {
      openLightbox(doc.querySelector('img')!, noCtx, collectGallery(doc.body));
      press('ArrowRight');
      expect(overlayOf(doc)!.querySelector('.md-lightbox-count')!.textContent).toBe('1/1');
      press('Escape');
      expect(overlayOf(doc)).toBeNull();
    }
  });
});
