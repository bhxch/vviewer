import { test, expect, type Page } from '@playwright/test';

/**
 * M7 E2E（Task 1 补 + review fix round 1）：
 * 1. PWA：SW 注册成功（navigator.serviceWorker.ready → active=activated，scope/script
 *    正确）+ caches 含 workbox precache 名且条目 > 10（brief 验收：注册成功 +
 *    caches 含 precache）。前端走 playwright webServer 的 vite preview（:4173，
 *    服务 build/ 产物，sw.js/manifest.webmanifest 在根路径）。
 * 2. hljs 近似映射真实级联抽查：jsdom 不算 cascade，theme.test.ts 只能锁注入
 *    文本的形态；这里在真实浏览器（colorScheme=dark）断言 computed style 的
 *    --hljs-keyword 取当前代码主题（serika-dark #e29da7）而非 app.css 暗色默认
 *    （#ff7b72）——选择器提权（:root[data-theme-mode=...] 四形态）是否生效的
 *    最终裁决。
 */

/**
 * SW 首装激活/控制权交接（clientsClaim + autoUpdate 可能触发自动 reload）窗口内
 * evaluate 会命中未就绪的 document（`caches is not defined` / 返回 undefined）——
 * 一律折叠为 null 让外层 expect.poll 重试，不对瞬态做断言。
 */
async function safeEval<T>(page: Page, fn: () => T | Promise<T>): Promise<T | null> {
  try {
    const v = await page.evaluate(fn);
    return (v ?? null) as T | null;
  } catch {
    return null;
  }
}

test('PWA：SW 注册成功且 workbox precache 就位（条目 > 10）', async ({ page }) => {
  await page.goto('/');
  await expect
    .poll(
      async () => {
        const s = await safeEval(page, async () => {
          const reg = await navigator.serviceWorker.ready;
          const keys = await caches.keys();
          const precacheName = keys.find((k) => k.startsWith('workbox-precache')) ?? null;
          // 注意 keys() 也要 await（Promise 上取 .length 是 undefined，且不报错）
          const entries = precacheName ? (await (await caches.open(precacheName)).keys()).length : 0;
          return {
            activated: reg.active?.state === 'activated',
            scopeOk: new URL(reg.scope).pathname === '/',
            scriptOk: new URL(reg.active?.scriptURL ?? '').pathname === '/sw.js',
            precacheName,
            entries
          };
        });
        if (!s) return null; // 重载/未就绪窗口：重试
        if (!s.activated || !s.scopeOk || !s.scriptOk) return -1; // 注册态不对：保持失败值便于诊断
        if (s.precacheName === null || !s.precacheName.startsWith('workbox-precache')) return -2;
        return typeof s.entries === 'number' ? s.entries : null; // 条目数未就绪：重试
      },
      { timeout: 30_000, message: '等待 SW activated 且 workbox precache 填充' }
    )
    .toBeGreaterThan(10);
});

test('hljs 近似映射真实级联：暗色下 computed --hljs-keyword 取代码主题色而非 app.css 默认', async ({
  page
}) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');
  // 等注入节点出现（AppShell/TopBar 挂载后异步加载 themes.json 再 applyCodeTheme），
  // 然后取 :root 上 --hljs-keyword 的最终级联值；空串/重载窗口一律重试
  await expect
    .poll(
      async () => {
        const ready = await safeEval(page, () => document.getElementById('vv-code-theme') !== null);
        if (ready !== true) return null;
        const kw = await safeEval(page, () =>
          getComputedStyle(document.documentElement).getPropertyValue('--hljs-keyword').trim()
        );
        return kw === null || kw === '' ? null : kw;
      },
      { timeout: 30_000, message: '等待代码主题注入' }
    )
    // 默认暗色代码主题 serika-dark 的 keyword fg=#e29da7；若 app.css 暗色默认
    // #ff7b72 胜出，即选择器提权回归（specificity 被暗色块盖过）
    .toBe('#e29da7');
});
