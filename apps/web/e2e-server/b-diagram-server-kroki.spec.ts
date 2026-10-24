import { createServer, type Server } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import { stopServer, waitHealthy } from '../e2e/serverHarness';

/**
 * 服务端图表与 kroki 代发 e2e（DSV-01/02/05，P3 plan Task 9，spec
 * 2026-10-23-renderer-lang-override §8）：承接 Task 4 b-compute-diagrams 的
 * 「服务端 markdown 后处理」面之后，本轮补「客户端按语言设置路由服务端」的
 * 两个消费面——
 * - DSV-01 modes.graphviz='server'（spec §8.3）：computePolicy=local 使文档
 *   正文留本地（状态栏「渲染: 本地」，与 Task 4 的整篇远程路径区分），围栏
 *   经客户端管线 effectiveModeOf 能力协商（health diagrams 子集）POST
 *   /api/compute/diagram 内联 svg——断言真实 POST 200 + 视图 svg + 无
 *   data-md-diagram-wrapped（服务端 markdown 产物指纹，证非后处理路径）；
 * - DSV-02 krokiVia='server'（spec §8.2/§8.3）：plantuml 默认 kroki 模式改走
 *   POST /api/kroki 服务端代发，视图为 [data-vv-diagram="kroki-proxy"] 内联
 *   svg（非 img）。**mock 策略记档**：page.route 拦不到服务端 reqwest 出站
 *   （不经过浏览器网络栈），kroki.io 上游的离线模拟唯一通道是部署侧
 *   `--kroki-host` 指向 spec 内自起的 node http mock 上游（4187 端口）——
 *   前端→/api/kroki→reqwest→mock 上游→svg 回流全链真实，mock 侧命中
 *   计数与请求体断言（路径 /plantuml/svg + 源码原文）证明转发链穿透；
 * - DSV-05 UI 能力面（spec §8.3 协商的设置中心侧）：已连接 kroki-proxy
 *   能力实例后「Kroki 通道」select 的「服务端代发」option 可选（默认通道
 *   DSV-03 的未连接面为 disabled），graphviz 行渲染模式含「服务端」档
 *   （注册表 server 旗标门控的 UI 投影）。
 *
 * 拓扑（b-compute-diagrams 同款 beforeAll spawn / afterAll stop，端口错开
 * 既有 4174/4178-4182/4185）：同源 compute 实例 :4186（--compute +
 * --kroki-host http://127.0.0.1:4187）；mock kroki 上游 :4187（node http，
 * POST {lang}/svg 恒 200 svg，GET /dsv-mock-ping 供幂等复用探测）。夹具
 * dsv- 前缀写入共享 fixture 根。
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const BIN = join(repoRoot, 'server/target/release/vviewer');
const WEB_DIST = join(repoRoot, 'apps/web/build');
const FIXTURE = process.env.VV_E2E_SERVER_FIXTURE ?? join(repoRoot, '.temp/e2e-server-fixture');
const PORT_COMPUTE = 4186; // 同源 compute+kroki 实例（本轮专用）
const PORT_KROKI_MOCK = 4187; // mock kroki 上游（部署侧 --kroki-host 指向）
const COMPUTE_BASE = `http://127.0.0.1:${PORT_COMPUTE}`;

/** mock 上游应答 svg（结构最小面；data-* 是否穿过客户端 sanitize 不进断言面） */
const MOCK_SVG = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="8" height="8"/></svg>';

/** mock kroki 上游命中台账：{路径段, body 源码原文}——转发链穿透的直接证据 */
const krokiUpstreamHits: Array<{ path: string; body: string }> = [];

let computeServer: ChildProcess | null = null;
let mockUpstream: Server | null = null;
let mockOwned = false;

function spawnServe(port: number, extraArgs: string[]): ChildProcess {
  return spawn(
    BIN,
    ['serve', '--root', FIXTURE, '--web-dist', WEB_DIST, '--port', String(port), ...extraArgs],
    { stdio: ['ignore', 'inherit', 'inherit'] }
  );
}

