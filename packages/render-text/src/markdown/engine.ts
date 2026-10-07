// engine.ts — markdown-it 引擎：GFM 全家（table/strikethrough 内建，tasklist 插件，
// footnote 插件，linkify）+ html:true。输出必经 sanitizeHtml（sanitize.ts）后才能入 DOM。
// footnote（终审批次 C）：补齐与 comrak（服务端）的 GFM 脚注能力对齐——此前本地引擎
// 把 `[^1]` 渲染成字面文本而服务端出 footnote-ref，同文档双引擎渲染不一致。
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
  return md;
}

const sharedEngine = createMarkdownEngine();

/** markdown 源 → { html, frontMatter }。front matter 解析失败/非映射时为 null 且原文整体渲染。 */
export function renderMarkdownToHtml(src: string): MarkdownRenderResult {
  const { frontMatter, body } = parseFrontMatter(src);
  return { html: sharedEngine.render(body), frontMatter };
}
