// export.ts — 导出装配纯函数集（spec 2026-10-19 §6/§7，md-export Task 1）。
// collectExportHtml：管线成品 Document → 自包含 HTML 字符串（剥交互壳 → 图片
// data URI 化 → 音视频降级链接 → 静态 TOC → 样式注入 → 序列化）；collectPrintHtml：
// 导出 HTML → 打印模板（@page 尺寸映射 + @media print 分页保护）。
// 本模块无浏览器副作用（fetch/Blob/iframe print 由 apps/web 触发壳承担），输入
// 输出皆为 DOM/字符串，可单测。入参 Document 约定为工作副本（调用方持有的独立
// 文档——markdownRenderer 实例 getExportDocument 返回的克隆），就地装配不额外
// 克隆；每张图片解析失败/返回 null 均降级原 URL，单点故障不阻塞整篇导出。

import { LIGHTBOX_OVERLAY_ID } from '@vviewer/lightbox';

// ---------- 基础排版样式（md-export Task 2 触发壳消费） ----------

/**
 * 导出基础排版 CSS（单源常量，随本文件维护——md-export 台账裁决：常量单源 +
 * app.css 复制 + 双端同步注释）。内容为 app.css 的 :root 变量子集（亮/暗双块，
 * 暗块以 html[data-vv-mode="dark"] 为键——触发壳按当前生效模式在导出文档根元素
 * 打标）+ 代码高亮映射段（.hljs-* 与 .ts-* 类名→var()，app.css 对应段的复制——
 * 映射规则缺席则注入变量无处落地，导出高亮全灭，终审 C1）+ body 基线 +
 * .vv-markdown 排版段。双端同步点：
 * - 变量值/排版/映射规则改动须同步 apps/web/src/app.css 对应段；映射段规则集
 *   一致性由 export.test.ts 双向校验锁定（theme.test.ts 同款防漂移形态）；
 * - 交互壳规则（徽标复制入口 hover/点击态、alert 折叠 foldable/collapsed 等）不进
 *   导出：交互壳在装配时已剥离（徽标 button 已转纯 span）；折叠规则删而不留——
 *   剥离后永不命中，留存反成
 *   「忘剥→collapsed 正文永久 display:none」的隐患（删之 fail-safe 为普通 alert）；
 * - 代码主题变量值（--vv-ts-* 与 --hljs-* 覆盖）不在此处——由触发壳抽取 style
 *   #vv-code-theme 的当前 textContent 注入（本文档只带亮暗默认值兜底；变量值
 *   需映射段先在才有落点，见上）。
 */
