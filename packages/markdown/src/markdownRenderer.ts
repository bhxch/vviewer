// markdownRenderer.ts — markdown 渲染器：五步管线的 Renderer 装配 + createMarkdownView
// 高层入口。render 链：markdown 引擎（注入后端或本地 markdown-it）→ sanitizeHtml
// → DOMParser 解析 → enrichMarkdownDom → runPipeline（highlightFence 注入）→ 挂载
// target → heading 赋 id → TOC 提取。
// 依赖倒置：围栏高亮经注入缝（setHighlightFence / options.highlightFence）注入，
// 未注入时用包内默认实现 highlightDefault（主线程 tree-sitter，CDN grammar），
// null 返回时管线内回落 hljs。（自 render-text/src/markdown/markdownRenderer.ts
// 迁入参数化：getRemoteBase → resolveRemoteBase 注入缝；vv:* 事件 → applyTheme
// 实例 API；UI 文案 → options.ui；图片 resolver → options.resolveImage。本包不
// 依赖 @vviewer/core——Renderer/RenderedInstance 等以结构类型自持，宿主 core 值
// 直接传入结构兼容。）
import {
  createMarkdownEngine,
  renderMarkdownToHtml,
  protectLatexDelimiters,
  GfmAnchorizer,
  parseFrontMatter
} from '@vviewer/markdown-engine';
import { sanitizeHtml } from '@vviewer/sanitize';
import { renderMermaidInto, resolveDiagramType, DEFAULT_KROKI_HOST, type DiagramMode, type MermaidTheme } from '@vviewer/render-diagram';
import { enrichMarkdownDom } from './enrich';
import { runPipeline, removeLightboxOverlay, LIGHTBOX_OVERLAY_ID, type PipelineUiTexts } from './pipeline';
import { decodeText } from './decodeText';
import { makePreview, type SearchMatchWithPreview } from './search';
import {
  createDefaultHighlightFence,
  type DefaultHighlighterOptions
} from './highlightDefault';
import type {
  ComputeSource,
  ComputeWhere,
  DetectionLike,
  Encoding,
  FileSourceLike,
  HighlightFence,
  SearchMatch,
  TocEntry
} from './types';

/**
 * 超大输入守卫阈值（render-text code/strategy.ts MARKUP_MAX_BYTES 同值自持）：
 * markdown 管线（净化/DOM 遍历/katex/mermaid）无分块能力，超限长时间阻塞主线程，
 * 降级为纯文本视图（降级而非拒绝，内容仍可读）。
 */
export const MARKUP_MAX_BYTES = 20 * 1024 * 1024;

// ---------- 围栏高亮注入（模块级缝：Renderer 路径用；视图路径走 options） ----------

let highlightFenceImpl: HighlightFence | null = null;

/** 包内默认实现单例（Renderer 路径未注入时复用；engine/manifest 惰性创建一次） */
let defaultFence: HighlightFence | null = null;
function getDefaultFence(): HighlightFence {
  defaultFence ??= createDefaultHighlightFence();
  return defaultFence;
}

/**
 * 注入围栏高亮回调（宿主把自身 worker client 桥接为 HighlightFence 时调用；
 * 传 null 解绑回包内默认实现 highlightDefault）。视图路径可经 options.highlightFence
 * 按实例覆盖。
 */
export function setHighlightFence(fn: HighlightFence | null): void {
  highlightFenceImpl = fn;
}

/** 读取已注入的围栏高亮回调（未注入 null → 调用方用包内默认实现）。 */
export function getHighlightFence(): HighlightFence | null {
  return highlightFenceImpl;
}

// ---------- 正文引擎注入（M7 Task 2：markdown 接 compute 路由） ----------

/**
 * markdown 正文引擎状态（getEngine 契约值，遗留 T1）：local/remote 即执行位置。
 * 无 'pending'——实例只在 render 完成后创建并返回，getEngine 无观察窗口。
 */
export type MarkdownEngineState = 'local' | 'remote';

/** 交给注入后端的一次渲染调用：text 为剥掉 front matter 的正文，src 为计算来源。 */
export interface MarkdownBackendCall {
  /** 剥掉 front matter 后的 markdown 正文（远程 comrak 不识别 front matter） */
  text: string;
  /** 计算来源：远程 store 文件带服务端 path（auto 策略据此路由远程）；本地文件缺省 */
  src?: ComputeSource;
}

/**
 * 注入后端的最小接口：宿主侧组装（compute 路由 + 远程 comrak 端点 + 回退），
 * 失败直接 reject（显式 remote 的错误卡片语义由调用方兜底）。
 */
export type MarkdownBackend = (call: MarkdownBackendCall) => Promise<{ html: string; where: ComputeWhere }>;

let markdownBackend: MarkdownBackend | null = null;

/** 注入 markdown 正文引擎（启动时调用；传 null 解绑回本地引擎）。 */
export function setMarkdownBackend(fn: MarkdownBackend | null): void {
  markdownBackend = fn;
}

/** 读取已注入的 markdown 正文引擎（测试断言用）。 */
export function getMarkdownBackend(): MarkdownBackend | null {
  return markdownBackend;
}

// ---------- 远程计算来源决策（原 getRemoteBase 依赖切断点） ----------

/**
 * 远程计算来源决策缝（本包不 import @vviewer/core 的 getRemoteBase）：宿主按自身
 * 的远程注册表判断该来源是否可用远程计算，可用则返回 ComputeSource（path/storeId），
 * 不可用返回 null（本地引擎）。缺省恒 null（无远程语义）。
 */
export type ResolveRemoteBase = (source: { storeId: string; path: string }) => ComputeSource | null;

let resolveRemoteBaseImpl: ResolveRemoteBase | null = null;

/** 注入远程计算来源决策（启动时调用；传 null 解绑回恒本地）。 */
export function setResolveRemoteBase(fn: ResolveRemoteBase | null): void {
  resolveRemoteBaseImpl = fn;
}

