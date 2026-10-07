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
import type { Renderer, RenderedInstance, Detection, FileSource, TocEntry, ComputeSource, ComputeWhere } from '@vviewer/core';
import { getRemoteBase } from '@vviewer/core';
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
import { createMarkdownEngine, renderMarkdownToHtml } from './engine';
import { parseFrontMatter } from './frontMatter';
import { sanitizeHtml } from './sanitize';
import { enrichMarkdownDom } from './enrich';
import { runPipeline, removeLightboxOverlay, LIGHTBOX_OVERLAY_ID } from './pipeline';

/**
 * 围栏代码高亮回调（pipeline 的 highlightFence 实现）：HighlightClient 区间
 * → 行分配 → span HTML（类名经 captureToCssClass，与 code 渲染器同一来源）。
 * client 未注入、语言不在 grammar 清单、请求被取消（tab 切换）等一切失败
 * 返回 null → 管线内 hljs 兜底。
 */
export async function fenceToHtml(code: string, lang: string): Promise<string | null> {
  const client = getHighlightClient();
  if (!client) return null;
  try {
    const intervals = await client.highlight(code, lang);
    const lines = buildLineIndex(code);
    const byLine = new Map(
      assignIntervalsToLines(intervals, buildLineOffsets(lines)).map((a) => [a.line, a.segs])
    );
    return lines.map((line, i) => renderLineHtml(line, byLine.get(i))).join('\n');
  } catch {
    return null;
  }
}

// ---------- 正文引擎注入（M7 Task 2：markdown 接 compute 路由） ----------

/** markdown 正文引擎状态：pending = 已启动等待结果；渲染完成后落 local/remote。 */
export type MarkdownEngineState = 'pending' | 'local' | 'remote';

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

  async function search(query: string): Promise<SearchMatchWithPreview[]> {
    restore(); // 上一次的 mark 先还原，避免嵌套
    if (isDestroyed() || query === '') return [];
    const needle = query.toLowerCase();
    const doc = target.ownerDocument;
    const results: SearchMatchWithPreview[] = [];
    for (const node of collectTextNodes(target)) {
      const text = node.nodeValue ?? '';
      const lower = text.toLowerCase();
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

/** 超大文件降级实例：代码视图句柄 → RenderedInstance（无 TOC，搜索走 code 实现） */
function degradedInstance(code: RenderCodeHandle, target: HTMLElement): RenderedInstance {
  return {
    destroy() {
      code.destroy();
      target.replaceChildren();
      target.classList.remove('vv-degraded');
    },
    getToc: () => [], // 降级视图无标题结构
    search: (query) => code.search(query),
    gotoMatch: (index) => code.gotoMatch(index)
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
        target
      );
    }
    // 管线含动态 import（mermaid/katex/hljs）与注入后端的异步往返，期间 tab 可能
    // 已切换：destroyed 后不再挂载
    let destroyed = false;
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
      engine = 'pending';
      const res = await backend({ text: parseFrontMatter(text).body, src: computeSrc });
      html = res.html;
      engine = res.where;
    } else {
      html = renderMarkdownToHtml(text).html;
    }
    // 引擎输出（含远程 comrak unsafe 结果）必经净化后才能入 DOM
    const doc = new DOMParser().parseFromString(sanitizeHtml(html), 'text/html');
    enrichMarkdownDom(doc);
    await runPipeline(doc, { highlightFence: fenceToHtml });
    if (destroyed) return { destroy() {} };
    target.classList.add('vv-markdown');
    assignHeadingIds(doc); // TOC 点击按 id 定位，id 必须先于挂载/提取存在（挂载后节点已离开 doc）
    // 解析文档 → 挂载（节点被主文档收养，管线加的复制按钮/灯箱监听随节点保留）
    target.replaceChildren(...Array.from(doc.body.childNodes));
    const toc = extractToc(target);
    // 渲染视图搜索（Task 6）：root 即挂载后的 target；destroyed 闭包供防御
    const domSearch = createDomSearcher(target, () => destroyed);
    // getEngine 供 ViewerPane 状态栏显示正文引擎（M7：渲染: 本地/远程），复用 code 实例的轮询模式
    const instance: RenderedInstance & { getEngine(): MarkdownEngineState } = {
      destroy() {
        destroyed = true;
        domSearch.restore(); // 还原搜索 mark，避免把包裹态节点留在 DOM（虽随即清空，保持对称）
        // 灯箱 overlay 挂在 body（img 点击时 target 已在主文档），不随渲染节点销毁：显式清理
        removeLightboxOverlay(target.ownerDocument);
        target.replaceChildren();
        target.classList.remove('vv-markdown');
      },
      getToc: () => toc,
      search: domSearch.search,
      gotoMatch: domSearch.gotoMatch,
      getEngine: () => engine
    };
    return instance;
  }
};
