// sanitize.ts — markdown/HTML 渲染输出的唯一净化策略。
// 移植自 markpad src/lib/utils/sanitize.ts（单一策略模块原则），按 vviewer 契约
// 调整 URI 白名单：http/https/mailto/相对路径/data:image（data: 仅限 src/srcset，
// 见下方钩子）；FORBID_TAGS style/meta；ALLOW_DATA_ATTR 保留 mermaid/katex 管线钩子。
import DOMPurify from 'dompurify';
import type { Config } from 'dompurify';

// 仅在 DOMPurify 默认形状上收窄与放行两种方向：
//   - `data:image/`：内嵌图片（其余 data: MIME 一律拒绝，如 data:text/html）
//   - 删除 markpad 的盘符/asset:/tauri: 分支（无 Tauri 环境）
// 其余与 DOMPurify 默认一致：相对路径、片段、字母开头的非 scheme 串。
// `javascript:`、`vbscript:`、`data:text/html` 匹配不到任何分支，连属性一起剥除。
// 注意该正则只做值前缀匹配、不区分属性：data:image/ 也会命中 <a href>，
// data: 的属性级放行由下方 afterSanitizeAttributes 钩子收窄为 src/srcset。
export const ALLOWED_URI_REGEXP =
  /^(?:(?:(?:f|ht)tps?|mailto):|data:image\/|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i;

// data: 协议仅放行 src/srcset（内嵌图片/媒体）。ALLOWED_URI_REGEXP 按属性无关的
// 值前缀匹配，单正则难以按属性区分；DOMPurify 默认的 DATA_URI_TAGS 分支又只覆盖
// data: 前缀本身而非 data:image/。故用钩子在属性判定之后统一复核：src/srcset 之外
// 的属性一律不允许 data:*——否则 <a href="data:image/svg+xml,..."> 可通过，用户点击
// 后浏览器顶层导航至 SVG data URL，其中的脚本可执行（跳转型 XSS）。
// 惰性注册（首次 sanitizeHtml 时、幂等）：模块顶层不可触 DOMPurify——SSR/Node 下
// 默认导出是未绑定 window 的工厂（无 addHook/sanitize），顶层调用会让 SvelteKit
// SSR 求值直接 500。
const DATA_URI_ATTRS = new Set(['src', 'srcset']);

/**
 * 外域图片判定（BUG-17 跟踪像素防线）：绝对 http(s) 与协议相对（//host/…）都会向
 * 第三方发起 GET（可回传 IP/会话）；相对路径、data:image、blob: 不在此列。
 */
function isExternalImageSrc(src: string): boolean {
  return /^https?:/i.test(src) || src.startsWith('//');
}

/** URL 的 host（解析失败回落原串做提示） */
function hostOf(url: string): string {
  try {
    return new URL(url, 'https://vviewer.invalid').host;
  } catch {
    return url;
  }
}

function markBlockedExternal(el: Element, host: string): void {
  el.setAttribute('data-vv-blocked-external', '1');
  el.setAttribute('title', `已拦截外部图片：${host}`);
}

let dataUriHookRegistered = false;
function registerDataUriHook(): void {
  if (dataUriHookRegistered) return;
  dataUriHookRegistered = true;
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    for (const attr of Array.from(node.attributes)) {
      if (DATA_URI_ATTRS.has(attr.name.toLowerCase())) continue;
      if (/^\s*data:/i.test(attr.value)) node.removeAttribute(attr.name);
    }
    // BUG-17：img 的 http(s)/协议相对 src 一律移除并打拦截标记——渲染视图中不再
    // 向外域发起网络请求（跟踪像素拿不到 IP）；title 保留域名供占位悬停提示。
    // 相对路径与 data:/blob: 不受影响（markdown 相对图片解析为 blob 的链路发生在
    // 净化之后，同样不受影响）；链接 <a href> 外链不拦（用户主动导航型外泄）。
    if (node.nodeType === 1 && (node as Element).tagName === 'IMG') {
      const el = node as Element;
      const src = el.getAttribute('src');
      const srcExternal = src !== null && isExternalImageSrc(src.trim());
      if (srcExternal) {
        el.removeAttribute('src');
        markBlockedExternal(el, hostOf(src!.trim()));
      }
      // srcset 是同等的图片加载源（无 src 时浏览器按 srcset 加载；markdown 渲染
      // 视图把净化后 DOM 挂主文档、无 CSP 兜底）：逐候选过滤——srcset 语法上逗号
      // 不出现在 URL 内，候选首段（首个空白前）即其 URL。外域候选移除、其余保留；
      // 过滤后无任何可用加载源（src 缺失或同为外域已拦）时补拦截标记。
      const srcset = el.getAttribute('srcset');
      if (srcset !== null) {
        const candidates = srcset.split(',').map((c) => c.trim()).filter((c) => c !== '');
        const kept: string[] = [];
        let firstBlockedHost = srcExternal ? hostOf(src!.trim()) : '';
        for (const c of candidates) {
          const url = (c.split(/\s+/)[0] ?? '').trim();
          if (isExternalImageSrc(url)) {
            if (firstBlockedHost === '') firstBlockedHost = hostOf(url);
            continue;
          }
          kept.push(c);
        }
        if (kept.length !== candidates.length) {
          if (kept.length === 0) el.removeAttribute('srcset');
          else el.setAttribute('srcset', kept.join(', '));
          if (kept.length === 0 && (src === null || srcExternal)) {
            markBlockedExternal(el, firstBlockedHost);
          }
        }
      }
    }
  });
}

// <style> 在 DOMPurify 默认允许表内且其 CSS 不经过滤：作者样式表注入预览文档后
// 可全局生效（隐藏 UI / background:url 外传），故禁；行内 style 属性仍允许。
// <meta> 当前虽不在 DOMPurify 默认允许表内，仍显式声明防上游默认变化
// （http-equiv=refresh/UVG 元信息不应出现在预览片段；沙箱文档的 CSP meta 由
// html 渲染器在净化之后自行注入，不受此禁影响）。
export const MARKDOWN_SANITIZE_CONFIG: Config = {
  ALLOWED_URI_REGEXP,
  FORBID_TAGS: ['style', 'meta'],
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
  registerDataUriHook();
  const html = typeof dirty === 'string' ? dirty : dirty.body.innerHTML;
  const config: Config = opts.wholeDocument
    ? { ...MARKDOWN_SANITIZE_CONFIG, WHOLE_DOCUMENT: true }
    : MARKDOWN_SANITIZE_CONFIG;
  // 无 RETURN_DOM/RETURN_DOM_FRAGMENT 的重载返回 string
  return DOMPurify.sanitize(html, config) as string;
}
