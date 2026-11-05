import http from 'node:http';
import zlib from 'node:zlib';
import type { AddressInfo } from 'node:net';
import { test, expect, type Page } from '@playwright/test';
import { hash8 } from '@bhxch/vviewer-core';
import JSZip from 'jszip';
import { injectDir, openTreeFile } from './b-markdown-html-docs-helpers';
import { openSettings, gotoGroup, applySettings, closeSettings } from './settings-center';

/**
 * b-save-as —— 另存为统一管线 e2e 锚（spec §6.4 另存为双形态 + tab 级第七动作；
 * plan2 Task 7，brief Step-5 三锚 + 控制器移交 DL-PROG-01/02、DL-CONF-01/02/03）。
 *
 * - SA-01 远端菜单另存为：saveAsTab 重下泵（/api/file 下载事件锚：另存为触发新增
 *   Range 读）→ picker 桩直写落盘，字节校验和等值；
 * - SA-02 zip 条目另存为：非远端 store.read 单次全量（zipStore 条目读通道）→
 *   picker 桩字节等值（纯本地注入，零网络面）；
 * - SA-03 菜单项置灰：占位 tab（unrestorable）「另存为」aria-disabled + 点击零动作
 *   （picker 不弹、菜单留守）；
 * - DL-PROG-01 进度卡字段全锚（R1 慢泵）：地址/进度条/已下载/完整大小/速度/ETA/
 *   取消；完成后卡自动卸载（Task 7 完成态 TTL）+ 内容渲染出现；
 * - DL-PROG-02 不定态锚：快照无 size（tree-size 缺失形态，spec §6.4 已知接缝①：
 *   FileSource.size 为打开时快照非 Content-Length——R1 树条目缺 size 即干净不定态
 *   形态）→「（总大小未知）」文案 + 无 valuenow 不定态 bar；
 * - DL-CONF-01 确认门双路（默认阈值 512MB，>512MB 形态）：(a) 确认卡字段全锚 →
 *   开始下载 → 进度卡出现（route 只 fulfill 首块后挂起，泵免真传 512MB）；
 *   (b) 取消 → /api/file 请求计数 0（泵未启动）；
 * - DL-CONF-02 阈值生效：设置面板改 1MB → 2MB 文件确认卡出现（门每轮现算即时生效）；
 * - DL-CONF-03 孤儿清偿（I-1 回归锚）：确认等待期切目录 tab → 确认卡消失。
 *
 * 装置：mini 假 vviewer 服务器（b-error-card-open-as 同款端点集，Range 206 切片 +
 * 逐块延时/挂起形态）+ 旧键 'tabs' 快照预置恢复（须含 path==='' 目录条目派生来源）；
 * showSaveFilePicker 以 addInitScript 桩（headless 无 FS Access 自动化面，创建
 * writable 捕获写入块/close/abort，b-error-card picker 桩同思路）。
 *
 * 桌面专属（仅 chromium project，b-diagram-file beforeEach 跳过同款）：右键菜单/
 * 进度卡浮层均为桌面交互面，mobile 375px 复跑无增量覆盖。
 */

// ---------- 载体构造：大体积 PNG（私有 ancillary 块填充，解码面 1×1 像素） ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** 1×1 RGBA PNG + vvEX 私有 ancillary 块填充到目标体量（解码器跳过未知块） */
function makePaddedPng(padBytes: number): Buffer {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = pngChunk('IHDR', Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]));
  const pad = pngChunk('vvEX', Buffer.alloc(padBytes, 0x5a));
  const raw = Buffer.from([0, 0x33, 0x44, 0x55, 0xff]); // filter 0 + RGBA 像素
  const idat = pngChunk('IDAT', zlib.deflateSync(raw));
  const iend = pngChunk('IEND', Buffer.alloc(0));
  return Buffer.concat([sig, ihdr, pad, idat, iend]);
}

/** 页面/节点两端一致的轻量字节校验和（SA-01/02 落盘等值锚） */
function byteHash(bytes: Uint8Array): number {
  let h = 0;
  for (let i = 0; i < bytes.length; i++) h = (h + bytes[i]! * ((i % 97) + 1)) >>> 0;
  return h >>> 0;
}

