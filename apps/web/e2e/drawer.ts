import type { Page } from '@playwright/test';

/**
 * 移动视口（M7 Task 4）抽屉适配：AppShell ≤900px 断点下文件树收进左侧抽屉
 * （transform: translateX(-100%) 移出视口），Playwright 点击视口外元素会报
 * "outside of the viewport"。既有 spec 的树行点击统一经此模块开/关抽屉：
 * 桌面视口（>900px）为空操作，mobile project（375px）开抽屉点击后关闭还内容区。
 */

/** 当前视口是否处于抽屉断点（≤900px） */
export function isDrawerViewport(page: Page): boolean {
  return (page.viewportSize()?.width ?? 1280) <= 900;
}

/** 窄视口下打开抽屉，返回是否实际打开（配 closeDrawer 还原，避免覆盖主内容区） */
export async function openDrawerIfNarrow(page: Page): Promise<boolean> {
  if (!isDrawerViewport(page)) return false;
  await page.locator('.vv-drawer-toggle').click();
  return true;
}

/** openDrawerIfNarrow 返回 true 时关闭抽屉 */
export async function closeDrawerIfOpened(page: Page, opened: boolean): Promise<void> {
  if (opened) await page.locator('.vv-drawer-toggle').click();
}
