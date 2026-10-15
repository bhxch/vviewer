import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { expect, type Locator, type Page, test } from '@playwright/test';
import {
  CODE_BLOCK_BYTES,
  CODE_NEEDLE,
  IoStats,
  MB,
  type StreamFakeServer,
  codeBlockRange,
  connectForm,
  makeCodeFile,
  openRemoteFile,
  settleStats,
  startStreamFakeServer,
  waitAppMounted
} from './b-stream-resilience-helpers';
import { closeDrawerIfOpened, openDrawerIfNarrow } from './drawer';

/**
 * 上轮存疑观察 e2e 复核（SUSP 定档探针，docs/e2e/susp-verification.md 场景
 * SUSP-01~07/09/10；SUSP-08 并入既有 BUG-53 不复核）。来源：2026-10-13 报告 §4.2
 * 的 10 条 unconfirmed 存疑观察——本 spec 把每条「记录的现状」落成可执行探针。
 *
 * 探针纪律（域文档 §3 硬性规则）：断言写「记录的现状」，不写「应有行为」——
 * 探针绿 = 现象确认（记录与实跑一致）；探针红 = 未复现（probe-negative，属预期
 * 有效结果，绝不改断言凑绿，失败信息须携带实测证据供分诊定档）。现象确认 ≠
 * 缺陷定档：定档（改实现/改文档/裁决为设计）由门禁实跑后的分诊环节出。
 *
 * 装置：b-stream-resilience-helpers.ts（SCAN/JVL/DEG 共享，只 import 不修改）——
 * startStreamFakeServer（rangeless 'all' / fail 门 / slowMs）+ IoStats 计量 +
 * makeCodeFile/openRemoteFile/settleStats/waitAppMounted/connectForm。code/搜索
 * 面板装置与 b-code-scan-resilience 同款复制；jsonl GBK 嗅探夹具与
 * b-jsonl-degrade-chain 同款构造；错误卡片/MetaPanel/本地目录注入装置与
 * b-error-card-open-as 同款复制；SUSP-07 为 spec 内专用 /api/tree-500 mini 服务器。
 *
 * serviceWorkers: 'block'（b-grammar-spa-fallback 同款已知边界）：SUSP-06 对同源
 * manifest 的 page.route mock 不被 PWA SW CacheFirst 旁路；其余用例不依赖 SW。
 *
 * 场景 → 探针断言概览（记录的现状）：
 * - SUSP-01（已优化落地，探针随落地翻转）：清空→重输同词 = 同词短路零扫描 IO
 *   （退出搜索仅令牌失效 + 视觉清理，短路缓存保留；优化前为全新全文扫描 40 块级
 *   重拉、缓存不复用）；对照面同值 input 重派发 = 同键短路零扫描 IO
 * - SUSP-02：SCAN-08 布点续扫中视口块 1 被 LRU 逐出经 pendingReload 回拉 ≥2 次
 * - SUSP-03（已锚定落地，探针随落地翻转）：流内嗅探降级重渲后视口锚定原首行
 *   （不回顶；原「整体 replaceChildren → 视口回顶 scrollTop=0」现状存档于
 *   susp-verification.md §SUSP-03）
 * - SUSP-04：Range-less(200-only) + size 已知 10MB：首屏恰 3 请求共 3×文件字节，
 *   滚动零新增
 * - SUSP-05：900KB 非块对齐 jsonl（≤1MB 全量直读路径）恰 2 请求：无 Range 全量
 *   read + tail 部分块整块重拉 bytes=786432-921599
 * - SUSP-06：manifest 无 java 条目仍发起 /queries/java/** 空打（≥1）且 java.wasm
 *   零请求（doPrepare 先 expand 后 resolve 的执行顺序实证）
 * - SUSP-07：/api/tree 500 → 标签行在场、树区零行（失败隔离）、状态栏提示
 *   「加载失败」（BUG-24 通道——confirmed-bug 修复后翻转，原静默现状存档于
 *   susp-verification.md §SUSP-07）
 * - SUSP-09：av 卡片「以 hex 打开」上位后打开方式下拉维持「自动」无手动标记
 * - SUSP-10：远端截断 mp4 卡片上位 hex 零新增请求（buffer 全量在手，零 Range）
 *
 * 通道：vite preview :4173 纯前端页面 + 跨源假服务器；chromium + mobile（375×667）
 * 双 project，树行点击经 drawer.ts 窄视口适配、右栏经 openRightIfNarrow 适配。
 */

test.use({ serviceWorkers: 'block' });

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

// ---- code 扫描夹具（SUSP-01/02，与 SCAN 域同构：40 块、布点分属块 0/5） ----

