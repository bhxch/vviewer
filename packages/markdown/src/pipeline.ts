/// <reference path="./types/katex-min-css.d.ts" />
// （ambient 模块声明随本指令进入每个拉入 pipeline 源的编译单元——ambient declare
// module 不随 import 图传播，reference 指令是唯一收进通道，markdown-engine 五垫片
// 同款；发布态由 pack copies 复制到 dist/types/ 并回注 dist/index.d.ts。）

// pipeline.ts — markdown 渲染五步管线（移植自 markpad src/lib/pipeline/index.ts 的
// 固定顺序与单步容错语义，按 vviewer M3 契约裁剪）：highlight → diagrams → katex
// → copyCode → lightbox。输入是净化后的 Document（sanitize 在管线外完成）。
// - highlight 步经注入回调（依赖倒置）：管线只认 highlightFence 注入缝，包内默认
//   实现为 highlightDefault.ts（主线程 tree-sitter），应用侧可注入自己的 worker
//   client；null 返回时管线内 hljs 兜底（动态 import）。
// - diagrams 步查 diagrams.ts 注册表分发（spec 2026-10-19 §2.1/§2.2）：图表语言
//   走 local 引擎（diagramEngines 动态 import）/ kroki img / 源码面板三分支，
//   重库一律懒加载；katex/highlight.js 同样动态 import。
// - 每步独立 try/catch：单步失败不阻塞后续步骤。
// （自 render-text/src/markdown/pipeline.ts 迁入；UI 文案（复制徽标/图源切换/
//   错误卡）参数化为 PipelineUiTexts，缺省值=原中文文案。）

import { resolveDiagramType, createKrokiUrl, createPlantumlUrl, DEFAULT_KROKI_HOST, type DiagramMode, type DiagramType, renderDiagramEngine } from '@vviewer/render-diagram';
import { sanitizeDiagramFragment } from '@vviewer/sanitize';

export interface PipelineCtx {
  /**
   * 围栏代码高亮回调：返回 span HTML（如 HighlightClient 区间 + captureToCssClass
   * 生成），插入 code 元素；返回 null 时管线内 hljs 兜底；抛错（取消：tab 切换后
   * 请求作废）时静默跳过该块、不 hljs 兜底（结果即将随文档丢弃）。
   */
  highlightFence: (code: string, lang: string) => Promise<string | null>;
  /** 主题类前缀：管线生成元素（复制按钮/mermaid 容器/灯箱）的类名前缀，供主题作用域样式。 */
  themeClassPrefix?: string;
  /**
   * 灯箱归属实例代币（遗留 U3）：body 级 overlay 是跨渲染实例的单例，markdownRenderer
   * 每次 render 生成唯一值传入；openLightbox 把"最后打开者"记在 overlay 上，
   * removeLightboxOverlay 只许 owner 随自身 destroy 摘除——多 markdown 实例（多 tab）
   * 共存时，B 实例的 destroy 不得互删 A 正开着的灯箱。
   */
  lightboxOwner?: string;
  /**
   * 灯箱画廊收集域（挂载容器）：管线在 DOMParser detached doc 上运行，挂载时节点
   * 被收养出该 doc（markdownRenderer target.replaceChildren）——点击发生在收养后，
   * collectGallery 若仍对管线期 root 查询必得空画廊（每图退化为单条，e2e 实证）。
   * 点击时对收集域活查询（而非管线期快照）还使 resolveRelativeImages 改写后的
   * img src、图表主题就地重画后的 svg 外层 HTML 均取到最新值。缺省回退 root
   * （单元测试节点未离开 doc 的场景）。
   */
  galleryScope?: ParentNode;
  /**
   * 图表分发选项（注入反转，本包内类型自 markdownRenderer；未注入时
   * 按注册表 defaultMode 走）：kroki host / mermaid 主题 / 语言→模式映射由
   * 宿主侧按自身配置解析，管线不感知存储实现。
   */
  diagram?: import('./markdownRenderer').DiagramRenderOptions;
  /** UI 文案（复制徽标/图源切换钮/错误卡等；缺省用中文默认值 DEFAULT_UI_TEXTS）。 */
  ui?: PipelineUiTexts;
}

/**
 * 管线产出的用户可见文案（复制徽标/图源切换/图表错误卡）：全部可选，缺省=
 * 原中文文案。错误卡为模板函数（错误文案内嵌语言 id）。
 */
export interface PipelineUiTexts {
  /** 复制徽标 title（悬停提示） */
  copyTitle?: string;
  /** 无语言围栏的徽标词 */
  copyLabel?: string;
  /** 复制成功反馈 */
  copiedLabel?: string;
  /** 复制失败反馈 */
  copyFailedLabel?: string;
  /** 图表 wrapper「图」切换钮词（源码态显示） */
  diagramLabel?: string;
  /** 图表 wrapper「源码」切换钮词（图态显示） */
  sourceLabel?: string;
  /** kroki img 失败错误卡文案（officialTried=已试过官方服务器 fallback 档的两跳形态） */
  krokiErrorText?: (lang: string, officialTried: boolean) => string;
  /** 官方服务器显式档失败错误卡文案 */
  officialErrorText?: (lang: string) => string;
}

