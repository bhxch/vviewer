// webviewHtml.ts — webview HTML 模板（spec H T2）。
//
// **vscode-free 纯模块**（评审订正⑧）：零 `import * as vscode from 'vscode'`——该模块在
// 运行时不存在，vitest 直解析会红。故 CSP 与样式内联在此模块内成形（入参为 cspSource
// 与 styleText），可被 `webviewHtml.test.ts` 直测。
//
// CSP 七 directive（评审订正②的最终形态，缺一即对应功能面静默失效）：
// - `default-src 'none'`：默认全禁，逐条放开
// - `script-src` 含 **`${webview.cspSource}`**——webview 入口 `main.js` 与动态 chunk
//   `chunk-*.js` 都是外链脚本（ESM 入口 + code splitting），nonce 只覆盖宿主内联脚本、
//   **覆盖不到 `import()` 的 chunk**；`'wasm-unsafe-eval'` 供 tree-sitter wasm 实例化
// - `media-src` **显式列**——`default-src 'none'` 下回落即拦死 `<audio>`/`<video>`
//   （av 渲染器的主功能面）
// - `connect-src`——worker 内 fetch wasm（缺则 tree-sitter 静默降级 hljs）
// - `worker-src`——blob worker 起活
// - `font-src`——katex 字体（asWebviewUri）
// - `style-src`——'unsafe-inline' 供包内导出/运行时样式；宿主内联块另带 nonce
// - `img-src`——data:/blob:（相对图片转 blob URL）与 https:（外链图片，受三档策略约束）
//
// 样式供给面（评审订正①）：`createMarkdownView` 自身**不注入样式**
// （packages/vviewer-markdown/src/markdownRenderer.ts:958-961 明写「CSS 由消费方引入」）→
// 扩展必须自带两处：markdown 排版样式（`MARKDOWN_CSS` 常量）+ 壳样式（`SHELL_CSS` 常量），
// 合成为**单一** `<style nonce>` 内联进 webview HTML。
// 动态令牌（`--vv-ts-*` 等随主题变的部分）**不进**此块——由 webview 侧 `<style>` 元素整体
// 替换（T3/T6）。
import { MARKDOWN_CSS } from '@bhxch/vviewer-markdown/css';
import { SHELL_CSS } from '../webview/shellCss';

/** webview HTML 入参 */
export interface WebviewHtmlOptions {
  /** `webview.cspSource`（webview 资源源） */
  cspSource: string;
  /** CSP nonce（宿主内联样式块用） */
  nonce: string;
  /** webview 入口脚本 URL（`asWebviewUri` 后的绝对 URL） */
  scriptUri: string;
  /** 内联样式文本（markdown 排版 + 壳样式） */
  styleText: string;
  /** 文档标题（缺省 'VViewer'） */
  title?: string;
  /** 文档语言标签（缺省 'en'） */
  lang?: string;
}

/** CSP 的七条 directive 名（穷举面——缺一即对应功能面静默失效） */
export const CSP_DIRECTIVES = [
  'default-src',
  'img-src',
  'style-src',
  'script-src',
  'worker-src',
  'font-src',
  'media-src',
  'connect-src'
] as const;

/**
 * 合成内联样式文本：markdown 排版样式（`MARKDOWN_CSS`）+ 壳样式（`SHELL_CSS`）。
 *
 * 顺序：先 markdown 段、后壳段——壳段是扩展自有布局，优先级在后者（同等特异性下后者胜）。
 */
export function composeStyleText(): string {
  return `${MARKDOWN_CSS}\n${SHELL_CSS}`;
}

/** 构造 CSP 头值（七 directive） */
export function buildCsp(cspSource: string, nonce: string): string {
  return [
    `default-src 'none'`,
    `img-src ${cspSource} data: blob: https:`,
    `style-src ${cspSource} 'unsafe-inline'`,
    `script-src ${cspSource} 'nonce-${nonce}' 'wasm-unsafe-eval'`,
    `worker-src ${cspSource} blob:`,
    `font-src ${cspSource} data:`,
    `media-src ${cspSource} blob: data:`,
    `connect-src ${cspSource} data: blob: https:`
  ].join('; ');
}

/** HTML 文本转义（标题等文本内容入模板前必过） */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * HTML 属性值转义（只转 `&` 与 `"`——属性以双引号界定，单引号在属性值内是字面量）。
 * CSP 走此路：转义单引号虽仍被 HTML 解析器还原，但会让 CSP 头在源码面不可读。
 */
export function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

/**
 * 渲染 webview HTML。
 *
 * 结构：单一内联 `<style nonce>`（markdown 排版 + 壳样式）+ 外链 ESM 入口
 * `<script type="module">`（webview 侧 main.js，动态 chunk 由 esbuild code splitting
 * 产出，同目录相对解析）。
 */
export function renderWebviewHtml(options: WebviewHtmlOptions): string {
  const { cspSource, nonce, scriptUri, styleText } = options;
  const title = escapeHtml(options.title ?? 'VViewer');
  const lang = escapeAttr(options.lang ?? 'en');
  const csp = buildCsp(cspSource, nonce);
  return `<!DOCTYPE html>
<html lang="${lang}">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${escapeAttr(csp)}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${title}</title>
    <style nonce="${escapeAttr(nonce)}">${styleText}</style>
  </head>
  <body>
    <div id="vv-root"></div>
    <script type="module" src="${escapeAttr(scriptUri)}"></script>
  </body>
</html>
`;
}
