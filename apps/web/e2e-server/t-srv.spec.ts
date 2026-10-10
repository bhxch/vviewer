import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, type Page } from '@playwright/test';
import { assertPortFree, stopServer, waitHealthy } from '../e2e/serverHarness';

/**
 * server-file-service 域缺口补齐（t- 前缀标记本轮新增；编号对照
 * docs/e2e/server-file-service.md 第 2/3 节）：
 * - SRV-01：release 二进制冒烟补全——首页 200 + capabilities=[file-server] +
 *   目录树懒加载展开（smoke.spec.ts 只断言壳渲染，无树展开半）；
 * - SRV-03：无 token / token 两形态连接 + 树懒加载 + 凭据存 sessionStorage
 *   （偏差 #2；行为原散落 m5.spec.ts / b-markdown-html-docs-server.spec.ts
 *   但无编号标记）；
 * - SRV-04/2：错误 token 表单提示验收全文案（m5.spec.ts:113 仅 contains '401'；
 *   文案出处 openFlow.svelte.ts:356）；
 * - SRV-05/2：跨源部署（--cors-origin）下 X-VV 头 JS 可读（d8ba77e expose_headers
 *   回归锚，server/src/lib.rs:134-140）+ 状态栏语言/编码与头逐字一致；
 * - SRV-06/2：watcher 故障注入→自愈（fixme 占位，原因见用例注释）；
 * - SRV-07/2：刷新模式 manual→auto 回切后 SSE 自动重读恢复（b- 侧两个用例
 *   只测 auto→manual 单向）；
 * - SRV-10/2：--allow-lan 无 token 拒启的报错输出（b-server-file-service.spec.ts:368
 *   只断 exit=2；文案出处 server/src/main.rs:108）；
 * - SRV-11/2：--hidden 实例浏览器树对照（b- 侧 SRV-11 止步 API 层）；
 * - SRV-12/2：API 层目录+文件混合清单全序（目录优先 rank + 自然排序，
 *   server/src/routes/tree.rs:75-77）；
 * - SRV-12/3：空格/中文/emoji 特殊文件名 API 列出 + 树展开（域文档 4.2 对照件）。
 *
 * 实例拓扑：主实例 :4174 由 playwright.server.config.ts webServer 启动（release
 * 二进制、无 token、无 --compute、同源伺服）；beforeAll 另起三个辅助实例（:4375
 * token+cors、:4376 hidden+cors、:4377 cors，同 fixture 目录），afterAll 按 PID
 * 清理；SRV-10/2 的短命实例用例内起停。跨源实例的 --cors-origin 必须精确等于
 * 页面源 http://127.0.0.1:4174（CorsLayer AllowOrigin::list 精确回显）。
 * 夹具写在共享 fixture 的 srv-t/ 命名空间（幂等，独立命名不与 fixtures.mjs /
 * srv-fs / bmd- / cg- / b24 等产物冲突）。端口 437x 与既有 4175-4177/4279/4280/
 * 8399/8449 错开；套件单 worker（playwright.server.config.ts workers:1）串行执行。
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const BIN = join(repoRoot, 'server/target/release/vviewer');
const FIXTURE = process.env.VV_E2E_SERVER_FIXTURE ?? join(repoRoot, '.temp/e2e-server-fixture');
const BASE = 'http://127.0.0.1:4174';
const PAGE_ORIGIN = 'http://127.0.0.1:4174';
const TOKEN = 'srv-t-token-42';

const PORT_TOKEN = 4375;
const PORT_HIDDEN = 4376;
const PORT_CORS = 4377;

function spawnServe(port: number, extraArgs: string[]): ChildProcess {
  return spawn(
    BIN,
    [
      'serve', '--root', FIXTURE, '--web-dist', join(repoRoot, 'apps/web/build'),
      '--port', String(port), ...extraArgs
    ],
    { stdio: ['ignore', 'inherit', 'inherit'] }
  );
}

let tokenServer: ChildProcess | null = null;
let hiddenServer: ChildProcess | null = null;
let corsServer: ChildProcess | null = null;

test.beforeAll(async () => {
  // ---- 夹具：srv-t/ 命名空间（幂等） ----
  const dir = join(FIXTURE, 'srv-t');
  mkdirSync(join(dir, 'token-tree/sub'), { recursive: true });
  mkdirSync(join(dir, 'mixed/dir-a'), { recursive: true });
  mkdirSync(join(dir, 'mixed/dir-b'), { recursive: true });
  mkdirSync(join(dir, '特殊名'), { recursive: true });
  writeFileSync(join(dir, 'token-tree/top.txt'), 'token tree top\n');
  writeFileSync(join(dir, 'token-tree/sub/deep.txt'), 'lazy leaf\n');
  writeFileSync(join(dir, 'cors-lang.js'), 'const cors = "srv-t";\n');
  writeFileSync(join(dir, 'manual-toggle.txt'), 'toggle baseline\n');
  writeFileSync(join(dir, 'visible.txt'), 'visible in both\n');
  writeFileSync(join(dir, '.srv-t-dot'), 'dot entry\n');
  writeFileSync(join(dir, 'mixed/file1.txt'), '1\n');
  writeFileSync(join(dir, 'mixed/file2.txt'), '2\n');
  writeFileSync(join(dir, 'mixed/file10.txt'), '10\n');
  writeFileSync(join(dir, '特殊名/空格 名.txt'), 'space\n');
  writeFileSync(join(dir, '特殊名/emoji😀.txt'), 'emoji\n');
  writeFileSync(join(dir, '特殊名/中文·名.txt'), 'cjk\n');

  // ---- 辅助实例（重试安全：health 已有响应即复用遗留实例，同
  //      b-server-file-service.spec.ts ensureServe 前例）----
  async function ensureServe(
    port: number,
    args: string[],
    store: (c: ChildProcess | null) => void
  ): Promise<void> {
    const url = `http://127.0.0.1:${port}`;
    try {
      const res = await fetch(`${url}/api/health`);
      if (res.ok) return;
    } catch {
      // 端口空闲：继续启动
    }
    const child = spawnServe(port, args);
    store(child);
    await waitHealthy(url);
  }
  await ensureServe(PORT_TOKEN, ['--token', TOKEN, '--cors-origin', PAGE_ORIGIN], (c) => (tokenServer = c));
  await ensureServe(PORT_HIDDEN, ['--hidden', '--cors-origin', PAGE_ORIGIN], (c) => (hiddenServer = c));
  await ensureServe(PORT_CORS, ['--cors-origin', PAGE_ORIGIN], (c) => (corsServer = c));
});

test.afterAll(async () => {
  await stopServer(tokenServer, 'srv-t-token');
  await stopServer(hiddenServer, 'srv-t-hidden');
  await stopServer(corsServer, 'srv-t-cors');
});

/** 连接表单提交（新 page 每用例独立 sessionStorage）；token null = 留空 */
async function connectForm(page: Page, base: string, token: string | null): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: '连接服务器' }).click();
  await page.getByLabel('服务器地址').fill(base);
  if (token !== null) await page.getByLabel('访问令牌').fill(token);
  await page.getByRole('button', { name: '连接', exact: true }).click();
}

