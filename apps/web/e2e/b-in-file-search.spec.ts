import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect, type Page } from '@playwright/test';
import { closeDrawerIfOpened, openDrawerIfNarrow } from './drawer';

/**
 * b-in-file-search E2E（in-file-search 域补齐，2026-10-09 缺陷修复批次回归）。
 * 场景来源：docs/e2e/in-file-search.md——BUG-18（全部命中高亮）/ BUG-23（大小写开关）
 * 的修复回归 + 既有套件（m3-search.spec.ts）未覆盖的 FSEARCH-02（3MB 分块+虚拟滚动
 * 稀疏命中）/ FSEARCH-05（HTML 源码视图搜索）/ FSEARCH-07（无命中与清空恢复）。
 * 通道同 m1-m3：页面内 File + webkitRelativePath 经 __vvOpenDirImpl 注入（本地 store）。
 */
const samples = fileURLToPath(new URL('../../../samples', import.meta.url));

interface FilePayload {
  name: string;
  type: string;
  b64?: string;
  content?: string;
}

const SAMPLES: FilePayload[] = [
  { name: 'm2/sample.ts', key: 'sample.ts', type: 'text/plain' },
  { name: 'm2/sample.md', key: 'sample.md', type: 'text/markdown' },
  { name: 'm3/page.html', key: 'page.html', type: 'text/html' }
].map((f) => ({
  name: f.key,
  type: f.type,
  b64: readFileSync(`${samples}/${f.name}`).toString('base64')
}));

/** FSEARCH-03/BUG-23 基准样例：AlphaCase×2 + alphacase×2 + ALPHACASE×1 + AlPhAcAsE×1 = 6 处 */
const CASE_TEST = [
  'AlphaCase one',
  'AlphaCase two',
  'alphacase three',
  'alphacase four',
  'ALPHACASE five',
  'AlPhAcAsE six'
].join('\n');

async function openDir(page: Page, extra: FilePayload[] = []): Promise<void> {
  const payloads = [...SAMPLES, ...extra];
  await page.waitForFunction(
    () => typeof (window as unknown as { __vvOpenDirImpl?: unknown }).__vvOpenDirImpl === 'function'
  );
  await page.evaluate((payloads) => {
    const files = payloads.map(({ name, type, b64, content }) => {
      const f =
        content !== undefined
          ? new File([content], name, { type })
          : new File([Uint8Array.from(atob(b64!), (c) => c.charCodeAt(0))], name, { type });
      Object.defineProperty(f, 'webkitRelativePath', { value: `bsearch/${name}` });
      return f;
    });
    return (window as unknown as { __vvOpenDirImpl: (f: File[]) => void }).__vvOpenDirImpl(files);
  }, payloads);
}

async function openFile(page: Page, name: string): Promise<void> {
  const drawer = await openDrawerIfNarrow(page);
  await page.locator('.vv-tree-row', { hasText: name }).click();
  await closeDrawerIfOpened(page, drawer);
  await expect(page.locator('.vv-tab.active', { hasText: name })).toBeVisible();
}

async function openPanelAndSearch(page: Page, term: string): Promise<void> {
  await page.keyboard.press('/'); // 树行/查看区持焦，非输入框 → 面板打开
  await expect(page.locator('.vv-search-panel')).toBeVisible();
  await expect(page.locator('.vv-search-input')).toBeFocused();
  await page.keyboard.insertText(term);
}

/** 当前命中行（data-line，0 起）——active 行级高亮是跳转定位的直接证据 */
async function activeLine(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const el = document.querySelector('.vv-code-line.vv-search-hit-line-active');
    return el instanceof HTMLElement ? Number(el.dataset.line) : null;
  });
}

