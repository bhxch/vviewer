import type { Detection, FileSource, RenderedInstance, Renderer } from '../types';

/** 错误卡片动作按钮（BUG-14）：label 为按钮文案，onClick 在点击时执行 */
export interface ErrorCardAction {
  label: string;
  onClick(): void;
}

export interface ErrorCardOptions {
  /** 卡片底部动作按钮（重试/降级等）；缺省无按钮（兼容既有调用） */
  actions?: ErrorCardAction[];
}

function buildErrorCard(actions?: ErrorCardAction[]): HTMLDivElement {
  const card = document.createElement('div');
  card.className = 'vv-error-card';
  card.innerHTML = `
    <div class="vv-error-title">无法预览此文件</div>
    <div class="vv-error-detail"></div>
    <div class="vv-error-meta"></div>`;
  if (actions && actions.length > 0) {
    // 样式内联：app.css 归属其他修复包，卡片按钮需开箱可见；类名保留语义钩子供 e2e/样式接管
    const box = document.createElement('div');
    box.className = 'vv-error-actions';
    box.style.cssText = 'display:flex;gap:.5rem;margin-top:.25rem;flex-wrap:wrap;';
    for (const action of actions) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'vv-error-action';
      btn.style.cssText = 'cursor:pointer;padding:.15rem .75rem;';
      btn.textContent = action.label;
      btn.onclick = () => action.onClick();
      box.append(btn);
    }
    card.append(box);
  }
  return card;
}

/** 供 dispatcher 在选路失败或 render 失败时复用，展示原因并返回可销毁实例 */
export function showErrorCard(
  target: HTMLElement,
  message: string,
  source: { name: string },
  opts?: ErrorCardOptions
): RenderedInstance {
  const card = buildErrorCard(opts?.actions);
  (card.querySelector('.vv-error-detail') as HTMLElement).textContent = message;
  (card.querySelector('.vv-error-meta') as HTMLElement).textContent = source.name;
  target.replaceChildren(card);
  return { destroy() { card.remove(); } };
}

/**
 * hex 降级渲染器注册点（BUG-14「降级查看」）：av 渲染器运行期错误卡片需要把
 * 原始字节交给 hex 渲染器兜底，但 render-media 不依赖 render-binary（避免包间
 * 耦合）。createDispatcher 装配时从 registry 取 'hex' 注入，av 渲染器经 getter 消费。
 */
let hexFallback: Renderer | null = null;

/** 由 createDispatcher 注册（registry 中 id 为 'hex' 的渲染器）；传 null 清除 */
export function setHexFallbackRenderer(r: Renderer | null): void {
  hexFallback = r;
}

/** av 等渲染器错误卡片的「降级查看」兜底；未注册返回 null（按钮不出现） */
export function getHexFallbackRenderer(): Renderer | null {
  return hexFallback;
}

export const errorRenderer: Renderer = {
  id: 'error',
  label: '错误',
  extensions: [],
  async render(buffer: Uint8Array, target: HTMLElement, source: FileSource, det: Detection): Promise<RenderedInstance> {
    const card = buildErrorCard();
    (card.querySelector('.vv-error-meta') as HTMLElement).textContent =
      `${source.name} · ${det.ext === '' ? '无扩展名' : `扩展名 ".${det.ext}"`} ${det.binary ? '· 检测为二进制' : ''}`;
    target.replaceChildren(card);
    return { destroy() { card.remove(); } };
  }
};
