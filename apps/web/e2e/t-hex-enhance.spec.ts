import { test, expect, type Page } from '@playwright/test';
import { closeDrawerIfOpened, openDrawerIfNarrow } from './drawer';

/**
 * hex 增强 e2e（跳转/搜索/检查器 spec H §2-§3 的 t- 前缀新文件；Task 4 将按 spec
 * 补齐跳转/搜索/两档高亮/移动抽屉全量场景）。
 *
 * Task 4 补齐：跳转（HEX-GOTO-01）、hex/文本搜索与两档高亮（HEX-SEARCH-01/02/03）、
 * 检查器值表与 ≤600px 右抽屉可达性（HEX-INSP-02，补 Task 1 记账的「检查器移动抽屉
 * 可达性」）、性能锚点（HEX-PERF-01，spec §2.4 原文 200MB/100ms 进度帧锚点经 ledger
 * 裁决降格为 1MB 搜索启动首帧版）。
 *
 * 本轮（Task 3 fix round 1 Critical 1）先落「真实布局断言 + 点击定位」：
 * - 布局链：.vv-hex-row 处于 .vv-virtual-viewport（absolute left:0 right:0）内，
 *   block 行默认被拉伸为容器宽，hex.ts 点击换算的「行宽/77=单字符宽」随之高估
 *   2~2.5 倍（检查器核心交互系统性偏移）。修复：app.css `.vv-hex-row{width:
 *   max-content}` 使行宽回到内容宽（不可配对 min-width:100%——容器更宽时行被顶回
 *   容器宽、抵消 max-content，e2e 首跑实测 768 vs 554.6px 后移除）。
 * - 断言口径：Range 圈选行首字符**独立实测**单字符宽（不依赖被测的 rect.width/77
 *   公式），先锁「行宽 ≈ 77×字符宽」（max-content 回归护栏——jsdom 无布局，单测
 *   mock 只能固化假设，真实布局只能在此验证），再驱动真实鼠标点击断言检查器 offset。
 * - 注入通道同 t-bin.spec.ts（__vvOpenDirImpl 页内建目录；.bin 路由 hex 渲染器）。
 */

/** 已知字节布点的样例：offset 3 = 0x01、offset 4 = 0x00（uint16 little=1 / big=256） */
function makeSample(): Uint8Array {
  const bytes = new Uint8Array(64);
  bytes[3] = 0x01;
  return bytes;
}

async function openDir(page: Page, name: string, bytes: Uint8Array): Promise<void> {
  await page.waitForFunction(
    () => typeof (window as unknown as { __vvOpenDirImpl?: unknown }).__vvOpenDirImpl === 'function'
  );
  await page.evaluate(({ name, bytes }) => {
    const f = new File([bytes as unknown as BlobPart], name, { type: 'application/octet-stream' });
    Object.defineProperty(f, 'webkitRelativePath', { value: `hexenh/${name}` });
    (window as unknown as { __vvOpenDirImpl: (f: File[]) => void }).__vvOpenDirImpl([f]);
  }, { name, bytes });
}

/** 多文件目录注入（单次 __vvOpenDirImpl 调用建树，同 t-bin 复数版；perf 多轮换文件用） */
async function openFiles(page: Page, files: Array<{ name: string; bytes: Uint8Array }>): Promise<void> {
  await page.waitForFunction(
    () => typeof (window as unknown as { __vvOpenDirImpl?: unknown }).__vvOpenDirImpl === 'function'
  );
  await page.evaluate((list) => {
    const fs = list.map(({ name, bytes }) => {
      const f = new File([bytes as unknown as BlobPart], name, { type: 'application/octet-stream' });
      Object.defineProperty(f, 'webkitRelativePath', { value: `hexenh/${name}` });
      return f;
    });
    (window as unknown as { __vvOpenDirImpl: (f: File[]) => void }).__vvOpenDirImpl(fs);
  }, files);
}

/** 打开文件并等 tab 激活（抽屉视口 ≤900px 自动开/关抽屉，drawer.ts/t-bin 惯例） */
async function openHexFile(page: Page, name: string): Promise<void> {
  const drawer = await openDrawerIfNarrow(page);
  await page.locator('.vv-tree-row', { hasText: name }).click();
  await closeDrawerIfOpened(page, drawer);
  await expect(page.locator('.vv-tab.active', { hasText: name })).toBeVisible();
}

/**
 * ≤600px 断点（mobile 375 视口）MetaPanel 收进右抽屉（AppShell.svelte 媒体查询）：
 * 开启使其可达（桌面 no-op）。判定经 matchMedia 与样式表同引擎求值（drawer.ts 同法）。
 */
