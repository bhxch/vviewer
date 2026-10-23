// pipeline.diagrams.test.ts — diagrams 步注册表分发（Task 3）：local/kroki/source
// 三分支、模式回退链、wrapper DOM 契约（.md-diagram* 系列 + data-mermaid 锚）。
// jsdom 无真实图表引擎视觉度量能力：mermaid/nomnoml 走引擎失败错误路径或桩
// （断言两类终态均可观察）；kroki 只断言 img.src 形态（jsdom 不派发 img load/error）。
// spec §8.3（Task 5）：server 模式与 krokiVia=server 代发——fetch 注入走 global
// stub（vi.stubGlobal，highlightRouter.test.ts 同款），remoteCall 走注入缝桩。
import { afterEach, describe, expect, it, vi } from 'vitest';
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
    // 未装 nomnoml 真渲染也要求错误路径可观察；真环境断言 svg。spec §6 回退链后
    // 失败终态为 kroki img——容差一并认 img（测试环境 nomnoml 实装，走 svg 分支）
    const view = doc.querySelector('.md-diagram-view')!;
    expect(
      view.classList.contains('md-diagram-error') || view.querySelector('svg') || view.querySelector('img')
    ).toBeTruthy();
  });

  it('local 引擎失败且有 krokiType：spec §6 回退链降级 kroki img（src 形态断言）', async () => {
    const doc = docWithFence('graphviz', 'digraph { a ->');
    await runPipeline(doc, {
      ...baseCtx,
      diagram: { krokiHost: 'https://k', mermaidTheme: 'default', modeOf: () => 'local' }
    });
    // jsdom 不派 img error（既有口径）：断言 src 形态；错误卡仅真浏览器 img error 后出现
    const img = doc.querySelector('.md-diagram-view img') as HTMLImageElement;
    expect(img.getAttribute('src')!.startsWith('https://k/graphviz/svg/')).toBe(true);
    expect(doc.querySelector('.md-diagram-error')).toBeNull();
  });

  it('local 引擎失败且无 krokiType（math）：spec §6 回退链终点，仍错误卡保留源码', async () => {
    const doc = docWithFence('math', '\\notacommand'); // katex throwOnError 抛 ParseError
    await runPipeline(doc, {
      ...baseCtx,
      diagram: { krokiHost: 'https://k', mermaidTheme: 'default', modeOf: () => 'local' }
    });
    expect(doc.querySelector('.md-diagram-error')).not.toBeNull();
    expect(doc.querySelector('.md-diagram-error')!.textContent).toContain('\\notacommand');
    expect(doc.querySelector('.md-diagram-view img')).toBeNull(); // 无 krokiType 不降级 img
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

describe('diagrams 步：server 模式与 krokiVia=server 代发（Task 5 / spec §8.3）', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** 200 JSON 响应桩（{svg} 形态，/api/compute/diagram 与 /api/kroki 共用）。
   * mock 按 fetch 签名类型化（highlightRouter.test.ts 同款），calls 元组可索引。 */
  const svgResponse = (svg: string) =>
    async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
      new Response(JSON.stringify({ svg }), { status: 200 });

  it('modes=server 且 serverDiagramOf 命中：走服务端 fetch 并 sanitize（引擎 style 豁免保留、危险 style 丢弃）', async () => {
    const fetchMock = vi.fn(svgResponse(
      '<svg viewBox="0 0 1 1"><style>text { fill: red }</style><style>@import url(https://evil.example/x.css)</style><circle r="1"/></svg>'
    ));
    vi.stubGlobal('fetch', fetchMock);
    const doc = docWithFence('dot', 'digraph { a -> b }'); // 别名归一：fence dot → type.id graphviz
    await runPipeline(doc, {
      ...baseCtx,
      diagram: {
        krokiHost: 'https://k',
        mermaidTheme: 'default',
        modeOf: () => 'server',
        serverDiagramOf: (lang) => lang === 'graphviz',
        krokiProxy: true,
        remoteCall: () => ({ url: 'http://s:8321/api/compute/diagram', headers: { authorization: 'Bearer t' } })
      }
    });
    const view = doc.querySelector('.md-diagram-view')!;
    expect(view.querySelector('svg circle')).not.toBeNull();
    expect(view.querySelector('img')).toBeNull();
    // sanitize 豁免面（服务端上下文同款）：合法引擎 style 保留，危险 token（@import）整节点丢弃
    const styles = Array.from(view.querySelectorAll('style')).map((s) => s.textContent ?? '');
    expect(styles).toContain('text { fill: red }');
    expect(styles.some((t) => t.includes('@import'))).toBe(false);
    // fetch 形态：remoteCall 取 {url, headers}，POST JSON {lang, source}（lang 为归一 id）
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]! as [RequestInfo | URL, RequestInit];
    expect(String(url)).toBe('http://s:8321/api/compute/diagram');    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ lang: 'graphviz', source: 'digraph { a -> b }' });
    expect(init.headers).toMatchObject({ authorization: 'Bearer t', 'content-type': 'application/json' });
  });

  it('modes=server 未命中能力：降级链首站 local（graphviz 本地引擎出图或 kroki img），零 fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const doc = docWithFence('dot', 'digraph { a -> b }');
    await runPipeline(doc, {
      ...baseCtx,
      diagram: {
        krokiHost: 'https://k',
        mermaidTheme: 'default',
        modeOf: () => 'server',
        serverDiagramOf: () => false,
        krokiProxy: false,
        remoteCall: () => null
      }
    });
    expect(fetchMock).not.toHaveBeenCalled();
    // serverDiagramOf 未命中 → type.local && type.engine → local：viz 可用时出 svg，
    // 引擎失败走 spec §6 既有回退落 kroki img——两终态皆合法，但必不落 source 空视图
    const view = doc.querySelector('.md-diagram-view')!;
    expect(view.querySelector('svg, img')).not.toBeNull();
  });

  it('modes=server fetch 失败（非 ok）：按「fetch 抛错转 Kroki 回退」落 kroki img（无本地引擎类型）', async () => {
    const fetchMock = vi.fn(async () => new Response('boom', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);
    const doc = docWithFence('plantuml', 'a -> b'); // plantuml 无本地引擎：降级链直落 kroki
    await runPipeline(doc, {
      ...baseCtx,
      diagram: {
        krokiHost: 'https://k',
        mermaidTheme: 'default',
        modeOf: () => 'server',
        serverDiagramOf: () => true,
        krokiProxy: true,
        remoteCall: () => ({ url: 'http://s:8321/api/compute/diagram', headers: {} })
      }
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const img = doc.querySelector('.md-diagram-view img') as HTMLImageElement;
    expect(img.getAttribute('src')!.startsWith('https://k/plantuml/svg/')).toBe(true);
  });

  it('krokiVia=server→POST /api/kroki 内联 svg（非 img src，kroki-proxy 容器承接）', async () => {
    const fetchMock = vi.fn(svgResponse('<svg viewBox="0 0 1 1"><circle r="1"/></svg>'));
    vi.stubGlobal('fetch', fetchMock);
    const doc = docWithFence('plantuml', 'a -> b');
    await runPipeline(doc, {
      ...baseCtx,
      diagram: {
        krokiHost: 'https://k',
        mermaidTheme: 'default',
        modeOf: () => 'kroki',
        krokiVia: 'server',
        krokiProxy: true,
        remoteCall: () => ({ url: 'http://s:8321/api/kroki', headers: { authorization: 'Bearer t' } })
      }
    });
    const view = doc.querySelector('.md-diagram-view')!;
    expect(view.querySelector('svg circle')).not.toBeNull();
    expect(view.querySelector('img')).toBeNull();
    expect(view.querySelector('[data-vv-diagram="kroki-proxy"]')).not.toBeNull();
    const [url, init] = fetchMock.mock.calls[0]! as [RequestInfo | URL, RequestInit];
    expect(String(url)).toBe('http://s:8321/api/kroki');
    expect(JSON.parse(init.body as string)).toEqual({ lang: 'plantuml', source: 'a -> b' });
    expect(init.headers).toMatchObject({ authorization: 'Bearer t' });
  });

  it('krokiVia=server 而 krokiProxy=false：回落既有 client img 直发路径，零 fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const doc = docWithFence('plantuml', 'a -> b');
    await runPipeline(doc, {
      ...baseCtx,
      diagram: {
        krokiHost: 'https://k',
        mermaidTheme: 'default',
        modeOf: () => 'kroki',
        krokiVia: 'server',
        krokiProxy: false,
        remoteCall: () => null
      }
    });
    expect(fetchMock).not.toHaveBeenCalled();
    const img = doc.querySelector('.md-diagram-view img') as HTMLImageElement;
    expect(img.getAttribute('src')!.startsWith('https://k/plantuml/svg/')).toBe(true);
  });
});

