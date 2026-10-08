import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect, type CDPSession, type Page } from '@playwright/test';
import { closeDrawerIfOpened, openDrawerIfNarrow } from './drawer';

/**
 * pwa-mobile-performance 域回归（docs/e2e/pwa-mobile-performance.md）。既有覆盖不重写：
 * PWA-01 SW/precache（m7）、BUG-15 离线 reload、BUG-06 本地主路径、BUG-16 hex 虚拟滚动
 * 结构断言（fix-pwa.spec.ts）。本文件补：
 * - PWA-08 / BUG-16：hex 首帧与文本首帧性能（口径：performance.now() → MutationObserver
 *   内容首现 → 双 rAF；预算 hex 桌面 <200ms/移动 <500ms，断言按指示放宽：桌面 <1000ms、
 *   移动 <1500ms 防 headless 容器抖动，同时仍低于缺陷态实测 1404~1781/1523~1738ms 基线）
 * - PWA-05：375×667 移动视口无横向溢出 + 12 层嵌套 blockquote 全渲染（mobile project）
 * - PWA-06：触摸滑动 1:1 驱动虚拟滚动 + 虚拟渲染受控（硬门）；快滑惯性按编排层裁决
 *   改为实测记录 + 非虚拟容器对照（本 harness 上虚拟滚动路径惯性恒 0、非虚拟容器
 *   0~1263px 不稳定，断言不可靠；疑似虚拟滚动改造引入的触摸动量回归，记录供人工复核）
 * - PWA-07：mp4 播放器挂载 + 全屏进入/退出（mobile project）
 * - PWA-09：mp4/wav 打开到起播就绪（预算 <1s，断言放宽 <5s 并记录实测）
 */

const LINE = 'const vv = 1; // c\n';

/** 1x1 无关占位（未用）；mp4 与既有 m4/mobile.spec 同源 */
const MP4_B64 = readFileSync(fileURLToPath(new URL('../../../samples/m4/sample.mp4', import.meta.url))).toString('base64');

