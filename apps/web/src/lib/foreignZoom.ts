// foreignZoom.ts — foreign 渲染器 ctrl+wheel 缩放接线（zoom provider 宿主消费面）。
// 背景（根因，2026-11-10）：@file-viewer 渲染器把缩放能力注册为 zoom provider（core
// registerFileViewerZoomProvider：WeakMap + `__flyfishViewerZoomProvider` +
// `[data-viewer-zoom-provider]`，契约 {zoomIn/zoomOut/resetZoom/setZoom?/fit?/
// getState/subscribe?}，contracts/types.d.ts FileViewerZoomProvider）——provider
// 本身不接任何事件，事件面（工具栏/快捷键/滚轮）由宿主自行驱动（上游 flyfish 宿主
// 如此）。vviewer 桥接此前零消费 ⇒ ctrl+滚轮落到浏览器默认整页缩放（缩放的是整个
// vviewer UI 而非文档内容）——「excel 渲染器对 ctrl+滚轮缩放支持不佳」的根因。
//
// 设计（通盘对照 spreadsheet 渲染器内部缩放实现，dist/spreadsheet.js 实读）：
// 1. 乘性连续缩放：setZoom(scale×factor)，factor=exp(-px/1000)——鼠标一格
//    （|Δ|≈100-120px）≈±10-11%，与上游 zoomIn/zoomOut 的 ±0.1 档同量级；触控板
//    捏合（小 delta 连发）天然平滑。内部 clampZoom 收 2 位小数（0.25–2.5），连续值
//    安全。渲染器内部为「内容重排式」缩放（scalePx 重算行高列宽→syncTableLayout
//    全量 doLayout+draw），setZoom 一次=一次全量重布局——wheel 高频事件必须按帧
//    合并（乘性累积，一帧恰一次 setZoom），否则滚动一波触发几十次全量重绘必卡。
// 2. 边界钳制：getState 的 minScale/maxScale（契约可选字段）在宿主侧钳；钳后与当前
//    scale 相等即 no-op 跳过 setZoom——上游 setZoom 恒做全量重布局，越界重绘纯属
//    浪费。provider 自身不报告 min/max 时信任其内部 clamp（spreadsheet clampZoom
//    如此）。
// 3. setZoom 缺席兜底：契约 setZoom 可选——按累积方向回退 zoomIn/zoomOut 档步
//    （一帧至多一档；presently 无缺 setZoom 的渲染器，纯契约完备性兜底）。
// 4. 滚动锚定不做：provider 不暴露滚动读取面（e-virt-table 的 ctx.scrollX/Y 为渲染
//    器内部虚拟滚动状态，宿主不可达）——zoom 后 px 滚动位置保持原值（视觉内容漂移），
//    与上游 zoomIn/zoomOut 行为一致，记档为已知边界。
// 5. preventDefault 恒发（ctrl+wheel 时）：即使处于 min/max 边界也不放行——放行使
//    浏览器整页缩放启动，出现「表格不动、整个 UI 缩放」的混合态。触控板捏合手势在
//    Chromium 同发 ctrlKey wheel，同一通道收敛。
// 6. 非 ctrl wheel 零干预：不挂 preventDefault、不缩放——表格/文档的自滚动、触控板
//    双指滚动照常。
//
// 生命周期（mount 期接线，foreignRenderers pluginMount mountBody 调用）：provider
// 发现走 core findFileViewerZoomProvider（target 内含 shadow DOM 扫描）——本模块只
// 收 provider 实例，不依赖 @file-viewer/core（装配层单源 import，本模块零依赖可
// vitest 直测）。同 target 重渲染（错误卡重试/open-as 换渲染器）幂等：WeakMap 登记
// 现役 detach，新接线先摘旧；destroy 路径同样经 detach 摘除（listener/rAF 双清）。
export interface ForeignZoomProvider {
  zoomIn: () => unknown;
  zoomOut: () => unknown;
  setZoom?: (scale: number) => unknown;
  getState: () => {
    scale: number;
    minScale?: number;
    maxScale?: number;
  };
}

/** 现役接线表（key=mount target）：同 target 重渲染先摘旧，destroy 摘除幂等。 */
const wiringByTarget = new WeakMap<HTMLElement, () => void>();

/** 帧 dispatcher：优先 rAF（视觉对齐），无 rAF 环境回落 16ms 定时器（jsdom 等）。 */
function scheduleFrame(view: Window | null, cb: () => void): () => void {
  if (view && typeof view.requestAnimationFrame === 'function') {
    const frame = view.requestAnimationFrame(() => cb());
    return () => view.cancelAnimationFrame(frame);
  }
  const timer = setTimeout(cb, 16);
  return () => clearTimeout(timer);
}

/**
 * 在 target 上接 ctrl+wheel → provider 驱动。返回 detach（幂等：重复调用无副作用）。
 * 无 provider 宿主的渲染器由装配层短路（不调本函数），零监听零干预。
 */
export function wireForeignZoom(target: HTMLElement, provider: ForeignZoomProvider): () => void {
  wiringByTarget.get(target)?.(); // 重渲染同 target：先摘旧（listener/rAF 双清）
  const view = target.ownerDocument.defaultView;

  let frameCancel: (() => void) | null = null;
  let pendingFactor = 1; // 本帧累积乘性（1=无累积；帧应用后复位）

  const applyFrame = (): void => {
    frameCancel = null;
    const factor = pendingFactor;
    pendingFactor = 1;
    if (factor === 1) return;
    try {
      const state = provider.getState();
      const zoomIn = factor > 1;
      if (typeof provider.setZoom !== 'function') {
        // 契约兜底：setZoom 缺席按方向走档步（一帧至多一档）
        if (zoomIn) provider.zoomIn();
        else provider.zoomOut();
        return;
      }
      let next = state.scale * factor;
      if (state.minScale !== undefined) next = Math.max(state.minScale, next);
      if (state.maxScale !== undefined) next = Math.min(state.maxScale, next);
      if (next === state.scale) return; // 越界钳到当前值：no-op 跳过（省全量重布局）
      provider.setZoom(next);
    } catch (error) {
      // provider 异常不毒化接线（渲染器内部错误自有错误面）——记录后照常续帧
      console.error('[vviewer] foreign zoom provider 调用失败', error);
    }
  };

  const onWheel = (e: Event): void => {
    if (!(e instanceof WheelEvent) || !e.ctrlKey) return; // 非 ctrl 通道零干预
    e.preventDefault(); // 阻断浏览器整页缩放（边界态同样拦，见注 5）
    // deltaMode 归一为 px（tabScroll dominantWheelDelta 同约定：1 行=16px；
    // 2=页按 400px 经验值——现实输入设备几乎不产生 mode 2，纯完备兜底）
    const raw = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
    if (!Number.isFinite(raw) || raw === 0) return;
    pendingFactor *= Math.exp(-raw / 1000);
    if (frameCancel === null) frameCancel = scheduleFrame(view, applyFrame);
  };

  target.addEventListener('wheel', onWheel, { passive: false });

  const detach = (): void => {
    if (wiringByTarget.get(target) !== detach) return; // 已被新接线顶替/已摘除
    wiringByTarget.delete(target);
    target.removeEventListener('wheel', onWheel);
    frameCancel?.();
    frameCancel = null;
    pendingFactor = 1;
  };
  wiringByTarget.set(target, detach);
  return detach;
}