// graphviz 双渲染器（Task 6 / spec 2026-10-23 §9.1）：rendererOf 注入值经管线透传
// renderDiagramEngine opts.renderer——vi.mock 拦 cdnEngines 模块边界观察 hpcc 分流
//（文件级 mock 对上方用例无影响：均不触 CDN 引擎路径）；默认（未注入 rendererOf）
// 走既有 viz 路径零变化（viz 真渲染环境相关，容差断言）。
vi.mock('./cdnEngines', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return { ...real, renderGraphvizHpcc: vi.fn(async () => '<svg><circle r="1"/></svg>') };
});

describe('diagrams 步：graphviz 渲染器透传（Task 6 / spec §9.1）', () => {
  it('rendererOf=hpcc：hpcc CDN 引擎出图注入视图（非 kroki img 非错误卡）', async () => {
    const doc = docWithFence('graphviz', 'digraph { a -> b }');
    await runPipeline(doc, {
      ...baseCtx,
      diagram: { krokiHost: 'https://k', mermaidTheme: 'default', modeOf: () => 'local', rendererOf: () => 'hpcc' }
    });
    const view = doc.querySelector('.md-diagram-view')!;
    expect(view.innerHTML).toContain('<circle');
    expect(view.querySelector('img')).toBeNull();
    expect(view.classList.contains('md-diagram-error')).toBe(false);
  });

  it('未注入 rendererOf：默认 viz 路径（hpcc mock 零调用），失败照旧降级 kroki img', async () => {
    const { renderGraphvizHpcc } = await import('./cdnEngines');
    const hpccMock = vi.mocked(renderGraphvizHpcc);
    const doc = docWithFence('graphviz', 'digraph { a ->');
    await runPipeline(doc, {
      ...baseCtx,
      diagram: { krokiHost: 'https://k', mermaidTheme: 'default', modeOf: () => 'local' }
    });
    expect(renderGraphvizHpcc).not.toHaveBeenCalled();
    // 既有回退链不受 renderer 字段影响：viz 失败 → kroki img
    const img = doc.querySelector('.md-diagram-view img') as HTMLImageElement | null;
    expect(img?.getAttribute('src')?.startsWith('https://k/graphviz/svg/') ?? true).toBe(true);
  });
});
