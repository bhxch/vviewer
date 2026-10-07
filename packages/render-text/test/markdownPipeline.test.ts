import { describe, it, expect, vi, beforeEach } from 'vitest';

// mermaid 全文件 mock：jsdom 无法真实渲染（依赖视觉度量），按裁决 mock 模块，
// 分别验证成功路径与失败容错路径。
const mermaidMocks = vi.hoisted(() => ({ render: vi.fn() }));
vi.mock('mermaid', () => ({
  default: { initialize: () => {}, render: mermaidMocks.render },
}));

import { runPipeline, getPipelineSteps, runSteps, type PipelineCtx } from '../src/markdown/pipeline';
import { renderMarkdownToHtml } from '../src/markdown/engine';
import { sanitizeHtml } from '../src/markdown/sanitize';

/** 引擎 → 净化 → 解析为 Document（T3 管线的真实输入形态）。 */
function docOf(md: string): Document {
  const { html } = renderMarkdownToHtml(md);
  return new DOMParser().parseFromString(sanitizeHtml(html), 'text/html');
}

function noopCtx(overrides: Partial<PipelineCtx> = {}): PipelineCtx {
  return { highlightFence: vi.fn().mockResolvedValue(null), ...overrides };
}

beforeEach(() => {
  mermaidMocks.render.mockReset();
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    configurable: true,
  });
});

describe('管线步骤装配', () => {
  it('五步固定次序：highlight → diagrams → katex → copyCode → lightbox', () => {
    expect(getPipelineSteps(noopCtx()).map((s) => s.name)).toEqual([
      'highlight',
      'diagrams',
      'katex',
      'copyCode',
      'lightbox',
    ]);
  });

  it('顺序执行——用调用记录数组断言五步次序', async () => {
    const calls: string[] = [];
    const steps = getPipelineSteps(noopCtx()).map((s) => ({
      name: s.name,
      run: async (r: Document, c: PipelineCtx) => {
        calls.push(s.name);
        await s.run(r, c);
      },
    }));
    await runSteps(steps, docOf(''), noopCtx());
    expect(calls).toEqual(['highlight', 'diagrams', 'katex', 'copyCode', 'lightbox']);
  });
});

describe('highlight 步', () => {
  it('highlightFence 注入被调用，返回的 span HTML 插入且不触发 hljs 兜底', async () => {
    const doc = docOf('```js\nconst a = 1;\n```\n');
    const ctx = noopCtx({ highlightFence: vi.fn().mockResolvedValue('<span class="ts-kw">const</span>') });
    await runPipeline(doc, ctx);
    const code = doc.querySelector('pre code')!;
    expect(ctx.highlightFence).toHaveBeenCalledWith('const a = 1;', 'js');
    expect(code.innerHTML).toContain('ts-kw');
    expect(code.classList.contains('hljs')).toBe(false);
  });

  it('highlightFence 返回 null → hljs 兜底高亮', async () => {
    const doc = docOf('```js\nconst a = 1;\n```\n');
    await runPipeline(doc, noopCtx());
    const code = doc.querySelector('pre code')!;
    expect(code.classList.contains('hljs')).toBe(true);
    expect(code.querySelector('.hljs-keyword')).not.toBeNull();
  });

  it('mermaid 块不送 highlightFence（归 diagrams 步）', async () => {
    const doc = docOf('```mermaid\ngraph TD; A-->B;\n```\n');
    const ctx = noopCtx();
    await runPipeline(doc, ctx);
    expect(ctx.highlightFence).not.toHaveBeenCalled();
  });
});

describe('diagrams 步（mermaid）', () => {
  const MERMAID_MD = '```mermaid\ngraph TD; A-->B;\n```\n';

  it('code.language-mermaid 替换为容器 div（data-mermaid 源码）并注入 svg', async () => {
    mermaidMocks.render.mockResolvedValue({ svg: '<svg><g/></svg>' });
    const doc = docOf(MERMAID_MD);
    await runPipeline(doc, noopCtx());
    expect(doc.querySelector('pre')).toBeNull();
    const container = doc.querySelector('div[data-mermaid]');
    expect(container).not.toBeNull();
    expect(container!.getAttribute('data-mermaid')).toBe('graph TD; A-->B;');
    expect(container!.querySelector('svg')).not.toBeNull();
    expect(container!.classList.contains('md-mermaid-error')).toBe(false);
  });

  it('mermaid.render 失败：保留原文加错误类', async () => {
    mermaidMocks.render.mockRejectedValue(new Error('boom'));
    const doc = docOf(MERMAID_MD);
    await runPipeline(doc, noopCtx());
    const container = doc.querySelector('div[data-mermaid]')!;
    expect(container).not.toBeNull();
    expect(container.classList.contains('md-mermaid-error')).toBe(true);
    expect(container.textContent).toContain('graph TD; A-->B;');
  });

  it('mermaid 失败不阻塞 copyCode——同文档 js 块仍有复制按钮', async () => {
    mermaidMocks.render.mockRejectedValue(new Error('boom'));
    const doc = docOf('```mermaid\ngraph TD; A-->B;\n```\n\n```js\nconst a = 1;\n```\n');
    await runPipeline(doc, noopCtx());
    expect(doc.querySelector('pre [data-md-copy]') ?? doc.querySelector('pre[data-md-copy]')).not.toBeNull();
    expect(doc.querySelectorAll('button.md-copy-btn').length).toBe(1);
  });
});