/** UI 文案缺省值（=迁移前 render-text 管线的硬编码中文文案，零漂移）。 */
export const DEFAULT_UI_TEXTS: Required<Pick<PipelineUiTexts, 'copyTitle' | 'copyLabel' | 'copiedLabel' | 'copyFailedLabel' | 'diagramLabel' | 'sourceLabel'>> = {
  copyTitle: '点击复制代码',
  copyLabel: '复制',
  copiedLabel: '已复制',
  copyFailedLabel: '复制失败',
  diagramLabel: '图',
  sourceLabel: '源码'
};

/** 合并出全量文案：注入项覆盖缺省，未注入项用缺省（错误卡模板缺省=原硬编码文案）。 */
export function resolveUiTexts(ctx: PipelineCtx): Required<PipelineUiTexts> {
  return {
    ...DEFAULT_UI_TEXTS,
    krokiErrorText: (lang, officialTried) =>
      officialTried ? `kroki 与官方服务器渲染失败（${lang}）` : `kroki 渲染失败（${lang}）`,
    officialErrorText: (lang) => `官方服务器渲染失败（${lang}）`,
    ...ctx.ui
  };
}

export interface PipelineStep {
  name: 'highlight' | 'diagrams' | 'katex' | 'copyCode' | 'lightbox';
  run: (root: Document, ctx: PipelineCtx) => Promise<void>;
}

/** 生成元素的基础类名（可被 ctx.themeClassPrefix 前缀）。 */
const CLS = {
  codeBar: 'md-code-bar',
  codeLang: 'md-code-lang',
  diagram: 'md-diagram',
  diagramBar: 'md-diagram-bar',
  diagramLang: 'md-diagram-lang',
  diagramToggle: 'md-diagram-toggle',
  diagramView: 'md-diagram-view',
  diagramError: 'md-diagram-error',
  diagramSource: 'md-diagram-source',
} as const;

function cls(ctx: PipelineCtx, base: keyof typeof CLS): string {
  const name = CLS[base];
  return ctx.themeClassPrefix ? ctx.themeClassPrefix + name : name;
}

// ---------- highlight 步 ----------

async function runHighlight(root: Document, ctx: PipelineCtx): Promise<void> {
  for (const code of Array.from(root.querySelectorAll('pre code'))) {
    if (code.hasAttribute('data-md-highlight')) continue;
    const langClass = Array.from(code.classList).find((c) => c.startsWith('language-'));
    const lang = langClass ? langClass.slice('language-'.length) : '';
    // 图表语言归 diagrams 步（spec §2.1）：不 hljs 兜底不 tree-sitter（源码面板
    // 的高亮由 diagrams 步按注册表 highlightLang 自行调 highlightFence）
    if (resolveDiagramType(lang)) continue;
    code.setAttribute('data-md-highlight', '');
    // 围栏原始语言记录（Task 7 copyCode 徽标取词源，小写归一与 BUG-42 同规）：无语言
    // fence 经 hljs 兜底会被 highlightAuto 侦测并追加 language-* 类（实测 'plain' →
    // language-ebnf），copyCode 若届时从类名取词会把侦测语言误当围栏语言——故在高亮
    // 入口记录原始词，copyCode 只读此属性
    code.setAttribute('data-md-lang', lang.toLowerCase());
    // 围栏内容自带格式性尾换行（markdown-it 原样保留），高亮/复制均不应带上
    const raw = (code.textContent ?? '').replace(/\n$/, '');
    // 回调抛错（如取消：tab 切换后请求作废）→ 静默跳过该块，不走 hljs 兜底
    //（结果即将随整个文档被丢弃）；返回 null（普通失败）才回落 hljs
    let spanHtml: string | null;
    try {
      spanHtml = await ctx.highlightFence(raw, lang);
    } catch {
      continue;
    }
    if (spanHtml) {
      code.innerHTML = spanHtml;
      // BUG-42：tree-sitter 命中后语言类名同步小写归一——```Rust 缺陷态曾整块降级
      // hljs（cls "language-Rust hljs"）；归一后与同语言小写写法（```rust）类名一致
      if (langClass !== undefined && lang !== lang.toLowerCase()) {
        code.classList.replace(langClass, `language-${lang.toLowerCase()}`);
      }
      continue;
    }
    // 兜底：注入回调失败/null → hljs 全量包
    try {
      const hljs = (await import('highlight.js')).default;
      hljs.highlightElement(code as HTMLElement);
    } catch {
      /* 保留原文 */
    }
  }
}

// ---------- diagrams 步（注册表分发：local/kroki/source，spec 2026-10-19 §2.1/§2.2） ----------

async function runDiagrams(root: Document, ctx: PipelineCtx): Promise<void> {
  // 服务端图表 div（compute markdown 后处理产物，spec §2.5）先于 fence 接回标准
  // wrapper——契约属性 div 不是 pre>code，两个循环互不命中
  wrapServerDiagrams(root, ctx);
  for (const code of Array.from(root.querySelectorAll('pre > code'))) {
    const langClass = Array.from(code.classList).find((c) => c.startsWith('language-'));
    if (!langClass) continue;
    const type = resolveDiagramType(langClass.slice('language-'.length));
    if (!type) continue;
    if (code.hasAttribute('data-md-diagram')) continue;
    code.setAttribute('data-md-diagram', '');
    // per-block 兜底（P2 终审移交 M2）：renderDiagramBlock 内部 catch 已兜引擎失败与
    // 回退链，此处兜其外溢错误（如 kroki 编码内 pako 惰性 import 失败）——单块失败
    // 不得中断后续块；该块保留 wrapper 半成品或原 pre 形态，负结果不缓存
    try {
      await renderDiagramBlock(code as HTMLElement, type, ctx);
    } catch (e) {
      console.warn('diagram 块渲染失败（不中断后续块）', e);
    }
  }
}