test('BUG-18：code 视图 4 处 Point 词级 mark 全部高亮 + 行级背景，Enter 循环 active 转移，Esc 还原', async ({
  page
}) => {
  test.setTimeout(60_000);
  await page.goto('/');
  await openDir(page);
  await openFile(page, 'sample.ts');
  await expect(page.locator('.vv-code-pre')).toBeVisible();

  await openPanelAndSearch(page, 'Point');
  // 基准：sample.ts 恰 4 处 Point（grep -o Point | wc -l = 4，域文档 FSEARCH-01/BUG-18 判据）
  await expect(page.locator('.vv-search-count')).toHaveText('1/4', { timeout: 5_000 });
  // 修复证据 1：全部 4 处命中词级 mark（缺陷态：全 DOM 无 mark，仅当前命中行行级背景）
  await expect(page.locator('mark.vv-search-hit')).toHaveCount(4);
  // 修复证据 2：全部命中行（3 行，其中一行两处）都有行级背景（缺陷态：仅当前 1 行）
  await expect(page.locator('.vv-code-line.vv-search-hit-line')).toHaveCount(3);
  // 当前命中与全部命中视觉可区分：active 恰 1 处，落在第一命中行（行 0 起 = 1）
  await expect(page.locator('.vv-code-line.vv-search-hit-line-active')).toHaveCount(1);
  expect(await activeLine(page)).toBe(1);

  // Enter 下一个：active 转移到第 2 命中行（ORIGIN 行，0 起 = 6）
  await page.keyboard.press('Enter');
  await expect(page.locator('.vv-search-count')).toHaveText('2/4');
  expect(await activeLine(page)).toBe(6);
  // 再 Enter：第 3 命中行（distance 行，两处同 line，0 起 = 8）
  await page.keyboard.press('Enter');
  await expect(page.locator('.vv-search-count')).toHaveText('3/4');
  expect(await activeLine(page)).toBe(8);

  // Shift+Enter 上一个：退回第 2 命中
  await page.keyboard.press('Shift+Enter');
  await expect(page.locator('.vv-search-count')).toHaveText('2/4');

  // 首尾循环：从 2/4 连进 3 次 → 3/4 → 4/4 → 1/4
  for (const n of ['3/4', '4/4', '1/4']) {
    await page.keyboard.press('Enter');
    await expect(page.locator('.vv-search-count')).toHaveText(n);
  }

  // Esc 关闭：面板与词级/行级高亮全部还原
  await page.keyboard.press('Escape');
  await expect(page.locator('.vv-search-panel')).toHaveCount(0);
  await expect(page.locator('mark.vv-search-hit')).toHaveCount(0);
  await expect(page.locator('.vv-code-line.vv-search-hit-line')).toHaveCount(0);
});

test('BUG-23：Aa 大小写开关切换即重搜，敏感口径 2/2/1/1，导航在新命中集合工作，阴性对照不回退', async ({
  page
}) => {
  test.setTimeout(60_000);
  await page.goto('/');
  await openDir(page, [{ name: 'case-test.txt', type: 'text/plain', content: CASE_TEST }]);
  await openFile(page, 'case-test.txt');
  await expect(page.locator('.vv-code-pre')).toBeVisible();

  const count = page.locator('.vv-search-count');
  const toggle = page.locator('.vv-search-btn[title="区分大小写"]');

  await openPanelAndSearch(page, 'alphacase');
  // 缺陷态回归基线：开关存在（缺陷态：面板仅 input+计数+3 按钮无开关）且默认不敏感
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  // 计数为 current/total：不敏感下 6 处全中，游标停在第 1 处 → 1/6
  await expect(count).toHaveText('1/6', { timeout: 5_000 });

  // 开→敏感：'alphacase' 仅小写两行命中（2/2/1/1 区分口径）
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(count).toHaveText('1/2'); // 切换即时重搜（跳过防抖），游标复位第 1 处

  // 敏感口径逐形式核对（BUG-23 验收 3：AlphaCase=2 / ALPHACASE=1 / AlPhAcAsE=1）
  const input = page.locator('.vv-search-input');
  await input.fill('AlphaCase');
  await expect(count).toHaveText('1/2', { timeout: 5_000 });
  await input.fill('ALPHACASE');
  await expect(count).toHaveText('1/1', { timeout: 5_000 });
  await input.fill('AlPhAcAsE');
  await expect(count).toHaveText('1/1', { timeout: 5_000 });

  // 敏感集合上导航：total=1 环绕仍 1/1
  await page.keyboard.press('Enter');
  await expect(count).toHaveText('1/1');

  // 关→不敏感：现行行为不回退（验收 2），total 回到 6
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(count).toHaveText('1/6');

  // 阴性对照（验收 5）：不存在的词仍无结果、无异常，Enter 无异常
  await input.fill('nonexistentzz');
  await expect(count).toHaveText('无结果', { timeout: 5_000 });
  await page.keyboard.press('Enter');
  await expect(count).toHaveText('无结果');
  await expect(page.locator('.vv-error-card')).toHaveCount(0);
});

