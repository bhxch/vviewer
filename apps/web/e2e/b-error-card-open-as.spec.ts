import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { test, expect, type Locator, type Page } from '@playwright/test';
import { hash8 } from '@vviewer/core';
import { closeDrawerIfOpened, openDrawerIfNarrow } from './drawer';

/**
 * 错误卡片打开方式入口（open-as 全链）域补充 E2E（b- 前缀）。
 * 场景来源：docs/e2e/error-card-open-as.md（OWX-01~08）。既有覆盖不重写：
 * OPEN-03（MetaPanel 手选+快照落盘）、BUG-69（remote restore 透传 override）、
 * MEDIA-11/BUG-14（截断 mp4/pdf 卡片按钮存在性，从未点击）；本文件补「点击链」：
 *
 * 错误卡片有两条实现链（域文档文件头注记，样本按链选型）：
 * - 渲染器内构卡片（软失败）：av.ts showMediaError → [重试, 以 hex 打开]，hex 动作
 *   直调 hex.render(buffer)（全量形态）+ takeOver 级联托管，不经 dispatch 重入
 *   —— OWX-01/03/06/07③/08（截断 mp4）；
 * - dispatcher 级卡片（抛错型）：render throw → buildRenderErrorActions →
 *   [重试, 以纯文本打开, 以 hex 打开]（looksTextual 动态排序）+ openAsAction 以
 *   rendererOverride 重入 dispatch —— OWX-02/04/05（broken.svg：sanitizeSvg 抛
 *   「SVG 解析失败」）与 OWX-09（broken-binary.jpg：图片解码校验 throw，BUG-53
 *   修复面，t-media 同载体）。
 *
 * 注入通道：本地目录经 __vvOpenDirImpl（b-media-office-viewer 同款）；远端经 spec 内
 * mini 假服务器（t-open-with BUG-69 同款端点集）+ 旧键 'tabs' 快照预置恢复（须含
 * path==='' 目录条目派生来源）。default 套件双 project 全跑，窄视口经 drawer.ts /
 * openRightIfNarrow 适配，无 desktop-only skip 项。
 */

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

/** sample.mp4 截前 300B（moov 损坏 → av 内构错误卡片「无法播放此媒体」，MEDIA-11 同口径） */
const BROKEN_MP4 = new Uint8Array(readFileSync(`${repoRoot}/samples/m4/sample.mp4`)).slice(0, 300);

const SVG_HEAD = '<svg xmlns="http://www.w3.org/2000/svg">\n';

/**
 * 截断 XML（根元素未闭合）：sanitizeSvg 的 DOMParser image/svg+xml 解析得 parsererror
 * → 抛「SVG 解析失败」→ dispatcher 级错误卡片（三按钮）。'x' 填充为纯 ASCII：
 * looksTextual 判文本 → 「以纯文本打开」排前（动态排序的被测面）。
 */
function makeBrokenSvgBytes(total: number): Uint8Array {
  const head = new TextEncoder().encode(SVG_HEAD);
  const out = new Uint8Array(total);
  out.set(head);
  out.fill(0x78, head.length); // 'x'
  return out;
}

const BROKEN_SVG_SMALL = makeBrokenSvgBytes(128); // formatSize → "128 B"
const BROKEN_SVG_BIG = makeBrokenSvgBytes(1_572_864); // 1.5MiB：>1MB → head 探测 + hex 窗口模式

/**
 * JPEG 头 + NUL 填充：解码必败（image.ts BUG-53 解码校验 throw → dispatcher 卡片）；
 * 含 NUL 判非文本（magic.ts:32，git 同口径）→ open-as 排序「以 hex 打开」排前。
 * 纯 0xba 垃圾字节 suspicious=0 会被 looksTextual 误判文本（t-media BUG-53 实证），
 * 不可作本锚载体。
 */
const BROKEN_JPG = new Uint8Array(512).map((_, i) => (i === 0 ? 0xff : i === 1 ? 0xd8 : i === 2 ? 0xff : 0x00));

interface SpecFile {
  name: string;
  type: string;
  bytes: Uint8Array;
}

/** 等应用挂载（TopBar 就绪；t-open-with waitAppMounted 同款） */
async function waitAppMounted(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('.vv-topbar')).toBeVisible();
}

