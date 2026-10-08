import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, type Page } from '@playwright/test';

/**
 * b-server-highlight-search E2E（服务端模式：release 二进制同源伺服 :4174）。
 * 场景来源：docs/e2e/code-highlight-degrade.md 的服务端独有口径——
 * - BUG-04（HL-06/07 完整验收）：状态栏编码值与 `X-VV-Encoding` 响应头逐字一致
 *   （纯前端 spec 只能覆盖前端启发式，响应头对照必须服务端）；
 * - BUG-07（HL-05 报告原场景即服务端）：文件树点击无扩展名 shebang-py 不再被
 *   「不支持的扩展名 "."」拒绝，进入代码预览识别 python；.py 对照组带 X-VV-Lang 头。
 *
 * 夹具：beforeAll 直接写入 fixture 根目录（playwright.server.config.ts 的
 * VV_E2E_SERVER_FIXTURE，与 fixtures.mjs 同目录惯例）——/api/tree 每请求动态
 * readdir（server/src/routes/tree.rs），server 复用/新起都可见。不修改基建文件。
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const fixtureDir =
  process.env.VV_E2E_SERVER_FIXTURE ?? join(repoRoot, '.temp/e2e-server-fixture');
const BASE = 'http://127.0.0.1:4174';

/** 「中文内容」的 GB18030 字节（与 GBK 双字节区兼容，硬编码避免依赖 ICU Buffer） */
const GB18030_BYTES = Uint8Array.from([0xd6, 0xd0, 0xce, 0xc4, 0xc4, 0xda, 0xc8, 0xdd]);

/** UTF-16LE BOM + 「《中文》\n」——BOM 消费后首字符码点 12298（域文档 HL-07 实测口径） */
function utf16leBytes(text: string): Uint8Array {
  const bytes = new Uint8Array(2 + text.length * 2);
  bytes[0] = 0xff;
  bytes[1] = 0xfe;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    bytes[2 + i * 2] = code & 0xff;
    bytes[3 + i * 2] = code >> 8;
  }
  return bytes;
}

const SHEBANG_PY = '#!/usr/bin/env python3\ndef greet(name):\n    return f"hello {name}"\n\nprint(greet("vviewer"))\n';

test.beforeAll(() => {
  mkdirSync(fixtureDir, { recursive: true });
  writeFileSync(join(fixtureDir, 'b-gb18030-cn.txt'), GB18030_BYTES);
  writeFileSync(join(fixtureDir, 'b-utf8-cn.txt'), '中文内容 UTF-8\n', 'utf-8');
  writeFileSync(join(fixtureDir, 'b-utf16le-cn.txt'), utf16leBytes('\u300A\u4E2D\u6587\u300B\n'));
  writeFileSync(join(fixtureDir, 'b-shebang-py'), SHEBANG_PY);
  writeFileSync(join(fixtureDir, 'b-shebang-py-verify.py'), SHEBANG_PY, 'utf-8');
});

/** 服务端模式连接（同源 :4174，release server 无 --token 配置 → 访问令牌留空） */
async function connectServerMode(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: '连接服务器' }).click();
  await page.getByLabel('服务器地址').fill(BASE);
  await page.getByRole('button', { name: '连接', exact: true }).click();
  await expect(page.locator('.vv-tree-row').first()).toBeVisible({ timeout: 10_000 });
}

async function openTreeFile(page: Page, name: string): Promise<void> {
  // 精确匹配：b-shebang-py 与 b-shebang-py-verify.py 前缀包含，子串 hasText 撞 strict mode
  await page
    .locator('.vv-tree-row')
    .filter({ hasText: new RegExp(`^\\s*${name.replace(/\./g, '\\.')}\\s*$`) })
    .click();
  await expect(page.locator('.vv-tab.active', { hasText: name })).toBeVisible();
}

