import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { closeDrawerIfOpened, openDrawerIfNarrow } from './drawer';

/**
 * b-grammar-spa-fallback E2E（grammar SPA-fallback 嗅探回归，GRF-01~08）：静态托管把
 * 缺失路径 SPA-fallback 成 200 index.html 是真实部署形态，三层资产链的三个资产面
 * （manifest / wasm / 查询 .scm）各有「200 text/html 误载」修复的浏览器端回归锚：
 *
 * - manifest（grammarLayers.ts fetchGrammarManifest）：200 且 content-type 含 text/html
 *   → null + 「非 JSON 资产应答（SPA fallback？）」warn 跳层（050ae69；修复前
 *   res.json() 抛 SyntaxError 误报网络错）；
 * - 查询 .scm（core-parse.ts remoteQueryLoader）：200 text/html → undefined 视同缺失
 *   （7fab3a5 前端层；修复前 HTML 误载为查询文本，Query 编译抛错整语言降级 hljs）；
 * - wasm：HTML 误入 WebAssembly 实例化必抛——断言被捕获降级 hljs 不崩（BUG-06a
 *   per-language 可观测 warn 留痕）。
 *
 * 场景文档：docs/e2e/grammar-spa-fallback.md。与既有锚点不重叠：b-grammar-layers
 * （CDN 兜底正锚 / CDN 不可达降级）、b-grammar-layers-server（服务端层 first-wins）、
 * CMP/t-cmp（路由三道门）。
 *
 * 构建期前提（同 b-grammar-layers）：bundle 必须以
 *   VV_GRAMMAR_CDN=https://cdn.grammars.test/grammars/ pnpm build
 * 构建（CI e2e job 已设该 env）。该值经 vite define 静态替换进 highlightClient.ts，
 * 未注入时 CDN 层不发起任何请求——GRF-01/02 的 warn/命中计数断言即构建注入守卫。
 *
 * serviceWorkers: 'block'（b-grammar-layers 同款已知边界）：PWA SW 对 grammar 资产
 * 注册 CacheFirst 而 page.route 拦不到经 SW 的请求，SW 激活时机会使 mock 随机失效；
 * 屏蔽 SW 求确定性（注册失败被 workbox-window 捕获，页面功能不受影响）。
 *
 * CDN 请求纪律：环境遗留观察（full-grammar-alignment §7.2）——本机透明代理会把
 * 未 mock 的 cdn.grammars.test fetch 变成真实 socket。凡不专门 mock CDN 资产的用例
 * 一律 blockCdn() 全域 abort，杜绝外网抖动。
 *
 * 布局契约（base = 同时容纳 manifest.json 与 *.wasm 的目录前缀，以 / 结尾）：
 * 查询资产恒同源 `${base}queries/<lang>/{highlights,injections}.scm`（queriesBase 不
 * 随 grammar 条目分层——b-grammar-layers 头注同款口径），故查询 mock 无跨源形态。
 */
test.use({ serviceWorkers: 'block' });

/** CDN origin（base 含 /grammars/ 目录段，与 VV_GRAMMAR_CDN 构建值一致） */
const CDN_ORIGIN = 'https://cdn.grammars.test';

/** SPA fallback 应答体：最小 index.html 形态（嗅探只看 content-type，wasm 面靠字节非法） */
const SPA_HTML =
  '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>vviewer</title>' +
  '</head><body><div id="app"></div></body></html>';

/** 用例载入的 .java 文件（短小、语法特征明确：tree-sitter 与 hljs 均可识别） */
const JAVA_SRC = [
  'package com.vviewer.demo;',
  '',
  'public class Hello {',
  '    public static String greet(String name) {',
  '        return "hello " + name;',
  '    }',
  '}'
].join('\n');

/** GRF-07 第二个 java 文件（内容可区分，验证第二文件照常渲染） */
const JAVA_SRC_2 = [
  'package com.vviewer.demo;',
  '',
  'public class World {',
  '    public static String farewell(String name) {',
  '        return "bye " + name;',
  '    }',
  '}'
].join('\n');

