import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import {
  IoStats,
  MB,
  UrlStats,
  openRemoteFile,
  openTreeFile,
  openUrlFile,
  settleStats,
  startStreamFakeServer
} from './b-stream-resilience-helpers';

/**
 * IO 流式公共防线降级矩阵 e2e（DEG-01~09；docs/e2e/io-degrade-matrix.md）：
 * dispatcher 读策略（packages/core/src/dispatch/dispatcher.ts）与 BlockStream 回退
 * 语义（packages/render-text/src/blockStream.ts）的降级矩阵整行锚点——b-io-streaming
 * （IO-01~11）只覆盖「rangeCapable + Range 服务器 + size 已知」的窗口流式正路，本
 * spec 锚定其余矩阵行：
 * - DEG-01/09：url store（!rangeCapable，size null）→ dispatcher 全量 ctx（=现状），
 *   TopBar「粘贴文件 URL」+ page.route 拦截（t-shell SHELL-04 先例）；
 * - DEG-02：Range-less 200-only 服务器正锚——探针即全量、head 已含全量 → 块全预置
 *   （夹具 3MB ≤ 块表 LRU 16×256KB=4MB，超限逐出面见 DEG-03 的回退语义）、恰 1 请求、
 *   滚动零新增（「200 全量是允许形态」的正向用例，b-io-streaming:213 自认缺口）；
 * - DEG-03：探针 206 + 块读 200 超长 → BlockStream 抛弃流式缓冲全量重取（宁切全量
 *   不错位，d3c9e0a / BUG-103）——恰 3 请求、末行零错位、此后零增量；
 * - DEG-04：tree 条目省略 size（size 未知）→ jsonl 仍窗口流式、逐块 Range、短读探 EOF；
 * - DEG-05：读策略边界（dispatcher.ts:37 FULL_LIMIT 1MB）——≤1MB 全量直读（恰 1 请求
 *   无 Range）vs >1MB head 探测窗口流式；
 * - DEG-06：流内逐块 UTF-8 嗅探判非 → memoizedFullRead 补拉 + redetectWithFull 精判
 *   重渲（5c92269 / BUG-104）——无 U+FFFD 扩散、状态栏编码翻转 gb18030；
 * - DEG-07/08：SSE changed 重渲染免全量重读（IO-03 的 jsonl/code 版）——增量仅
 *   探针 + 受影响窗口块。
 *
 * 夹具全部 spec 内构造（恰界尺寸/坏位/GBK 字节/布点），假服务器行为（rangeless 两档
 * /SSE 注入/条目省略 size）由 b-stream-resilience-helpers.ts startStreamFakeServer
 * 提供；URL 场景经 UrlStats 计量（url store 直连 fetch 不经 /api/file）。
 */

const JSONL_ROW = 512; // jsonl 行字节（含 \n）：行 i 起始偏移 = i×512（纯 ASCII 可预算）
const CODE_ROW = 64; // code 行字节（含 \n）：行 i 起始偏移 = i×64
const CODE_BLOCK = 256 * 1024; // 窗口块大小（jsonl/code 同源 256KB）

/**
 * 恰 rowBytes 字节/行的 jsonl（含 \n）：`{"id":i,"pad":"<填充>"}`，填充段以 marks[i]
 * （布点标记）或 'a' 补齐。纯 ASCII：字节数 === 字符数；卡片为 JSON.stringify 2 缩进
 * 的 pretty 正文（`"id": N` 带空格，t-open-with OPEN-05 / IO-05 同款断言面）。
 */
function makeJsonl(rows: number, rowBytes: number, marks?: Record<number, string>): Uint8Array {
  const parts = new Array<string>(rows);
  for (let i = 0; i < rows; i++) {
    const head = `{"id":${i},"pad":"`;
    const fillLen = rowBytes - 1 - head.length - 2;
    const mark = marks?.[i] ?? '';
    if (mark.length > fillLen) throw new Error(`布点标记超出行填充段: 行 ${i}`);
    parts[i] = `${head}${mark}${'a'.repeat(fillLen - mark.length)}"}\n`;
  }
  return new TextEncoder().encode(parts.join(''));
}

