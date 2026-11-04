// diagramFile.ts — 图表文件渲染器注册面 + 渲染路径（spec
// 2026-11-04-file-viewer-integration §5.1/§5.2）：29 型（diagram 注册表全集去
// math——.tex 维持 latex 源码高亮；drawio 不在注册表归批次三）→ 扩展名映射逐字取
// spec §5.1 表，createDiagramFileRenderers 产出 29 个 Renderer 实例（id
// `diagram-<type>`）供装配点安装。
//
// 扩展名计数注记：spec §5.1 标题写「31 扩展名」，但其表行逐行累加为 33——两处含
// 「/」的行（plantuml/c4plantuml、vega/vegalite）各 3 个扩展名，「31」疑为把该两行
// 按 2 计的笔误。表行是逐字规范面（测试 test/diagramFile.test.ts 内联锚定），实现
// 以表行为准；漏绑任一扩展名都会让对应图表文件落不进图形预览。
//
// 渲染路径（Task 4，spec §5.2）：全量 buffer 在手（streaming false）→ 2MB 大小门
// 先行（超大直落源码 + 降级卡，不进任何引擎路径）→ 模式裁决（md 管线
// effectiveModeOf 同构：getDiagramOptions().modeOf 缺省按注册表 defaultMode）→
// 三分发 local/kroki/server 失败降级链（server→local→kroki、official→kroki、
// local→kroki，终态源码视图 + 提示卡）→ 产出 SVG/HTML 一律过 sanitizeDiagramFragment
// 消毒链（spec §5.2「产出物复用 markdown 管线的 sanitize 钩子」；md 管线本地分支
// 未净化是历史形态，本渲染器按 spec 收紧）→ 源码/渲染双视图切换移植 html.ts 机制
// （类名复用 vv-html-* 既有样式钩，app.css 单一来源，渲染器不注入 CSS）。viewer.ts
// 装配序（diagram 先于 code 安装，generated 补空位铁律）在 Task 5 落地。
import type { Detection, FileSource, Renderer, RenderedInstance } from '@bhxch/vviewer-core';
import {
  DEFAULT_KROKI_HOST,
  createKrokiUrl,
  createPlantumlUrl,
  renderDiagramEngine,
  resolveDiagramType,
  type DiagramMode,
  type DiagramType
} from '@bhxch/vviewer-render-diagram';
import { getDiagramOptions, type DiagramRenderOptions } from '@bhxch/vviewer-markdown';
import { sanitizeDiagramFragment } from '@bhxch/vviewer-sanitize';
import { renderCode, type RenderCodeHandle } from './code';
import { decodeText } from './decodeText';

/** Task 4/5 注入缝：server 模式单图渲染的远端调用通道（同 md 管线 PipelineCtx.diagram.remoteCall 形态）。 */
export interface DiagramFileRenderOpts {
  remoteCall?: (path: string, init?: { method?: string; body?: unknown }) => Promise<unknown>;
}

/** 大小门（spec §5.2）：图表源超过 2MB 渲染无意义，直落源码视图。 */
const DIAGRAM_MAX_BYTES = 2 * 1024 * 1024;

/**
 * 29 型 → 扩展名映射，逐字取 spec 2026-11-04 §5.1 表（键序 = 表行序）。标「造」
 * 行 = 无通行扩展名按类型同名（或格式约定 umlet→uxf）注册的扩展名；扩展名小写
 * 无点（registry 登记侧亦归一小写）。不得出现既有 owner 扩展名
 * （md/markdown/html/htm/jsonl/ndjson/svg——测试锚定），装配序保证图表渲染器先于
 * generated fallback 安装（dot/gv/mermaid/mmd/bpmn/dbml/d2 与 670 项生成物重叠由
 * 「专有先注册、generated 补空位」消解）。
 */
