// renderers.ts — MVP 渲染器安装序（**单一来源**）。
//
// 为什么单源（评审 important ③）：custom editor 的 `selector`（扩展接管哪些扩展名）与
// 运行时注册表（打开时哪个渲染器认领）**必须同源**——认领面大于 selector → 用户双击
// 某扩展名不接管；小于 selector → 接管后无渲染器（错误卡片）。
//
// 此前安装序在**三处**各抄一份（webview 装配层 / selector 生成脚本 / 单测）→ 只在装配层
// 加一个渲染器，selector 静默缺该扩展名且无测试变红。本模块把安装序收成一处，装配层与
// 生成脚本共用；`apps/vscode/test/extensions.test.ts` 以「装配层实际注册表 vs 生成脚本
// 输出」做跨文件守卫。
//
// 装序铁律：**专有渲染器先于 generated 兜底安装**（`installFallbackExtensions` 遇已认领
// 扩展名即跳过——`md`/`markdown` 归 markdown 渲染器、`html`/`htm` 归 html 渲染器；
// code 渲染器显式不认领这两类）。
import {
  createRegistry,
  GENERATED_EXTENSIONS,
  type Registry,
  type Renderer
} from '@bhxch/vviewer-core';
import { codeRenderer } from '@bhxch/vviewer-render-text';
import { htmlRenderer } from '@bhxch/vviewer-render-text/html';
import { jsonlRenderer } from '@bhxch/vviewer-render-text/jsonl';
import { markdownRenderer } from '@bhxch/vviewer-markdown';
import { imageRenderer } from '@bhxch/vviewer-render-media';
import { avRenderer } from '@bhxch/vviewer-render-media/av';
import { pdfRenderer } from '@bhxch/vviewer-render-doc';
import { hexRenderer } from '@bhxch/vviewer-render-binary';

/** MVP 渲染器集（安装序即数组序）——archive / foreign / Office 三族不装（裁量 3） */
export const MVP_RENDERERS: readonly Renderer[] = [
  codeRenderer,
  markdownRenderer,
  htmlRenderer,
  imageRenderer,
  avRenderer,
  pdfRenderer,
  hexRenderer,
  jsonlRenderer
];

/** 在给定注册表上安装 MVP 渲染器 + generated 兜底（装配层与 selector 生成共用） */
export function installMvpRenderers(registry: Registry): void {
  for (const renderer of MVP_RENDERERS) registry.install(renderer);
  registry.installFallbackExtensions('code', GENERATED_EXTENSIONS);
}

/** 建一个装了 MVP 渲染器的注册表（装配层与 selector 生成共用） */
export function createMvpRegistry(): Registry {
  const registry = createRegistry();
  installMvpRenderers(registry);
  return registry;
}