test('FSEARCH-02：3MB lazy chunk 路径稀疏 10 命中，Enter 步进逐次前滚且行号与构造吻合（虚拟滚动不错位）', async ({
  page
}) => {
  test.setTimeout(120_000);
  await page.goto('/');
  // 48,000 行 × 62B ≈ 3.0MB ∈ (2MB, 200MB] → lazy chunk 懒高亮 + 虚拟滚动；
  // 每 4,800 行埋一处 zzneedleqz（行 100/4900/…/43300，共 10 处）
  await openDir(page, [
    {
      name: 'sparse-3mb.js',
      type: 'text/javascript',
      content: Array.from({ length: 48_000 }, (_, i) =>
        i % 4_800 === 100 ? `const n${i} = 'zzneedleqz'; // hit` : `const v${i} = '${'x'.repeat(40)}'; // pad`
      ).join('\n')
    }
  ]);
  await openFile(page, 'sparse-3mb.js');
  await expect(page.locator('.vv-code-pre .vv-code-line').first()).toBeVisible();
  // lazy chunk 路径在跑（HL-03/FSEARCH-02 的渲染路径前提；阶段 4 后不再有 hljs 分块）
  await expect(page.locator('.vv-statusbar')).toContainText('高亮: tree-sitter', { timeout: 20_000 });

  await openPanelAndSearch(page, 'zzneedleqz');
  await expect(page.locator('.vv-search-count')).toHaveText('1/10', { timeout: 10_000 });
  // 首个命中行被定位（新搜索自动跳第一个命中）
  expect(await activeLine(page)).toBe(100);

  // 连续 Enter 从 1 步进到 10：计数递增、scrollTop 前滚、行号与埋针位置吻合
  const line = page.locator('.vv-code-line.vv-search-hit-line-active');
  for (let k = 1; k <= 9; k++) {
    const before = await page.locator('.vv-code-pre').evaluate((el) => el.scrollTop);
    await page.keyboard.press('Enter');
    await expect(page.locator('.vv-search-count')).toHaveText(`${k + 1}/10`, { timeout: 10_000 });
    const expected = 100 + 4_800 * k;
    await expect(line).toHaveAttribute('data-line', String(expected), { timeout: 10_000 });
    // 定位行可见且内容为该埋针行（分块路径重绘后内容零错位）
    await expect(line).toContainText(`n${expected}`);
    await expect(line).toBeVisible();
    const after = await page.locator('.vv-code-pre').evaluate((el) => el.scrollTop);
    expect(after).toBeGreaterThan(before); // 稀疏分布：步进必前滚
  }
  await page.keyboard.press('Escape');
  await expect(page.locator('.vv-search-panel')).toHaveCount(0);
});

test('FSEARCH-05：HTML 渲染视图搜索无结果，切源码视图后复用 code 搜索计数 1/3 且 Enter 推进', async ({
  page
}) => {
  test.setTimeout(60_000);
  await page.goto('/');
  await openDir(page);
  await openFile(page, 'page.html');
  // 默认渲染视图（沙箱 iframe）
  await expect(page.locator('.vv-html-frame')).toBeVisible();

  // 渲染视图是沙箱文档，不做跨文档搜索 → 「无结果」（html.ts search 的 view==='source' 门）
  await openPanelAndSearch(page, 'allow');
  await expect(page.locator('.vv-search-count')).toHaveText('无结果', { timeout: 5_000 });
  await page.keyboard.press('Escape');
  await expect(page.locator('.vv-search-panel')).toHaveCount(0);

  // 切源码视图：复用 code 渲染器，搜索照常
  await page.locator('.vv-html-btn-source').click();
  await expect(page.locator('.vv-code-pre')).toBeVisible();
  await openPanelAndSearch(page, 'allow');
  // 基准：page.html 中 allow 恰 3 处（allow-scripts ×1 + allow-same-origin ×2，grep -io 口径）
  await expect(page.locator('.vv-search-count')).toHaveText('1/3', { timeout: 5_000 });
  await expect(page.locator('mark.vv-search-hit')).toHaveCount(3); // 源码视图同为 code 词级高亮
  await page.keyboard.press('Enter');
  await expect(page.locator('.vv-search-count')).toHaveText('2/3');
  await expect(page.locator('.vv-code-line.vv-search-hit-line-active')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(page.locator('mark.vv-search-hit')).toHaveCount(0);
});

test('FSEARCH-07：markdown 渲染视图无命中提示无异常，清空重搜恢复，Esc 关闭', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/');
  await openDir(page);
  await openFile(page, 'sample.md');
  await expect(page.locator('.vv-markdown')).toBeVisible();

  await openPanelAndSearch(page, 'nonexistentzz');
  await expect(page.locator('.vv-search-count')).toHaveText('无结果', { timeout: 5_000 });
  // 无结果态 Enter 无异常：面板仍在、无错误卡片、无 mark
  await page.keyboard.press('Enter');
  await expect(page.locator('.vv-search-panel')).toBeVisible();
  await expect(page.locator('.vv-error-card')).toHaveCount(0);
  await expect(page.locator('mark.vv-search-hit')).toHaveCount(0);

  // 清空后重搜：计数恢复（可重新搜索）
  await page.locator('.vv-search-input').fill('');
  await page.keyboard.insertText('围栏');
  await expect(page.locator('.vv-search-count')).toContainText(/1\/\d+/, { timeout: 5_000 });
  await expect(page.locator('mark.vv-search-hit').first()).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.locator('.vv-search-panel')).toHaveCount(0);
  await expect(page.locator('mark.vv-search-hit')).toHaveCount(0);
});
