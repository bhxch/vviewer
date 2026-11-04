// diagramFile.test.ts — Task 3（spec 2026-11-04-file-viewer-integration §5.1）：
// 图表文件渲染器注册面锚——映射表逐字一致、扩展名跨型去重、fresh registry 零
// RegistryError 安装、byExtension 大小写归一、与既有 owner（markdown/html/jsonl）
// 不撞。Task 4 追加渲染路径行为锚（§5.2）：三分发 local/kroki/server、失败回退链
// （local 无引擎→kroki→源码+提示）、2MB 大小门、源码/渲染切换；引擎层（包边界）
// 桩 renderDiagramEngine/createKrokiUrl/createPlantumlUrl，注册表 resolveDiagramType
// 保持真身；模式注入经 setDiagramOptions 真通道（不 mock markdown 包，与装配点
// viewer.ts 同一注入面）。装配序锚在 Task 5（viewer.ts 先 diagram 后 generated）。
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRegistry, GENERATED_EXTENSIONS, type Detection, type FileSource, type RenderedInstance } from '@bhxch/vviewer-core';
import {
  resolveDiagramType,
  DEFAULT_KROKI_HOST,
  renderDiagramEngine,
  createKrokiUrl,
  createPlantumlUrl,
  renderMermaidInto,
  type DiagramMode,
  type MermaidTheme
} from '@bhxch/vviewer-render-diagram';
import { setDiagramOptions, type DiagramRenderOptions } from '@bhxch/vviewer-markdown';
import { markdownRenderer } from '../src/markdown/markdownRenderer';
import { htmlRenderer } from '../src/html';
import { jsonlRenderer } from '../src/jsonl/index';
import { codeRenderer, renderCode, type RenderCodeHandle } from '../src/code';
import { DIAGRAM_FILE_EXTS, createDiagramFileRenderers, type DiagramFileRenderOpts } from '../src/diagramFile';

// 引擎层包边界桩（spread real 保留注册表/编码等其余导出，注册面测试不受影响）：
// renderDiagramEngine/createKrokiUrl/createPlantumlUrl 缺省实现于 beforeEach 统一给
// 值，失败分支逐测覆盖。
vi.mock('@bhxch/vviewer-render-diagram', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    renderDiagramEngine: vi.fn(),
    createKrokiUrl: vi.fn(),
    createPlantumlUrl: vi.fn(),
    renderMermaidInto: vi.fn()
  };
});

// renderCode 包装为透传 spy（real 实现不变，其余测试行为不受影响）：M3 重挂锚需要
// 观测 diagramFile 对旧 code 实例的 destroy 流转（mockImplementationOnce 换桩句柄）。
vi.mock('../src/code', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/code')>();
  return { ...real, renderCode: vi.fn(real.renderCode) };
});

/**
 * spec 2026-11-04 §5.1 表逐字内联（防实现漂移）。29 型（diagram 注册表全集去
 * math——.tex 维持 latex 源码高亮；drawio 不在注册表归批次三），标「造」= 无通行
 * 扩展名按类型同名（或格式约定 umlet→uxf）注册。表行：
 *   mermaid=mermaid,mmd ｜ plantuml=plantuml,puml ／ c4plantuml=c4plantuml（造）｜
 *   graphviz=dot,gv ｜ d2=d2 ｜ dbml=dbml ｜ vega=vega,vg ／ vegalite=vl（后两个造）｜
 *   excalidraw=excalidraw ｜ bpmn=bpmn ｜ nomnoml=nomnoml（造）｜ svgbob=svgbob ｜
 *   pikchr=pikchr ｜ ditaa=ditaa ｜ blockdiag/nwdiag/actdiag/seqdiag 同名（造）｜
 *   erd=erd ｜ structurizr=dsl ｜ bytefield=bytefield（造）｜ wavedrom=wavedrom（造）｜
 *   tikz=tikz（造）｜ umlet=uxf（格式约定）｜ goat=goat（造）｜ wireviz=wireviz（造）｜
 *   packetdiag/rackdiag 同名（造）｜ symbolator=symbolator（造）
 * 注：spec §5.1 标题写「31 扩展名」，但其表行逐行累加为 33——两处含「/」的行
 * （plantuml/c4plantuml、vega/vegalite）各 3 个扩展名，「31」疑为把该两行按 2 计的
 * 笔误。表行才是逐字规范面（task-3-brief：「Each row's extension list is exact」），
 * 此处按表行实测值锚定，防止实现按错误总数漏绑扩展名。
 */
const EXPECTED_EXTS: Readonly<Record<string, readonly string[]>> = {
  mermaid: ['mermaid', 'mmd'],
  plantuml: ['plantuml', 'puml'],
  c4plantuml: ['c4plantuml'],
  graphviz: ['dot', 'gv'],
  d2: ['d2'],
  dbml: ['dbml'],
  vega: ['vega', 'vg'],
  vegalite: ['vl'],
  excalidraw: ['excalidraw'],
  bpmn: ['bpmn'],
  nomnoml: ['nomnoml'],
  svgbob: ['svgbob'],
  pikchr: ['pikchr'],
  ditaa: ['ditaa'],
  blockdiag: ['blockdiag'],
  nwdiag: ['nwdiag'],
  actdiag: ['actdiag'],
  seqdiag: ['seqdiag'],
  erd: ['erd'],
  structurizr: ['dsl'],
  bytefield: ['bytefield'],
  wavedrom: ['wavedrom'],
  tikz: ['tikz'],
  umlet: ['uxf'],
  goat: ['goat'],
  wireviz: ['wireviz'],
  packetdiag: ['packetdiag'],
  rackdiag: ['rackdiag'],
  symbolator: ['symbolator']
};

const TYPES = Object.keys(EXPECTED_EXTS);
const ALL_EXTS = TYPES.flatMap((t) => [...(EXPECTED_EXTS[t] ?? [])]);