/** 10MB = 163840 行 = 40 块；SUSP-01 布点行 1000（块 0）/21000（块 5） */
const SUSP_ROWS = 163_840;
const SUSP_NEEDLES = [1000, 21_000] as const;
/** SUSP-02 布点：块 1（行 5000，fail 门之前）与块 5（行 21000，门之后） */
const SUSP_FAIL_NEEDLES = [5000, 21_000] as const;

// ---- jsonl 均匀行夹具（SUSP-04/05；b-jsonl-degrade-chain 同款构造） ----

/** jsonl 窗口块大小（render-text jsonl WINDOW_BLOCK_BYTES 同源）：256KB */
const JSONL_BLOCK = 256 * 1024;
/** 均匀行字节（含 \n）：行 i 起始偏移可预算（块号 = floor(i×256/256KB)） */
const JSONL_ROW = 256;

/** jsonl 块 b 的精确 Range 区间字符串（BlockStream 步进形状） */
function jsonlBlockRange(b: number): string {
  return `bytes=${b * JSONL_BLOCK}-${(b + 1) * JSONL_BLOCK - 1}`;
}

/** 恰 255 字符的均匀行内容（+'\n' = 256B）：`{"id":i,"pad":"aaa…"}` 合法 JSON */
function uniformContent(i: number): string {
  const prefix = `{"id":${i},"pad":"`;
  return prefix + 'a'.repeat(255 - prefix.length - 2) + '"}';
}

/** totalBytes 字节的合法均匀行 jsonl（须为 256 整数倍，末行带换行；纯 ASCII） */
function makeUniformJsonl(totalBytes: number): Uint8Array {
  const rows = totalBytes / JSONL_ROW;
  if (!Number.isInteger(rows)) throw new Error(`makeUniformJsonl：totalBytes 须为 ${JSONL_ROW} 整数倍`);
  const lines: string[] = new Array(rows);
  for (let i = 0; i < rows; i++) lines[i] = uniformContent(i);
  return new TextEncoder().encode(lines.join('\n') + '\n');
}

/** 「中文」的 GBK 字节（python3 gbk codec 生成并回转验证；非法 UTF-8） */
const GBK_ZHONGWEN = [0xd6, 0xd0, 0xce, 0xc4];

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/**
 * 流内嗅探降级夹具（SUSP-03，b-jsonl-degrade-chain makeGbkNoSizeJsonl 同款）：
 * 前 512KB 纯 ASCII 均匀行（恰块 0/1，首屏嗅探不触发）+ 自 524288 起 GBK 中文行
 * 补至 ≥900KB（脏块 = 块 2 起，须滚动续读才喂入）。返回行数供「共 N 行」断言。
 */
function makeGbkNoSizeJsonl(): { bytes: Uint8Array; rows: number } {
  const head = makeUniformJsonl(512 * 1024); // 2048 行，恰 2 块
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [head];
  let total = head.length;
  let i = 0;
  while (total < 900 * 1024) {
    const pre = enc.encode(`{"zh":"`);
    const post = enc.encode(`","n":${i}}\n`);
    const line = new Uint8Array(pre.length + GBK_ZHONGWEN.length + post.length);
    line.set(pre, 0);
    line.set(GBK_ZHONGWEN, pre.length);
    line.set(post, pre.length + GBK_ZHONGWEN.length);
    parts.push(line);
    total += line.length;
    i += 1;
  }
  return { bytes: concatBytes(parts), rows: 2048 + i };
}

// ---- media 夹具（SUSP-09/10；OWX/MEDIA-11 同口径） ----

/** sample.mp4 截前 300B（moov 损坏 → av 内构错误卡片「无法播放此媒体」） */
const BROKEN_MP4 = new Uint8Array(readFileSync(`${repoRoot}/samples/m4/sample.mp4`)).slice(0, 300);

/** SUSP-06 的 java 样例（短小、语法特征明确；manifest 剥离 java 后降级 hljs） */
const JAVA_SRC = [
  'package com.vviewer.demo;',
  '',
  'public class Hello {',
  '    public static String greet(String name) {',
  '        return "hello " + name;',
  '    }',
  '}'
].join('\n');

// ---------------- 页面装置（既有 spec 同款复制，本 spec 内自含） ----------------

/** 打开远端 code 文件并等首屏就绪：openRemoteFile → 首行渲染 → settleStats。
 * 返回内部滚动容器 .vv-code-pre。 */
