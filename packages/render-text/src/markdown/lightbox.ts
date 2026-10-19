// lightbox.ts — markdown 灯箱（body 级单例 overlay）：画廊导航 + 键盘集 + 缩放平移。
// 自 pipeline.ts 迁出（Task 1）：三导出（LIGHTBOX_OVERLAY_ID / LIGHTBOX_OWNER_ATTR /
// removeLightboxOverlay）语义原样，pipeline.ts re-export 保持 markdownRenderer 与既有
// 测试的 import 面不变；本模块对 pipeline 只剩类型依赖（编译期擦除，无运行时环）。
// - 状态机纯函数（clampZoom/zoomAt/navigate）单测直测：zoomAt 光标中心锚定——
//   屏幕点 p = 内容点 c × zoom + t（stage transform-origin 0 0 同构），令光标处
//   缩放前后 p 不变解出 t' = (cx,cy) − applied × ((cx,cy) − t)。
// - 关闭语义（T1 裁决）：点背景（overlay 本体/stage 空白）或关闭钮关；点内容与
//   控制件不关——比原「点 overlay 任意处关」多一层 target 判定，原有语义测试
//   （overlay.click()）不受影响。
// - 拖拽 pan 与关闭的冲突（T2 裁决）：拖拽位移超阈值置 dragMoved，吞掉 mouseup
//   后收尾的 click（该 click 经冒泡会落在 overlay 上，否则拖完即误关）。

import type { PipelineCtx } from './pipeline';

/** body 级灯箱 overlay 的元素 id（openLightbox 创建；markdownRenderer destroy 时清理防泄漏） */
export const LIGHTBOX_OVERLAY_ID = 'md-lightbox-overlay';

/** overlay 上的打开者代币属性（openLightbox 写入、removeLightboxOverlay 校验，遗留 U3） */
export const LIGHTBOX_OWNER_ATTR = 'data-md-lightbox-owner';

/** 画廊条目：img 取 src/alt；svg（图表视图）取 outerHTML（alt 空）。 */
export interface GalleryItem {
  type: 'img' | 'svg';
  src: string;
  alt: string;
}

/** 视图状态：zoom 缩放、tx/ty 平移（overlay 坐标系，stage origin 0 0）、index 画廊位置。 */
export interface LightboxState {
  zoom: number;
  tx: number;
  ty: number;
  index: number;
}

/** 缩放限幅：下限 0.2 防缩没、上限 8 防性能塌方。 */
export function clampZoom(zoom: number): number {
  return Math.min(8, Math.max(0.2, zoom));
}

/** 光标中心锚定缩放：缩放后光标下内容点保持原屏幕位置（推导见文件头）。 */
export function zoomAt(state: LightboxState, factor: number, cx: number, cy: number): LightboxState {
  const zoom = clampZoom(state.zoom * factor);
  const applied = zoom / state.zoom;
  return { zoom, tx: cx - applied * (cx - state.tx), ty: cy - applied * (cy - state.ty), index: state.index };
}

/** 画廊导航（index 环绕）：count 非正不挪。 */
export function navigate(state: { index: number; count: number }, delta: number): { index: number } {
  if (state.count <= 0) return { index: state.index };
  return { index: ((state.index + delta) % state.count + state.count) % state.count };
}

/**
 * 收集渲染根下的画廊条目（文档序：img 在前、图表 svg 在后）：img 跳过两类——
 * 宽高属性均在且均 <32px 的微缩图（图标/表情）、KaTeX 排版产物内的 img；图表
 * 视图（.md-diagram-view）内的 svg 整体入列（src 记 outerHTML 供灯箱回放）。
 */
export function collectGallery(root: ParentNode): GalleryItem[] {
  const items: GalleryItem[] = [];
  for (const img of Array.from(root.querySelectorAll('img'))) {
    if (img.closest('.katex')) continue;
    // 宽高属性均在且均 <32 才跳过；属性缺失（Number(null)=0）不得误判——常规文档图无宽高属性
    const wAttr = img.getAttribute('width');
    const hAttr = img.getAttribute('height');
    if (wAttr !== null && hAttr !== null && Number(wAttr) < 32 && Number(hAttr) < 32) continue;
    items.push({ type: 'img', src: img.getAttribute('src') ?? '', alt: img.getAttribute('alt') ?? '' });
  }
  for (const svg of Array.from(root.querySelectorAll('.md-diagram-view svg'))) {
    items.push({ type: 'svg', src: svg.outerHTML, alt: '' });
  }
  return items;
}

