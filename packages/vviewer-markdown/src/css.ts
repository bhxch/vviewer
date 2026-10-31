// css.ts — markdown 渲染样式单源（CSS 字符串常量，tsc publish 形态可用的单源方案）。
// 收编 apps/web/src/app.css 的 markdown 专属段（.hljs-*/.ts-* 高亮映射、.vv-markdown
// 排版、.md-code-bar/.md-code-lang、.md-diagram 系列、.md-lightbox-*、.markdown-alert、
// .md-wikilink-dead/a.anchor、img[data-vv-blocked-external]），并与 src/markdown.css
// 镜像文件由 test/cssMirror.test.ts 锁等价（镜像供 <link>/CSS import 消费面）。
//
// 令牌形态契约：全部设计令牌写成 var(--token, 默认值)——本模块不定义 :root 令牌块、
// 不与应用主题打架。默认值取 app.css :root 亮色现值（--ui-*/--code-*/--hljs-*）与
// highlight 包 themes.json onelight 主题（应用默认代码主题，theme.ts DEFAULT_CODE_THEME
// light 项）的 53 capture 解析值；应用运行时注入的 style#vv-code-theme（--vv-ts-*）
// 与各主题令牌块仍照常覆盖（动态注入在 head 后部/特异性更高）。
// 例外（保持应用侧语义不变）：--hljs-type/--hljs-variable/--hljs-tag 默认未定义
// （仅当代码主题映射命中时生效，app.css 同注），--vv-ts-variable/--vv-ts-number
// 在 onelight 无 fg 值 → 回落 inherit。
//
// 分节导出供 export.ts 组装导出基础 CSS（交互壳规则——按钮 reset/hover、折叠、
// 灯箱、锚点焦点揭示等——不进导出，与 render-text export.ts 既有口径一致）。
// 交互壳专属段以 RUNTIME_ 前缀命名，共享段无前缀。

// ---------- 高亮映射段（.hljs-* 与 .ts-* 类名→颜色变量） ----------

/**
 * 代码高亮映射段：颜色经 CSS 变量间接（宿主主题供值，缺省给亮色默认值）。
 * .ts-* 清单与 @bhxch/vviewer-highlight 的 CODE_CAPTURES 一一对齐（53 条；测试锁定），
 * 默认色取 onelight 主题解析值（test/cssMirror.test.ts 断言形态与清单对齐）。
 */
