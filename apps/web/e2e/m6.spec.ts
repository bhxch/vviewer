import type { ChildProcess } from 'node:child_process';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, type Page } from '@playwright/test';
import { assertPortFree, startVviewerServer, stopServer, waitHealthy } from './serverHarness';
import { closeDrawerIfOpened, openDrawerIfNarrow } from './drawer';

/**
 * M6 E2E 验收（Task 5）：compute 模式全链路——
 * server 带 --compute 起服（root=tmpdir fixture：samples/m5+m6 拷贝，m5 与 m6
 * 样例同根）→ health 能力含 compute 且前端连接后缓存进 sessionStorage →
 * policy=remote（localStorage 注入 settings JSON）下打开远程文件，状态栏出现
 * 执行位置「远程」（小文件与大文件各一）→ Ctrl+Shift+F 全局搜索 "inner" 命中
 * m5/sub/inner.txt（远程 ripgrep 路径），点击结果打开该文件 → markdown 表格/
 * 任务列表渲染 + comrak 端点直连断言 → policy=local（TopBar UI 切换）回退状态栏「本地」。
 *
 * server 生命周期：复用共享 harness（serverHarness.ts）——cargo build（增量）+
 * spawn 预编译二进制 + /api/health 轮询就绪 + 端口预检 + SIGTERM→SIGKILL 兜底停止。
 * fixture 与 BIG_FILE 均在 os.tmpdir() 独立目录（终审 M2/M7：不写 tracked 工作树，
 * 双 project/双 spec 并发无共享路径竞态），afterAll 整目录清理。
 * 端口用 8401（m5 用 8399）：playwright 默认多 worker 并行跑不同 spec 文件，错开避免端口冲突。
 * 前端仍走 preview server（:4173），跨源需 --cors-origin http://127.0.0.1:4173。
 */
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const binPath = `${repoRoot}/server/target/debug/vviewer`;
// 双 project（chromium/mobile）下同一 spec 文件在两个 worker 并发跑，
// 各 project 错开监听端口避免 beforeAll spawn 时 bind 冲突（os error 98）；
// test.info() 仅测试期可用，故 project 分派在 beforeAll 内完成
let PORT = 8401;
let BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'e2etoken6';
const PREVIEW_ORIGIN = 'http://127.0.0.1:4173';

/** 临时大文件（≈1.5MB，tree-sitter 主路径阈值 2MB 之内），随 fixtureRoot 一起清理 */
const BIG_LINE = 'const vv = 1; // c\n';
const BIG_REPS = 80_000;

let server: ChildProcess | null = null;
/** 临时 fixture 根目录（samples/m5 + samples/m6 拷贝），afterAll 清理 */
let fixtureRoot: string | null = null;

test.beforeAll(async () => {
  if (test.info().project.name === 'mobile') {
    PORT = 8451;
    BASE = `http://127.0.0.1:${PORT}`;
  }
  // 钩子默认 30s 不够 cargo 增量编译（fresh clone 全量编译更久），扩到 5 分钟
  test.setTimeout(300_000);
  // 端口预检：遗留进程占口时 fail-fast 带明确信息（否则 spawn 后才 bind 失败）
  await assertPortFree(BASE);
  fixtureRoot = await mkdtemp(join(tmpdir(), 'vviewer-e2e-m6-'));
  await cp(`${repoRoot}/samples/m5`, `${fixtureRoot}/m5`, { recursive: true });
  await cp(`${repoRoot}/samples/m6`, `${fixtureRoot}/m6`, { recursive: true });
  await writeFile(`${fixtureRoot}/m6/e2e-big.js`, BIG_LINE.repeat(BIG_REPS));
  server = startVviewerServer({
    repoRoot,
    binPath,
    root: fixtureRoot,
    webDist: `${repoRoot}/apps/web/build`,
    port: PORT,
    token: TOKEN,
    corsOrigin: PREVIEW_ORIGIN,
    compute: true,
    tag: 'm6'
  });
  await waitHealthy(BASE);
});

test.afterAll(async () => {
  await stopServer(server, 'm6');
  if (fixtureRoot !== null) await rm(fixtureRoot, { recursive: true, force: true });
});

/** 展开 TopBar 连接表单并提交（同 m5：每次测试用新 page，存储互不影响） */
async function connect(page: Page, token: string): Promise<void> {
  await page.getByRole('button', { name: '连接服务器' }).click();
  await page.getByLabel('服务器地址').fill(BASE);
  await page.getByLabel('访问令牌').fill(token);
  await page.getByRole('button', { name: '连接', exact: true }).click();
}

