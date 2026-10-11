import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, expect, type Page } from '@playwright/test';
import { hash8 } from '@vviewer/core';

/**
 * open-with 域回归（C 项「格式覆盖自动化」Task 7）：探测链与打开方式 override 的
 * 端到端验收（spec §2.2/§2.3）。
 * - OPEN-01：未知扩展名 probe.foo（PNG 签名内容）→ 签名改派 → image 视图
 * - OPEN-02：未知扩展名 bin.foo（NUL 二进制）→ 探测链 hex 兜底 → hex 视图
 * - OPEN-03：MetaPanel「打开方式」手选二进制 → override 即时重渲染 + 快照落盘；
 *   刷新后本地注入文件按既有语义以占位恢复（m1.spec.ts:102 先例）。override 的
 *   UI 级刷新恢复由 BUG-69 用例覆盖（假服务器 + 预置快照通道）。
 * - OPEN-04：notes.jsonl → 专有 JSON Lines 卡片视图（jsonlRenderer 装配锚点）。
 * - OPEN-05：混合合法/非法行 jsonl → 失败行徽标 + 状态条失败计数。
 * - OPEN-06：打开方式往返 jsonl↔code（override 路径，候选经 C 项 openWithOf）。
 * - OPEN-07：1MB/约 5000 行 jsonl 首屏性能锚点（BUG-16 口径：桌面<200ms/
 *   移动<400ms，9 轮取中位；探针仿 t-pwa.spec.ts installPaintProbe）。
 *
 * 注入通道：合成 drop（页内 new DataTransfer + DragEvent 派发 window）——先例
 * t-shell.spec.ts L145-155（SHELL-03①）；二进制载荷经 base64 → Uint8Array
 * （m1/b-* 套件的 b64 通道）。
 */

/** 1×1 PNG（与 samples/m1/pixel.png、b-app-shell-sources BUG-04 用例同源 base64） */
const PNG_1PX_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

interface DropPayload {
  name: string;
  type: string;
  content?: string;
  b64?: string;
}

/** 等应用挂载（svelte:window 的 drop 监听与 TopBar 就绪；t-shell waitAppMounted 同款） */
async function waitAppMounted(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('.vv-topbar')).toBeVisible();
}

/** 合成 drop 注入单文件并等 tab 激活（先例 t-shell.spec.ts L145-155） */
async function dropFile(page: Page, payload: DropPayload): Promise<void> {
  await page.evaluate((p) => {
    const file = new File(
      [
        p.content !== undefined
          ? p.content
          : Uint8Array.from(atob(p.b64!), (c) => c.charCodeAt(0))
      ],
      p.name,
      { type: p.type }
    );
    const dt = new DataTransfer();
    dt.items.add(file);
    // 构造 File 的 webkitGetAsEntry 恒 null → collectDirectoryFiles 返回 null 走单文件通道
    window.dispatchEvent(
      new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })
    );
  }, payload);
  await expect(page.locator('.vv-tab.active', { hasText: payload.name })).toBeVisible();
}

/** ≤600px 断点右栏（MetaPanel）收进抽屉（b-app-shell-sources/t-shell 同款本文件先例） */
async function openRightIfNarrow(page: Page): Promise<boolean> {
  const narrow = await page.evaluate(() => window.innerWidth <= 600);
  if (!narrow) return false;
  await page.locator('.vv-right-toggle').click();
  return true;
}

// ── OPEN-07 性能锚点辅助（探针/中位数仿 t-pwa.spec.ts L137-155 与 PWA-08/2） ──

/** 首帧探针：MutationObserver 首现选择器 + 双 rAF（t-pwa installPaintProbe 同款） */
async function installPaintProbe(page: Page, selector: string): Promise<void> {
  await page.evaluate((sel) => {
    (window as unknown as Record<string, unknown>).__vvPaintProbe = new Promise<number>((resolve) => {
      const t0 = performance.now();
      if (document.querySelector(sel)) {
        resolve(0);
        return;
      }
      const mo = new MutationObserver(() => {
        if (document.querySelector(sel)) {
          mo.disconnect();
          requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - t0)));
        }
      });
      mo.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => resolve(-1), 30_000);
    });
  }, selector);
}

async function readProbe(page: Page): Promise<number> {
  const ms = await page.evaluate(
    () => (window as unknown as { __vvPaintProbe?: Promise<number> }).__vvPaintProbe
  );
  expect(ms, '首帧探针超时（30s 内容未现）').toBeGreaterThanOrEqual(0);
  return ms as number;
}

/** 9 样本中位（t-pwa median 同款；调用契约 values 非空奇数个，断言收窄索引） */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[(sorted.length - 1) >> 1] as number;
}

