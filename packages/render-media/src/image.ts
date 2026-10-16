import { getHexFallbackRenderer, showErrorCard, type Encoding, type ErrorCardAction, type RenderedInstance, type Renderer } from '@vviewer/core';

/** 超时护栏（spec §4.2）：decode 挂死（异常大图/畸形编码）时按成功放行，迟到失败
 * 走渲染器内构兜底卡——不阻塞查看器主路径。 */
const IMAGE_DECODE_TIMEOUT_MS = 10_000;

type DecodeOutcome = { kind: 'ok' } | { kind: 'failed' } | { kind: 'timeout' };

/**
 * 解码校验观察（BUG-53）：decode() 主路径、load/error 事件回退（jsdom/无 decode
 * 环境）、超时三路竞待。结果枚举而非 promise reject——竞待落定后迟到的另一路
 * 不产生 unhandled rejection。finish 幂等（首达移除全部监听与计时器）。
 */
function observeImageDecode(img: HTMLImageElement, timeoutMs: number): Promise<DecodeOutcome> {
  return new Promise((resolve) => {
    const finish = (outcome: DecodeOutcome): void => {
      clearTimeout(timer);
      img.removeEventListener('error', onError);
      img.removeEventListener('load', onLoad);
      resolve(outcome);
    };
    const onError = (): void => finish({ kind: 'failed' });
    const onLoad = (): void => finish({ kind: 'ok' });
    img.addEventListener('error', onError);
    img.addEventListener('load', onLoad);
    const timer = setTimeout(() => finish({ kind: 'timeout' }), timeoutMs);
    if (typeof img.decode === 'function') {
      img.decode().then(
        () => finish({ kind: 'ok' }),
        () => finish({ kind: 'failed' })
      );
    }
  });
}

/** SVG 只读消毒：去除 script、on* 事件属性、javascript: 与外部 href|src|xlink */
export function sanitizeSvg(svgText: string): string {
  const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  const svg = doc.documentElement;
  if (svg.nodeName === 'parsererror' || svg.getElementsByTagName('parsererror').length) {
    throw new Error('SVG 解析失败');
  }
  for (const el of [...svg.querySelectorAll('script, foreignObject')]) el.remove();

  const scrub = (el: Element): void => {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      const value = attr.value.trim().toLowerCase();
      if (name.startsWith('on')) el.removeAttribute(attr.name);
      else if ((name === 'href' || name === 'src' || name === 'xlink:href') &&
               (value.startsWith('javascript:') || value.startsWith('http:') || value.startsWith('https:') || value === '')) {
        el.removeAttribute(attr.name);
      }
    }
  };

  // TreeWalker 不遍历根节点自身，根 <svg> 上的 onload 等需单独清洗
  scrub(svg);
  const walk = doc.createTreeWalker(svg, NodeFilter.SHOW_ELEMENT);
  let node = walk.nextNode();
  while (node) {
    scrub(node as Element);
    node = walk.nextNode();
  }
  return new XMLSerializer().serializeToString(svg);
}

function attachZoom(container: HTMLElement, img: HTMLElement): () => void {
  let zoom = 1; // 每实例独立，避免多图共享状态互相污染
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    zoom = Math.min(10, Math.max(0.1, zoom * (e.deltaY < 0 ? 1.1 : 0.9)));
    img.style.transform = `scale(${zoom})`;
  };
  const onDbl = () => { zoom = 1; img.style.transform = 'scale(1)'; };
  // 双指捏合缩放留待 M7 触屏专项
  container.addEventListener('wheel', onWheel, { passive: false });
  container.addEventListener('dblclick', onDbl);
  return () => {
    container.removeEventListener('wheel', onWheel);
    container.removeEventListener('dblclick', onDbl);
    zoom = 1;
  };
}