/** 树行精确匹配（共享夹具名字相近行多，避免 hasText 子串误中；同 b-server-regression 前例） */
function treeRow(page: Page, name: string): ReturnType<Page['locator']> {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return page
    .locator('.vv-tree-row')
    .filter({ has: page.locator('.vv-tree-name', { hasText: new RegExp(`^${escaped}$`) }) });
}

/** 展开目录树行（懒加载：点击目录行出现子层） */
async function expandRow(page: Page, name: string): Promise<void> {
  await treeRow(page, name).first().click();
}

test('SRV-01: release 二进制冒烟——首页 200、capabilities=[file-server]、目录树懒加载展开', async ({
  page
}) => {
  // ① health（主实例即 release 二进制，无 --compute 形态）
  const health = await page.request.get('/api/health');
  expect(health.status()).toBe(200);
  const body = (await health.json()) as { name: string; capabilities: string[] };
  expect(body.name).toBe('vviewer');
  expect(body.capabilities).toEqual(['file-server']);

  // ② 首页 200 + 应用壳
  const home = await page.goto('/');
  expect(home!.status()).toBe(200);
  await expect(page.locator('.vv-shell')).toBeVisible();

  // ③ 目录树懒加载展开：三层逐层点击，末层叶可见
  await connectForm(page, BASE, null);
  await expect(treeRow(page, 'srv-t')).toBeVisible({ timeout: 10_000 });
  await expandRow(page, 'srv-t');
  await expect(treeRow(page, 'token-tree')).toBeVisible();
  await expandRow(page, 'token-tree');
  await expect(treeRow(page, 'sub')).toBeVisible({ timeout: 10_000 });
  await expandRow(page, 'sub');
  await expect(treeRow(page, 'deep.txt')).toBeVisible({ timeout: 10_000 });
});