async function openRightDrawerIfNarrow(page: Page): Promise<void> {
  const narrow = await page.evaluate(() => window.matchMedia('(max-width: 600px)').matches);
  if (narrow) await page.locator('.vv-right-toggle').click();
}

// ---- Task 4 fixtures：页内构造已知布点 Uint8Array（同 makeSample 手法）----

/** 跳转样例：64KB；0x10=0xab（近端跳转 flash）、0x8000=0x5a（远端滚动定位）、末字节 0xff（超界 clamp 落点） */
function makeGotoSample(): Uint8Array {
  const bytes = new Uint8Array(64 * 1024);
  bytes[0x10] = 0xab;
  bytes[0x8000] = 0x5a;
  bytes[bytes.length - 1] = 0xff;
  return bytes;
}

/** hex 搜索样例：16KB，'de ad' 布点 0x30/0x40/0x50（同窗可断言两档高亮）+ 0x1000（远端导航滚动） */
function makeHitSample(): Uint8Array {
  const bytes = new Uint8Array(16 * 1024);
  for (const off of [0x30, 0x40, 0x50, 0x1000]) {
    bytes[off] = 0xde;
    bytes[off + 1] = 0xad;
  }
  return bytes;
}

/** 文本搜索样例：4KB，0x100 布点 'CaseSensitivity'、0x800 布点 'casesensitivity'（大小写开关两态） */
function makeTextSample(): Uint8Array {
  const bytes = new Uint8Array(4 * 1024);
  bytes.set(new TextEncoder().encode('CaseSensitivity'), 0x100);
  bytes.set(new TextEncoder().encode('casesensitivity'), 0x800);
  return bytes;
}

/** 截断样例：4KB 全 'de ad'（2048 处命中 > SEARCH_MAX_HITS=1000 → 提前终止 + 截断标记） */
function makeTruncatedSample(): Uint8Array {
  const bytes = new Uint8Array(4096);
  for (let i = 0; i < bytes.length; i += 2) {
    bytes[i] = 0xde;
    bytes[i + 1] = 0xad;
  }
  return bytes;
}

/** 检查器值表样例：offset 8 = 0x01（uint16/uint32/int64 端序翻转取干净数值 1↔256↔16777216） */
function makeInspectorSample(): Uint8Array {
  const bytes = new Uint8Array(64);
  bytes[8] = 0x01;
  return bytes;
}

/** 性能样例：1MB，每 4096 字节布点 'de ad'（256 命中 < 上限，无截断） */
function makePerfSample(): Uint8Array {
  const bytes = new Uint8Array(1 << 20);
  for (let off = 0; off < bytes.length; off += 4096) {
    bytes[off] = 0xde;
    bytes[off + 1] = 0xad;
  }
  return bytes;
}