describe('diagramFile 注册面（spec 2026-11-04 §5.1）', () => {
  it('映射表全锚：29 型 resolveDiagramType 均非空，DIAGRAM_FILE_EXTS 与 spec 表逐字一致', () => {
    expect(TYPES).toHaveLength(29);
    for (const type of TYPES) {
      const diagram = resolveDiagramType(type);
      expect(diagram, `resolveDiagramType(${type})`).not.toBeNull();
      expect(diagram!.id, type).toBe(type);
      expect([...(DIAGRAM_FILE_EXTS[type] ?? [])], `DIAGRAM_FILE_EXTS.${type}`).toEqual(EXPECTED_EXTS[type]);
    }
    // 无多余键：映射表键集与 29 型全集精确相等
    expect(Object.keys(DIAGRAM_FILE_EXTS).slice().sort()).toEqual(TYPES.slice().sort());
  });

  it('扩展名跨型去重：全表扁平化无重复（表行实测 33 个）', () => {
    const all = TYPES.flatMap((t) => [...(DIAGRAM_FILE_EXTS[t] ?? [])]);
    expect(all).toHaveLength(ALL_EXTS.length);
    expect(new Set(all).size, '存在跨型重复扩展名').toBe(all.length);
  });

  it('既有 owner 扩展名（md/markdown/html/htm/jsonl/ndjson/svg）不入映射表', () => {
    const owned = ['md', 'markdown', 'html', 'htm', 'jsonl', 'ndjson', 'svg'];
    const all = new Set(TYPES.flatMap((t) => [...(DIAGRAM_FILE_EXTS[t] ?? [])]));
    for (const ext of owned) expect(all.has(ext), `映射表不得认领 ".${ext}"`).toBe(false);
  });

  it('fresh registry 安装 29 渲染器零 RegistryError；byExtension 大小写归一锚', () => {
    const registry = createRegistry();
    const renderers = createDiagramFileRenderers({});
    expect(renderers).toHaveLength(29);
    expect(() => {
      for (const r of renderers) registry.install(r);
    }).not.toThrow();
    // 注册面形态：id diagram-<type>、label 非空、streaming false、扩展名同映射表
    // （工厂返回类型即 Renderer[]，不再重复断言/强转——评审 T3 冗余清理）
    for (const r of renderers) {
      const type = r.id.slice('diagram-'.length);
      expect(TYPES, r.id).toContain(type);
      expect(r.label, r.id).toBeTruthy();
      expect(r.streaming, `${r.id}.streaming`).toBe(false);
      expect(r.extensions, `${r.id}.extensions`).toEqual([...(DIAGRAM_FILE_EXTS[type] ?? [])]);
    }
    // 大小写归一（Review Focus 1）：查询侧大写命中小写注册键
    expect(registry.byExtension('dot')?.id).toBe('diagram-graphviz');
    expect(registry.byExtension('MERMAID')?.id).toBe('diagram-mermaid');
    // 格式约定别名锚：umlet→uxf、structurizr→dsl
    expect(registry.byExtension('uxf')?.id).toBe('diagram-umlet');
    expect(registry.byExtension('dsl')?.id).toBe('diagram-structurizr');
  });

  it('与既有 owner 不撞：先装 markdown/html/jsonl 再装 diagram 系零 RegistryError，既有扩展名不被 diagram-* 认领', () => {
    const registry = createRegistry();
    registry.install(markdownRenderer);
    registry.install(htmlRenderer);
    registry.install(jsonlRenderer);
    const renderers = createDiagramFileRenderers({});
    expect(() => {
      for (const r of renderers) registry.install(r);
    }).not.toThrow();
    // svg 不入列：本 registry 未装 imageRenderer，byExtension('svg') 落 '(未注册)' 分支
    // 空转——svg 排除已由上方「既有 owner 扩展名不入映射表」组经 DIAGRAM_FILE_EXTS 锚定
    for (const ext of ['md', 'markdown', 'html', 'htm', 'jsonl', 'ndjson']) {
      const owner = registry.byExtension(ext);
      expect(owner?.id ?? '(未注册)', `".${ext}" 的 owner`).not.toMatch(/^diagram-/);
    }
  });
});

// ---------- Task 4：渲染路径（spec §5.2 三分发 + 失败回退 + 2MB 门 + 切换） ----------

// 桩缺省实现（成功路径），失败分支在测内以 mockRejectedValue 覆盖；clearAllMocks
// 只清调用记录不清实现，beforeEach 重设保证每测从干净缺省起步。
beforeEach(() => {
  vi.mocked(renderDiagramEngine).mockResolvedValue('<svg id="t"/>');
  vi.mocked(createKrokiUrl).mockResolvedValue('https://kroki.test/svg/DEFAULT');
  vi.mocked(createPlantumlUrl).mockResolvedValue('https://plantuml.test/plantuml/svg/DEFAULT');
  vi.mocked(renderMermaidInto).mockResolvedValue(true);
});

/** jsdom 无 ResizeObserver，源码视图的 virtualScroller 需要（照 htmlRenderer.test.ts 的 stub） */
function stubResizeObserver(): void {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
  );
}

function sourceOf(name: string): FileSource {
  return {
    storeId: 's',
    storeLabel: '样本',
    path: name,
    name,
    store: {
      id: 's',
      displayName: () => '样本',
      listChildren: async () => [],
      read: async () => new Uint8Array()
    }
  };
}

/** 按类型取渲染器并渲染：返回宿主与实例（det.encoding 恒 utf-8，buffer 由源文本编码） */
async function renderDiagramFile(
  type: string,
  ext: string,
  text: string,
  opts: DiagramFileRenderOpts = {},
  buffer?: Uint8Array
): Promise<{ target: HTMLElement; instance: RenderedInstance }> {
  stubResizeObserver();
  const target = document.createElement('div');
  document.body.append(target);
  const renderer = createDiagramFileRenderers(opts).find((r) => r.id === `diagram-${type}`);
  expect(renderer, `diagram-${type} 渲染器存在`).toBeTruthy();
  const instance = await renderer!.render(
    buffer ?? new TextEncoder().encode(text),
    target,
    sourceOf(`f.${ext}`),
    { ext, encoding: 'utf-8' } satisfies Detection
  );
  return { target, instance };
}

/** 注入图表选项（真通道 setDiagramOptions，与 viewer.ts 装配点同一注入面） */
function setOpts(extra: Partial<DiagramRenderOptions> = {}, modeOf?: (lang: string) => DiagramMode): void {
  setDiagramOptions(() => ({
    krokiHost: 'https://kroki.test',
    mermaidTheme: 'default',
    modeOf: modeOf ?? ((lang) => resolveDiagramType(lang)?.defaultMode ?? 'source'),
    ...extra
  }));
}