export const exportBaseCss = `/* vviewer markdown 导出基础排版（与 apps/web/src/app.css 的 .vv-markdown 段同步维护） */
:root {
  --vv-code-font: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
  --ui-bg: #ffffff; --ui-fg: #1f2328; --ui-fg-muted: #656d76; --ui-border: #d0d7de;
  --ui-accent: #0969da; --ui-side-bg: #f6f8fa;
  /* 语义色（§2.4 alert 七色令牌化同步）：app.css :root 同值镜像——callout 边色落点 */
  --ui-danger: #cf222e; --ui-warning: #9a6700; --ui-success: #1a7f37; --ui-accent-2: #8250df;
  --code-bg: #ffffff; --code-fg: #1f2328;
  --hljs-keyword: #cf222e; --hljs-string: #0a3069; --hljs-comment: #6e7781;
  --hljs-number: #0550ae; --hljs-title: #8250df; --hljs-built_in: #0550ae; --hljs-attr: #0550ae;
}
:root[data-vv-mode="dark"] {
  --ui-bg: #0d1117; --ui-fg: #e6edf3; --ui-fg-muted: #8b949e; --ui-border: #30363d;
  --ui-accent: #2f81f7; --ui-side-bg: #161b22;
  /* app.css 暗块同值镜像（§2.2 暗色补漏：callout 边随暗色令牌） */
  --ui-danger: #f85149; --ui-warning: #d29922; --ui-success: #3fb950; --ui-accent-2: #a371f7;
  --code-bg: #0d1117; --code-fg: #e6edf3;
  --hljs-keyword: #ff7b72; --hljs-string: #a5d6ff; --hljs-comment: #8b949e;
  --hljs-number: #79c0ff; --hljs-title: #d2a8ff; --hljs-built_in: #79c0ff; --hljs-attr: #79c0ff;
}
/* 代码高亮映射段（终审 C1 自 app.css「代码」段复制，双向校验防漂移）：类名→var()
   映射须随导出文档自带，触发壳注入的变量值（style#vv-code-theme 的 --vv-ts- 与
   --hljs-* 两族）才有落点——此前缺失致导出产物代码高亮全灭 */
.hljs-keyword { color: var(--hljs-keyword); } .hljs-string { color: var(--hljs-string); }
.hljs-comment { color: var(--hljs-comment); font-style: italic; } .hljs-number { color: var(--hljs-number); }
.hljs-title { color: var(--hljs-title); } .hljs-built_in { color: var(--hljs-built_in); }
.hljs-attr { color: var(--hljs-attr); } .hljs-params { color: var(--hljs-title); }
/* --hljs-type/--hljs-variable/--hljs-tag 默认未定义（→ unset 继承默认前景），
   仅当代码主题映射命中时生效（theme.ts HLJS_CAPTURE_TO_VAR 输出） */
.hljs-type { color: var(--hljs-type); } .hljs-variable { color: var(--hljs-variable); }
.hljs-tag { color: var(--hljs-tag); }
/* tree-sitter 捕获样式：颜色取自注入的 style#vv-code-theme（--vv-ts-*），变量缺失
   时回落继承；清单与 theme.ts CODE_CAPTURES 一一对齐（theme.test.ts 校验 app.css 侧） */
.ts-attribute { color: var(--vv-ts-attribute, inherit); } .ts-comment { color: var(--vv-ts-comment, inherit); }
.ts-comment-line { color: var(--vv-ts-comment-line, inherit); } .ts-comment-block { color: var(--vv-ts-comment-block, inherit); }
.ts-constant { color: var(--vv-ts-constant, inherit); } .ts-constant-builtin { color: var(--vv-ts-constant-builtin, inherit); }
.ts-constant-character { color: var(--vv-ts-constant-character, inherit); } .ts-constant-character-escape { color: var(--vv-ts-constant-character-escape, inherit); }
.ts-constant-numeric { color: var(--vv-ts-constant-numeric, inherit); } .ts-constructor { color: var(--vv-ts-constructor, inherit); }
.ts-function { color: var(--vv-ts-function, inherit); } .ts-function-builtin { color: var(--vv-ts-function-builtin, inherit); }
.ts-function-call { color: var(--vv-ts-function-call, inherit); } .ts-function-macro { color: var(--vv-ts-function-macro, inherit); }
.ts-function-method { color: var(--vv-ts-function-method, inherit); } .ts-keyword { color: var(--vv-ts-keyword, inherit); }
.ts-keyword-control { color: var(--vv-ts-keyword-control, inherit); } .ts-keyword-control-conditional { color: var(--vv-ts-keyword-control-conditional, inherit); }
.ts-keyword-control-import { color: var(--vv-ts-keyword-control-import, inherit); } .ts-keyword-control-repeat { color: var(--vv-ts-keyword-control-repeat, inherit); }
.ts-keyword-directive { color: var(--vv-ts-keyword-directive, inherit); } .ts-keyword-function { color: var(--vv-ts-keyword-function, inherit); }
.ts-keyword-operator { color: var(--vv-ts-keyword-operator, inherit); } .ts-label { color: var(--vv-ts-label, inherit); }
.ts-markup-bold { color: var(--vv-ts-markup-bold, inherit); } .ts-markup-heading { color: var(--vv-ts-markup-heading, inherit); }
.ts-markup-italic { color: var(--vv-ts-markup-italic, inherit); } .ts-markup-link { color: var(--vv-ts-markup-link, inherit); }
.ts-markup-list { color: var(--vv-ts-markup-list, inherit); } .ts-markup-raw { color: var(--vv-ts-markup-raw, inherit); }
.ts-module { color: var(--vv-ts-module, inherit); } .ts-namespace { color: var(--vv-ts-namespace, inherit); }
.ts-number { color: var(--vv-ts-number, inherit); } .ts-operator { color: var(--vv-ts-operator, inherit); }
.ts-property { color: var(--vv-ts-property, inherit); } .ts-punctuation { color: var(--vv-ts-punctuation, inherit); }
.ts-punctuation-bracket { color: var(--vv-ts-punctuation-bracket, inherit); } .ts-punctuation-delimiter { color: var(--vv-ts-punctuation-delimiter, inherit); }
.ts-punctuation-special { color: var(--vv-ts-punctuation-special, inherit); } .ts-special { color: var(--vv-ts-special, inherit); }
.ts-string { color: var(--vv-ts-string, inherit); } .ts-string-escape { color: var(--vv-ts-string-escape, inherit); }
.ts-string-special { color: var(--vv-ts-string-special, inherit); } .ts-tag { color: var(--vv-ts-tag, inherit); }
.ts-type { color: var(--vv-ts-type, inherit); } .ts-type-builtin { color: var(--vv-ts-type-builtin, inherit); }
.ts-type-enum-variant { color: var(--vv-ts-type-enum-variant, inherit); } .ts-variable { color: var(--vv-ts-variable, inherit); }
.ts-variable-builtin { color: var(--vv-ts-variable-builtin, inherit); } .ts-variable-parameter { color: var(--vv-ts-variable-parameter, inherit); }
.ts-diff-delta { color: var(--vv-ts-diff-delta, inherit); } .ts-diff-minus { color: var(--vv-ts-diff-minus, inherit); }
.ts-diff-plus { color: var(--vv-ts-diff-plus, inherit); }
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
/* 字号挂 chrome 字阶 token（§3.2/§10-G1 同步）；等值回退保导出文档未定义变量时
   视觉零漂移（app.css 同款回退形式，双端一致） */
.vv-markdown .md-code-lang { font-size: var(--vv-fs-xs, 12px); color: var(--ui-fg-muted); text-transform: uppercase; letter-spacing: .04em; }
.vv-markdown .md-diagram { margin: .8rem 0; border: 1px solid var(--ui-border); border-radius: 6px; overflow: hidden; }
.vv-markdown .md-diagram-bar { display: flex; align-items: center; gap: .5rem; padding: .25rem .6rem; border-bottom: 1px solid var(--ui-border); background: var(--ui-side-bg); }
.vv-markdown .md-diagram-lang { font-size: var(--vv-fs-xs, 12px); color: var(--ui-fg-muted); text-transform: uppercase; letter-spacing: .04em; }
.vv-markdown .md-diagram-view { display: flex; justify-content: center; padding: .6rem; overflow-x: auto; }
.vv-markdown .md-diagram-view svg { max-width: 100%; height: auto; }
.vv-markdown .md-diagram-view img { max-width: 100%; }
.vv-markdown .md-diagram-view.md-diagram-error { display: block; white-space: pre-wrap; color: var(--ui-fg-muted); font-family: var(--vv-code-font); font-size: var(--vv-code-font-size, 13px); }
.vv-markdown .md-diagram-view[hidden] { display: none; }
.vv-markdown .md-diagram-source { padding: .6rem; overflow-x: auto; }
.vv-markdown .md-diagram-source code { font-family: var(--vv-code-font); font-size: var(--vv-code-font-size, 13px); }
.vv-markdown .md-wikilink-dead { border-bottom: 1px dashed var(--ui-border); cursor: default; }
.markdown-alert { border: 1px solid var(--ui-border); border-left-width: 4px; border-radius: 6px;
  padding: .5rem 1rem; margin: .8rem 0; }
.markdown-alert-title { display: flex; align-items: center; gap: .4rem; font-weight: 600; margin: .2rem 0; }
/* callout 七色→令牌（§2.4）：与 app.css 同段逐字镜像（双端同步段） */
.markdown-alert-note, .markdown-alert-info, .markdown-alert-faq, .markdown-alert-question { border-left-color: var(--ui-accent); }
.markdown-alert-tip { border-left-color: var(--ui-success); }
.markdown-alert-important, .markdown-alert-example { border-left-color: var(--ui-accent-2); }
.markdown-alert-warning { border-left-color: var(--ui-warning); }
.markdown-alert-caution { border-left-color: var(--ui-danger); }
.markdown-alert-todo { border-left-color: var(--ui-fg-muted); }
/* 折叠规则（app.css 的 foldable/collapsed 段）不进导出（终审 M2）：剥离后永不命中，
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

/**
 * 交互壳剥离清单（管线产物类名，见 pipeline.ts CLS / lightbox.ts）：图表切换钮、
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