/**
 * 生效模式解析（含能力回退链）：local 未启用→kroki（krokiType 空则 source）；
 * kroki 无类型→source；server（spec §8.3）按注入能力协商（serverDiagramOf），
 * 未命中按既有链降级——恰好 graphviz/svgbob 两类都有前端本地引擎，降级链全通；
 * official（官方服务器第五档）仅注册表 officialServer 两类可生效，不支持类型按
 * server 同款链降级（local→kroki→source）。
 */
function effectiveModeOf(type: DiagramType, ctx: PipelineCtx): DiagramMode {
  const requested = ctx.diagram?.modeOf(type.id) ?? type.defaultMode;
  if (requested === 'server') {
    if (ctx.diagram?.serverDiagramOf?.(type.id)) return 'server';
    if (type.local && type.engine) return 'local';
    return type.krokiType ? 'kroki' : 'source';
  }
  if (requested === 'official') {
    if (type.officialServer) return 'official';
    if (type.local && type.engine) return 'local';
    return type.krokiType ? 'kroki' : 'source';
  }
  if (requested === 'local') {
    if (type.local && type.engine) return 'local';
    return type.krokiType ? 'kroki' : 'source';
  }
  if (requested === 'kroki') return type.krokiType ? 'kroki' : 'source';
  return 'source';
}

/**
 * 服务端单图渲染（spec 2026-10-23 §8.3）：POST /api/compute/diagram
 * {lang, source} → {svg}，{url, headers} 经注入的 remoteCall 缝取（remoteMarkdown
 * 同款形态；lang 为注册表归一 id，服务端 canonical_of 二次归一）。未连接/非 ok/
 * 响应缺 svg 一律抛错，由调用方按降级链回退；svg 先经 sanitizeDiagramFragment
 * 净化（服务端上下文 style 豁免面，同 wrapServerDiagrams 承接语义）再返回。
 */
async function renderServerDiagram(lang: string, source: string, ctx: PipelineCtx, doc: Document): Promise<string> {
  const call = ctx.diagram?.remoteCall?.('/api/compute/diagram');
  if (!call) throw new Error('未连接服务器，无法服务端渲染图表');
  const res = await fetch(call.url, {
    method: 'POST',
    headers: { ...call.headers, 'content-type': 'application/json' },
    body: JSON.stringify({ lang, source })
  });
  if (!res.ok) throw new Error(`服务端图表渲染失败: HTTP ${res.status}`);
  const data = (await res.json()) as { svg?: unknown };
  if (typeof data.svg !== 'string' || data.svg === '') throw new Error('服务端图表渲染失败：响应缺 svg');
  return sanitizeDiagramFragment(doc, data.svg);
}

/**
 * kroki 服务端代发（spec 2026-10-23 §8.2/§8.3）：POST /api/kroki {lang, source} →
 * {svg}（protected 组、不挂 native 门，kroki-proxy 恒宣告），lang 为 kroki 类型名
 * （krokiType，与 img 直发的 URL 段一致）。失败语义与 renderServerDiagram 相同：
 * 抛错交调用方回落 client img 直发（img error 既有路径兜错误卡）。
 */
async function renderKrokiViaServer(krokiType: string, source: string, ctx: PipelineCtx, doc: Document): Promise<string> {
  const call = ctx.diagram?.remoteCall?.('/api/kroki');
  if (!call) throw new Error('未连接服务器，无法代发 kroki 渲染');
  const res = await fetch(call.url, {
    method: 'POST',
    headers: { ...call.headers, 'content-type': 'application/json' },
    body: JSON.stringify({ lang: krokiType, source })
  });
  if (!res.ok) throw new Error(`kroki 服务端代发失败: HTTP ${res.status}`);
  const data = (await res.json()) as { svg?: unknown };
  if (typeof data.svg !== 'string' || data.svg === '') throw new Error('kroki 服务端代发失败：响应缺 svg');
  return sanitizeDiagramFragment(doc, data.svg);
}

/**
 * 图/源码切换接线（buildDiagramWrapper 的 withToggle 分支与服务端图表 wrapper 共享，
 * 切换语义一致）：节点挂载进主文档后监听器随节点保留——徽标按钮同款前提。首次切到
 * 源码时惰性高亮（图视图优先出图，源码高亮不挡首屏）：data-md-diag-src-hl 标记先行
 * 防连点重复请求；成功才写 innerHTML，null 失败/catch 静默保留纯文本（标记已写不
 * 重试——与 source 分支失败语义一致）。
 */
