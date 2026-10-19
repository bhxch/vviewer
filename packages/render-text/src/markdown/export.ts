// export.ts — 导出装配纯函数集（spec 2026-10-19 §6/§7，md-export Task 1）。
// collectExportHtml：管线成品 Document → 自包含 HTML 字符串（剥交互壳 → 图片
// data URI 化 → 音视频降级链接 → 静态 TOC → 样式注入 → 序列化）；collectPrintHtml：
// 导出 HTML → 打印模板（@page 尺寸映射 + @media print 分页保护）。
// 本模块无浏览器副作用（fetch/Blob/iframe print 由 apps/web 触发壳承担），输入
// 输出皆为 DOM/字符串，可单测。入参 Document 约定为工作副本（调用方持有的独立
// 文档——markdownRenderer 实例 getExportDocument 返回的克隆），就地装配不额外
// 克隆；每张图片解析失败/返回 null 均降级原 URL，单点故障不阻塞整篇导出。

// ---------- 基础排版样式（md-export Task 2 触发壳消费） ----------

/**
 * 导出基础排版 CSS（单源常量，随本文件维护——md-export 台账裁决：常量单源 +
 * app.css 复制 + 双端同步注释）。内容为 app.css 的 :root 变量子集（亮/暗双块，
 * 暗块以 html[data-vv-mode="dark"] 为键——触发壳按当前生效模式在导出文档根元素
 * 打标）+ body 基线 + .vv-markdown 排版段。双端同步点：
 * - 变量值/排版规则改动须同步 apps/web/src/app.css 对应段（该段头部有同步注释）；
 * - 交互壳规则（md-copy-btn hover 等）不进导出：交互壳在装配时已剥离；
 * - 代码主题变量（--vv-ts-* 与 --hljs-* 覆盖）不在此处——由触发壳抽取 style
 *   #vv-code-theme 的当前 textContent 注入（本文档只带亮暗默认值兜底）。
 */
