import { abortReadError, getHexFallbackRenderer, showErrorCard, type Encoding, type ErrorCardAction, type RenderedInstance, type Renderer } from '@bhxch/vviewer-core';

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

/** 缩放范围（滚轮/捏合同规）：下限 0.1、上限 10 */
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 10;

/** 指针位移超过该值（Manhattan 距离，px）视为拖动：拖动收尾凑成的 dblclick 不复位 */
const DRAG_THRESHOLD = 3;

interface Point {
  x: number;
  y: number;
}

const midpoint = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/**
 * 缩放平移交互（布局缩放 + 容器滚动）：
 * - 缩放改 img 的 width/height（基准为 naturalWidth/Height；SVG 无固有尺寸时取 zoom=1
 *   的布局尺寸），容器滚动区随之增长——放大后整幅图任意区域都能滚到/拖到，且溢出
 *   恒从左上起，不出现左/上侧溢出不可达（原 transform: scale 不改布局尺寸，放大部分
 *   无从平移）。宿主 CSS 契约（app.css .vv-image）：容器 flex + overflow:auto，img
 *   flex:none + margin:auto——小图居中，溢出时 auto margin 归零从左上起可滚。
 * - 平移即改容器 scrollLeft/scrollTop；锚点缩放前后各取一次 img 实际布局矩形（居中
 *   margin、滚动条增减均已计入），差值补偿到滚动，令锚点下像素不动。
 * - Pointer Events 统一鼠标/触屏/笔：单指针拖动平移；双指针以两指中点为锚捏合缩放
 *   并随中点平移；滚轮以光标为锚缩放；双击复位。
 * - 防原生行为抢手势：容器 touch-action:none / user-select:none 在宿主 CSS（否则浏览器
 *   原生滚动/缩放与自定义手势竞争并以 pointercancel 打断）；此处 img draggable=false
 *   并拦 dragstart（原生图片拖拽会吃掉鼠标拖动）。
 * 当前倍率写入 img 的 data-vv-zoom（e2e 读数面：布局尺寸经 CSS 序列化有舍入，不宜
 * 反推倍率）。返回 detach：摘除全部监听。
 */
