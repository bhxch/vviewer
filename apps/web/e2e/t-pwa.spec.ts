import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect, type CDPSession, type Page } from '@playwright/test';
import { closeDrawerIfOpened, openDrawerIfNarrow } from './drawer';

/**
 * pwa-mobile-performance 域覆盖缺口补强（t- 前缀：本轮新增，不改既有文件）。
 * 缺口来源：docs/e2e/pwa-mobile-performance.md 第 2/3 节验收判据 vs 既有覆盖
 * （m7.spec.ts / fix-pwa.spec.ts / b-pwa-mobile-performance.spec.ts / e2e-server
 * b-server-regression.spec.ts）的弱断言面，补：
 * - PWA-01/2：验收「controller=true」显式断言 + precache 主判据（>10 条）。注：
 *   文档期望「precache 包含 manifest」为旧版实测——现构建契约 manifest 不入
 *   precache（vite.config.ts:148「图标与 wasm 资产走静态拷贝不进预缓存」、:153
 *   globPatterns 仅 js/css/woff2、:169 additionalManifestEntries 仅 index.html），
 *   实测值仅 console 观察记录，不作断言（避免把过时期望固化为反向断言）。
 * - PWA-02/2：BUG-15 验收「离线经地址栏重新导航可用」（离线 reload 本身
 *   fix-pwa.spec.ts:87 已覆盖，此处补同验收第 3 条的另一半）。
 * - PWA-02/3：BUG-15 验收「在线 reload 正常（基线）」回归护栏。
 * - PWA-03：BUG-06 验收 1「多语言打开 → .wasm 请求非零 + vv-grammars-* 缓存」
 *   （fix-pwa.spec.ts:107 仅单语言 rust，此处补 javascript+rust 双语言）。
 * - PWA-03/2：BUG-06 验收 2「断网后 fetch grammar/runtime wasm 命中运行时缓存，
 *   不再 Failed to fetch」——从缓存枚举实际条目逐个离线 fetch。
 * - PWA-03/3：BUG-06 验收 3「离线打开本地代码文件显示 tree-sitter」——同会话
 *   断网后打开第二个 rust 文件（worker 已装配，与文档复核裁决「离线 cold.rs
 *   tree-sitter ts=15」同口径）。边界记录：manifest.json 无 runtimeCaching 策略
 *   （vite.config.ts:170-207 三条策略均不匹配 json），queries 由 worker 端 fetch
 *   不经 SW（vite.config.ts:187-188）——跨会话（reload 后）离线装配不属本验收。
 * - PWA-06/2：BUG-26 验收 2 快滑惯性多轮采样——README §3.2 第 5 条 unconfirmed
 *   场景落探针；现状本 harness 虚拟滚动路径惯性恒 0（b-pwa-mobile-performance
 *   .spec.ts:14-16 记录，疑似虚拟滚动改造引入的触摸动量回归），硬断言必败，
 *   以 test.fixme 占位，人工复核定论后转正式断言。
 * - PWA-08/2：BUG-16 验收 1/2 按文档预算硬断言（hex 桌面<200ms/移动<500ms，
 *   文本桌面<300ms/移动<800ms），多轮采样取中位（域文档 §4.3 口径）；既有
 *   b-pwa PWA-08 断言放宽（<1000/<1500/<5000ms）防抖动，此处按修复后复测
 *   实测余量（桌面 35~50ms/移动 262~275ms）收紧。
 * - PWA-09/2：验收「打开到起播 <1s」按真实可起播口径收紧——readyState ≥
 *   HAVE_FUTURE_DATA(3)（ArtPlayer autoplay:false，packages/render-media/src/
 *   av.ts:63，currentTime 前进不适用；既有 b-pwa PWA-09 为 readyState≥1 + <5s）。
 * 通道同既有：纯前端 preview（无服务端，auto 策略落本地 tree-sitter worker），
 * 文件经 __vvOpenDirImpl 页内注入；移动触摸按域文档 §4.3 以 CDP dispatchTouchEvent。
 */
const MP4_B64 = readFileSync(fileURLToPath(new URL('../../../samples/m4/sample.mp4', import.meta.url))).toString('base64');

const RS_SRC_1 = 'fn main() {\n    let x = 42;\n    println!("hello {}", x);\n}\n';
const RS_SRC_2 = 'enum Color {\n    Red,\n    Green,\n}\n\nfn paint(c: Color) {}\n';
const JS_SRC = 'const vv = 1;\nfunction greet(name) {\n  return `hi ${name}`;\n}\n';

/** SW 首装激活/控制权交接窗口内 evaluate 折叠为 null 轮询重试（m7/fix-pwa 惯例） */
async function safeEval<T>(page: Page, fn: () => T | Promise<T>): Promise<T | null> {
  try {
    const v = await page.evaluate(fn);
    return (v ?? null) as T | null;
  } catch {
    return null;
  }
}

/** 等 SW activated、控制权交接完成（controller 在位）且 precache 填充（>10 条） */
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
      { timeout: 30_000, message: '等待 SW activated、controller 在位且 precache 填充' }
    )
    .toBeGreaterThan(10);
}

/** 读取 precache 条目 URL 路径列表（waitSwActivated 之后调用） */
async function readPrecachePaths(page: Page): Promise<string[]> {
  return (
    (await safeEval(page, async () => {
      const keys = await caches.keys();
      const name = keys.find((k) => k.startsWith('workbox-precache')) ?? '';
      const reqs = await (await caches.open(name)).keys();
      return reqs.map((r) => new URL(r.url).pathname);
    })) ?? []
  );
}

/** 枚举指定前缀运行时缓存（vv-grammars-*、vv-runtime-*）内的请求 URL */
async function cacheUrls(page: Page, prefix: string): Promise<string[]> {
  return page.evaluate(async (p) => {
    const out: string[] = [];
    for (const k of await caches.keys()) {
      if (!k.startsWith(p)) continue;
      for (const req of await (await caches.open(k)).keys()) out.push(req.url);
    }
    return out;
  }, prefix);
}

/** 页内构造 File 目录注入（__vvOpenDirImpl，同 t-bin/b-pwa 惯例） */
async function openTDir(
  page: Page,
  files: Array<{ name: string; type: string; bytes: Uint8Array | string }>
): Promise<void> {
  await page.waitForFunction(
    () => typeof (window as unknown as { __vvOpenDirImpl?: unknown }).__vvOpenDirImpl === 'function'
  );
  await page.evaluate((list) => {
    const fs = list.map(({ name, type, bytes }) => {
      const f = new File([bytes as unknown as BlobPart], name, { type });
      Object.defineProperty(f, 'webkitRelativePath', { value: `tpwa/${name}` });
      return f;
    });
    return (window as unknown as { __vvOpenDirImpl: (f: File[]) => void }).__vvOpenDirImpl(fs);
  }, files);
}

