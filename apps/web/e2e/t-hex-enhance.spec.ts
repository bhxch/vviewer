import { test, expect, type Page } from '@playwright/test';

/**
 * hex 增强 e2e（跳转/搜索/检查器 spec H §2-§3 的 t- 前缀新文件；Task 4 将按 spec
 * 补齐跳转/搜索/两档高亮/移动抽屉全量场景）。
 *
 * 本轮（Task 3 fix round 1 Critical 1）先落「真实布局断言 + 点击定位」：
 * - 布局链：.vv-hex-row 处于 .vv-virtual-viewport（absolute left:0 right:0）内，
 *   block 行默认被拉伸为容器宽，hex.ts 点击换算的「行宽/77=单字符宽」随之高估
 *   2~2.5 倍（检查器核心交互系统性偏移）。修复：app.css `.vv-hex-row{width:
 *   max-content;min-width:100%}` 使行宽回到内容宽。
 * - 断言口径：Range 圈选行首字符**独立实测**单字符宽（不依赖被测的 rect.width/77
 *   公式），先锁「行宽 ≈ 77×字符宽」（max-content 回归护栏——jsdom 无布局，单测
 *   mock 只能固化假设，真实布局只能在此验证），再驱动真实鼠标点击断言检查器 offset。
 * - 注入通道同 t-bin.spec.ts（__vvOpenDirImpl 页内建目录；.bin 路由 hex 渲染器）。
 */

/** 已知字节布点的样例：offset 3 = 0x01、offset 4 = 0x00（uint16 little=1 / big=256） */
function makeSample(): Uint8Array {
  const bytes = new Uint8Array(64);
  bytes[3] = 0x01;
  return bytes;
}

async function openDir(page: Page, name: string, bytes: Uint8Array): Promise<void> {
  await page.waitForFunction(
    () => typeof (window as unknown as { __vvOpenDirImpl?: unknown }).__vvOpenDirImpl === 'function'
  );
  await page.evaluate(({ name, bytes }) => {
    const f = new File([bytes as unknown as BlobPart], name, { type: 'application/octet-stream' });
    Object.defineProperty(f, 'webkitRelativePath', { value: `hexenh/${name}` });
    (window as unknown as { __vvOpenDirImpl: (f: File[]) => void }).__vvOpenDirImpl([f]);
  }, { name, bytes });
}

test('HEX-INSP-01：点击 hex 列第 k 字节 → 检查器 offset === k（真实布局 + 字节序下行）', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', '点击定位与布局断言为桌面基准（THEME-03 惯例）；检查器移动抽屉可达性由 Task 4 补');
  test.setTimeout(60_000);
  await page.goto('/');
  await openDir(page, 'insp.bin', makeSample());
  await page.locator('.vv-tree-row', { hasText: 'insp.bin' }).click();
  await expect(page.locator('.vv-tab.active', { hasText: 'insp.bin' })).toBeVisible();

  // ① 真实布局护栏：Range 独立实测首字符宽，行宽必须等于内容宽（77 字符）——
  //    若 .vv-hex-row 被 viewport 拉伸为容器宽（Critical 1 回归）此处即红
  const row = page.locator('.vv-hex-dump .vv-hex-row').first();
  await expect(row).toBeVisible();
  const m = await row.evaluate((el) => {
    const node = el.firstChild!;
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, 1);
    const charW = range.getBoundingClientRect().width;
    return { charW, rowW: el.getBoundingClientRect().width, chars: (el.textContent ?? '').length };
  });
  expect(m.chars).toBe(77); // 64 字节文件首行为完整行（renderHexBytes 三列定宽）
  expect(m.charW).toBeGreaterThan(0);
  // 容差 1 字符宽；拉伸布局偏差为数倍。带实测值抛出（playwright expect 无 message 形参）
  if (!(Math.abs(m.rowW - m.charW * 77) < m.charW)) {
    throw new Error(`layout regression: rowW=${m.rowW} charW=${m.charW} chars=${m.chars}`);
  }

  // ② 点击 hex 列字节 3（列 19-20 的首字符中点）→ 检查器 offset === 3（Critical 1 直接验证）
  await row.click({ position: { x: 19.5 * m.charW, y: 9 } });
  await expect(page.locator('.meta-inspector-offset')).toHaveText('@ 0x3');
  // 光标字节高亮：hex 列 + ASCII 列同字节（0x01 → '01'/'.'）
  await expect(page.locator('.vv-hex-dump .vv-hex-cursor')).toHaveText(['01', '.']);

  // ③ 字节序下行链端到端：select → inspectorBus → setLittle → 重解码 → 轮询上行。
  //    offset 3 起字节 01 00：uint16 小端 1 / 大端 256
  const uint16Row = page.locator('.meta-inspector .meta-row', { hasText: 'uint16' });
  await expect(uint16Row).toHaveText('uint161');
  await page.locator('.meta-inspector-little').selectOption('big');
  await expect(uint16Row).toHaveText('uint16256');
  await expect(page.locator('.meta-inspector-offset')).toHaveText('@ 0x3'); // 光标不动
});
