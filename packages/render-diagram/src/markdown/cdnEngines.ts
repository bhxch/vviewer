// cdnEngines.ts — CDN 直链图表引擎（spec §6/§10）：jsdelivr +esm 精确版本，dist 零增量。
// 版本钉死与 spec §10 勘定版本对齐（2026-10-23 实测）；
// 加载/渲染失败抛错由 pipeline local 分支错误卡片兜底，负结果不缓存（可重试）。
// 注意：URL 必须运行时模板字符串构造，配 @vite-ignore 防 Vite 静态分析打包。
const CDN = 'https://cdn.jsdelivr.net/npm';

type CdnLoader = (url: string) => Promise<unknown>;
let loader: CdnLoader = (url) => import(/* @vite-ignore */ url);

/** 单测注入口（生产路径不调用）；传 null 还原生产动态 import */
export function __setCdnLoaderForTest(fn: CdnLoader | null): void {
  loader = fn ?? ((u) => import(/* @vite-ignore */ u));
}

/** excalidraw（@excalidraw/utils@0.1.5）：exportToSvg({ data }) 签名（≥0.1.4），
 * elements/appState/files 包在 data 里——扁平结构包内读 data.appState 即抛错
 *（markpad 实证），故按 markpad 归一化重组并补导出背景默认值。 */
export async function renderExcalidrawCdn(source: string): Promise<string> {
  const mod = (await loader(`${CDN}/@excalidraw/utils@0.1.5/+esm`)) as {
    exportToSvg: (opts: { data: unknown }) => Promise<SVGSVGElement>;
  };
  const data = JSON.parse(source) as {
    elements?: unknown[];
    appState?: { viewBackgroundColor?: string } & Record<string, unknown>;
    files?: Record<string, unknown> | null;
  };
  const appState = data.appState ?? {};
  const svg = await mod.exportToSvg({
    data: {
      elements: data.elements ?? [],
      appState: {
        ...appState,
        exportBackground: true,
        viewBackgroundColor: appState.viewBackgroundColor || '#ffffff' // markpad 对齐：空串同回退
      },
      files: data.files ?? null
    }
  });
  return svg.outerHTML;
}

/** bpmn（bpmn-js@18.31.0 lib/NavigatedViewer.js 子路径 +esm）：不传 container 由
 * viewer 自建；importXML → saveSVG → destroy（markpad 同款调用序）。 */
export async function renderBpmnCdn(source: string): Promise<string> {
  const mod = (await loader(`${CDN}/bpmn-js@18.31.0/lib/NavigatedViewer.js/+esm`)) as {
    default: new () => {
      importXML: (xml: string) => Promise<unknown>;
      saveSVG: () => Promise<{ svg: string }>;
      destroy: () => void;
    };
  };
  const viewer = new mod.default();
  try {
    await viewer.importXML(source);
    const { svg } = await viewer.saveSVG();
    return svg;
  } finally {
    viewer.destroy();
  }
}

/** vega/vega-lite（vega-embed@7.3.0）：svg renderer 直出字符串，容器不入文档。 */
export async function renderVegaCdn(source: string): Promise<string> {
  const mod = (await loader(`${CDN}/vega-embed@7.3.0/+esm`)) as {
    default: (el: HTMLElement, spec: unknown, opts?: { renderer: string; actions?: boolean }) => Promise<unknown>;
  };
  const el = document.createElement('div');
  await mod.default(el, JSON.parse(source), { renderer: 'svg', actions: false });
  const svg = el.querySelector('svg');
  if (!svg) throw new Error('vega 渲染失败');
  return svg.outerHTML;
}

/** graphviz hpcc 渲染器（spec 2026-10-23 §9.1）：@hpcc-js/wasm-graphviz@1.30.0
 *（wasm 内嵌单文件，jsdelivr +esm 直链可用——2026-10-23 HEAD 200 实证；spec §9.1
 * 的「wasm-graphograf」为笔误，计划已勘误）。Graphviz.load() 拿实例后
 * layout(source, 'svg', 'dot')，finally dispose 释放 wasm 实例（失败同样释放）。 */
export async function renderGraphvizHpcc(source: string): Promise<string> {
  const mod = (await loader(`${CDN}/@hpcc-js/wasm-graphviz@1.30.0/+esm`)) as {
    Graphviz: { load: () => Promise<{ layout: (src: string, fmt?: string, engine?: string) => Promise<string>; dispose: () => void }> };
  };
  const g = await mod.Graphviz.load();
  try {
    return await g.layout(source, 'svg', 'dot');
  } finally {
    g.dispose();
  }
}