async function openFileViaTree(page: Page, name: string): Promise<void> {
  const drawer = await openDrawerIfNarrow(page);
  await page.locator('.vv-tree-row', { hasText: name }).click();
  await closeDrawerIfOpened(page, drawer);
  await expect(page.locator('.vv-tab.active', { hasText: name })).toBeVisible();
}

/** 打开文件并等本地 tree-sitter 主路径证据（状态栏引擎指示），返回 whether ok */
async function openAndWaitTreeSitter(page: Page, name: string): Promise<void> {
  await openFileViaTree(page, name);
  await expect(page.locator('.vv-statusbar')).toContainText('高亮: tree-sitter', { timeout: 20_000 });
}

/** 首帧探针（PWA-08 口径）：MutationObserver 首现 + 双 rAF，b-pwa 同款 */
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
  const ms = await page.evaluate(() => (window as unknown as { __vvPaintProbe?: Promise<number> }).__vvPaintProbe);
  expect(ms, '首帧探针超时（30s 内容未现）').toBeGreaterThanOrEqual(0);
  return ms as number;
}

/** 合法 WAV（1s 8kHz 16bit 静音），b-pwa 同款 */
function makeWav(): Buffer {
  const sampleRate = 8000;
  const data = Buffer.alloc(sampleRate * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  // 调用契约：values 非空（hexMs 5 元素/textMs 4 元素），mid 必在界内——
  // noUncheckedIndexedAccess 下以断言收窄
  return sorted.length % 2
    ? (sorted[mid] as number)
    : Math.round(((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2);
}

// ── PWA-01：SW 注册与 precache ────────────────────────────────────────────────

test('PWA-01/2: SW 控制权在位（controller=true）与 precache 主判据（条目>10、含 index.html）', async ({
  page
}) => {
  await page.goto('/');
  await waitSwActivated(page);

  // 验收判据：controller=true（m7.spec.ts 用 reg.active 间接覆盖，此处显式断言控制权）
  const controlled = await safeEval(page, () => navigator.serviceWorker.controller !== null);
  expect(controlled, 'SW 控制页面').toBe(true);

  // precache 主判据 + 内容契约：index.html 单一 html 来源（BUG-15 修复通道，
  // vite.config.ts:169）。manifest.webmanifest 不入 precache 为现构建契约（文件头
  // 注释），仅观察记录不固化反向断言：
  const precache = await readPrecachePaths(page);
  expect(precache.length, 'precache 条目 >10（文档主判据；报告实测 102 条）').toBeGreaterThan(10);
  expect(precache.some((p) => p === '/index.html' || p.endsWith('/index.html'))).toBe(true);
  const hasWebmanifest = precache.some((p) => p.endsWith('.webmanifest'));
  console.log(
    `[pwa01] precache 条目=${precache.length}，含 manifest.webmanifest=${hasWebmanifest}（现构建契约：false，文档「102 条含 manifest」为旧版实测）`
  );
});

// ── PWA-02：BUG-15 离线壳可用性（验收 3 的两条回归保护） ─────────────────────

test('PWA-02/2: 断网后经地址栏重新导航呈现完整应用壳（URL/origin 不变、controller 在位）', async ({
  page
}) => {
  test.setTimeout(60_000);
  await page.goto('/');
  await waitSwActivated(page);
  await page.context().setOffline(true);
  try {
    // 离线重新导航（地址栏回车等价：全新导航而非 reload）——BUG-15 复核中该路径
    // 修复前即可用，验收 3 要求保持
    await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 10_000 });
    expect(new URL(page.url()).pathname, 'location 保持本源（不落 chrome-error）').toBe('/');
    await expect(page.locator('.vv-brand')).toBeVisible({ timeout: 10_000 });
    const controlled = await safeEval(page, () => navigator.serviceWorker.controller !== null);
    expect(controlled).toBe(true);
    await expect(page.locator('header, .vv-topbar').first()).toBeVisible();
  } finally {
    await page.context().setOffline(false);
  }
});

test('PWA-02/3: 在线 reload 基线正常（BUG-15 验收 3 回归护栏）', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/');
  await waitSwActivated(page);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('.vv-brand')).toBeVisible({ timeout: 10_000 });
  const controlled = await safeEval(page, () => navigator.serviceWorker.controller !== null);
  expect(controlled, '在线 reload 后 SW 仍控制页面').toBe(true);
});

// ── PWA-03：BUG-06 grammar wasm 资产链（验收 1/2/3） ──────────────────────────

test('PWA-03: 在线打开多语言文件，grammar/runtime wasm 请求非零且 vv-grammars-* 缓存创建', async ({
  page
}) => {
  test.setTimeout(90_000);
  const wasmRequests: string[] = [];
  page.on('request', (r) => {
    if (r.url().endsWith('.wasm')) wasmRequests.push(r.url());
  });
  await page.goto('/');
  await openTDir(page, [
    { name: 'sample.js', type: 'text/javascript', bytes: JS_SRC },
    { name: 'sample.rs', type: 'text/plain', bytes: RS_SRC_1 }
  ]);
  await openAndWaitTreeSitter(page, 'sample.js');
  await openAndWaitTreeSitter(page, 'sample.rs');

  // 验收 1：不再零 .wasm 请求——runtime + 各语言 grammar wasm 真实发出
  expect(
    wasmRequests.some((u) => u.endsWith('/tree-sitter.wasm')),
    'runtime wasm 请求发出'
  ).toBe(true);
  expect(
    wasmRequests.some((u) => u.includes('/grammars/') && u.endsWith('/javascript.wasm')),
    'javascript grammar wasm 请求发出'
  ).toBe(true);
  expect(
    wasmRequests.some((u) => u.includes('/grammars/') && u.endsWith('/rust.wasm')),
    'rust grammar wasm 请求发出'
  ).toBe(true);

  // 验收 1：vv-grammars-* 运行时缓存创建且含两语言条目（预热线程为 fire-and-forget，轮询）
  await expect
    .poll(async () => (await cacheUrls(page, 'vv-grammars-')).length, {
      timeout: 20_000,
      message: '等待 vv-grammars-* 缓存填充两语言 grammar wasm'
    })
    .toBeGreaterThanOrEqual(2);
  expect((await cacheUrls(page, 'vv-runtime-')).length, 'vv-runtime-* 缓存含 runtime wasm').toBeGreaterThanOrEqual(1);
});