/** 页面内构造 File 经 __vvOpenDirImpl 注入目录（b-media-office-viewer openDir 同款） */
async function openDir(page: Page, files: SpecFile[]): Promise<void> {
  await page.waitForFunction(
    () => typeof (window as unknown as { __vvOpenDirImpl?: unknown }).__vvOpenDirImpl === 'function'
  );
  await page.evaluate((list) => {
    const fs = list.map(({ name, type, bytes }) => {
      const f = new File([bytes as unknown as BlobPart], name, { type });
      Object.defineProperty(f, 'webkitRelativePath', { value: `bowx/${name}` });
      return f;
    });
    return (window as unknown as { __vvOpenDirImpl: (f: File[]) => void }).__vvOpenDirImpl(fs);
  }, files);
}

/** 树行点击开文件（窄视口经 drawer.ts 开合左抽屉；b-media openFile 同款） */
async function openFile(page: Page, name: string): Promise<void> {
  const drawer = await openDrawerIfNarrow(page);
  await page.locator('.vv-tree-row', { hasText: name }).click();
  await closeDrawerIfOpened(page, drawer);
  await expect(page.locator('.vv-tab.active', { hasText: name })).toBeVisible();
}

/** ≤600px 断点右栏（MetaPanel）收进抽屉（t-open-with openRightIfNarrow 同款） */
async function openRightIfNarrow(page: Page): Promise<boolean> {
  const narrow = await page.evaluate(() => window.innerWidth <= 600);
  if (!narrow) return false;
  await page.locator('.vv-right-toggle').click();
  return true;
}

/** 等错误卡片出现并核对 meta（文件名）与 detail（错误信息），返回卡片 locator */
async function expectErrorCard(page: Page, name: string, detail: string): Promise<Locator> {
  const card = page.locator('.vv-error-card');
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(card.locator('.vv-error-meta')).toContainText(name);
  await expect(card.locator('.vv-error-detail')).toContainText(detail);
  return card;
}

// ── 远端通道装置（OWX-04/05/06）：mini 假服务器 + 快照预置恢复（BUG-69 同款） ──

interface FileReadRecord {
  t: number;
  range: string | null;
  status: number;
}

/**
 * mini vviewer 文件服务器（t-open-with BUG-69 端点集同款）：/api/file 支持
 * Range: bytes=start-end（end 含 → 206 区间 + Content-Range）、无 Range → 200 全量、
 * failFile() 可注入 500（open-as 重入读失败的被测面）；全响应 ACAO:*（4173 页面源跨源）。
 * requests 记录每次 /api/file 的 Range 头/状态/时刻，供 OWX-05 计量。
 */
async function startFakeVVServer(
  fileName: string,
  bytes: Uint8Array
): Promise<{
  base: string;
  requests: FileReadRecord[];
  failFile(): void;
  okFile(): void;
  close(): Promise<void>;
}> {
  const requests: FileReadRecord[] = [];
  let fail = false;
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
      res.end(JSON.stringify({ entries: [{ name: fileName, kind: 'file', size: bytes.length }] }));
      return;
    }
    if (url.pathname === '/api/file') {
      const range = req.headers.range ?? null;
      if (fail) {
        requests.push({ t: Date.now(), range, status: 500 });
        res.writeHead(500, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'e2e 注入故障' }));
        return;
      }
      const m = range !== null ? /bytes=(\d+)-(\d*)/.exec(range) : null;
      if (m !== null) {
        const start = Math.min(Number(m[1]), Math.max(bytes.length - 1, 0));
        const end = Math.min(
          m[2] !== undefined && m[2] !== '' ? Number(m[2]) : bytes.length - 1,
          bytes.length - 1
        );
        const chunk = bytes.subarray(start, end + 1);
        requests.push({ t: Date.now(), range, status: 206 });
        res.writeHead(206, {
          ...cors,
          'Content-Type': 'application/octet-stream',
          'Content-Range': `bytes ${start}-${end}/${bytes.length}`,
          'Content-Length': String(chunk.length)
        });
        res.end(chunk);
        return;
      }
      requests.push({ t: Date.now(), range: null, status: 200 });
      res.writeHead(200, {
        ...cors,
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(bytes.length)
      });
      res.end(bytes);
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
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    requests,
    failFile: () => {
      fail = true;
    },
    okFile: () => {
      fail = false;
    },
    close: async () => {
      server.close();
      server.closeAllConnections(); // /api/events 长连接不 end：close() 需配套断连
    }
  };
}

