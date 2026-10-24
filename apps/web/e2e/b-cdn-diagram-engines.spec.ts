import { expect, test, type Page } from '@playwright/test';
import { injectDir, openTreeFile } from './b-markdown-html-docs-helpers';

/**
 * b-cdn-diagram-engines —— 图表 CDN 直链引擎用例（CDN-01~04，P2 plan Task 5 +
 * P3 后续批次 CDN-04，spec `2026-10-23-renderer-lang-override-markpad-alignment-design.md`
 * §6/§7/§9.1）：
 * - CDN-01 真网实渲染：excalidraw fence 经 jsdelivr +esm CDN 引擎（@excalidraw/utils，
 *   18.74MB 单文件自打包——T4 spike 报告的 Worker URL 构造惰性路径在真浏览器实渲染一并
 *   验证）直出 svg；CDN 成功即不降级（零 kroki 请求）。skipIf offline：GRF 域离线前科
 *  （VV_GRAMMAR_CDN），探测 page.request.get cdn 3s 超时（API request 不受 page.route
 *   影响）；mock loader 不可用于 e2e（产物 chunk 内生产 loader），真网是唯一实渲染面。
 * - CDN-02 回退链两态（f807636 运行时 kroki 回退，spec §6 承诺）：
 *   ① 仅拦截 cdn.jsdelivr.net → 引擎动态 import 失败降级 kroki img（回退链第一跳）；
 *   ② CDN+kroki 双拦截 → img error → 错误卡 + 源码同展（失败态文案不得 hidden，
 *   66afead 教训，DM-01 同构断言）。全 route mock 离线稳定，不依赖真网。
 * - CDN-03 svgbob fence 本地 wasm 出图（spec §7：唯一本地打包例外，构建期 gen:svgbob-wasm
 *   产物入 dist）——不依赖外网；page.on('request') 断言零 kroki.io 请求。
 * - CDN-04 graphviz hpcc 渲染器真渲染（spec §9.1 双渲染器，P3 承接
 *   diagram-server-kroki.md §6 留档候选）：settings.diagrams.renderers.graphviz='hpcc'
 *   预注入 → ```graphviz fence 经 CDN @hpcc-js/wasm-graphviz@1.30.0（wasm 内嵌单文件
 *   820KB）Graphviz.load→layout 出 svg；零 kroki 请求（local 成功路径不降级）。因果锚
 *   双保险：renderers 设置是切换 hpcc 档的开关，@hpcc-js/wasm-graphviz 的 CDN 请求在案
 *   则排除 viz-js 路径（viz-js 为打包内嵌依赖、零网络面——hpcc 档唯一的请求面指纹）。
 *   skipIf offline 同 CDN-01；SW block 同 CDN-02/03——hpcc CDN 请求若经 SW CacheFirst
 *   则 page.on('request') 不可观测（请求由 SW fetch 发起，不进页面网络栈），阻断 SW
 *   保证因果锚请求必现，真网语义不受影响（首载本就无缓存可用）。
 *
 * 装置：SW block（CDN-02/03/04）——page.route 拦不到经 SW 的请求（DM-03 备案同源：
 * SW runtimeCaching 的 jsdelivr CacheFirst 会吞掉拦截面），阻断 SW 保证请求必经页面
 * 网络栈，abort 才能确定性触发回退链；CDN-01 真网语义不 block（SW CacheFirst 生效与
 * 否不影响首次加载出图断言）。注入通道与 b-md-diagrams 同款（injectDir + openTreeFile，
 * 夹具内联）；settings 预注入走 localStorage 直写（DM-04/DSV-06 injectSettings 先例）。
 */

/** excalidraw 最小 JSON（spec Task 5 夹具口径；空 elements 亦须出图——CDN-01 实测锚定） */
const EXCALIDRAW_SRC = '{"type":"excalidraw","elements":[],"appState":{},"files":{}}';

/** svgbob 最小 ASCII 图（盒图 + 单向箭头） */
const SVGBOB_SRC = ['+-->+', '| a |', '+<--+'].join('\n');

/** graphviz 最小有向图（server 单测同款 digraph 形态） */
const GRAPHVIZ_SRC = 'digraph { cdn04 -> hpcc }';

const SVG_BODY = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>';

/** 围栏构造（markdown-it fence 内容恒带尾换行，与 samples 采样文档同构） */
function fence(lang: string, body: string): string {
  return ['```' + lang, body, '```'].join('\n');
}