test('PWA-03/2: 断网后 fetch 已预热高亮 wasm 命中运行时缓存（不再 Failed to fetch）', async ({
  page
}) => {
  test.setTimeout(90_000);
  await page.goto('/');
  await openTDir(page, [{ name: 'sample.rs', type: 'text/plain', bytes: RS_SRC_1 }]);
  await openAndWaitTreeSitter(page, 'sample.rs');

  // 等预热线程把 runtime + grammar wasm 写入 CacheFirst（vv-queries-* 不依赖：
  // queries 由 worker 端 fetch 不经 SW，文件头边界注释）
  await expect
    .poll(async () => (await cacheUrls(page, 'vv-runtime-')).length, {
      timeout: 20_000,
      message: '等待 vv-runtime-* 缓存'
    })
    .toBeGreaterThanOrEqual(1);
  await expect
    .poll(async () => (await cacheUrls(page, 'vv-grammars-')).length, {
      timeout: 20_000,
      message: '等待 vv-grammars-* 缓存'
    })
    .toBeGreaterThanOrEqual(1);

  const warmUrls = [...(await cacheUrls(page, 'vv-runtime-')), ...(await cacheUrls(page, 'vv-grammars-'))];
  await page.context().setOffline(true);
  try {
    // 验收 2：离线逐个 fetch 已缓存资产——全部命中（修复前 8 个 wasm fetch 全部
    // Failed to fetch）；fetch 经页面 SW 的 CacheFirst 策略响应
    const results = await page.evaluate(async (list) => {
      return Promise.all(
        list.map(async (u) => {
          try {
            const r = await fetch(u);
            return { url: u, ok: r.ok, status: r.status };
          } catch (e) {
            return { url: u, ok: false, status: e instanceof Error ? e.message : String(e) };
          }
        })
      );
    }, warmUrls);
    expect(results.length, '至少覆盖 runtime + grammar 两类资产').toBeGreaterThanOrEqual(2);
    for (const r of results) {
      expect(r.ok, `离线 fetch ${r.url} 应命中缓存（实际 ${r.status}）`).toBe(true);
    }
  } finally {
    await page.context().setOffline(false);
  }
});

test('PWA-03/3: 同会话断网后打开本地 rust 文件走 tree-sitter 主路径（离线高亮承诺）', async ({
  page
}) => {
  test.setTimeout(90_000);
  await page.goto('/');
  await openTDir(page, [
    { name: 'sample.rs', type: 'text/plain', bytes: RS_SRC_1 },
    { name: 'cold.rs', type: 'text/plain', bytes: RS_SRC_2 }
  ]);
  // 在线装配：打开第一个 rust 文件，等主路径证据（worker 实例化 + grammar 就位）
  await openAndWaitTreeSitter(page, 'sample.rs');
  await expect(page.locator('.vv-code-pre span[class^="ts-keyword"]').first()).toBeVisible({
    timeout: 20_000
  });

  await page.context().setOffline(true);
  try {
    // 离线打开第二个 rust 文件（文档复核裁决「离线 cold.rs tree-sitter ts=15」同口径：
    // 同会话 worker 已装配）——状态栏非「hljs 兜底」、ts-* span > 0
    await openAndWaitTreeSitter(page, 'cold.rs');
    await expect(page.locator('.vv-code-pre span[class^="ts-keyword"]').first()).toBeVisible({
      timeout: 20_000
    });
    await expect(page.locator('.vv-statusbar')).not.toContainText('hljs 兜底');
  } finally {
    await page.context().setOffline(false);
  }
});

// ── PWA-06：BUG-26 触摸惯性（unconfirmed，README §3.2 第 5 条探针占位） ───────

test.fixme(
  'PWA-06/2: 快滑惯性多轮采样（5 轮中 ≥4 轮 touchend 后续滚 >100px，文档复核基准）',
  async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', '域场景为触摸仿真移动视口（mobile project）');
    test.setTimeout(120_000);

    /**
     * fixme 原因（现状必败）：本 harness 虚拟滚动代码路径 touchend 后惯性恒 0、
     * 非虚拟容器 0~1263px 不稳定（b-pwa-mobile-performance.spec.ts:14-16 实测记录），
     * 疑似 BUG-16 修复的虚拟滚动改造引入的触摸动量回归，待人工/真机复核定论；
     * 按 README §3.2 第 4/5 条以占位落法保留完整断言，复核证实后去 fixme 转正。
     */
    const LINE = 'const vv = 1; // c\n';
    await page.goto('/');
    await page.waitForFunction(
      () => typeof (window as unknown as { __vvOpenDirImpl?: unknown }).__vvOpenDirImpl === 'function'
    );
    await page.evaluate((line) => {
      const txt = new File([line.repeat(165000)], 'long-3mb.txt', { type: 'text/plain' });
      Object.defineProperty(txt, 'webkitRelativePath', { value: 'tpwa/long-3mb.txt' });
      return (window as unknown as { __vvOpenDirImpl: (f: File[]) => void }).__vvOpenDirImpl([txt]);
    }, LINE);
    const drawer = await openDrawerIfNarrow(page);
    await page.locator('.vv-tree-row', { hasText: 'long-3mb.txt' }).click();
    await closeDrawerIfOpened(page, drawer);
    const pre = page.locator('.vv-code-pre');
    await expect(page.locator('.vv-code-pre .vv-code-line').first()).toBeVisible({ timeout: 30_000 });

    const cdp: CDPSession = await page.context().newCDPSession(page);
    const scrollTop = () => pre.evaluate((el) => el.scrollTop);
    const touchSwipe = async (steps: number, stepDelayMs: number): Promise<void> => {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x: 187, y: 550, id: 1 }]
      });
      for (let i = 1; i <= steps; i++) {
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [{ x: 187, y: 550 - (480 * i) / steps, id: 1 }]
        });
        if (stepDelayMs > 0) await page.waitForTimeout(stepDelayMs);
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    };

    // 快滑 480px（12 步 × 40px、零步进延迟）× 5 轮：touchend 后 800ms 内续滚峰值
    // （文档 BUG-26 复核基准：5 次中 4 次衰减曲线续滚 ~250-280px）
    let inertialRounds = 0;
    for (let round = 1; round <= 5; round++) {
      await touchSwipe(12, 0);
      const s0 = await scrollTop();
      let peak = s0;
      for (let i = 0; i < 8; i++) {
        await page.waitForTimeout(100);
        peak = Math.max(peak, await scrollTop());
      }
      const coast = peak - s0;
      console.log(`[pwa06] 快滑第 ${round} 轮 touchend 后续滚: ${coast}px`);
      if (coast > 100) inertialRounds++;
    }
    expect(inertialRounds, '5 轮快滑中 ≥4 轮出现惯性续滚（>100px）').toBeGreaterThanOrEqual(4);
  }
);

// ── PWA-08：BUG-16 hex/文本首帧按文档预算（多轮中位口径） ─────────────────────