function wireDiagramToggle(
  ctx: PipelineCtx,
  toggle: HTMLButtonElement,
  view: HTMLElement,
  sourcePane: HTMLElement,
  sourceCode: HTMLElement,
  source: string,
  highlightLang: string,
): void {
  const ui = resolveUiTexts(ctx);
  toggle.addEventListener('click', () => {
    const showSource = sourcePane.hasAttribute('hidden');
    sourcePane.toggleAttribute('hidden', !showSource);
    view.toggleAttribute('hidden', showSource);
    toggle.textContent = showSource ? ui.diagramLabel : ui.sourceLabel;
    if (showSource && highlightLang && !sourcePane.hasAttribute('data-md-diag-src-hl')) {
      sourcePane.setAttribute('data-md-diag-src-hl', '');
      ctx.highlightFence(source, highlightLang).then((spanHtml) => {
        if (spanHtml) sourceCode.innerHTML = spanHtml;
      }).catch(() => { /* 取消等：保留纯文本 */ });
    }
  });
}

/**
 * wrapper 骨架构造（bar/view/sourcePane 三段；withToggle=true 附带「源码」切换钮
 * 与共享监听，false 为 source-only 形态——无图视图可切，连 DOM 都不加，bar 只留
 * 语言徽标）。只构造不落位：调用方决定 replaceWith 时机（fence 路径换 pre，服务端
 * 路径先把原 div 搬进视图面板）。
 */
function buildDiagramWrapper(
  doc: Document,
  ctx: PipelineCtx,
  opts: { langLabel: string; highlightLang: string; source: string; withToggle: boolean },
): {
  wrap: HTMLElement;
  toggle: HTMLButtonElement | null;
  view: HTMLElement;
  sourcePane: HTMLElement;
  sourceCode: HTMLElement;
} {
  const wrap = doc.createElement('div');
  wrap.className = cls(ctx, 'diagram');
  const bar = doc.createElement('div');
  bar.className = cls(ctx, 'diagramBar');
  const label = doc.createElement('span');
  label.className = cls(ctx, 'diagramLang');
  label.textContent = opts.langLabel;
  bar.append(label);
  const view = doc.createElement('div');
  view.className = cls(ctx, 'diagramView');
  const sourcePane = doc.createElement('div');
  sourcePane.className = cls(ctx, 'diagramSource');
  sourcePane.setAttribute('hidden', '');
  const sourceCode = doc.createElement('code');
  if (opts.highlightLang) sourceCode.className = `language-${opts.highlightLang}`;
  sourceCode.textContent = opts.source;
  sourcePane.appendChild(sourceCode);
  wrap.append(bar, view, sourcePane);
  let toggle: HTMLButtonElement | null = null;
  if (opts.withToggle) {
    toggle = doc.createElement('button');
    toggle.type = 'button';
    toggle.className = cls(ctx, 'diagramToggle');
    toggle.textContent = resolveUiTexts(ctx).sourceLabel;
    bar.append(toggle);
    wireDiagramToggle(ctx, toggle, view, sourcePane, sourceCode, opts.source, opts.highlightLang);
  }
  return { wrap, toggle, view, sourcePane, sourceCode };
}

/**
 * 服务端图表 div（Task 2 契约：compute markdown 后处理产物，spec §2.5）接回标准
 * wrapper：svg 原样搬入视图面板（sanitize 上下文豁免已保其引擎 style，见
 * sanitize.ts）；源码面板收 data-diagram-src——getAttribute 经 DOM 解析自动反解码
 * HTML 实体为原文；图/源码切换与本地 fence 同构（buildDiagramWrapper withToggle
 * 路径共享 wireDiagramToggle，含首次切源码惰性高亮）。双保险防二次命中：
 * data-md-diagram-wrapped 标记 + 摘除 data-vv-diagram 契约属性。
 */
function wrapServerDiagrams(root: Document, ctx: PipelineCtx): void {
  for (const el of Array.from(root.querySelectorAll('[data-vv-diagram="server"]'))) {
    if (el.hasAttribute('data-md-diagram-wrapped')) continue;
    el.setAttribute('data-md-diagram-wrapped', '');
    const lang = el.getAttribute('data-diagram-lang') ?? '';
    const source = el.getAttribute('data-diagram-src') ?? '';
    const type = resolveDiagramType(lang);
    const w = buildDiagramWrapper(el.ownerDocument, ctx, {
      langLabel: lang,
      highlightLang: type?.highlightLang ?? '',
      source,
      withToggle: true
    });
    el.replaceWith(w.wrap); // wrapper 先占位；后搬入——若先 append 后 replaceWith，
    // 替换会相对 el 的新父节点（view）执行，wrap 嵌进自身 view 成环（HierarchyRequest）
    w.view.appendChild(el); // svg 原样搬入视图面板（sanitize 已过）
    el.removeAttribute('data-vv-diagram'); // 防二次命中
  }
}

