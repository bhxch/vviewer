import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect, type CDPSession, type Page } from '@playwright/test';

/**
 * M7 Task 4：移动视口（375×667 触摸）冒烟——
 * 1. 抽屉开合：≤900px 断点下文件树/右栏收进抽屉，drawer-toggle 按钮开合生效；
 * 2. 文件夹打开 → 树 → 打开 md → 渲染（经抽屉内树行点击的移动端真实路径）；
 * 3. 触摸滚动：CDP Input.dispatchTouchEvent 滑动 markdown 正文，scrollTop 前移；
 * 4. 主题切换：TopBar 主题按钮三态循环，html data-theme-mode 随之变化；
 * 5. 视频播放页不崩：ArtPlayer 容器挂载、video 无 error（headless codec 宽松断言）；
 * 6. 手机右栏入口：ℹ toggle 开合 TOC/属性抽屉（≤600px 断点，终审 M7 补入口）。
 *
 * 通道同 m1-m4：页面内构造 File + webkitRelativePath 经 __vvOpenDirImpl 注入
 * （真实 webkitdirectory input 在移动仿真下同样无法被 Playwright 驱动）。
 */

// 移动视口专属冒烟：桌面 project（>900px 无抽屉）下整体跳过
test.beforeEach(async ({}, testInfo) => {
  testInfo.skip(testInfo.project.name !== 'mobile', '移动视口专属冒烟（仅 mobile project）');
});

const BIG_MD_PARAS = 400;

/** 生成足够高的 markdown 正文（滚动断言载体），b64 注入 */
const BIG_MD = Array.from(
  { length: BIG_MD_PARAS },
  (_, i) => `## 第 ${i + 1} 节\n\n移动视口滚动冒烟段落 ${i + 1}，内容用于撑起滚动高度。\n`
).join('\n');

async function openBigMd(page: Page): Promise<void> {
  await page.waitForFunction(
    () => typeof (window as unknown as { __vvOpenDirImpl?: unknown }).__vvOpenDirImpl === 'function'
  );
  await page.evaluate((md) => {
    const f = new File([md], 'mobile.md', { type: 'text/markdown' });
    Object.defineProperty(f, 'webkitRelativePath', { value: 'mobile/mobile.md' });
    return (window as unknown as { __vvOpenDirImpl: (f: File[]) => void }).__vvOpenDirImpl([f]);
  }, BIG_MD);
  // 树行在抽屉内：≤900px 需先开抽屉（本 spec 本身就验证开合，此处显式点击）
  await page.locator('.vv-drawer-toggle').click();
  await page.locator('.vv-tree-row', { hasText: 'mobile.md' }).click();
  await page.locator('.vv-drawer-toggle').click(); // 关抽屉还内容区
  await expect(page.locator('.vv-markdown')).toBeVisible({ timeout: 20_000 });
}

/** CDP 触摸滑动（hasTouch 下 Playwright touchscreen 只有 tap，滑动走 CDP 触摸事件） */
async function touchSwipe(page: Page, cdp: CDPSession, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: from.x, y: from.y, id: 1 }]
  });
  // 分步 move 模拟真实滑动轨迹（一步跳变可能被识别为 tap）
  const steps = 5;
  for (let i = 1; i <= steps; i++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [
        {
          x: from.x + ((to.x - from.x) * i) / steps,
          y: from.y + ((to.y - from.y) * i) / steps,
          id: 1
        }
      ]
    });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

test('抽屉开合：toggle 点击后侧栏滑入/滑出视口', async ({ page }) => {
  await page.goto('/');
  const toggle = page.locator('.vv-drawer-toggle');
  const side = page.locator('.vv-side');

  // 初始关闭：抽屉在视口外（translateX(-100%)，宽 300px → x ≈ -300）
  await expect(toggle).toBeVisible();
  const closedBox = await side.boundingBox();
  expect(closedBox).not.toBeNull();
  expect(closedBox!.x).toBeLessThan(0);
  await expect(page.locator('.vv-shell.drawer')).toHaveCount(0);

  // 开：抽屉滑入视口（x=0），shell 挂 drawer 类
  await toggle.click();
  await expect(page.locator('.vv-shell.drawer')).toHaveCount(1);
  await expect
    .poll(async () => (await side.boundingBox())?.x ?? -1, { timeout: 3_000 })
    .toEqual(0);

  // 关：滑回视口外
  await toggle.click();
  await expect(page.locator('.vv-shell.drawer')).toHaveCount(0);
  await expect
    .poll(async () => (await side.boundingBox())?.x ?? 0, { timeout: 3_000 })
    .toBeLessThan(0);
});

