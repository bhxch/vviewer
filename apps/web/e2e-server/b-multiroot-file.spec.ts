import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, type Page } from '@playwright/test';
import { assertPortFree, stopServer, waitHealthy } from '../e2e/serverHarness';
import { closeDrawerIfOpened, openDrawerIfNarrow } from '../e2e/drawer';

/**
 * 多根 file 通道与越界防护（MRF-01~08，编号对照 docs/e2e/multiroot-file-channel.md
 * 第 2/3 节；b- 前缀 = server 套件补充轮）。补齐 SRV-MULTIROOT（t-srv.spec.ts:609，
 * 只锚 health/tree/search/SSE 四面）未覆盖的 file 通道 `?root=` 路由与越界防护 +
 * 多根来源 UI 全链（rootIndex 透传 / watch 帧按来源根过滤）：
 * - MRF-01：file?root=N 按根路由（root=0 显式 = 缺省，root=1 取 1 号根子树）；
 * - MRF-02：root 越界 400「root index out of range」（file/tree 双端点 + 坏输入）；
 * - MRF-03：`../` 清洗 400、root0-only 路径在 root=1 下 404（按根解析不串根）；
 * - MRF-04：root 内 symlink 越界 403「path escapes root」（guard.rs:46-50，
 *   BUG-68 建链手法：root1/esc → ../outside-secret）；
 * - MRF-05：root×Range 共存（206 / Content-Range / 尾钳制 / 布点字节核对）；
 * - MRF-06：单根实例兼容（显式 root=0 正常、缺省形状不变、越界仍 400）；
 * - MRF-07：UI 全链——双根实例 :4395 伺服 web-dist → 连本机 → health roots=2 选根
 *   1 添加来源 → 打开文件渲染且 /api/file 请求带 root=1（remote.ts rootIndex 透传，
 *   BUG-107 回归形态「回落 0 号根」在此拦截）；
 * - MRF-08：watch 帧按来源 rootIndex 过滤（remote.ts:240）——root0 同名文件变更
 *   不触发 root1 来源 tab 重读（负向），root1 变更照常重读（正向对照证明链路活）。
 *
 * 实例拓扑：主实例 :4174 由 playwright.server.config.ts webServer 启动（单根，
 * MRF-06 专用）；beforeAll 另起双根实例（:4395，`--root root0 --root root1`，两根为
 * 互不相交的独立 mkdtemp 目录——嵌套根会被 strip_root 逐根前缀匹配误归 0 号根，
 * t-srv SRV-MULTIROOT 注释同款约束；不写共享 FIXTURE，root0 顶层清单被既有用例
 * 断言）。端口 4395 与既有 4173/4174/4375-4384/8399/8449 错开；套件单 worker
 * （playwright.server.config.ts workers:1）串行执行。API 级场景直接 fetch（node
 * fetch），UI 级场景经同源页面 :4395（无 CORS 面）。
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const BIN = join(repoRoot, 'server/target/release/vviewer');
const WEB_DIST = join(repoRoot, 'apps/web/build');
const BASE = 'http://127.0.0.1:4174'; // 主实例（webServer，单根）

const PORT_MULTI = 4395;
const MULTI_BASE = `http://127.0.0.1:${PORT_MULTI}`;
const MULTI_HOST = `127.0.0.1:${PORT_MULTI}`;

let multiChild: ChildProcess | null = null;
let baseDir = '';
let root0 = '';
let root1 = '';

test.beforeAll(async () => {
  // ---- 双根夹具（独立 mkdtemp，互不相交；幂等写）----
  baseDir = mkdtempSync(join(os.tmpdir(), 'vv-mrf-'));
  root0 = join(baseDir, 'root0');
  root1 = join(baseDir, 'root1');
  mkdirSync(root0, { recursive: true });
  mkdirSync(join(root1, 'sub'), { recursive: true });
  writeFileSync(join(root0, 'a.txt'), 'root0-alpha\n');
  writeFileSync(join(root0, 'other.txt'), 'root0 other\n');
  writeFileSync(join(root1, 'b.txt'), 'root1-beta\n');
  writeFileSync(join(root1, 'sub/only-r1.txt'), 'only in root1\n');
  writeFileSync(join(root1, 'hello-r1.txt'), 'root1 hello v1\n');
  // MRF-04：越界 symlink（目标在双根之外的 base 侧，内容可读——403 只能来自
  // canonicalize 越界校验而非 EACCES；建链手法同 BUG-68 探索用例）
  writeFileSync(join(baseDir, 'outside-secret'), 'outside secret\n');
  symlinkSync('../outside-secret', join(root1, 'esc'));
  // MRF-05：1MB 二进制（值 = 偏移低 8 位，0xde 布点于 0x100/0xff00/0xffffa——
  // 末布点供尾段 Range 的 body 字节核对）
  const bin = Buffer.alloc(1024 * 1024);
  for (let i = 0; i < bin.length; i++) bin[i] = i & 0xff;
  bin[0x100] = 0xde;
  bin[0xff00] = 0xde;
  bin[0xffffa] = 0xde;
  writeFileSync(join(root1, 'range.bin'), bin);

  // ---- 双根实例（assertPortFree fail-fast，不复用遗留实例——mkdtemp 根每次
  //      不同，复用旧实例会指向已删目录；SRV-MULTIROOT 同款手法）----
  await assertPortFree(`${MULTI_BASE}/api/health`);
  multiChild = spawn(
    BIN,
    [
      'serve', '--root', root0, '--root', root1, '--web-dist', WEB_DIST,
      '--port', String(PORT_MULTI)
    ],
    { stdio: ['ignore', 'inherit', 'inherit'] }
  );
  await waitHealthy(MULTI_BASE);
});

test.afterAll(async () => {
  await stopServer(multiChild, 'mrf-multiroot');
  if (baseDir !== '') rmSync(baseDir, { recursive: true, force: true });
});

/** 错误体 JSON 形状（error.rs：`{"error": msg}`） */
interface ErrorBody {
  error?: string;
}

