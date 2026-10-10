import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, type Page } from '@playwright/test';
import { stopServer, waitHealthy } from '../e2e/serverHarness';

/**
 * compute-global-search 域补缺（docs/e2e/compute-global-search.md 第 2/3 节）。
 * 既有覆盖不重写：CMP-01/CMP-05 → m6.spec.ts（capabilities+状态栏远程、GFM remote/
 * local+comrak 直连）；CMP-06 的分组/<mark>/点击打开半 → m6.spec.ts。
 *
 * 本文件覆盖（缺陷回归为主）：
 * - CMP-02/BUG-10：显式 remote 下 >2MB 文件不再被本地阈值压制（状态栏远程 + POST
 *   /api/compute/highlight 发生）；auto 双护栏——server-served 3MB 不限大小走服务端
 *   （POST + tree-sitter 渲染），本地添加 3MB（单文件上传通道）恒本地懒高亮零 POST；
 *   宣告门（阶段 4 收口，spec §7.3 勘误承接）——server-served >2MB .jsonc（差集
 *   语言，languages.json 342 与 301 差集 57）+ auto：零 POST + 行级 hljs 本地分块
 *   （同源 compute 实例；跨源下 X-VV-Lang 未被 CORS expose，门语义以同源为边界）
 * - CMP-03/BUG-22：auto 下含围栏 md 与 html（渲染/源码两视图）均显示「渲染: 本地」；
 *   围栏二级高亮保留；非注入语言（py）auto 仍远程（路由矩阵抽样不回归）
 * - CMP-04：php（阶段 1 起在服务端 301 集内，正例对照）auto 远程成功；POST lang
 *   改写集外 brainfuck（server 单测同款名）触发真实 400——auto 回退本地可读，
 *   remote 错误卡片「远程高亮失败: HTTP 400」
 * - CMP-06/BUG-09：全局搜索点击命中行滚动定位（视口渲染命中行）+ .vv-search-hit-line
 *   高亮 + 2.5s 后不丢；分组/<mark> 回归
 * - CMP-07：Aa/.* 开关与 /api/search glob 参数（BUG-21 回归不破坏项）
 * - CMP-08：1000 命中止于上限 + truncated 终帧 + 远程 store 无服务器引导（BUG-11 远程侧护栏）
 * - CMP-09：无 rg 实例 501 + 前端降级提示「服务器 ripgrep 不可用」且结果可用
 * - CMP-12：搜索取消/重发——全部 POST 200、无 rg 进程残留
 *
 * 实例拓扑：主实例 :4174（webServer，无 compute）承担搜索类场景（search 属 file-server
 * 基础能力，不要求 --compute）；辅助 --compute 实例 :4178（带 token + cors-origin 指
 * 页面源，高亮/markdown 路由类场景经连接表单跨源连接，同 m5/m6 跨源前例）；同源
 * --compute 实例 :4180（无 token，宣告门用例专用——X-VV-Lang 需同源可读）；辅助无 rg
 * 实例 :4179（PATH 剔除 rg 所在目录，CMP-09 专用）。夹具 cg- 前缀写入共享 fixture 根。
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const BIN = join(repoRoot, 'server/target/release/vviewer');
const FIXTURE = process.env.VV_E2E_SERVER_FIXTURE ?? join(repoRoot, '.temp/e2e-server-fixture');
const BASE = 'http://127.0.0.1:4174';
const PAGE_ORIGIN = 'http://127.0.0.1:4174';
const CG_TOKEN = 'cg-e2e-token';
const PORT_COMPUTE = 4178;
const PORT_COMPUTE_SAME = 4180; // 宣告门专用：同源 compute 实例（页面即该实例伺服）
const PORT_NORG = 4179;

function spawnServe(port: number, extraArgs: string[], env?: NodeJS.ProcessEnv): ChildProcess {
  return spawn(
    BIN,
    [
      'serve', '--root', FIXTURE, '--web-dist', join(repoRoot, 'apps/web/build'),
      '--port', String(port), ...extraArgs
    ],
    { stdio: ['ignore', 'inherit', 'inherit'], ...(env ? { env } : {}) }
  );
}

let computeServer: ChildProcess | null = null;
let computeSameServer: ChildProcess | null = null;
let norgServer: ChildProcess | null = null;

/** PATH 剔除 rg 所在目录（probe_rg 按 PATH 逐目录探测可执行 rg） */
function pathWithoutRg(): string {
  const dirs = (process.env.PATH ?? '').split(':').filter((d) => d !== '');
  const kept = dirs.filter((d) => !existsSync(join(d, 'rg')));
  return kept.length > 0 ? kept.join(':') : '/usr/bin:/bin';
}