describe('diagramFile 渲染——local 成功（净化路径注入）', () => {
  afterEach(() => {
    setDiagramOptions(null);
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    document.body.innerHTML = '';
  });

  it('.dot：引擎 svg 经 sanitizeDiagramFragment 注入（script 剥除、svg 与引擎 style 存活），引擎参数锚', async () => {
    vi.mocked(renderDiagramEngine).mockResolvedValue('<svg id="t"><script>alert(1)</script><style>.a{fill:red}</style></svg>');
    const { target } = await renderDiagramFile('graphviz', 'dot', 'digraph{a->b}');
    // 未注入 options → 注册表 defaultMode 'local'，graphviz 本地引擎直 renderDiagramEngine
    expect(vi.mocked(renderDiagramEngine)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(renderDiagramEngine)).toHaveBeenCalledWith('graphviz', 'digraph{a->b}', {
      mermaidTheme: 'default',
      renderer: undefined
    });
    const svg = target.querySelector('svg#t');
    expect(svg).not.toBeNull();
    expect(svg!.querySelector('script')).toBeNull(); // 净化路径：script 剥除
    expect(svg!.querySelector('style')).not.toBeNull(); // 图表契约壳豁免面：引擎 style 保留
  });

  it('非 UTF-8 坏字节不抛未捕获（fatal:false 解码替换，渲染照常）', async () => {
    vi.mocked(renderDiagramEngine).mockResolvedValue('<svg id="t"/>');
    const bytes = new TextEncoder().encode('digraph{a->b}');
    bytes[3] = 0xff; // 坏字节
    const { target } = await renderDiagramFile('graphviz', 'dot', 'digraph{a->b}', {}, bytes);
    expect(target.querySelector('svg#t')).not.toBeNull();
  });
});

describe('diagramFile 渲染——kroki 客户端 img', () => {
  afterEach(() => {
    setDiagramOptions(null);
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    document.body.innerHTML = '';
  });

  it('mode kroki：createKrokiUrl 以 (krokiHost, krokiType, source) 调用，target 出 img[src]，不调本地引擎', async () => {
    vi.mocked(createKrokiUrl).mockResolvedValue('https://kroki.test/plantuml/svg/AAECAw');
    setOpts({ krokiHost: 'https://kroki.test' }, (lang) => (lang === 'plantuml' ? 'kroki' : 'source'));
    const { target } = await renderDiagramFile('plantuml', 'plantuml', '@startuml\nA->B\n@enduml');
    expect(vi.mocked(createKrokiUrl)).toHaveBeenCalledWith('https://kroki.test', 'plantuml', '@startuml\nA->B\n@enduml');
    expect(vi.mocked(renderDiagramEngine)).not.toHaveBeenCalled();
    const img = target.querySelector('img');
    expect(img).not.toBeNull();
    expect(img!.getAttribute('src')).toBe('https://kroki.test/plantuml/svg/AAECAw');
    expect(img!.getAttribute('alt')).toBe('plantuml');
  });

  it('mode official（plantuml officialServer 型）：createPlantumlUrl img（md 管线第五档同构），不经 kroki', async () => {
    vi.mocked(createPlantumlUrl).mockResolvedValue('https://plantuml.test/plantuml/svg/BBB');
    setOpts({}, (lang) => (lang === 'plantuml' ? 'official' : 'source'));
    const { target } = await renderDiagramFile('plantuml', 'plantuml', '@startuml\nA->B\n@enduml');
    expect(vi.mocked(createPlantumlUrl)).toHaveBeenCalledWith('@startuml\nA->B\n@enduml');
    expect(vi.mocked(createKrokiUrl)).not.toHaveBeenCalled();
    expect(target.querySelector('img[src="https://plantuml.test/plantuml/svg/BBB"]')).not.toBeNull();
  });
});

describe('diagramFile 渲染——server 分发（remoteCall 通道）', () => {
  afterEach(() => {
    setDiagramOptions(null);
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    document.body.innerHTML = '';
  });

  it('server 模式 + remoteCall：POST /api/compute/diagram {lang, source} → {svg} 净化注入，不经本地引擎', async () => {
    const remoteCall = vi.fn(async () => ({ svg: '<svg id="srv"><script>x()</script></svg>' }));
    setOpts({ serverDiagramOf: (lang) => lang === 'graphviz' }, (lang) => (lang === 'graphviz' ? 'server' : 'source'));
    const { target } = await renderDiagramFile('graphviz', 'dot', 'digraph{a->b}', { remoteCall });
    expect(remoteCall).toHaveBeenCalledTimes(1);
    expect(remoteCall).toHaveBeenCalledWith('/api/compute/diagram', {
      method: 'POST',
      body: { lang: 'graphviz', source: 'digraph{a->b}' }
    });
    expect(vi.mocked(renderDiagramEngine)).not.toHaveBeenCalled();
    const svg = target.querySelector('svg#srv');
    expect(svg).not.toBeNull();
    expect(svg!.querySelector('script')).toBeNull(); // 服务端 svg 必经净化（同 md 管线 server 分支）
  });

  it('server 模式但无 remoteCall（未注入通道）：跳过 server 走 local 回落（graphviz 引擎 svg）', async () => {
    vi.mocked(renderDiagramEngine).mockResolvedValue('<svg id="t"/>');
    setOpts({ serverDiagramOf: (lang) => lang === 'graphviz' }, (lang) => (lang === 'graphviz' ? 'server' : 'source'));
    const { target } = await renderDiagramFile('graphviz', 'dot', 'digraph{a->b}');
    expect(target.querySelector('svg#t')).not.toBeNull();
    expect(vi.mocked(renderDiagramEngine)).toHaveBeenCalledTimes(1);
  });

  it('krokiVia=server 且 krokiProxy 宣告：kroki 走 /api/kroki 代发内联 svg，不经 client img', async () => {
    const remoteCall = vi.fn(async () => ({ svg: '<svg id="ks"/>' }));
    setOpts(
      { krokiVia: 'server', krokiProxy: true },
      (lang) => (lang === 'plantuml' ? 'kroki' : 'source')
    );
    const { target } = await renderDiagramFile('plantuml', 'plantuml', '@startuml\nA->B\n@enduml', { remoteCall });
    expect(remoteCall).toHaveBeenCalledWith('/api/kroki', {
      method: 'POST',
      body: { lang: 'plantuml', source: '@startuml\nA->B\n@enduml' }
    });
    expect(vi.mocked(createKrokiUrl)).not.toHaveBeenCalled();
    expect(target.querySelector('svg#ks')).not.toBeNull();
  });

  // M2（Task 4 评审）：server 模式 × remoteCall 注入但 reject × 无本地引擎（plantuml）
  // 的组合链——降级链照走（server→kroki），引擎零调用；kroki 也败则终态源码 + 提示卡
  it('server 模式 + remoteCall reject（plantuml 无本地引擎）：降级直落 kroki，kroki 也败终态源码 + 提示卡', async () => {
    const remoteCall = vi.fn(() => Promise.reject(new Error('服务器断连')));
    vi.mocked(createKrokiUrl).mockRejectedValue(new Error('kroki 不可达'));
    setOpts({ serverDiagramOf: (lang) => lang === 'plantuml' }, (lang) => (lang === 'plantuml' ? 'server' : 'source'));
    const { target } = await renderDiagramFile('plantuml', 'plantuml', '@startuml\nA->B\n@enduml', { remoteCall });
    expect(remoteCall).toHaveBeenCalledTimes(1);
    expect(remoteCall).toHaveBeenCalledWith('/api/compute/diagram', {
      method: 'POST',
      body: { lang: 'plantuml', source: '@startuml\nA->B\n@enduml' }
    });
    expect(vi.mocked(renderDiagramEngine)).not.toHaveBeenCalled(); // plantuml 无本地引擎：跳过 local 档
    expect(vi.mocked(createKrokiUrl)).toHaveBeenCalledTimes(1); // 降级链只走一跳 kroki
    const body = target.querySelector('.vv-code-body');
    expect(body).not.toBeNull(); // 终态源码视图承接
    expect(body!.textContent).toContain('@startuml');
    const card = target.querySelector('.vv-error-card');
    expect(card).not.toBeNull();
    expect(card!.textContent).toContain('已回退');
  });
});