test('SRV-03: 无 token 与 token 两形态连接成功、树懒加载展开、凭据存 sessionStorage（偏差 #2）', async ({
  page
}) => {
  // ① 无 token 同源（主实例）：连接 → 逐层展开至叶
  await connectForm(page, BASE, null);
  await expect(treeRow(page, 'srv-t')).toBeVisible({ timeout: 10_000 });
  await expandRow(page, 'srv-t');
  await expandRow(page, 'token-tree');
  await expandRow(page, 'sub');
  await expect(treeRow(page, 'deep.txt')).toBeVisible({ timeout: 10_000 });

  // ② token 实例（:4375，跨源 + CORS 放行）：表单粘贴 token 连接 → 树出现
  await connectForm(page, `http://127.0.0.1:${PORT_TOKEN}`, TOKEN);
  await expect(treeRow(page, 'srv-t')).toBeVisible({ timeout: 10_000 });
  await expandRow(page, 'srv-t');
  await expect(treeRow(page, 'top.txt')).toBeVisible({ timeout: 10_000 });

  // ③ 偏差 #2：凭据存 sessionStorage（键 vviewer-last-server，packages/core/src/tree/remote.ts:58，
  //    值形状 {baseUrl, token}，openFlow.svelte.ts:385-387 写入），会话内可预填、重连需手动
  const last = await page.evaluate(() =>
    sessionStorage.getItem('vviewer-last-server')
  );
  expect(last).not.toBeNull();
  const parsed = JSON.parse(last!) as { baseUrl: string; token: string | null };
  expect(parsed.baseUrl).toBe(`http://127.0.0.1:${PORT_TOKEN}`);
  expect(parsed.token).toBe(TOKEN);
});

test('SRV-04/2: 错误 token 表单提交显示验收全文案「鉴权失败：令牌缺失或错误（HTTP 401）」', async ({
  page
}) => {
  await connectForm(page, `http://127.0.0.1:${PORT_TOKEN}`, 'wrong-token');
  const error = page.locator('.vv-server-error');
  await expect(error).toBeVisible({ timeout: 10_000 });
  await expect(error).toContainText('鉴权失败：令牌缺失或错误（HTTP 401）');
  // 连接失败：目录树不得出现
  await expect(page.locator('.vv-tree')).toHaveCount(0);
});

test('SRV-05/2: 跨源部署下 X-VV 头 JS 可读（expose_headers）且状态栏语言/编码逐字一致', async ({
  page
}) => {
  // ① 直接锚（d8ba77e 回归）：页面源 4174 跨源 fetch :4377 响应，JS 可读 x-vv-*。
  //    expose 缺失时 headers.get 恒 null（设计文档 §7.3 记录过的缺陷形态）
  const corsBase = `http://127.0.0.1:${PORT_CORS}`;
  await page.goto('/'); // 先有文档上下文，evaluate 内 fetch 才以页面源发起
  const heads = await page.evaluate(async (url) => {
    const res = await fetch(url);
    return {
      status: res.status,
      lang: res.headers.get('x-vv-lang'),
      enc: res.headers.get('x-vv-encoding')
    };
  }, `${corsBase}/api/file?path=${encodeURIComponent('srv-t/cors-lang.js')}`);
  expect(heads.status).toBe(200);
  expect(heads.lang).toBe('javascript');
  expect(heads.enc).toBe('utf-8');

  // ② 端到端：跨源连接 → 打开文件 → 状态栏语言/编码与头逐字一致
  await connectForm(page, corsBase, null);
  await expect(treeRow(page, 'srv-t')).toBeVisible({ timeout: 10_000 });
  await expandRow(page, 'srv-t');
  await treeRow(page, 'cors-lang.js').click();
  await expect(page.locator('.vv-tab.active', { hasText: 'cors-lang.js' })).toBeVisible();
  const sb = page.locator('.vv-statusbar');
  await expect(sb).toContainText(`语言: ${heads.lang}`, { timeout: 10_000 });
  await expect(sb).toContainText(`编码: ${heads.enc}`);
});

// SRV-06/2（BUG-02 验收 3/5）：watcher 故障注入→自愈。
// 暂以 fixme 占位：e2e 层无法稳定注入 notify 运行期错误——chmod 000 子目录依赖
// 非 root 执行环境、symlink→不可读目标依赖环境特定行为
// （b-server-file-service.spec.ts:81-88 首轮实测 /etc 形态会反复触发 watcher
// 重建并毒化时序断言，但目标不可读性随执行环境变化）；降级→探试恢复的窗口由
// RetryPolicy（attempts=3、退避 0.5/1/2s、POLL_PROBE_EVERY=5×poll 2s）支配，
// 断言窗口 15s+ 且路径随 notify 内部行为分叉。状态机各分支（运行期错误→
// watch-recovered、降级 PollWatcher 后 changed 仍流动、周期探试回归实时、
// 全程不广播 watch-error）已由 server/src/watch.rs:717-889 的 mock opener 单测
// 覆盖（cargo test 门禁 150 项内）。若需 e2e，须 server 提供故障注入开关后转正。
test.fixme('SRV-06/2: watcher 故障注入→降级后 changed 仍流动→自愈 recovered（BUG-02 验收 3/5）', async () => {
  expect(true).toBe(true);
});

