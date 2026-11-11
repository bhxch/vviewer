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

/** 点触发钮打开融合菜单浮层（TRIGGER 类锚）。
 *
 * 水合竞态根治（T13b，2026-11-12 探针实证）：SvelteKit SPA fallback + Svelte 5
 * 启动路径下，触发钮 DOM 可见早于根级委托 click 监听挂载约 200-400ms（全量并发
 * 负载下更长；探针 dump：trusted click t=370ms 命中触发钮、委托监听 t=591ms 才
 * 挂载、浮层此后永不出现——Svelte 内部 event delegation 在组件 mount 完成**之后**
 * 才安装，OPEN-01/02「监听挂载前派发的事件永久丢失」同族）。单发点击落进竞态窗
 * 即被吞且不可恢复，故改自校验重试：click → 浮层可见才算成功，未开（被吞）即
 * 退避重试。浮层既现即委托监听必已挂载，故本装置同时是整条菜单流（openSubmenu
 * 与浮层内条目点击）的监听就绪锚，后续点击免再锚。 */
export async function openMenu(page: Page): Promise<void> {
  const trigger = page.locator(TRIGGER);
  await trigger.waitFor({ state: 'visible', timeout: 20_000 });
  const pop = page.locator(MENU_POP);
  await expect(async () => {
    await trigger.click({ timeout: 2_000 });
    await expect(pop).toBeVisible({ timeout: 250 });
  }).toPass({ timeout: 15_000, intervals: [100, 250, 500] });
}

/** 应用交互就绪门（T13b）：openMenu → 点触发钮收回，一个开合来回。openMenu 的
 * 自校验重试通过即委托 click 监听已挂载（组件 mount 完成），此后整个文档上的
 * UI 交互——含 contextmenu 右键、pointer 拖拽、svelte:window keydown（均在
 * mount 同期挂载，不晚于委托监听）——全部生效。供 goto 后不经菜单/设置装置、
 * 直接点壳内元素的 spec（b-layout-zen 折叠/右键/Ctrl+,、mobile 抽屉等）在首
 * 交互前调用一次。菜单开合零持久化副作用，落点为关态，不影响后续断言。 */
export async function primeUiInteractive(page: Page): Promise<void> {
  await openMenu(page);
  await page.locator(TRIGGER).click();
  await expect(page.locator(MENU_POP)).toHaveCount(0);
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
