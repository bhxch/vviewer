import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, type Page } from '@playwright/test';
import { assertPortFree, stopServer, waitHealthy } from '../e2e/serverHarness';

/**
 * workspace 富化域 server 面（WSX-01~06，编号对照 docs/e2e/workspace-enrichment.md
 * 第 2/3 节；第二轮富化——多根 search/compute 通道语义、搜索引擎宣告与回退、
 * watch SSE 帧风暴聚合承诺面）。与既有锚点分工：
 * - SRV-MULTIROOT（t-srv.spec.ts:609）只锚 search 缺省跨根帧带 root 一面；
 *   WSX-01 补「指定 root 限定单根」的帧形状退化（无 root 字段）对比与 path 相对根；
 * - MRF-01~08 只锚 file/tree 通道的 root 路由；WSX-02/05 补 search 4xx 矩阵与
 *   /api/compute/highlight 的 root 语义（path 模式按根解析、text 模式不涉）；
 * - CMP-09 的「无 rg 501」拓扑在本机恰好 rg+grep 双缺；WSX-03 补 rg 缺失 grep 在的
 *   回退正例全链（API NDJSON col=1 + 前端 vv:search-engine 徽标与降级 tooltip），
 *   WSX-04 补双缺的 health 字段省略 + 徽标缺失 + 主实例 rg 宣告护栏；
 * - t-srv BUG-68 锚只覆盖越界 symlink 不降级；WSX-06 补 watch-log-flood 设计的
 *   SSE 层承诺——500ms debounce 固定窗口把单窗口 24 连写聚合成有界帧（逐根发帧）。
 *
 * 实例拓扑：主实例 :4174 由 playwright.server.config.ts webServer 启动（单根 rg）；
 * beforeAll 另起四辅助实例（ensureServe 重试安全复用，b-compute 先例）：
 *   :4396 双根（WSX-01/02/06）；:4397 单根 PATH=仅 grep 符号链接目录（WSX-03）；
 *   :4398 单根 PATH=空目录（WSX-04）；:4399 双根 --compute（WSX-05）。
 * 双根均为互不相交的独立 mkdtemp（嵌套根被 strip_root 逐根前缀匹配误归 0 号根，
 * SRV-MULTIROOT/MRF 同款约束；不写共享 FIXTURE）。4396-4399 与既有
 * 4173/4174/4178-4180/4375-4377/4383/4384/4395/8399/8449 错开；套件单 worker 串行。
 * UI 徽标场景在 :4174 页面跨源连辅助实例（--cors-origin 精确等于页面源）。
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const BIN = join(repoRoot, 'server/target/release/vviewer');
const WEB_DIST = join(repoRoot, 'apps/web/build');
const BASE = 'http://127.0.0.1:4174';
const PAGE_ORIGIN = 'http://127.0.0.1:4174';

const PORT_MULTI = 4396;
const MULTI = `http://127.0.0.1:${PORT_MULTI}`;
const PORT_GREP = 4397;
const GREP = `http://127.0.0.1:${PORT_GREP}`;
const PORT_NOENGINE = 4398;
const NOENGINE = `http://127.0.0.1:${PORT_NOENGINE}`;
const PORT_COMPUTE = 4399;
const COMPUTE = `http://127.0.0.1:${PORT_COMPUTE}`;

let multiServer: ChildProcess | null = null;
let grepServer: ChildProcess | null = null;
let noEngineServer: ChildProcess | null = null;
let computeServer: ChildProcess | null = null;

let multiDir = '';
let root0 = '';
let root1 = '';
let grepFixture = '';
let grepPathDir = '';
let noEngineFixture = '';
let noEnginePathDir = '';
let computeDir = '';
let computeRoot0 = '';
let computeRoot1 = '';

/** 真实 grep 可执行路径（which 探测，失败回退常见绝对路径扫描）。 */
async function findGrep(): Promise<string> {
  const viaWhich = await new Promise<string | null>((res) => {
    execFile('which', ['grep'], (err, stdout) => res(err ? null : stdout.trim()));
  });
  if (viaWhich) return viaWhich;
  for (const p of ['/usr/bin/grep', '/bin/grep', '/usr/sbin/grep']) {
    if (existsSync(p)) return p;
  }
  throw new Error('环境中未找到 grep：WSX-03/04 的引擎注入场景无法构造');
}