/** 合法 WAV（1s 8kHz 16bit 静音）：PWA-09 音频起播载体 */
function makeWav(): Buffer {
  const sampleRate = 8000;
  const data = Buffer.alloc(sampleRate * 2); // 1s × 16bit
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/**
 * 首帧探针（PWA-08 口径）：MutationObserver 检测 selector 内容首现，双 rAF 后视为绘制终点。
 * 必须在触发点击前安装；返回 Promise 由后续 evaluate 消费（-1 = 30s 超时未现）。
 */
async function installPaintProbe(page: Page, selector: string): Promise<void> {
  await page.evaluate((selector) => {
    (window as unknown as Record<string, unknown>).__vvPaintProbe = new Promise<number>((resolve) => {
      const t0 = performance.now();
      if (document.querySelector(selector)) {
        resolve(0);
        return;
      }
      const mo = new MutationObserver(() => {
        if (document.querySelector(selector)) {
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

/** 域文档 4.2：perf-1mb.bin（1,048,576B）+ long-3mb.txt（≈3.1MB 文本对照）在页内构造 */
async function openPerfDir(page: Page): Promise<void> {
  await page.waitForFunction(
    () => typeof (window as unknown as { __vvOpenDirImpl?: unknown }).__vvOpenDirImpl === 'function'
  );
  await page.evaluate((line) => {
    const bytes = new Uint8Array(1 << 20);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i & 0xff;
    const bin = new File([bytes], 'perf-1mb.bin', { type: 'application/octet-stream' });
    Object.defineProperty(bin, 'webkitRelativePath', { value: 'bpwa/perf-1mb.bin' });
    const txt = new File([line.repeat(165000)], 'long-3mb.txt', { type: 'text/plain' });
    Object.defineProperty(txt, 'webkitRelativePath', { value: 'bpwa/long-3mb.txt' });
    return (window as unknown as { __vvOpenDirImpl: (f: File[]) => void }).__vvOpenDirImpl([bin, txt]);
  }, LINE);
}

test('PWA-08/BUG-16：1MB hex 首帧宽松预算（桌面 <1000ms / 移动 <1500ms），3MB 文本对照不劣化', async ({
  page
}, testInfo) => {
  test.setTimeout(120_000);
  const isMobile = testInfo.project.name === 'mobile';
  await page.goto('/');
  await openPerfDir(page);
  await expect(page.locator('.vv-tree-row', { hasText: 'perf-1mb.bin' })).toBeVisible();

  // ① 文本首帧对照（域文档：先点参照文件重置 pane，亦为 3MB 文本首帧测量）
  await installPaintProbe(page, '.vv-code-pre .vv-code-line');
  const drawer = await openDrawerIfNarrow(page);
  await page.locator('.vv-tree-row', { hasText: 'long-3mb.txt' }).click();
  await closeDrawerIfOpened(page, drawer);
  const textMs = await readProbe(page);
  console.log(`[perf] 3MB 文本首帧: ${Math.round(textMs)}ms（预算 桌面300/移动800ms）`);
  expect(textMs, '文本首帧宽松上限（防抖动）').toBeLessThan(5000);

  // ② hex 首帧：MutationObserver + 双 rAF（缺陷态实测 桌面 1404~1781ms / 移动 1523~1738ms）
  await installPaintProbe(page, '.vv-hex-row');
  const drawer2 = await openDrawerIfNarrow(page);
  await page.locator('.vv-tree-row', { hasText: 'perf-1mb.bin' }).click();
  await closeDrawerIfOpened(page, drawer2);
  const hexMs = await readProbe(page);
  console.log(
    `[perf] 1MB hex 首帧: ${Math.round(hexMs)}ms（预算 桌面200/移动500ms，宽松上限 ${isMobile ? 1500 : 1000}ms）`
  );
  expect(hexMs, 'hex 首帧宽松上限（防抖动，且远低于缺陷态 1.4s+ 基线）').toBeLessThan(
    isMobile ? 1500 : 1000
  );

  // ③ 内容正确性不回退：首行偏移 00000000、行内首字节 00
  await expect(page.locator('.vv-hex-row').first()).toContainText('00000000');
});

test('PWA-05：375×667 无横向溢出，12 层嵌套 blockquote 全渲染', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', '域场景为 375×667 移动视口（mobile project）');
  await page.goto('/');
  const quoteLine = '> '.repeat(12) + '深层引用内容，验证嵌套渲染不溢出。';
  const md = [quoteLine, '', '# 移动端冒烟', '', '普通段落。'].join('\n');
  await page.waitForFunction(
    () => typeof (window as unknown as { __vvOpenDirImpl?: unknown }).__vvOpenDirImpl === 'function'
  );
  await page.evaluate((md) => {
    const f = new File([md], 'deep-quotes.md', { type: 'text/markdown' });
    Object.defineProperty(f, 'webkitRelativePath', { value: 'bpwa/deep-quotes.md' });
    return (window as unknown as { __vvOpenDirImpl: (f: File[]) => void }).__vvOpenDirImpl([f]);
  }, md);

  // 抽屉开合 → 树 → 打开 md（域文档步骤 ②③④）
  await page.locator('.vv-drawer-toggle').click();
  await page.locator('.vv-tree-row', { hasText: 'deep-quotes.md' }).click();
  await page.locator('.vv-drawer-toggle').click();
  await expect(page.locator('.vv-markdown')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.vv-markdown')).toContainText('深层引用内容');

  // 12 层嵌套 blockquote 全渲染（最深 chain 12）
  const depth = await page.evaluate(() => {
    let deepest = 0;
    for (const bq of document.querySelectorAll('.vv-markdown blockquote')) {
      let d = 1;
      let cur = bq.parentElement;
      while (cur) {
        if (cur.tagName === 'BLOCKQUOTE') d++;
        cur = cur.parentElement;
      }
      deepest = Math.max(deepest, d);
    }
    return deepest;
  });
  expect(depth).toBe(12);

  // 无横向溢出：文档滚动宽度不超视口（域文档步骤 ⑤）
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.innerWidth + 1);
});

/** CDP 触摸滑动（mobile project hasTouch；分步 move 模拟真实轨迹，同 mobile.spec.ts 惯例） */
async function touchSwipe(
  page: Page,
  cdp: CDPSession,
  from: { x: number; y: number },
  to: { x: number; y: number },
  steps: number,
  stepDelayMs: number
): Promise<void> {
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: from.x, y: from.y, id: 1 }]
  });
  for (let i = 1; i <= steps; i++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [
        {
          x: from.x + ((to.x - from.x) * i) / steps,
          y: from.y + ((to.y - from.y) * i) / steps,
          id: 1
        }
      ]
    });
    if (stepDelayMs > 0) await page.waitForTimeout(stepDelayMs);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

test('PWA-06：触摸滑动 1:1 驱动虚拟滚动（硬门）；快滑惯性对照实测记录（不硬断言）', async ({
  page
}, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', '域场景为触摸仿真移动视口（mobile project）');
  test.setTimeout(120_000);
  await page.goto('/');
  await openPerfDir(page);
  const drawer = await openDrawerIfNarrow(page);
  await page.locator('.vv-tree-row', { hasText: 'long-3mb.txt' }).click();
  await closeDrawerIfOpened(page, drawer);
  const pre = page.locator('.vv-code-pre');
  await expect(page.locator('.vv-code-pre .vv-code-line').first()).toBeVisible({ timeout: 30_000 });
  await expect(pre.evaluate((el) => el.scrollTop)).resolves.toBe(0);

  // ── 硬门①：慢滑 300px（5 步 × 20ms）1:1 跟手（300px 手势 ≈ 300px 位移）──
  const cdp = await page.context().newCDPSession(page);
  const scrollTop = () => pre.evaluate((el) => el.scrollTop);
  await touchSwipe(page, cdp, { x: 187, y: 500 }, { x: 187, y: 200 }, 5, 20);
  await expect.poll(scrollTop, { timeout: 5_000 }).toBeGreaterThan(150);
  expect(await scrollTop(), '慢滑 1:1（低于 fling 阈值无惯性属正常）').toBeLessThan(600);

  // ── 硬门②：长文件虚拟渲染受控——常驻行数远小于总行数 165000，可视行号随 scrollTop ──
  const rendered = await page.locator('.vv-code-pre .vv-code-line').count();
  expect(rendered, '虚拟滚动常驻行数受控').toBeLessThan(200);
  const top1 = await scrollTop();
  const firstLineNo = await page.evaluate(() => {
    const gutter = document.querySelector('.vv-code-pre .vv-code-line .vv-code-gutter');
    return Number(gutter?.textContent?.replace(/\D/g, '') ?? NaN);
  });
  expect(Math.abs(firstLineNo - 1 - Math.floor(top1 / 20))).toBeLessThanOrEqual(15); // overscan 裕量

  // ── 快滑惯性：实测记录（编排层裁决：本 harness 上虚拟滚动路径惯性不可靠，不作硬断言）──
  /** 快滑 480px（12 步 × 40px、零步进延迟）后 touchend 续滚像素（800ms 内峰值 - touchend 时值） */
  const flingInertia = async (scope: () => ReturnType<Page['locator']>): Promise<number> => {
    await touchSwipe(page, cdp, { x: 187, y: 550 }, { x: 187, y: 70 }, 12, 0);
    const s0 = await scope().evaluate((el) => el.scrollTop);
    let peak = s0;
    for (let i = 0; i < 8; i++) {
      await page.waitForTimeout(100);
      peak = Math.max(peak, await scope().evaluate((el) => el.scrollTop));
    }
    return peak - s0;
  };
  for (let round = 1; round <= 3; round++) {
    console.log(`[perf] 虚拟滚动代码容器快滑第 ${round} 轮 touchend 后续滚: ${await flingInertia(() => pre)}px`);
  }

  // 对照组①：markdown 原生滚动容器（非虚拟，.vv-viewer-scroll）
  const mdBody = Array.from({ length: 800 }, (_, i) => `第 ${i + 1} 段。内容用于撑起滚动高度。`).join('\n\n');
  await page.evaluate((mdBody) => {
    const f = new File([mdBody], 'scroll-ctl.md', { type: 'text/markdown' });
    Object.defineProperty(f, 'webkitRelativePath', { value: 'bpwa/scroll-ctl.md' });
    return (window as unknown as { __vvOpenDirImpl: (f: File[]) => void }).__vvOpenDirImpl([f]);
  }, mdBody);
  const drawer2 = await openDrawerIfNarrow(page);
  await page.locator('.vv-tree-row', { hasText: 'scroll-ctl.md' }).click();
  await closeDrawerIfOpened(page, drawer2);
  await expect(page.locator('.vv-markdown')).toBeVisible({ timeout: 20_000 });
  console.log(`[perf] 对照·markdown 原生容器快滑续滚: ${await flingInertia(() => page.locator('.vv-viewer-scroll'))}px`);

  // 对照组②：非虚拟小代码文件（tree-sitter 路径，同 .vv-code-pre 容器）
  await page.evaluate(() => {
    const content = Array.from({ length: 400 }, (_, i) => `const v${i} = ${i}; // line`).join('\n');
    const f = new File([content], 'scroll-ctl.js', { type: 'text/javascript' });
    Object.defineProperty(f, 'webkitRelativePath', { value: 'bpwa/scroll-ctl.js' });
    return (window as unknown as { __vvOpenDirImpl: (f: File[]) => void }).__vvOpenDirImpl([f]);
  });
  const drawer3 = await openDrawerIfNarrow(page);
  await page.locator('.vv-tree-row', { hasText: 'scroll-ctl.js' }).click();
  await closeDrawerIfOpened(page, drawer3);
  const preSmall = page.locator('.vv-code-pre');
  await expect(preSmall.locator('.vv-code-line').first()).toBeVisible({ timeout: 20_000 });
  console.log(`[perf] 对照·非虚拟代码容器快滑续滚: ${await flingInertia(() => preSmall)}px`);
});

test('PWA-07：mp4 播放器挂载，全屏进入/退出', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', '域场景为移动视口（mobile project）');
  test.setTimeout(60_000);
  await page.goto('/');
  await page.waitForFunction(
    () => typeof (window as unknown as { __vvOpenDirImpl?: unknown }).__vvOpenDirImpl === 'function'
  );
  await page.evaluate((b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const f = new File([bytes], 'sample.mp4', { type: 'video/mp4' });
    Object.defineProperty(f, 'webkitRelativePath', { value: 'bpwa/sample.mp4' });
    return (window as unknown as { __vvOpenDirImpl: (f: File[]) => void }).__vvOpenDirImpl([f]);
  }, MP4_B64);
  await page.locator('.vv-drawer-toggle').click();
  await page.locator('.vv-tree-row', { hasText: 'sample.mp4' }).click();
  await page.locator('.vv-drawer-toggle').click();

  // ArtPlayer 挂载（同 mobile.spec：headless codec 宽松，仅断容器与无 error）
  await expect(page.locator('.vv-artplayer')).toBeVisible({ timeout: 20_000 });
  const video = page.locator('.vv-artplayer video');
  await expect(video).toHaveCount(1);
  // 控制条按钮就绪后再点（ArtPlayer 异步装配 controls，过早 force 点击落空导致偶发 flake）
  const fsBtn = page.locator('.vv-artplayer .art-control-fullscreen');
  await expect(fsBtn).toBeAttached({ timeout: 15_000 });
  await page.waitForTimeout(300);

  // 全屏进入（trusted click → requestFullscreen）。单轮只点一次再轮询确认——
  // 轮询内反复 force-click 会排队多次 toggle，迟到的 toggle 把已进入的全屏切回
  let entered = false;
  for (let attempt = 0; attempt < 3 && !entered; attempt++) {
    await fsBtn.click({ force: true }).catch(() => undefined);
    try {
      await expect
        .poll(() => page.evaluate(() => document.fullscreenElement !== null), { timeout: 3_000 })
        .toBe(true);
      entered = true;
    } catch {
      /* 本轮未进入：重试一轮 */
    }
  }
  expect(entered, 'trusted click 后应进入全屏').toBe(true);
  const fsName = await page.evaluate(() => document.fullscreenElement?.tagName.toLowerCase());
  expect(['video', 'div']).toContain(fsName ?? '');

  // 全屏退出（Document.exitFullscreen）
  await expect
    .poll(
      async () => {
        await page.evaluate(() => {
          if (document.fullscreenElement) void document.exitFullscreen();
        });
        return page.evaluate(() => document.fullscreenElement === null);
      },
      { timeout: 10_000, message: '等待全屏退出' }
    )
    .toBe(true);
  await expect(page.locator('.vv-artplayer')).toBeVisible(); // 页面不崩、播放器仍在
});

test('PWA-09：mp4/wav 打开到起播就绪（预算 <1s，宽松上限 <5s 并记录实测）', async ({
  page
}, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', '域场景为移动视口（mobile project）');
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
      Object.defineProperty(f1, 'webkitRelativePath', { value: 'bpwa/sample.mp4' });
      const wavBytes = Uint8Array.from(atob(wav), (c) => c.charCodeAt(0));
      const f2 = new File([wavBytes], 'tone.wav', { type: 'audio/wav' });
      Object.defineProperty(f2, 'webkitRelativePath', { value: 'bpwa/tone.wav' });
      return (window as unknown as { __vvOpenDirImpl: (f: File[]) => void }).__vvOpenDirImpl([f1, f2]);
    },
    { b64: MP4_B64, wav: wavB64 }
  );

  /** 打开 → 媒体元素起播就绪（readyState ≥ 1 HAVE_METADATA）耗时 */
  const openAndMeasure = async (name: string, selector: string): Promise<number> => {
    const t0 = Date.now();
    const drawer = await openDrawerIfNarrow(page);
    await page.locator('.vv-tree-row', { hasText: name }).click();
    await closeDrawerIfOpened(page, drawer);
    const el = page.locator(selector);
    await expect(el).toBeVisible({ timeout: 20_000 });
    await expect
      .poll(() => el.evaluate((m) => (m as HTMLMediaElement).readyState), { timeout: 10_000 })
      .toBeGreaterThanOrEqual(1);
    return Date.now() - t0;
  };

  const mp4Ms = await openAndMeasure('sample.mp4', '.vv-artplayer video');
  console.log(`[perf] mp4 打开到起播就绪: ${mp4Ms}ms（预算 <1000ms）`);
  expect(mp4Ms, 'mp4 起播就绪宽松上限（防抖动）').toBeLessThan(5000);

  const wavMs = await openAndMeasure('tone.wav', 'audio.vv-av');
  console.log(`[perf] wav 打开到起播就绪: ${wavMs}ms（预算 <1000ms）`);
  expect(wavMs, 'wav 起播就绪宽松上限（防抖动）').toBeLessThan(5000);
});