// ---------- mini 假 vviewer 服务器（端点集同 b-error-card-open-as） ----------

interface FakeVVServer {
  base: string;
  fileRequests: string[];
  close(): Promise<void>;
}

async function startFakeVVServer(
  fileName: string,
  bytes: Uint8Array,
  opts: { treeSize?: number; omitTreeSize?: boolean; chunkDelayMs?: number; hangAfterFirstChunk?: boolean } = {}
): Promise<FakeVVServer> {
  const fileRequests: string[] = [];
  let servedChunks = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const cors = { 'Access-Control-Allow-Origin': '*' };
    if (url.pathname === '/api/health') {
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ capabilities: ['file-server'] }));
      return;
    }
    if (url.pathname === '/api/tree') {
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      const entry: Record<string, unknown> = { name: fileName, kind: 'file' };
      if (opts.omitTreeSize === true) {
        // 树条目省略 size：FileSource.size null（不定态下载的干净 mock 形态）
      } else if (opts.treeSize !== undefined) {
        entry.size = opts.treeSize; // 声明体量与实际字节脱钩（>512MB 门形态，免真传）
      } else {
        entry.size = bytes.length;
      }
      res.end(JSON.stringify({ entries: [entry] }));
      return;
    }
    if (url.pathname === '/api/file') {
      fileRequests.push(req.headers.range ?? '(no-range)');
      // hangAfterFirstChunk：放行 head 探测块 + 首个泵块（进度卡有 tick 可断言），
      // 自第 3 个请求起永不应答——确认路免真传 >512MB，泵挂起即可观察进度卡
      if (opts.hangAfterFirstChunk === true && servedChunks >= 2) {
        return;
      }
      servedChunks += 1;
      const range = req.headers.range ?? null;
      const m = range !== null ? /bytes=(\d+)-(\d*)/.exec(range) : null;
      const start = m !== null ? Math.min(Number(m[1]), Math.max(bytes.length - 1, 0)) : 0;
      const end =
        m !== null && m[2] !== undefined && m[2] !== ''
          ? Math.min(Number(m[2]), bytes.length - 1)
          : bytes.length - 1;
      const chunk = bytes.subarray(start, end + 1);
      const write = (): void => {
        res.writeHead(m !== null ? 206 : 200, {
          ...cors,
          'Content-Type': 'application/octet-stream',
          ...(m !== null ? { 'Content-Range': `bytes ${start}-${end}/${bytes.length}` } : {}),
          'Content-Length': String(chunk.length)
        });
        res.end(chunk);
      };
      if (opts.chunkDelayMs !== undefined && opts.chunkDelayMs > 0) {
        setTimeout(write, opts.chunkDelayMs); // 慢泵形态：逐块延时（进度卡观察窗）
      } else {
        write();
      }
      return;
    }
    if (url.pathname === '/api/ticket') {
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ticket: 'e2e' }));
      return;
    }
    if (url.pathname === '/api/events') {
      res.writeHead(200, { ...cors, 'Content-Type': 'text/event-stream' });
      return; // 保持打开、无数据帧：SSE 挂起（测试结束统一断连）
    }
    res.writeHead(404, cors);
    res.end();
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    fileRequests,
    close: async () => {
      server.close();
      server.closeAllConnections();
    }
  };
}

// ---------- 会话预置（旧键 'tabs' 快照恢复，BUG-69/OWX 同款） ----------

interface SeedTab {
  path: string;
  name: string;
  size?: number;
  active?: boolean;
}

async function seedRemoteTabs(
  page: Page,
  opts: { base: string; tabs: SeedTab[]; withLastServer?: boolean }
): Promise<void> {
  const storeId = `remote:${hash8(`${opts.base}:e2e-fake`)}`;
  await page.addInitScript(
    (seed) => {
      if (seed.withLastServer) {
        sessionStorage.setItem('vviewer-last-server', JSON.stringify({ baseUrl: seed.base, token: null }));
      }
      const open = indexedDB.open('vviewer');
      open.onupgradeneeded = () => {
        if (!open.result.objectStoreNames.contains('kv')) open.result.createObjectStore('kv');
      };
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction('kv', 'readwrite');
        const entries = seed.tabs.map((t, i) => ({
          id: `t${i}`,
          storeId: seed.storeId,
          storeLabel: 'e2e-fake',
          ...(seed.withLastServer ? { storeBase: seed.base } : {}),
          kind: 'rename-only' as const,
          scrollTop: 0,
          active: t.active ?? false,
          path: t.path,
          name: t.name,
          ...(t.size !== undefined ? { size: t.size } : {})
        }));
        tx.objectStore('kv').put(entries, 'tabs');
        tx.oncomplete = () => db.close();
        tx.onerror = () => db.close();
      };
    },
    { base: opts.base, storeId, tabs: opts.tabs, withLastServer: opts.withLastServer ?? true }
  );
}

