import { abortReadError, getHexFallbackRenderer, showErrorCard, type Encoding, type ErrorCardAction, type RenderedInstance, type Renderer } from '@vviewer/core';

/** 超时护栏（spec §4.2）：decode 挂死（异常大图/畸形编码）时按成功放行，迟到失败
 * 走渲染器内构兜底卡——不阻塞查看器主路径。 */
const IMAGE_DECODE_TIMEOUT_MS = 10_000;

type DecodeOutcome = { kind: 'ok' } | { kind: 'failed' } | { kind: 'timeout' } | { kind: 'aborted' };

/**
 * 解码校验观察（BUG-53）：decode() 主路径、load/error 事件回退（jsdom/无 decode
 * 环境）、超时三路竞待。结果枚举而非 promise reject——竞待落定后迟到的另一路
 * 不产生 unhandled rejection。finish 幂等（首达移除全部监听与计时器）。
 * 审计 R1 I-1：可选 signal（render 第 6 参透传）——解码 await 窗内的取消
 * （tab 重派/切走/destroy）即刻落定 'aborted'，堵住「迟到 resolve/reject 覆写
 * 或污染新渲染」盲窗；预 aborted 初始即短路。
 */
function observeImageDecode(img: HTMLImageElement, timeoutMs: number, signal?: AbortSignal): Promise<DecodeOutcome> {
  return new Promise((resolve) => {
    const finish = (outcome: DecodeOutcome): void => {
      clearTimeout(timer);
      img.removeEventListener('error', onError);
      img.removeEventListener('load', onLoad);
      signal?.removeEventListener('abort', onAbort);
      resolve(outcome);
    };
    const onError = (): void => finish({ kind: 'failed' });
    const onLoad = (): void => finish({ kind: 'ok' });
    const onAbort = (): void => finish({ kind: 'aborted' });
    img.addEventListener('error', onError);
    img.addEventListener('load', onLoad);
    signal?.addEventListener('abort', onAbort);
    const timer = setTimeout(() => finish({ kind: 'timeout' }), timeoutMs);
    if (signal?.aborted) {
      finish({ kind: 'aborted' });
      return;
    }
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
  // 第 5 参 ctx 不读（非 streaming 渲染器）；第 6 参 opts.signal 审计 R1 I-1：
  // 解码 await 窗取消快速失败（见 observeImageDecode doc）
  async render(buffer, target, source, det, _ctx, opts) {
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
      : await observeImageDecode(img, IMAGE_DECODE_TIMEOUT_MS, opts?.signal);
    // 审计 R1 I-1：解码窗内取消——revoke 后以 abortReadError 身份快速失败，经
    // dispatch catch 的 abort 分类 no-op 不上屏（迟到落定不再覆写/污染新渲染）
    if (outcome.kind === 'aborted') {
      URL.revokeObjectURL(url);
      throw abortReadError();
    }
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
    // 评审 R1：destroy 后 revoke 会中止在途加载并触发 img 迟到 error——实例已销毁
    // 时不得再把兜底卡打进 target（可能覆盖 dispatcher 刚挂载的新渲染内容）
    let destroyed = false;
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
        if (cardShown || destroyed) return;
        cardShown = true;
        detach();
        detachImage();
        showErrorCard(target, '图片解码失败：数据损坏或格式不支持', source, { actions: buildActions() });
      });
    }
    // BUG-04（SHELL-12 验收）：图片状态栏/属性面板至少含大小与编码——det.encoding
    // 为本地启发式的检测结果（服务端 x-vv-encoding 仅入 remoteMeta 供 code 渲染器
    // 纠偏，不达此处），ViewerPane 按 'getMeta' in 探测；BUG-32：二进制媒体的
    // det.encoding 为 undefined（编码检测对二进制无意义），消费方对 undefined 隐藏
    // 「编码」段——「至少含编码」语义由「文本媒体恒有、二进制媒体合理省略」取代
    const instance: RenderedInstance & { getMeta(): { size: number; encoding?: Encoding } } = {
      getMeta: () => ({ size: buffer.length, encoding: det.encoding }),
      destroy() {
        destroyed = true;
        detach();
        detachImage();
        liveChild?.destroy();
      }
    };
    return instance;
  }
};
