import { test, expect, type Page } from '@playwright/test';

/**
 * wscreate 外点关闭（设计系统 §10-G3 交互补齐 / §12.3-6 回归口径）：新建工作区
 * 模态的 document pointerdown 外点关闭为 G3 新增 JS 行为，既有 10 处 .vv-wscreate
 * 引用（t-tab-actions/t-workspace/b-wsx-recovery/b-filetree-src-remove/b-layout-zen）
 * 全部是面板内操作路径、无外点回归保护，本 spec 独立补锚——新增文件，不触碰既有断言：
 * - 面板内点击不被外点监听误伤（contains 守卫）：「创建并激活」照常完成创建并关闭；
 * - 面板外 pointerdown 关闭：复用 t-workspace createWorkspace 的打开装置
 *   （触发器 → 「＋ 新建工作区…」，两个 project 视口同径）。
 */

/** 等应用挂载（t-workspace waitAppMounted 同款：__vvOpenDirImpl 就绪 + TopBar 可见） */
async function waitAppMounted(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(
    () => typeof (window as unknown as { __vvOpenDirImpl?: unknown }).__vvOpenDirImpl === 'function'
  );
  await expect(page.locator('.vv-topbar')).toBeVisible();
}

test('WS-OC：wscreate 外点关闭——面板内点击不受误伤、面板外 pointerdown 关闭', async ({
  page
}) => {
  await waitAppMounted(page);

  // 面板内点击不受误伤：主钮（finish → close）照常工作，面板经既有完成路径关闭
  await page.locator('.vv-ws-trigger').click();
  await page.getByRole('button', { name: '＋ 新建工作区…' }).click();
  const modal = page.locator('.vv-wscreate');
  await expect(modal).toBeVisible();
  await modal.getByRole('button', { name: '创建并激活' }).click();
  await expect(modal).toHaveCount(0);

  // 面板外 pointerdown 关闭：重开后点模态底边下方 40px 的正文区坐标——顶距 44px +
  // 模态限高 min(75vh, 560px) + 40px 在两个 project 视口（375×667 / 1280×720）内
  // 恒有落点；x=12 处 pointerdown 经冒泡到 document 监听，落在面板 contains 之外
  await page.locator('.vv-ws-trigger').click();
  await page.getByRole('button', { name: '＋ 新建工作区…' }).click();
  await expect(modal).toBeVisible();
  const box = await modal.boundingBox();
  if (box === null) throw new Error('wscreate 面板未渲染出 bounding box');
  await page.mouse.click(12, box.y + box.height + 40);
  await expect(modal).toHaveCount(0);
});
