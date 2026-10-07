import { describe, it, expect } from 'vitest';
import { sanitizeHtml } from '../src/markdown/sanitize';
import { enrichMarkdownDom } from '../src/markdown/enrich';
import { renderMarkdownToHtml } from '../src/markdown/engine';

function docOf(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

/** 引擎输出 → 净化 → 增强，返回增强后 DOM（贴近 Task 4 renderer 的真实顺序）。 */
function renderEnriched(md: string): Document {
  const { html } = renderMarkdownToHtml(md);
  const doc = docOf(sanitizeHtml(html));
  enrichMarkdownDom(doc);
  return doc;
}

describe('sanitizeHtml——净化策略', () => {
  it('script 标签剥除', () => {
    const out = sanitizeHtml('<p>ok</p><script>alert(1)</script>');
    expect(out).toContain('<p>ok</p>');
    expect(out).not.toContain('script');
    expect(out).not.toContain('alert');
  });

  it('style 标签禁用（FORBID_TAGS style）', () => {
    const out = sanitizeHtml('<style>.titlebar{display:none}</style><p>x</p>');
    expect(out).not.toContain('<style');
    expect(out).not.toContain('titlebar');
  });

  it('javascript: URI 剥除', () => {
    const out = sanitizeHtml('<a href="javascript:alert(1)">点我</a>');
    expect(out).toContain('点我');
    expect(out).not.toContain('javascript:');
  });

  it('on* 事件属性剥除', () => {
    const out = sanitizeHtml('<img src="a.png" onerror="alert(1)">');
    expect(out).toContain('a.png');
    expect(out).not.toContain('onerror');
  });

  it('iframe/object/embed 危险标签剥除', () => {
    const out = sanitizeHtml('<iframe src="https://evil.example"></iframe><object></object><p>x</p>');
    expect(out).not.toContain('iframe');
    expect(out).not.toContain('object');
  });

  it('data-* 属性保留（mermaid/katex 钩子依赖）', () => {
    const out = sanitizeHtml('<div data-mermaid="graph TD">x</div>');
    expect(out).toContain('data-mermaid="graph TD"');
  });

  it('URI 白名单：http/https/mailto/相对路径/data:image 保留', () => {
    const out = sanitizeHtml(
      [
        '<a href="https://a.example/b">1</a>',
        '<a href="http://a.example/b">2</a>',
        '<a href="mailto:a@b.example">3</a>',
        '<a href="./notes/other.md">4</a>',
        '<a href="#anchor">5</a>',
        '<img src="data:image/png;base64,iVBOR">',
      ].join(''),
    );
    expect(out).toContain('href="https://a.example/b"');
    expect(out).toContain('href="http://a.example/b"');
    expect(out).toContain('href="mailto:a@b.example"');
    expect(out).toContain('href="./notes/other.md"');
    expect(out).toContain('href="#anchor"');
    expect(out).toContain('data:image/png;base64');
  });

  it('白名单外 URI 剥除：data:text/html、vbscript:', () => {
    const out = sanitizeHtml('<a href="data:text/html;base64,PHNjcmlwdD4=">x</a><a href="vbscript:msgbox(1)">y</a>');
    expect(out).toContain('x');
    expect(out).not.toContain('data:text/html');
    expect(out).not.toContain('vbscript:');
  });

  it('data: 仅放行 src/srcset：a[href] 上的 data:image 剥除（导航至 SVG data URL 可执行脚本）', () => {
    const out = sanitizeHtml('<a href="data:image/svg+xml,%3Csvg onload=alert(1)%3E">x</a><a href="#d">y</a>');
    expect(out).toContain('y');
    expect(out).not.toContain('data:image');
    expect(out).not.toContain('href="data:');
  });

  it('data: 仅放行 src/srcset：img 的 src/srcset data:image 保留（内嵌图片）', () => {
    const out = sanitizeHtml(
      '<img src="data:image/png;base64,iVBOR" srcset="data:image/png;base64,iVBOR 2x" alt="嵌入图">'
    );
    expect(out).toContain('src="data:image/png;base64,iVBOR"');
    expect(out).toContain('srcset="data:image/png;base64,iVBOR 2x"');
  });

  it('data: 仅放行 src/srcset：action/formaction 等其余 URI 属性一并剥除', () => {
    const out = sanitizeHtml(
      '<form action="data:image/svg+xml,x"><button formaction="data:image/svg+xml,y">go</button></form>'
    );
    expect(out).not.toContain('action=');
    expect(out).not.toContain('formaction=');
  });

  it('meta 标签显式禁用（防 DOMPurify 上游默认变化）', () => {
    const out = sanitizeHtml(
      '<meta http-equiv="refresh" content="0;url=https://evil.example"><p>x</p>'
    );
    expect(out).not.toContain('<meta');
    expect(out).not.toContain('evil.example');
  });

  it('接受 Document 输入，返回净化字符串', () => {
    const doc = docOf('<p>a</p><script>b</script>');
    const out = sanitizeHtml(doc);
    expect(typeof out).toBe('string');
    expect(out).toContain('a');
    expect(out).not.toContain('b');
  });
});

describe('enrichMarkdownDom——callout 转换', () => {
  it('[!note] 块引用转为样式化卡片（标题 + 内容）', () => {
    const doc = renderEnriched('> [!note] 标题行\n> 内容段落\n');
    const card = doc.querySelector('.markdown-alert.markdown-alert-note');
    expect(card).not.toBeNull();
    expect(card!.querySelector('.markdown-alert-title')!.textContent).toContain('标题行');
    expect(card!.querySelector('.markdown-alert-content')!.textContent).toContain('内容段落');
    expect(doc.querySelector('blockquote')).toBeNull();
  });

  it('无标题 callout 用类型大写名作默认标题', () => {
    const doc = renderEnriched('> [!tip]\n> 提示内容\n');
    const title = doc.querySelector('.markdown-alert-tip .markdown-alert-title');
    expect(title!.textContent).toBe('Tip');
  });

  it('已知类型 ≥6 个各自带类型类', () => {
    for (const type of ['note', 'tip', 'warning', 'caution', 'important', 'info', 'example']) {
      const doc = renderEnriched(`> [!${type}] t\n> c\n`);
      expect(doc.querySelector(`.markdown-alert-${type}`), type).not.toBeNull();
    }
  });

  it('未知类型用默认样式类仍转卡片', () => {
    const doc = renderEnriched('> [!custom-kind] t\n> c\n');
    expect(doc.querySelector('.markdown-alert.markdown-alert-custom-kind')).not.toBeNull();
  });

  it('普通块引用不受影响', () => {
    const doc = renderEnriched('> 普通引用\n');
    expect(doc.querySelector('blockquote')).not.toBeNull();
    expect(doc.querySelector('.markdown-alert')).toBeNull();
  });

  it('嵌套引用：内层 [!note] 转换为卡片，外层不触发保持块引用', () => {
    const doc = renderEnriched('> > [!note]\n> > 嵌套\n');
    // 外层首子元素是 blockquote 而非段落 → 外层不转换；内层按规则转卡片
    const outer = doc.querySelector('blockquote');
    expect(outer).not.toBeNull();
    expect(doc.querySelectorAll('blockquote')).toHaveLength(1); // 仅剩外层
    const card = doc.querySelector('.markdown-alert.markdown-alert-note');
    expect(card).not.toBeNull();
    expect(outer!.contains(card!)).toBe(true); // 卡片留在外层引用内
    expect(card!.querySelector('.markdown-alert-title')!.textContent).toBe('Note');
  });
});

describe('enrichMarkdownDom——媒体链接转换', () => {
  it('img 指向 .mp4 转 video 占位（controls）', () => {
    const doc = renderEnriched('![演示](movie.mp4)\n');
    const video = doc.querySelector('video');
    expect(video).not.toBeNull();
    expect(video!.getAttribute('src')).toBe('movie.mp4');
    expect(video!.hasAttribute('controls')).toBe(true);
    expect(doc.querySelector('img')).toBeNull();
  });

  it('img 指向 .webm/.ogg 同样转 video', () => {
    for (const ext of ['webm', 'ogg']) {
      const doc = renderEnriched(`![v](a.${ext})\n`);
      expect(doc.querySelector('video'), ext).not.toBeNull();
    }
  });

  it('a 链接指向音频扩展名转 audio 占位', () => {
    for (const ext of ['mp3', 'wav', 'flac', 'm4a']) {
      const doc = renderEnriched(`[听](song.${ext})\n`);
      const audio = doc.querySelector('audio');
      expect(audio, ext).not.toBeNull();
      expect(audio!.getAttribute('src')).toBe(`song.${ext}`);
      expect(audio!.hasAttribute('controls')).toBe(true);
    }
  });

  it('带查询串/锚点的媒体地址仍识别', () => {
    const doc = renderEnriched('[听](song.mp3?t=1#x)\n');
    expect(doc.querySelector('audio')).not.toBeNull();
  });

  it('普通图片与普通链接不受影响', () => {
    const doc = renderEnriched('![图](photo.png) [文](page.md)\n');
    expect(doc.querySelector('img')).not.toBeNull();
    expect(doc.querySelector('a')).not.toBeNull();
    expect(doc.querySelector('video')).toBeNull();
    expect(doc.querySelector('audio')).toBeNull();
  });

  it('转出的媒体元素保留 alt 语义（aria-label）', () => {
    const doc = renderEnriched('![演示视频](movie.mp4)\n');
    const video = doc.querySelector('video')!;
    expect(video.getAttribute('aria-label')).toBe('演示视频');
  });
});