/**
 * 预注入 settings localStorage（loadSettings 与默认值合并，白名单校验通过），
 * 再 goto——computeRouter 每次调用实时读 settings，导航前写入即生效。
 */
async function gotoWithPolicy(page: Page, policy: 'remote' | 'local' | 'auto'): Promise<void> {
  await page.addInitScript((p) => {
    localStorage.setItem('vviewer:settings', JSON.stringify({ computePolicy: p }));
  }, policy);
  await page.goto('/');
}

/** 展开目录行（root=samples 时 m5/m6 是顶层目录，懒加载需点击展开） */
async function expandDir(page: Page, name: string): Promise<void> {
  await page.locator('.vv-tree-row', { hasText: name }).first().click();
}

/** 展开目录并打开其中的文件（文件行出现在目录行的子树内）。
 * 移动视口：目录树在抽屉内，展开+点击全程开抽屉，点完关闭（drawer.ts） */
async function openFile(page: Page, dir: string, name: string): Promise<void> {
  const drawer = await openDrawerIfNarrow(page);
  await expandDir(page, dir);
  await page.locator('.vv-tree-row', { hasText: name }).click();
  await closeDrawerIfOpened(page, drawer);
  await expect(page.locator('.vv-tab.active', { hasText: name })).toBeVisible({ timeout: 10_000 });
}

test('--compute 起服：health 含 compute，前端连接后 capabilities 缓存生效', async ({ page }) => {
  // 服务端能力宣告（免鉴权）
  const caps = (await (await fetch(`${BASE}/api/health`)).json()) as { capabilities: string[] };
  expect(caps.capabilities).toContain('file-server');
  expect(caps.capabilities).toContain('compute');

  // 前端连接：health 能力写入 sessionStorage（M6 compute 路由的判定来源）；
  // root=samples 时树只挂顶层目录（折叠态），以 m5 目录行出现为连接成功证据
  await page.goto('/');
  await connect(page, TOKEN);
  await expect(page.locator('.vv-tree-row', { hasText: 'm5' }).first()).toBeVisible({ timeout: 10_000 });
  const cached = await page.evaluate(() =>
    JSON.parse(sessionStorage.getItem('vv:capabilities') ?? '[]') as string[]
  );
  expect(cached).toContain('compute');
});

test('policy=remote：打开 sample.js 高亮走服务端，状态栏显示执行位置「远程」', async ({ page }) => {
  test.setTimeout(60_000);
  await gotoWithPolicy(page, 'remote');
  await connect(page, TOKEN);
  await openFile(page, 'm5', 'sample.js');

  // 远程高亮往返后引擎落 tree-sitter、执行位置「远程」（watchEngine 250ms 轮询反映）
  const statusbar = page.locator('.vv-statusbar');
  await expect(statusbar).toContainText('高亮: tree-sitter', { timeout: 20_000 });
  await expect(statusbar).toContainText('执行: 远程', { timeout: 20_000 });
  // 不得出现本地兜底产物（显式 remote 失败会如实报错而非静默回退，出现 hljs 即为假绿）
  await expect(statusbar).not.toContainText('hljs');
});

test('policy=remote：大文件（≈1.5MB）高亮执行位置同为「远程」', async ({ page }) => {
  // 1.5MB 远程高亮在双 project 全量并发（tree-sitter wasm 多 worker 抢 CPU）下
  // 可能超过 60s，放宽到 120s（实测常态 ~45s，纯防抖不改变通过门槛）
  test.setTimeout(150_000);
  await gotoWithPolicy(page, 'remote');
  await connect(page, TOKEN);
  await openFile(page, 'm6', 'e2e-big.js');

  const statusbar = page.locator('.vv-statusbar');
  await expect(statusbar).toContainText('高亮: tree-sitter', { timeout: 120_000 });
  await expect(statusbar).toContainText('执行: 远程', { timeout: 120_000 });
});