/** 精确名正则（同名行歧义防护，t-srv exactName 同款） */
function exactName(name: string): RegExp {
  return new RegExp(`^${name.replace(/[.*+?${}()|[\]\\]/g, '\\$&')}$`);
}

/** 树行精确匹配：exactName 须挂在子 .vv-tree-name 上（行按钮 textContent 带标记
 *  空白，正则锚 ^$ 会失配）——t-srv.spec.ts:130-135 treeRow 同款形态 */
function treeRow(page: Page, name: string): ReturnType<Page['locator']> {
  return page
    .locator('.vv-tree-row')
    .filter({ has: page.locator('.vv-tree-name', { hasText: exactName(name) }) });
}

/** 连接表单提交（t-srv/b-io-streaming connectForm 同款；token 留空） */
async function connectForm(page: Page, base: string): Promise<void> {
  await page.getByRole('button', { name: '连接服务器' }).click();
  await page.getByLabel('服务器地址').fill(base);
  await page.getByRole('button', { name: '连接', exact: true }).click();
}

/** 等应用挂载（t-workspace/b-io-streaming waitAppMounted 同款） */
async function waitAppMounted(page: Page, origin: string): Promise<void> {
  await page.goto(`${origin}/`);
  await page.waitForFunction(
    () => typeof (window as unknown as { __vvOpenDirImpl?: unknown }).__vvOpenDirImpl === 'function'
  );
  await expect(page.locator('.vv-topbar')).toBeVisible();
}

/**
 * MRF-07/08 共用前置：双根来源 UI 全链搭到「root1 来源的 hello-r1.txt 已渲染」。
 * 记录器先挂（不漏首开请求）→ 连接（写 last-server + 建 0 号根 store）→ 新建
 * 工作区 → 后端路径浏览（health roots=2 先选根）→ 选 1 号根 → 整根作来源 →
 * 创建并激活 → 树中打开 hello-r1.txt。
 */
