import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { test, expect, type Page } from '@playwright/test';

/**
 * M6 E2E 验收（Task 5）：compute 模式全链路——
 * server 带 --compute 起服（root=整个 samples/，m5 与 m6 样例同根）→ health 能力
 * 含 compute 且前端连接后缓存进 sessionStorage → policy=remote（localStorage 注入
 * settings JSON）下打开远程文件，状态栏出现执行位置「远程」（小文件与大文件各一）→
 * Ctrl+Shift+F 全局搜索 "inner" 命中 m5/sub/inner.txt（远程 ripgrep 路径），点击结果
 * 打开该文件 → markdown 表格/任务列表渲染 + comrak 端点直连断言 → policy=local
 * （TopBar UI 切换）回退状态栏「本地」。
 *
 * server 生命周期：复用 m5.spec 的模式——beforeAll `cargo build`（增量）+ spawn
 * 预编译二进制 + /api/health 轮询就绪，afterAll kill + 临时大文件清理。
 * 端口用 8401（m5 用 8399）：playwright 默认多 worker 并行跑不同 spec 文件，错开避免端口冲突。
 * 前端仍走 preview server（:4173），跨源需 --cors-origin http://127.0.0.1:4173。
 */
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const samplesDir = `${repoRoot}/samples`;
const binPath = `${repoRoot}/server/target/debug/vviewer`;
const PORT = 8401;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'e2etoken6';
const PREVIEW_ORIGIN = 'http://127.0.0.1:4173';

/** 临时大文件（≈1.5MB，tree-sitter 主路径阈值 2MB 之内），afterAll 清理 */
const BIG_FILE = `${samplesDir}/m6/e2e-big.js`;
const BIG_LINE = 'const vv = 1; // c\n';
const BIG_REPS = 80_000;

let server: ChildProcess | null = null;

async function waitHealthy(url: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/api/health`);
      if (res.ok) return;
    } catch {
      // 尚未就绪：继续轮询
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`vviewer server 未在 ${timeoutMs}ms 内就绪: ${url}`);
}

test.beforeAll(async () => {
  // 钩子默认 30s 不够 cargo 增量编译（fresh clone 全量编译更久），扩到 5 分钟
  test.setTimeout(300_000);
  await writeFile(BIG_FILE, BIG_LINE.repeat(BIG_REPS));
  // 预编译（增量；fresh clone 首次会全量编译，耗时计入 beforeAll）
  execSync('cargo build --manifest-path server/Cargo.toml', { cwd: repoRoot, stdio: 'inherit' });
  server = spawn(
    binPath,
    [
      'serve',
      '--root', samplesDir,
      '--web-dist', `${repoRoot}/apps/web/build`,
      '--port', String(PORT),
      '--token', TOKEN,
      '--cors-origin', PREVIEW_ORIGIN,
      '--compute'
    ],
    { stdio: 'inherit' }
  );
  server.on('exit', (code) => {
    if (code !== null && code !== 0) console.error(`[m6] server 提前退出: code=${code}`);
  });
  await waitHealthy(BASE);
});

test.afterAll(async () => {
  if (server !== null && server.exitCode === null) {
    const exited = new Promise<void>((resolve) => server!.once('exit', () => resolve()));
    server.kill('SIGTERM');
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5_000))]);
  }
  await rm(BIG_FILE, { force: true });
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

/** 展开目录并打开其中的文件（文件行出现在目录行的子树内） */
async function openFile(page: Page, dir: string, name: string): Promise<void> {
  await expandDir(page, dir);
  await page.locator('.vv-tree-row', { hasText: name }).click();
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
  test.setTimeout(90_000);
  await gotoWithPolicy(page, 'remote');
  await connect(page, TOKEN);
  await openFile(page, 'm6', 'e2e-big.js');

  const statusbar = page.locator('.vv-statusbar');
  await expect(statusbar).toContainText('高亮: tree-sitter', { timeout: 60_000 });
  await expect(statusbar).toContainText('执行: 远程', { timeout: 60_000 });
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

  // 前端引擎渲染：GFM 表格（表头 + 2 数据行，中文单元格）与任务列表复选框
  const md = page.locator('.vv-markdown');
  await expect(md).toBeVisible({ timeout: 20_000 });
  await expect(md.locator('table')).toBeVisible();
  await expect(md.locator('table tr')).toHaveCount(3);
  await expect(md.locator('table')).toContainText('传感器 A');
  await expect(md.locator('li.task-list-item input[type="checkbox"]')).toHaveCount(2);

  // comrak 服务端渲染直连断言（UI markdown 不路由远程——T1-T4 范围如此，见任务报告偏差说明）：
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
