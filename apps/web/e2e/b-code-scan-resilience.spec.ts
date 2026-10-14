import { expect, type Locator, type Page, test } from '@playwright/test';
import {
  CODE_BLOCK_BYTES,
  CODE_NEEDLE,
  CODE_TRIGGER,
  IoStats,
  type StreamFakeServer,
  codeBlockRange,
  codeLineText,
  makeCodeFile,
  openRemoteFile,
  settleStats,
  startStreamFakeServer
} from './b-stream-resilience-helpers';

/**
 * code 后台扫描与重搜韧性 e2e（docs/e2e/code-scan-resilience.md 场景 SCAN-01~11）：
 * code 窗口模式（>2MB / size 未知流式）后台全文扫描搜索的失败/取消/重搜面回归锚。
 * 既有锚点 IO-06~10（b-io-streaming.spec.ts）只走正常 206 通道的 happy-path 计量，
 * 本 spec 补齐其失败面：进度条全生命周期（BUG-100）、同 query 重搜一致性（BUG-101）、
 * 补块失败游标回退与恢复（BUG-102）、revealLine 未加载行续读跳转（d37fcd0）、
 * 回看重拉失败停机闩（90f4ca5）、命中渐进上屏（spec §4.3）。
 *
 * 装置：b-stream-resilience-helpers.ts（SCAN/JVL/DEG 共享）——node:http 假服务器
 * （Range 206 切片 + stall/fail/failOnce 三形态门 + slowMs 确定性放慢 + /api/tree
 * 可省 size + POST /api/search NDJSON）+ IoStats /api/file 计量（Range 头/状态/字节）。
 * 时序面全部用门构造（挂起/拒绝指定 Range），杜绝真实时序竞态。
 *
 * 场景 → 断言概览：
 * - SCAN-01/02：进度条 % 形态出现-推进-完成移除 + 命中计数精确（BUG-100）
 * - SCAN-03：取消（Esc）后进度条收场移除、挂起应答有归宿（BUG-100）
 * - SCAN-04：在飞换 query 进度条属主接管（ffab040），旧扫描收场不误删（BUG-100）
 * - SCAN-05：size 未知 KB 形态进度文本 + EOF 短读收场（BUG-100）
 * - SCAN-06：全文完成同键重搜零扫描 IO（4102b26 短路；BUG-101）
 * - SCAN-07：取消收场后同 query 重搜续扫不短路、不重读不重复（BUG-101）
 * - SCAN-08：补块失败部分收场 + 放行后续扫补全（e75c59e/5cd1698；BUG-102）
 * - SCAN-09：全局搜索命中点击 → revealLine 未加载行驱动续读跳转（d37fcd0/BUG-09 面）
 * - SCAN-10：回看重拉首拒停机闩——无请求风暴、用户动作重试成功（90f4ca5）
 * - SCAN-11：挂起阶段命中渐进——进度条命中数 + 行级背景先于全文完成可见（spec §4.3）
 *
 * 通道：vite preview :4173 纯前端页面 + 跨源假服务器（t-workspace 先例）；
 * chromium + mobile（375×667）双 project，树行点击经 drawer.ts 窄视口适配（helper 内）。
 */

// ---- 夹具尺寸（与 helper 的 64B 定长行/256KB 块耦合：块号 = floor(行×64/256KB)） ----

/** 10MB = 163840 行 = 40 块；布点分属块 0（行 1000）与块 5（行 21000） */
const BIG_JS_ROWS = 163_840;
const BIG_NEEDLES = [1000, 21_000] as const;
/** 2MB = 32768 行 = 8 块（size 未知专载）；布点行 500（块 0）与 9000（块 2） */
const NOSIZE_ROWS = 32_768;
const NOSIZE_NEEDLES = [500, 9000] as const;
/** SCAN-08 布点：块 1（行 5000，失败门之前）与块 5（行 21000，失败门之后） */
const FAIL_NEEDLES = [5000, 21_000] as const;
/** ~19.5MB = 320000 行 = 79 块（SCAN-09 深行专载）；唯一布点行 300000（块 73） */
const DEEP_ROWS = 320_000;
const DEEP_ROW = 300_000;
/** 6MB = 98304 行 = 24 块 > 块表 LRU 16（SCAN-10 回看逐出专载） */
const BACKTRACK_ROWS = 98_304;

/** code 首块之前的首请求：head 探测（dispatcher HEAD_SIZE 8KB） */
const PROBE_RANGE = 'bytes=0-8191';

// ---------------- 页面装置（code/搜索面板专载，本 spec 内自含） ----------------

/** 打开远端 code 文件并等首屏就绪：openRemoteFile（连接+树行+抽屉适配）→ 首行渲染
 * → settleStats 收敛保险。返回内部滚动容器 .vv-code-pre。 */
async function openCode(
  page: Page,
  fake: StreamFakeServer,
  stats: IoStats,
  name: string
): Promise<Locator> {
  await openRemoteFile(page, fake, stats, name);
  const pre = page.locator('.vv-code-pre');
  await expect(pre.locator('.vv-code-line').first()).toBeVisible({ timeout: 20_000 });
  await settleStats(page, stats);
  return pre;
}

