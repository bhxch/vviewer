import type { Detection, FileSource, RenderedInstance, Renderer } from '../types';

function buildErrorCard(): HTMLDivElement {
  const card = document.createElement('div');
  card.className = 'vv-error-card';
  card.innerHTML = `
    <div class="vv-error-title">无法预览此文件</div>
    <div class="vv-error-detail"></div>
    <div class="vv-error-meta"></div>`;
  return card;
}

/** 供 dispatcher 在选路失败或 render 失败时复用，展示原因并返回可销毁实例 */
export function showErrorCard(
  target: HTMLElement,
  message: string,
  source: { name: string }
): RenderedInstance {
  const card = buildErrorCard();
  (card.querySelector('.vv-error-detail') as HTMLElement).textContent = message;
  (card.querySelector('.vv-error-meta') as HTMLElement).textContent = source.name;
  target.replaceChildren(card);
  return { destroy() { card.remove(); } };
}

export const errorRenderer: Renderer = {
  id: 'error',
  label: '错误',
  extensions: [],
  async render(buffer: Uint8Array, target: HTMLElement, source: FileSource, det: Detection): Promise<RenderedInstance> {
    const card = buildErrorCard();
    (card.querySelector('.vv-error-meta') as HTMLElement).textContent =
      `${source.name} · 扩展名 ".${det.ext}" ${det.binary ? '· 检测为二进制' : ''}`;
    target.replaceChildren(card);
    return { destroy() { card.remove(); } };
  }
};