export const HIGHLIGHT_CSS = `/* 代码高亮映射段（.hljs-* 与 .ts-* 类名→颜色变量）：颜色经 CSS 变量间接（宿主主题供值，缺省亮色默认值） */
.hljs-keyword { color: var(--hljs-keyword, #cf222e); } .hljs-string { color: var(--hljs-string, #0a3069); }
.hljs-comment { color: var(--hljs-comment, #6e7781); font-style: italic; } .hljs-number { color: var(--hljs-number, #0550ae); }
.hljs-title { color: var(--hljs-title, #8250df); } .hljs-built_in { color: var(--hljs-built_in, #0550ae); }
.hljs-attr { color: var(--hljs-attr, #0550ae); } .hljs-params { color: var(--hljs-title, #8250df); }
/* --hljs-type/--hljs-variable/--hljs-tag 默认未定义（→ unset 继承默认前景），
   仅当代码主题映射命中时生效（宿主 theme 映射输出） */
.hljs-type { color: var(--hljs-type); } .hljs-variable { color: var(--hljs-variable); }
.hljs-tag { color: var(--hljs-tag); }
/* tree-sitter 捕获样式：默认色取 onelight 主题（应用默认代码主题）解析值；宿主注入的
   style#vv-code-theme（--vv-ts-*）覆盖。清单与 @bhxch/vviewer-highlight CODE_CAPTURES 对齐 */
.ts-attribute { color: var(--vv-ts-attribute, #ff6f00); } .ts-comment { color: var(--vv-ts-comment, #5c6370); }
.ts-comment-line { color: var(--vv-ts-comment-line, #5c6370); } .ts-comment-block { color: var(--vv-ts-comment-block, #5c6370); }
.ts-constant { color: var(--vv-ts-constant, #0086c1); } .ts-constant-builtin { color: var(--vv-ts-constant-builtin, #651fff); }
.ts-constant-character { color: var(--vv-ts-constant-character, #24a443); } .ts-constant-character-escape { color: var(--vv-ts-constant-character-escape, #795548); }
.ts-constant-numeric { color: var(--vv-ts-constant-numeric, #795548); } .ts-constructor { color: var(--vv-ts-constructor, #0061ff); }
.ts-function { color: var(--vv-ts-function, #0061ff); } .ts-function-builtin { color: var(--vv-ts-function-builtin, #0086c1); }
.ts-function-call { color: var(--vv-ts-function-call, #0061ff); } .ts-function-macro { color: var(--vv-ts-function-macro, #c2185b); }
.ts-function-method { color: var(--vv-ts-function-method, #0091ea); } .ts-keyword { color: var(--vv-ts-keyword, #b500a9); }
.ts-keyword-control { color: var(--vv-ts-keyword-control, #b500a9); } .ts-keyword-control-conditional { color: var(--vv-ts-keyword-control-conditional, #d50000); }
.ts-keyword-control-import { color: var(--vv-ts-keyword-control-import, #d50000); } .ts-keyword-control-repeat { color: var(--vv-ts-keyword-control-repeat, #c2185b); }
.ts-keyword-directive { color: var(--vv-ts-keyword-directive, #651fff); } .ts-keyword-function { color: var(--vv-ts-keyword-function, #b500a9); }
.ts-keyword-operator { color: var(--vv-ts-keyword-operator, #d50000); } .ts-label { color: var(--vv-ts-label, #0086c1); }
.ts-markup-bold { color: var(--vv-ts-markup-bold, #ff6f00); } .ts-markup-heading { color: var(--vv-ts-markup-heading, #d50000); }
.ts-markup-italic { color: var(--vv-ts-markup-italic, #b500a9); } .ts-markup-link { color: var(--vv-ts-markup-link, #0091ea); }
.ts-markup-list { color: var(--vv-ts-markup-list, #0091ea); } .ts-markup-raw { color: var(--vv-ts-markup-raw, #795548); }
.ts-module { color: var(--vv-ts-module, #0061ff); } .ts-namespace { color: var(--vv-ts-namespace, #0061ff); }
.ts-number { color: var(--vv-ts-number, inherit); } .ts-operator { color: var(--vv-ts-operator, #d50000); }
.ts-property { color: var(--vv-ts-property, #b500a9); } .ts-punctuation { color: var(--vv-ts-punctuation, #282c34); }
.ts-punctuation-bracket { color: var(--vv-ts-punctuation-bracket, #795548); } .ts-punctuation-delimiter { color: var(--vv-ts-punctuation-delimiter, #b500a9); }
.ts-punctuation-special { color: var(--vv-ts-punctuation-special, #795548); } .ts-special { color: var(--vv-ts-special, #651fff); }
.ts-string { color: var(--vv-ts-string, #24a443); } .ts-string-escape { color: var(--vv-ts-string-escape, #24a443); }
.ts-string-special { color: var(--vv-ts-string-special, #24a443); } .ts-tag { color: var(--vv-ts-tag, #0086c1); }
.ts-type { color: var(--vv-ts-type, #d35400); } .ts-type-builtin { color: var(--vv-ts-type-builtin, #ff6f00); }
.ts-type-enum-variant { color: var(--vv-ts-type-enum-variant, #0086c1); } .ts-variable { color: var(--vv-ts-variable, inherit); }
.ts-variable-builtin { color: var(--vv-ts-variable-builtin, #0091ea); } .ts-variable-parameter { color: var(--vv-ts-variable-parameter, #d50000); }
.ts-diff-delta { color: var(--vv-ts-diff-delta, #0086c1); } .ts-diff-minus { color: var(--vv-ts-diff-minus, #d50000); }
.ts-diff-plus { color: var(--vv-ts-diff-plus, #24a443); }`;

// ---------- 排版段（.vv-markdown 基础排版） ----------