/** 打开文件内搜索面板并输入词（'/' 打开；面板已开时勿用——'/' 会落入输入框） */
async function panelSearch(page: Page, term: string): Promise<void> {
  await page.keyboard.press('/');
  await expect(page.locator('.vv-search-panel')).toBeVisible();
  await expect(page.locator('.vv-search-input')).toBeFocused();
  await page.keyboard.insertText(term);
}

/** 面板已开时替换查询词（fill 整值替换单次 input → 防抖后重搜；在飞换 query 用） */
async function replaceSearchQuery(page: Page, term: string): Promise<void> {
  await page.locator('.vv-search-input').fill(term);
}

/**
 * 同键重搜触发（面板保持开启、查询值不变）：向输入框重派发同值 input 事件——
 * 等价用户全选重贴同词。防抖后 runSearch 以相同 key 进入实例 search，命中
 * 「同键短路 / 同键续扫」分界（清空再输入是换键，会重置命中集与游标，非同键重搜）。
 */
async function retriggerSameQuerySearch(page: Page, term: string): Promise<void> {
  await page.locator('.vv-search-input').evaluate((el, value) => {
    (el as HTMLInputElement).value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, term);
}

/** 扫描进度条（runScan 期间挂在 target 顶部的一次性元素；收场移除） */
function scanBar(page: Page): Locator {
  return page.locator('.vv-code-scan-progress');
}

/** 文件内搜索面板计数文本 */
function searchCount(page: Page): Locator {
  return page.locator('.vv-search-count');
}

/** 当前命中行（code active 行级高亮） */
function activeHitLine(page: Page): Locator {
  return page.locator('.vv-code-line.vv-search-hit-line-active');
}

/** 页内安装进度条文本采样器（100ms 间隔、仅条在位时采样，避免 evaluate 往返漏采） */
async function installScanBarSampler(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __vvScanSamples?: string[]; __vvScanTimer?: number };
    w.__vvScanSamples = [];
    w.__vvScanTimer = window.setInterval(() => {
      const el = document.querySelector('.vv-code-scan-progress');
      if (el !== null) w.__vvScanSamples!.push(el.textContent ?? '');
    }, 100);
  });
}

/** 收取采样器样本并拆卸 */
async function collectScanBarSamples(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const w = window as unknown as { __vvScanSamples?: string[]; __vvScanTimer?: number };
    if (w.__vvScanTimer !== undefined) clearInterval(w.__vvScanTimer);
    return w.__vvScanSamples ?? [];
  });
}

/** 全程负向护栏：窗口模式路径不得出现全量 200（任一 Range-less 记录即流式选路回归） */
function expectNoFullRead(stats: IoStats): void {
  for (const r of stats.records) {
    expect(r.range, `不得出现全量 200 拉取（status ${r.status}）`).not.toBeNull();
  }
}

// ---------------------------------------------------------------- SCAN-01

test('SCAN-01：扫描进度条 % 形态出现并单调推进（size 已知），全程无全量 200', async ({ page }) => {
  test.setTimeout(150_000);
  // slowMs=60：40 块扫描推进 ≈2.3s+，采样窗口充足且不依赖真实时序
  const fake = await startStreamFakeServer(
    { 'scan10.js': makeCodeFile(BIG_JS_ROWS) },
    { slowMs: 60 }
  );
  try {
    const stats = new IoStats();
    const pre = await openCode(page, fake, stats, 'scan10.js');
    await installScanBarSampler(page);
    // 无命中词触发后台全文扫描（40 块逐块拉取至 EOF）
    await panelSearch(page, 'qqnothingqz');
    // 收场信号 = IO 事实（末块 39 已拉取）；计数文本全程「无结果」不可作完成信号
    //（面板计数完成制，扫描期间即显示无结果）
    await expect
      .poll(() => stats.ranges().includes(codeBlockRange(39)), { timeout: 120_000 })
      .toBe(true);
    await settleStats(page, stats);
    const samples = await collectScanBarSamples(page);

    // 扫描期间进度条可见且为 % 形态「扫描中 N%（已命中 0 处）」，N% 单调不减
    expect(samples.length, `扫描期间应采样到进度条文本，实得 ${samples.length}`).toBeGreaterThanOrEqual(3);
    let prev = -1;
    for (const s of samples) {
      const m = /^扫描中 (\d+)%（已命中 0 处）$/.exec(s);
      expect(m, `进度文本应为 size 已知 % 形态: ${s}`).not.toBeNull();
      const pct = Number(m![1]);
      expect(pct, `百分比应单调不减: ${samples.join(' | ')}`).toBeGreaterThanOrEqual(prev);
      prev = pct;
    }
    expect(prev, `末采样应已推进（首 ≤30 → 末 >30）: ${samples.join(' | ')}`).toBeGreaterThan(30);

    // 负向护栏 + 完成即移除（终态在 SCAN-02 细化）
    expectNoFullRead(stats);
    await expect(scanBar(page)).toHaveCount(0);
    await expect(pre.locator('.vv-code-line').first()).toBeVisible(); // 索引完好
  } finally {
    await fake.close();
  }
});

