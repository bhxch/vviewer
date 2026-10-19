// export.test.ts — 导出装配纯函数集（md-export Task 1）：collectExportHtml /
// collectPrintHtml / markdownRenderer 实例句柄 getExportDocument。
// 夹具为管线成品形态的手工 DOM（高亮 code/katex/图表 wrapper/交互壳/blob 图/
// 外域图/data 图/音视频/多级标题），断言剥壳、data URI 化、媒体降级、TOC 结构、
// 样式注入与打印模板；不重跑五步管线（管线自身行为由 pipeline*.test 覆盖）。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { attachHighlightClient, MARKUP_MAX_BYTES } from '../code';
import { markdownRenderer } from './markdownRenderer';
import { collectExportHtml, collectPrintHtml } from './export';

/** 管线成品形态的富文档夹具：交互壳（复制钮/切换钮/源码面板）、图表两种形态
 * （有图可看的 toggle wrapper / source-only wrapper）、三类图片、音视频、四级标题。 */
const RICH_HTML = `<div class="vv-markdown">
<h1 id="user-content-top">总览</h1>
<h2 id="user-content-sub">用法</h2>
<h3 id="user-content-advanced">进阶</h3>
<h4 id="user-content-notes">附注</h4>
<p>公式 <span class="katex"><span class="katex-mathml">E=mc^2</span></span> 行内。</p>
<pre data-md-copy=""><span class="md-code-bar"><span class="md-code-lang">ts</span><button type="button" class="md-copy-btn">复制</button></span><code class="language-ts"><span class="ts-keyword">const</span> x = 1;</code></pre>
<div class="md-diagram" id="diagram-with-view"><div class="md-diagram-bar"><span class="md-diagram-lang">mermaid</span><button type="button" class="md-diagram-toggle">源码</button></div><div class="md-diagram-view" data-mermaid="graph TD; A--&gt;B"><svg id="mermaid-svg"><circle r="4"></circle></svg></div><div class="md-diagram-source" hidden=""><code>graph TD; A--&gt;B</code></div></div>
<div class="md-diagram" id="diagram-source-only"><div class="md-diagram-bar"><span class="md-diagram-lang">plantuml</span></div><div class="md-diagram-view" hidden=""></div><div class="md-diagram-source"><code>@startuml</code></div></div>
<img id="blob-img" src="blob:https://vviewer.test/abc" alt="blob">
<img id="ext-img" src="https://example.com/x.png" alt="ext">
<img id="data-img" src="data:image/gif;base64,R0=" alt="data">
<video controls="" src="blob:https://vviewer.test/v.mp4"></video>
<audio controls="" src="https://cdn.example.com/a.mp3" aria-label="讲解录音"></audio>
</div>`;

function richDoc(): Document {
  return new DOMParser().parseFromString(RICH_HTML, 'text/html');
}

/** 图片解析桩（md-export 契约：blob: → data URI；外域/data: 返回 null 保留原 URL） */
async function resolveImageStub(src: string): Promise<string | null> {
  return src.startsWith('blob:') ? 'data:image/png;base64,QUE=' : null;
}

