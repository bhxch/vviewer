import { test, expect } from '@playwright/test';

/**
 * 服务端模式冒烟用例：release 二进制同源伺服 web-dist（:4174），
 * 打开首页断言应用壳渲染（壳选择器与既有 e2e 同源：AppShell.svelte 的
 * .vv-shell/.vv-main/.vv-topbar/.vv-brand）。只验证壳可用 + 免鉴权
 * /api/health 能力宣告，连接/目录树/渲染全链路属 m5/m6 域用例，不在此重复。
 */
test('服务端模式首页渲染应用壳', async ({ page }) => {
  const health = await page.request.get('/api/health');
  await expect(health).toBeOK();
  const body = await health.json();
  expect(body.name).toBe('vviewer');
  expect(body.capabilities).toContain('file-server');

  await page.goto('/');
  await expect(page.locator('.vv-shell')).toBeVisible();
  await expect(page.locator('.vv-topbar .vv-brand')).toHaveText('vviewer');
  await expect(page.locator('.vv-side')).toBeVisible();
  await expect(page.locator('.vv-main')).toBeVisible();
});