function attachZoom(container: HTMLElement, img: HTMLImageElement): () => void {
  let zoom = 1; // 每实例独立，避免多图共享状态互相污染
  let base: { w: number; h: number } | null = null;
  /** 活动指针 → 最近位置（Map 插入序即按下序，捏合取前两个） */
  const pointers = new Map<number, Point>();
  /** 本次手势首指按下点与是否越过拖动阈值（dblclick 守卫） */
  let downAt: Point = { x: 0, y: 0 };
  let moved = false;

  img.draggable = false;
  img.dataset.vvZoom = '1';

  /** zoom=1 基准尺寸：首次缩放时测定并缓存；图片未就绪（尺寸全 0）返回 null 不缩放 */
  const measureBase = (): { w: number; h: number } | null => {
    if (base) return base;
    let w = img.naturalWidth;
    let h = img.naturalHeight;
    if (!(w > 0 && h > 0)) {
      // SVG 无固有尺寸：首次缩放前 img 未写尺寸，当前布局尺寸即 zoom=1 尺寸
      const r = img.getBoundingClientRect();
      w = r.width;
      h = r.height;
    }
    if (w > 0 && h > 0) base = { w, h };
    return base;
  };

  /** cursor：可平移时 grab、拖动中 grabbing、不可平移不设（随缩放/指针/容器尺寸变化同步） */
  const syncCursor = (): void => {
    const pannable = container.scrollWidth > container.clientWidth || container.scrollHeight > container.clientHeight;
    const next = !pannable ? '' : pointers.size > 0 ? 'grabbing' : 'grab';
    if (container.style.cursor !== next) container.style.cursor = next;
  };

  /**
   * 缩放到 next，并令缩放前视口点 from 下的图像像素落到视口点 to：滚轮 from=to=光标；
   * 捏合 from/to 为前后两帧两指中点（缩放与平移一步完成）。
   */
  const zoomAround = (next: number, from: Point, to: Point): void => {
    const b = measureBase();
    if (!b) return;
    const before = img.getBoundingClientRect();
    if (!(before.width > 0 && before.height > 0)) return; // 容器隐藏等无布局态
    const u = (from.x - before.left) / before.width;
    const v = (from.y - before.top) / before.height;
    zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next));
    img.style.width = `${b.w * zoom}px`;
    img.style.height = `${b.h * zoom}px`;
    img.dataset.vvZoom = String(zoom);
    const after = img.getBoundingClientRect();
    container.scrollLeft += after.left + u * after.width - to.x;
    container.scrollTop += after.top + v * after.height - to.y;
    syncCursor();
  };

  const onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const at = { x: e.clientX, y: e.clientY };
    zoomAround(zoom * (e.deltaY < 0 ? 1.1 : 0.9), at, at);
  };

  /** 按在容器自身的经典滚动条上（目标为容器且落在客户区外；覆盖式滚动条不占客户区外，恒 false） */
  const onScrollbar = (e: PointerEvent): boolean => {
    if (e.target !== container) return false;
    const r = container.getBoundingClientRect();
    return e.clientX - r.left - container.clientLeft >= container.clientWidth
      || e.clientY - r.top - container.clientTop >= container.clientHeight;
  };

  const onDown = (e: PointerEvent): void => {
    if (e.pointerType === 'mouse' && e.button !== 0) return; // 鼠标仅主键拖动（中键/右键原生行为照常）
    if (onScrollbar(e)) return; // 滚动条保留原生拖动：起平移会与之反向互搏
    try {
      // 捕获：拖出容器乃至窗口仍持续收到 move/up
      container.setPointerCapture(e.pointerId);
    } catch {
      // jsdom 未实现 / 合成事件无活动指针时抛错：不捕获，容器内拖动照常
    }
    if (pointers.size === 0) {
      downAt = { x: e.clientX, y: e.clientY };
      moved = false;
    }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    syncCursor();
  };

  const onMove = (e: PointerEvent): void => {
    const prev = pointers.get(e.pointerId);
    if (!prev) return;
    const cur = { x: e.clientX, y: e.clientY };
    if (pointers.size === 1) {
      // 单指针平移：增量跟手（图随指针移动 = 滚动反向）
      pointers.set(e.pointerId, cur);
      if (Math.abs(cur.x - downAt.x) + Math.abs(cur.y - downAt.y) > DRAG_THRESHOLD) moved = true;
      container.scrollLeft -= cur.x - prev.x;
      container.scrollTop -= cur.y - prev.y;
      return;
    }
    // 双指针捏合：仅按下序前两个指针参与（第三指起只记位置）
    const [a0, b0] = [...pointers.values()];
    pointers.set(e.pointerId, cur);
    const [a1, b1] = [...pointers.values()];
    if (!a0 || !b0 || !a1 || !b1 || (a0 === a1 && b0 === b1)) return;
    moved = true;
    const d0 = Math.hypot(b0.x - a0.x, b0.y - a0.y);
    const d1 = Math.hypot(b1.x - a1.x, b1.y - a1.y);
    zoomAround(d0 > 0 ? zoom * (d1 / d0) : zoom, midpoint(a0, b0), midpoint(a1, b1));
  };

  // 抬起/取消：剩余指针按其最近位置接续（捏合抬一指转单指平移，增量跟手无跳变）
  const onUp = (e: PointerEvent): void => {
    if (pointers.delete(e.pointerId)) syncCursor();
  };

  const onDbl = (): void => {
    if (moved) return; // 拖动收尾凑成的双击不复位
    zoom = 1;
    img.style.width = '';
    img.style.height = '';
    img.dataset.vvZoom = '1';
    container.scrollLeft = 0;
    container.scrollTop = 0;
    syncCursor();
  };

  const onDragStart = (e: Event): void => e.preventDefault();

  container.addEventListener('wheel', onWheel, { passive: false });
  container.addEventListener('pointerdown', onDown);
  container.addEventListener('pointermove', onMove);
  container.addEventListener('pointerup', onUp);
  container.addEventListener('pointercancel', onUp);
  container.addEventListener('pointerenter', syncCursor); // 容器尺寸可能已变（窗口/分栏调整）
  container.addEventListener('dblclick', onDbl);
  container.addEventListener('dragstart', onDragStart);
  img.addEventListener('load', syncCursor); // SVG 不等解码、超时放行的 raster 迟到加载
  syncCursor();
  return () => {
    container.removeEventListener('wheel', onWheel);
    container.removeEventListener('pointerdown', onDown);
    container.removeEventListener('pointermove', onMove);
    container.removeEventListener('pointerup', onUp);
    container.removeEventListener('pointercancel', onUp);
    container.removeEventListener('pointerenter', syncCursor);
    container.removeEventListener('dblclick', onDbl);
    container.removeEventListener('dragstart', onDragStart);
    img.removeEventListener('load', syncCursor);
    pointers.clear();
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
