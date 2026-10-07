import { createRegistry, createDispatcher, type Dispatcher, type Registry } from '@vviewer/core';
import { codeRenderer } from '@vviewer/render-text';
import {
  markdownRenderer,
  setMarkdownBackend,
  renderMarkdownBody
} from '@vviewer/render-text/markdown/markdownRenderer';
import { htmlRenderer } from '@vviewer/render-text/html';
import { imageRenderer } from '@vviewer/render-media';
import { avRenderer } from '@vviewer/render-media/av';
import { pdfRenderer } from '@vviewer/render-doc';
import { docxRenderer } from '@vviewer/render-doc/docx';
import { xlsxRenderer } from '@vviewer/render-doc/xlsx';
import { pptxRenderer } from '@vviewer/render-doc/pptx';
import { hexRenderer } from '@vviewer/render-binary';
import { archiveRenderer } from '@vviewer/render-archive';
import { configureLibarchive } from '@vviewer/render-archive/libarchiveStore';
import { browser } from '$app/environment';
import { ensureHighlightClient, computeRouter } from './highlightClient';

/** M1 渲染器注册表：代码/文本、markdown、html 沙箱预览、图片（含消毒后的 SVG）、音视频。
 * M4 追加：PDF（render-doc）、hex/结构树（render-binary）、压缩包 zip/tar/7z/rar
 * （render-archive，libarchive worker 走静态拷贝的 /libarchive/worker-bundle.js）、
 * Office 三件套 docx/xlsx/pptx（render-doc，pptx 为文本提纲降级路径）。 */
export const registry: Registry = createRegistry();
registry.install(codeRenderer);
registry.install(markdownRenderer);
registry.install(htmlRenderer);
registry.install(imageRenderer);
registry.install(avRenderer);
registry.install(pdfRenderer);
registry.install(docxRenderer);
registry.install(xlsxRenderer);
registry.install(pptxRenderer);
registry.install(hexRenderer);
registry.install(archiveRenderer);

// libarchive worker 路径：worker bundle + wasm 由 vite 插件拷到 static/libarchive/
// （见 vite.config.ts copyLibarchiveAssets），仅存 URL 字符串，首次解包时才起 worker
if (browser) {
  configureLibarchive({ workerUrl: `${import.meta.env.BASE_URL}libarchive/worker-bundle.js` });
}

export const dispatcher: Dispatcher = createDispatcher(registry);

// M2：应用启动即预热 tree-sitter 高亮 Worker（握手 + 资产就绪早于首个 code tab；
// 失败只告警一次，渲染端对 code.ts 的 attachHighlightClient 保持未注入 → 降级 hljs）
if (browser) {
  ensureHighlightClient()?.catch((e: unknown) => {
    console.warn('[highlight] client 初始化失败，代码高亮降级 hljs', e);
  });
}

// ---------- markdown 正文引擎接入 compute 路由（M7 Task 2，M6 遗留） ----------

/**
 * 远程 markdown：POST /api/compute/markdown（Bearer），body {text, options}。
 * 未连接服务器抛错——router 的 auto 会回退本地 markdown-it；显式 remote 如实
 * 报错不静默回退（与远程高亮同一语义）。wikilinks 不开启：与本地引擎能力对齐
 * （markdown-it 无 wikilinks，开启会让 auto 回退前后渲染结果不一致）。
 */
async function remoteMarkdown(text: string): Promise<string> {
  const call = computeRouter.remoteCall('/api/compute/markdown');
  if (!call) throw new Error('未连接服务器，无法远程渲染 markdown');
  const res = await fetch(call.url, {
    method: 'POST',
    headers: { ...call.headers, 'content-type': 'application/json' },
    body: JSON.stringify({ text, options: undefined })
  });
  if (!res.ok) throw new Error(`远程 markdown 渲染失败: HTTP ${res.status}`);
  const data = (await res.json()) as { html: string };
  return data.html;
}

/**
 * 注入 markdown 正文后端：renderer 只认注入的 fn，路由裁决与回退全在这里——
 * routeMarkdown 按 policy × compute 能力 × 服务端 path 裁决（auto 失败回退本地
 * markdown-it；remote 失败如实抛错 → ViewerPane 错误卡片），comrak 返回的 HTML
 * 由 renderer 走 sanitize+enrich+pipeline 全管线。
 */
if (browser) {
  setMarkdownBackend(async ({ text, src }) => {
    const res = await computeRouter.routeMarkdown(
      src,
      text,
      undefined,
      () => Promise.resolve(renderMarkdownBody(text)),
      src ? (t) => remoteMarkdown(t) : undefined
    );
    if (!res.ok) throw new Error(res.error ?? 'markdown 渲染失败');
    return { html: res.data ?? '', where: res.where };
  });
}
