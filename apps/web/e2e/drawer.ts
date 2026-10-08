import type { Page } from '@playwright/test';

/**
 * 移动视口（M7 Task 4）抽屉适配：AppShell ≤900px 断点下文件树收进左侧抽屉
 * （transform: translateX(-100%) 移出视口），Playwright 点击视口外元素会报
 * "outside of the viewport"。既有 spec 的树行点击统一经此模块开/关抽屉：
 * 桌面视口（>900px）为空操作，mobile project（375px）开抽屉点击后关闭还内容区。
 */

/** 抽屉断点条件式：与 AppShell.svelte 的 @media (max-width: 900px) 同一条件。
 * CSS 无法 import TS 常量，改断点须两处同步；判定经浏览器 matchMedia 与样式表
 * 同引擎求值，替代手工视口宽度比较，消除断点语义双源（遗留 T4）。 */
const DRAWER_MEDIA_QUERY = '(max-width: 900px)';

/** 当前视口是否处于抽屉断点（≤900px） */
export function isDrawerViewport(page: Page): Promise<boolean> {
  return page.evaluate((query) => window.matchMedia(query).matches, DRAWER_MEDIA_QUERY);
}

/** 窄视口下打开抽屉，返回是否实际打开（配 closeDrawer 还原，避免覆盖主内容区） */
export async function openDrawerIfNarrow(page: Page): Promise<boolean> {
  // isDrawerViewport 为异步（matchMedia 经 page.evaluate 求值）：必须 await，
  // 否则 Promise 恒真导致桌面视口也去点 display:none 的抽屉钮（超时雪崩）
  if (!(await isDrawerViewport(page))) return false;
  await page.locator('.vv-drawer-toggle').click();
  return true;
}

/** openDrawerIfNarrow 返回 true 时关闭抽屉 */
export async function closeDrawerIfOpened(page: Page, opened: boolean): Promise<void> {
  if (opened) await page.locator('.vv-drawer-toggle').click();
}
