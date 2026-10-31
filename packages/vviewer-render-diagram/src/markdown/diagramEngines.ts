// diagramEngines.ts — 本地图表引擎适配（spec §2.1 启用集 + §2.6 standalone 形态）。
// API 用法对齐 markpad src/lib/localRenderers.ts；全部动态 import（不进主包），
// import 失败不缓存负结果（允许重试）。CDN 直链四类委派 cdnEngines.ts（spec §6）。
// MermaidTheme（spec 2026-10-23 §9.2 Task 7）：五值为 mermaid 原生主题枚举
//（initialize { theme } 直透）；settings.diagrams.mermaidTheme 的 'auto'（跟随
// 亮暗）在 app 侧解析为本联合，render-text 侧只见具体值。
export const MERMAID_THEMES = ['default', 'dark', 'neutral', 'forest', 'base'] as const;
export type MermaidTheme = (typeof MERMAID_THEMES)[number];

let mermaidSeq = 0;

/** mermaid 单入口（全仓唯一 import('mermaid') 点）：失败抛错由分发层降级。 */
async function renderMermaid(source: string, theme: MermaidTheme): Promise<string> {
  const mermaid = await import('mermaid').then((m) => m.default).catch(() => null);
  if (!mermaid) throw new Error('mermaid 加载失败');
  mermaid.initialize({ startOnLoad: false, theme });
  const { svg } = await mermaid.render(`md-mermaid-${(mermaidSeq += 1)}`, source);
  return svg;
}

/** graphviz 本地引擎（spec 2026-10-23 §9.1 双渲染器）：renderer==='hpcc' 走
 * CDN 直链 @hpcc-js/wasm-graphviz（cdnEngines 恒懒加载不进主 chunk）；缺省/其余值
 * 走既有 @viz-js/viz 路径——默认 settings.diagrams.renderers 为空 → rendererOf
 * 返回 undefined → viz，渲染结果零变化。 */
async function renderGraphviz(source: string, renderer?: string): Promise<string> {
  if (renderer === 'hpcc') return (await import('./cdnEngines')).renderGraphvizHpcc(source);
  const viz = await import('@viz-js/viz');
  const inst = await viz.instance();
  return inst.renderSVGElement(source).outerHTML;
}

async function renderNomnoml(source: string): Promise<string> {
  const nomnoml = await import('nomnoml');
  return nomnoml.renderSvg(source);
}

async function renderMathFence(source: string): Promise<string> {
  const katex = (await import('katex').catch(() => null))?.default;
  if (!katex) throw new Error('katex 加载失败');
  return katex.renderToString(source, { displayMode: true, throwOnError: true });
}

export type DiagramEngineId =
  | 'mermaid'
  | 'graphviz'
  | 'nomnoml'
  | 'math'
  | 'svgbob'
  // CDN 直链八类（spec §6/§10）：实现另置 cdnEngines.ts（jsdelivr +esm 精确版本），
  // 经下方 switch 动态 import 委派——cdnEngines 恒懒加载不进主 chunk
  | 'excalidraw'
  | 'bpmn'
  | 'vega'
  | 'vegalite'
  | 'wavedrom'
  | 'bytefield'
  | 'dbml'
  | 'd2';

/** svgbob wasm 引擎（spec §7）：glue 构建期生成（gen:svgbob-wasm），init 幂等缓存。 */
let svgbobInit: Promise<{ render: (s: string) => string }> | null = null;
async function renderSvgbob(source: string): Promise<string> {
  svgbobInit ??= import('./svgbob-wasm-gen/svgbob_wasm.js').then(async (m) => {
    await m.default();
    return m;
  }).catch((e: unknown) => { svgbobInit = null; throw e; });
  const mod = await svgbobInit;
  return mod.render(source);
}

export async function renderDiagramEngine(
  engine: DiagramEngineId,
  source: string,
  opts?: { mermaidTheme?: MermaidTheme; renderer?: string }
): Promise<string> {
  switch (engine) {
    case 'mermaid':
      return renderMermaid(source, opts?.mermaidTheme ?? 'default');
    case 'graphviz':
      return renderGraphviz(source, opts?.renderer);
    case 'nomnoml':
      return renderNomnoml(source);
    case 'math':
      return renderMathFence(source);
    case 'svgbob':
      return renderSvgbob(source);
    case 'excalidraw':
      return (await import('./cdnEngines')).renderExcalidrawCdn(source);
    case 'bpmn':
      return (await import('./cdnEngines')).renderBpmnCdn(source);
    case 'vega':
    case 'vegalite':
      return (await import('./cdnEngines')).renderVegaCdn(source);
    case 'wavedrom':
      return (await import('./cdnEngines')).renderWavedromCdn(source);
    case 'bytefield':
      return (await import('./cdnEngines')).renderBytefieldCdn(source);
    case 'dbml':
      return (await import('./cdnEngines')).renderDbmlCdn(source);
    case 'd2':
      return (await import('./cdnEngines')).renderD2Cdn(source);
  }
}

/** 就地重渲染 mermaid 容器（外观主题联动）：成功 true；失败保留旧图 false。 */
export async function renderMermaidInto(container: Element, source: string, theme: MermaidTheme): Promise<boolean> {
  try {
    const svg = await renderMermaid(source, theme);
    container.innerHTML = svg;
    return true;
  } catch {
    return false;
  }
}
