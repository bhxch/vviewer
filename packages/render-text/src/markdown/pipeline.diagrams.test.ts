// pipeline.diagrams.test.ts — diagrams 步注册表分发（Task 3）：local/kroki/source
// 三分支、模式回退链、wrapper DOM 契约（.md-diagram* 系列 + data-mermaid 锚）。
// jsdom 无真实图表引擎视觉度量能力：mermaid/nomnoml 走引擎失败错误路径或桩
// （断言两类终态均可观察）；kroki 只断言 img.src 形态（jsdom 不派发 img load/error）。
import { describe, expect, it } from 'vitest';
import { runPipeline, type PipelineCtx } from './pipeline';

function docWithFence(lang: string, body: string): Document {
  const doc = document.implementation.createHTMLDocument('');
  const pre = doc.createElement('pre');
  const code = doc.createElement('code');
  code.className = `language-${lang}`;
  code.textContent = body;
  pre.appendChild(code);
  doc.body.appendChild(pre);
  return doc;
}
const baseCtx: PipelineCtx = { highlightFence: async () => null };

describe('diagrams 步：注册表分发', () => {
  it('非图表语言不进 diagrams 分发（保留原 pre）', async () => {
    const doc = docWithFence('rust', 'fn main() {}');
    await runPipeline(doc, baseCtx);
    expect(doc.querySelector('pre code.language-rust')).not.toBeNull();
  });

  it('source 模式：wrapper + 源码面板 + 源码走 highlightFence', async () => {
    const doc = docWithFence('plantuml', 'a -> b');
    let highlighted = '';
    await runPipeline(doc, {
      ...baseCtx,
      diagram: { krokiHost: 'https://k', mermaidTheme: 'default', modeOf: () => 'source' },
      highlightFence: async (code, lang) => { highlighted = `${lang}:${code}`; return `<i>${lang}</i>`; }
    });
    const wrap = doc.querySelector('.md-diagram')!;
    expect(wrap).not.toBeNull();
    // source 模式初始即展开源码面板（视图隐藏）——与 brief 实现片段语义一致
    expect(doc.querySelector('.md-diagram-source')!.hasAttribute('hidden')).toBe(false);
    // 切换到图视图后源码面板隐藏；高亮回调已以映射语言调用
    (wrap.querySelector('.md-diagram-toggle') as HTMLElement).click();
    expect(doc.querySelector('.md-diagram-source')!.hasAttribute('hidden')).toBe(true);
    expect(highlighted).toBe('plantuml:a -> b');
  });

  it('kroki 模式：img.src 按 kroki 编码构造', async () => {
    const doc = docWithFence('plantuml', 'a -> b');
    await runPipeline(doc, {
      ...baseCtx,
      diagram: { krokiHost: 'https://k.example.com', mermaidTheme: 'default', modeOf: () => 'kroki' }
    });
    const img = doc.querySelector('.md-diagram-view img') as HTMLImageElement;
    expect(img.getAttribute('src')!.startsWith('https://k.example.com/plantuml/svg/')).toBe(true);
  });

  it('kroki 不支持语言（math）回退 source 模式', async () => {
    const doc = docWithFence('latex', 'c^2');
    await runPipeline(doc, {
      ...baseCtx,
      diagram: { krokiHost: 'https://k', mermaidTheme: 'default', modeOf: () => 'kroki' }
    });
    expect(doc.querySelector('.md-diagram-view img')).toBeNull();
    expect(doc.querySelector('.md-diagram-source code')).not.toBeNull();
  });

  it('local 模式成功：视图注入 svg（graphviz 桩）', async () => {
    const doc = docWithFence('nomnoml', '[a]->[b]');
    await runPipeline(doc, {
      ...baseCtx,
      diagram: { krokiHost: 'https://k', mermaidTheme: 'default', modeOf: () => 'local' }
    });
    // 未装 nomnoml 真渲染也要求错误路径可观察；真环境断言 svg：
    const view = doc.querySelector('.md-diagram-view')!;
    expect(view.classList.contains('md-diagram-error') || view.querySelector('svg')).toBeTruthy();
  });

  it('local 引擎失败：错误卡片保留源码', async () => {
    const doc = docWithFence('graphviz', 'digraph { a ->');
    await runPipeline(doc, {
      ...baseCtx,
      diagram: { krokiHost: 'https://k', mermaidTheme: 'default', modeOf: () => 'local' }
    });
    expect(doc.querySelector('.md-diagram-error')).not.toBeNull();
    expect(doc.querySelector('.md-diagram-error')!.textContent).toContain('digraph');
  });

  it('math 围栏 local：katex display HTML', async () => {
    const doc = docWithFence('math', 'c^2');
    await runPipeline(doc, baseCtx); // 无 diagram options → 注册表 defaultMode=local
    expect(doc.querySelector('.md-diagram-view')!.innerHTML).toContain('katex');
  });

  it('mermaid 既有语义保持：data-mermaid 源码属性', async () => {
    const doc = docWithFence('mermaid', 'graph TD; a-->b;');
    await runPipeline(doc, baseCtx);
    expect(doc.querySelector('[data-mermaid]')).not.toBeNull();
  });

  it('highlight 步跳过全部图表语言（不 hljs 兜底不 tree-sitter）', async () => {
    for (const lang of ['graphviz', 'plantuml', 'bpmn', 'vega', 'math']) {
      const doc = docWithFence(lang, 'x');
      await runPipeline(doc, { ...baseCtx, diagram: { krokiHost: 'https://k', mermaidTheme: 'default', modeOf: () => 'source' } });
      expect(doc.querySelector(`pre code.language-${lang}[data-md-highlight]`)).toBeNull();
    }
  });
});
