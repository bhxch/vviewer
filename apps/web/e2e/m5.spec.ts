import { appendFileSync } from 'node:fs';
import type { ChildProcess } from 'node:child_process';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
import { assertPortFree, startVviewerServer, stopServer, waitHealthy } from './serverHarness';
import { closeDrawerIfOpened, openDrawerIfNarrow } from './drawer';

/**
 * M5 E2E 验收（Task 6）：server 模式全链路——
 * TopBar 连接表单（地址+token）→ health 校验 → 目录树（RemoteStore）→ 打开 sample.js
 * → code tab 高亮 → SSE 变更推送驱动 tab 自动刷新（外部 fs 追加 → ≤3s 出现新文本）
 * → 错误 token 连接被拒（表单内错误提示）。
 *
 * server 生命周期：webServer 配置无法起 cargo，在 beforeAll 里经共享 harness
 * （serverHarness.ts）先 `cargo build` 再 spawn 预编译二进制，轮询 /api/health
 * 就绪，afterAll SIGTERM→SIGKILL 兜底停止。
 * fixture：root 指向 os.tmpdir() 独立目录（samples/m5 拷贝过去）——不污染 tracked
 * 工作树，也消除双 project/双 spec 并发下的 fixture 竞态（终审 M2/M7）。
 * 前端走 preview server（:4173），与 server（:8399）跨源 → 必须带
 * --cors-origin http://127.0.0.1:4173（精确 origin + authorization 头放行）。
 */
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const samplesDir = `${repoRoot}/samples/m5`;
const binPath = `${repoRoot}/server/target/debug/vviewer`;
// 双 project（chromium/mobile）下同一 spec 文件在两个 worker 并发跑，
// 各 project 错开监听端口避免 beforeAll spawn 时 bind 冲突（os error 98）；
// test.info() 仅测试期可用，故 project 分派在 beforeAll 内完成
let PORT = 8399;
let BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'e2etoken';
const PREVIEW_ORIGIN = 'http://127.0.0.1:4173';

let server: ChildProcess | null = null;
/** 临时 fixture 根目录（samples/m5 的拷贝），afterAll 清理 */
let fixtureRoot: string | null = null;

test.beforeAll(async () => {
  if (test.info().project.name === 'mobile') {
    PORT = 8449;
    BASE = `http://127.0.0.1:${PORT}`;
  }
  // 钩子默认 30s 不够 cargo 增量编译（多 worker/并行 cargo 争用 target 锁时更久），
  // 扩到 5 分钟——与 m6.spec.ts 同惯例（全量回归曾因锁排队超时误报 m5 双 project 失败）
  test.setTimeout(300_000);
  // 端口预检：遗留进程占口时 fail-fast 带明确信息（否则 spawn 后才 bind 失败）
  await assertPortFree(BASE);
  // fixture 拷到 tmpdir：测试向 sample.js 追加 marker，不触碰 tracked 树
  fixtureRoot = await mkdtemp(join(tmpdir(), 'vviewer-e2e-m5-'));
  await cp(samplesDir, fixtureRoot, { recursive: true });
  server = startVviewerServer({
    repoRoot,
    binPath,
    root: fixtureRoot,
    webDist: `${repoRoot}/apps/web/build`,
    port: PORT,
    token: TOKEN,
    corsOrigin: PREVIEW_ORIGIN,
    tag: 'm5'
  });
  await waitHealthy(BASE);
});

test.afterAll(async () => {
  await stopServer(server, 'm5');
  if (fixtureRoot !== null) await rm(fixtureRoot, { recursive: true, force: true });
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
  // 移动视口：远程目录树同样在抽屉内，开抽屉点击后关闭（drawer.ts）
  const drawer = await openDrawerIfNarrow(page);
  await tree.locator('.vv-tree-row', { hasText: 'sample.js' }).click();
  await closeDrawerIfOpened(page, drawer);
  await expect(page.locator('.vv-tab.active', { hasText: 'sample.js' })).toBeVisible();
  const code = page.locator('.vv-code-pre');
  await expect(code).toContainText('fib', { timeout: 20_000 });
  await expect(code.locator('span[class^="ts-"], span[class^="hljs-"]').first()).toBeVisible({
    timeout: 20_000
  });

  // SSE 自动刷新：外部 fs 追加注释行 → 服务端 500ms debounce 推 changed → tab 重读重渲染。
  // 断言窗口 3s：debounce 500ms + fetch + 小文件重渲染，余量充足
  const marker = `// e2e-m5-marker-${Date.now()}`;
  appendFileSync(`${fixtureRoot}/sample.js`, `\n${marker}\n`);
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