// ---------------------------------------------------------------- SCAN-02

test('SCAN-02：扫描完成进度条移除，命中计数与布点精确一致（1/2 → 2/2 定位正确）', async ({ page }) => {
  test.setTimeout(150_000);
  const fake = await startStreamFakeServer({ 'scan10.js': makeCodeFile(BIG_JS_ROWS, BIG_NEEDLES) });
  try {
    const stats = new IoStats();
    await openCode(page, fake, stats, 'scan10.js');
    await panelSearch(page, CODE_NEEDLE);

    // 完成收场：计数落定（无结果 → 1/2）+ 进度条移除
    await expect(searchCount(page)).toHaveText('1/2', { timeout: 120_000 });
    await expect(scanBar(page)).toHaveCount(0);
    // 首命中自动定位：行号与构造布点吻合 + 词级命中可见
    await expect(activeHitLine(page)).toHaveAttribute('data-line', String(BIG_NEEDLES[0]), {
      timeout: 15_000
    });
    await expect(activeHitLine(page)).toContainText(CODE_NEEDLE);

    // 导航第二处：布点 21000 ∈ 块 5——计数与定位逐一吻合（布点精确一致）
    await page.keyboard.press('Enter');
    await expect(searchCount(page)).toHaveText('2/2');
    await expect(activeHitLine(page)).toHaveAttribute('data-line', String(BIG_NEEDLES[1]), {
      timeout: 15_000
    });

    // 扫描 IO 证据：扫到 EOF（末块 39 在列），全程无全量 200
    await settleStats(page, stats);
    expect(stats.ranges()).toContain(codeBlockRange(39));
    expectNoFullRead(stats);
    await expect(page.locator('.vv-error-card')).toHaveCount(0);
  } finally {
    await fake.close();
  }
});

// ---------------------------------------------------------------- SCAN-03

test('SCAN-03：Esc 取消后进度条收场移除、挂起应答有归宿、新搜索照常', async ({ page }) => {
  test.setTimeout(150_000);
  // stall 门：块 2 起 Range 应答挂起至 release——扫描确定性停在块 2 上
  const fake = await startStreamFakeServer(
    { 'scan10.js': makeCodeFile(BIG_JS_ROWS, BIG_NEEDLES) },
    { stall: { path: 'scan10.js', minStart: 2 * CODE_BLOCK_BYTES } }
  );
  try {
    const stats = new IoStats();
    await openCode(page, fake, stats, 'scan10.js');
    // 块 1 不受 stall 门限：采样时后台索引泵是否已推进至块 1 取决于机器速度（慢机
    // 采样前即拉，2026-10-14 CI 实证）——打开期下界探针+块 0 必达即可，精确计账由
    // 扫描停门断言（恰 3）在块 1 落地后承接
    expect(stats.count(), '打开应为探针+块 0（或泵已推进至块 1）').toBeLessThanOrEqual(3);

    await panelSearch(page, CODE_TRIGGER);
    await expect
      .poll(() => stats.ranges().includes(codeBlockRange(1)), { timeout: 15_000 })
      .toBe(true);
    await settleStats(page, stats);
    expect(stats.count(), '扫描应停在 stall 门上（探针+块 0+块 1）').toBe(3);
    await expect(scanBar(page)).toBeVisible(); // 扫描在飞：进度条在位

    // Esc 关闭面板 = search('') 令牌失效：扫描在下一检查点收场（挂起读解锁后）
    await page.keyboard.press('Escape');
    await expect(page.locator('.vv-search-panel')).toHaveCount(0);

    // 放行：挂起的块 2 应答落地（取消不悬挂）→ 扫描收场 → 进度条同步移除
    fake.releaseStall();
    await expect
      .poll(() => stats.ranges().includes(codeBlockRange(2)), { timeout: 15_000 })
      .toBe(true);
    await expect(scanBar(page)).toHaveCount(0, { timeout: 15_000 });
    await settleStats(page, stats);

    // 取消后新搜索照常完成（全文重扫 40 块，计数与定位正确）
    await panelSearch(page, CODE_NEEDLE);
    await expect(searchCount(page)).toHaveText('1/2', { timeout: 120_000 });
    await expect(activeHitLine(page)).toHaveAttribute('data-line', String(BIG_NEEDLES[0]), {
      timeout: 15_000
    });
    expectNoFullRead(stats);
    await expect(page.locator('.vv-error-card')).toHaveCount(0);
  } finally {
    await fake.close();
  }
});

// ---------------------------------------------------------------- SCAN-04

