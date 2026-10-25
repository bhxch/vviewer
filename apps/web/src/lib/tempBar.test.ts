// tempBar.test.ts — chrome 临时条可见性状态机（spec 2026-10-19 §2 隐藏唤出 / §3
// zen 退出条，FE-2 自 AppShell.svelte 抽出的纯模块）直测：fake timers 驱动，锁定
// 「唤出 / 移开 1.5s 收回 / 排定窗口内重唤重置计时（LZ-11 竞态）/ 立即收回清
// 定时器（L1）」的状态转移。AppShell 侧接线由 e2e b-layout-zen-deep LZ-11 收口。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEMP_HIDE_DELAY_MS, TempBarVisibility } from './tempBar';

describe('tempBar 临时条可见性状态机（spec §2/§3：边缘悬停唤出，移开 1.5s 再隐）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('summon 立即可见（onChange 上行），无定时器悬置', () => {
    const seen: boolean[] = [];
    const bar = new TempBarVisibility((v) => seen.push(v));
    bar.summon();
    expect(bar.isVisible).toBe(true);
    expect(seen).toEqual([true]);
    vi.advanceTimersByTime(10_000); // 无 scheduleHide 则永不收回
    expect(bar.isVisible).toBe(true);
  });

  it('scheduleHide：移开 1.5s 后收回（1499ms 仍在场，1500ms 隐）', () => {
    const bar = new TempBarVisibility(() => {});
    bar.summon();
    bar.scheduleHide();
    expect(bar.isVisible).toBe(true); // 移开瞬间条仍可见
    vi.advanceTimersByTime(TEMP_HIDE_DELAY_MS - 1);
    expect(bar.isVisible).toBe(true);
    vi.advanceTimersByTime(1);
    expect(bar.isVisible).toBe(false);
  });

  it('收回经 onChange 上行（AppShell $state 副本随动）', () => {
    const seen: boolean[] = [];
    const bar = new TempBarVisibility((v) => seen.push(v));
    bar.summon();
    bar.scheduleHide();
    vi.advanceTimersByTime(TEMP_HIDE_DELAY_MS);
    expect(seen).toEqual([true, false]);
  });

  it('排定窗口内重唤：作废已排定的收回（LZ-11 竞态——重进清未决定时器）', () => {
    const bar = new TempBarVisibility(() => {});
    bar.summon();
    bar.scheduleHide();
    vi.advanceTimersByTime(600); // ~600ms 处重进热区
    bar.summon();
    vi.advanceTimersByTime(10_000);
    expect(bar.isVisible).toBe(true); // 已排定的收回被作废，重唤后常驻待再移开
  });

  it('移开后再次移开：重置计时窗口（后一次 scheduleHide 重新计 1.5s）', () => {
    const bar = new TempBarVisibility(() => {});
    bar.summon();
    bar.scheduleHide();
    vi.advanceTimersByTime(1000);
    bar.summon();
    bar.scheduleHide(); // 重新排定：从现在起再计 1.5s
    vi.advanceTimersByTime(1400);
    expect(bar.isVisible).toBe(true);
    vi.advanceTimersByTime(100);
    expect(bar.isVisible).toBe(false);
  });

  it('dismiss 立即收回并清未决定时器（L1：常显分支残留定时器会在常显条上误触发隐藏竞态）', () => {
    const bar = new TempBarVisibility(() => {});
    bar.summon();
    bar.scheduleHide();
    bar.dismiss(); // 右键置可见：立即收回 + 残留定时器必须清
    expect(bar.isVisible).toBe(false);
    vi.advanceTimersByTime(10_000);
    expect(bar.isVisible).toBe(false); // 已清定时器不得复活 temp 态
  });

  it('隐态再 dismiss / 再 summon：幂等收敛（退出 zen 的 clearTempTimers 双通道同调）', () => {
    const bar = new TempBarVisibility(() => {});
    bar.dismiss();
    expect(bar.isVisible).toBe(false);
    bar.summon();
    expect(bar.isVisible).toBe(true);
  });
});