test('PWA-08/2: 首帧按验收预算多轮中位——hex 桌面<200ms/移动<500ms，文本桌面<300ms/移动<800ms', async ({
  page
}, testInfo) => {
  test.setTimeout(180_000);
  const isMobile = testInfo.project.name === 'mobile';
  await page.goto('/');
  const line = 'const vv = 1; // c\n';
  await openTDir(page, [
    { name: 'perf-1mb.bin', type: 'application/octet-stream', bytes: new Uint8Array(1 << 20) },
    { name: 'long-3mb.txt', type: 'text/plain', bytes: line.repeat(165000) }
  ]);
  await expect(page.locator('.vv-tree-row', { hasText: 'perf-1mb.bin' })).toBeVisible();

  // 严格交替点击两文件（每轮换文件天然重置 pane，域文档 §4.3 口径；不重复点击
  // 同一文件——探针对已存在 DOM 会立即返回 0ms 造成假达标），9 轮 = hex 5 + 文本 4
  const hexMs: number[] = [];
  const textMs: number[] = [];
  for (let i = 0; i < 9; i++) {
    const hexTurn = i % 2 === 0;
    if (hexTurn) {
      await installPaintProbe(page, '.vv-hex-row');
      const drawer = await openDrawerIfNarrow(page);
      await page.locator('.vv-tree-row', { hasText: 'perf-1mb.bin' }).click();
      await closeDrawerIfOpened(page, drawer);
      hexMs.push(await readProbe(page));
    } else {
      await installPaintProbe(page, '.vv-code-pre .vv-code-line');
      const drawer = await openDrawerIfNarrow(page);
      await page.locator('.vv-tree-row', { hasText: 'long-3mb.txt' }).click();
      await closeDrawerIfOpened(page, drawer);
      textMs.push(await readProbe(page));
    }
  }
  const hexMed = median(hexMs);
  const textMed = median(textMs);
  console.log(
    `[perf] hex 首帧中位 ${hexMed}ms（${hexMs.map(Math.round).join('/')}），文本首帧中位 ${textMed}ms（${textMs.map(Math.round).join('/')}）；预算 hex ${isMobile ? 500 : 200}/文本 ${isMobile ? 800 : 300}ms`
  );
  expect(hexMed, 'hex 首屏中位达验收预算（BUG-16 验收 1）').toBeLessThan(isMobile ? 500 : 200);
  expect(textMed, '3MB 文本首帧中位不退化（BUG-16 验收 2）').toBeLessThan(isMobile ? 800 : 300);

  // 验收 3 正确性抽查：首行偏移（字节级一致性主体在 fix-pwa BUG-16 末行偏移断言）
  await expect(page.locator('.vv-hex-row').first()).toContainText('00000000');
});

// ── PWA-09：媒体打开到起播（真实可起播口径） ─────────────────────────────────

test('PWA-09/2: mp4/wav 打开到可起播（readyState≥HAVE_FUTURE_DATA）<1s', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', '域场景为 375×667 移动视口（mobile project）');
  test.setTimeout(60_000);
  const wavB64 = makeWav().toString('base64');
  await page.goto('/');
  await page.waitForFunction(
    () => typeof (window as unknown as { __vvOpenDirImpl?: unknown }).__vvOpenDirImpl === 'function'
  );
  await page.evaluate(
    ({ b64, wav }) => {
      const mp4 = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const f1 = new File([mp4], 'sample.mp4', { type: 'video/mp4' });
      Object.defineProperty(f1, 'webkitRelativePath', { value: 'tpwa/sample.mp4' });
      const wavBytes = Uint8Array.from(atob(wav), (c) => c.charCodeAt(0));
      const f2 = new File([wavBytes], 'tone.wav', { type: 'audio/wav' });
      Object.defineProperty(f2, 'webkitRelativePath', { value: 'tpwa/tone.wav' });
      return (window as unknown as { __vvOpenDirImpl: (f: File[]) => void }).__vvOpenDirImpl([f1, f2]);
    },
    { b64: MP4_B64, wav: wavB64 }
  );

  // 「可起播」= HAVE_FUTURE_DATA(3)：当前播放位置有可用帧且可推进——autoplay:false
  // （packages/render-media/src/av.ts:63）下 currentTime 前进不适用，比既有
  // readyState≥1 口径更贴近验收「起播」语义
  const openAndPlayable = async (name: string, selector: string): Promise<number> => {
    const t0 = Date.now();
    const drawer = await openDrawerIfNarrow(page);
    await page.locator('.vv-tree-row', { hasText: name }).click();
    await closeDrawerIfOpened(page, drawer);
    const el = page.locator(selector);
    await expect(el).toBeVisible({ timeout: 20_000 });
    await expect
      .poll(() => el.evaluate((m) => (m as HTMLMediaElement).readyState), { timeout: 10_000 })
      .toBeGreaterThanOrEqual(3);
    return Date.now() - t0;
  };

  const mp4Ms = await openAndPlayable('sample.mp4', '.vv-artplayer video');
  console.log(`[perf] mp4 打开到可起播: ${mp4Ms}ms（验收 <1000ms）`);
  expect(mp4Ms, 'mp4 打开到可起播 <1s（验收判据）').toBeLessThan(1000);

  const wavMs = await openAndPlayable('tone.wav', 'audio.vv-av');
  console.log(`[perf] wav 打开到可起播: ${wavMs}ms（验收 <1000ms）`);
  expect(wavMs, 'wav 打开到可起播 <1s（验收判据）').toBeLessThan(1000);
});

// ── 探索复核确认缺陷回归占位（2026-10-10；发现于 PWA 与移动端域、根因属本域，
// README §3.2.1 一域一文件、§3.2.4 修复合入前 test.fixme 占位、修复 PR 转正）──