test('SCAN-04：在飞换 query 进度条属主接管——旧扫描收场不误删新扫描的条', async ({ page }) => {
  test.setTimeout(180_000);
  const fake = await startStreamFakeServer(
    { 'scan10.js': makeCodeFile(BIG_JS_ROWS, BIG_NEEDLES) },
    { stall: { path: 'scan10.js', minStart: 2 * CODE_BLOCK_BYTES } }
  );
  try {
    const stats = new IoStats();
    await openCode(page, fake, stats, 'scan10.js');

    // 扫描 A（无命中词）停在块 2：进度条在位（属主 A）
    await panelSearch(page, CODE_TRIGGER);
    await expect
      .poll(() => stats.ranges().includes(codeBlockRange(1)), { timeout: 15_000 })
      .toBe(true);
    await settleStats(page, stats);
    await expect(scanBar(page)).toBeVisible();

    // 在飞换 query B（布点词）：条不被移除，B 接管后渐进命中上文本（块 0 布点已入集）
    await replaceSearchQuery(page, CODE_NEEDLE);
    await expect(scanBar(page)).toBeVisible();
    await expect(scanBar(page)).toContainText('已命中 1 处', { timeout: 15_000 });

    // 放行：A 的挂起读落地 → A 收场（属主不符不得删条/覆写文本）；B 续扫自块 3 起
    fake.releaseStall();
    await expect
      .poll(() => stats.ranges().includes(codeBlockRange(3)), { timeout: 15_000 })
      .toBe(true); // 块 3 已发出 ⇒ A 必已退出（A 退出先于 B 前向拉块）
    await expect(scanBar(page)).toBeVisible(); // ← ffab040 属主语义回归锚

    // B 扫至 EOF：计数 1/2（B 的布点；A 零命中不入集）、条由 B 收场移除
    await expect(searchCount(page)).toHaveText('1/2', { timeout: 120_000 });
    await expect(scanBar(page)).toHaveCount(0);
    await expect(activeHitLine(page)).toHaveAttribute('data-line', String(BIG_NEEDLES[0]), {
      timeout: 15_000
    });
    expectNoFullRead(stats);
    await expect(page.locator('.vv-error-card')).toHaveCount(0);
  } finally {
    await fake.close();
  }
});

// ---------------------------------------------------------------- SCAN-05

test('SCAN-05：size 未知进度条 KB 形态「已扫描 N KB」+ EOF 短读收场移除', async ({ page }) => {
  test.setTimeout(120_000);
  // tree 条目省略 size（FileSource.size null → ctx.size null 窗口流式）；slowMs 撑采样窗
  const fake = await startStreamFakeServer(
    { 'nosize.js': { bytes: makeCodeFile(NOSIZE_ROWS, NOSIZE_NEEDLES) } },
    { slowMs: 100 }
  );
  try {
    const stats = new IoStats();
    await openCode(page, fake, stats, 'nosize.js');
    await installScanBarSampler(page);
    await panelSearch(page, CODE_NEEDLE);

    await expect(searchCount(page)).toHaveText('1/2', { timeout: 90_000 });
    await settleStats(page, stats);
    const samples = await collectScanBarSamples(page);

    // size 未知形态：「扫描中 · 已扫描 N KB（已命中 M 处）」，KB 数单调不减
    expect(samples.length, `应采样到进度条文本，实得 ${samples.length}`).toBeGreaterThanOrEqual(2);
    let prev = -1;
    for (const s of samples) {
      const m = /^扫描中 · 已扫描 (\d+) KB（已命中 \d+ 处）$/.exec(s);
      expect(m, `进度文本应为 size 未知 KB 形态: ${s}`).not.toBeNull();
      const kb = Number(m![1]);
      expect(kb, `KB 数应单调不减: ${samples.join(' | ')}`).toBeGreaterThanOrEqual(prev);
      prev = kb;
    }

    // EOF 短读收场：size 未知靠块 8 短读（2MB 整 = 8 块）探得 EOF——0 字节应答在列
    const eofProbe = stats.records.find((r) => r.range === 'bytes=2097152-2359295');
    expect(eofProbe, '应存在块 8 的 EOF 短读探测请求').toBeDefined();
    expect(eofProbe!.bytes, 'EOF 探测应答应为 0 字节短读').toBe(0);
    await expect(scanBar(page)).toHaveCount(0);
    expectNoFullRead(stats);
    await expect(page.locator('.vv-error-card')).toHaveCount(0);
  } finally {
    await fake.close();
  }
});

// ---------------------------------------------------------------- SCAN-06

