// diagrams.ts — 图表注册表与 kroki 编码（spec 2026-10-19 §2.1/§2.2）。
// 类型清单/别名对齐 kroki v0.33.0 官方注册表（30 类，spec 2026-10-23 §10）；
// local 启用集按 spec §2.6/§7/§6/§10：前端包引擎 graphviz/nomnoml + 既有 mermaid/math
// + wasm svgbob（§7）+ CDN 直链 excalidraw/bpmn/vega/vegalite/wavedrom/bytefield/dbml/d2
//（§6/§10），其余 kroki/源码覆盖。

export type DiagramMode = 'local' | 'kroki' | 'server' | 'source';

export interface DiagramType {
  id: string;
  aliases: readonly string[];
  /** 本期是否内置本地引擎依赖（Global Constraints 启用集；spec §6 起含 CDN 直链四类） */
  local: boolean;
  defaultMode: DiagramMode;
  /** kroki 服务端类型名；'' = kroki 不支持（如 math） */
  krokiType: string;
  /** 源码模式/图源切换的高亮语言（'' = 不高亮） */
  highlightLang: string;
  /** 本地引擎 id：mermaid/graphviz/nomnoml/math 前端包，svgbob wasm，
   * excalidraw/bpmn/vega/vegalite/wavedrom/bytefield/dbml/d2 走 jsdelivr CDN 直链
   *（cdnEngines.ts，spec §6/§10） */
  engine?: 'mermaid' | 'graphviz' | 'nomnoml' | 'math' | 'svgbob' | 'excalidraw' | 'bpmn' | 'vega' | 'vegalite' | 'wavedrom' | 'bytefield' | 'dbml' | 'd2';
  /** 服务端单图渲染端点形态（spec 2026-10-23 §8.3：/api/compute/diagram 的
   * NATIVE 子集）；仅设置面「服务端」选项显隐消费，运行时能力以 health
   * diagrams 子集协商为准（serverDiagramOf 注入，注册表旗标不裁决运行时）。 */
  server?: boolean;
  /** 多渲染器选择面（spec 2026-10-23 §9.1）：本地引擎可选实现 id 列表，首项为
   * 默认渲染器（settings.diagrams.renderers 空/未命中即首项语义）。undefined/空 =
   * 单渲染器（设置面不显示渲染器列，settings 白名单按本表裁决值合法性）。 */
  renderers?: readonly string[];
}