test.beforeAll(async () => {
  // ---- 夹具（cg- 前缀，幂等） ----
  mkdirSync(join(FIXTURE, 'cg-sub'), { recursive: true });
  // BUG-10 主体：>2MB（现役本地阈值 2MiB）单文件 JS，块内重复行避免转义噪音
  writeFileSync(join(FIXTURE, 'cg-code-3mb.js'), 'const vv = 1; // c\n'.repeat(160_000));
  // 宣告门 e2e（阶段 4 收口，spec §7.3 勘误承接）：languages.json 342 与服务端 301
  // 差集 57，jsonc 为差集内且 code 渲染白名单可达的语言——server-served 路径
  // X-VV-Lang 按条目名下发 jsonc（同源可读，前端本地 langdetect 的 grammar 归并
  // json 不生效），auto 宣告门前置拦截：零 POST + 行级 hljs 本地分块。载体行含
  // JSON 特征（hljs 原生注册 jsonc 别名，行级兜底按 jsonc 着色）
  writeFileSync(join(FIXTURE, 'cg-code-3mb.jsonc'), '{"vv": "cg", "n": 1} // jsonc\n'.repeat(120_000));
  writeFileSync(join(FIXTURE, 'cg-small-sample.js'), 'const small = "cg02";\n');
  writeFileSync(
    join(FIXTURE, 'cg-rust-fence.md'),
    '# 围栏路由\n\n```rust\nfn main() {\n    let a = 42;\n    println!("{}", a);\n}\n```\n\n正文段落。\n'
  );
  writeFileSync(
    join(FIXTURE, 'cg-with-script.html'),
    '<!DOCTYPE html>\n<html><head><title>cg03</title></head>\n<body><p>cg html body</p>\n<script>window.__vvCg = 1;</script>\n</body></html>\n'
  );
  writeFileSync(join(FIXTURE, 'cg-hello.py'), 'value = 7\nprint(f"v={value}")\n');
  // CMP-04 载体：php（301 集内）——阶段 1 语法源同步后 php 已是服务端支持的正例，
  // 用作对照组；集外 400 场景经 ② 的请求改写注入（见用例内注释）
  writeFileSync(join(FIXTURE, 'cg-probe.php'), '<?php\nfunction hello($n) { return "hi $n"; }\necho hello("php");\n');
  // BUG-09：801 行 tall-hit，第 751 行第 1 列 treasure（复核实测 801 行口径）
  const tall: string[] = [];
  for (let i = 1; i <= 801; i++) tall.push(i === 751 ? 'treasure buried on this line' : `filler ${i}`);
  writeFileSync(join(FIXTURE, 'cg-tall-hit.txt'), tall.join('\n') + '\n');
  writeFileSync(join(FIXTURE, 'cg-alpha.txt'), 'inner hit in alpha\nplain\n');
  writeFileSync(join(FIXTURE, 'cg-beta.txt'), 'inner hit in beta\nplain\n');
  // CMP-07：helio 关键词分布（避开 fixtures.mjs 的 hello.js 干扰计数）
  writeFileSync(join(FIXTURE, 'cg-case.txt'), 'helio lower one\nHelio upper one\nhelio lower two\n');
  writeFileSync(join(FIXTURE, 'cg-case.md'), '# Helio upper md\n');
  writeFileSync(join(FIXTURE, 'cg-case.js'), '// helio lower js\n');
  // CMP-08：30 文件 × 40 行 = 1200 命中 > 1000 上限
  for (let i = 0; i < 30; i++) {
    writeFileSync(join(FIXTURE, `cg-flood-${String(i).padStart(2, '0')}.txt`), 'flood line here\n'.repeat(40));
  }
  writeFileSync(join(FIXTURE, 'cg-needle.txt'), 'needle in text\n');

  // ---- 辅助实例（重试安全复用，同 b-server-file-service.spec.ts 口径） ----
  async function ensureServe(
    port: number,
    args: string[],
    env: NodeJS.ProcessEnv | undefined,
    store: (c: ChildProcess | null) => void
  ): Promise<void> {
    const url = `http://127.0.0.1:${port}`;
    try {
      if ((await fetch(`${url}/api/health`)).ok) return;
    } catch {
      // 端口空闲
    }
    const child = spawnServe(port, args, env);
    store(child);
    await waitHealthy(url);
  }
  await ensureServe(
    PORT_COMPUTE,
    ['--compute', '--token', CG_TOKEN, '--cors-origin', PAGE_ORIGIN],
    undefined,
    (c) => (computeServer = c)
  );
  // 宣告门专用同源实例：无 token、无 --cors-origin（页面与 API 同源，X-VV-Lang/
  // X-VV-Encoding 检测头无需 Access-Control-Expose-Headers 即可读——跨源部署下
  // 服务端 CORS 层未暴露该头，前端回落本地检测，宣告门语义边界见用例内注释）
  await ensureServe(
    PORT_COMPUTE_SAME,
    ['--compute'],
    undefined,
    (c) => (computeSameServer = c)
  );
  await ensureServe(
    PORT_NORG,
    ['--cors-origin', PAGE_ORIGIN],
    { ...process.env, PATH: pathWithoutRg() },
    (c) => (norgServer = c)
  );
});

