// sanitize.ts — markdown/HTML 渲染输出的唯一净化策略。
// 移植自 markpad src/lib/utils/sanitize.ts（单一策略模块原则），按 vviewer 契约
// 调整 URI 白名单：http/https/mailto/相对路径/data:image；FORBID_TAGS style；
// ALLOW_DATA_ATTR 保留 mermaid/katex 管线钩子。
import DOMPurify from 'dompurify';
import type { Config } from 'dompurify';

// 仅在 DOMPurify 默认形状上收窄与放行两种方向：
//   - `data:image/`：内嵌图片（其余 data: MIME 一律拒绝，如 data:text/html）
//   - 删除 markpad 的盘符/asset:/tauri: 分支（无 Tauri 环境）
// 其余与 DOMPurify 默认一致：相对路径、片段、字母开头的非 scheme 串。
// `javascript:`、`vbscript:`、`data:text/html` 匹配不到任何分支，连属性一起剥除。
export const ALLOWED_URI_REGEXP =
  /^(?:(?:(?:f|ht)tps?|mailto):|data:image\/|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i;

// <style> 在 DOMPurify 默认允许表内且其 CSS 不经过滤：作者样式表注入预览文档后
// 可全局生效（隐藏 UI / background:url 外传），故禁；行内 style 属性仍允许。
export const MARKDOWN_SANITIZE_CONFIG: Config = {
  ALLOWED_URI_REGEXP,
  FORBID_TAGS: ['style'],
  ALLOW_DATA_ATTR: true,
};

/** sanitizeHtml 可选项 */
export interface SanitizeOptions {
  /** true 时净化整份 HTML 文档（含 html/head/body 与其中的 meta/title），html 渲染器 srcdoc 用 */
  wholeDocument?: boolean;
}

/**
 * 不可信渲染 HTML 过唯一共享策略。string 与 Document 输入统一返回字符串
 * （SDD Ruling：T3 管线以字符串为统一出口，自行 innerHTML 成 DOM）。
 * Document 输入取 body 内容净化（DOMPurify 无法导入文档节点本身；本管线
 * 的 Document 均为 body 级片段容器）。wholeDocument 时输入必须是完整文档
 * 字符串（Document 输入会丢 head，此时应直接传原始字符串）。
 */
export function sanitizeHtml(dirty: string | Document, opts: SanitizeOptions = {}): string {
  const html = typeof dirty === 'string' ? dirty : dirty.body.innerHTML;
  const config: Config = opts.wholeDocument
    ? { ...MARKDOWN_SANITIZE_CONFIG, WHOLE_DOCUMENT: true }
    : MARKDOWN_SANITIZE_CONFIG;
  // 无 RETURN_DOM/RETURN_DOM_FRAGMENT 的重载返回 string
  return DOMPurify.sanitize(html, config) as string;
}
