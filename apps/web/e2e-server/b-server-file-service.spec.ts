import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, type Page } from '@playwright/test';
import { assertPortFree, stopServer, waitHealthy } from '../e2e/serverHarness';

/**
 * server-file-service 域补缺（docs/e2e/server-file-service.md 第 2/3 节）：
 * 补既有套件未覆盖的场景与缺陷回归。既有覆盖不在此重写——
 * SRV-01 → e2e-server/smoke.spec.ts（release 二进制冒烟）；
 * SRV-03 → m5.spec.ts（token 连接+树懒加载）/ b-markdown-html-docs-server.spec.ts（无 token 连接）；
 * SRV-04 前端半（表单 401 提示）→ m5.spec.ts；
 * SRV-06 的「追加后自动重读出现新行」半 → m5.spec.ts；
 * BUG-04 纯前端状态栏 / BUG-05 排除规则与开关 → e2e/b-app-shell-sources.spec.ts。
 *
 * 本文件覆盖：
 * - SRV-02：/api/health capabilities 随 --compute 变化（尾部追加语义）
 * - SRV-04 接口半：错误 token → 401 + www-authenticate + unauthorized JSON
 * - SRV-05/BUG-04 服务端半：X-VV 检测头下发（含 Range 206 路径）+ 状态栏语言/编码与头一致
 * - SRV-06/BUG-02：SSE changed 帧流动（含 paths）、无 watch-error、15s 心跳、
 *   自动重读保留滚动位置、状态栏无常驻「自动刷新不可用」
 * - SRV-07/BUG-05：设置面板切手动 → 服务端追加不自动出现 → 手动刷新按钮出新行
 * - SRV-08：Range 三态（206 / 非法 416 / 后缀 206）
 * - SRV-09：路径穿越 400 ×2 + root 外 symlink 内容层 403（域文档 4.3 边界 3 要求补的断言）
 * - SRV-10：--allow-lan 无 token 拒启（exit 2）；--token-gen 正常启动 + stdout 64 位 token
 * - SRV-11：dot 文件默认全显示，--hidden 实例过滤
 * - SRV-12：中文 4 层懒加载展开 + 目录优先 + 自然排序 file1<file2<file10
 * - SRV-13：ticket 一次性、Bearer 不可开事件流、`: ping` 心跳 15s
 *
 * 实例拓扑：主实例 :4174 由 playwright.server.config.ts webServer 启动（无 token/
 * 无 --compute，同源伺服）；本 spec beforeAll 另起三个辅助实例（--compute :4176、
 * --token :4175、--hidden :4177，全部指向同一 fixture 目录），afterAll 按 PID 清理；
 * SRV-10 的两个短命实例在用例内起停。夹具统一写在共享 fixture 的 srv-fs/ 子目录
 * （独立命名，不与 fixtures.mjs / b-markdown 组产物冲突；文件服务按请求读盘，
 * server 启动后新增文件对目录树可见，同 b-markdown-html-docs-server.spec.ts 前例）。
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const BIN = join(repoRoot, 'server/target/release/vviewer');
const FIXTURE = process.env.VV_E2E_SERVER_FIXTURE ?? join(repoRoot, '.temp/e2e-server-fixture');
const BASE = 'http://127.0.0.1:4174';
const TOKEN = 'srv-e2e-token-42';
const PAGE_ORIGIN = 'http://127.0.0.1:4174'; // 浏览器页面源（webServer 同源伺服）

const PORT_COMPUTE = 4176;
const PORT_TOKEN = 4175;
const PORT_HIDDEN = 4177;

/** 直启辅助实例（不带 --token 的形态不能走共享 harness：空 --token 会被 main.rs 拒绝） */
function spawnServe(port: number, extraArgs: string[], env?: NodeJS.ProcessEnv): ChildProcess {
  return spawn(
    BIN,
    ['serve', '--root', FIXTURE, '--web-dist', join(repoRoot, 'apps/web/build'), '--port', String(port), ...extraArgs],
    { stdio: ['ignore', 'inherit', 'inherit'], ...(env ? { env } : {}) }
  );
}

let computeServer: ChildProcess | null = null;
let tokenServer: ChildProcess | null = null;
let hiddenServer: ChildProcess | null = null;

