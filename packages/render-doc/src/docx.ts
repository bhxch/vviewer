// docx.ts — Word 渲染器（M4 Task 5）。mammoth 动态 import（重依赖不进主包）：
// convertToHtml 输入按运行时形态选择——Node（vitest/SSR 侧测试）用 Buffer，
// 浏览器构建（package.json browser 字段换用 browser/unzip.js）用 arrayBuffer。
// 输出 HTML 必经 sanitizeHtml（复用 @vviewer/render-text 的唯一净化策略，
// 依赖方向 render-doc → render-text，SDD 裁决）。mammoth 图片默认内联为
// data:image/* base64，净化白名单已放行 img src 的 data:image。
// OOXML 预检语义见 ooxml.ts：render 侧 ZIP 签名早失败，sniff 永不改派。
import type { Detection, FileSource, RenderedInstance, Renderer } from '@vviewer/core';
import { sanitizeHtml } from '@vviewer/render-text/sanitize';
import { assertZipSignature, sniffOoxml } from './ooxml';

type MammothModule = typeof import('mammoth');
type MammothInput = Parameters<MammothModule['convertToHtml']>[0];

/** Node Buffer 最小结构类型（避免引入 @types/node；浏览器构建无 Buffer 走 arrayBuffer 分支） */
interface NodeBufferLike {
  from(input: Uint8Array): unknown;
}

function toMammothInput(u8: Uint8Array): MammothInput {
  const nodeBuffer = (globalThis as { Buffer?: NodeBufferLike }).Buffer;
  if (nodeBuffer) return { buffer: nodeBuffer.from(u8) } as MammothInput;
  return {
    arrayBuffer: u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer
  };
}

export const docxRenderer: Renderer = {
  id: 'docx',
  label: 'Word 文档',
  extensions: ['docx'],
  sniff: sniffOoxml,
  async render(buffer: Uint8Array, target: HTMLElement, _source: FileSource, _det: Detection) {
    assertZipSignature(buffer, 'docx（Word）');
    const mod = await import('mammoth');
    const mammoth = ((mod as { default?: MammothModule }).default ?? mod) as MammothModule;
    const result = await mammoth.convertToHtml(toMammothInput(buffer));

    const root = document.createElement('div');
    root.className = 'vv-docx';
    const content = document.createElement('div');
    content.className = 'vv-docx-content';
    content.innerHTML = sanitizeHtml(result.value);
    root.append(content);
    target.replaceChildren(root);

    const instance: RenderedInstance = {
      destroy() {
        root.remove();
      }
    };
    return instance;
  }
};