test.fixme(
  'BUG-58 [探索]: /grammars/manifest.json 不在任何 SW 缓存策略内——离线启动会话 grammar 三层资产全败，create() 单例固化全会话降级 hljs',
  async ({ page }) => {
    // 复核成立（medium；hljs 兜底保证功能可用、无崩溃/数据丢失，仅离线启动会话
    // 主代码查看引擎全会话不可用且无法恢复）。发现于本域、根因属 PWA（SW 缓存
    // 策略缺口；highlightClient 单例不重试是放大器）。根因链：manifest.json 不入
    // precache（vite.config.ts:153 globPatterns 仅 js/css/woff2；:169
    // additionalManifestEntries 仅 index.html），三条 runtimeCaching（:174/:189/:199）
    // 分别只匹配 grammars/*.wasm、tree-sitter.wasm、queries/，均不含 .json——离线
    // 启动（断网后经 SW 壳 reload 进入）会话中 manifest fetch 必败，grammar 资产
    // 三层（同源/服务端/CDN）全部加载失败（highlightClient.ts:229-238
    // layers.length===0 仅 console.error、grammars 空表），create() 单例失败不重试
    // （highlightClient.ts:46/:87-97），全会话本地 tree-sitter 静默降级 hljs——即使
    // rust.wasm/queries/*.scm/tree-sitter.wasm 此前已进 vv-*-运行时缓存。对照组
    // （同会话先在线后离线、不 reload）离线高亮正常 tree-sitter——该对照已由上方
    // PWA-03/3 既有断言承担护栏，缺陷仅在离线启动路径（t-pwa 文件头 PWA-03/3
    // 边界注释「跨会话离线装配不属本验收」正是本条缺陷化）。
    // 最小复现：cwd=apps/web，node .temp/explore-pwa/p3c-manifest-offline.mjs
    // （在线打开 rust 至 tree-sitter → CDP Network.clearBrowserCache 保留
    // CacheStorage + setOffline + reload → 离线注入 rust 打开 → 状态栏 hljs 兜底）。
    // 证据：独立复核脚本 apps/web/.temp/recheck-pwa-e1/recheck.mjs——A 组离线启动态
    // 捕获启动期两条 manifest.json ERR_INTERNET_DISCONNECTED + [error]「grammar 资产
    // 三层全部加载失败（同源/服务端/CDN），本地高亮将降级 hljs」，离线开 rust 状态栏
    // 「高亮: hljs 兜底」而三份运行时缓存经 caches API 复查仍完整；B 组先在线后离线
    // 不 reload 保持 tree-sitter。截图与结构化结果
    // /share/rw/repo/server/vviewer/.temp/e2e-artifacts/recheck-pwa-e1/。
    // 修复方向：manifest.json 纳入缓存通道（precache glob 补 .json 或 runtimeCaching
    // 加 /grammars/manifest.json 条目），并考虑 create() 失败可重试；修复后本用例转正。
    test.setTimeout(120_000);
    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    // 在线装配：打开 rust 至 tree-sitter，三层资产进 vv-grammars-/vv-runtime- 缓存
    await page.goto('/');
    await openTDir(page, [{ name: 'bug58-a.rs', type: 'text/plain', bytes: RS_SRC_1 }]);
    await openAndWaitTreeSitter(page, 'bug58-a.rs');
    await expect
      .poll(async () => (await cacheUrls(page, 'vv-runtime-')).length, {
        timeout: 20_000,
        message: '等待 vv-runtime-* 缓存'
      })
      .toBeGreaterThanOrEqual(1);
    await expect
      .poll(async () => (await cacheUrls(page, 'vv-grammars-')).length, {
        timeout: 20_000,
        message: '等待 vv-grammars-* 缓存'
      })
      .toBeGreaterThanOrEqual(1);

    // 离线启动：清 HTTP 缓存（保留 CacheStorage，复现确定化——manifest.json 无
    // Cache-Control，启发式新鲜度隔天过期同样命中）+ 断网 + reload；SW 壳经
    // precache 正常接管（BUG-15 通道），但 manifest.json 无任何缓存通道
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Network.clearBrowserCache');
    await page.context().setOffline(true);
    try {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(page.locator('.vv-brand')).toBeVisible({ timeout: 10_000 });

      // 离线注入同语言文件打开
      await openTDir(page, [{ name: 'bug58-b.rs', type: 'text/plain', bytes: RS_SRC_2 }]);
      // 修复判据 1：离线启动会话本地 tree-sitter 可用（缺陷态：「高亮: hljs 兜底 ·
      // 执行: 本地」，恢复联网前无法复原）
      await expect(page.locator('.vv-statusbar')).toContainText('高亮: tree-sitter', { timeout: 30_000 });
      await expect(page.locator('.vv-statusbar')).not.toContainText('hljs 兜底');
      // 修复判据 2：三层全败降级 error 不再出现（现状文案 highlightClient.ts:236-237）
      expect(consoleErrors.join('\n')).not.toContain('grammar 资产三层全部加载失败');
      // 护栏：运行时缓存仍在（缺陷态亦满足——证明降级非资产缺失而是 manifest
      // 通道缺失；修复后资产 + manifest 双通道齐备）
      expect((await cacheUrls(page, 'vv-grammars-')).length).toBeGreaterThanOrEqual(1);
    } finally {
      await page.context().setOffline(false);
    }
  }
);

test.fixme(
  'BUG-59 [探索]: libarchive.wasm 无任何 SW 缓存通道——离线打开 tar/tgz/xz/7z/rar 必然 20s 超时错误卡（zip JS 解包对照不受影响）',
  async ({ page }) => {
    // 复核成立（medium；失败模式优雅可恢复——错误卡片带重试/降级按钮，非静默非
    // 崩溃，online 功能完全正常）。发现于本域、根因属 PWA（SW 缓存策略缺
    // libarchive 路由；归档解析本身无缺陷——范围断言由 zip 对照护栏承担）。根因：
    // libarchive.wasm（约 1MB，实测 HTTP 200 / 1002547 bytes）既不在 precache
    // （vite.config.ts:153 globPatterns 不含 .wasm）也无 runtimeCaching 路由
    // （:170-207 仅 grammars/tree-sitter/queries 三条）——断网后 libarchive worker
    // 初始化取不到 wasm，OPEN_TIMEOUT_MS=20_000（packages/render-archive/src/
    // libarchiveStore.ts:89）超时弹错误卡片「打开压缩包超时（20s）：libarchive
    // worker 初始化失败或格式解析卡死」（:168-169）。tar/tgz/tbz2/xz/7z/rar 全走
    // 该 wasm 通道（libarchiveStore.ts:1-2），zip 为 JS 解包不受影响（离线对照
    // 解包成功）。
    // 最小复现：cwd=apps/web，node .temp/explore-pwa/p2-archive-offline.mjs
    // （在线打开 tar 确认 wasm 200 + 解包成功 → caches 枚举确认 wasm 不在任何缓存
    // → 清 HTTP 缓存 + setOffline → 注入同字节 tar 打开等 22s → 错误卡片）。
    // 证据：apps/web/.temp/pwa-review/repro-cand-pwa-e2.mjs（在线 200 + pane
    // 解包成功、2 缓存 140 条中 libarchive 相关仅 worker-bundle.js precache 条目、
    // 离线 20s 后错误卡片含重试/降级按钮、恢复在线对照再成功）；zip 离线对照
    // .temp/pwa-review/zip-control.mjs 解包成功；sw.js 静态核查（curl 下载 grep：
    // registerRoute 共 4 条、precache 零 .wasm）；截图 /tmp/pwa-review-e2/
    // r2-offline-tar.png。
    // 修复方向：为 /libarchive/.*\.wasm$/ 增加 CacheFirst 运行时路由（或入
    // precache）；修复后本用例转正。
    test.setTimeout(150_000);
    const tarBytes = new Uint8Array(
      readFileSync(fileURLToPath(new URL('../../../samples/m4/sample.tar', import.meta.url)))
    );
    const zipBytes = new Uint8Array(
      readFileSync(fileURLToPath(new URL('../../../samples/m4/sample.zip', import.meta.url)))
    );

    // 在线基线：libarchive.wasm 200 + tar 解包成功（清 HTTP 缓存使离线复现确定化，
    // 与真实「隔天启发式过期后离线」同效）
    await page.goto('/');
    await openTDir(page, [{ name: 'bug59.tar', type: 'application/x-tar', bytes: tarBytes }]);
    await openFileViaTree(page, 'bug59.tar');
    await expect(page.locator('.vv-archive .vv-tree-row').first()).toBeVisible({ timeout: 20_000 });

    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Network.clearBrowserCache');
    await page.context().setOffline(true);
    try {
      await openTDir(page, [
        { name: 'bug59-off.tar', type: 'application/x-tar', bytes: tarBytes },
        { name: 'bug59-off.zip', type: 'application/zip', bytes: zipBytes }
      ]);
      // 修复判据 1：离线 tar 解包成功（缺陷态：20s 超时后错误卡片「无法预览此
      // 文件 / 打开压缩包超时（20s）……」）
      await openFileViaTree(page, 'bug59-off.tar');
      await expect(page.locator('.vv-archive .vv-tree-row').first()).toBeVisible({ timeout: 30_000 });
      await expect(page.locator('.vv-error-card')).toHaveCount(0);
      // 护栏（范围断言）：zip JS 解包通道离线可用——缺陷态亦通过，证明缺陷仅
      // libarchive wasm 通道、非离线归档整体
      await openFileViaTree(page, 'bug59-off.zip');
      await expect(page.locator('.vv-archive .vv-tree-row').first()).toBeVisible({ timeout: 20_000 });
    } finally {
      await page.context().setOffline(false);
    }
  }
);

