import AxeBuilder from '@axe-core/playwright';
import { test, expect, type Page } from '@playwright/test';
import { openDirText, openFile, tabNamed, waitAppMounted } from './helpers';
import { gotoGroup, openSettings } from './settings-center';
import { openMenu, MENU_POP } from './tabbar-menu';

/**
 * b-a11y-axe 全页可达性扫描域（A11Y- 域，a11y 重构 spec Task 2）：
 *
 * @axe-core/playwright 全页扫描，规则集 wcag2a + wcag21a（A 档；color-contrast
 * 属 AA 档不在集内，由对比度机检承接），**零 violation 断言**（D9 口径）——
 * 扫出的违规必须真修（改产品），不允许 AxeBuilder.exclude / withRules 豁免。
 * 虚拟滚动区域只扫可视 DOM（axe 对 display:none 天然跳过），面板态扫前均等待
 * 挂载/加载完成（各态打开装置内置 toBeVisible 守卫）。夹具选无外联载荷
 * （markdown 不含图表围栏、code 走 build:e2e 的 CDN 注入面），零网络依赖
 * （axe-core 本地打包，CI 默认套件自动覆盖）。
 *
 * 状态矩阵（≥7 态，设计 §4.3）：空壳 / markdown 样例 / code 语料 / 设置中心 /
 * 设置中心「语言与辅助功能」组（Task 6 补扫，域 C 抽取的 aria 复核面）/
 * QuickOpen / 目录管理 / 全局搜索 / TabBarMenu 融合菜单展开。双 project（桌面
 * + mobile 375×667）各跑一遍：抽屉/触屏形态若引出额外违规，按 D9 真修；
 * 确属移动形态固有且桌面已覆盖的，允许用例级 test.skip 限定 project 并注明
 * 理由（用例级取舍，不是规则豁免）。
 */

/** 全页 axe 扫描（wcag2a+wcag21a），违规清空断言——失败信息内联违规清单便于定位 */
async function expectNoAxeViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag21a']).analyze();
  expect(
    results.violations,
    JSON.stringify(
      results.violations.map((v) => ({
        id: v.id,
        impact: v.impact,
        nodes: v.nodes.map((n) => ({ target: n.target, summary: n.failureSummary }))
      }))
    )
  ).toEqual([]);
}

const MARKDOWN_SAMPLE = [
  '# a11y 探针样例',
  '',
  '一段**普通**段落，含 `inline code` 与列表：',
  '',
  '- 条目一',
  '- 条目二',
  '',
  '> 引用块',
  '',
  '| 列 A | 列 B |',
  '| ---- | ---- |',
  '| 1    | 2    |',
  ''
].join('\n');

const CODE_SAMPLE = [
  'export function add(a: number, b: number): number {',
  '  return a + b;',
  '}',
  '',
  'export const answer = add(40, 2);',
  ''
].join('\n');

test.describe('b-a11y-axe 全页可达性扫描（wcag2a+wcag21a 零违规）', () => {
  test('A11Y-01 空壳态', async ({ page }) => {
    await page.goto('/');
    await waitAppMounted(page);
    await expectNoAxeViolations(page);
  });

  test('A11Y-02 打开 markdown 样例', async ({ page }) => {
    await page.goto('/');
    await waitAppMounted(page);
    await openDirText(page, 'a11y-md', 'sample.md', MARKDOWN_SAMPLE);
    // openFile 装置含 ≤900px 抽屉断点适配（mobile project 同流）；打开后抽屉已收，
    // axe 扫的是抽屉关态主区
    await openFile(page, 'sample.md');
    await expect(page.locator('.vv-markdown')).toBeVisible({ timeout: 20_000 });
    await expectNoAxeViolations(page);
  });

  test('A11Y-03 打开 code 语料', async ({ page }) => {
    await page.goto('/');
    await waitAppMounted(page);
    await openDirText(page, 'a11y-code', 'sample.ts', CODE_SAMPLE);
    await openFile(page, 'sample.ts');
    await expect(tabNamed(page, 'sample.ts')).toBeVisible();
    // 内容挂载守卫（对齐 A11Y-02 对 .vv-markdown 的口径）：防虚拟滚动未挂载时
    // axe 扫到空主区而静默弱化
    await expect(page.locator('.vv-code-pre')).toBeVisible({ timeout: 20_000 });
    await expectNoAxeViolations(page);
  });

  test('A11Y-04 设置中心', async ({ page }) => {
    await page.goto('/');
    await waitAppMounted(page);
    await openSettings(page);
    await expectNoAxeViolations(page);
  });

  test('A11Y-09 设置中心「语言与辅助功能」组（Task 3 披露的 gotoGroup 扩展位，域 C 抽取后 aria 复扫）', async ({
    page
  }) => {
    await page.goto('/');
    await waitAppMounted(page);
    await openSettings(page);
    // A11Y-04 只扫默认激活组「外观」；本用例切到 i18n 基建新节（Task 3 披露项），
    // 并覆盖域 C 全部 11 节抽取后的左导航组名 aria（组名 init 期 t()）与新节控件
    await gotoGroup(page, '语言与辅助功能');
    await expect(page.locator('.vv-sc-section').first()).toBeVisible();
    await expectNoAxeViolations(page);
  });

  test('A11Y-05 QuickOpen 开启', async ({ page }) => {
    await page.goto('/');
    await waitAppMounted(page);
    await page.keyboard.press('Control+p');
    await expect(page.locator('.vv-quickopen')).toBeVisible();
    await expectNoAxeViolations(page);
  });

  test('A11Y-06 目录管理面板', async ({ page }) => {
    await page.goto('/');
    await waitAppMounted(page);
    await openMenu(page);
    await page.locator(MENU_POP).getByRole('button', { name: /目录管理|Mounts/ }).click();
    await expect(page.locator('.vv-mounts-manager')).toBeVisible();
    await expectNoAxeViolations(page);
  });

  test('A11Y-07 全局搜索面板', async ({ page }) => {
    await page.goto('/');
    await waitAppMounted(page);
    await page.keyboard.press('Control+Shift+f');
    await expect(page.locator('.vv-gsearch')).toBeVisible();
    await expectNoAxeViolations(page);
  });

  test('A11Y-08 TabBarMenu 融合菜单展开', async ({ page }) => {
    await page.goto('/');
    await waitAppMounted(page);
    await openMenu(page);
    await expect(page.locator('.vv-tbmenu-pop')).toBeVisible();
    await expectNoAxeViolations(page);
  });
});
