import { test, expect, type Page } from '@playwright/test';
import { closeDrawerIfOpened, openDrawerIfNarrow } from './drawer';

/**
 * fix-pwa E2E 护栏（2026-10-08 缺陷修复批次：BUG-15 / BUG-06 / BUG-16）。
 * 全部用例跑 production build（playwright webServer 为 vite preview，服务 build/ 产物）。
 *
 * 1. BUG-15：precache 清单必须含 index.html——此前 vite-plugin-pwa 生成 manifest
 *    早于 adapter-static 写出 index.html，precache 零 html，sw.js 求值期
 *    createHandlerBoundToURL('index.html') 抛 non-precached-url，NavigationRoute
 *    与 grammars/queries 运行时路由全部静默丢失（残缺 SW），离线 reload 落
 *    chrome-error。护栏断言：precache 有 index.html 键 + 断网 reload 呈现完整应用壳。
 * 2. BUG-06：本地 tree-sitter 主路径整链护栏——本地策略（auto + 本地上传通道）
 *    打开 sample.rs 出现 ts-* span，network 层有 /tree-sitter.wasm 与
 *    /grammars/rust.wasm 请求，vv-grammars-* 运行时缓存随请求创建。
 * 3. BUG-16：1MB .bin hex 行虚拟滚动——首屏 DOM 行数受限（不再一次性渲染
 *    6.5 万行），滚动到底末行偏移 0xffff0（行内覆盖至末字节 0xfffff）与 1MB 吻合。
 *    性能数字（PWA-08 的 200ms 预算）含 headless 容器噪声，按场景文档多轮采样
 *    人工回归，不作硬门断言。
 */

/**
 * SW 首装激活/控制权交接窗口内 evaluate 会命中未就绪的 document——
 * 一律折叠为 null 让外层 expect.poll 重试（照 m7.spec.ts 惯例）。
 */
async function safeEval<T>(page: Page, fn: () => T | Promise<T>): Promise<T | null> {
  try {
    const v = await page.evaluate(fn);
    return (v ?? null) as T | null;
  } catch {
    return null;
  }
}

/** 等待 SW activated 且 precache 填充完成（后续断言的前置状态） */
async function waitSwActivated(page: Page): Promise<void> {
  await expect
    .poll(
      async () => {
        const s = await safeEval(page, async () => {
          const reg = await navigator.serviceWorker.ready;
          const keys = await caches.keys();
          const precache = keys.find((k) => k.startsWith('workbox-precache')) ?? null;
          const entries = precache ? (await (await caches.open(precache)).keys()).length : 0;
          return {
            activated: reg.active?.state === 'activated',
            controlled: navigator.serviceWorker.controller !== null,
            entries
          };
        });
        if (!s || !s.activated || !s.controlled) return null;
        return s.entries;
      },
      { timeout: 30_000, message: '等待 SW activated 且 precache 填充' }
    )
    .toBeGreaterThan(10);
}

test('BUG-15：precache 含 index.html（NavigationRoute 求值前提），运行时缓存路由就位', async ({
  page
}) => {
  await page.goto('/');
  await expect
    .poll(
      async () => {
        const s = await safeEval(page, async () => {
          const reg = await navigator.serviceWorker.ready;
          if (reg.active?.state !== 'activated') return null;
          const keys = await caches.keys();
          const precache = keys.find((k) => k.startsWith('workbox-precache')) ?? null;
          if (!precache) return null;
          const reqs = await (await caches.open(precache)).keys();
          return {
            hasIndex: reqs.some((r) => {
              const p = new URL(r.url).pathname;
              return p === '/index.html' || p.endsWith('/index.html');
            })
          };
        });
        return s ?? null;
      },
      { timeout: 30_000, message: '等待 precache 填充后检查 index.html 键' }
    )
    .toMatchObject({ hasIndex: true });
});

test('BUG-15：SW activated 后断网 reload 呈现完整应用壳（非 chrome-error，controller 在位）', async ({
  page
}) => {
  test.setTimeout(60_000);
  await page.goto('/');
  await waitSwActivated(page);
  await page.context().setOffline(true);
  try {
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 10_000 });
    // 完整应用壳：品牌控件渲染（chrome-error 页面无任何 vv-* 元素）且 SW 控制在位
    await expect(page.locator('.vv-brand')).toBeVisible({ timeout: 10_000 });
    const controlled = await safeEval(page, () => navigator.serviceWorker.controller !== null);
    expect(controlled).toBe(true);
    // 壳内交互就绪：TopBar 可见（应用而非静态残页）
    await expect(page.locator('header, .vv-topbar').first()).toBeVisible();
  } finally {
    await page.context().setOffline(false);
  }
});

