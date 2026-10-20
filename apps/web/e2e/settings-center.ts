import { expect, type Page } from '@playwright/test';

/**
 * 设置中心 e2e 共用装置（settings center 2026-10-19，Task 5 迁移共用）：
 * 全屏 overlay（.vv-settings-center，role=dialog name=设置）取代退役的
 * .vv-settings 弹层后，各 spec 的「开面板→改→即时生效」断言统一迁移为
 * 「开页→切组→改→应用」管线。本模块只收装置，不含断言策略。
 *
 * - 打开：TopBar ⚙（aria-label「设置」）；Ctrl+, 入口的专项断言在
 *   b-settings-center（双入口用例），迁移用例统一走 ⚙ 通道。
 * - 应用：草稿→saveSettings 订阅链的唯一落盘时机；应用成功后「应用/放弃」
 *   钮复位为 disabled（脏态清除的同步信号，后续断言以此为界）。
 * - 关闭：Esc。脏态（canApply）时 Esc 只弹确认条不关页——调用方须先应用
 *   或放弃（closeSettings 的 toHaveCount(0) 即守卫）。
 */

/** 设置中心根（全屏 overlay；OVERLAY_SELECTOR 入册类名） */
export const SETTINGS_ROOT = '.vv-settings-center';

/** 打开设置中心（⚙ → 全屏页；返回根 locator 便于调用方局部断言） */
export async function openSettings(page: Page): Promise<void> {
  await page.locator('button[aria-label="设置"]').click();
  await expect(page.locator(SETTINGS_ROOT)).toBeVisible();
}

/** 左导航切组（按钮文案即组名：外观/字体/图表/布局/搜索与排除/自动刷新/计算/存储与数据/关于） */
export async function gotoGroup(page: Page, label: string): Promise<void> {
  await page.locator('.vv-sc-navitem', { hasText: label }).click();
}

/** 应用（草稿统一落盘；返回后「应用」已复位 disabled = 脏态已清） */
export async function applySettings(page: Page): Promise<void> {
  await page.locator('.vv-sc-apply').click();
  await expect(page.locator('.vv-sc-apply')).toBeDisabled();
}

/** 关闭（Esc；脏态残留时确认条会挡下关闭——toHaveCount(0) 即脏态守卫） */
export async function closeSettings(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await expect(page.locator(SETTINGS_ROOT)).toHaveCount(0);
}

/** 计算策略切换（设置中心「计算」组——自 TopBar 下拉迁入的完整用户管线；t-hl/m6/t-md 共用） */
export async function setComputePolicy(
  page: Page,
  policy: 'auto' | 'local' | 'remote'
): Promise<void> {
  await openSettings(page);
  await gotoGroup(page, '计算');
  await page.getByLabel('计算策略').selectOption(policy);
  await applySettings(page);
  await closeSettings(page);
}