// ---- 首帧探针（t-pwa PWA-08 installPaintProbe/readProbe 本地拷贝先例）----

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

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  // 调用契约：values 非空（3 轮），mid 必在界内——noUncheckedIndexedAccess 下以断言收窄
  return sorted.length % 2 ? (sorted[mid] as number) : Math.round(((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2);
}

/** 含当前命中（active 档）的 hex 行（has 内层须为文档级 page.locator——
 *  dump.locator 作用域链下相对解析不命中，首跑实测） */
function activeHitRow(page: Page) {
  return page.locator('.vv-hex-row', { has: page.locator('.vv-hex-hit-active') });
}

test('HEX-INSP-01：点击 hex 列第 k 字节 → 检查器 offset === k（真实布局 + 字节序下行）', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', '点击定位与布局断言为桌面基准（THEME-03 惯例）；检查器移动抽屉可达性由 Task 4 补');
  test.setTimeout(60_000);
  await page.goto('/');
  await openDir(page, 'insp.bin', makeSample());
  await page.locator('.vv-tree-row', { hasText: 'insp.bin' }).click();
  await expect(page.locator('.vv-tab.active', { hasText: 'insp.bin' })).toBeVisible();

  // ① 真实布局护栏：Range 独立实测首字符宽，行宽必须等于内容宽（77 字符）——
  //    若 .vv-hex-row 被 viewport 拉伸为容器宽（Critical 1 回归）此处即红
  const row = page.locator('.vv-hex-dump .vv-hex-row').first();
  await expect(row).toBeVisible();
  const m = await row.evaluate((el) => {
    const node = el.firstChild!;
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, 1);
    const charW = range.getBoundingClientRect().width;
    return { charW, rowW: el.getBoundingClientRect().width, chars: (el.textContent ?? '').length };
  });
  expect(m.chars).toBe(77); // 64 字节文件首行为完整行（renderHexBytes 三列定宽）
  expect(m.charW).toBeGreaterThan(0);
  // 容差 1 字符宽；拉伸布局偏差为数倍。带实测值抛出（playwright expect 无 message 形参）
  if (!(Math.abs(m.rowW - m.charW * 77) < m.charW)) {
    throw new Error(`layout regression: rowW=${m.rowW} charW=${m.charW} chars=${m.chars}`);
  }

  // ② 点击 hex 列字节 3（列 19-20 的首字符中点）→ 检查器 offset === 3（Critical 1 直接验证）
  await row.click({ position: { x: 19.5 * m.charW, y: 9 } });
  await expect(page.locator('.meta-inspector-offset')).toHaveText('@ 0x3');
  // 光标字节高亮：hex 列 + ASCII 列同字节（0x01 → '01'/'.'）
  await expect(page.locator('.vv-hex-dump .vv-hex-cursor')).toHaveText(['01', '.']);

  // ③ 字节序下行链端到端：select → inspectorBus → setLittle → 重解码 → 轮询上行。
  //    offset 3 起字节 01 00：uint16 小端 1 / 大端 256
  const uint16Row = page.locator('.meta-inspector .meta-row', { hasText: 'uint16' });
  await expect(uint16Row).toHaveText('uint161');
  await page.locator('.meta-inspector-little').selectOption('big');
  await expect(uint16Row).toHaveText('uint16256');
  await expect(page.locator('.meta-inspector-offset')).toHaveText('@ 0x3'); // 光标不动
});

// ── Task 4：跳转 / 搜索 / 高亮两档 / 检查器值表 / 性能锚点（spec H §2-§3/§5）──

test('HEX-GOTO-01：跳转 0x10 flash 定位 + 远端跳转滚动 + 超界 clamp「已跳至文件尾」', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/');
  await openDir(page, 'goto.bin', makeGotoSample());
  await openHexFile(page, 'goto.bin');
  const dump = page.locator('.vv-hex-dump');
  await expect(dump.locator('.vv-hex-row').first()).toBeVisible();
  const gotoInput = page.locator('.vv-hex-goto');

  // ① `0x10`（0x 前缀 = 十六进制解析）Enter → 状态位空（未 clamp）+ 目标字节 flash 高亮。
  //    flash 1s 衰减：断言紧随 Enter 首轮轮询即命中（目标行 1 在 scrollTop=0 的可视区内）
  await gotoInput.fill('0x10');
  await gotoInput.press('Enter');
  await expect(page.locator('.vv-hex-toolbar-status')).toHaveText('');
  await expect(page.locator('.vv-hex-goto-flash')).toHaveText(['ab', '.']); // 0xab → hex 'ab' + ASCII '.'

  // ② 远端跳转 0x8000 → 视口滚动（scrollTop > 0）且目标行渲染在可视范围——虚拟滚动
  //    只渲染视口 ±overscan 行，「该行存在于 DOM」即滚动定位证据
  await gotoInput.fill('0x8000');
  await gotoInput.press('Enter');
  await expect(dump.locator('.vv-hex-row', { hasText: /^00008000/ })).toBeVisible();
  expect(await dump.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);

  // ③ 超界 0x999999 → clamp 到末字节（0xffff，行首 0xfff0）+ 状态位「已跳至文件尾」
  await gotoInput.fill('0x999999');
  await gotoInput.press('Enter');
  await expect(page.locator('.vv-hex-toolbar-status')).toHaveText('已跳至文件尾');
  await expect(dump.locator('.vv-hex-row', { hasText: /^0000fff0/ })).toBeVisible();
});

