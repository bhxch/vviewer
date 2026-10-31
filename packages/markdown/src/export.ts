// export.ts — 导出装配纯函数集（spec 2026-10-19 §6/§7，md-export Task 1）。
// collectExportHtml：管线成品 Document → 自包含 HTML 字符串（剥交互壳 → 图片
// data URI 化 → 音视频降级链接 → 静态 TOC → 样式注入 → 序列化）；collectPrintHtml：
// 导出 HTML → 打印模板（@page 尺寸映射 + @media print 分页保护）。
// 本模块无浏览器副作用（fetch/Blob/iframe print 由宿主触发壳承担），输入
// 输出皆为 DOM/字符串，可单测。入参 Document 约定为工作副本（调用方持有的独立
// 文档——markdownRenderer 实例 getExportDocument 返回的克隆），就地装配不额外
// 克隆；每张图片解析失败/返回 null 均降级原 URL，单点故障不阻塞整篇导出。
// （自 render-text/src/markdown/export.ts 迁入；exportBaseCss 的共享规则段改由
// css.ts 单源引用——消灭原 app.css↔export.ts 双端手工镜像，交互壳规则与导出
// 专有段（:root 令牌块/body/.vv-export-toc）留在本文件。）

import { LIGHTBOX_OVERLAY_ID } from '@vviewer/lightbox';
import {
  HIGHLIGHT_CSS,
  TYPOGRAPHY_CSS,
  CODE_BAR_CSS,
  DIAGRAM_CSS,
  ALERT_CSS,
  WIKILINK_CSS
} from './css';

// ---------- 基础排版样式（导出触发壳消费） ----------

/**
 * 导出基础排版 CSS：共享规则段（高亮映射/排版/代码顶栏/图表/callout/wikilink）
 * 自 css.ts 单源引用，此处只叠加导出专有的 :root 令牌块（亮/暗双块，暗块以
 * html[data-vv-mode="dark"] 为键——触发壳按当前生效模式在导出文档根元素打标）、
 * body 基线与导出目录段。
 * 单源说明（md-export 台账裁决演进）：原「常量单源 + app.css 复制 + 双端同步注释」
 * 的手工镜像改为 css.ts 单源 + markdown.css 镜像（test/cssMirror.test.ts 锁等价），
 * app.css 侧的切换是后续步骤（本包内不再持有第二份映射/排版规则文本）。
 * 与运行时样式的口径差异（保留原导出语义）：
 * - 交互壳规则（徽标 button reset/hover、alert 折叠 foldable/collapsed、灯箱、
 *   锚点焦点揭示）不进导出：交互壳在装配时已剥离（徽标 button 已转纯 span）；
 *   折叠规则删而不留——剥离后永不命中，留存反成
 *   「忘剥→collapsed 正文永久 display:none」的隐患（删之 fail-safe 为普通 alert）；
 * - 代码主题变量值（--vv-ts-* 与 --hljs-* 覆盖）不在此处——由触发壳抽取 style
 *   #vv-code-theme 的当前 textContent 注入（本文档只带映射段与令牌缺省值；变量
 *   值需映射段先在才有落点）。
 */