/** 注入单文件文档并打开（等待 markdown 视图挂载） */
async function openDoc(page: Page, name: string, content: string): Promise<void> {
  await injectDir(page, [{ name, content }]);
  await openTreeFile(page, name);
  await expect(page.locator('.vv-markdown')).toBeVisible({ timeout: 20_000 });
}

/** 按语言徽标定位 wrapper（徽标为注册表归一后的 type.id） */
function wrapByLang(page: Page, lang: string): ReturnType<Page['locator']> {
  return page
    .locator('.vv-markdown .md-diagram')
    .filter({ has: page.locator('.md-diagram-lang', { hasText: lang }) });
}

/** jsdelivr 连通探测（CDN-01 skipIf offline 判据；API request 不走页面 route/SW） */
async function cdnReachable(page: Page): Promise<boolean> {
  try {
    await page.request.get('https://cdn.jsdelivr.net/', { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

/** kroki.io 请求收集器（先于注入挂载，回退链是否被触发的网络面探针） */
function collectKrokiRequests(page: Page): string[] {
  const hits: string[] = [];
  page.on('request', (r) => {
    if (/kroki\.io/.test(r.url())) hits.push(r.url());
  });
  return hits;
}

/** settings 预注入（loadSettings 白名单直读；须先于 goto 注册，DSV-06/DM-04 同款） */
function injectSettings(page: Page, settings: Record<string, unknown>): void {
  void page.addInitScript((s) => {
    localStorage.setItem('vviewer:settings', JSON.stringify(s));
  }, settings);
}

/** hpcc CDN 引擎请求收集器（先于注入挂载）：viz-js 为打包内嵌依赖零网络面，
 * @hpcc-js/wasm-graphviz 的 jsdelivr 请求在案 = hpcc 路径已走（CDN-04 因果锚） */
function collectHpccRequests(page: Page): string[] {
  const hits: string[] = [];
  page.on('request', (r) => {
    if (/@hpcc-js\/wasm-graphviz/.test(r.url())) hits.push(r.url());
  });
  return hits;
}

test.describe('b-cdn-diagram-engines CDN 直链引擎', () => {
  test('CDN-01 可达网络下 excalidraw fence CDN 引擎实渲染出 svg（真网面，skipIf offline）', async ({
    page
  }) => {
    test.setTimeout(180_000); // excalidraw 包 18.74MB（含 react），慢网加载上界放宽
    if (!(await cdnReachable(page))) {
      test.skip(true, '离线环境：CDN-01 依赖真网 jsdelivr（GRF 域 VV_GRAMMAR_CDN 前科同策略）');
    }
    const krokiHits = collectKrokiRequests(page);
    await openDoc(
      page,
      'cdn-01-excalidraw.md',
      ['# CDN 实渲染', '', fence('excalidraw', EXCALIDRAW_SRC), ''].join('\n')
    );
    const view = wrapByLang(page, 'excalidraw').locator('.md-diagram-view');
    // CDN 引擎成功路径：svg 直出、无失败态、零 kroki 请求（成功即不降级）
    await expect(view.locator('svg')).toBeVisible({ timeout: 120_000 });
    await expect(view).not.toHaveClass(/md-diagram-error/);
    expect(krokiHits).toHaveLength(0);
  });
});

test.describe('b-cdn-diagram-engines 拦截面（SW block：page.route 拦不到经 SW 请求，DM-03 备案）', () => {
  test.use({ serviceWorkers: 'block' });

  test('CDN-02 回退链第一跳：仅拦截 CDN 后引擎降级 kroki img 接管', async ({ page }) => {
    test.setTimeout(60_000);
    await page.route('**/cdn.jsdelivr.net/**', (route) => route.abort());
    await page.route('**/kroki.io/**', (route) =>
      route.fulfill({ contentType: 'image/svg+xml', body: SVG_BODY })
    );
    await openDoc(
      page,
      'cdn-02-cdn-only.md',
      ['# CDN 拦截', '', fence('excalidraw', EXCALIDRAW_SRC), ''].join('\n')
    );
    const wrap = wrapByLang(page, 'excalidraw');
    // 引擎动态 import 被 abort → 有 krokiType 降级 kroki img（f807636 运行时回退）
    const img = wrap.locator('.md-diagram-view img[src^="https://kroki.io/excalidraw/svg/"]');
    await expect(img).toBeVisible({ timeout: 30_000 });
    // kroki 接管成功：不落错误卡（回退链第一跳即终态）
    await expect(wrap.locator('.md-diagram-view.md-diagram-error')).toHaveCount(0);
  });

  test('CDN-02 回退链终点：CDN+kroki 双拦截后错误卡+源码可见（失败态不得 hidden）', async ({ page }) => {
    test.setTimeout(60_000);
    await page.route('**/cdn.jsdelivr.net/**', (route) => route.abort());
    await page.route('**/kroki.io/**', (route) => route.abort());
    await openDoc(
      page,
      'cdn-02-cdn-kroki.md',
      ['# 双拦截', '', fence('excalidraw', EXCALIDRAW_SRC), ''].join('\n')
    );
    const wrap = wrapByLang(page, 'excalidraw');
    // kroki img error 事件（abort 触发，真浏览器专属面）→ 错误卡文案带类型 id、可见
    const errView = wrap.locator('.md-diagram-view.md-diagram-error');
    await expect(errView).toBeVisible({ timeout: 30_000 });
    await expect(errView).toHaveText('kroki 渲染失败（excalidraw）');
    // 源码同展兜底：原文可读（66afead：失败态文案与源码均不得 hidden）
    const sourcePane = wrap.locator('.md-diagram-source');
    await expect(sourcePane).toBeVisible();
    await expect(sourcePane.locator('code')).toContainText(EXCALIDRAW_SRC);
    // toggle 留「图」可切回文案卡（与 DM-01 同构）
    await expect(wrap.locator('.md-diagram-toggle')).toHaveText('图');
  });

  test('CDN-03 svgbob fence 本地 wasm 出图：不依赖外网、零 kroki 请求', async ({ page }) => {
    test.setTimeout(60_000);
    const krokiHits = collectKrokiRequests(page);
    await openDoc(
      page,
      'cdn-03-svgbob.md',
      ['# svgbob 本地', '', fence('svgbob', SVGBOB_SRC), ''].join('\n')
    );
    // 本地 wasm 引擎直出 svg（spec §7 唯一本地打包例外；构建期 gen:svgbob-wasm 产物）
    await expect(wrapByLang(page, 'svgbob').locator('.md-diagram-view svg')).toBeVisible({
      timeout: 30_000
    });
    // local 默认成功路径不发 kroki（运行时回退仅在引擎失败后触发）
    expect(krokiHits).toHaveLength(0);
  });
});

test.describe('b-cdn-diagram-engines CDN-04 hpcc 真渲染（SW block：因果锚请求可观测；真网 jsdelivr 不 mock）', () => {
  test.use({ serviceWorkers: 'block' });

  test('CDN-04 renderers.graphviz=hpcc：@hpcc-js/wasm-graphviz CDN 真渲染出 svg（skipIf offline）', async ({
    page
  }) => {
    test.setTimeout(120_000); // wasm-graphviz 内嵌 wasm 单文件 820KB，慢网加载上界放宽（CDN-01 同口径比例）
    if (!(await cdnReachable(page))) {
      test.skip(true, '离线环境：CDN-04 依赖真网 jsdelivr（CDN-01/DSV-04 同策略）');
    }
    const krokiHits = collectKrokiRequests(page);
    const hpccHits = collectHpccRequests(page);
    // viz-js 是注册表默认渲染器（打包内嵌、恒出 svg）——renderers.graphviz='hpcc'
    // 预注入是切换 hpcc 档的唯一开关（spec §9.1；loadSettings 白名单校验值合法）
    injectSettings(page, { diagrams: { renderers: { graphviz: 'hpcc' } } });
    await openDoc(
      page,
      'cdn-04-hpcc.md',
      ['# hpcc 真渲染', '', fence('graphviz', GRAPHVIZ_SRC), ''].join('\n')
    );
    const view = wrapByLang(page, 'graphviz').locator('.md-diagram-view');
    // hpcc 引擎成功路径：Graphviz.load→layout 直出 svg、无失败态、零 kroki 请求
    await expect(view.locator('svg')).toBeVisible({ timeout: 60_000 });
    await expect(view).not.toHaveClass(/md-diagram-error/);
    expect(krokiHits).toHaveLength(0);
    // 因果锚（排除 viz-js 路径）：hpcc 档必经 CDN 拉取 @hpcc-js/wasm-graphviz（引擎
    // cdnEngines.renderGraphvizHpcc 的 loader 直链），viz-js 内嵌无请求——请求在案即
    // 证渲染走的是 settings 指定的 hpcc 档而非默认档巧合出图
    expect(
      hpccHits.length,
      `hpcc 因果锚：@hpcc-js/wasm-graphviz CDN 请求应在案（实际 ${JSON.stringify(hpccHits)}）`
    ).toBeGreaterThan(0);
  });
});
