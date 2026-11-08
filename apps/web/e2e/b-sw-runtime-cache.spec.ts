import { test, expect, type Page } from '@playwright/test';
import { createServer } from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';

/**
 * b-sw-runtime-cache —— SW 运行时缓存路由域（SWR-ROUTE-01~07 / SWR-TABLE-01~02 /
 * SWR-MIRROR-01 / SWR-EXP-01 / SWR-CLEAN-01~02）。
 *
 * 覆盖对象：apps/web/vite.config.ts 的 workbox `runtimeCaching` 路由表（先匹配先赢，
 * 数组顺序即优先级）与 `genSwCleanup` 跨版本清理脚本（构建期生成 static/vv-sw-cleanup.js
 * → 烘焙进产物 apps/web/build/vv-sw-cleanup.js）。
 *
 * 装置（自建在本文件内——本域 e2e 铁律：装置自建、不抽公共 helper，避免域间文件冲突；
 * 允许的既有 helper 只读引用白名单为 ./b-markdown-html-docs-helpers、./drawer、
 * ./settings-center、./helpers，均不含本域所需的「伺服构建产物 + 合成探针 + 产物内
 * REV 改写」装置。serverHarness.ts 是 m5/m6 的 Rust 进程 harness（cargo build + spawn
 * vviewer 二进制 + /api/health 轮询），它伺服的是文件服务根目录而非构建产物目录，
 * 且未知路径走 server/src/lib.rs `serve_index` 的 SPA fallback（SWR-DEF-01 收窄后仅
 * 导航请求回 index.html，fetch 形态一律 404），无法提供本域需要的「指定路径精确
 * 200/404 应答」合成面，故本域自建静态伺服面）：
 * - 假静态服务器：node:http 伺服 apps/web/build 产物 + 合成探针路径（200/404 合成
 *   应答，含修复后服务端契约——非导航 fetch 的未知资产 404），记录每路径命中次数
 *   （用于「二次访问不再回源」的 CacheFirst 判定）。端口取临时端口（listen(0)），
 *   不与 playwright webServer 的 4173 冲突。
 * - SW 控制权：走产品自身的注册通道（src/routes/+layout.svelte:13 registerSW），等
 *   activated + controller 在位 + precache 填充后开始断言。
 * - 换版模拟：伺服面把 sw.js / vv-sw-cleanup.js 内的 BUILD_REVISION 全量替换后再交付
 *   （真实换版时这两个产物随部署同步换新），配合 reload 即「部署换版」（同 BUG-60 锚手法）。
 *
 * 断言纪律：
 * - SW 缓存一律用 caches API 断言（page.route 对经 SW 的请求恒为 0——请求由 SW 的
 *   fetch 事件发起，不进页面网络栈）。
 * - 不写死注册面数量；路由归属用「族前缀 + 恰好一个持有者」表达。
 * - 产物层断言（路由表 / 清理正则）读 apps/web/build 产物——CI 在 e2e 前跑
 *   `pnpm --filter web build`（.github/workflows/ci.yml:163），产物为当次构建。
 *
 * 真实产品缺陷已修、锚转正式断言（docs/e2e/README.md §3.2 第 4 条口径）：
 * - SWR-CLEAN-01 / SWR-CLEAN-02：genSwCleanup 的 current 清单含 vv-worker-wasm
 *   （vite.config.ts:130），但 activate 里的删除正则曾漏了该族（vite.config.ts:148
 *   的 /^(vv-grammars|vv-runtime|vv-queries|vv-diagram-svgbob|vv-cdn-engines|
 *   vv-foreign-assets)-/）→ 旧 REV 的 vv-worker-wasm-* 缓存永久残留（BUG-60 的缓存
 *   卫生不变量在残余 A7 路由上失效）。**已修**：删除正则补入 vv-worker-wasm 族，
 *   两条锚由 test.fixme 转正式断言（断言原文未弱化）。
 * - SWR-ROUTE-07（SWR-DEF-01）：真实后端曾对未知且非 .scm/.wasm 的路径返回 200 +
 *   index.html（server/src/lib.rs SPA fallback），被 /file-viewer-assets/ 路由的
 *   cacheableResponse{statuses:[200]}（vite.config.ts:777-784）收进 vv-foreign-assets
 *   缓存。**已修（服务端 Accept 收窄）**：serve_index 只对导航请求（Accept 含
 *   text/html）回 index.html，其余（fetch/XHR 的通配 Accept、资源加载、缺头）一律 404——
 *   cacheableResponse 只拦非 200，SPA fallback 的 200 HTML 由服务端 Accept 收窄治理
 *   （SW 层无法按 content-type 过滤：generateSW 不支持自定义 cacheWillUpdate plugin）。
 *   本锚转正式断言（断言面改为修复后契约：未知资产 fetch 得 404、零缓存条目），
 *   服务端契约由 cargo 集成锚（server/tests/health.rs spa_fallback_gated_on_navigation_accept）
 *   守住；本域自建伺服面同步改为修复后契约（swr-spa.js → 404）。
 *
 * 旁证（SWR-EXP-01 反面）：workbox 的 runtimeCaching 配了 expiration 选项即由
 * workbox-build 自动注入 ExpirationPlugin，族内条目数受 maxEntries 压制、LRU 逐出
 * 可实证——故该锚为正式断言，不占位。
 *
 * 与既有锚的边界（详见 docs/e2e/sw-runtime-cache.md §2.3）：
 * - BUG-60 锚（t-pwa.spec.ts:736-881）拥有「grammars/runtime/queries 三族换版清理」；
 *   本域 SWR-CLEAN-01 只钉新增族 vv-worker-wasm 的同机制表现，控制组仅保留一条
 *   「清理动作确实执行过」的最小判据（排除「清理整体没跑」的另一种解释）。
 * - PWA-03/fix-pwa 锚拥有「打开语言文件后某族缓存被创建」；本域 SWR-ROUTE-04 钉的是
 *   「URL → 缓存族的唯一归属」映射口径（含既有锚零覆盖的 svgbob 族）。
 * - check-pwa-build.mjs:67-77 拥有「cacheName 族存在」；foreignAssets.test.ts:126-139
 *   拥有「源码文本序」；本域 SWR-TABLE-01 拥有「产物层按 workbox 匹配语义解析首个命中
 *   路由」的运行语义面（含 method / statuses / 过期配额）。
 */

/** 构建产物目录（apps/web/build）——SW 产物与运行时缓存路由的来源 */
const BUILD_DIR = fileURLToPath(new URL('../build', import.meta.url));

/** 合成 wasm 字节（最小 wasm 头，路由判定不消费内容） */
const WASM_BYTES = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

interface Synthetic {
  status: number;
  type: string;
  body: Buffer;
}