test.afterAll(async () => {
  await stopServer(computeServer, 'cg-compute');
  await stopServer(computeSameServer, 'cg-compute-same');
  await stopServer(norgServer, 'cg-norg');
});

/** 连接服务器：任意同源实例（无 token；4174 主实例 / 4180 同源 compute 实例共用） */
async function connectSameOriginAt(page: Page, base: string): Promise<void> {
  await page.goto(base + '/');
  await page.getByRole('button', { name: '连接服务器' }).click();
  await page.getByLabel('服务器地址').fill(base);
  await page.getByRole('button', { name: '连接', exact: true }).click();
  await expect(page.locator('.vv-tree-row', { hasText: 'cg-' }).first()).toBeVisible({ timeout: 10_000 });
}

/** 主实例同源连接（无 token；search 类场景用） */
async function connectSameOrigin(page: Page): Promise<void> {
  await connectSameOriginAt(page, BASE);
}

/** 连接 --compute 辅助实例（跨源，策略经 localStorage 预注入，同 m6 gotoWithPolicy） */
async function connectCompute(page: Page, policy: 'auto' | 'remote' | 'local'): Promise<void> {
  await page.addInitScript((p) => {
    localStorage.setItem('vviewer:settings', JSON.stringify({ computePolicy: p }));
  }, policy);
  await page.goto('/');
  await page.getByRole('button', { name: '连接服务器' }).click();
  await page.getByLabel('服务器地址').fill(`http://127.0.0.1:${PORT_COMPUTE}`);
  await page.getByLabel('访问令牌').fill(CG_TOKEN);
  await page.getByRole('button', { name: '连接', exact: true }).click();
  await expect(page.locator('.vv-tree-row', { hasText: 'cg-' }).first()).toBeVisible({ timeout: 10_000 });
}

async function openFile(page: Page, name: string): Promise<void> {
  await page.locator('.vv-tree-row', { hasText: name }).first().click();
  await expect(page.locator('.vv-tab.active', { hasText: name })).toBeVisible({ timeout: 10_000 });
}

async function openGlobalSearch(page: Page, query: string): Promise<void> {
  await page.keyboard.press('Control+Shift+F');
  await expect(page.locator('.vv-gsearch')).toBeVisible();
  await page.getByLabel('全局搜索内容').fill(query);
}