describe('collectExportHtml——自包含 HTML 装配', () => {
  it('交互壳剥离：复制钮/切换钮移除，正文与高亮 code 保留；有图 wrapper 源码面板剥离、source-only wrapper 源码面板保留', async () => {
    const html = await collectExportHtml(richDoc(), {
      title: '演示',
      styleCss: '',
      resolveImage: resolveImageStub
    });
    const out = new DOMParser().parseFromString(html, 'text/html');
    expect(out.querySelector('.md-copy-btn')).toBeNull();
    expect(out.querySelector('.md-diagram-toggle')).toBeNull();
    expect(out.querySelector('.md-lightbox-overlay')).toBeNull();
    // 正文与高亮成品不动
    expect(out.querySelector('pre code .ts-keyword')?.textContent).toBe('const');
    expect(out.querySelector('#mermaid-svg')).not.toBeNull();
    expect(out.querySelector('.katex-mathml')).not.toBeNull();
    // 有图可看的 wrapper：源码面板是切换备胎 → 剥离
    expect(out.querySelector('#diagram-with-view .md-diagram-source')).toBeNull();
    // source-only wrapper（视图隐藏）：源码面板是唯一展示 → 保留
    expect(out.querySelector('#diagram-source-only .md-diagram-source')).not.toBeNull();
  });

  it('图片 data URI 化：blob 图走 resolveImage 换 data URI；外域图/data 图原样保留', async () => {
    const html = await collectExportHtml(richDoc(), {
      title: '演示',
      styleCss: '',
      resolveImage: resolveImageStub
    });
    const out = new DOMParser().parseFromString(html, 'text/html');
    expect(out.querySelector<HTMLImageElement>('#blob-img')?.src).toBe('data:image/png;base64,QUE=');
    expect(out.querySelector<HTMLImageElement>('#ext-img')?.getAttribute('src')).toBe('https://example.com/x.png');
    expect(out.querySelector<HTMLImageElement>('#data-img')?.getAttribute('src')).toBe('data:image/gif;base64,R0=');
  });

  it('resolveImage 抛错视同失败：保留原 URL 不中断装配', async () => {
    const html = await collectExportHtml(richDoc(), {
      title: '演示',
      styleCss: '',
      resolveImage: async (src) => {
        if (src.startsWith('blob:')) throw new Error('网络失败');
        return null;
      }
    });
    const out = new DOMParser().parseFromString(html, 'text/html');
    expect(out.querySelector<HTMLImageElement>('#blob-img')?.getAttribute('src')).toBe('blob:https://vviewer.test/abc');
  });

  it('音视频占位降级为源地址超链接：video/audio 元素不进导出产物', async () => {
    const html = await collectExportHtml(richDoc(), {
      title: '演示',
      styleCss: '',
      resolveImage: resolveImageStub
    });
    const out = new DOMParser().parseFromString(html, 'text/html');
    expect(out.querySelector('video')).toBeNull();
    expect(out.querySelector('audio')).toBeNull();
    const videoLink = out.querySelector<HTMLAnchorElement>('a[href="blob:https://vviewer.test/v.mp4"]');
    expect(videoLink).not.toBeNull();
    const audioLink = out.querySelector<HTMLAnchorElement>('a[href="https://cdn.example.com/a.mp3"]');
    expect(audioLink?.textContent).toBe('讲解录音'); // aria-label 优先作为链接文本
  });

  it('静态 TOC：nav 锚列表按文档序覆盖 h1-h4，href 与 heading 最终 id 一致，无滚动跟踪脚本', async () => {
    const html = await collectExportHtml(richDoc(), {
      title: '演示',
      styleCss: '',
      resolveImage: resolveImageStub
    });
    const out = new DOMParser().parseFromString(html, 'text/html');
    const nav = out.querySelector('nav.vv-export-toc');
    expect(nav).not.toBeNull();
    const links = Array.from(nav!.querySelectorAll('a'));
    expect(links.map((a) => [a.getAttribute('href'), a.textContent])).toEqual([
      ['#user-content-top', '总览'],
      ['#user-content-sub', '用法'],
      ['#user-content-advanced', '进阶'],
      ['#user-content-notes', '附注']
    ]);
    for (const a of links) {
      expect(out.getElementById((a.getAttribute('href') ?? '').slice(1))).not.toBeNull();
    }
    expect(out.querySelector('script')).toBeNull();
    expect(html).not.toContain('<script');
  });

  it('标题/字符集/样式注入：title 落 head，styleCss 进入 <style>，产物为完整 HTML 文档', async () => {
    const html = await collectExportHtml(richDoc(), {
      title: '演示文档',
      styleCss: '.vv-markdown { color: #123; }',
      resolveImage: resolveImageStub
    });
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    const out = new DOMParser().parseFromString(html, 'text/html');
    expect(out.title).toBe('演示文档');
    expect(out.querySelector('meta[charset]')).not.toBeNull();
    const style = out.querySelector('head style');
    expect(style?.textContent).toContain('.vv-markdown { color: #123; }');
    expect(out.querySelector('.vv-markdown')).not.toBeNull();
  });

  it('</style 转义防护：styleCss 中的闭合标签不逃逸出 style 块', async () => {
    const html = await collectExportHtml(richDoc(), {
      title: '演示',
      styleCss: 'a{color:red}</style><script>window.__pwned=1</script>',
      resolveImage: resolveImageStub
    });
    expect(html).not.toContain('</style><script>');
    const out = new DOMParser().parseFromString(html, 'text/html');
    expect(out.querySelector('script')).toBeNull();
    // 恶意片段以惰性文本留在 style 块内（style 块未被提前截断），不成为脚本元素
    const css = out.querySelector('head style')?.textContent ?? '';
    expect(css).toContain('<script>window.__pwned=1</script>');
    expect(out.body.querySelector('.vv-markdown')).not.toBeNull();
  });
});