test.beforeAll(async () => {
  // ---- 夹具（dsv- 前缀，幂等） ----
  mkdirSync(FIXTURE, { recursive: true });
  writeFileSync(
    join(FIXTURE, 'dsv-01-server-mode.md'),
    ['# 服务端单图', '', '```dot', 'digraph { dsv -> ok }', '```', ''].join('\n')
  );
  writeFileSync(
    join(FIXTURE, 'dsv-02-kroki-proxy.md'),
    ['# kroki 代发', '', '```plantuml', 'Alice -> Bob: dsv', '```', ''].join('\n')
  );

  // ---- mock kroki 上游 :4187（幂等复用：前轮残留 ping 通即不重复 listen） ----
  try {
    const res = await fetch(`http://127.0.0.1:${PORT_KROKI_MOCK}/dsv-mock-ping`);
    if (res.ok) return;
  } catch {
    // 端口空闲：起 mock
  }
  mockUpstream = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => {
      body += c.toString('utf-8');
    });
    req.on('end', () => {
      if (req.method === 'GET' && req.url === '/dsv-mock-ping') {
        res.writeHead(200).end('ok');
        return;
      }
      krokiUpstreamHits.push({ path: req.url ?? '', body });
      res.writeHead(200, { 'content-type': 'image/svg+xml' });
      res.end(MOCK_SVG);
    });
  });
  await new Promise<void>((ok, err) =>
    mockUpstream!.once('error', err).listen(PORT_KROKI_MOCK, '127.0.0.1', () => ok())
  );
  mockOwned = true;

  // ---- 同源 compute 实例 :4186（--compute + --kroki-host 指向 mock；重试安全复用） ----
  try {
    if ((await fetch(`${COMPUTE_BASE}/api/health`)).ok) return;
  } catch {
    // 端口空闲
  }
  computeServer = spawnServe(PORT_COMPUTE, [
    '--compute',
    '--kroki-host',
    `http://127.0.0.1:${PORT_KROKI_MOCK}`
  ]);
  await waitHealthy(COMPUTE_BASE);
});

test.afterAll(async () => {
  await stopServer(computeServer, 'dsv-compute');
  if (mockOwned && mockUpstream) await new Promise<void>((ok) => mockUpstream!.close(() => ok()));
});

/**
 * 同源连接 + 设置预注入（connectSameOriginCompute 同款：settings 经
 * addInitScript 先于 goto 落 localStorage——normalizeSettings 白名单直读）。
 */
async function connectWithSettings(page: Page, settings: Record<string, unknown>): Promise<void> {
  await page.addInitScript((s) => {
    localStorage.setItem('vviewer:settings', JSON.stringify(s));
  }, settings);
  await page.goto(COMPUTE_BASE + '/');
  await page.getByRole('button', { name: '连接服务器' }).click();
  await page.getByLabel('服务器地址').fill(COMPUTE_BASE);
  await page.getByRole('button', { name: '连接', exact: true }).click();
  await expect(page.locator('.vv-tree-row', { hasText: 'dsv-' }).first()).toBeVisible({
    timeout: 10_000
  });
}

async function openFile(page: Page, name: string): Promise<void> {
  await page.locator('.vv-tree-row', { hasText: name }).first().click();
  await expect(page.locator('.vv-tab.active', { hasText: name })).toBeVisible({ timeout: 10_000 });
}

