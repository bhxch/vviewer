import type { Page } from '@playwright/test';

/**
 * 移动视口（M7 Task 4）抽屉适配：AppShell ≤900px 断点下文件树收进左侧抽屉
 * （transform: translateX(-100%) 移出视口），Playwright 点击视口外元素会报
 * "outside of the viewport"。既有 spec 的树行点击统一经此模块开/关抽屉：
 * 桌面视口（>900px）为空操作，mobile project（375px）开抽屉点击后关闭还内容区。
 *
 * BUG-61（2026-10-17）适配：AppShell onTreeOpen 现在会在抽屉断点下点树文件后
 * 自动收起抽屉——「点击后手动关回」的盲目 toggle 配对随之失效（还原点击变成
 * 重新打开，下一轮 openDrawerIfNarrow 的点击变成关闭，行点击落在屏外抽屉内
 * 永挂）。两函数改为按 .vv-side 实际 transform 状态幂等操作：
 * open 仅在未开时点击、close 仅在开着时点击，与自动收起语义自然兼容。
 */

/** 抽屉断点条件式：与 AppShell.svelte 的 @media (max-width: 900px) 同一条件。
 * CSS 无法 import TS 常量，改断点须两处同步；判定经浏览器 matchMedia 与样式表
 * 同引擎求值，替代手工视口宽度比较，消除断点语义双源（遗留 T4）。 */
const DRAWER_MEDIA_QUERY = '(max-width: 900px)';

/** 当前视口是否处于抽屉断点（≤900px） */
export function isDrawerViewport(page: Page): Promise<boolean> {
  return page.evaluate((query) => window.matchMedia(query).matches, DRAWER_MEDIA_QUERY);
}

/** 抽屉实际开合状态：open 态 transform:none（AppShell @media 内 .vv-shell.drawer
 * .vv-side { transform: none }），closed 态为 translateX(-100%) 的 matrix。 */
function isDrawerOpen(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const el = document.querySelector('.vv-side');
    return el !== null && getComputedStyle(el).transform === 'none';
  });
}

/** 窄视口下确保抽屉打开（已开则不重复 toggle——BUG-61 自动收起后的状态幂等），
 * 返回调用方是否处于抽屉断点（配 closeDrawer 还原语义保留，见 closeDrawer）。 */
export async function openDrawerIfNarrow(page: Page): Promise<boolean> {
  // isDrawerViewport 为异步（matchMedia 经 page.evaluate 求值）：必须 await，
  // 否则 Promise 恒真导致桌面视口也去点 display:none 的抽屉钮（超时雪崩）
  if (!(await isDrawerViewport(page))) return false;
  if (!(await isDrawerOpen(page))) await page.locator('.vv-drawer-toggle').click();
  return true;
}

/** 窄视口下若抽屉仍开着则关闭（BUG-61 起行点击后应用自动收起，多为 no-op）；
 * opened=false（桌面视口）为空操作。 */
export async function closeDrawerIfOpened(page: Page, opened: boolean): Promise<void> {
  if (opened && (await isDrawerOpen(page))) await page.locator('.vv-drawer-toggle').click();
}