test('SCAN-06：全文完成同键重搜零扫描 IO（短路）——计数与定位一致', async ({ page }) => {
  test.setTimeout(150_000);
  const fake = await startStreamFakeServer({ 'scan10.js': makeCodeFile(BIG_JS_ROWS, BIG_NEEDLES) });
  try {
    const stats = new IoStats();
    await openCode(page, fake, stats, 'scan10.js');
    await panelSearch(page, CODE_NEEDLE);
    await expect(searchCount(page)).toHaveText('1/2', { timeout: 120_000 });

    // 先步进到第二布点（改变 current/active 态），短路重搜完成后应回落首布点
    await page.keyboard.press('Enter');
    await expect(searchCount(page)).toHaveText('2/2');
    await expect(activeHitLine(page)).toHaveAttribute('data-line', String(BIG_NEEDLES[1]), {
      timeout: 15_000
    });
    await settleStats(page, stats); // gotoMatch(1) 的块 5 缺驻补拉落定
    const baseline = stats.count();

    // 同键重搜（面板保持开启、查询值不变）：全文完成（lastScanComplete）→ 短路零读
    await retriggerSameQuerySearch(page, CODE_NEEDLE);
    // 短路即时完成：计数回落 1/2 + 自动定位回首布点（证明 runSearch 真实跑过且秒回）
    await expect(searchCount(page)).toHaveText('1/2', { timeout: 10_000 });
    await expect(activeHitLine(page)).toHaveAttribute('data-line', String(BIG_NEEDLES[0]), {
      timeout: 10_000
    });
    await settleStats(page, stats);

    // 零扫描 IO：新请求至多 1 条且只能是 gotoMatch 的块 0 缺驻补拉（扫描后早期块
    // 普遍被 LRU 逐出；本例视口停在顶部持续触新块 0 时甚至为 0 条）。短路回归
    //（重扫全文）时为 39+ 块级增量必红
    const after = stats.records.slice(baseline);
    expect(
      after.filter((r) => r.range !== codeBlockRange(0)),
      `同键重搜不得产生块 0 之外的任何请求，实得 ${JSON.stringify(after.map((r) => r.range))}`
    ).toHaveLength(0);
    expect(after.length, '同键重搜 IO 至多为 gotoMatch 补块一次').toBeLessThanOrEqual(1);
    expectNoFullRead(stats);
    await expect(page.locator('.vv-error-card')).toHaveCount(0);
  } finally {
    await fake.close();
  }
});

// ---------------------------------------------------------------- SCAN-07

test('SCAN-07：取消收场后同 query 重搜续扫不短路——不重读已扫块、命中不重复', async ({ page }) => {
  test.setTimeout(180_000);
  const fake = await startStreamFakeServer(
    { 'scan10.js': makeCodeFile(BIG_JS_ROWS, BIG_NEEDLES) },
    { stall: { path: 'scan10.js', minStart: 2 * CODE_BLOCK_BYTES } }
  );
  try {
    const stats = new IoStats();
    await openCode(page, fake, stats, 'scan10.js');

    // 扫描停在块 2（已拉块 0/1）→ Esc 部分收场 → 放行（挂起块 2 落地）
    await panelSearch(page, CODE_NEEDLE);
    await expect
      .poll(() => stats.ranges().includes(codeBlockRange(1)), { timeout: 15_000 })
      .toBe(true);
    await settleStats(page, stats);
    await page.keyboard.press('Escape');
    await expect(page.locator('.vv-search-panel')).toHaveCount(0);
    fake.releaseStall();
    await expect
      .poll(() => stats.ranges().includes(codeBlockRange(2)), { timeout: 15_000 })
      .toBe(true);
    await settleStats(page, stats);

    // 重开面板输入同 query：取消收场不得短路（9ed0626）——必须续扫至 EOF
    await panelSearch(page, CODE_NEEDLE);
    await expect(searchCount(page)).toHaveText('1/2', { timeout: 120_000 });
    await expect(scanBar(page)).toHaveCount(0);
    await expect(activeHitLine(page)).toHaveAttribute('data-line', String(BIG_NEEDLES[0]), {
      timeout: 15_000
    });
    // 不重复不遗漏的 IO 面：探测头恰 1 次；扫描前沿块 1..39 全部被覆盖（续扫至 EOF）。
    // 不锁「恰一次」：块表 LRU（16）< 40 块，泵在取消窗口期的推进 + 续扫/回看的合法
    // backtracking 补块都会产生逐出重拉（与 IO-07 同语义）——锁的是无全量回归、EOF
    // 覆盖与命中不重复（下方 1/2→2/2），重复入集/重搜回环由终值计数锚定
    expect(
      stats.records.filter((r) => r.range === PROBE_RANGE),
      '探测头应恰 1 次'
    ).toHaveLength(1);
    const rangeCount = (range: string): number =>
      stats.records.filter((r) => r.range === range).length;
    for (let b = 1; b < 40; b++) {
      expect(rangeCount(codeBlockRange(b)), `块 ${b} 应被覆盖`).toBeGreaterThanOrEqual(1);
    }
    const b0 = rangeCount(codeBlockRange(0));
    expect(b0, `块 0 应 ≥1（打开首拉），实得 ${b0}`).toBeGreaterThanOrEqual(1);

    // 命中不重复入集：重搜后总数 2（非 3+），第二布点导航定位正确
    await page.keyboard.press('Enter');
    await expect(searchCount(page)).toHaveText('2/2');
    await expect(activeHitLine(page)).toHaveAttribute('data-line', String(BIG_NEEDLES[1]), {
      timeout: 15_000
    });
    expectNoFullRead(stats);
    await expect(page.locator('.vv-error-card')).toHaveCount(0);
  } finally {
    await fake.close();
  }
});

