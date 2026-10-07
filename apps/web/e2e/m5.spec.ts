import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';

/**
 * M5 E2E 验收（Task 6）：server 模式全链路——
 * TopBar 连接表单（地址+token）→ health 校验 → 目录树（RemoteStore）→ 打开 sample.js
 * → code tab 高亮 → SSE 变更推送驱动 tab 自动刷新（外部 fs 追加 → ≤3s 出现新文本）
 * → 错误 token 连接被拒（表单内错误提示）。
 *
 * server 生命周期：webServer 配置无法起 cargo，在 beforeAll 里先 `cargo build`
 * （复用增量编译），再直接 spawn 预编译二进制 target/debug/vviewer（cargo run 每次
 * 都有编译检查开销且首次编译慢），轮询 /api/health 就绪，afterAll kill。
 * 前端走 preview server（:4173），与 server（:8399）跨源 → 必须带
 * --cors-origin http://127.0.0.1:4173（精确 origin + authorization 头放行）。
 */
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const samplesDir = `${repoRoot}/samples/m5`;
const binPath = `${repoRoot}/server/target/debug/vviewer`;
const PORT = 8399;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'e2etoken';
const PREVIEW_ORIGIN = 'http://127.0.0.1:4173';

let server: ChildProcess | null = null;
let sampleOriginal: Buffer | null = null;

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
  sampleOriginal = await readFile(`${samplesDir}/sample.js`);
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
      '--cors-origin', PREVIEW_ORIGIN
    ],
    { stdio: 'inherit' }
  );
  server.on('exit', (code) => {
    if (code !== null && code !== 0) console.error(`[m5] server 提前退出: code=${code}`);
  });
  await waitHealthy(BASE);
});

test.afterAll(async () => {
  // 样例文件还原（测试向 sample.js 追加过 marker）
  if (sampleOriginal !== null) await writeFile(`${samplesDir}/sample.js`, sampleOriginal);
  if (server !== null && server.exitCode === null) {
    const exited = new Promise<void>((resolve) => server!.once('exit', () => resolve()));
    server.kill('SIGTERM');
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5_000))]);
  }
});

/** 展开 TopBar 连接表单并提交（每次测试用新 page，sessionStorage 互不影响） */
async function connect(page: import('@playwright/test').Page, token: string): Promise<void> {
  await page.getByRole('button', { name: '连接服务器' }).click();
  await page.getByLabel('服务器地址').fill(BASE);
  await page.getByLabel('访问令牌').fill(token);
  await page.getByRole('button', { name: '连接', exact: true }).click();
}

test('连接 → 目录树 → 打开 sample.js 高亮 → 修改文件 SSE 自动刷新', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/');
  await connect(page, TOKEN);

  // 目录树出现 sample.js 与 sub/
  const tree = page.locator('.vv-tree');
  await expect(tree.locator('.vv-tree-row', { hasText: 'sample.js' })).toBeVisible({ timeout: 10_000 });
  await expect(tree.locator('.vv-tree-row', { hasText: 'sub' })).toBeVisible();

  // 点击 sample.js → code tab 渲染 + 高亮 span（tree-sitter ts-* 或 hljs 兜底 hljs-*）
  await tree.locator('.vv-tree-row', { hasText: 'sample.js' }).click();
  await expect(page.locator('.vv-tab.active', { hasText: 'sample.js' })).toBeVisible();
  const code = page.locator('.vv-code-pre');
  await expect(code).toContainText('fib', { timeout: 20_000 });
  await expect(code.locator('span[class^="ts-"], span[class^="hljs-"]').first()).toBeVisible({
    timeout: 20_000
  });

  // SSE 自动刷新：外部 fs 追加注释行 → 服务端 500ms debounce 推 changed → tab 重读重渲染。
  // 断言窗口 3s：debounce 500ms + fetch + 小文件重渲染，余量充足
  const marker = `// e2e-m5-marker-${Date.now()}`;
  appendFileSync(`${samplesDir}/sample.js`, `\n${marker}\n`);
  await expect(code).toContainText(marker, { timeout: 3_000 });
});

test('token 错误连接被拒：表单内错误提示可见', async ({ page }) => {
  await page.goto('/');
  await connect(page, 'wrong-token');
  const error = page.locator('.vv-server-error');
  await expect(error).toBeVisible({ timeout: 10_000 });
  await expect(error).toContainText('401');
  // 连接失败：目录树不得出现
  await expect(page.locator('.vv-tree')).toHaveCount(0);
});