/**
 * 合成探针路径（仅本域装置）：命中 SW 运行时路由的 URL 形态，服务端自造应答，
 * 避免依赖外网与真实资产内容。404 探针专测 cacheableResponse 只收 200——
 * swr-missing.wasm 是通用 404 形态；swr-spa.js 模拟**修复后**的服务端契约
 * （SWR-DEF-01：server/src/lib.rs `serve_index` 的 SPA fallback 收窄为只对导航
 * 请求生效——Accept 含 text/html 才回 index.html，非导航 fetch 的未知资产路径
 * 一律 404。缺陷态曾回 200 HTML 被 vv-foreign-assets 缓存，历史见
 * docs/e2e/sw-runtime-cache.md §3.2）。vv-runtime 族探针
 * （/yN/libarchive/libarchive.wasm 与 /zN/tree-sitter.wasm）用于 LRU 逐出场景——
 * tree-sitter 与 libarchive 两条路由共用 vv-runtime-<REV>，同族条目互相挤占
 * 同一份 maxEntries 配额。
 */
const SYNTHETIC: Record<string, Synthetic> = {
  '/grammars/swr-probe.wasm': { status: 200, type: 'application/wasm', body: WASM_BYTES },
  '/queries/swr-probe/highlight.scm': { status: 200, type: 'text/plain', body: Buffer.from('(comment)\n') },
  '/_app/immutable/assets/svgbob_wasm_bg.swrprobe.wasm': {
    status: 200,
    type: 'application/wasm',
    body: WASM_BYTES
  },
  '/_app/immutable/workers/assets/swr-probe.wasm': {
    status: 200,
    type: 'application/wasm',
    body: WASM_BYTES
  },
  '/file-viewer-assets/swr-probe.wasm': { status: 200, type: 'application/wasm', body: WASM_BYTES },
  '/file-viewer-assets/swr-missing.wasm': {
    status: 404,
    type: 'text/plain',
    body: Buffer.from('not deployed\n')
  },
  // 修复后服务端契约（SWR-DEF-01，server/src/lib.rs serve_index Accept 收窄）：
  // 非导航 fetch 的未知资产路径 404——原缺陷态为 200 + text/html（SPA fallback），
  // 曾被 vv-foreign-assets 缓存收留
  '/file-viewer-assets/swr-spa.js': {
    status: 404,
    type: 'text/plain',
    body: Buffer.from('not deployed\n')
  },
  '/y1/libarchive/libarchive.wasm': { status: 200, type: 'application/wasm', body: WASM_BYTES },
  '/y2/libarchive/libarchive.wasm': { status: 200, type: 'application/wasm', body: WASM_BYTES },
  '/y3/libarchive/libarchive.wasm': { status: 200, type: 'application/wasm', body: WASM_BYTES },
  '/z1/tree-sitter.wasm': { status: 200, type: 'application/wasm', body: WASM_BYTES },
  '/z2/tree-sitter.wasm': { status: 200, type: 'application/wasm', body: WASM_BYTES },
  '/z3/tree-sitter.wasm': { status: 200, type: 'application/wasm', body: WASM_BYTES }
};

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.scm': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json'
};

interface Fixture {
  /** 服务器基址（http://127.0.0.1:<临时端口>） */
  base: string;
  /** 某路径被请求的次数（CacheFirst 二次命中的判据） */
  hits(path: string): number;
  /**
   * 部署换版模拟：把 sw.js / vv-sw-cleanup.js 内的 BUILD_REVISION 全量替换
   * （真实换版时这两个产物随部署同步换新；其余产物内容不变不影响缓存行为）。
   * 传 null 取消替换。
   */
  setRevRewrite(from: string | null, to?: string): void;
  close(): Promise<void>;
}