test.describe('CMP-02/BUG-10 大文件远程高亮路由', () => {
  test('显式 remote：3MB 文件远程执行（状态栏远程 + POST /api/compute/highlight），不再被 2MB 阈值压制', async ({
    page
  }) => {
    test.setTimeout(180_000);
    const highlightPosts: string[] = [];
    page.on('request', (r) => {
      if (r.method() === 'POST' && r.url().includes('/api/compute/highlight')) highlightPosts.push(r.url());
    });
    await connectCompute(page, 'remote');
    await openFile(page, 'cg-code-3mb.js');

    const sb = page.locator('.vv-statusbar');
    await expect(sb).toContainText('执行: 远程', { timeout: 120_000 }); // 修复前恒「hljs 分块 · 本地」
    await expect(sb).not.toContainText('hljs 分块');
    expect(highlightPosts.length).toBeGreaterThanOrEqual(1); // 修复前页面网络层零 POST

    // 回归不破坏（验收 3）：<2MB 文件 remote 仍远程（sample.js 口径）
    await openFile(page, 'cg-small-sample.js');
    await expect(sb).toContainText('执行: 远程', { timeout: 30_000 });
  });

  test('auto 双护栏① server-served：3MB 文件不限大小走服务端（POST 发生 + tree-sitter 渲染）', async ({
    page
  }) => {
    test.setTimeout(180_000);
    const highlightPosts: string[] = [];
    page.on('request', (r) => {
      if (r.method() === 'POST' && r.url().includes('/api/compute/highlight')) highlightPosts.push(r.url());
    });
    await connectCompute(page, 'auto');
    await openFile(page, 'cg-code-3mb.js');

    const sb = page.locator('.vv-statusbar');
    // 阶段 3 语义反转：server-served 文件 auto 下不限大小走服务端（旧契约「auto 3MB
    // 零 POST」作废）——远程区间按 tree-sitter 路径渲染，状态栏引擎与执行位置如实反映
    await expect(sb).toContainText('高亮: tree-sitter', { timeout: 120_000 });
    await expect(sb).toContainText('执行: 远程', { timeout: 120_000 });
    await expect(sb).not.toContainText('hljs 分块');
    expect(highlightPosts.length).toBeGreaterThanOrEqual(1);
  });

  test('auto 双护栏② 本地来源：3MB 单文件上传恒本地执行零 POST（硬护栏回归）', async ({ page }) => {
    test.setTimeout(120_000);
    const highlightPosts: string[] = [];
    page.on('request', (r) => {
      if (r.method() === 'POST' && r.url().includes('/api/compute/highlight')) highlightPosts.push(r.url());
    });
    await connectCompute(page, 'auto');

    // 本地添加文件（单文件上传通道，同 fix-pwa 的 __vvOpenDirImpl 前例）：无服务端
    // path 语义 → 注入侧硬护栏恒 null。已连接 --compute 实例（capabilities+宣告
    // 齐备）仍零 POST——证明护栏按来源而非能力判定。阶段 4 后 null → 本地懒高亮
    // （worker chunk tree-sitter 或其失败行级 hljs 兜底，二者执行位置均为本地）。
    // 引擎身份不作本用例锚点：release 二进制对缺失 .scm 查询文件 SPA-fallback 成
    // 200 index.html，worker 查询准备失败落 hljs 兜底（vite preview 404 跳过则
    // tree-sitter 正常）——该伺服兼容问题见 b-grammar-layers-server 文件头，与
    // 本用例锚定的「来源护栏」正交。
    await page.waitForFunction(
      () => typeof (window as unknown as { __vvOpenDirImpl?: unknown }).__vvOpenDirImpl === 'function'
    );
    await page.evaluate(() => {
      const content = 'const vv = 1; // c\n'.repeat(160_000); // ≈3.4MB > 2MiB 阈值
      const f = new File([content], 'cg-local-3mb.js', { type: 'text/javascript' });
      Object.defineProperty(f, 'webkitRelativePath', { value: 'cg-local/cg-local-3mb.js' });
      (window as unknown as { __vvOpenDirImpl: (f: File[]) => void }).__vvOpenDirImpl([f]);
    });
    // 注入目录 tab 不会自动打开文件：显式点树行触发渲染链（路由问询发生处）
    await openFile(page, 'cg-local-3mb.js');

    const sb = page.locator('.vv-statusbar');
    await expect(sb).toContainText('执行: 本地', { timeout: 60_000 });
    await expect(sb).not.toContainText('执行: 远程');
    // 懒高亮着色到达（tree-sitter chunk 或行级 hljs 兜底任一引擎，正文非裸转义）
    await expect(
      page.locator('.vv-code-pre span[class^="ts-"], .vv-code-pre span[class^="hljs-"]').first()
    ).toBeVisible({ timeout: 60_000 });
    expect(highlightPosts).toEqual([]); // 本地来源恒零 POST（highlightRouter 注入侧护栏）
  });

  test('auto 宣告门：server-served >2MB .jsonc（差集语言）零 POST + 行级 hljs 本地分块（同源）', async ({
    page
  }) => {
    test.setTimeout(120_000);
    const highlightPosts: string[] = [];
    page.on('request', (r) => {
      if (r.method() === 'POST' && r.url().includes('/api/compute/highlight')) highlightPosts.push(r.url());
    });
    // 同源 compute 实例（4180）：页面与 API 同源，X-VV-Lang（条目名 jsonc）可读，
    // meta.lang 生效。跨源部署下服务端 CORS 层未 Access-Control-Expose-Headers 该头，
    // 前端回落本地 langdetect 的 grammar 归并（jsonc→json，宣告集内）→ 门放行真实
    // POST——「宣告门前置拦截」语义以同源部署为边界（预存在缺口，已在案单独立项候选）。
    await connectSameOriginAt(page, `http://127.0.0.1:${PORT_COMPUTE_SAME}`);
    await openFile(page, 'cg-code-3mb.jsonc');

    // languages.json 342 与服务端 301 差集 57，jsonc 在差集内且经 code 渲染白名单可达
    //（spec §7.3 勘误）：meta.lang = X-VV-Lang = 条目名 jsonc，不在宣告集合 → auto
    // 宣告门（BUG-06c 同源）前置拦截返回 null——零请求直落本地分块，而非白发 400 再
    // 回退。引擎身份可钉定：null → 行级 hljs（不回落本地 wasm，渲染侧裁决），且
    // jsonc 不在任何 grammar manifest，本地 wasm 路径本就不可达。
    const sb = page.locator('.vv-statusbar');
    await expect(sb).toContainText('语言: jsonc', { timeout: 30_000 }); // X-VV-Lang 同源可读且生效
    await expect(sb).toContainText('执行: 本地', { timeout: 60_000 });
    await expect(sb).not.toContainText('执行: 远程');
    await expect(sb).toContainText('高亮: hljs 兜底', { timeout: 60_000 });
    await expect(page.locator('.vv-code-pre span[class^="hljs-"]').first()).toBeVisible({
      timeout: 60_000
    });
    expect(highlightPosts).toEqual([]); // 宣告门前置拦截：零 POST（与护栏②的来源拦截相区分）
  });
});

