// markdownRenderer.ts — markdown 渲染器（Task 4）：T1-T3 五步管线的 Renderer 装配。
// render 链：markdown 引擎（注入后端或本地 markdown-it）→ sanitizeHtml → DOMParser
// 解析 → enrichMarkdownDom → runPipeline（highlightFence 注入）→ 挂载 target
// → heading 赋 id → TOC 提取。
// 依赖倒置：围栏高亮复用 code.ts 的 HighlightClient 全局单例（apps/web 启动时经
// attachHighlightClient 注入，本模块无需 viewer.ts 额外接线）；client 不可用/失败
// 时 fenceToHtml 返回 null，管线内回落 hljs。
// M7（Task 2）：markdown 正文引擎同样走模块级注入（setMarkdownBackend，沿用
// highlightFence 模式）——renderer 只认注入的 fn，不感知路由策略；fn 内部
// （apps/web 侧）做 compute 路由与回退。backend 返回的 HTML（远程 comrak unsafe
// 输出）一律仍走 sanitize+enrich+pipeline 全管线，与本地引擎同权。
// 终审 C（相对图片 404）：`<img src="相对路径">` 经 setMarkdownImageResolver 注入的
// 解析器换为同 store 文件的 URL；未注入或找不到保留原 src。
import type { Renderer, RenderedInstance, Detection, FileSource, TocEntry, ComputeSource, ComputeWhere, Encoding } from '@vviewer/core';
import { getRemoteBase } from '@vviewer/core';
import { HighlightCanceledError, type HighlightInterval } from '@vviewer/highlight';
import {
  DECODERS,
  MARKUP_MAX_BYTES,
  getHighlightClient,
  buildLineIndex,
  buildLineOffsets,
  assignIntervalsToLines,
  renderLineHtml,
  renderCode,
  renderDegradedCode,
  type RenderCodeHandle
} from '../code';
import { makePreview, type SearchMatchWithPreview } from '../search';
import type { SearchMatch } from '@vviewer/core';
import { createMarkdownEngine, renderMarkdownToHtml } from './engine';
import { parseFrontMatter } from './frontMatter';
import { sanitizeHtml } from './sanitize';
import { enrichMarkdownDom } from './enrich';
import { runPipeline, removeLightboxOverlay, LIGHTBOX_OVERLAY_ID } from './pipeline';

/**
 * 围栏代码高亮回调（pipeline 的 highlightFence 实现）：HighlightClient 区间
 * → 行分配 → span HTML（类名经 captureToCssClass，与 code 渲染器同一来源）。
 * client 未注入、语言不在 grammar 清单等失败返回 null → 管线内 hljs 兜底；
 * 请求被取消（tab 切换）时重抛 HighlightCanceledError → 管线静默跳过该块、
 * 不再跑 hljs 兜底（结果即将随 tab 丢弃，整篇兜底纯属空转）。
 */
export async function fenceToHtml(code: string, lang: string): Promise<string | null> {
  const client = getHighlightClient();
  if (!client) return null;
  let intervals: HighlightInterval[];
  try {
    intervals = await client.highlight(code, lang);
  } catch (err) {
    if (err instanceof HighlightCanceledError) throw err; // 取消：管线跳过，不 hljs 兜底
    return null; // 其余失败：管线内 hljs 兜底
  }
  const lines = buildLineIndex(code);
  const byLine = new Map(
    assignIntervalsToLines(intervals, buildLineOffsets(lines)).map((a) => [a.line, a.segs])
  );
  return lines.map((line, i) => renderLineHtml(line, byLine.get(i))).join('\n');
}

// ---------- 正文引擎注入（M7 Task 2：markdown 接 compute 路由） ----------

/**
 * markdown 正文引擎状态（getEngine 契约值，遗留 T1）：local/remote 即执行位置。
 * 无 'pending'——实例只在 render 完成后创建并返回，getEngine 无观察窗口，
 * await 期间的中间态不可达（ViewerPane 状态栏轮询从实例创建后才开始）。
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
 * 注入后端的最小接口：apps/web 侧组装（compute 路由 + 远程 comrak 端点 + 回退），
 * 失败直接 reject（显式 remote 的错误卡片语义由调用方兜底）。
 */
export type MarkdownBackend = (call: MarkdownBackendCall) => Promise<{ html: string; where: ComputeWhere }>;

let markdownBackend: MarkdownBackend | null = null;

/** 应用侧注入 markdown 正文引擎（apps/web 启动时调用；传 null 解绑回本地引擎）。 */
export function setMarkdownBackend(fn: MarkdownBackend | null): void {
  markdownBackend = fn;
}

/** 读取已注入的 markdown 正文引擎（测试断言用）。 */
export function getMarkdownBackend(): MarkdownBackend | null {
  return markdownBackend;
}

// ---------- 相对图片解析注入（终审 M3：相对图片 404） ----------