/**
 * 单个图表围栏 → wrapper（bar/view/sourcePane 三段）+ 按生效模式填充：
 * - source：withToggle=false 构造（无图视图可切，不生成 toggle），bar 只留语言徽标、
 *   源码面板展开（highlightLang 命中时源码走 highlightFence）；
 * - kroki：视图为 img（src 经 kroki deflate+base64url 编码；error 监听仅真浏览器
 *   生效——jsdom 需手动派发 error 事件断言）。plantuml/c4plantuml 带 fallback 档：
 *   error 且 krokiHost 为公共默认时换 PlantUML 官方服务器重试一跳，再失败落错误
 *   卡（文案标注两跳；自建 host 不回落）；krokiVia=server 且 krokiProxy 宣告时改
 *   走 /api/kroki 服务端代发内联 svg（失败回落 img 直发，fallback 档同样承接）；
 * - server（spec 2026-10-23 §8.3）：POST /api/compute/diagram 内联 svg（能力协商
 *   命中才到这，见 effectiveModeOf）；fetch 失败按 server→local→kroki 降级链重走
 *   分支（有本地引擎转 local、无引擎直转 kroki img）；
 * - official（官方服务器第五档）：img 直连官方服务器（不经 kroki），失败按
 *   official→kroki 降级链转 appendKrokiImg（其 fallback 档对官方 URL 再试一跳）；
 * - local：动态引擎渲染 svg/katex HTML 注入视图；失败按 spec §6 回退链降级——有
 *   krokiType 先降 kroki img（kroki img error 再落错误卡），无 krokiType 直落错误卡片
 *   （保留源码）。
 * mermaid 视图容器带 data-mermaid 源码属性（重渲染锚，Task 5 主题联动依赖）：
 * local/kroki/server 模式带，source 模式无（未渲染无需重渲染锚）；local 失败态同样
 * 保留——旧实现语义，渲染成功与否不影响锚存在。
 */