test.describe('CMP-03/BUG-22 auto 执行位置指示', () => {
  test('含围栏 md 与 html（渲染/源码视图）均「渲染: 本地」，围栏二级高亮保留，py 仍远程', async ({
    page
  }) => {
    test.setTimeout(120_000);
    await connectCompute(page, 'auto');
    const sb = page.locator('.vv-statusbar');

    // ① auto 下含围栏 md 留本地（修复前「渲染: 远程」与本地围栏着色语义割裂）
    await openFile(page, 'cg-rust-fence.md');
    await expect(page.locator('.vv-markdown')).toBeVisible({ timeout: 30_000 });
    await expect(sb).toContainText('渲染: 本地', { timeout: 30_000 });
    await expect(sb).not.toContainText('渲染: 远程');
    // 围栏二级高亮不回退：代码块内语法 span 存在（ts-*（本地 tree-sitter 主路径）或 hljs-*）
    await expect(page.locator('.vv-markdown pre code span').first()).toBeVisible({ timeout: 30_000 });

    // ② html 渲染视图状态栏有统一口径执行位置段（修复前两视图均无）且为本地
    await openFile(page, 'cg-with-script.html');
    await expect(page.locator('.vv-html-frame')).toBeVisible({ timeout: 30_000 });
    await expect(sb).toContainText('渲染: 本地', { timeout: 30_000 });
    // 源码视图同口径（复用 code 渲染链，内容完整着色不白屏）
    await page.getByRole('button', { name: '源码' }).click();
    await expect(page.locator('.vv-code-pre')).toContainText('window.__vvCg', { timeout: 30_000 });
    await expect(sb).toContainText('渲染: 本地');

    // ③ 路由矩阵抽样不回归：非注入语言 py 在 auto 下仍远程（修复前后均已 ✓ 的路由结果）
    await openFile(page, 'cg-hello.py');
    await expect(sb).toContainText('执行: 远程', { timeout: 60_000 });
  });
});

