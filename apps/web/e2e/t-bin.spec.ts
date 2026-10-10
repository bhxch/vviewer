import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect, type Page } from '@playwright/test';
import { closeDrawerIfOpened, openDrawerIfNarrow } from './drawer';

/**
 * binary-hex-archive 域覆盖缺口补强（t- 前缀：本轮新增，不改既有文件）。
 * 场景来源：docs/e2e/binary-hex-archive.md 第 3 节验收判据，补既有覆盖的弱断言：
 * - BIN-01 验收③：sample.bin(4129B) 末偏移与文件实际大小吻合（0x1020；首行三列/PNG
 *   签名 m4.spec.ts 已断言，不重复）
 * - BIN-02 期望③④：3MB 口径末行 0x2ffff0 + 回滚再滚动行内容稳定无白屏（1MB 口径与
 *   虚拟化结构证据 fix-pwa.spec.ts:159 已断言；BUG-16 性能预算按域档 §4.3.7 不自动化）
 * - BIN-03 验收②：IHDR height=8（width=32 m4.spec.ts 已断言；samples/m4/sample.bin
 *   即 IHDR width=32/height=8 的 PNG 改名件，xxd 实测偏移 0x10 处 00000020 00000008）
 * - BIN-05：zip 条目树与 unzip -l 逐项一致（sample.zip 共 7 条目，既有断言缺
 *   nested/inner.zip）
 * 通道同 m4/b-：页面内构造 File 经 __vvOpenDirImpl 注入（偏差 #7 压缩包前端本地解包）。
 */
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