/** 读取已注入的远程计算来源决策（测试断言用）。 */
export function getResolveRemoteBase(): ResolveRemoteBase | null {
  return resolveRemoteBaseImpl;
}

// ---------- 相对图片解析注入（终审 M3：相对图片 404） ----------

/**
 * 相对图片解析器：img 的相对 src + 当前文件来源 → 可用 URL（如同 store 文件的
 * blob URL）；找不到返回 null（保留原 src，维持 404 现状）。抛错视同找不到。
 * store 读取能力在宿主侧组装（setMarkdownImageResolver 模块缝 / 视图路径
 * options.resolveImage——后者只收 src，来源上下文由调用方闭包自持）。
 */
export type MarkdownImageResolver = (src: string, source: FileSourceLike) => Promise<string | null>;

let markdownImageResolver: MarkdownImageResolver | null = null;

/** 注入相对图片解析器（启动时调用；传 null 解绑恢复 404 现状）。 */
export function setMarkdownImageResolver(fn: MarkdownImageResolver | null): void {
  markdownImageResolver = fn;
}

/** 读取已注入的相对图片解析器（测试断言用）。 */
export function getMarkdownImageResolver(): MarkdownImageResolver | null {
  return markdownImageResolver;
}

/** 绝对地址形态：scheme（http:/data:/blob:）、根相对（/…、//host）、页内片段（#…）不进 resolver。 */
function isAbsoluteSrc(src: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith('/') || src.startsWith('#');
}

// ---------- 图表渲染选项注入（spec 2026-10-19 §2.1/§2.2/§2.3） ----------

/** 图表分发选项：宿主按自身配置解析（本包不感知 localStorage 等存储实现）。 */
export interface DiagramRenderOptions {
  krokiHost: string;
  /** mermaid 主题（spec §2.3 亮暗联动 + §9.2 用户显式设置）：'auto' 已在宿主侧
   * 解析为具体主题——本包只见 mermaid 原生五枚举。 */
  mermaidTheme: MermaidTheme;
  /** 未配置语言返回注册表 defaultMode（调用方保证） */
  modeOf: (lang: string) => DiagramMode;
  /**
   * kroki 消费通道（spec 2026-10-23 §8.3）：client=前端直连 kroki img（现状）；
   * server=经部署侧 /api/kroki 代发内联 svg（krokiProxy 能力协商失败时管线
   * 自动回落 client 直发）。缺省=client。
   */
  krokiVia?: 'client' | 'server';
  /**
   * 图表类型 → 本地渲染器覆盖（spec 2026-10-23 §9.1 graphviz 双渲染器）：仅注册表
   * 宣告 renderers 的类型有多渲染器（graphviz: viz-js/hpcc）；缺省/未命中返回
   * undefined = 注册表默认渲染器（viz-js），管线原样透传给 renderDiagramEngine。
   */
  rendererOf?: (lang: string) => string | undefined;
  /**
   * 服务端单图渲染能力（health diagrams 子集归一后的类型 id 集合，spec §8.3）：
   * server 模式的生效裁决依据；缺省=无能力，server 模式按降级链走 local/kroki。
   */
  serverDiagramOf?: (lang: string) => boolean;
  /** 服务端 kroki 代发能力宣告（capabilities 'kroki-proxy'，恒宣告项）。 */
  krokiProxy?: boolean;
  /**
   * 远程调用描述缝（宿主透传，remoteMarkdown 同款语义）：server 模式与 kroki 代发
   * 据此取 {url, headers} 构造 fetch；缺省/返回 null=未连接服务器，两条服务端路径
   * 按降级链回退。
   */
  remoteCall?: (path: string) => { url: string; headers: Record<string, string> } | null;
}

let diagramOptions: (() => DiagramRenderOptions) | null = null;

/** 注入图表选项提供器（启动时调用；null 解绑）。 */
export function setDiagramOptions(fn: (() => DiagramRenderOptions) | null): void {
  diagramOptions = fn;
}

/** 当前图表选项（未注入 null——管线按注册表 defaultMode 走）。 */
export function getDiagramOptions(): DiagramRenderOptions | null {
  return diagramOptions?.() ?? null;
}

/**
 * 渲染前解析文档内相对图片：命中 resolver → src 换为返回的 URL（blob: URL 登记，
 * destroy 时 revoke，与渲染实例生命周期对齐）；未命中/抛错保留原 src。
 * resolve 发生在 enrich/管线之后：av 扩展名的 img 已被替换为 media 元素不重复
 * 处理；灯箱点击时读 attr 自然拿到已解析的 src。
 */
async function resolveRelativeImages(
  scope: ParentNode,
  source: FileSourceLike | undefined,
  resolver: MarkdownImageResolver | null
): Promise<string[]> {
  if (!resolver) return [];
  const created: string[] = [];
  for (const img of Array.from(scope.querySelectorAll('img'))) {
    const raw = img.getAttribute('src');
    if (!raw || isAbsoluteSrc(raw)) continue;
    try {
      const url = await resolver(raw, source ?? { storeId: '', storeLabel: '', path: '', name: '' });
      if (url) {
        img.setAttribute('src', url);
        created.push(url);
      }
    } catch {
      // resolver 抛错（store 读失败等）视同找不到：保留原 src
    }
  }
  return created;
}

/**
 * 本地 markdown-it 直渲染 body（不再剥 front matter）：注入后端的 auto 回退路径用
 * ——backend 收到的 text 已剥过 front matter，二次解析会把以 `---` 开头的正文误判
 * 为 front matter。
 * 保护必须接在同一条腿上（修复轮 1/M1）：本地来源文件、auto+非图表围栏强制
 * 本地、远程失败回退三条真实路径全走本函数而非 renderMarkdownToHtml——漏套
 * protectLatexDelimiters 会让双引擎对 \(..\)/\[..\] 分裂（remote 侧有
 * apply_latex_delimiters）。入参已是剥 front matter 的 body，勿二次剥。
 */