async function openRoot1HelloTab(page: Page, fileReqs: string[]): Promise<void> {
  page.on('request', (r) => {
    if (new URL(r.url()).pathname === '/api/file') fileReqs.push(r.url());
  });
  await waitAppMounted(page, MULTI_BASE);
  await connectForm(page, MULTI_BASE);
  await expect(page.locator('.vv-tab', { hasText: MULTI_HOST })).toBeVisible({ timeout: 10_000 });

  // 来源创建流：切换器 → 新建模态 → 后端路径（t-workspace WS-05 同款）
  await page.locator('.vv-ws-trigger').click();
  await page.getByRole('button', { name: '＋ 新建工作区…' }).click();
  const modal = page.locator('.vv-wscreate');
  await expect(modal).toBeVisible();
  await page.getByLabel('工作区名称').fill('根1源组');
  await modal.getByRole('button', { name: '后端路径…' }).click();
  const browse = page.locator('.vv-remotesrc');
  await expect(browse).toBeVisible();
  // health roots=2 → 先展示根选择，两根按钮文案 = health rootPaths canonical 路径
  await expect(browse.locator('.vv-remotesrc-roots button')).toHaveCount(2);
  await browse.locator('.vv-remotesrc-roots button').nth(1).click(); // 选 1 号根
  await expect(browse.locator('.vv-remotesrc-rootback')).toContainText(root1); // 当前根 = 1 号
  // root1 子树清单：只见 root1 条目，root0 条目不得串根出现
  await expect(browse.locator('.vv-remotesrc-row', { hasText: 'hello-r1.txt' })).toBeVisible({
    timeout: 10_000
  });
  await expect(browse.locator('.vv-remotesrc-row', { hasText: 'a.txt' })).toHaveCount(0);
  // 整根作来源（pickcurrent 按钮名含「将此文件/目录作为来源」无子串歧义，
  // WS-05 exact 教训只针对行内「作为来源」短名）
  await browse.getByRole('button', { name: /将当前目录作为来源/ }).click();
  await expect(browse).toHaveCount(0);
  await modal.getByRole('button', { name: '创建并激活' }).click();
  await expect(modal).toHaveCount(0);

  // 新工作区：root1 来源目录 tab + 树单源分组（标签 = `${host} · 根1/`，
  // openFlow.svelte.ts remoteSourceLabel rootIndex!==0 分支）
  await expect(page.locator('.vv-tab', { hasText: '根1' })).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('.vv-tree-src-label', { hasText: '根1' })).toBeVisible({
    timeout: 10_000
  });
  await expect(page.locator('.vv-tree-src-label')).toHaveCount(1);

  // 树中打开 hello-r1.txt（窄视口抽屉适配；server 套件 chromium 宽视口下为空操作）
  const drawer = await openDrawerIfNarrow(page);
  const row = treeRow(page, 'hello-r1.txt');
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.click();
  await closeDrawerIfOpened(page, drawer);
  await expect(page.locator('.vv-tab.active', { hasText: 'hello-r1.txt' })).toBeVisible();
  await expect(page.locator('.vv-code-pre')).toContainText('root1 hello v1', { timeout: 20_000 });
}

/** hello-r1.txt 的 root=1 形态 /api/file 请求计数（rootIndex 透传的唯一 URL 指纹） */
function countHelloRoot1(fileReqs: string[]): number {
  return fileReqs.filter((u) => u.includes('path=hello-r1.txt&root=1')).length;
}

// ---------------------------------------------------------------- MRF-01

test('MRF-01: file?root=N 按根路由——root=0 显式与缺省等价、root=1 取 1 号根子树', async () => {
  // ① 显式 root=0 与 ② 缺省等价：同取 root0/a.txt
  const explicit0 = await fetch(`${MULTI_BASE}/api/file?path=${encodeURIComponent('a.txt')}&root=0`);
  expect(explicit0.status).toBe(200);
  expect(await explicit0.text()).toBe('root0-alpha\n');
  const omitted = await fetch(`${MULTI_BASE}/api/file?path=${encodeURIComponent('a.txt')}`);
  expect(omitted.status).toBe(200);
  expect(await omitted.text()).toBe('root0-alpha\n');

  // ③ root=1 按 1 号根解析：取 root1/b.txt（file.rs:189 resolve_at(…, q.root.unwrap_or(0))）
  const r1 = await fetch(`${MULTI_BASE}/api/file?path=${encodeURIComponent('b.txt')}&root=1`);
  expect(r1.status).toBe(200);
  expect(await r1.text()).toBe('root1-beta\n');
});

// ---------------------------------------------------------------- MRF-02