async function openDir(page: Page, files: Array<{ name: string; type: string; bytes: Uint8Array }>): Promise<void> {
  await page.waitForFunction(
    () => typeof (window as unknown as { __vvOpenDirImpl?: unknown }).__vvOpenDirImpl === 'function'
  );
  await page.evaluate((list) => {
    const fs = list.map(({ name, type, bytes }) => {
      const f = new File([bytes as unknown as BlobPart], name, { type });
      Object.defineProperty(f, 'webkitRelativePath', { value: `tbin/${name}` });
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

/** hex 虚拟滚动容器滚到顶/底（.vv-hex-dump 自身滚动，hex.ts:63-70） */
async function scrollHexDump(page: Page, to: 'top' | 'bottom'): Promise<void> {
  await page.locator('.vv-hex-dump').evaluate((el, dir) => {
    el.scrollTop = dir === 'bottom' ? el.scrollHeight : 0;
  }, to);
}

/** 末行行首偏移（16 字节/行，8 位十六进制），同 fix-pwa 口径 */
async function lastHexRowOffset(page: Page): Promise<string> {
  return page.locator('.vv-hex-dump').evaluate((el) => {
    const rows = el.querySelectorAll('.vv-hex-row');
    return rows.length > 0 ? (rows[rows.length - 1] as HTMLElement).textContent!.slice(0, 8) : '';
  });
}

test('BIN-01：sample.bin hex 三列视图滚动到底，末偏移与 4129 字节吻合(0x1020)', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/');
  const bytes = new Uint8Array(readFileSync(`${repoRoot}/samples/m4/sample.bin`));
  expect(bytes.length).toBe(4129);
  await openDir(page, [{ name: 'sample.bin', type: 'application/octet-stream', bytes }]);
  await openFile(page, 'sample.bin');

  // 首行在位（三列逐字节断言见 m4.spec.ts），滚到底：末行行首 = floor(4128/16)*16 = 0x1020
  await expect(page.locator('.vv-hex-dump .vv-hex-row').first()).toBeVisible();
  await scrollHexDump(page, 'bottom');
  await expect.poll(() => lastHexRowOffset(page), { timeout: 10_000, message: '等待滚动到底后的末行渲染' })
    .toBe('00001020');
});

test('BIN-02：3MB .bin 滚动到底即达末尾(0x2ffff0)，回滚再滚动行内容稳定无白屏', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/');
  const bytes = new Uint8Array(3 * 1024 * 1024);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7 + 13) & 0xff;
  await openDir(page, [{ name: 'random-3mb.bin', type: 'application/octet-stream', bytes }]);
  await openFile(page, 'random-3mb.bin');
  const dump = page.locator('.vv-hex-dump');

  // ① 滚动到底即达数据末尾（无续读步骤）：196,608 行整，末行起始 0x2ffff0、行内覆盖至末字节
  await expect(dump.locator('.vv-hex-row').first()).toBeVisible();
  await scrollHexDump(page, 'bottom');
  await expect.poll(() => lastHexRowOffset(page), { timeout: 10_000, message: '等待首次滚动到底的末行' })
    .toBe('002ffff0');
  const lastRowText = await dump.locator('.vv-hex-row').last().textContent();

  // ② 回滚到顶：首行偏移 00000000（无白屏——行内容即时重渲染）
  await scrollHexDump(page, 'top');
  await expect
    .poll(
      async () =>
        dump.evaluate((el) => {
          const rows = el.querySelectorAll('.vv-hex-row');
          return rows.length > 0 ? (rows[0] as HTMLElement).textContent!.slice(0, 8) : '';
        }),
      { timeout: 10_000, message: '等待回滚到顶后的首行渲染' }
    )
    .toBe('00000000');

  // ③ 再滚到底：末行偏移与行内容与首次一致（滚动续读行稳定）
  await scrollHexDump(page, 'bottom');
  await expect.poll(() => lastHexRowOffset(page), { timeout: 10_000, message: '等待再次滚动到底的末行' })
    .toBe('002ffff0');
  expect(await dump.locator('.vv-hex-row').last().textContent()).toBe(lastRowText);
});

test('BIN-03：PNG 改名 .bin 按内容 magic 识别结构树——IHDR width=32、height=8', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/');
  // samples/m4/sample.bin 即「IHDR width=32、height=8 的 PNG 改名 .bin」样例
  // （xxd -l 32 实测：PNG 签名 + IHDR 数据 00000020 00000008）
  const bytes = new Uint8Array(readFileSync(`${repoRoot}/samples/m4/sample.bin`));
  await openDir(page, [{ name: 'png-as-bin.bin', type: 'application/octet-stream', bytes }]);
  await openFile(page, 'png-as-bin.bin');

  // 状态行按内容识别为 PNG（.bin 扩展名路由 hex 渲染器，识别发生在渲染器内 struct 解析）
  await expect(page.locator('.vv-hex-status')).toContainText('PNG');
  await page.locator('.vv-hex-struct > summary').click();
  await page.locator('.vv-hex-struct summary', { hasText: 'PNG' }).click();
  await page.locator('.vv-hex-struct summary', { hasText: 'IHDR' }).click();
  // 验收②：width/height 与结构解析一致（十进制，struct.ts:157-158）
  await expect(page.locator('.vv-hex-struct')).toContainText('width = 32');
  await expect(page.locator('.vv-hex-struct')).toContainText('height = 8');
});

test('BIN-05：zip 条目树与 unzip -l 逐项一致（7 条目含目录层级）', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/');
  // unzip -l samples/m4/sample.zip：hello.txt / notes.md / nested/ / nested/inner.txt /
  // nested/inner.zip / nested/deep/ / nested/deep/n1.zip（本轮实跑核对）
  const bytes = new Uint8Array(readFileSync(`${repoRoot}/samples/m4/sample.zip`));
  await openDir(page, [{ name: 'sample.zip', type: 'application/zip', bytes }]);
  await openFile(page, 'sample.zip');
  const pane = page.locator('.vv-archive');

  // 根级 3 项：2 文件 + 1 目录
  await expect(pane.locator('.vv-tree-row', { hasText: 'hello.txt' })).toBeVisible();
  await expect(pane.locator('.vv-tree-row', { hasText: 'notes.md' })).toBeVisible();
  await expect(pane.locator('summary.vv-tree-row', { hasText: 'nested' })).toBeVisible();

  // nested/ 下 3 项：2 文件 + 1 目录（inner.zip 为既有覆盖缺口项）
  await expandArchiveDir(page, 'nested');
  await expect(pane.locator('.vv-tree-row', { hasText: 'inner.txt' })).toBeVisible();
  await expect(pane.locator('.vv-tree-row', { hasText: 'inner.zip' })).toBeVisible();
  await expect(pane.locator('summary.vv-tree-row', { hasText: 'deep' })).toBeVisible();

  // nested/deep/ 下 1 项
  await expandArchiveDir(page, 'deep');
  await expect(pane.locator('.vv-tree-row', { hasText: 'n1.zip' })).toBeVisible();
});
