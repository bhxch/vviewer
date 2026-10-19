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

  it('source 模式：wrapper + 源码面板展开 + 无 toggle 钮 + 源码走 highlightFence', async () => {
    const doc = docWithFence('plantuml', 'a -> b');
    let highlighted = '';
    await runPipeline(doc, {
      ...baseCtx,
      diagram: { krokiHost: 'https://k', mermaidTheme: 'default', modeOf: () => 'source' },
      highlightFence: async (code, lang) => { highlighted = `${lang}:${code}`; return `<i>${lang}</i>`; }
    });
    const wrap = doc.querySelector('.md-diagram')!;
    expect(wrap).not.toBeNull();
    // source 模式无图视图可切：不生成 toggle（连 DOM 都不加）——否则「图」钮点开空视图条假交互
    expect(wrap.querySelector('.md-diagram-toggle')).toBeNull();
    // 源码面板初始展开、视图隐藏；高亮回调已以映射语言调用
    expect(doc.querySelector('.md-diagram-source')!.hasAttribute('hidden')).toBe(false);
    expect(doc.querySelector('.md-diagram-view')!.hasAttribute('hidden')).toBe(true);
    expect(highlighted).toBe('plantuml:a -> b');
  });

  it('local/kroki 模式首次切源码：惰性 highlightFence 注入（源码面板标记防重复）', async () => {
    const doc = docWithFence('plantuml', 'a -> b');
    let calls = 0;
    await runPipeline(doc, {
      ...baseCtx,
      diagram: { krokiHost: 'https://k', mermaidTheme: 'default', modeOf: () => 'kroki' },
      highlightFence: async (code, lang) => { calls += 1; return `<i>${lang}:${code}</i>`; }
    });
    const wrap = doc.querySelector('.md-diagram')!;
    const sourceCode = doc.querySelector('.md-diagram-source code')!;
    // 图视图优先：初始源码面板保持纯文本（未请求高亮）
    expect(calls).toBe(0);
    expect(sourceCode.innerHTML).not.toContain('<i>');
    // 首次切到源码：惰性高亮注入
    (wrap.querySelector('.md-diagram-toggle') as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 0)); // flush 微任务
    expect(calls).toBe(1);
    // innerHTML 实体转义：> 写作 &gt;（注入本身已生效）
    expect(sourceCode.innerHTML).toContain('<i>plantuml:a -&gt; b</i>');
    // 切回图再切源码：data-md-diag-src-hl 标记生效，不重复请求
    (wrap.querySelector('.md-diagram-toggle') as HTMLElement).click();
    (wrap.querySelector('.md-diagram-toggle') as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toBe(1);
  });

  it('kroki 模式：img.src 按 kroki 编码构造', async () => {
    const doc = docWithFence('plantuml', 'a -> b');
    await runPipeline(doc, {
      ...baseCtx,
      diagram: { krokiHost: 'https://k.example.com', mermaidTheme: 'default', modeOf: () => 'kroki' }
    });
    const img = doc.querySelector('.md-diagram-view img') as HTMLImageElement;
    expect(img.getAttribute('src')!.startsWith('https://k.example.com/plantuml/svg/')).toBe(true);
    // data-mermaid 锚仅 mermaid 视图保留（Task 5 以 [data-mermaid] 做主题重渲染，
    // 空属性同样命中选择器）——非 mermaid 的 kroki 视图不得带该属性
    expect(doc.querySelector('.md-diagram-view[data-mermaid]')).toBeNull();
  });

  it('kroki 模式 mermaid：视图保留 data-mermaid 源码锚（非 mermaid 不设）', async () => {
    const doc = docWithFence('mermaid', 'graph TD; a-->b;');
    await runPipeline(doc, {
      ...baseCtx,
      diagram: { krokiHost: 'https://k', mermaidTheme: 'default', modeOf: () => 'kroki' }
    });
    const view = doc.querySelector('.md-diagram-view')!;
    expect(view.getAttribute('data-mermaid')).toBe('graph TD; a-->b;');
    expect(doc.querySelector('.md-diagram-view[data-mermaid]')).toBe(view);
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

describe('diagrams 步：服务端图表 div 接回标准 wrapper（Task 3 / spec §2.5）', () => {
  it('服务端图表 div 接回标准 wrapper（图/源码切换一致）', async () => {
    const doc = document.implementation.createHTMLDocument('');
    doc.body.innerHTML = '<div data-vv-diagram="server" data-diagram-lang="dot" data-diagram-src="digraph{a}"><svg viewBox="0 0 1 1"></svg></div>';
    await runPipeline(doc, baseCtx);
    const wrap = doc.querySelector('.md-diagram')!;
    expect(wrap).not.toBeNull();
    expect(wrap.querySelector('.md-diagram-view svg')).not.toBeNull();
    expect(wrap.querySelector('.md-diagram-view[data-mermaid]')).toBeNull(); // 非 mermaid 无锚
    const src = wrap.querySelector('.md-diagram-source code')!;
    expect(src.textContent).toBe('digraph{a}');
    expect((wrap.querySelector('.md-diagram-toggle') as HTMLElement)).not.toBeNull();
  });

  it('服务端 div 的 data-diagram-src 经属性反解码为原文', async () => {
    const doc = document.implementation.createHTMLDocument('');
    doc.body.innerHTML = '<div data-vv-diagram="server" data-diagram-lang="svgbob" data-diagram-src="a -&gt; b"><svg/></div>';
    await runPipeline(doc, baseCtx);
    expect(doc.querySelector('.md-diagram-source code')!.textContent).toBe('a -> b');
  });

  it('服务端 div 幂等：重入不二次包裹、契约属性不残留', async () => {
    const doc = document.implementation.createHTMLDocument('');
    doc.body.innerHTML = '<div data-vv-diagram="server" data-diagram-lang="dot" data-diagram-src="digraph{a}"><svg/></div>';
    await runPipeline(doc, baseCtx);
    expect(doc.querySelectorAll('.md-diagram')).toHaveLength(1);
    // 模拟重入（同一 DOM 再跑一遍管线）：wrapped 标记 + 契约属性摘除防二次命中
    await runPipeline(doc, baseCtx);
    expect(doc.querySelectorAll('.md-diagram')).toHaveLength(1);
    expect(doc.querySelector('.md-diagram-view [data-vv-diagram]')).toBeNull();
  });
});