/** 起一台自建静态服务器：伺服 build 产物 + 合成探针（含修复后服务端契约的 404 形态） */
async function startFixture(dir: string): Promise<Fixture> {
  const hits = new Map<string, number>();
  let revRewrite: { from: string; to: string } | null = null;
  const server = createServer((req, res) => {
    void (async () => {
      let pathname = '/';
      try {
        pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://127.0.0.1').pathname);
      } catch {
        pathname = '/';
      }
      if (pathname === '/') pathname = '/index.html';
      hits.set(pathname, (hits.get(pathname) ?? 0) + 1);
      const synth = SYNTHETIC[pathname];
      if (synth) {
        res.writeHead(synth.status, { 'content-type': synth.type, 'cache-control': 'no-cache' });
        res.end(synth.body);
        return;
      }
      const file = join(dir, pathname);
      if (!file.startsWith(dir)) {
        res.writeHead(403, { 'content-type': 'text/plain' }).end('forbidden');
        return;
      }
      if (revRewrite && (pathname === '/sw.js' || pathname === '/vv-sw-cleanup.js')) {
        const text = (await readFile(file)).toString('utf8');
        res.writeHead(200, { 'content-type': 'application/javascript', 'cache-control': 'no-cache' });
        res.end(text.split(revRewrite.from).join(revRewrite.to));
        return;
      }
      const data = await readFile(file);
      res.writeHead(200, {
        'content-type': MIME[extname(file)] ?? 'application/octet-stream',
        'cache-control': 'no-cache'
      });
      res.end(data);
    })().catch(() => {
      if (!res.headersSent) res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    hits: (p: string) => hits.get(p) ?? 0,
    setRevRewrite: (from: string | null, to?: string) => {
      revRewrite = from !== null && to !== undefined ? { from, to } : null;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      })
  };
}

/** SW 首装激活/控制权交接窗口内 evaluate 会命中未就绪文档——折叠为 null 让外层 poll 重试 */
async function safeEval<T>(page: Page, fn: () => T | Promise<T>): Promise<T | null> {
  try {
    const v = await page.evaluate(fn);
    return (v ?? null) as T | null;
  } catch {
    return null;
  }
}

/** 等 SW activated、控制权交接完成（controller 在位）且 precache 填充 */
async function waitSwActivated(page: Page): Promise<void> {
  await expect
    .poll(
      async () => {
        const s = await safeEval(page, async () => {
          const reg = await navigator.serviceWorker.ready;
          const keys = await caches.keys();
          const precache = keys.find((k) => k.startsWith('workbox-precache')) ?? null;
          const entries = precache ? (await (await caches.open(precache)).keys()).length : 0;
          return {
            activated: reg.active?.state === 'activated',
            controlled: navigator.serviceWorker.controller !== null,
            entries
          };
        });
        if (!s || !s.activated || !s.controlled) return null;
        return s.entries;
      },
      { timeout: 60_000, message: '等待 SW activated、controller 在位且 precache 填充' }
    )
    .toBeGreaterThan(10);
}

/** 经页面发起一次 fetch（经 SW 路由），返回状态码/应答类型；网络层失败折叠为 status=-1 */
async function probe(
  page: Page,
  url: string,
  init?: { mode?: 'cors' | 'no-cors' }
): Promise<{ status: number; type: string; error: string | null }> {
  return page.evaluate(async ({ u, mode }) => {
    try {
      const r = await fetch(u, mode ? { mode } : undefined);
      return { status: r.status, type: r.type, error: null };
    } catch (e) {
      return { status: -1, type: 'error', error: e instanceof Error ? e.message : String(e) };
    }
  }, { u: url, mode: init?.mode });
}

/** 枚举持有某 URL 的 vv-* 运行时缓存名（不含 precache 族） */
async function vvHolders(page: Page, url: string): Promise<string[]> {
  return page.evaluate(async (u) => {
    const out: string[] = [];
    for (const name of await caches.keys()) {
      if (!name.startsWith('vv-')) continue;
      const cache = await caches.open(name);
      if (await cache.match(u)) out.push(name);
    }
    return out;
  }, url);
}

/** 统计某族（cacheName 前缀）内的条目总数——LRU 配额断言用 */
async function familyEntryCount(page: Page, prefix: string): Promise<number> {
  return page.evaluate(async (p) => {
    let n = 0;
    for (const name of await caches.keys()) {
      if (!name.startsWith(p)) continue;
      n += (await (await caches.open(name)).keys()).length;
    }
    return n;
  }, prefix);
}

/** 统计给定 URL 列表中仍被该族缓存持有的条数——LRU 逐出断言用 */
async function familyHeldCount(page: Page, prefix: string, urls: string[]): Promise<number> {
  return page.evaluate(
    async ({ p, list }) => {
      let n = 0;
      for (const name of await caches.keys()) {
        if (!name.startsWith(p)) continue;
        const cache = await caches.open(name);
        for (const u of list) if (await cache.match(u)) n += 1;
      }
      return n;
    },
    { p: prefix, list: urls }
  );
}

/** 全部缓存名快照；evaluate 失败（换版 reload 窗口）返回 null 以区别于「空列表」 */
async function cacheNames(page: Page): Promise<string[] | null> {
  return safeEval(page, () => caches.keys());
}

interface RouteRow {
  kind: 'navigation' | 'cache';
  /** 正则源码（不含首尾斜杠） */
  source: string;
  /** 处理器构造名（CacheFirst / NavigationRoute） */
  handler: string;
  cacheName: string | null;
  /** 路由方法（产物里为 "GET"） */
  method: string | null;
  /** CacheableResponsePlugin 的 statuses 白名单 */
  statuses: number[] | null;
  /** ExpirationPlugin 的 maxEntries */
  maxEntries: number | null;
  /** ExpirationPlugin 的 purgeOnQuotaError */
  purgeOnQuotaError: boolean | null;
}

/**
 * 解析构建产物 sw.js 的 registerRoute 调用表（含 plugins 段与 method 参数）。
 * 压缩产物的命名空间字母随打包变化，故一律按「new <ns>.<Ctor>(」形态匹配，不写死字母。
 */
function parseRoutes(sw: string): RouteRow[] {
  const rows: RouteRow[] = [];
  const KEY = 'registerRoute(';
  const NAV = /^new\s+[A-Za-z_$][\w$]*\.NavigationRoute\(/;
  const CTOR = /^,\s*new\s+[A-Za-z_$][\w$]*\.([A-Za-z][\w$]*)\(/;
  let idx = 0;
  for (;;) {
    const at = sw.indexOf(KEY, idx);
    if (at === -1) break;
    const j = at + KEY.length;
    if (NAV.test(sw.slice(j, j + 80))) {
      rows.push({
        kind: 'navigation',
        source: '',
        handler: 'NavigationRoute',
        cacheName: null,
        method: null,
        statuses: null,
        maxEntries: null,
        purgeOnQuotaError: null
      });
      idx = j + 1;
      continue;
    }
    if (sw[j] !== '/') {
      idx = j + 1;
      continue;
    }
    let k = j + 1;
    let source = '';
    while (k < sw.length) {
      const ch = sw[k] as string;
      if (ch === '\\') {
        source += ch + (sw[k + 1] ?? '');
        k += 2;
        continue;
      }
      if (ch === '/') break;
      source += ch;
      k += 1;
    }
    const tail = sw.slice(k + 1, k + 600);
    const ctor = CTOR.exec(tail);
    const cm = /cacheName:"([^"]+)"/.exec(tail);
    const st = /CacheableResponsePlugin\(\{statuses:\[([^\]]*)\]\}/.exec(tail);
    const me = /ExpirationPlugin\(\{maxEntries:(\d+)/.exec(tail);
    const po = /purgeOnQuotaError:(!0|!1|true|false)/.exec(tail);
    const method = /,"([A-Z]+)"\)/.exec(tail);
    rows.push({
      kind: 'cache',
      source,
      handler: ctor?.[1] ?? '?',
      cacheName: cm?.[1] ?? null,
      method: method?.[1] ?? null,
      statuses: st ? (st[1] ?? '').split(',').map((s) => Number(s.trim())) : null,
      maxEntries: me ? Number(me[1]) : null,
      purgeOnQuotaError: po ? po[1] === '!0' || po[1] === 'true' : null
    });
    idx = k + 1;
  }
  return rows;
}

/**
 * 按 workbox 的匹配语义解析首个命中路由（先匹配先赢）：
 * 正则对完整 URL（href）匹配；跨域请求必须从头匹配（workbox RegExpRoute：
 * 跨域且 match.index !== 0 时不接管）。
 */
function resolveRoute(rows: RouteRow[], url: string, origin: string): RouteRow | null {
  const u = new URL(url);
  for (const r of rows) {
    if (r.kind !== 'cache') continue;
    const m = new RegExp(r.source).exec(u.href);
    if (!m) continue;
    if (u.origin !== origin && m.index !== 0) continue;
    return r;
  }
  return null;
}

/**
 * 绝对 URL 路由的「字面前缀」：按正则源码逐字符扫描——转义字符（\x）按字面取，
 * 遇到未转义的正则元字符即止。例：`^https:\/\/cdn\.jsdelivr\.net\/npm\/.*`
 * → 字面前缀 `https://cdn.jsdelivr.net/npm/`（末尾 `.*` 为通配，不入前缀）。
 * 用于「元字符已转义、按字面匹配」的判定，不依赖任何特定主机的启发式。
 */
function literalPrefix(source: string): string | null {
  if (!source.startsWith('^')) return null;
  let out = '';
  let i = 1;
  for (; i < source.length; i += 1) {
    const ch = source[i] as string;
    if (ch === '\\') {
      out += source[i + 1] ?? '';
      i += 1;
      continue;
    }
    if ('.*+?()[]{}|^$'.includes(ch)) break;
    out += ch;
  }
  return out.startsWith('http') ? out : null;
}

/** 枚举构建产物的客户端 JS 文件（读注入字面量用） */
function builtClientJsFiles(): string[] {
  const root = join(BUILD_DIR, '_app', 'immutable');
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith('.js')) files.push(p);
    }
  };
  walk(root);
  return files;
}

/** 从构建产物的注入字面量读出构建期 env 值（vite define 注入 import.meta.env） */
function readBuildEnvValue(key: string): string | null {
  for (const f of builtClientJsFiles()) {
    const text = readFileSync(f, 'utf8');
    const m = new RegExp(key + ':(["\'`])([^"\'`]*)\\1').exec(text);
    if (m) return m[2] ?? '';
  }
  return null;
}