export function renderMarkdownBody(body: string): string {
  return createMarkdownEngine().render(protectLatexDelimiters(body));
}

/**
 * 标题文本 → GFM 锚基名（comrak Anchorizer 同款，见 engine.ts GfmAnchorizer）。
 * 兼容导出：本函数曾是本地 heading id 的 slug 管线（无前缀、全空回退 section、
 * 重名 -2 起）；BUG-39 裁决（2026-10-17）后 id 生成统一走 assignHeadingIds 的
 * user-content- 前缀 + GFM anchorize 方案，本函数保留仅供外部对基名形态的引用，
 * 渲染管线不再使用。
 */
export function slugifyHeading(text: string): string {
  const anchorizer = new GfmAnchorizer();
  const slug = anchorizer.baseSlug(text.trim());
  return slug === '' || slug === '-' ? 'section' : slug;
}

/**
 * 为 h1-h4 确保元素 id（BUG-39 裁决：双引擎统一 user-content- 前缀命名空间，GitHub
 * 同款）：无 id 的标题生成 `user-content-` + GFM anchorize（comrak Anchorizer 同款
 * 算法与去重序列，与远程 comrak 预填 id、本地引擎锚 href 同一方案）；有 id 的标题
 * （远程 comrak 输出 / 作者 raw HTML）保留原值。used 预置灯箱 overlay id 与全部
 * 非 heading 元素 id：生成结果撞车时沿 GFM 后缀序列避让（overlay/作者 id 不被标题
 * 占用；前缀命名空间下常规撞车已不可能，避让为防御性保留）。
 * 幂等：有 id 的 heading 保留原值（预填排除 heading 自身，否则会被自己的 id 判为
 * 冲突而改名）。
 * 收尾把标题内引擎自产锚（comrak header anchors / 本地 heading_close 规则，均
 * class="anchor"）的 href 改写为最终 id——内嵌锚 href 与 heading id 自一致由构造
 * 保证（BUG-39「comrak 自产 anchor href 自不一致」的收口点；引擎侧 href 只是
 * 净化前形态）。
 */
export function assignHeadingIds(root: Document): void {
  const used = new Set<string>([LIGHTBOX_OVERLAY_ID]);
  for (const el of Array.from(root.querySelectorAll('[id]'))) {
    if (!el.matches('h1, h2, h3, h4')) used.add(el.id);
  }
  const anchorizer = new GfmAnchorizer();
  const headings = Array.from(root.querySelectorAll('h1, h2, h3, h4'));
  for (const h of headings) {
    if (h.id) {
      // 预填 id 注册避让集与锚化器（后续生成不与之撞车）
      used.add(h.id);
      anchorizer.reserve(h.id);
      continue;
    }
    let id = `user-content-${anchorizer.anchorize(h.textContent ?? '')}`;
    if (used.has(id)) {
      let n = 1;
      while (used.has(`${id}-${n}`)) n += 1;
      id = `${id}-${n}`;
    }
    h.id = id;
    used.add(id);
    anchorizer.reserve(id);
  }
  for (const h of headings) {
    if (!h.id) continue;
    const anchorLink = h.querySelector('a.anchor');
    if (anchorLink !== null) anchorLink.setAttribute('href', `#${h.id}`);
  }
}

/**
 * 正文页内锚的 hash→heading id 重映射（BUG-39，GitHub hash→前缀映射的渲染期
 * 形态）：作者视角的页内链接 `[x](#标题)` hash 是无前缀 GFM slug，而 heading id
 * 统一为 user-content- 命名空间——直连目标不存在且 `user-content-<hash>` 存在时
 * 改写 href（markdown-it 会对 CJK href 百分号编码，decode 后同判）。作者自锚
 * （指向非 heading 元素 id）、脚注互链与已可直达的链接不动；纯渲染期 DOM 改写，
 * 不引入点击监听。
 */
export function remapHeadingHashLinks(root: Document): void {
  const hasId = (id: string): boolean => root.getElementById(id) !== null;
  for (const a of Array.from(root.querySelectorAll('a[href^="#"]'))) {
    const href = a.getAttribute('href') ?? '';
    const raw = href.slice(1);
    if (raw === '' || hasId(raw)) continue;
    let decoded = raw;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      // 非法百分号序列：保留原串继续
    }
    if (decoded !== raw && hasId(decoded)) continue;
    for (const cand of decoded !== raw ? [raw, decoded] : [raw]) {
      const mapped = `user-content-${cand}`;
      if (hasId(mapped)) {
        a.setAttribute('href', `#${mapped}`);
        break;
      }
    }
  }
}

/** 从挂载后的 DOM 提取 TOC（h1-h4，文档序；id 由 assignHeadingIds 保证存在） */
export function extractToc(scope: ParentNode): TocEntry[] {
  return Array.from(scope.querySelectorAll('h1, h2, h3, h4')).map((h) => ({
    level: Number(h.tagName[1]),
    text: (h.textContent ?? '').trim(),
    id: h.id
  }));
}

// ---------- 文件内搜索（Task 6） ----------

/** 搜索跳过的祖先元素：脚本/样式内容不是可读文本，语言徽标（复制入口）是 UI 而非文档内容 */
const SEARCH_SKIP_TAGS = new Set(['SCRIPT', 'STYLE']);

/**
 * 收集 scope 下可搜索的文本节点（文档序）：祖先含 SCRIPT/STYLE/md-code-lang 的拒绝。
 * 独立导出便于单测（walk 逻辑与包裹/还原解耦）。
 */