/** GRF-05/08 的 rust 样例（lite 集内语言，同源 manifest 真实条目） */
const RUST_SRC = [
  'pub fn add(a: i64, b: i64) -> i64 {',
  '    a + b',
  '}',
  '',
  'fn main() {',
  '    println!("{}", add(1, 2));',
  '}'
].join('\n');

interface FilePayload {
  name: string;
  type: string;
  content: string;
}

/** 通道同 b-grammar-layers：页面内 File + webkitRelativePath 经 __vvOpenDirImpl 注入 */
async function openDir(page: Page, payloads: FilePayload[]): Promise<void> {
  await page.waitForFunction(
    () => typeof (window as unknown as { __vvOpenDirImpl?: unknown }).__vvOpenDirImpl === 'function'
  );
  await page.evaluate((payloads) => {
    const files = payloads.map(({ name, type, content }) => {
      const f = new File([content], name, { type });
      Object.defineProperty(f, 'webkitRelativePath', { value: `grf-spa/${name}` });
      return f;
    });
    return (window as unknown as { __vvOpenDirImpl: (f: File[]) => void }).__vvOpenDirImpl(files);
  }, payloads);
}

/** 抽屉适配（mobile project ≤900px 文件树收进抽屉），断言 active tab 后还原内容区 */
async function openFile(page: Page, name: string): Promise<void> {
  const drawer = await openDrawerIfNarrow(page);
  await page.locator('.vv-tree-row').filter({ hasText: name }).click();
  await closeDrawerIfOpened(page, drawer);
  await expect(page.locator('.vv-tab.active', { hasText: name })).toBeVisible();
}

/** E2E 观测口径：最近一次高亮的落定值（highlightClient withDebug 写入） */
async function lastHighlight(page: Page): Promise<{ ok?: boolean; lang?: string }> {
  return page.evaluate(() => {
    const dbg = window as unknown as { __vvLastHighlightOk?: boolean; __vvLastHighlightLang?: string };
    return { ok: dbg.__vvLastHighlightOk, lang: dbg.__vvLastHighlightLang };
  });
}

/**
 * warn/pageerror 探针：必须在 goto 前挂载（资产链随应用启动即发起请求，避免漏计）。
 * 三类 warn 文案分别对应：050ae69 嗅探路径、跳层折叠点（嗅探/非 2xx/网络错共用尾巴）、
 * BUG-06a per-language 准备失败通道（core-parse prepare catch）。
 */
interface WarnProbe {
  /** 嗅探路径 warn（「非 JSON 资产应答（SPA fallback？）」） */
  spa: string[];
  /** 全部跳层 warn（文案含「跳过该资产层」尾巴） */
  layerSkip: string[];
  /** per-language 准备失败 warn（文案含「grammar/查询准备失败」） */
  langPrepFail: string[];
  pageErrors: string[];
}

function attachWarnProbe(page: Page): WarnProbe {
  const probe: WarnProbe = { spa: [], layerSkip: [], langPrepFail: [], pageErrors: [] };
  page.on('console', (msg) => {
    if (msg.type() !== 'warning') return;
    const text = msg.text();
    if (text.includes('非 JSON 资产应答')) probe.spa.push(text);
    if (text.includes('跳过该资产层')) probe.layerSkip.push(text);
    if (text.includes('grammar/查询准备失败')) probe.langPrepFail.push(text);
  });
  page.on('pageerror', (err) => probe.pageErrors.push(String(err)));
  return probe;
}

/** 同源 manifest（不含 CDN host）的跳层 warn：三层链在 CDN 构建下还会各自发 CDN 层请求 */
function originManifestSkips(probe: WarnProbe): string[] {
  return probe.layerSkip.filter(
    (t) => t.includes('/grammars/manifest.json') && !t.includes(CDN_ORIGIN)
  );
}

/** 命中计数 + fulfill 的组合返回：hits() 断言「场景面真的被请求过 / 未被请求」 */
interface HitCounter {
  hits: () => number;
}

/**
 * mock 同源 grammar manifest：剥离 java 条目（模拟 release lite 集不含 java），
 * 从 e2e 服务器真实清单读取后改写（防硬编码漂移）。正则负向前瞻排除 cdn host：
 * 同源 manifest 的匹配式会同时命中 CDN manifest（双星吞掉 scheme 与 host），
 * 按 origin 分流（b-grammar-layers 同款手法）。
 */