/** 合成 ~1MB jsonl 载荷：~212B/行 × 5000 行 ≈ 1.02MB（brief 口径 ~5000 行 × ~200B） */
function makeJsonlPayload(rows: number): string {
  const lines: string[] = [];
  for (let i = 0; i < rows; i++) {
    lines.push(
      JSON.stringify({
        id: i,
        name: `item-${i}`,
        tags: ['alpha', 'beta'],
        active: i % 2 === 0,
        note: 'x'.repeat(140)
      })
    );
  }
  return lines.join('\n');
}

test('OPEN-01：未知扩展名 probe.foo + PNG 签名内容 → 签名改派 image 渲染', async ({ page }) => {
  test.setTimeout(60_000);
  await waitAppMounted(page);
  await dropFile(page, { name: 'probe.foo', type: 'application/octet-stream', b64: PNG_1PX_B64 });
  // .foo 不在任何扩展名清单：可渲染只能来自内容探测链 ① 签名改派（png → image）
  await expect(page.locator('.vv-error-card')).toHaveCount(0);
  await expect(page.locator('.vv-image img')).toBeVisible({ timeout: 20_000 });
});

test('OPEN-02：未知扩展名 bin.foo（NUL 二进制）→ 探测链 hex 兜底', async ({ page }) => {
  test.setTimeout(60_000);
  await waitAppMounted(page);
  // 00 01 ff fe 7f 00 09：NUL 即二进制（looksTextual 与 git 同口径），且无已知签名
  // → 探测链 ③ hex 兜底（旧行为是「不支持的扩展名 ".foo"」错误卡片）
  await dropFile(page, { name: 'bin.foo', type: 'application/octet-stream', b64: 'AAH//n8ACQ==' });
  await expect(page.locator('.vv-error-card')).toHaveCount(0);
  await expect(page.locator('.vv-hex')).toBeVisible();
  await expect(page.locator('.vv-hex-row').first()).toBeVisible();
  // 无已知签名 → 结构树不出现，状态行落「未知二进制」（struct 解析完成后改写）
  await expect(page.locator('.vv-hex-status')).toContainText('未知二进制', { timeout: 20_000 });
});

test('OPEN-03：MetaPanel 手选二进制 → override 即时重渲染 + 快照落盘；刷新后 tab 以占位恢复', async ({
  page
}) => {
  test.setTimeout(60_000);
  await waitAppMounted(page);

  // —— 手选链：txt 自动路由 code → 手选 hex 即时重渲染 ——
  await dropFile(page, { name: 'manual.txt', type: 'text/plain', content: 'plain text body\n' });
  await expect(page.locator('.vv-code-pre')).toContainText('plain text body', { timeout: 20_000 });
  await openRightIfNarrow(page);
  const openWith = page.locator('.meta-openwith');
  await expect(openWith).toBeVisible();
  await openWith.selectOption('hex');
  // rev++ 复用渲染 effect 重跑通道：code 退场、hex 上位（override 路径跳过探测链）
  await expect(page.locator('.vv-hex')).toBeVisible();
  await expect(page.locator('.vv-code-pre')).toHaveCount(0);
  await expect(openWith).toHaveValue('hex');
  await expect(page.locator('.meta-openwith-manual')).toBeVisible(); // （手动）标记

  // override 落盘（setRendererOverride 经代理写 → persist）：IDB workspaces 快照含
  // overrideRenderer:'hex'（确定性等待异步写，m1.spec.ts 轮询先例）。
  // 旧语义→新语义（workspace T3）：快照键 'tabs'（扁平数组）→ 'workspaces'
  // （{activeId, workspaces:[{tabs:[…]}]} 按组分桶；旧键双写已移除），DB 版本 2。
  await page.waitForFunction(
    () =>
      new Promise<boolean>((resolve) => {
        const open = indexedDB.open('vviewer', 2);
        open.onsuccess = () => {
          const db = open.result;
          try {
            const get = db.transaction('kv', 'readonly').objectStore('kv').get('workspaces');
            get.onsuccess = () => {
              const snap = get.result as
                | { workspaces?: { tabs?: { name?: string; overrideRenderer?: string }[] }[] }
                | undefined;
              const tabs = Array.isArray(snap?.workspaces)
                ? snap.workspaces.flatMap((w) => w.tabs ?? [])
                : [];
              resolve(
                tabs.some((t) => t.name === 'manual.txt' && t.overrideRenderer === 'hex')
              );
              db.close();
            };
            get.onerror = () => {
              resolve(false);
              db.close();
            };
          } catch {
            resolve(false);
            db.close();
          }
        };
        open.onerror = () => resolve(false);
      }),
    undefined,
    { polling: 50 }
  );

  // 刷新：本地注入 File 内容不跨刷新（m1.spec.ts:102 先例）——tab 以占位恢复（名称保留），
  // 内容侧错误卡片。override 的 UI 级刷新恢复走 BUG-69 用例（需 remote 快照通道）。
  await page.reload();
  await expect(
    page.locator('.vv-error-card, .vv-empty').first()
  ).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('.vv-tab', { hasText: 'manual.txt' })).toBeVisible();
});

