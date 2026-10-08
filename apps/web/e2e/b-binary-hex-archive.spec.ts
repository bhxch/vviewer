import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect, type Page } from '@playwright/test';
import { closeDrawerIfOpened, openDrawerIfNarrow } from './drawer';

/**
 * binary-hex-archive 域补充 E2E（b- 前缀：缺陷修复回归 + 既有套件缺失场景）。
 * 场景来源：docs/e2e/binary-hex-archive.md（BIN-01~10）。既有覆盖不重写：
 * m4.spec.ts 已覆盖 BIN-01/03（hex 三列 + PNG 结构树）、BIN-05/06/07（zip 条目树、
 * 递归预览、深度限制）、BIN-09（tar）、BIN-02/BUG-16 由 fix-pwa.spec.ts 覆盖
 * （1MB 虚拟滚动 + 末偏移）；本文件补：
 * - BIN-04：ELF 二进制结构树（magic/class/endian/type/machine/entry 与 ELF 头逐字段吻合，
 *   构造值即 readelf -h 的解析口径，本机已用 readelf 对同构字节核对）
 * - BIN-08 / BUG-12：ZipCrypto 混合包（plain/open.txt 明文 + secret/locked.txt 加密）
 *   不整包拒绝：条目树完整、加密条目 🔒 标记、点击报「加密不支持」、明文条目照常预览
 * - BIN-10 / BUG-13（树点击入口 + 正常命名对照）：zip 改名 .txt 后经 magic 预检
 *   重定向压缩包渲染器展示条目树，而非 code 渲染二进制乱码；URL 入口在服务端模式
 *   套件（e2e-server/b-binary-hex-archive.spec.ts）覆盖
 * 通道同 m4：页面内构造 File 经 __vvOpenDirImpl 注入（纯前端本地 store；压缩包一律
 * 前端 jszip/libarchive 本地解包，偏差 #7 架构前提）。
 */
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
/** 两阶段构造的 ZipCrypto 混合包（本机 zip CLI 产出，zipinfo -v 验证：
 * plain/open.txt not encrypted、secret/locked.txt encrypted(traditional PKWARE)，
 * unzip -t -P wordcipher 双条目 OK） */
const MIXED_ZIP_B64 =
  'UEsDBAoAAAAAAJwiSV0gt/KOEAAAABAAAAAOAAAAcGxhaW4vb3Blbi50eHRwbGFpbiBvcGVuIHRleHQKUEsDBAoACQAAAJwiSV1B3lP+HgAAABIAAAARABwAc2VjcmV0L2xvY2tlZC50eHRVVAkAAyj7x2oo+8dqdXgLAAEE7AMAAATpAwAAnjfYs5V1FyjCcLehdbDzMkxzpVHwhxsQ56XafbiFUEsHCEHeU/4eAAAAEgAAAFBLAQIeAwoAAAAAAJwiSV0gt/KOEAAAABAAAAAOAAAAAAAAAAEAAACkgQAAAABwbGFpbi9vcGVuLnR4dFBLAQIeAwoACQAAAJwiSV1B3lP+HgAAABIAAAARABgAAAAAAAEAAACkgTwAAABzZWNyZXQvbG9ja2VkLnR4dFVUBQADKPvHanV4CwABBOwDAAAE6QMAAFBLBQYAAAAAAgACAJMAAAC1AAAAAAA=';

/** 最小 ELF64 可执行头（64B）：字段值与 readelf -h 对同构字节的解析一致——
 * Class ELF64 / Data little endian / Type EXEC / Machine x86-64 / Entry 0x401000 */
function makeElf64(): Uint8Array {
  const b = new Uint8Array(64);
  b[0] = 0x7f;
  b.set(new TextEncoder().encode('ELF'), 1);
  b[4] = 2; // ELFCLASS64
  b[5] = 1; // little endian
  b[6] = 1; // EV_CURRENT
  const v = new DataView(b.buffer);
  v.setUint16(16, 2, true); // e_type = ET_EXEC
  v.setUint16(18, 62, true); // e_machine = EM_X86_64
  v.setUint32(20, 1, true); // e_version
  v.setBigUint64(24, 0x401000n, true); // e_entry
  return b;
}

const b64Bytes = (b64: string): Uint8Array => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

async function openDir(page: Page, files: Array<{ name: string; type: string; bytes: Uint8Array }>): Promise<void> {
  await page.waitForFunction(
    () => typeof (window as unknown as { __vvOpenDirImpl?: unknown }).__vvOpenDirImpl === 'function'
  );
  await page.evaluate((list) => {
    const fs = list.map(({ name, type, bytes }) => {
      const f = new File([bytes as unknown as BlobPart], name, { type });
      Object.defineProperty(f, 'webkitRelativePath', { value: `bbin/${name}` });
      return f;
    });
    return (window as unknown as { __vvOpenDirImpl: (f: File[]) => void }).__vvOpenDirImpl(fs);
  }, files);
}

async function openFile(page: Page, name: string): Promise<void> {
  const drawer = await openDrawerIfNarrow(page);
  await page.locator('.vv-tree-row', { hasText: name }).click();
  await closeDrawerIfOpened(page, drawer);
  await expect(page.locator('.vv-tab.active', { hasText: name })).toBeVisible();
}

/** 展开压缩包树内目录（details summary 首次展开懒加载子项），同 m4 惯例 */
async function expandArchiveDir(page: Page, dir: string): Promise<void> {
  await page.locator('.vv-archive summary.vv-tree-row', { hasText: dir }).click();
}