function spawnServe(port: number, rootArgs: string[], extraArgs: string[], env?: NodeJS.ProcessEnv): ChildProcess {
  return spawn(
    BIN,
    ['serve', ...rootArgs, '--web-dist', WEB_DIST, '--port', String(port), ...extraArgs],
    { stdio: ['ignore', 'inherit', 'inherit'], ...(env ? { env } : {}) }
  );
}

test.beforeAll(async () => {
  // ---- :4396 双根夹具（互不相交 mkdtemp；首行同 pattern 次行根判异词）----
  multiDir = mkdtempSync(join(os.tmpdir(), 'vv-wsx-multi-'));
  root0 = join(multiDir, 'root0');
  root1 = join(multiDir, 'root1');
  mkdirSync(root0, { recursive: true });
  mkdirSync(join(root1, 'sub'), { recursive: true });
  writeFileSync(join(root0, 'wsx-r0.txt'), 'wsx needle shared\nr0 zebra unique\n');
  writeFileSync(join(root1, 'wsx-r1.txt'), 'wsx needle shared\nr1 yak unique\n');
  writeFileSync(join(root1, 'sub/needle-deep.txt'), 'deep probe needle in sub\n');

  // ---- :4397 夹具 + PATH 注入目录（仅一枚指向真实 grep 的符号链接：
  //      resolve_one 的 is_executable 跟随符号链接 → probe(rg) 失败、probe(grep) 命中）----
  grepFixture = mkdtempSync(join(os.tmpdir(), 'vv-wsx-grep-fixture-'));
  writeFileSync(join(grepFixture, 'wsx-grep-needle.txt'), 'grep engine needle here\nsecond grep line\n');
  grepPathDir = mkdtempSync(join(os.tmpdir(), 'vv-wsx-grep-path-'));
  symlinkSync(await findGrep(), join(grepPathDir, 'grep'));

  // ---- :4398 夹具 + PATH 注入目录（空目录 → probe rg/grep 双失败 → 501）----
  noEngineFixture = mkdtempSync(join(os.tmpdir(), 'vv-wsx-none-fixture-'));
  writeFileSync(join(noEngineFixture, 'wsx-quiet.txt'), 'nothing to find\n');
  noEnginePathDir = mkdtempSync(join(os.tmpdir(), 'vv-wsx-none-path-'));

  // ---- :4399 双根 + compute 夹具（行数差供 range.startLine 锐证）----
  computeDir = mkdtempSync(join(os.tmpdir(), 'vv-wsx-compute-'));
  computeRoot0 = join(computeDir, 'root0');
  computeRoot1 = join(computeDir, 'root1');
  mkdirSync(computeRoot0, { recursive: true });
  mkdirSync(computeRoot1, { recursive: true });
  writeFileSync(join(computeRoot0, 'wsx-hl-r0.js'), 'const r0 = "wsx-hl";\n');
  writeFileSync(join(computeRoot1, 'wsx-hl-r1.js'), 'const r1 = "wsx-hl";\nconst b = 2;\nconst c = 3;\n');

  // ---- 辅助实例（assertPortFree fail-fast + ensureServe 重试安全复用）----
  await assertPortFree(`${MULTI}/api/health`);
  multiServer = spawnServe(PORT_MULTI, ['--root', root0, '--root', root1], []);
  await waitHealthy(MULTI);

  const ensureServe = async (
    port: number,
    base: string,
    rootArgs: string[],
    extraArgs: string[],
    env: NodeJS.ProcessEnv | undefined,
    store: (c: ChildProcess | null) => void
  ): Promise<void> => {
    await assertPortFree(`${base}/api/health`);
    const child = spawnServe(port, rootArgs, extraArgs, env);
    store(child);
    await waitHealthy(base);
  };
  await ensureServe(
    PORT_GREP, GREP, ['--root', grepFixture], ['--cors-origin', PAGE_ORIGIN],
    { ...process.env, PATH: grepPathDir }, (c) => (grepServer = c)
  );
  await ensureServe(
    PORT_NOENGINE, NOENGINE, ['--root', noEngineFixture], ['--cors-origin', PAGE_ORIGIN],
    { ...process.env, PATH: noEnginePathDir }, (c) => (noEngineServer = c)
  );
  await ensureServe(
    PORT_COMPUTE, COMPUTE, ['--root', computeRoot0, '--root', computeRoot1], ['--compute'],
    undefined, (c) => (computeServer = c)
  );
});

