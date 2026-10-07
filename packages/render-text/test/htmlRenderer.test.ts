import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Detection, FileSource, RenderedInstance } from '@vviewer/core';
import { htmlRenderer, buildSandboxedSrcdoc } from '../src/html';

const SOURCE: FileSource = {
  storeId: 's',
  storeLabel: '样本',
  path: 'page.html',
  name: 'page.html',
  store: {
    id: 's',
    displayName: () => '样本',
    listChildren: async () => [],
    read: async () => new Uint8Array()
  }
};

const DET: Detection = { ext: 'html', encoding: 'utf-8' };

function parseSrcdoc(srcdoc: string): Document {
  return new DOMParser().parseFromString(srcdoc, 'text/html');
}

describe('buildSandboxedSrcdoc——双层防御', () => {
  it('script 元素与其内容整体剥除（DOMPurify WHOLE_DOCUMENT）', () => {
    const srcdoc = buildSandboxedSrcdoc(
      '<!DOCTYPE html><html><head><title>t</title></head><body><p>ok</p><script>alert(1)</script></body></html>'
    );
    const doc = parseSrcdoc(srcdoc);
    expect(doc.querySelector('script')).toBeNull();
    expect(srcdoc).not.toContain('alert');
    expect(doc.querySelector('p')?.textContent).toBe('ok');
  });

  it('style 标签沿用共享净化策略（FORBID_TAGS style）', () => {
    const srcdoc = buildSandboxedSrcdoc('<style>body{display:none}</style><p>x</p>');
    expect(srcdoc).not.toContain('<style');
    expect(srcdoc).not.toContain('display:none');
  });

  it('属性二次清洗：on* 全剥，src/href 白名单校验', () => {
    const srcdoc = buildSandboxedSrcdoc(
      '<img src="ok.png" onclick="alert(1)" onerror="x()"><a href="javascript:alert(1)">bad</a><a href="/rel.html">rel</a>'
    );
    const doc = parseSrcdoc(srcdoc);
    const img = doc.querySelector('img');
    expect(img?.hasAttribute('onclick')).toBe(false);
    expect(img?.hasAttribute('onerror')).toBe(false);
    expect(img?.getAttribute('src')).toBe('ok.png');
    const links = doc.querySelectorAll('a');
    expect(links[0]?.hasAttribute('href')).toBe(false);
    expect(links[1]?.getAttribute('href')).toBe('/rel.html');
  });

  it('CSP meta 注入（注入于净化之后，必然存活）', () => {
    const srcdoc = buildSandboxedSrcdoc('<p>x</p>');
    expect(srcdoc).toContain('http-equiv="Content-Security-Policy"');
    expect(srcdoc).toContain("default-src 'none'");
  });
});

describe('htmlRenderer——sandbox iframe 与视图切换', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  /** jsdom 无 ResizeObserver，源码视图的 virtualScroller 需要（照 code.test.ts 的 stub） */
  function stubResizeObserver(): void {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      }
    );
  }

  async function renderHtml(html: string): Promise<{ target: HTMLElement; instance: RenderedInstance }> {
    stubResizeObserver();
    const target = document.createElement('div');
    document.body.append(target);
    const instance = await htmlRenderer.render(new TextEncoder().encode(html), target, SOURCE, DET);
    return { target, instance };
  }

  it('默认渲染视图：iframe sandbox 只含 allow-same-origin（无 allow-scripts），srcdoc 为净化产物', async () => {
    const { target } = await renderHtml('<p>hi</p><script>alert(1)</script>');
    const frame = target.querySelector('iframe');
    expect(frame).not.toBeNull();
    // 裁决：sandbox="allow-same-origin"（父页面可读 contentDocument 断言脚本未执行）；
    // 不含 allow-scripts → 文档内脚本一律不执行
    expect(frame!.getAttribute('sandbox')).toBe('allow-same-origin');
    expect(frame!.getAttribute('sandbox')!.split(/\s+/)).not.toContain('allow-scripts');
    const srcdoc = frame!.getAttribute('srcdoc') ?? '';
    expect(srcdoc).toContain('hi');
    expect(srcdoc).not.toContain('<script');
  });

  it('视图切换：源码视图复用 renderCode（.vv-code-pre），切回渲染视图 iframe 复位', async () => {
    const { target, instance } = await renderHtml('<p>hi</p>');
    const sourceBtn = target.querySelector<HTMLButtonElement>('.vv-html-btn-source');
    const renderedBtn = target.querySelector<HTMLButtonElement>('.vv-html-btn-rendered');
    expect(sourceBtn).not.toBeNull();
    expect(renderedBtn).not.toBeNull();

    sourceBtn!.click();
    expect(target.querySelector('iframe')).toBeNull();
    expect(target.querySelector('.vv-code-pre')).not.toBeNull();

    renderedBtn!.click();
    expect(target.querySelector('iframe')).not.toBeNull();
    expect(target.querySelector('.vv-code-pre')).toBeNull();

    // 实例方法同通道（键盘/外部触发预留；toggleView 为 html 实例专属，core 类型不含）
    const toggle = instance as RenderedInstance & { toggleView(): void };
    toggle.toggleView();
    expect(target.querySelector('iframe')).toBeNull();
    expect(target.querySelector('.vv-code-pre')).not.toBeNull();
    toggle.toggleView();
    expect(target.querySelector('iframe')).not.toBeNull();
  });

  it('destroy 清空宿主', async () => {
    const { target, instance } = await renderHtml('<p>hi</p>');
    instance.destroy();
    expect(target.innerHTML).toBe('');
  });

  it('search/gotoMatch：源码视图继承 code 实现，渲染视图返回空结果', async () => {
    const { target, instance } = await renderHtml('<p>hi</p>');
    // 渲染视图：沙箱 iframe 不做跨文档搜索
    await expect(instance.search!('hi')).resolves.toEqual([]);
    const sourceBtn = target.querySelector<HTMLButtonElement>('.vv-html-btn-source')!;
    sourceBtn.click();
    const matches = await instance.search!('hi');
    expect(matches.map((m) => m.line)).toEqual([0]); // 源码视图 = code 行扫描
    instance.gotoMatch!(0);
    expect(target.querySelector('[data-line="0"]')?.classList.contains('vv-search-hit-line')).toBe(true);
    instance.destroy();
  });
});