export const exportBaseCss = `/* vviewer markdown 导出基础排版（共享规则段自 @vviewer/markdown css.ts 单源引用） */
:root {
  --vv-code-font: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
  --ui-bg: #ffffff; --ui-fg: #1f2328; --ui-fg-muted: #656d76; --ui-border: #d0d7de;
  --ui-accent: #0969da; --ui-side-bg: #f6f8fa;
  /* 语义色（§2.4 alert 七色令牌化同步）：callout 边色落点 */
  --ui-danger: #cf222e; --ui-warning: #9a6700; --ui-success: #1a7f37; --ui-accent-2: #8250df;
  --code-bg: #ffffff; --code-fg: #1f2328;
  --hljs-keyword: #cf222e; --hljs-string: #0a3069; --hljs-comment: #6e7781;
  --hljs-number: #0550ae; --hljs-title: #8250df; --hljs-built_in: #0550ae; --hljs-attr: #0550ae;
}
:root[data-vv-mode="dark"] {
  --ui-bg: #0d1117; --ui-fg: #e6edf3; --ui-fg-muted: #8b949e; --ui-border: #30363d;
  --ui-accent: #2f81f7; --ui-side-bg: #161b22;
  /* 暗块同值（§2.2 暗色补漏：callout 边随暗色令牌） */
  --ui-danger: #f85149; --ui-warning: #d29922; --ui-success: #3fb950; --ui-accent-2: #a371f7;
  --code-bg: #0d1117; --code-fg: #e6edf3;
  --hljs-keyword: #ff7b72; --hljs-string: #a5d6ff; --hljs-comment: #8b949e;
  --hljs-number: #79c0ff; --hljs-title: #d2a8ff; --hljs-built_in: #79c0ff; --hljs-attr: #79c0ff;
}
${HIGHLIGHT_CSS}
body { margin: 0; background: var(--ui-bg); color: var(--ui-fg); font-family: system-ui, -apple-system, sans-serif; }
${TYPOGRAPHY_CSS}
${CODE_BAR_CSS}
${DIAGRAM_CSS}
${WIKILINK_CSS}
${ALERT_CSS}
/* 折叠规则（foldable/collapsed）不进导出（终审 M2）：剥离后永不命中，
   删之使「忘剥→显示为普通 alert」fail-safe（留存则 collapsed 正文永久 display:none） */
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
   * katex.min.css 完整文本传入（宿主壳侧读包内资产，本包不做 fs/资产解析，
   * 保持纯函数性）；缺省/空串不嵌入（导出公式与预览同为无排印结构）。
   */
  katexCss?: string;
  /**
   * 图片 data URI 解析回调：blob:/同源 http(s) → fetch 转 data URI；data: 已内联
   * 与外域 http(s)（CORS 不可控不强拉）返回 null 保留原 URL；抛错视同失败。
   */
  resolveImage(src: string): Promise<string | null>;
}

/**
 * 交互壳剥离清单（管线产物类名，见 pipeline.ts CLS / @vviewer/lightbox）：图表切换钮、
 * 灯箱 overlay。语言徽标（button.md-code-lang，spec 2026-10-23 §5 徽标即复制单入口）
 * 在此列但按形态转换处理——导出无脚本，button 交互面转纯 span，语言词保留（见
 * flattenCodeLangBadge）。源码面板不在此列——source 模式图表的唯一展示就是它，
 * 按 wrapper 内视图可见性逐个判定（stripInteractiveShells）。口径注记（F5）：
 * 剥离对象为类名（交互壳在本仓以类承载）；计划 Global Constraints 所列
 * 「data-md-copy|md-lightbox|md-diagram-toggle」为语义列举（属性/类混称），
 * 实际剥离面以类名选择器为准，data-* 属性无行为不剥离。
 */
const STRIP_SELECTORS = ['.md-diagram-toggle', `.${LIGHTBOX_OVERLAY_ID}`] as const;

/** 语言徽标 button→span 定向转换：语言词（类名含主题前缀变体）与文本保留，title 等交互属性消失。 */
function flattenCodeLangBadge(root: Document): void {
  for (const btn of Array.from(root.querySelectorAll('button.md-code-lang'))) {
    const span = root.createElement('span');
    span.className = btn.className;
    span.textContent = btn.textContent;
    btn.replaceWith(span);
  }
}

function stripInteractiveShells(root: Document): void {
  for (const sel of STRIP_SELECTORS) {
    for (const el of Array.from(root.querySelectorAll(sel))) el.remove();
  }
  flattenCodeLangBadge(root);
  // 图表 wrapper 内源码面板：视图可见（有图可看）时是切换备胎 → 剥离；视图隐藏
  // （source 模式 / kroki 失败态）时是唯一内容 → 保留（剥离即丢内容）
  for (const wrap of Array.from(root.querySelectorAll('.md-diagram'))) {
    const view = wrap.querySelector('.md-diagram-view');
    const sourcePane = wrap.querySelector('.md-diagram-source');
    if (view !== null && sourcePane !== null && !view.hasAttribute('hidden')) sourcePane.remove();
  }
  // foldable callout（enrich 折叠卡片，F1）：折叠态由标题点击切换，导出无脚本——
  // 折叠类留着即死类名；剥离（配合 exportBaseCss 不含折叠规则，终审 M2）使导出
  // 形态=全部展开的普通 alert，忘剥时同样以普通 alert 呈现不丢正文。标题上的
  // markdown-alert-fold-toggle 为 enrich 挂点击监听用的纯标记类（无样式无行为），
  // 顺手剥净保持产物类名只余形态语义。
  for (const alert of Array.from(root.querySelectorAll('.markdown-alert-foldable'))) {
    alert.classList.remove('markdown-alert-foldable', 'markdown-alert-collapsed');
    for (const toggle of Array.from(alert.querySelectorAll('.markdown-alert-fold-toggle'))) {
      toggle.classList.remove('markdown-alert-fold-toggle');
    }
  }
}

/**
 * 音视频占位降级为源地址超链接（防 data URI 爆炸，spec §6）：无 src 直接移除。
 * 知情留档（S5）：产物 href 可含 data:（管线内联后的媒体）或 blob:（实例存活期
 * 生成的媒体 URL）——现代浏览器阻断顶级 data: 导航、blob: 在导出文件里是死链，
 * 二者点击均不可达。这是「占位降级为链接」语义的惰性形态（无特权不做媒体转码
 * 内联），知情接受。
 */
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