describe('katex 步', () => {
  it('行内公式 $...$ 渲染为 .katex，定界符消失', async () => {
    const doc = docOf('质能方程 $E=mc^2$ 很有名\n');
    await runPipeline(doc, noopCtx());
    expect(doc.querySelector('.katex')).not.toBeNull();
    expect(doc.body.textContent).not.toContain('$E=mc^2$');
  });

  it('块级公式 $$...$$ 渲染为 .katex-display', async () => {
    const doc = docOf('$$\nx^2 + y^2 = z^2\n$$\n');
    await runPipeline(doc, noopCtx());
    expect(doc.querySelector('.katex-display')).not.toBeNull();
  });

  it('跳过 code/pre 内文本', async () => {
    const doc = docOf('行内代码 `$x^2$` 保持原样\n');
    await runPipeline(doc, noopCtx());
    expect(doc.querySelector('code')!.textContent).toContain('$x^2$');
    expect(doc.querySelector('.katex')).toBeNull();
  });

  it('金额类 $ 非公式不误判', async () => {
    const doc = docOf('价格 $100 与 $200 之间\n');
    await runPipeline(doc, noopCtx());
    expect(doc.querySelector('.katex')).toBeNull();
    expect(doc.body.textContent).toContain('$100');
  });

  it('非法 LaTeX 保留原文（容错）', async () => {
    const doc = docOf('公式 $\\unknownCmdX$ 原样\n');
    await runPipeline(doc, noopCtx());
    expect(doc.querySelector('.katex')).toBeNull();
    expect(doc.body.textContent).toContain('\\unknownCmdX');
  });
});

describe('copyCode 步', () => {
  it('每个 pre 追加复制按钮，点击写入剪贴板', async () => {
    const doc = docOf('```js\nconst a = 1;\n```\n');
    await runPipeline(doc, noopCtx());
    const btn = doc.querySelector<HTMLElement>('button.md-copy-btn')!;
    expect(btn).not.toBeNull();
    btn.click();
    await Promise.resolve();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('const a = 1;');
  });

  it('重复 runPipeline 不累积按钮（幂等）', async () => {
    const doc = docOf('```js\nconst a = 1;\n```\n');
    const ctx = noopCtx();
    await runPipeline(doc, ctx);
    await runPipeline(doc, ctx);
    expect(doc.querySelectorAll('button.md-copy-btn').length).toBe(1);
  });
});

describe('lightbox 步', () => {
  it('img 点击打开 body 级 overlay 放大，点击 overlay 关闭', async () => {
    const doc = docOf('![图](photo.png)\n');
    await runPipeline(doc, noopCtx());
    const img = doc.querySelector('img')!;
    expect(doc.getElementById('md-lightbox-overlay')).toBeNull();
    img.click();
    const overlay = doc.getElementById('md-lightbox-overlay');
    expect(overlay).not.toBeNull();
    expect(overlay!.querySelector('img')!.getAttribute('src')).toContain('photo.png');
    overlay!.click();
    expect(doc.getElementById('md-lightbox-overlay')).toBeNull();
  });

  it('多图共享单例 overlay', async () => {
    const doc = docOf('![a](a.png)\n\n![b](b.png)\n');
    await runPipeline(doc, noopCtx());
    const imgs = doc.querySelectorAll('img');
    imgs[0]!.click();
    imgs[1]!.click();
    expect(doc.querySelectorAll('#md-lightbox-overlay').length).toBe(1);
  });
});

describe('themeClassPrefix 与集成', () => {
  it('themeClassPrefix 前缀生成元素的类名', async () => {
    mermaidMocks.render.mockRejectedValue(new Error('boom'));
    const doc = docOf('```js\nconst a = 1;\n```\n\n```mermaid\ngraph TD;\n```\n');
    await runPipeline(doc, noopCtx({ themeClassPrefix: 'dark-' }));
    expect(doc.querySelector('button.dark-md-copy-btn')).not.toBeNull();
    expect(doc.querySelector('div.dark-md-mermaid')).not.toBeNull();
    expect(doc.querySelector('button.md-copy-btn:not(.dark-md-copy-btn)')).toBeNull();
  });

  it('集成：一次管线同时完成高亮/mermaid/公式/复制/灯箱', async () => {
    mermaidMocks.render.mockResolvedValue({ svg: '<svg/>' });
    const doc = docOf(
      [
        '```js',
        'const a = 1;',
        '```',
        '',
        '```mermaid',
        'graph TD; A-->B;',
        '```',
        '',
        '公式 $E=mc^2$。',
        '',
        '![图](pic.png)',
        '',
      ].join('\n'),
    );
    await runPipeline(doc, noopCtx({ highlightFence: vi.fn().mockResolvedValue('<span class="ts-kw">const</span>') }));
    expect(doc.querySelector('.ts-kw')).not.toBeNull();
    expect(doc.querySelector('div[data-mermaid] svg')).not.toBeNull();
    expect(doc.querySelector('.katex')).not.toBeNull();
    expect(doc.querySelector('button.md-copy-btn')).not.toBeNull();
    doc.querySelector('img')!.click();
    expect(doc.getElementById('md-lightbox-overlay')).not.toBeNull();
  });
});