export const DIAGRAM_FILE_EXTS: Readonly<Record<string, readonly string[]>> = {
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

/**
 * 可读名表：DiagramType（diagrams.ts 实态）无 label 字段，注册面 label 由本表提供
 * （键 = 类型 id；通行专名保留官方拼写）。上游注册表若补 label 字段可切换取值来源。
 */
const DIAGRAM_LABELS: Readonly<Record<string, string>> = {
  mermaid: 'Mermaid',
  plantuml: 'PlantUML',
  c4plantuml: 'PlantUML C4',
  graphviz: 'Graphviz',
  d2: 'D2',
  dbml: 'DBML',
  vega: 'Vega',
  vegalite: 'Vega-Lite',
  excalidraw: 'Excalidraw',
  bpmn: 'BPMN',
  nomnoml: 'Nomnoml',
  svgbob: 'SVGBob',
  pikchr: 'Pikchr',
  ditaa: 'Ditaa',
  blockdiag: 'BlockDiag',
  nwdiag: 'NWDiag',
  actdiag: 'ActDiag',
  seqdiag: 'SeqDiag',
  erd: 'ERD',
  structurizr: 'Structurizr',
  bytefield: 'Bytefield',
  wavedrom: 'WaveDrom',
  tikz: 'TikZ',
  umlet: 'UMLet',
  goat: 'Goat',
  wireviz: 'WireViz',
  packetdiag: 'PacketDiag',
  rackdiag: 'RackDiag',
  symbolator: 'Symbolator'
};

/**
 * 生效模式裁决（md 管线 effectiveModeOf 同构，pipeline.ts:200）：请求模式按能力
 * 裁决，未生效模式按注册表能力降级（server 需 serverDiagramOf 宣告；official 需
 * officialServer 型；local 需本地引擎；kroki 需 krokiType）。
 */
function resolveEffectiveMode(diagram: DiagramType, dOpts: DiagramRenderOptions | null): DiagramMode {
  const requested = dOpts?.modeOf(diagram.id) ?? diagram.defaultMode;
  const localCapable = diagram.local && !!diagram.engine;
  const krokiCapable = !!diagram.krokiType;
  if (requested === 'server') {
    if (dOpts?.serverDiagramOf?.(diagram.id)) return 'server';
    return localCapable ? 'local' : krokiCapable ? 'kroki' : 'source';
  }
  if (requested === 'official') {
    if (diagram.officialServer) return 'official';
    return localCapable ? 'local' : krokiCapable ? 'kroki' : 'source';
  }
  if (requested === 'local') {
    return localCapable ? 'local' : krokiCapable ? 'kroki' : 'source';
  }
  if (requested === 'kroki') return krokiCapable ? 'kroki' : 'source';
  return 'source';
}

/** 降级/失败原因文本（Error message 优先，其余 String 化）。 */
function reasonText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** server/kroki-server 响应形状守卫（md 管线同款：svg 必须为非空 string）。 */
function isSvgPayload(data: unknown): data is { svg: string } {
  return (
    typeof data === 'object' &&
    data !== null &&
    typeof (data as { svg?: unknown }).svg === 'string' &&
    (data as { svg: string }).svg !== ''
  );
}

/**
 * 失败提示卡（renderDegradedCode 卡结构同款：vv-error-* 类面由 app.css 供给）。
 * showStatusNotice 是 web 层助手（apps/web/src），渲染器包不可 import——按 html.ts
 * 先例在渲染器内以同语义提示卡承接：失败原因落在回退源码视图的提示区。
 */
function failureCard(detail: string): HTMLElement {
  const card = document.createElement('div');
  card.className = 'vv-error-card vv-oversize-card';
  const title = document.createElement('div');
  title.className = 'vv-error-title';
  title.textContent = '图表渲染失败，已回退源码视图';
  const detailEl = document.createElement('div');
  detailEl.className = 'vv-error-detail';
  detailEl.textContent = detail;
  card.append(title, detailEl);
  return card;
}

type DiagramView = 'rendered' | 'source';

/**
 * 单个图表文件渲染体（29 型共享，按 diagram 注册表条目参数化）：大小门先行 →
 * 文本解码 → 模式裁决 → 三分发失败降级链 → 双视图切换（html.ts 机制同构移植：
 * 缓存复挂载闭包，切换不重调引擎、不重读文件）。ctx（流式上下文）不消费——
 * streaming false，buffer 恒全量。
 */
async function renderDiagramFileBuffer(
  diagram: DiagramType,
  opts: DiagramFileRenderOpts,
  buffer: Uint8Array,
  target: HTMLElement,
  source: FileSource,
  det: Detection
): Promise<RenderedInstance> {
  // 大小门（spec §5.2）：>2MB 不进任何引擎/kroki/服务端路径，直落源码视图 +
  // 降级提示卡（renderDegradedCode 结构同构——其卡文案硬编码 MARKUP_MAX_BYTES=20MB
  // 阈值，图表门是 2MB，按同结构自建卡取正确阈值；类面零新增）。
  if (buffer.byteLength > DIAGRAM_MAX_BYTES) {
    target.classList.add('vv-html', 'vv-degraded'); // 撑满宿主高度（同正常路径）+ 降级排布
    const card = document.createElement('div');
    card.className = 'vv-error-card vv-oversize-card';
    const title = document.createElement('div');
    title.className = 'vv-error-title';
    title.textContent = '图表文件过大，已降级显示';
    const detail = document.createElement('div');
    detail.className = 'vv-error-detail';
    detail.textContent = `文件超过 ${DIAGRAM_MAX_BYTES / 1024 / 1024}MB，图表渲染已跳过（避免长时间阻塞），已降级为源码视图。`;
    const meta = document.createElement('div');
    meta.className = 'vv-error-meta';
    meta.textContent = source.name;
    card.append(title, detail, meta);
    const degraded = document.createElement('div');
    degraded.className = 'vv-degraded-content';
    target.replaceChildren(card, degraded);
    const codeInst = renderCode(buffer, degraded, {
      encoding: det.encoding,
      highlight: true,
      ext: det.ext,
      oversizeNotice: false // 降级卡已存在：不叠加超限提示条（BUG-20 防重复）
    });
    const instance: RenderedInstance & { toggleView(): void } = {
      destroy() {
        codeInst.destroy();
        target.replaceChildren();
        target.classList.remove('vv-html', 'vv-degraded');
      },
      toggleView() {
        // 降级视图无渲染视图可切：保持接口形状，操作为空
      },
      search(query: string, searchOpts?: { caseSensitive?: boolean }) {
        return codeInst.search(query, searchOpts);
      },
      gotoMatch(index: number) {
        codeInst.gotoMatch(index);
      }
    };
    return instance;
  }

  const dOpts = getDiagramOptions();
  const mode = resolveEffectiveMode(diagram, dOpts);
  const doc = target.ownerDocument;
  const text = decodeText(buffer, det.encoding);
  const localCapable = diagram.local && !!diagram.engine;

  let destroyed = false;
  let view: DiagramView = 'rendered';
  let codeInst: RenderCodeHandle | null = null;
  /** 成功渲染的复挂载闭包缓存（切换不重调引擎/不重发请求——不重读文件的实现面） */
  let renderedMount: (() => void) | null = null;
  /** 失败回退原因（非空时源码视图顶部出提示卡；新链启动或渲染成功即清） */
  let failureNotice: string | null = null;
  /** 在飞渲染链代币（M4）：attemptRendered 启动新链时自增，旧链迟到落定比对过期即整体作废 */
  let chainToken = 0;
  /** BUG-44 同款：视图切换订阅（SearchPanel 重扫）；destroy 清空防迟滞回调 */
  const viewListeners = new Set<() => void>();

  // DOM 骨架（html.ts 双视图机制同构移植：toolbar 两钮 + content 单活动视图）。
  // 类名复用 vv-html-* 既有样式钩（app.css 单一来源，渲染器不注入 CSS）；source
  // 生效模式无渲染视图可切，不建 toolbar（md 管线 withToggle=false 同语义）。
  target.classList.add('vv-html');
  const content = doc.createElement('div');
  content.className = 'vv-html-content';
  let renderedBtn: HTMLButtonElement | null = null;
  let sourceBtn: HTMLButtonElement | null = null;
  if (mode !== 'source') {
    const toolbar = doc.createElement('div');
    toolbar.className = 'vv-html-toolbar';
    renderedBtn = doc.createElement('button');
    renderedBtn.type = 'button';
    renderedBtn.className = 'vv-html-btn-rendered active';
    renderedBtn.textContent = '渲染';
    sourceBtn = doc.createElement('button');
    sourceBtn.type = 'button';
    sourceBtn.className = 'vv-html-btn-source';
    sourceBtn.textContent = '源码';
    toolbar.append(renderedBtn, sourceBtn);
    target.replaceChildren(toolbar, content);
  } else {
    target.replaceChildren(content);
  }

  function updateButtons(): void {
    renderedBtn?.classList.toggle('active', view === 'rendered');
    sourceBtn?.classList.toggle('active', view === 'source');
  }

  function notify(): void {
    for (const cb of viewListeners) cb();
  }

  function unmount(): void {
    codeInst?.destroy();
    codeInst = null;
    content.replaceChildren();
  }

  /** 源码视图挂载（renderCode 同一高亮链，buffer 引用复用——不重读文件）；失败回退时附提示卡 */
  function mountSource(): void {
    // M3（Task 4 评审）：重挂前先卸旧实例——showSourceFallback 在源码视图已生效时迟到
    // 触发（如 kroki img error 晚于用户切源码）会在此重挂，不卸旧则双份高亮实例叠加。
    unmount();
    target.classList.toggle('vv-degraded', failureNotice !== null);
    if (failureNotice) content.append(failureCard(failureNotice));
    const holder = doc.createElement('div');
    holder.className = 'vv-degraded-content';
    content.append(holder);
    codeInst = renderCode(buffer, holder, { encoding: det.encoding, highlight: true, ext: det.ext });
  }

  // ---------- 三分发失败降级链（md 管线 renderDiagramBlock 同构） ----------

  /** 服务端单图渲染（md 管线 renderServerDiagram 同款形状）：POST /api/compute/diagram {lang, source} → {svg}。 */
  async function serverDiagramHtml(): Promise<string> {
    const data = await opts.remoteCall!('/api/compute/diagram', {
      method: 'POST',
      body: { lang: diagram.id, source: text }
    });
    if (!isSvgPayload(data)) throw new Error('服务端图表渲染失败：响应缺 svg');
    return sanitizeDiagramFragment(doc, data.svg);
  }

  /** kroki 服务端代发（md 管线 renderKrokiViaServer 同款形状）：POST /api/kroki {lang: krokiType, source} → {svg}。 */
  async function krokiServerHtml(): Promise<string> {
    const data = await opts.remoteCall!('/api/kroki', {
      method: 'POST',
      body: { lang: diagram.krokiType, source: text }
    });
    if (!isSvgPayload(data)) throw new Error('kroki 服务端代发失败：响应缺 svg');
    return sanitizeDiagramFragment(doc, data.svg);
  }

  /** 本地引擎渲染：renderer 透传（spec §9.1 rendererOf 注入）；falsy 结果同失败（switch 无 default 的落空路径）。 */
  async function localEngineHtml(): Promise<string> {
    const html = await renderDiagramEngine(diagram.engine!, text, {
      mermaidTheme: dOpts?.mermaidTheme ?? 'default',
      renderer: dOpts?.rendererOf?.(diagram.id)
    });
    if (!html) throw new Error('图表引擎返回空结果');
    return sanitizeDiagramFragment(doc, html);
  }

  function mountHtml(html: string): () => void {
    return () => {
      content.innerHTML = html;
    };
  }

  function mountImg(url: string, onError: (img: HTMLImageElement) => void): () => void {
    return () => {
      const img = doc.createElement('img');
      img.setAttribute('alt', diagram.id);
      img.setAttribute('src', url);
      // img error 仅真浏览器可派（jsdom 不派）：kroki/官方服务器不可达兜底回退
      img.addEventListener('error', () => onError(img));
      content.replaceChildren(img);
    };
  }

  /** 失败终态：回退源码视图 + 提示卡（失败原因入提示区，showStatusNotice 的渲染器内承接语义） */
  function showSourceFallback(reason: string): void {
    failureNotice = reason;
    if (destroyed) return;
    if (view !== 'source') {
      view = 'source';
      updateButtons();
      notify();
    }
    mountSource();
  }

  /** kroki 挂载链：krokiVia=server 且 krokiProxy 宣告先试 /api/kroki 代发（失败回落 client img 直发）。 */
  async function mountKroki(): Promise<() => void> {
    if (dOpts?.krokiVia === 'server' && dOpts.krokiProxy && opts.remoteCall) {
      try {
        return mountHtml(await krokiServerHtml());
      } catch {
        /* 代发失败：回落 client img 直发（md 管线同分叉） */
      }
    }
    const url = await createKrokiUrl(dOpts?.krokiHost ?? DEFAULT_KROKI_HOST, diagram.krokiType, text);
    // M1（Task 4 评审，md 管线 kroki 分支同款）：kroki img error 且类型在注册表
    // officialServer（plantuml/c4plantuml）且 kroki 上游为公共默认 kroki.io 时，src 换
    // PlantUML 官方服务器 URL（createPlantumlUrl）重试一跳——同一 img/监听器承接两跳，
    // 换 src 后再 error 落源码回退；自建 krokiHost 不回落（用户明确指定的服务端不得把
    // 源码静默扩散到第三方，隐私防线），直落源码回退与既有形态一致。
    const host = (dOpts?.krokiHost || DEFAULT_KROKI_HOST).replace(/\/+$/, '');
    let officialTried = false;
    return mountImg(url, (img) => {
      // 终态文案与 md 管线 krokiErrorText 对齐（pipeline.ts resolveUiTexts）：官方重试
      // 一跳也败用「kroki 与官方服务器渲染失败」两跳形态，单跳失败用基础文案
      const fallToSource = (): void =>
        showSourceFallback(
          officialTried
            ? `kroki 与官方服务器渲染失败（图片加载错误）：${diagram.id}`
            : `kroki 渲染失败（图片加载错误）：${diagram.id}`
        );
      if (diagram.officialServer && !officialTried && host === DEFAULT_KROKI_HOST) {
        officialTried = true;
        // 编码外溢失败（pako/btoa 桩炸）直落源码回退；URL 构造成功才换 src
        createPlantumlUrl(text).then((official) => img.setAttribute('src', official)).catch(fallToSource);
        return;
      }
      fallToSource();
    });
  }

  // official img error → 降 kroki 链（md 管线 official 档同语义）；迟到落定不覆盖已切视图
  const officialImgError = (): void => {
    mountKroki()
      .then((mount) => {
        if (destroyed || view !== 'rendered') return;
        renderedMount = mount;
        failureNotice = null;
        target.classList.remove('vv-degraded');
        mount();
      })
      .catch((e: unknown) => showSourceFallback(reasonText(e)));
  };

  async function renderChain(): Promise<() => void> {
    let m = mode;
    if (m === 'server') {
      if (!opts.remoteCall) {
        // 未注入通道（未连接服务器）：跳过 server 按既有链降级（brief：无 remoteCall 走 local/kroki 回落）
        m = localCapable ? 'local' : 'kroki';
      } else {
        try {
          return mountHtml(await serverDiagramHtml());
        } catch {
          m = localCapable ? 'local' : 'kroki'; // spec §8.3 降级链 server→local→kroki
        }
      }
    }
    if (m === 'official') {
      try {
        return mountImg(await createPlantumlUrl(text), officialImgError);
      } catch {
        /* 编码外溢失败：降 kroki 链 */
      }
    }
    if (m === 'local') {
      try {
        return mountHtml(await localEngineHtml());
      } catch (e) {
        if (!diagram.krokiType) throw e; // 无 krokiType（math 档形态）：终态源码回退
        // 引擎失败：降 kroki img（md 管线同链，29 型 krokiType 恒非空）
        void e;
      }
    }
    return mountKroki();
  }

  /**
   * 渲染视图挂载（缓存命中直接复挂载；未命中走分发链，失败落源码回退）。
   * M4 在飞守卫：链启动即取代币并清上一链失败态（源码视图残卡 DOM 已随 setView
   * unmount 清空）——快速 render→source→render 连切时新链使旧链迟到落定整体作废
   * （不覆盖 DOM/不复活失败卡），只有当前链可落定或置失败态。
   */
  async function attemptRendered(): Promise<void> {
    if (renderedMount) {
      renderedMount();
      return;
    }
    const token = ++chainToken;
    failureNotice = null;
    target.classList.remove('vv-degraded');
    try {
      const mount = await renderChain();
      if (token !== chainToken) return; // 已被新链取代：迟到落定作废（DOM/失败卡都不动）
      renderedMount = mount;
      if (destroyed || view !== 'rendered') return; // 迟到落定：不覆盖用户已切视图
      mount();
    } catch (e) {
      if (destroyed || token !== chainToken) return;
      showSourceFallback(reasonText(e));
    }
  }

  function setView(next: DiagramView): void {
    if (destroyed || next === view) return;
    unmount();
    view = next;
    updateButtons();
    if (next === 'source') {
      mountSource();
      notify();
      return;
    }
    notify();
    void attemptRendered();
  }

  renderedBtn?.addEventListener('click', () => setView('rendered'));
  sourceBtn?.addEventListener('click', () => setView('source'));

  if (mode === 'source') {
    view = 'source';
    mountSource();
  } else {
    await attemptRendered();
  }

  const toggleable = mode !== 'source';
  // 实例面（html 渲染器同构）：RenderedInstance + toggleView/onViewChanged 扩展
  // （core 类型不含，消费方鸭子探测；SearchPanel 经 onViewChanged 重扫，BUG-44 同款）
  const instance: RenderedInstance & {
    toggleView(): void;
    onViewChanged(cb: () => void): () => void;
  } = {
    destroy() {
      destroyed = true;
      viewListeners.clear();
      codeInst?.destroy();
      codeInst = null;
      renderedMount = null;
      target.replaceChildren();
      target.classList.remove('vv-html', 'vv-degraded');
    },
    toggleView() {
      if (!toggleable) return;
      setView(view === 'rendered' ? 'source' : 'rendered');
    },
    // BUG-44 同款：视图切换订阅（SearchPanel 重扫）；返回退订函数
    onViewChanged(cb: () => void): () => void {
      viewListeners.add(cb);
      return () => viewListeners.delete(cb);
    },
    // 文件内搜索（html 渲染器同款）：源码视图复用 code 实现；渲染视图返回空结果
    search(query: string, searchOpts?: { caseSensitive?: boolean }) {
      return view === 'source' && codeInst ? codeInst.search(query, searchOpts) : Promise.resolve([]);
    },
    gotoMatch(index: number) {
      if (view === 'source') codeInst?.gotoMatch(index);
    }
  };
  return instance;
}

/**
 * 29 个图表文件渲染器（id `diagram-<type>`，label 取可读名，streaming false——
 * 图表源按全量文本渲染，三分发/回退/大小门都建立在全量在手前提上）。
 * 映射表类型若与 diagram 注册表漂移（resolveDiagramType 落空）即抛错——注册一个
 * 不可达 id 属装配期错误，宁可响 fail-fast 也不静默缩容。
 * opts.remoteCall 供 server 分支与 kroki 服务端代发使用（Task 5 装配注入）。
 */
export function createDiagramFileRenderers(opts: DiagramFileRenderOpts): Renderer[] {
  return Object.entries(DIAGRAM_FILE_EXTS).map(([type, extensions]) => {
    const diagram = resolveDiagramType(type);
    if (!diagram) throw new Error(`diagramFile: 映射表类型 "${type}" 不在 diagram 注册表`);
    return {
      id: `diagram-${type}`,
      label: DIAGRAM_LABELS[diagram.id] ?? diagram.id,
      extensions: [...extensions],
      streaming: false,
      async render(buffer: Uint8Array, target: HTMLElement, source: FileSource, det: Detection) {
        return renderDiagramFileBuffer(diagram, opts, buffer, target, source, det);
      }
    };
  });
}
