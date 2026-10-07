// markdownRenderer.ts — markdown 渲染器（Task 4）：T1-T3 五步管线的 Renderer 装配。
// render 链：renderMarkdownToHtml → sanitizeHtml → DOMParser 解析 → enrichMarkdownDom
// → runPipeline（highlightFence 注入）→ 挂载 target → heading 赋 id → TOC 提取。
// 依赖倒置：围栏高亮复用 code.ts 的 HighlightClient 全局单例（apps/web 启动时经
// attachHighlightClient 注入，本模块无需 viewer.ts 额外接线）；client 不可用/失败
// 时 fenceToHtml 返回 null，管线内回落 hljs。
import type { Renderer, RenderedInstance, Detection, FileSource, TocEntry } from '@vviewer/core';
import {
  DECODERS,
  getHighlightClient,
  buildLineIndex,
  buildLineOffsets,
  assignIntervalsToLines,
  renderLineHtml
} from '../code';
import { makePreview, type SearchMatchWithPreview } from '../search';
import { renderMarkdownToHtml } from './engine';
import { sanitizeHtml } from './sanitize';
import { enrichMarkdownDom } from './enrich';
import { runPipeline, removeLightboxOverlay } from './pipeline';

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
 */
export function assignHeadingIds(root: Document): void {
  const used = new Set<string>();
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

export const markdownRenderer: Renderer = {
  id: 'markdown',
  label: 'Markdown',
  extensions: ['md', 'markdown'],
  async render(buffer: Uint8Array, target: HTMLElement, _source: FileSource, det: Detection) {
    void _source;
    // 管线含动态 import（mermaid/katex/hljs），期间 tab 可能已切换：destroyed 后不再挂载
    let destroyed = false;
    const text = new TextDecoder(DECODERS[det.encoding ?? 'utf-8'], { fatal: false }).decode(buffer);
    const { html } = renderMarkdownToHtml(text);
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
    const instance: RenderedInstance = {
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
      gotoMatch: domSearch.gotoMatch
    };
    return instance;
  }
};