test('BUG-06：本地策略 sample.rs 走 tree-sitter 主路径（ts-* span + .wasm 请求 + vv-grammars 缓存）', async ({
  page
}) => {
  test.setTimeout(90_000);
  const assetRequests: string[] = [];
  page.on('request', (r) => {
    const u = r.url();
    if (u.includes('.wasm')) assetRequests.push(u);
  });
  await page.goto('/');
  await page.waitForFunction(
    () => typeof (window as unknown as { __vvOpenDirImpl?: unknown }).__vvOpenDirImpl === 'function'
  );
  // 本地上传通道（本地 store：无服务端，auto 策略落本地 tree-sitter worker）
  await page.evaluate(() => {
    const rs = `fn main() {\n    let x = 42;\n    println!("hello {}", x);\n}\n`;
    const f = new File([rs], 'sample.rs', { type: 'text/plain' });
    Object.defineProperty(f, 'webkitRelativePath', { value: 'fixpwa/sample.rs' });
    (window as unknown as { __vvOpenDirImpl: (f: File[]) => void }).__vvOpenDirImpl([f]);
  });
  const drawer = await openDrawerIfNarrow(page);
  await page.locator('.vv-tree-row', { hasText: 'sample.rs' }).click();
  await closeDrawerIfOpened(page, drawer);
  await expect(page.locator('.vv-tab.active', { hasText: 'sample.rs' })).toBeVisible();

  // 主路径证据 1：ts-* 语法 span（hljs 兜底产物是 hljs-*，引擎可分辨）
  await expect(page.locator('.vv-code-pre span[class^="ts-keyword"]').first()).toBeVisible({
    timeout: 20_000
  });
  // 主路径证据 2：状态栏引擎指示
  await expect(page.locator('.vv-statusbar')).toContainText('高亮: tree-sitter', {
    timeout: 20_000
  });
  // 主路径证据 3：network 层真实发生 runtime 与 grammar wasm 请求（报告缺陷态为零请求）
  expect(assetRequests.some((u) => u.endsWith('/tree-sitter.wasm'))).toBe(true);
  expect(assetRequests.some((u) => u.includes('/grammars/') && u.endsWith('/rust.wasm'))).toBe(true);
  // 主路径证据 4：sw.js 求值期异常修复后 grammars 运行时缓存路由真实注册并创建。
  // grammar wasm 经主线程预热通道（worker fetch 不经 SW）进入 CacheFirst——预热
  // 等 serviceWorker.ready（= precache 安装完成，首次访问 30s+）后才发起，
  // 因此先等 SW activated 再轮询缓存。
  await waitSwActivated(page);
  await expect
    .poll(
      async () => {
        const keys = await safeEval(page, () => caches.keys());
        return keys?.filter((k) => k.startsWith('vv-grammars-')).length ?? 0;
      },
      { timeout: 20_000, message: '等待 vv-grammars-* 运行时缓存创建' }
    )
    .toBeGreaterThan(0);
});

test('BUG-16：1MB .bin hex 行虚拟滚动——首屏 DOM 行受限，滚动到底末偏移吻合', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/');
  await page.waitForFunction(
    () => typeof (window as unknown as { __vvOpenDirImpl?: unknown }).__vvOpenDirImpl === 'function'
  );
  await page.evaluate(() => {
    const bytes = new Uint8Array(1 << 20); // 1MB → 65,536 行
    for (let i = 0; i < bytes.length; i++) bytes[i] = i & 0xff;
    const f = new File([bytes], 'perf-1mb.bin', { type: 'application/octet-stream' });
    Object.defineProperty(f, 'webkitRelativePath', { value: 'fixpwa/perf-1mb.bin' });
    (window as unknown as { __vvOpenDirImpl: (f: File[]) => void }).__vvOpenDirImpl([f]);
  });
  const drawer = await openDrawerIfNarrow(page);
  await page.locator('.vv-tree-row', { hasText: 'perf-1mb.bin' }).click();
  await closeDrawerIfOpened(page, drawer);
  const dump = page.locator('.vv-hex-dump');
  await expect(dump.locator('.vv-hex-row').first()).toBeVisible({ timeout: 15_000 });

  // 虚拟化证据：常驻 DOM 行数远小于总行数 65,536（视口 + 2×10 overscan + 裕量）
  await expect
    .poll(async () => page.locator('.vv-hex-row').count(), {
      timeout: 10_000,
      message: '统计常驻 hex 行数'
    })
    .toBeLessThan(300);

  // 分页按钮语义移除（滚动续读替代）
  await expect(page.locator('.vv-hex-more')).toHaveCount(0);

  // 滚动到底：末行起始偏移 0xffff0（行内覆盖至末字节 0xfffff，与 1MB 吻合）
  await dump.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect
    .poll(
      async () =>
        dump.evaluate((el) => {
          const rows = el.querySelectorAll('.vv-hex-row');
          return rows.length > 0 ? (rows[rows.length - 1] as HTMLElement).textContent!.slice(0, 8) : '';
        }),
      { timeout: 10_000, message: '等待滚动到底后的末行渲染' }
    )
    .toBe('000ffff0');
});