async function renderDiagramBlock(code: HTMLElement, type: DiagramType, ctx: PipelineCtx): Promise<void> {
  const source = (code.textContent ?? '').replace(/\n$/, '');
  const host = code.closest('pre') ?? code;
  const doc = code.ownerDocument;
  const ui = resolveUiTexts(ctx);
  // let：server fetch 失败的降级会改写生效模式重走分支（spec §8.3 server→local→kroki）
  let mode = effectiveModeOf(type, ctx);
  const w = buildDiagramWrapper(doc, ctx, {
    langLabel: type.id,
    highlightLang: type.highlightLang,
    source,
    withToggle: mode !== 'source'
  });
  host.replaceWith(w.wrap);

  // source 模式：无图视图可切——不生成 toggle（构造已按 withToggle=false 跳过），
  // 源码面板直接展开、视图隐藏（空 view 容器有 padding 不隐藏仍占空条）；否则
  //「图」钮点击后只能展示约一行高的空视图条，纯假交互
  if (mode === 'source') {
    w.view.setAttribute('hidden', '');
    w.sourcePane.removeAttribute('hidden');
    if (type.highlightLang) {
      try {
        const spanHtml = await ctx.highlightFence(source, type.highlightLang);
        if (spanHtml) w.sourceCode.innerHTML = spanHtml;
      } catch { /* 取消等：保留纯文本 */ }
    }
    return;
  }

  const { view, sourcePane, sourceCode } = w;
  const toggle = w.toggle!; // 非 source 模式恒为 withToggle=true 构造，toggle 必在

  // kroki img 构造（spec §6 回退链 local→kroki→错误卡+源码：kroki 模式直走；local
  // 引擎失败且有 krokiType 时复用同一段降级，全 local 引擎统一语义——mermaid/
  // graphviz/nomnoml/svgbob/CDN 四类同）。抽局部函数复用，勿复制分支体。
  const appendKrokiImg = async (): Promise<void> => {
    // krokiVia=server 分叉头部（spec §8.3）：能力协商（krokiProxy 宣告）成立先走
    // 服务端代发内联 svg（kroki-proxy 标容器承接）；代发失败（未连接/上游不可达）
    // 回落下方 client img 直发——img error 既有路径兜错误卡，与直发语义一致。
    if (ctx.diagram?.krokiVia === 'server' && ctx.diagram.krokiProxy) {
      try {
        const html = await renderKrokiViaServer(type.krokiType, source, ctx, doc);
        const holder = doc.createElement('div');
        holder.setAttribute('data-vv-diagram', 'kroki-proxy');
        holder.innerHTML = html;
        // 回退时整体重置视图：容器承接面语义与 img replaceChildren 同构
        view.replaceChildren(holder);
        // mermaid 视图同带重渲染锚（kroki img 态同款语义：主题重画走 local 引擎）
        if (type.id === 'mermaid') view.setAttribute('data-mermaid', source);
        return;
      } catch { /* 代发失败：回落 client img 直发（下方既有路径） */ }
    }
    const img = doc.createElement('img');
    img.setAttribute('alt', type.id);
    img.setAttribute('src', await createKrokiUrl(ctx.diagram?.krokiHost ?? DEFAULT_KROKI_HOST, type.krokiType, source));
    // 官方服务器 fallback 档（2026-10-30 调查实测锚）：kroki img error 且类型在
    // 注册表 officialServer（plantuml/c4plantuml）且 kroki 上游为公共默认
    // kroki.io 时，src 换 PlantUML 官方服务器 URL（createPlantumlUrl）重试一次
    // ——同一 img/监听器承接两跳（换 src 后再 error 走错误卡）；自建 krokiHost
    // 不回落（用户明确指定的服务端不得把源码静默扩散到第三方，隐私防线），
    // 直接落错误卡与既有形态一致。
    let officialTried = false;
    img.addEventListener('error', () => {
      const showErrorCard = () => {
        view.classList.add(cls(ctx, 'diagramError'));
        view.textContent = ui.krokiErrorText(type.id, officialTried);
        // 失败态文案卡可见（md-diagram-error 文本样式在案）+ 源码同展兜底可读——
        // 4-3：文案不得 hidden（66afead 补的 [hidden] display:none 兜底会把它藏掉，
        // 退化为台账所记「只露源码无失败文案」形态）；toggle 留「图」可切回文案卡
        sourcePane.removeAttribute('hidden');
        toggle.textContent = ui.diagramLabel;
      };
      if (
        type.officialServer &&
        !officialTried &&
        (ctx.diagram?.krokiHost || DEFAULT_KROKI_HOST).replace(/\/+$/, '') === DEFAULT_KROKI_HOST
      ) {
        officialTried = true;
        // 编码外溢失败（pako/btoa 桩炸）直落错误卡；URL 构造成功才换 src
        createPlantumlUrl(source).then((url) => img.setAttribute('src', url)).catch(showErrorCard);
        return;
      }
      showErrorCard();
    });
    // 回退时整体重置视图：引擎半成品不得残留（replaceChildren 替换非追加）
    view.replaceChildren(img);
    // 锚仅 mermaid 视图保留（Task 5 以 [data-mermaid] 选择器做主题重渲染，空属性
    // 同样命中选择器——plantuml/graphviz 等非 mermaid 视图不得设，否则被误重渲染）
    if (type.id === 'mermaid') view.setAttribute('data-mermaid', source);
  };

  if (mode === 'server') {
    try {
      const html = await renderServerDiagram(type.id, source, ctx, doc);
      view.innerHTML = html;
      // mermaid 若经服务端渲染（注册表宣告子集外，防御性同 kroki 态语义）保留重渲染锚
      if (type.id === 'mermaid') view.setAttribute('data-mermaid', source);
      return;
    } catch {
      // spec §8.3 降级链 server→local→kroki（错误卡由 local 分支既有路径兜底）：
      // fetch 抛错按「有本地引擎转 local（其自带 kroki/错误卡二级回退），无引擎
      // 直转 kroki img」重走分支——mode 已声明 let，此处改写生效模式
      mode = type.local && type.engine ? 'local' : 'kroki';
      if (mode === 'kroki') {
        await appendKrokiImg();
        return;
      }
    }
  }

  if (mode === 'kroki') {
    await appendKrokiImg();
    return;
  }

  // official（官方服务器第五档，plantuml/c4plantuml 专属）：img 直连官方服务器 URL
  //（createPlantumlUrl 编码，不经 kroki）。失败降级链 official→kroki——降级后
  // appendKrokiImg 的 fallback 档对刚失败的官方 URL 再试一跳（容忍瞬态故障），两跳
  // 全败落错误卡（文案「kroki 与官方服务器渲染失败」如实）。
  if (mode === 'official') {
    try {
      const img = doc.createElement('img');
      img.setAttribute('alt', type.id);
      img.setAttribute('src', await createPlantumlUrl(source));
      // 编码外溢失败（pako/btoa 炸）由 catch 兜 kroki img；img error 降级链如上。
      // appendKrokiImg 自身再抛（kroki 编码双异常环境）定卡收尾不留静默死 img
      img.addEventListener('error', () => {
        void appendKrokiImg().catch(() => {
          view.classList.add(cls(ctx, 'diagramError'));
          view.textContent = ui.officialErrorText(type.id);
          sourcePane.removeAttribute('hidden');
          toggle.textContent = ui.diagramLabel;
        });
      });
      view.replaceChildren(img);
      return;
    } catch {
      await appendKrokiImg();
      return;
    }
  }

  // local：spec §6 回退链——引擎失败且有 krokiType 先降级 kroki img（kroki 也失败，
  // img error 既有路径，才落错误卡+源码）；无 krokiType（math）直落错误卡保留源码。
  // renderer 透传（spec §9.1）：多渲染器类型（graphviz）按 rendererOf 注入选择，
  // 缺省 undefined = 注册表默认渲染器（viz-js）。
  try {
    const html = await renderDiagramEngine(type.engine!, source, {
      mermaidTheme: ctx.diagram?.mermaidTheme ?? 'default',
      renderer: ctx.diagram?.rendererOf?.(type.id)
    });
    view.innerHTML = html;
  } catch {
    if (type.krokiType) {
      await appendKrokiImg();
    } else {
      view.classList.add(cls(ctx, 'diagramError'));
      view.textContent = source;
    }
  }
  if (type.id === 'mermaid') view.setAttribute('data-mermaid', source); // 重渲染锚（成功/失败态都在）
}

// ---------- katex 步 ----------

// 公式扫描跳过的祖先标签：代码/脚本/样式内 $ 是字面量；.katex 防重入。
const MATH_SKIP_TAGS = new Set(['CODE', 'PRE', 'SCRIPT', 'STYLE', 'KATEX']);

type MathSegment = { kind: 'text'; value: string } | { kind: 'math'; value: string; display: boolean };

/**
 * 简单分隔符扫描：`$$...$$` 块级（可跨行）、`$...$` 行内（止于行尾，
 * 开定界符后与闭定界符前不允许紧邻空白——金额 $100 与 $200 不误判）、
 * `\(...\)` 行内与 `\[...\]` 块级（markpad 对齐；成对才触发，与 $ 同样
 * 收空内容/未闭合原文不动）。无有效公式返回空数组（原文不动）。
 */
