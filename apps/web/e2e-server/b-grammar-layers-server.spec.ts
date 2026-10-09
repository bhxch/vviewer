import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, type Page } from '@playwright/test';
import { stopServer, waitHealthy } from '../e2e/serverHarness';

/**
 * b-grammar-layers-server E2E（P2 资产三层解析链 · 服务端层冒烟，spec §3/§7.2）。
 * 与 e2e/b-grammar-layers.spec.ts（同源/CDN 两层，page.route mock）互补，本 spec
 * 验证服务端层的端到端行为——全程真实服务，零 route mock、不屏蔽 SW：
 *
 * 拓扑 = 简报的部署组合「Pages 纯静态托管 + 远程 vviewer 服务器」：
 * - 页面源 :4180 = vite preview 伺服 apps/web/build（纯 web，无任何 vviewer 服务端）；
 * - 服务端 :4181 = release 二进制（--web-dist 同一 build，故其 /grammars/ 为 lite
 *   manifest），--cors-origin 精确指向页面源。
 * 端口偏离简报字面的 :4174：:4174 是 playwright.server.config.ts 的 webServer 主
 * 实例，未配 --cors-origin，跨源 manifest fetch 会被 CORS 拦截（层被跳过），无法
 * 断言「层命中」；按 b-compute-*.spec.ts 的辅助实例惯例由本 spec 自起带 CORS 的
 * 实例（beforeAll 幂等，重试安全）。
 *
 * 快照键与形状（前置核对修正简报笔误）：core SESSION_LAST_SERVER_KEY =
 * 'vviewer-last-server'、值 {baseUrl, token}，存储为 **sessionStorage** 而非
 * localStorage（写入侧 openFlow.svelte.ts connectServer、读取侧 loadLastServer、
 * 跨包契约测试 treeRemote.test.ts 三处锚定）。addInitScript 预写 = 模拟「本会话
 * 曾连接过该服务器」；服务端层为连接时快照（create() 启动时读一次），会话内新
 * 连接不进入资产链——该语义由用例 2 反向锚定（无快照 ⇒ 零服务端请求）。
 *
 * 合并口径（简报 fallback 断言）：两实例伺服同一 build，服务端层与同源层同为
 * lite 集——first-wins 下合并表 = lite ∪ lite = 同源表不变。行为断言 = js 高亮
 * 不变 + grammar wasm 零跨源（若合并被服务端层覆写，条目 base 指向 :4181，
 * wasm 将从服务端层取，该断言即暴露）。
 *
 * 同源 manifest 回放（对齐 e2e/b-grammar-layers.spec.ts 的 mock 惯例）：同源层
 * manifest 以真实字节（page.request 取自 :4180 后 route.fulfill 原样回放）交付，
 * CDN 层 abort 快速失败；被测的服务端层不经任何 mock，全程真实网络 + CORS。
 * 原因：本环境实测（chromium，vite preview 与 release 二进制伺服均复现），应用在
 * 页面加载期创建的 tree-sitter worker 其 Parser.init 在「同源 manifest 经真实网络
 * 交付」或「真实 cdn.grammars.test fetch 与完整合并表并存」时确定性挂起（15s
 * 看门狗兜底 hljs）——同字节回放 / abort 即恢复、独立延迟创建的 worker 探针正常，
 * 属与资产链语义无关的底层传输问题，非本任务引入（b-grammar-layers 以 mock 规避
 * 同因；其行为归该 spec 与 fix-pwa.spec）。
 * serviceWorkers: 'block' 同 b-grammar-layers：route 拦不到经 SW 放行的请求，
 * 屏蔽求确定性（SW 行为归 fix-pwa.spec）。
 */
test.use({ serviceWorkers: 'block' });

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const BIN = join(repoRoot, 'server/target/release/vviewer');
const FIXTURE = process.env.VV_E2E_SERVER_FIXTURE ?? join(repoRoot, '.temp/e2e-server-fixture');
const WEB_DIST = join(repoRoot, 'apps/web/build');
const VITE_BIN = join(repoRoot, 'apps/web/node_modules/.bin/vite');

const PAGE_BASE = 'http://127.0.0.1:4180';
const SERVER_BASE = 'http://127.0.0.1:4181';
const SERVER_MANIFEST = `${SERVER_BASE}/grammars/manifest.json`;
/** core SESSION_LAST_SERVER_KEY（写入侧 openFlow.svelte.ts / 读取侧 loadLastServer 同源） */
const LAST_SERVER_KEY = 'vviewer-last-server';