test.describe('CMP-04 远程高亮失败语义', () => {
  test('php 正例 auto 远程成功；lang 改写集外 brainfuck 后 auto 回退本地可读、remote 错误卡片 400', async ({
    page
  }) => {
    test.setTimeout(120_000);
    const statuses: number[] = [];
    page.on('response', (r) => {
      if (r.url().includes('/api/compute/highlight')) statuses.push(r.status());
    });

    // ① 对照组：php 随阶段 1 进入服务端 301 集——auto 宣告集内语言真实走服务端（200）
    await connectCompute(page, 'auto');
    await openFile(page, 'cg-probe.php');
    await expect(page.locator('.vv-code-pre')).toContainText('hello', { timeout: 30_000 });
    await expect(page.locator('.vv-statusbar')).toContainText('执行: 远程', { timeout: 30_000 });
    expect(statuses).toContain(200);
    await expect(page.locator('.vv-error-card')).toHaveCount(0);

    // ② 集外 400 场景经请求改写注入（spec §7.3 勘误后的口径）：languages.json 342 与
    // 服务端 301 差集 57，但差集语言的请求被 auto 宣告门前置拦截为零请求（本文件
    // CMP-02 描述组的 jsonc 用例），auto 下到不了 400——故「auto 收 400」场景仍需
    // 改写注入：POST body lang 改写为 brainfuck（server 单测同款集外名），400 真实
    // 来自服务端（unsupported language），非 mock 响应
    await page.route('**/api/compute/highlight', async (route) => {
      const body = route.request().postDataJSON() as { path: string; lang: string };
      const headers = { ...route.request().headers() };
      delete headers['content-length'];
      await route.continue({ headers, postData: JSON.stringify({ ...body, lang: 'brainfuck' }) });
    });

    // ③ auto：服务端 400 → warn 留痕回退本地 hljs 分块（可用性优先，不抛错），
    // 内容可读、无错误卡片（重新 goto 重置 tab，route 持续生效）
    statuses.length = 0;
    await connectCompute(page, 'auto');
    await openFile(page, 'cg-probe.php');
    await expect(page.locator('.vv-code-pre')).toContainText('hello', { timeout: 30_000 });
    expect(statuses).toContain(400);
    await expect(page.locator('.vv-error-card')).toHaveCount(0);
    await expect(page.locator('.vv-statusbar')).toContainText('执行: 本地', { timeout: 30_000 });

    // ④ remote：显式远程失败不静默回退，错误卡片「远程高亮失败: HTTP 400」
    statuses.length = 0;
    await connectCompute(page, 'remote');
    await openFile(page, 'cg-probe.php');
    await expect(page.locator('.vv-error-card')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.vv-error-card')).toContainText('远程高亮失败: HTTP 400');
    expect(statuses).toContain(400);
  });
});

test.describe('CMP-06/BUG-09 全局搜索跳转定位', () => {
  test('点击 751:1 命中行：视口渲染命中行 + 行级高亮，2.5s 后不丢；分组与 mark 不回退', async ({
    page
  }) => {
    test.setTimeout(120_000);
    await connectSameOrigin(page);

    // 分组回归（BUG-09 验收 4）：'inner' 两文件各自分组、预览带 <mark>
    await openGlobalSearch(page, 'inner');
    await expect(page.locator('.vv-gsearch-file-path', { hasText: 'cg-alpha.txt' })).toBeVisible({
      timeout: 10_000
    });
    await expect(page.locator('.vv-gsearch-file-path', { hasText: 'cg-beta.txt' })).toBeVisible();
    await expect(page.locator('.vv-gsearch-row mark').first()).toHaveText('inner');
    await page.keyboard.press('Escape');

    // 点击 tall-hit 751:1（find click 变体）：打开文件并滚动定位 + 行级高亮
    await openGlobalSearch(page, 'treasure');
    const row = page.locator('.vv-gsearch-row', { hasText: '751:1' }).first();
    await expect(row).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.vv-gsearch-file-path', { hasText: 'cg-tall-hit.txt' })).toBeVisible();
    await row.click();

    await expect(page.locator('.vv-tab.active', { hasText: 'cg-tall-hit.txt' })).toBeVisible();
    const hitLine = page.locator('.vv-code-line[data-line="750"]'); // GrepMatch.line 1 起 → data-line 0 起
    await expect(hitLine).toBeVisible({ timeout: 10_000 }); // 视口渲染命中行（虚拟容器 scrollTop 恒 0，不可作判据）
    await expect(hitLine).toHaveClass(/vv-search-hit-line/);
    await expect(hitLine).toHaveClass(/vv-search-hit-line-active/);
    await expect(hitLine.locator('.vv-code-gutter')).toHaveText('751');

    // 2.5s 后定位不丢（验收 3）。行级高亮按既有 BUG-18 语义 1.5s 后消退（jumpToLine
    // 的 clearHit 有意设计，与文件内搜索 active 命中同语义）——复点应复亮，证跳转机制持续可用
    await page.waitForTimeout(2_500);
    await expect(hitLine).toBeVisible();
    await row.click(); // 面板已随点击关闭？未关闭则行仍在——若已关闭改经文件内跳转复验
    await expect(hitLine).toHaveClass(/vv-search-hit-line-active/, { timeout: 5_000 });
  });
});

test.describe('CMP-07 开关与 glob 参数', () => {
  test('Aa 大小写（5→3）与 .* 正则（字面量无结果 → 正则 5）开关，/api/search glob 真实过滤', async ({
    page
  }) => {
    test.setTimeout(120_000);
    await connectSameOrigin(page);
    const status = page.locator('.vv-gsearch-status');

    // 不敏感基线：cg-case.txt 3 行（含 1 大写）+ cg-case.md 1 + cg-case.js 1 = 5
    await openGlobalSearch(page, 'helio');
    await expect(status).toContainText('5 个命中', { timeout: 10_000 });

    // Aa 开关：敏感后仅小写行（txt 2 + js 1 = 3）
    await page.getByTitle('区分大小写').click();
    await expect(status).toContainText('3 个命中', { timeout: 10_000 });
    await page.getByTitle('区分大小写').click();

    // .* 开关：字面量 'hel+io' 查空，正则后 5 命中（开关即刻重搜）
    await page.getByLabel('全局搜索内容').fill('hel+io');
    await expect(status).toContainText('无结果', { timeout: 10_000 });
    await page.getByTitle('正则表达式').click();
    await expect(status).toContainText('5 个命中', { timeout: 10_000 });
    await page.keyboard.press('Escape');

    // API 层 glob（BUG-21 已 ✓ 项不回退）：glob=*.txt 仅返回 txt 命中（3 帧）
    const withGlob = await fetch(`${BASE}/api/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pattern: 'helio', glob: '*.txt', caseSensitive: false, regex: false })
    });
    expect(withGlob.ok).toBeTruthy();
    const globFrames = (await withGlob.text()).trim().split('\n').map((l) => JSON.parse(l));
    const globFiles = new Set(globFrames.filter((f) => f.file).map((f) => f.file as string));
    expect([...globFiles]).toEqual(['cg-case.txt']);
    expect(globFrames.filter((f) => f.file)).toHaveLength(3);

    const all = await fetch(`${BASE}/api/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pattern: 'helio', caseSensitive: false, regex: false })
    });
    const allFrames = (await all.text()).trim().split('\n').map((l) => JSON.parse(l));
    const allFiles = new Set(allFrames.filter((f) => f.file).map((f) => f.file as string));
    expect(allFiles.size).toBe(3); // txt/md/js 三文件
  });
});