test('BUG-69 [open-with e2e]: restore 透传 overrideRenderer 生效——remote 快照回读的 UI 级恢复（scrollTop 同机理，BUG-64 一并修复）', async ({
  page
}) => {
  test.setTimeout(60_000);
  // 假 vviewer 文件服务器（t-shell.spec.ts SHELL-04/cors 的测试内 http 服务先例）：
  // restore 期 reconnectRemoteStore 只探测 GET /api/health（3s 超时判可达）；
  // ViewerPane 经 RemoteStore.read 拉 GET /api/file。跨源（4173 页面源）必须带 ACAO:*。
  // /api/ticket+/api/events 给合法 SSE 通道，避免 watch 订阅 1s 退避重试噪音。
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const cors = { 'Access-Control-Allow-Origin': '*' };
    if (url.pathname === '/api/health') {
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ capabilities: ['file-server'] }));
      return;
    }
    if (url.pathname === '/api/file') {
      res.writeHead(200, { ...cors, 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('plain text body\n');
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
    res.writeHead(404, cors);
    res.end();
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  try {
    await waitAppMounted(page);
    // 预置恢复现场：sessionStorage last-server（base 精确匹配 storeBase）+ IDB 旧键
    // 'tabs' 快照 → reload 触发 restore 走迁移（migrateLegacyTabs）+ remote 重连分支。
    // 旧语义→新语义（workspace T3/T4）：旧 restore 按单 tab storeBase 重连；v2 restore
    // 只重连「迁移派生的来源」（path==='' 目录条目派生 source）并按 storeId 挂靠 tab
    // ——故快照须含目录条目，且 storeId 必须等于重建 store 的 id（hash8(base:label)，
    // label 参与 hash：T5 I-1「快照 storeLabel 原值回环」的本用例即锚）。DB 版本 2
    //（主题库升级；v1 open 对既有 v2 库 VersionError）。
    const remoteId = `remote:${hash8(`${base}:e2e-fake`)}`;
    const baseTab = {
      storeId: remoteId,
      storeLabel: 'e2e-fake',
      storeBase: base,
      kind: 'rename-only' as const,
      scrollTop: 0
    };
    await page.evaluate(
      (seed) =>
        new Promise<void>((resolve, reject) => {
          sessionStorage.setItem(
            'vviewer-last-server',
            JSON.stringify({ baseUrl: seed.base, token: null })
          );
          const open = indexedDB.open('vviewer', 2);
          open.onupgradeneeded = () => {
            if (!open.result.objectStoreNames.contains('kv')) open.result.createObjectStore('kv');
          };
          open.onsuccess = () => {
            const db = open.result;
            const tx = db.transaction('kv', 'readwrite');
            tx.objectStore('kv').put(
              [
                {
                  ...seed.baseTab,
                  id: 't0',
                  path: '',
                  name: 'e2e-fake',
                  active: false
                },
                {
                  ...seed.baseTab,
                  id: 't1',
                  path: 'notes.txt',
                  name: 'notes.txt',
                  active: true,
                  overrideRenderer: 'hex'
                }
              ],
              'tabs'
            );
            tx.oncomplete = () => {
              db.close();
              resolve();
            };
            tx.onerror = () => {
              db.close();
              reject(tx.error);
            };
          };
          open.onerror = () => reject(open.error);
        }),
      { base, baseTab }
    );
    await page.reload();
    await expect(page.locator('.vv-tab', { hasText: 'notes.txt' })).toBeVisible({
      timeout: 10_000
    });
    // 修复前（BUG-69）：addTab 返回裸对象，透传 `tab.overrideRenderer = 'hex'` 绕过
    // $state 代理 set trap 恒不生效 → tab 无 override，自动路由渲染 code 视图。
    await openRightIfNarrow(page);
    await expect(page.locator('.vv-hex')).toBeVisible({ timeout: 20_000 }); // override 命中
    await expect(page.locator('.vv-code-pre')).toHaveCount(0); // 非 code 视图
    await expect(page.locator('.meta-openwith')).toHaveValue('hex'); // MetaPanel 回显
    await expect(page.locator('.meta-openwith-manual')).toBeVisible(); // （手动）标记
  } finally {
    server.close();
    server.closeAllConnections(); // /api/events 长连接不 end：close() 需配套断连
  }
});

test('OPEN-04：jsonl → 专有 JSON Lines 卡片视图（jsonlRenderer 装配锚点）', async ({ page }) => {
  test.setTimeout(60_000);
  await waitAppMounted(page);
  const jsonl = '{"id":1,"label":"first"}\n{"id":2,"label":"second"}\n';
  await dropFile(page, { name: 'notes.jsonl', type: 'application/jsonl', content: jsonl });
  await expect(page.locator('.vv-error-card')).toHaveCount(0);
  await expect(page.locator('.vv-jsonl')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.vv-jsonl-card', { hasText: 'first' })).toBeVisible();
  await expect(page.locator('.vv-jsonl-card', { hasText: 'second' })).toBeVisible();
});

test('OPEN-05：解析失败行徽标与折叠（混合合法/非法行）', async ({ page }) => {
  test.setTimeout(60_000);
  await waitAppMounted(page);
  const lines = [
    JSON.stringify({ id: 1, nested: { deep: [1, 2, 3] } }),
    '{broken',
    JSON.stringify({ id: 3 })
  ].join('\n');
  await dropFile(page, { name: 'mixed.jsonl', type: 'application/jsonl', content: lines });
  await expect(page.locator('.vv-jsonl-card-failed')).toHaveCount(1);
  await expect(page.locator('.vv-jsonl-status')).toContainText('1 行解析失败');
});

test('OPEN-06：打开方式往返 jsonl↔code（override）', async ({ page }) => {
  test.setTimeout(60_000);
  await waitAppMounted(page);
  await dropFile(page, { name: 'r.jsonl', type: 'application/jsonl', content: '{"a":1}\n' });
  await expect(page.locator('.vv-jsonl-card')).toHaveCount(1);
  await openRightIfNarrow(page); // 移动断点右栏在抽屉里（OPEN-03 同款）
  // 切 code（候选含 code，经 C 项 openWithOf 自动出现）
  await page.locator('.meta-openwith').selectOption('code');
  await expect(page.locator('.vv-code-pre')).toBeVisible({ timeout: 20_000 });
  // 切回 jsonl
  await page.locator('.meta-openwith').selectOption('jsonl');
  await expect(page.locator('.vv-jsonl-card')).toBeVisible({ timeout: 20_000 });
});

test('OPEN-07：1MB/约 5000 行首屏性能锚点（BUG-16 口径）', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const isMobile = testInfo.project.name === 'mobile';
  await waitAppMounted(page);
  // 1MB 载荷一次性预置进页面：后续每轮派发只引用页内字符串——传输/序列化
  // 开销落在探针 t0 之前，不污染测量窗口（探针只盖 File 构造 + drop → 首卡双 rAF）
  await page.evaluate((payload) => {
    (window as unknown as Record<string, unknown>).__vvJsonlPerfPayload = payload;
  }, makeJsonlPayload(5000));
  const samples: number[] = [];
  for (let i = 0; i < 9; i++) {
    await installPaintProbe(page, '.vv-jsonl-card');
    await page.evaluate((idx) => {
      const payload = (window as unknown as Record<string, unknown>).__vvJsonlPerfPayload as string;
      const file = new File([payload], `perf-${idx}.jsonl`, { type: 'application/jsonl' });
      const dt = new DataTransfer();
      dt.items.add(file);
      window.dispatchEvent(
        new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })
      );
    }, i);
    samples.push(await readProbe(page));
    if (i < 8) {
      // 轮间换小文件重置 pane（PWA-08「换文件天然重置」口径）：jsonl 卡片随 tab
      // 切换 destroy 移除，下一轮探针不会对上一轮残留 DOM 立即命中（0ms 假样本）
      await dropFile(page, { name: `pad-${i}.txt`, type: 'text/plain', content: 'pad\n' });
      await expect(page.locator('.vv-code-pre')).toBeVisible({ timeout: 20_000 });
    }
  }
  const med = median(samples);
  const budget = isMobile ? 400 : 200; // 移动放宽 = t-pwa 双倍惯例（spec §3 锚点）
  expect(med, `探针假样本（0ms=残留 DOM 立即命中）或超时：${samples.join('/')}`).toBeGreaterThan(0);
  console.log(
    `[perf] jsonl 首帧中位 ${med}ms（${samples.map(Math.round).join('/')}），预算 ${budget}ms（${testInfo.project.name}）`
  );
  expect(med, '1MB/约 5000 行首屏中位达验收预算（BUG-16 口径）').toBeLessThan(budget);
});