function scanMathSegments(text: string): MathSegment[] {
  const segments: MathSegment[] = [];
  let buf = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '\\' && text[i + 1] === '(') {
      const end = text.indexOf('\\)', i + 2);
      const inner = end === -1 ? '' : text.slice(i + 2, end).trim();
      if (end !== -1 && inner) {
        if (buf) segments.push({ kind: 'text', value: buf });
        segments.push({ kind: 'math', value: inner, display: false });
        buf = '';
        i = end + 2;
        continue;
      }
    }
    if (ch === '\\' && text[i + 1] === '[') {
      const end = text.indexOf('\\]', i + 2);
      const inner = end === -1 ? '' : text.slice(i + 2, end).trim();
      if (end !== -1 && inner) {
        if (buf) segments.push({ kind: 'text', value: buf });
        segments.push({ kind: 'math', value: inner, display: true });
        buf = '';
        i = end + 2;
        continue;
      }
    }
    if (ch !== '$') {
      buf += ch;
      i += 1;
      continue;
    }
    if (text[i + 1] === '$') {
      const end = text.indexOf('$$', i + 2);
      const inner = end === -1 ? '' : text.slice(i + 2, end).trim();
      if (end !== -1 && inner) {
        if (buf) segments.push({ kind: 'text', value: buf });
        segments.push({ kind: 'math', value: inner, display: true });
        buf = '';
        i = end + 2;
        continue;
      }
      buf += '$$';
      i += 2;
      continue;
    }
    const next = text[i + 1] ?? '';
    if (next && !/[\s$]/.test(next)) {
      let j = i + 1;
      while (j < text.length && text[j] !== '$' && text[j] !== '\n') j += 1;
      if (text[j] === '$' && j > i + 1 && !/\s/.test(text[j - 1]!)) {
        if (buf) segments.push({ kind: 'text', value: buf });
        segments.push({ kind: 'math', value: text.slice(i + 1, j), display: false });
        buf = '';
        i = j + 1;
        continue;
      }
    }
    buf += '$';
    i += 1;
  }
  if (buf) segments.push({ kind: 'text', value: buf });
  return segments.some((s) => s.kind === 'math') ? segments : [];
}

