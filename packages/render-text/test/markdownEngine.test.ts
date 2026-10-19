import { describe, it, expect } from 'vitest';
import { renderMarkdownToHtml, protectLatexDelimiters } from '../src/markdown/engine';
import { parseFrontMatter } from '../src/markdown/frontMatter';

describe('renderMarkdownToHtml——GFM 全家', () => {
  it('表格渲染为 <table>', () => {
    const { html } = renderMarkdownToHtml('| a | b |\n| --- | --- |\n| 1 | 2 |\n');
    expect(html).toContain('<table>');
    expect(html).toContain('<th>a</th>');
    expect(html).toContain('<td>1</td>');
  });

  it('删除线渲染为 <del>（BUG-67：对齐 comrak/GFM，markdown-it v13 默认 <s> 已改写）', () => {
    const { html } = renderMarkdownToHtml('~~划掉~~');
    expect(html).toContain('<del>划掉</del>');
    expect(html).not.toContain('<s>');
  });

  it('标题渲染尾置锚链接（comrak header anchors 同款形状；BUG-39 统一 user-content- 前缀）', () => {
    const { html } = renderMarkdownToHtml('# 指纹样例\n\n正文\n');
    // 锚在标题内、末尾；href 为 comrak 同款 GFM anchorize + user-content- 前缀
    // （comrak header_id_prefix_in_href=true 同形态）。本地 heading 的实际 id 由
    // enrich assignHeadingIds 用同一 GfmAnchorizer 分配（BUG-39 裁决，Wave 4）。
    expect(html).toContain('<h1>指纹样例');
    expect(html).toMatch(
      /<a href="#user-content-指纹样例" aria-label="Link to heading '指纹样例'" data-heading-content="指纹样例" class="anchor"><\/a><\/h1>/
    );
  });

  it('重名标题按 GFM 算法 -1 去重（comrak Anchorizer 同款，锚 href 同步去重）', () => {
    const { html } = renderMarkdownToHtml('## Stuff\n\n## Stuff\n');
    expect(html).toContain('href="#user-content-stuff"');
    expect(html).toContain('href="#user-content-stuff-1"');
  });

  it('任务列表渲染 disabled checkbox 并标记 li', () => {
    const { html } = renderMarkdownToHtml('- [x] 已完成\n- [ ] 未完成\n');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('disabled');
    expect(html).toContain('task-list-item');
  });

  it('linkify 裸 URL 转链接', () => {
    const { html } = renderMarkdownToHtml('访问 https://example.com 试试');
    expect(html).toContain('<a href="https://example.com"');
  });

  it('脚注渲染 footnote-ref 与回链（与 comrak 服务端能力对齐，样例文本同 samples/m6/sample-gfm.md）', () => {
    // 与 samples/m6/sample-gfm.md「脚注」节同构：正文引用 + 脚注定义
    const { html } = renderMarkdownToHtml(
      'vviewer 是一个本地文件查看器[^1]。\n\n[^1]: 本样例用于 M6 E2E 验收。\n'
    );
    // 引用侧：sup.footnote-ref 内锚点指向脚注条目
    expect(html).toContain('footnote-ref');
    expect(html).toMatch(/<a href="#fn1" id="fnref1">/);
    // 定义侧：脚注条目 + 回到引用的 backlink（sanitize 白名单保留 id/href/#）
    expect(html).toContain('footnote-backref');
    expect(html).toContain('本样例用于 M6 E2E 验收');
  });

  it('无定义的脚注引用保持字面文本（不吞内容）', () => {
    const { html } = renderMarkdownToHtml('孤儿引用[^nope] 不应消失');
    expect(html).toContain('[^nope]');
  });

  it('围栏代码保留 language- 类（供管线高亮步定位）', () => {
    const { html } = renderMarkdownToHtml('```ts\nconst a = 1;\n```\n');
    expect(html).toContain('<pre><code class="language-ts">');
  });

  it('html: true——内联 HTML 原样保留（输出必经 sanitize）', () => {
    const { html } = renderMarkdownToHtml('前 <b>粗</b> 后');
    expect(html).toContain('<b>粗</b>');
  });
});

describe('renderMarkdownToHtml——扩展语法（Task 2：mark/ins/deflist）', () => {
  it('==mark== 渲染 <mark>（与 comrak 扩展语法金标对齐的本地半边）', () => {
    const { html } = renderMarkdownToHtml('==高亮==');
    expect(html).toContain('<mark>高亮</mark>');
  });

  it('++ins++ 渲染 <ins>', () => {
    const { html } = renderMarkdownToHtml('++插入++');
    expect(html).toContain('<ins>插入</ins>');
  });

  it('描述列表 term / : def 渲染 dl/dt/dd', () => {
    const html = renderMarkdownToHtml('术语\n: 定义一行').html;
    expect(html).toContain('<dl>');
    expect(html).toContain('<dt>术语</dt>');
    expect(html).toContain('<dd>');
  });
});

