import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect, type Page } from '@playwright/test';
import { closeDrawerIfOpened, openDrawerIfNarrow } from './drawer';

const samples = fileURLToPath(new URL('../../../samples/m2', import.meta.url));

/** M3 Task 6 E2E：文件内搜索面板（/ 打开、n/N 计数、Enter 推进、Esc 关闭、焦点还原）。
 * 通道同 m1/m2：页面内构造 File + webkitRelativePath 经 __vvOpenDirImpl 注入。 */
const SAMPLES = ['sample.md', 'sample.ts'].map((name) => ({
  name,
  type: name.endsWith('.md') ? 'text/markdown' : 'text/plain',
  b64: readFileSync(`${samples}/${name}`).toString('base64')
}));

async function openDir(page: Page): Promise<void> {
  await page.waitForFunction(
    () => typeof (window as unknown as { __vvOpenDirImpl?: unknown }).__vvOpenDirImpl === 'function'
  );
  await page.evaluate((payloads) => {
    const files = payloads.map(({ name, type, b64 }) => {
      const f = new File([Uint8Array.from(atob(b64!), (c) => c.charCodeAt(0))], name, { type });
      Object.defineProperty(f, 'webkitRelativePath', { value: `m2/${name}` });
      return f;
    });
    return (window as unknown as { __vvOpenDirImpl: (f: File[]) => void }).__vvOpenDirImpl(files);
  }, SAMPLES);
}

async function openFile(page: Page, name: string): Promise<void> {
  // 移动视口：树行在抽屉内，开抽屉点击后关闭（drawer.ts）
  const drawer = await openDrawerIfNarrow(page);
  await page.locator('.vv-tree-row', { hasText: name }).click();
  await closeDrawerIfOpened(page, drawer);
  await expect(page.locator('.vv-tab.active', { hasText: name })).toBeVisible();
}

async function openPanelAndSearch(page: Page, term: string): Promise<void> {
  await page.keyboard.press('/'); // 树行按钮持焦，非输入框 → 面板打开
  await expect(page.locator('.vv-search-panel')).toBeVisible();
  await expect(page.locator('.vv-search-input')).toBeFocused();
  await page.keyboard.insertText(term);
  await expect(page.locator('.vv-search-count')).toContainText(/\d+\/\d+/, { timeout: 5_000 });
}

test('markdown 视图：/ 搜索（计数/mark 包裹/Enter 推进），Esc 关闭并还原文本', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/');
  await openDir(page);
  await openFile(page, 'sample.md');
  await expect(page.locator('.vv-markdown')).toBeVisible();

  await openPanelAndSearch(page, '围栏');
  const count = await page.locator('.vv-search-count').textContent();
  const total = Number(count!.trim().split('/')[1]);
  expect(total).toBeGreaterThan(0);
  await expect(page.locator('mark.vv-search-hit')).toHaveCount(total);
  await expect(page.locator('mark.vv-search-hit-active')).toHaveCount(1);

  // Enter 推进：计数 n/N 的 n 前进（环绕由 panel 逻辑保证，此处断言变化即可）
  const before = await page.locator('.vv-search-count').textContent();
  await page.keyboard.press('Enter');
  await expect(page.locator('.vv-search-count')).not.toHaveText(before!);

  // 输入框持焦按 Esc：面板关闭，mark 还原、文本无损
  await page.keyboard.press('Escape');
  await expect(page.locator('.vv-search-panel')).toHaveCount(0);
  await expect(page.locator('mark.vv-search-hit')).toHaveCount(0);
  await expect(page.locator('.vv-markdown')).toContainText('围栏');
});

test('Esc 焦点态与焦点还原：✕/↓ 按钮持焦按 Esc 可关闭，焦点回落查看器宿主', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/');
  await openDir(page);
  await openFile(page, 'sample.md');
  await expect(page.locator('.vv-markdown')).toBeVisible();

  await openPanelAndSearch(page, '围栏');
  // 焦点移到 ↓ 按钮（面板内非输入焦点），Escape 仍须关闭（keydown 绑面板容器）
  await page.locator('.vv-search-btn[aria-label="下一个"]').focus();
  await page.keyboard.press('Escape');
  await expect(page.locator('.vv-search-panel')).toHaveCount(0);
  // 关闭后焦点还原：面板元素已移除 → 回落 .vv-viewer-host（setTimeout(0) 落在卸载后）
  await page.waitForFunction(() => document.activeElement?.classList.contains('vv-viewer-host'));
});

test('code 视图：行级命中高亮，关闭（search(\'\')）后高亮立即消退且焦点还原', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/');
  await openDir(page);
  await openFile(page, 'sample.ts');
  await expect(page.locator('.vv-code-pre')).toBeVisible();

  await openPanelAndSearch(page, 'export');
  await expect(page.locator('.vv-code-line.vv-search-hit-line')).toHaveCount(1);
  await expect(page.locator('mark.vv-search-hit')).toHaveCount(0); // code 视图无 DOM mark

  // 聚焦 ✕ 按钮关闭：退出搜索走 search('')，行级高亮立即消退（不等 1.5s 计时）
  await page.locator('.vv-search-btn[aria-label="关闭搜索"]').focus();
  await page.keyboard.press('Escape');
  await expect(page.locator('.vv-search-panel')).toHaveCount(0);
  await expect(page.locator('.vv-code-line.vv-search-hit-line')).toHaveCount(0);
  await page.waitForFunction(() => document.activeElement?.classList.contains('vv-viewer-host'));
});