async function runKatex(root: Document): Promise<void> {
  const scope: Node = root.body ?? root;
  const katex = (await import('katex').catch(() => null))?.default;
  if (!katex) return;
  // 公式排印样式（Task 2b 预览修复）：katex JS 产物（.katex/.vlist 等 span 结构）
  // 必须配 katex.min.css 才有排印（此前预览公式自 M3 起是无样式 HTML 的潜伏缺陷）。
  // 动态导入随 katex 步惰性加载：vite 构建抽为独立样式 chunk 按需注入，不进主包
  // （KatexCss 非 PWA globIgnores 的 diagram-engines 组，正常 precache）；加载失败
  // 仅降级为无排印（与修复前现状一致），不阻断公式排版。无 bundler 的独立使用需
  // 自行引入 katex css（README 注记）。
  await import('katex/dist/katex.min.css').catch(() => null);
  // mhchem 宏扩展（\ce{}）：必须走 .mjs 裸子路径——CJS 副本会产生第二解析器、
  // 宏表分裂（markpad #745）；与上面同一 katex 实例共享模块图（mhchem.mjs 顶层
  // import '../katex.mjs'，vite 按同一 resolved id 去重）。导入失败静默=无 \ce
  // 宏（throwOnError 保留原文），普通公式不受影响。
  await import('katex/contrib/mhchem').catch(() => null);

  const walker = root.createTreeWalker(scope, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      let cur: Node | null = node.parentNode;
      while (cur && cur !== scope) {
        if (cur.nodeType === 1 && MATH_SKIP_TAGS.has((cur as Element).tagName)) {
          return NodeFilter.FILTER_REJECT;
        }
        cur = cur.parentNode;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const targets: Text[] = [];
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const value = node.nodeValue ?? '';
    // $ 之外把 \( \[ 也列为候选（含无对闭合的），真正甄别交给 scanMathSegments
    if (value.includes('$') || value.includes('\\(') || value.includes('\\[')) {
      targets.push(node as Text);
    }
  }

  for (const target of targets) {
    const segments = scanMathSegments(target.nodeValue ?? '');
    if (segments.length === 0) continue;
    try {
      const frag = root.createDocumentFragment();
      for (const seg of segments) {
        if (seg.kind === 'text') {
          frag.appendChild(root.createTextNode(seg.value));
          continue;
        }
        const span = root.createElement('span');
        span.innerHTML = katex.renderToString(seg.value, { displayMode: seg.display, throwOnError: true });
        frag.appendChild(span);
      }
      target.replaceWith(frag);
    } catch {
      /* 非法 LaTeX：保留原文 */
    }
  }
}

// ---------- copyCode 步 ----------

/**
 * 代码块顶栏（Task 7；spec 2026-10-23 §5 重开拍板：徽标即复制单入口，markpad
 * copyCode.ts 对齐）：pre 首子元素 .md-code-bar 内单 button.md-code-lang——有语言
 * 显示语言词、无语言显示「复制」，点击即复制 code 文本（去尾换行），反馈文案
 * 1.5s 后回原词。原案「徽标只展示语言词、点击语义在右下角独立复制钮」的
 * 双触发面结构就此退役（右下角复制钮删除）。文案经 ctx.ui（缺省中文）。
 */
async function runCopyCode(root: Document, ctx: PipelineCtx): Promise<void> {
  const ui = resolveUiTexts(ctx);
  for (const pre of Array.from(root.querySelectorAll('pre'))) {
    if (pre.hasAttribute('data-md-copy')) continue;
    pre.setAttribute('data-md-copy', '');
    // span 而非 div：HTML 内容模型里 pre 只容 phrasing content（div 无效，
    // 浏览器容错但结构脏）；布局由 .md-code-bar 的 display:flex 规则保证
    const bar = root.createElement('span');
    bar.className = cls(ctx, 'codeBar');
    // 语言词取 highlight 步记录的围栏原始语言（小写）；属性缺失（步级失败等罕见
    // 路径）回落类名提取——此时 hljs 侦测类可能已污染，仅为尽力兜底
    const code = pre.querySelector('code');
    const langClass = code ? Array.from(code.classList).find((c) => c.startsWith('language-')) : undefined;
    const lang = code?.getAttribute('data-md-lang') ?? (langClass ? langClass.slice('language-'.length).toLowerCase() : '');
    const btn = root.createElement('button');
    btn.type = 'button';
    btn.className = cls(ctx, 'codeLang');
    btn.title = ui.copyTitle;
    const baseLabel = lang || ui.copyLabel;
    btn.textContent = baseLabel;
    // 复制反馈：成功/失败改 1.5s 文案，回徽标原词（连点时重置计时，避免旧计时
    // 提前还原）
    let revertTimer: ReturnType<typeof setTimeout> | null = null;
    const feedback = (text: string): void => {
      btn.textContent = text;
      if (revertTimer !== null) clearTimeout(revertTimer);
      revertTimer = setTimeout(() => {
        revertTimer = null;
        btn.textContent = baseLabel;
      }, 1500);
    };
    btn.addEventListener('click', () => {
      const text = (pre.querySelector('code')?.textContent ?? '').replace(/\n$/, '');
      const p = navigator.clipboard?.writeText(text);
      if (p) void p.then(() => feedback(ui.copiedLabel), () => feedback(ui.copyFailedLabel));
      else feedback(ui.copyFailedLabel); // 无剪贴板权限（非安全上下文等）
    });
    bar.appendChild(btn);
    pre.insertBefore(bar, pre.firstChild);
  }
}

// ---------- lightbox 步 ----------

// 灯箱本体（三导出 + overlay DOM/交互/状态机）在 @vviewer/lightbox 包；
// 此处 re-export 保住 markdownRenderer 与既有测试的 import 面：
export { removeLightboxOverlay, LIGHTBOX_OVERLAY_ID, LIGHTBOX_OWNER_ATTR } from '@vviewer/lightbox';
import { collectGallery, openLightbox } from '@vviewer/lightbox';

async function runLightbox(root: Document, ctx: PipelineCtx): Promise<void> {
  for (const img of Array.from(root.querySelectorAll('img'))) {
    if (img.hasAttribute('data-md-lightbox')) continue;
    img.setAttribute('data-md-lightbox', '');
    img.addEventListener('click', (ev) => {
      ev.preventDefault();
      // 点击时对收集域收集（挂载容器；未传时回退管线 root——节点仍在其内的
      // 单测场景）：同文档的 img 与图表 svg 可在灯箱内 ←/→ 连续导航
      openLightbox(img, ctx, collectGallery(ctx.galleryScope ?? root));
    });
  }
  // 图表 svg 同款接线（5-4）：collectGallery 已将 .md-diagram-view svg 入列（src 记
  // outerHTML 供灯箱回放），点击按元素身份定位开灯箱；防重复绑定代币与 img 同款。
  // KaTeX 产物无 .md-diagram-view 包裹，排除逻辑天然不涉 svg（照收集现状）。
  for (const svg of Array.from(root.querySelectorAll('.md-diagram-view svg'))) {
    if (svg.hasAttribute('data-md-lightbox')) continue;
    svg.setAttribute('data-md-lightbox', '');
    svg.addEventListener('click', (ev) => {
      ev.preventDefault();
      openLightbox(svg, ctx, collectGallery(ctx.galleryScope ?? root));
    });
  }
}

// ---------- 装配与执行 ----------

/** 当前配置下的五步有序列表（单一代码来源；runPipeline 即按此顺序执行）。 */
export function getPipelineSteps(ctx: PipelineCtx): PipelineStep[] {
  return [
    { name: 'highlight', run: (r, c) => runHighlight(r, c) },
    { name: 'diagrams', run: (r, c) => runDiagrams(r, c) },
    { name: 'katex', run: (r) => runKatex(r) },
    { name: 'copyCode', run: (r, c) => runCopyCode(r, c) },
    { name: 'lightbox', run: (r, c) => runLightbox(r, c) },
  ];
}

/** 顺序执行各步，单步 try/catch 不阻塞后续。 */
export async function runSteps(
  steps: readonly PipelineStep[],
  root: Document,
  ctx: PipelineCtx,
): Promise<void> {
  for (const step of steps) {
    try {
      await step.run(root, ctx);
    } catch {
      /* 单步失败不阻塞后续步骤 */
    }
  }
}

/** 五步管线入口：输入为净化后的 Document（sanitize/enrich 在外部完成后调用）。 */
export async function runPipeline(root: Document, ctx: PipelineCtx): Promise<void> {
  await runSteps(getPipelineSteps(ctx), root, ctx);
}