export const exportBaseCss = `/* vviewer markdown 导出基础排版（与 apps/web/src/app.css 的 .vv-markdown 段同步维护） */
:root {
  --vv-code-font: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
  --ui-bg: #ffffff; --ui-fg: #1f2328; --ui-fg-muted: #656d76; --ui-border: #d0d7de;
  --ui-accent: #0969da; --ui-side-bg: #f6f8fa;
  --code-bg: #ffffff; --code-fg: #1f2328;
  --hljs-keyword: #cf222e; --hljs-string: #0a3069; --hljs-comment: #6e7781;
  --hljs-number: #0550ae; --hljs-title: #8250df; --hljs-built_in: #0550ae; --hljs-attr: #0550ae;
}
:root[data-vv-mode="dark"] {
  --ui-bg: #0d1117; --ui-fg: #e6edf3; --ui-fg-muted: #8b949e; --ui-border: #30363d;
  --ui-accent: #2f81f7; --ui-side-bg: #161b22;
  --code-bg: #0d1117; --code-fg: #e6edf3;
  --hljs-keyword: #ff7b72; --hljs-string: #a5d6ff; --hljs-comment: #8b949e;
  --hljs-number: #79c0ff; --hljs-title: #d2a8ff; --hljs-built_in: #79c0ff; --hljs-attr: #79c0ff;
}
body { margin: 0; background: var(--ui-bg); color: var(--ui-fg); font-family: system-ui, -apple-system, sans-serif; }
.vv-markdown { max-width: 60rem; padding: 1rem 1.5rem; line-height: 1.6; overflow-wrap: break-word; }
.vv-markdown h1, .vv-markdown h2, .vv-markdown h3, .vv-markdown h4 { line-height: 1.3; margin: 1.5em 0 .5em; scroll-margin-top: .5rem; }
.vv-markdown h1 { font-size: 1.6em; border-bottom: 1px solid var(--ui-border); padding-bottom: .3em; }
.vv-markdown h2 { font-size: 1.35em; border-bottom: 1px solid var(--ui-border); padding-bottom: .2em; }
.vv-markdown h3 { font-size: 1.15em; }
.vv-markdown pre { background: var(--code-bg); border: 1px solid var(--ui-border);
  border-radius: 6px; padding: .75rem 1rem; overflow: auto; }
.vv-markdown code { font-family: var(--vv-code-font); font-size: .9em; background: var(--ui-side-bg);
  border-radius: 4px; padding: .1em .35em; }
.vv-markdown pre code { background: none; padding: 0; }
.vv-markdown blockquote { margin: .8rem 0; padding: .1rem 1rem; color: var(--ui-fg-muted);
  border-left: 4px solid var(--ui-border); }
.vv-markdown table { border-collapse: collapse; margin: .8rem 0; }
.vv-markdown th, .vv-markdown td { border: 1px solid var(--ui-border); padding: .3rem .65rem; }
.vv-markdown img, .vv-markdown video, .vv-markdown audio { max-width: 100%; }
.vv-markdown .md-code-bar { display: flex; align-items: center; gap: .5rem;
  margin: -.75rem -1rem .5rem; padding: .25rem .6rem; border-bottom: 1px solid var(--ui-border);
  background: var(--ui-side-bg); }
.vv-markdown .md-code-lang { font-size: 12px; color: var(--ui-fg-muted); text-transform: uppercase; letter-spacing: .04em; }
.vv-markdown .md-diagram { margin: .8rem 0; border: 1px solid var(--ui-border); border-radius: 6px; overflow: hidden; }
.vv-markdown .md-diagram-bar { display: flex; align-items: center; gap: .5rem; padding: .25rem .6rem; border-bottom: 1px solid var(--ui-border); background: var(--ui-side-bg); }
.vv-markdown .md-diagram-lang { font-size: 12px; color: var(--ui-fg-muted); text-transform: uppercase; letter-spacing: .04em; }
.vv-markdown .md-diagram-view { display: flex; justify-content: center; padding: .6rem; overflow-x: auto; }
.vv-markdown .md-diagram-view svg { max-width: 100%; height: auto; }
.vv-markdown .md-diagram-view img { max-width: 100%; }
.vv-markdown .md-diagram-view.md-diagram-error { display: block; white-space: pre-wrap; color: var(--ui-fg-muted); font-family: var(--vv-code-font); font-size: 13px; }
.vv-markdown .md-diagram-view[hidden] { display: none; }
.vv-markdown .md-diagram-source { padding: .6rem; overflow-x: auto; }
.vv-markdown .md-diagram-source code { font-family: var(--vv-code-font); font-size: 13px; }
.vv-markdown .md-wikilink-dead { border-bottom: 1px dashed var(--ui-border); cursor: default; }
.markdown-alert { border: 1px solid var(--ui-border); border-left-width: 4px; border-radius: 6px;
  padding: .5rem 1rem; margin: .8rem 0; }
.markdown-alert-title { display: flex; align-items: center; gap: .4rem; font-weight: 600; margin: .2rem 0; }
.markdown-alert-note, .markdown-alert-info, .markdown-alert-faq, .markdown-alert-question { border-left-color: #0969da; }
.markdown-alert-tip { border-left-color: #1a7f37; }
.markdown-alert-important, .markdown-alert-example { border-left-color: #8250df; }
.markdown-alert-warning { border-left-color: #9a6700; }
.markdown-alert-caution { border-left-color: #cf222e; }
.markdown-alert-todo { border-left-color: #57606a; }
.markdown-alert-foldable > .markdown-alert-title { cursor: pointer; user-select: none; }
.markdown-alert-foldable > .markdown-alert-title::after { content: '▾'; margin-left: auto;
  font-size: .8em; color: var(--ui-fg-muted); }
.markdown-alert-collapsed > .markdown-alert-title::after { content: '▸'; }
.markdown-alert-collapsed > :not(.markdown-alert-title) { display: none; }
/* 导出目录（本模块生成） */
.vv-export-toc { border: 1px solid var(--ui-border); border-radius: 6px; padding: .6rem 1rem; margin: 1rem 0; }
.vv-export-toc-title { font-weight: 600; margin-bottom: .4rem; }
.vv-export-toc ul { margin: 0; padding: 0; }
.vv-export-toc li { list-style: none; }
.vv-export-toc a { color: var(--ui-fg); text-decoration: none; }
.vv-export-toc .vv-toc-l2 { padding-left: 1em; }
.vv-export-toc .vv-toc-l3 { padding-left: 2em; }
.vv-export-toc .vv-toc-l4 { padding-left: 3em; }`;

