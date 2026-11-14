import { expect, test, type Page } from '@playwright/test';
import { openDrawerIfNarrow } from './drawer';
import { applySettings, closeSettings, gotoGroup, openSettings } from './settings-center';
import { openMenu } from './tabbar-menu';

/**
 * 触屏档案 e2e 锚（TP-01..05，触屏适配 spec B §4，Task 4）：
 * - TP-01：auto 档双 project 分流——chromium（fine pointer）不吃档案 / mobile
 *   project（hasTouch）吃档案（计划探针实证 1：hasTouch 天然翻转 any-pointer:coarse）
 * - TP-02：设置三态切换翻转（spec §4 ①）——touch 档常显翻转 / desktop 档回收 +
 *   layout.touchMode 落盘
 * - TP-03：强制桌面档语义（spec §3.4）——CDP coarse 在场下 desktop 仍回收、auto 回归
 * - TP-04：触控目标加大（spec §3.3.2）——菜单条目 8px 档（>600px 视口 data-touch
 *   通道实证）+ 抽屉浮钮 ≥40px（32→40 升档实证）
 * - TP-05：FileTree 删除钮 mobile 恒显（spec §4 ③——既有 hover:none 断言迁移后
 *   保持的 mobile 直证版）
 *
 * 装置复用（不新造）：目录注入 openLocalDir（b-filetree-src-remove/b-sidebar-roots
 * 同款 __vvOpenDirImpl + webkitRelativePath 通道——先例均为文件内局部函数未导出，
 * 随例复制同款体）；设置管线 openSettings/gotoGroup/applySettings/closeSettings
 * （e2e/settings-center.ts）；抽屉 openDrawerIfNarrow（e2e/drawer.ts）；菜单
 * openMenu（e2e/tabbar-menu.ts，含 T13b 委托监听就绪锚）。CDP 触摸模拟独立 test
 * 隔离（计划探针实证 4：模拟有特征残留迹象，enable 不 disable、page 每 test 重建
 * 即隔离）；emulateMedia({pointer}) 通道弃用（1.64.0 翻不动 any-pointer，探针实证 3）。
 */

/** 应用就绪锚（b-sidebar-roots waitAppMounted 同款）：openLocalDir 的
 * __vvOpenDirImpl 通道挂载 + 壳层可见（B6 装置就绪锚纪律）。 */
async function waitAppMounted(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(
    () => typeof (window as unknown as { __vvOpenDirImpl?: unknown }).__vvOpenDirImpl === 'function'
  );
  await expect(page.locator('.vv-tabbar')).toBeVisible();
}

async function openLocalDir(
  page: Page,
  files: Array<{ name: string; content: string }>,
  label: string
): Promise<void> {
  await page.evaluate(({ list, label }) => {
    const fs = list.map(({ name, content }) => {
      const f = new File([content], name, { type: 'text/plain' });
      Object.defineProperty(f, 'webkitRelativePath', { value: `${label}/${name}` });
      return f;
    });
    return (window as unknown as { __vvOpenDirImpl: (f: File[]) => void }).__vvOpenDirImpl(fs);
  }, { list: files, label });
}

/** 落盘设置直读（b-settings-center.spec.ts savedSettings 同款四行 inline） */
function savedSettings(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(() => JSON.parse(localStorage.getItem('vviewer:settings') ?? '{}'));
}

/** 触屏档切换公共前缀（TP-02/03/04 chromium 分支共用）：开面板 → 布局组 →
 * select → 应用 → 关闭（应用后非脏，Esc 直关——closeSettings 自带脏态守卫） */
async function selectTouchMode(page: Page, mode: 'auto' | 'touch' | 'desktop'): Promise<void> {
  await openSettings(page);
  await gotoGroup(page, '布局');
  await page.getByLabel('触屏适配模式').selectOption(mode);
  await applySettings(page);
  await closeSettings(page);
}