async function openCode(page: Page, fake: StreamFakeServer, stats: IoStats, name: string): Promise<Locator> {
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

/** 面板已开时替换查询词（fill 整值替换单次 input → 防抖后重搜） */
async function replaceSearchQuery(page: Page, term: string): Promise<void> {
  await page.locator('.vv-search-input').fill(term);
}

/**
 * 同键重搜触发（面板保持开启、查询值不变）：向输入框重派发同值 input 事件——
 * 等价用户全选重贴同词（清空再输入是换键，会重置命中集与游标，非同键重搜）。
 */
async function retriggerSameQuerySearch(page: Page, term: string): Promise<void> {
  await page.locator('.vv-search-input').evaluate((el, value) => {
    (el as HTMLInputElement).value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, term);
}

/** 文件内搜索面板计数文本 */
function searchCount(page: Page): Locator {
  return page.locator('.vv-search-count');
}

/** 当前命中行（code active 行级高亮） */
function activeHitLine(page: Page): Locator {
  return page.locator('.vv-code-line.vv-search-hit-line-active');
}

/** 全程负向护栏：窗口模式路径不得出现全量 200（SUSP-04 的 200-only 场景除外） */
function expectNoFullRead(stats: IoStats): void {
  for (const r of stats.records) {
    expect(r.range, `不得出现全量 200 拉取（status ${r.status}）`).not.toBeNull();
  }
}

/** 等错误卡片出现并核对 meta（文件名）与 detail（错误信息），返回卡片 locator */
async function expectErrorCard(page: Page, name: string, detail: string): Promise<Locator> {
  const card = page.locator('.vv-error-card');
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(card.locator('.vv-error-meta')).toContainText(name);
  await expect(card.locator('.vv-error-detail')).toContainText(detail);
  return card;
}

interface SpecFile {
  name: string;
  type: string;
  bytes: Uint8Array;
}

/** 页面内构造 File 经 __vvOpenDirImpl 注入目录（b-error-card-open-as 同款） */
async function openDir(page: Page, files: SpecFile[]): Promise<void> {
  await page.waitForFunction(
    () => typeof (window as unknown as { __vvOpenDirImpl?: unknown }).__vvOpenDirImpl === 'function'
  );
  await page.evaluate((list) => {
    const fs = list.map(({ name, type, bytes }) => {
      const f = new File([bytes as unknown as BlobPart], name, { type });
      Object.defineProperty(f, 'webkitRelativePath', { value: `susp/${name}` });
      return f;
    });
    return (window as unknown as { __vvOpenDirImpl: (f: File[]) => void }).__vvOpenDirImpl(fs);
  }, files);
}

/** 本地注入文件的树行点击开文件（窄视口经 drawer.ts 开合左抽屉） */
async function openFileLocal(page: Page, name: string): Promise<void> {
  const drawer = await openDrawerIfNarrow(page);
  await page.locator('.vv-tree-row').filter({ hasText: name }).click();
  await closeDrawerIfOpened(page, drawer);
  await expect(page.locator('.vv-tab.active', { hasText: name })).toBeVisible();
}

/** ≤600px 断点右栏（MetaPanel）收进抽屉（t-open-with openRightIfNarrow 同款） */
async function openRightIfNarrow(page: Page): Promise<void> {
  const narrow = await page.evaluate(() => window.innerWidth <= 600);
  if (narrow) await page.locator('.vv-right-toggle').click();
}

/** 计量记录摘要（失败信息证据用：[Range, status, bytes] 三元组列表） */
function digest(records: Array<{ range: string | null; status: number; bytes: number | null }>): string {
  return JSON.stringify(records.map((r) => [r.range, r.status, r.bytes]));
}

// ---------------------------------------------------------------- SUSP-01

test('SUSP-01（已优化落地）：清空→重输同词短路零扫描（退出保留短路缓存）；对照同键重搜短路零 IO', async ({ page }) => {
  test.setTimeout(240_000);
  const fake = await startStreamFakeServer({ 'susp10.js': makeCodeFile(SUSP_ROWS, SUSP_NEEDLES) });
  try {
    const stats = new IoStats();
    await openCode(page, fake, stats, 'susp10.js');

    // ① 首次全文扫描收场（40 块拉齐、计数落定）
    await panelSearch(page, CODE_NEEDLE);
    await expect(searchCount(page)).toHaveText('1/2', { timeout: 120_000 });
    await settleStats(page, stats);

    // ② 对照面：同键重搜（同值 input 重派发）短路零扫描 IO——证明扫描缓存存在
    await page.keyboard.press('Enter'); // 步进到第二布点，短路回落可观测
    await expect(searchCount(page)).toHaveText('2/2');
    await expect(activeHitLine(page)).toHaveAttribute('data-line', String(SUSP_NEEDLES[1]), {
      timeout: 15_000
    });
    await settleStats(page, stats);
    const beforeShort = stats.count();
    await retriggerSameQuerySearch(page, CODE_NEEDLE);
    await expect(searchCount(page)).toHaveText('1/2', { timeout: 10_000 });
    await expect(activeHitLine(page)).toHaveAttribute('data-line', String(SUSP_NEEDLES[0]), {
      timeout: 10_000
    });
    await settleStats(page, stats);
    const shortCircuit = stats.records.slice(beforeShort);
    expect(
      shortCircuit.filter((r) => r.range !== codeBlockRange(0)),
      `对照面：同键重搜应短路（至多 gotoMatch 块 0 补拉 1 条），实得 ${digest(shortCircuit)}`
    ).toHaveLength(0);
    expect(shortCircuit.length, '对照面短路 IO 至多 1 条').toBeLessThanOrEqual(1);

    // ③ 清空输入框：空 query 调 search('')（SearchPanel.svelte:105）= 退出搜索——
    //    仅令牌失效 + 视觉清理（词级 mark/行级背景消退），短路缓存保留（SUSP-01
    //    优化落地）；计数转「无结果」为已执行信号
    await replaceSearchQuery(page, '');
    await expect(searchCount(page)).toHaveText('无结果', { timeout: 10_000 });
    await settleStats(page, stats);

    // ④⑤ 重输同一布点词（SUSP-01 优化后目标形态）：退出不清缓存 → 同词重搜走完成态
    //    短路，零新增扫描请求（至多 gotoMatch 块 0 补拉 1 条，与对照面同口径）；优化
    //    前的「全新全文扫描」形态（块级请求 ≥20、末块 39 在列）若复现即回归
    const beforeRescan = stats.count();
    await replaceSearchQuery(page, CODE_NEEDLE);
    await expect(searchCount(page)).toHaveText('1/2', { timeout: 10_000 });
    await expect(activeHitLine(page)).toHaveAttribute('data-line', String(SUSP_NEEDLES[0]), {
      timeout: 15_000
    });
    await settleStats(page, stats);
    const rescan = stats.records.slice(beforeRescan);
    const blockPulls = rescan.filter((r) => r.range !== null).length;
    expect(
      rescan.filter((r) => r.range !== codeBlockRange(0)),
      `重输同词应短路零扫描（块 0 补拉之外不得有任何请求），实得 ${digest(rescan)}`
    ).toHaveLength(0);
    expect(
      blockPulls,
      `重搜块级请求应 ≤1（短路形态；全新全文扫描为 ≥20 且末块 39 在列），实得 ${digest(rescan)}`
    ).toBeLessThanOrEqual(1);
    expectNoFullRead(stats);
    await expect(page.locator('.vv-error-card')).toHaveCount(0);
  } finally {
    await fake.close();
  }
});

// ---------------------------------------------------------------- SUSP-02

test('SUSP-02：长扫描续扫中视口块被 LRU 逐出经 pendingReload 回看——同一次续扫内回拉 ≥2 次', async ({ page }) => {
  test.setTimeout(240_000);
  // SCAN-08 布点（fail 门块 3 起 500 直至放行；布点行 5000/21000 分属块 1 门前/块 5
  // 门后）+ slowMs=60：续扫 37 块撑开到 ~2.3s，两次「逐出→回拉」窗口均可观测
  const fake = await startStreamFakeServer(
    { 'susp10.js': makeCodeFile(SUSP_ROWS, SUSP_FAIL_NEEDLES) },
    { fail: { path: 'susp10.js', minStart: 3 * CODE_BLOCK_BYTES }, slowMs: 60 }
  );
  try {
    const stats = new IoStats();
    await openCode(page, fake, stats, 'susp10.js');

    // ① 部分收场：计数 1/1（仅门前布点），自动定位行 5000（视口驻块 1）
    await panelSearch(page, CODE_NEEDLE);
    await expect(searchCount(page)).toHaveText('1/1', { timeout: 120_000 });
    await expect(activeHitLine(page)).toHaveAttribute('data-line', String(SUSP_FAIL_NEEDLES[0]), {
      timeout: 15_000
    });
    await settleStats(page, stats);

    // ② 放行 + 同键重搜：续扫自游标（块 3）起，视口仍驻块 1
    fake.releaseFail();
    await settleStats(page, stats);
    const baseline = stats.count();
    await retriggerSameQuerySearch(page, CODE_NEEDLE);
    await expect(searchCount(page)).toHaveText('1/2', { timeout: 120_000 });
    await settleStats(page, stats);
    const phase = stats.records.slice(baseline);

    // 记录的现状：视口块 1 在续扫中被块表 LRU（16×256KB）逐出 → pendingReload 回看
    // 重拉（code.ts:1677-1696）——同一次续扫内 ≥2 次（上轮 SCAN-08 实测恰 2 次：
    // 逐出→回拉→再逐出→再回拉），伴随可见闪烁
    const b1 = phase.filter((r) => r.range === codeBlockRange(1));
    expect(
      b1.length,
      `续扫内视口块 1 应经回看重拉 ≥2 次（记录现状），实得 ${b1.length}：${digest(phase)}`
    ).toBeGreaterThanOrEqual(2);
    for (const r of b1) {
      expect(r.status, '回看重拉应为 206（占位兜底契约，非失败面）').toBe(206);
    }

    // 扫描面不变形（SCAN-08 同款护栏）：块 2 不重读；前沿块 3..39 各恰一次；末块在列
    const phaseCount = (range: string): number => phase.filter((r) => r.range === range).length;
    expect(phaseCount(codeBlockRange(2)), '续扫不得重读游标之前已索引的块 2').toBe(0);
    for (let b = 3; b < 40; b++) {
      expect(phaseCount(codeBlockRange(b)), `扫描前沿块 ${b} 应恰拉取一次`).toBe(1);
    }
    expect(phase.map((r) => r.range)).toContain(codeBlockRange(39));
    expectNoFullRead(stats);
    await expect(page.locator('.vv-error-card')).toHaveCount(0);
  } finally {
    await fake.close();
  }
});

// ---------------------------------------------------------------- SUSP-03

test('SUSP-03（已锚定落地，探针随落地翻转）：流内嗅探降级重渲后视口锚定原首行——不回顶', async ({ page }) => {
  test.setTimeout(120_000);
  const f = makeGbkNoSizeJsonl();
  // 条目省略 size（size 未知窗口流式）：前 512KB 干净、脏块块 2 起
  const fake = await startStreamFakeServer({ 'susp-gbk-nosize.jsonl': { bytes: f.bytes } });
  try {
    const stats = new IoStats();
    const loadedRows = 2048; // 降级前已加载行数（夹具前 512KB 均匀行的构造值）
    await openRemoteFile(page, fake, stats, 'susp-gbk-nosize.jsonl');
    const status = page.locator('.vv-jsonl-status');
    await expect(status).toHaveText(`已加载 ${loadedRows} 行`, { timeout: 20_000 });

    // ① 滚动到已加载区中部（记录位置 >0）——此处不触发续读（距前沿余量充足）
    const scroll = page.locator('.vv-jsonl-scroll');
    await scroll.evaluate((el) => {
      el.scrollTop = el.scrollHeight / 2;
    });
    const midTop = await scroll.evaluate((el) => el.scrollTop);
    expect(midTop, '前置：应已滚至中部（scrollTop > 0）').toBeGreaterThan(0);

    // ② 继续滚动到加载前沿：续读喂入脏块（块 2 起 GBK）→ 流内嗅探判非 UTF-8
    //    → 降级重渲（jsonl/index.ts:709 嗅探点捕获锚行 curFirst、:713 新实例
    //    mount 完成后经 revealLine 恢复）
    await scroll.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });

    // ③ 降级完成信号：全量实例接管（状态转「共 N 行」+ 精判编码 gb18030）
    await expect(status).toHaveText(`共 ${f.rows} 行`, { timeout: 30_000 });
    await expect(page.locator('.vv-statusbar')).toContainText('编码: gb18030', { timeout: 10_000 });
    await settleStats(page, stats);

    // 翻转后的验收（原「回顶 scrollTop=0、滚动位置丢失」现状记录存档于
    // susp-verification.md §SUSP-03）：降级时视口贴着加载前沿（已加载 2048 行的
    // 末屏），嗅探时刻 curFirst = 2048 - 可视行数 - overscan 内——恢复后可视首行
    // （窗口 min data-line，overscan 口径降级前后一致）应落在「前沿一屏 + overscan
    // 容差」带内：下界 2048 - 可视卡片数 - 20（一屏可视 + overscan + 精调余量），
    // 上界 < 2048（不得越过降级前加载前沿）。锚定用行号而非 scrollTop（窗口估算
    // 行高 vs 全量卡片可变高度，scrollTop 不可直译——spec §5 裁决）。
    const firstAfter = await page.evaluate(() => {
      const cards = document.querySelectorAll<HTMLElement>('.vv-jsonl-card');
      let min = Number.MAX_SAFE_INTEGER;
      cards.forEach((c) => { min = Math.min(min, Number(c.dataset.line)); });
      return cards.length === 0 ? -1 : min;
    });
    const visible = await page.locator('.vv-jsonl-card').count();
    expect(firstAfter, `降级后可视首行应 ≈ 降级前前沿首行（±可视范围+overscan，非回顶）：first=${firstAfter} 可视卡片=${visible}`)
      .toBeGreaterThan(loadedRows - visible - 20);
    expect(firstAfter, `降级后可视首行不得越过降级前加载前沿：first=${firstAfter} 前沿=${loadedRows}`)
      .toBeLessThan(loadedRows);
    await expect(page.locator('.vv-error-card')).toHaveCount(0); // 降级非失败态
  } finally {
    await fake.close();
  }
});