/**
 * 预置远端恢复现场（t-open-with BUG-69 同款）：sessionStorage last-server（base 精确
 * 匹配 storeBase 才重连）+ IDB 旧键 'tabs' 快照 → reload 触发迁移恢复。目录条目
 * （path===''）必须存在：migrateLegacyTabs 只从目录条目派生 remote 来源，缺则 tab 落
 * 占位无内容。文件条目携 size（TabSnapshot.size 恢复链回填 source.size，OWX-05 的
 * 读策略/hex 窗口模式依赖）。不写 overrideRenderer——「open-as 临时查看不落 override」
 * 是本域被测面。
 */
async function seedRemoteTab(page: Page, opts: { base: string; path: string; size: number }): Promise<void> {
  const remoteId = `remote:${hash8(`${opts.base}:e2e-fake`)}`;
  const baseTab = {
    storeId: remoteId,
    storeLabel: 'e2e-fake',
    storeBase: opts.base,
    kind: 'rename-only' as const,
    scrollTop: 0
  };
  await page.evaluate(
    (seed) =>
      new Promise<void>((resolve, reject) => {
        sessionStorage.setItem('vviewer-last-server', JSON.stringify({ baseUrl: seed.base, token: null }));
        const open = indexedDB.open('vviewer', 2);
        open.onupgradeneeded = () => {
          if (!open.result.objectStoreNames.contains('kv')) open.result.createObjectStore('kv');
        };
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction('kv', 'readwrite');
          tx.objectStore('kv').put(
            [
              { ...seed.baseTab, id: 't0', path: '', name: 'e2e-fake', active: false },
              { ...seed.baseTab, id: 't1', path: seed.path, name: seed.path, active: true, size: seed.size }
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
    { base: opts.base, baseTab, path: opts.path, size: opts.size }
  );
}

/** 等 'workspaces' 快照（v2）出现指定 tab（OPEN-03:171-204 IDB 轮询先例；持久化异步） */
async function waitForWorkspaceTab(page: Page, name: string): Promise<void> {
  await page.waitForFunction(
    (tabName) =>
      new Promise<boolean>((resolve) => {
        const open = indexedDB.open('vviewer', 2);
        open.onsuccess = () => {
          const db = open.result;
          try {
            const get = db.transaction('kv', 'readonly').objectStore('kv').get('workspaces');
            get.onsuccess = () => {
              const snap = get.result as { workspaces?: { tabs?: { name?: string }[] }[] } | undefined;
              const tabs = Array.isArray(snap?.workspaces)
                ? snap.workspaces.flatMap((w) => w.tabs ?? [])
                : [];
              resolve(tabs.some((t) => t.name === tabName));
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
    name,
    { polling: 50 }
  );
}

/** 读快照中指定 tab 的 overrideRenderer（undefined = 未落 override，open-as 临时查看语义） */
async function readTabOverride(page: Page, name: string): Promise<string | undefined> {
  return page.evaluate(
    (tabName) =>
      new Promise<string | undefined>((resolve) => {
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
              resolve(tabs.find((t) => t.name === tabName)?.overrideRenderer);
              db.close();
            };
            get.onerror = () => {
              resolve(undefined);
              db.close();
            };
          } catch {
            resolve(undefined);
            db.close();
          }
        };
        open.onerror = () => resolve(undefined);
      }),
    name
  );
}

// ── OWX-01：内构链点击（截断 mp4 → 以 hex 打开） ──

test('OWX-01：截断 mp4 卡片点「以 hex 打开」→ hex 上位渲染原字节、原卡片级联替换', async ({ page }) => {
  test.setTimeout(60_000);
  await waitAppMounted(page);
  await openDir(page, [{ name: 'broken.mp4', type: 'video/mp4', bytes: BROKEN_MP4 }]);
  await openFile(page, 'broken.mp4');
  const card = await expectErrorCard(page, 'broken.mp4', '无法播放此媒体');
  // av 内构卡片（软失败链）按钮集合：MEDIA-11 存在性口径，此处升级为点击
  await expect(card.locator('.vv-error-action')).toHaveCount(2);
  await expect(card.locator('.vv-error-action').nth(0)).toHaveText('重试');
  await expect(card.locator('.vv-error-action').nth(1)).toHaveText('以 hex 打开');
  await card.locator('.vv-error-action').nth(1).click();
  // hex 上位（直调 hex.render，300B 全量形态）：行渲染 + 状态行结构解析文案（300B 无 moov
  // → struct 无识别 → 「未知二进制」；formatSize(300) = "300 B"）
  await expect(page.locator('.vv-hex')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.vv-hex-row').first()).toBeVisible();
  await expect(page.locator('.vv-hex-status')).toContainText('300 B');
  await expect(page.locator('.vv-hex-status')).toContainText('未知二进制');
  // 原卡片被替换无残留（takeOver 级联托管：无双实例、无卡片残留、黑屏播放器不回流）
  await expect(page.locator('.vv-error-card')).toHaveCount(0);
  await expect(page.locator('.vv-hex')).toHaveCount(1);
  await expect(page.locator('.vv-artplayer')).toHaveCount(0);
});

// ── OWX-02：dispatcher 链点击（损坏 SVG → 以纯文本打开，动态排序） ──

test('OWX-02：损坏 SVG 卡片「以纯文本打开」→ code 文本形态上位（探测按钮动态排序）', async ({ page }) => {
  test.setTimeout(60_000);
  await waitAppMounted(page);
  await openDir(page, [{ name: 'broken.svg', type: 'image/svg+xml', bytes: BROKEN_SVG_SMALL }]);
  await openFile(page, 'broken.svg');
  const card = await expectErrorCard(page, 'broken.svg', 'SVG 解析失败');
  // dispatcher 级卡片（render 抛错 → buildRenderErrorActions）：looksTextual 判文本 → 纯文本排前
  await expect(card.locator('.vv-error-action')).toHaveCount(3);
  await expect(card.locator('.vv-error-action').nth(0)).toHaveText('重试');
  await expect(card.locator('.vv-error-action').nth(1)).toHaveText('以纯文本打开');
  await expect(card.locator('.vv-error-action').nth(2)).toHaveText('以 hex 打开');
  // openAsAction 重入 dispatch（rendererOverride:'code'，跳过探测链）→ code 文本形态上位
  await card.locator('.vv-error-action').nth(1).click();
  await expect(page.locator('.vv-code-pre')).toBeVisible({ timeout: 20_000 });
  // 原始字节的可读投影（renderCode 非致命解码；ASCII 样本应原样可读）
  await expect(page.locator('.vv-code-pre')).toContainText('svg xmlns');
  await expect(page.locator('.vv-error-card')).toHaveCount(0);
});

// ── OWX-03：open-as 后 MetaPanel 维持「自动」+ 快照无 overrideRenderer ──

test('OWX-03：open-as 成功后 MetaPanel openWith 维持「自动」、快照无 overrideRenderer', async ({ page }) => {
  test.setTimeout(60_000);
  await waitAppMounted(page);
  await openDir(page, [{ name: 'broken.mp4', type: 'video/mp4', bytes: BROKEN_MP4 }]);
  await openFile(page, 'broken.mp4');
  const card = await expectErrorCard(page, 'broken.mp4', '无法播放此媒体');
  await card.locator('.vv-error-action', { hasText: '以 hex 打开' }).click();
  await expect(page.locator('.vv-hex')).toBeVisible({ timeout: 20_000 });
  // 右栏（窄视口在抽屉里）：openWith 维持「自动」——open-as 在卡片内部重派 dispatch、
  // 不经 setRendererOverride（ViewerPane.svelte:245-255 注释承诺；OPEN-03 手选后
  // value='hex'+「（手动）」标记为其对照面）
  await openRightIfNarrow(page);
  const openWith = page.locator('.meta-openwith');
  await expect(openWith).toBeVisible();
  await expect(openWith).toHaveValue('');
  await expect(page.locator('.meta-openwith-manual')).toHaveCount(0);
  // 快照无 overrideRenderer：否定断言——hex 上位后静置再读（persist 异步，防写入延迟误判）
  await page.waitForTimeout(1_000);
  await waitForWorkspaceTab(page, 'broken.mp4');
  expect(await readTabOverride(page, 'broken.mp4')).toBeUndefined();
});

// ── OWX-04：远端重入读失败 → .catch 保留卡片可再 open-as（e183735） ──

test('OWX-04：远端「以 hex 打开」重入读失败 → .catch 保留卡片、可再次 open-as（e183735）', async ({ page }) => {
  test.setTimeout(90_000);
  const file = { name: 'broken.svg', bytes: BROKEN_SVG_SMALL };
  const srv = await startFakeVVServer(file.name, file.bytes);
  const pageErrors: unknown[] = [];
  page.on('pageerror', (e) => pageErrors.push(e));
  let reentryLogged = false;
  page.on('console', (msg) => {
    if (msg.type() === 'error' && msg.text().includes('open-as 重入失败')) reentryLogged = true;
  });
  try {
    await waitAppMounted(page);
    await seedRemoteTab(page, { base: srv.base, path: file.name, size: file.bytes.length });
    await page.reload();
    await expect(page.locator('.vv-tab', { hasText: file.name })).toBeVisible({ timeout: 15_000 });
    const card = await expectErrorCard(page, file.name, 'SVG 解析失败');
    await expect(card.locator('.vv-error-action')).toHaveCount(3);

    // ① /api/file 注入 500 → openAsAction 重入 dispatch 的全量读失败 → .catch 保留原卡片
    srv.failFile();
    await card.locator('.vv-error-action', { hasText: '以 hex 打开' }).click();
    await expect.poll(() => reentryLogged, { timeout: 10_000 }).toBe(true); // .catch console.error 落日志
    await expect(page.locator('.vv-error-card')).toHaveCount(1); // 不白屏：原卡片仍在
    const kept = page.locator('.vv-error-card');
    await expect(kept.locator('.vv-error-detail')).toContainText('SVG 解析失败'); // 原样保留
    await expect(kept.locator('.vv-error-action')).toHaveCount(3); // 动作组完整（用户可改选其他方式）
    await expect(page.locator('.vv-hex')).toHaveCount(0); // 未上位
    expect(pageErrors, '重入失败走 .catch，不应有未捕获异常').toEqual([]);

    // ② 解除故障 → 同一按钮再次 open-as 成功（重入链可重复使用，无 once 污染）
    srv.okFile();
    await kept.locator('.vv-error-action', { hasText: '以 hex 打开' }).click();
    await expect(page.locator('.vv-hex')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('.vv-hex-status')).toContainText('128 B');
    await expect(page.locator('.vv-error-card')).toHaveCount(0);
  } finally {
    await srv.close();
  }
});

// ── OWX-05：远端 1.5MB hex 窗口流式 Range 计量 ──

test('OWX-05：远端 1.5MB「以 hex 打开」→ hex 窗口流式 Range 计量（无全量 200）', async ({ page }) => {
  test.setTimeout(90_000);
  const file = { name: 'broken.svg', bytes: BROKEN_SVG_BIG };
  const srv = await startFakeVVServer(file.name, file.bytes);
  const requests: FileReadRecord[] = [];
  page.on('response', (r) => {
    if (new URL(r.url()).pathname === '/api/file') {
      requests.push({
        t: Date.now(),
        range: r.request().headers()['range'] ?? null,
        status: r.status()
      });
    }
  });
  try {
    await waitAppMounted(page);
    await seedRemoteTab(page, { base: srv.base, path: file.name, size: file.bytes.length });
    await page.reload();
    await expect(page.locator('.vv-tab', { hasText: file.name })).toBeVisible({ timeout: 15_000 });
    // 恢复期 image 渲染器非 streaming → dispatch 全量读（语义内行为，计量只看点击之后）
    const card = await expectErrorCard(page, file.name, 'SVG 解析失败');
    // dispatcher 级 open-as hex：redisplay 走 null+read 流式读，size>1MB → head 探测 + hex 窗口模式
    const clickT = Date.now();
    await card.locator('.vv-error-action', { hasText: '以 hex 打开' }).click();
    await expect(page.locator('.vv-hex')).toBeVisible({ timeout: 20_000 });
    const sizeText = `${(file.bytes.length / (1024 * 1024)).toFixed(1)} MB`;
    await expect(page.locator('.vv-hex-status')).toContainText(sizeText); // 总字节数来自 ctx.size（非全量 buffer）
    // 滚到底：可视行落在探测头（8KB）覆盖面之外 → 占位行 + ensure 块读 + 重渲
    await page.locator('.vv-hex-dump').evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    // 计量①：点击后出现 start>8192 的 Range 块读（结构尾窗/滚动窗块，非探测头覆盖面）
    await expect.poll(
      () =>
        requests.filter((r) => {
          if (r.t <= clickT || r.range === null) return false;
          return Number(/bytes=(\d+)-/.exec(r.range)?.[1] ?? 0) > 8192;
        }).length,
      { timeout: 15_000 }
    ).toBeGreaterThan(0);
    // 计量②：hex 阶段零 Range-less 全量读、全部 206（「逐 Range 请求、无全量 200」锚）
    await page.waitForTimeout(1_000); // 安静窗：确认无迟到的全量读
    const afterClick = requests.filter((r) => r.t > clickT);
    expect(afterClick.length, 'hex 阶段应有流式块读').toBeGreaterThan(0);
    expect(afterClick.filter((r) => r.range === null), 'hex 阶段不应有全量 200').toEqual([]);
    expect(afterClick.every((r) => r.status === 206), 'hex 阶段读应全部命中 Range 206').toBe(true);
  } finally {
    await srv.close();
  }
});

// ── OWX-06：open-as 临时查看不落快照 → 刷新回原路由形态 ──

test('OWX-06：open-as 临时查看不落快照——刷新恢复回原路由形态（av 错误卡片复现）', async ({ page }) => {
  test.setTimeout(90_000);
  const file = { name: 'broken.mp4', bytes: BROKEN_MP4 };
  const srv = await startFakeVVServer(file.name, file.bytes);
  try {
    await waitAppMounted(page);
    await seedRemoteTab(page, { base: srv.base, path: file.name, size: file.bytes.length });
    await page.reload();
    await expect(page.locator('.vv-tab', { hasText: file.name })).toBeVisible({ timeout: 15_000 });
    // ① av 路由 → 内构卡片 → open-as hex 上位（临时查看）
    const card = await expectErrorCard(page, file.name, '无法播放此媒体');
    await card.locator('.vv-error-action', { hasText: '以 hex 打开' }).click();
    await expect(page.locator('.vv-hex')).toBeVisible({ timeout: 20_000 });
    // ② 快照无 overrideRenderer（静置防持久化延迟误判；OPEN-03 手选链此处为 'hex'）
    await page.waitForTimeout(1_000);
    await waitForWorkspaceTab(page, file.name);
    expect(await readTabOverride(page, file.name)).toBeUndefined();
    // ③ 刷新 → 回原路由形态：仍按扩展名 av → 错误卡片复现且非 hex（BUG-69 快照透传
    // override 后恢复 hex 为其对照面；本地注入内容不跨刷新，须远端通道才能验证）
    await page.reload();
    await expect(page.locator('.vv-tab', { hasText: file.name })).toBeVisible({ timeout: 15_000 });
    await expectErrorCard(page, file.name, '无法播放此媒体');
    await expect(page.locator('.vv-hex')).toHaveCount(0);
  } finally {
    await srv.close();
  }
});

// ── OWX-07：重试与 open-as 互斥替换（takeOver 托管无泄漏） ──

test('OWX-07：「重试」与 open-as 互斥替换——takeOver 托管无泄漏、无未捕获错误', async ({ page }) => {
  test.setTimeout(90_000);
  const pageErrors: unknown[] = [];
  page.on('pageerror', (e) => pageErrors.push(e));
  await waitAppMounted(page);
  await openDir(page, [
    { name: 'broken.svg', type: 'image/svg+xml', bytes: BROKEN_SVG_SMALL },
    { name: 'broken.mp4', type: 'video/mp4', bytes: BROKEN_MP4 }
  ]);

  // ① dispatcher 级卡片重试：render 再抛错 → 卡片原位重建（动作组完整，无双卡片）
  await openFile(page, 'broken.svg');
  let card = await expectErrorCard(page, 'broken.svg', 'SVG 解析失败');
  await card.locator('.vv-error-action', { hasText: '重试' }).click();
  await expect(page.locator('.vv-error-card')).toHaveCount(1);
  card = page.locator('.vv-error-card'); // 重建后的新卡片元素
  await expect(card.locator('.vv-error-detail')).toContainText('SVG 解析失败');
  await expect(card.locator('.vv-error-action')).toHaveCount(3);

  // ② 重试后再 open-as：互斥替换（卡片实例让位 code 实例，无残留双视图）
  await card.locator('.vv-error-action', { hasText: '以纯文本打开' }).click();
  await expect(page.locator('.vv-code-pre')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.vv-error-card')).toHaveCount(0);
  await expect(page.locator('.vv-code-pre')).toHaveCount(1);

  // ③ av 内构卡片重试：软失败重渲染 → 新卡片替换旧卡片（同样互斥；先 svg 后 mp4、
  // 开完不再切换，规避 MEDIA-11 头注的 av 销毁期伪 error 干扰节奏）
  await openFile(page, 'broken.mp4');
  const mp4Card = await expectErrorCard(page, 'broken.mp4', '无法播放此媒体');
  await mp4Card.locator('.vv-error-action', { hasText: '重试' }).click();
  await expect(page.locator('.vv-error-card')).toHaveCount(1);
  await expect(page.locator('.vv-error-card').locator('.vv-error-detail')).toContainText('无法播放此媒体');
  await expect(page.locator('.vv-error-card').locator('.vv-error-action')).toHaveCount(2);
  await expect(page.locator('.vv-artplayer')).toHaveCount(0); // 黑屏播放器不回流

  expect(pageErrors, '重试/open-as 连续操作无未捕获异常').toEqual([]);
});

// ── OWX-08：移动断点按钮可达可点（mobile project 375×667 天然执行） ──

test('OWX-08：移动断点（375px）错误卡片按钮可达可点——入口 A 不依赖抽屉', async ({ page }) => {
  test.setTimeout(60_000);
  await waitAppMounted(page);
  await openDir(page, [{ name: 'broken.mp4', type: 'video/mp4', bytes: BROKEN_MP4 }]);
  await openFile(page, 'broken.mp4'); // 窄视口：树行点击经 drawer.ts 开合左抽屉（b-media 同款）
  const card = await expectErrorCard(page, 'broken.mp4', '无法播放此媒体');
  // 右栏抽屉保持闭合：直接点「以 hex 打开」——spec §3「移动端右栏为抽屉，入口 A 为主要
  // 触达路径」：点击不被抽屉遮挡、hex 上位可见。桌面 project 走同一路径（无 skip 项）
  await card.locator('.vv-error-action', { hasText: '以 hex 打开' }).click();
  await expect(page.locator('.vv-hex')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.vv-hex-row').first()).toBeVisible();
  // 右栏（移动断点在抽屉里）可达：openWith 维持「自动」（OWX-03 的移动断点复核）
  await openRightIfNarrow(page);
  await expect(page.locator('.meta-openwith')).toBeVisible();
  await expect(page.locator('.meta-openwith')).toHaveValue('');
});

// ── OWX-09：dispatcher 链排序锚（二进制图片 → hex 排前，与 OWX-02 纯文本排前成双向） ──

test('OWX-09：损坏二进制图片卡片动作「以 hex 打开」排前（looksTextual 判非文本）', async ({ page }) => {
  test.setTimeout(60_000);
  await waitAppMounted(page);
  await openDir(page, [{ name: 'broken-binary.jpg', type: 'image/jpeg', bytes: BROKEN_JPG }]);
  await openFile(page, 'broken-binary.jpg');
  // 解码失败 throw → dispatcher 级卡片（BUG-53 修复解锁的本分支 e2e 锚；t-media BUG-53 同载体）
  const card = await expectErrorCard(page, 'broken-binary.jpg', '图片解码失败');
  // dispatcher 约定：重试恒首（排序只作用于 open-as 组内，t-media BUG-53 同款）
  await expect(card.locator('.vv-error-action')).toHaveCount(3);
  await expect(card.locator('.vv-error-action').nth(0)).toHaveText('重试');
  await expect(card.locator('.vv-error-action').nth(1), '判非文本 → 「以 hex 打开」排「以纯文本打开」前（排序锚）').toHaveText(
    '以 hex 打开'
  );
  await expect(card.locator('.vv-error-action').nth(2)).toHaveText('以纯文本打开');
});