describe('diagramFile 渲染——回退链（Review Focus 3）', () => {
  afterEach(() => {
    setDiagramOptions(null);
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    document.body.innerHTML = '';
  });

  it('kroki-only 型被 modeOf 强判 local：无本地引擎不调引擎，降级 kroki img 兜住', async () => {
    setOpts({ krokiHost: 'https://kroki.test' }, () => 'local');
    const { target } = await renderDiagramFile('plantuml', 'plantuml', '@startuml\nA->B\n@enduml');
    expect(vi.mocked(renderDiagramEngine)).not.toHaveBeenCalled(); // plantuml 无本地引擎
    expect(vi.mocked(createKrokiUrl)).toHaveBeenCalledWith('https://kroki.test', 'plantuml', '@startuml\nA->B\n@enduml');
    expect(target.querySelector('img')).not.toBeNull();
  });

  it('kroki 也失败（createKrokiUrl reject）：落 renderCode 源码视图（源文本出现）+ 失败状态提示卡（渲染器内提示通道）', async () => {
    vi.mocked(createKrokiUrl).mockRejectedValue(new Error('kroki 不可达'));
    setOpts({}, () => 'local');
    const { target } = await renderDiagramFile('plantuml', 'plantuml', '@startuml\nA->B\n@enduml');
    expect(vi.mocked(renderDiagramEngine)).not.toHaveBeenCalled();
    expect(vi.mocked(createKrokiUrl)).toHaveBeenCalledTimes(1);
    const body = target.querySelector('.vv-code-body');
    expect(body).not.toBeNull(); // 源码视图承接（renderCode 同一高亮链）
    expect(body!.textContent).toContain('@startuml');
    const card = target.querySelector('.vv-error-card'); // 状态提示元素（showStatusNotice 属 web 层，渲染器内以提示卡同语义承接）
    expect(card).not.toBeNull();
    expect(card!.textContent).toContain('kroki');
    expect(card!.textContent).toContain('已回退');
  });
});

describe('diagramFile 渲染——引擎抛错回退', () => {
  afterEach(() => {
    setDiagramOptions(null);
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    document.body.innerHTML = '';
  });

  it('引擎 reject（graphviz 有 krokiType）：降级 kroki img（md 管线同链）', async () => {
    vi.mocked(renderDiagramEngine).mockRejectedValue(new Error('viz 加载失败'));
    const { target } = await renderDiagramFile('graphviz', 'dot', 'digraph{a->b}');
    expect(vi.mocked(renderDiagramEngine)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(createKrokiUrl)).toHaveBeenCalledWith(DEFAULT_KROKI_HOST, 'graphviz', 'digraph{a->b}');
    expect(target.querySelector('img')).not.toBeNull();
  });

  it('引擎 reject + kroki reject：直落源码视图 + 提示卡（不空白死等）', async () => {
    vi.mocked(renderDiagramEngine).mockRejectedValue(new Error('viz 加载失败'));
    vi.mocked(createKrokiUrl).mockRejectedValue(new Error('kroki 不可达'));
    const { target } = await renderDiagramFile('graphviz', 'dot', 'digraph{a->b}');
    const body = target.querySelector('.vv-code-body');
    expect(body).not.toBeNull();
    expect(body!.textContent).toContain('digraph');
    expect(target.querySelector('.vv-error-card')).not.toBeNull();
  });
});

describe('diagramFile 渲染——大小门（Review Focus 4）', () => {
  afterEach(() => {
    setDiagramOptions(null);
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    document.body.innerHTML = '';
  });

  it('>2MB：不调引擎不构 kroki URL，直落源码视图 + 降级提示卡（无工具栏，切换空操作）', async () => {
    const big = new Uint8Array(2 * 1024 * 1024 + 1);
    big.set(new TextEncoder().encode('digraph{a->b}'));
    const { target, instance } = await renderDiagramFile('graphviz', 'dot', 'digraph{a->b}', {}, big);
    expect(vi.mocked(renderDiagramEngine)).not.toHaveBeenCalled();
    expect(vi.mocked(createKrokiUrl)).not.toHaveBeenCalled();
    expect(target.querySelector('.vv-error-card')).not.toBeNull(); // 降级提示卡
    expect(target.textContent).toContain('文件过大');
    expect(target.querySelector('.vv-code-body')).not.toBeNull(); // 源码视图承接
    expect(target.querySelector('.vv-html-toolbar')).toBeNull(); // 无渲染视图可切
    const toggle = instance as RenderedInstance & { toggleView(): void };
    toggle.toggleView(); // 降级视图切换空操作
    expect(target.querySelector('.vv-code-body')).not.toBeNull();
    instance.destroy();
    expect(target.innerHTML).toBe('');
    expect(target.classList.contains('vv-html')).toBe(false);
    expect(target.classList.contains('vv-degraded')).toBe(false);
  });

  it('=2MB 恰好不触发门（仅 >2MB 降级）：走正常渲染路径', async () => {
    vi.mocked(renderDiagramEngine).mockResolvedValue('<svg id="t"/>');
    const buf = new Uint8Array(2 * 1024 * 1024);
    buf.set(new TextEncoder().encode('digraph{a->b}'));
    const { target } = await renderDiagramFile('graphviz', 'dot', 'digraph{a->b}', {}, buf);
    expect(vi.mocked(renderDiagramEngine)).toHaveBeenCalledTimes(1);
    expect(target.querySelector('.vv-error-card')).toBeNull();
    expect(target.querySelector('svg#t')).not.toBeNull();
  });
});