test.fixme(
  'BUG-60 [探索]: vv-* 运行时缓存 cacheName 拼 BUILD_REVISION——部署换版后旧 REV 缓存永久残留、随部署次数线性累积（cleanupOutdatedCaches 仅清 precache）',
  async ({ page }) => {
    // 复核成立（low；纯存储泄漏无功能影响）。发现于本域、根因属 PWA。根因：三个
    // runtime 缓存 cacheName 模板拼 BUILD_REVISION（vite.config.ts:177/:192/:202），
    // workbox cleanupOutdatedCaches 只清 workbox-precache-* 前缀（运行时实证三次
    // 版本后 precache 始终单份），ExpirationPlugin 的 maxEntries/purgeOnQuotaError
    // 只在当前 REV cacheName 内部逐出条目、不跨 cacheName 删除，sw.js 中无任何
    // caches.delete/caches.keys 调用（grep 零命中）——每次部署新版 SW 后旧 REV
    // 命名的 vv-* 缓存永久残留（实测两次部署累计残留 ≈2.5MB）。vite.config.ts:22-23
    // 注释「旧 CacheFirst 缓存（旧名）不再命中、随 expiration 清理」的「随
    // expiration 清理」与实现不符（「不再命中」部分正确）。
    // 实现说明：webServer（vite preview）产物目录不可在 spec 内改写（共享状态），
    // 以 node:fs 复制 build 产物到临时目录、sed 等价替换 sw.js 内 REV 字符串模拟
    // 部署换版，node:http 自起静态服务（evidence 同法验证：vviewer serve
    // --web-dist 改写副本）。前提：本地已有 pnpm build 产物（../build）。
    // 最小复现：cwd=apps/web，node .temp/explore-pwa/p4-update-flow.mjs 与
    // p4b-update-accumulate.mjs（v1→v2→v3，每次 reload 后读 caches.keys() 与
    // 字节数）。
    // 证据：apps/web/.temp/rc/verify.mjs——REV 0.1.0-hs0ec→0.1.1-rcv222→0.1.2-rcv333：
    // v2 后旧 0.1.0 两缓存原样残留+新增 0.1.1（页面 marker 证明 autoUpdate 新 SW
    // 已接管），v3 后 4 缓存全部残留（2×(201+1089)KB≈2.5MB），workbox-precache-v2
    // 全程单份；静态 grep apps/web/build/sw.js：三 REV 缓存名 + maxEntries:500/4/300
    // + purgeOnQuotaError:!0 + caches.delete 零命中。
    // 修复方向：activate 处枚举 caches.keys() 清理 vv-grammars-/vv-runtime-/vv-queries-
    // 前缀中非当前 REV 的缓存（或改单一 cacheName + 版本化 URL）；修复后本用例转正。
    test.setTimeout(180_000);
    const fsp = await import('node:fs/promises');
    const http = await import('node:http');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');

    const buildDir = fileURLToPath(new URL('../build', import.meta.url));
    const work = await fsp.mkdtemp(join(tmpdir(), 'vv-bug60-'));
    // ①复制 build（v1）并从 sw.js 提取当前 REV（cacheName 模板 vv-grammars-<REV>）
    await fsp.cp(buildDir, join(work, 'v1'), { recursive: true });
    const swPathOf = (v: string): string => join(work, v, 'sw.js');
    const swText1 = await fsp.readFile(swPathOf('v1'), 'utf8');
    const rev1 = swText1.match(/vv-grammars-([^'"`\\]+)/)?.[1];
    expect(rev1, 'sw.js 应含 vv-grammars-<BUILD_REVISION> 缓存名').toBeTruthy();
    const rev2 = `${rev1}-bug60v2`;
    // ②v2 部署副本：sw.js 内 REV 全量替换（三条 cacheName 及相关引用一次到位）
    await fsp.cp(join(work, 'v1'), join(work, 'v2'), { recursive: true });
    await fsp.writeFile(swPathOf('v2'), swText1.split(rev1 as string).join(rev2));

    // ③node:http 静态服务（MIME 覆盖 html/js/wasm/json/css；每次请求读盘——
    // 「部署」仅切目录指针）
    let serving = join(work, 'v1');
    const server = http.createServer(async (req, res) => {
      try {
        const u = new URL(req.url ?? '/', 'http://x');
        let p = decodeURIComponent(u.pathname);
        if (p === '/') p = '/index.html';
        const text = await fsp.readFile(join(serving, p));
        const mime = p.endsWith('.wasm')
          ? 'application/wasm'
          : p.endsWith('.js')
            ? 'application/javascript'
            : p.endsWith('.json')
              ? 'application/json'
              : p.endsWith('.css')
                ? 'text/css'
                : 'text/html';
        res.writeHead(200, { 'content-type': mime }).end(text);
      } catch {
        res.writeHead(404).end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      // ④v1 在线会话：打开 rust 触发 vv-* 运行时缓存
      await page.goto(base);
      await openTDir(page, [{ name: 'bug60.rs', type: 'text/plain', bytes: RS_SRC_1 }]);
      await openAndWaitTreeSitter(page, 'bug60.rs');
      await expect
        .poll(async () => (await cacheUrls(page, 'vv-grammars-')).length, {
          timeout: 20_000,
          message: '等待 vv-grammars-* 缓存'
        })
        .toBeGreaterThanOrEqual(1);

      // ⑤部署 v2：切目录指针 + reload（SW 更新检查取到新 sw.js，autoUpdate 接管）
      serving = join(work, 'v2');
      await page.reload({ waitUntil: 'domcontentloaded' });
      // 等新 REV SW 接管：反复 fetch 命中 CacheFirst 路由的资产直至 rev2 缓存出现
      // （旧 SW 接管期间写入/命中均为 rev1；rev2 出现即证明新 SW 已控制页面；
      // autoUpdate 触发的页面自动 reload 以循环内 try/catch 容忍）
      await expect
        .poll(
          async () => {
            try {
              await page.evaluate(() => fetch('/tree-sitter.wasm').catch(() => undefined));
              const keys = await page.evaluate(() => caches.keys());
              return keys.some((k) => k.startsWith(`vv-runtime-${rev2}`)) ? true : null;
            } catch {
              return null;
            }
          },
          { timeout: 60_000, message: '等待新 REV SW 接管并建立 rev2 运行时缓存' }
        )
        .toBe(true);

      // 修复判据：旧 rev1 的 vv-* 缓存已被清理（缺陷态：原样残留、逐版累积）
      const keys = await page.evaluate(() => caches.keys());
      const stale = keys.filter(
        (k) => /^(vv-grammars|vv-runtime|vv-queries)-/.test(k) && !k.endsWith(rev2)
      );
      expect(stale, `旧 REV 缓存应被清理（缺陷态残留：${stale.join(', ') || '无'}）`).toEqual([]);
      // 护栏：workbox-precache-* 始终单份（cleanupOutdatedCaches 正常工作面，不回归）
      const precacheNames = keys.filter((k) => k.startsWith('workbox-precache'));
      expect(precacheNames.length, 'precache 不随版本累积').toBeLessThanOrEqual(1);
    } finally {
      server.close();
      await fsp.rm(work, { recursive: true, force: true });
    }
  }
);

test.fixme(
  'BUG-61 [探索]: ≤900px 移动视口点击树文件后抽屉不自动收起——无遮罩、Escape 与点外关闭均无效，唯一途径再点 ☰',
  async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', '缺陷仅 ≤900px 移动视口（mobile project 375×667 实测）');
    // 复核成立（low；移动端 UX 缺口——文件正常打开、tab 与渲染均正常，仅抽屉
    // 300px 全宽继续遮挡主区需手动收起）。发现于本域。根因（静态）：onTreeOpen
    // 仅 addTab、无 drawerOpen=false（apps/web/src/lib/AppShell.svelte:207-209）；
    // 抽屉唯一开关是 ☰ 按钮 onclick 取反（:301）；≤900px 时 .vv-side
    // position:fixed width:min(80vw,300px)（:351-371），全组件样式无任何
    // overlay/backdrop 元素；全局键位（:232-271）仅 Ctrl+Shift+F/Ctrl+P/j/k/g/G、
    // 无 Escape 处理。
    // 最小复现：cwd=apps/web，node .temp/explore-pwa/p5-drawer.mjs（375×667+
    // isMobile+hasTouch：tap ☰ 开抽屉 → tap 树中 p1.txt → 读 .vv-side computed
    // transform=none；对照再 tap ☰ 恢复 matrix(1,0,0,1,-301,0)）。
    // 证据：apps/web/.temp/review-pwa-e4/repro.mjs——[drawer open] transform=none →
    // mask-like elements=0 → x=370 命中 DIV.vv-viewer-scroll（无可点遮罩）→ 文件
    // tap 后 transform 仍 none 且 tabbar 含 p1.txt → Esc 后 none → 点外后 none →
    // 仅 ☰ 后 matrix(1,0,0,1,-301,0)；截图 .temp/e2e-artifacts/review-pwa-e4/
    // r-after-file-tap.png（抽屉全宽盖主区）与 r-after-esc.png（Esc 后仍全开）。
    // 覆盖核对：docs/e2e/pwa-mobile-performance.md:32 PWA-05 验收仅「无横向溢出；
    // 抽屉开合正常」，既有 e2e/drawer.ts 模式为「开抽屉点击后手动关回」——「选中
    // 文件后自动收起」在源码承诺与 e2e 均未覆盖，确系新缺口。
    // 修复方向：onTreeOpen 内窄视口置 drawerOpen=false（可加遮罩/Esc 关闭）；
    // 修复后本用例转正。
    test.setTimeout(60_000);
    await page.goto('/');
    await openTDir(page, [{ name: 'bug61.txt', type: 'text/plain', bytes: 'hello drawer\n' }]);
    // 手动开抽屉（不经 openDrawerIfNarrow/closeDrawer 包装——缺陷交互正是
    // 「抽屉开着点文件不收」，与既有 drawer.ts 的手动关回模式区分）
    await page.locator('.vv-drawer-toggle').click();
    await expect(page.locator('.vv-side')).toHaveCSS('transform', 'none');
    // 点击树文件
    await page.locator('.vv-tree-row', { hasText: 'bug61.txt' }).click();
    // 护栏：文件照常打开（缺陷不影响功能，仅遮挡阅读）
    await expect(page.locator('.vv-tab.active', { hasText: 'bug61.txt' })).toBeVisible();
    // 修复判据 1：抽屉自动收起——transform 离开 none（恢复 translateX(-100%) 的
    // matrix(1,0,0,1,-301,0)；缺陷态保持 none）
    await expect(page.locator('.vv-side')).not.toHaveCSS('transform', 'none');
    // 修复判据 2：主区不再被遮挡——视口中心命中主滚动区（缺陷态中心被 300px 宽
    // 抽屉覆盖、命中 .vv-side 内元素）
    const centerHit = await page.evaluate(() => {
      const el = document.elementFromPoint(Math.round(window.innerWidth / 2), Math.round(window.innerHeight / 2));
      return el?.closest('.vv-viewer-scroll') != null;
    });
    expect(centerHit, '视口中心应命中主区（缺陷态被抽屉盖住）').toBe(true);
  }
);

test.fixme(
  'BUG-62 [探索]: 375px isMobile 视口「连接服务器」表单不折行——layout viewport 被撑宽到 465px，提交按钮屏外且页面无法横向滚动',
  async ({ page }, testInfo) => {
    test.skip(
      testInfo.project.name !== 'mobile',
      '缺陷仅 isMobile 仿真（Chrome Android layout viewport 撑宽行为）；桌面硬 375 窗口可横向滚动、click 自动滚入 3/3 可达'
    );
    // 复核成立（low；次要功能的响应式布局缺陷——地址框 Enter 提交可绕过，功能
    // 可达）。发现于本域。根因（静态）：.vv-server-form display:flex; gap:6px 无
    // flex-wrap（apps/web/src/app.css:229），地址输入固定 220px（:230）+ 令牌
    // 150px（:231）+ 提交按钮（TopBar.svelte:166-183 表单标记、:179 提交钮）——
    // 375px 视口下内容宽 465px 溢出；isMobile（Chrome Android 仿真）下 layout
    // viewport 被撑宽到 innerWidth=465（clientWidth=375，整页约缩小 20% 渲染），
    // 令牌框右缘 412.4 被裁、提交按钮 x=418.4 完全屏外；且页面无法横向滚动
    // （scrollTo/scrollLeft 无效、scrollX 恒 0——layout viewport 本身已被撑到
    // 465 无溢出可滚），按钮点击必超时（点击点被令牌 input/header 截获）。
    // 最小复现：cwd=apps/web，node .temp/explore-pwa/p5a-form.mjs（375×667+
    // isMobile：点「连接服务器」读表单几何与 innerWidth/scrollWidth + 截图）；
    // 对照：Playwright 非 isMobile 硬 375 下 click 3/3 稳定成功（该模式文档可横滚
    // 90px、click 自动滚入真实触发 submit）。
    // 证据：/tmp/cand-pwa-e5/repro.mjs 与 diag.mjs——A 场景（isMobile+Pixel7 UA）
    // innerWidth=465/scrollWidth=465/formWidth=453/地址 x=12 w=226.4/token
    // right=412.4/submitBtn x=418.4 right=465，scrollTo(9999,0) 后 scrollX 仍 0，
    // click 5s 超时 call log「input[type=password] intercepts pointer events」
    // 「header.vv-topbar intercepts pointer events」；B 场景（硬 375）click 3/3 ok
    // 且点击后出现「请输入服务器地址」校验错误证明 submit 真实触发；C 场景地址框
    // Enter 连接成功、树 17 行；截图 /tmp/cand-pwa-e5/A-isMobile-375.png、
    // B-hard375.png。iOS Safari 真机未验证（无真机）。
    // 修复方向：.vv-server-form 加 flex-wrap（或移动断点下输入改 100% 宽换行）；
    // 修复后本用例转正。
    test.setTimeout(60_000);
    await page.goto('/');
    await page.locator('header button', { hasText: '连接服务器' }).click();
    const form = page.locator('.vv-server-form');
    await expect(form).toBeVisible();
    // 修复判据 1（几何）：提交按钮完全在 375px 视口内（缺陷态 x=418.4、right=465，
    // isMobile layout viewport 撑宽致整页缩放渲染）
    const submit = form.locator('button[type="submit"]');
    const box = await submit.boundingBox();
    expect(box, '提交按钮应有布局位置').not.toBeNull();
    expect(box!.x, '提交按钮左缘应在视口内').toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width, '提交按钮右缘应 ≤ 375px 视口（缺陷态 465 屏外）').toBeLessThanOrEqual(375);
    // 修复判据 2（交互）：提交按钮真实可点（缺陷态 click 5s 超时——点击点被令牌
    // input/header 截获）；点后空表单触发必填校验（TopBar.svelte:137，同 evidence
    // B 场景口径，证明 submit 真实触发而非空点）
    await submit.click({ timeout: 5_000 });
    await expect(page.locator('.vv-server-error')).toContainText('请输入服务器地址');
  }
);

test.fixme(
  'BUG-63 [探索]: highlightClient.ts:161 注释承诺 window.__vvHighlightClient E2E 探测钩子但全仓库无赋值实现——悬空类型声明，通道实际不存在',
  async ({ page }) => {
    // 复核成立（low；注释与实现失实 + 调试通道缺失——现役 e2e/e2e-server 套件经
    // rg 全量核实未引用该钩子，无现役测试失败；误导后续按注释使用该钩子的 E2E
    // 作者）。发现于本域（PWA/移动端探索复核），根因文件 apps/web/src/lib/
    // highlightClient.ts（高亮链路入口挂载点，一域一文件按发现域落本文件）。根因：
    // :161 注释「原始实例经 window.__vvHighlightClient 暴露（E2E 语言可用性探测
    // 用）」，:109 HighlightDebug.__vvHighlightClient? 为悬空类型声明——
    // `rg -n '__vvHighlightClient' apps/web/src` 全仓库仅此两处、无任何赋值语句；
    // withDebug()（:163-221）仅写 __vvLastHighlightMs/Lang/Ok（:173-175），
    // create() 中原始 client 仅在 :258 经 attachHighlightClient(withDebug(client))
    // 注入渲染端，从未挂 window。运行时确认：真实触发高亮（__vvLastHighlightMs=97.1、
    // __vvLastHighlightLang="javascript"、__vvLastHighlightOk=true，即 withDebug.record
    // 确已执行）的同一 window 上 `__vvHighlightClient in window` 为 false、evaluate
    // 返回 undefined——排除懒加载/时序解释；对照钩子 __vvOpenDirImpl 同窗口为
    // function（证明探测方式有效）。另核实 4199/8391/8440 三实例各时点 hasClient
    // 均为 false。
    // 最小复现：①`rg -n '__vvHighlightClient' apps/web/src`（仅 :109 类型 + :161
    // 注释，无赋值）；②浏览器侧一次性 spec 注入后开文件触发高亮，evaluate
    // `window.__vvHighlightClient` 得 undefined（.temp 探测脚本 p1b-diag.mjs 口径
    // RAW CLIENT: {"hasClient": false}）。
    // 证据：现役 HL-10 同机 `npx playwright test e2e/t-hl.spec.ts -g 'HL-10:'
    // --project=chromium` 3.0s passed（产品高亮通道正常，与本缺陷无关）；缺陷态
    // 高亮真实发生而钩子缺失的实测值见上（withDebug.record 已执行为反证）。
    // 修复方向：create() 内把原始 client 挂到 window.__vvHighlightClient（与
    // :161 注释兑现），或删除该注释与 :109 悬空类型；修复后本用例转正。
    test.setTimeout(60_000);
    await page.goto('/');
    // 触发高亮装配真实发生（排除「withDebug 未执行才缺失」的时序解释——缺陷态下
    // record 已执行而钩子仍不在 window 上）
    await openTDir(page, [{ name: 'bug63.js', type: 'text/javascript', bytes: JS_SRC }]);
    await openAndWaitTreeSitter(page, 'bug63.js');

    // 护栏（对照）：同窗口既有 __vv 钩子可探测——证明 evaluate 方式本身有效
    // （缺陷态亦满足，evidence 口径：__vvOpenDirImpl 同窗口为 function）
    const openDirImpl = await page.evaluate(
      () => typeof (window as unknown as Record<string, unknown>).__vvOpenDirImpl
    );
    expect(openDirImpl, '对照钩子 __vvOpenDirImpl 应为 function').toBe('function');

    // 修复判据：window.__vvHighlightClient 已暴露（缺陷态：in window 为 false、
    // evaluate 得 undefined）；类型放宽 object|function——兑现注释「原始实例」
    // （client 对象）或调试包装（withDebug 返回对象）均可
    const hasClient = await page.evaluate(() => {
      const w = window as unknown as { __vvHighlightClient?: unknown };
      return w.__vvHighlightClient != null && (typeof w.__vvHighlightClient === 'object' || typeof w.__vvHighlightClient === 'function');
    });
    expect(hasClient, 'E2E 探测钩子 window.__vvHighlightClient 应存在（highlightClient.ts:161 注释承诺）').toBe(true);
  }
);