async function mockOriginManifestWithoutJava(page: Page, request: APIRequestContext): Promise<void> {
  const res = await request.get('/grammars/manifest.json');
  expect(res.ok()).toBeTruthy();
  const manifest = (await res.json()) as { grammars: Record<string, unknown> };
  delete manifest.grammars.java;
  await page.route(
    /\/\/(?!cdn\.grammars\.test).*\/grammars\/manifest\.json$/,
    (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(manifest)
      })
  );
}

/** mock 同源 manifest → 200 text/html（SPA fallback 形态本尊） */
async function mockOriginManifestSpa(page: Page): Promise<void> {
  await page.route(/\/\/(?!cdn\.grammars\.test).*\/grammars\/manifest\.json$/, (route) =>
    route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: SPA_HTML })
  );
}

/** CDN 全域 abort：不专门 mock CDN 资产的用例必须调用，杜绝未 mock CDN fetch 变真实 socket */
async function blockCdn(page: Page): Promise<void> {
  await page.route(`**/cdn.grammars.test/**`, (route) => route.abort());
}

/** CDN manifest → 合法 JSON（跨源 fulfill 必须显式 ACAO 过浏览器 CORS 检查） */
async function mockCdnManifest(
  page: Page,
  manifest: { grammars: Record<string, unknown> }
): Promise<void> {
  await page.route(`**/cdn.grammars.test/grammars/manifest.json`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify(manifest)
    })
  );
}

/** CDN manifest → 200 text/html（SPA fallback 本尊，跨源） */
async function mockCdnManifestSpa(page: Page): Promise<void> {
  await page.route(`**/cdn.grammars.test/grammars/manifest.json`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      headers: { 'access-control-allow-origin': '*' },
      body: SPA_HTML
    })
  );
}

/**
 * CDN 层 java.wasm：字节从 e2e 服务器同源 /grammars/java.wasm 读取（request 不经
 * page.route，拿到的是真实构建产物），补 CORS 头放行跨域 fetch；返回命中计数器。
 */
async function mockCdnJavaWasm(page: Page, request: APIRequestContext): Promise<HitCounter> {
  const wasmRes = await request.get('/grammars/java.wasm');
  expect(wasmRes.ok()).toBeTruthy();
  const wasmBody = await wasmRes.body();
  let hits = 0;
  await page.route(`**/cdn.grammars.test/grammars/java.wasm`, (route) => {
    hits++;
    return route.fulfill({
      status: 200,
      contentType: 'application/wasm',
      headers: { 'access-control-allow-origin': '*' },
      body: wasmBody
    });
  });
  return { hits: () => hits };
}

/** 同源单资产 → 200 text/html（wasm / 查询 .scm 共用的 SPA fallback 注入面，带计数） */
async function mockOriginAssetSpa(page: Page, urlPattern: RegExp): Promise<HitCounter> {
  let hits = 0;
  await page.route(urlPattern, (route) => {
    hits++;
    return route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: SPA_HTML
    });
  });
  return { hits: () => hits };
}

/** 同源单资产命中计数 + 放行真实网络：证明资产面照常被请求且拿到真实产物 */
async function countOriginAsset(page: Page, urlPattern: RegExp): Promise<HitCounter> {
  let hits = 0;
  await page.route(urlPattern, (route) => {
    hits++;
    return route.continue();
  });
  return { hits: () => hits };
}