describe('diagramFile 渲染——源码/渲染切换', () => {
  afterEach(() => {
    setDiagramOptions(null);
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    document.body.innerHTML = '';
  });

  it('渲染态点源码钮：源码视图出现且引擎调用不增（不重读文件）；点渲染钮：svg 复现且引擎调用不增', async () => {
    vi.mocked(renderDiagramEngine).mockResolvedValue('<svg id="t"/>');
    const { target } = await renderDiagramFile('graphviz', 'dot', 'digraph{a->b}');
    expect(vi.mocked(renderDiagramEngine)).toHaveBeenCalledTimes(1);
    const sourceBtn = target.querySelector<HTMLButtonElement>('.vv-html-btn-source');
    const renderedBtn = target.querySelector<HTMLButtonElement>('.vv-html-btn-rendered');
    expect(sourceBtn).not.toBeNull();
    expect(renderedBtn).not.toBeNull();

    sourceBtn!.click();
    expect(target.querySelector('svg#t')).toBeNull();
    const body = target.querySelector('.vv-code-body');
    expect(body).not.toBeNull();
    expect(body!.textContent).toContain('digraph');
    expect(vi.mocked(renderDiagramEngine)).toHaveBeenCalledTimes(1); // 切源码不重渲染

    renderedBtn!.click();
    expect(target.querySelector('svg#t')).not.toBeNull(); // 缓存复挂载
    expect(target.querySelector('.vv-code-body')).toBeNull();
    expect(vi.mocked(renderDiagramEngine)).toHaveBeenCalledTimes(1); // 切回渲染不重调引擎
  });

  it('toggleView 实例方法同通道；destroy 清空宿主与类标记', async () => {
    vi.mocked(renderDiagramEngine).mockResolvedValue('<svg id="t"/>');
    const { target, instance } = await renderDiagramFile('graphviz', 'dot', 'digraph{a->b}');
    const toggle = instance as RenderedInstance & { toggleView(): void };
    toggle.toggleView();
    expect(target.querySelector('.vv-code-body')).not.toBeNull();
    toggle.toggleView();
    expect(target.querySelector('svg#t')).not.toBeNull();
    instance.destroy();
    expect(target.innerHTML).toBe('');
    expect(target.classList.contains('vv-html')).toBe(false);
  });
});

// ---------- Task 4 评审修正锚（M3：重挂前卸旧实例） ----------

describe('diagramFile 回退面——重挂源码前卸旧实例（评审 M3）', () => {
  afterEach(() => {
    setDiagramOptions(null);
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    document.body.innerHTML = '';
  });

  /** RenderCodeHandle 生命周期桩（不产真实 DOM——本组只看实例流转）：仅实现本组
   * 消费的生命周期面（destroy），滚动/引擎/元数据等方法面与本组无关，经 unknown
   * 中转窄化（TS2352 直接转型缺面报错——根 typecheck 0E 修复，行为零改动） */
  function stubHandle(destroy: () => void): RenderCodeHandle {
    return {
      destroy,
      search: async () => [],
      gotoMatch: () => {}
    } as unknown as RenderCodeHandle;
  }

  it('源码视图已挂载时迟到的 kroki img error 再走 showSourceFallback：重挂前 destroy 旧 code 实例（不叠加高亮）', async () => {
    // 自建 krokiHost：M1 的官方重试一跳不触发（隐私防线），img error 直走源码回退
    setOpts({ krokiHost: 'https://kroki.test' }, (lang) => (lang === 'plantuml' ? 'kroki' : 'source'));
    const { target } = await renderDiagramFile('plantuml', 'plantuml', '@startuml\nA->B\n@enduml');
    const img = target.querySelector('img');
    expect(img).not.toBeNull();

    const destroy1 = vi.fn();
    const destroy2 = vi.fn();
    vi.mocked(renderCode).mockImplementationOnce(() => stubHandle(destroy1));
    target.querySelector<HTMLButtonElement>('.vv-html-btn-source')!.click(); // 第一次 mountSource → renderCode #1
    expect(destroy1).not.toHaveBeenCalled();

    vi.mocked(renderCode).mockImplementationOnce(() => stubHandle(destroy2));
    // 迟到的 img error（jsdom 不自动派 img error，手动派发；img 虽已脱离 DOM，监听器仍在）
    img!.dispatchEvent(new Event('error')); // showSourceFallback：view 已 source → 仍会重挂源码
    expect(vi.mocked(renderCode)).toHaveBeenCalledTimes(2);
    expect(destroy1, '重挂前必须 unmount 旧实例（否则双份高亮实例叠加）').toHaveBeenCalledTimes(1);
    expect(destroy2).not.toHaveBeenCalled();
  });
});

// ---------- Task 4 评审修正锚（M4：attemptRendered 在飞守卫 + 陈旧失败卡） ----------

describe('diagramFile 渲染——在飞守卫（M4：连切后旧链迟到落定作废）', () => {
  afterEach(() => {
    setDiagramOptions(null);
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    document.body.innerHTML = '';
  });

  /** renderDiagramFile 的不等待变体：链 1 须在飞期间操作切换钮（手控 promise 门），故不走 renderDiagramFile 助手 */
  function startRender(type: string, ext: string, text: string): { target: HTMLElement; promise: Promise<RenderedInstance> } {
    stubResizeObserver();
    const target = document.createElement('div');
    document.body.append(target);
    const renderer = createDiagramFileRenderers({}).find((r) => r.id === `diagram-${type}`);
    expect(renderer, `diagram-${type} 渲染器存在`).toBeTruthy();
    const promise = renderer!.render(
      new TextEncoder().encode(text),
      target,
      sourceOf(`f.${ext}`),
      { ext, encoding: 'utf-8' } satisfies Detection
    );
    return { target, promise };
  }

  it('连切 render→source→render：旧链成功迟到落定不覆盖新链 DOM（代币守卫）', async () => {
    // 手控链 1 引擎 promise：挂起期间完成 render→source→render 连切；链 2 用 beforeEach 缺省桩（svg#t）
    let release1!: () => void;
    const gate1 = new Promise<void>((resolve) => {
      release1 = resolve;
    });
    vi.mocked(renderDiagramEngine).mockImplementationOnce(async () => {
      await gate1;
      return '<svg id="t1"/>';
    });
    const { target, promise } = startRender('graphviz', 'dot', 'digraph{a->b}');
    target.querySelector<HTMLButtonElement>('.vv-html-btn-source')!.click(); // 链 1 仍在飞
    target.querySelector<HTMLButtonElement>('.vv-html-btn-rendered')!.click(); // 链 2 启动（取代链 1）
    await vi.waitFor(() => expect(target.querySelector('svg#t')).not.toBeNull()); // 链 2 已落定
    expect(vi.mocked(renderDiagramEngine)).toHaveBeenCalledTimes(2); // 新链照常重走（守卫不拦用户请求）

    release1(); // 旧链迟到成功落定
    const instance = await promise;
    expect(target.querySelector('svg#t1'), '被取代链的迟到落定不得覆盖新链 DOM').toBeNull();
    expect(target.querySelector('svg#t')).not.toBeNull(); // 新链视图原样
    expect(target.querySelector('.vv-error-card')).toBeNull();
    instance.destroy();
  });

  it('连切后旧链失败迟到落定：不出失败卡、不切源码视图（陈旧失败卡防复活）', async () => {
    // 手控链 1 引擎 promise 为 reject 门；链 1 引擎败后降 kroki、kroki 桩也 reject → 链 1 迟到失败
    let reject1!: (e: unknown) => void;
    const gate1 = new Promise<string>((_, reject) => {
      reject1 = reject;
    });
    vi.mocked(renderDiagramEngine).mockImplementationOnce(() => gate1);
    vi.mocked(createKrokiUrl).mockRejectedValue(new Error('kroki 不可达'));
    const { target, promise } = startRender('graphviz', 'dot', 'digraph{a->b}');
    target.querySelector<HTMLButtonElement>('.vv-html-btn-source')!.click();
    target.querySelector<HTMLButtonElement>('.vv-html-btn-rendered')!.click(); // 链 2：引擎缺省桩成功
    await vi.waitFor(() => expect(target.querySelector('svg#t')).not.toBeNull());

    reject1(new Error('viz 加载失败')); // 旧链迟到失败（未守卫时会切源码 + 出提示卡）
    const instance = await promise;
    expect(target.querySelector('.vv-error-card'), '被取代链的失败不得复活提示卡').toBeNull();
    expect(target.querySelector('.vv-code-body')).toBeNull(); // 不得把用户拽回源码视图
    expect(target.querySelector('svg#t')).not.toBeNull(); // 新链视图原样
    instance.destroy();
  });
});

