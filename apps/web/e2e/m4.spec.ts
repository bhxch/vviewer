import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect, type Page } from '@playwright/test';
import { closeDrawerIfOpened, openDrawerIfNarrow } from './drawer';

/**
 * M4 E2E 验收（Task 7）：二进制与媒体收口——
 * pdf canvas + 文件内搜索计数、hex 三列 dump + PNG 结构树、zip 包内树与递归预览
 * （含 4 层嵌套链的深度限制拒绝）、tar（libarchive wasm 路径）、Office 三件套 +
 * 大表截断、ArtPlayer 视频容器。遗留修复回归：zip/tar 条目 tab 关闭走 store.close
 * 接线（正常读取即回归证据）。
 * 通道同 m1/m2/m3：页面内构造 File + webkitRelativePath 经 __vvOpenDirImpl 注入，
 * 与真实 webkitdirectory input change 走同一 openDirectoryViaInput 通道。
 */
const samples = fileURLToPath(new URL('../../../samples/m4', import.meta.url));

const FILES: Array<[name: string, type: string]> = [
  ['sample.pdf', 'application/pdf'],
  ['sample.bin', 'application/octet-stream'],
  ['sample.zip', 'application/zip'],
  ['sample.tar', 'application/x-tar'],
  ['sample.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['sample.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['sample-large.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['sample.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  ['sample.mp4', 'video/mp4']
];

const PAYLOADS = FILES.map(([name, type]) => ({
  name,
  type,
  b64: readFileSync(`${samples}/${name}`).toString('base64')
}));

async function openDir(page: Page): Promise<void> {
  await page.waitForFunction(
    () => typeof (window as unknown as { __vvOpenDirImpl?: unknown }).__vvOpenDirImpl === 'function'
  );
  await page.evaluate((payloads) => {
    const files = payloads.map(({ name, type, b64 }) => {
      const f = new File([Uint8Array.from(atob(b64!), (c) => c.charCodeAt(0))], name, { type });
      Object.defineProperty(f, 'webkitRelativePath', { value: `m4/${name}` });
      return f;
    });
    return (window as unknown as { __vvOpenDirImpl: (f: File[]) => void }).__vvOpenDirImpl(files);
  }, PAYLOADS);
}

async function openFile(page: Page, name: string): Promise<void> {
  // 移动视口：树行在抽屉内，开抽屉点击后关闭（drawer.ts）；包内树行在主区不受影响
  const drawer = await openDrawerIfNarrow(page);
  await page.locator('.vv-tree-row', { hasText: name }).click();
  await closeDrawerIfOpened(page, drawer);
  await expect(page.locator('.vv-tab.active', { hasText: name })).toBeVisible();
}

/** 展开压缩包树内目录（details summary 首次展开懒加载子项） */
async function expandArchiveDir(page: Page, dir: string): Promise<void> {
  await page.locator('.vv-archive summary.vv-tree-row', { hasText: dir }).click();
}

test('pdf：canvas 渲染 + / 搜索 "vviewer" 计数 ≥1', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/');
  await openDir(page);
  await openFile(page, 'sample.pdf');

  // pdfjs worker 路径真实渲染：canvas 就位
  await expect(page.locator('.vv-pdf canvas').first()).toBeVisible({ timeout: 20_000 });

  // 文件内搜索（/ 面板）：sample.pdf 内容含 "vviewer pdf sample"
  await page.keyboard.press('/');
  await expect(page.locator('.vv-search-panel')).toBeVisible();
  await expect(page.locator('.vv-search-input')).toBeFocused();
  await page.keyboard.insertText('vviewer');
  await expect(page.locator('.vv-search-count')).toContainText(/\d+\/\d+/, { timeout: 10_000 });
  const count = await page.locator('.vv-search-count').textContent();
  const total = Number(count!.trim().split('/')[1]);
  expect(total).toBeGreaterThanOrEqual(1);

  // Enter 推进：命中页高亮闪现（gotoMatch → .vv-pdf-page-hit）
  await page.keyboard.press('Enter');
  await expect(page.locator('.vv-pdf-page-hit')).toHaveCount(1);
});

test('hex：三列 dump（偏移/hex/ASCII）+ PNG 结构树展开到 width', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/');
  await openDir(page);
  await openFile(page, 'sample.bin');

  // 首行三列齐备：00000000 偏移 | PNG 签名 + IHDR 长度/类型的 hex（逐字节空格分隔，
  // 16×3-1=47 字符恰满宽）| ASCII 列（89/0d/0a/1a/0a 与 3×00 共 8 字节为 '.'）
  const first = page.locator('.vv-hex-row').first();
  await expect(first).toBeVisible();
  await expect(first).toHaveText(
    /^00000000 {2}89 50 4e 47 0d 0a 1a 0a 00 00 00 0d 49 48 44 52 {2}\|\.PNG\.{8}IHDR\|$/
  );

  // 结构树：hexRenderer render 完成时 structReady 已 await，树必然在 DOM；
  // details 默认折叠 → 逐层展开（结构 → PNG → IHDR）后断言 width 字段与取值
  await expect(page.locator('.vv-hex-status')).toContainText('PNG');
  await page.locator('.vv-hex-struct > summary').click();
  await page.locator('.vv-hex-struct summary', { hasText: 'PNG' }).click();
  await page.locator('.vv-hex-struct summary', { hasText: 'IHDR' }).click();
  await expect(page.locator('.vv-hex-struct')).toContainText('width');
  await expect(page.locator('.vv-hex-struct')).toContainText('width = 32');
});

