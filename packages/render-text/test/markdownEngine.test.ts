import { describe, it, expect } from 'vitest';
import { renderMarkdownToHtml } from '../src/markdown/engine';
import { parseFrontMatter } from '../src/markdown/frontMatter';

describe('renderMarkdownToHtml——GFM 全家', () => {
  it('表格渲染为 <table>', () => {
    const { html } = renderMarkdownToHtml('| a | b |\n| --- | --- |\n| 1 | 2 |\n');
    expect(html).toContain('<table>');
    expect(html).toContain('<th>a</th>');
    expect(html).toContain('<td>1</td>');
  });

  it('删除线渲染为 <s>（markdown-it 内建双删除线用 s 标签）', () => {
    const { html } = renderMarkdownToHtml('~~划掉~~');
    expect(html).toContain('<s>划掉</s>');
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

  it('围栏代码保留 language- 类（供管线高亮步定位）', () => {
    const { html } = renderMarkdownToHtml('```ts\nconst a = 1;\n```\n');
    expect(html).toContain('<pre><code class="language-ts">');
  });

  it('html: true——内联 HTML 原样保留（输出必经 sanitize）', () => {
    const { html } = renderMarkdownToHtml('前 <b>粗</b> 后');
    expect(html).toContain('<b>粗</b>');
  });
});

describe('renderMarkdownToHtml——front matter', () => {
  it('YAML 块剥离后渲染正文，front matter 返回解析对象', () => {
    const src = '---\ntitle: Hello\ntags:\n  - a\n  - b\n---\n\n# 正文\n';
    const { html, frontMatter } = renderMarkdownToHtml(src);
    expect(frontMatter).toEqual({ title: 'Hello', tags: ['a', 'b'] });
    expect(html).toContain('<h1>正文</h1>');
    expect(html).not.toContain('title: Hello');
    expect(html).not.toContain('<hr>'); // 开头 --- 不得渲染为主题分割线
  });

  it('无 front matter 返回 null 且正文照常渲染', () => {
    const { html, frontMatter } = renderMarkdownToHtml('# 只有标题\n');
    expect(frontMatter).toBeNull();
    expect(html).toContain('<h1>只有标题</h1>');
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
