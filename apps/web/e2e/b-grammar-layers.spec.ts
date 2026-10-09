import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { closeDrawerIfOpened, openDrawerIfNarrow } from './drawer';

/**
 * b-grammar-layers E2E（P2 资产三层解析链，spec §3）：grammar manifest 按
 * 同源 → 服务端 → CDN 逐层 fetch、first-wins 合并、失败层跳过（grammarLayers.ts）。
 * 本 spec 验证其中同源/CDN 两层的端到端行为——mock CDN（page.route），不依赖外网。
 *
 * 构建期前提（test.beforeAll 口径说明）：bundle 必须以
 *   VV_GRAMMAR_CDN=https://cdn.grammars.test/grammars/ pnpm build
 * 构建（本地手工执行；CI e2e job 的 build 步骤已设同名 env）。该值经 vite define
 * 静态替换进 highlightClient.ts，未注入时 CDN 层不会发起任何请求——用例 1 的
 * CDN 命中计数断言即构建注入的运行时守卫。
 *
 * 布局契约（base = 同时容纳 manifest.json 与 *.wasm 的目录前缀，以 / 结尾）：
 * CDN base 为 https://cdn.grammars.test/grammars/，故 mock 路径含 /grammars/ 段。
 *
 * java 的角色：同源 manifest 经 mock 剥离 java 条目（模拟 release lite 语言集不含
 * java 的场景），java 成为「仅 CDN 层提供」的语言。查询仍取同源 /queries/java/
 *（CDN 层只供 wasm，queriesBase 恒同源——分层链契约）。
 *
 * serviceWorkers: 'block'：PWA SW 对 /grammars/*.wasm（含 CDN URL，路径同含该段）
 * 注册了 CacheFirst，而 page.route 拦不到经 SW fetch handler 放行/转发的请求
 *（Playwright 已知边界）——SW 激活时机会使 mock 随机失效。本 spec 只验资产分层
 * 链（SW 离线行为归 fix-pwa.spec），屏蔽 SW 求确定性：注册失败被 workbox-window
 * 捕获（registerSW catch），页面功能不受影响。
 */
test.use({ serviceWorkers: 'block' });

/** CDN origin / base（base 含 /grammars/ 目录段，与 VV_GRAMMAR_CDN 构建值一致） */
const CDN_ORIGIN = 'https://cdn.grammars.test';
const CDN_BASE = `${CDN_ORIGIN}/grammars/`;

/** 用例载入的 .java 文件内容（短小、语法特征明确：tree-sitter 与 hljs 均可识别） */
const JAVA_SRC = [
  'package com.vviewer.demo;',
  '',
  'public class Hello {',
  '    public static String greet(String name) {',
  '        return "hello " + name;',
  '    }',
  '}'
].join('\n');

interface FilePayload {
  name: string;
  type: string;
  content: string;
}

/** 通道同 m1-m3：页面内 File + webkitRelativePath 经 __vvOpenDirImpl 注入（本地 store） */
async function openDir(page: Page, payloads: FilePayload[]): Promise<void> {
  await page.waitForFunction(
    () => typeof (window as unknown as { __vvOpenDirImpl?: unknown }).__vvOpenDirImpl === 'function'
  );
  await page.evaluate((payloads) => {
    const files = payloads.map(({ name, type, content }) => {
      const f = new File([content], name, { type });
      Object.defineProperty(f, 'webkitRelativePath', { value: `bgl/${name}` });
      return f;
    });
    return (window as unknown as { __vvOpenDirImpl: (f: File[]) => void }).__vvOpenDirImpl(files);
  }, payloads);
}

async function openFile(page: Page, name: string): Promise<void> {
  const drawer = await openDrawerIfNarrow(page);
  await page.locator('.vv-tree-row').filter({ hasText: name }).click();
  await closeDrawerIfOpened(page, drawer);
  await expect(page.locator('.vv-tab.active', { hasText: name })).toBeVisible();
}

/**
 * mock 同源 grammar manifest：剥离 java 条目（模拟 lite 集不含 java）。
 * 正则负向前瞻排除 cdn host：双星开头的同源 manifest glob（以 /grammars/manifest.json
 * 结尾）会同时命中 CDN manifest（双星吞掉 scheme 与 host），这里按 origin 分流。
 * 注意：块注释内不得出现星号紧跟斜杠的序列（会提前闭合注释），描述 glob 时用文字。
 */
