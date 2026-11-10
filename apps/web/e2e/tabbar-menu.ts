import { expect, type Locator, type Page } from '@playwright/test';

/**
 * TabBar 左端融合菜单 e2e 装置（标签栏收敛 spec Task 1）。
 *
 * 融合菜单宿主为 .vv-tabbar-menu（TabBarMenu.svelte）：单触发钮「工作区名 ▾」
 * + 单浮层承载全部全局功能（工作区/打开/刷新/连接服务器/主题/目录管理/设置/
 * 专注），子菜单为就地手风琴（工作区/打开/主题三父项，同刻至多一个展开）。
 * 本文件收敛「点触发钮 →（点子菜单父项）→ 点浮层条目」的两/三段流，替代原
 * tabbar-actions 的 ＋/⋯ 双触发钮流（随四件簇退役删除）。aria-label/条目文案
 * 与旧簇逐字相同（组件锚红线），变化仅两点：容器作用域随迁 + 打开三通道经
 * 「打开」子菜单多一步父项点击。
 *
 * 选择器约定：触发钮限 `.vv-tabbar-menu`（最窄稳定作用域），浮层条目限
 * `.vv-tbmenu-pop`（同刻至多一个浮层开，locator 天然唯一）。
 */

/** TabBar 左端融合菜单容器（TabBar.svelte 内固定插槽，不随 tabs 滚动） */
export const TABBAR_MENU = '.vv-tabbar-menu';

/** 融合菜单触发钮（类锚；aria-label 动态「工作区：工作区名」——a11y Task 2 真修
 * label-content-name-mismatch，原静态「切换工作区」红线解除；文本恒「工作区名 ▾」，
 * narrow 分支退役） */
export const TRIGGER = `${TABBAR_MENU} .vv-tbmenu-trigger`;

/** 融合菜单浮层（首层 8 行 + 子菜单/行内表单同浮层，同刻至多一个开） */
export const MENU_POP = '.vv-tbmenu-pop';

/** 点触发钮打开融合菜单浮层（TRIGGER 类锚） */
export async function openMenu(page: Page): Promise<void> {
  await page.locator(TRIGGER).click();
  await expect(page.locator(MENU_POP)).toBeVisible();
}

/** 打开子菜单（就地手风琴：openMenu 后点子菜单父项一行，aria-expanded 翻转断言
 * 收口；which=父项可见文本=accessible name——chevron ▸ 为 aria-hidden span 不进
 * name）。前置条件：菜单浮层处于关态（openMenu 内含触发钮 click toggle） */
export async function openSubmenu(page: Page, which: '工作区' | '打开' | '主题'): Promise<void> {
  await openMenu(page);
  const row = page.locator(MENU_POP).getByRole('button', { name: which, exact: true });
  await row.click();
  await expect(row).toHaveAttribute('aria-expanded', 'true');
}

/** 「打开」子菜单「打开文件」：filechooser 通道喂 files（hidden input 常驻挂载，
 * 菜单条目点击后 menu 收起再弹原生选择器，事件先注册后点击）。
 * 调用者：b-tabbar-menu.spec.ts MEN-01 ①（filechooser 通道开文件档） */
export async function menuOpenFile(page: Page, files: string | string[]): Promise<void> {
  const chooser = page.waitForEvent('filechooser');
  await openSubmenu(page, '打开');
  await page
    .locator(MENU_POP)
    .getByRole('button', { name: '打开文件', exact: true })
    .click();
  await (await chooser).setFiles(files);
}

/** 「打开」子菜单「打开文件夹」条目点击（showDirectoryPicker 由用例侧承接：
 * headless 立即 AbortError 或 hook createElement 的回退通道） */
export async function menuOpenFolder(page: Page): Promise<void> {
  await openSubmenu(page, '打开');
  await page
    .locator(MENU_POP)
    .getByRole('button', { name: '打开文件夹', exact: true })
    .click();
}

/** 「打开」子菜单「粘贴 URL」：行内展开单行表单并提交（input aria-label=「文件 URL」
 * 沿用原文；回车提交，提交后展开行收起、菜单保持开） */
export async function menuOpenUrl(page: Page, url: string): Promise<void> {
  await openSubmenu(page, '打开');
  await page.locator(MENU_POP).getByRole('button', { name: '粘贴 URL' }).click();
  const input = page.locator(MENU_POP).getByLabel('文件 URL');
  await input.fill(url);
  await input.press('Enter');
}

/** 融合菜单「连接服务器」：展开内联表单（菜单保持开），返回 .vv-server-form 作用域。
 * 连接成功后浮层自动收起（onconnected → menuOpen=false）——提交后的等待/断言照旧。 */
export async function menuConnectServer(page: Page): Promise<Locator> {
  await openMenu(page);
  await page
    .locator(MENU_POP)
    .getByRole('button', { name: '连接服务器', exact: true })
    .click();
  const form = page.locator(`${MENU_POP} .vv-server-form`);
  await expect(form).toBeVisible();
  return form;
}