describe('collectPrintHtml——打印模板', () => {
  it('@page 尺寸映射：a4/a3/letter/legal 各生成对应 page size', () => {
    for (const [page, size] of [
      ['a4', 'A4 portrait'],
      ['a3', 'A3 portrait'],
      ['letter', 'letter portrait'],
      ['legal', 'legal portrait']
    ] as const) {
      const html = collectPrintHtml('<!DOCTYPE html><html><body><p>x</p></body></html>', { page });
      expect(html).toContain(`data-vv-page="${page}"`);
      expect(html).toContain(`size: ${size}`);
    }
  });

  it('dynamic 页型：带待回写标记，由触发壳 onload 后按内容高度注入精确页高', () => {
    const html = collectPrintHtml('<!DOCTYPE html><html><body><p>x</p></body></html>', { page: 'dynamic' });
    expect(html).toContain('data-vv-page="dynamic"');
    expect(html).toContain('vv-dynamic-page');
  });

  it('分页保护：PRE/TABLE/FIGURE/SVG break-inside:avoid 与大图 95% 页高上限存在于 @media print', () => {
    const html = collectPrintHtml('<!DOCTYPE html><html><body><p>x</p></body></html>', { page: 'a4' });
    const out = new DOMParser().parseFromString(html, 'text/html');
    const css = out.querySelector('style[data-vv-page]')?.textContent ?? '';
    expect(css).toContain('@media print');
    expect(css).toMatch(/break-inside:\s*avoid/);
    expect(css).toMatch(/\bpre\b/);
    expect(css).toMatch(/\btable\b/);
    expect(css).toMatch(/\bfigure\b/);
    expect(css).toMatch(/\bsvg\b/);
    expect(css).toMatch(/max-height:\s*95/);
    // 原文档内容保留
    expect(out.body.textContent).toContain('x');
  });
});

describe('markdownRenderer 实例句柄 getExportDocument', () => {
  const SOURCE = {
    storeId: 's',
    storeLabel: '样本',
    path: 'demo.md',
    name: 'demo.md',
    store: {
      id: 's',
      displayName: () => '样本',
      listChildren: async () => [],
      read: async () => new Uint8Array()
    }
  };
  const DET = { ext: 'md', encoding: 'utf-8' as const };

  beforeEach(() => {
    // 失败终态：waitForAttachedClient 即刻返回 null，围栏走 hljs 兜底（本文件夹具无围栏，不触发）
    attachHighlightClient(null);
  });

  it('返回挂载后 DOM 的独立克隆（body 含 .vv-markdown 包装）；改克隆不影响主文档', async () => {
    const target = document.createElement('div');
    const instance = await markdownRenderer.render(
      new TextEncoder().encode('# 标题一\n\n正文段落。\n'),
      target,
      SOURCE,
      DET
    );
    const read = 'getExportDocument' in instance
      ? (instance as { getExportDocument(): Document | null }).getExportDocument
      : null;
    expect(typeof read).toBe('function');
    const doc = read!();
    expect(doc).not.toBeNull();
    const wrap = doc!.body.querySelector('.vv-markdown');
    expect(wrap).not.toBeNull();
    expect(wrap!.querySelector('h1')?.textContent).toBe('标题一');
    // 独立文档：装配就地改写不回写主文档
    wrap!.querySelector('h1')?.remove();
    expect(target.querySelector('h1')).not.toBeNull();
    instance.destroy();
  });

  it('实例销毁后返回 null（快照随实例生命周期）', async () => {
    const target = document.createElement('div');
    const instance = await markdownRenderer.render(
      new TextEncoder().encode('# 标题一\n'),
      target,
      SOURCE,
      DET
    );
    instance.destroy();
    const read = (instance as { getExportDocument?(): Document | null }).getExportDocument;
    expect(read?.call(instance)).toBeNull();
  });

  it('超大文件降级实例无导出句柄（探测为 false，触发壳不显示导出钮）', async () => {
    // jsdom 无 ResizeObserver，降级路径的 virtualScroller 需要（markdownRenderer.test 同款 stub）
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      }
    );
    const target = document.createElement('div');
    const instance = await markdownRenderer.render(
      new Uint8Array(MARKUP_MAX_BYTES + 1),
      target,
      SOURCE,
      DET
    );
    expect('getExportDocument' in instance).toBe(false);
    instance.destroy();
  });
});
