import { test, expect, type Page } from '@playwright/test';

/**
 * compute-global-search 域 · 纯前端档补缺（docs/e2e/compute-global-search.md
 * CMP-10/11 与 BUG-11 验收行为）：静态服务器（vite preview :4173，默认配置）
 * 提供页面、全程零 /api/ 请求；本地文件夹经调试钩子 window.__vvOpenDirImpl
 * 注入（与真实 input change 同路径，域文档 4.3 边界 10 的复核口径）。
 *
 * 覆盖：
 * - CMP-10：本地文件夹搜索按文件分组；>2MB 文件与二进制扩展名被过滤（二者均含
 *   关键词但不进结果，证明过滤生效而非无命中）
 * - CMP-11/BUG-11：2050 文件触达 2000 文件扫描上限——截断提示止点正确（第 2000
 *   个文件的命中在列、第 2001 个含关键词文件缺席）；终态出现「建议改用服务器模式」
 *   引导（SERVER_SEARCH_HINT，BUG-11 修复主体）；新一轮搜索进度阶段不携带上轮遗留
 *   的「已达上限」字样（BUG-11 验收 3）
 */

/** 页内构造 File（带 webkitRelativePath）经 __vvOpenDirImpl 注入（同 b-app-shell-sources 通道） */
async function injectDir(page: Page, label: string, build: string): Promise<void> {
  await page.waitForFunction(
    () => typeof (window as unknown as { __vvOpenDirImpl?: unknown }).__vvOpenDirImpl === 'function'
  );
  await page.evaluate(
    ({ label, build }) => {
      const make = (name: string, content: string | Uint8Array): File => {
        const f = new File([content as unknown as BlobPart], name, { type: 'text/plain' });
        Object.defineProperty(f, 'webkitRelativePath', { value: `${label}/${name}` });
        return f;
      };
      const files = new Function('make', `return [${build}];`)(make) as File[];
      (window as unknown as { __vvOpenDirImpl: (f: File[]) => void }).__vvOpenDirImpl(files);
    },
    { label, build }
  );
}

async function openGlobalSearch(page: Page, query: string): Promise<void> {
  await page.keyboard.press('Control+Shift+F');
  await expect(page.locator('.vv-gsearch')).toBeVisible();
  await page.getByLabel('全局搜索内容').fill(query);
}

test('CMP-10：本地文件夹搜索按文件分组，>2MB 与二进制文件被过滤不进搜索（全程零 /api/ 请求）', async ({
  page
}) => {
  test.setTimeout(120_000);
  const apiRequests: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/api/')) apiRequests.push(r.url());
  });

  await page.goto('/');
  // 4 件均含 needle：2 个小文本应命中，>2MB 的 .js 与二进制 .bin 必须被过滤
  await injectDir(
    page,
    'cgweb',
    `
    make('small-a.txt', 'needle one\\nplain\\nneedle two\\n'),
    make('small-b.txt', 'needle three\\n'),
    make('big.js', 'const pad = 1;\\n'.repeat(150000) + 'needle in big\\n'),
    make('data.bin', new Uint8Array([0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65, 0x00, 0x01, 0xff]))
    `
  );
  await expect(page.locator('.vv-tree-row', { hasText: 'small-a.txt' })).toBeVisible({ timeout: 10_000 });

  await openGlobalSearch(page, 'needle');
  const status = page.locator('.vv-gsearch-status');
  await expect(status).toContainText('3 个命中', { timeout: 30_000 });

  // 按文件分组：仅两个小文本；>2MB 与二进制件（含关键词）不在分组中
  const groups = page.locator('.vv-gsearch-file-path');
  await expect(groups.filter({ hasText: 'small-a.txt' })).toHaveCount(1);
  await expect(groups.filter({ hasText: 'small-b.txt' })).toHaveCount(1);
  await expect(groups).toHaveCount(2);
  await expect(page.locator('.vv-gsearch-file-path', { hasText: 'big.js' })).toHaveCount(0);
  await expect(page.locator('.vv-gsearch-file-path', { hasText: 'data.bin' })).toHaveCount(0);

  expect(apiRequests).toEqual([]); // 纯前端判定：全程零 /api/ 请求
});