// ---------------------------------------------------------------- SUSP-04

test('SUSP-04：Range-less(200-only) + size 已知 10MB——首屏恰 3 请求共 3×文件字节，滚动零新增', async ({ page }) => {
  test.setTimeout(120_000);
  // 40960 行×256B 恰 40 块 > LRU 16（16×256KB=4MB 界外）：head 预置全部块后超限逐出，
  // 首屏喂入对被逐块重拉收 200 全量 → 200-回退全量重取（blockStream.ts:130-138/169-190）
  const jsonl = makeUniformJsonl(10 * MB);
  const fake = await startStreamFakeServer(
    { 'susp-rangeless-10mb.jsonl': jsonl },
    { rangeless: 'all' }
  );
  try {
    const stats = new IoStats();
    await openRemoteFile(page, fake, stats, 'susp-rangeless-10mb.jsonl');
    await expect(page.locator('.vv-jsonl-status')).toHaveText('共 40960 行', { timeout: 30_000 });
    await settleStats(page, stats);

    // 记录的现状：首屏恰 3 请求、共 3×文件字节（每条响应体均 10MB）
    expect(
      stats.records.map((r) => r.range),
      `首屏请求形状应为 探针/被逐块/全量重取，实得 ${digest(stats.records)}`
    ).toEqual(['bytes=0-8191', jsonlBlockRange(0), 'bytes=0-9007199254740991']);
    expect(stats.count(), '首屏应恰 3 条请求').toBe(3);
    for (const r of stats.records) {
      expect(r.status, `200-only 服务器应答 200（Range ${r.range}）`).toBe(200);
      expect(r.bytes, `忽略 Range 应全量原样交付（Range ${r.range}）`).toBe(jsonl.length);
    }

    // 滚动零新增：全量底座就绪后一切块零 IO 切片
    const scroll = page.locator('.vv-jsonl-scroll');
    await scroll.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await page.waitForTimeout(300);
    await scroll.evaluate((el) => {
      el.scrollTop = 0;
    });
    await settleStats(page, stats);
    expect(stats.count(), `滚动应零新增请求，实得 ${digest(stats.records.slice(3))}`).toBe(3);
    await expect(page.locator('.vv-error-card')).toHaveCount(0);
  } finally {
    await fake.close();
  }
});