test('zip：包内树 → 条目递归预览 → 4 层嵌套链深度限制拒绝', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/');
  await openDir(page);
  await openFile(page, 'sample.zip');

  // 包内树根级条目
  const pane = page.locator('.vv-archive');
  await expect(pane.locator('.vv-tree-row', { hasText: 'hello.txt' })).toBeVisible();
  await expect(pane.locator('.vv-tree-row', { hasText: 'notes.md' })).toBeVisible();

  // 点击 hello.txt → 新 code tab（递归预览走派发器自然路由）
  await pane.locator('.vv-tree-row', { hasText: 'hello.txt' }).click();
  await expect(page.locator('.vv-tab.active', { hasText: 'hello.txt' })).toBeVisible();
  await expect(page.locator('.vv-code-pre')).toContainText('hello vviewer');

  // 回 zip tab（树重渲染）→ 展开 nested → 点 inner.txt 亦可开
  await page.locator('.vv-tab', { hasText: 'sample.zip' }).click();
  await expect(page.locator('.vv-tab.active', { hasText: 'sample.zip' })).toBeVisible();
  await expandArchiveDir(page, 'nested');
  const innerTxt = pane.locator('.vv-tree-row', { hasText: 'inner.txt' });
  await expect(innerTxt).toBeVisible();
  await innerTxt.click();
  await expect(page.locator('.vv-tab.active', { hasText: 'inner.txt' })).toBeVisible();
  await expect(page.locator('.vv-code-pre')).toContainText('inner content');

  // 深度链：n1 ⊃ n2 ⊃ n3 ⊃ n4。n1/n2/n3 逐层可开；n3 的 store depth=3，
  // 再点开 n4.zip 被拒（错误卡：嵌套层数超限）
  await page.locator('.vv-tab', { hasText: 'sample.zip' }).click();
  await expandArchiveDir(page, 'nested');
  await expandArchiveDir(page, 'deep');
  await pane.locator('.vv-tree-row', { hasText: 'n1.zip' }).click();
  await expect(page.locator('.vv-tab.active', { hasText: 'n1.zip' })).toBeVisible();
  await expect(page.locator('.vv-archive .vv-tree-row', { hasText: 'n2.zip' })).toBeVisible();
  await page.locator('.vv-archive .vv-tree-row', { hasText: 'n2.zip' }).click();
  await expect(page.locator('.vv-tab.active', { hasText: 'n2.zip' })).toBeVisible();
  await page.locator('.vv-archive .vv-tree-row', { hasText: 'n3.zip' }).click();
  await expect(page.locator('.vv-tab.active', { hasText: 'n3.zip' })).toBeVisible();
  await page.locator('.vv-archive .vv-tree-row', { hasText: 'n4.zip' }).click();
  await expect(page.locator('.vv-tab.active', { hasText: 'n4.zip' })).toBeVisible();
  await expect(page.locator('.vv-error-card')).toContainText('嵌套层数超限');
});