/** .vv-markdown 基础排版（标题/代码块/引用/表格/媒体），亮色令牌缺省值兜底。 */
export const TYPOGRAPHY_CSS = `.vv-markdown { max-width: 60rem; padding: 1rem 1.5rem; line-height: 1.6; overflow-wrap: break-word; }
.vv-markdown h1, .vv-markdown h2, .vv-markdown h3, .vv-markdown h4 { line-height: 1.3; margin: 1.5em 0 .5em; scroll-margin-top: .5rem; }
.vv-markdown h1 { font-size: 1.6em; border-bottom: 1px solid var(--ui-border, #d0d7de); padding-bottom: .3em; }
.vv-markdown h2 { font-size: 1.35em; border-bottom: 1px solid var(--ui-border, #d0d7de); padding-bottom: .2em; }
.vv-markdown h3 { font-size: 1.15em; }
.vv-markdown pre { background: var(--code-bg, #ffffff); border: 1px solid var(--ui-border, #d0d7de);
  border-radius: 6px; padding: .75rem 1rem; overflow: auto; }
.vv-markdown code { font-family: var(--vv-code-font, ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace); font-size: .9em; background: var(--ui-side-bg, #f6f8fa);
  border-radius: 4px; padding: .1em .35em; }
.vv-markdown pre code { background: none; padding: 0; }
.vv-markdown blockquote { margin: .8rem 0; padding: .1rem 1rem; color: var(--ui-fg-muted, #656d76);
  border-left: 4px solid var(--ui-border, #d0d7de); }
.vv-markdown table { border-collapse: collapse; margin: .8rem 0; }
.vv-markdown th, .vv-markdown td { border: 1px solid var(--ui-border, #d0d7de); padding: .3rem .65rem; }
.vv-markdown img, .vv-markdown video, .vv-markdown audio { max-width: 100%; }`;

// ---------- 代码块顶栏（.md-code-bar/.md-code-lang） ----------

/**
 * 代码块顶栏共享段：pre 首子行单语言徽标（有语言=语言词、无语言=「复制」），负
 * 外边距抵 pre 内边距贴边成栏。md-code-lang 为共享基础段（字号/色/大写化）——
 * button 交互 reset 在 RUNTIME_CODE_LANG_BUTTON_CSS（导出侧徽标已转纯 span 不含）。
 */
export const CODE_BAR_CSS = `/* 代码块顶栏（徽标即复制单入口）：pre 首子行单语言徽标，负外边距贴边成栏（视觉同 md-diagram-bar）。
   pre overflow:auto 下长行横滚时顶栏随行滚出视野——与退役的 absolute 复制钮行为一致 */
.vv-markdown .md-code-bar { display: flex; align-items: center; gap: .5rem;
  margin: -.75rem -1rem .5rem; padding: .25rem .6rem; border-bottom: 1px solid var(--ui-border, #d0d7de);
  background: var(--ui-side-bg, #f6f8fa); }
/* 字号挂 chrome 字阶 token；等值回退保未定义变量时视觉零漂移 */
.vv-markdown .md-code-lang { font-size: var(--vv-fs-xs, 12px); color: var(--ui-fg-muted, #656d76); text-transform: uppercase; letter-spacing: .04em; }`;

/** 运行时专有：button 形态 reset（导出侧徽标已转纯 span，此段不进导出）。font 简写
 * 在前、font-size 在后（简写会重置字号，须重申）；选择器限定 button.md-code-lang
 * 使纯 span 形态（导出）不吃 cursor/user-select。 */
export const RUNTIME_CODE_LANG_BUTTON_CSS = `.vv-markdown button.md-code-lang { font: inherit; font-size: var(--vv-fs-xs, 12px);
  background: none; border: none; padding: 0; cursor: pointer; user-select: none; }`;

// ---------- 图表 wrapper（.md-diagram 系列） ----------