// ---------------------------------------------------------------- SUSP-05

test('SUSP-05：≤1MB 全量直读路径在 size 非块对齐时恰 2 请求（全量 read + tail 部分块整块重拉）', async ({ page }) => {
  test.setTimeout(120_000);
  // 921600 B = 3600 行×256B，非 256KB 块对齐（恰 4 块，末块 135168 B）；
  // size 已知 ≤FULL_LIMIT(1MB) → dispatcher 全量直读（dispatcher.ts:277-281）
  const jsonl = makeUniformJsonl(900 * 1024);
  expect(jsonl.length).toBe(921_600);
  const fake = await startStreamFakeServer({ 'susp-900kb.jsonl': jsonl });
  try {
    const stats = new IoStats();
    await openRemoteFile(page, fake, stats, 'susp-900kb.jsonl');
    await expect(page.locator('.vv-jsonl-status')).toHaveText('共 3600 行', { timeout: 30_000 });
    await settleStats(page, stats);

    // 记录的现状：恰 2 请求——1 条无 Range 全量 read + 1 条 tail 部分块整块重拉
    //（head 预置末块 135168 B 非整块，首屏喂入按「未 ensure 不得进索引」纪律重拉；
    // 「恰 1 请求」口径在非块对齐 size 下不成立）
    expect(
      stats.records.map((r) => [r.range, r.status, r.bytes]),
      `应恰为 [无 Range 全量 200, tail 块 206]，实得 ${digest(stats.records)}`
    ).toEqual([
      [null, 200, 921_600],
      // tail 块 Range 端点按 size 钳制：786432 + cap(135168) - 1 = 921599（非块步进端点）
      ['bytes=786432-921599', 206, 135_168]
    ]);

    // 静置 + 滚动零新增：全量已喂、EOF 锁定（消费契约：finish 后续读停机）
    const scroll = page.locator('.vv-jsonl-scroll');
    await scroll.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await page.waitForTimeout(300);
    await scroll.evaluate((el) => {
      el.scrollTop = 0;
    });
    await settleStats(page, stats);
    expect(stats.count(), `滚动应零新增请求，实得 ${digest(stats.records.slice(2))}`).toBe(2);
    await expect(page.locator('.vv-error-card')).toHaveCount(0);
  } finally {
    await fake.close();
  }
});

