// markdownExport.ts — 导出触发壳的可测辅助（md-export Task 2）。装配本体在
// @vviewer/render-text/markdown/export（collectExportHtml/collectPrintHtml 纯函数）；
// 本模块持浏览器副作用面：图片 data URI 解析策略、Blob 下载、隐藏 iframe 打印、
// PDF 前置 mermaid 浅色重画。除 iframe print（jsdom 无 srcdoc load，e2e 承担）外
// 均可 vitest 直测。
import { renderMermaidInto } from '@vviewer/render-diagram';

/**
 * 导出文件名（计划 Global Constraints：`<原名>.html`）：剥单一扩展名，无名回退
 * export。PDF 钮不出下载（走系统打印对话框，文件名由用户在对话框定）。
 */
export function exportFileName(name: string, ext: 'html'): string {
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  return `${base.trim() !== '' ? base : 'export'}.${ext}`;
}

/**
 * 图片 data URI 解析策略（注入 collectExportHtml 的 resolveImage，spec §6）：
 * - data: 已内联 → 返回 null（原样保留）；
 * - 外域 http(s) → 返回 null 不强拉（CORS 不可控）；
 * - blob: / 同源 http(s) / 相对路径 → fetch 转 base64 data URI；非 2xx、非 image
 *   内容型、fetch 抛错 → null 保留原 URL（fetch 失败降级）；
 * - blob: 的 MIME 可为空串（markdownImages IMAGE_MIME 未知扩展给 ''）：data URI
 *   缺型不可省，回退 image/png——<img> 解码按内容嗅探，不因声明型失真。
 */
export async function resolveExportImage(src: string): Promise<string | null> {
  if (src === '' || src.startsWith('data:')) return null;
  try {
    const url = new URL(src, globalThis.location?.href);
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      if (globalThis.location !== undefined && url.origin !== globalThis.location.origin) return null;
    } else if (url.protocol !== 'blob:') {
      return null; // 未知 scheme（file:/javascript: 等）不强拉
    }
    const res = await fetch(url.href); // 相对 src 解析为绝对 URL 再取（与页面基址一致）
    if (!res.ok) return null;
    const type = res.headers.get('content-type') ?? '';
    if (type !== '' && !type.startsWith('image/')) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    let bin = '';
    const CHUNK = 0x8000; // 逐块 String.fromCharCode，避开超长实参栈限
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return `data:${type !== '' ? type : 'image/png'};base64,${btoa(bin)}`;
  } catch {
    return null; // fetch 失败保留原 URL（降级语义与外域一致）
  }
}

/**
 * PDF 浅色重画调度（spec §7）：对导出克隆 doc 内每个 [data-mermaid] 以 default
 * 主题就地重画。renderMermaidInto 的 mermaid.render 自建临时宿主产出 SVG 字符串，
 * 容器只作写入目标、不参与渲染——detached 克隆节点无需挂载（Task 2 实测校准，
 * 主文档临时重画+还原的降级路径不需要）；单图失败保留旧图（false）不阻断整篇。
 */
export async function repaintMermaidForPrint(doc: Document): Promise<void> {
  for (const el of Array.from(doc.querySelectorAll('[data-mermaid]'))) {
    const src = el.getAttribute('data-mermaid');
    if (!src) continue;
    await renderMermaidInto(el, src, 'default');
  }
}

/** 导出 HTML 经 Blob+a[download] 下载（计划 Global Constraints；jsdom 不可真下载，
 * 真实下载事件由 e2e 断言）。URL 撤销延迟兜底防泄漏。 */
export function downloadExport(html: string, filename: string): void {
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** print 特性检测（print 可用性探测一步）：contentWindow 缺失/print 非函数不可用。 */
export function printAvailable(win: Window | null | undefined): boolean {
  return typeof win?.print === 'function';
}

/** print 不可用时的降级通知回调（MetaPanel 注入 toast 提示，不静默——计划既定）。 */
export type PrintUnavailableNotice = () => void;

/**
 * 隐藏 iframe 打印（spec §7 主路径，与 window.print 作用域方案二选一不并存）：
 * srcdoc 载入打印模板 → onload 后 contentWindow.print()。点击链路内的异步装配
 * 消耗的是同一次用户激活窗口（Chromium 瞬时激活秒级有效，装配毫秒级完成），
 * print() 的手势要求天然满足；策略拦截/特性缺失时经 onUnavailable 通知降级
 * （不静默）。返回 'invoked'（iframe 已排入装载）——print 调用发生在 onload
 * 异步步，失败经回调上浮；同步返回值仅供调用方区分「未排程」形态。
 */
export function printDocument(html: string, onUnavailable: PrintUnavailableNotice): 'invoked' | 'unavailable' {
  if (typeof document === 'undefined') return 'unavailable';
  const iframe = document.createElement('iframe');
  iframe.setAttribute('aria-hidden', 'true');
  // sandbox 纵深防御（终审 M3）：导出产物结构性无 script（collectExportHtml 装配
  // 面不含脚本，单测+e2e 锁定）。allow-same-origin 保持同源——跨源 WindowProxy 上
  // 取 print 属性即 SecurityError，print 通道直接瘫痪；allow-modals 放行 print 对话
  // 框（sandbox 模态旗标门控 window.print，缺省被静默忽略）。
  iframe.setAttribute('sandbox', 'allow-same-origin allow-modals');
  // 0 尺寸 + visibility 隐藏（display:none 的 iframe 在部分内核拒绝渲染/print）
  iframe.style.position = 'fixed';
  iframe.style.right = '0';
  iframe.style.bottom = '0';
  iframe.style.width = '0';
  iframe.style.height = '0';
  iframe.style.border = '0';
  iframe.style.visibility = 'hidden';
  iframe.onload = () => {
    try {
      if (!printAvailable(iframe.contentWindow)) throw new Error('print 不可用');
      iframe.contentWindow?.print(); // Chromium 阻塞至打印对话框关闭
    } catch {
      onUnavailable();
    } finally {
      setTimeout(() => iframe.remove(), 0); // 对话框关闭后摘除宿主
    }
  };
  iframe.srcdoc = html;
  document.body.append(iframe);
  return 'invoked';
}
