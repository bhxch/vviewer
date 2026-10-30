import { describe, it, expect, vi } from 'vitest';

// mermaid 引擎失败分支（M3 deferred minor）：引擎 reject → 分发层（pipeline
// renderDiagramBlock）spec §6 回退链：有 krokiType 先降级 kroki img（jsdom 不派
// img error，单测断言 src 形态），kroki 也失败（真浏览器 img error）才落错误卡片
// 保留原文。与 markdownPipeline.test.ts 的「模块加载成功但 render 失败」分支互补。
// mermaid 迁出为 @vviewer/render-diagram 后，『真加载失败』（模块工厂抛错形态）
// 由该包 test/mermaidFail.test.ts 承接；此处包边界桩 renderDiagramEngine reject，
// 只验证管线侧回退链编排。spread real 保留注册表/编码等其余导出。
vi.mock('@vviewer/render-diagram', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    renderDiagramEngine: vi.fn(async () => {
      throw new Error('mermaid 引擎失败（包边界桩：真加载失败见 @vviewer/render-diagram 包内测试）');
    })
  };
});

import { runPipeline, type PipelineCtx } from '../src/markdown/pipeline';
import { renderMarkdownToHtml } from '@vviewer/markdown-engine';
import { sanitizeHtml } from '@vviewer/sanitize';

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