/** 用例载入的 .js 文件内容（短小、语法特征明确：tree-sitter 可识别） */
const JS_SRC = [
  '// e2e-server grammar-layers smoke fixture',
  'export function greet(name) {',
  '  return `hello, ${name}`;',
  '}',
  '',
  "greet('vviewer');"
].join('\n');

let preview: ChildProcess | null = null;
let server: ChildProcess | null = null;

/** vite preview 就绪轮询（GET / 200 即就绪；strictPort 占口时进程提前退出 fail-fast） */
async function ensurePreview(): Promise<void> {
  try {
    if ((await fetch(`${PAGE_BASE}/`)).ok) return;
  } catch {
    // 端口空闲
  }
  preview = spawn(VITE_BIN, ['preview', '--host', '127.0.0.1', '--port', '4180', '--strictPort'], {
    cwd: join(repoRoot, 'apps/web'),
    stdio: ['ignore', 'inherit', 'inherit']
  });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (preview.exitCode !== null) {
      throw new Error(`vite preview 提前退出 code=${preview.exitCode}（端口被占用或 build 缺失）`);
    }
    try {
      if ((await fetch(`${PAGE_BASE}/`)).ok) return;
    } catch {
      // 尚未就绪
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('vite preview 未在 30s 内就绪');
}

/** release 二进制辅助实例（--cors-origin 指页面源；幂等，重试安全复用） */
async function ensureServer(): Promise<void> {
  try {
    if ((await fetch(`${SERVER_BASE}/api/health`)).ok) return;
  } catch {
    // 端口空闲
  }
  server = spawn(
    BIN,
    [
      'serve', '--root', FIXTURE, '--web-dist', WEB_DIST,
      '--port', '4181', '--cors-origin', PAGE_BASE
    ],
    { stdio: ['ignore', 'inherit', 'inherit'] }
  );
  await waitHealthy(SERVER_BASE);
}

test.beforeAll(async () => {
  await ensurePreview();
  await ensureServer();
});

test.afterAll(async () => {
  await stopServer(preview, 'bgls-vite');
  await stopServer(server, 'bgls-server');
});

/** 预写连接时快照（sessionStorage；base=null 即不写，覆盖「未连接过服务器」场景） */
function presetLastServer(page: Page, base: string | null): void {
  if (base === null) return;
  void page.addInitScript(
    ({ key, value }) => {
      sessionStorage.setItem(key, value);
    },
    { key: LAST_SERVER_KEY, value: JSON.stringify({ baseUrl: base, token: null }) }
  );
}

/**
 * 同源 manifest 以真实字节回放（缘由见文件头「同源 manifest 回放」）：page.request
 * 取页面源的真实 manifest（完整 lite 语言表），route.fulfill 原样交付；负向前瞻
 * 排除被测的服务端源（:4181 真实网络 + CORS）。CDN 层显式 abort（对齐
 * b-grammar-layers 用例 2 的「CDN 不可达」mock）：本 spec 的被测对象是服务端层，
 * CDN 跳层语义归 e2e/b-grammar-layers.spec.ts，这里只需其快速、确定性失败——
 * 实测真实 cdn.grammars.test fetch（ERR_CONNECTION_CLOSED ~0.6s）与完整合并表
 * 并存时同侧 worker 稳定挂起（见文件头），abort 消除该环境噪音。
 */
async function replayOriginManifest(page: Page): Promise<void> {
  const res = await page.request.get(`${PAGE_BASE}/grammars/manifest.json`);
  expect(res.ok()).toBeTruthy();
  const body = await res.body();
  await page.route(/\/\/(?!127\.0\.0\.1:4181).*\/grammars\/manifest\.json$/, (route) => {
    const url = route.request().url();
    if (url.includes('cdn.grammars.test')) return route.abort();
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body
    });
  });
}

interface FilePayload {
  name: string;
  type: string;
  content: string;
}

/** 纯 web 通道（同 e2e/b-grammar-layers.spec.ts）：__vvOpenDirImpl 注入本地 File */
async function openDir(page: Page, payloads: FilePayload[]): Promise<void> {
  await page.waitForFunction(
    () => typeof (window as unknown as { __vvOpenDirImpl?: unknown }).__vvOpenDirImpl === 'function'
  );
  await page.evaluate((payloads) => {
    const files = payloads.map(({ name, type, content }) => {
      const f = new File([content], name, { type });
      Object.defineProperty(f, 'webkitRelativePath', { value: `bgls/${name}` });
      return f;
    });
    return (window as unknown as { __vvOpenDirImpl: (f: File[]) => void }).__vvOpenDirImpl(files);
  }, payloads);
}

