import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Detection, FileSource, RenderedInstance } from '@vviewer/core';
import type { HighlightInterval } from '@vviewer/highlight';
import { markdownRenderer, fenceToHtml, slugifyHeading } from '../src/markdown/markdownRenderer';
import { attachHighlightClient, type CodeHighlightClient } from '../src/code';

const SOURCE: FileSource = {
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

const DET: Detection = { ext: 'md', encoding: 'utf-8' };

async function renderMd(md: string): Promise<{ target: HTMLElement; instance: RenderedInstance }> {
  const target = document.createElement('div');
  const instance = await markdownRenderer.render(new TextEncoder().encode(md), target, SOURCE, DET);
  return { target, instance };
}

/** RenderedInstance 上可选的 getToc（core types 已声明） */
function tocOf(instance: RenderedInstance): { level: number; text: string; id: string }[] {
  if (!instance.getToc) throw new Error('markdownRenderer 实例应提供 getToc');
  return instance.getToc();
}

afterEach(() => {
  attachHighlightClient(null);
  document.body.innerHTML = '';
});

describe('markdownRenderer——渲染与 TOC', () => {
  it('管线全链：heading 落入 target，getToc 按 h1-h4 提取 level/text/id 且 heading 均有 id', async () => {
    const md = '# 标题一\n\n## 标题二\n\n正文\n\n### 标题三\n\n#### 标题四\n';
    const { target, instance } = await renderMd(md);
    expect(target.querySelector('h1')?.textContent).toBe('标题一');
    const toc = tocOf(instance);
    expect(toc.map((t) => [t.level, t.text])).toEqual([
      [1, '标题一'],
      [2, '标题二'],
      [3, '标题三'],
      [4, '标题四']
    ]);
    for (const t of toc) {
      expect(t.id).not.toBe('');
      expect(target.querySelector(`[id="${t.id}"]`)).not.toBeNull();
    }
  });

  it('无 id 的 heading 生成 slug id；重复标题唯一化；既有 id 保留', async () => {
    const md = [
      '# Hello World!',
      '',
      '## Hello World',
      '',
      '<h2 id="custom-id">自定标题</h2>',
      '',
      '### 自定标题',
      ''
    ].join('\n');
    const { target, instance } = await renderMd(md);
    const toc = tocOf(instance);
    const ids = toc.map((t) => t.id);
    expect(ids[0]).toBe('hello-world'); // slug：去标点、空格转 -
    expect(ids[1]).toBe('hello-world-2'); // 重复标题唯一化
    expect(ids[2]).toBe('custom-id'); // 既有 id 保留
    expect(ids[3]).toBe('自定标题'); // 无 id 的 CJK 标题生成 CJK slug
    expect(new Set(ids).size).toBe(ids.length);
    // DOM 内 id 与 TOC 一一对应
    for (const t of toc) expect(target.querySelector(`[id="${t.id}"]`)).not.toBeNull();
  });

  it('CJK 标题生成 CJK slug', () => {
    expect(slugifyHeading('中文 标题')).toBe('中文-标题');
    expect(slugifyHeading('!!!')).toBe('section'); // 全空 slug 回退
  });

  it('destroy 清空 target，getToc 数据保持最后一次渲染的结果', async () => {
    const { target, instance } = await renderMd('# 存留\n');
    const toc = tocOf(instance);
    expect(toc).toHaveLength(1);
    instance.destroy();
    expect(target.innerHTML).toBe('');
    expect(tocOf(instance)).toEqual(toc);
  });
});

describe('fenceToHtml——highlightFence 接线（依赖倒置）', () => {
  it('注入 fake client：区间 → 行 HTML（captureToCssClass 类名），多行分段正确', async () => {
    const fake: CodeHighlightClient = {
      highlight: async (text: string): Promise<HighlightInterval[]> =>
        text.startsWith('const') ? [{ start: 0, end: 5, capture: 'keyword' }] : [{ start: 0, end: 3, capture: 'keyword.control' }]
    };
    attachHighlightClient(fake);
    expect(await fenceToHtml('const a = 1;', 'js')).toBe(
      '<span class="ts-keyword">const</span> a = 1;'
    );
    expect(await fenceToHtml('if x:\nelse y:', 'py')).toBe(
      '<span class="ts-keyword-control">if </span>x:\nelse y:'
    );
  });

  it('client 抛错（含取消）/未注入 → 返回 null（管线内 hljs 兜底）', async () => {
    attachHighlightClient({
      highlight: async () => {
        throw new Error('boom');
      }
    });
    expect(await fenceToHtml('x', 'js')).toBeNull();
    attachHighlightClient(null);
    expect(await fenceToHtml('x', 'js')).toBeNull();
  });

  it('渲染集成：注入 fake 后围栏代码块内出现 ts-* span', async () => {
    attachHighlightClient({
      highlight: async (): Promise<HighlightInterval[]> => [{ start: 0, end: 5, capture: 'keyword' }]
    });
    const { target } = await renderMd('```js\nconst a = 1;\n```\n');
    const span = target.querySelector('pre code .ts-keyword');
    expect(span).not.toBeNull();
    expect(span?.textContent).toBe('const');
  });

  it('渲染集成：client 失败时围栏回落 hljs（hljs-* span）', async () => {
    attachHighlightClient({
      highlight: async (): Promise<HighlightInterval[]> => {
        throw new Error('boom');
      }
    });
    const { target } = await renderMd('```js\nconst a = 1;\n```\n');
    await vi.waitFor(() => {
      expect(target.querySelector('pre code span[class^="hljs-"]')).not.toBeNull();
    });
  });
});
