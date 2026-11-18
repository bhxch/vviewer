/**
 * shellCss.ts — 扩展 webview 壳样式常量（spec H T1）。
 *
 * 供给面说明（Global Constraints「样式供给面」条）：
 * - `createMarkdownView` 自身**不注入任何样式**（packages/vviewer-markdown/src/markdownRenderer.ts:958-961
 *   明写「CSS 由消费方引入」），故扩展必须自带两处样式供给：markdown 排版样式
 *   （`MARKDOWN_CSS` 常量，@bhxch/vviewer-markdown 导出）+ 本文件的壳样式常量。
 *   两者在 T2 由 host 侧合成为**单一** `<style nonce>` 内联进 webview HTML。
 * - 本模块**不含**动态令牌（`--vv-ts-*` 等随主题变的部分）——那部分走 webview 侧
 *   `<style>` 元素整体替换面（T3/T6），不混进宿主内联块。
 *
 * 令牌纪律（与 packages/vviewer-markdown/src/css.ts 同族）：
 * - 所有设计令牌一律写成 `var(--token, 默认值)`——缺省值沿 markdown.css 内既默认值
 *   （`--ui-*` 亮色现值）与设计系统既有档位（`--vv-sp-*`/`--vv-fs-*`/`--vv-radius-*`）。
 * - **不定义 `:root` 令牌块、不声明任何自定义属性**（零新 token）——宿主注入
 *   `--ui-*`/`--code-*`/`--vv-ts-*` 覆盖，本块只提供缺省。
 * - 无 transition/animation：动效义务（reduced-motion 双块门控）在 apps/web 的
 *   app.css 内，本扩展壳零动效，无门控义务。
 *
 * CSS 载荷内的注释一律 ASCII：扩展 ESLint 覆盖块（apps/vscode/src/**）禁模板串静态段的
 * CJK（cjkTemplateElement——模板串静态段被当作潜在显示文案）→ 中文说明留在本文件的
 * TS 注释面（不受该规则约束），CSS 内只留 ASCII 段落标记。
 *
 * 类名契约（T3 的 webview 壳按此建 DOM；勿改名——改名即视觉漂移）：
 * - `.vv-shell` 壳根（flex 行）
 * - `.vv-shell__body` 主体行容器（内容区 + toc 面板的横向行）
 * - `.vv-shell__main` 内容区（滚动面）
 * - `.vv-shell__toc` toc 面板（停靠侧由 `--left`/`--right` 类切换，折叠态由
 *   `data-collapsed="true"` 表达）
 * - `.vv-shell__toc-head` / `__title` / `__badge` / `__toggle` 面板头部
 * - `.vv-shell__toc-list` / `__item`（`__item--depth-1..4` 缩进档）面板条目
 * - `.vv-shell__notice` 顶部提示条（宿主挂 `role="status"`；`--warn`/`--error` 变体）
 */
