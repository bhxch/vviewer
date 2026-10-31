// packages/vviewer-render-diagram/src/markdown/diagrams.test.ts
import { describe, expect, it } from 'vitest';
import { inflateRawSync, inflateSync } from 'node:zlib';
import { DIAGRAM_TYPES, DEFAULT_KROKI_HOST, DEFAULT_PLANTUML_HOST, createKrokiUrl, createPlantumlUrl, resolveDiagramType } from './diagrams';

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
  it('本期 local 启用集 = 前端包 4 类 + wasm svgbob + CDN 八类（spec §7/§6/§10 翻转），其余 kroki 兜底', () => {
    const localIds = DIAGRAM_TYPES.filter((t) => t.local).map((t) => t.id).sort();
    expect(localIds).toEqual([
      'bpmn', 'bytefield', 'd2', 'dbml', 'excalidraw', 'graphviz', 'math', 'mermaid', 'nomnoml', 'svgbob', 'vega', 'vegalite', 'wavedrom'
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

describe('注册表扩容 30 类（spec 2026-10-23 §10）', () => {
  it('总数 30（kroki v0.33.0 官方注册表对齐；diagramsnet/lini/protobuf 不注册）', () => {
    expect(DIAGRAM_TYPES).toHaveLength(30);
    for (const id of ['wavedrom', 'bytefield', 'dbml', 'd2', 'packetdiag', 'rackdiag', 'goat', 'wireviz', 'structurizr', 'symbolator', 'tikz', 'umlet']) {
      expect(resolveDiagramType(id), id).not.toBeNull();
    }
    expect(resolveDiagramType('diagramsnet')).toBeNull();
    expect(resolveDiagramType('lini')).toBeNull();
    expect(resolveDiagramType('protobuf')).toBeNull();
  });

  it('四个新本地引擎行：local:true、defaultMode local（d2 例外 kroki）、engine 同 id', () => {
    for (const id of ['wavedrom', 'bytefield', 'dbml', 'd2']) {
      const t = resolveDiagramType(id)!;
      expect(t.local, id).toBe(true);
      expect(t.engine, id).toBe(id);
      expect(t.krokiType, id).toBe(id); // krokiType=id（spec §10）
    }
    expect(resolveDiagramType('wavedrom')!.defaultMode).toBe('local');
    expect(resolveDiagramType('bytefield')!.defaultMode).toBe('local');
    expect(resolveDiagramType('dbml')!.defaultMode).toBe('local');
    // d2：官方 wasm 11.5MB 太重不做默认本地档（spec §10 拍板）
    expect(resolveDiagramType('d2')!.defaultMode).toBe('kroki');
  });

  it('kroki-only 八行：无引擎、defaultMode kroki、krokiType=id', () => {
    for (const id of ['packetdiag', 'rackdiag', 'goat', 'wireviz', 'structurizr', 'symbolator', 'tikz', 'umlet']) {
      const t = resolveDiagramType(id)!;
      expect(t.local, id).toBe(false);
      expect(t.engine, id).toBeUndefined();
      expect(t.defaultMode, id).toBe('kroki');
      expect(t.krokiType, id).toBe(id);
    }
  });

  it('highlightLang 逐值（spec §10）：wavedrom json/bytefield clojure/dbml sql/tikz latex/wireviz yaml/structurizr groovy，d2 等余量空串', () => {
    expect(resolveDiagramType('wavedrom')!.highlightLang).toBe('json');
    expect(resolveDiagramType('bytefield')!.highlightLang).toBe('clojure');
    expect(resolveDiagramType('dbml')!.highlightLang).toBe('sql');
    expect(resolveDiagramType('tikz')!.highlightLang).toBe('latex');
    expect(resolveDiagramType('wireviz')!.highlightLang).toBe('yaml');
    expect(resolveDiagramType('structurizr')!.highlightLang).toBe('groovy');
    for (const id of ['d2', 'goat', 'symbolator', 'umlet', 'packetdiag', 'rackdiag']) {
      expect(resolveDiagramType(id)!.highlightLang, id).toBe('');
    }
  });

  it('aliases 无新增（kroki 无额外官方别名）：别名集仍仅 dot/vega-lite/latex', () => {
    const withAliases = DIAGRAM_TYPES.filter((t) => t.aliases.length > 0).map((t) => `${t.id}:${t.aliases.join(',')}`);
    expect(withAliases).toEqual(['graphviz:dot', 'vegalite:vega-lite', 'math:latex']);
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

describe('createPlantumlUrl（官方服务器 fallback 档，2026-10-30）', () => {
  it('URL 形态：官方 host + /svg/ 段 + PlantUML 自定义字母表（非 base64url 的 -_ 语义重排）', async () => {
    const url = await createPlantumlUrl('@startuml\nA -> B\n@enduml');
    expect(url.startsWith(`${DEFAULT_PLANTUML_HOST}/svg/`)).toBe(true);
    // 官方字母表 0-9A-Za-z-_：段内字符集同 base64url 无填充形态，但编码值不同
    //（kroki 的 base64url 与官方编码对同源恒异串，此处以实锚向量守卫）
    const seg = url.split('/svg/')[1]!;
    expect(seg).toMatch(/^[0-9A-Za-z_-]+$/);
  });

  it('编码实锚向量：官方服务器同款源 → 官方文档经典编码串（2026-10-30 curl 200+svg 实测）', async () => {
    // 尾换行的 fence 源（管线 kroki 步剥尾换行同款载荷）经 deflateRaw+自定义 base64
    const url = await createPlantumlUrl('@startuml\nBob -> Alice : hello\n@enduml\n');
    expect(url).toBe(`${DEFAULT_PLANTUML_HOST}/svg/SoWkIImgAStDuNBAJrBGjLDmpCbCJbMmKiX8pSd9vt98pKi1IG80`);
  });

  it('raw deflate 往返：自定义字母表逆映射 → inflateRaw 还原原文（无 zlib 头）', async () => {
    const source = 'Bob -> Alice : fallback';
    const seg = (await createPlantumlUrl(source)).split('/svg/')[1]!;
    // 逆映射：官方字母表索引 → 标准字母表字符 → base64 解码（需补回填充）
    const PLANTUML_B64 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_';
    const STD_B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const std = seg.replace(/[0-9A-Za-z_-]/g, (c) => STD_B64[PLANTUML_B64.indexOf(c)]!);
    const bin = Buffer.from(std, 'base64');
    expect(inflateRawSync(new Uint8Array(bin)).toString()).toBe(source);
  });

  it('官方服务器可承接类型带 officialServer 旗标（显式档+回落目标双消费面），其余类型不带', () => {
    expect(resolveDiagramType('plantuml')!.officialServer).toBe(true);
    expect(resolveDiagramType('c4plantuml')!.officialServer).toBe(true);
    for (const id of ['mermaid', 'graphviz', 'ditaa', 'd2', 'structurizr', 'tikz']) {
      expect(resolveDiagramType(id)!.officialServer, id).toBeUndefined();
    }
    expect(DIAGRAM_TYPES.filter((t) => t.officialServer).map((t) => t.id)).toEqual(['plantuml', 'c4plantuml']);
  });
});