// ---------- spec 2026-10-23 §10 四新引擎（API 均 2026-10-23 实测勘定） ----------

/** wavedrom（wavedrom@3.7.0）：renderAny+onml 无 DOM 路径直出 SVG（Node 实测，
 * jsdelivr 主入口 lib/index.js 与 unpkg bundle 同导出面：renderAny/waveSkin/onml）。
 * brief 骨架的 renderWaveForm DOM 路径弃用留案：3.7.0 真实签名为
 * renderWaveForm(index, source, outputId: string)——第三参是元素 id 字符串（内部
 * document.getElementById(outputId + index)）且皮肤取 window.WaveSkin，与骨架的
 * (0, source, el: HTMLElement) 元素参数形态不符，故采无 DOM 案。
 * seq 递增做 svg id（svgcontent_N）唯一化：renderAny 按此 index 写根 id 且会改写
 * 共享 skin 对象属性，同页多图必须各给独立 index（mermaidSeq 同款先例）。
 * wavejson 按 JSON 解析（highlightLang=json 口径）：JSON5 宽松语法 parse 失败即抛错
 * 走回退链（kroki 服务端兜底）；非 signal/assign/reg 源 renderAny 不抛错而回落
 * ['div'] 树，须显式守卫根标签为 svg。 */
let wavedromSeq = 0;
export async function renderWavedromCdn(source: string): Promise<string> {
  const mod = (await loader(`${CDN}/wavedrom@3.7.0/+esm`)) as {
    renderAny: (index: number, source: unknown, waveSkin: unknown) => unknown[];
    waveSkin: unknown;
    onml: { stringify: (tree: unknown[]) => string };
  };
  const tree = mod.renderAny((wavedromSeq += 1), JSON.parse(source), mod.waveSkin);
  if (tree[0] !== 'svg') throw new Error('wavedrom 渲染失败');
  return mod.onml.stringify(tree);
}

/** bytefield（bytefield-svg@1.11.0）：default 导出生成函数，embedded:true 去
 * <?xml?> 序言直出 <svg>（HTML 内联注入同 vega/bpmn 产物口径）。1.x 语法注意：
 * draw-box 宽度须属性表 {:span 4} 形态（实测 "(draw-box "A" 4)" 报
 * Invalid attribute spec；kroki 服务端同款语义，spec §10 已注）。 */
export async function renderBytefieldCdn(source: string): Promise<string> {
  const mod = (await loader(`${CDN}/bytefield-svg@1.11.0/+esm`)) as {
    default: (src: string, opts?: { embedded?: boolean }) => string;
  };
  return mod.default(source, { embedded: true });
}

/** dbml（@softwaretechnik/dbml-renderer@1.0.31）：run(source, 'svg') 同步直出
 * 字符串（实测非 Promise）；产物带头 <?xml?> 序言且无 embedded 选项，正则剥离
 * 对齐 bytefield embedded 口径。语法错误抛错走回退链（kroki 兜底）。 */
export async function renderDbmlCdn(source: string): Promise<string> {
  const mod = (await loader(`${CDN}/@softwaretechnik/dbml-renderer@1.0.31/+esm`)) as {
    run: (src: string, format: string) => string;
  };
  return mod.run(source, 'svg').replace(/^<\?xml[^?]*\?>\s*/, '');
}

/** d2（@d2lang/d2@0.1.34 官方 wasm，play.d2lang.com 同款）：compile(source) →
 * {diagram, renderOptions} → render(diagram, options)。render 首参必传 compile
 * 产物 diagram（官方 README 用法；brief 骨架的零参 render() 不成立——d.ts
 * render(diagram: Diagram, options?) 为必填首位）。noXMLTag:true 去 <?xml?> 序言
 *（README 钦定「直接 HTML 嵌入」选项）；dispose 释放 backing worker（finally，
 * 官方声明重复调用安全，失败同样释放）。11.5MB 太重不做默认本地档（spec §10，
 * 注册表 defaultMode=kroki）。 */
export async function renderD2Cdn(source: string): Promise<string> {
  const mod = (await loader(`${CDN}/@d2lang/d2@0.1.34/+esm`)) as {
    D2: new () => {
      compile: (src: string) => Promise<{ diagram: unknown; renderOptions?: Record<string, unknown> }>;
      render: (diagram: unknown, opts?: Record<string, unknown>) => Promise<string>;
      dispose: () => Promise<void>;
    };
  };
  const d2 = new mod.D2();
  try {
    const result = await d2.compile(source);
    return await d2.render(result.diagram, { ...result.renderOptions, noXMLTag: true });
  } finally {
    await d2.dispose();
  }
}