test('HEX-SEARCH-01：hex 模式命中数/导航（Enter/Shift+Enter/按钮循环）+ 两档高亮 + 奇数位 aria-invalid', async ({
  page
}) => {
  test.setTimeout(60_000);
  await page.goto('/');
  await openDir(page, 'hits.bin', makeHitSample());
  await openHexFile(page, 'hits.bin');
  const dump = page.locator('.vv-hex-dump');
  const search = page.locator('.vv-hex-search');
  const status = page.locator('.vv-hex-search-status');

  // ① 奇数位 hex → aria-invalid + 内联提示；修正后摘除
  await search.fill('abc');
  await expect(search).toHaveAttribute('aria-invalid', 'true');
  await expect(status).toHaveText('hex 位数须为偶数');
  await search.fill('de ad');
  await expect(search).not.toHaveAttribute('aria-invalid');

  // ② Enter 搜索：4 处命中（0x30/0x40/0x50 同窗 + 0x1000 远端），done 自动定位首处。
  //    两档：当前命中 active（hex 段 'de ad' + ASCII 段 '..'）×2 span；同窗其余命中普通档 ×4 span
  await search.press('Enter');
  await expect(status).toHaveText('1/4 处命中');
  await expect(dump.locator('.vv-hex-hit-active')).toHaveText(['de ad', '..']);
  await expect(dump.locator('.vv-hex-hit:not(.vv-hex-hit-active)')).toHaveCount(4);

  // ③ 同输入 Enter = 导航下一处（2/4，active 落 0x40 行）；Shift+Enter 上一处回 1/4
  await search.press('Enter');
  await expect(status).toHaveText('2/4 处命中');
  await expect(activeHitRow(page)).toHaveText(/^00000040/);
  await search.press('Shift+Enter');
  await expect(status).toHaveText('1/4 处命中');

  // ④ 按钮循环推进至远端命中：4/4（0x1000 行渲染 = 滚动定位）；再下一处回绕 1/4
  await page.locator('.vv-hex-search-next').click();
  await page.locator('.vv-hex-search-next').click();
  await page.locator('.vv-hex-search-next').click();
  await expect(status).toHaveText('4/4 处命中');
  await expect(activeHitRow(page)).toHaveText(/^00001000/);
  await page.locator('.vv-hex-search-next').click();
  await expect(status).toHaveText('1/4 处命中');
});

test('HEX-SEARCH-02：文本模式 + 大小写开关（默认敏感）+ 无命中状态位', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/');
  await openDir(page, 'text.bin', makeTextSample());
  await openHexFile(page, 'text.bin');
  const dump = page.locator('.vv-hex-dump');
  const search = page.locator('.vv-hex-search');
  const status = page.locator('.vv-hex-search-status');
  const caseToggle = page.locator('.vv-hex-search-case');

  // 默认敏感（spec §Global Constraints；T2 fix round 1 I-1 对齐）
  await expect(caseToggle).toBeChecked();

  // ① 敏感：'cases'（含非 hex 字符 s → 文本模式）只命中小写布点 0x800
  await search.fill('cases');
  await search.press('Enter');
  await expect(status).toHaveText('1/1 处命中');
  await expect(activeHitRow(page)).toHaveText(/^00000800/);

  // ② 取消勾选（不敏感）→ 新输入 'CaseS' 命中两处布点，自动定位首处 0x100
  await caseToggle.click();
  await expect(caseToggle).not.toBeChecked();
  await search.fill('CaseS');
  await search.press('Enter');
  await expect(status).toHaveText('1/2 处命中');
  await expect(activeHitRow(page)).toHaveText(/^00000100/);

  // ③ 无命中状态位
  await search.fill('AbsentNeedle');
  await search.press('Enter');
  await expect(status).toHaveText('无命中');

  // ④ hex 模式输入时大小写开关禁用（仅文本模式有意义）
  await search.fill('de ad');
  await expect(caseToggle).toBeDisabled();
});

test('HEX-SEARCH-03：命中数超上限截断（块内即时判停）——状态位「（截断）」', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/');
  await openDir(page, 'trunc.bin', makeTruncatedSample());
  await openHexFile(page, 'trunc.bin');
  const search = page.locator('.vv-hex-search');
  // 4096B 全 'de ad' → 2048 处命中 > SEARCH_MAX_HITS=1000 → 截断标记。上限为块内
  // 即时判停（块内收满配额即 break）：单块恰好收满 1000 即停扫并置 truncated——
  // 断言锁定「（截断）」标记与精确命中数。done 自动定位首处
  await search.fill('de ad');
  await search.press('Enter');
  await expect(page.locator('.vv-hex-search-status')).toHaveText('1/1000 处命中（截断）');
});