/**
 * 恰 64 字节/行的 js（含 \n）：`const v{i} = '<core><填充>';\n`——行 i 起始偏移可预算
 * （块号 = floor(i×64/256KB)）；marks[i] 换入行 core 作文本布点（搜索/更新断言锚）。
 */
function makeCodeFile(rows: number, marks?: Record<number, string>): Uint8Array {
  const parts = new Array<string>(rows);
  for (let i = 0; i < rows; i++) {
    const head = `const v${i} = '`;
    const core = marks?.[i] ?? '';
    const pad = CODE_ROW - 1 - head.length - 2 - core.length;
    if (pad < 0) throw new Error(`布点标记超出行长: 行 ${i}`);
    parts[i] = `${head}${core}${'x'.repeat(pad)}';\n`;
  }
  return new TextEncoder().encode(parts.join(''));
}

/**
 * DEG-04 专载：2MB（4096×512B 整块）+ 末行短行（137B）= 2,097,289 字节——末块 137B
 * 短读即 EOF 证据（size 未知形态靠短读探 EOF，非恰好整块边界）。
 */
function makeNoSizeJsonl(): Uint8Array {
  const parts: string[] = [];
  for (let i = 0; i < 4096; i++) {
    const head = `{"id":${i},"pad":"`;
    parts.push(`${head}${'a'.repeat(512 - 1 - head.length - 2)}"}\n`);
  }
  const head = `{"id":4096,"pad":"`;
  parts.push(`${head}${'a'.repeat(137 - 1 - head.length - 2)}"}\n`);
  return new TextEncoder().encode(parts.join(''));
}

/** '编码嗅探降级验证' 的 GBK 字节（生成时经 python3 gbk 编码 + 回解校验，16 字节） */
const GBK_PHRASE = new Uint8Array([
  177, 224, 194, 235, 208, 225, 204, 189, 189, 181, 188, 182, 209, 233, 214, 164
]);

/** DEG-06 载体：2.25MB（9×256KB 块）= 36864 行 × 64B——
 * 前 1MB（块 0~3）纯 ASCII 行：head 8KB 探测判 utf-8（窗口选路的误判前提）；
 * 块 4 起 GBK 中文注释行（`// 编码嗅探降级验证 id=N`）：喂块面嗅探判定面，每块
 * 4096 行 × 16 GBK 字节远超 UTF8_SNIFF_ILLEGAL_MIN=8 与 1% 阈，判定无边缘性。 */
const SNIFF_ROWS = 36_864; // 2.25MB / 64
const SNIFF_BYTES = SNIFF_ROWS * CODE_ROW;
const SNIFF_ASCII_ROWS = 16_384; // 前 1MB / 64：脏块自块 4（行 16384）起

function makeSniffFile(): Uint8Array {
  const out = new Uint8Array(SNIFF_BYTES);
  const ascii = new TextEncoder();
  for (let i = 0; i < SNIFF_ROWS; i++) {
    const off = i * CODE_ROW;
    if (i < SNIFF_ASCII_ROWS) {
      const head = `const v${i} = '`;
      const line = `${head}${'x'.repeat(CODE_ROW - 1 - head.length - 2)}';\n`;
      out.set(ascii.encode(line), off);
      continue;
    }
    // GBK 注释行：'// ' + GBK 短语 + ' id=<i>' + '.' 填充 + '\n'，恰 64 字节
    let p = off;
    out[p++] = 0x2f;
    out[p++] = 0x2f;
    out[p++] = 0x20;
    out.set(GBK_PHRASE, p);
    p += GBK_PHRASE.length;
    const tail = ` id=${i}`;
    out.set(ascii.encode(tail), p);
    p += tail.length;
    while (p < off + CODE_ROW - 1) out[p++] = 0x2e;
    out[p] = 0x0a;
  }
  return out;
}