// ---------------------------------------------------------------- SCAN-08

test('SCAN-08：补块失败部分收场（失败块恰一次请求）→ 放行续扫补全缺失布点', async ({ page }) => {
  test.setTimeout(180_000);
  // fail 门：块 3 起 Range 应答 500 直至 releaseFail——扫描确定性死在块 3
  const fake = await startStreamFakeServer(
    { 'scan10.js': makeCodeFile(BIG_JS_ROWS, FAIL_NEEDLES) },
    { fail: { path: 'scan10.js', minStart: 3 * CODE_BLOCK_BYTES } }
  );
  try {
    const stats = new IoStats();
    await openCode(page, fake, stats, 'scan10.js');

    // ① 部分收场：非崩溃、以部分结果计数（仅门之前布点 5000 ∈ 块 1），进度条收场移除
    await panelSearch(page, CODE_NEEDLE);
    await expect(searchCount(page)).toHaveText('1/1', { timeout: 120_000 });
    await expect(scanBar(page)).toHaveCount(0);
    await expect(activeHitLine(page)).toHaveAttribute('data-line', String(FAIL_NEEDLES[0]), {
      timeout: 15_000
    });
    await settleStats(page, stats);
    // 失败无重试风暴（5cd1698 每块收敛 + continueFailed 停机闩）：500 只落在失败
    // 块 3 上且数量有界——泵（打开期未被扫描让位前的推进）与扫描各至多贡献一条，
    // 不会出现逐行/逐块重试风暴
    const fails = stats.records.filter((r) => r.status === 500);
    expect(fails.length, `应至少一条 500（失败块请求），实得 ${fails.length}`).toBeGreaterThanOrEqual(1);
    for (const f of fails) {
      expect(f.range, `500 应全在失败块 3，实得 ${f.range}`).toBe(codeBlockRange(3));
    }
    // 有界（无逐行/逐块风暴）：每个拉取生命周期各至多一条——泵闩（continueFailed
    // 停机）、扫描补拉（failedBlocks 每块一次）、扫描喂块（停机闩）合计 ≤3
    expect(fails.length, `500 应有界（≤3），实得 ${fails.length}`).toBeLessThanOrEqual(3);
    await expect(page.locator('.vv-error-card')).toHaveCount(0);

    // ② 失败因素解除后同键重搜：续扫自游标（块 3）起——缺失布点（21000 ∈ 块 5）补全
    fake.releaseFail();
    await settleStats(page, stats);
    const baseline = stats.count();
    await retriggerSameQuerySearch(page, CODE_NEEDLE);
    await expect(searchCount(page)).toHaveText('1/2', { timeout: 120_000 });
    await expect(activeHitLine(page)).toHaveAttribute('data-line', String(FAIL_NEEDLES[0]), {
      timeout: 15_000
    });
    await settleStats(page, stats);

    // 二阶段请求自块 3 起（游标续扫：首请求即失败块的 206 重试）；块 2 不重读
    //（游标之前的已索引块扫描面不再触达）；扫描前沿块 4..39 各恰 1 次。视口停在
    // 布点行 5000（块 1），其所在块被 LRU 逐出后经回看重拉补齐属合法 backtracking
    // 补块（不计入扫描面）
    const after = stats.records.slice(baseline);
    expect(
      after[0]?.range,
      `续扫应自失败块 3 起（游标回退），实得 ${JSON.stringify(after.map((r) => r.range))}`
    ).toBe(codeBlockRange(3));
    expect(
      after.filter((r) => r.range === codeBlockRange(2)),
      '块 2 不得重读'
    ).toHaveLength(0);
    const afterCount = (range: string): number =>
      after.filter((r) => r.range === range).length;
    expect(afterCount(codeBlockRange(3)), '块 3 重试应恰一次成功').toBe(1);
    expect(
      after.find((r) => r.range === codeBlockRange(3))?.status,
      '块 3 重试应为 206'
    ).toBe(206);
    for (let b = 4; b < 40; b++) {
      expect(afterCount(codeBlockRange(b)), `扫描前沿块 ${b} 应恰拉取一次`).toBe(1);
    }

    // 全程形状：块 3 的 206 成功恰一次（失败块无重试风暴；500 见上方有界断言）；
    // 块 0 至少打开时 1 次；终值无重复（2 布点 = 计数 2）
    const byRange = (range: string): number =>
      stats.records.filter((r) => r.range === range).length;
    expect(
      stats.records.filter((r) => r.range === codeBlockRange(3) && r.status === 206).length,
      '块 3 的 206 成功重试应恰一次'
    ).toBe(1);
    expect(byRange(codeBlockRange(0)), '块 0 应 ≥1（打开时）').toBeGreaterThanOrEqual(1);
    expectNoFullRead(stats);
    await expect(page.locator('.vv-error-card')).toHaveCount(0);
  } finally {
    await fake.close();
  }
});