test('MRF-02: root 越界 400「root index out of range」——file/tree 双端点 + 坏输入不 500 化', async () => {
  // ① file 越界（roots=2，idx=2 超界；guard.rs:36-38）
  const fileOob = await fetch(`${MULTI_BASE}/api/file?path=${encodeURIComponent('a.txt')}&root=2`);
  expect(fileOob.status).toBe(400);
  expect(((await fileOob.json()) as ErrorBody).error).toContain('root index out of range');

  // ② tree 越界同防（tree.rs:46 同走 resolve_at）
  const treeOob = await fetch(`${MULTI_BASE}/api/tree?path=&root=9`);
  expect(treeOob.status).toBe(400);
  expect(((await treeOob.json()) as ErrorBody).error).toContain('root index out of range');

  // ③ 坏输入（负数/非数字，usize 反序列化失败 → axum Query 拒绝）：客户端错误档，不得 500
  const neg = await fetch(`${MULTI_BASE}/api/file?path=${encodeURIComponent('a.txt')}&root=-1`);
  expect(neg.status).toBeGreaterThanOrEqual(400);
  expect(neg.status).toBeLessThan(500);

  // ④ 护栏：恰界 root=1 正常（越界防护不误伤合法索引）
  const ok = await fetch(`${MULTI_BASE}/api/file?path=${encodeURIComponent('b.txt')}&root=1`);
  expect(ok.status).toBe(200);
});

// ---------------------------------------------------------------- MRF-03

test('MRF-03: ../ 清洗 400、root0-only 路径在 root=1 下 404——按根解析不串根', async () => {
  // ① `../` 清洗层拒绝（guard.rs:22，先于 canonicalize）
  const trav = await fetch(
    `${MULTI_BASE}/api/file?path=${encodeURIComponent('../a.txt')}&root=1`
  );
  expect(trav.status).toBe(400);
  expect(((await trav.json()) as ErrorBody).error).toContain("must not contain '..'");

  // ② root0-only 路径在 root=1 视角不存在：404（canonicalize NotFound 档），
  //    不是 200 也不是 403——证明按所选根解析、根间不串
  const cross = await fetch(`${MULTI_BASE}/api/file?path=${encodeURIComponent('other.txt')}&root=1`);
  expect(cross.status).toBe(404);
  expect(((await cross.json()) as ErrorBody).error).toBe('path not found');

  // ③ 护栏：root1 子树内文件正常（root1/sub/only-r1.txt）
  const ok = await fetch(
    `${MULTI_BASE}/api/file?path=${encodeURIComponent('sub/only-r1.txt')}&root=1`
  );
  expect(ok.status).toBe(200);
  expect(await ok.text()).toBe('only in root1\n');
});

// ---------------------------------------------------------------- MRF-04

test('MRF-04: root 内 symlink 越界 403「path escapes root」（BUG-68 建链手法）', async () => {
  // ① root1/esc → ../outside-secret（双根之外真实文件，可读）：canonicalize 后
  //    越出所选根 canonical → 403（guard.rs:46-50；TOCTOU 窗口为已知接受风险）
  const esc = await fetch(`${MULTI_BASE}/api/file?path=${encodeURIComponent('esc')}&root=1`);
  expect(esc.status).toBe(403);
  expect(((await esc.json()) as ErrorBody).error).toBe('path escapes root');

  // ② 护栏：root1 内正常文件不受越界 symlink 存在影响
  const ok = await fetch(`${MULTI_BASE}/api/file?path=${encodeURIComponent('b.txt')}&root=1`);
  expect(ok.status).toBe(200);
});

// ---------------------------------------------------------------- MRF-05

test('MRF-05: root×Range 共存——root=1 文件 206/Content-Range/尾钳制与布点字节', async () => {
  const url = `${MULTI_BASE}/api/file?path=${encodeURIComponent('range.bin')}&root=1`;

  // ① 恰界窗口 bytes=0-1023：206 + Content-Range 全长 + body 恰 1024 字节且布点在位
  const win = await fetch(url, { headers: { Range: 'bytes=0-1023' } });
  expect(win.status).toBe(206);
  expect(win.headers.get('content-range')).toBe('bytes 0-1023/1048576');
  expect(win.headers.get('accept-ranges')).toBe('bytes');
  expect(win.headers.get('content-type')).toBe('application/octet-stream'); // 非 UTF-8 面
  const winBody = Buffer.from(await win.arrayBuffer());
  expect(winBody.length).toBe(1024);
  expect(winBody[0x100]).toBe(0xde);

  // ② 开口尾段 bytes=1048570-：钳制到末字节（end=size-1），布点 0xffffa 在位
  const tail = await fetch(url, { headers: { Range: 'bytes=1048570-' } });
  expect(tail.status).toBe(206);
  expect(tail.headers.get('content-range')).toBe('bytes 1048570-1048575/1048576');
  const tailBody = Buffer.from(await tail.arrayBuffer());
  expect(tailBody.length).toBe(6);
  expect(tailBody[0]).toBe(0xde);

  // ③ root 参数与 Range 语义互不干扰：同 root=1 无 Range 全量 200
  const full = await fetch(url);
  expect(full.status).toBe(200);
  expect(full.headers.get('content-length')).toBe('1048576');
});

