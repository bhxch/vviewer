import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, expect, type Page } from '@playwright/test';

/**
 * QuickOpen 多源扫描域（QO-01..04，docs/e2e/quickopen-multisource.md；富化第三轮）。
 * 多源 = workspace 多根来源扫描（quickOpen.ts 按源序串行 DFS、跨源全局 maxFiles=5000、
 * 排除规则跨源；结果行带「源名 / path」前缀、按 storeId 定位来源打开）。单测已全钉
 * （quickOpen.test.ts 双源拼接/跨源排除/maxFiles/空来源），本域补端到端：双源并存扫描
 * 拼接与源名前缀 / 按 storeId 打开落对来源 / 跨源排除规则 / 空来源态。maxFiles 上限
 * 由单测承载，e2e 不重复布点（spec §2 既有裁决）。
 *
 * 装置：本地源走 __vvOpenDirImpl 注入（t-shell 同款）；remote 走 spec 内单根假服务
 * （b-wsx-recovery startWsxFakeServer 的单根精简版）。
 */

interface FakeOptions {
  rootPath: string;
  files: Record<string, string>;
}

async function startQoFakeServer(opts: FakeOptions): Promise<{ base: string; host: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const cors: Record<string, string> = { 'Access-Control-Allow-Origin': '*' };
    if (url.pathname === '/api/health') {
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ capabilities: ['file-server'] }));
      return;
    }
    if (url.pathname === '/api/ticket') {
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ticket: 'e2e' }));
      return;
    }
    if (url.pathname === '/api/events') {
      res.writeHead(200, { ...cors, 'Content-Type': 'text/event-stream' });
      return; // 保持打开、无数据帧：SSE 挂起即可（测试结束统一断连）
    }
    if (url.pathname === '/api/tree' || url.pathname === '/api/file') {
      const p = (url.searchParams.get('path') ?? '').replace(/^\/+|\/+$/g, '');
      const table = opts.files;
      if (url.pathname === '/api/tree') {
        const entries = new Map<string, 'dir' | 'file'>();
        const prefix = p === '' ? '' : `${p}/`;
        for (const key of Object.keys(table)) {
          if (!key.startsWith(prefix)) continue;
          const rest = key.slice(prefix.length);
          const head = rest.split('/')[0]!;
          entries.set(head, rest.includes('/') ? 'dir' : 'file');
        }
        res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            entries: [...entries].map(([name, kind]) => ({
              name,
              kind,
              ...(kind === 'file' ? { size: (table[`${prefix}${name}`] ?? '').length } : {})
            }))
          })
        );
        return;
      }
      const content = table[p];
      if (content === undefined) {
        res.writeHead(404, cors);
        res.end('no such file');
        return;
      }
      res.writeHead(200, { ...cors, 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(content);
      return;
    }
    res.writeHead(404, cors);
    res.end();
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    host: `127.0.0.1:${port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((ok) => server.close(() => ok()));
    }
  };
}

async function waitAppMounted(page: Page): Promise<void> {
  await page.waitForFunction(
    () => typeof (window as unknown as { __vvOpenDirImpl?: unknown }).__vvOpenDirImpl === 'function'
  );
}

async function openLocalDir(page: Page, files: Array<{ name: string; content: string }>, label: string): Promise<void> {
  await page.evaluate(({ list, label }) => {
    const fs = list.map(({ name, content }) => {
      const f = new File([content], name, { type: 'text/plain' });
      Object.defineProperty(f, 'webkitRelativePath', { value: `${label}/${name}` });
      return f;
    });
    return (window as unknown as { __vvOpenDirImpl: (f: File[]) => void }).__vvOpenDirImpl(fs);
  }, { list: files, label });
}

async function connectForm(page: Page, base: string): Promise<void> {
  await page.getByRole('button', { name: '连接服务器' }).click();
  await page.getByLabel('服务器地址').fill(base);
  await page.getByRole('button', { name: '连接', exact: true }).click();
}

async function openQuickOpen(page: Page): Promise<void> {
  await page.keyboard.press('Control+p');
  const input = page.locator('.vv-quickopen-input');
  await expect(page.locator('.vv-quickopen')).toBeVisible();
  await expect(input, '面板输入框自动聚焦（键盘直注前提）').toBeFocused();
}

test.describe('QuickOpen 多源扫描（QO-01..04）', () => {
  test('QO-01：双源扫描拼接——结果行同时含两源文件且带「源名 / path」前缀', async ({ page }) => {
    const fake = await startQoFakeServer({ rootPath: '/qo-root', files: { 'hello-remote.txt': 'remote body\n' } });
    try {
      await page.goto('/');
      await waitAppMounted(page);
      await openLocalDir(page, [
        { name: 'alpha-local.txt', content: 'local alpha\n' },
        { name: 'beta-local.txt', content: 'local beta\n' }
      ], 'qosrc');
      await connectForm(page, fake.base);
      await openQuickOpen(page);
      const rows = page.locator('.vv-quickopen-row');
      // 两源结果并存（无过滤词 = 全量列表；localfiles 源在先——注入先于连接）
      await expect(rows.filter({ hasText: 'alpha-local.txt' })).toHaveCount(1);
      await expect(rows.filter({ hasText: 'hello-remote.txt' })).toHaveCount(1);
      // 源名前缀形态（QuickOpenPanel 行渲染 {labelOf(storeId)} / {path}）
      await expect(rows.filter({ hasText: 'alpha-local.txt' })).toContainText(' / ');
      await expect(rows.filter({ hasText: 'hello-remote.txt' })).toContainText(' / ');
    } finally {
      await fake.close();
    }
  });

  test('QO-02：按 storeId 打开——过滤词命中 remote 源文件，Enter 后内容落 remote 来源', async ({ page }) => {
    const fake = await startQoFakeServer({ rootPath: '/qo-root', files: { 'hello-remote.txt': 'remote body marker-42\n' } });
    try {
      await page.goto('/');
      await waitAppMounted(page);
      await openLocalDir(page, [{ name: 'alpha-local.txt', content: 'local alpha\n' }], 'qosrc');
      await connectForm(page, fake.base);
      await openQuickOpen(page);
      await page.keyboard.type('hello-remote');
      await page.keyboard.press('Enter');
      await expect(page.locator('.vv-tab.active', { hasText: 'hello-remote.txt' })).toBeVisible();
      // 内容来自 remote store（fake server body），非本地同名文件
      await expect(page.locator('.vv-viewer-host')).toContainText('marker-42');
    } finally {
      await fake.close();
    }
  });

  test('QO-03：跨源排除规则——命中排除的两源同名文件均不出现，其余文件在', async ({ page }) => {
    const fake = await startQoFakeServer({ rootPath: '/qo-root', files: { 'secret.txt': 'remote secret\n', 'keep.txt': 'remote keep\n' } });
    try {
      // 排除规则在应用启动读取（settings store）：addInitScript 预写 localStorage（先于首次导航）
      await page.addInitScript(() => {
        localStorage.setItem('vviewer:settings', JSON.stringify({ excludedPatterns: ['secret.txt'] }));
      });
      await page.goto('/');
      await waitAppMounted(page);
      await openLocalDir(page, [{ name: 'secret.txt', content: 'local secret\n' }, { name: 'keep-local.txt', content: 'local keep\n' }], 'qosrc');
      await connectForm(page, fake.base);
      await openQuickOpen(page);
      const rows = page.locator('.vv-quickopen-row');
      await expect(rows.filter({ hasText: 'secret.txt' })).toHaveCount(0);
      await expect(rows.filter({ hasText: 'keep.txt' })).toHaveCount(1);
      await expect(rows.filter({ hasText: 'keep-local.txt' })).toHaveCount(1);
    } finally {
      await fake.close();
    }
  });

  test('QO-04：空来源态——本地空目录来源不拖垮扫描，remote 结果正常列出且无错误态', async ({ page }) => {
    const fake = await startQoFakeServer({ rootPath: '/qo-root', files: { 'only-remote.txt': 'remote only\n' } });
    try {
      await page.goto('/');
      await waitAppMounted(page);
      await openLocalDir(page, [], 'empty-src');
      await connectForm(page, fake.base);
      await openQuickOpen(page);
      const rows = page.locator('.vv-quickopen-row');
      await expect(rows.filter({ hasText: 'only-remote.txt' })).toHaveCount(1);
      await expect(page.locator('.vv-quickopen')).not.toContainText('列出文件失败');
    } finally {
      await fake.close();
    }
  });
});