export const DIAGRAM_TYPES: readonly DiagramType[] = [
  { id: 'mermaid', aliases: [], local: true, defaultMode: 'local', krokiType: 'mermaid', highlightLang: 'mermaid', engine: 'mermaid' },
  { id: 'graphviz', aliases: ['dot'], local: true, defaultMode: 'local', krokiType: 'graphviz', highlightLang: 'dot', engine: 'graphviz', server: true, renderers: ['viz-js', 'hpcc'] },
  { id: 'plantuml', aliases: [], local: false, defaultMode: 'kroki', krokiType: 'plantuml', highlightLang: 'plantuml' },
  { id: 'c4plantuml', aliases: [], local: false, defaultMode: 'kroki', krokiType: 'c4plantuml', highlightLang: 'plantuml' },
  { id: 'ditaa', aliases: [], local: false, defaultMode: 'kroki', krokiType: 'ditaa', highlightLang: '' },
  { id: 'blockdiag', aliases: [], local: false, defaultMode: 'kroki', krokiType: 'blockdiag', highlightLang: '' },
  { id: 'nwdiag', aliases: [], local: false, defaultMode: 'kroki', krokiType: 'nwdiag', highlightLang: '' },
  { id: 'actdiag', aliases: [], local: false, defaultMode: 'kroki', krokiType: 'actdiag', highlightLang: '' },
  { id: 'seqdiag', aliases: [], local: false, defaultMode: 'kroki', krokiType: 'seqdiag', highlightLang: '' },
  { id: 'erd', aliases: [], local: false, defaultMode: 'kroki', krokiType: 'erd', highlightLang: '' },
  { id: 'pikchr', aliases: [], local: false, defaultMode: 'kroki', krokiType: 'pikchr', highlightLang: '' },
  { id: 'svgbob', aliases: [], local: true, defaultMode: 'local', krokiType: 'svgbob', highlightLang: '', engine: 'svgbob', server: true },
  { id: 'excalidraw', aliases: [], local: true, defaultMode: 'local', krokiType: 'excalidraw', highlightLang: 'json', engine: 'excalidraw' },
  { id: 'nomnoml', aliases: [], local: true, defaultMode: 'local', krokiType: 'nomnoml', highlightLang: '', engine: 'nomnoml' },
  { id: 'bpmn', aliases: [], local: true, defaultMode: 'local', krokiType: 'bpmn', highlightLang: 'xml', engine: 'bpmn' },
  { id: 'vega', aliases: [], local: true, defaultMode: 'local', krokiType: 'vega', highlightLang: 'json', engine: 'vega' },
  { id: 'vegalite', aliases: ['vega-lite'], local: true, defaultMode: 'local', krokiType: 'vegalite', highlightLang: 'json', engine: 'vegalite' },
  { id: 'math', aliases: ['latex'], local: true, defaultMode: 'local', krokiType: '', highlightLang: 'latex', engine: 'math' },
  // —— spec 2026-10-23 §10 扩容（18→30）：四个新 CDN 本地引擎 + 八个 kroki-only。
  // krokiType=id（kroki v0.33.0 官方端点名）；aliases 无新增（kroki 无额外官方别名）。
  { id: 'wavedrom', aliases: [], local: true, defaultMode: 'local', krokiType: 'wavedrom', highlightLang: 'json', engine: 'wavedrom' },
  { id: 'bytefield', aliases: [], local: true, defaultMode: 'local', krokiType: 'bytefield', highlightLang: 'clojure', engine: 'bytefield' },
  { id: 'dbml', aliases: [], local: true, defaultMode: 'local', krokiType: 'dbml', highlightLang: 'sql', engine: 'dbml' },
  // d2：官方 wasm 11.5MB 太重不做默认本地档（spec §10 拍板），defaultMode kroki
  { id: 'd2', aliases: [], local: true, defaultMode: 'kroki', krokiType: 'd2', highlightLang: '', engine: 'd2' },
  // kroki-only 八类（spec §10）：无本地引擎，kroki / source 双通道
  { id: 'packetdiag', aliases: [], local: false, defaultMode: 'kroki', krokiType: 'packetdiag', highlightLang: '' },
  { id: 'rackdiag', aliases: [], local: false, defaultMode: 'kroki', krokiType: 'rackdiag', highlightLang: '' },
  { id: 'goat', aliases: [], local: false, defaultMode: 'kroki', krokiType: 'goat', highlightLang: '' },
  { id: 'wireviz', aliases: [], local: false, defaultMode: 'kroki', krokiType: 'wireviz', highlightLang: 'yaml' },
  { id: 'structurizr', aliases: [], local: false, defaultMode: 'kroki', krokiType: 'structurizr', highlightLang: 'groovy' },
  { id: 'symbolator', aliases: [], local: false, defaultMode: 'kroki', krokiType: 'symbolator', highlightLang: '' },
  { id: 'tikz', aliases: [], local: false, defaultMode: 'kroki', krokiType: 'tikz', highlightLang: 'latex' },
  { id: 'umlet', aliases: [], local: false, defaultMode: 'kroki', krokiType: 'umlet', highlightLang: '' }
];

const byId = new Map<string, DiagramType>();
for (const t of DIAGRAM_TYPES) {
  byId.set(t.id, t);
  for (const a of t.aliases) byId.set(a, t);
}

/** fence 语言 → 图表类型（小写归一；空串/非图表语言 null）。 */
export function resolveDiagramType(lang: string): DiagramType | null {
  const l = lang.trim().toLowerCase();
  return l ? (byId.get(l) ?? null) : null;
}

export const DEFAULT_KROKI_HOST = 'https://kroki.io';

/**
 * kroki URL：pako deflate(level 9) + base64url（无填充）。host 尾斜杠归一。
 * 4-1：pako 主包静态导入退役——kroki 编码惰性化，非 kroki 文档不再进主图。
 */
export async function createKrokiUrl(host: string, krokiType: string, source: string): Promise<string> {
  const base = (host || DEFAULT_KROKI_HOST).replace(/\/+$/, '');
  const { default: pako } = await import('pako');
  const bytes = pako.deflate(new TextEncoder().encode(source), { level: 9 });
  let str = '';
  for (let i = 0; i < bytes.length; i += 1) str += String.fromCharCode(bytes[i]!);
  const b64 = btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${base}/${krokiType}/svg/${b64}`;
}
