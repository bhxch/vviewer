// enrichExternalMedia.test.ts — spec D §3.1 manual 档外链媒体占位构建（enrich 承接面）。
// jsdom 直测 enrichMarkdownDom：输入=手工构造含 sanitize data-vv-external-src 标记的
// img 的 doc（sanitize 分流面在 vviewer-sanitize 包三档矩阵已测，本文件只测 enrich
// 的占位构建/按钮文案三分支/点击回填/AV 替换/会话免确认/幂等代币/无标记不构建）。
import { beforeEach, describe, expect, it } from 'vitest';
import { EXT_MEDIA_CSS, MARKDOWN_CSS } from '../src/css';
import { enrichMarkdownDom, __resetExternalMediaSessionForTest } from '../src/enrich';

function docOf(html: string): Document {
  const doc = document.implementation.createHTMLDocument('');
  doc.body.innerHTML = html;
  return doc;
}

const EXT = 'https://external.example.com/pic.png';

describe('enrichMarkdownDom——manual 档外链媒体占位构建（spec D §3.1）', () => {
  beforeEach(() => {
    __resetExternalMediaSessionForTest(); // 会话免确认 Set 装置隔离
  });

  it('①构建 wrapper（span.md-ext-media）+加载按钮 + img 收进 wrapper（CSS 隐藏不发请求）', () => {
    const doc = docOf(`<img data-vv-external-src="${EXT}" data-vv-blocked-external="1" title="已拦截外部图片：external.example.com" alt="x">`);
    enrichMarkdownDom(doc);
    const wrap = doc.querySelector('span.md-ext-media')!;
    expect(wrap).not.toBeNull();
    const img = doc.querySelector('img')!;
    expect(wrap.contains(img)).toBe(true);
    const btn = wrap.querySelector('button.md-ext-media-load')!;
    expect(btn.textContent).toBe('加载图片');
    expect(btn.getAttribute('type')).toBe('button');
    expect(btn.getAttribute('aria-label')).toBe('加载图片：external.example.com'); // aria=文案+域名
    expect(wrap.getAttribute('title')).toBe('已拦截外部图片：external.example.com'); // wrapper 继承 img 域名 title
    // img 保留标记（未点击前不回填）
    expect(img.getAttribute('data-vv-external-src')).toBe(EXT);
    expect(img.hasAttribute('src')).toBe(false);
    // CSS 承担 img 隐藏（BUG-17 防线的视觉面）
    expect(EXT_MEDIA_CSS).toContain('.vv-markdown .md-ext-media img { display: none; }');
    expect(MARKDOWN_CSS).toContain(EXT_MEDIA_CSS);
  });

  it('②按钮文案按扩展名分流：.mp4→加载视频 / .mp3→加载音频 / .png→加载图片（含 query 形态）', () => {
    const doc = docOf(
      `<img data-vv-external-src="https://e.example/clip.mp4">` +
        `<img data-vv-external-src="https://e.example/a.mp3">` +
        `<img data-vv-external-src="https://e.example/p.png?v=1">`,
    );
    enrichMarkdownDom(doc);
    const buttons = Array.from(doc.querySelectorAll('button.md-ext-media-load'));
    expect(buttons.map((b) => b.textContent)).toEqual(['加载视频', '加载音频', '加载图片']);
  });

  it('③点击 img 分支：src 回填 + srcset 回填 + data-vv-external-src/srcset/blocked-external/md-ext-media 四标记移除 + wrapper 解包', () => {
    const doc = docOf(`<img data-vv-external-src="${EXT}" data-vv-external-srcset="${EXT} 1x" data-vv-blocked-external="1" alt="x">`);
    enrichMarkdownDom(doc);
    const wrap = doc.querySelector('span.md-ext-media')!;
    wrap.querySelector('button.md-ext-media-load')!.dispatchEvent(new Event('click'));
    const img = doc.querySelector('img')!;
    expect(img.getAttribute('src')).toBe(EXT);
    expect(img.getAttribute('srcset')).toBe(`${EXT} 1x`);
    expect(img.hasAttribute('data-vv-external-src')).toBe(false);
    expect(img.hasAttribute('data-vv-external-srcset')).toBe(false);
    expect(img.hasAttribute('data-vv-blocked-external')).toBe(false);
    expect(img.hasAttribute('data-md-ext-media')).toBe(false);
    expect(doc.querySelector('span.md-ext-media')).toBeNull(); // 解包
    // 放行加载后不得留着「已拦截外部图片」title（评审 minor：已加载的事实与悬停提示相悖）
    expect(img.hasAttribute('title')).toBe(false);
  });

  it('④点击 video 分支：.mp4 创建 video（controls/preload=none/无 autoplay/src/maxWidth）替换 wrapper（MD-13 语义）', () => {
    const doc = docOf(`<img data-vv-external-src="https://e.example/clip.mp4" data-vv-blocked-external="1" alt="演示" title="已拦截外部图片：e.example">`);
    enrichMarkdownDom(doc);
    doc.querySelector('button.md-ext-media-load')!.dispatchEvent(new Event('click'));
    expect(doc.querySelector('span.md-ext-media')).toBeNull();
    const video = doc.querySelector('video')!;
    expect(video.getAttribute('controls')).toBe('');
    expect(video.getAttribute('preload')).toBe('none');
    expect(video.hasAttribute('autoplay')).toBe(false);
    expect(video.getAttribute('src')).toBe('https://e.example/clip.mp4');
    expect(video.getAttribute('aria-label')).toBe('演示'); // alt→aria-label
    expect(video.getAttribute('title')).toBe('已拦截外部图片：e.example'); // title 继承
    expect(doc.querySelector('img')).toBeNull(); // 占位 img 随 wrapper 替换移除
  });

  it('④点击 audio 分支：.mp3 创建 audio 同口径', () => {
    const doc = docOf(`<img data-vv-external-src="https://e.example/a.mp3">`);
    enrichMarkdownDom(doc);
    doc.querySelector('button.md-ext-media-load')!.dispatchEvent(new Event('click'));
    const audio = doc.querySelector('audio')!;
    expect(audio.getAttribute('preload')).toBe('none');
    expect(audio.hasAttribute('autoplay')).toBe(false);
    expect(audio.getAttribute('src')).toBe('https://e.example/a.mp3');
  });

  it('⑤会话免确认：同 src 第二次 enrichMarkdownDom 直接回填（无 wrapper 无按钮），跨渲染实例生效', () => {
    const first = docOf(`<img data-vv-external-src="${EXT}">`);
    enrichMarkdownDom(first);
    first.querySelector('button.md-ext-media-load')!.dispatchEvent(new Event('click'));
    expect(first.querySelector('img')!.getAttribute('src')).toBe(EXT);
    // 第二个渲染实例（新 doc）：同 src 免确认直接回填
    const second = docOf(`<img data-vv-external-src="${EXT}" data-vv-blocked-external="1">`);
    enrichMarkdownDom(second);
    const img = second.querySelector('img')!;
    expect(img.getAttribute('src')).toBe(EXT);
    expect(img.hasAttribute('data-vv-external-src')).toBe(false);
    expect(second.querySelector('span.md-ext-media')).toBeNull();
    expect(second.querySelector('button.md-ext-media-load')).toBeNull();
  });

  it('⑥幂等代币：同一 doc 二次调用不重复包裹（已处理 img 挂 data-md-ext-media 跳过）', () => {
    const doc = docOf(`<img data-vv-external-src="${EXT}">`);
    enrichMarkdownDom(doc);
    enrichMarkdownDom(doc);
    expect(doc.querySelectorAll('span.md-ext-media')).toHaveLength(1);
    expect(doc.querySelectorAll('button.md-ext-media-load')).toHaveLength(1);
  });

  it('⑤a 免确认 AV 分流（评审 I3）：.mp4 点击放行后重开同文档——免确认路径换 video 替换（与点击路径同口径，不回填 img 破图）', () => {
    const mp4 = 'https://e.example/clip.mp4';
    const first = docOf(`<img data-vv-external-src="${mp4}" data-vv-blocked-external="1" alt="演示">`);
    enrichMarkdownDom(first);
    first.querySelector('button.md-ext-media-load')!.dispatchEvent(new Event('click'));
    expect(first.querySelector('video')!.getAttribute('src')).toBe(mp4); // 首次点击呈 video
    // 第二个渲染实例（新 doc）：同 src 免确认——AV 扩展名换 video 替换（不回填 img）
    const second = docOf(`<img data-vv-external-src="${mp4}" data-vv-blocked-external="1" alt="演示">`);
    enrichMarkdownDom(second);
    const video = second.querySelector('video')!;
    expect(video).not.toBeNull();
    expect(video.getAttribute('src')).toBe(mp4);
    expect(video.getAttribute('preload')).toBe('none');
    expect(video.hasAttribute('autoplay')).toBe(false);
    expect(second.querySelector('img')).toBeNull(); // img 随替换消失（无破图 img）
    expect(second.querySelector('span.md-ext-media')).toBeNull();
    expect(second.querySelector('button.md-ext-media-load')).toBeNull();
  });

  it('⑦无 data-vv-external-src 标记的 img 零改动（blocked 占位/相对图片不构建）', () => {
    const doc = docOf(
      `<img src="photo.png" alt="相对图">` +
        `<img data-vv-blocked-external="1" title="已拦截外部图片：t.example" alt="blocked 占位">`,
    );
    enrichMarkdownDom(doc);
    expect(doc.querySelectorAll('span.md-ext-media')).toHaveLength(0);
    expect(doc.querySelectorAll('button.md-ext-media-load')).toHaveLength(0);
    expect(doc.querySelectorAll('img')).toHaveLength(2);
    // blocked 占位 img 保持 sanitize 原形态（title/标记不被 enrich 触碰）
    const blocked = doc.querySelectorAll('img')[1]!;
    expect(blocked.getAttribute('title')).toBe('已拦截外部图片：t.example');
    expect(blocked.getAttribute('data-vv-blocked-external')).toBe('1');
  });
});

