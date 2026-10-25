/**
 * shellDrawers.ts — 移动端双抽屉开合状态机（FE-2 自 AppShell.svelte 抽出的纯
 * 模块）：左抽屉（文件树，≤900px 抽屉断点，shell .drawer 类）与右抽屉
 *（MetaPanel/TOC，≤600px 手机断点，.rightopen 类）各自独立开合——双抽屉独立
 * 是钉死的产品语义（e937d05：全高抽屉遮挡命中点由用例编排关合，AppShell 不
 * 联动）。断点判定（matchMedia）由调用方求值传入，本模块只做状态转移（不可变
 * 更新，无变化时原引用返回——$state 赋值同引用零失效）；转移由
 * shellDrawers.test.ts 直测锁定。
 */
export interface ShellDrawersState {
  /** 左抽屉（文件树）开合——仅 ≤900px 抽屉断点有滑入视觉 */
  leftOpen: boolean;
  /** 右抽屉（MetaPanel/TOC）开合——仅 ≤600px 断点有滑入视觉 */
  rightOpen: boolean;
}

export const DRAWERS_CLOSED: ShellDrawersState = { leftOpen: false, rightOpen: false };

/** ☰ 钮切换左抽屉（右抽屉开合不动——独立开合）。 */
export function toggleLeftDrawer(d: ShellDrawersState): ShellDrawersState {
  return { ...d, leftOpen: !d.leftOpen };
}

/** ℹ 钮切换右抽屉（左抽屉开合不动——独立开合）。 */
export function toggleRightDrawer(d: ShellDrawersState): ShellDrawersState {
  return { ...d, rightOpen: !d.rightOpen };
}

/**
 * BUG-61：≤900px 抽屉断点下点树文件后自动收左抽屉（固定定位的 300px 抽屉会继续
 * 遮挡主阅读区）；非断点（桌面无抽屉机制）或已收起时不动（原引用返回）。右抽屉
 * 不受树点击联动——独立开合，关合由用户/用例显式操作（e937d05 语义）。
 */
export function drawersAfterTreeOpen(d: ShellDrawersState, drawerBreakpoint: boolean): ShellDrawersState {
  return drawerBreakpoint && d.leftOpen ? { ...d, leftOpen: false } : d;
}

/**
 * 语言轻入口（renderer-lang-override spec §4.2）：手机断点（≤600px）先开右抽屉
 *（右栏收进抽屉的同一媒体查询条件）——置位非切换（已开保持开）；左抽屉开合
 * 不动。桌面断点不经本函数（AppShell 走 updateLayout 展开右栏）。
 */
export function openRightDrawerForMetaLang(d: ShellDrawersState): ShellDrawersState {
  return { ...d, rightOpen: true };
}