test.describe('CMP-08 命中上限与截断终帧', () => {
  test('>1000 命中止于 1000 并提示上限，NDJSON truncated 终帧；远程 store 不引导服务器模式', async ({
    page
  }) => {
    test.setTimeout(120_000);
    // API 层：1000 个 match 帧 + {done:true,truncated:true} 终帧
    const res = await fetch(`${BASE}/api/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pattern: 'flood', caseSensitive: false, regex: false })
    });
    const frames = (await res.text()).trim().split('\n').map((l) => JSON.parse(l));
    expect(frames.filter((f) => f.file)).toHaveLength(1000);
    expect(frames[frames.length - 1]).toMatchObject({ done: true, truncated: true });

    // UI 层：命中计数 + 截断提示；远程 store 已是服务器模式 → 无 .vv-gsearch-hint 引导
    await connectSameOrigin(page);
    await openGlobalSearch(page, 'flood');
    await expect(page.locator('.vv-gsearch-status')).toContainText(
      '1000 个命中（结果不完整，已达上限）',
      { timeout: 15_000 }
    );
    await expect(page.locator('.vv-gsearch-hint')).toHaveCount(0); // serverSearchHint 远程侧 null（BUG-11 护栏）
  });
});

test.describe('CMP-09 无 rg 降级', () => {
  test('/api/search 501 明确报错，前端 auto 降级浏览器内搜索并提示，结果可用', async ({ page }) => {
    test.setTimeout(120_000);
    // ① 接口：无 rg 实例 501 + ripgrep 字样
    const res = await fetch(`http://127.0.0.1:${PORT_NORG}/api/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pattern: 'needle', caseSensitive: false, regex: false })
    });
    expect(res.status).toBe(501);
    expect(((await res.json()) as { error: string }).error).toContain('ripgrep');

    // ② 前端：降级提示条 + 结果仍可用（本地 grep 经远程 store 逐文件读取）
    await page.goto('/');
    await page.getByRole('button', { name: '连接服务器' }).click();
    await page.getByLabel('服务器地址').fill(`http://127.0.0.1:${PORT_NORG}`);
    await page.getByRole('button', { name: '连接', exact: true }).click();
    await expect(page.locator('.vv-tree-row', { hasText: 'cg-needle.txt' })).toBeVisible({ timeout: 10_000 });

    await openGlobalSearch(page, 'needle');
    await expect(page.locator('.vv-gsearch-hint')).toContainText('服务器 ripgrep 不可用，已改用浏览器内搜索', {
      timeout: 30_000
    });
    await expect(page.locator('.vv-gsearch-file-path', { hasText: 'cg-needle.txt' })).toBeVisible({
      timeout: 30_000
    });
  });
});

