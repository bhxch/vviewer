import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';

/**
 * 服务端模式回归（docs/e2e/app-shell-sources.md + pwa-mobile-performance.md 的服务端侧验收）。
 * 基建：playwright.server.config.ts 以 release 二进制同源伺服 web-dist 与夹具目录（:4174）。
 * 夹具基础件来自 fixtures.mjs（hello.js/notes.md/pixel.png/sub/data.txt）；本 spec 在
 * beforeAll 向同一 gitignored 夹具目录追加自己的样例（不改动基建文件）。
 *
 * 覆盖：
 * - BUG-08（SHELL-14）：服务器来源 tab 刷新后自动重读并保留滚动位置，不再误标「本地文件」占位
 * - BUG-05 验收 4（SRV-07）：关自动刷新后 SSE 不再自动重读，手动刷新 ↻ 拉到追加内容
 * - BUG-24（PWA-04）：断网展开未加载目录给出明确提示（不再静默）；/api 严格网络优先；
 *   文件打开失败提示与已加载目录纯客户端开合两既有行为不回退
 * - BUG-04 跨域（SRV-05）：服务端 x-vv-encoding 检测映射到状态栏/属性面板
 */

const BASE = 'http://127.0.0.1:4174';
const FIXTURE = process.env.VV_E2E_SERVER_FIXTURE ?? '../../.temp/e2e-server-fixture';

/** B08 长文件（400 行 × 19B ≈ 7.6KB，scrollTop=2500 位移成立：行高 20px → 总高 8000px） */
const LONG_LINE = 'const vv = 1; // c\n';

test.beforeAll(() => {
  mkdirSync(`${FIXTURE}/b24`, { recursive: true });
  writeFileSync(`${FIXTURE}/b08-long.js`, LONG_LINE.repeat(400));
  writeFileSync(`${FIXTURE}/b05-refresh.txt`, 'marker-v1\n');
  writeFileSync(`${FIXTURE}/b24/nested.txt`, 'b24 child\n');
  // UTF-16LE 带 BOM（服务端 x-vv-encoding: utf-16le 映射验证载体）
  const body = '服务端编码验证\n'.repeat(6);
  const bytes = Buffer.alloc(2 + body.length * 2);
  bytes[0] = 0xff;
  bytes[1] = 0xfe;
  for (let i = 0; i < body.length; i++) {
    bytes[2 + i * 2] = body.charCodeAt(i) & 0xff;
    bytes[3 + i * 2] = body.charCodeAt(i) >> 8;
  }
  writeFileSync(`${FIXTURE}/srv-utf16le.txt`, bytes);
});

/** TopBar 连接表单（同 m5 惯例）→ 目录树可见 */
async function connectServer(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: '连接服务器' }).click();
  await page.getByLabel('服务器地址').fill(BASE);
  await page.getByRole('button', { name: '连接', exact: true }).click();
  await expect(page.locator('.vv-tree-row', { hasText: 'hello.js' })).toBeVisible({
    timeout: 10_000
  });
}

async function openFile(page: Page, name: string): Promise<void> {
  await treeRow(page, name).click();
  await expect(page.locator('.vv-tab.active', { hasText: name })).toBeVisible();
}

/** 树行精确匹配（共享夹具可能被并行批次塞入名字相近的目录，如 cg-sub） */
function treeRow(page: Page, name: string): ReturnType<Page['locator']> {
  return page
    .locator('.vv-tree-row')
    .filter({ has: page.locator(`.vv-tree-name`, { hasText: new RegExp(`^${name}$`) }) });
}

/** 等待 IndexedDB 快照中 name 的 scrollTop 达到 min（持久化是异步写，轮询防 flake）。
 * 旧语义→新语义（workspace T3/T7 适配）：快照键 'tabs'（扁平数组）→ 'workspaces'
 * （{activeId, workspaces:[{tabs:[…]}]} 按组分桶，旧键仅存迁移副本不再更新），
 * DB 版本随主题库升 2（v1 open 对既有 v2 库 VersionError）。断言语义等价：
 * 跨全部组的 tab 均参与 scrollTop 匹配。 */
