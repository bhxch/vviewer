import { createRegistry, createDispatcher, type Dispatcher, type Registry } from '@vviewer/core';
import { codeRenderer } from '@vviewer/render-text';
import {
  markdownRenderer,
  setMarkdownBackend,
  setMarkdownImageResolver,
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
import { resolveImageBlobUrl } from './markdownImages';

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

/** 在途远程 markdown 渲染的中止控制器（cancelMarkdownRemote 随 tab 切换一并 abort，对齐 highlight 的 remoteAbort 模式）。 */
let markdownRemoteAbort: AbortController | null = null;

/** tab 切换/重渲染时取消在途远程 markdown 请求（不留无主连接）。 */
export function cancelMarkdownRemote(): void {
  markdownRemoteAbort?.abort();
  markdownRemoteAbort = null;
}

/**
 * 远程 markdown：POST /api/compute/markdown（Bearer），body {text, options}。
 * 未连接服务器抛错——router 的 auto 会回退本地 markdown-it；显式 remote 如实
 * 报错不静默回退（与远程高亮同一语义）。wikilinks 不开启：与本地引擎能力对齐
 * （markdown-it 无 wikilinks，开启会让 auto 回退前后渲染结果不一致）。
 * abort 抛错经 router 折叠：auto 回退本地、remote 走错误卡片（既有路径）。
 */
async function remoteMarkdown(text: string): Promise<string> {
  const call = computeRouter.remoteCall('/api/compute/markdown');
  if (!call) throw new Error('未连接服务器，无法远程渲染 markdown');
  // 挂 tab 级 abort：cancelMarkdownRemote（tab 切换/重渲染）时中止在途请求
  const ac = new AbortController();
  markdownRemoteAbort = ac;
  try {
    const res = await fetch(call.url, {
      method: 'POST',
      headers: { ...call.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ text, options: undefined }),
      signal: ac.signal
    });
    if (!res.ok) throw new Error(`远程 markdown 渲染失败: HTTP ${res.status}`);
    const data = (await res.json()) as { html: string };
    return data.html;
  } finally {
    if (markdownRemoteAbort === ac) markdownRemoteAbort = null;
  }
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

// ---------- markdown 相对图片解析（终审 M3：相对图片 404；L4 大小上限） ----------

if (browser) {
  // 相对图片 → 同 store 文件 blob URL：store 读失败（不存在/无权限）抛错由 renderer
  // 捕获后保留原 src（404 现状）；URL 随渲染实例 destroy 释放（renderer 侧 revoke）。
  // 解析逻辑（路径规范 + 大小上限）抽在 markdownImages.ts（无 $app 依赖，可单测）。
  setMarkdownImageResolver(async (src, source) =>
    resolveImageBlobUrl(source.store, source.path, src)
  );
}

// dev-only HMR 防线（遗留 T14）：本模块是装配单例来源（registry、libarchive worker
// 配置、markdown backend/图片 resolver 注入），Vite 局部热替换会重跑装配——重复
// install 与新旧模块状态并存。decline 使变更冒泡为整页刷新，杜绝半新半旧状态；
// 生产构建 import.meta.hot 恒为 undefined，分支不存在。
if (import.meta.hot) {
  import.meta.hot.accept.decline();
}
