import { describe, it, expect } from 'vitest';
import { sanitizeDiagramFragment } from '../src/sanitize';

function docOf(html = ''): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

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

describe('sanitizeDiagramFragment——服务端图表 SVG 片段净化', () => {
  it('空片段净化后返回空串', () => {
    expect(sanitizeDiagramFragment(docOf(), '')).toBe('');
  });

  it('契约壳包裹净化后剥壳取回内层：引擎 style（含 url(#arrow) 片段引用）与图元存活，壳属性不外泄', () => {
    const out = sanitizeDiagramFragment(
      docOf(),
      `<svg><style>${SVGBOB_STYLE_076}</style><line class="end_marked_arrow"/><path class="solid"/></svg>`,
    );
    expect(out).toContain('<style>');
    expect(out).toContain('stroke: black');
    expect(out).toContain('marker-end: url(#arrow)');
    expect(out).toContain('marker-start: url(#arrow)');
    expect(out).toContain('<line');
    expect(out).toContain('<path');
    expect(out).not.toContain('data-vv-diagram');
  });

  it('敌意 style（非片段 url(/@import）整节点丢弃：样式降级、图元保留（fail-closed）', () => {
    const out = sanitizeDiagramFragment(
      docOf(),
      '<svg><style>.a{background:url(https://evil.example/b.png)}@import "x.css";</style><path d="M0 0"/></svg>',
    );
    expect(out).not.toContain('<style');
    expect(out).not.toContain('evil.example');
    expect(out).not.toContain('@import');
    expect(out).toContain('<path');
  });

  it('hex 转义伪装的 url( 归一化后整节点丢弃（对抗性不因片段承接面放松）', () => {
    const out = sanitizeDiagramFragment(
      docOf(),
      '<svg><style>\\75 rl(https://evil.example/x.png)</style><line/></svg>',
    );
    expect(out).not.toContain('<style');
    expect(out).not.toContain('evil.example');
    expect(out).toContain('<line');
  });

  it('片段内外域 image href 拦截：移除引用并打标记，内域保留', () => {
    const out = sanitizeDiagramFragment(
      docOf(),
      '<svg><image href="https://evil.example.com/s.png"></image><image href="local.png"></image></svg>',
    );
    expect(out).not.toContain('evil.example.com/s.png'); // 加载源移除（title 域名提示残留属预期）
    expect(out).toContain('href="local.png"');
    expect(out).toContain('data-vv-blocked-external="1"');
    expect(out).toContain('已拦截外部图片：evil.example.com');
  });

  it('片段内 script 剥除', () => {
    const out = sanitizeDiagramFragment(docOf(), '<svg><path d="M0 0"/></svg><script>alert(1)</script>');
    expect(out).toContain('<path');
    expect(out).not.toContain('<script');
    expect(out).not.toContain('alert');
  });

  it('opts.serverDiagram 透传：壳属性按契约构造（壳/钩子同源，契约字面量不漂移）', () => {
    // 判别性：若壳仍按默认字面量构造而钩子按自定义契约识别（或反之），容器
    // 上下文匹配失败 → style 被剥，用例即失败
    const out = sanitizeDiagramFragment(
      docOf(),
      '<svg><style>.e{fill:none;stroke:red}</style><path d="M0 0"/></svg>',
      { serverDiagram: { attr: 'data-diagram', value: 'kroki' } },
    );
    expect(out).toContain('<style>');
    expect(out).toContain('fill:none;stroke:red');
    expect(out).not.toContain('data-vv-diagram'); // 壳按自定义契约构造
  });
});
