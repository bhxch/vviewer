import { describe, it, expect, vi } from 'vitest';

// mermaid 动态 import 失败分支（M3 deferred minor）：模块工厂抛错 →
// pipeline 的 `await import('mermaid').catch(() => null)` 得 null →
// 每块走无库路径：保留原文 + 错误类，不注入 svg、不抛未处理 rejection。
// 与 markdownPipeline.test.ts 的「模块加载成功但 render 失败」分支互补。
vi.mock('mermaid', async () => {
  throw new Error('mermaid bundle 加载失败（模拟网络/分块错误）');
});

import { runPipeline, type PipelineCtx } from '../src/markdown/pipeline';
import { renderMarkdownToHtml } from '../src/markdown/engine';
import { sanitizeHtml } from '../src/markdown/sanitize';

function docOf(md: string): Document {
  const { html } = renderMarkdownToHtml(md);
  return new DOMParser().parseFromString(sanitizeHtml(html), 'text/html');
}

describe('diagrams 步：mermaid 动态 import 失败', () => {
  it('import 失败降级为逐块错误容器：保留原文 + mermaid-error 类', async () => {
    const doc = docOf('```mermaid\ngraph TD; A-->B;\n```\n');
    const ctx: PipelineCtx = { highlightFence: vi.fn().mockResolvedValue(null) };
    await expect(runPipeline(doc, ctx)).resolves.toBeUndefined();
    const container = doc.querySelector('div[data-mermaid]');
    expect(container).not.toBeNull();
    expect(container!.getAttribute('data-mermaid')).toBe('graph TD; A-->B;');
    expect(container!.classList.contains('md-mermaid-error')).toBe(true);
    expect(container!.textContent).toBe('graph TD; A-->B;');
    expect(container!.querySelector('svg')).toBeNull();
  });

  it('import 失败不阻塞后续步骤：同文档 js 块仍有复制按钮', async () => {
    const doc = docOf('```mermaid\ngraph TD; A-->B;\n```\n\n```js\nconst a = 1;\n```\n');
    const ctx: PipelineCtx = { highlightFence: vi.fn().mockResolvedValue(null) };
    await runPipeline(doc, ctx);
    expect(doc.querySelector('button.md-copy-btn')).not.toBeNull();
  });
});