// ---------- 终审修正锚（official 降级链代币守卫：officialImgError 迟到落定作废） ----------

describe('diagramFile 渲染——official 降 kroki 链代币守卫（终审：officialImgError 迟到落定作废）', () => {
  afterEach(() => {
    setDiagramOptions(null);
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    document.body.innerHTML = '';
  });

  it('official img error → kroki 降级在飞时切源码再点渲染（清缓存起新链）：旧链 kroki 迟到成功落定不覆盖新链 DOM/缓存', async () => {
    // 手控旧链 kroki 降级 promise：official img error 触发 mountKroki 挂起期间完成连切
    let releaseKroki!: (url: string) => void;
    const krokiGate = new Promise<string>((resolve) => {
      releaseKroki = resolve;
    });
    vi.mocked(createPlantumlUrl)
      .mockResolvedValueOnce('https://plantuml.test/plantuml/svg/OLD') // 链 1 official src
      .mockResolvedValue('https://plantuml.test/plantuml/svg/NEW'); // 新链 official src
    vi.mocked(createKrokiUrl).mockImplementationOnce(() => krokiGate); // 链 1 降级 kroki 挂起
    setOpts({}, (lang) => (lang === 'plantuml' ? 'official' : 'source'));
    const { target, instance } = await renderDiagramFile('plantuml', 'plantuml', '@startuml\nA->B\n@enduml');
    const img = target.querySelector('img');
    expect(img!.getAttribute('src')).toBe('https://plantuml.test/plantuml/svg/OLD');

    img!.dispatchEvent(new Event('error')); // official 失败 → officialImgError：清 renderedMount + kroki 链挂起
    target.querySelector<HTMLButtonElement>('.vv-html-btn-source')!.click(); // 切源码（降级链仍在飞）
    target.querySelector<HTMLButtonElement>('.vv-html-btn-rendered')!.click(); // 新链启动（renderedMount 已清，链代币自增）
    await vi.waitFor(() =>
      expect(target.querySelector('img[src="https://plantuml.test/plantuml/svg/NEW"]')).not.toBeNull()
    );

    releaseKroki('https://kroki.io/plantuml/svg/LATE'); // 旧链 kroki 迟到成功落定
    await new Promise((resolve) => setTimeout(resolve, 0)); // 放行旧链 .then 微任务（守卫应丢弃）
    expect(target.querySelector('img[src="https://kroki.io/plantuml/svg/LATE"]'), '被取代链的 kroki 落定不得挂载').toBeNull();
    expect(target.querySelector('img[src="https://plantuml.test/plantuml/svg/NEW"]')).not.toBeNull(); // 新链视图原样
    expect(target.querySelector('.vv-error-card')).toBeNull();

    // 行为面锚 renderedMount 未被 clobber：切源码再回渲染，缓存复挂载仍是新链 official img
    target.querySelector<HTMLButtonElement>('.vv-html-btn-source')!.click();
    target.querySelector<HTMLButtonElement>('.vv-html-btn-rendered')!.click();
    expect(target.querySelector('img[src="https://plantuml.test/plantuml/svg/NEW"]')).not.toBeNull();
    expect(target.querySelector('img[src^="https://kroki"]')).toBeNull();
    instance.destroy();
  });

  it('旧链 kroki 降级失败迟到落定：不出失败卡、不拽切源码（新链视图原样）', async () => {
    let rejectKroki!: (e: unknown) => void;
    const krokiGate = new Promise<string>((_, reject) => {
      rejectKroki = reject;
    });
    vi.mocked(createPlantumlUrl)
      .mockResolvedValueOnce('https://plantuml.test/plantuml/svg/OLD')
      .mockResolvedValue('https://plantuml.test/plantuml/svg/NEW');
    vi.mocked(createKrokiUrl).mockImplementationOnce(() => krokiGate);
    setOpts({}, (lang) => (lang === 'plantuml' ? 'official' : 'source'));
    const { target, instance } = await renderDiagramFile('plantuml', 'plantuml', '@startuml\nA->B\n@enduml');
    target.querySelector('img')!.dispatchEvent(new Event('error'));
    target.querySelector<HTMLButtonElement>('.vv-html-btn-source')!.click();
    target.querySelector<HTMLButtonElement>('.vv-html-btn-rendered')!.click();
    await vi.waitFor(() =>
      expect(target.querySelector('img[src="https://plantuml.test/plantuml/svg/NEW"]')).not.toBeNull()
    );

    rejectKroki(new Error('kroki 不可达')); // 旧链降级失败迟到落定（未守卫会切源码 + 出提示卡）
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(target.querySelector('.vv-error-card'), '被取代链的失败不得复活提示卡').toBeNull();
    expect(target.querySelector('.vv-code-body')).toBeNull(); // 不得把用户拽回源码视图
    expect(target.querySelector('img[src="https://plantuml.test/plantuml/svg/NEW"]')).not.toBeNull();
    instance.destroy();
  });
});

