import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { openDirText, waitAppMounted } from './helpers';
import { realPptx } from './pptx-fixture';
import { openTreeFile } from './b-markdown-html-docs-helpers';
import { openCdnGroup, setEnginesCdnCustom, setForeignCdnCustom, setGrammarCdnCustom } from './settings-center';

/**
 * b-cdn-profiles（spec C §3.2，Task 5 CDNP 域）：settings.cdn 三作用面档位切换的
 * 端到端行为——设置中心改档应用后的运行时消费翻转。
 *
 * - CDNP-01 grammars default→custom：应用触发 highlightClient 重建（AppShell 订阅
 *   diff），CDN 层请求 URL 翻转到新 origin（page.route 计数）；
 * - CDNP-02 custom 输入实时校验错误态（role="status" 行，settings.cdn.grammarsError）；
 * - CDNP-03 engines custom host 注入**免刷新**生效：AppShell engines 两字段 diff 的
 *   派发 + rev++ 重渲染通道（CDN 引擎图命中新 host——本锚的验证对象）；
 * - CDNP-04 foreign custom base **保存→刷新**生效（装配级快照拍板语义）：刷新后
 *   重新装配读到新档，资产请求命中 custom 域；
 * - CDNP-05 档位切换后重建生效：切档前 hljs（CDN 不可达）→ 切档后新渲染 tree-sitter。
 *
 * serviceWorkers: 'block'（b-grammar-layers 同口径）：本 spec 只验应用层请求面与
 * 运行时翻转（SW 跨域请求不经 page.route，行为锚归 b-sw-runtime-cache）。
 *
 * 构建期前提：bundle 以 VV_GRAMMAR_CDN=https://cdn.grammars.test/grammars/ 构建
 * （CI e2e job 已设）——CDNP-05 的「切档前 CDN 不可达」即此 mock host abort。
 */
test.use({ serviceWorkers: 'block' });

const JAVA_SRC = [
  'package com.vviewer.demo;',
  '',
  'public class Hello {',
  '    public static String greet(String name) {',
  '        return "hello " + name;',
  '    }',
  '}'
].join('\n');

const JAVA2_SRC = JAVA_SRC.replace('Hello', 'Hello2');

/** excalidraw +esm 最小 stub（CDNP-03）：renderExcalidrawCdn 调 exportToSvg({data})
 * → 返回带探针标记的 svg——渲染成功即证明引擎从 custom 域加载（真引擎字节不在
 * e2e 可达面，stub 满足「import 自 custom 域并产出 SVG」的锚定语义）。 */
const EXCALIDRAW_STUB = [
  'export async function exportToSvg(opts) {',
  `  return { outerHTML: '<svg data-cdn-custom="hit"><text>stub</text></svg>' };`,
  '}'
].join('\n');

/** mock 子包路由（CDNP-01/05）：manifest 与 wasm 各自伺服，命中记录供 URL 断言 */
async function mockCdnOrigin(
  page: Page,
  host: string,
  wasmBytes: Buffer,
  hits: string[],
  opts: { abort?: boolean } = {}
): Promise<void> {
  await page.route(`**/${host}/**`, (route) => {
    const url = route.request().url();
    hits.push(url);
    if (opts.abort) return route.abort();
    if (url.endsWith('/grammars/manifest.json')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify({ grammars: { java: { file: 'java.wasm', aliases: [] } } })
      });
    }
    if (url.endsWith('/grammars/java.wasm')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/wasm',
        headers: { 'access-control-allow-origin': '*' },
        body: wasmBytes
      });
    }
    return route.abort();
  });
}

/** 同源 manifest 剥离 java（java 只能来自 CDN 档；mockOriginManifestWithoutJava 同源） */
async function mockOriginWithoutJava(page: Page, request: APIRequestContext): Promise<void> {
  const res = await request.get('/grammars/manifest.json');
  expect(res.ok()).toBeTruthy();
  const manifest = (await res.json()) as { grammars: Record<string, unknown> };
  delete manifest.grammars.java;
  await page.route(/\/\/(?!cdn\.grammars\.test).*\/grammars\/manifest\.json$/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(manifest) })
  );
}

async function waitHighlightResult(page: Page, expected: { ok: boolean; lang: string }, message: string): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const dbg = window as unknown as { __vvLastHighlightOk?: boolean; __vvLastHighlightLang?: string };
          return { ok: dbg.__vvLastHighlightOk, lang: dbg.__vvLastHighlightLang };
        }),
      { timeout: 30_000, message }
    )
    .toEqual(expected);
}