/** 图表 wrapper 共享段：bar 内语言徽标+切换钮，视图居中，源码面板等宽。 */
export const DIAGRAM_CSS = `/* 图表 wrapper：bar 内语言徽标+切换钮，视图居中，源码面板等宽 */
.vv-markdown .md-diagram { margin: .8rem 0; border: 1px solid var(--ui-border, #d0d7de); border-radius: 6px; overflow: hidden; }
.vv-markdown .md-diagram-bar { display: flex; align-items: center; gap: .5rem; padding: .25rem .6rem; border-bottom: 1px solid var(--ui-border, #d0d7de); background: var(--ui-side-bg, #f6f8fa); }
.vv-markdown .md-diagram-lang { font-size: var(--vv-fs-xs, 12px); color: var(--ui-fg-muted, #656d76); text-transform: uppercase; letter-spacing: .04em; }
.vv-markdown .md-diagram-toggle { margin-left: auto; font-size: var(--vv-fs-xs, 12px); padding: 1px 8px; border: 1px solid var(--ui-border, #d0d7de); border-radius: 4px; background: transparent; color: var(--ui-fg, #1f2328); cursor: pointer; }
.vv-markdown .md-diagram-view { display: flex; justify-content: center; padding: .6rem; overflow-x: auto; }
.vv-markdown .md-diagram-view svg { max-width: 100%; height: auto; }
.vv-markdown .md-diagram-view img { max-width: 100%; }
.vv-markdown .md-diagram-view.md-diagram-error { display: block; white-space: pre-wrap; color: var(--ui-fg-muted, #656d76); font-family: var(--vv-code-font, ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace); font-size: var(--vv-code-font-size, 13px); }
/* hidden 属性兜底：上方 display:flex/block 作者规则特异性压过 UA [hidden]，切换/源码
   模式/kroki 失败态设了 hidden 视图仍可见——末位同特异性显式 display:none */
.vv-markdown .md-diagram-view[hidden] { display: none; }
.vv-markdown .md-diagram-source { padding: .6rem; overflow-x: auto; }
.vv-markdown .md-diagram-source code { font-family: var(--vv-code-font, ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace); font-size: var(--vv-code-font-size, 13px); }`;

/** 运行时专有：切换钮 hover 态（导出无交互不进）。 */
export const RUNTIME_DIAGRAM_TOGGLE_HOVER_CSS = `.vv-markdown .md-diagram-toggle:hover { background: var(--ui-border, #d0d7de); }`;

// ---------- 灯箱（.md-lightbox-*，运行时专有） ----------

/** 灯箱 overlay（body 级单例）与画廊/控制条：纯交互壳，整段不进导出。 */
export const RUNTIME_LIGHTBOX_CSS = `.md-lightbox-overlay { position: fixed; inset: 0; z-index: 100; background: rgb(0 0 0 / 70%);
  display: flex; align-items: center; justify-content: center; cursor: zoom-out; }
.md-lightbox { max-width: 92vw; max-height: 92vh; }
/* 灯箱画廊：stage 铺满 overlay 作为缩放平移变换面（origin 0 0 与 zoomAt 的
   「屏幕点 = 内容点×zoom + t」锚定数学同构），内容居中；bar 悬浮底部集中导航/
   计数/缩放/关闭，触控目标 ≥32px。关闭语义：点背景（overlay/stage 空白）或关闭钮，
   点内容与控制件不关 */
.md-lightbox-stage { position: absolute; inset: 0; display: flex; align-items: center;
  justify-content: center; transform-origin: 0 0; cursor: grab; }
.md-lightbox-stage.md-lightbox-dragging { cursor: grabbing; }
.md-lightbox-svg { display: flex; max-width: 92vw; max-height: 92vh; }
.md-lightbox-svg svg { max-width: 100%; max-height: 92vh; }
/* 作者 display 规则压过 UA [hidden] 的 display:none——显式兜底（md-diagram-view 同教训） */
.md-lightbox-stage img[hidden], .md-lightbox-svg[hidden], .md-lightbox-bar [hidden] { display: none; }
.md-lightbox-bar { position: absolute; bottom: 1rem; left: 50%; transform: translateX(-50%);
  display: flex; align-items: center; gap: 2px; padding: 4px; border-radius: 8px; background: rgb(0 0 0 / 50%); }
.md-lightbox-btn { display: inline-flex; align-items: center; justify-content: center;
  min-width: 32px; min-height: 32px; padding: 0; border: none; border-radius: 6px;
  background: transparent; color: #fff; font-size: 16px; line-height: 1; cursor: pointer; }
.md-lightbox-btn:hover { background: rgb(255 255 255 / 20%); }
.md-lightbox-count { min-width: 32px; display: inline-flex; align-items: center; justify-content: center;
  color: #fff; font-size: var(--vv-fs-sm, 13px); font-variant-numeric: tabular-nums; }`;

// ---------- callout 卡片（.markdown-alert 系列） ----------