test.describe('b-sw-runtime-cache SW 运行时缓存路由（自建静态伺服面 + caches API 断言）', () => {
  let fixture: Fixture;

  test.beforeAll(async () => {
    fixture = await startFixture(BUILD_DIR);
  });

  test.afterAll(async () => {
    await fixture.close();
  });

  test('SWR-ROUTE-01: worker 图同源 wasm（残余 A7）落 vv-worker-wasm-*，二次不回源且断网后仍可取回', async ({
    page
  }) => {
    test.setTimeout(120_000);
    await page.goto(fixture.base);
    await waitSwActivated(page);

    const path = '/_app/immutable/workers/assets/swr-probe.wasm';
    const url = `${fixture.base}${path}`;
    const first = await probe(page, url);
    expect(first.status, `worker wasm 探针应 200（实际 ${first.error ?? first.status}）`).toBe(200);

    // 落位断言：恰好一个 vv-* 运行时缓存持有该 URL（族归属唯一，不被别的族截胡）
    await expect
      .poll(async () => (await vvHolders(page, url)).length, {
        timeout: 20_000,
        message: '等待 worker wasm 进运行时缓存'
      })
      .toBe(1);
    const holders = await vvHolders(page, url);
    expect(
      holders[0],
      'worker 图 wasm 应归 vv-worker-wasm-* 族（vite.config.ts:729-735 残余 A7 路由）'
    ).toMatch(/^vv-worker-wasm-/);

    // CacheFirst 语义：第二次 fetch 由缓存应答，服务端不再收到请求
    const hitsBefore = fixture.hits(path);
    const second = await probe(page, url);
    expect(second.status, '二次 fetch 应命中缓存返回 200').toBe(200);
    expect(
      fixture.hits(path),
      '二次 fetch 不应回源（CacheFirst 命中运行时缓存；服务端 no-cache 头确保无 HTTP 缓存兜底）'
    ).toBe(hitsBefore);

    // 离线二次可用性（本路由自述收益：own 面 worker 的 wasm 随本路由获得离线可用性，
    // vite.config.ts:726-728）：断网后同一 URL 仍应从运行时缓存应答 200
    await page.context().setOffline(true);
    try {
      const offline = await probe(page, url);
      expect(
        offline.status,
        `断网后应从 vv-worker-wasm-* 运行时缓存取回 200（实际 ${offline.error ?? offline.status}）`
      ).toBe(200);
    } finally {
      await page.context().setOffline(false);
    }
  });

  test('SWR-ROUTE-02: foreign 资产同源预留槽落 vv-foreign-assets-*（与 CDN 路由同族计账）', async ({
    page
  }) => {
    test.setTimeout(120_000);
    await page.goto(fixture.base);
    await waitSwActivated(page);

    const path = '/file-viewer-assets/swr-probe.wasm';
    const url = `${fixture.base}${path}`;
    const r = await probe(page, url);
    expect(r.status, `同源预留槽探针应 200（实际 ${r.error ?? r.status}）`).toBe(200);

    await expect
      .poll(async () => (await vvHolders(page, url)).length, {
        timeout: 20_000,
        message: '等待同源预留槽资产进运行时缓存'
      })
      .toBe(1);
    const holders = await vvHolders(page, url);
    expect(
      holders[0],
      '同源预留槽 /file-viewer-assets/ 应归 vv-foreign-assets-* 族（vite.config.ts:774-785）'
    ).toMatch(/^vv-foreign-assets-/);
  });

  test('SWR-ROUTE-03: 路由命中的非 200 应答不入运行时缓存（cacheableResponse 只收 200）', async ({
    page
  }) => {
    test.setTimeout(120_000);
    await page.goto(fixture.base);
    await waitSwActivated(page);

    const missPath = '/file-viewer-assets/swr-missing.wasm';
    const missUrl = `${fixture.base}${missPath}`;
    const r = await probe(page, missUrl);
    expect(r.status, '404 应原样透传给页面（不被 SW 拦成网络错误）').toBe(404);

    // 同族 200 探针：其入缓存即证明该路由的 cache.put 通道已跑通（排除时序误判）
    const okPath = '/file-viewer-assets/swr-probe.wasm';
    const okUrl = `${fixture.base}${okPath}`;
    expect((await probe(page, okUrl)).status).toBe(200);
    await expect
      .poll(async () => (await vvHolders(page, okUrl)).length, {
        timeout: 20_000,
        message: '等待同族 200 探针入缓存（证明 put 通道已跑通）'
      })
      .toBe(1);

    expect(
      await vvHolders(page, missUrl),
      '404 应答不得进入任何 vv-* 运行时缓存（cacheableResponse statuses:[200]）'
    ).toEqual([]);
  });

  test('SWR-ROUTE-04: URL → 缓存族的唯一归属（grammars/runtime/queries/svgbob 各归其位）', async ({
    page
  }) => {
    test.setTimeout(120_000);
    await page.goto(fixture.base);
    await waitSwActivated(page);

    const cases = [
      { path: '/grammars/swr-probe.wasm', family: 'vv-grammars-' },
      { path: '/tree-sitter.wasm', family: 'vv-runtime-' },
      { path: '/libarchive/libarchive.wasm', family: 'vv-runtime-' },
      { path: '/queries/swr-probe/highlight.scm', family: 'vv-queries-' },
      { path: '/_app/immutable/assets/svgbob_wasm_bg.swrprobe.wasm', family: 'vv-diagram-svgbob-' }
    ];
    for (const c of cases) {
      const url = `${fixture.base}${c.path}`;
      const r = await probe(page, url);
      expect(r.status, `${c.path} 应 200（实际 ${r.error ?? r.status}）`).toBe(200);
      await expect
        .poll(async () => (await vvHolders(page, url)).length, {
          timeout: 20_000,
          message: `等待 ${c.path} 进运行时缓存`
        })
        .toBe(1);
      const holders = await vvHolders(page, url);
      expect(holders[0], `${c.path} 应归 ${c.family} 族`).toMatch(
        new RegExp('^' + c.family.replace(/-/g, '\\-'))
      );
    }
  });

  test('SWR-ROUTE-05: jsdelivr foreign 资产直链落 vv-foreign-assets-* 且不被 CDN 通配路由截胡（真网）', async ({
    page
  }) => {
    test.setTimeout(120_000);
    // 跨域 CDN 请求经 SW 的 fetch 事件发起，不进页面网络栈——page.route 拦不到。
    // 可达性探针与断言同口径（页面 fetch，受 CORS 约束）：CDN 撤掉 ACAO 或不可达时
    // 页面 fetch 失败/非 200 → skip，不假红（CDN-01/CDN-04 的 page.request 探针不受
    // CORS 约束，与页面 fetch 不同口径，会把「CORS 缺失」误判成产品缺陷）。
    const url = 'https://cdn.jsdelivr.net/npm/@file-viewer/assets-standard@3.3.3/package.json';
    await page.goto(fixture.base);
    await waitSwActivated(page);

    // ① opaque 应答（no-cors 模式 → status 0）不得入缓存：statuses:[200] 拒收 status 0。
    // 必须在 cors 探测之前做——同 URL 一旦被 cors 应答缓存，后续请求命中缓存而非网络。
    const opaque = await probe(page, url, { mode: 'no-cors' });
    if (opaque.status === -1) {
      test.skip(true, `CDN 不可达（no-cors 探测失败：${opaque.error ?? '-'}）：SWR-ROUTE-05 依赖真网 jsdelivr`);
    }
    expect(
      opaque.status === 0 || opaque.type === 'opaque',
      `no-cors 应答应为 opaque（status 0 / type=opaque），实际 status=${opaque.status} type=${opaque.type}`
    ).toBe(true);
    expect(
      await vvHolders(page, url),
      'opaque 应答（status 0）不得进入 vv-* 运行时缓存（statuses:[200] 只收 200）'
    ).toEqual([]);

    // ② cors 应答 200 → 归 foreign 族，且不被 jsdelivr 通配路由截胡
    const r = await probe(page, url);
    if (r.status !== 200) {
      test.skip(
        true,
        `CDN 不可达或页面 fetch 被 CORS 拒绝（status=${r.status}, error=${r.error ?? '-'}）：SWR-ROUTE-05 依赖真网 jsdelivr`
      );
    }
    await expect
      .poll(async () => (await vvHolders(page, url)).length, {
        timeout: 20_000,
        message: '等待 jsdelivr foreign 资产进运行时缓存'
      })
      .toBe(1);
    const holders = await vvHolders(page, url);
    expect(
      holders[0],
      'jsdelivr @file-viewer/assets- 直链应归 vv-foreign-assets-* 族（先匹配先赢，不被 jsdelivr 通配路由截胡）'
    ).toMatch(/^vv-foreign-assets-/);
  });

  test('SWR-ROUTE-06: jsdelivr 通配 CDN 引擎路由落 vv-cdn-engines-* 且不被 foreign 路由截胡（真网）', async ({
    page
  }) => {
    test.setTimeout(120_000);
    const url = 'https://cdn.jsdelivr.net/npm/lodash@4.17.21/package.json';
    await page.goto(fixture.base);
    await waitSwActivated(page);

    const r = await probe(page, url);
    if (r.status !== 200) {
      test.skip(
        true,
        `CDN 不可达或页面 fetch 被 CORS 拒绝（status=${r.status}, error=${r.error ?? '-'}）：SWR-ROUTE-06 依赖真网 jsdelivr`
      );
    }

    await expect
      .poll(async () => (await vvHolders(page, url)).length, {
        timeout: 20_000,
        message: '等待 jsdelivr 通配路由入缓存'
      })
      .toBe(1);
    const holders = await vvHolders(page, url);
    expect(
      holders[0],
      'jsdelivr 通配 CDN 引擎应归 vv-cdn-engines-* 族（不被 @file-viewer/assets- 专用路由截胡）'
    ).toMatch(/^vv-cdn-engines-/);
  });

  test(
    'SWR-ROUTE-07 [SWR-DEF-01 已修: 服务端 fallback 收窄后未知资产 404 不入 foreign 资产缓存]: /file-viewer-assets/ 下未知资产应答不得入运行时缓存',
    async ({ page }) => {
      // 修复后契约（server/src/lib.rs `serve_index` Accept 收窄，SWR-DEF-01）：SPA
      // fallback 只对导航请求生效——非导航 fetch 的未知资产 URL（foreign 资产的真实
      // 形态是 .js）由服务端回 404，404 被 /file-viewer-assets/ 路由的
      // cacheableResponse{statuses:[200]} 拒收。cacheableResponse 只拦非 200；SPA
      // fallback 的 200 HTML 由服务端 Accept 收窄治理（SW 层无法按 content-type 过滤：
      // generateSW 不支持自定义 cacheWillUpdate plugin）。本域伺服面已同步为修复后
      // 契约（swr-spa.js → 404）；服务端契约由 cargo 集成锚
      // （server/tests/health.rs spa_fallback_gated_on_navigation_accept）守住。
      // 缺陷态历史（200 HTML 入缓存）见 docs/e2e/sw-runtime-cache.md §3.2。
      test.setTimeout(120_000);
      await page.goto(fixture.base);
      await waitSwActivated(page);

      const path = '/file-viewer-assets/swr-spa.js';
      const url = `${fixture.base}${path}`;
      const r = await probe(page, url);
      expect(r.status, '修复后服务端对非导航 fetch 的未知资产回 404（Accept 收窄）').toBe(404);

      // 同族 200 探针入缓存即证明 put 通道已跑通（排除时序误判）
      const okUrl = `${fixture.base}/file-viewer-assets/swr-probe.wasm`;
      expect((await probe(page, okUrl)).status).toBe(200);
      await expect
        .poll(async () => (await vvHolders(page, okUrl)).length, {
          timeout: 20_000,
          message: '等待同族 200 探针入缓存（证明 put 通道已跑通）'
        })
        .toBe(1);

      expect(
        await vvHolders(page, url),
        '未知资产的 404 不得进入 vv-foreign-assets 缓存（cacheableResponse 拒收非 200）'
      ).toEqual([]);
    }
  );

  test('SWR-TABLE-01: 构建产物路由表契约——族归属、处理器、方法、可缓存状态与过期配额', async () => {
    const sw = await readFile(join(BUILD_DIR, 'sw.js'), 'utf8');
    const rows = parseRoutes(sw);
    const origin = 'http://127.0.0.1:4173';
    const cases = [
      { url: `${origin}/grammars/rust.wasm`, family: 'vv-grammars-' },
      { url: `${origin}/tree-sitter.wasm`, family: 'vv-runtime-' },
      { url: `${origin}/libarchive/libarchive.wasm`, family: 'vv-runtime-' },
      { url: `${origin}/queries/rust/highlights.scm`, family: 'vv-queries-' },
      { url: `${origin}/_app/immutable/assets/svgbob_wasm_bg.XYZ.wasm`, family: 'vv-diagram-svgbob-' },
      { url: `${origin}/_app/immutable/workers/assets/rpgp_wrapper_bg-XYZ.wasm`, family: 'vv-worker-wasm-' },
      { url: `${origin}/file-viewer-assets/vendor/docx/docx.js`, family: 'vv-foreign-assets-' },
      {
        url: 'https://cdn.jsdelivr.net/npm/@file-viewer/assets-standard@3.3.3/viewer/vendor/docx/docx.js',
        family: 'vv-foreign-assets-'
      },
      { url: 'https://cdn.jsdelivr.net/npm/lodash@4.17.21/package.json', family: 'vv-cdn-engines-' }
    ];
    for (const c of cases) {
      const row = resolveRoute(rows, c.url, origin);
      expect(row, `产物路由表应能解析 ${c.url}`).not.toBeNull();
      // 处理器面：handler 由 CacheFirst 改为其它策略（NetworkFirst/StaleWhileRevalidate）
      // 会在此打红——运行期行为差异由 SWR-ROUTE-01/02 与 SWR-EXP-01 承担
      expect(
        row?.handler,
        `${c.url} 的处理器应为 CacheFirst（产物压缩形态变化会导致解析不到构造名）`
      ).toBe('CacheFirst');
      expect(
        row?.cacheName ?? '',
        `${c.url} 应归属 ${c.family} 族（先匹配先赢：专用路由先于 jsdelivr 通配路由注册）`
      ).toMatch(new RegExp('^' + c.family.replace(/-/g, '\\-')));
      // 方法面：产物里 registerRoute 均带 "GET"——被改成允许 POST 会被此处发现
      expect(row?.method ?? '', `${c.url} 的路由方法应为 GET`).toBe('GET');
      // 可缓存状态面：只收 200 —— 放宽到 [0,200]（收 opaque）或 [200,404] 会被此处发现
      expect(
        row?.statuses ?? [],
        `${c.url} 的 cacheableResponse statuses 应恰为 [200]（不含 0/opaque、不含 404）`
      ).toEqual([200]);
      // 过期配额面：每条路由均配 ExpirationPlugin 的 maxEntries + purgeOnQuotaError
      expect(
        typeof row?.maxEntries === 'number' && row.maxEntries > 0,
        `${c.url} 应配置 ExpirationPlugin.maxEntries（实际 ${row?.maxEntries ?? '缺失'}）`
      ).toBe(true);
      expect(row?.purgeOnQuotaError, `${c.url} 应配置 purgeOnQuotaError`).toBe(true);
    }

    // 共用缓存族的配额一致性：tree-sitter 与 libarchive 两条路由共用 vv-runtime-<REV>，
    // 其 maxEntries 必须一致（同族共用一份 LRU 预算，配置不一致即互相挤占失准）
    const runtimeRows = rows.filter(
      (r) => r.kind === 'cache' && (r.cacheName ?? '').startsWith('vv-runtime-')
    );
    expect(runtimeRows.length, 'vv-runtime 族应含 tree-sitter 与 libarchive 两条路由').toBe(2);
    expect(
      new Set(runtimeRows.map((r) => r.cacheName)).size,
      'vv-runtime 族的两条路由应共用同一 cacheName'
    ).toBe(1);
    expect(
      new Set(runtimeRows.map((r) => r.maxEntries)).size,
      'vv-runtime 族的两条路由应共用同一 maxEntries（同族 LRU 预算）'
    ).toBe(1);
  });

  test('SWR-TABLE-02: 构建产物 base 接线一致（清理脚本 importScripts 与 manifest scope 同目录、SW 注册路径相对）', async () => {
    const sw = await readFile(join(BUILD_DIR, 'sw.js'), 'utf8');
    const manifest = JSON.parse(
      await readFile(join(BUILD_DIR, 'manifest.webmanifest'), 'utf8')
    ) as { scope?: string; start_url?: string };
    const scope = manifest.scope ?? '/';
    const scopeDir = scope.endsWith('/') ? scope.slice(0, -1) : scope;
    const importMatch = /importScripts\("([^"]+)"\)/.exec(sw);
    expect(importMatch, 'sw.js 应以 importScripts 引入清理脚本（vite.config.ts:654）').toBeTruthy();
    const importPath = importMatch?.[1] ?? '';
    const importDir = importPath.slice(0, importPath.lastIndexOf('/'));
    expect(
      importDir,
      `清理脚本 importScripts 路径应落在 SW 自身目录（base 一致）：scope=${scope}，importScripts=${importPath}`
    ).toBe(scopeDir);
    expect(importPath.endsWith('/vv-sw-cleanup.js'), 'importScripts 目标应为 vv-sw-cleanup.js').toBe(
      true
    );

    // SW 注册 URL / scope 必须与 manifest scope 同源（相对路径或带 base 前缀）——
    // base 接错时 SW 装不上或 scope 越界，清理脚本永不执行。
    let registerUrl: string | null = null;
    let registerScope: string | null = null;
    for (const f of builtClientJsFiles()) {
      const text = readFileSync(f, 'utf8');
      const m = /`([^`]*sw\.js)`,\{scope:`([^`]*)`/.exec(text);
      if (m) {
        registerUrl = m[1] ?? null;
        registerScope = m[2] ?? null;
        break;
      }
    }
    expect(registerUrl, '客户端产物应含 SW 注册 URL').toBeTruthy();
    expect(
      (registerUrl ?? '').startsWith('./') || (registerUrl ?? '').startsWith(scope),
      `SW 注册 URL 应为相对路径或带 base 前缀（与 manifest scope=${scope} 同源）：实际 ${registerUrl ?? '缺失'}`
    ).toBe(true);
    expect(
      registerScope === './' || registerScope === scope,
      `SW 注册 scope 应为 './' 或与 manifest scope 一致（实际 ${registerScope ?? '缺失'}，manifest=${scope}）`
    ).toBe(true);
  });

  test('SWR-MIRROR-01: 跨域路由的字面匹配与族归属（路由条数由构建期 env 推导；元字符按字面匹配）', async () => {
    const sw = await readFile(join(BUILD_DIR, 'sw.js'), 'utf8');
    const rows = parseRoutes(sw);
    const envValue = readBuildEnvValue('VV_FOREIGN_ASSETS');
    expect(envValue, '构建产物应含 VV_FOREIGN_ASSETS 注入字面量（vite define）').not.toBeNull();
    const env = (envValue ?? '').trim();

    // env 镜像路由的生成条件（vite.config.ts:37,54-56,64-72）：env 非空且为 http(s)
    // 前缀时，才生成一条 urlPattern = `^` + escapeRegExp(env base) 的路由；其字面
    // 前缀即 env base 本身（转义只影响正则语义，不改字面文本）。
    const mirrorBase = env === '' ? '' : env.endsWith('/') ? env : `${env}/`;
    const expectMirror = /^https?:\/\//.test(mirrorBase);

    const absRows = rows
      .filter((r) => r.kind === 'cache')
      .map((r) => ({ row: r, prefix: literalPrefix(r.source) }))
      .filter((x): x is { row: RouteRow; prefix: string } => x.prefix !== null);
    expect(absRows.length, '产物应含绝对 URL 路由（jsdelivr foreign + 通配 [+ env 镜像]）').toBeGreaterThan(
      0
    );

    // 族基准：foreign 族 = jsdelivr @file-viewer/assets- 路由与同源预留槽路由共用的
    // 缓存名（vite.config.ts:764-781 两者同族计账）；env 镜像路由（若存在）亦归此族
    // （vite.config.ts:770 注释）。以「解析代表 URL 得出的族」为基准，不按 source
    // 文本猜主机（jsdelivr 启发式在 env base 指向 jsdelivr 时会误判）。
    const origin = 'http://127.0.0.1:4173';
    const foreignRow = resolveRoute(
      rows,
      'https://cdn.jsdelivr.net/npm/@file-viewer/assets-standard@3.3.3/viewer/vendor/docx/docx.js',
      origin
    );
    const slotRow = resolveRoute(rows, `${origin}/file-viewer-assets/vendor/docx/docx.js`, origin);
    const engineRow = resolveRoute(rows, 'https://cdn.jsdelivr.net/npm/lodash@4.17.21/package.json', origin);
    expect(foreignRow?.cacheName ?? '', 'foreign CDN 路由应归 vv-foreign-assets-* 族').toMatch(
      /^vv-foreign-assets-/
    );
    expect(
      slotRow?.cacheName ?? '',
      '同源预留槽路由应与 foreign CDN 路由同族（共用 vv-foreign-assets-* 配额）'
    ).toBe(foreignRow?.cacheName ?? '');
    expect(engineRow?.cacheName ?? '', 'jsdelivr 通配引擎路由应归 vv-cdn-engines-* 族').toMatch(
      /^vv-cdn-engines-/
    );

    // 绝对 URL 路由条数由构建期 env 推导（默认构建 env 空 ⇒ 2 条：jsdelivr foreign +
    // jsdelivr 通配；env 非空且为 http(s) ⇒ 3 条，多出的一条即 env 镜像路由）。
    // 断言写成「条数 == 期望值」，两种构建形态下都是可执行断言（非死分支）。
    const expectedAbsCount = expectMirror ? 3 : 2;
    expect(
      absRows.length,
      `绝对 URL 路由条数应为 ${expectedAbsCount}（env=${env || '<空>'}，expectMirror=${expectMirror}）`
    ).toBe(expectedAbsCount);

    for (const { row, prefix } of absRows) {
      const re = new RegExp(row.source);
      // 字面前缀可命中（路由前缀本身有效）
      expect(re.test(`${prefix}probe`), `绝对 URL 路由应命中其字面前缀下的 URL：${prefix}`).toBe(true);
      // 元字符已转义（按字面匹配，不把 '.' 当通配）——镜像域路由的 base 同样经
      // escapeRegExp 转义（vite.config.ts:57-58），该判据对镜像路由同样成立
      if (prefix.includes('.')) {
        const mutated = prefix.replace('.', 'X');
        expect(
          re.test(`${mutated}probe`),
          `绝对 URL 路由应按字面匹配前缀（正则元字符已转义）：${prefix}`
        ).toBe(false);
      }
      // 族归属：跨域路由只允许落在 foreign 族或 cdn-engines 族两个基准之一
      // （env 镜像路由归 foreign 族由 vite.config.ts:770 的族复用语义保证）
      const allowed = [foreignRow?.cacheName ?? '', engineRow?.cacheName ?? ''];
      expect(
        allowed,
        `绝对 URL 路由 ${prefix} 应归属 foreign 族或 cdn-engines 族（env 镜像归 foreign 族）`
      ).toContain(row.cacheName ?? '');
    }

    if (expectMirror) {
      // env 非空构建：镜像路由的字面前缀必须恰为 env base（尾斜杠归一），族归 foreign
      const mirror = absRows.find((x) => x.prefix === mirrorBase);
      expect(mirror, `env 非空构建应含 env base 前缀的镜像路由：${mirrorBase}`).toBeTruthy();
      expect(
        mirror?.row.cacheName ?? '',
        'env 镜像路由应归 foreign 族（与 jsdelivr foreign 路由同族计账，vite.config.ts:770）'
      ).toBe(foreignRow?.cacheName ?? '');
    } else {
      // env 空构建：跨域路由主机只能是 jsdelivr（无镜像域路由）
      const hosts = [...new Set(absRows.map((x) => new URL(x.prefix).host))];
      expect(
        hosts,
        'VV_FOREIGN_ASSETS 为空时不得存在非 jsdelivr 主机的绝对 URL 路由（无镜像域路由，vite.config.ts:37,54-56）'
      ).toEqual(['cdn.jsdelivr.net']);
    }
  });

  test('SWR-EXP-01: vv-runtime 族 LRU 逐出生效（tree-sitter 与 libarchive 两路由共用同族配额互相挤占）', async ({
    page
  }) => {
    test.setTimeout(120_000);
    await page.goto(fixture.base);
    await waitSwActivated(page);

    // 两条路由（/tree-sitter.wasm 与 /libarchive/libarchive.wasm）共用 vv-runtime-<REV>，
    // 该族 maxEntries=4（vite.config.ts:677,692）。写入 6 条跨路由条目 → 超配额 →
    // ExpirationPlugin 的 LRU 逐出必须把族内条目压回配额内（workbox-expiration
    // models/CacheTimestampsModel.js:113-160：按时间戳降序遍历，保留最新 maxEntries 条）。
    // 注意：应用自身启动时亦预热 /tree-sitter.wasm（highlightClient.ts:297）并入同一族，
    // 故族内基线条数非零——逐出断言只针对「本用例写入的 6 条」，不假设族的初始内容。
    const written = [
      '/y1/libarchive/libarchive.wasm',
      '/y2/libarchive/libarchive.wasm',
      '/y3/libarchive/libarchive.wasm',
      '/z1/tree-sitter.wasm',
      '/z2/tree-sitter.wasm',
      '/z3/tree-sitter.wasm'
    ];
    for (const p of written) {
      const r = await probe(page, `${fixture.base}${p}`);
      expect(r.status, `${p} 应 200（实际 ${r.error ?? r.status}）`).toBe(200);
    }
    const writtenUrls = written.map((p) => `${fixture.base}${p}`);

    // 等族内容稳定：SW 的 cache.put 与 ExpirationPlugin 的逐出都跑在 fetch 事件的
    // waitUntil 里（响应返回 ≠ 落盘完成），故连续三次读到同一组数值才算落定，
    // 避免在写入尚未全部落盘时读到「族内 ≤ 4」的假稳定态。
    let lastKey = '';
    let stable = 0;
    await expect
      .poll(
        async () => {
          const fam = await familyEntryCount(page, 'vv-runtime-');
          const held = await familyHeldCount(page, 'vv-runtime-', writtenUrls);
          const key = `${fam}/${held}`;
          stable = key === lastKey ? stable + 1 : 0;
          lastKey = key;
          return stable >= 2 ? key : null;
        },
        { timeout: 30_000, message: '等待 vv-runtime 族内容落定（cache.put 与逐出完成）' }
      )
      .toBeTruthy();
    const [famStr = '', heldStr = ''] = lastKey.split('/');
    const fam = Number(famStr);
    const held = Number(heldStr);

    // 配额生效：族内条目数被压回 maxEntries（4）以内（过期插件缺失/配额放宽即红）。
    // 族内基线非零——应用启动即预热 /tree-sitter.wasm（highlightClient.ts:297）
    // 并入同一族，故不假设族初始为空。
    expect(fam, 'vv-runtime 族条目数应被压回 maxEntries(4) 以内').toBeLessThanOrEqual(4);
    // 逐出语义：本用例经两条不同路由写入 6 条 > 配额 4 → 至少 2 条被逐出
    // （无过期插件则 6 条全留 → 红）；且逐出是「最旧优先」而非全清（族内仍留有条目）。
    expect(held, '本用例写入的 6 条中至少 2 条应被逐出（LRU 配额 4）').toBeLessThanOrEqual(4);
    expect(held, '逐出不应清空整个族（LRU 只逐出最旧条目）').toBeGreaterThan(0);
  });

  test(
    'SWR-CLEAN-01: 换版后旧 REV 的 vv-worker-wasm-* 缓存应被 activate 清理',
    async ({ page }) => {
      test.setTimeout(240_000);
      // 部署换版模拟：sw.js 与 vv-sw-cleanup.js 两处的 BUILD_REVISION 全量替换
      // （真实换版时这两个产物随部署同步换新；其余产物内容不变不影响缓存行为）
      const swText = await readFile(join(BUILD_DIR, 'sw.js'), 'utf8');
      const rev1 = swText.match(/vv-grammars-([^"'`\\]+)/)?.[1];
      expect(rev1, 'sw.js 应含 vv-grammars-<BUILD_REVISION> 缓存名').toBeTruthy();
      const rev = rev1 as string;
      const rev2 = `${rev}-swrv2`;
      const cleanupText = await readFile(join(BUILD_DIR, 'vv-sw-cleanup.js'), 'utf8');
      expect(cleanupText, '清理脚本应烘焙当前 REV').toContain(rev);

      const local = await startFixture(BUILD_DIR);
      try {
        await page.goto(local.base);
        await waitSwActivated(page);

        // 旧 REV 会话：预热两个族的运行时缓存
        const gramPath = '/grammars/swr-probe.wasm';
        const workerPath = '/_app/immutable/workers/assets/swr-probe.wasm';
        expect((await probe(page, `${local.base}${gramPath}`)).status).toBe(200);
        expect((await probe(page, `${local.base}${workerPath}`)).status).toBe(200);
        await expect
          .poll(async () => (await vvHolders(page, `${local.base}${gramPath}`)).length, {
            timeout: 20_000,
            message: '等待旧 REV 的 grammars 缓存'
          })
          .toBe(1);
        await expect
          .poll(async () => (await vvHolders(page, `${local.base}${workerPath}`)).length, {
            timeout: 20_000,
            message: '等待旧 REV 的 worker-wasm 缓存'
          })
          .toBe(1);
        const before = (await cacheNames(page)) ?? [];
        expect(before, '旧 REV 会话应建立 vv-grammars 缓存').toContain(`vv-grammars-${rev}`);
        expect(before, '旧 REV 会话应建立 vv-worker-wasm 缓存').toContain(`vv-worker-wasm-${rev}`);

        // 部署 v2：产物内 REV 改写 + reload（浏览器取到新 sw.js → 新 SW 接管）。
        // registerType autoUpdate 下新 SW 接管会自行触发页面 reload，reload 本身可能
        // 落在 context destroyed 窗口抛错——吞掉并交给后续 poll 判读。
        local.setRevRewrite(rev, rev2);
        try {
          await page.reload({ waitUntil: 'domcontentloaded' });
        } catch {
          // 换版 reload 与 autoUpdate reload 竞态：页面上下文在途销毁，判定交给轮询
        }

        // 等新 REV 接管：只用 worker-wasm 族做信号——该族旧 REV 缓存在缺陷态永不被清理，
        // 不会与「控制组族」互相干扰；且换版后不再 fetch grammars 族（避免旧 SW 在清理
        // 完成前把已删的旧 REV 缓存重新写回，使控制组判据失真）
        await expect
          .poll(
            async () => {
              try {
                await probe(page, `${local.base}${workerPath}`);
                const keys = await cacheNames(page);
                return keys?.includes(`vv-worker-wasm-${rev2}`) ?? false;
              } catch {
                return false;
              }
            },
            { timeout: 90_000, message: '等待新 REV SW 接管并建立新 REV 运行时缓存' }
          )
          .toBe(true);
        // 控制组（最小化，仅证「清理动作确实执行过」以排除「清理整体没跑」的另一种
        // 解释；三族换版清理的主责在既有锚 t-pwa.spec.ts:736-881）
        await expect
          .poll(
            async () => {
              const keys = await cacheNames(page);
              if (!keys) return -1;
              return keys.filter(
                (k) => k.startsWith('vv-grammars-') && k !== `vv-grammars-${rev2}`
              ).length;
            },
            { timeout: 30_000, message: '等待旧 REV 的 vv-grammars 缓存被清理（控制组）' }
          )
          .toBe(0);

        const after = (await cacheNames(page)) ?? [];
        // 缺陷锚：清理正则漏 vv-worker-wasm → 旧 REV 缓存永久残留
        expect(
          after.filter((k) => k.startsWith('vv-worker-wasm-') && k !== `vv-worker-wasm-${rev2}`),
          '旧 REV 的 vv-worker-wasm-* 缓存应随换版被清理（vite.config.ts:130 current 清单含该族，:148 清理正则漏该族 → 永久残留）'
        ).toEqual([]);
        // 护栏：当前 REV 的同族缓存不得被误删
        expect(after, '当前 REV 的 vv-worker-wasm-* 缓存须保留').toContain(`vv-worker-wasm-${rev2}`);
      } finally {
        await local.close();
      }
    }
  );

  test(
    'SWR-CLEAN-02: 清理脚本正向不变量——current 清单的每个缓存名都须被删除正则覆盖',
    async () => {
      const cleanupText = await readFile(join(BUILD_DIR, 'vv-sw-cleanup.js'), 'utf8');
      const currentMatch = /const current = (\[[^\]]*\]);/.exec(cleanupText);
      expect(currentMatch, 'vv-sw-cleanup.js 应烘焙 current 缓存清单').toBeTruthy();
      const current = JSON.parse(currentMatch?.[1] ?? '[]') as string[];
      const filterMatch = /\.filter\(\(n\) => \/(.+?)\/\.test\(n\)/.exec(cleanupText);
      expect(filterMatch, 'vv-sw-cleanup.js 应有删除过滤正则').toBeTruthy();
      const re = new RegExp(filterMatch?.[1] ?? '$^');

      // 正向不变量：current 清单里的每个族都被删除正则覆盖（漏族 → 旧 REV 缓存永久残留）
      const uncovered = current.filter((n) => !re.test(n));
      expect(
        uncovered,
        `清理正则未覆盖的 current 缓存族：${uncovered.join('、') || '（无）'}（current 清单与删除正则必须同族）`
      ).toEqual([]);
    }
  );

  test('SWR-CLEAN-03: 清理脚本反向不变量——每条运行时路由的 cacheName 都在 current 清单内、清单无多余条目', async () => {
    const cleanupText = await readFile(join(BUILD_DIR, 'vv-sw-cleanup.js'), 'utf8');
    const currentMatch = /const current = (\[[^\]]*\]);/.exec(cleanupText);
    expect(currentMatch, 'vv-sw-cleanup.js 应烘焙 current 缓存清单').toBeTruthy();
    const current = JSON.parse(currentMatch?.[1] ?? '[]') as string[];

    const sw = await readFile(join(BUILD_DIR, 'sw.js'), 'utf8');
    const rows = parseRoutes(sw);
    const routeCacheNames = [
      ...new Set(
        rows
          .filter((r) => r.kind === 'cache')
          .map((r) => r.cacheName ?? '')
          .filter((n) => n !== '')
      )
    ];
    expect(routeCacheNames.length, '产物应含运行时路由的 cacheName').toBeGreaterThan(0);

    // 反向不变量（新增族忘进 current 清单 → 该族旧 REV 缓存既不被任何路由命中、
    // 也不在删除候选内 → 静默泄漏）
    const missing = routeCacheNames.filter((n) => !current.includes(n));
    expect(
      missing,
      `未登记进 current 清单的路由缓存名：${missing.join('、') || '（无）'}（新增族必须同时进 current 清单与删除正则）`
    ).toEqual([]);
    // 清单不得含已无路由对应的陈旧条目（陈旧条目使删除候选与实际族脱节）
    const orphans = current.filter((n) => !routeCacheNames.includes(n));
    expect(
      orphans,
      `current 清单中无对应路由的条目：${orphans.join('、') || '（无）'}`
    ).toEqual([]);
  });
});