// ---------- collectExportHtml：自包含 HTML 装配 ----------

/** collectExportHtml 选项（resolveImage 由触发壳注入：返回 null = 保留原 URL）。 */
export interface ExportHtmlOptions {
  /** 导出文档标题（<title>；触发壳传文件名） */
  title: string;
  /** 内联样式文本（触发壳组装：exportBaseCss + 主题变量块；'</style' 已转义防护） */
  styleCss: string;
  /**
   * KaTeX 排印样式（spec §6，Task 2b：全嵌上限形态，按需裁剪列未来优化）。
   * 触发壳以「woff2 字体已转 data:font/woff2 内联、woff/ttf 回退段已移除」的
   * katex.min.css 完整文本传入（apps/web 壳侧读包内资产，本包不做 fs/资产解析，
   * 保持纯函数性）；缺省/空串不嵌入（导出公式与预览同为无排印结构）。
   */
  katexCss?: string;
  /**
   * 图片 data URI 解析回调：blob:/同源 http(s) → fetch 转 data URI；data: 已内联
   * 与外域 http(s)（CORS 不可控不强拉）返回 null 保留原 URL；抛错视同失败。
   */
  resolveImage(src: string): Promise<string | null>;
}

/** 交互壳剥离清单（管线产物类名，见 pipeline.ts CLS / lightbox.ts）：复制钮、图表
 * 切换钮、灯箱 overlay。源码面板不在此列——source 模式图表的唯一展示就是它，
 * 按 wrapper 内视图可见性逐个判定（stripInteractiveShells）。 */
const STRIP_SELECTORS = ['.md-copy-btn', '.md-diagram-toggle', '.md-lightbox-overlay'] as const;

function stripInteractiveShells(root: Document): void {
  for (const sel of STRIP_SELECTORS) {
    for (const el of Array.from(root.querySelectorAll(sel))) el.remove();
  }
  // 图表 wrapper 内源码面板：视图可见（有图可看）时是切换备胎 → 剥离；视图隐藏
  // （source 模式 / kroki 失败态）时是唯一内容 → 保留（剥离即丢内容）
  for (const wrap of Array.from(root.querySelectorAll('.md-diagram'))) {
    const view = wrap.querySelector('.md-diagram-view');
    const sourcePane = wrap.querySelector('.md-diagram-source');
    if (view !== null && sourcePane !== null && !view.hasAttribute('hidden')) sourcePane.remove();
  }
}

/** 音视频占位降级为源地址超链接（防 data URI 爆炸，spec §6）：无 src 直接移除。 */
function demoteMediaToLinks(root: Document): void {
  for (const media of Array.from(root.querySelectorAll('video, audio'))) {
    const src = media.getAttribute('src') ?? '';
    if (src === '') {
      media.remove();
      continue;
    }
    const a = root.createElement('a');
    a.setAttribute('href', src);
    a.textContent = media.getAttribute('aria-label') || media.getAttribute('title') || src;
    media.replaceWith(a);
  }
}

/** 图片 data URI 化（Promise.all 并行）：回调结果非空才换 src；抛错/null 保留原 URL。 */
async function inlineImages(root: Document, resolveImage: ExportHtmlOptions['resolveImage']): Promise<void> {
  const imgs = Array.from(root.querySelectorAll('img[src]'));
  await Promise.all(
    imgs.map(async (img) => {
      const src = img.getAttribute('src') ?? '';
      let replacement: string | null = null;
      try {
        replacement = await resolveImage(src);
      } catch {
        replacement = null; // fetch 抛错降级原 URL（spec：fetch 失败保留原 URL）
      }
      if (replacement !== null && replacement !== '') img.setAttribute('src', replacement);
    })
  );
}

/** 静态 TOC（spec §6：锚列表，无滚动跟踪脚本）：h1-h4 文档序，仅收有 id 的标题
 * （id 由管线 assignHeadingIds 保证；heading 内引擎自产锚是空元素不污染文本）。 */
