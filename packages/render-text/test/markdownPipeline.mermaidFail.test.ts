import { describe, it, expect, vi } from 'vitest';

// mermaid 动态 import 失败分支（M3 deferred minor）：模块工厂抛错 →
// diagramEngines.renderMermaid 的 `import('mermaid').catch(() => null)` 得 null →
// 抛错 → 分发层（pipeline renderDiagramBlock）spec §6 回退链：有 krokiType 先降级
// kroki img（jsdom 不派 img error，单测断言 src 形态），kroki 也失败（真浏览器 img
// error）才落错误卡片保留原文。
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
  it('import 失败按 spec §6 回退链降级 kroki img：data-mermaid 锚保留 + src 形态（jsdom 不派 img error，错误卡仅真浏览器 img error 后出现）', async () => {
    const doc = docOf('```mermaid\ngraph TD; A-->B;\n```\n');
    const ctx: PipelineCtx = { highlightFence: vi.fn().mockResolvedValue(null) };
    await expect(runPipeline(doc, ctx)).resolves.toBeUndefined();
    const container = doc.querySelector('.md-diagram-view[data-mermaid]');
    expect(container).not.toBeNull();
    expect(container!.getAttribute('data-mermaid')).toBe('graph TD; A-->B;');
    // 回退 img：src 走注册表 krokiType（mermaid）+ 默认 kroki host
    const img = container!.querySelector('img');
    expect(img?.getAttribute('src')?.startsWith('https://kroki.io/mermaid/svg/')).toBe(true);
    expect(container!.classList.contains('md-diagram-error')).toBe(false);
    expect(container!.querySelector('svg')).toBeNull();
  });

  it('import 失败不阻塞后续步骤：同文档 js 块仍有可复制的语言徽标', async () => {
    const doc = docOf('```mermaid\ngraph TD; A-->B;\n```\n\n```js\nconst a = 1;\n```\n');
    const ctx: PipelineCtx = { highlightFence: vi.fn().mockResolvedValue(null) };
    await runPipeline(doc, ctx);
    expect(doc.querySelector('button.md-code-lang')).not.toBeNull();
  });
});