test('tar：libarchive 路径树渲染 + 条目可读 + 切回树 tab 复渲染', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/');
  await openDir(page);
  await openFile(page, 'sample.tar');

  const pane = page.locator('.vv-archive');
  await expect(pane.locator('.vv-tree-row', { hasText: 'hello.txt' })).toBeVisible();
  await expandArchiveDir(page, 'nested');
  const innerTxt = pane.locator('.vv-tree-row', { hasText: 'inner.txt' });
  await expect(innerTxt).toBeVisible();

  // 条目可读：hello.txt 经 libarchive worker 懒提取 → code tab
  await pane.locator('.vv-tree-row', { hasText: 'hello.txt' }).click();
  await expect(page.locator('.vv-tab.active', { hasText: 'hello.txt' })).toBeVisible();
  await expect(page.locator('.vv-code-pre')).toContainText('hello vviewer');

  // 切回 tar tab：实例重建（entryOpened 已派发 → destroy 不关 store，内层 tab 仍可读）
  await page.locator('.vv-tab', { hasText: 'sample.tar' }).click();
  await expect(pane.locator('.vv-tree-row', { hasText: 'hello.txt' })).toBeVisible();
  await expandArchiveDir(page, 'nested');
  await pane.locator('.vv-tree-row', { hasText: 'inner.txt' }).click();
  await expect(page.locator('.vv-tab.active', { hasText: 'inner.txt' })).toBeVisible();
  await expect(page.locator('.vv-code-pre')).toContainText('inner content');
});

test('office：docx 段落 / xlsx 表格与页签 / 大表 200 行截断 / pptx 提纲卡片', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/');
  await openDir(page);

  // docx：mammoth → 净化 HTML → <p>
  await openFile(page, 'sample.docx');
  const docx = page.locator('.vv-docx');
  await expect(docx.locator('p', { hasText: 'vviewer docx 样例' })).toBeVisible({ timeout: 20_000 });
  await expect(docx.locator('p')).toHaveCount(4);

  // xlsx：<table> + 双 sheet 页签切换（两 sheet 的 table 常驻 DOM，只断言可见 sheet）
  await openFile(page, 'sample.xlsx');
  const xlsx = page.locator('.vv-xlsx');
  const activeSheet = page.locator('.vv-xlsx-sheet:not([hidden])');
  await expect(activeSheet.locator('table')).toBeVisible({ timeout: 20_000 });
  await expect(activeSheet.locator('table tr').nth(1)).toContainText('苹果'); // 首行为表头
  await expect(page.locator('.vv-xlsx-tab')).toHaveCount(2);
  await page.locator('.vv-xlsx-tab', { hasText: '汇总' }).click();
  await expect(activeSheet.locator('table')).toContainText('2048');

  // 大表：250 行 > 200 → 截断提示条 + 恰好 200 行
  await openFile(page, 'sample-large.xlsx');
  await expect(page.locator('.vv-xlsx-truncated')).toHaveText(
    '内容较长：共 250 行，仅显示前 200 行',
    { timeout: 20_000 }
  );
  await expect(activeSheet.locator('table tr')).toHaveCount(200);

  // pptx：文本提纲降级路径 → 2 张卡片
  await openFile(page, 'sample.pptx');
  const pptx = page.locator('.vv-pptx');
  await expect(pptx.locator('.vv-pptx-slide')).toHaveCount(2, { timeout: 20_000 });
  await expect(pptx.locator('.vv-pptx-slide').first()).toContainText('vviewer pptx 样例');
  await expect(pptx.locator('.vv-pptx-slide').nth(1)).toContainText('要点 A');
});

test('artplayer：mp4 → .artplayer 容器 + video 就绪（loadedmetadata 或无 error）', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/');
  await openDir(page);
  await openFile(page, 'sample.mp4');

  // ArtPlayer 真实挂载：5.4 根容器类为 .art-video-player（挂在自建 .vv-artplayer 内）+ 内部 <video>（blob src）
  const container = page.locator('.vv-artplayer .art-video-player');
  await expect(container).toBeVisible({ timeout: 20_000 });
  const video = page.locator('.vv-artplayer video');
  await expect(video).toHaveCount(1);
  expect(await video.getAttribute('src')).toMatch(/^blob:/);

  // readyState 断言放宽（headless codec 可用性不定）：等 loadedmetadata（readyState ≥ 1）
  // 或 error 二者先到；断言落点是"无 error"——error 即测试失败
  await expect
    .poll(
      async () => {
        const s = await video.evaluate((v) => ({ rs: v.readyState, err: v.error?.code ?? 0 }));
        return s.rs >= 1 || s.err > 0 ? 'settled' : 'pending';
      },
      { timeout: 15_000, intervals: [250, 500, 1_000] }
    )
    .toBe('settled');
  const errCode = await video.evaluate((v) => v.error?.code ?? 0);
  const readyState = await video.evaluate((v) => v.readyState);
  console.log(`[m4] video 状态：readyState=${readyState}${errCode ? ` error.code=${errCode}` : ' 无 error'}`);
  expect(errCode).toBe(0);
});