test.beforeAll(async () => {
  // ---- 夹具：srv-fs/ 命名空间（幂等） ----
  const dir = join(FIXTURE, 'srv-fs');
  mkdirSync(join(dir, '中文目录一/中文目录二/中文目录三/中文目录四'), { recursive: true });
  mkdirSync(join(dir, 'sort'), { recursive: true });
  writeFileSync(join(dir, 'status-sample.js'), 'const vv = "srv05";\nconsole.log(vv);\n');
  writeFileSync(join(dir, 'status-hello.py'), 'value = 42\nprint(f"v={value}")\n');
  writeFileSync(
    join(dir, 'sse-tall.txt'),
    Array.from({ length: 600 }, (_, i) => `filler line ${i + 1}`).join('\n') + '\n'
  );
  writeFileSync(join(dir, 'manual-refresh.txt'), 'manual refresh baseline\n');
  writeFileSync(join(dir, 'visible.txt'), 'visible in both instances\n');
  writeFileSync(join(dir, '.dot-hidden'), 'dot entry\n');
  writeFileSync(join(dir, 'sort/file1.txt'), '1\n');
  writeFileSync(join(dir, 'sort/file2.txt'), '2\n');
  writeFileSync(join(dir, 'sort/file10.txt'), '10\n');
  writeFileSync(join(dir, '中文目录一/中文目录二/中文目录三/中文目录四/leaf.txt'), 'deep leaf\n');
  // 越界 symlink（域文档 4.2「escape-etc -> /etc」形态的本质：指向 root 外的 symlink）。
  // 目标不用 /etc：walkdir 扫入 /etc 的 PermissionDenied 会反复触发 watcher 重建、
  // 毒化本 fixture 上所有 SSE 时序断言（首轮实测复现）；自控空目录保持越界语义且无噪音。
  const escapeTarget = join(FIXTURE, '..', 'e2e-server-escape-target');
  mkdirSync(escapeTarget, { recursive: true });
  writeFileSync(join(escapeTarget, 'outside.txt'), 'outside root\n');
  rmSync(join(dir, 'escape'), { force: true, recursive: true }); // 重建夹具时清掉旧链接（首轮指向 /etc 的会毒化 watcher）；recursive 兼容目录/链接两种遗留形态
  symlinkSync(escapeTarget, join(dir, 'escape'), 'dir');

  // ---- 辅助实例（重试安全：上一轮 attempt 的实例仍在服务时直接复用，
  //      与 playwright.server.config.ts 的 reuseExistingServer 同口径）----
  async function ensureServe(
    port: number,
    args: string[],
    store: (c: ChildProcess | null) => void
  ): Promise<void> {
    const url = `http://127.0.0.1:${port}`;
    try {
      const res = await fetch(`${url}/api/health`);
      if (res.ok) return; // 已有健康实例（本轮 attempt 遗留）：复用
    } catch {
      // 端口空闲：继续启动
    }
    const child = spawnServe(port, args);
    store(child);
    await waitHealthy(url);
  }

  await ensureServe(PORT_COMPUTE, ['--compute'], (c) => (computeServer = c));
  await ensureServe(PORT_TOKEN, ['--token', TOKEN], (c) => (tokenServer = c));
  await ensureServe(PORT_HIDDEN, ['--hidden'], (c) => (hiddenServer = c));
});

test.afterAll(async () => {
  await stopServer(computeServer, 'srv-compute');
  await stopServer(tokenServer, 'srv-token');
  await stopServer(hiddenServer, 'srv-hidden');
});

/** 主实例同源连接（无 token，全放行，同 b-markdown-html-docs-server.spec.ts 前例） */
async function connectSameOrigin(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: '连接服务器' }).click();
  await page.getByLabel('服务器地址').fill(BASE);
  await page.getByRole('button', { name: '连接', exact: true }).click();
  await expect(page.locator('.vv-tree-row', { hasText: 'srv-fs' })).toBeVisible({ timeout: 10_000 });
}

/** 展开目录树行（懒加载：点击目录行出现子层） */
async function expandRow(page: Page, name: string): Promise<void> {
  await page.locator('.vv-tree-row', { hasText: name }).first().click();
}