test.describe('触屏档案（TP-01..05，spec B §4）', () => {
  test('TP-01：auto 档双 project 分流——chromium fine 不吃档案 / mobile hasTouch 吃档案', async ({
    page
  }, testInfo) => {
    await waitAppMounted(page); // 挂载完成锚：打标面是 init 通道行为，挂载后断言才有意义
    if (testInfo.project.name === 'mobile') {
      // 前置探针守卫（BUG-26 先例形态）：环境异常时 skip 备案
      const coarse = await page.evaluate(() => window.matchMedia('(any-pointer: coarse)').matches);
      test.skip(!coarse, '环境异常：hasTouch 未翻转 any-pointer:coarse——备案');
      await expect(page.locator('html')).toHaveAttribute('data-touch', 'on');
    } else {
      await expect(page.locator('html')).not.toHaveAttribute('data-touch');
    }
  });

  test('TP-02：设置三态切换翻转——touch 档常显 / desktop 档回收 + 落盘（spec §4 ①）', async ({
    page
  }, testInfo) => {
    testInfo.skip(
      testInfo.project.name !== 'chromium',
      'chromium 专属：fine pointer 下三态强启/回收语义（mobile 天然 coarse 无对照面）'
    );
    await waitAppMounted(page);
    await openLocalDir(page, [{ name: 'solo.txt', content: 'solo body\n' }], 'src-a');
    const srcRow = page.locator('.vv-tree-src', { hasText: 'src-a' });
    const removeBtn = srcRow.locator('.vv-tree-src-remove');

    // touch 档：属性翻转 + 常显翻转（无 hover opacity 1——指针停在面板区坐标，不在源行）
    await selectTouchMode(page, 'touch');
    await expect(page.locator('html')).toHaveAttribute('data-touch', 'on');
    await expect(removeBtn).toHaveCSS('opacity', '1');

    // desktop 档：属性消失 + 删除钮回 hover 语义（SRC-08 ①② 同款揭示链）
    await selectTouchMode(page, 'desktop');
    await expect(page.locator('html')).not.toHaveAttribute('data-touch');
    await srcRow.hover();
    await expect(removeBtn).toHaveCSS('opacity', '1');
    const vp = page.viewportSize();
    expect(vp).not.toBeNull();
    await page.mouse.move(vp!.width - 6, vp!.height - 6); // 移出源行（主区右下空白）
    await expect(removeBtn).toHaveCSS('opacity', '0');

    // 落盘断言：layout.touchMode 持久化 'desktop'（savedSettings localStorage 直读）
    const saved = await savedSettings(page);
    expect((saved.layout as { touchMode?: string }).touchMode).toBe('desktop');
  });

  test('TP-03：强制桌面档语义——CDP coarse 在场下 desktop 仍回收、auto 回归（spec §3.4）', async ({
    page
  }, testInfo) => {
    testInfo.skip(
      testInfo.project.name !== 'chromium',
      'chromium 专属 + CDP 触摸模拟独立 test 隔离（探针实证 4 特征残留防护）'
    );
    // goto 前安装（计划 Step 3 口径）：独立 page 隔离，enable 不 disable
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await waitAppMounted(page);
    await openLocalDir(page, [{ name: 'solo.txt', content: 'solo body\n' }], 'src-a');
    const removeBtn = page
      .locator('.vv-tree-src', { hasText: 'src-a' })
      .locator('.vv-tree-src-remove');

    // auto 档：coarse 在场吃档案（探针实证 2：CDP 全翻 any-pointer + maxTouchPoints=5）
    await expect(page.locator('html')).toHaveAttribute('data-touch', 'on');

    // desktop 档：coarse 在场仍回收（强制桌面档核心语义——媒介查询挡不住的回收路径）
    await selectTouchMode(page, 'desktop');
    await expect(page.locator('html')).not.toHaveAttribute('data-touch');
    await expect(removeBtn).toHaveCSS('opacity', '0'); // 无 hover（指针在面板区坐标）hover 语义恢复

    // 切回 auto：coarse 在场属性回归 'on'
    await selectTouchMode(page, 'auto');
    await expect(page.locator('html')).toHaveAttribute('data-touch', 'on');
  });

  test('TP-04：触控目标加大——chromium 强制触屏档菜单条目 8px / mobile 浮钮 ≥40px（spec §3.3.2）', async ({
    page
  }, testInfo) => {
    if (testInfo.project.name === 'chromium') {
      // 强制 touch 档（TP-02 装置复用；不注入目录——菜单档与目录无关）
      await waitAppMounted(page);
      await selectTouchMode(page, 'touch');
      await expect(page.locator('html')).toHaveAttribute('data-touch', 'on');
      // 先 openMenu（F2：.vv-tbmenu-item 全部条目在 TabBarMenu {#if menuOpen} 门内
      // 条件挂载，不开菜单 locator 落空）
      await openMenu(page);
      const pt = await page
        .locator('.vv-tbmenu-item')
        .first()
        .evaluate((el) => getComputedStyle(el).paddingTop);
      expect(pt).toBe('8px'); // >600px 视口下 data-touch 生效——媒介查询等价通道实证
    } else {
      // mobile：抽屉浮钮 ≤900px 断点内恒显，无需开门（F2 注）；data-touch 天然在场
      // → 40px 档生效（32px 基态即红，升档实证）
      await waitAppMounted(page);
      const box = await page.locator('.vv-drawer-toggle').boundingBox();
      expect(box).not.toBeNull();
      expect(box!.width).toBeGreaterThanOrEqual(40);
      expect(box!.height).toBeGreaterThanOrEqual(40);
    }
  });

  test('TP-05：FileTree 删除钮 mobile 恒显（spec §4 ③ hover:none 断言迁移后保持）', async ({
    page
  }, testInfo) => {
    testInfo.skip(
      testInfo.project.name !== 'mobile',
      'mobile project 直证面（chromium fine 下删除钮走 hover 揭示，SRC-08 ①② 承载）'
    );
    await waitAppMounted(page);
    await openLocalDir(page, [{ name: 'solo.txt', content: 'solo body\n' }], 'src-a');
    await openDrawerIfNarrow(page); // mobile 375px 树区在抽屉内（抽屉装置先例）
    const srcRow = page.locator('.vv-tree-src', { hasText: 'src-a' });
    await expect(srcRow.locator('.vv-tree-src-remove')).toHaveCSS('opacity', '1'); // 无 hover 恒显
  });
});
