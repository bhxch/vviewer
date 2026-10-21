// diagrams.ts — 图表注册表与 kroki 编码（spec 2026-10-19 §2.1/§2.2）。
// 类型清单/别名对齐 markpad src/lib/diagrams.ts；local 启用集按 spec §2.6
// 预算裁决仅 graphviz/nomnoml（mermaid/math 既有），其余 kroki/源码覆盖。

export type DiagramMode = 'local' | 'kroki' | 'source';

export interface DiagramType {
  id: string;
  aliases: readonly string[];
  /** 本期是否内置本地引擎依赖（Global Constraints 启用集） */
  local: boolean;
  defaultMode: DiagramMode;
  /** kroki 服务端类型名；'' = kroki 不支持（如 math） */
  krokiType: string;
  /** 源码模式/图源切换的高亮语言（'' = 不高亮） */
  highlightLang: string;
  engine?: 'mermaid' | 'graphviz' | 'nomnoml' | 'math';
}

export const DIAGRAM_TYPES: readonly DiagramType[] = [
  { id: 'mermaid', aliases: [], local: true, defaultMode: 'local', krokiType: 'mermaid', highlightLang: 'mermaid', engine: 'mermaid' },
  { id: 'graphviz', aliases: ['dot'], local: true, defaultMode: 'local', krokiType: 'graphviz', highlightLang: 'dot', engine: 'graphviz' },
  { id: 'plantuml', aliases: [], local: false, defaultMode: 'kroki', krokiType: 'plantuml', highlightLang: 'plantuml' },
  { id: 'c4plantuml', aliases: [], local: false, defaultMode: 'kroki', krokiType: 'c4plantuml', highlightLang: 'plantuml' },
  { id: 'ditaa', aliases: [], local: false, defaultMode: 'kroki', krokiType: 'ditaa', highlightLang: '' },
  { id: 'blockdiag', aliases: [], local: false, defaultMode: 'kroki', krokiType: 'blockdiag', highlightLang: '' },
  { id: 'nwdiag', aliases: [], local: false, defaultMode: 'kroki', krokiType: 'nwdiag', highlightLang: '' },
  { id: 'actdiag', aliases: [], local: false, defaultMode: 'kroki', krokiType: 'actdiag', highlightLang: '' },
  { id: 'seqdiag', aliases: [], local: false, defaultMode: 'kroki', krokiType: 'seqdiag', highlightLang: '' },
  { id: 'erd', aliases: [], local: false, defaultMode: 'kroki', krokiType: 'erd', highlightLang: '' },
  { id: 'pikchr', aliases: [], local: false, defaultMode: 'kroki', krokiType: 'pikchr', highlightLang: '' },
  { id: 'svgbob', aliases: [], local: false, defaultMode: 'kroki', krokiType: 'svgbob', highlightLang: '' },
  { id: 'excalidraw', aliases: [], local: false, defaultMode: 'kroki', krokiType: 'excalidraw', highlightLang: 'json' },
  { id: 'nomnoml', aliases: [], local: true, defaultMode: 'local', krokiType: 'nomnoml', highlightLang: '', engine: 'nomnoml' },
  { id: 'bpmn', aliases: [], local: false, defaultMode: 'kroki', krokiType: 'bpmn', highlightLang: 'xml' },
  { id: 'vega', aliases: [], local: false, defaultMode: 'kroki', krokiType: 'vega', highlightLang: 'json' },
  { id: 'vegalite', aliases: ['vega-lite'], local: false, defaultMode: 'kroki', krokiType: 'vegalite', highlightLang: 'json' },
  { id: 'math', aliases: ['latex'], local: true, defaultMode: 'local', krokiType: '', highlightLang: 'latex', engine: 'math' }
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
