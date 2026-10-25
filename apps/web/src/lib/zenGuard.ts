/**
 * zenGuard.ts — zen 守卫历史项状态机（spec 2026-10-19 §3.1 返回键拦截，FE-2 自
 * AppShell.svelte 抽出的纯模块）：Android 返回键触发 popstate 时按 zenPopAction
 * （layout.ts）分派的「守卫在位」载体。不变式：移动断点下 zen 在场即守卫在当前
 * 历史项——closeOverlay 消费守卫后重新压入（onPopstate）；非 popstate 通道退出
 *（浮钮/菜单/Esc/快捷键）时 history.back() 消费之，返回键语义回归原生（不劫持
 * 正常导航）。守卫项跨 reload 存活（history.state 持久），reload 落 zen 时认领
 * 或补压（浮钮即在场 + 返回键仍可退出，无困死路径）。
 * 无 $state/DOM 深耦合：history 经构造以惰性源注入（AppShell 传 () => history，
 * 单测传假件），状态转移由 zenGuard.test.ts 直测锁定；事件接线（popstate 监听与
 * zenPopAction 分派消费）留在 AppShell。
 */

/** history 面的最小依赖面（AppShell 传全局 history；单测传记录假件）。 */
export interface ZenHistoryOps {
  pushState(data: unknown, unused: string): void;
  back(): void;
  readonly state: unknown;
}

export class ZenHistoryGuard {
  private armed = false;

  /** history 以惰性源注入（() => ZenHistoryOps）：AppShell 组件实例脚本在 SSR 期
   * 也会执行，而全局 history 仅浏览器在场——与原实现一致地只在方法调用期（事件
   * 回调/onMount，恒客户端）解引用，构造期不触碰（theme.ts 的 typeof 守卫同因）。
   * 方法内别名为局部 const history，守卫写点（pushState/back/state）保持原文。 */
  constructor(private readonly historySource: () => ZenHistoryOps) {}

  get isArmed(): boolean {
    return this.armed;
  }

  /** 压入 {vvZen:1} 守卫项（移动断点进 zen / closeOverlay 后重压维持「zen 在场即守卫在顶」）。 */
  arm(): void {
    const history = this.historySource();
    history.pushState({ vvZen: 1 }, '');
    this.armed = true;
  }

  /**
   * reload 认领：守卫项跨 reload 存活在当前历史项（history.state 持久）——当前项
   * 即守卫则置 armed 返回 true；无守卫（上个会话经浮钮退出后 reload 等）返回
   * false，由调用方决定是否在移动断点补压。
   */
  claimReloaded(): boolean {
    const history = this.historySource();
    if ((history.state as { vvZen?: unknown } | null)?.vvZen === 1) {
      this.armed = true;
      return true;
    }
    return false;
  }

  /** 消费守卫（popstate 通道退出的前置标记）：本次回退已弹出守卫项，退出不再 history.back。 */
  consume(): void {
    this.armed = false;
  }

  /**
   * zen 进出对齐（toggleZen 尾部调用）：进入且在移动断点（≤900px 抽屉断点，调用方
   * matchMedia 求值传入）→ 压守卫；桌面断点不压（桌面无返回键语义，history 保持
   * 纯净）。退出 → 守卫在位时非 popstate 通道 history.back() 消费（守卫项仍在
   * 栈顶），popstate 分支已弹过跳过；守卫不在场（桌面进入等）不动 history。
   */
  update(zen: boolean, viaPopstate: boolean, drawerBreakpoint: boolean): void {
    if (zen) {
      if (drawerBreakpoint) this.arm();
      return;
    }
    if (!this.armed) return;
    this.armed = false;
    const history = this.historySource();
    if (!viaPopstate) history.back(); // 守卫项仍在栈顶：回退消费（popstate 分支已弹过）
  }
}