// ---------- Task 4 评审修正锚（M1：kroki→official 重试一跳，md 管线同款） ----------

describe('diagramFile 回退面——kroki img error 官方重试一跳（评审 M1）', () => {
  afterEach(() => {
    setDiagramOptions(null);
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    document.body.innerHTML = '';
  });

  it('officialServer 型 + 默认 krokiHost：img error 换 createPlantumlUrl 官方 src 重试一跳（同 img），不落源码', async () => {
    vi.mocked(createKrokiUrl).mockResolvedValue('https://kroki.io/plantuml/svg/AAA');
    setOpts({ krokiHost: DEFAULT_KROKI_HOST }, (lang) => (lang === 'plantuml' ? 'kroki' : 'source'));
    const { target } = await renderDiagramFile('plantuml', 'plantuml', '@startuml\nA->B\n@enduml');
    const img = target.querySelector('img');
    expect(img!.getAttribute('src')).toBe('https://kroki.io/plantuml/svg/AAA');
    expect(vi.mocked(createPlantumlUrl)).not.toHaveBeenCalled();

    img!.dispatchEvent(new Event('error'));
    expect(vi.mocked(createPlantumlUrl), '默认 kroki 上游失败先试官方服务器一跳').toHaveBeenCalledWith(
      '@startuml\nA->B\n@enduml'
    );
    await vi.waitFor(() => expect(img!.getAttribute('src')).toBe('https://plantuml.test/plantuml/svg/DEFAULT'));
    expect(target.querySelector('.vv-code-body')).toBeNull(); // 重试期不落源码
    expect(target.querySelector('.vv-error-card')).toBeNull();

    img!.dispatchEvent(new Event('error')); // 官方也失败：两跳后终态源码回退
    await vi.waitFor(() => expect(target.querySelector('.vv-code-body')).not.toBeNull());
    expect(target.querySelector('.vv-error-card')).not.toBeNull();
    // 终态文案（T5 评审：与 md 管线 krokiErrorText 官方已试变体对齐）
    expect(target.querySelector('.vv-error-card')!.textContent).toContain('kroki 与官方服务器渲染失败');
  });

  it('自建 krokiHost（隐私防线）：img error 不回落官方，直落源码回退', async () => {
    setOpts({ krokiHost: 'https://kroki.self.test' }, (lang) => (lang === 'plantuml' ? 'kroki' : 'source'));
    const { target } = await renderDiagramFile('plantuml', 'plantuml', '@startuml\nA->B\n@enduml');
    target.querySelector('img')!.dispatchEvent(new Event('error'));
    await vi.waitFor(() => expect(target.querySelector('.vv-code-body')).not.toBeNull());
    expect(vi.mocked(createPlantumlUrl)).not.toHaveBeenCalled();
    expect(target.querySelector('.vv-error-card')).not.toBeNull();
    // 终态文案（T5 评审：未试官方用基础文案，不带「与官方服务器」段）
    const card = target.querySelector('.vv-error-card')!;
    expect(card.textContent).toContain('kroki 渲染失败');
    expect(card.textContent).not.toContain('与官方服务器');
  });

  it('非 officialServer 型（graphviz）：img error 不试官方，直落源码回退', async () => {
    setOpts({ krokiHost: DEFAULT_KROKI_HOST }, (lang) => (lang === 'graphviz' ? 'kroki' : 'source'));
    const { target } = await renderDiagramFile('graphviz', 'dot', 'digraph{a->b}');
    target.querySelector('img')!.dispatchEvent(new Event('error'));
    await vi.waitFor(() => expect(target.querySelector('.vv-code-body')).not.toBeNull());
    expect(vi.mocked(createPlantumlUrl)).not.toHaveBeenCalled();
  });
});

// ---------- 终审修正锚（applyTheme：mermaid 文件主题联动，markdown 实例同构桥接面） ----------

/** applyTheme 鸭子探测形态（ViewerPane 桥接处同款：typeof applyTheme === 'function' 即挂监听） */
type ThemeBridgeInstance = RenderedInstance & { applyTheme(opts?: { mermaidTheme?: MermaidTheme }): void };

describe('diagramFile 渲染——applyTheme mermaid 主题联动（终审）', () => {
  afterEach(() => {
    setDiagramOptions(null);
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    document.body.innerHTML = '';
  });

  it('.mermaid 渲染视图：applyTheme 就地重画（renderMermaidInto 以新主题作用于 content 容器），DOM 换新 svg；destroy 后 no-op', async () => {
    vi.mocked(renderDiagramEngine).mockResolvedValue('<svg id="t"/>');
    vi.mocked(renderMermaidInto).mockImplementation(async (container, _source, theme) => {
      container.innerHTML = `<svg data-theme="${theme}"/>`; // 模拟重画落 DOM（真身由 renderMermaid 承担）
      return true;
    });
    const { target, instance } = await renderDiagramFile('mermaid', 'mermaid', 'flowchart A-->B');
    expect(target.querySelector('svg#t')).not.toBeNull(); // 初始本地渲染（mermaid defaultMode=local）

    const themed = instance as ThemeBridgeInstance;
    expect(typeof themed.applyTheme, 'ViewerPane 鸭子探测面：applyTheme 为函数').toBe('function');
    themed.applyTheme({ mermaidTheme: 'dark' });
    expect(vi.mocked(renderMermaidInto)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(renderMermaidInto)).toHaveBeenCalledWith(
      target.querySelector('.vv-html-content'),
      'flowchart A-->B',
      'dark'
    );
    expect(target.querySelector('svg[data-theme="dark"]')).not.toBeNull(); // 就地换新
    expect(target.querySelector('svg#t')).toBeNull();

    instance.destroy();
    themed.applyTheme({ mermaidTheme: 'dark' }); // destroyed 守卫：不再重画
    expect(vi.mocked(renderMermaidInto)).toHaveBeenCalledTimes(1);
  });

  it('非 mermaid 型（graphviz 输出主题无关）：applyTheme 静默 no-op，原图原样', async () => {
    vi.mocked(renderDiagramEngine).mockResolvedValue('<svg id="t"/>');
    const { target, instance } = await renderDiagramFile('graphviz', 'dot', 'digraph{a->b}');
    (instance as ThemeBridgeInstance).applyTheme({ mermaidTheme: 'dark' });
    expect(vi.mocked(renderMermaidInto)).not.toHaveBeenCalled();
    expect(target.querySelector('svg#t')).not.toBeNull();
    instance.destroy();
  });

  it('源码视图与 kroki img 形态：applyTheme 静默 no-op（无可重画的 mermaid svg）', async () => {
    vi.mocked(renderDiagramEngine).mockResolvedValue('<svg id="t"/>');
    const { instance } = await renderDiagramFile('mermaid', 'mermaid', 'flowchart A-->B');
    // diagramFile 实例面 = RenderedInstance + toggleView/onViewChanged/applyTheme 扩展
    // （diagramFile.ts「实例面」注）：core 返回类型不含扩展，按既有先例（本文件 :500
    // 交叉断言同型）就地窄化——根 typecheck 0E 修复，行为零改动
    (instance as RenderedInstance & { toggleView(): void }).toggleView(); // → 源码视图
    (instance as ThemeBridgeInstance).applyTheme({ mermaidTheme: 'dark' });
    expect(vi.mocked(renderMermaidInto)).not.toHaveBeenCalled(); // 源码视图 no-op

    // kroki img 形态：mounted 输出非 mermaid svg，重画无对象（缺省 krokiHost 桩出 img）
    setOpts({ krokiHost: 'https://kroki.test' }, (lang) => (lang === 'mermaid' ? 'kroki' : 'source'));
    const kroki = await renderDiagramFile('mermaid', 'mmd', 'flowchart C-->D');
    expect(kroki.target.querySelector('img')).not.toBeNull();
    (kroki.instance as ThemeBridgeInstance).applyTheme({ mermaidTheme: 'dark' });
    expect(vi.mocked(renderMermaidInto)).not.toHaveBeenCalled(); // kroki img 形态 no-op
    kroki.instance.destroy();
    instance.destroy();
  });
});