test.describe('CMP-12 取消与重发', () => {
  test('取消/连续重发：全部 POST 200 无失败堆积、无页面错误、无 rg 进程残留', async ({ page }) => {
    test.setTimeout(120_000);
    const errors: Error[] = [];
    page.on('pageerror', (e) => errors.push(e));
    const searchStatuses: number[] = [];
    page.on('response', (r) => {
      if (r.url().includes('/api/search')) searchStatuses.push(r.status());
    });

    await connectSameOrigin(page);
    // ① 进行中取消（长查询 flood 期间 Esc 关面板 → abort）
    await openGlobalSearch(page, 'flood');
    await page.waitForTimeout(300);
    await page.keyboard.press('Escape');
    await expect(page.locator('.vv-gsearch')).toHaveCount(0);
    // ② 连续重发三次至终态
    for (let i = 0; i < 3; i++) {
      await openGlobalSearch(page, i % 2 === 0 ? 'needle' : 'flood');
      await expect(page.locator('.vv-gsearch-status')).toContainText('个命中', { timeout: 30_000 });
      await page.keyboard.press('Escape');
    }
    await openGlobalSearch(page, 'flood'); // 末轮以本 spec 专属关键词收尾（flood 仅 cg-flood-* 命中）
    await expect(page.locator('.vv-gsearch-status')).toContainText('1000 个命中', { timeout: 30_000 });

    expect(errors).toEqual([]);
    expect(searchStatuses.filter((s) => s >= 400)).toEqual([]); // 无 canceled/failed 响应堆积
    await page.keyboard.press('Escape');

    // 服务器侧：无 rg 进程残留（pgrep 按 rg 命令行匹配；收窄到本 spec 专属 pattern
    // flood，避免并行 worker/其它 spec 对共享 fixture 的在途搜索误报）
    const residue = await new Promise<string>((resolve_) => {
      execFile('pgrep', ['-af', 'rg --json'], (err, stdout) => resolve_(err ? '' : stdout));
    });
    expect(residue.split('\n').filter((l) => l.includes('-e flood'))).toEqual([]);
  });
});