async function openFile(page: Page, name: string): Promise<void> {
  await page.locator('.vv-tree-row', { hasText: name }).first().click();
  await expect(page.locator('.vv-tab.active', { hasText: name })).toBeVisible({ timeout: 10_000 });
}

test('服务端层冒烟：启动期跨源 manifest 请求且命中，js 高亮不变、wasm 零跨源（first-wins）', async ({
  page
}) => {
  test.setTimeout(120_000);
  const serverManifestResponses: number[] = [];
  const serverWasmRequests: string[] = [];
  const layerSkips: string[] = [];
  const pageErrors: string[] = [];
  page.on('request', (r) => {
    if (r.url().startsWith(`${SERVER_BASE}/`) && r.url().endsWith('.wasm')) {
      serverWasmRequests.push(r.url());
    }
  });
  page.on('response', (r) => {
    if (r.url() === SERVER_MANIFEST) serverManifestResponses.push(r.status());
  });
  page.on('console', (msg) => {
    if (msg.type() === 'warning' && msg.text().includes('跳过该资产层')) layerSkips.push(msg.text());
  });
  page.on('pageerror', (err) => pageErrors.push(String(err)));

  presetLastServer(page, SERVER_BASE);
  await replayOriginManifest(page);
  await page.goto(`${PAGE_BASE}/`);

  // ① 启动期（未打开任何文件，create() 随首屏预热跑资产链）即向服务端层发起
  //    manifest 请求且 HTTP 200；且无针对该 URL 的跳层 warn——网络层 200 之外
  //    还须 CORS 放行 fetch 才不算「加载失败」，二者合计才是「层命中」的完整证据
  await expect
    .poll(() => serverManifestResponses, {
      timeout: 30_000,
      message: '等待启动期服务端层 manifest 请求（连接时快照 → <serverBase>/grammars/manifest.json）'
    })
    .toContain(200);
  expect(
    layerSkips.filter((t) => t.includes(SERVER_MANIFEST)),
    '服务端 manifest 不得出现跳层 warn（200 + CORS 放行 = 层被合并消费）'
  ).toEqual([]);

  // ② 同源语言高亮行为不变：js 仍 tree-sitter 正常高亮（服务端层同为 lite 集，
  //    first-wins 下合并表 = lite ∪ lite，结果与未连接时一致）
  await openDir(page, [{ name: 'bgls-hello.js', type: 'text/javascript', content: JS_SRC }]);
  await openFile(page, 'bgls-hello.js');
  await expect(page.locator('.vv-statusbar')).toContainText('高亮: tree-sitter', { timeout: 60_000 });
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const dbg = window as unknown as { __vvLastHighlightOk?: boolean; __vvLastHighlightLang?: string };
          return { ok: dbg.__vvLastHighlightOk, lang: dbg.__vvLastHighlightLang };
        }),
      { timeout: 30_000, message: '等待 js 高亮成功落定' }
    )
    .toEqual({ ok: true, lang: 'javascript' });

  // ③ first-wins 来源层锚定：js 条目归同源层（更近来源），grammar wasm 不得从
  //    服务端层取——合并若被服务端层覆写，条目 base 指向 :4181，此处即非空
  expect(serverWasmRequests).toEqual([]);
  expect(pageErrors).toEqual([]);
  await expect(page.locator('.vv-error-card')).toHaveCount(0);
});

test('无连接快照（纯 web 未连服务器）：启动零服务端请求，同源高亮照常', async ({ page }) => {
  test.setTimeout(120_000);
  const serverRequests: string[] = [];
  page.on('request', (r) => {
    if (r.url().startsWith(`${SERVER_BASE}/`)) serverRequests.push(r.url());
  });

  // 不预写快照：服务端层整体缺席（连接时快照语义的反向锚定——服务端层不是
  // 无条件发起，而只由会话内「曾连接」的快照驱动）
  await replayOriginManifest(page);
  await page.goto(`${PAGE_BASE}/`);
  await openDir(page, [{ name: 'bgls-hello.js', type: 'text/javascript', content: JS_SRC }]);
  await openFile(page, 'bgls-hello.js');
  await expect(page.locator('.vv-statusbar')).toContainText('高亮: tree-sitter', { timeout: 60_000 });

  // 高亮落定 ⇒ create()（含全部资产层 fetch，先于 worker grammar 加载完成）已结束，
  // 此刻断言零服务端请求无时序漏洞
  expect(serverRequests).toEqual([]);
});
