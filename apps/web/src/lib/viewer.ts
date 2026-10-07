import { createRegistry, createDispatcher, type Dispatcher, type Registry } from '@vviewer/core';
import { codeRenderer } from '@vviewer/render-text';
import { markdownRenderer } from '@vviewer/render-text/markdown/markdownRenderer';
import { htmlRenderer } from '@vviewer/render-text/html';
import { imageRenderer } from '@vviewer/render-media';
import { avRenderer } from '@vviewer/render-media/av';
import { pdfRenderer } from '@vviewer/render-doc';
import { hexRenderer } from '@vviewer/render-binary';
import { archiveRenderer } from '@vviewer/render-archive';
import { configureLibarchive } from '@vviewer/render-archive/libarchiveStore';
import { browser } from '$app/environment';
import { ensureHighlightClient } from './highlightClient';

/** M1 渲染器注册表：代码/文本、markdown、html 沙箱预览、图片（含消毒后的 SVG）、音视频。
 * M4 追加：PDF（render-doc）、hex/结构树（render-binary）、压缩包 zip/tar/7z/rar
 * （render-archive，libarchive worker 走静态拷贝的 /libarchive/worker-bundle.js）。 */
export const registry: Registry = createRegistry();
registry.install(codeRenderer);
registry.install(markdownRenderer);
registry.install(htmlRenderer);
registry.install(imageRenderer);
registry.install(avRenderer);
registry.install(pdfRenderer);
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