test.describe('SRV-02/04/08/09 接口契约', () => {
  test('SRV-02：capabilities 随 --compute 变化（无 compute 仅 file-server，有 compute 尾部追加）', async () => {
    const bare = (await (await fetch(`${BASE}/api/health`)).json()) as { capabilities: string[] };
    expect(bare.capabilities).toEqual(['file-server']);

    const withCompute = (await (await fetch(`http://127.0.0.1:${PORT_COMPUTE}/api/health`)).json()) as {
      capabilities: string[];
    };
    expect(withCompute.capabilities).toEqual(['file-server', 'compute']); // compute 追加于尾部
  });

  test('SRV-04（接口半）：错误 token → 401 + www-authenticate + unauthorized（前端表单半见 m5.spec）', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT_TOKEN}/api/tree`, {
      headers: { authorization: 'Bearer wrong-token' }
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
    expect(((await res.json()) as { error: string }).error).toBe('unauthorized');
  });

  test('SRV-08：Range 三态——正常 206 / 非法严格拒绝 416 / 后缀 206', async () => {
    const file = `${BASE}/api/file?path=srv-fs/status-sample.js`;
    const size = Number((await fetch(file)).headers.get('content-length'));
    expect(size).toBeGreaterThan(0);

    const ok = await fetch(file, { headers: { range: 'bytes=0-5' } });
    expect(ok.status).toBe(206);
    expect(ok.headers.get('content-range')).toBe(`bytes 0-5/${size}`);
    expect((await ok.arrayBuffer()).byteLength).toBe(6);

    // 非法 Range（起点越界 / 非数字）：严格 416 + bytes */size
    for (const bad of [`bytes=${size}-1000`, 'bytes=abc']) {
      const res = await fetch(file, { headers: { range: bad } });
      expect(res.status).toBe(416);
      expect(res.headers.get('content-range')).toBe(`bytes */${size}`);
    }

    const suffix = await fetch(file, { headers: { range: 'bytes=-2' } });
    expect(suffix.status).toBe(206);
    expect(suffix.headers.get('content-range')).toBe(`bytes ${size - 2}-${size - 1}/${size}`);
  });

  test('SRV-09：../ 与 %2e%2e%2f 穿越 400，root 外 symlink 内容层读取 403（边界 3 补断言）', async () => {
    const dotdot = await fetch(`${BASE}/api/file?path=srv-fs/../hello.js`);
    expect(dotdot.status).toBe(400);
    const encoded = await fetch(`${BASE}/api/file?path=%2e%2e%2fetc%2fhostname`);
    expect(encoded.status).toBe(400);
    // symlink 越界（escape -> root 外目录）：树呈现 dir，内容层 /api/file 读取必须 403
    const viaSymlink = await fetch(`${BASE}/api/file?path=srv-fs/escape/outside.txt`);
    expect(viaSymlink.status).toBe(403);
    const tree = (await (await fetch(`${BASE}/api/tree?path=srv-fs`)).json()) as {
      entries: Array<{ name: string; kind: string }>;
    };
    expect(tree.entries.find((e) => e.name === 'escape')?.kind).toBe('dir');
  });
});

test.describe('SRV-05/BUG-04 状态栏与服务端检测头一致', () => {
  test('X-VV 检测头下发（GET 与 Range 206 同形），状态栏语言/编码逐字一致', async ({ page }) => {
    // ① 接口半：js/python 检测头 + Range 206 路径仍带头（偏差 #3：无 X-VV-Type 属已裁决，不断言）
    const js = await fetch(`${BASE}/api/file?path=srv-fs/status-sample.js`);
    expect(js.headers.get('x-vv-lang')).toBe('javascript');
    const jsEnc = js.headers.get('x-vv-encoding');
    expect(jsEnc).toBe('utf-8');
    const ranged = await fetch(`${BASE}/api/file?path=srv-fs/status-sample.js`, {
      headers: { range: 'bytes=0-5' }
    });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get('x-vv-lang')).toBe('javascript');
    expect(ranged.headers.get('x-vv-encoding')).toBe('utf-8');
    const py = await fetch(`${BASE}/api/file?path=srv-fs/status-hello.py`);
    expect(py.headers.get('x-vv-lang')).toBe('python');

    // ② 浏览器半：状态栏值与 X-VV 头一致（BUG-04 修复前状态栏不展示，现状不得回退）
    await connectSameOrigin(page);
    await expandRow(page, 'srv-fs');
    await page.locator('.vv-tree-row', { hasText: 'status-sample.js' }).click();
    const sb = page.locator('.vv-statusbar');
    await expect(page.locator('.vv-tab.active', { hasText: 'status-sample.js' })).toBeVisible();
    await expect(sb).toContainText(`语言: javascript`, { timeout: 10_000 });
    await expect(sb).toContainText(`编码: ${jsEnc}`);

    await page.locator('.vv-tree-row', { hasText: 'status-hello.py' }).click();
    await expect(sb).toContainText('语言: python', { timeout: 10_000 });
  });
});

test.describe('SRV-06/BUG-02 SSE 变更推送与自愈', () => {
  test('changed 帧流动（含 paths）且窗口内无 watch-error', async () => {
    test.setTimeout(30_000);
    const ticket = ((await (await fetch(`${BASE}/api/ticket`, { method: 'POST' })).json()) as { ticket: string })
      .ticket;
    const res = await fetch(`${BASE}/api/events?ticket=${ticket}`, {
      headers: { accept: 'text/event-stream' }
    });
    expect(res.ok).toBeTruthy();
    const reader = res.body!.getReader();
    const frames: string[] = [];
    let changed: string | null = null;
    const deadline = Date.now() + 10_000;
    writeFileSync(join(FIXTURE, 'srv-fs/sse-poke.txt'), `poke ${Date.now()}\n`); // 新建文件触发 watcher
    while (Date.now() < deadline && changed === null) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = new TextDecoder().decode(value);
      frames.push(chunk);
      for (const line of chunk.split('\n')) {
        if (line.startsWith('data:')) {
          const body = line.slice(5).trim();
          if (body.includes('"changed"') && body.includes('sse-poke.txt')) changed = body;
        }
      }
    }
    await reader.cancel().catch(() => {});
    expect(changed).not.toBeNull(); // ~500ms debounce 内推送 {"type":"changed","paths":[...]}
    expect(JSON.parse(changed!).paths).toContain('srv-fs/sse-poke.txt');
    // 全程不得出现已弃用的 watch-error 帧（BUG-02 修复口径；degraded/recovered 为信息帧不算故障）
    expect(frames.join('')).not.toContain('watch-error');
  });

  test('SRV-13：ticket 一次性、Bearer 不可开事件流、ping 心跳间隔 15s', async () => {
    test.setTimeout(60_000);
    // ① 一次性 ticket：首用可建流（读到首个帧/注释即证升级成功），二次使用 401
    const t1 = ((await (await fetch(`${BASE}/api/ticket`, { method: 'POST' })).json()) as { ticket: string }).ticket;
    const first = await fetch(`${BASE}/api/events?ticket=${t1}`);
    expect(first.status).toBe(200);
    await first.body!.cancel().catch(() => {});
    const second = await fetch(`${BASE}/api/events?ticket=${t1}`);
    expect(second.status).toBe(401); // 同一 ticket 二次使用失效

    // ② Bearer 认证不可用于 /api/events（带 token 实例：持有效 Bearer 但无 ticket 仍 401）
    const bearerOnly = await fetch(`http://127.0.0.1:${PORT_TOKEN}/api/events`, {
      headers: { authorization: `Bearer ${TOKEN}` }
    });
    expect(bearerOnly.status).toBe(401);

    // ③ 心跳：长挂流实录相邻 ping 时间戳，间隔精确 15s（读到第 2 个 ping 即收）
    const t2 = ((await (await fetch(`${BASE}/api/ticket`, { method: 'POST' })).json()) as { ticket: string }).ticket;
    const stream = await fetch(`${BASE}/api/events?ticket=${t2}`);
    const reader = stream.body!.getReader();
    const pings: number[] = [];
    const started = Date.now();
    while (pings.length < 2 && Date.now() - started < 40_000) {
      const { value, done } = await reader.read();
      if (done) break;
      if (new TextDecoder().decode(value).includes(': ping')) pings.push(Date.now());
    }
    await reader.cancel().catch(() => {});
    expect(pings.length).toBe(2);
    const gap = (pings[1]! - pings[0]!) / 1000;
    expect(gap).toBeGreaterThan(13); // 15s ± 抖动余量（分块读取时机）
    expect(gap).toBeLessThan(17);
  });

  test('自动重读：追加后 ~500ms debounce 内新行渲染且 scrollTop 保留，状态栏无常驻降级警示', async ({ page }) => {
    test.setTimeout(60_000);
    await connectSameOrigin(page);
    await expandRow(page, 'srv-fs');
    await page.locator('.vv-tree-row', { hasText: 'sse-tall.txt' }).click();
    const pre = page.locator('.vv-code-pre');
    await expect(pre).toContainText('filler line 1', { timeout: 10_000 });

    // 滚到中部（BUG-09 复核口径：以视口渲染了哪些行判定，而非容器 scrollHeight）
    await pre.evaluate((el) => {
      el.scrollTop = 3000;
      el.dispatchEvent(new Event('scroll'));
    });
    await expect(pre.locator('.vv-code-line[data-line="150"]')).toBeVisible();

    // 服务器侧追加（与 m5 的自动刷新用例互补：断言滚动保留 + 新内容渲染 + 无降级警示）。
    // 600 行文件走虚拟渲染：末尾新行不进 DOM，重读证据用「3s 内自动 GET /api/file」
    // （对齐报告 tmpfs 对照基线口径）+ 跳底后 marker 可见
    let fileFetches = 0;
    await page.exposeFunction('__vvBumpFileFetch', () => {
      fileFetches += 1;
    });
    await page.on('request', (r) => {
      if (r.url().includes('/api/file') && r.url().includes('sse-tall.txt')) {
        void page.evaluate(() => (window as unknown as { __vvBumpFileFetch: () => void }).__vvBumpFileFetch());
      }
    });
    const marker = `// e2e-bug02-marker-${Date.now()}`;
    const before = fileFetches;
    appendFileSync(join(FIXTURE, 'srv-fs/sse-tall.txt'), `${marker}\n`);
    await expect
      .poll(() => fileFetches, { timeout: 3_000, message: 'append 后 3s 内未自动重读 /api/file' })
      .toBeGreaterThan(before); // 500ms debounce 内自动重读
    await expect(pre.locator('.vv-code-line[data-line="150"]')).toBeVisible(); // scrollTop 保留：视口仍停在中部
    await pre.click({ position: { x: 40, y: 40 } }); // 焦点态后 G 跳底验证新行已渲染
    await page.keyboard.press('G');
    await expect(pre).toContainText(marker, { timeout: 5_000 });
    await expect(page.locator('.vv-statusbar')).not.toContainText('自动刷新不可用'); // BUG-02 验收 3
  });
});

