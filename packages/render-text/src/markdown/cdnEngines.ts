// cdnEngines.ts — CDN 直链图表引擎（spec §6）：jsdelivr +esm 精确版本，dist 零增量。
// 版本钉死与 markpad src/lib/localRenderers.ts 对齐（2026-10-23 实测）；
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
    appState?: Record<string, unknown>;
    files?: Record<string, unknown> | null;
  };
  const appState = data.appState ?? {};
  const svg = await mod.exportToSvg({
    data: {
      elements: data.elements ?? [],
      appState: {
        ...appState,
        exportBackground: true,
        viewBackgroundColor:
          typeof appState.viewBackgroundColor === 'string' ? appState.viewBackgroundColor : '#ffffff'
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
