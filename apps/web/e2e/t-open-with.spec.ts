import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, expect, type Page } from '@playwright/test';

/**
 * open-with 域回归（C 项「格式覆盖自动化」Task 7）：探测链与打开方式 override 的
 * 端到端验收（spec §2.2/§2.3）。
 * - OPEN-01：未知扩展名 probe.foo（PNG 签名内容）→ 签名改派 → image 视图
 * - OPEN-02：未知扩展名 bin.foo（NUL 二进制）→ 探测链 hex 兜底 → hex 视图
 * - OPEN-03：MetaPanel「打开方式」手选二进制 → override 即时重渲染 + 快照落盘；
 *   刷新后本地注入文件按既有语义以占位恢复（m1.spec.ts:102 先例）。override 的
 *   UI 级刷新恢复由 BUG-69 用例覆盖（假服务器 + 预置快照通道）。
 * - OPEN-04：notes.jsonl → code 视图——jsonl 不在 codeRenderer.extensions 手工清单
 *   （仅 json/jsonc），可预览只能来自 gen-code-extensions 生成物（C/D 装配锚点）。
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

  // override 落盘（setRendererOverride 经代理写 → persist）：IDB tabs 快照含
  // overrideRenderer:'hex'（确定性等待异步写，m1.spec.ts:74 轮询先例）
  await page.waitForFunction(
    () =>
      new Promise<boolean>((resolve) => {
        const open = indexedDB.open('vviewer', 1);
        open.onsuccess = () => {
          const db = open.result;
          try {
            const get = db.transaction('kv', 'readonly').objectStore('kv').get('tabs');
            get.onsuccess = () => {
              const tabs = (get.result ?? []) as { name?: string; overrideRenderer?: string }[];
              resolve(
                Array.isArray(tabs) &&
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
    // 预置恢复现场：sessionStorage last-server（base 精确匹配 storeBase）+ IDB tabs
    // 快照（rename-only + storeBase + overrideRenderer:'hex'）→ reload 触发 restore
    // 走 remote 重连分支（AppShell.svelte 对 addTab 返回值透传 scrollTop/overrideRenderer）
    await page.evaluate(
      (serverBase) =>
        new Promise<void>((resolve, reject) => {
          sessionStorage.setItem(
            'vviewer-last-server',
            JSON.stringify({ baseUrl: serverBase, token: null })
          );
          const open = indexedDB.open('vviewer', 1);
          open.onupgradeneeded = () => open.result.createObjectStore('kv');
          open.onsuccess = () => {
            const db = open.result;
            const tx = db.transaction('kv', 'readwrite');
            tx.objectStore('kv').put(
              [
                {
                  id: 't1',
                  storeId: 'remote:e2efake',
                  storeLabel: 'e2e-fake',
                  storeBase: serverBase,
                  path: 'notes.txt',
                  name: 'notes.txt',
                  kind: 'rename-only',
                  scrollTop: 0,
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
      base
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

test('OPEN-04：jsonl（生成扩展名集契约锚点）→ 以 code 视图渲染', async ({ page }) => {
  test.setTimeout(60_000);
  await waitAppMounted(page);
  const jsonl = '{"id":1,"label":"first"}\n{"id":2,"label":"second"}\n';
  await dropFile(page, { name: 'notes.jsonl', type: 'application/jsonl', content: jsonl });
  await expect(page.locator('.vv-error-card')).toHaveCount(0);
  await expect(page.locator('.vv-code-pre')).toContainText('"first"', { timeout: 20_000 });
  await expect(page.locator('.vv-code-pre')).toContainText('"second"');
});
