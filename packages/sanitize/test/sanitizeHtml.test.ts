import { describe, it, expect } from 'vitest';
import { ALLOWED_URI_REGEXP, hostOf, isExternalMediaSrc, sanitizeHtml } from '../src/sanitize';

function docOf(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

describe('sanitizeHtml——净化基础', () => {
  it('script 标签剥除', () => {
    const out = sanitizeHtml('<p>ok</p><script>alert(1)</script>');
    expect(out).toContain('<p>ok</p>');
    expect(out).not.toContain('script');
    expect(out).not.toContain('alert');
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

  it('data-* 属性保留（mermaid/katex 管线钩子依赖）', () => {
    const out = sanitizeHtml('<div data-mermaid="graph TD">x</div>');
    expect(out).toContain('data-mermaid="graph TD"');
  });

  it('meta 标签显式禁用（防 DOMPurify 上游默认变化）', () => {
    const out = sanitizeHtml('<meta http-equiv="refresh" content="0;url=https://evil.example"><p>x</p>');
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

  it('wholeDocument：整文档净化保留 html/body 骨架，meta 仍被禁', () => {
    const raw =
      '<html><head><meta http-equiv="refresh" content="0;url=https://evil.example"></head><body><p>x</p></body></html>';
    const out = sanitizeHtml(raw, { wholeDocument: true });
    expect(out).toContain('<html');
    expect(out).toContain('<body>');
    expect(out).toContain('<p>x</p>');
    expect(out).not.toContain('<meta');
    expect(out).not.toContain('evil.example');
    // 默认（片段模式）下同一输入不保留文档骨架
    const fragment = sanitizeHtml(raw);
    expect(fragment).not.toContain('<html');
    expect(fragment).toContain('<p>x</p>');
  });
});

describe('ALLOWED_URI_REGEXP——URI 白名单正则直测', () => {
  it('放行：http/https/mailto、data:image、相对路径、片段、字母开头非 scheme 串', () => {
    for (const v of [
      'https://a.example/b',
      'http://a.example/b',
      'mailto:a@b.example',
      'data:image/png;base64,iVBOR',
      './notes/other.md',
      '#anchor',
      'photo.png',
    ]) {
      expect(ALLOWED_URI_REGEXP.test(v), v).toBe(true);
    }
  });

  it('拒绝：javascript:/vbscript:/data:text/html 匹配不到任何分支', () => {
    for (const v of [
      'javascript:alert(1)',
      'vbscript:msgbox(1)',
      'data:text/html;base64,PHNjcmlwdD4=',
    ]) {
      expect(ALLOWED_URI_REGEXP.test(v), v).toBe(false);
    }
  });
});

describe('isExternalMediaSrc / hostOf——外域判定与域提示', () => {
  it('isExternalMediaSrc：http(s) 与协议相对为外域，相对/data/blob 不算', () => {
    expect(isExternalMediaSrc('https://t.example/a.png')).toBe(true);
    expect(isExternalMediaSrc('http://t.example/a.png')).toBe(true);
    expect(isExternalMediaSrc('//t.example/a.png')).toBe(true);
    expect(isExternalMediaSrc('photo.png')).toBe(false);
    expect(isExternalMediaSrc('./a/b.png')).toBe(false);
    expect(isExternalMediaSrc('data:image/png;base64,iVBOR')).toBe(false);
    expect(isExternalMediaSrc('blob:https://vviewer.invalid/uuid')).toBe(false);
  });

  it('hostOf：取 host；解析失败回落原串', () => {
    expect(hostOf('https://tracker.example.com/track.png')).toBe('tracker.example.com');
    expect(hostOf('//evil.example/p.gif')).toBe('evil.example');
    // 特殊 scheme 空 host 的残串：URL 构造抛错 → 回落原串
    expect(hostOf('http://')).toBe('http://');
  });
});

describe('sanitizeHtml——URI 白名单与 data: 按属性收窄', () => {
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
      '<img src="data:image/png;base64,iVBOR" srcset="data:image/png;base64,iVBOR 2x" alt="嵌入图">',
    );
    expect(out).toContain('src="data:image/png;base64,iVBOR"');
    expect(out).toContain('srcset="data:image/png;base64,iVBOR 2x"');
  });

  it('data: 仅放行 src/srcset：action/formaction 等其余 URI 属性一并剥除', () => {
    const out = sanitizeHtml(
      '<form action="data:image/svg+xml,x"><button formaction="data:image/svg+xml,y">go</button></form>',
    );
    expect(out).not.toContain('action=');
    expect(out).not.toContain('formaction=');
  });
});

describe('sanitizeHtml——外域图片拦截（BUG-17）', () => {
  it('img 的 http(s) src 移除并打 data-vv-blocked-external 标记，title 保留域名', () => {
    const out = sanitizeHtml(
      '<img src="https://tracker.example.com/track.png" alt="x"><img src="http://evil.example/p.gif">',
    );
    expect(out).not.toContain('src="https://tracker.example.com');
    expect(out).not.toContain('src="http://evil.example');
    expect(out).toContain('data-vv-blocked-external="1"');
    expect(out).toContain('已拦截外部图片：tracker.example.com');
    expect(out).toContain('已拦截外部图片：evil.example');
    expect(out).toContain('alt="x"'); // 其余属性不受影响
  });

  it('协议相对（//host/…）同样拦截', () => {
    const out = sanitizeHtml('<img src="//tracker.example.net/p.png">');
    expect(out).not.toContain('src="//');
    expect(out).toContain('data-vv-blocked-external="1"');
    expect(out).toContain('已拦截外部图片：tracker.example.net');
  });

  it('相对路径 / data:image 不拦截（markdown 相对图片解析与内嵌图不受损）', () => {
    const out = sanitizeHtml('<img src="photo.png"><img src="./a/b.jpg"><img src="data:image/png;base64,iVBOR">');
    expect(out).toContain('src="photo.png"');
    expect(out).toContain('src="./a/b.jpg"');
    expect(out).toContain('src="data:image/png;base64,iVBOR"');
    expect(out).not.toContain('data-vv-blocked-external');
  });

  it('srcset 外域候选同样拦截：有内域候选时保留其余、不置标记', () => {
    const out = sanitizeHtml('<img srcset="https://t.example/b.png 1x, /local-c.png 2x">');
    expect(out).not.toContain('t.example');
    expect(out).toContain('srcset="/local-c.png 2x"');
    expect(out).not.toContain('data-vv-blocked-external');
  });

  it('srcset 全部候选外域且无 src：移除 srcset 并置拦截标记', () => {
    const out = sanitizeHtml('<img srcset="https://t.example/b.png 1x, //t.example/c.png 2x">');
    expect(out).not.toContain('srcset=');
    expect(out).toContain('data-vv-blocked-external="1"');
    expect(out).toContain('已拦截外部图片：t.example');
  });

  it('链接 <a href> 外链不拦（用户主动导航，与图片的被动加载区分）', () => {
    const out = sanitizeHtml('<a href="https://external.example/x">外链</a>');
    expect(out).toContain('href="https://external.example/x"');
    expect(out).not.toContain('data-vv-blocked-external');
  });
});

describe('sanitizeHtml——外域媒体自动加载防线（BUG-17/MD-13 延伸）', () => {
  it('裸 HTML video/audio：外域 src 保留但强制 preload=none 并去 autoplay', () => {
    const html = sanitizeHtml(
      '<video controls autoplay src="https://evil.example.com/clip.mp4"></video>' +
        '<audio controls src="https://evil.example.com/a.mp3"></audio>',
    );
    const div = document.createElement('div');
    div.innerHTML = html;
    const video = div.querySelector('video')!;
    expect(video.getAttribute('src')).toBe('https://evil.example.com/clip.mp4');
    expect(video.getAttribute('preload')).toBe('none');
    expect(video.hasAttribute('autoplay')).toBe(false);
    expect(div.querySelector('audio')!.getAttribute('preload')).toBe('none');
  });

  it('内部相对 src 的 video 不受影响（preload 不被强改）', () => {
    const html = sanitizeHtml('<video controls src="sample.mp4"></video>');
    const div = document.createElement('div');
    div.innerHTML = html;
    const video = div.querySelector('video')!;
    expect(video.getAttribute('src')).toBe('sample.mp4');
    expect(video.hasAttribute('preload')).toBe(false);
  });

  it('source 外域候选剥除 src；内部候选保留', () => {
    const html = sanitizeHtml(
      '<video controls><source src="https://evil.example.com/a.mp4"><source src="local.mp4"></video>',
    );
    const div = document.createElement('div');
    div.innerHTML = html;
    const sources = Array.from(div.querySelectorAll('source'));
    expect(sources).toHaveLength(2);
    expect(sources[0]!.getAttribute('src')).toBeNull();
    expect(sources[1]!.getAttribute('src')).toBe('local.mp4');
  });
});

describe('sanitizeHtml——五类等价加载向量外域拦截（BUG-40）', () => {
  it('① video/audio 的外域 poster 移除并打标记（poster 随渲染即拉取，preload 拦不住）', () => {
    const html = sanitizeHtml(
      '<video controls poster="https://evil.example.com/p.jpg" src="local.mp4"></video>' +
        '<audio controls poster="//evil.example.net/a.jpg"></audio>',
    );
    expect(html).not.toContain('poster='); // 两形态全剥（http 绝对 + 协议相对）
    expect(html).not.toContain('evil.example.com/p.jpg');
    expect(html).not.toContain('evil.example.net/a.jpg');
    expect(html).toContain('data-vv-blocked-external="1"');
    expect(html).toContain('已拦截外部图片：evil.example.com');
    expect(html).toContain('src="local.mp4"'); // src 语义不受影响（点播放才请求）
  });

  it('① 内域/相对 poster 保留（data: poster 由 data: 收窄分支剥除）', () => {
    const html = sanitizeHtml(
      '<video controls poster="local.jpg" src="local.mp4"></video>' +
        '<video controls poster="data:image/png;base64,iVBOR"></video>',
    );
    expect(html).toContain('poster="local.jpg"');
    expect(html).not.toContain('poster="data:');
    expect(html).not.toContain('data-vv-blocked-external');
  });

  it('② SVG image 的 href/xlink:href 外域移除并打标记，内域保留', () => {
    const html = sanitizeHtml(
      '<svg><image href="https://evil.example.com/s.png"></image>' +
        '<image xlink:href="https://evil.example.net/t.png"></image>' +
        '<image href="local.png"></image></svg>',
    );
    expect(html).not.toContain('evil.example.com/s.png');
    expect(html).not.toContain('evil.example.net/t.png');
    expect(html).toContain('href="local.png"');
    expect(html).toContain('data-vv-blocked-external="1"');
    expect(html).toContain('已拦截外部图片：evil.example.com');
  });

  it('③ 行内 style 外域 url() 剥声明：其余声明保留，全部外域时整属性移除', () => {
    const html = sanitizeHtml(
      '<div style="color:red;background:url(https://evil.example.com/bg.png)">x</div>' +
        '<div style="background:url(//evil.example.net/bg.png)">y</div>' +
        '<div style="background:url(https://evil.example.com/only.png)">z</div>',
    );
    expect(html).toContain('style="color:red"'); // 外域声明剥除、其余保留
    expect(html).not.toContain('evil.example.com/bg.png');
    expect(html).not.toContain('evil.example.net/bg.png');
    expect(html).not.toContain('style="background:'); // 仅外域声明 → 整属性移除
    expect(html).toContain('data-vv-blocked-external="1"');
    expect(html).toContain('已拦截外部图片：evil.example.com');
  });

  it('③ 行内 style 相对/data url 与无 url 声明不受损（image-set 字符串 URL 同拦）', () => {
    const html = sanitizeHtml(
      '<div style="color: crimson;background:url(./a.png);list-style-image:url(data:image/png;base64,iVBOR)">x</div>' +
        '<div style="background:image-set(&quot;https://evil.example.com/i.png&quot; 1x)">y</div>',
    );
    expect(html).toContain('color: crimson');
    expect(html).toContain('url(./a.png)');
    expect(html).toContain('data:image/png;base64');
    expect(html).not.toContain('image-set'); // 外域 image-set 声明整体剥除
    expect(html).not.toContain('evil.example.com/i.png');
    expect(html).toContain('data-vv-blocked-external="1"');
  });

  it('④ table background 属性外域移除并打标记，内域保留', () => {
    const html = sanitizeHtml(
      '<table background="https://evil.example.com/tbg.png"><tr><td>a</td></tr></table>' +
        '<table background="tbg-local.png"><tr><td>b</td></tr></table>',
    );
    expect(html).not.toContain('evil.example.com/tbg.png');
    expect(html).toContain('background="tbg-local.png"');
    expect(html).toContain('data-vv-blocked-external="1"');
    expect(html).toContain('已拦截外部图片：evil.example.com');
  });

  it('⑤ input type=image 的外域 src 移除并打标记，checkbox 等其余 input 不受影响', () => {
    const html = sanitizeHtml(
      '<input type="image" src="https://evil.example.com/i.png" alt="x">' +
        '<input type="checkbox" checked><input type="text">',
    );
    expect(html).not.toContain('evil.example.com/i.png');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('data-vv-blocked-external="1"');
    expect(html).toContain('已拦截外部图片：evil.example.com');
  });
});

describe('sanitizeHtml——服务端图表 style 上下文豁免（默认契约）', () => {
  const SRV = '<div data-vv-diagram="server" data-diagram-lang="dot" data-diagram-src="digraph{a}">';

  it('服务端图表容器内的 style 存活（引擎线条样式不丢）', () => {
    const out = sanitizeHtml(`${SRV}<svg><style>.e{fill:none;stroke:red}</style><path d="M0 0"/></svg></div>`);
    expect(out).toContain('<style>');
    expect(out).toContain('.e{fill:none;stroke:red}');
  });

  it('豁免 style 命中危险 token 整节点丢弃（url(/@import/expression(——凡命中即敌意，降级不保留）', () => {
    const out = sanitizeHtml(
      `${SRV}<style>.a{background:url(https://evil.example/b.png)}@import "x.css";p{width:expression(alert(1))}</style></div>`,
    );
    expect(out).not.toContain('<style');
    expect(out).not.toContain('evil.example');
    expect(out).not.toContain('expression(');
  });

  it('对抗性：CSS hex/字面转义伪装的 url( 归一化后整节点丢弃', () => {
    // 浏览器 CSS tokenizer 先解码转义再语义化：\75 rl( 与 u\72 l( 均按 url( 生效，
    // 字面串匹配会漏——归一化副本（hex 转义含尾随空白消费 + 字面转义）上匹配
    const hexed = sanitizeHtml(`${SRV}<style>\\75 rl(https://evil.example/x.png)</style></div>`);
    expect(hexed).not.toContain('<style');
    expect(hexed).not.toContain('evil.example');
    const literal = sanitizeHtml(`${SRV}<style>u\\72 l(https://evil.example/x.png)</style></div>`);
    expect(literal).not.toContain('<style');
  });

  it('合法引擎 CSS 不误杀（layout-rs 真实 token：font-family/stroke/fill 原样保留）', () => {
    const out = sanitizeHtml(
      `${SRV}<svg><style>.a14 { font-size: 14px; font-family: Times, serif; }</style><ellipse/></svg></div>`,
    );
    expect(out).toContain('<style>');
    expect(out).toContain('.a14 { font-size: 14px; font-family: Times, serif; }');
  });

  /** svgbob 0.7.6 直出 style 片段（`svgbob::to_svg("+---+\n|a|")` 逐字提取）：描边 + 箭头 marker 规则 */
  const SVGBOB_STYLE_076 = `.svgbob line, .svgbob path, .svgbob circle, .svgbob rect, .svgbob polygon {
  stroke: black;
  stroke-width: 2;
  stroke-opacity: 1;
  fill-opacity: 1;
  stroke-linecap: round;
  stroke-linejoin: miter;
}

.svgbob text {
  white-space: pre;
  fill: black;
  font-family: Iosevka Fixed, monospace;
  font-size: 14px;
}

.svgbob .end_marked_arrow {
  marker-end: url(#arrow);
}

.svgbob .start_marked_arrow {
  marker-start: url(#arrow);
}`;

  it('真实引擎 fixture：svgbob 0.7.6 style（含 url(#arrow) 片段引用）存活——整杀即线条消失', () => {
    const out = sanitizeHtml(`${SRV}<svg><style>${SVGBOB_STYLE_076}</style><line class="solid"/></svg></div>`);
    expect(out).toContain('<style>');
    expect(out).toContain('stroke: black');
    expect(out).toContain('marker-end: url(#arrow)');
    expect(out).toContain('marker-start: url(#arrow)');
  });

  it('普通位置（容器外）的 style 仍被剥除（BUG-40 防线不松动）', () => {
    const out = sanitizeHtml('<style>.titlebar{display:none}</style><p>x</p>');
    expect(out).not.toContain('<style');
    expect(out).not.toContain('titlebar');
  });

  it('容器外的 svg style 同样剥除（豁免仅限容器上下文）', () => {
    const out = sanitizeHtml('<svg><style>.g{display:none}</style><path/></svg>');
    expect(out).not.toContain('<style');
    expect(out).not.toContain('.g');
  });
});

describe('sanitizeHtml——serverDiagram 契约选项（拆包提取：默认字面量与原硬编码一致）', () => {
  // 非契约容器：默认调用下 style 不豁免；自定义契约后获豁免
  const NO_CONTRACT = '<div data-diagram="kroki"><svg><style>.e{fill:none}</style></svg></div>';

  it('默认调用：非契约容器内的 style 不豁免（字面量收口为默认值，行为与迁移前一致）', () => {
    const out = sanitizeHtml(NO_CONTRACT);
    expect(out).not.toContain('<style');
    expect(out).not.toContain('fill:none');
    expect(out).toContain('<svg'); // 图元不受影响
  });

  it('自定义契约：attr/value 均可配，容器内 style 获豁免', () => {
    const out = sanitizeHtml(NO_CONTRACT, { serverDiagram: { attr: 'data-diagram', value: 'kroki' } });
    expect(out).toContain('<style>');
    expect(out).toContain('fill:none');
  });

  it('仅覆盖 value：attr 回落默认 data-vv-diagram', () => {
    const out = sanitizeHtml('<div data-vv-diagram="trusted"><svg><style>.e{fill:none}</style></svg></div>', {
      serverDiagram: { value: 'trusted' },
    });
    expect(out).toContain('<style>');
  });

  it('契约按调用替换：自定义后默认 data-vv-diagram="server" 容器不再豁免', () => {
    const out = sanitizeHtml(
      '<div data-vv-diagram="server"><svg><style>.e{fill:none}</style></svg></div>',
      { serverDiagram: { attr: 'data-diagram', value: 'kroki' } },
    );
    expect(out).not.toContain('<style');
    expect(out).toContain('<svg');
  });

  it('契约不落共享 config：连续两次不同选项调用互不串扰（逐调用 config 语义）', () => {
    const srv = '<div data-vv-diagram="server"><svg><style>.e{fill:none}</style></svg></div>';
    const custom = sanitizeHtml(srv, { serverDiagram: { attr: 'data-diagram', value: 'kroki' } });
    expect(custom).not.toContain('<style'); // 自定义契约下默认容器不豁免
    const back = sanitizeHtml(srv); // 随后的默认调用必须恢复默认契约
    expect(back).toContain('<style>');
    expect(back).toContain('fill:none');
  });
});