// ---------- DOM 装配 ----------

/** 灯箱元素类名（与 pipeline 的 CLS 同构：可被 ctx.themeClassPrefix 前缀供主题作用域）。 */
const CLS = {
  lightbox: 'md-lightbox',
  lightboxOverlay: 'md-lightbox-overlay',
  stage: 'md-lightbox-stage',
  svgHost: 'md-lightbox-svg',
  bar: 'md-lightbox-bar',
  btn: 'md-lightbox-btn',
  btnPrev: 'md-lightbox-btn-prev',
  btnNext: 'md-lightbox-btn-next',
  btnZoomIn: 'md-lightbox-btn-zoom-in',
  btnZoomOut: 'md-lightbox-btn-zoom-out',
  btnReset: 'md-lightbox-btn-reset',
  btnClose: 'md-lightbox-btn-close',
  count: 'md-lightbox-count',
  dragging: 'md-lightbox-dragging',
} as const;

function cls(ctx: PipelineCtx, base: keyof typeof CLS): string {
  const name = CLS[base];
  return ctx.themeClassPrefix ? ctx.themeClassPrefix + name : name;
}

/** overlay → 其 document 级键盘监听（removeLightboxOverlay / 关闭时随之摘除，防监听器累积） */
const escHandlers = new WeakMap<HTMLElement, (ev: KeyboardEvent) => void>();

/** overlay → 其打开函数（复用单例时取回闭包状态；随元素由 WeakMap 回收） */
const openers = new WeakMap<HTMLElement, (items: GalleryItem[], index: number) => void>();

/** 缩放步进（键盘/滚轮/按钮同规） */
const ZOOM_STEP = 1.25;

/** 拖拽位移超过该值（Manhattan 距离，px）才算真拖拽：吞掉收尾 click 防拖完误关 */
const DRAG_THRESHOLD = 3;

/**
 * 从文档移除灯箱 overlay（markdownRenderer destroy 调用；overlay 挂在 body，不随渲染节点销毁）。
 * ownerId 传时校验打开者代币：非当前 owner 的 destroy 直接跳过（多 markdown 实例
 * 共存时互删对方正开着的灯箱，遗留 U3）；不传（Esc / overlay 点击等自有关场景）
 * 行为不变，无条件移除。
 */
export function removeLightboxOverlay(doc: Document, ownerId?: string): void {
  const overlay = doc.getElementById(LIGHTBOX_OVERLAY_ID);
  if (!overlay) return;
  if (ownerId !== undefined && overlay.getAttribute(LIGHTBOX_OWNER_ATTR) !== ownerId) return;
  const onKey = escHandlers.get(overlay);
  if (onKey) doc.removeEventListener('keydown', onKey);
  escHandlers.delete(overlay);
  overlay.remove();
}

/**
 * 点击图打开灯箱：定位到该图在画廊中的位置（未命中——微缩图/KaTeX 内 img 等被
 * 收集规则跳过——退化为单条画廊）。gallery 由调用方（runLightbox）点击时对渲染根
 * 收集：同一文档内的 img 与图表 svg 可在灯箱内 ←/→ 连续导航。
 */
