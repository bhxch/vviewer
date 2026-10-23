// packages/render-text/src/markdown/diagrams.test.ts
import { describe, expect, it } from 'vitest';
import { inflateSync } from 'node:zlib';
import { DIAGRAM_TYPES, DEFAULT_KROKI_HOST, createKrokiUrl, resolveDiagramType } from './diagrams';

describe('resolveDiagramType', () => {
  it('主名命中（大小写归一）', () => {
    expect(resolveDiagramType('Mermaid')?.id).toBe('mermaid');
    expect(resolveDiagramType('graphviz')?.id).toBe('graphviz');
  });
  it('别名命中：dot/vega-lite/latex', () => {
    expect(resolveDiagramType('dot')?.id).toBe('graphviz');
    expect(resolveDiagramType('vega-lite')?.id).toBe('vegalite');
    expect(resolveDiagramType('latex')?.id).toBe('math');
  });
  it('空与非图表语言返回 null', () => {
    expect(resolveDiagramType('')).toBeNull();
    expect(resolveDiagramType('rust')).toBeNull();
  });
  it('注册表覆盖 spec 11+1 类', () => {
    for (const id of ['mermaid','graphviz','plantuml','c4plantuml','ditaa','blockdiag','nwdiag','actdiag','seqdiag','erd','pikchr','svgbob','excalidraw','nomnoml','bpmn','vega','vegalite','math']) {
      expect(resolveDiagramType(id), id).not.toBeNull();
    }
  });
  it('本期 local 启用集 = 前端包 4 类 + wasm svgbob + CDN 四类（spec §7/§6 翻转），其余 kroki 兜底', () => {
    const localIds = DIAGRAM_TYPES.filter((t) => t.local).map((t) => t.id).sort();
    expect(localIds).toEqual([
      'bpmn', 'excalidraw', 'graphviz', 'math', 'mermaid', 'nomnoml', 'svgbob', 'vega', 'vegalite'
    ]);
    expect(resolveDiagramType('plantuml')!.defaultMode).toBe('kroki');
  });
  it('svgbob 注册表翻转 local 默认（spec §7）', () => {
    const t = resolveDiagramType('svgbob')!;
    expect(t.local).toBe(true);
    expect(t.engine).toBe('svgbob');
    expect(t.defaultMode).toBe('local');
  });
  it('CDN 四类注册表翻转 local 默认（spec §6）：excalidraw/bpmn/vega/vegalite', () => {
    for (const id of ['excalidraw', 'bpmn', 'vega', 'vegalite']) {
      const t = resolveDiagramType(id)!;
      expect(t.local, id).toBe(true);
      expect(t.engine, id).toBe(id);
      expect(t.defaultMode, id).toBe('local');
    }
  });
  it('多渲染器选择面（spec 2026-10-23 §9.1）：graphviz viz-js/hpcc 且首项为默认；其余类型单渲染器', () => {
    const g = resolveDiagramType('graphviz')!;
    expect(g.renderers).toEqual(['viz-js', 'hpcc']); // 首项 viz-js = 默认渲染器
    expect(g.renderers![0]).toBe('viz-js');
    // 无 renderers 的类型（如 mermaid）undefined——设置面不显示渲染器列、白名单拒绝任何值
    expect(resolveDiagramType('mermaid')!.renderers).toBeUndefined();
    const withRenderers = DIAGRAM_TYPES.filter((t) => t.renderers?.length).map((t) => t.id);
    expect(withRenderers).toEqual(['graphviz']); // 本期仅 graphviz 双渲染器
  });
});

describe('createKrokiUrl', () => {
  it('默认 host 与 URL 形态', async () => {
    const url = await createKrokiUrl('', 'graphviz', 'digraph{}');
    expect(url.startsWith(`${DEFAULT_KROKI_HOST}/graphviz/svg/`)).toBe(true);
  });
  it('host 尾斜杠归一', async () => {
    const url = await createKrokiUrl('https://k.example.com/', 'dot', 'x');
    // krokiType 由调用方传归一名；host 尾斜杠剥离
    expect(url.startsWith('https://k.example.com/dot/svg/')).toBe(true);
  });
  it('base64url 编码可解码还原（deflate 往返）', async () => {
    const source = 'digraph { a -> b }';
    const url = await createKrokiUrl(DEFAULT_KROKI_HOST, 'graphviz', source);
    const b64 = url.split('/svg/')[1]!;
    const std = b64.replace(/-/g, '+').replace(/_/g, '/');
    const bin = Buffer.from(std, 'base64');
    expect(inflateSync(new Uint8Array(bin)).toString()).toBe(source);
  });
});