export function collectTextNodes(scope: HTMLElement): Text[] {
  const doc = scope.ownerDocument;
  const walker = doc.createTreeWalker(scope, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      let cur: Node | null = node.parentNode;
      while (cur && cur !== scope) {
        if (cur.nodeType === 1) {
          const el = cur as Element;
          if (SEARCH_SKIP_TAGS.has(el.tagName) || el.classList.contains('md-code-lang')) {
            return NodeFilter.FILTER_REJECT;
          }
        }
        cur = cur.parentNode;
      }
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  const out: Text[] = [];
  let node: Node | null;
  while ((node = walker.nextNode())) out.push(node as Text);
  return out;
}

/**
 * 渲染视图搜索状态：每次 search 记录"原文本节点 → 生成的替换节点序列"，
 * 退出搜索（search('')）/重新搜索/destroy 时按序还原，保证文本无损、无 mark 嵌套。
 */
interface SearchEdit {
  original: Text;
  generated: ChildNode[];
}

/**
 * markdown 渲染视图的文件内搜索：TreeWalker 收集文本节点，大小写不敏感找 query，
 * 命中处拆分文本节点并包 `<mark class="vv-search-hit">`（文档序）。
 * 已知局限（遗留 T5）：逐文本节点扫描，跨内联元素边界的 query 不命中——
 * 如 `foo<b>bar</b>` 搜 "foobar"（"foo" 与 "bar" 分属两个文本节点），
 * 这是 DOM 逐节点包裹的固有局限（与 code 视图逐行扫描同构，不在行/节点间拼匹配）。
 * 返回扩展形状：渲染视图无行概念，line 复用为命中序号（gotoMatch 按同序定位），
 * start/end 恒 0，preview 为命中文本节点上下文。
 * 空 query 还原上一次包裹并返回 []（退出搜索语义）。
 */
function createDomSearcher(target: HTMLElement, isStale: () => boolean) {
  let edits: SearchEdit[] = [];
  let marks: HTMLElement[] = [];
  let activeIndex = -1;

  /** 还原全部包裹：把生成节点序列换回原文本节点（逆序稳妥；重复还原幂等） */
  function restore(): void {
    for (let i = edits.length - 1; i >= 0; i--) {
      const { original, generated } = edits[i]!;
      const first = generated[0];
      if (first && first.parentNode !== null) {
        first.replaceWith(original);
        for (let k = 1; k < generated.length; k++) generated[k]!.remove();
      }
    }
    edits = [];
    marks = [];
    activeIndex = -1;
  }

  async function search(
    query: string,
    opts?: { caseSensitive?: boolean }
  ): Promise<SearchMatchWithPreview[]> {
    restore(); // 上一次的 mark 先还原，避免嵌套
    if (isStale() || query === '') return [];
    const caseSensitive = opts?.caseSensitive === true;
    const needle = caseSensitive ? query : query.toLowerCase();
    const doc = target.ownerDocument;
    const results: SearchMatchWithPreview[] = [];
    for (const node of collectTextNodes(target)) {
      const text = node.nodeValue ?? '';
      const lower = caseSensitive ? text : text.toLowerCase();
      const positions: number[] = [];
      let from = 0;
      for (;;) {
        const idx = lower.indexOf(needle, from);
        if (idx === -1) break;
        positions.push(idx);
        from = idx + needle.length;
      }
      if (positions.length === 0) continue;
      const frag = doc.createDocumentFragment();
      const generated: ChildNode[] = [];
      let pos = 0;
      for (const p of positions) {
        const end = p + needle.length;
        if (p > pos) {
          const t = doc.createTextNode(text.slice(pos, p));
          generated.push(t);
          frag.append(t);
        }
        const mark = doc.createElement('mark');
        mark.className = 'vv-search-hit';
        mark.textContent = text.slice(p, end);
        generated.push(mark);
        frag.append(mark);
        marks.push(mark);
        results.push({
          line: results.length, // 渲染视图无行概念：line 复用为命中序号
          start: 0,
          end: 0,
          preview: makePreview(text, p, end)
        });
        pos = end;
      }
      if (pos < text.length) {
        const t = doc.createTextNode(text.slice(pos));
        generated.push(t);
        frag.append(t);
      }
      node.replaceWith(frag);
      edits.push({ original: node, generated });
    }
    return results;
  }

  function gotoMatch(index: number): void {
    const mark = marks[index];
    if (!mark) return;
    marks[activeIndex]?.classList.remove('vv-search-hit-active');
    activeIndex = index;
    mark.classList.add('vv-search-hit-active');
    mark.scrollIntoView({ block: 'center' });
  }

  return { search, gotoMatch, restore };
}

/** 灯箱 owner 代币序号（U3）：每次 render 唯一，destroy 时凭它校验 overlay 归属 */
let lightboxOwnerSeq = 0;

/** 渲染实例元数据快照（BUG-04）：markdown 无行概念（行列仅 code 渲染器有意义） */
export interface MarkdownFileMeta {
  encoding?: Encoding;
  size: number;
}

// ---------- 共享渲染装配（Renderer 路径与 createMarkdownView 共用） ----------

/** 一次渲染装配的内部选项（两条入口路径归一后的形态）。 */
interface RenderRunOptions {
  /** 实例解析出的围栏高亮回调（必填：注入值或包内默认实现） */
  highlightFence: HighlightFence;
  /** 图表分发选项（undefined=注册表 defaultMode） */
  diagram?: DiagramRenderOptions;
  /** 管线 UI 文案（undefined=中文缺省） */
  ui?: PipelineUiTexts;
  /** 管线生成元素的类名前缀 */
  themeClassPrefix?: string;
  /** 相对图片解析器（null=src 原样） */
  imageResolver: MarkdownImageResolver | null;
  /** 注入后端（null=本地 markdown-it） */
  backend: MarkdownBackend | null;
  /** 远程计算来源决策（null=恒本地；仅在 backend 在位时消费） */
  remoteBase: ResolveRemoteBase | null;
  /** 来源上下文（remoteBase 决策与 imageResolver 回调的 path/storeId 语义） */
  sourceInfo: { storeId: string; path: string };
  /** FileSourceLike 透传给 imageResolver（视图路径缺省合成空来源） */
  fileSource?: FileSourceLike;
  /** 元数据快照（getMeta） */
  meta: MarkdownFileMeta;
}

/** 一次渲染装配的产物（实例方法面的共享闭包状态）。 */
interface MountedRender {
  target: HTMLElement;
  toc: TocEntry[];
  engine: MarkdownEngineState;
  meta: MarkdownFileMeta;
  /** 渲染时快照的 mermaid 主题（applyTheme 缺参回退值） */
  currentTheme: MermaidTheme;
  domSearch: ReturnType<typeof createDomSearcher>;
  /** 就地重画本实例 [data-mermaid] 为指定主题（applyTheme 本体） */
  rerenderMermaid(theme: MermaidTheme): void;
  /** 释放本次渲染资源：搜索还原/blob revoke/灯箱 overlay/挂载内容清除 */
  destroy(): void;
}

function revokeUrls(urls: string[]): void {
  for (const url of urls) {
    if (typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(url);
  }
}

/**
 * 共享渲染链（Renderer.render 与 view.render 复用）：管线含动态 import
 * （mermaid/katex/hljs）与注入后端的异步往返，期间 tab 可能已切换/实例重渲——
 * aborted() 为真后不再挂载，已产出的 blob URL 就地 revoke。
 */
async function renderMarkdownInto(
  target: HTMLElement,
  text: string,
  opts: RenderRunOptions,
  aborted: () => boolean
): Promise<MountedRender | null> {
  // U3：灯箱 owner 代币——destroy 只摘自己实例打开的 body 级 overlay
  const lightboxOwner = `md-render-${++lightboxOwnerSeq}`;
  // 正文引擎裁决：注入后端优先（路由策略与回退全在宿主侧的 fn 内），未注入走
  // 本地 markdown-it（现状）。远程 comrak 不识别 front matter——交给后端前先剥掉；
  // 本地路径保持 renderMarkdownToHtml 原语义（内部解析 front matter）。
  let html: string;
  let engine: MarkdownEngineState = 'local';
  if (opts.backend) {
    const computeSrc: ComputeSource | null = opts.remoteBase
      ? opts.remoteBase(opts.sourceInfo)
      : null;
    const res = await opts.backend({ text: parseFrontMatter(text).body, src: computeSrc ?? undefined });
    html = res.html;
    engine = res.where;
  } else {
    html = renderMarkdownToHtml(text).html;
  }
  // 引擎输出（含远程 comrak unsafe 结果）必经净化后才能入 DOM
  const doc = new DOMParser().parseFromString(sanitizeHtml(html), 'text/html');
  enrichMarkdownDom(doc);
  await runPipeline(doc, {
    highlightFence: opts.highlightFence,
    themeClassPrefix: opts.themeClassPrefix,
    lightboxOwner,
    diagram: opts.diagram,
    ui: opts.ui,
    // 灯箱画廊收集域：挂载时节点收养出管线期 doc（下方 replaceChildren），
    // 点击发生在收养后——对挂载容器活查询才能收全 img/图表 svg
    galleryScope: target
  });
  if (aborted()) return null;
  // 相对图片 → 同 store 文件 URL（未注入 resolver 时原样保留，404 现状）
  const resolvedUrls = await resolveRelativeImages(doc, opts.fileSource, opts.imageResolver);
  if (aborted()) {
    revokeUrls(resolvedUrls);
    return null;
  }
  target.classList.add('vv-markdown');
  assignHeadingIds(doc); // TOC 点击按 id 定位，id 必须先于挂载/提取存在（挂载后节点已离开 doc）
  remapHeadingHashLinks(doc); // 页内锚 hash→user-content- id 重映射（须在 id 定型后）
  // 解析文档 → 挂载（节点被主文档收养，管线加的复制按钮/灯箱监听随节点保留）
  target.replaceChildren(...Array.from(doc.body.childNodes));
  const toc = extractToc(target);
  // 图表主题即时生效 API（原 vv:appearance-applied / vv:diagram-settings-applied
  // 两事件同构语义的实例化形态，spec §2.3/§9.2）：mermaid 配色烘焙进 SVG 不可反演，
  // 主题变化就地重画。宿主把外观/设置变化桥接到 applyTheme 即可（包内不硬编码
  // vv:* 事件名）。主题快照自本次 render 的 diagram 选项（未注入时兜底 default）；
  // kroki 态 mermaid 视图同带锚，重渲染走 local 引擎（主题即时生效、消除远端
  // kroki 依赖——可接受语义）。
  const currentTheme = opts.diagram?.mermaidTheme ?? 'default';
  // 重画本体：主题缺省回退渲染时快照
  const rerenderMermaid = (theme: MermaidTheme): void => {
    for (const el of Array.from(target.querySelectorAll('[data-mermaid]'))) {
      const src = el.getAttribute('data-mermaid');
      if (!src) continue;
      void renderMermaidInto(el, src, theme).then((ok) => {
        // 失败保留旧图（含错误态）原样=静默保留为设计形态（renderMermaidInto 内部
        // 吞错只回布尔，无 err 对象可带），warn 仅留诊断线索、非用户可见文案（台账 5-8）
        if (!ok) {
          console.warn('[md] mermaid 主题重渲失败，保留旧图');
          return;
        }
        // 治愈：上次 local 失败态残留的错误类随旧内容一并清掉——themeClassPrefix
        // 场景类名带前缀（cls(ctx,…) 机制），前缀值此处不可知，按 'md-diagram-error'
        // 后缀匹配自身 classList 摘除最简可靠；视图已换新 SVG，错误样式不再适用
        for (const c of Array.from(el.classList)) {
          if (c.endsWith('md-diagram-error')) el.classList.remove(c);
        }
      });
    }
  };
  // 渲染视图搜索（Task 6）：root 即挂载后的 target；aborted 闭包供防御
  const domSearch = createDomSearcher(target, aborted);
  return {
    target,
    toc,
    engine,
    meta: opts.meta,
    currentTheme,
    domSearch,
    rerenderMermaid,
    destroy() {
      domSearch.restore(); // 还原搜索 mark，避免把包裹态节点留在 DOM（虽随即清空，保持对称）
      // 相对图片解析产出的 blob: URL 随实例释放（渲染重跑会重新解析，不复用旧 URL）
      revokeUrls(resolvedUrls);
      // 灯箱 overlay 挂在 body（img 点击时 target 已在主文档），不随渲染节点销毁：显式清理。
      // 非 owner 时管线内跳过——多 markdown 实例共存不得互删对方正开着的灯箱（U3）
      removeLightboxOverlay(target.ownerDocument, lightboxOwner);
      target.replaceChildren();
      target.classList.remove('vv-markdown');
    }
  };
}

// ---------- Renderer 形态（结构兼容 core Renderer；dispatcher/宿主装配用） ----------

/** 渲染实例完整表面（Renderer.render 正常路径产物；结构兼容 core RenderedInstance）。 */
export interface MarkdownRenderedInstance {
  destroy(): void;
  getToc(): TocEntry[];
  search(query: string, opts?: { caseSensitive?: boolean }): Promise<SearchMatch[]>;
  gotoMatch(index: number): void;
  getEngine(): MarkdownEngineState;
  getMeta(): MarkdownFileMeta;
  /** 导出文档快照（md-export Task 1）：挂载后 DOM 的独立克隆（含相对图片解析后
   * 的最终 src）。克隆 target 本体（保留 .vv-markdown 排版作用域类名，导出基础
   * CSS 与该选择器直接生效）。降级实例无本方法（'in' 探测为 false → 触发壳不显示
   * 导出钮，与 getToc 同款鸭子探测）。 */
  getExportDocument(): Document | null;
  /** 图表主题即时生效（原 vv:* 事件联动的实例 API）：就地重画本实例 [data-mermaid]
   * 为指定主题；缺参回退渲染时快照。 */
  applyTheme(opts?: { mermaidTheme?: MermaidTheme }): void;
}

/** 超大文件降级实例表面（无 getEngine/getExportDocument/applyTheme——鸭子探测不出）。
 * search 返回 preview 扩展形态（DOM 文本节点搜索；结构兼容 core SearchMatch）。 */
export interface MarkdownDegradedInstance {
  destroy(): void;
  getToc(): never[];
  search(query: string, opts?: { caseSensitive?: boolean }): Promise<SearchMatchWithPreview[]>;
  gotoMatch(index: number): void;
  getMeta(): MarkdownFileMeta;
}

/** 渲染器注册形状（结构兼容 core Renderer，本包不依赖 core）。 */
export interface MarkdownRenderer {
  id: string;
  label: string;
  extensions: string[];
  render(
    buffer: Uint8Array,
    target: HTMLElement,
    source: FileSourceLike,
    det: DetectionLike
  ): Promise<MarkdownRenderedInstance | MarkdownDegradedInstance | { destroy(): void }>;
}

/**
 * 内置超大文件降级视图（纯文本）：形态对齐 render-text renderDegradedCode 的
 * 提示卡结构（vv-error-card vv-oversize-card），内容区为单个 plain pre（无虚拟
 * 滚动——code 渲染器属 render-text 不迁入；宿主需要原 code 视图形态时经
 * createMarkdownView 的 options.renderOversize 注入）。搜索走 DOM 文本节点实现。
 */
function degradedPlainText(
  text: string,
  target: HTMLElement,
  name: string,
  meta: MarkdownFileMeta
): MarkdownDegradedInstance {
  target.classList.add('vv-degraded');
  const card = document.createElement('div');
  card.className = 'vv-error-card vv-oversize-card';
  const title = document.createElement('div');
  title.className = 'vv-error-title';
  title.textContent = '文件过大，已降级显示';
  const detail = document.createElement('div');
  detail.className = 'vv-error-detail';
  detail.textContent = `文件超过 ${MARKUP_MAX_BYTES / 1024 / 1024}MB，富文本渲染已跳过（避免长时间阻塞），已降级为纯文本视图。`;
  const nameEl = document.createElement('div');
  nameEl.className = 'vv-error-meta';
  nameEl.textContent = name;
  card.append(title, detail, ...(name ? [nameEl] : []));
  const content = document.createElement('div');
  content.className = 'vv-degraded-content';
  const pre = document.createElement('pre');
  pre.className = 'vv-code-pre';
  pre.textContent = text;
  content.append(pre);
  target.replaceChildren(card, content);
  const domSearch = createDomSearcher(pre, () => !pre.isConnected);
  return {
    destroy() {
      domSearch.restore();
      target.replaceChildren();
      target.classList.remove('vv-degraded');
    },
    getToc: () => [], // 降级视图无标题结构
    search: (query, opts) => domSearch.search(query, opts),
    gotoMatch: (index) => domSearch.gotoMatch(index),
    getMeta: () => meta
  };
}

/** Renderer 形态入口（结构兼容 core Renderer；buffer+Detection 协议）。 */
export const markdownRenderer: MarkdownRenderer = {
  id: 'markdown',
  label: 'Markdown',
  extensions: ['md', 'markdown'],
  async render(buffer: Uint8Array, target: HTMLElement, source: FileSourceLike, det: DetectionLike) {
    // 超大输入守卫：markdown 管线（净化/DOM 遍历/katex/mermaid）无分块能力，
    // >20MB 会长时间阻塞主线程。降级为纯文本视图（降级而非拒绝，内容仍可读）。
    if (buffer.byteLength > MARKUP_MAX_BYTES) {
      return degradedPlainText(
        decodeText(buffer, det.encoding),
        target,
        source.name,
        { encoding: det.encoding, size: buffer.byteLength }
      );
    }
    // 管线含动态 import（mermaid/katex/hljs）与注入后端的异步往返，期间 tab 可能
    // 已切换：destroyed 后不再挂载
    let destroyed = false;
    const text = decodeText(buffer, det.encoding);
    const mounted = await renderMarkdownInto(
      target,
      text,
      {
        // 围栏高亮：模块注入优先，未注入用包内默认 tree-sitter 实现（hljs 兜底在管线内）
        highlightFence: highlightFenceImpl ?? getDefaultFence(),
        diagram: getDiagramOptions() ?? undefined,
        imageResolver: markdownImageResolver,
        backend: markdownBackend,
        remoteBase: resolveRemoteBaseImpl,
        sourceInfo: { storeId: source.storeId, path: source.path },
        fileSource: source,
        meta: { encoding: det.encoding, size: buffer.byteLength }
      },
      () => destroyed
    );
    if (!mounted) return { destroy() {} };
    // getEngine 供状态栏显示正文引擎（M7：渲染: 本地/远程）；getMeta 供状态栏/
    // 属性面板元数据（BUG-04；markdown 渲染视图无行概念，不报 lines）
    const instance: MarkdownRenderedInstance = {
      destroy() {
        destroyed = true;
        mounted.destroy();
      },
      getToc: () => mounted.toc,
      search: (query, opts) => mounted.domSearch.search(query, opts),
      gotoMatch: (index) => mounted.domSearch.gotoMatch(index),
      getEngine: () => mounted.engine,
      getMeta: () => mounted.meta,
      // 导出文档快照（md-export Task 1）：挂载后 DOM 的独立克隆。克隆 target 本体
      // （保留 .vv-markdown 排版作用域类名，导出基础 CSS 与该选择器直接生效）；
      // 跨文档 append 自动 adopt，触发壳就地装配不回写主文档。
      getExportDocument: () => {
        if (destroyed) return null;
        const out = new DOMParser().parseFromString('', 'text/html');
        out.body.append(target.cloneNode(true));
        return out;
      },
      applyTheme: (opts) => {
        if (destroyed) return;
        mounted.rerenderMermaid(opts?.mermaidTheme ?? mounted.currentTheme);
      }
    };
    return instance;
  }
};

// ---------- createMarkdownView（引入即完整效果的高层入口） ----------

/** 超大输入降级渲染器注入缝（视图路径）：缺省为包内纯文本降级视图。name 为
 * 提示卡文件名行（视图路径取 options.source.path，空则不显示该行）。 */
export type RenderOversize = (
  text: string,
  target: HTMLElement,
  name: string,
  meta: MarkdownFileMeta
) => MarkdownDegradedInstance;

/**
 * createMarkdownView 选项全集（缺省值=完整效果：包内默认 tree-sitter 高亮器 +
 * katex 开 + diagram 开（注册表 defaultMode，kroki 默认 DEFAULT_KROKI_HOST）+
 * lightbox 开 + sanitize 开 + 相对图片 src 原样）。
 */
export interface MarkdownViewOptions {
  /**
   * 围栏高亮回调（HighlightFence 契约；宿主 worker client 桥接缝）。缺省顺序：
   * 本选项 → setHighlightFence 模块注入 → 包内默认 tree-sitter 主线程实现
   * （options.highlight 配置其 grammar 来源）。
   */
  highlightFence?: HighlightFence;
  /** 包内默认高亮器选项（highlightFence 未注入时生效）：grammar wasm 来源/查询
   * 来源/语言白名单等，见 DefaultHighlighterOptions。 */
  highlight?: DefaultHighlighterOptions;
  /** markdown 正文引擎后端（compute 路由注入缝）；缺省回落 setMarkdownBackend
   * 模块注入值，仍未注入走本地 markdown-it。 */
  markdownBackend?: MarkdownBackend;
  /** 远程计算来源决策（原 getRemoteBase 依赖切断点）：返回 ComputeSource 传给
   * 后端；null/缺省=本地。source 上下文取 options.source。 */
  resolveRemoteBase?: ResolveRemoteBase;
  /** 相对图片解析器（按 src 返回可用 URL，null=保留原 src；缺省=src 原样）。
   * blob: URL 登记由视图托管，destroy/重渲时 revoke。 */
  resolveImage?: (src: string) => Promise<string | null>;
  /**
   * 图表分发选项（可部分注入：krokiHost 缺省 DEFAULT_KROKI_HOST、mermaidTheme
   * 缺省 'default'、modeOf 缺省按注册表 defaultMode）；完全不传=注册表语义。
   */
  diagram?: Partial<DiagramRenderOptions>;
  /** 管线 UI 文案（复制徽标/图源切换钮/错误卡；缺省中文 DEFAULT_UI_TEXTS）。 */
  ui?: PipelineUiTexts;
  /** 管线生成元素的类名前缀（主题作用域样式用）。 */
  themeClassPrefix?: string;
  /** 文档来源上下文（resolveRemoteBase 决策的 path/storeId 语义；getMeta 不消费）。 */
  source?: { storeId?: string; path?: string };
  /** 超大输入降级渲染器（缺省包内纯文本降级视图，无虚拟滚动）。 */
  renderOversize?: RenderOversize;
}

/** markdown 渲染视图实例：既有 RenderedInstance 能力重组 + applyTheme 主题钩子。 */
export interface MarkdownView {
  /** 渲染 markdown 源文本（front matter 由引擎/后端处理）：重复调用整体重挂，
   * 上一次渲染的资源（blob URL/灯箱 overlay/搜索包裹）随重渲释放。 */
  render(source: string): Promise<void>;
  destroy(): void;
  /** 目录（h1-h4 文档序；上次 render 的快照） */
  getToc(): TocEntry[];
  /** 文件内搜索（空 query=退出搜索还原） */
  search(query: string, opts?: { caseSensitive?: boolean }): Promise<SearchMatchWithPreview[]>;
  /** 跳到第 index 个搜索命中 */
  gotoMatch(index: number): void;
  /** 正文引擎执行位置（local/remote） */
  getEngine(): MarkdownEngineState;
  /** 元数据快照（encoding 恒 utf-8——输入为 JS 字符串；size 为 UTF-8 字节数） */
  getMeta(): MarkdownFileMeta;
  /** 导出文档快照（挂载后 DOM 的独立克隆；未渲染/已销毁返回 null） */
  getExportDocument(): Document | null;
  /** 图表主题即时生效（原 vv:* 事件联动的实例 API）：就地重画本实例 [data-mermaid]
   * 为指定主题；缺参回退渲染时快照。宿主把外观/设置变化桥接到此即可。 */
  applyTheme(opts?: { mermaidTheme?: MermaidTheme }): void;
}

/**
 * 视图缺省图表选项（options.diagram 部分注入时的补全省）：modeOf 缺省=注册表
 * defaultMode（resolveDiagramType 归一别名后取 defaultMode），kroki host 缺省
 * DEFAULT_KROKI_HOST，mermaid 主题缺省 'default'——与「不传 diagram」的注册表
 * 语义等价，仅作为部分注入时的显式兜底。
 */
function defaultDiagramOptions(): DiagramRenderOptions {
  return {
    krokiHost: DEFAULT_KROKI_HOST,
    mermaidTheme: 'default',
    modeOf: (lang) => resolveDiagramType(lang)?.defaultMode ?? 'source'
  };
}

/**
 * 创建 markdown 渲染视图（引入即完整效果）：一行装配「引擎→sanitize→enrich→
 * 五步管线（默认 tree-sitter 高亮/katex/diagram/copyCode/lightbox）→挂载→
 * heading id→TOC」。CSS 由消费方引入 '@vviewer/markdown/markdown.css'（或
 * MARKDOWN_CSS 常量注入 <style>）。
 */
export function createMarkdownView(container: HTMLElement, options: MarkdownViewOptions = {}): MarkdownView {
  let destroyed = false;
  let renderGen = 0;
  let current: MountedRender | null = null;
  let degraded: MarkdownDegradedInstance | null = null;
  const encoder = new TextEncoder();

  /** 释放当前渲染态（正常与降级两形态互斥；重渲/销毁共用） */
  function teardownCurrent(): void {
    current?.destroy();
    current = null;
    degraded?.destroy();
    degraded = null;
  }

  const view: MarkdownView = {
    async render(source: string) {
      if (destroyed) return;
      const gen = ++renderGen;
      // 上一次渲染的资源随重渲释放（blob URL/灯箱 overlay/搜索包裹——target 即将
      // 整体重挂）；owner 代币换代：旧 render 打开的灯箱按 U3 归属语义随之收尾
      teardownCurrent();
      // 中止判定：destroy 或已有更新一代 render 接管（过期渲染的挂载/资源就地丢弃）
      const aborted = (): boolean => destroyed || gen !== renderGen;
      const byteSize = encoder.encode(source).byteLength;
      if (byteSize > MARKUP_MAX_BYTES) {
        // 超大输入守卫（与 Renderer 路径同阈值）：降级而非拒绝
        degraded = (options.renderOversize ?? degradedPlainText)(
          source,
          container,
          options.source?.path ?? '',
          { encoding: 'utf-8', size: byteSize }
        );
        return;
      }
      // 围栏高亮解析顺序：实例选项 → 模块注入 → 包内默认 tree-sitter 实现
      const highlightFence = options.highlightFence
        ?? highlightFenceImpl
        ?? (options.highlight ? createDefaultHighlightFence(options.highlight) : getDefaultFence());
      // 图表选项：实例选项（部分注入补全省）→ 模块注入 → 注册表语义（undefined）
      const diagram = options.diagram
        ? { ...defaultDiagramOptions(), ...options.diagram }
        : getDiagramOptions() ?? undefined;
      const mounted = await renderMarkdownInto(
        container,
        source,
        {
          highlightFence,
          diagram,
          ui: options.ui,
          themeClassPrefix: options.themeClassPrefix,
          imageResolver: options.resolveImage ?? null,
          backend: options.markdownBackend ?? markdownBackend,
          remoteBase: options.resolveRemoteBase ?? null,
          sourceInfo: { storeId: options.source?.storeId ?? '', path: options.source?.path ?? '' },
          meta: { encoding: 'utf-8', size: byteSize }
        },
        aborted
      );
      // 过期/已销毁：renderMarkdownInto 内部已回收半途资源，不占实例状态
      if (mounted && !aborted()) current = mounted;
    },
    destroy() {
      destroyed = true;
      renderGen += 1; // 在途渲染就地中止
      teardownCurrent();
    },
    getToc: () => (destroyed || !current ? [] : current.toc),
    search: (query, opts) => {
      if (destroyed) return Promise.resolve([]);
      if (degraded) return degraded.search(query, opts);
      return current ? current.domSearch.search(query, opts) : Promise.resolve([]);
    },
    gotoMatch: (index) => {
      if (destroyed) return;
      if (degraded) degraded.gotoMatch(index);
      else current?.domSearch.gotoMatch(index);
    },
    getEngine: () => current?.engine ?? 'local',
    getMeta: () => current?.meta ?? degraded?.getMeta() ?? { encoding: 'utf-8', size: 0 },
    getExportDocument: () => {
      if (destroyed || !current) return null;
      const out = new DOMParser().parseFromString('', 'text/html');
      out.body.append(container.cloneNode(true));
      return out;
    },
    applyTheme: (opts) => {
      if (destroyed || !current) return;
      current.rerenderMermaid(opts?.mermaidTheme ?? current.currentTheme);
    }
  };
  return view;
}