test('HEX-INSP-02：检查器值表各类型断言 + 字节序翻转值（≤600px 右抽屉可达性）', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/');
  await openDir(page, 'insp2.bin', makeInspectorSample());
  await openHexFile(page, 'insp2.bin');
  const row = page.locator('.vv-hex-dump .vv-hex-row').first();
  await expect(row).toBeVisible();

  // 点击 hex 列字节 8（列 34-35 首字符中点）：字符宽经 Range 独立实测（同 HEX-INSP-01
  // 口径；布局不变式「行宽=77×字符宽」由其 ① 护栏承担，此处不重复）
  const m = await row.evaluate((el) => {
    const node = el.firstChild!;
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, 1);
    return range.getBoundingClientRect().width;
  });
  await row.click({ position: { x: 34.5 * m, y: 9 } });

  // ≤600px（mobile 375 视口）MetaPanel 收进右抽屉：开启使其可达（Task 1 记账项；
  // 桌面 no-op）
  await openRightDrawerIfNarrow(page);

  // 值表上行（250ms 轮询，expect 自动重试覆盖）：13 行全类型 + offset '@ 0x8'。
  // 行定位用 ^label 正则——'int8' 是 'uint8' 的子串，子串匹配会双行命中 strict 冲突
  await expect(page.locator('.meta-inspector .meta-row')).toHaveCount(13);
  await expect(page.locator('.meta-inspector-offset')).toHaveText('@ 0x8');
  const metaRow = (label: string) => page.locator('.meta-inspector .meta-row', { hasText: new RegExp(`^${label}`) });
  await expect(metaRow('int8')).toHaveText('int81');
  await expect(metaRow('uint8')).toHaveText('uint81');
  await expect(metaRow('int16')).toHaveText('int161');
  await expect(metaRow('uint16')).toHaveText('uint161');
  await expect(metaRow('uint32')).toHaveText('uint321');
  await expect(metaRow('int64')).toHaveText('int641');
  await expect(metaRow('bool')).toHaveText('booltrue');
  await expect(metaRow('hex')).toContainText('01 00 00 00'); // 16 字节窗回显

  // 字节序翻转（下行链 select → inspectorBus → setLittle → 重解码 → 轮询上行）：
  // offset 8 起 01 00 00 00 → 小端 1 ↔ 大端 256（uint16）/ 16777216（uint32），offset 不动
  await page.locator('.meta-inspector-little').selectOption('big');
  await expect(metaRow('uint16')).toHaveText('uint16256');
  await expect(metaRow('uint32')).toHaveText('uint3216777216');
  await expect(metaRow('int16')).toHaveText('int16256');
  await expect(page.locator('.meta-inspector-offset')).toHaveText('@ 0x8');
});

test('HEX-PERF-01：1MB 搜索启动首帧（命中高亮首现）中位 < 300ms + 命中态滚动到底', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', '性能锚点为桌面基准（THEME-03 惯例；移动预算由 b-pwa 域承担）');
  test.setTimeout(120_000);
  // 降格说明：spec §2.4 原文锚点「200MB 搜索 / 100ms 进度帧」构造不现实（ledger 裁决），
  // 降格为 1MB 文件搜索启动首帧探针（BUG-16 installPaintProbe 口径本地拷贝）——探针
  // 覆盖 worker 建连 + 1MB 扫描 + 进度重绘 + 命中高亮首现全链。
  await page.goto('/');
  await openFiles(page, [
    { name: 'perf-a.bin', bytes: makePerfSample() },
    { name: 'perf-b.bin', bytes: makePerfSample() },
    { name: 'perf-c.bin', bytes: makePerfSample() }
  ]);

  // 3 轮换文件（换 tab 天然重置 pane——同文件重开探针会对残留 DOM 返回 0ms 假达标，
  // t-pwa PWA-08/2 同教训）；探针在 tab 切换后、搜索触发前安装（此刻无任何命中 DOM）
  const ms: number[] = [];
  for (const name of ['perf-a.bin', 'perf-b.bin', 'perf-c.bin']) {
    await openHexFile(page, name);
    await installPaintProbe(page, '.vv-hex-hit');
    const search = page.locator('.vv-hex-search');
    await search.fill('de ad');
    await search.press('Enter');
    ms.push(await readProbe(page));
  }
  const med = median(ms);
  console.log(`[hexperf] 搜索启动命中首帧: ${ms.map(Math.round).join('/')} ms，中位 ${Math.round(med)}ms（预算 300ms）`);
  expect(med, '1MB 搜索启动首帧中位 < 300ms（降格锚点；实测 ~71ms，4 倍余量，PWA-08 收紧惯例）').toBeLessThan(300);

  // 命中态滚动到底：装饰行重绘路径滚动可达末偏移（1MB = 65536 行整，末行 0xffff0）
  const dump = page.locator('.vv-hex-dump');
  await expect(page.locator('.vv-hex-search-status')).toContainText('处命中');
  await dump.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect(dump.locator('.vv-hex-row', { hasText: /^000ffff0/ })).toBeVisible({ timeout: 10_000 });
});