// ---------------------------------------------------------------- MRF-06

test('MRF-06: 单根实例兼容——显式 root=0 正常、缺省形状不变、越界仍 400（主实例 :4174）', async () => {
  // ① 显式 root=0：单根下合法索引，正常返回（单根请求形状不因多根参数回归）
  const explicit0 = await fetch(`${BASE}/api/file?path=${encodeURIComponent('hello.js')}&root=0`);
  expect(explicit0.status).toBe(200);
  expect(await explicit0.text()).toContain('greet');

  // ② 缺省（无 root 参数）：历史形状不变
  const omitted = await fetch(`${BASE}/api/file?path=${encodeURIComponent('hello.js')}`);
  expect(omitted.status).toBe(200);
  expect(await omitted.text()).toContain('greet');

  // ③ 单根下越界同样防护（roots=1，idx=3 超界）
  const oob = await fetch(`${BASE}/api/file?path=${encodeURIComponent('hello.js')}&root=3`);
  expect(oob.status).toBe(400);
  expect(((await oob.json()) as ErrorBody).error).toContain('root index out of range');
});

// ---------------------------------------------------------------- MRF-07

test('MRF-07: 多根来源 UI 全链——health roots=2 选根 1 添加来源、打开文件渲染且请求带 root=1', async ({
  page
}) => {
  test.setTimeout(90_000);
  const fileReqs: string[] = [];
  await openRoot1HelloTab(page, fileReqs);

  // 渲染正确 + 无错误卡片
  await expect(page.locator('.vv-code-pre')).toContainText('root1 hello v1');
  await expect(page.locator('.vv-error-card')).toHaveCount(0);

  // rootIndex 透传（remote.ts:181-183 rootIndex!==0 追加 &root=）：hello-r1.txt 的
  // 全部 /api/file 请求带 root=1；无 root 参数的回落 0 号根请求（BUG-107 回归形态）零出现
  const helloReqs = fileReqs.filter((u) => u.includes('path=hello-r1.txt'));
  expect(helloReqs.length).toBeGreaterThanOrEqual(1);
  for (const u of helloReqs) {
    expect(u, `root1 来源文件请求必须带 root=1: ${u}`).toContain('root=1');
  }
});

// ---------------------------------------------------------------- MRF-08

test('MRF-08: watch 帧按来源 rootIndex 过滤——root0 变更不重渲 root1 来源 tab、root1 变更重渲', async ({
  page
}) => {
  test.setTimeout(90_000);
  const fileReqs: string[] = [];
  await openRoot1HelloTab(page, fileReqs);
  await page.waitForTimeout(300); // 首开收敛保险（b-io-streaming 同款）
  const baseline = countHelloRoot1(fileReqs);
  expect(baseline).toBeGreaterThanOrEqual(1);

  // ① 负向：root0 写入「同名」文件 hello-r1.txt（帧 root:0 + paths:['hello-r1.txt']，
  //    若 rootIndex 过滤失效——remote.ts:240——root1 store 会命中该 path 触发重读重渲）
  writeFileSync(join(root0, 'hello-r1.txt'), 'root0 impostor\n');
  await page.waitForTimeout(3_500); // watcher 500ms debounce + SSE + 渲染全程裕量
  expect(countHelloRoot1(fileReqs)).toBe(baseline); // 无新请求 = 未重读
  await expect(page.locator('.vv-code-pre')).toContainText('root1 hello v1'); // 内容不变
  await expect(page.locator('.vv-code-pre')).not.toContainText('root0 impostor');

  // ② 正向对照：root1 变更 → changed 帧被接受 → rev++ 重读 + 内容更新（证明
  //    SSE 链路活，①的非变化只能归因于按根过滤而非链路失效）
  const marker = `root1 hello v2 ${Date.now()}`;
  writeFileSync(join(root1, 'hello-r1.txt'), `${marker}\n`);
  await expect
    .poll(() => countHelloRoot1(fileReqs), { timeout: 10_000 })
    .toBeGreaterThan(baseline);
  await expect(page.locator('.vv-code-pre')).toContainText(marker, { timeout: 10_000 });
});