export const SHELL_CSS = `/* Extension shell styles (spec H): layout skeleton + toc panel + notice bar. */
html, body { height: 100%; }
body {
  margin: 0;
  font-family: var(--vv-ui-font, system-ui, -apple-system, "Segoe UI", sans-serif);
  font-size: var(--vv-ui-font-size, 16px);
  line-height: 1.4;
  color: var(--ui-fg, #1f2328);
  background: var(--ui-bg, #ffffff);
}

/* Shell layout: notice bar on top, content area and toc panel in one row below. */
.vv-shell { display: flex; flex-direction: column; height: 100vh; overflow: hidden; }
.vv-shell__body { display: flex; flex-direction: row; align-items: stretch; flex: 1 1 auto; min-height: 0; }
.vv-shell__main { flex: 1 1 auto; min-width: 0; overflow: auto; padding: var(--vv-sp-12, 12px) var(--vv-sp-16, 16px); }
.vv-shell__toc {
  flex: 0 0 auto;
  width: 260px;
  min-width: 0;
  overflow: auto;
  padding: var(--vv-sp-8, 8px);
  background: var(--ui-side-bg, #f6f8fa);
  border-left: 1px solid var(--ui-border, #d0d7de);
}
.vv-shell__toc--left { order: -1; border-left: none; border-right: 1px solid var(--ui-border, #d0d7de); }
/* Collapsed: keep the header (the toggle lives there) visible and shrink to the button
   width -- hiding the whole panel would hide the toggle with it, leaving no way to
   expand it again. */
.vv-shell__toc[data-collapsed="true"] { width: auto; padding: 0; }
.vv-shell__toc[data-collapsed="true"] .vv-shell__toc-head { margin-bottom: 0; }
.vv-shell__toc[data-collapsed="true"] .vv-shell__toc-title,
.vv-shell__toc[data-collapsed="true"] .vv-shell__toc-badge,
.vv-shell__toc[data-collapsed="true"] .vv-shell__toc-list { display: none; }

/* Panel head: title + engine badge + collapse toggle. */
.vv-shell__toc-head { display: flex; align-items: center; gap: var(--vv-sp-4, 4px); margin-bottom: var(--vv-sp-8, 8px); }
.vv-shell__toc-title { font-size: var(--vv-fs-md, 14px); font-weight: 600; color: var(--ui-fg, #1f2328); }
.vv-shell__toc-badge {
  font-size: var(--vv-fs-2xs, 11px);
  color: var(--ui-fg-muted, #656d76);
  background: var(--ui-hover-bg, #f6f8fa);
  border: 1px solid var(--ui-border, #d0d7de);
  border-radius: var(--vv-radius-full, 999px);
  padding: 0 var(--vv-sp-4, 4px);
}
.vv-shell__toc-toggle {
  margin-left: auto;
  font: inherit;
  font-size: var(--vv-fs-sm, 13px);
  color: var(--ui-fg, #1f2328);
  background: transparent;
  border: 1px solid var(--ui-border, #d0d7de);
  border-radius: var(--vv-radius-md, 6px);
  padding: var(--vv-sp-2, 2px) var(--vv-sp-8, 8px);
  cursor: pointer;
}
.vv-shell__toc-toggle:hover { background: var(--ui-hover-bg, #f6f8fa); }

/* Panel items: outline entries (heading / symbol share this row). */
.vv-shell__toc-list { list-style: none; margin: 0; padding: 0; }
.vv-shell__toc-item {
  display: block;
  width: 100%;
  text-align: left;
  font: inherit;
  font-size: var(--vv-fs-sm, 13px);
  color: var(--ui-fg, #1f2328);
  background: transparent;
  border: none;
  border-radius: var(--vv-radius-sm, 4px);
  padding: var(--vv-sp-2, 2px) var(--vv-sp-4, 4px);
  cursor: pointer;
}
.vv-shell__toc-item:hover { background: var(--ui-hover-bg, #f6f8fa); color: var(--ui-accent, #0969da); }
.vv-shell__toc-item--depth-1 { padding-left: var(--vv-sp-4, 4px); }
.vv-shell__toc-item--depth-2 { padding-left: var(--vv-sp-8, 8px); }
.vv-shell__toc-item--depth-3 { padding-left: var(--vv-sp-12, 12px); }
.vv-shell__toc-item--depth-4 { padding-left: var(--vv-sp-16, 16px); }

/* Top notice bar (host mounts role="status"; degraded / too-large / export feedback). */
.vv-shell__notice {
  display: flex;
  align-items: center;
  gap: var(--vv-sp-6, 6px);
  margin-bottom: var(--vv-sp-8, 8px);
  padding: var(--vv-sp-6, 6px) var(--vv-sp-10, 10px);
  font-size: var(--vv-fs-sm, 13px);
  color: var(--ui-fg, #1f2328);
  background: var(--ui-hover-bg, #f6f8fa);
  border: 1px solid var(--ui-border, #d0d7de);
  border-radius: var(--vv-radius-md, 6px);
}
.vv-shell__notice[hidden] { display: none; }
.vv-shell__notice--warn { color: var(--ui-warning, #9a6700); border-color: var(--ui-warning, #9a6700); }
.vv-shell__notice--error { color: var(--ui-danger, #cf222e); border-color: var(--ui-danger, #cf222e); }

/* Focus ring (same shape as apps/web base layer: 2px accent + negative offset). */
:where(button, [tabindex], a[href]):focus-visible { outline: 2px solid var(--ui-accent, #0969da); outline-offset: -1px; }`;