export function openLightbox(img: HTMLImageElement, ctx: PipelineCtx, gallery: GalleryItem[]): void {
  const doc = img.ownerDocument;
  // body 级单例：首次点击创建，之后所有图共用
  let overlay = doc.getElementById(LIGHTBOX_OVERLAY_ID);
  if (!overlay) {
    const built = buildOverlay(doc, ctx);
    overlay = built.overlay;
    openers.set(overlay, built.open);
  }
  const src = img.getAttribute('src') ?? '';
  const idx = gallery.findIndex((it) => it.type === 'img' && it.src === src);
  const items = idx === -1 ? [{ type: 'img' as const, src, alt: img.getAttribute('alt') ?? '' }] : gallery;
  const open = openers.get(overlay);
  if (!open) {
    // 防御（不裸非空断言）：同 id 陌生元素（外部 DOM 注入/序列化恢复等理论路径）
    // 无打开表项——不复用不重建，按脏状态移除，下次点击走全新构建
    removeLightboxOverlay(doc);
    return;
  }
  open(items, idx === -1 ? 0 : idx);
  // 最后打开者即 owner（覆盖旧记号）：其后仅 owner 的 destroy 可随生命周期摘除（U3）。
  // 注意须在此处写（而非 buildOverlay 闭包）：复用单例时归属跟随本次打开者的 ctx。
  overlay.setAttribute(LIGHTBOX_OWNER_ATTR, ctx.lightboxOwner ?? '');
}

/**
 * 构造 overlay DOM 并接线全部交互，挂入 doc.body，返回 { overlay, open }：
 * open(items, index) 装载画廊条目并复位视图。闭包持有可变状态（items/state），
 * 单 overlay 一份——多 document（多 markdown 实例）互不串扰。
 */