/** 轮询 IndexedDB 直至指定 tab 的 scrollTop 落盘 ≥ min（persistScroll 300ms 尾随
 * 防抖——必须真等到落盘再 reload，否则防抖定时器随页面销毁、快照恒 0）。 */
async function waitSnapshotScroll(page: Page, name: string, min: number): Promise<void> {
  await expect
    .poll(async () => page.evaluate(readSnapshotScroll, name), { timeout: 10_000, interval: 100 })
    .toBeGreaterThanOrEqual(min);
}

/** 单次读取 kv 'workspaces' 中指定 tab 名的 scrollTop（无则 null）。 */
function readSnapshotScroll(name: string): Promise<number | null> {
  return new Promise((resolve) => {
    const open = indexedDB.open('vviewer', 2);
    open.onsuccess = () => {
      const db = open.result;
      try {
        const get = db.transaction('kv', 'readonly').objectStore('kv').get('workspaces');
        get.onsuccess = () => {
          const snap = get.result as
            | { workspaces?: { tabs?: { name: string; scrollTop: number }[] }[] }
            | undefined;
          const tabs = Array.isArray(snap?.workspaces)
            ? snap.workspaces.flatMap((w) => w.tabs ?? [])
            : [];
          resolve(tabs.find((t) => t.name === name)?.scrollTop ?? null);
          db.close();
        };
        get.onerror = () => {
          resolve(null);
          db.close();
        };
      } catch {
        resolve(null);
        db.close();
      }
    };
    open.onerror = () => resolve(null);
  });
}