async function mockOriginManifestWithoutJava(
  page: Page,
  request: APIRequestContext
): Promise<void> {
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

test('分层链用例 1：同源缺失 java（lite 场景）→ CDN 层兜底，tree-sitter 高亮生效', async ({
  page,
  request
}) => {
  test.setTimeout(60_000);
  let cdnWasmHits = 0;
  // 同源 manifest 剥离 java；同源 java.wasm 一并 404（防御：java 资产只能来自 CDN 层，
  // 若合并/加载意外回落同源将在此暴露而非假绿）
  await mockOriginManifestWithoutJava(page, request);
  await page.route(
    /\/\/(?!cdn\.grammars\.test).*\/grammars\/java\.wasm$/,
    (route) => route.fulfill({ status: 404, body: 'not found' })
  );
  // CDN 层 manifest（base 契约：manifest 与 wasm 同目录，路径含 /grammars/ 段）。
  // 跨源 fetch 的 fulfill 响应同样过浏览器 CORS 检查——必须显式带 allow-origin
  await page.route(`**/cdn.grammars.test/grammars/manifest.json`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify({ grammars: { java: { file: 'java.wasm', aliases: [] } } })
    })
  );
  // CDN 层 wasm：字节从 e2e 服务器同源 /grammars/java.wasm 读取（request 不经
  // page.route，拿到的是真实构建产物；不读盘），补 CORS 头放行跨域 fetch
  const wasmRes = await request.get('/grammars/java.wasm');
  expect(wasmRes.ok()).toBeTruthy();
  const wasmBody = await wasmRes.body();
  await page.route(`**/cdn.grammars.test/grammars/java.wasm`, (route) => {
    cdnWasmHits++;
    return route.fulfill({
      status: 200,
      contentType: 'application/wasm',
      headers: { 'access-control-allow-origin': '*' },
      body: wasmBody
    });
  });

  await page.goto('/');
  await openDir(page, [{ name: 'Hello.java', type: 'text/x-java-source', content: JAVA_SRC }]);
  await openFile(page, 'Hello.java');

  // tree-sitter 生效（状态栏引擎段 + where=local），last-highlight 调试口径 ok=true
  await expect(page.locator('.vv-statusbar')).toContainText('高亮: tree-sitter', { timeout: 30_000 });
  await expect(page.locator('.vv-statusbar')).toContainText('本地', { timeout: 10_000 });
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const dbg = window as unknown as { __vvLastHighlightOk?: boolean; __vvLastHighlightLang?: string };
          return { ok: dbg.__vvLastHighlightOk, lang: dbg.__vvLastHighlightLang };
        }),
      {
        timeout: 30_000,
        message:
          '等待 java 高亮成功。ok 恒 false 时排查构建是否注入 VV_GRAMMAR_CDN=https://cdn.grammars.test/grammars/（未注入则 CDN 层不发起请求，java 无来源）'
      }
    )
    .toEqual({ ok: true, lang: 'java' });
  // CDN 兜底确证：wasm 确实从 mock CDN 取到（预热与 worker 加载至少一次经此路由）
  expect(cdnWasmHits).toBeGreaterThanOrEqual(1);
  // 无错误卡片（分层链成功路径不产生任何降级痕迹）
  await expect(page.locator('.vv-error-card')).toHaveCount(0);
});

test('分层链用例 2：CDN manifest 不可达 → 跳层 console.warn 一条，java 降级 hljs 且页面不崩溃', async ({
  page,
  request
}) => {
  test.setTimeout(60_000);
  const layerSkips: string[] = [];
  const pageErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'warning' && msg.text().includes('跳过该资产层')) layerSkips.push(msg.text());
  });
  page.on('pageerror', (err) => pageErrors.push(String(err)));

  // java 唯一来源是 CDN 层（同源 manifest 剥离）；CDN 全部 abort 模拟不可达外网
  await mockOriginManifestWithoutJava(page, request);
  await page.route('**/cdn.grammars.test/**', (route) => route.abort());

  await page.goto('/');
  await openDir(page, [{ name: 'Hello.java', type: 'text/x-java-source', content: JAVA_SRC }]);
  await openFile(page, 'Hello.java');

  // 跳层语义：CDN 层失败仅 warn 一条，不阻塞渲染（同源层正常，页面可用）
  await expect
    .poll(() => layerSkips.length, { timeout: 20_000, message: '等待 CDN 层跳过的 console.warn' })
    .toBe(1);
  // java 降级：tree-sitter 无 java 来源 → hljs 兜底渲染，last-highlight 如实 ok=false
  await expect(page.locator('.vv-statusbar')).toContainText('高亮: hljs 兜底', { timeout: 30_000 });
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const dbg = window as unknown as { __vvLastHighlightOk?: boolean; __vvLastHighlightLang?: string };
          return { ok: dbg.__vvLastHighlightOk, lang: dbg.__vvLastHighlightLang };
        }),
      { timeout: 30_000, message: '等待 java 高亮失败落定（ok=false）' }
    )
    .toEqual({ ok: false, lang: 'java' });
  // 页面无崩溃：正文照常渲染、无错误卡片、无未捕获异常
  await expect(page.locator('.vv-code-pre')).toContainText('greet', { timeout: 20_000 });
  await expect(page.locator('.vv-error-card')).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});
