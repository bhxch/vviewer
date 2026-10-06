import { createRegistry, createDispatcher, type Dispatcher, type Registry } from '@vviewer/core';
import { codeRenderer } from '@vviewer/render-text';
import { imageRenderer } from '@vviewer/render-media';
import { avRenderer } from '@vviewer/render-media/av';

/** M1 渲染器注册表：代码/文本、图片（含消毒后的 SVG）、音视频 */
export const registry: Registry = createRegistry();
registry.install(codeRenderer);
registry.install(imageRenderer);
registry.install(avRenderer);

export const dispatcher: Dispatcher = createDispatcher(registry);
