import { createRegistry, createDispatcher, type Dispatcher, type Registry } from '@vviewer/core';
import { codeRenderer } from '@vviewer/render-text';
import { markdownRenderer } from '@vviewer/render-text/markdown/markdownRenderer';
import { htmlRenderer } from '@vviewer/render-text/html';
import { imageRenderer } from '@vviewer/render-media';
import { avRenderer } from '@vviewer/render-media/av';
import { browser } from '$app/environment';
import { ensureHighlightClient } from './highlightClient';

/** M1 渲染器注册表：代码/文本、markdown、html 沙箱预览、图片（含消毒后的 SVG）、音视频 */
export const registry: Registry = createRegistry();
registry.install(codeRenderer);
registry.install(markdownRenderer);
registry.install(htmlRenderer);
registry.install(imageRenderer);
registry.install(avRenderer);

export const dispatcher: Dispatcher = createDispatcher(registry);

// M2：应用启动即预热 tree-sitter 高亮 Worker（握手 + 资产就绪早于首个 code tab；
// 失败只告警一次，渲染端对 code.ts 的 attachHighlightClient 保持未注入 → 降级 hljs）
if (browser) {
  ensureHighlightClient()?.catch((e: unknown) => {
    console.warn('[highlight] client 初始化失败，代码高亮降级 hljs', e);
  });
}