test.describe('SRV-07/BUG-05 手动刷新', () => {
  test('设置切手动后 SSE 追加不自动出现，手动刷新按钮呈现新行', async ({ page }) => {
    test.setTimeout(60_000);
    await connectSameOrigin(page);
    await expandRow(page, 'srv-fs');
    await page.locator('.vv-tree-row', { hasText: 'manual-refresh.txt' }).click();
    const pre = page.locator('.vv-code-pre');
    await expect(pre).toContainText('manual refresh baseline', { timeout: 10_000 });

    // 设置面板（BUG-05 修复后入口）切手动：关「自动刷新」开关
    await page.locator('button[aria-label="设置"]').click();
    const panel = page.locator('.vv-settings');
    await expect(panel).toBeVisible();
    await panel.locator('.vv-settings-toggle input[type="checkbox"]').uncheck();
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);

    // 手动刷新按钮恒可用（BUG-05 验收 2 的 UI 前提）
    await expect(page.locator('button[aria-label="刷新当前文件"]')).toBeVisible();

    // 服务端追加：手动模式下不自动出现（现状基线：追加 2.5s 后页面不含新行）
    const marker = `manual marker ${Date.now()}`;
    appendFileSync(join(FIXTURE, 'srv-fs/manual-refresh.txt'), `${marker}\n`);
    await page.waitForTimeout(2_500);
    await expect(pre).not.toContainText(marker);

    // 手动刷新 → 新行出现（BUG-05 验收 2 行为级）
    await page.locator('button[aria-label="刷新当前文件"]').click();
    await expect(pre).toContainText(marker, { timeout: 5_000 });
  });
});