/** callout 基础段：卡片框线/标题 + 七色语义→令牌（亮值=GitHub light 语义色默认）。 */
export const ALERT_CSS = `.markdown-alert { border: 1px solid var(--ui-border, #d0d7de); border-left-width: 4px; border-radius: 6px;
  padding: .5rem 1rem; margin: .8rem 0; }
.markdown-alert-title { display: flex; align-items: center; gap: .4rem; font-weight: 600; margin: .2rem 0; }
/* callout 七色语义→令牌：note/info/faq/question→accent、tip→success、
   important/example→accent-2、warning→warning、caution→danger、todo→fg-muted */
.markdown-alert-note, .markdown-alert-info, .markdown-alert-faq, .markdown-alert-question { border-left-color: var(--ui-accent, #0969da); }
.markdown-alert-tip { border-left-color: var(--ui-success, #1a7f37); }
.markdown-alert-important, .markdown-alert-example { border-left-color: var(--ui-accent-2, #8250df); }
.markdown-alert-warning { border-left-color: var(--ui-warning, #9a6700); }
.markdown-alert-caution { border-left-color: var(--ui-danger, #cf222e); }
.markdown-alert-todo { border-left-color: var(--ui-fg-muted, #656d76); }`;

/** 运行时专有：callout 折叠（+/− 后缀卡片）——标题即折叠钮；collapsed 只隐藏标题外
 * 内容。导出不带（导出壳剥离折叠类后永不命中，留存反成「忘剥→正文永久隐藏」隐患）。 */
export const RUNTIME_ALERT_FOLD_CSS = `.markdown-alert-foldable > .markdown-alert-title { cursor: pointer; user-select: none; }
.markdown-alert-foldable > .markdown-alert-title::after { content: '▾'; margin-left: auto;
  font-size: .8em; color: var(--ui-fg-muted, #656d76); }
.markdown-alert-collapsed > .markdown-alert-title::after { content: '▸'; }
.markdown-alert-collapsed > :not(.markdown-alert-title) { display: none; }`;

// ---------- wikilink / 锚点 / 外域占位 / 搜索命中 ----------

/** 跨文件 wikilink 降级（不可点原文，虚线下划线悬停提示）。 */
export const WIKILINK_CSS = `.vv-markdown .md-wikilink-dead { border-bottom: 1px dashed var(--ui-border, #d0d7de); cursor: default; }`;

/** 标题锚点（引擎自产 a.anchor，空内容 0 宽）：交互段（焦点揭示）运行时专有。 */
export const RUNTIME_ANCHOR_CSS = `.vv-markdown a.anchor { color: var(--ui-accent, #0969da); text-decoration: none; }
/* 0 宽盒上焦点环左右边缘重合无从辨识——键盘聚焦时揭示链接字符。平时零内容零视觉 */
.vv-markdown a.anchor:focus-visible::before { content: '#'; }`;

/** 被拦截的外域图片占位（sanitize 层 data-vv-blocked-external 标记）。 */
export const BLOCKED_EXTERNAL_CSS = `.vv-markdown img[data-vv-blocked-external] { display: inline-block; min-width: 96px; min-height: 40px;
  border: 1px dashed #b58900; border-radius: 4px; background: rgb(181 137 0 / 8%); }`;

/** 文件内搜索命中 mark（独立使用 search() 的完整效果所需；app 侧该段仍单源自持）。 */
export const SEARCH_HIT_CSS = `mark.vv-search-hit { background: var(--vv-hit-bg, rgb(255 213 0 / 45%)); color: inherit; }
mark.vv-search-hit-active { background: var(--vv-hit-active, rgb(255 160 0 / 80%)); }`;

/** 运行时全量样式（markdown.css 镜像文件的源；导入 '@bhxch/vviewer-markdown/markdown.css'
 * 与 import { MARKDOWN_CSS } 等效，两者由测试锁逐字节等价）。 */
export const MARKDOWN_CSS = [
  HIGHLIGHT_CSS,
  TYPOGRAPHY_CSS,
  CODE_BAR_CSS,
  RUNTIME_CODE_LANG_BUTTON_CSS,
  DIAGRAM_CSS,
  RUNTIME_DIAGRAM_TOGGLE_HOVER_CSS,
  RUNTIME_LIGHTBOX_CSS,
  ALERT_CSS,
  RUNTIME_ALERT_FOLD_CSS,
  WIKILINK_CSS,
  RUNTIME_ANCHOR_CSS,
  BLOCKED_EXTERNAL_CSS,
  SEARCH_HIT_CSS
].join('\n');