describe('buildWikilink 死链 data-wikilink-path 元数据（spec D §3.2：纯属性零行为变化）', () => {
  it('死链 span 恒写 data-wikilink-path=路径首段（裸名/带别名/子路径+hash 三形态，保序）', () => {
    const doc = docOf('<p>[[Other.md]] [[b|别名]] [[sub/deep#Setup]]</p>');
    enrichMarkdownDom(doc);
    const spans = Array.from(doc.querySelectorAll('span.md-wikilink-dead'));
    expect(spans).toHaveLength(3);
    expect(spans.map((s) => s.getAttribute('data-wikilink-path'))).toEqual(['Other.md', 'b', 'sub/deep#Setup']);
    // 纯元数据：title/textContent 既有形态零变化
    expect(spans[0]!.getAttribute('title')).toBe('跨文件 wikilink 不支持');
    expect(spans[1]!.textContent).toBe('[[b|别名]]');
  });

  it('外域嵌入降级 span 同写 path（出口 isRelativeLinkHref 不升级）；页内锚 a[data-wikilink] 不带该属性', () => {
    const doc = docOf('<p>![[https://e.example/p.png]] [[#slug]]</p>');
    enrichMarkdownDom(doc);
    const span = doc.querySelector('span.md-wikilink-dead')!;
    expect(span.getAttribute('data-wikilink-path')).toBe('https://e.example/p.png');
    const anchor = doc.querySelector('a[data-wikilink="anchor"]')!;
    expect(anchor.hasAttribute('data-wikilink-path')).toBe(false);
  });
});