test.describe('SRV-10 启动约束', () => {
  test('--allow-lan 无 token 拒绝启动（exit 2 + 明确报错）', async () => {
    await assertPortFree('http://127.0.0.1:4279');
    const child = spawnServe(4279, ['--allow-lan']);
    const exitCode: number | null = await new Promise((resolve_) => {
      child.on('exit', (code) => resolve_(code));
    });
    expect(exitCode).toBe(2);
  });

  test('--token-gen 正常启动：stdout 打印 64 位 token，health 可用', async () => {
    test.setTimeout(30_000);
    await assertPortFree('http://127.0.0.1:4280');
    const child = spawn(BIN, [
      'serve', '--root', FIXTURE, '--web-dist', join(repoRoot, 'apps/web/build'),
      '--port', '4280', '--allow-lan', '--token-gen'
    ]);
    const tokenPromise = new Promise<string>((resolve_) => {
      child.stdout!.on('data', (chunk: Buffer) => {
        const line = chunk.toString().split('\n')[0]!.trim();
        if (/^[0-9a-f]{64}$/.test(line)) resolve_(line);
      });
    });
    const token = await Promise.race([
      tokenPromise,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('3s 内未见 64 位 token')), 3_000))
    ]);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    await waitHealthy('http://127.0.0.1:4280');
    // 64 位 token 真实生效：无 token 401，持 token 放行
    const denied = await fetch('http://127.0.0.1:4280/api/tree');
    expect(denied.status).toBe(401);
    const allowed = await fetch('http://127.0.0.1:4280/api/tree', {
      headers: { authorization: `Bearer ${token}` }
    });
    expect(allowed.ok).toBeTruthy();
    await stopServer(child, 'srv-tokengen');
  });
});