// ---------- picker 桩（addInitScript：headless 无 FS Access 自动化面） ----------

/** showSaveFilePicker 桩：suggestedName 记录、writable 捕获写入块 + close/abort 计数 */
async function installSavePickerStub(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown> & {
      __vvSave: { calls: (string | null)[]; chunks: Array<Blob | Uint8Array>; closed: number; aborted: number };
    };
    w.__vvSave = { calls: [], chunks: [], closed: 0, aborted: 0 };
    w.showSaveFilePicker = async (o?: { suggestedName?: string }) => {
      w.__vvSave.calls.push(o?.suggestedName ?? null);
      return {
        createWritable: async () => ({
          write: async (c: Blob) => {
            w.__vvSave.chunks.push(c);
          },
          close: async () => {
            w.__vvSave.closed += 1;
          },
          abort: async () => {
            w.__vvSave.aborted += 1;
          }
        })
      };
    };
  });
}

/** 落盘汇总：suggestedName / 总字节 / 校验和 / close·abort 计数。chunks 兼容双形态：
 * Blob（saveAsBlob 一次性写）与 Uint8Array（tee 自持泵逐块直写，终审 I-4 锚） */
async function savedSummary(page: Page): Promise<{
  calls: (string | null)[];
  total: number;
  hash: number;
  closed: number;
  aborted: number;
}> {
  return page.evaluate(async () => {
    const s = (window as unknown as {
      __vvSave: { calls: (string | null)[]; chunks: Array<Blob | Uint8Array>; closed: number; aborted: number };
    }).__vvSave;
    let total = 0;
    let hash = 0;
    for (const c of s.chunks) {
      const buf = c instanceof Blob ? new Uint8Array(await c.arrayBuffer()) : new Uint8Array(c);
      total += buf.length;
      for (let i = 0; i < buf.length; i++) hash = (hash + buf[i]! * ((i % 97) + 1)) >>> 0;
    }
    return { calls: s.calls, total, hash, closed: s.closed, aborted: s.aborted };
  });
}

/** 右键 tab 打开自绘菜单并点「另存为」（第七动作，菜单项 role=menuitem） */
async function clickTabSaveAs(page: Page, tabName: string): Promise<void> {
  await page.locator('.vv-tab', { hasText: tabName }).first().click({ button: 'right' });
  await expect(page.locator('.vv-tabctx')).toBeVisible();
  await page.getByRole('menuitem', { name: '另存为' }).click();
}

/** 设置面板把远端下载确认阈值改为指定 MB（DL-CONF-02/03 共用，评审 I-4 去重）：
 * fill 只发 input 事件，本输入框 onchange 提交（blur/Enter）——Enter 触发 change
 * 使草稿变脏（apply 恒 disabled 死锁面，b-settings-center-deep 数值输入同款） */
async function setConfirmThreshold(page: Page, mb: string): Promise<void> {
  await openSettings(page);
  await gotoGroup(page, '存储与数据');
  const input = page.getByLabel('远端下载确认阈值（MB）');
  await input.fill(mb);
  await input.press('Enter');
  await applySettings(page);
  await closeSettings(page);
}