export const imageRenderer: Renderer = {
  id: 'image',
  label: '图片',
  extensions: ['png', 'jpeg', 'jpg', 'gif', 'webp', 'avif', 'bmp', 'ico', 'svg'],
  async render(buffer, target, source, det) {
    const wrap = document.createElement('div');
    wrap.className = 'vv-image';
    let url: string;
    if (det.ext === 'svg') {
      const clean = sanitizeSvg(new TextDecoder().decode(buffer));
      url = URL.createObjectURL(new Blob([clean], { type: 'image/svg+xml' }));
    } else {
      // buffer 实际由普通 ArrayBuffer 支持；断言绕开 TS 5.9 BlobPart 的 ArrayBuffer 泛型收窄，避免大图复制
      url = URL.createObjectURL(new Blob([buffer as Uint8Array<ArrayBuffer>], { type: '' }));
    }
    const img = document.createElement('img');
    img.src = url;
    img.alt = source.name;
    // BUG-53 解码校验：失败即 revoke + throw（DOM 未污染）→ dispatcher 现成错误
    // 卡片（重试/以 hex/以纯文本；损坏二进制图片经 looksTextual 走「以 hex 打开」
    // 排前）；超时按成功放行 + 迟到 error 渲染器内构兜底卡（超时路径动作面较窄，
    // 无 dispatcher 级 open-as，注释明示的降级体验）
    // SVG 走 sanitizeSvg throw 锚（spec 铁律：SVG 分支不接解码校验）——仅 raster 校验
    const outcome = det.ext === 'svg'
      ? ({ kind: 'ok' } as const)
      : await observeImageDecode(img, IMAGE_DECODE_TIMEOUT_MS);
    if (outcome.kind === 'failed') {
      URL.revokeObjectURL(url);
      throw new Error('图片解码失败：数据损坏或格式不支持');
    }
    const lateGuard = outcome.kind === 'timeout';
    wrap.append(img);
    target.replaceChildren(wrap);
    const detach = attachZoom(wrap, img);
    // —— 迟到兜底（BUG-53 超时路径专属）：渲染器内构卡，av 同款形态 ——
    let cardShown = false;
    let liveChild: RenderedInstance | null = null;
    const takeOver = (instance: RenderedInstance): void => {
      liveChild?.destroy();
      liveChild = instance;
    };
    const detachImage = (): void => {
      URL.revokeObjectURL(url);
      wrap.remove();
    };
    const buildActions = (): ErrorCardAction[] => {
      const actions: ErrorCardAction[] = [
        {
          label: '重试',
          onClick: () => {
            imageRenderer.render(buffer, target, source, det)
              .then(takeOver)
              .catch((err: unknown) => {
                const message = err instanceof Error ? err.message : String(err);
                showErrorCard(target, message, source, { actions: buildActions() });
              });
          }
        }
      ];
      const hex = getHexFallbackRenderer();
      if (hex) {
        actions.push({
          label: '以 hex 打开',
          onClick: () => {
            detachImage();
            Promise.resolve(hex.render(buffer, target, source, det))
              .then(takeOver)
              .catch((err: unknown) => {
                const message = err instanceof Error ? err.message : String(err);
                showErrorCard(target, message, source);
              });
          }
        });
      }
      return actions;
    };
    if (lateGuard) {
      img.addEventListener('error', () => {
        if (cardShown) return;
        cardShown = true;
        detach();
        detachImage();
        showErrorCard(target, '图片解码失败：数据损坏或格式不支持', source, { actions: buildActions() });
      });
    }
    // BUG-04（SHELL-12 验收）：图片状态栏/属性面板至少含大小与编码——det.encoding
    // 为服务端 x-vv-encoding 或本地启发式的检测结果，ViewerPane 按 'getMeta' in 探测
    const instance: RenderedInstance & { getMeta(): { size: number; encoding?: Encoding } } = {
      getMeta: () => ({ size: buffer.length, encoding: det.encoding }),
      destroy() {
        detach();
        detachImage();
        liveChild?.destroy();
      }
    };
    return instance;
  }
};