test('CMP-11/BUG-11：2050 文件触达 2000 上限——止点正确、出现服务器模式引导、进度阶段无遗留截断字样', async ({
  page
}) => {
  test.setTimeout(240_000);
  await page.goto('/');

  // bulk2/：2050 个文件，bulk-0050 起每逢 50 含 bulkword（41 个）；第 2001 个含关键词
  // 文件为 bulk-2050.txt，用于验证截断止点（恰止于第 2000 个文件）
  await page.waitForFunction(
    () => typeof (window as unknown as { __vvOpenDirImpl?: unknown }).__vvOpenDirImpl === 'function'
  );
  await page.evaluate(() => {
    const files: File[] = [];
    for (let i = 1; i <= 2050; i++) {
      const name = `bulk-${String(i).padStart(4, '0')}.txt`;
      const content = i % 50 === 0 ? 'bulkword here\n' : 'filler text\n';
      const f = new File([content], name, { type: 'text/plain' });
      Object.defineProperty(f, 'webkitRelativePath', { value: `bulk2/${name}` });
      files.push(f);
    }
    (window as unknown as { __vvOpenDirImpl: (f: File[]) => void }).__vvOpenDirImpl(files);
  });
  await expect(page.locator('.vv-tree-row', { hasText: 'bulk-0001.txt' })).toBeVisible({ timeout: 10_000 });

  // ① 首轮搜索至终态：40 个命中（恰止于第 2000 个文件）+ 截断提示 + 服务器模式引导
  await openGlobalSearch(page, 'bulkword');
  const status = page.locator('.vv-gsearch-status');
  await expect(status).toContainText('40 个命中（结果不完整，已达上限）', { timeout: 60_000 });
  await expect(page.locator('.vv-gsearch-hint')).toContainText('建议在顶栏连接服务器', { timeout: 5_000 });

  const groups = page.locator('.vv-gsearch-file-path');
  await expect(groups.filter({ hasText: 'bulk-2000.txt' })).toHaveCount(1); // 第 2000 个文件的命中在列
  await expect(groups.filter({ hasText: 'bulk-2050.txt' })).toHaveCount(0); // 第 2001 个含关键词文件缺席

  // ② BUG-11 验收 3：新一轮搜索的进度阶段（「已扫描 N 个文件…」）不得携带上轮遗留
  //    的「（结果不完整，已达上限）」。2050 个小文件扫描窗口仅百毫秒级——在页内装
  //    5ms 间隔采样器（避免 evaluate 往返漏采），换无命中查询保持全程扫描宽度
  await page.evaluate(() => {
    const w = window as unknown as { __vvStatusSamples?: string[]; __vvStatusTimer?: ReturnType<typeof setInterval> };
    w.__vvStatusSamples = [];
    w.__vvStatusTimer = setInterval(() => {
      const text = document.querySelector('.vv-gsearch-status')?.textContent ?? '';
      if (text !== '') w.__vvStatusSamples!.push(text);
    }, 5);
  });
  await page.getByLabel('全局搜索内容').fill('zzz-no-such-hit');
  await expect(status).toContainText('无结果（结果不完整，已达上限）', { timeout: 60_000 });
  const progressSamples = await page.evaluate(() => {
    const w = window as unknown as { __vvStatusSamples?: string[]; __vvStatusTimer?: ReturnType<typeof setInterval> };
    clearInterval(w.__vvStatusTimer);
    return (w.__vvStatusSamples ?? []).filter((t) => t.includes('已扫描'));
  });
  expect(progressSamples.length).toBeGreaterThan(0); // 进度阶段被采样到
  for (const sample of progressSamples) {
    expect(sample).not.toContain('已达上限'); // 修复前：进度阶段即携带上轮截断遗留
  }
  // 第二轮终态：无结果但同样触达上限 → 截断提示与引导均在
  await expect(status).toContainText('无结果（结果不完整，已达上限）');
  await expect(page.locator('.vv-gsearch-hint')).toContainText('建议在顶栏连接服务器');
});