test('GRF-01: CDN manifest 200 text/html → 嗅探跳层「非 JSON 资产应答」warn 恰一条不误报网络错，java 降级 hljs 不崩（BUG-106/050ae69）', async ({
  page,
  request
}) => {
  test.setTimeout(60_000);
  const probe = attachWarnProbe(page);
  // java 唯一来源是 CDN 层（同源 manifest 剥离 java）；CDN manifest 被 SPA fallback；
  // CDN java.wasm 计数（期望恒 0：HTML 未被当 JSON 解析 → manifest 无 java 条目）
  await mockOriginManifestWithoutJava(page, request);
  await mockCdnManifestSpa(page);
  const cdnWasm = await mockCdnJavaWasm(page, request);

  await page.goto('/');
  await openDir(page, [{ name: 'Hello.java', type: 'text/x-java-source', content: JAVA_SRC }]);
  await openFile(page, 'Hello.java');

  // 嗅探路径 warn 恰一条（恒 0 时排查构建是否注入 VV_GRAMMAR_CDN——CDN 层未发请求则无嗅探面）
  await expect
    .poll(() => probe.spa.length, {
      timeout: 20_000,
      message:
        '等待 CDN manifest 嗅探跳层 warn。恒 0 时排查构建是否注入 VV_GRAMMAR_CDN=https://cdn.grammars.test/grammars/（未注入则 CDN 层不发起请求）'
    })
    .toBe(1);
  // 050ae69 修复文案（「非 JSON 资产应答」），而非修复前误报的网络错误导（catch 的「加载失败」）
  expect(probe.spa[0]).toContain('非 JSON 资产应答（SPA fallback？）');
  expect(probe.spa[0]).not.toContain('加载失败');
  // HTML 未被当 JSON 解析的行为学判据：manifest 无 java 条目 → 不发起 java.wasm 请求
  expect(cdnWasm.hits()).toBe(0);
  // java 无来源 → hljs 兜底渲染，如实落定 ok=false
  await expect(page.locator('.vv-statusbar')).toContainText('高亮: hljs 兜底', { timeout: 30_000 });
  await expect
    .poll(() => lastHighlight(page), { timeout: 30_000, message: '等待 java 高亮失败落定（ok=false）' })
    .toEqual({ ok: false, lang: 'java' });
  // 页面无崩溃：正文照常渲染、无错误卡片、无未捕获异常
  await expect(page.locator('.vv-code-pre')).toContainText('greet', { timeout: 20_000 });
  await expect(page.locator('.vv-error-card')).toHaveCount(0);
  expect(probe.pageErrors).toEqual([]);
});

test('GRF-02: 同源 manifest 200 text/html → 层缺失跳过，CDN 层兜底照常（first-wins 跨层不受嗅探影响），java tree-sitter 生效（BUG-106）', async ({
  page,
  request
}) => {
  test.setTimeout(60_000);
  const probe = attachWarnProbe(page);
  // 同源 manifest 被 SPA fallback；java 只能来自 CDN 层。同源 java.wasm 一并 404
  // （防御：若合并/加载意外回落同源将在此暴露而非假绿）
  await mockOriginManifestSpa(page);
  await page.route(/\/\/(?!cdn\.grammars\.test).*\/grammars\/java\.wasm$/, (route) =>
    route.fulfill({ status: 404, body: 'not found' })
  );
  await mockCdnManifest(page, { grammars: { java: { file: 'java.wasm', aliases: [] } } });
  const cdnWasm = await mockCdnJavaWasm(page, request);

  await page.goto('/');
  await openDir(page, [{ name: 'Hello.java', type: 'text/x-java-source', content: JAVA_SRC }]);
  await openFile(page, 'Hello.java');

  // 同源层被嗅探跳过（不误载 HTML），CDN 层兜底：tree-sitter 生效
  await expect
    .poll(() => lastHighlight(page), {
      timeout: 30_000,
      message:
        '等待 java 高亮成功。ok 恒 false 时排查构建是否注入 VV_GRAMMAR_CDN=https://cdn.grammars.test/grammars/（未注入则同源层缺失后 java 无来源）'
    })
    .toEqual({ ok: true, lang: 'java' });
  await expect(page.locator('.vv-statusbar')).toContainText('高亮: tree-sitter', { timeout: 30_000 });
  // CDN 兜底确证：wasm 确实从 mock CDN 取到
  expect(cdnWasm.hits()).toBeGreaterThanOrEqual(1);
  // 同源层缺失语义照常成立：嗅探 warn 恰一条（缺失≠崩溃，层照常跳过）
  await expect
    .poll(() => probe.spa.length, { timeout: 20_000, message: '等待同源 manifest 嗅探跳层 warn' })
    .toBe(1);
  expect(probe.spa[0]).toContain('非 JSON 资产应答（SPA fallback？）');
  await expect(page.locator('.vv-error-card')).toHaveCount(0);
  expect(probe.pageErrors).toEqual([]);
});