test('SRV-07/2: 刷新模式 manual→auto 回切后 SSE 自动重读恢复', async ({ page }) => {
  test.setTimeout(60_000);
  await connectForm(page, BASE, null);
  await expect(treeRow(page, 'srv-t')).toBeVisible({ timeout: 10_000 });
  await expandRow(page, 'srv-t');
  await treeRow(page, 'manual-toggle.txt').click();
  const pre = page.locator('.vv-code-pre');
  await expect(pre).toContainText('toggle baseline', { timeout: 10_000 });

  // auto → manual：关「自动刷新」（设置面板唯一 checkbox，SettingsPanel.svelte:147）
  await page.locator('button[aria-label="设置"]').click();
  const panel = page.locator('.vv-settings');
  await expect(panel).toBeVisible();
  await panel.locator('.vv-settings-toggle input[type="checkbox"]').uncheck();
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);

  // manual → auto：重开面板，开关状态被记住（未勾选），勾回
  await page.locator('button[aria-label="设置"]').click();
  await expect(panel).toBeVisible();
  const toggle = panel.locator('.vv-settings-toggle input[type="checkbox"]');
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);

  // 回切后 SSE 自动重读恢复：服务端追加 → 3s 内自动出现（500ms debounce + 余量）
  const marker = `auto-restored marker ${Date.now()}`;
  appendFileSync(join(FIXTURE, 'srv-t/manual-toggle.txt'), `${marker}\n`);
  await expect(pre).toContainText(marker, { timeout: 3_000 });
});