/** DEG-09 专载：1MB 二进制（0x41 填充，无 magic/EOCD 签名 → 「未知二进制」），
 * 0xde 0xad 双布点（hex 搜索命中，分属 hex 行 0x30000 / 0x60000）。 */
function makeBlob(): Uint8Array {
  const bytes = new Uint8Array(MB);
  bytes.fill(0x41);
  for (const off of [0x30000, 0x60000]) {
    bytes[off] = 0xde;
    bytes[off + 1] = 0xad;
  }
  return bytes;
}

/** 当前 hex 命中行（active 档；has 须为文档级 page.locator，b-io-streaming 同款） */
function activeHexHitRow(page: Page) {
  return page.locator('.vv-hex-row', { has: page.locator('.vv-hex-hit-active') });
}

// ---------------------------------------------------------------- DEG-01

test('DEG-01：url store（!rangeCapable）全量 ctx——TopBar URL 打开 jsonl 恰 1 请求无 Range、全量形态', async ({
  page
}) => {
  test.setTimeout(60_000);
  const bytes = makeJsonl(4096, JSONL_ROW); // 2MB = 8 块（≤ LRU 16，head 全预置零逐出）
  await page.route('https://fake.asset.test/url-big.jsonl', (route) =>
    route.fulfill({
      status: 200,
      // 跨源 fetch：显式 ACAO（t-shell SHELL-04/cors 反例的正向面）
      headers: { 'access-control-allow-origin': '*', 'content-type': 'application/octet-stream' },
      body: Buffer.from(bytes)
    })
  );
  const stats = new UrlStats((u) => u.host === 'fake.asset.test' && u.pathname === '/url-big.jsonl');
  stats.attach(page);
  await openUrlFile(page, 'https://fake.asset.test/url-big.jsonl', 'url-big.jsonl');

  // 全量 ctx（head 即全量 → 块全预置 → 首屏排空喂索引）：状态条直接落「共 N 行」
  await expect(page.locator('.vv-jsonl')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.vv-jsonl-status')).toContainText('共 4096 行', { timeout: 20_000 });
  await settleStats(page, stats);
  // !rangeCapable → 单请求、无 Range 头、恰全尺寸（url store read 忽略 range 参数，
  // dispatcher 探针与补拉共享同一次 fetch 的 memo）
  expect(stats.count(), 'url 打开应恰 1 次网络请求（探针即全量，补拉走缓存）').toBe(1);
  expect(stats.records[0]?.range, 'url store 全量请求不得携带 Range 头').toBeNull();
  expect(stats.records[0]?.bytes).toBe(2 * MB);
  // 渲染内容正确（非错误卡/截断）
  await expect(page.locator('.vv-jsonl-card', { hasText: '"id": 0' })).toBeVisible();
  await expect(page.locator('.vv-error-card')).toHaveCount(0);
});

// ---------------------------------------------------------------- DEG-02

test('DEG-02：Range-less 200-only 服务器正锚——jsonl 探针即全量恰 1 请求，滚动/回顶零新增', async ({
  page
}) => {
  test.setTimeout(120_000);
  // 3MB = 12 块 ≤ 块表 LRU 16：head（探针即全量）预置全部块零逐出——「块全预置、
  // 零后续请求」语义成立的前提（>4MB 构造期 evictOverflow 逐出头块，见 §4.3 边界）
  const fake = await startStreamFakeServer(
    { 'rl-all-3mb.jsonl': makeJsonl(6144, JSONL_ROW) },
    { rangeless: 'all' }
  );
  try {
    const stats = new IoStats();
    await openRemoteFile(page, fake, stats, 'rl-all-3mb.jsonl');
    // size 已知 3MB > FULL_LIMIT → 探针带 Range bytes=0-8191，服务器忽略 Range 回
    // 200 全量：head 已含全量 → 首屏排空喂索引直达 EOF「共 6144 行」
    await expect(page.locator('.vv-jsonl')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('.vv-jsonl-status')).toContainText('共 6144 行', { timeout: 20_000 });
    await settleStats(page, stats);
    expect(stats.count(), '探针即全量：除探针外不得有任何块请求').toBe(1);
    expect(stats.records[0]?.range, '探针请求形状（Range 头在，响应 200 全量）').toBe('bytes=0-8191');
    expect(stats.records[0]?.bytes, '响应体恰全尺寸（200 全量而非 206 切片）').toBe(3 * MB);

    // 滚到底 + 回顶：全量在手（EOF 已确认、一切块驻留），零新增请求、末行内容正确
    const scroll = page.locator('.vv-jsonl-scroll');
    await scroll.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await expect(page.locator('.vv-jsonl-card', { hasText: '"id": 6143' })).toBeVisible({
      timeout: 10_000
    });
    await scroll.evaluate((el) => {
      el.scrollTop = 0;
    });
    await settleStats(page, stats);
    expect(stats.count(), '滚动/回顶不得再发任何 /api/file 请求').toBe(1);
    await expect(page.locator('.vv-error-card')).toHaveCount(0);
  } finally {
    await fake.close();
  }
});

// ---------------------------------------------------------------- DEG-03

test('DEG-03：探针 206 + 块读 200 超长→全量切换恰 3 请求，末行零错位、此后零增量', async ({ page }) => {
  test.setTimeout(120_000);
  // after-probe：仅 bytes=0-8191 探针回 206，其余 Range 请求一律 200 全量——
  // 首块请求即超长返回，BlockStream 抛弃流式缓冲向 ctx 重取全量（宁切全量不错位）
  const fake = await startStreamFakeServer(
    { 'rl-ap-10mb.js': makeCodeFile(163_840) },
    { rangeless: 'after-probe' }
  );
  try {
    const stats = new IoStats();
    await openRemoteFile(page, fake, stats, 'rl-ap-10mb.js');
    await expect(page.locator('.vv-code-pre').locator('.vv-code-line').first()).toBeVisible({
      timeout: 20_000
    });
    await settleStats(page, stats);

    // 恰 3 请求：探针 206 8KB + 首块请求 200 超长 + 全量重取 200（blockStream.ts
    // 200-回退：read({0, MAX}) 端点钳制语义）；第 4 条 = 流式路径残留回归
    expect(stats.count(), '全量切换应恰为 探针+块读+全量重取 3 个请求').toBe(3);
    expect(stats.records[0]?.range).toBe('bytes=0-8191');
    expect(stats.records[0]?.bytes).toBe(8192);
    expect(stats.records[1]?.range, '次请求应为块 0 整块区间（被 200 全量回答）').toBe(
      'bytes=0-262143'
    );
    expect(stats.records[1]?.bytes, '块读收到 200 全量（超长返回 = 回退触发证据）').toBe(10 * MB);
    expect(stats.records[2]?.range, '全量重取经 ctx.read({0, MAX}) 原样透传').toBe(
      'bytes=0-9007199254740991'
    );
    expect(stats.records[2]?.bytes).toBe(10 * MB);

    // 全量底座在手：滚到底末行真实渲染且零错位零新增（d3c9e0a：宁切全量不错位——
    // 末行必须是构造内容 v163839，而非文件头字节错位拼进末块坐标）
    const pre = page.locator('.vv-code-pre');
    await pre.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await expect(pre.locator('.vv-code-line[data-line="163839"]')).toContainText(
      'v163839',
      { timeout: 10_000 }
    );
    await settleStats(page, stats);
    expect(stats.count(), '全量底座就绪后滚动零 IO').toBe(3);
    await expect(pre).not.toContainText('\uFFFD');
    await expect(page.locator('.vv-error-card')).toHaveCount(0);
  } finally {
    await fake.close();
  }
});

// ---------------------------------------------------------------- DEG-04

test('DEG-04：size 未知（tree 无 size）jsonl 仍窗口流式——逐块 Range + 短读探 EOF「共 N 行」', async ({
  page
}) => {
  test.setTimeout(120_000);
  // 条目省略 size：{ bytes } 形态（treeSize 缺省）→ FileSource.size null
  const fake = await startStreamFakeServer({
    'nosize-2mb.jsonl': { bytes: makeNoSizeJsonl() }
  });
  try {
    const stats = new IoStats();
    await openRemoteFile(page, fake, stats, 'nosize-2mb.jsonl');
    // 首屏窗口流式（探针 + 前 2 块）——「已加载 N 行」= 窗口路径信号（EOF 未确认）
    await expect(page.locator('.vv-jsonl')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('.vv-jsonl-status')).toHaveText('已加载 1024 行', { timeout: 20_000 });
    await settleStats(page, stats);
    expect(stats.count()).toBe(3); // 探针 + 块 0 + 块 1（size 未知预取退化为逐块顺序）
    for (const r of stats.records) {
      expect(r.range, 'size 未知流式全程必须逐请求 Range（200 全量 = 选路回归）').not.toBeNull();
      expect(r.bytes as number).toBeLessThanOrEqual(CODE_BLOCK);
    }

    // 贴底循环续读（一次一块）至短读探 EOF（末块 137B）→「共 4097 行」
    const scroll = page.locator('.vv-jsonl-scroll');
    await scroll.evaluate(async (el) => {
      const statusEl = el.parentElement!.querySelector('.vv-jsonl-status')!;
      for (let i = 0; i < 300; i++) {
        el.scrollTop = el.scrollHeight;
        await new Promise((r) => setTimeout(r, 50));
        if (statusEl.textContent?.startsWith('共 ')) return;
      }
      throw new Error('size 未知 jsonl 续读未在预算轮次内到达 EOF');
    });
    await expect(page.locator('.vv-jsonl-status')).toContainText('共 4097 行', { timeout: 10_000 });
    await settleStats(page, stats);
    // 请求形状：探针 8KB + 9 块（块 0~8）；末块 137B 短读 = EOF 证据；末块请求端点
    // 未预钳（size 未知满请求，服务器钳制短读）
    expect(stats.count(), '应恰为 探针+9 块（短读末块）').toBe(10);
    const last = stats.records[9];
    expect(last?.range).toBe('bytes=2097152-2359295');
    expect(last?.bytes, '末块短读 137B（EOF 靠短读发现而非 size 预钳）').toBe(137);
    for (const r of stats.records) {
      expect(r.range).not.toBeNull();
    }
    // EOF 后末行真实渲染（短块行切片正确）
    await scroll.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await expect(page.locator('.vv-jsonl-card', { hasText: '"id": 4096' })).toBeVisible({
      timeout: 10_000
    });
    await expect(page.locator('.vv-error-card')).toHaveCount(0);
  } finally {
    await fake.close();
  }
});

// ---------------------------------------------------------------- DEG-05

test('DEG-05：读策略边界 ≤1MB 全量直读 vs >1MB 窗口流式（dispatcher FULL_LIMIT）', async ({ page }) => {
  test.setTimeout(120_000);
  const fake = await startStreamFakeServer({
    // 1048576 ≤ 1MB（恰界含）：size 已知 → 直接全量 read（保 detect 编码精判）；
    // 恰 4 整块（块对齐）——head 预置无部分块，不触发「部分块首拉重拉替换」的第二读
    'boundary-1mb.jsonl': makeJsonl(2048, JSONL_ROW),
    // 2097152 > 1MB：head 探测窗口流式
    'boundary-2mb.jsonl': makeJsonl(4096, JSONL_ROW)
  });
  try {
    const stats = new IoStats();

    // ① ≤1MB：恰 1 请求、无 Range 头、全量形态「共 N 行」（head=full 预置全部块）
    await openRemoteFile(page, fake, stats, 'boundary-1mb.jsonl');
    await expect(page.locator('.vv-jsonl')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('.vv-jsonl-status')).toContainText('共 2048 行', { timeout: 20_000 });
    await settleStats(page, stats);
    expect(stats.count(), '≤1MB 应恰 1 次全量 read').toBe(1);
    expect(stats.records[0]?.range, '全量直读 read() 不带 range → 无 Range 头').toBeNull();
    expect(stats.records[0]?.bytes).toBe(MB);

    // ② >1MB：探针 206 8KB + 窗口块 Range，「已加载 N 行」
    const baseline = stats.count();
    await openTreeFile(page, 'boundary-2mb.jsonl'); // 内含活动 tab 可见等待
    await expect(page.locator('.vv-jsonl-status')).toHaveText('已加载 1024 行', { timeout: 20_000 });
    await settleStats(page, stats);
    const delta = stats.records.slice(baseline);
    expect(delta.length, '应恰为 探针+2 块').toBe(3);
    expect(delta[0]?.range).toBe('bytes=0-8191');
    expect(delta[0]?.bytes).toBe(8192);
    for (const r of delta) {
      expect(r.range, '>1MB 窗口路径全程逐请求 Range').not.toBeNull();
      expect(r.bytes as number).toBeLessThanOrEqual(CODE_BLOCK);
    }
  } finally {
    await fake.close();
  }
});

// ---------------------------------------------------------------- DEG-06

test('DEG-06：code 流内 UTF-8 嗅探判非→全量重渲——编码精判 gb18030、无 U+FFFD 扩散', async ({
  page
}) => {
  test.setTimeout(180_000);
  const fake = await startStreamFakeServer({ 'sniff-gbk.js': makeSniffFile() });
  try {
    const stats = new IoStats();
    await openRemoteFile(page, fake, stats, 'sniff-gbk.js');
    const pre = page.locator('.vv-code-pre');
    await expect(pre.locator('.vv-code-line').first()).toBeVisible({ timeout: 20_000 });
    // 基线：head 8KB 纯 ASCII → 窗口模式 + 编码误判 utf-8（状态栏元数据段）
    await expect(page.locator('.vv-statusbar')).toContainText('编码: utf-8', { timeout: 30_000 });
    await settleStats(page, stats);
    expect(stats.count(), '首屏应恰为 探针+块 0').toBe(2);

    // 贴底滚动驱动喂块（块 1→4 逐块推进）；块 4（首脏块）喂入即判非 UTF-8 → 停喂 +
    // memoizedFullRead 全量补拉 + redetectWithFull 精判 gb18030 全量重渲（状态栏
    // 250ms 轮询翻转）——以状态栏编码翻转为降级收口信号
    await page.waitForFunction(
      () => {
        const el = document.querySelector('.vv-code-pre');
        if (el) el.scrollTop = el.scrollHeight;
        return document.querySelector('.vv-statusbar')?.textContent?.includes('编码: gb18030') ?? false;
      },
      undefined,
      { polling: 120, timeout: 120_000 }
    );
    await settleStats(page, stats);

    // 计量：块 1~4 逐块 Range + 全量补拉恰 1 条（memoizedFullRead 一次性；retry 免重拉）
    expect(stats.count()).toBe(2 + 4 + 1);
    const fullFetches = stats.records.filter((r) => r.range === 'bytes=0-9007199254740991');
    expect(fullFetches.length, '全量补拉恰 1 条').toBe(1);
    expect(fullFetches[0]?.bytes, '补拉恰全尺寸 2.25MB').toBe(SNIFF_BYTES);
    for (const r of stats.records) {
      expect(r.range, '降级全程不得出现 200 全量形态（补拉走 Range 透传 206 钳制）').not.toBeNull();
    }

    // 降级后滚动零 IO（全量实例在手）+ 中文行解码正确（gb18030 全量解码，非 U+FFFD）
    const baseline = stats.count();
    await pre.evaluate((el) => {
      el.scrollTop = 0;
      el.scrollTop = el.scrollHeight;
    });
    await expect(pre.locator(`.vv-code-line[data-line="${SNIFF_ROWS - 1}"]`)).toContainText(
      `编码嗅探降级验证 id=${SNIFF_ROWS - 1}`,
      { timeout: 15_000 }
    );
    await settleStats(page, stats);
    expect(stats.count(), '降级完成后滚动零新增请求').toBe(baseline);
    await expect(pre).not.toContainText('\uFFFD');
    await expect(page.locator('.vv-statusbar')).toContainText('编码: gb18030');
    await expect(page.locator('.vv-error-card')).toHaveCount(0);
  } finally {
    await fake.close();
  }
});

// ---------------------------------------------------------------- DEG-07

test('DEG-07：jsonl SSE changed 重渲染免全量重读——增量仅探针+受影响窗口块，更新行可见', async ({
  page
}) => {
  test.setTimeout(120_000);
  const before = makeJsonl(6144, JSONL_ROW, { 3: 'sse-before-marker' });
  const after = makeJsonl(6144, JSONL_ROW, { 3: 'sse-after-marker-9f2c' });
  const fake = await startStreamFakeServer({ 'sse-3mb.jsonl': before });
  try {
    const stats = new IoStats();
    await openRemoteFile(page, fake, stats, 'sse-3mb.jsonl');
    await expect(page.locator('.vv-jsonl')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('.vv-jsonl-status')).toHaveText('已加载 1024 行', { timeout: 20_000 });
    // 变更前行 3（块 0 首屏可见）内容在位
    await expect(page.locator('.vv-jsonl-card', { hasText: 'sse-before-marker' })).toBeVisible();
    await settleStats(page, stats);
    const bytesBefore = stats.total();
    const countBefore = stats.count();

    // 外部变更：替换字节表 + SSE changed 帧 → rev++ 重渲染（销毁重建，块缓存不继承）
    fake.updateFile('sse-3mb.jsonl', after);
    fake.notifyChanged(['sse-3mb.jsonl']);
    await expect(page.locator('.vv-jsonl-card', { hasText: 'sse-after-marker-9f2c' })).toBeVisible({
      timeout: 30_000
    });
    await expect(page.locator('.vv-jsonl-card', { hasText: 'sse-before-marker' })).toHaveCount(0);
    await settleStats(page, stats);

    // 增量 = 探针 + 受影响窗口块（块 0/1），全部带 Range——10MB/3MB 级全量增幅即回归
    const delta = stats.records.slice(countBefore);
    expect(delta.length).toBeGreaterThanOrEqual(3);
    const growth = stats.total() - bytesBefore;
    expect(growth, `SSE 重渲染增量 ${growth}B 应为窗口级（<2MB）`).toBeLessThan(2_000_000);
    for (const r of delta) {
      expect(r.range, '重渲染请求必须带 Range（200 全量 = 整件重读回归）').not.toBeNull();
      expect(r.bytes as number).toBeLessThanOrEqual(CODE_BLOCK);
    }
    await expect(page.locator('.vv-error-card')).toHaveCount(0);
  } finally {
    await fake.close();
  }
});

// ---------------------------------------------------------------- DEG-08

test('DEG-08：code SSE changed 重渲染免全量重读——增量仅探针+块 0，更新行渲染正确', async ({
  page
}) => {
  test.setTimeout(120_000);
  // 10MB（40 块）；更新行布点块 0 首屏可见（行 5）——窗口级重读判据不受行位影响，
  // 且免去中部定位的额外块拉取噪声
  const before = makeCodeFile(163_840, { 5: 'sse-before-qz7' });
  const after = makeCodeFile(163_840, { 5: 'sse-after-k4md' });
  const fake = await startStreamFakeServer({ 'sse-10mb.js': before });
  try {
    const stats = new IoStats();
    await openRemoteFile(page, fake, stats, 'sse-10mb.js');
    const pre = page.locator('.vv-code-pre');
    await expect(pre.locator('.vv-code-line[data-line="5"]')).toContainText('sse-before-qz7', {
      timeout: 20_000
    });
    await settleStats(page, stats);
    const bytesBefore = stats.total();
    const countBefore = stats.count();

    fake.updateFile('sse-10mb.js', after);
    fake.notifyChanged(['sse-10mb.js']);
    await expect(pre.locator('.vv-code-line[data-line="5"]')).toContainText('sse-after-k4md', {
      timeout: 30_000
    });
    await expect(pre.locator('.vv-code-line[data-line="5"]')).not.toContainText('sse-before-qz7');
    await settleStats(page, stats);

    const delta = stats.records.slice(countBefore);
    expect(delta.length).toBeGreaterThanOrEqual(2);
    const growth = stats.total() - bytesBefore;
    expect(growth, `SSE 重渲染增量 ${growth}B 应为窗口级（<2MB），全量回归即 ~10MB`).toBeLessThan(
      2_000_000
    );
    for (const r of delta) {
      expect(r.range, '重渲染请求必须带 Range').not.toBeNull();
      expect(r.bytes as number).toBeLessThanOrEqual(CODE_BLOCK);
    }
    await expect(page.locator('.vv-error-card')).toHaveCount(0);
  } finally {
    await fake.close();
  }
});

// ---------------------------------------------------------------- DEG-09

test('DEG-09：hex size 未知全量回退——url 打开 blob 恰 1 全量请求、视图与布点搜索正确', async ({
  page
}) => {
  test.setTimeout(60_000);
  const bytes = makeBlob();
  await page.route('https://fake.asset.test/url-blob.bin', (route) =>
    route.fulfill({
      status: 200,
      headers: { 'access-control-allow-origin': '*', 'content-type': 'application/octet-stream' },
      body: Buffer.from(bytes)
    })
  );
  const stats = new UrlStats((u) => u.host === 'fake.asset.test' && u.pathname === '/url-blob.bin');
  stats.attach(page);
  await openUrlFile(page, 'https://fake.asset.test/url-blob.bin', 'url-blob.bin');

  // hex 全量回退（io spec §5：size null → hex 全量模式）：状态行 1.0 MB · 未知二进制
  await expect(page.locator('.vv-hex-status')).toContainText('1.0 MB · 未知二进制', {
    timeout: 20_000
  });
  await settleStats(page, stats);
  expect(stats.count(), 'url 打开应恰 1 次网络请求（hex 全量回退零追加读）').toBe(1);
  expect(stats.records[0]?.range).toBeNull();
  expect(stats.records[0]?.bytes).toBe(MB);

  // hex 视图内容正确 + 布点字节搜索命中（全量切片视图，搜索零网络 IO）
  await expect(page.locator('.vv-hex-dump .vv-hex-row').first()).toHaveText(/^00000000 {2}41/);
  const search = page.locator('.vv-hex-search');
  await search.fill('de ad');
  await search.press('Enter');
  await expect(page.locator('.vv-hex-search-status')).toHaveText('1/2 处命中', { timeout: 30_000 });
  await expect(activeHexHitRow(page)).toHaveText(/^00030000/);
  await page.locator('.vv-hex-search-next').click();
  await expect(page.locator('.vv-hex-search-status')).toHaveText('2/2 处命中');
  await expect(activeHexHitRow(page)).toHaveText(/^00060000/);
  await expect(page.locator('.vv-error-card')).toHaveCount(0);
});
