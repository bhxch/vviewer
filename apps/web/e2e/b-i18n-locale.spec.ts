import { test, expect, type Page } from '@playwright/test';
import { waitAppMounted } from './helpers';
import { applySettings, closeSettings, gotoGroup, openSettings } from './settings-center';

/**
 * b-i18n-locale 语言与减少动效域（i18n 基建 spec，I18N- 域，b- 前缀）：
 *
 * - I18N-01 默认 zh-CN：html[lang]=zh-CN（app.html 静态兜底 + 启动接线同值）、
 *   「语言与辅助功能」节标签中文
 * - I18N-02 切 en（UI 管线：下拉→应用→订阅链）：节标签就地翻英 + html[lang]=en
 * - I18N-03 reload 持久化：en 落盘 → 重载后启动接线恢复 html[lang]=en，
 *   组名（SettingsCenter 挂载期 t()）随持久化 locale 翻英
 * - I18N-04 切回 zh-CN：en↔zh 双向往返，html[lang] 与标签双侧复原
 * - I18N-05 减少动效三态：on/off 显式打标 html[data-reduce-motion]，
 *   system 移除属性（CSS media 块承接=现状语义）
 *
 * 每用例独立 context（Playwright 默认）→ localStorage 净空，I18N-01 默认态
 * 不受同文件前序用例污染；I18N-03/04 内部自建 en 前置（UI 管线复走，不依赖
 * 跨用例持久化）。
 */

/** 「语言与辅助功能」节内控件锚（zh/en 双语通用：getByLabel 走目录值） */
function languageSelect(page: Page, label: string) {
  return page.getByLabel(label);
}

async function gotoLanguageA11y(page: Page, groupLabel: string): Promise<void> {
  await gotoGroup(page, groupLabel);
  await expect(page.locator('.vv-sc-section').first()).toBeVisible();
}

test.describe('b-i18n-locale 语言与减少动效', () => {
  test('I18N-01 · 默认 zh-CN：html[lang]=zh-CN + 节标签中文', async ({ page }) => {
    await waitAppMounted(page);
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');

    await openSettings(page);
    await gotoLanguageA11y(page, '语言与辅助功能');
    await expect(languageSelect(page, '界面语言')).toBeVisible();
    await expect(languageSelect(page, '减少动效')).toBeVisible();
    // 默认值：locale zh-CN / reduceMotion system（DEFAULTS 口径）
    await expect(languageSelect(page, '界面语言')).toHaveValue('zh-CN');
    await expect(languageSelect(page, '减少动效')).toHaveValue('system');
  });

  test('I18N-02 · 切 en（UI 管线）：节标签就地翻英 + html[lang]=en', async ({ page }) => {
    await waitAppMounted(page);
    await openSettings(page);
    await gotoLanguageA11y(page, '语言与辅助功能');

    await languageSelect(page, '界面语言').selectOption('en');
    await applySettings(page);

    // 响应式 t()（$state locale 镜像）：同面板内标签即时翻英
    await expect(languageSelect(page, 'Interface language')).toBeVisible();
    await expect(languageSelect(page, 'Reduce motion')).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  });

  test('I18N-03 · reload 持久化 en：启动接线恢复 html[lang] + 组名翻英', async ({ page }) => {
    await waitAppMounted(page);
    await openSettings(page);
    await gotoLanguageA11y(page, '语言与辅助功能');
    await languageSelect(page, '界面语言').selectOption('en');
    await applySettings(page);
    await closeSettings(page);

    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    // 设置中心挂载期 t()（groups 注册表 init 取当下 locale）随持久化 en 翻英
    await openSettings(page);
    await gotoLanguageA11y(page, 'Language & accessibility');
    await expect(languageSelect(page, 'Interface language')).toHaveValue('en');
  });

  test('I18N-04 · 切回 zh-CN：en↔zh 双向往返复原', async ({ page }) => {
    await waitAppMounted(page);
    await openSettings(page);
    await gotoLanguageA11y(page, '语言与辅助功能');
    await languageSelect(page, '界面语言').selectOption('en');
    await applySettings(page);
    await closeSettings(page);

    // 重开（en 态导航）→ 切回 zh-CN
    await openSettings(page);
    await gotoLanguageA11y(page, 'Language & accessibility');
    await languageSelect(page, 'Interface language').selectOption('zh-CN');
    await applySettings(page);
    await expect(languageSelect(page, '界面语言')).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');

    // 再开：组名复原中文（挂载期 t() 随当前 locale）
    await closeSettings(page);
    await openSettings(page);
    await gotoLanguageA11y(page, '语言与辅助功能');
    await expect(languageSelect(page, '界面语言')).toHaveValue('zh-CN');
  });

  test('I18N-05 · 减少动效三态：on/off 显式打标 + system 属性移除', async ({ page }) => {
    await waitAppMounted(page);
    await openSettings(page);
    await gotoLanguageA11y(page, '语言与辅助功能');

    const html = page.locator('html');

    await languageSelect(page, '减少动效').selectOption('on');
    await applySettings(page);
    await expect(html).toHaveAttribute('data-reduce-motion', 'on');

    await languageSelect(page, '减少动效').selectOption('off');
    await applySettings(page);
    await expect(html).toHaveAttribute('data-reduce-motion', 'off');

    // 跟随系统：属性移除（CSS @media prefers-reduced-motion 块承接）
    await languageSelect(page, '减少动效').selectOption('system');
    await applySettings(page);
    expect(await html.getAttribute('data-reduce-motion')).toBeNull();
  });
});
