// engine.ts — markdown-it 引擎：GFM 全家（table/strikethrough 内建，tasklist 插件，
// footnote 插件，linkify）+ html:true。输出必经 sanitizeHtml（sanitize.ts）后才能入 DOM。
// footnote（终审批次 C）：补齐与 comrak（服务端）的 GFM 脚注能力对齐——此前本地引擎
// 把 `[^1]` 渲染成字面文本而服务端出 footnote-ref，同文档双引擎渲染不一致。
// 删除线（BUG-67/CAND-cmp-F1，同缺陷类 BUG-66/CAND-md-F1）：markdown-it v13 起
// strikethrough 默认标签由 del 改为 <s>，而远程 comrak ext.strikethrough 出 <del>
// （server/src/compute/markdown.rs）——同文档 remote/local 双引擎 DOM 指纹必然差一个
// 标签。renderer rule 改写回 <del>（GFM 规范推荐标签），与 comrak 对齐。
import MarkdownIt from 'markdown-it';
import type { MarkdownIt as MarkdownItInstance } from 'markdown-it';
// markdown-it-task-lists / markdown-it-footnote 均无类型声明，见 src/types/*.d.ts
import taskLists from 'markdown-it-task-lists';
import footnote from 'markdown-it-footnote';
import { parseFrontMatter } from './frontMatter';

export interface MarkdownRenderResult {
  html: string;
  frontMatter: Record<string, unknown> | null;
}

export type MarkdownEngine = MarkdownItInstance;

/** 创建共享配置的 markdown-it 实例（html:true 输出必经净化；tasklist 复选框 disabled）。 */
export function createMarkdownEngine(): MarkdownEngine {
  const md = new MarkdownIt({ html: true, linkify: true, breaks: false });
  md.use(taskLists, { enabled: false });
  md.use(footnote);
  // 删除线输出 <del>（对齐 comrak/GFM，见文件头注释）。markdown-it v15 的
  // token 类型为 s_open/s_close（内建默认渲染 <s>），按名覆写
  md.renderer.rules.s_open = () => '<del>';
  md.renderer.rules.s_close = () => '</del>';
  installHeadingAnchors(md);
  return md;
}

/**
 * 标题尾置锚链接（BUG-67 指纹对齐第二处分歧）：远程 comrak 开 header_id_prefix
 * （server/src/compute/markdown.rs）为每级标题输出 id，并在标题末尾渲染空锚
 * `<a href="#{id}" aria-label="Link to heading '{text}'"
 * data-heading-content="{text}" class="anchor"></a>`（comrak 0.56 html.rs
 * render_heading）。本地 markdown-it 此前不产锚，同文档双引擎 DOM 指纹差 a.anchor。
 * BUG-39 裁决落地（2026-10-17，Wave 4）：双引擎 heading id 方案统一为 user-content-
 * 前缀命名空间（GitHub 同款）——本规则 href 与 comrak（header_id_prefix_in_href=true）
 * 同款输出带前缀完整锚；本地 heading 的实际 id 由 enrich 侧 assignHeadingIds 用同一
 * GfmAnchorizer 分配（markdownRenderer.ts），引擎 href 形态与其一致，前端锚 href
 * 改写步再按最终 id 收口（自一致由构造保证）。
 */
export class GfmAnchorizer {
  private ids = new Set<string>();
  private nextSuffix = new Map<string, number>();

  /** GFM 基名变换（comrak Anchorizer 同款）：小写 → 保留 空格/-/字母/附标/数字/
   * 连接标点 → 空格转 '-'。不去重。 */
  baseSlug(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^ \-\p{L}\p{M}\p{N}\p{Pc}]/gu, '')
      .replace(/ /g, '-');
  }

  /** comrak Anchorizer 同款去重：首现无后缀，重名 -1 起顺延。 */
  anchorize(text: string): string {
    const base = this.baseSlug(text);
    let uniq = this.nextSuffix.get(base) ?? 0;
    let anchor: string;
    for (;;) {
      anchor = uniq === 0 ? base : `${base}-${uniq}`;
      if (!this.ids.has(anchor)) break;
      uniq += 1;
    }
    this.ids.add(anchor);
    this.nextSuffix.set(base, uniq + 1);
    return anchor;
  }

  /** 预占既有 id（作者 HTML / 远程预填标题）：后续 anchorize 自动避让。 */
  reserve(id: string): void {
    this.ids.add(id);
  }
}

function installHeadingAnchors(md: MarkdownEngine): void {
  const headingText = (inline: { content: string; children: { content: string }[] | null } | undefined): string => {
    if (!inline) return '';
    if (inline.children === null) return inline.content;
    return inline.children.map((c) => c.content).join('');
  };
  const escapeAttr = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  md.renderer.rules.heading_close = (tokens, idx, _options, env) => {
    // tokens[idx-1] = inline（标题文本）；id 取 comrak 同款 GFM anchorize + user-content-
    // 前缀（BUG-39 双引擎统一命名空间；本地 heading 的实际 id 归 enrich assignHeadingIds，
    // 同一 GfmAnchorizer 算法，最终一致）
    const text = headingText(tokens[idx - 1]);
    const scope = (env ??= {}) as { __anchorizer?: GfmAnchorizer };
    const state = scope.__anchorizer ?? (scope.__anchorizer = new GfmAnchorizer());
    const id = state.anchorize(text);
    const escaped = escapeAttr(text);
    return `<a href="#user-content-${id}" aria-label="Link to heading '${escaped}'" data-heading-content="${escaped}" class="anchor"></a></${tokens[idx]!.tag}>\n`;
  };
}

const sharedEngine = createMarkdownEngine();

/** markdown 源 → { html, frontMatter }。front matter 解析失败/非映射时为 null 且原文整体渲染。 */
export function renderMarkdownToHtml(src: string): MarkdownRenderResult {
  const { frontMatter, body } = parseFrontMatter(src);
  return { html: sharedEngine.render(body), frontMatter };
}
