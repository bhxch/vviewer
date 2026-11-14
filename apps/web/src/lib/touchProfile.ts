/**
 * touchProfile 纯逻辑层（spec B §3.1，Task 2）：触屏档案生效判定——不依赖 DOM
 * 与响应式状态，可被 vitest 直测。runes 单例（探测初始化 / dataset 单写点 /
 * 设置同步）在 touchProfile.svelte.ts，本模块只承载公式与枚举消费。
 */
import { type TouchMode } from './layout';

/** 生效判定（spec B §3.1 拍板公式）：auto = (any-pointer:coarse) 且 maxTouchPoints>0
 * （落定用 any-pointer——触屏笔记本 primary pointer fine 不漏报）；touch 恒 true
 * （fine pointer 强启，spec §3.4）；desktop 恒 false（coarse 在场回收常显）。 */
export function resolveTouchActive(mode: TouchMode, coarse: boolean, touchPoints: number): boolean {
  if (mode === 'touch') return true;
  if (mode === 'desktop') return false;
  return coarse && touchPoints > 0;
}
