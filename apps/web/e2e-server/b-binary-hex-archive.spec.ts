import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';

/**
 * binary-hex-archive 域 · 服务端模式补充 E2E（b- 前缀）。
 * 场景来源：docs/e2e/binary-hex-archive.md BIN-10 / BUG-13（medium · verified）。
 * 树点击入口的纯前端回归在 apps/web/e2e/b-binary-hex-archive.spec.ts；本文件补
 * 报告明确要求的两入口一致性（§5 BUG-13 验收第 5 条：树点击与「文件 URL」两入口
 * 都要验证）与「判定基于内容嗅探而非 Content-Type」的服务端证据（§5 第 4 条）：
 * 1. 服务端 /api/file 对 zip-as-txt.txt 按扩展名下发 text/plain（报告 curl 实测
 *    text/plain + x-vv-encoding），前端 magic 预检（504b0304）仍重定向压缩包渲染器；
 * 2. 树点击入口（服务端 store）与 URL 入口（createUrlStore）均展示包内条目树，
 *    可继续递归预览（hello.txt 内嵌文件可读）；
 * 3. 只重定向一次不循环：条目树稳定渲染、文件内容仅拉取有限次。
 * 夹具：beforeAll 将 samples/m4/sample.zip（头部 504b0304）复制为 fixture 根下
 * zip-as-txt.txt（报告口径 cp 改名件；文件名与基础夹具及其他域用例不重叠）。
 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const PORT = 4174;
const BASE = `http://127.0.0.1:${PORT}`;
const FIXTURE = process.env.VV_E2E_SERVER_FIXTURE ?? join(repoRoot, '.temp/e2e-server-fixture');
// 夹具直接放 fixture 根：服务端文件树默认不展开子目录；文件名与基础夹具及其他域用例均不重叠
const BIN_DIR = FIXTURE;

test.beforeAll(() => {
  mkdirSync(BIN_DIR, { recursive: true });
  writeFileSync(join(BIN_DIR, 'zip-as-txt.txt'), '');
  copyFileSync(join(repoRoot, 'samples/m4/sample.zip'), join(BIN_DIR, 'zip-as-txt.txt'));
});

/** 展开 TopBar 连接表单并提交（服务器无 token 配置，令牌留空） */
async function connect(page: import('@playwright/test').Page): Promise<void> {
  await page.getByRole('button', { name: '连接服务器' }).click();
  await page.getByLabel('服务器地址').fill(BASE);
  await page.getByRole('button', { name: '连接', exact: true }).click();
  await expect(page.locator('.vv-tree')).toBeVisible({ timeout: 15_000 });
}

test('BIN-10/BUG-13：改名 zip 两入口均重定向压缩包渲染器，判定基于内容嗅探而非 Content-Type', async ({
  page
}) => {
  test.setTimeout(120_000);
  const manifestRequests: string[] = [];
  page.on('request', (r) => {
    const u = r.url();
    if (u.includes('zip-as-txt.txt')) manifestRequests.push(u);
  });

  // ---- 服务端证据：按扩展名下发 text/plain（报告 curl 口径），重定向只能靠内容嗅探 ----
  const res = await page.request.get(`${BASE}/api/file?path=zip-as-txt.txt`);
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toContain('text/plain');
  expect((await res.body()).subarray(0, 4)).toEqual(Uint8Array.from([0x50, 0x4b, 0x03, 0x04])); // PK\x03\x04

  await page.goto('/');
  await connect(page);

  // ---- 入口一（树点击）：条目树渲染而非 code 乱码 ----
  await page.locator('.vv-tree-row', { hasText: 'zip-as-txt.txt' }).click();
  await expect(page.locator('.vv-tab.active', { hasText: 'zip-as-txt.txt' })).toBeVisible();
  const pane = page.locator('.vv-archive');
  await expect(pane.locator('.vv-tree-row', { hasText: 'hello.txt' })).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.vv-code-pre')).toHaveCount(0);

  // ---- 入口二（TopBar 文件 URL）：createUrlStore 无扩展名文件名，签名改派链路由压缩包 ----
  await page.getByLabel('文件 URL').fill(`${BASE}/api/file?path=zip-as-txt.txt`);
  await page.getByLabel('文件 URL').press('Enter');
  await expect(page.locator('.vv-tab.active', { hasText: 'file' })).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.vv-archive .vv-tree-row', { hasText: 'hello.txt' })).toBeVisible({
    timeout: 20_000
  });
  await expect(page.locator('.vv-code-pre')).toHaveCount(0);

  // ---- 两入口一致性：均能继续 BIN-06 式递归预览（hello.txt 内容正确）----
  await page.locator('.vv-archive .vv-tree-row', { hasText: 'hello.txt' }).click();
  await expect(page.locator('.vv-tab.active', { hasText: 'hello.txt' })).toBeVisible();
  await expect(page.locator('.vv-code-pre')).toContainText('hello vviewer');

  // ---- 只重定向一次不循环：改名字节仅拉取有限次（url store 1 次 + 可能的预检），无风暴 ----
  expect(manifestRequests.length).toBeLessThanOrEqual(6);
});