test('文件夹打开 → 抽屉内树 → 打开 md → 渲染', async ({ page }) => {
  await page.goto('/');
  await openBigMd(page);
  await expect(page.locator('.vv-markdown')).toContainText('第 1 节', { timeout: 10_000 });
  await expect(page.locator('.vv-tab.active', { hasText: 'mobile.md' })).toBeVisible();
});

test('触摸滑动 markdown 正文：scrollTop 前移', async ({ page }) => {
  await page.goto('/');
  await openBigMd(page);
  const scroller = page.locator('.vv-viewer-scroll');
  expect(await scroller.evaluate((el) => el.scrollTop)).toBe(0);

  const cdp = await page.context().newCDPSession(page);
  // 从内容区中下部向上滑（y: 500 → 250，375 宽视口内避开底部 toggle 按钮）
  await touchSwipe(page, cdp, { x: 187, y: 500 }, { x: 187, y: 250 });
  await expect
    .poll(() => scroller.evaluate((el) => el.scrollTop), { timeout: 5_000 })
    .toBeGreaterThan(0);
});

test('主题切换：TopBar 按钮三态循环写入 data-theme-mode', async ({ page }) => {
  await page.goto('/');
  const themeBtn = page.locator('.vv-topbar button', { hasText: '主题：' });
  await expect(themeBtn).toBeVisible();

  // system → light → dark → system 循环（AppShell onMount 写初始 system）
  await expect(page.locator('html')).toHaveAttribute('data-theme-mode', 'system');
  await themeBtn.click();
  await expect(page.locator('html')).toHaveAttribute('data-theme-mode', 'light');
  await themeBtn.click();
  await expect(page.locator('html')).toHaveAttribute('data-theme-mode', 'dark');
  // 刷新后持久化（localStorage）
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme-mode', 'dark');
});

test('视频播放页不崩：ArtPlayer 容器挂载，video 无 error', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/');
  // 真 mp4 样例（samples/m4 与 m4.spec 同源）；headless codec 可用性不定 → 只断言无 error
  const mp4 = fileURLToPath(new URL('../../../samples/m4/sample.mp4', import.meta.url));
  await page.waitForFunction(
    () => typeof (window as unknown as { __vvOpenDirImpl?: unknown }).__vvOpenDirImpl === 'function'
  );
  await page.evaluate(
    (b64) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const f = new File([bytes], 'sample.mp4', { type: 'video/mp4' });
      Object.defineProperty(f, 'webkitRelativePath', { value: 'mobile/sample.mp4' });
      return (window as unknown as { __vvOpenDirImpl: (f: File[]) => void }).__vvOpenDirImpl([f]);
    },
    readFileSync(mp4).toString('base64')
  );
  await page.locator('.vv-drawer-toggle').click();
  await page.locator('.vv-tree-row', { hasText: 'sample.mp4' }).click();
  await page.locator('.vv-drawer-toggle').click();

  // ArtPlayer 挂载（播放器初始化失败会抛错阻断容器出现）；无 codec 时 error 容忍
  await expect(page.locator('.vv-artplayer')).toBeVisible({ timeout: 20_000 });
  const video = page.locator('.vv-artplayer video');
  await expect(video).toHaveCount(1);
  const errCode = await video.evaluate((v) => v.error?.code ?? 0);
  expect(errCode).toBe(0);
});

test('手机右栏入口：ℹ toggle 开合 TOC/属性抽屉（终审 M7：TOC 不可达）', async ({ page }) => {
  await page.goto('/');
  await openBigMd(page); // markdown 打开后右栏 TOC 有数据（属性面板恒有占位内容）
  const toggle = page.locator('.vv-right-toggle');
  const right = page.locator('.vv-right');
  await expect(toggle).toBeVisible();

  // 初始关闭：右栏抽屉在视口右侧之外
  const closedBox = await right.boundingBox();
  expect(closedBox).not.toBeNull();
  expect(closedBox!.x).toBeGreaterThanOrEqual(375);

  // 开：滑入视口（宽 min(80vw, 300px) = 300 → x = 75），TOC 与属性面板可见
  await toggle.click();
  await expect(page.locator('.vv-shell.rightopen')).toHaveCount(1);
  await expect
    .poll(async () => (await right.boundingBox())?.x ?? 999, { timeout: 3_000 })
    .toEqual(75);
  await expect(right.locator('nav.toc')).toBeVisible();
  await expect(right.locator('.meta-title')).toBeVisible();

  // 关：滑回视口外
  await toggle.click();
  await expect(page.locator('.vv-shell.rightopen')).toHaveCount(0);
  await expect
    .poll(async () => (await right.boundingBox())?.x ?? 0, { timeout: 3_000 })
    .toBeGreaterThanOrEqual(375);
});
