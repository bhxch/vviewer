import { expect, type Locator, type Page } from '@playwright/test';

/**
 * TabBar 左端全局动作簇 e2e 装置（顶栏退役 spec Task 4）。
 *
 * TopBar 退役后全局动作宿主为 .vv-tabbar-actions（TabBarActions.svelte）：
 * 工作区切换器 + ＋ 打开菜单（打开文件/打开文件夹/粘贴 URL）+ ↻ 刷新 + ⋯ 更多
 * 菜单（连接服务器/主题/目录管理/设置/专注）。本文件收敛「点触发钮 → 点浮层
 * 条目」的两段流，替代原 `.vv-topbar` 直点流（打开文件/打开文件夹按钮与
 * 连接服务器表单触发不再直挂常驻条）。aria-label/条目文案与 TopBar 时代逐字
 * 相同（组件锚红线），仅容器作用域变化。
 *
 * 选择器约定：触发钮限 `.vv-tabbar-actions`（最窄稳定作用域），浮层条目限
 * `.vv-tbact-pop`（同刻至多一个浮层开，locator 天然唯一）。
 */

/** TabBar 左端全局动作簇容器（TabBar.svelte 内固定插槽，不随 tabs 滚动） */
export const TABBAR_ACTIONS = '.vv-tabbar-actions';

/** ＋ 打开菜单浮层条目（打开文件/打开文件夹/粘贴 URL） */
export const PLUS_ITEMS = '.vv-tbact-pop';

/** ⋯ 更多菜单浮层（与 ＋ 菜单同类同类名，同刻至多一个开） */
export const OVERFLOW_POP = '.vv-tbact-pop';

/** 点簇内 ＋ 打开「打开菜单」浮层（aria-label="打开" 沿用 TopBar 原文） */
export async function openPlusMenu(page: Page): Promise<void> {
  await page.locator(`${TABBAR_ACTIONS} [aria-label="打开"]`).click();
  await expect(page.locator(PLUS_ITEMS)).toBeVisible();
}

/** 点簇内 ⋯ 打开「更多菜单」浮层（aria-label="更多" 沿用 TopBar 原文） */
export async function openOverflowMenu(page: Page): Promise<void> {
  await page.locator(`${TABBAR_ACTIONS} [aria-label="更多"]`).click();
  await expect(page.locator(OVERFLOW_POP)).toBeVisible();
}

/** ＋ 菜单「打开文件」：filechooser 通道喂 files（hidden input 常驻挂载，
 * 菜单条目点击后 menu 收起再弹原生选择器，事件先注册后点击）。
 * 暂无调用者（备用装置，filechooser 通道）——打开文件用例改直点流后保留，
 * 供后续 filechooser 负路径/多文件用例取用 */
export async function plusOpenFile(page: Page, files: string | string[]): Promise<void> {
  const chooser = page.waitForEvent('filechooser');
  await openPlusMenu(page);
  await page
    .locator(PLUS_ITEMS)
    .getByRole('button', { name: '打开文件', exact: true })
    .click();
  await (await chooser).setFiles(files);
}

/** ＋ 菜单「打开文件夹」条目点击（showDirectoryPicker 由用例侧承接：
 * headless 立即 AbortError 或 hook createElement 的回退通道） */
export async function plusOpenFolder(page: Page): Promise<void> {
  await openPlusMenu(page);
  await page
    .locator(PLUS_ITEMS)
    .getByRole('button', { name: '打开文件夹', exact: true })
    .click();
}

/** ＋ 菜单「粘贴 URL」：行内展开单行表单并提交（input aria-label=「文件 URL」
 * 沿用 TopBar 原文；回车提交，提交后展开行收起、＋ 菜单保持开） */
export async function plusOpenUrl(page: Page, url: string): Promise<void> {
  await openPlusMenu(page);
  await page.locator(PLUS_ITEMS).getByRole('button', { name: '粘贴 URL' }).click();
  const input = page.locator(PLUS_ITEMS).getByLabel('文件 URL');
  await input.fill(url);
  await input.press('Enter');
}

/** ⋯ 菜单「连接服务器」：展开内联表单（菜单保持开），返回 .vv-server-form 作用域。
 * 连接成功后浮层自动收起（onconnected → menu=null）——提交后的等待/断言照旧。 */
export async function overflowConnectServer(page: Page): Promise<Locator> {
  await openOverflowMenu(page);
  await page
    .locator(OVERFLOW_POP)
    .getByRole('button', { name: '连接服务器', exact: true })
    .click();
  const form = page.locator(`${OVERFLOW_POP} .vv-server-form`);
  await expect(form).toBeVisible();
  return form;
}