test.describe('b-cdn-profiles 档位切换（spec C §3.2 CDNP 域）', () => {
  test('CDNP-01 grammars default→custom：应用触发重建，CDN 层请求翻转到新 origin（page.route 计数）', async ({
    page,
    request
  }) => {
    test.setTimeout(90_000);
    const c1Hits: string[] = [];
    await mockOriginWithoutJava(page, request);
    const javaWasm = await (await request.get('/grammars/java.wasm')).body();
    await mockCdnOrigin(page, 'cdn-c1.grammars.test', javaWasm, c1Hits);

    await page.goto('/');
    await waitAppMounted(page);
    // 切档（应用）→ rebuildHighlightClient → 新 client 以 custom base 装配
    await setGrammarCdnCustom(page, 'https://cdn-c1.grammars.test/grammars/');
    await openDirText(page, 'cdnp1', 'Hello.java', JAVA_SRC);
    await openTreeFile(page, 'Hello.java');
    await expect(page.locator('.vv-statusbar')).toContainText('高亮: tree-sitter', { timeout: 30_000 });
    await waitHighlightResult(
      page,
      { ok: true, lang: 'java' },
      '等待 java 高亮成功（custom 档新 origin wasm）'
    );
    // CDN 层请求 URL 断言：新 origin 命中（manifest+wasm），旧构建期 origin 零命中
    expect(c1Hits.some((u) => u.endsWith('/grammars/manifest.json')), 'custom origin manifest 命中').toBe(true);
    expect(c1Hits.some((u) => u.endsWith('/grammars/java.wasm')), 'custom origin wasm 命中').toBe(true);
    await expect(page.locator('.vv-error-card')).toHaveCount(0);
  });

  test('CDNP-02 custom 输入实时校验：非 /grammars/ 结尾显示 role="status" 错误行（不静默吞）', async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto('/');
    await waitAppMounted(page);
    await openCdnGroup(page);
    await page.getByLabel('语法高亮 CDN 档位').selectOption('custom');
    await page.getByLabel('语法高亮自定义地址').fill('https://bad.test/wasm/');
    const errorRow = page.locator('.vv-settings-note', { hasText: '地址不合法' });
    await expect(errorRow).toBeVisible();
    // 正确形态即时消错（实时校验双向）
    await page.getByLabel('语法高亮自定义地址').fill('https://good.test/grammars/');
    await expect(errorRow).toHaveCount(0);
    // 放弃草稿（脏态确认条「放弃」通道），不落盘
    await page.keyboard.press('Escape');
    await page.locator('.vv-sc-confirm').getByRole('button', { name: '放弃' }).click();
    await expect(page.locator('.vv-settings-center')).toHaveCount(0);
  });

  test('CDNP-03 engines custom host 注入免刷新：excalidraw 围栏改档应用后请求命中 custom 域并出图', async ({
    page
  }) => {
    test.setTimeout(90_000);
    const engineHits: string[] = [];
    // custom 引擎域 stub：import 自 custom 域产出探针 SVG（真引擎字节不在离线可达面）
    await page.route('**/cdn-engines.test/**', (route) => {
      engineHits.push(route.request().url());
      return route.fulfill({
        status: 200,
        contentType: 'text/javascript',
        headers: { 'access-control-allow-origin': '*' },
        body: EXCALIDRAW_STUB
      });
    });
    // 离线 jsdelivr（改档前 local 引擎走缺省 jsdelivr → 拉不到 → 图渲染失败落错误卡）
    await page.route('**/cdn.jsdelivr.net/**', (route) => route.abort());

    await page.goto('/');
    await waitAppMounted(page);
    // 先打开 md（excalidraw 围栏，local 引擎）——图渲染失败（jsdelivr 离线）
    const MD = [
      '# cdnp3',
      '',
      '```excalidraw',
      '{"elements":[],"appState":{},"files":null}',
      '```',
      ''
    ].join('\n');
    await openDirText(page, 'cdnp3', 'diagram.md', MD);
    await openTreeFile(page, 'diagram.md');
    await expect(page.locator('.vv-markdown')).toBeVisible({ timeout: 20_000 });

    // 改档应用（不刷新）——AppShell engines 两字段 diff 派发 + rev++ 重渲染通道
    await setEnginesCdnCustom(page, 'https://cdn-engines.test/npm/');

    // 重渲染后 excalidraw 从 custom 域加载并产出探针 SVG（免刷新命中——本锚验证对象）
    await expect(page.locator('.vv-markdown [data-cdn-custom="hit"]')).toBeVisible({ timeout: 30_000 });
    expect(
      engineHits.some((u) => u.includes('/@excalidraw/utils@0.1.5/+esm')),
      `引擎 import 命中 custom 域（实得 ${JSON.stringify(engineHits)}）`
    ).toBe(true);
  });

  test('CDNP-04 foreign custom base 保存→刷新生效：刷新后重新装配，资产请求命中 custom 域', async ({ page }) => {
    test.setTimeout(90_000);
    const foreignHits: string[] = [];
    // 最小假资产域：伺服 404（渲染失败可接受）——锚是「资产请求 URL 命中 custom 域」
    await page.route('**/foreign-custom.test/**', (route) => {
      foreignHits.push(route.request().url());
      return route.fulfill({ status: 404, headers: { 'access-control-allow-origin': '*' }, body: 'no asset' });
    });
    // 缺省 jsdelivr foreign 域 abort（切档前的资产面不可达，防兜底请求混淆）
    await page.route('**/cdn.jsdelivr.net/npm/@file-viewer/**', (route) => route.abort());

    await page.goto('/');
    await waitAppMounted(page);
    // 保存 foreign custom（不刷新不生效——装配级快照拍板语义）
    await setForeignCdnCustom(page, 'https://foreign-custom.test/viewer/');
    // 刷新 → 重新装配读到新档
    await page.reload();
    await waitAppMounted(page);
    // 打开 pptx（真 PPTX 夹具运行时构造——presentation 组必拉 assets-standard vendor
    // 资产；docx 渲染为纯 bundle JS 无 CDN 资产拉取面，不触发基座请求）
    const pptxBytes = realPptx(['CDNP-04 触发页']);
    await page.evaluate((bytes) => {
      const f = new File([new Uint8Array(bytes)], 'cdnp4.pptx', {
        type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
      });
      Object.defineProperty(f, 'webkitRelativePath', { value: 'cdnp4/cdnp4.pptx' });
      return (window as unknown as { __vvOpenDirImpl: (f: File[]) => void }).__vvOpenDirImpl([f]);
    }, [...pptxBytes]);
    await openTreeFile(page, 'cdnp4.pptx');
    // foreign 资产请求命中 custom 域（渲染结果不限——错误卡承接 404 资产）
    await expect
      .poll(() => foreignHits.length, { timeout: 30_000, message: '等待 foreign 资产请求命中 custom 域' })
      .toBeGreaterThanOrEqual(1);
  });

  test('CDNP-05 档位切换后重建生效：切档前 CDN 不可达 hljs 兜底 → 切档后新渲染 tree-sitter 翻转', async ({
    page,
    request
  }) => {
    test.setTimeout(120_000);
    const c1Hits: string[] = [];
    await mockOriginWithoutJava(page, request);
    const javaWasm = await (await request.get('/grammars/java.wasm')).body();
    // 构建期缺省 origin abort（初始 client 装配时 CDN 层不可达 → java 无来源）
    await mockCdnOrigin(page, 'cdn.grammars.test', javaWasm, [], { abort: true });
    await mockCdnOrigin(page, 'cdn-c1.grammars.test', javaWasm, c1Hits);

    await page.goto('/');
    await waitAppMounted(page);
    // 单次注入两文件（二次 openDirText 注入不落树——openTreeFile 等不到行）
    await page.evaluate(
      ({ a, b }) => {
        const mk = (n: string, t: string, c: string): File => {
          const f = new File([c], n, { type: t });
          Object.defineProperty(f, 'webkitRelativePath', { value: `cdnp5/${n}` });
          return f;
        };
        return (window as unknown as { __vvOpenDirImpl: (f: File[]) => void }).__vvOpenDirImpl([
          mk('Hello.java', 'text/x-java-source', a),
          mk('Hello2.java', 'text/x-java-source', b)
        ]);
      },
      { a: JAVA_SRC, b: JAVA2_SRC }
    );
    await openTreeFile(page, 'Hello.java');
    // 切档前：tree-sitter 无 java 来源 → hljs 兜底
    await expect(page.locator('.vv-statusbar')).toContainText('高亮: hljs 兜底', { timeout: 30_000 });
    await waitHighlightResult(
      page,
      { ok: false, lang: 'java' },
      '等待切档前 java 高亮失败落定（ok=false，CDN 不可达）'
    );

    // 切档应用（rebuild）→ 另一文件的新渲染走新 client（grammars 档位 diff 不 rev——
    // 高亮在下次渲染生效，新 tab 渲染即新渲染）
    await setGrammarCdnCustom(page, 'https://cdn-c1.grammars.test/grammars/');
    await openTreeFile(page, 'Hello2.java');
    await expect(page.locator('.vv-statusbar')).toContainText('高亮: tree-sitter', { timeout: 30_000 });
    await waitHighlightResult(
      page,
      { ok: true, lang: 'java' },
      '等待切档后 java 高亮成功（重建后新 client 从 custom origin 取 wasm）'
    );
    expect(c1Hits.some((u) => u.endsWith('/grammars/java.wasm')), '重建后 wasm 来自 custom origin').toBe(true);
  });
});