function buildTocNav(root: Document): Element | null {
  const headings = Array.from(root.querySelectorAll('h1, h2, h3, h4')).filter((h) => h.id !== '');
  if (headings.length === 0) return null;
  const nav = root.createElement('nav');
  nav.className = 'vv-export-toc';
  const title = root.createElement('div');
  title.className = 'vv-export-toc-title';
  title.textContent = '目录';
  const list = root.createElement('ul');
  for (const h of headings) {
    const li = root.createElement('li');
    li.className = `vv-toc-l${h.tagName[1]}`;
    const a = root.createElement('a');
    a.setAttribute('href', `#${h.id}`);
    a.textContent = (h.textContent ?? '').trim();
    li.append(a);
    list.append(li);
  }
  nav.append(title, list);
  return nav;
}

/** 样式文本的 </style 转义防护（spec §6）：防主题注入样式文本截断 style 块。 */
function escapeStyleCss(css: string): string {
  return css.replace(/<\/(style)/gi, '<\\/$1');
}

function serializeDocument(doc: Document): string {
  return `<!DOCTYPE html>\n${doc.documentElement.outerHTML}`;
}

/**
 * 自包含 HTML 装配（spec §6）：剥离交互壳 → 音视频降级链接 → 图片 data URI 化
 * （并行）→ 拼静态 TOC（body 顶部）→ head 注入 title/meta charset/<style> →
 * 序列化完整 HTML 字符串。入参 doc 就地装配（约定为工作副本，见文件头）。
 */
export async function collectExportHtml(doc: Document, opts: ExportHtmlOptions): Promise<string> {
  stripInteractiveShells(doc);
  demoteMediaToLinks(doc);
  await inlineImages(doc, opts.resolveImage);
  const toc = buildTocNav(doc);
  if (toc !== null) doc.body.prepend(toc);
  doc.title = opts.title;
  const meta = doc.createElement('meta');
  meta.setAttribute('charset', 'utf-8');
  doc.head.prepend(meta);
  const style = doc.createElement('style');
  style.textContent = escapeStyleCss(opts.styleCss);
  doc.head.append(style);
  // KaTeX 排印样式独立 <style>（与基础/主题样式分离，纯文本嵌入无 @import/外链）
  if (opts.katexCss) {
    const katexStyle = doc.createElement('style');
    katexStyle.textContent = escapeStyleCss(opts.katexCss);
    doc.head.append(katexStyle);
  }
  return serializeDocument(doc);
}

// ---------- collectPrintHtml：打印模板 ----------

/** 打印页型（spec §7；dynamic = 单页动态高度，触发壳 onload 后回写精确页高）。 */
export type PrintPage = 'a4' | 'a3' | 'letter' | 'legal' | 'dynamic';

const PAGE_SIZES: Record<Exclude<PrintPage, 'dynamic'>, string> = {
  a4: 'A4 portrait',
  a3: 'A3 portrait',
  letter: 'letter portrait',
  legal: 'legal portrait'
};

/**
 * 打印保护 CSS（spec §7）：不可断标签 break-inside:avoid；大图按页高 95% 缩放
 * 防跨页（vh 在打印上下文解析为页面视口高，等效「页高 95%」——img 的百分比
 * max-height 对 auto 高父容器不生效，故取 vh 形态）。
 */
const PRINT_PROTECT_CSS = `@media print {
  pre, table, figure, svg { break-inside: avoid; }
  img, svg { max-height: 95vh; } /* 页高 95% */
}`;

/**
 * 打印模板装配（spec §7）：输入 collectExportHtml 产物字符串，head 注入
 * `<style data-vv-page>`（@page 尺寸 + 分页保护），返回完整 HTML。dynamic 页型
 * 先发 A4 占位并带 vv-dynamic-page 标记，触发壳 iframe onload 后按内容实测高度
 * 回写（styleTextContent 整体替换即可，data-vv-page 属性是定位锚）。
 */
export function collectPrintHtml(html: string, opts: { page: PrintPage }): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const size = opts.page === 'dynamic'
    ? `${PAGE_SIZES.a4} /* vv-dynamic-page: 触发壳 onload 后按内容高度回写 */`
    : PAGE_SIZES[opts.page];
  const style = doc.createElement('style');
  style.setAttribute('data-vv-page', opts.page);
  style.textContent = `@page { size: ${size}; margin: 12mm; }\n${PRINT_PROTECT_CSS}`;
  doc.head.append(style);
  return serializeDocument(doc);
}