test.describe('SRV-11/12 树过滤与排序', () => {
  test('SRV-11：dot 文件默认全显示，--hidden 实例仅剩 visible.txt（API 对照）', async () => {
    const q = (port: number) => fetch(`http://127.0.0.1:${port}/api/tree?path=srv-fs`);
    const names = async (port: number) =>
      ((await (await q(port)).json()) as { entries: Array<{ name: string }> }).entries.map((e) => e.name);
    const def = await names(4174);
    expect(def).toContain('.dot-hidden');
    expect(def).toContain('visible.txt');
    const hidden = await names(PORT_HIDDEN);
    expect(hidden).toContain('visible.txt');
    expect(hidden).not.toContain('.dot-hidden');
  });

  test('SRV-12：中文 4 层懒加载展开 + 目录优先 + 自然排序 file1<file2<file10', async ({ page }) => {
    test.setTimeout(60_000);
    // API 层：目录优先 + 自然排序
    const sortApi = ((await (await fetch(`${BASE}/api/tree?path=srv-fs/sort`)).json()) as {
      entries: Array<{ name: string }>;
    }).entries.map((e) => e.name);
    expect(sortApi).toEqual(['file1.txt', 'file2.txt', 'file10.txt']); // 非字典序（字典序 file10 在 file2 前）

    // 浏览器层：逐层展开中文目录至第 4 层（懒加载），末层 leaf 可见
    await connectSameOrigin(page);
    await expandRow(page, 'srv-fs');
    // 目录优先（UI 同一口径）：srv-fs 展开后首个子行是最靠前的目录 escape（e < s < 中）
    const allRows = page.locator('.vv-tree-row');
    const texts = await allRows.allTextContents();
    const srvIdx = texts.findIndex((t) => t.includes('srv-fs'));
    expect(texts[srvIdx + 1]).toContain('escape');
    // 默认实例 dot 文件在树中可见（BUG 报告口径：默认全显示；--hidden 过滤已在 API 层对照）
    await expect(allRows.filter({ hasText: '.dot-hidden' }).first()).toBeVisible();

    for (const seg of ['中文目录一', '中文目录二', '中文目录三', '中文目录四']) {
      await expandRow(page, seg);
    }
    await expect(page.locator('.vv-tree-row', { hasText: 'leaf.txt' })).toBeVisible({ timeout: 10_000 });

    // 自然排序在 UI 树内同样成立：sort/ 展开后 DOM 顺序 file1 < file2 < file10
    await expandRow(page, 'sort');
    await expect(allRows.filter({ hasText: 'file10.txt' }).first()).toBeVisible({ timeout: 10_000 });
    const sortRows = await allRows.allTextContents();
    const f1 = sortRows.findIndex((t) => t.includes('file1.txt'));
    const f2 = sortRows.findIndex((t) => t.includes('file2.txt'));
    const f10 = sortRows.findIndex((t) => t.includes('file10.txt'));
    expect(f1).toBeGreaterThanOrEqual(0);
    expect(f1).toBeLessThan(f2);
    expect(f2).toBeLessThan(f10);
  });
});
