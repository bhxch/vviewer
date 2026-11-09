// code 自动换行（settings.code.wordWrap / 状态栏开关）：opts.wordWrap 为真时行在正文列内
// 折行（.vv-code-wrap）、虚拟滚动改可变行高（core variableScroller，按每行字符/字节数
// 粗估折行数、渲染后实测修正）；setWordWrap 原地切换且保持首可视行。全量与窗口两路径。
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Detection, FileSource, StreamCtx, TreeStore } from '@bhxch/vviewer-core';
import { codeRenderer, renderCode, renderDegradedCode } from '../src/code';
import { htmlRenderer } from '../src/html';
import { createDiagramFileRenderers } from '../src/diagramFile';
import { setDiagramOptions } from '@bhxch/vviewer-markdown';

function stubResizeObserver(): void {
  vi.stubGlobal('ResizeObserver', class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

// jsdom 无布局：列数测量回落 80 列，行高估算 = 20 × ceil(字符数/80)
const LONG = 'x'.repeat(200); // ceil(200/80)=3 视觉行
const TEXT = [LONG, 'short', LONG, 'tail'].join('\n');

function mountHost(): HTMLElement {
  const host = document.createElement('div');
  document.body.append(host);
  return host;
}

describe('renderCode opts.wordWrap（全量路径）', () => {
  it('换行：pre 带 vv-code-wrap、行不写固定高度、spacer 按折行估算总高', () => {
    stubResizeObserver();
    const host = mountHost();
    const inst = renderCode(new TextEncoder().encode(TEXT), host, { highlight: false, wordWrap: true });
    const pre = host.querySelector<HTMLElement>('.vv-code-pre')!;
    expect(pre.classList.contains('vv-code-wrap')).toBe(true);
    expect(host.querySelector<HTMLElement>('.vv-code-line')!.style.height).toBe('');
    expect(host.querySelector<HTMLElement>('.vv-virtual-spacer')!.style.height).toBe(`${(3 + 1 + 3 + 1) * 20}px`);
    inst.destroy();
  });

  it('缺省不换行：现状形态逐字保持（固定行高 + 无 vv-code-wrap）', () => {
    stubResizeObserver();
    const host = mountHost();
    const inst = renderCode(new TextEncoder().encode(TEXT), host, { highlight: false });
    const pre = host.querySelector<HTMLElement>('.vv-code-pre')!;
    expect(pre.classList.contains('vv-code-wrap')).toBe(false);
    expect(host.querySelector<HTMLElement>('.vv-code-line')!.style.height).toBe('20px');
    expect(host.querySelector<HTMLElement>('.vv-virtual-spacer')!.style.height).toBe(`${4 * 20}px`);
    inst.destroy();
  });

  it('revealLine 在换行模式按折行前缀定位（行 2 之前：3+1 视觉行）', () => {
    stubResizeObserver();
    const host = mountHost();
    const inst = renderCode(new TextEncoder().encode(TEXT), host, { highlight: false, wordWrap: true });
    inst.revealLine(2); // jsdom clientHeight=0 → center = offsetOf(2) + heightOf(2)/2 = 80 + 30
    expect(host.querySelector<HTMLElement>('.vv-code-pre')!.scrollTop).toBe(110);
    inst.destroy();
  });

  it('setWordWrap 原地切换：类名/滚动器模式互换，首可视行保持', () => {
    stubResizeObserver();
    const host = mountHost();
    const many = Array.from({ length: 100 }, (_, i) => (i % 2 === 0 ? LONG : `l${i}`)).join('\n');
    const inst = renderCode(new TextEncoder().encode(many), host, { highlight: false });
    const pre = host.querySelector<HTMLElement>('.vv-code-pre')!;
    pre.scrollTop = 40 * 20; // 不换行：首可视行 40
    pre.dispatchEvent(new Event('scroll'));
    expect(inst.firstVisibleLine?.()).toBe(40);
    inst.setWordWrap!(true);
    expect(pre.classList.contains('vv-code-wrap')).toBe(true);
    expect(inst.firstVisibleLine?.()).toBe(40);
    // 换行域前缀：行 0..39 中 20 条长行×3 + 20 条短行×1 = 80 视觉行
    expect(pre.scrollTop).toBe(80 * 20);
    inst.setWordWrap!(false);
    expect(pre.classList.contains('vv-code-wrap')).toBe(false);
    expect(inst.firstVisibleLine?.()).toBe(40);
    expect(pre.scrollTop).toBe(40 * 20);
    inst.destroy();
  });
});

describe('renderCode opts.wordWrap（窗口流式路径）', () => {
  it('换行：按索引行字节长估算折行，setWordWrap 往返切换', async () => {
    stubResizeObserver();
    const lines = Array.from({ length: 300 }, (_, i) => (i % 3 === 0 ? 'y'.repeat(170) : `{"i":${i}}`));
    const full = new TextEncoder().encode(lines.join('\n'));
    const ctx: StreamCtx = { size: null, head: full.slice(0, 8192), read: async (r) => full.slice(r.start, r.end + 1) };
    const host = mountHost();
    const inst = renderCode(full.slice(0, 8192), host, { ctx, highlight: false, wordWrap: true });
    try {
      await vi.waitFor(() => expect(inst.getMeta().lines).toBe(300));
      const pre = host.querySelector<HTMLElement>('.vv-code-pre')!;
      expect(pre.classList.contains('vv-code-wrap')).toBe(true);
      // 100 条长行（170 字节 → ceil(170/80)=3 视觉行）+ 200 条短行
      await vi.waitFor(() =>
        expect(host.querySelector<HTMLElement>('.vv-virtual-spacer')!.style.height).toBe(`${(100 * 3 + 200) * 20}px`)
      );
      inst.setWordWrap!(false);
      expect(pre.classList.contains('vv-code-wrap')).toBe(false);
      expect(host.querySelector<HTMLElement>('.vv-virtual-spacer')!.style.height).toBe(`${300 * 20}px`);
    } finally {
      inst.destroy();
    }
  });
});

describe('codeRenderer 透传 opts.wordWrap 与 setWordWrap', () => {
  it('render 第 6 参 wordWrap 生效；实例恒暴露 setWordWrap（状态栏开关的鸭子探测面）', async () => {
    stubResizeObserver();
    const host = mountHost();
    const source: FileSource = { storeId: 's', storeLabel: 's', path: 'a.txt', name: 'a.txt', store: {} as TreeStore };
    const det = { ext: 'txt', encoding: 'utf-8' } as Detection;
    const inst = await codeRenderer.render(new TextEncoder().encode(TEXT), host, source, det, undefined, { wordWrap: true });
    expect(host.querySelector('.vv-code-pre')!.classList.contains('vv-code-wrap')).toBe(true);
    expect(typeof (inst as { setWordWrap?: unknown }).setWordWrap).toBe('function');
    (inst as unknown as { setWordWrap(on: boolean): void }).setWordWrap(false);
    expect(host.querySelector('.vv-code-pre')!.classList.contains('vv-code-wrap')).toBe(false);
    inst.destroy();
  });
});

describe('复用代码视图的源码面同样遵循换行设置', () => {
  const src = (name: string): FileSource => ({ storeId: 's', storeLabel: 's', path: name, name, store: {} as TreeStore });
  type Toggleable = { toggleView(): void; setWordWrap(on: boolean): void; destroy(): void };
  const wrapped = (host: HTMLElement): boolean => host.querySelector('.vv-code-pre')!.classList.contains('vv-code-wrap');

  it('HTML 源码视图：按 opts.wordWrap 换行；setWordWrap 即时切换，渲染视图下切换后再切源码亦生效', async () => {
    stubResizeObserver();
    const host = mountHost();
    const html = new TextEncoder().encode(`<p>${'x'.repeat(300)}</p>`);
    const det = { ext: 'html', encoding: 'utf-8' } as Detection;
    const inst = (await htmlRenderer.render(html, host, src('a.html'), det, undefined, { wordWrap: true })) as unknown as Toggleable;
    inst.toggleView(); // → 源码
    expect(wrapped(host)).toBe(true);
    inst.setWordWrap(false);
    expect(wrapped(host)).toBe(false);
    inst.toggleView(); // → 渲染
    inst.setWordWrap(true);
    inst.toggleView(); // → 源码：按最新设置重挂
    expect(wrapped(host)).toBe(true);
    inst.destroy();
  });

  it('超大降级源码视图（renderDegradedCode）：opts.wordWrap 透传', () => {
    stubResizeObserver();
    const host = mountHost();
    const code = renderDegradedCode(new TextEncoder().encode(TEXT), host, { name: 'big.html', mode: '源码', wordWrap: true });
    expect(wrapped(host)).toBe(true);
    code.setWordWrap?.(false);
    expect(wrapped(host)).toBe(false);
    code.destroy();
  });

  it('图表文件源码模式：按 opts.wordWrap 换行并可 setWordWrap 切换', async () => {
    stubResizeObserver();
    setDiagramOptions(() => ({ krokiHost: 'https://kroki.example', modeOf: () => 'source' }) as never);
    try {
      const host = mountHost();
      const r = createDiagramFileRenderers({}).find((x) => x.id === 'diagram-mermaid')!;
      const det = { ext: 'mmd', encoding: 'utf-8' } as Detection;
      const inst = (await r.render(new TextEncoder().encode(`graph TD\n  A-->${'B'.repeat(300)}`), host, src('a.mmd'), det, undefined, {
        wordWrap: true
      })) as unknown as Toggleable;
      expect(wrapped(host)).toBe(true);
      inst.setWordWrap(false);
      expect(wrapped(host)).toBe(false);
      inst.destroy();
    } finally {
      setDiagramOptions(() => null as never);
    }
  });
});