// ---------------------------------------------------------------- SUSP-06

test('SUSP-06：语言不在合并 manifest 仍发起该语言 /queries/** 空打——java.wasm 零请求对照', async ({ page, request }) => {
  test.setTimeout(60_000);
  // 计数预挂（goto 前）：/queries/java/** 与 java.wasm 的响应计数（404/HTML 兜底均计）
  const queryHits: string[] = [];
  const wasmHits: string[] = [];
  page.on('response', (res) => {
    let u: URL;
    try {
      u = new URL(res.url());
    } catch {
      return;
    }
    if (u.pathname.includes('/queries/java/')) queryHits.push(u.pathname);
    if (u.pathname.endsWith('/grammars/java.wasm')) wasmHits.push(u.pathname);
  });

  // 同源 manifest mock 为剥离 java 条目的真实清单（b-grammar-spa-fallback GRF-01
  // 同款手法：读真实清单后删条目，防硬编码漂移；负向前瞻排除 CDN host）
  const manifestRes = await request.get('/grammars/manifest.json');
  expect(manifestRes.ok()).toBeTruthy();
  const manifest = (await manifestRes.json()) as { grammars: Record<string, unknown> };
  delete manifest.grammars.java;
  await page.route(
    /\/\/(?!cdn\.grammars\.test).*\/grammars\/manifest\.json$/,
    (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(manifest)
      })
  );
  // CDN 全域 abort：不专门 mock CDN 资产的用例必须调用（杜绝未 mock fetch 变真实 socket）
  await page.route(`**/cdn.grammars.test/**`, (route) => route.abort());

  await page.goto('/');
  await openDir(page, [
    { name: 'Hello.java', type: 'text/x-java-source', bytes: new TextEncoder().encode(JAVA_SRC) }
  ]);
  await openFileLocal(page, 'Hello.java');
  // doPrepare 已跑且失败兜底（manifest 无 java 条目 → 整语言降级 hljs）
  await expect(page.locator('.vv-statusbar')).toContainText('高亮: hljs 兜底', { timeout: 30_000 });

  // 记录的现状（core-parse.ts:266-273 执行顺序实证）：doPrepare 先 expandQueryAsync
  // 后 resolveGrammarEntry——查询 .scm 空打发生（≥1），而 java.wasm 零请求（manifest
  // 无条目短路）。若实跑为零空打 = SUSP-06 未复现（顺序推断有误）
  expect(
    queryHits.length,
    `/queries/java/** 空打应发生（≥1），实得 ${JSON.stringify(queryHits)}`
  ).toBeGreaterThanOrEqual(1);
  expect(
    wasmHits,
    `manifest 无 java 条目不得发起 java.wasm 请求（resolveGrammarEntry 短路面），实得 ${JSON.stringify(wasmHits)}`
  ).toEqual([]);
  await expect(page.locator('.vv-error-card')).toHaveCount(0);
});

