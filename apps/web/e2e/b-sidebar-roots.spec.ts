import { test, expect, type Page } from '@playwright/test';
import { closeDrawerIfOpened, isDrawerViewport, openDrawerIfNarrow } from './drawer';

/**
 * 侧栏多根源头行 e2e 锚（SRC-01..04，侧栏多根 spec Task 4 收官）：
 * - SRC-01：源头行 chevron 折叠整源树——aria-expanded 翻转、该源组行收敛、他源不受影响
 * - SRC-02：源级移除钮键盘可达——Tab 聚焦后 :focus-within 揭示（computed opacity；
 *   toBeVisible 判定不含 opacity，对 opacity:0 恒真，不构成揭示断言）
 * - SRC-03：行右让位几何（§2.2 重叠修复）——侧栏折叠钮 .vv-collapse-left 与首个
 *   移除钮 boundingBox 手写相交判定（桌面视口锚；抽屉断点无中缝重叠面跳过）
 * - SRC-04：0 目录空态引导区（§2.3）——三入口控件可见可用、连接服务器就地展开
 *   ServerConnectForm；空态控件与 ⋯ 菜单同名同屏，定位一律限定 .vv-side-empty
 *   容器（不含真实连接/打开动作）
 *
 * 装置：本地源走 __vvOpenDirImpl 注入（b-filetree-src-remove 同款通道，label 决定
 * localfiles:<label> storeId）；空态用 Playwright 每用例新 context 的零来源天然形态。
 */

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

test.describe('侧栏多根源头行（SRC-01..04）', () => {
  test('SRC-01：源头行折叠——aria-expanded 翻转、该源组行收敛、他源不受影响', async ({
    page
  }) => {
    await waitAppMounted(page);
    await openLocalDir(page, [{ name: 'a1.txt', content: 'a1 body\n' }], 'src-a');
    await openLocalDir(page, [{ name: 'b1.txt', content: 'b1 body\n' }], 'src-b');
    const drawer = await openDrawerIfNarrow(page);
    const toggleA = page.locator('.vv-tree-src', { hasText: 'src-a' }).locator('.vv-tree-src-toggle');
    const toggleB = page.locator('.vv-tree-src', { hasText: 'src-b' }).locator('.vv-tree-src-toggle');
    // 相邻兄弟组合器锚定「该源」的组行：折叠时组行卸载、紧邻变为他源行，不会误吞他源组
    const groupA = page.locator('.vv-tree-src:has-text("src-a") + .vv-tree-group');
    const groupB = page.locator('.vv-tree-src:has-text("src-b") + .vv-tree-group');
    await expect(toggleA).toHaveAttribute('aria-expanded', 'true');
    await expect(toggleB).toHaveAttribute('aria-expanded', 'true');
    await expect(groupA.locator('.vv-tree-row', { hasText: 'a1.txt' })).toBeVisible();
    await expect(groupB.locator('.vv-tree-row', { hasText: 'b1.txt' })).toBeVisible();

    await toggleA.click();
    await expect(toggleA).toHaveAttribute('aria-expanded', 'false');
    await expect(groupA).toHaveCount(0);
    await expect(toggleB).toHaveAttribute('aria-expanded', 'true');
    await expect(groupB.locator('.vv-tree-row', { hasText: 'b1.txt' })).toBeVisible();

    await toggleA.click();
    await expect(toggleA).toHaveAttribute('aria-expanded', 'true');
    await expect(groupA.locator('.vv-tree-row', { hasText: 'a1.txt' })).toBeVisible();
    await closeDrawerIfOpened(page, drawer);
  });

  test('SRC-02：移除钮键盘可达——Tab 聚焦后 :focus-within 揭示（computed opacity=1）', async ({
    page
  }) => {
    await waitAppMounted(page);
    await openLocalDir(page, [{ name: 'a1.txt', content: 'a1 body\n' }], 'src-a');
    const drawer = await openDrawerIfNarrow(page);
    const srcRow = page.locator('.vv-tree-src', { hasText: 'src-a' });
    const removeBtn = srcRow.locator('.vv-tree-src-remove');
    // 行内 Tab 序：toggle（button）→ 移除钮（label span 不入焦点链）
    await srcRow.locator('.vv-tree-src-toggle').focus();
    await page.keyboard.press('Tab');
    await expect(removeBtn).toBeFocused();
    await expect(removeBtn).toHaveCSS('opacity', '1');
    await closeDrawerIfOpened(page, drawer);
  });

  test('SRC-03：折叠钮与移除钮几何不重叠（§2.2 行右让位，桌面视口）', async ({ page }) => {
    await waitAppMounted(page);
    test.skip(await isDrawerViewport(page), '几何锚限定桌面视口：抽屉断点无中缝折叠钮重叠面');
    await openLocalDir(page, [{ name: 'a1.txt', content: 'a1 body\n' }], 'src-a');
    const collapseBox = await page.locator('.vv-collapse-btn.vv-collapse-left').boundingBox();
    const removeBox = await page.locator('.vv-tree-src-remove').first().boundingBox();
    expect(collapseBox).not.toBeNull();
    expect(removeBox).not.toBeNull();
    // 手写相交判定（无断言库依赖）：至少一轴分离即不相交（贴边不计交叠）
    const separated =
      collapseBox!.x + collapseBox!.width <= removeBox!.x ||
      removeBox!.x + removeBox!.width <= collapseBox!.x ||
      collapseBox!.y + collapseBox!.height <= removeBox!.y ||
      removeBox!.y + removeBox!.height <= collapseBox!.y;
    expect(separated).toBe(true);
  });

  test('SRC-04：0 目录空态引导区——三入口可见可用，连接服务器就地展开共享表单', async ({
    page
  }) => {
    await waitAppMounted(page); // 每用例新 context 零来源：天然空态
    const empty = page.locator('.vv-side-empty');
    await expect(empty).toBeVisible();
    await openDrawerIfNarrow(page);
    const openBtn = empty.getByRole('button', { name: '打开文件夹' });
    await expect(openBtn).toBeVisible();
    await expect(openBtn).toBeEnabled();
    await expect(empty.getByLabel('文件 URL')).toBeVisible();
    // 空态「连接服务器」与 ⋯ 菜单同名同屏：限定 .vv-side-empty 容器
    await empty.getByRole('button', { name: '连接服务器' }).click();
    await expect(empty.locator('.vv-server-form')).toBeVisible();
  });
});