function buildOverlay(doc: Document, ctx: PipelineCtx): { overlay: HTMLElement; open: (items: GalleryItem[], index: number) => void } {
  let items: GalleryItem[] = [];
  let state: LightboxState = { zoom: 1, tx: 0, ty: 0, index: 0 };
  let dragMoved = false;

  const overlay = doc.createElement('div');
  overlay.id = LIGHTBOX_OVERLAY_ID;
  overlay.className = cls(ctx, 'lightboxOverlay');

  // 内容容器（stage）：缩放平移的变换面，absolute 铺满 overlay 使其坐标系与
  // zoomAt 的光标坐标同系（CSS transform-origin: 0 0）
  const stage = doc.createElement('div');
  stage.className = cls(ctx, 'stage');
  const clone = doc.createElement('img');
  clone.className = cls(ctx, 'lightbox');
  const svgHost = doc.createElement('div');
  svgHost.className = cls(ctx, 'svgHost');
  svgHost.setAttribute('hidden', '');
  stage.append(clone, svgHost);

  // 控制件条：prev/next/计数 + 缩放钮组 + 关闭
  const bar = doc.createElement('div');
  bar.className = cls(ctx, 'bar');
  const count = doc.createElement('span');
  count.className = cls(ctx, 'count');

  const applyState = (): void => {
    stage.style.transform = `translate(${state.tx}px, ${state.ty}px) scale(${state.zoom})`;
    count.textContent = `${state.index + 1}/${items.length}`;
  };

  /** 按当前 index 渲染条目内容（img 换 src/alt；svg 注入 outerHTML），切换两宿主显隐。 */
  const showItem = (): void => {
    const item = items[state.index]!;
    if (item.type === 'img') {
      clone.setAttribute('src', item.src);
      clone.setAttribute('alt', item.alt);
      clone.removeAttribute('hidden');
      svgHost.setAttribute('hidden', '');
    } else {
      svgHost.innerHTML = item.src;
      svgHost.removeAttribute('hidden');
      clone.setAttribute('hidden', '');
    }
  };

  const resetView = (): void => {
    state = { zoom: 1, tx: 0, ty: 0, index: state.index };
    applyState();
  };

  const centerZoom = (factor: number): void => {
    state = zoomAt(state, factor, overlay.clientWidth / 2, overlay.clientHeight / 2);
    applyState();
  };

  /** 环绕导航：内容切换且视图复位（新图从 1:1 看起）。 */
  const go = (delta: number): void => {
    state = { zoom: 1, tx: 0, ty: 0, index: navigate({ index: state.index, count: items.length }, delta).index };
    showItem();
    applyState();
  };

  const mkBtn = (base: keyof typeof CLS, glyph: string, label: string, onClick: () => void): HTMLButtonElement => {
    const b = doc.createElement('button');
    b.type = 'button';
    b.className = `${cls(ctx, 'btn')} ${cls(ctx, base)}`;
    b.textContent = glyph;
    b.setAttribute('aria-label', label);
    b.addEventListener('click', onClick);
    return b;
  };
  const prev = mkBtn('btnPrev', '‹', '上一张', () => go(-1));
  const next = mkBtn('btnNext', '›', '下一张', () => go(1));
  const zoomOut = mkBtn('btnZoomOut', '−', '缩小', () => centerZoom(1 / ZOOM_STEP));
  const zoomIn = mkBtn('btnZoomIn', '+', '放大', () => centerZoom(ZOOM_STEP));
  const reset = mkBtn('btnReset', '⟲', '重置视图', resetView);
  const closeBtn = mkBtn('btnClose', '×', '关闭', () => removeLightboxOverlay(doc));
  bar.append(prev, next, count, zoomOut, zoomIn, reset, closeBtn);
  overlay.append(stage, bar);

  // 键盘集（document 级，escHandlers 既有模式：关闭随之摘除防监听器累积）
  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key === 'Escape') removeLightboxOverlay(doc);
    else if (ev.key === 'ArrowRight') { ev.preventDefault(); go(1); }
    else if (ev.key === 'ArrowLeft') { ev.preventDefault(); go(-1); }
    else if (ev.key === '+' || ev.key === '=') centerZoom(ZOOM_STEP);
    else if (ev.key === '-') centerZoom(1 / ZOOM_STEP);
    else if (ev.key === 'r' || ev.key === 'f') resetView();
  };
  escHandlers.set(overlay, onKey);
  doc.addEventListener('keydown', onKey);

  // 点击关闭：仅背景（overlay 本体/stage 空白）；内容与控制件不关（T1 裁决）
  overlay.addEventListener('click', (ev) => {
    if (dragMoved) { dragMoved = false; return; } // 拖拽收尾 click 吞掉，不误关（T2 裁决）
    if (ev.target === overlay || ev.target === stage) removeLightboxOverlay(doc);
  });

  // 滚轮缩放（光标中心锚定）：preventDefault 防 overlay 之下页面滚动
  overlay.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const rect = overlay.getBoundingClientRect();
    state = zoomAt(state, ev.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP, ev.clientX - rect.left, ev.clientY - rect.top);
    applyState();
  }, { passive: false });

  // 拖拽平移：mousedown 记起点与基准位移，document 级 mousemove 增量写 tx/ty（按下
  // 态才挂监听），mouseup 收监听；位移超阈值置 dragMoved（恒允许 pan，zoom=1 时
  // 拖动即平移、无边界回弹——实现取简）
  stage.addEventListener('mousedown', (ev) => {
    if (ev.button !== 0) return;
    ev.preventDefault(); // 防原生 img 拖拽与选中
    dragMoved = false;
    const startX = ev.clientX;
    const startY = ev.clientY;
    const base = { tx: state.tx, ty: state.ty };
    const onMove = (me: MouseEvent): void => {
      const dx = me.clientX - startX;
      const dy = me.clientY - startY;
      if (Math.abs(dx) + Math.abs(dy) > DRAG_THRESHOLD) dragMoved = true;
      state = { ...state, tx: base.tx + dx, ty: base.ty + dy };
      applyState();
    };
    const onUp = (): void => {
      stage.classList.remove(cls(ctx, 'dragging'));
      doc.removeEventListener('mousemove', onMove);
      doc.removeEventListener('mouseup', onUp);
    };
    stage.classList.add(cls(ctx, 'dragging'));
    doc.addEventListener('mousemove', onMove);
    doc.addEventListener('mouseup', onUp);
  });

  // HTML5 原生拖拽与指针平移冲突，禁掉
  stage.addEventListener('dragstart', (ev) => ev.preventDefault());

  (doc.body ?? doc.documentElement).appendChild(overlay);

  return {
    overlay,
    open(nextItems, index) {
      items = nextItems;
      state = { zoom: 1, tx: 0, ty: 0, index };
      dragMoved = false; // 跨打开不复用旧拖拽态：重开后的首个 click 按正常语义判定
      const multi = items.length > 1;
      prev.toggleAttribute('hidden', !multi);
      next.toggleAttribute('hidden', !multi);
      count.toggleAttribute('hidden', !multi);
      showItem();
      applyState();
    },
  };
}
