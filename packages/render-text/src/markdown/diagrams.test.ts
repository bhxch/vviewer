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
  it('本期 local 启用集 = mermaid/graphviz/nomnoml/math，其余 kroki 兜底', () => {
    const localIds = DIAGRAM_TYPES.filter((t) => t.local).map((t) => t.id).sort();
    expect(localIds).toEqual(['graphviz', 'math', 'mermaid', 'nomnoml']);
    expect(resolveDiagramType('vega')!.defaultMode).toBe('kroki');
  });
});

describe('createKrokiUrl', () => {
  it('默认 host 与 URL 形态', () => {
    const url = createKrokiUrl('', 'graphviz', 'digraph{}');
    expect(url.startsWith(`${DEFAULT_KROKI_HOST}/graphviz/svg/`)).toBe(true);
  });
  it('host 尾斜杠归一', () => {
    const url = createKrokiUrl('https://k.example.com/', 'dot', 'x');
    // krokiType 由调用方传归一名；host 尾斜杠剥离
    expect(url.startsWith('https://k.example.com/dot/svg/')).toBe(true);
  });
  it('base64url 编码可解码还原（deflate 往返）', () => {
    const source = 'digraph { a -> b }';
    const url = createKrokiUrl(DEFAULT_KROKI_HOST, 'graphviz', source);
    const b64 = url.split('/svg/')[1]!;
    const std = b64.replace(/-/g, '+').replace(/_/g, '/');
    const bin = Buffer.from(std, 'base64');
    expect(inflateSync(new Uint8Array(bin)).toString()).toBe(source);
  });
});
