/**
 * tempBar.ts — chrome 临时条可见性状态机（spec 2026-10-19 §2 隐藏唤出 / §3 zen
 * 退出条，FE-2 自 AppShell.svelte 抽出的纯模块）：隐藏后的顶栏/标签栏边缘悬停
 * 唤出（summon），移开 1.5s 再隐（scheduleHide，重进重置计时）；立即收回
 *（dismiss）同步清定时器——常显分支调用时残留 temp 态会使半透/覆盖形态滞留，
 * 残留定时器会在常显条上误触发隐藏竞态（L1）。
 * 无 $state/DOM 深耦合：定时器走全局 setTimeout/clearTimeout（vitest fake
 * timers 可驱），可见性经 onChange 回调上行（AppShell 持 $state 副本供 markup
 * 的 temp/hidden props 消费）；状态转移由 tempBar.test.ts 直测锁定。
 */
export const TEMP_HIDE_DELAY_MS = 1500;

export class TempBarVisibility {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private visible = false;

  constructor(
    private readonly onChange: (visible: boolean) => void,
    private readonly hideDelayMs: number = TEMP_HIDE_DELAY_MS
  ) {}

  get isVisible(): boolean {
    return this.visible;
  }

  /** 唤出临时条并清未决收回定时器（排定窗口内重进不收回——LZ-11 竞态防线）。 */
  summon(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.setVisible(true);
  }

  /** 立即收回并清定时器（L1：右键置可见分支同步调用——见模块 doc）。 */
  dismiss(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.setVisible(false);
  }

  /** 移开排定 1.5s 收回；再排定重置计时窗口（已排定的收回作废）。 */
  scheduleHide(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.visible = false;
      this.timer = null;
      this.onChange(false);
    }, this.hideDelayMs);
  }

  private setVisible(v: boolean): void {
    this.visible = v;
    this.onChange(v);
  }
}
