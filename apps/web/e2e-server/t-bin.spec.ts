import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';

/**
 * binary-hex-archive 域覆盖缺口补强 · 服务端模式（t- 前缀：本轮新增，不改既有文件）。
 * 场景来源：docs/e2e/binary-hex-archive.md 第 3 节验收判据，补服务端侧缺口：
 * - BIN-08 验收⑥：服务端 /api/file 对加密混合包契约不变（200 application/zip，偏差 #7
 *   前端本地解包架构不变，加密判定仍在前端解析阶段）——web 套件为纯前端 File 注入不经
 *   /api/file，该护栏此前无自动化
 * - BIN-10 验收②：「签名不符时只重定向一次」的签名不符分支——扩展名命中压缩包但头部
 *   非 ZIP 签名时，按裁决（packages/core/src/dispatch/dispatcher.ts:44-47）非文本类
 *   渲染器不参与改派，由 archive 渲染失败错误卡片兜底；断言明确落点 + 该文件字节仅
 *   拉取有限次（无循环改派请求风暴）
 * 夹具：beforeAll 写入 fixture 根（服务端文件树默认不展开子目录），文件名 t- 前缀
 * 与基础夹具（fixtures.mjs）及其他域用例均不重叠。
 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const PORT = 4174;
const BASE = `http://127.0.0.1:${PORT}`;
const FIXTURE = process.env.VV_E2E_SERVER_FIXTURE ?? join(repoRoot, '.temp/e2e-server-fixture');
const BIN_DIR = FIXTURE;

/** 两阶段构造的 ZipCrypto 混合包（plain/open.txt 明文 + secret/locked.txt 加密）。
 * 抄自 apps/web/e2e/b-binary-hex-archive.spec.ts MIXED_ZIP_B64（同源验证口径：
 * zipinfo -v 证实 plain=not encrypted、secret=encrypted，unzip -t -P 双条目 OK） */
const MIXED_ZIP_B64 =
  'UEsDBAoAAAAAAJwiSV0gt/KOEAAAABAAAAAOAAAAcGxhaW4vb3Blbi50eHRwbGFpbiBvcGVuIHRleHQKUEsDBAoACQAAAJwiSV1B3lP+HgAAABIAAAARABwAc2VjcmV0L2xvY2tlZC50eHRVVAkAAyj7x2oo+8dqdXgLAAEE7AMAAATpAwAAnjfYs5V1FyjCcLehdbDzMkxzpVHwhxsQ56XafbiFUEsHCEHeU/4eAAAAEgAAAFBLAQIeAwoAAAAAAJwiSV0gt/KOEAAAABAAAAAOAAAAAAAAAAEAAACkgQAAAABwbGFpbi9vcGVuLnR4dFBLAQIeAwoACQAAAJwiSV1B3lP+HgAAABIAAAARABgAAAAAAAEAAACkgTwAAABzZWNyZXQvbG9ja2VkLnR4dFVUBQADKPvHanV4CwABBOwDAAAE6QMAAFBLBQYAAAAAAgACAJMAAAC1AAAAAAA=';

const b64Bytes = (b64: string): Uint8Array => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

test.beforeAll(() => {
  mkdirSync(BIN_DIR, { recursive: true });
  writeFileSync(
    join(BIN_DIR, 't-encrypted-entries.zip'),
    Buffer.from(b64Bytes(MIXED_ZIP_B64))
  );
  writeFileSync(
    join(BIN_DIR, 't-txt-as-zip.zip'),
    'this is plain text, not a zip archive\n'
  );
});

/** 展开 TopBar 连接表单并提交（服务器无 token 配置，令牌留空），同 b- 惯例 */
async function connect(page: import('@playwright/test').Page): Promise<void> {
  await page.getByRole('button', { name: '连接服务器' }).click();
  await page.getByLabel('服务器地址').fill(BASE);
  await page.getByRole('button', { name: '连接', exact: true }).click();
  await expect(page.locator('.vv-tree')).toBeVisible({ timeout: 15_000 });
}

test('BIN-08/6：服务端 /api/file 契约不变——加密混合包仍 200 application/zip，加密判定在前端', async ({
  page
}) => {
  // 偏差 #7：服务端按扩展名下发（server/src/routes/file.rs:121 zip => application/zip），
  // 不因加密条目存在而改变；前端拿字节后由 zipStore 逐条标记/拦截（web 套件覆盖）
  const res = await page.request.get(`${BASE}/api/file?path=t-encrypted-entries.zip`);
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toContain('application/zip');
  expect((await res.body()).subarray(0, 4)).toEqual(Uint8Array.from([0x50, 0x4b, 0x03, 0x04]));
});

test('BIN-10/2：扩展名命中压缩包但签名不符——错误卡片兜底不循环，字节仅拉取有限次', async ({
  page
}) => {
  const fileRequests: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('t-txt-as-zip.zip')) fileRequests.push(r.url());
  });

  await page.goto('/');
  await connect(page);

  // 树点击：.zip 扩展名路由 archive 渲染器，头部非 PK 签名 → 解析失败错误卡片
  // （dispatcher.ts:44-47 裁决：非文本类渲染器不参与 magic 改派，错误卡片兜底语义正确）
  await page.locator('.vv-tree-row', { hasText: 't-txt-as-zip.zip' }).click();
  await expect(page.locator('.vv-tab.active', { hasText: 't-txt-as-zip.zip' })).toBeVisible();
  await expect(page.locator('.vv-error-card')).toBeVisible({ timeout: 15_000 });

  // 「只重定向一次」反向口径：无循环改派——该文件字节仅拉取有限次（树 store 拉取 +
  // 树列举引用，≤6 与既有 b- 服务端用例同口径），无请求风暴
  expect(fileRequests.length).toBeLessThanOrEqual(6);
});
