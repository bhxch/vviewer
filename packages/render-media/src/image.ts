import type { Encoding, RenderedInstance, Renderer } from '@vviewer/core';

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
    wrap.append(img);
    target.replaceChildren(wrap);
    const detach = attachZoom(wrap, img);
    // BUG-04（SHELL-12 验收）：图片状态栏/属性面板至少含大小与编码——det.encoding
    // 为服务端 x-vv-encoding 或本地启发式的检测结果，ViewerPane 按 'getMeta' in 探测
    const instance: RenderedInstance & { getMeta(): { size: number; encoding?: Encoding } } = {
      getMeta: () => ({ size: buffer.length, encoding: det.encoding }),
      destroy() {
        detach();
        URL.revokeObjectURL(url);
        wrap.remove();
      }
    };
    return instance;
  }
};