test.afterAll(async () => {
  // 先停服再清 PATH 注入目录/夹具（目录先删会令在途 probe 语义漂移）
  await stopServer(multiServer, 'wsx-multi');
  await stopServer(grepServer, 'wsx-grep');
  await stopServer(noEngineServer, 'wsx-noengine');
  await stopServer(computeServer, 'wsx-compute');
  for (const dir of [multiDir, grepFixture, grepPathDir, noEngineFixture, noEnginePathDir, computeDir]) {
    if (dir !== '') rmSync(dir, { recursive: true, force: true });
  }
});

/** 错误体 JSON 形状（error.rs：`{"error": msg}`） */
interface ErrorBody {
  error?: string;
}

interface SearchFrame {
  file?: string;
  line?: number;
  col?: number;
  text?: string;
  root?: number;
  done?: boolean;
  truncated?: boolean;
}

interface SearchOutcome {
  status: number;
  frames: SearchFrame[];
  error: string;
}

/** POST /api/search：200 → NDJSON 帧数组；非 200 → JSON 错误体（search.rs 分流）。 */
async function postSearch(base: string, body: Record<string, unknown>): Promise<SearchOutcome> {
  const res = await fetch(`${base}/api/search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  if (!res.ok) {
    let error = text;
    try {
      error = (JSON.parse(text) as ErrorBody).error ?? text;
    } catch {
      // 非 JSON 错误体：原样
    }
    return { status: res.status, frames: [], error };
  }
  const frames = text
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as SearchFrame);
  return { status: res.status, frames, error: '' };
}

/** 命中帧（file 字段在即命中帧；终帧带 done）。 */
function hitFrames(outcome: SearchOutcome): SearchFrame[] {
  return outcome.frames.filter((f) => f.file !== undefined);
}

/** 连接表单提交（t-srv/b-io-streaming connectForm 同款；token 留空）。 */
async function connectForm(page: Page, base: string): Promise<void> {
  await page.getByRole('button', { name: '连接服务器' }).click();
  await page.getByLabel('服务器地址').fill(base);
  await page.getByRole('button', { name: '连接', exact: true }).click();
}

// ---------------------------------------------------------------- WSX-01

test('WSX-01: /api/search 指定 root 限定单根——帧退化单根形状 vs 缺省跨根帧带 root、path 相对所选根', async () => {
  test.setTimeout(60_000);
  // ① health 先探引擎（col 精确断言以此为条件）与多根宣告
  const health = (await (await fetch(`${MULTI}/api/health`)).json()) as {
    roots?: number;
    searchEngine?: string;
  };
  expect(health.roots).toBe(2);
  expect(health.searchEngine === 'rg' || health.searchEngine === 'grep').toBe(true);

  // ② 缺省 = 跨全部根：两根各一命中、每帧带 root 字段（SRV-MULTIROOT 已锚帧形状，此处补集合对比面）
  const cross = await postSearch(MULTI, { pattern: 'wsx needle' });
  expect(cross.status).toBe(200);
  const crossHits = hitFrames(cross);
  expect(new Set(crossHits.map((f) => f.file))).toEqual(new Set(['wsx-r0.txt', 'wsx-r1.txt']));
  for (const f of crossHits) {
    expect(f.root, `跨根命中帧必须带 root 字段: ${JSON.stringify(f)}`).toBeDefined();
    expect([0, 1]).toContain(f.root);
    expect(f.text).toContain('wsx needle shared');
  }
  expect(new Set(crossHits.map((f) => f.root))).toEqual(new Set([0, 1]));

  // ③ root=1 限定：帧集合恰为 root1 文件，且帧【无】root 字段（search.rs:289-291
  //    解析器只见一个根 → 与单根形状逐字节一致）
  const limited = await postSearch(MULTI, { pattern: 'wsx needle', root: 1 });
  expect(limited.status).toBe(200);
  const limitedHits = hitFrames(limited);
  expect(new Set(limitedHits.map((f) => f.file))).toEqual(new Set(['wsx-r1.txt']));
  for (const f of limitedHits) {
    expect(f.root, '限定单根的命中帧不得携带 root 字段').toBeUndefined();
    expect(f.line).toBe(1);
    expect(f.text).toBe('wsx needle shared');
  }

  // ④ root=1 + path='sub'：path 相对所选根解析（root1/sub，非 root0 视角）；
  //    pattern 用专属词避免与顶层同 pattern 命中集互串
  const inSub = await postSearch(MULTI, { pattern: 'deep probe needle', root: 1, path: 'sub' });
  expect(inSub.status).toBe(200);
  expect(new Set(hitFrames(inSub).map((f) => f.file))).toEqual(new Set(['sub/needle-deep.txt']));

  // ⑤ root=0 限定对照：恰为 root0 文件、同样无 root 字段
  const limited0 = await postSearch(MULTI, { pattern: 'wsx needle', root: 0 });
  expect(limited0.status).toBe(200);
  const hits0 = hitFrames(limited0);
  expect(new Set(hits0.map((f) => f.file))).toEqual(new Set(['wsx-r0.txt']));
  for (const f of hits0) expect(f.root).toBeUndefined();

  // ⑥ 列号语义按引擎分流：rg 主路径精确列（pattern 首列 = 1）；grep 无列号恒 1
  for (const f of limitedHits) {
    if (health.searchEngine === 'rg') {
      expect(f.col).toBe(1);
    } else {
      expect(f.col).toBe(1); // grep 回退：col 恒 1（设计 §1 决策表）
    }
  }
});

// ---------------------------------------------------------------- WSX-02

test('WSX-02: /api/search 多根歧义/越界 4xx 矩阵 + 单根历史形状对照（400 不外溢单根）', async () => {
  test.setTimeout(60_000);
  // ① 多根下 root 缺省 + path：无基准根歧义 → 400（search.rs:221-223）
  const ambiguous = await postSearch(MULTI, { pattern: 'wsx', path: 'wsx-r0.txt' });
  expect(ambiguous.status).toBe(400);
  expect(ambiguous.error).toContain('path requires an explicit root');

  // ② root 越界 → 400：可达文案是 guard::resolve_at 的前置拒绝（guard.rs:38-40，
  //    `root index out of range: 2`）——search.rs:293-299 的 parser_roots 越界分支
  //    是防御式兜底，正常请求在目录解析阶段已被拒，两处文案以可达者为准
  const oob = await postSearch(MULTI, { pattern: 'wsx', root: 2 });
  expect(oob.status).toBe(400);
  expect(oob.error).toContain('root index out of range: 2');

  // ③ root=1 + `../`：guard 清洗层先于 canonicalize → 400（guard.rs:23）
  const trav = await postSearch(MULTI, { pattern: 'wsx', root: 1, path: '../outside' });
  expect(trav.status).toBe(400);
  expect(trav.error).toContain("path must not contain '..'");

  // ④ root=1 + 不存在目录：canonicalize NotFound 档 → 404（非 200/403）
  const missing = await postSearch(MULTI, { pattern: 'wsx', root: 1, path: 'no-such-dir' });
  expect(missing.status).toBe(404);
  expect(missing.error).toBe('path not found');

  // ⑤ 空 pattern：参数校验 → 400（search.rs:211-213）
  const empty = await postSearch(MULTI, { pattern: '' });
  expect(empty.status).toBe(400);
  expect(empty.error).toBe('pattern must not be empty');

  // ⑥ 单根历史形状对照（主实例 :4174）：path 合法无需 root → 200、命中全部落在
  //    所指文件、帧无 root 字段——多根歧义 400 不得外溢单根部署（spec §2.1 单根兼容决策）
  const single = await postSearch(BASE, { pattern: 'greet', path: 'hello.js' });
  expect(single.status).toBe(200);
  const singleHits = hitFrames(single);
  expect(singleHits.length).toBeGreaterThanOrEqual(1); // hello.js 内 greet 两处（line 2/8）
  for (const f of singleHits) {
    expect(f.file).toBe('hello.js');
    expect(f.root).toBeUndefined();
  }

  // ⑦ 护栏：越界防护不误伤合法索引（WSX-01③ 同请求复测为独立判据收尾）
  const ok = await postSearch(MULTI, { pattern: 'wsx needle', root: 1 });
  expect(ok.status).toBe(200);
});

// ---------------------------------------------------------------- WSX-03

test('WSX-03: rg 缺失注入 → health 宣告 grep + /api/search grep 引擎 200（col=1）+ 前端徽标/降级 tooltip', async ({
  page
}) => {
  test.setTimeout(120_000);
  // ① API 面：health 如实宣告 grep（resolve_engine 探测链 rg 失败 → grep 命中）
  const health = (await (await fetch(`${GREP}/api/health`)).json()) as { searchEngine?: string };
  expect(health.searchEngine).toBe('grep');

  // ② grep 引擎 NDJSON：命中帧形状完整且 col 恒 1（grep 无列号，设计 §1 决策表），
  //    终帧 done（grep_args 的 -rHn --null 行解析全链真实执行）
  const search = await postSearch(GREP, { pattern: 'grep engine needle' });
  expect(search.status).toBe(200);
  const hits = hitFrames(search);
  expect(hits).toHaveLength(1);
  expect(hits[0]!.file).toBe('wsx-grep-needle.txt');
  expect(hits[0]!.line).toBe(1);
  expect(hits[0]!.col).toBe(1);
  expect(hits[0]!.text).toBe('grep engine needle here');
  const doneFrame = search.frames[search.frames.length - 1]!;
  expect(doneFrame.done).toBe(true);

  // ③ UI 面：:4174 页面跨源连接 :4397 → health 宣告写入 sessionStorage（A 项缓存）
  await page.goto('/');
  await connectForm(page, GREP);
  await expect(page.locator('.vv-tree-row', { hasText: 'wsx-grep-needle.txt' }).first()).toBeVisible({
    timeout: 15_000
  });
  const cached = await page.evaluate(() => sessionStorage.getItem('vv:search-engine'));
  expect(cached).toBe('grep');

  // ④ 徽标：面板打开即读缓存（GlobalSearchPanel 组件初始化 loadSearchEngine）
  await page.keyboard.press('Control+Shift+F');
  await expect(page.locator('.vv-gsearch')).toBeVisible();
  const badge = page.locator('.vv-gsearch-hint', { hasText: '服务端搜索：grep' });
  await expect(badge).toBeVisible();
  // grep 徽标 tooltip 注明限制（设计 §2.4：无列定位、顺序不保证、ERE 方言）
  expect(await badge.getAttribute('title')).toContain('降级引擎');

  // ⑤ 真实搜索走服务端引擎：结果可用且无「已改用浏览器内搜索」降级提示
  await page.getByLabel('全局搜索内容').fill('grep engine needle');
  await expect(page.locator('.vv-gsearch-status')).toContainText('个命中', { timeout: 15_000 });
  await expect(page.locator('.vv-gsearch-file-path', { hasText: 'wsx-grep-needle.txt' })).toBeVisible({
    timeout: 15_000
  });
  await expect(page.locator('.vv-gsearch-hint', { hasText: '已改用浏览器内搜索' })).toHaveCount(0);
  await page.keyboard.press('Escape');
});

// ---------------------------------------------------------------- WSX-04

test('WSX-04: rg+grep 双缺 → 501 + health searchEngine 整体省略 + 前端徽标缺失（主实例 rg 宣告护栏）', async ({
  page
}) => {
  test.setTimeout(120_000);
  // ① health 双缺：字段整体省略（health.rs:105-110 语义——不是 null 也不是空串）
  const noEngineHealth = (await (await fetch(`${NOENGINE}/api/health`)).json()) as Record<string, unknown>;
  expect('searchEngine' in noEngineHealth).toBe(false);

  // ② 双缺 501：resolve_engine 兜底错误文案（search.rs:130-132）
  const search = await postSearch(NOENGINE, { pattern: 'nothing to find' });
  expect(search.status).toBe(501);
  expect(search.error).toContain('neither ripgrep (rg) nor grep found on server');

  // ③ 护栏：主实例（继承进程 PATH）宣告 rg——注入不影响默认探测链
  const mainHealth = (await (await fetch(`${BASE}/api/health`)).json()) as { searchEngine?: string };
  expect(mainHealth.searchEngine).toBe('rg');

  // ④ UI：连双缺实例 → saveSearchEngine(undefined) 清缓存 → 面板无徽标
  //   （CMP-09 已锚该拓扑的 501 降级搜索面，此处只锚宣告/徽标缺失面）
  await page.goto('/');
  await connectForm(page, NOENGINE);
  await expect(page.locator('.vv-tree-row', { hasText: 'wsx-quiet.txt' }).first()).toBeVisible({
    timeout: 15_000
  });
  const cached = await page.evaluate(() => sessionStorage.getItem('vv:search-engine'));
  expect(cached).toBeNull();
  await page.keyboard.press('Control+Shift+F');
  await expect(page.locator('.vv-gsearch')).toBeVisible();
  await expect(page.locator('.vv-gsearch-hint', { hasText: '服务端搜索：' })).toHaveCount(0);
  await page.keyboard.press('Escape');
});

// ---------------------------------------------------------------- WSX-05

test('WSX-05: /api/compute/highlight 携 root——path 模式按根解析（baseLine 锐证）、越界 400、text 模式不涉 root', async () => {
  test.setTimeout(60_000);
  const url = `${COMPUTE}/api/compute/highlight`;
  const post = async (body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown>; error: string }> => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    const text = await res.text();
    if (!res.ok) {
      let error = text;
      try {
        error = (JSON.parse(text) as ErrorBody).error ?? text;
      } catch {
        // 非 JSON 错误体
      }
      return { status: res.status, body: {}, error };
    }
    return { status: res.status, body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>), error: '' };
  };

  // ① root=1 path 模式：200 + 真实高亮区间（js 关键字/字符串出区间）
  const r1 = await post({ path: 'wsx-hl-r1.js', lang: 'javascript', root: 1 });
  expect(r1.status).toBe(200);
  expect(Array.isArray(r1.body.intervals)).toBe(true);
  expect((r1.body.intervals as unknown[]).length).toBeGreaterThanOrEqual(1);
  expect((r1.body.captures as unknown[]).length).toBeGreaterThanOrEqual(1);
  expect(r1.body.baseLine).toBe(0);

  // ② 缺省 root = 0 号根：root0 无该文件 → 404（highlight.rs:449 unwrap_or(0)，不串根）
  const omitted = await post({ path: 'wsx-hl-r1.js', lang: 'javascript' });
  expect(omitted.status).toBe(404);
  expect(omitted.error).toBe('path not found');

  // ③ root=0 显式：root0 文件正常
  const r0 = await post({ path: 'wsx-hl-r0.js', lang: 'javascript', root: 0 });
  expect(r0.status).toBe(200);
  expect(r0.body.baseLine).toBe(0);

  // ④ root 路由锐证：root1 文件 3 行，range.startLine=2 可读 → baseLine===2；
  //    若误读 root0 的 1 行同名不存在文件（或串到 1 行的 r0 文件）必 400
  //    startLine beyond EOF——baseLine 值本身即「读的是 root1 文件」的证明
  const ranged = await post({
    path: 'wsx-hl-r1.js',
    lang: 'javascript',
    root: 1,
    range: { startLine: 2, lineCount: 1 }
  });
  expect(ranged.status).toBe(200);
  expect(ranged.body.baseLine).toBe(2);

  // ⑤ root 越界 → 400（guard.resolve_at 文案形态 `root index out of range: 9`，
  //    与 search.rs 的 `root index 2 out of range` 分文案锁定）
  const oob = await post({ path: 'wsx-hl-r0.js', lang: 'javascript', root: 9 });
  expect(oob.status).toBe(400);
  expect(oob.error).toContain('root index out of range: 9');

  // ⑥ text 模式不涉 root：越界 root 在场仍 200 出区间（root 仅 path 模式语义）
  const textMode = await post({ text: 'const z = 1;\n', lang: 'javascript', root: 9 });
  expect(textMode.status).toBe(200);
  expect((textMode.body.intervals as unknown[]).length).toBeGreaterThanOrEqual(1);
});

// ---------------------------------------------------------------- WSX-06

test('WSX-06: watch SSE 帧风暴聚合——单窗口 24 连写聚合为有界 changed 帧（逐根发帧 + 并集完整）', async () => {
  test.setTimeout(60_000);
  // SSE 建连（t-srv BUG-68 用例同款：ticket → events）
  const ticket = (
    (await (await fetch(`${MULTI}/api/ticket`, { method: 'POST' })).json()) as { ticket: string }
  ).ticket;
  const res = await fetch(`${MULTI}/api/events?ticket=${encodeURIComponent(ticket)}`, {
    headers: { accept: 'text/event-stream' }
  });
  expect(res.ok).toBeTruthy();
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  /** 读一个 SSE chunk；超时返回 null（pending read 复用——被 race 丢弃的 read
   *  仍会吞走下一个 chunk，对本用例「收窗即停」的消费模式可接受）。 */
  let pendingRead: Promise<string | null> | null = null;
  const readChunk = (timeoutMs: number): Promise<string | null> => {
    pendingRead ??= reader.read().then(({ value, done }) => {
      pendingRead = null;
      return done ? null : decoder.decode(value);
    });
    pendingRead.catch(() => {}); // race 丢弃后若流出错，不产生 unhandled rejection
    return Promise.race([
      pendingRead,
      new Promise<null>((r) => setTimeout(() => r(null), timeoutMs))
    ]);
  };

  try {
    // 帧风暴注入：24 个文件在单次同步循环内连写（远小于 500ms debounce 窗口——
    // watch.rs:96 DEBOUNCE_WINDOW / session_loop 固定窗口「窗口内后续事件并入
    // 同一条 changed」承诺的注入面）
    const burstNames: string[] = [];
    for (let i = 0; i < 24; i++) {
      const name = `burst-${String(i).padStart(2, '0')}.txt`;
      burstNames.push(name);
      writeFileSync(join(root1, name), `burst payload ${i}\n`);
    }

    // 收集 4s（≫ 500ms 窗口 + inotify/聚合裕量；取保守窗宽吸收门禁负载下的
    // 交付延迟——t-srv waitFrame 同量级）
    let buffer = '';
    const deadline = Date.now() + 4_000;
    while (Date.now() < deadline) {
      const chunk = await readChunk(500);
      if (chunk !== null) buffer += chunk;
    }

    // 解析 changed 帧（`data: {json}` 行）
    interface ChangedFrame {
      type?: string;
      root?: number;
      paths?: string[];
    }
    const frames = buffer
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => {
        try {
          return JSON.parse(l.slice(5).trim()) as ChangedFrame;
        } catch {
          return null;
        }
      })
      .filter((f): f is ChangedFrame => f !== null && f.type === 'changed');

    // ① 帧风暴防护：帧数有界（≪ 24）且非零——debounce 聚合承诺的直接可观测形态
    expect(frames.length, `24 连写应聚合为有界帧，实得 ${frames.length}`).toBeLessThan(24);
    expect(frames.length).toBeGreaterThanOrEqual(1);

    // ② 逐根发帧 + 跨根隔离：多根部署显式携带 root（root0 无写入 → 全部帧 root:1，
    //    无 root0 帧、无跨根路径混入）
    for (const f of frames) {
      expect(f.root).toBe(1);
      for (const p of f.paths ?? []) {
        expect(burstNames, `帧路径应属 burst 注入集: ${p}`).toContain(p);
      }
    }

    // ③ 聚合不丢事件：24 个路径的并集完整覆盖
    const union = new Set(frames.flatMap((f) => f.paths ?? []));
    for (const name of burstNames) {
      expect(union.has(name), `burst 路径 ${name} 未出现在任何 changed 帧`).toBe(true);
    }

    // ④ 聚合确证：至少一帧并入 ≥2 条路径（24 连写在一个窗口内，合并必然发生）
    expect(frames.some((f) => (f.paths ?? []).length >= 2)).toBe(true);
  } finally {
    await reader.cancel().catch(() => {});
  }
});
