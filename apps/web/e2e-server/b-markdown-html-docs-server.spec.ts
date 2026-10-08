import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, type Page } from '@playwright/test';

/**
 * markdown-html-docs 域 · 服务端模式补缺（BUG-17 / MD-11 回归，域文档第 3 节验收行为）：
 * 域文档统一前置即服务端模式（vviewer serve 同源伺服 web-dist 与夹具目录）。
 * 纯前端侧的净化回归见 e2e/b-markdown-html-docs-bug-regressions.spec.ts；此处补
 * 服务端文件服务链路下的同套验收：danger.html 经 /api/file 拉取 → 沙箱净化、
 * 外域图片零网络请求；danger.md 经远程 store → markdown 管线净化。
 * 夹具写入运行期 fs（固定夹具目录，独立命名不与 fixtures.mjs 产物冲突）：
 * 文件服务按请求读盘，server 启动后新增文件对目录树可见。
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const FIXTURE = process.env.VV_E2E_SERVER_FIXTURE ?? join(repoRoot, '.temp/e2e-server-fixture');
// 与 playwright.server.config.ts 的 BASE_URL 同源（:4174）
const BASE_URL = 'http://127.0.0.1:4174';

const DANGER_HTML = `<!DOCTYPE html>
<html>
<head><title>server danger</title></head>
<body>
<script>window.__vvSrvExecuted = true;</script>
<img src="http://external.example.com/track.png" onerror="window.__vvSrvOnError = true">
<a href="javascript:alert('srv-xss')">js 链接</a>
<p style="color:teal">行内样式文本</p>
</body>
</html>`;

const DANGER_MD = ['![track](http://external.example.com/track.png)', ''].join('\n');

const EXTERNAL_HOSTS = /external\.example\.com/;

test.beforeAll(() => {
  mkdirSync(FIXTURE, { recursive: true });
  writeFileSync(join(FIXTURE, 'bmd-danger.html'), DANGER_HTML);
  writeFileSync(join(FIXTURE, 'bmd-danger.md'), DANGER_MD);
});

/** TopBar 连接表单：无 token 启动的 server 全放行（server/src/auth.rs 无 token 配置全放行） */
async function connectSameOrigin(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: '连接服务器' }).click();
  await page.getByLabel('服务器地址').fill(BASE_URL);
  await page.getByRole('button', { name: '连接', exact: true }).click();
  await expect(page.locator('.vv-tree-row', { hasText: 'bmd-danger.html' })).toBeVisible({
    timeout: 10_000
  });
}

test('服务端模式 MD-11/BUG-17：danger.html 经 /api/file 渲染，净化达标且外域图片零请求', async ({
  page
}) => {
  test.setTimeout(60_000);
  const urls: string[] = [];
  page.on('request', (r) => urls.push(r.url()));
  await connectSameOrigin(page);

  await page.locator('.vv-tree-row', { hasText: 'bmd-danger.html' }).click();
  const frame = page.locator('.vv-html-frame');
  await expect(frame).toBeVisible({ timeout: 20_000 });
  // 日志窗口证明：文件本体确实经网络服务拉取（外域 GET 若存在必然紧随其后）
  expect(urls.some((u) => u.includes('/api/file'))).toBe(true);

  const stats = await page.evaluate(() => {
    const f = document.querySelector('.vv-html-frame') as HTMLIFrameElement;
    const doc = f.contentDocument;
    if (!doc) throw new Error('contentDocument 不可读');
    let scripts = 0;
    let onAttrs = 0;
    for (const el of Array.from(doc.querySelectorAll('*'))) {
      if (el.tagName === 'SCRIPT') scripts += 1;
      for (const a of Array.from(el.attributes)) if (/^on/i.test(a.name)) onAttrs += 1;
    }
    return {
      scripts,
      onAttrs,
      jsHref: Array.from(doc.querySelectorAll('a')).some((a) =>
        (a.getAttribute('href') ?? '').trim().toLowerCase().startsWith('javascript:')
      ),
      httpImgs: Array.from(doc.querySelectorAll('img'))
        .map((i) => i.getAttribute('src') ?? '')
        .filter((s) => /^https?:/i.test(s.trim())),
      blockedImgs: doc.querySelectorAll('img[data-vv-blocked-external]').length,
      inlineStyleKept: doc.querySelector('p[style]') !== null,
      executed: (f.contentWindow as unknown as Record<string, unknown> | null)?.__vvSrvExecuted === true
    };
  });
  expect(stats.scripts).toBe(0);
  expect(stats.onAttrs).toBe(0);
  expect(stats.jsHref).toBe(false);
  expect(stats.executed).toBe(false);
  expect(stats.httpImgs).toEqual([]);
  expect(stats.blockedImgs).toBe(1);
  expect(stats.inlineStyleKept).toBe(true);

  await page.waitForTimeout(1_500);
  expect(urls.filter((u) => EXTERNAL_HOSTS.test(u))).toEqual([]);
});

test('服务端模式 MD-11/BUG-17：远程 store markdown 渲染，外域图片同样拦截零请求', async ({
  page
}) => {
  test.setTimeout(60_000);
  const urls: string[] = [];
  page.on('request', (r) => urls.push(r.url()));
  await connectSameOrigin(page);

  await page.locator('.vv-tree-row', { hasText: 'bmd-danger.md' }).click();
  const md = page.locator('.vv-markdown');
  await expect(md).toBeVisible({ timeout: 20_000 });
  expect(urls.some((u) => u.includes('/api/file'))).toBe(true);

  const blocked = md.locator('img[data-vv-blocked-external]');
  await expect(blocked).toHaveCount(1);
  await expect(blocked).toHaveAttribute('title', /external\.example\.com/);
  await expect(md.locator('img[src^="http"]')).toHaveCount(0);

  await page.waitForTimeout(1_500);
  expect(urls.filter((u) => EXTERNAL_HOSTS.test(u))).toEqual([]);
});