test.describe('b-diagram-server-kroki 服务端图表与 kroki 代发（spec §8）', () => {
  test('DSV-01 modes.graphviz=server 围栏经 /api/compute/diagram 出图（正文留本地，非 markdown 后处理面）', async ({
    page
  }) => {
    test.setTimeout(120_000);
    const diagramPosts: number[] = [];
    page.on('response', (r) => {
      if (r.request().method() === 'POST' && r.url().includes('/api/compute/diagram')) {
        diagramPosts.push(r.status());
      }
    });

    await connectWithSettings(page, {
      computePolicy: 'local',
      diagrams: { modes: { graphviz: 'server' } }
    });
    await openFile(page, 'dsv-01-server-mode.md');

    // 真实 POST /api/compute/diagram 发生且成功（能力协商命中才提供 server 分支）
    await expect
      .poll(() => diagramPosts.length, { timeout: 30_000, message: 'POST /api/compute/diagram 应发生' })
      .toBeGreaterThan(0);
    for (const s of diagramPosts) expect(s, '单图端点全部 200').toBe(200);

    // 客户端管线 server 分支：svg 内联进标准 wrapper 视图面板
    const view = page.locator('.vv-markdown .md-diagram-view', { has: page.locator('svg') });
    await expect(view).toBeVisible({ timeout: 30_000 });
    await expect(view.locator('svg')).toHaveCount(1);
    // 非 markdown 后处理面：无契约 div 接回指纹（Task 4 路径专属）；正文留本地
    await expect(page.locator('[data-md-diagram-wrapped]')).toHaveCount(0);
    const sb = page.locator('.vv-statusbar');
    await expect(sb).toContainText('渲染: 本地');
  });

  test('DSV-02 krokiVia=server 经 /api/kroki 服务端代发出内联 svg——mock 上游（--kroki-host）命中与源码透传', async ({
    page
  }) => {
    test.setTimeout(120_000);
    const krokiPosts: number[] = [];
    page.on('response', (r) => {
      if (r.request().method() === 'POST' && r.url().includes('/api/kroki')) {
        krokiPosts.push(r.status());
      }
    });

    await connectWithSettings(page, {
      computePolicy: 'local',
      diagrams: { krokiVia: 'server' }
    });
    await openFile(page, 'dsv-02-kroki-proxy.md');

    // 代发链穿透：前端→/api/kroki 200；服务端 reqwest→mock 上游命中（page.route
    // 拦不到出站，命中台账是转发链真实发生的唯一观测面）——路径 {lang}/svg、
    // body 即 raw 源码（core kroki.rs 不加工透传语义）
    await expect
      .poll(() => krokiPosts.length, { timeout: 30_000, message: 'POST /api/kroki 应发生' })
      .toBeGreaterThan(0);
    for (const s of krokiPosts) expect(s, '代发端点全部 200').toBe(200);
    await expect
      .poll(() => krokiUpstreamHits.length, { timeout: 30_000, message: 'mock 上游应被命中' })
      .toBeGreaterThan(0);
    expect(krokiUpstreamHits.some((h) => h.path === '/plantuml/svg')).toBe(true);
    expect(krokiUpstreamHits.some((h) => h.body.includes('Alice -> Bob: dsv'))).toBe(true);

    // 前端消费面：kroki-proxy 标容器内联 svg（非 img 直发）
    const view = page.locator('.vv-markdown .md-diagram-view').first();
    await expect(view.locator('[data-vv-diagram="kroki-proxy"] svg')).toBeVisible({ timeout: 30_000 });
    await expect(view.locator('img')).toHaveCount(0);
  });

  test('DSV-05 已连接 kroki-proxy 实例：Kroki 通道「服务端代发」可选 + graphviz 行含「服务端」档', async ({
    page
  }) => {
    test.setTimeout(120_000);
    await connectWithSettings(page, { computePolicy: 'local' });

    // 连接后开设置中心（DiagramsSection 挂载时读会话缓存 capabilities）
    await page.locator('button[aria-label="设置"]').click();
    await page.locator('.vv-sc-navitem', { hasText: '图表' }).click();
    const via = page.locator('select[aria-label="Kroki 通道"]');
    await expect(via).toHaveValue('client');
    await expect(via.locator('option[value="server"]')).toBeEnabled();
    // 注册表 server 旗标（graphviz/svgbob）的 UI 投影：模式行含「服务端」option；
    // 非旗标类型（plantuml）恒无该档
    await expect(page.locator('select[aria-label="graphviz 渲染模式"] option[value="server"]')).toHaveCount(1);
    await expect(page.locator('select[aria-label="plantuml 渲染模式"] option[value="server"]')).toHaveCount(0);
  });
});