test('HL-06：gb18030/utf-8 中文文件状态栏编码与 X-VV-Encoding 头逐字一致，渲染无乱码', async ({
  page
}) => {
  const gb = await page.request.get(`/api/file?path=b-gb18030-cn.txt`);
  expect(gb.status()).toBe(200);
  const gbEnc = gb.headers()['x-vv-encoding'];
  expect(gbEnc).toBe('gb18030');

  await connectServerMode(page);
  await openTreeFile(page, 'b-gb18030-cn.txt');
  await expect(page.locator('.vv-code-pre')).toContainText('中文内容', { timeout: 20_000 });
  // BUG-04 完整口径：状态栏编码与响应头逐字一致（缺陷态：状态栏无编码字段）
  await expect(page.locator('.vv-statusbar')).toContainText(`编码: ${gbEnc}`, { timeout: 20_000 });

  // UTF-8 对照（缺陷态亦正确下发，回归不得回退）
  const u8 = await page.request.get(`/api/file?path=b-utf8-cn.txt`);
  const u8Enc = u8.headers()['x-vv-encoding'];
  expect(u8Enc).toBe('utf-8');
  await openTreeFile(page, 'b-utf8-cn.txt');
  await expect(page.locator('.vv-code-pre')).toContainText('中文内容', { timeout: 20_000 });
  await expect(page.locator('.vv-statusbar')).toContainText(`编码: ${u8Enc}`, { timeout: 20_000 });
});

test('HL-07：UTF-16LE(BOM) 文件状态栏编码与头一致，BOM 消费后首字符码点 12298', async ({
  page
}) => {
  const res = await page.request.get(`/api/file?path=b-utf16le-cn.txt`);
  expect(res.status()).toBe(200);
  expect(res.headers()['x-vv-encoding']).toBe('utf-16le');

  await connectServerMode(page);
  await openTreeFile(page, 'b-utf16le-cn.txt');
  await expect(page.locator('.vv-statusbar')).toContainText('编码: utf-16le', { timeout: 20_000 });
  const firstCharCode = await page.evaluate(() => {
    const body = document.querySelector('.vv-code-pre .vv-code-line .vv-code-body');
    return body?.textContent ? body.textContent.codePointAt(0) : null;
  });
  expect(firstCharCode).toBe(12298); // 0x300A 《：BOM 已消费、正文解码无乱码
  await expect(page.locator('.vv-code-pre')).toContainText('中文');
});

test('HL-05：服务端树打开无扩展名 shebang-py 进入代码预览识别 python，.py 对照组带 X-VV-Lang', async ({
  page
}) => {
  // API 对照（域文档 HL-05 证据口径）：.py 带 x-vv-lang: python；无扩展名 200 完整正文无该头
  const py = await page.request.get(`/api/file?path=b-shebang-py-verify.py`);
  expect(py.headers()['x-vv-lang']).toBe('python');
  const extless = await page.request.get(`/api/file?path=b-shebang-py`);
  expect(extless.status()).toBe(200);
  expect(extless.headers()['x-vv-lang']).toBeUndefined();
  const body = await extless.text();
  expect(body).toContain('#!/usr/bin/env python3');

  // 缺陷态：文件树点击直接渲染错误页「无法预览此文件 / 不支持的扩展名 "."」
  await connectServerMode(page);
  await openTreeFile(page, 'b-shebang-py');
  await expect(page.locator('.vv-code-pre')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.vv-error-card')).toHaveCount(0);
  await expect(page.locator('.vv-main')).not.toContainText('不支持的扩展名');
  // shebang 检测发生（extless 回退链写 det.lang → 状态栏语言段）
  await expect(page.locator('.vv-statusbar')).toContainText('语言: python', { timeout: 20_000 });
  await expect(page.locator('.vv-code-pre')).toContainText('greet');

  // 对照组：.py 正常渲染，状态栏语言取服务端检测头（BUG-04 语言段与 X-VV-Lang 一致）
  await openTreeFile(page, 'b-shebang-py-verify.py');
  await expect(page.locator('.vv-statusbar')).toContainText('语言: python', { timeout: 20_000 });
  await expect(page.locator('.vv-code-pre')).toContainText('greet');
});