test('BIN-04：ELF 二进制进入 hex 视图，结构树字段与 ELF 头逐字段吻合', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/');
  await openDir(page, [{ name: 'sample.elf', type: 'application/octet-stream', bytes: makeElf64() }]);
  await openFile(page, 'sample.elf');

  // hex 视图（.elf 扩展名路由 hexRenderer），状态行识别为 ELF
  await expect(page.locator('.vv-hex-row').first()).toBeVisible();
  await expect(page.locator('.vv-hex-status')).toContainText('ELF');

  // 结构树：结构 → ELF 展开，叶子字段与头字节一致（readelf -h 同构字节核对：
  // Magic 7f 45 4c 46 / Class ELF64 / Data little endian / Type EXEC / Machine x86-64 /
  // Entry point 0x401000）
  await page.locator('.vv-hex-struct > summary').click();
  await page.locator('.vv-hex-struct summary', { hasText: 'ELF' }).click();
  await expect(page.locator('.vv-hex-struct')).toContainText('magic = 7f 45 4c 46');
  await expect(page.locator('.vv-hex-struct')).toContainText('class = 64-bit');
  await expect(page.locator('.vv-hex-struct')).toContainText('endian = little');
  await expect(page.locator('.vv-hex-struct')).toContainText('type = executable');
  await expect(page.locator('.vv-hex-struct')).toContainText('machine = x86-64');
  await expect(page.locator('.vv-hex-struct')).toContainText('entry = 4198400'); // 0x401000
});

test('BIN-08/BUG-12：加密混合包不整包拒绝——条目树完整、🔒 标记、加密条目报错、明文可预览', async ({
  page
}) => {
  test.setTimeout(90_000);
  await page.goto('/');
  await openDir(page, [
    { name: 'encrypted-entries.zip', type: 'application/zip', bytes: b64Bytes(MIXED_ZIP_B64) }
  ]);
  await openFile(page, 'encrypted-entries.zip');

  const pane = page.locator('.vv-archive');
  // ① 不再整包拒绝：包内条目树渲染，plain/ 与 secret/ 均出现
  await expect(pane.locator('summary.vv-tree-row', { hasText: 'plain' })).toBeVisible({ timeout: 20_000 });
  await expect(pane.locator('summary.vv-tree-row', { hasText: 'secret' })).toBeVisible();

  // ② 加密条目逐条标记（锁形）
  await expandArchiveDir(page, 'secret');
  const lockedRow = pane.locator('.vv-tree-row', { hasText: 'locked.txt' });
  await expect(lockedRow).toBeVisible();
  await expect(lockedRow).toContainText('🔒');

  // ③ 点击加密条目报「加密不支持」（错误只作用于该条目）
  await lockedRow.click();
  await expect(page.locator('.vv-tab.active', { hasText: 'locked.txt' })).toBeVisible();
  await expect(page.locator('.vv-error-card')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.vv-error-card')).toContainText('加密不支持');

  // ④ 同包明文条目照常预览（独立 code tab、内容正确，参照 BIN-06 口径）
  await page.locator('.vv-tab', { hasText: 'encrypted-entries.zip' }).click();
  await expect(page.locator('.vv-tab.active', { hasText: 'encrypted-entries.zip' })).toBeVisible();
  await expandArchiveDir(page, 'plain');
  const openRow = pane.locator('.vv-tree-row', { hasText: 'open.txt' });
  await expect(openRow).toBeVisible();
  await expect(openRow).not.toContainText('🔒');
  await openRow.click();
  await expect(page.locator('.vv-tab.active', { hasText: 'open.txt' })).toBeVisible();
  await expect(page.locator('.vv-code-pre')).toContainText('plain open text');
});

test('BIN-10/BUG-13（树点击入口）：zip 改名 .txt 经 magic 预检重定向压缩包渲染器；正常命名不回归', async ({
  page
}) => {
  test.setTimeout(90_000);
  const zipBytes = new Uint8Array(readFileSync(`${repoRoot}/samples/m4/sample.zip`)); // 头部 504b0304
  await page.goto('/');
  await openDir(page, [
    { name: 'zip-as-txt.txt', type: 'text/plain', bytes: zipBytes },
    { name: 'control.zip', type: 'application/zip', bytes: zipBytes }
  ]);

  // ① 入口一（树点击）：改名件不以 code 渲染二进制乱码，而是重定向压缩包渲染器出条目树
  await openFile(page, 'zip-as-txt.txt');
  const pane = page.locator('.vv-archive');
  await expect(pane.locator('.vv-tree-row', { hasText: 'hello.txt' })).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.vv-code-pre')).toHaveCount(0);

  // 可继续 BIN-06 式递归预览
  await pane.locator('.vv-tree-row', { hasText: 'hello.txt' }).click();
  await expect(page.locator('.vv-tab.active', { hasText: 'hello.txt' })).toBeVisible();
  await expect(page.locator('.vv-code-pre')).toContainText('hello vviewer');

  // ③ 对照回归：正常命名的 .zip 仍直接进入压缩包渲染器
  const drawer = await openDrawerIfNarrow(page);
  await page.locator('.vv-tree-row', { hasText: 'control.zip' }).click();
  await closeDrawerIfOpened(page, drawer);
  await expect(page.locator('.vv-tab.active', { hasText: 'control.zip' })).toBeVisible();
  await expect(page.locator('.vv-archive .vv-tree-row', { hasText: 'notes.md' })).toBeVisible({
    timeout: 20_000
  });
});