test('Ctrl+Shift+F 全局搜索 "inner"：远程 ripgrep 命中 sub/inner.txt，点击打开该文件', async ({ page }) => {
  test.setTimeout(60_000);
  await gotoWithPolicy(page, 'remote');
  await connect(page, TOKEN);
  await expect(page.locator('.vv-tree-row').first()).toBeVisible({ timeout: 10_000 });

  // 焦点在正文（非输入框）时 Ctrl+Shift+F 打开全局搜索面板
  await page.keyboard.press('Control+Shift+F');
  const panel = page.locator('.vv-gsearch');
  await expect(panel).toBeVisible();
  await page.getByLabel('全局搜索内容').fill('inner');

  // 远程 ripgrep（policy=remote 显式远程）：按文件分组出现 m5/sub/inner.txt
  await expect(page.locator('.vv-gsearch-file-path', { hasText: 'm5/sub/inner.txt' })).toBeVisible({
    timeout: 10_000
  });
  await expect(page.locator('.vv-gsearch-status')).toContainText('个命中');
  // 无降级提示条 = 未回退浏览器内 grep（ripgrep 路径生效的直接证据）
  await expect(page.locator('.vv-gsearch-hint')).toHaveCount(0);

  // 点击结果行 → 该文件以新 tab 打开并激活，内容真实加载（含 "inner" 关键行）
  await page.locator('.vv-gsearch-row').first().click();
  await expect(page.locator('.vv-tab.active', { hasText: 'inner.txt' })).toBeVisible();
  await expect(page.locator('.vv-code-pre')).toContainText('inner', { timeout: 10_000 });
});

test('markdown：表格与任务列表渲染，comrak 端点 GFM 直连断言', async ({ page }) => {
  test.setTimeout(60_000);
  await gotoWithPolicy(page, 'auto');
  await connect(page, TOKEN);
  await openFile(page, 'm6', 'sample-gfm.md');

  // M7 起 auto 策略对远程文件路由远程 comrak（markdown 接入 compute 路由）；
  // comrak 的任务列表 li 无类，由前端 enrich 归一化补 task-list-item（双引擎样式一致）
  const statusbar = page.locator('.vv-statusbar');
  await expect(statusbar).toContainText('渲染: 远程', { timeout: 20_000 });

  // 远程渲染结果：GFM 表格（表头 + 2 数据行，中文单元格）与任务列表复选框
  const md = page.locator('.vv-markdown');
  await expect(md).toBeVisible({ timeout: 20_000 });
  await expect(md.locator('table')).toBeVisible();
  await expect(md.locator('table tr')).toHaveCount(3);
  await expect(md.locator('table')).toContainText('传感器 A');
  await expect(md.locator('li.task-list-item input[type="checkbox"]')).toHaveCount(2);

  // comrak 服务端渲染直连断言（同一端点独立验证）：
  // 表格 / 任务列表 / 脚注 / wikilinks 全扩展一次覆盖
  const res = await fetch(`${BASE}/api/compute/markdown`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      text: '| a | b |\n|---|---|\n| 1 | 2 |\n\n- [x] done\n\n见 [[docs]] 与 x[^1]。\n\n[^1]: note\n',
      options: { wikilinks: true }
    })
  });
  expect(res.ok).toBeTruthy();
  const { html } = (await res.json()) as { html: string };
  expect(html).toContain('<table');
  expect(html).toContain('<th>a</th>');
  expect(html).toContain('checkbox');
  expect(html).toContain('footnote-ref');
  expect(html).toContain('vv-wikilink');
});

test('policy=remote：markdown 正文走服务端 comrak，状态栏显示「渲染: 远程」', async ({ page }) => {
  test.setTimeout(60_000);
  await gotoWithPolicy(page, 'remote');
  await connect(page, TOKEN);
  await openFile(page, 'm6', 'sample-gfm.md');

  // 显式 remote：markdown 正文引擎=远程 comrak（状态栏），GFM 内容完整渲染
  const statusbar = page.locator('.vv-statusbar');
  await expect(statusbar).toContainText('渲染: 远程', { timeout: 20_000 });
  await expect(statusbar).not.toContainText('渲染: 本地');
  const md = page.locator('.vv-markdown');
  await expect(md).toBeVisible({ timeout: 20_000 });
  await expect(md.locator('table')).toContainText('传感器 A');
  await expect(md.locator('li.task-list-item')).toHaveCount(2);
});

test('policy=local（TopBar UI 切换）：高亮回退本地，状态栏显示「本地」', async ({ page }) => {
  test.setTimeout(60_000);
  // 默认 auto 连接后经 UI 切 local（覆盖设置 UI 通道；auto 对远程文件也会选远程，须显式 local 才恒本地）
  await page.goto('/');
  await connect(page, TOKEN);
  await page.getByLabel('计算策略').selectOption('local');
  await openFile(page, 'm5', 'sample.js');

  const statusbar = page.locator('.vv-statusbar');
  await expect(statusbar).toContainText('高亮: tree-sitter', { timeout: 20_000 });
  await expect(statusbar).toContainText('执行: 本地', { timeout: 20_000 });
  await expect(statusbar).not.toContainText('远程');
});
