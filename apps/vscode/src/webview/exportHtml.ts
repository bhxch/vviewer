// exportHtml.ts — 导出 HTML 组装 + 图片 data URI 解析（spec H T5）。
//
// 装配走包内纯函数 `collectExportHtml`（packages/vviewer-markdown/src/export.ts:226）——
// **选项名对齐真实 API**：`{ title, styleCss, katexCss?, resolveImage }`（无 `inlineCss`
// 选项名——初版误写，订正）。
//
// - `styleCss` = `exportBaseCss`（包导出）+ 主题变量块（`--ui-*`/`--code-*`/`--vv-ts-*`
//   当前值快照）——导出产物自带当前主题。
// - `katexCss` = **自包含**的 katex 排印样式（woff2 字体已转 data URI 内联、woff/ttf
//   回退段已移除）——构建期产物（apps/vscode/scripts/collect-assets.mjs 产出
//   `dist/webview/katex.export.css`）。
// - `resolveImage` = 图片 data URI 解析（语义对齐 apps/web/src/lib/markdownExport.ts:27）。
import { collectExportHtml, exportBaseCss } from '@bhxch/vviewer-markdown';

/** 导出上下文 */
export interface ExportContext {
  /** 导出文档标题（<title>） */
  title: string;
  /** 主题变量块 CSS 文本（`--ui-*`/`--code-*`/`--vv-ts-*` 当前值快照） */
  themeCss: string;
  /** 自包含 katex CSS（缺省空串＝不嵌排印样式） */
  katexCss: string;
  /** 图片解析覆盖（缺省用 resolveExportImage） */
  resolveImage?: (src: string) => Promise<string | null>;
}

/**
 * 图片 data URI 解析（对齐 apps/web 的 resolveExportImage）：
 * - data: 已内联 → null（原样保留）
 * - 外域 http(s) → null 不强拉（CORS 不可控）
 * - blob: / 同源 http(s) / 相对路径 → fetch 转 base64 data URI
 * - 非 2xx / 非 image 内容型 / fetch 抛错 → null（保留原 URL，降级语义与外域一致）
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
    const res = await fetch(url.href);
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
 * 组装自包含导出 HTML。
 *
 * @param source 渲染成品容器（其克隆作为导出文档正文——`collectExportHtml` 会就地
 *   加工：剥交互壳、图片转 data URI、插目录导航、内联样式）
 */
export async function buildExportHtml(source: HTMLElement, context: ExportContext): Promise<string> {
  const doc = document.implementation.createHTMLDocument('');
  doc.body.appendChild(source.cloneNode(true));
  return collectExportHtml(doc, {
    title: context.title,
    styleCss: `${exportBaseCss}\n${context.themeCss}`,
    ...(context.katexCss !== '' ? { katexCss: context.katexCss } : {}),
    resolveImage: context.resolveImage ?? resolveExportImage
  });
}

/** 导出文件名（`<原名>.html`：剥单一扩展名，无名回退 export） */
export function exportFileName(name: string): string {
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  return `${base.trim() !== '' ? base : 'export'}.html`;
}
