import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Detection, FileSource, RenderedInstance, SearchMatch } from '@vviewer/core';
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

  it('属性二次清洗：href 上的 data:* 一律剥除（data: 仅放行 src/srcset，与共享策略同规则）', () => {
    const srcdoc = buildSandboxedSrcdoc(
      '<a href="data:image/svg+xml,x">bad</a><img src="data:image/png;base64,iVBOR" alt="ok"><a href="/ok.html">ok</a>'
    );
    const doc = parseSrcdoc(srcdoc);
    const links = doc.querySelectorAll('a');
    expect(links[0]?.hasAttribute('href')).toBe(false);
    expect(links[1]?.getAttribute('href')).toBe('/ok.html');
    expect(doc.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,iVBOR');
  });

  it('meta 标签显式禁用：作者 meta 不进 srcdoc，仅剩注入的 CSP meta', () => {
    const srcdoc = buildSandboxedSrcdoc(
      '<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=https://evil.example"></head><body><p>x</p></body></html>'
    );
    const doc = parseSrcdoc(srcdoc);
    const metas = doc.querySelectorAll('meta');
    expect(metas).toHaveLength(1); // 仅净化后注入的 CSP meta
    expect(metas[0]?.getAttribute('http-equiv')).toBe('Content-Security-Policy');
    expect(srcdoc).not.toContain('evil.example');
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

  it('>20MB：降级为源码视图 + 提示卡（无 iframe、无工具栏，切换为空操作）', async () => {
    stubResizeObserver();
    const big = new Uint8Array(20 * 1024 * 1024 + 1);
    const target = document.createElement('div');
    document.body.append(target);
    const instance = await htmlRenderer.render(big, target, SOURCE, DET);
    expect(target.querySelector('.vv-error-card')).not.toBeNull();
    expect(target.textContent).toContain('文件过大');
    expect(target.querySelector('iframe')).toBeNull(); // 不构建 srcdoc
    expect(target.querySelector('.vv-html-toolbar')).toBeNull(); // 无渲染视图可切
    expect(target.querySelector('.vv-code-pre')).not.toBeNull(); // 源码视图承接
    const toggle = instance as RenderedInstance & { toggleView(): void };
    toggle.toggleView();
    expect(target.querySelector('iframe')).toBeNull();
    instance.destroy();
    expect(target.innerHTML).toBe('');
    expect(target.classList.contains('vv-html')).toBe(false);
    expect(target.classList.contains('vv-degraded')).toBe(false);
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

describe('htmlRenderer——BUG-17 外域图片拦截 + CSP 收紧 / BUG-22 getEngine', () => {
  it('CSP 收紧：img-src/media-src 仅 data: blob:，不再放行 http: https:', () => {
    const srcdoc = buildSandboxedSrcdoc('<p>x</p>');
    expect(srcdoc).toContain('img-src data: blob:');
    expect(srcdoc).toContain('media-src data: blob:');
    expect(srcdoc).not.toContain('img-src data: blob: http:');
    expect(srcdoc).not.toContain('https:;');
  });

  it('外域 img：净化移除 src + 拦截标记 + title；srcdoc 内带占位行内样式（iframe 内 app.css 不作用）', () => {
    const srcdoc = buildSandboxedSrcdoc(
      '<p>ok</p><img src="http://external.example.com/track.png" alt="t"><img src="/local.png">'
    );
    const doc = parseSrcdoc(srcdoc);
    const blocked = doc.querySelector('img[data-vv-blocked-external]');
    expect(blocked).not.toBeNull();
    expect(blocked!.hasAttribute('src')).toBe(false);
    expect(blocked!.getAttribute('title')).toContain('已拦截外部图片：external.example.com');
    expect(blocked!.getAttribute('style')).toContain('border');
    expect(doc.querySelector('img[src="/local.png"]')).not.toBeNull(); // 相对图不受影响
  });

  it('getEngine 恒 local（BUG-22：渲染/源码两视图状态栏均出「渲染: 本地」段）', async () => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      }
    );
    const target = document.createElement('div');
    document.body.append(target);
    const instance = await htmlRenderer.render(new TextEncoder().encode('<p>hi</p>'), target, SOURCE, DET);
    const engine = (instance as RenderedInstance & { getEngine?(): 'local' }).getEngine;
    expect(typeof engine).toBe('function');
    expect(engine!.call(instance)).toBe('local');
    instance.destroy();
  });

  it('源码视图 search 透传 caseSensitive（BUG-23）', async () => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      }
    );
    const target = document.createElement('div');
    document.body.append(target);
    const instance = await htmlRenderer.render(
      new TextEncoder().encode('<p>Alpha alpha</p>'),
      target,
      SOURCE,
      DET
    );
    target.querySelector<HTMLButtonElement>('.vv-html-btn-source')!.click();
    const search = instance.search!.bind(instance) as (
      q: string,
      opts?: { caseSensitive?: boolean }
    ) => Promise<SearchMatch[]>;
    expect((await search('alpha')).length).toBe(2);
    // 源码视图搜索的是 HTML 源文本：'<p>Alpha alpha</p>' 中小写 'alpha' 起于偏移 9
    expect((await search('alpha', { caseSensitive: true })).map((m) => m.start)).toEqual([9]);
    instance.destroy();
  });
});
