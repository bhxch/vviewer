// shellDrawers.test.ts — 移动端双抽屉开合状态机（FE-2 自 AppShell.svelte 抽出的
// 纯模块）直测：锁定双抽屉独立开合（e937d05 钉死的产品语义）、BUG-61 抽屉断点
// 点树自动收左抽屉（右抽屉不联动）、语言轻入口手机断点置位开右抽屉。断点门
// （matchMedia）由 AppShell 求值传入，本测试直接以布尔驱动；DOM/类名行为由
// e2e（t-pwa BUG-61 / b-override-lang LANG-04/06 的 closeRightIfOpened 编排）
// 收口。
import { describe, expect, it } from 'vitest';
import {
  DRAWERS_CLOSED,
  drawersAfterTreeOpen,
  openRightDrawerForMetaLang,
  toggleLeftDrawer,
  toggleRightDrawer
} from './shellDrawers';

describe('shellDrawers 双抽屉开合状态机（独立开合：e937d05 钉死语义）', () => {
  it('初始态双收（DRAWERS_CLOSED）；☰/ℹ 各自切换互不影响另一侧', () => {
    expect(DRAWERS_CLOSED).toEqual({ leftOpen: false, rightOpen: false });
    const onlyLeft = toggleLeftDrawer(DRAWERS_CLOSED);
    expect(onlyLeft).toEqual({ leftOpen: true, rightOpen: false });
    const onlyRight = toggleRightDrawer(DRAWERS_CLOSED);
    expect(onlyRight).toEqual({ leftOpen: false, rightOpen: true });
    // 双开 → 各自再切回，另一侧保持
    const both = toggleRightDrawer(onlyLeft);
    expect(both).toEqual({ leftOpen: true, rightOpen: true });
    expect(toggleLeftDrawer(both)).toEqual({ leftOpen: false, rightOpen: true });
    expect(toggleRightDrawer(both)).toEqual({ leftOpen: true, rightOpen: false });
  });

  it('BUG-61：≤900px 抽屉断点点树自动收左抽屉（遮挡主阅读区）；已收时同引用返回（零写）', () => {
    const open = { leftOpen: true, rightOpen: false };
    expect(drawersAfterTreeOpen(open, true)).toEqual({ leftOpen: false, rightOpen: false });
    const closed = { leftOpen: false, rightOpen: false };
    expect(drawersAfterTreeOpen(closed, true)).toBe(closed); // 已收：不再写新状态
  });

  it('BUG-61 断点门：非断点（桌面无抽屉机制）点树不动——同引用返回', () => {
    const open = { leftOpen: true, rightOpen: false };
    expect(drawersAfterTreeOpen(open, false)).toBe(open);
  });

  it('点树不联动右抽屉（独立开合：右抽屉开着也只收左侧——全高遮挡命中点由用例/用户显式关合，e937d05）', () => {
    const both = { leftOpen: true, rightOpen: true };
    expect(drawersAfterTreeOpen(both, true)).toEqual({ leftOpen: false, rightOpen: true });
    // ≤600px 关右抽屉后再碰树：不误触重开、也不误动左抽屉已收态
    const rightClosed = { leftOpen: false, rightOpen: false };
    expect(drawersAfterTreeOpen(rightClosed, true)).toBe(rightClosed);
  });

  it('语言轻入口：手机断点置位开右抽屉（非切换——已开保持开），左抽屉不动', () => {
    const closed = { leftOpen: false, rightOpen: false };
    expect(openRightDrawerForMetaLang(closed)).toEqual({ leftOpen: false, rightOpen: true });
    const leftOpen = { leftOpen: true, rightOpen: false };
    expect(openRightDrawerForMetaLang(leftOpen)).toEqual({ leftOpen: true, rightOpen: true });
    const already = { leftOpen: false, rightOpen: true };
    const next = openRightDrawerForMetaLang(already);
    expect(next).toEqual({ leftOpen: false, rightOpen: true }); // 置位非切换
    expect(next.rightOpen).toBe(true);
  });
});
