/**
 * touchProfile runes 单例（spec B §3.1，Task 2）：触屏档案的响应式状态域——
 * mode 由 syncTouchProfile 从 settings.layout.touchMode 同步（字段单源 layout 节，
 * spec B Task 1）；coarse/touchPoints 由 matchMedia 探测初始化；applyTouchDataset
 * 是 html[data-touch] 的唯一写函数。iconTheme.svelte.ts 单例先例形态。
 */
// resolveTouchActive 在本任务新建的 ./touchProfile（规划评审 F4 订正：原片段误写
// from './layout'——layout.ts 不导出该函数，照抄 typecheck 即红）；TouchMode 类型
// 单源在 ./layout（touchProfile.ts 不 re-export）。
import { resolveTouchActive } from './touchProfile';
import type { TouchMode } from './layout';
import type { Settings } from './stores/settings';

/** 触屏档案单例（spec B §3.1）：mode 由 syncTouchProfile 从 settings.layout.touchMode
 * 同步（落定归 layout 节）；coarse/touchPoints 由 matchMedia 探测初始化。 */
export const touchProfileState = $state<{ mode: TouchMode; coarse: boolean; touchPoints: number }>({
  mode: 'auto',
  coarse: false,
  touchPoints: 0
});

export function isTouchActive(): boolean {
  return resolveTouchActive(touchProfileState.mode, touchProfileState.coarse, touchProfileState.touchPoints);
}

let probeStarted = false;
/** matchMedia 探测初始化（幂等；SSR/jsdom 无 matchMedia 空转——theme.ts:292
 * onSystemModeChange 守卫先例）：any-pointer:coarse 单查询（落定 any-pointer——
 * 触屏笔记本 primary fine 不漏报，spec §3.1）；change 监听承担外接键鼠切换热更新
 * （maxTouchPoints 无事件面，随 change 同步重读，热插拔残余误差备案记档）。 */
export function initTouchProfileProbe(): void {
  if (probeStarted || typeof window === 'undefined' || typeof matchMedia === 'undefined') return;
  probeStarted = true;
  const mq = matchMedia('(any-pointer: coarse)');
  const sync = (): void => {
    touchProfileState.coarse = mq.matches;
    touchProfileState.touchPoints = navigator.maxTouchPoints;
  };
  sync();
  mq.addEventListener('change', sync);
}

/** html[data-touch] 单写点（Review Focus 1）：on='on'，off 删属性——reduceMotion
 * 双态口径（AppShell applyLocaleAndReduceMotion 'system' 移除属性同款）。SSR 无
 * document 空转（applyLocaleAndReduceMotion 守卫先例）。 */
export function applyTouchDataset(): void {
  if (typeof document === 'undefined') return;
  if (isTouchActive()) document.documentElement.dataset.touch = 'on';
  else delete document.documentElement.dataset.touch;
}

/** 设置→档案同步（AppShell 启动+订阅双通道；layout.touchMode 单源）。 */
export function syncTouchProfile(s: Settings): void {
  touchProfileState.mode = s.layout.touchMode;
}