test('SRV-10/2: --allow-lan 无 token 拒启报错明确（exit=2 + stderr 指明 --token/--token-gen）', async () => {
  await assertPortFree('http://127.0.0.1:4379');
  const child = spawn(
    BIN,
    [
      'serve', '--root', FIXTURE, '--web-dist', join(repoRoot, 'apps/web/build'),
      '--port', '4379', '--allow-lan'
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  let stderr = '';
  child.stderr!.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const exitCode: number | null = await new Promise((resolve_) => {
    child.on('exit', (code) => resolve_(code));
  });
  expect(exitCode).toBe(2);
  // 报错明确（server/src/main.rs:108）：指认冲突面（--allow-lan）与补救参数（--token/--token-gen）
  expect(stderr).toContain('--allow-lan');
  expect(stderr).toContain('--token');
});

test('SRV-11/2: --hidden 实例浏览器树无 dot 文件、有 visible.txt（UI 对照半）', async ({ page }) => {
  // 跨源连接 --hidden 实例（:4376 带 --cors-origin）
  await connectForm(page, `http://127.0.0.1:${PORT_HIDDEN}`, null);
  await expect(treeRow(page, 'srv-t')).toBeVisible({ timeout: 10_000 });
  await expandRow(page, 'srv-t');
  await expect(treeRow(page, 'visible.txt')).toBeVisible({ timeout: 10_000 });
  await expect(treeRow(page, '.srv-t-dot')).toHaveCount(0);
});

test('SRV-12/2: API 层目录+文件混合清单全序——目录优先 + 自然排序（非字典序）', async () => {
  const res = (await (
    await fetch(`${BASE}/api/tree?path=${encodeURIComponent('srv-t/mixed')}`)
  ).json()) as { entries: Array<{ name: string; kind: string }> };
  // 字典序会把 file10.txt 排在 file2.txt 前；目录 rank 恒在文件前（tree.rs:75-77）
  expect(res.entries.map((e) => e.name)).toEqual([
    'dir-a', 'dir-b', 'file1.txt', 'file2.txt', 'file10.txt'
  ]);
  expect(res.entries.map((e) => e.kind)).toEqual(['dir', 'dir', 'file', 'file', 'file']);
});

test('SRV-12/3: 空格/中文/emoji 特殊文件名 API 列出与树懒加载展开（域文档 4.2 对照件）', async ({
  page
}) => {
  // ① API 层：三件特殊名全部列出（空格/中文/emoji 各一）
  const res = (await (
    await fetch(`${BASE}/api/tree?path=${encodeURIComponent('srv-t/特殊名')}`)
  ).json()) as { entries: Array<{ name: string }> };
  expect([...res.entries.map((e) => e.name)].sort()).toEqual(
    ['emoji😀.txt', '中文·名.txt', '空格 名.txt'].sort()
  );

  // ② 浏览器层：展开后三行可见
  await connectForm(page, BASE, null);
  await expect(treeRow(page, 'srv-t')).toBeVisible({ timeout: 10_000 });
  await expandRow(page, 'srv-t');
  await expandRow(page, '特殊名');
  await expect(treeRow(page, '空格 名.txt')).toBeVisible({ timeout: 10_000 });
  await expect(treeRow(page, 'emoji😀.txt')).toBeVisible();
  await expect(treeRow(page, '中文·名.txt')).toBeVisible();
});

// ── 探索复核确认缺陷回归占位（README §3.2.4：修复合入前 test.fixme 落位，修复 PR 转正） ──
// 来源：服务端文件服务域探索候选缺陷独立复核确认（BUG-45/46/47/48，2026-10-10 轮）。
// 四条根因均定位在 server/src/*（lib.rs CORS 组装、guard.rs/error.rs 错误分类、
// routes/file.rs Range 解析、routes/tree.rs lossy 名），按 README §2 域归属全部留本域
// 文件，无跨域改挂。通道口径：BUG-46/47/48 走主实例 :4174 API 层直接复现（fetch）；
// BUG-45 需独立短命实例（--cors-origin '*'），用例内起停（SRV-10/2 前例，端口 4381/
// 4382 与既有 4375-4377/4379 错开）。标题以缺陷库编号开头、[探索] 标注来源；各用例
// 注释给出最小复现步骤、证据路径与源码定位。

test.fixme("BUG-45 [探索]: --cors-origin '*' 启动即 panic（exit 101）——'*' 过 from_str 校验后直传 AllowOrigin::list 触发 tower-http 库内 panic", async () => {
  // 复核确认（校准 medium）：启动即崩溃，但触发面是单一可选参数值、立即响亮失败、
  // 无数据丢失，精确 origin 用法一切正常，替换解法 trivial。build_router 在 bind 前
  // 急切执行，'*' 作为合法 header 值通过校验后原样传入 tower-http：
  //   server/src/lib.rs:131-137（HeaderValue::from_str(o).ok() → AllowOrigin::list([origin])）
  //   + server/src/main.rs:149（build_router 先行）+ main.rs:166（bind 在后）
  //   → panic 先于任何配置错误处理。违背项目自身约定：main.rs:92「启动服务；
  //   配置错误返回 exit code（不 panic）」。docs/deploy.md:40 仅提示「填精确 origin」，
  //   未显式排除通配值。对照 SRV-10 已裁决形态：--allow-lan 无 token → 干净 exit=2。
  // 最小复现（探索复核轮 8432/8433 两端口独立复现，独立数据根 .temp/explore/srv/data）：
  //   server/target/release/vviewer serve --root <任一目录> --web-dist apps/web/build \
  //     --port <空闲端口> --cors-origin '*' ; echo $?   → 101
  //   thread 'main' panicked at tower-http-0.7.1/src/cors/allow_origin.rs:61:13:
  //   Wildcard origin (`*`) cannot be passed to `AllowOrigin::list`. Use
  //   `AllowOrigin::any()` instead；事后 curl /api/health 连接拒绝、ss 无监听。
  // 证据（复核轮独立取得，非采信上报）：/tmp/vv-review-srv-e1/8441.log（panic 栈 +
  //   exit 101）；8442.log（对照 A：--allow-lan 无 token → exit=2 明确报错）；正对照
  //   --cors-origin 'http://127.0.0.1:4199' 于 8443 正常启动、带 Origin 请求正确回显
  //   access-control-allow-origin——panic 特异于 '*'。
  // 修复判据（按 main.rs:92 约定 + SRV-10/2 前例取「配置错误 exit=2 + 明确报错」形态；
  //   若改走 AllowOrigin::any() 支持通配，则转正时改断言启动成功 + ACAO 回显 '*'）：
  //   ① '*' 实例 exit=2（不得 panic/101），stderr 指认 --cors-origin（文案以修复 PR 为准）；
  //   ② 正对照：精确 origin 同法启动 health 200（修复不回退既有 CORS 精确回显路径）。
  const spawnCors = (port: number, origin: string): ChildProcess =>
    spawn(
      BIN,
      [
        'serve', '--root', FIXTURE, '--web-dist', join(repoRoot, 'apps/web/build'),
        '--port', String(port), '--cors-origin', origin
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
  const exitWith = async (
    child: ChildProcess
  ): Promise<{ code: number | null; stderr: string }> => {
    let stderr = '';
    child.stderr!.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const code = await new Promise<number | null>((resolve_) => {
      child.on('exit', (c) => resolve_(c));
    });
    return { code, stderr };
  };

  // ① '*' → 配置错误形态退出（修复后不得再是 panic 101）
  await assertPortFree('http://127.0.0.1:4381');
  const bad = await exitWith(spawnCors(4381, '*'));
  expect(bad.code).toBe(2);
  expect(bad.stderr).toContain('--cors-origin');
  expect(bad.stderr).toContain('*');

  // ② 正对照：精确 origin 正常启动（panic 特异于 '*'，修复不回退）
  await assertPortFree('http://127.0.0.1:4382');
  const ok = spawnCors(4382, PAGE_ORIGIN);
  try {
    await waitHealthy('http://127.0.0.1:4382');
  } finally {
    await stopServer(ok, 'srv-t-bug45-ok');
  }
});

test.fixme('BUG-46 [探索]: 三类奇异路径——NUL 字节、root 内自环 symlink、超长文件名——/api/file 与 /api/tree 归 500 而非 4xx', async () => {
  // 复核确认（medium）：调用方可构造的病态输入被标成服务器内部故障（附 errno 文本），
  // 误导监控与重试语义；服务不崩溃、错误文本无路径泄露。
  // 根因：server/src/guard.rs:34-37——canonicalize 失败仅 NotFound→404，其余一律
  //   AppError::internal；server/src/error.rs:32-34（internal→500）；调用点
  //   server/src/routes/file.rs:187、server/src/routes/tree.rs:44。
  // 最小复现（自起实例 :8440；基线 /api/file?path=base.txt 先行 200）：
  //   ① curl '/api/file?path=base.txt%00' → 500 {"error":"file name contained an
  //      unexpected NUL byte"}（变体 base.txt%2e%2e%00.png 同 500）；
  //   ② 数据根内 ln -s loop-self loop-self 后 /api/file?path=loop-self → 500
  //      {"error":"Too many levels of symbolic links (os error 40)"}；
  //   ③ /api/file?path=<5000 个 a> → 500 {"error":"File name too long (os error 36)"}；
  //   ④ /api/tree?path=%00 → 500 同 NUL 文本。
  //   对照：/api/file?path=../x → 400（清洗层正常，错位仅在 canonicalize 错误分支）；
  //   异常请求后再发基线仍 200，服务未崩溃。
  // 证据（复核轮独立取得）：/tmp/cand-srv-e2/ 实例记录；
  //   .temp/e2e-artifacts/explore-srv/probe-srv-out.json id=7/8/15/61（status 均 500）。
  // 修复判据：三处均归 4xx 客户端错误（NUL/超长名→400 一类；ELOOP→404/409 等 4xx，
  //   具体码转正时按修复实现定）；基线 200 与 ../x→400 护栏不回退。
  // 夹具：自环 symlink 落独立子目录（tree 对不可 stat 条目跳过，tree.rs:56-60，
  //   不污染既有清单断言）；NUL 与超长名均为请求侧构造，无需磁盘夹具。
  const { symlinkSync } = await import('node:fs');
  const loopDir = join(FIXTURE, 'srv-t/bug46-loop');
  mkdirSync(loopDir, { recursive: true });
  try {
    symlinkSync('loop-self', join(loopDir, 'loop-self')); // 幂等：复跑已存在
  } catch {
    // 已存在则跳过
  }

  // ① NUL 字节（附加在既有文件名后，证明错误来自 NUL 而非 NotFound）
  const nul = await fetch(`${BASE}/api/file?path=${encodeURIComponent('srv-t/cors-lang.js')}%00`);
  expect(nul.status).toBeGreaterThanOrEqual(400);
  expect(nul.status).toBeLessThan(500);

  // ② root 内自环 symlink（ELOOP）
  const loop = await fetch(
    `${BASE}/api/file?path=${encodeURIComponent('srv-t/bug46-loop/loop-self')}`
  );
  expect(loop.status).toBeGreaterThanOrEqual(400);
  expect(loop.status).toBeLessThan(500);

  // ③ 超长文件名（ENAMETOOLONG）
  const tooLong = await fetch(`${BASE}/api/file?path=${'a'.repeat(5000)}`);
  expect(tooLong.status).toBeGreaterThanOrEqual(400);
  expect(tooLong.status).toBeLessThan(500);

  // ④ /api/tree 同样按 4xx 归类（NUL 变体）
  const treeNul = await fetch(`${BASE}/api/tree?path=%00`);
  expect(treeNul.status).toBeGreaterThanOrEqual(400);
  expect(treeNul.status).toBeLessThan(500);

  // 护栏：基线 200、路径穿越 400 不回退（异常请求后服务存活）
  const baseOk = await fetch(`${BASE}/api/file?path=${encodeURIComponent('srv-t/cors-lang.js')}`);
  expect(baseOk.status).toBe(200);
  const traversal = await fetch(`${BASE}/api/file?path=${encodeURIComponent('srv-t/../x')}`);
  expect(traversal.status).toBe(400);
});

test.fixme('BUG-47 [探索]: 多区间 Range 静默丢弃第二区间（单区间 206 非 multipart/200 全量）、If-Range 完全被忽略（不匹配仍 206）', async () => {
  // 复核确认（维持 low）：非崩溃/数据丢失，vviewer 前端不使用多区间 Range 与
  // If-Range，服务器也不下发 ETag/Last-Modified（验证器缺失时第三方按 RFC 本不应
  // 使用 If-Range），影响面仅限依赖这两特性的第三方客户端。
  // 根因：server/src/routes/file.rs:33 `spec.split(',').next()` 取第一区间后丢弃其余；
  //   file.rs:201-209 仅读取 header::RANGE，全函数无 IF_RANGE 分支；file.rs:222-237
  //   响应头只设 CONTENT_TYPE/ACCEPT_RANGES/CONTENT_LENGTH/X_VV_*/CONTENT_RANGE，
  //   无 ETag/Last-Modified。
  // 最小复现（自起实例 :8440，fixture 256B 文件 range.bin 字节值=偏移）：
  //   ① curl -H 'Range: bytes=0-1,3-4' → 206、content-range: bytes 0-1/256、
  //      content-length: 2、content-type: application/octet-stream（非
  //      multipart/byteranges，也不按 RFC 9110 §15.3.7.2 回 200 全量）；换
  //      bytes=100-105,200-205 同形（body 'defghi'）——第二区间被静默丢弃且无错误信号；
  //   ② Range: bytes=0-9 + If-Range: "etag-xyz" → 206 bytes 0-9/256；If-Range 改
  //      HTTP-date 形态 'Wed, 01 Jan 2025 00:00:00 GMT' + bytes=0-0 同样仍 206
  //      （RFC 9110 §13.1.5：条件不满足应忽略 Range 回 200 全量）。
  //   对照：单区间矩阵 20 条（单区间/后缀/0-0/越界钳制/start==size/倒挂/-0/空文件/
  //   u64 溢出/HEAD/内容字节校验）全部符合 RFC；全量 GET 响应头确无 etag/last-modified
  //   （非普遍 Range 破坏，仅这两处边界）。
  // 证据（复核轮独立取得）：/tmp/vv-e3/ 实例与 curl 记录（body hex 0001、6465 6667
  //   6869、fcfd feff 逐字核对）。
  // 修复判据：① 多区间要么 200 全量 256B，要么 206 multipart/byteranges 覆盖全部
  //   区间（不得再是单区间 octet-stream 206）；② 不匹配 If-Range（etag 与 date 两
  //   形态）均忽略 Range 回 200 全量；单区间/后缀护栏不回退。
  const rangeBin = join(FIXTURE, 'srv-t/bug47-range.bin');
  writeFileSync(rangeBin, Buffer.from(Array.from({ length: 256 }, (_, i) => i)));
  const url = `${BASE}/api/file?path=${encodeURIComponent('srv-t/bug47-range.bin')}`;

  // ① 多区间：第二区间不得被静默丢弃（两条 RFC 9110 §15.3.7.2 合规形态二选一）
  const multi = await fetch(url, { headers: { Range: 'bytes=0-1,3-4' } });
  if (multi.status === 206) {
    expect(multi.headers.get('content-type')).toContain('multipart/byteranges');
    const body = Buffer.from(await multi.arrayBuffer());
    expect(body.length).toBeGreaterThanOrEqual(6); // 两区间合计 2+4 字节（另加边界开销）
  } else {
    expect(multi.status).toBe(200);
    expect(Buffer.from(await multi.arrayBuffer()).length).toBe(256);
  }

  // ② If-Range 不匹配（etag 形态）→ 忽略 Range 回 200 全量
  const ifRangeEtag = await fetch(url, {
    headers: { Range: 'bytes=0-9', 'If-Range': '"etag-xyz"' }
  });
  expect(ifRangeEtag.status).toBe(200);
  expect(Buffer.from(await ifRangeEtag.arrayBuffer()).length).toBe(256);

  // If-Range 不匹配（HTTP-date 形态）同样忽略 Range
  const ifRangeDate = await fetch(url, {
    headers: { Range: 'bytes=0-0', 'If-Range': 'Wed, 01 Jan 2025 00:00:00 GMT' }
  });
  expect(ifRangeDate.status).toBe(200);
  expect(Buffer.from(await ifRangeDate.arrayBuffer()).length).toBe(256);

  // 护栏：单区间后缀语义不回退（现正常）
  const suffix = await fetch(url, { headers: { Range: 'bytes=-4' } });
  expect(suffix.status).toBe(206);
  expect(suffix.headers.get('content-range')).toBe('bytes 252-255/256');
});

test.fixme('BUG-48 [探索]: 非 UTF-8 文件名经 /api/tree 列出（U+FFFD 替换）后任何 HTTP 路径名均不可寻址（恒 404）', async () => {
  // 复核确认（维持 low）：边界场景缺口——文件在磁盘上完好可读、正常名（空格/中文等）
  // 不受影响，但该文件一旦被服务端列出便无法通过任何 HTTP 路径名寻址，树中呈现为乱码名。
  // 根因：server/src/routes/tree.rs:53 `e.file_name().to_string_lossy().into_owned()`
  //   把磁盘非法 UTF-8 字节（如 ff fe）替换为 U+FFFD（ef bf bd）；/api/file 按 String
  //   path 走 guard::resolve→canonicalize（guard.rs:31-44、调用点 file.rs:187），
  //   替换名与磁盘真实字节不匹配恒 404；原始字节 percent-encoded（%FF%FE）请求同样
  //   404（axum Query 的 String 反序列化无法还原非法 UTF-8）——不存在可寻址的编码形式。
  // 最小复现（数据根内构造 + 自起实例 :8441，health OK）：
  //   printf 'nonutf8\n' > "$(printf 'bad\xff\xfename.txt')"（磁盘字节 od 确认
  //   62 61 64 ff fe 6e 61 6d 65 2e 74 78 74）
  //   ① /api/tree?path=. → name 为 bad\uFFFD\uFFFDname.txt（列出字节 ef bf bd ef bf bd）；
  //   ② /api/file?path=bad%EF%BF%BD%EF%BF%BDname.txt → 404 {"error":"path not found"}；
  //   ③ /api/file?path=bad%FF%FEname.txt（原始非法字节）→ 同样 404。
  //   对照：ok.txt → 200 内容 "hello"（正常名不受影响）。
  // 证据（复核轮独立取得）：/tmp/cand-srv-e4/ 实例记录（od + curl 逐字核对，复测后
  //   实例已清、端口释放）；.temp/e2e-artifacts/explore-srv/probe-srv-out.json id=53
  //   （%FF 单字节对照 404）。
  // 修复判据：tree 列出的非 UTF-8 名经 API 必须可寻址（列出⇒可取回；具体编码形态——
  //   percent-encode 非 UTF-8 字节或 lossy 名可反查——转正时按修复实现定）；正常名
  //   护栏不回退。夹具：Node Buffer 路径写原始字节名（本会话已验证落盘 62 61 64
  //   ff fe ...），落独立子目录避免污染既有清单断言。
  const bug48Dir = join(FIXTURE, 'srv-t/bug48-nonutf8');
  mkdirSync(bug48Dir, { recursive: true });
  const rawName = Buffer.from('bad\xff\xfename.txt', 'latin1'); // 62 61 64 ff fe 6e ...
  writeFileSync(Buffer.concat([Buffer.from(`${bug48Dir}/`, 'utf8'), rawName]), 'nonutf8\n');

  // ① tree 列出该文件（现名含 U+FFFD；修复后为可寻址的编码形态）
  const tree = (await (
    await fetch(`${BASE}/api/tree?path=${encodeURIComponent('srv-t/bug48-nonutf8')}`)
  ).json()) as { entries: Array<{ name: string; kind: string }> };
  const hit = tree.entries.find((e) => /bad.*name\.txt/u.test(e.name));
  expect(hit).toBeDefined();
  expect(hit!.kind).toBe('file');

  // ② 列出的名字必须可经 /api/file 寻址（现状任何编码形式恒 404）
  const fetched = await fetch(
    `${BASE}/api/file?path=${encodeURIComponent(`srv-t/bug48-nonutf8/${hit!.name}`)}`
  );
  expect(fetched.status).toBe(200);
  expect(await fetched.text()).toBe('nonutf8\n');

  // 护栏：正常名不受影响（对照形态）
  const okFile = await fetch(`${BASE}/api/file?path=${encodeURIComponent('srv-t/cors-lang.js')}`);
  expect(okFile.status).toBe(200);
});