// ---------------------------------------------------------------- SUSP-07

/** SUSP-07 专用 mini 服务器：health/ticket/events 正常，/api/tree 一律 500（计数） */
async function startTreeFailServer(): Promise<{
  base: string;
  host: string;
  treeFails: () => number;
  close: () => Promise<void>;
}> {
  let treeFailCount = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const cors = { 'Access-Control-Allow-Origin': '*' };
    if (url.pathname === '/api/health') {
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ capabilities: ['file-server'] }));
      return;
    }
    if (url.pathname === '/api/ticket') {
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ticket: 'susp-e2e' }));
      return;
    }
    if (url.pathname === '/api/events') {
      res.writeHead(200, { ...cors, 'Content-Type': 'text/event-stream' });
      return; // 保持打开、无数据帧（测试结束统一断连）
    }
    if (url.pathname === '/api/tree') {
      treeFailCount += 1;
      res.writeHead(500, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'e2e 注入树枚举失败' }));
      return;
    }
    res.writeHead(404, cors);
    res.end();
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    host: `127.0.0.1:${port}`,
    treeFails: () => treeFailCount,
    close: async () => {
      server.closeAllConnections(); // /api/events 长连接不 end：close() 需配套断连
      await new Promise<void>((ok) => server.close(() => ok()));
    }
  };
}