/**
 * 相对图片解析器：img 的相对 src + 当前文件来源 → 可用 URL（如同 store 文件的
 * blob URL）；找不到返回 null（保留原 src，维持 404 现状）。抛错视同找不到。
 * store 读取能力在 apps/web 侧组装（复用 setMarkdownBackend 注入模式：renderer
 * 不感知 store 具体实现）；本包单测以桩函数注入。
 */
export type MarkdownImageResolver = (src: string, source: FileSource) => Promise<string | null>;

let markdownImageResolver: MarkdownImageResolver | null = null;

/** 应用侧注入相对图片解析器（apps/web 启动时调用；传 null 解绑恢复 404 现状）。 */
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

/**
 * 渲染前解析文档内相对图片：命中 resolver → src 换为返回的 URL（blob: URL 登记，
 * destroy 时 revoke，与渲染实例生命周期对齐）；未命中/抛错保留原 src。
 * resolve 发生在 enrich/管线之后：av 扩展名的 img 已被替换为 media 元素不重复
 * 处理；灯箱点击时读 attr 自然拿到已解析的 src。
 */
async function resolveRelativeImages(scope: ParentNode, source: FileSource): Promise<string[]> {
  const resolver = markdownImageResolver;
  if (!resolver) return [];
  const created: string[] = [];
  for (const img of Array.from(scope.querySelectorAll('img'))) {
    const raw = img.getAttribute('src');
    if (!raw || isAbsoluteSrc(raw)) continue;
    try {
      const url = await resolver(raw, source);
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
 * 本地 markdown-it 直渲染 body（不再剥 front matter）：apps/web 注入后端的
 * auto 回退路径用——backend 收到的 text 已剥过 front matter，二次解析会把
 * 以 `---` 开头的正文误判为 front matter。
 */
export function renderMarkdownBody(body: string): string {
  return createMarkdownEngine().render(body);
}

/**
 * 标题文本 → slug id：小写化、去标点（保留 Unicode 字母/数字，CJK 不丢）、
 * 空白折叠为 '-'；全空回退 'section'。
 */
export function slugifyHeading(text: string): string {
  const slug = text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-');
  return slug === '' || slug === '-' ? 'section' : slug;
}

/**
 * 为 h1-h4 确保元素 id：无 id 生成 slug；与文档内其他元素 id（含作者 HTML 的
 * id）冲突时追加 -2/-3 后缀。幂等：有 id 的 heading 保留原值（预填排除
 * heading 自身，否则会被自己的 id 判为冲突而改名）。
 * used 预置灯箱 overlay id：正文标题恰为 md-lightbox-overlay 时 slug 会撞车，
 * 而灯箱 overlay 后挂在 body 上（openLightbox 按 LIGHTBOX_OVERLAY_ID 单例查找，
 * 重名 heading 会先占文档 id），预占后标题自动追加 -2 后缀，灯箱不受影响。
 */
export function assignHeadingIds(root: Document): void {
  const used = new Set<string>([LIGHTBOX_OVERLAY_ID]);
  for (const el of Array.from(root.querySelectorAll('[id]'))) {
    if (!el.matches('h1, h2, h3, h4')) used.add(el.id);
  }
  for (const h of Array.from(root.querySelectorAll('h1, h2, h3, h4'))) {
    let id = h.id || slugifyHeading(h.textContent ?? '');
    if (used.has(id)) {
      let n = 2;
      while (used.has(`${id}-${n}`)) n += 1;
      id = `${id}-${n}`;
    }
    h.id = id;
    used.add(id);
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

/** 搜索跳过的祖先元素：脚本/样式内容不是可读文本，复制按钮是 UI 而非文档内容 */
const SEARCH_SKIP_TAGS = new Set(['SCRIPT', 'STYLE']);

/**
 * 收集 scope 下可搜索的文本节点（文档序）：祖先含 SCRIPT/STYLE/md-copy-btn 的拒绝。
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
          if (SEARCH_SKIP_TAGS.has(el.tagName) || el.classList.contains('md-copy-btn')) {
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
 * 返回命中的 render-text 扩展形状：渲染视图无行概念，line 复用为命中序号
 * （gotoMatch 按同序定位），start/end 恒 0，preview 为命中文本节点上下文。
 * 空 query 还原上一次包裹并返回 []（退出搜索语义）。
 */
function createDomSearcher(target: HTMLElement, isDestroyed: () => boolean) {
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
    if (isDestroyed() || query === '') return [];
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

/** 超大文件降级实例：代码视图句柄 → RenderedInstance（无 TOC，搜索走 code 实现） */
function degradedInstance(
  code: RenderCodeHandle,
  target: HTMLElement,
  meta: MarkdownFileMeta
): Omit<RenderedInstance, 'search'> & {
  getToc(): never[];
  search(query: string, opts?: { caseSensitive?: boolean }): Promise<SearchMatch[]>;
  getMeta(): MarkdownFileMeta;
} {
  return {
    destroy() {
      code.destroy();
      target.replaceChildren();
      target.classList.remove('vv-degraded');
    },
    getToc: () => [], // 降级视图无标题结构
    search: (query: string, opts?: { caseSensitive?: boolean }) => code.search(query, opts),
    gotoMatch: (index) => code.gotoMatch(index),
    getMeta: () => meta
  };
}

export const markdownRenderer: Renderer = {
  id: 'markdown',
  label: 'Markdown',
  extensions: ['md', 'markdown'],
  async render(buffer: Uint8Array, target: HTMLElement, source: FileSource, det: Detection) {
    // 超大输入守卫：markdown 管线（净化/DOM 遍历/katex/mermaid）无分块能力，
    // >20MB 会长时间阻塞主线程。降级为纯文本代码视图（降级而非拒绝，内容仍可读）。
    if (buffer.byteLength > MARKUP_MAX_BYTES) {
      return degradedInstance(
        renderDegradedCode(buffer, target, {
          name: source.name,
          mode: '纯文本',
          encoding: det.encoding,
          ext: det.ext,
          highlight: false
        }),
        target,
        { encoding: det.encoding, size: buffer.byteLength }
      );
    }
    // 管线含动态 import（mermaid/katex/hljs）与注入后端的异步往返，期间 tab 可能
    // 已切换：destroyed 后不再挂载
    let destroyed = false;
    // U3：灯箱 owner 代币——destroy 只摘自己实例打开的 body 级 overlay
    const lightboxOwner = `md-render-${++lightboxOwnerSeq}`;
    const text = new TextDecoder(DECODERS[det.encoding ?? 'utf-8'], { fatal: false }).decode(buffer);
    // M7 正文引擎裁决：注入后端优先（路由策略与回退全在 apps/web 侧的 fn 内），
    // 未注入走本地 markdown-it（现状）。远程 comrak 不识别 front matter——交给
    // 后端前先剥掉；本地路径保持 renderMarkdownToHtml 原语义（内部解析 front matter）。
    const backend = getMarkdownBackend();
    let html: string;
    let engine: MarkdownEngineState = 'local';
    if (backend) {
      const computeSrc: ComputeSource | undefined =
        getRemoteBase(source.storeId) !== undefined
          ? { path: source.path, storeId: source.storeId }
          : undefined;
      const res = await backend({ text: parseFrontMatter(text).body, src: computeSrc });
      html = res.html;
      engine = res.where;
    } else {
      html = renderMarkdownToHtml(text).html;
    }
    // 引擎输出（含远程 comrak unsafe 结果）必经净化后才能入 DOM
    const doc = new DOMParser().parseFromString(sanitizeHtml(html), 'text/html');
    enrichMarkdownDom(doc);
    await runPipeline(doc, { highlightFence: fenceToHtml, lightboxOwner });
    if (destroyed) return { destroy() {} };
    // 相对图片 → 同 store 文件 URL（未注入 resolver 时原样保留，404 现状）
    const resolvedUrls = await resolveRelativeImages(doc, source);
    if (destroyed) {
      for (const url of resolvedUrls) {
        if (typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(url);
      }
      return { destroy() {} };
    }
    target.classList.add('vv-markdown');
    assignHeadingIds(doc); // TOC 点击按 id 定位，id 必须先于挂载/提取存在（挂载后节点已离开 doc）
    // 解析文档 → 挂载（节点被主文档收养，管线加的复制按钮/灯箱监听随节点保留）
    target.replaceChildren(...Array.from(doc.body.childNodes));
    const toc = extractToc(target);
    // 渲染视图搜索（Task 6）：root 即挂载后的 target；destroyed 闭包供防御
    const domSearch = createDomSearcher(target, () => destroyed);
    // getEngine 供 ViewerPane 状态栏显示正文引擎（M7：渲染: 本地/远程），复用 code 实例的轮询模式；
    // getMeta 供状态栏/属性面板元数据（BUG-04；markdown 渲染视图无行概念，不报 lines）
    const instance: Omit<RenderedInstance, 'search'> & {
      getEngine(): MarkdownEngineState;
      getMeta(): MarkdownFileMeta;
      search(query: string, opts?: { caseSensitive?: boolean }): Promise<SearchMatch[]>;
    } = {
      destroy() {
        destroyed = true;
        domSearch.restore(); // 还原搜索 mark，避免把包裹态节点留在 DOM（虽随即清空，保持对称）
        // 相对图片解析产出的 blob: URL 随实例释放（渲染重跑会重新解析，不复用旧 URL）
        for (const url of resolvedUrls) {
          if (typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(url);
        }
        // 灯箱 overlay 挂在 body（img 点击时 target 已在主文档），不随渲染节点销毁：显式清理。
        // 非 owner 时管线内跳过——多 markdown 实例共存不得互删对方正开着的灯箱（U3）
        removeLightboxOverlay(target.ownerDocument, lightboxOwner);
        target.replaceChildren();
        target.classList.remove('vv-markdown');
      },
      getToc: () => toc,
      search: domSearch.search,
      gotoMatch: domSearch.gotoMatch,
      getEngine: () => engine,
      getMeta: () => ({ encoding: det.encoding, size: buffer.byteLength })
    };
    return instance;
  }
};
