import { describe, it, expect, vi } from 'vitest';

// mermaid 动态 import 失败分支（M3 deferred minor）：模块工厂抛错 →
// diagramEngines.renderMermaid 的 `import('mermaid').catch(() => null)` 得 null →
// 抛错 → 分发层（pipeline renderDiagramBlock）逐块错误路径：错误卡片保留原文，
// 不注入 svg、不抛未处理 rejection。
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
  it('import 失败降级为逐块错误卡片：保留原文 + diagram-error 类（契约迁移：.md-diagram-view + data-mermaid）', async () => {
    const doc = docOf('```mermaid\ngraph TD; A-->B;\n```\n');
    const ctx: PipelineCtx = { highlightFence: vi.fn().mockResolvedValue(null) };
    await expect(runPipeline(doc, ctx)).resolves.toBeUndefined();
    const container = doc.querySelector('.md-diagram-view[data-mermaid]');
    expect(container).not.toBeNull();
    expect(container!.getAttribute('data-mermaid')).toBe('graph TD; A-->B;');
    expect(container!.classList.contains('md-diagram-error')).toBe(true);
    expect(container!.textContent).toBe('graph TD; A-->B;');
    expect(container!.querySelector('svg')).toBeNull();
  });

  it('import 失败不阻塞后续步骤：同文档 js 块仍有可复制的语言徽标', async () => {
    const doc = docOf('```mermaid\ngraph TD; A-->B;\n```\n\n```js\nconst a = 1;\n```\n');
    const ctx: PipelineCtx = { highlightFence: vi.fn().mockResolvedValue(null) };
    await runPipeline(doc, ctx);
    expect(doc.querySelector('button.md-code-lang')).not.toBeNull();
  });
});