// ---------- Task 5：装配序锚（viewer.ts diagram 先于 code，generated 补空位铁律） ----------

describe('装配序锚（Task 5：viewer.ts 语句序）', () => {
  // viewer.ts 本体 vitest 不可 import（$app/env 与 svelte runes 模块无插件不可编译，
  // highlightRouter.test.ts 同款结论），故装配序以两层面锚定：
  // ① 源序断言——直接读 viewer.ts，锁 install 语句的真实先后（顺序颠倒即本测红）；
  // ② 行为镜像——fresh registry 按 viewer.ts 实际语句序安装，锁语义不变量。
  function readViewerSource(): string {
    // vitest 下 import.meta.url 非 file scheme（loader 虚拟协议），按 cwd 双候选兜底：
    // 仓库根运行（root script 标准）与包目录运行各一份相对路径
    for (const rel of ['apps/web/src/lib/viewer.ts', '../../apps/web/src/lib/viewer.ts']) {
      try {
        return readFileSync(resolve(process.cwd(), rel), 'utf8');
      } catch {
        /* 下一候选 */
      }
    }
    throw new Error('apps/web/src/lib/viewer.ts 不可达（装配序锚须在 monorepo 内运行）');
  }

  it('viewer.ts 源序：diagram 29 型 install 语句先于 registry.install(codeRenderer)（Review Focus 2）', () => {
    const src = readViewerSource();
    const diagramAt = src.indexOf('createDiagramFileRenderers({ remoteCall');
    const codeAt = src.indexOf('registry.install(codeRenderer)');
    expect(diagramAt, 'viewer.ts 未装配图表文件渲染器（createDiagramFileRenderers({ remoteCall }) 逐个 install）').toBeGreaterThan(-1);
    expect(codeAt, 'viewer.ts 未装配 codeRenderer').toBeGreaterThan(-1);
    expect(diagramAt, 'diagram install 必须先于 code install：顺序颠倒则 generated 占位反转（dot/mermaid/mmd/bpmn/dbml 在 GENERATED_EXTENSIONS 内被 code 抢注，diagram install 抛 RegistryError）').toBeLessThan(codeAt);
  });

  it('viewer.ts 源序：diagram install 块先于 generated fallback（installFallbackExtensions）调用（T5 评审序锚）', () => {
    const src = readViewerSource();
    const diagramAt = src.indexOf('createDiagramFileRenderers({ remoteCall');
    const fallbackAt = src.indexOf("registry.installFallbackExtensions('code', GENERATED_EXTENSIONS)");
    expect(diagramAt, 'viewer.ts 未装配图表文件渲染器').toBeGreaterThan(-1);
    expect(fallbackAt, 'viewer.ts 未装配 generated fallback').toBeGreaterThan(-1);
    expect(diagramAt, 'diagram install 块必须整体先于 generated fallback：同一铁律在收尾调用面上的序锚').toBeLessThan(fallbackAt);
  });

  it('镜像 viewer.ts 语句序（diagram 29 → code → markdown → html → jsonl → generated fallback）：dot 归 diagram-graphviz、tsv 归 code', () => {
    // 镜像范围注记：image/av/pdf/docx/xlsx/pptx/hex/archive 为 app-only 依赖
    // （render-text 不依赖 render-media/doc/binary/archive，测试面不可达），其扩展名
    // 域（svg/jpg/pdf/docx/zip/bin…）与 diagram 33 扩展名无交集，不参与 Review
    // Focus 2 的顺序不变量；真实终态由 pnpm --filter web typecheck 与 web 构建背书。
    const registry = createRegistry();
    for (const r of createDiagramFileRenderers({})) registry.install(r); // viewer.ts 语句 1：图表文件渲染器
    registry.install(codeRenderer); // viewer.ts 语句 2
    registry.install(markdownRenderer); // 语句 3
    registry.install(htmlRenderer); // 语句 4
    registry.install(jsonlRenderer); // 语句 5（generated fallback 前）
    registry.installFallbackExtensions('code', GENERATED_EXTENSIONS); // 收尾：generated 补空位（冲突跳过）
    // 正面：diagram 认领的扩展名不被 generated fallback 抢走
    expect(registry.byExtension('dot')?.id).toBe('diagram-graphviz');
    expect(registry.byExtension('gv')?.id).toBe('diagram-graphviz');
    expect(registry.byExtension('mermaid')?.id).toBe('diagram-mermaid');
    expect(registry.byExtension('mmd')?.id).toBe('diagram-mermaid');
    expect(registry.byExtension('bpmn')?.id).toBe('diagram-bpmn');
    expect(registry.byExtension('dbml')?.id).toBe('diagram-dbml');
    expect(registry.byExtension('d2')?.id).toBe('diagram-d2');
    // 反面：code 专有/补空位与既有 owner 原样
    expect(registry.byExtension('tsv')?.id).toBe('code');
    expect(registry.byExtension('csv')?.id).toBe('code');
    expect(registry.byExtension('md')?.id).toBe('markdown');
    expect(registry.byExtension('html')?.id).toBe('html');
    expect(registry.byExtension('jsonl')?.id).toBe('jsonl');
  });
});