test('BUG-08/SHELL-14：服务器 tab 刷新后自动重读并恢复滚动，不落「本地文件」占位', async ({
  page
}) => {
  test.setTimeout(60_000);
  await connectServer(page);
  await openFile(page, 'b08-long.js');
  await expect(page.locator('.vv-code-pre .vv-code-line').first()).toBeVisible();

  // 滚动到 2500 并等待快照落盘（spec L262：保留滚动位置）。persistScroll 走
  // 300ms 尾随防抖——必须真等到落盘再 reload，否则防抖定时器随页面销毁、
  // 快照恒 0（转正诊断发现旧 waitSnapshotScroll 轮询单次评估即放行，形同虚设）
  await page.locator('.vv-code-pre').evaluate((el) => {
    el.scrollTop = 2500;
  });
  await waitSnapshotScroll(page, 'b08-long.js', 2000);

  // 重载后统计 /api/file 重读请求
  let refetches = 0;
  page.on('request', (r) => {
    if (r.url().includes('/api/file') && r.url().includes('b08-long.js')) refetches++;
  });
  await page.reload();

  // 修复行为：内容重读渲染（.vv-code-pre 存在），不出现「会话中的本地文件」/占位文案
  await expect(page.locator('.vv-code-pre')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.vv-tab.active', { hasText: 'b08-long.js' })).toBeVisible();
  await expect(page.getByText('会话中的本地文件需要重新打开')).toHaveCount(0);
  await expect(page.getByText(/重连后可恢复/)).toHaveCount(0);
  expect(refetches, '重载后应重新拉取 /api/file').toBeGreaterThan(0);

  // SHELL-14 验收：滚动位置还原。旧缺口 BUG-64（AppShell.restore 写入对象与
  // ViewerPane effect 读取对象非同一引用，恢复 rAF 从未调度）已由 BUG-69 修复
  // 解决（90a2166：TabCollection.add 返回响应式代理，restore 赋值与渲染读取同源）——
  // 转正硬断言：重载且内容重读渲染后 scrollTop 还原至 2500（容忍布局微差 ≥2000）
  await expect
    .poll(() => page.locator('.vv-code-pre').evaluate((el) => el.scrollTop), {
      timeout: 10_000
    })
    .toBeGreaterThanOrEqual(2000);
});
test('BUG-05/SRV-07：关自动刷新后 SSE 不自动重读，手动刷新 ↻ 拉到追加内容', async ({ page }) => {
  test.setTimeout(60_000);
  await connectServer(page);
  await openFile(page, 'b05-refresh.txt');
  await expect(page.locator('.vv-code-pre')).toContainText('marker-v1');

  // 设置面板关闭自动刷新（BUG-05 验收 3：可切换）
  await page.locator('button[aria-label="设置"]').click();
  await page.locator('.vv-settings-toggle input[type="checkbox"]').uncheck();
  await page.keyboard.press('Escape');
  await expect(page.locator('.vv-settings')).toHaveCount(0);

  // 外部追加 → 3.5s 内不自动出现（自动刷新已关）
  appendFileSync(`${FIXTURE}/b05-refresh.txt`, 'marker-v2-manual\n');
  await page.waitForTimeout(3_500);
  await expect(page.locator('.vv-code-pre')).not.toContainText('marker-v2-manual');

  // 手动刷新 ↻ → 新内容出现（BUG-05 验收 4，修复前无任何 UI 手段）
  await page.locator('button[aria-label="刷新当前文件"]').click();
  await expect(page.locator('.vv-code-pre')).toContainText('marker-v2-manual', { timeout: 10_000 });
});

test('BUG-24/PWA-04：断网展开未加载目录有明确提示；/api 严格网络优先；既有行为不回退', async ({
  page
}) => {
  test.setTimeout(60_000);
  await connectServer(page);

  // 在线展开 sub/（子节点加载）后折叠：对照组（已加载目录断网纯客户端开合）
  await treeRow(page, 'sub').click();
  await expect(treeRow(page, 'data.txt')).toBeVisible();
  await treeRow(page, 'sub').click(); // 折叠
  await expect(treeRow(page, 'data.txt')).toHaveCount(0);

  await page.context().setOffline(true);
  try {
    // ① 对照回归：已加载目录断网折叠/展开为纯客户端切换
    await treeRow(page, 'sub').click();
    await expect(treeRow(page, 'data.txt')).toBeVisible({ timeout: 5_000 });
    await treeRow(page, 'sub').click();
    await expect(treeRow(page, 'data.txt')).toHaveCount(0);

    // ② 修复行为：未加载目录（b24）断网展开 → 状态栏明确提示（修复前 3s/9s 采样均静默）
    const sub24 = page.locator('li[role="treeitem"]', { has: treeRow(page, 'b24') });
    await treeRow(page, 'b24').click();
    await expect(page.locator('.vv-statusbar')).toContainText(/b24 加载失败/, { timeout: 5_000 });
    await expect(sub24).toHaveAttribute('aria-expanded', 'false'); // 失败回滚展开态
    await expect(treeRow(page, 'nested.txt')).toHaveCount(0);

    // ③ 对照回归：文件打开失败提示明确
    await treeRow(page, 'notes.md').click();
    await expect(page.locator('.vv-error-card')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.vv-error-card')).toContainText('无法预览此文件');

    // ④ 回归不破坏：/api 严格网络优先——缓存中无任何 /api 条目
    const apiCached = await page.evaluate(async () => {
      const keys = await caches.keys();
      for (const k of keys) {
        for (const req of await (await caches.open(k)).keys()) {
          if (new URL(req.url).pathname.startsWith('/api/')) return true;
        }
      }
      return false;
    });
    expect(apiCached).toBe(false);
  } finally {
    await page.context().setOffline(false);
  }
});

test('BUG-04/SRV-05：服务端检测（x-vv-encoding）映射到状态栏与属性面板', async ({ page }) => {
  test.setTimeout(60_000);
  await connectServer(page);

  // 服务端文件：语言/编码/大小/行 通用字段（RemoteStore 路径）
  await openFile(page, 'hello.js');
  const sb = page.locator('.vv-statusbar');
  await expect(sb).toContainText('语言: javascript');
  await expect(sb).toContainText('编码: utf-8');
  await expect(sb).toContainText(/大小: \d+/);

  // 服务端编码检测：UTF-16LE 带 BOM → x-vv-encoding: utf-16le → 状态栏/属性面板一致
  await openFile(page, 'srv-utf16le.txt');
  await expect(sb).toContainText('编码: utf-16le');
  await expect(page.locator('.meta-row', { hasText: '编码' })).toContainText('utf-16le');
});
