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

/**
 * 抽屉开合状态幂等确保（BUG-61 教训的左抽屉收口版，ensureRightDrawer 同构）：
 * .vv-side 开合带 0.2s transform 过渡，瞬时采样会在过渡中段把「开」误读为
 * 「关」（matrix 中间值非 none）——close 判定因此跳过关闭（抽屉挂开遮挡后续
 * 点击，标签栏收敛 Task 1 门禁在 ICON-05/ICON-07/OWM-05 mobile 实证）、open
 * 判定因此重复 toggle 双 flip。期望状态未落定前以 250ms（> --vv-dur-med
 * 0.2s）间隔重读重 toggle，10 次封顶。
 */
async function ensureDrawer(page: Page, wantOpen: boolean): Promise<void> {
  let open = await isDrawerOpen(page);
  for (let i = 0; i < 10 && open !== wantOpen; i++) {
    await page.locator('.vv-drawer-toggle').click();
    await page.waitForTimeout(250); // > --vv-dur-med（0.2s）：过渡落定再采样
    open = await isDrawerOpen(page);
  }
}

/** 窄视口下确保抽屉打开（已开则不重复 toggle——BUG-61 自动收起后的状态幂等），
 * 返回调用方是否处于抽屉断点（配 closeDrawer 还原语义保留，见 closeDrawer）。 */
export async function openDrawerIfNarrow(page: Page): Promise<boolean> {
  // isDrawerViewport 为异步（matchMedia 经 page.evaluate 求值）：必须 await，
  // 否则 Promise 恒真导致桌面视口也去点 display:none 的抽屉钮（超时雪崩）
  if (!(await isDrawerViewport(page))) return false;
  await ensureDrawer(page, true);
  return true;
}

/** 窄视口下若抽屉仍开着则关闭（BUG-61 起行点击后应用自动收起，多为 no-op）；
 * opened=false（桌面视口）为空操作。关闭同样走 ensureDrawer 过渡落定重试
 * （见其注：过渡中段误读曾致跳过关闭、抽屉挂开遮挡后续点击）。 */
export async function closeDrawerIfOpened(page: Page, opened: boolean): Promise<void> {
  if (opened) await ensureDrawer(page, false);
}

/**
 * ≤600px 断点右抽屉幂等开合（openDrawerIfNarrow 的右栏对应面，transform 口径与
 * isDrawerOpen 同源）：.vv-right 开合带 0.2s transform 过渡，瞬时采样会在过渡
 * 中段把「开」误读为「关」（matrix 中间值非 none）——期望状态未落定前重试
 * toggle，防双 flip（BUG-61 盲目 toggle 教训的右抽屉同款规避）。桌面视口
 * （>600px）no-op。code-outline Task 3 起 b-code-outline（切换器断言）/md-export
 * 系（属性段切换）共用。
 */
export async function ensureRightDrawer(page: Page, wantOpen: boolean): Promise<void> {
  const narrow = await page.evaluate(() => window.matchMedia('(max-width: 600px)').matches);
  if (!narrow) return;
  const readOpen = (): Promise<boolean> =>
    page.evaluate(() => {
      const el = document.querySelector('.vv-right');
      return el !== null && getComputedStyle(el).transform === 'none';
    });
  let open = await readOpen();
  for (let i = 0; i < 10 && open !== wantOpen; i++) {
    await page.locator('.vv-right-toggle').click();
    await page.waitForTimeout(250); // > --vv-dur-med（0.2s）：过渡落定再采样
    open = await readOpen();
  }
}