test('GRF-03: 同源 java.wasm 被 HTML 兜底 → WebAssembly 实例化失败被捕获，整语言降级 hljs 不崩、per-language warn 恰一条（BUG-106）', async ({
  page
}) => {
  test.setTimeout(60_000);
  const probe = attachWarnProbe(page);
  // manifest 走真实同源（application/json，lite 集含 java）；仅 wasm 资产被 SPA fallback；
  // CDN 层不专门 mock，全域 abort 杜绝真实 socket
  await blockCdn(page);
  const wasm = await mockOriginAssetSpa(page, /\/\/(?!cdn\.grammars\.test).*\/grammars\/java\.wasm$/);

  await page.goto('/');
  await openDir(page, [{ name: 'Hello.java', type: 'text/x-java-source', content: JAVA_SRC }]);
  await openFile(page, 'Hello.java');

  // wasm 实例化失败被捕获（BUG-06a per-language 通道恰一条：prepared 按语言缓存）
  await expect
    .poll(() => probe.langPrepFail.length, { timeout: 30_000, message: '等待语言准备失败的 console.warn' })
    .toBe(1);
  expect(probe.langPrepFail[0]).toContain('java');
  // 场景确证（在流水线落定后读）：java.wasm 真的被请求且拿到的是 HTML 兜底
  expect(wasm.hits()).toBeGreaterThanOrEqual(1);
  // 整语言降级 hljs 兜底，不误报成功
  await expect(page.locator('.vv-statusbar')).toContainText('高亮: hljs 兜底', { timeout: 30_000 });
  await expect
    .poll(() => lastHighlight(page), { timeout: 30_000, message: '等待 java 高亮失败落定（ok=false）' })
    .toEqual({ ok: false, lang: 'java' });
  // 页面无崩溃：正文照常渲染（hljs 着色 span 在场）、无错误卡片、无未捕获异常
  await expect(page.locator('.vv-code-pre')).toContainText('greet', { timeout: 20_000 });
  await expect(page.locator('.vv-code-pre span[class^="hljs-"]').first()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.vv-error-card')).toHaveCount(0);
  expect(probe.pageErrors).toEqual([]);
});

test('GRF-04: 查询 injections.scm 200 text/html → 视同缺失，highlights.scm 照常加载，java 仍 tree-sitter 不整降级（BUG-106/7fab3a5 前端层）', async ({
  page
}) => {
  test.setTimeout(60_000);
  const probe = attachWarnProbe(page);
  await blockCdn(page);
  // java injections.scm 被 SPA fallback；highlights.scm 计数放行（真实构建产物）
  const injections = await mockOriginAssetSpa(
    page,
    /\/\/(?!cdn\.grammars\.test).*\/queries\/java\/injections\.scm$/
  );
  const highlights = await countOriginAsset(
    page,
    /\/\/(?!cdn\.grammars\.test).*\/queries\/java\/highlights\.scm$/
  );

  await page.goto('/');
  await openDir(page, [{ name: 'Hello.java', type: 'text/x-java-source', content: JAVA_SRC }]);
  await openFile(page, 'Hello.java');

  // java 仍 tree-sitter：injections 缺席不炸 Query 编译、不整语言降级
  await expect
    .poll(() => lastHighlight(page), {
      timeout: 30_000,
      message: '等待 java 高亮成功（injections 缺席不得整语言降级；恒 false 时查 7fab3a5 前端层回归）'
    })
    .toEqual({ ok: true, lang: 'java' });
  // 场景确证（在高亮落定后读，避免与惰性 query fetch 竞速）：
  // injections.scm 真的被请求且拿到 HTML（嗅探面真的被走过）、highlights.scm 照常加载
  expect(injections.hits()).toBeGreaterThanOrEqual(1);
  expect(highlights.hits()).toBeGreaterThanOrEqual(1);
  await expect(page.locator('.vv-statusbar')).toContainText('高亮: tree-sitter', { timeout: 30_000 });
  await expect(page.locator('.vv-code-pre span[class^="ts-"]').first()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.vv-code-pre span[class^="hljs-"]')).toHaveCount(0);
  // 无整语言降级痕迹：per-language 准备失败 warn 为零（HTML 未被误载为查询文本）
  expect(probe.langPrepFail).toEqual([]);
  await expect(page.locator('.vv-error-card')).toHaveCount(0);
  expect(probe.pageErrors).toEqual([]);
});

test('GRF-05: 正常 application/json manifest 零误伤——同源不 mock（真实清单），rust tree-sitter 生效、零 grammar warn（回归护栏）', async ({
  page
}) => {
  test.setTimeout(60_000);
  const probe = attachWarnProbe(page);
  // CDN 构建下三层链恒发 CDN manifest 请求：mock 为合法空 JSON（同走 application/json
  // 正锚路径），避免不 mock 时打真实 socket（环境遗留观察，见头注）
  await mockCdnManifest(page, { grammars: {} });

  await page.goto('/');
  await openDir(page, [{ name: 'sample.rs', type: 'text/x-rust', content: RUST_SRC }]);
  await openFile(page, 'sample.rs');

  // 嗅探零误伤：manifest 正常解析、tree-sitter 生效
  await expect
    .poll(() => lastHighlight(page), { timeout: 30_000, message: '等待 rust 高亮成功' })
    .toEqual({ ok: true, lang: 'rust' });
  await expect(page.locator('.vv-statusbar')).toContainText('高亮: tree-sitter', { timeout: 30_000 });
  await expect(page.locator('.vv-code-pre span[class^="ts-"]').first()).toBeVisible({ timeout: 20_000 });
  // 零 grammar 噪声：嗅探/跳层/准备失败三类 warn 全零
  expect(probe.spa).toEqual([]);
  expect(probe.layerSkip).toEqual([]);
  expect(probe.langPrepFail).toEqual([]);
  await expect(page.locator('.vv-error-card')).toHaveCount(0);
  expect(probe.pageErrors).toEqual([]);
});

test('GRF-06: 同源 manifest 200 无 content-type + HTML body → 走 JSON.parse 失败 catch 等价层缺失，不误当条目（不发起 wasm 请求）', async ({
  page
}) => {
  test.setTimeout(60_000);
  const probe = attachWarnProbe(page);
  await blockCdn(page);
  // 无 content-type 头（route.fulfill 不带 contentType → 响应无该头）：嗅探分支不触发，
  // 落 res.json() SyntaxError catch——与嗅探缺失等价的层缺失形态
  await page.route(/\/\/(?!cdn\.grammars\.test).*\/grammars\/manifest\.json$/, (route) =>
    route.fulfill({ status: 200, body: SPA_HTML })
  );
  // java.wasm 计数（期望恒 0：HTML body 未被误当 manifest 条目 → java 无条目可加载）
  const wasm = await mockOriginAssetSpa(page, /\/\/(?!cdn\.grammars\.test).*\/grammars\/java\.wasm$/);

  await page.goto('/');
  await openDir(page, [{ name: 'Hello.java', type: 'text/x-java-source', content: JAVA_SRC }]);
  await openFile(page, 'Hello.java');

  // 同源 manifest 的 catch 路径 warn 恰一条（「加载失败」catch 文案，非嗅探文案）
  await expect
    .poll(() => originManifestSkips(probe).length, {
      timeout: 20_000,
      message: '等待同源 manifest 的 catch 路径跳层 warn'
    })
    .toBe(1);
  expect(originManifestSkips(probe)[0]).toContain('加载失败，跳过该资产层');
  expect(originManifestSkips(probe)[0]).not.toContain('非 JSON 资产应答');
  // HTML body 未被误当 manifest 条目的行为学判据：不发起 java.wasm 请求
  expect(wasm.hits()).toBe(0);
  // 等价层缺失：java 降级 hljs 兜底，页面不崩
  await expect(page.locator('.vv-statusbar')).toContainText('高亮: hljs 兜底', { timeout: 30_000 });
  await expect
    .poll(() => lastHighlight(page), { timeout: 30_000, message: '等待 java 高亮失败落定（ok=false）' })
    .toEqual({ ok: false, lang: 'java' });
  await expect(page.locator('.vv-code-pre')).toContainText('greet', { timeout: 20_000 });
  await expect(page.locator('.vv-error-card')).toHaveCount(0);
  expect(probe.pageErrors).toEqual([]);
});

test('GRF-07: SPA-fallback 层缺失 warn 每层每会话恰一条——连续打开第二个 java 文件不重复刷屏，第二文件照常渲染', async ({
  page,
  request
}) => {
  test.setTimeout(60_000);
  const probe = attachWarnProbe(page);
  // GRF-01 同款场景：CDN manifest 被 SPA fallback，java 唯一来源缺失
  await mockOriginManifestWithoutJava(page, request);
  await mockCdnManifestSpa(page);

  await page.goto('/');
  await openDir(page, [
    { name: 'Hello.java', type: 'text/x-java-source', content: JAVA_SRC },
    { name: 'World.java', type: 'text/x-java-source', content: JAVA_SRC_2 }
  ]);
  await openFile(page, 'Hello.java');
  await expect(page.locator('.vv-statusbar')).toContainText('高亮: hljs 兜底', { timeout: 30_000 });

  // 会话内换文件（新 tab）：资产链为 create() 单例，不随文件切换重跑
  await openFile(page, 'World.java');
  await expect(page.locator('.vv-code-pre')).toContainText('farewell', { timeout: 20_000 });
  await expect
    .poll(() => lastHighlight(page), { timeout: 30_000, message: '等待第二个文件高亮失败落定' })
    .toEqual({ ok: false, lang: 'java' });

  // 不重复刷屏：两次文件打开后嗅探 warn 仍恰一条（每层每会话恰一次）
  expect(probe.spa).toHaveLength(1);
  expect(probe.spa[0]).toContain('非 JSON 资产应答（SPA fallback？）');
  expect(probe.pageErrors).toEqual([]);
});

test('GRF-08: 查询缺失只降级涉事语言——java injections.scm 被 HTML 兜底仍 tree-sitter，rust 完全不受影响无交叉污染', async ({
  page
}) => {
  test.setTimeout(60_000);
  const probe = attachWarnProbe(page);
  await blockCdn(page);
  // 仅 java 的 injections.scm 被 SPA fallback；rust 查询目录真实照常
  await mockOriginAssetSpa(page, /\/\/(?!cdn\.grammars\.test).*\/queries\/java\/injections\.scm$/);

  await page.goto('/');
  await openDir(page, [
    { name: 'Hello.java', type: 'text/x-java-source', content: JAVA_SRC },
    { name: 'sample.rs', type: 'text/x-rust', content: RUST_SRC }
  ]);

  // java：injections 缺席仍 tree-sitter（GRF-04 判据）
  await openFile(page, 'Hello.java');
  await expect
    .poll(() => lastHighlight(page), { timeout: 30_000, message: '等待 java 高亮成功' })
    .toEqual({ ok: true, lang: 'java' });
  await expect(page.locator('.vv-code-pre span[class^="ts-"]').first()).toBeVisible({ timeout: 20_000 });

  // rust：涉事语言外的隔离性——自身查询真实加载，tree-sitter 生效且正文为 rust 本尊
  await openFile(page, 'sample.rs');
  await expect
    .poll(() => lastHighlight(page), { timeout: 30_000, message: '等待 rust 高亮成功' })
    .toEqual({ ok: true, lang: 'rust' });
  await expect(page.locator('.vv-code-pre')).toContainText('add(1, 2)', { timeout: 20_000 });
  await expect(page.locator('.vv-code-pre span[class^="ts-"]').first()).toBeVisible({ timeout: 20_000 });

  // 隔离性：java 的查询缺失未波及任何语言准备（rust 的 injections.scm 真实到场）
  expect(probe.langPrepFail).toEqual([]);
  await expect(page.locator('.vv-error-card')).toHaveCount(0);
  expect(probe.pageErrors).toEqual([]);
});
