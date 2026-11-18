// theme.ts — 动态令牌注入面（spec H T3）。
//
// 两类令牌：
// - UI 令牌（`--ui-*`）：按活动主题 kind 选亮/暗缺省值（沿 apps/web/src/app.css 的亮暗
//   两块取值）——**零新 token**（只用既有 `--ui-*` 家族）。
// - 捕获色（`--vv-ts-*`）：tree-sitter 捕获名 → 颜色，由打包的两条主题表
//   （onelight / serika-dark，裁量 4）经 `themeToCssVars` 算出。
//
// 注入方式：webview 侧 `<style id="vv-tokens">` 元素**整体替换**（不进宿主的静态内联
// 块——主题变更时需整体替换；宿主的内联块只承载 markdown 排版 + 壳样式）。
//
// 令牌口径（docs/design/ui-design-system.md §2.1）：新增值一律落既有 `--ui-*` 家族，
// 不开新前缀；本模块只提供缺省值，宿主/webview 注入的同名值优先。
// 子路径导入（`@bhxch/vviewer-highlight/theme`）：theme.ts 零 import——走包根会把
// web-tree-sitter 拖进 host bundle（其 node 分支的动态 import 在 node 平台 bundle
// 里是 external 记录 → 触「产物无未解析 import」门）。
import { CODE_CAPTURES, themeToCssVars, type ThemeTable } from '@bhxch/vviewer-highlight/theme';

/** 动态令牌样式元素 id（整体替换面） */
export const TOKEN_STYLE_ID = 'vv-tokens';

/** 打包主题按亮暗的取用（裁量 4：MVP 取 onelight / serika-dark 两条） */
export const PACKAGED_THEME_BY_KIND = {
  light: 'onelight',
  dark: 'serika-dark'
} as const;

/** 亮色 UI 令牌缺省值（沿 apps/web/src/app.css 亮色块） */
const LIGHT_UI_VARS: Record<string, string> = {
  '--ui-bg': '#ffffff',
  '--ui-fg': '#1f2328',
  '--ui-fg-muted': '#656d76',
  '--ui-border': '#d0d7de',
  '--ui-accent': '#0969da',
  '--ui-side-bg': '#f6f8fa',
  '--ui-tab-bg': '#f6f8fa',
  '--ui-tab-active-bg': '#ffffff',
  '--ui-input-bg': '#ffffff',
  '--ui-hover-bg': '#f6f8fa',
  '--ui-selection-bg': '#add6ff',
  '--ui-statusbar-bg': '#f6f8fa',
  '--ui-danger': '#cf222e',
  '--ui-warning': '#9a6700',
  '--ui-success': '#1a7f37',
  '--ui-accent-2': '#8250df'
};

/** 暗色 UI 令牌缺省值（沿 apps/web/src/app.css 暗色块） */
const DARK_UI_VARS: Record<string, string> = {
  '--ui-bg': '#0d1117',
  '--ui-fg': '#e6edf3',
  '--ui-fg-muted': '#8b949e',
  '--ui-border': '#30363d',
  '--ui-accent': '#2f81f7',
  '--ui-side-bg': '#161b22',
  '--ui-tab-bg': '#161b22',
  '--ui-tab-active-bg': '#0d1117',
  '--ui-input-bg': '#0d1117',
  '--ui-hover-bg': '#161b22',
  '--ui-selection-bg': '#264f78',
  '--ui-statusbar-bg': '#161b22',
  '--ui-danger': '#f85149',
  '--ui-warning': '#d29922',
  '--ui-success': '#3fb950',
  '--ui-accent-2': '#a371f7'
};

/** 按活动主题 kind 取 UI 令牌缺省值（返回副本——消费方改不改都不影响源） */
export function kindCssVars(kind: 'dark' | 'light'): Record<string, string> {
  return { ...(kind === 'dark' ? DARK_UI_VARS : LIGHT_UI_VARS) };
}

/** 合成动态令牌 CSS 文本（UI 令牌 + 捕获色声明） */
export function buildTokenCss(uiVars: Record<string, string>, captureCss = ''): string {
  const lines = Object.entries(uiVars).map(([name, value]) => `${name}: ${value};`);
  if (captureCss.trim() !== '') lines.push(captureCss.trim());
  return lines.join('\n');
}

/**
 * 应用动态令牌：`<style id="vv-tokens">` **整体替换**（主题变更时整块换掉）。
 * 元素不存在则创建（首次）；存在则只换 textContent——不做增量 patch（避免残留旧值）。
 */
export function applyTokenCss(doc: Document, css: string): HTMLStyleElement {
  const existing = doc.getElementById(TOKEN_STYLE_ID);
  const element = existing instanceof HTMLStyleElement ? existing : doc.createElement('style');
  if (!(existing instanceof HTMLStyleElement)) {
    element.id = TOKEN_STYLE_ID;
    doc.head.appendChild(element);
  }
  element.textContent = css;
  return element;
}

/** katex 排印样式的样式元素 id */
export const KATEX_STYLE_ID = 'vv-katex';

/**
 * katex 排印样式的**自备注入面**（spec H T3，RF 7）。
 *
 * 包内 `packages/vviewer-markdown/src/pipeline.ts:643` 的 `import('katex/dist/katex.min.css')`
 * 是 **vite 专属**形态（vite 把 CSS 抽成独立 chunk 按需注入 <style>）——esbuild 无此机制，
 * 构建期已把该 import 拦为空模块（见 scripts/build-plugins.mjs 的 katexCssStubPlugin）。
 * 故扩展必须自备注入面：fetch 打包的 katex.min.css → 字体 URL 改写为绝对 asWebviewUri
 * → 注入 `<style>`。
 *
 * 字体 URL 必须**绝对**：`<style>` 内的相对 URL 按**文档 base** 解析（非 CSS 文件 URL），
 * 直接沿用 CSS 里的 `url(fonts/…)` 会打到文档根 → 字体 404 → 公式无排印。
 *
 * 失败面：读不到 → 返回 false（公式退化为无排印 HTML，与修复前同款；**不抛错**——
 * 排印样式是增强面，不该把渲染面带崩）。
 */
export async function injectKatexCss(doc: Document, cssUrl: string, fontsBase: string): Promise<boolean> {
  try {
    const response = await fetch(cssUrl);
    if (!response.ok) return false;
    const text = await response.text();
    const rewritten = text.replace(/url\((['"]?)fonts\//g, `url($1${fontsBase}`);
    const existing = doc.getElementById(KATEX_STYLE_ID);
    const element = existing instanceof HTMLStyleElement ? existing : doc.createElement('style');
    if (!(existing instanceof HTMLStyleElement)) {
      element.id = KATEX_STYLE_ID;
      doc.head.appendChild(element);
    }
    element.textContent = rewritten;
    return true;
  } catch {
    return false;
  }
}

/**
 * 读打包主题表并算出捕获色 CSS（`--vv-ts-*`）。
 *
 * 失败面：读不到/解析失败 → 返回空串（捕获色缺失 → 捕获着色回落 inherit，与无主题表
 * 的既有行为同款；**不抛错**——主题表是增强面，不该把渲染面带崩）。
 */
export async function loadCaptureCss(themesUrl: string, kind: 'dark' | 'light'): Promise<string> {
  try {
    const response = await fetch(themesUrl);
    if (!response.ok) return '';
    const themes = (await response.json()) as Record<string, ThemeTable>;
    const table = themes[PACKAGED_THEME_BY_KIND[kind]];
    if (!table) return '';
    return themeToCssVars(table, [...CODE_CAPTURES]);
  } catch {
    return '';
  }
}