test.describe('b-save-as 另存为管线（SA 域 + DL 移交锚）', () => {
  test.beforeEach(({}, testInfo) => {
    testInfo.skip(testInfo.project.name !== 'chromium', '桌面视口专属（仅 chromium project）');
  });

  test('SA-01 远端菜单另存为：saveAsTab 重下泵（下载事件锚）+ picker 桩字节等值落盘', async ({ page }) => {
    test.setTimeout(90_000);
    const png = makePaddedPng(2 * 1024 * 1024); // 2MiB（<4MiB 泵单块窗）
    const srv = await startFakeVVServer('big.png', png);
    await installSavePickerStub(page);
    await seedRemoteTabs(page, { base: srv.base, tabs: [{ path: '', name: 'e2e-fake', active: false }, { path: 'big.png', name: 'big.png', size: png.length, active: true }] });
    await page.goto('/');
    // 首开渲染（自动下载一次）：图片内容出现
    await expect(page.locator('.vv-viewer-host img')).toBeVisible({ timeout: 30_000 });
    const readsBefore = srv.fileRequests.length;
    expect(readsBefore).toBeGreaterThanOrEqual(1); // 首开物化读锚

    // 右键 → 另存为：saveAsTab 远端路（重新取数）→ saveAsBlob picker 桩
    await clickTabSaveAs(page, 'big.png');
    await page.waitForFunction(() => {
      const s = (window as unknown as { __vvSave?: { closed: number } }).__vvSave;
      return (s?.closed ?? 0) >= 1;
    }, undefined, { timeout: 20_000 });

    const sum = await savedSummary(page);
    expect(sum.calls[0]).toBe('big.png'); // suggestedName = 源文件名
    expect(sum.total).toBe(png.length); // 全量字节落盘
    expect(sum.hash).toBe(byteHash(png)); // 校验和等值
    expect(sum.closed).toBe(1);
    expect(sum.aborted).toBe(0);
    expect(srv.fileRequests.length).toBeGreaterThan(readsBefore); // 另存为触发新增下载（下载事件锚）
    await srv.close();
  });

  test('SA-02 zip 条目另存为：zipStore 读全量 + picker 桩字节等值（本地零网络通道）', async ({ page }) => {
    test.setTimeout(90_000);
    const entryText = 'HELLO-ZIP-ENTRY-BYTES';
    const z = new JSZip();
    z.file('hello.txt', entryText);
    const zip = await z.generateAsync({ type: 'nodebuffer' });
    await installSavePickerStub(page);
    await injectDir(page, [{ name: 'sample.zip', content: '', type: 'application/zip', b64: zip.toString('base64') }]);
    await openTreeFile(page, 'sample.zip');
    // 归档条目树 → 点击条目开 tab（zip: store）
    const pane = page.locator('.vv-archive');
    await expect(pane.locator('.vv-tree-row', { hasText: 'hello.txt' })).toBeVisible({ timeout: 20_000 });
    await pane.locator('.vv-tree-row', { hasText: 'hello.txt' }).click();
    await expect(page.locator('.vv-tab.active', { hasText: 'hello.txt' })).toBeVisible();

    await clickTabSaveAs(page, 'hello.txt');
    await page.waitForFunction(() => {
      const s = (window as unknown as { __vvSave?: { closed: number } }).__vvSave;
      return (s?.closed ?? 0) >= 1;
    }, undefined, { timeout: 20_000 });

    const sum = await savedSummary(page);
    expect(sum.calls[0]).toBe('hello.txt');
    expect(sum.total).toBe(entryText.length);
    expect(sum.hash).toBe(byteHash(new TextEncoder().encode(entryText)));
    expect(sum.closed).toBe(1);
  });

  test('SA-03 菜单项置灰：占位 tab 另存为 aria-disabled + 点击零动作（picker 不弹、菜单留守）', async ({ page }) => {
    test.setTimeout(90_000);
    await installSavePickerStub(page);
    // 无 last-server：remote 来源不重建 → tab 落占位（unrestorable）
    await seedRemoteTabs(page, {
      base: 'http://127.0.0.1:9',
      withLastServer: false,
      tabs: [{ path: 'ghost.bin', name: 'ghost.bin', active: true }]
    });
    await page.goto('/');
    await expect(page.locator('.vv-tab.active', { hasText: 'ghost.bin' })).toBeVisible({ timeout: 20_000 });

    await page.locator('.vv-tab.active', { hasText: 'ghost.bin' }).click({ button: 'right' });
    const menu = page.locator('.vv-tabctx');
    await expect(menu).toBeVisible();
    const item = page.getByRole('menuitem', { name: '另存为' });
    await expect(item).toHaveAttribute('aria-disabled', 'true');
    // force click：aria-disabled 被 Playwright actionability 判不可点（enabled 检查），
    // 而 run() 的置灰守卫按 disabled 属性拦截——force 派发点击验证「点击不动作」语义
    await item.click({ force: true }); // run() 置灰守卫：不动作、菜单不关
    await expect(menu).toBeVisible();
    const sum = await savedSummary(page);
    expect(sum.calls).toHaveLength(0); // picker 未弹
  });

  test('DL-PROG-01 进度卡字段全锚（R1 慢泵）+ 完成后卡自动卸载、内容渲染出现', async ({ page }) => {
    test.setTimeout(150_000);
    // 夹具体量 24MiB 级（6 × 4MiB 泵块）；声明 size 必须取 png.length（快照 size 是
    // 泵的收口真值——短声明会截断 PNG 尾部 IEND，解码失败面）
    const png = makePaddedPng(24 * 1024 * 1024);
    const size = png.length;
    const srv = await startFakeVVServer('big.png', png, { chunkDelayMs: 500 });
    await seedRemoteTabs(page, { base: srv.base, tabs: [{ path: '', name: 'e2e-fake', active: false }, { path: 'big.png', name: 'big.png', size, active: true }] });
    await page.goto('/');

    const card = page.locator('.vv-dl-progress');
    await expect(card).toBeVisible({ timeout: 20_000 });
    // 字段全锚：地址行（脱敏 endpoint + path）/ 进度条（progressbar 语义）/ 已下载行
    // （已下载/完整大小）/ 速度行（~5s 滑窗，逐块 500ms 下 ~1.5s 后稳定）/ ETA 行 /
    // 取消钮
    await expect(card.locator('.vv-dl-progress-address')).toContainText(srv.base);
    await expect(card.locator('.vv-dl-progress-address')).toContainText('big.png');
    const bar = card.locator('.vv-dl-progress-bar');
    await expect(bar).toHaveAttribute('role', 'progressbar');
    await expect(card.locator('.vv-dl-progress-loaded')).toContainText('已下载');
    await expect(card.locator('.vv-dl-progress-loaded')).toContainText('24.0 MB');
    await expect(card.locator('.vv-dl-progress-eta')).toBeVisible(); // 计算中 或 剩余 X
    await expect(card.locator('.vv-dl-progress-cancel')).toBeVisible();
    await expect(card.locator('.vv-dl-progress-speed')).toBeVisible({ timeout: 10_000 });

    // 完成：卡自动卸载（Task 7 完成态 TTL 4s——DL-PROG-01「完成后卡自动卸载」锚），
    // 内容渲染出现（浮层不占布局，渲染并行接管）
    await expect(page.locator('.vv-viewer-host img')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.vv-dl-progress-done')).toBeVisible({ timeout: 10_000 });
    await expect(card).toHaveCount(0, { timeout: 10_000 });
    await srv.close();
  });

  test('DL-PROG-02 不定态锚：size 未知 →「（总大小未知）」+ 无 valuenow 不定态 bar', async ({ page }) => {
    test.setTimeout(150_000);
    const png = makePaddedPng(9 * 1024 * 1024); // 3 × 4MiB 泵块（不定态满窗循环）
    // tree 条目省略 size + 快照不带 size：FileSource.size null（不定态的干净 mock 形态）
    const srv = await startFakeVVServer('mystery.png', png, { chunkDelayMs: 500, omitTreeSize: true });
    await seedRemoteTabs(page, { base: srv.base, tabs: [{ path: '', name: 'e2e-fake', active: false }, { path: 'mystery.png', name: 'mystery.png', active: true }] });
    await page.goto('/');

    const card = page.locator('.vv-dl-progress');
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card.locator('.vv-dl-progress-loaded')).toContainText('（总大小未知）');
    const bar = card.locator('.vv-dl-progress-bar');
    await expect(bar).toHaveClass(/vv-dl-progress-bar-indeterminate/);
    expect(await bar.getAttribute('aria-valuenow')).toBeNull(); // 不定态：无 valuenow
    await expect(card.locator('.vv-dl-progress-eta')).toHaveCount(0); // 不定态无 ETA 概念
    // 完成卸载 + 内容渲染
    await expect(page.locator('.vv-viewer-host img')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.vv-dl-progress')).toHaveCount(0, { timeout: 10_000 });
    await srv.close();
  });

  test('DL-CONF-01a 确认门确认路（默认 512MB 阈值）：确认卡字段全锚 → 开始下载 → 进度卡出现', async ({ page }) => {
    test.setTimeout(120_000);
    const declared = 513 * 1024 * 1024; // >512MB 阈值形态（mock 大 size，免真传）
    const actual = makePaddedPng(1024 * 1024);
    const srv = await startFakeVVServer('huge.png', actual, { treeSize: declared, hangAfterFirstChunk: true });
    await seedRemoteTabs(page, { base: srv.base, tabs: [{ path: '', name: 'e2e-fake', active: false }, { path: 'huge.png', name: 'huge.png', size: declared, active: true }] });
    await page.goto('/');

    // 确认卡先现（泵前置拦截：此时零 /api/file 请求）
    const card = page.locator('.vv-dl-confirm');
    await expect(card).toBeVisible({ timeout: 20_000 });
    expect(srv.fileRequests).toHaveLength(0);
    await expect(card.locator('.vv-dl-confirm-name')).toHaveText('huge.png');
    await expect(card.locator('.vv-dl-confirm-size')).toContainText('513.0 MB');
    await expect(card.locator('.vv-dl-confirm-renderer')).toHaveText('目标渲染器：图片');
    await expect(card.locator('.vv-dl-confirm-start')).toBeVisible();
    await expect(card.locator('.vv-dl-confirm-saveas')).toBeVisible(); // 双形态二按钮（FS Access 探测装配）
    await expect(card.locator('.vv-dl-confirm-cancel')).toBeVisible();

    // 确认 → 泵启动 → 进度卡出现（route 只 fulfill 首块后挂起——免真传 513MB）
    await card.locator('.vv-dl-confirm-start').click();
    await expect(page.locator('.vv-dl-progress')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('.vv-dl-confirm')).toHaveCount(0);
    expect(srv.fileRequests.length).toBeGreaterThanOrEqual(1);
    await srv.close();
  });

  test('DL-CONF-01b 确认门取消路：取消 → 无泵请求（请求计数 0）', async ({ page }) => {
    test.setTimeout(120_000);
    const declared = 513 * 1024 * 1024;
    const actual = makePaddedPng(1024 * 1024);
    const srv = await startFakeVVServer('huge.png', actual, { treeSize: declared });
    await seedRemoteTabs(page, { base: srv.base, tabs: [{ path: '', name: 'e2e-fake', active: false }, { path: 'huge.png', name: 'huge.png', size: declared, active: true }] });
    await page.goto('/');

    const card = page.locator('.vv-dl-confirm');
    await expect(card).toBeVisible({ timeout: 20_000 });
    await card.locator('.vv-dl-confirm-cancel').click(); // 静默中止：不 dispatch、无泵
    await expect(card).toHaveCount(0);
    await expect(page.locator('.vv-dl-progress')).toHaveCount(0);
    await page.waitForTimeout(500); // 泵若误启动，请求在此窗口内到达
    expect(srv.fileRequests).toHaveLength(0); // 请求计数 0（泵未启动锚）
    await srv.close();
  });

  test('DL-CONF-02 阈值生效：设置面板改 1MB → 打开 2MB 文件确认卡出现', async ({ page }) => {
    test.setTimeout(120_000);
    const png = makePaddedPng(2 * 1024 * 1024);
    const srv = await startFakeVVServer('mid.png', png);
    await seedRemoteTabs(page, { base: srv.base, tabs: [{ path: '', name: 'e2e-fake', active: true }, { path: 'mid.png', name: 'mid.png', size: png.length, active: false }] });
    await page.goto('/');
    await expect(page.locator('.vv-tab.active', { hasText: 'e2e-fake' })).toBeVisible({ timeout: 20_000 });

    // 设置面板把阈值改 1MB（门读 settings 现值，应用后下一次门评估即时生效）
    await setConfirmThreshold(page, '1');

    // 打开 2MB 文件（>1MB 阈值）→ 确认卡出现
    await page.locator('.vv-tab', { hasText: 'mid.png' }).click();
    await expect(page.locator('.vv-dl-confirm')).toBeVisible({ timeout: 20_000 });
    expect(srv.fileRequests).toHaveLength(0); // 门拦截：泵未启动
    await srv.close();
  });

  test('DL-CONF-03 孤儿清偿：确认等待期切目录 tab → 确认卡消失（I-1 回归锚）', async ({ page }) => {
    test.setTimeout(120_000);
    const png = makePaddedPng(2 * 1024 * 1024);
    const srv = await startFakeVVServer('mid.png', png);
    await seedRemoteTabs(page, { base: srv.base, tabs: [{ path: '', name: 'e2e-fake', active: true }, { path: 'mid.png', name: 'mid.png', size: png.length, active: false }] });
    await page.goto('/');
    await expect(page.locator('.vv-tab.active', { hasText: 'e2e-fake' })).toBeVisible({ timeout: 20_000 });
    await setConfirmThreshold(page, '1');

    await page.locator('.vv-tab', { hasText: 'mid.png' }).click();
    const card = page.locator('.vv-dl-confirm');
    await expect(card).toBeVisible({ timeout: 20_000 });

    // 确认等待期切目录 tab：守卫分支清偿（不留孤儿卡）
    await page.locator('.vv-tab', { hasText: 'e2e-fake' }).first().click();
    await expect(page.locator('.vv-tab.active', { hasText: 'e2e-fake' })).toBeVisible();
    await expect(card).toHaveCount(0);
    expect(srv.fileRequests).toHaveLength(0); // 全程零泵请求
    await srv.close();
  });

  test('DL-SAVE-01 tee 直写运行时锚（终审 I-4）：确认卡「下载并另存为」→ picker 桩 close → 落盘字节 hash 与源等值', async ({ page }) => {
    test.setTimeout(120_000);
    // 2MiB（<4MiB 泵单块窗；>1MB 阈值触发确认门）——落盘字节面走自持泵 tee
    //（pumpToWritable）单通道：SA-01 菜单路锚 saveAsBlob 管线，本锚钉确认卡双形态二
    const png = makePaddedPng(2 * 1024 * 1024);
    const srv = await startFakeVVServer('mid.png', png);
    await installSavePickerStub(page);
    await seedRemoteTabs(page, { base: srv.base, tabs: [{ path: '', name: 'e2e-fake', active: true }, { path: 'mid.png', name: 'mid.png', size: png.length, active: false }] });
    await page.goto('/');
    await expect(page.locator('.vv-tab.active', { hasText: 'e2e-fake' })).toBeVisible({ timeout: 20_000 });
    await setConfirmThreshold(page, '1');

    await page.locator('.vv-tab', { hasText: 'mid.png' }).click();
    const card = page.locator('.vv-dl-confirm');
    await expect(card).toBeVisible({ timeout: 20_000 });
    expect(srv.fileRequests).toHaveLength(0); // 门拦截：泵未启动

    // 双形态二：picker 桩同步 resolve → dlSaveHandle 登记 → effect 重跑过门 →
    // 自持泵 tee 逐块直写 → 泵完 close 落盘（不等渲染）
    await card.locator('.vv-dl-confirm-saveas').click();
    await expect(card).toHaveCount(0); // 门通过卸卡
    await page.waitForFunction(() => {
      const s = (window as unknown as { __vvSave?: { closed: number } }).__vvSave;
      return (s?.closed ?? 0) >= 1;
    }, undefined, { timeout: 30_000 });

    const sum = await savedSummary(page);
    expect(sum.calls[0]).toBe('mid.png'); // suggestedName = 源文件名
    expect(sum.total).toBe(png.length); // 全量字节落盘
    expect(sum.hash).toBe(byteHash(png)); // 校验和等值（tee 直写运行时锚）
    expect(sum.closed).toBe(1);
    expect(sum.aborted).toBe(0);
    // tee 泵完 buffer 直传 dispatch（full = buffer 零重读）：内容渲染接管
    await expect(page.locator('.vv-viewer-host img')).toBeVisible({ timeout: 30_000 });
    await srv.close();
  });
});
