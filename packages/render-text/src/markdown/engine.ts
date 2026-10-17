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
 * render_heading；href 不带前缀）。本地 markdown-it 此前不产锚，同文档双引擎
 * DOM 指纹差 a.anchor。
 * 范围裁决（2026-10-17）：此处**仅补指纹面的锚元素**（形状逐属性对齐 comrak），
 * heading id 不在此注入——id 方案（user-content- 前缀 vs 本地 slug、页内锚
 * href 一致性）是 t-md 域在案缺陷 BUG-39 的修复空间（锚点 t-md.spec.ts
 * 'BUG-39 [探索]'，方向未决），越界注入会预支其裁决并引入本地版 href/id 死链。
 * 本地 heading id 仍由 enrich assignHeadingIds 的 slug 管线分配（markdown
 * Renderer.ts），行为零变化。anchorize 用 comrak Anchorizer 同款 GFM 算法
 * （小写 → 保留 空格/-/字母/附标/数字/连接标点 → 空格转 - → 文档内重名 -1
 * 去重，去重状态挂 env 每渲染独立）。
 */
function installHeadingAnchors(md: MarkdownEngine): void {
  const headingText = (inline: { content: string; children: { content: string }[] | null } | undefined): string => {
    if (!inline) return '';
    if (inline.children === null) return inline.content;
    return inline.children.map((c) => c.content).join('');
  };
  const anchorize = (env: Record<string, unknown>, text: string): string => {
    const state = (env.__anchorizer ??= { seen: new Set<string>(), next: new Map<string, number>() }) as {
      seen: Set<string>;
      next: Map<string, number>;
    };
    const base = text
      .toLowerCase()
      .replace(/[^ \-\p{L}\p{M}\p{N}\p{Pc}]/gu, '')
      .replace(/ /g, '-');
    let uniq = state.next.get(base) ?? 0;
    let anchor: string;
    for (;;) {
      anchor = uniq === 0 ? base : `${base}-${uniq}`;
      if (!state.seen.has(anchor)) break;
      uniq += 1;
    }
    state.seen.add(anchor);
    state.next.set(base, uniq + 1);
    return anchor;
  };
  const escapeAttr = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  md.renderer.rules.heading_close = (tokens, idx, _options, env) => {
    // tokens[idx-1] = inline（标题文本）；id 取 comrak 同款 GFM anchorize（无前缀，
    // 与远程 href 形态一致；本地 heading 的实际 id 归 enrich slug 管线，见上）
    const text = headingText(tokens[idx - 1]);
    const id = anchorize(env as Record<string, unknown>, text);
    const escaped = escapeAttr(text);
    return `<a href="#${id}" aria-label="Link to heading '${escaped}'" data-heading-content="${escaped}" class="anchor"></a></${tokens[idx]!.tag}>\n`;
  };
}

const sharedEngine = createMarkdownEngine();

/** markdown 源 → { html, frontMatter }。front matter 解析失败/非映射时为 null 且原文整体渲染。 */
export function renderMarkdownToHtml(src: string): MarkdownRenderResult {
  const { frontMatter, body } = parseFrontMatter(src);
  return { html: sharedEngine.render(body), frontMatter };
}