// ---------------------------------------------------------------- SCAN-09

test('SCAN-09：全局搜索深行命中点击——revealLine 驱动续读后目标行真实渲染', async ({ page }) => {
  test.setTimeout(180_000);
  // ~19.5MB（79 块）单文件，唯一布点行 300000（块 73）。本地全局搜索单文件 >2MB 被
  // 过滤（GREP_MAX_FILE_BYTES），「命中点击打开」走远端 ripgrep 通道：假服务器
  // POST /api/search 固定 NDJSON 命中帧（1 起行号 300001），与真实 rg 同接口形状
  //——这也正是 BUG-09（全局搜索跳大文件）的真实触发通道
  const deep = makeCodeFile(DEEP_ROWS, [DEEP_ROW]);
  const fake = await startStreamFakeServer(
    { 'deep.js': deep },
    {
      searchHit: {
        file: 'deep.js',
        line: DEEP_ROW + 1,
        col: 17,
        text: codeLineText(deep, DEEP_ROW)
      }
    }
  );
  try {
    const stats = new IoStats();
    await openRemoteFile(page, fake, stats, 'deep.js'); // 仅连接建源，不预开文件

    // 全局搜索 → 命中帧 → 点击打开
    await page.keyboard.press('Control+Shift+F');
    await expect(page.locator('.vv-gsearch')).toBeVisible();
    await page.getByLabel('全局搜索内容').fill(CODE_NEEDLE);
    await expect(page.locator('.vv-gsearch-status')).toContainText('1 个命中', {
      timeout: 20_000
    });
    await page.locator('.vv-gsearch-row').click();
    await expect(page.locator('.vv-tab.active', { hasText: 'deep.js' })).toBeVisible();

    // revealLine 对未加载行（行 300000 > 首屏索引）驱动续读：目标行真实渲染且内容
    // 与构造一致（静默丢弃 = d37fcd0 修复面回归）。深行所在块 73 必被拉取
    const pre = page.locator('.vv-code-pre');
    await expect(pre.locator(`.vv-code-line[data-line="${DEEP_ROW}"]`)).toContainText(
      CODE_NEEDLE,
      { timeout: 60_000 }
    );
    await settleStats(page, stats);

    // IO 证据：续读按 256KB 块步进推进至深行（块 73 在列、请求量 ≥ 探针+74 块），
    // 全程无全量 200、无错误卡片
    expect(stats.count(), 'revealLine 应驱动逐块续读（探针+≥74 块）').toBeGreaterThanOrEqual(75);
    expect(stats.ranges()).toContain(codeBlockRange(73));
    expectNoFullRead(stats);
    await expect(page.locator('.vv-error-card')).toHaveCount(0);
  } finally {
    await fake.close();
  }
});

// ---------------------------------------------------------------- SCAN-10