test('SUSP-07：来源根目录 listChildren 失败显性提示（BUG-24 同款通道）——失败隔离保留（标签行在场、树区零行）', async ({ page }) => {
  test.setTimeout(60_000);
  const srv = await startTreeFailServer();
  try {
    await waitAppMounted(page);
    await connectForm(page, srv.base);
    await expect(page.locator('.vv-tab', { hasText: srv.host })).toBeVisible({ timeout: 10_000 });
    // 失败真实发生（服务器侧证据；FileTree $effect 对 listChildren('') 的调用）
    await expect.poll(() => srv.treeFails(), { timeout: 10_000 }).toBeGreaterThanOrEqual(1);

    // 失败隔离语义保留：来源渲染标签行，树区零行（本源空列表，不拖垮其他源）
    const drawer = await openDrawerIfNarrow(page);
    await expect(page.locator('.vv-tree-src-label')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.vv-tree-row')).toHaveCount(0);

    // 修复后验收（SUSP-07 定档 confirmed-bug 修复立项；原「静默空树」现状记录见
    // susp-verification.md）：复用 BUG-24 状态栏提示通道（TreeNodeRow 子目录展开
    // 失败同款），观察窗内出现「加载失败」提示；错误卡片仍为零（轻量异常走状态栏
    // 而非错误卡片，与「已取消选择文件夹」同通道口径）
    await expect(page.getByText('加载失败')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('.vv-error-card')).toHaveCount(0);
    await closeDrawerIfOpened(page, drawer);
  } finally {
    await srv.close();
  }
});

// ---------------------------------------------------------------- SUSP-09

test('SUSP-09：av 内构卡片「以 hex 打开」上位后 MetaPanel 打开方式维持「自动」、无生效态标识', async ({ page }) => {
  test.setTimeout(60_000);
  await waitAppMounted(page);
  await openDir(page, [{ name: 'broken.mp4', type: 'video/mp4', bytes: BROKEN_MP4 }]);
  await openFileLocal(page, 'broken.mp4');
  const card = await expectErrorCard(page, 'broken.mp4', '无法播放此媒体');
  // av 内构卡片（软失败链）按钮集合：[重试, 以 hex 打开]
  await expect(card.locator('.vv-error-action')).toHaveCount(2);
  await expect(card.locator('.vv-error-action').nth(1)).toHaveText('以 hex 打开');
  await card.locator('.vv-error-action', { hasText: '以 hex 打开' }).click();
  // hex 上位渲染原字节、原卡片级联替换（av.ts:456-464 直调 hex.render(buffer)+takeOver）
  await expect(page.locator('.vv-hex')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.vv-hex-status')).toContainText('300 B');
  await expect(page.locator('.vv-error-card')).toHaveCount(0);

  // 记录的现状：不经 dispatch 重入、不写 override（ViewerPane 不感知上位）——
  // 打开方式下拉维持「自动」（value=''）且无「（手动）」标记：与 dispatcher
  // openAsAction（rendererOverride 重入）同按钮不同语义
  await openRightIfNarrow(page);
  const openWith = page.locator('.meta-openwith');
  await expect(openWith).toBeVisible();
  await expect(openWith, '打开方式应维持「自动」（记录现状：内构链上位不写 override）').toHaveValue('');
  await expect(page.locator('.meta-openwith-manual'), '应无「（手动）」生效态标识').toHaveCount(0);
});

// ---------------------------------------------------------------- SUSP-10

test('SUSP-10：远端截断 mp4 卡片上位 hex 零新增请求——buffer 全量在手，不产生窗口 Range 流式读', async ({ page }) => {
  test.setTimeout(90_000);
  const fake = await startStreamFakeServer({ 'broken.mp4': BROKEN_MP4 });
  try {
    const stats = new IoStats();
    await openRemoteFile(page, fake, stats, 'broken.mp4');
    const card = await expectErrorCard(page, 'broken.mp4', '无法播放此媒体');
    await settleStats(page, stats);
    const baseline = stats.count();

    // 内构链 hex 动作（av.ts:457 hex.render(buffer, …)）：以手头全量 buffer 渲染，
    // 无 StreamCtx 全量形态
    await card.locator('.vv-error-action', { hasText: '以 hex 打开' }).click();
    await expect(page.locator('.vv-hex')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('.vv-hex-status')).toContainText('300 B');
    await settleStats(page, stats);

    // 记录的现状：零新增请求（零 Range 窗口流式读）——av 非 streaming 故 buffer
    // 恒全量在手，行为正确但绕过 hex streaming 能力（行为正确性记录，非疑点）
    const after = stats.records.slice(baseline);
    expect(
      after,
      `内构链 hex 上位应零新增请求（记录现状），实得 ${digest(after)}`
    ).toHaveLength(0);
    await expect(page.locator('.vv-error-card')).toHaveCount(0);
  } finally {
    await fake.close();
  }
});
