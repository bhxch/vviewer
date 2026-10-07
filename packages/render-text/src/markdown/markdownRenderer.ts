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
import { renderMarkdownToHtml } from './engine';
import { sanitizeHtml } from './sanitize';
import { enrichMarkdownDom } from './enrich';
import { runPipeline } from './pipeline';

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
    const instance: RenderedInstance = {
      destroy() {
        destroyed = true;
        target.replaceChildren();
        target.classList.remove('vv-markdown');
      },
      getToc: () => toc
    };
    return instance;
  }
};