test('SCAN-10：回看重拉首拒停机闩——无请求风暴、占位维持、用户动作重试成功', async ({ page }) => {
  test.setTimeout(150_000);
  // 6MB = 24 块 > 块表 LRU 16：贴底至 EOF 后块 0 必被逐出；failOnce 门只对块 0 整块
  // Range 的第 2 次请求（首轮回看重拉）应 500——skip=1 放过打开期的首次拉取，探测头
  // 与重试均不受影响。stall 门（块 9+）为逐出前提：泵时代下打开期泵即拉完全文件且
  // 顶部视口每次 remount 都触新块 0（永不逐出）——改由滚动续读拉入块 9..23，LRU
  // 不变量（16 容量 + 块 0 停触）保证逐出
  const fake = await startStreamFakeServer(
    { 'back.js': makeCodeFile(BACKTRACK_ROWS) },
    {
      failOnce: { path: 'back.js', exact: codeBlockRange(0), skip: 1, fails: 1 },
      stall: { path: 'back.js', minStart: 9 * CODE_BLOCK_BYTES }
    }
  );
  try {
    const stats = new IoStats();
    const pre = await openCode(page, fake, stats, 'back.js');

    // 滚动到底（块 0 被逐出）→ 滚回顶部：缺块占位行 + 回看重拉（首拒）。
    // 逐出必须是事实而非推断：视口先离顶（块 0 停触）再放行 stall 门，块 9..23 的
    // 插入序全部落在块 0 最后一次触新之后——LRU(16) 不变量保证块 0 逐出；随后贴底
    // 循环至 EOF（泵已恢复，拉取与循环殊途同归）
    await pre.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    fake.releaseStall();
    await pre.evaluate(
      async (el, last) => {
        // 800×50ms：移动视口（375×667，dpr2）渲染与滚动联动慢于桌面，实测 400×40ms
        // 预算内末行未入窗（索引已完整，纯渲染跟进慢）——放宽预算不改断言语义
        for (let i = 0; i < 800; i++) {
          el.scrollTop = el.scrollHeight;
          await new Promise((r) => setTimeout(r, 50));
          if (el.querySelector(`[data-line="${last}"]`) !== null) return;
        }
        throw new Error('code 续读未在预算轮次内到达 EOF');
      },
      BACKTRACK_ROWS - 1
    );
    await expect
      .poll(
        () => new Set(stats.records.map((r) => r.range ?? '')).size,
        { timeout: 30_000 }
      )
      .toBeGreaterThanOrEqual(18); // 探针 + 17 块（块 0 必已被 LRU 逐出）
    await settleStats(page, stats);
    await pre.evaluate((el) => {
      el.scrollTop = 0;
    });
    const row0 = pre.locator('.vv-code-line[data-line="0"]');
    await expect(row0).toBeVisible();
    await expect(row0.locator('.vv-code-body'), '缺块行应为占位行（无正文）').toHaveCount(0);
    // 微移滚动触发回看重拉评估：占位行入队（lineAvailable）与 maybeContinue 消费
    // 挂在滚动/refresh 回调面上，入队后的首个事件可能已消费完毕——微移保证队列
    // 必有一次重评（确定性，不依赖隐式时序）
    await pre.evaluate((el) => {
      el.scrollTop = 30;
    });

    // 首次回看重拉 500 恰一次（failOnce）
    await expect
      .poll(() => stats.records.filter((r) => r.range === codeBlockRange(0)).length, {
        timeout: 10_000
      })
      .toBe(2); // 打开 206 + 重拉 500
    await settleStats(page, stats);
    expect(
      stats.records.filter((r) => r.status === 500),
      '应恰有一次 500（首拒）'
    ).toHaveLength(1);

    // 停机闩（90f4ca5）：失败后任何自动重评不得重试——1.5s 内零新增请求、占位维持
    const frozen = stats.count();
    await page.waitForTimeout(1_500);
    await settleStats(page, stats);
    expect(stats.count(), '停机闩下不得出现请求风暴').toBe(frozen);
    await expect(row0.locator('.vv-code-body')).toHaveCount(0);
    await expect(page.locator('.vv-error-card')).toHaveCount(0);

    // 用户滚动动作（滚离又滚回）解除闩 → 单次重试成功：顶部行真实渲染
    await pre.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await page.waitForTimeout(150);
    await pre.evaluate((el) => {
      el.scrollTop = 0;
    });
    await expect(row0).toContainText('const v0', { timeout: 15_000 });
    await settleStats(page, stats);
    const r0 = stats.records.filter((r) => r.range === codeBlockRange(0));
    expect(r0.map((r) => r.status), '块 0 应恰为 打开 206 / 首拒 500 / 重试 206').toEqual([
      206, 500, 206
    ]);
    expectNoFullRead(stats);
    await expect(page.locator('.vv-error-card')).toHaveCount(0);
  } finally {
    await fake.close();
  }
});

// ---------------------------------------------------------------- SCAN-11

test('SCAN-11：挂起阶段命中渐进——进度条命中数与行级背景先于全文完成可见', async ({ page }) => {
  test.setTimeout(180_000);
  // stall 门（块 1+）+ slowMs=120：扫描对必驻留的块 0 布点即时计数（进度条命中数
  // 免节流直写），随后确定性挂死在块 1 上供挂起阶段断言。门不放在块 2+：打开期
  // 索引泵会抢先挂死在首个越门块上，扫描启动时点的驻留面在慢机上不可先验
  const fake = await startStreamFakeServer(
    { 'scan10.js': makeCodeFile(BIG_JS_ROWS, BIG_NEEDLES) },
    { stall: { path: 'scan10.js', minStart: CODE_BLOCK_BYTES }, slowMs: 120 }
  );
  try {
    const stats = new IoStats();
    const pre = await openCode(page, fake, stats, 'scan10.js');
    await panelSearch(page, CODE_NEEDLE);
    await expect(searchCount(page)).toHaveText('无结果');

    // 行级渐进上屏：滚至布点行 1000，行级命中背景与词级命中先于全文完成可见
    await pre.evaluate((el) => {
      el.scrollTop = 1000 * 20; // LINE_HEIGHT = 20（code.ts 同源）
    });
    const hitRow = pre.locator('.vv-code-line[data-line="1000"]');
    await expect(hitRow).toHaveClass(/vv-search-hit-line/, { timeout: 10_000 });
    await expect(hitRow).toContainText(CODE_NEEDLE);

    // 放行后续扫至 EOF：终值正确、条收场移除、自动定位首布点
    fake.releaseStall();
    await expect
      .poll(() => stats.ranges().includes(codeBlockRange(1)), { timeout: 30_000 })
      .toBe(true);
    await expect(searchCount(page)).toHaveText('1/2', { timeout: 120_000 });
    await expect(scanBar(page)).toHaveCount(0);
    await expect(activeHitLine(page)).toHaveAttribute('data-line', String(BIG_NEEDLES[0]), {
      timeout: 15_000
    });
    expectNoFullRead(stats);
    await expect(page.locator('.vv-error-card')).toHaveCount(0);
  } finally {
    fake.releaseStall();
    await fake.close();
  }
});