describe('renderMarkdownToHtml——front matter', () => {
  it('YAML 块剥离后渲染正文，front matter 返回解析对象', () => {
    const src = '---\ntitle: Hello\ntags:\n  - a\n  - b\n---\n\n# 正文\n';
    const { html, frontMatter } = renderMarkdownToHtml(src);
    expect(frontMatter).toEqual({ title: 'Hello', tags: ['a', 'b'] });
    expect(html).toContain('<h1>正文<a href="#user-content-正文"'); // 标题含尾置锚（BUG-67/BUG-39 对齐）
    expect(html).not.toContain('title: Hello');
    expect(html).not.toContain('<hr>'); // 开头 --- 不得渲染为主题分割线
  });

  it('无 front matter 返回 null 且正文照常渲染', () => {
    const { html, frontMatter } = renderMarkdownToHtml('# 只有标题\n');
    expect(frontMatter).toBeNull();
    expect(html).toContain('<h1>只有标题<a href="#user-content-只有标题"');
  });

  it('坏 YAML 容错：frontMatter=null 且原文整体渲染', () => {
    const src = '---\ntitle: [unclosed\n---\n\n# 正文\n';
    const { html, frontMatter } = renderMarkdownToHtml(src);
    expect(frontMatter).toBeNull();
    expect(html).toContain('unclosed'); // 原文未被剥离
    expect(html).toContain('正文');
  });

  it('非映射 YAML（标量/序列）不算 front matter：整体渲染', () => {
    const src = '---\njust a scalar\n---\n\n# 正文\n';
    const { html, frontMatter } = renderMarkdownToHtml(src);
    expect(frontMatter).toBeNull();
    expect(html).toContain('just a scalar');
  });

  it('空 front matter 块返回空对象', () => {
    const { frontMatter, html } = renderMarkdownToHtml('---\n---\n\n正文\n');
    expect(frontMatter).toEqual({});
    expect(html).toContain('正文');
  });

  it('容忍 BOM 与 CRLF', () => {
    const src = '﻿---\r\ntitle: T\r\n---\r\n\r\n正文\r\n';
    const { frontMatter, html } = renderMarkdownToHtml(src);
    expect(frontMatter).toEqual({ title: 'T' });
    expect(html).toContain('正文');
  });
});

describe('parseFrontMatter——frontMatter.ts 独立契约', () => {
  it('body 为剥离后的剩余原文', () => {
    const { frontMatter, body } = parseFrontMatter('---\na: 1\n---\nBODY');
    expect(frontMatter).toEqual({ a: 1 });
    expect(body).toBe('BODY');
  });

  it('文档中间的 --- 不是 front matter 边界', () => {
    const { frontMatter, body } = parseFrontMatter('前言\n---\na: 1\n---\n');
    expect(frontMatter).toBeNull();
    expect(body).toContain('前言');
  });
});

describe('protectLatexDelimiters——LaTeX 定界符前置改写（Task 1b）', () => {
  it('\\(..\\) → $..$、\\[..\\] → $$..$$（markpad markdown_ext 同款语义）', () => {
    expect(protectLatexDelimiters('行内 \\(a^2\\) 与块级 \\[b_2\\]')).toBe('行内 $a^2$ 与块级 $$b_2$$');
  });

  it('围栏码块（``` 与 ~~~）内不转换', () => {
    expect(protectLatexDelimiters('```\n\\(x\\)\n\\[y\\]\n```')).toBe('```\n\\(x\\)\n\\[y\\]\n```');
    expect(protectLatexDelimiters('~~~\n\\(x\\)\n~~~')).toBe('~~~\n\\(x\\)\n~~~');
  });

  it('围栏内外状态互不串扰：围栏后恢复转换', () => {
    expect(protectLatexDelimiters('```\n```\n\\(a\\)')).toBe('```\n```\n$a$');
  });

  it('单反引号行内码内不转换', () => {
    expect(protectLatexDelimiters('前 `\\(x\\)` 后')).toBe('前 `\\(x\\)` 后');
    // 行内码跨行（CommonMark code span 可含换行）：状态跨行持续
    expect(protectLatexDelimiters('`a\n\\(x\\)\nb`')).toBe('`a\n\\(x\\)\nb`');
  });

  it('无定界符与既有 $ 字面量原样不动', () => {
    const src = '价格 $100 与 $200，普通 (括号) 与 [方括号]\n';
    expect(protectLatexDelimiters(src)).toBe(src);
  });

  it('未闭合数学：内容原样回填、开定界符已消耗（markpad 同款）', () => {
    expect(protectLatexDelimiters('未闭 \\(abc')).toBe('未闭 $abc');
    expect(protectLatexDelimiters('未闭 \\[abc')).toBe('未闭 $$abc');
  });

  it('CRLF 输入：围栏内 \\( 保留、围栏外转换（\\r 残留不得卡死闭围栏）', () => {
    expect(protectLatexDelimiters('```\r\n\\(x\\)\r\n```\r\n\\(a\\)')).toBe('```\n\\(x\\)\n```\n$a$');
  });

  it('\\(..\\) 与 $ 字面量混排：改写不破坏 $ 语义', () => {
    expect(protectLatexDelimiters('\\(a\\) 值 $100')).toBe('$a$ 值 $100');
  });
});

describe('renderMarkdownToHtml × protectLatexDelimiters 接线（md.render 之前）', () => {
  it('\\(a^2\\) 经引擎后输出含 $a^2$ 文本（管线 katex 步接力）', () => {
    const { html } = renderMarkdownToHtml('行内 \\(a^2\\) 公式\n');
    expect(html).toContain('$a^2$');
    expect(html).not.toContain('\\(');
  });

  it('\\[..\\] 块级转 $$..$$（双行块形态按转换结果原样交引擎）', () => {
    const { html } = renderMarkdownToHtml('\\[\nb_2\n\\]\n');
    expect(html).toContain('$$');
  });

  it('fence 内 \\(x\\) 保留字面（引擎侧不做转换）', () => {
    const { html } = renderMarkdownToHtml('```\n\\(x\\)\n```\n');
    expect(html).toContain('\\(x\\)');
    expect(html).not.toContain('$x$');
  });

  it('front matter 内不改写（只处理正文）', () => {
    const src = '---\ndesc: \\(x\\)\n---\n\n正文\n';
    const { frontMatter, html } = renderMarkdownToHtml(src);
    expect(frontMatter).toEqual({ desc: '\\(x\\)' });
    expect(html).not.toContain('$x$');
  });
});
