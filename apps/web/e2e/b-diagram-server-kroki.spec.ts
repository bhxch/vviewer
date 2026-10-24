import { expect, test, type Page } from '@playwright/test';
import { injectDir, openTreeFile } from './b-markdown-html-docs-helpers';
import { applySettings, closeSettings, gotoGroup, openSettings } from './settings-center';

/**
 * b-diagram-server-kroki —— 图表 server/kroki 消费面默认通道用例（DSV-03/04 与
 * T7 主题重画承接，P3 plan Task 9，spec 2026-10-23-renderer-lang-override §8/§9.2/§10）。
 * 服务端端点链路（DSV-01/02）在 e2e-server 通道（b-diagram-server-kroki.spec.ts），
 * 本文件全部离线稳定（除 DSV-04 真网 skipIf offline）：
 * - DSV-03a 无 kroki-proxy 能力（默认通道不连接服务器）：设置中心「Kroki 通道」
 *   select 恒 client、「服务端代发」option disabled（spec §8.3 能力协商 UI 面；
 *   已连接的 enabled 面在 e2e-server DSV-05 对照）；
 * - DSV-03b 消费面回落：预设 krokiVia='server' 但未连接（krokiProxy=false）→
 *   管线自动回落 client img 直发（pipeline.ts appendKrokiImg 分叉头部 catch 语义），
 *   无 kroki-proxy 内联容器；
 * - DSV-04 wavedrom 本地 CDN 出图（spec §10 四新引擎之一，真网 jsdelivr）：
 *   ```wavedrom wavejson → renderWavedromCdn 直出 svg，成功即零 kroki 请求；
 * - DSV-06 d2 显式 local 档 CDN 出图（T8 申报承接：d2 defaultMode=kroki，wasm
 *   11.5MB 不做默认本地档——spec §10 拍板；真渲染面 T8 台账记「待 T9 e2e 真实网
 *   承接」）：settings 强制 modes.d2='local' → renderD2Cdn（@d2lang/d2@0.1.34
 *   官方 wasm，compile→render→dispose 全链）出 svg，真网 skipIf offline；
 * - T7（Task 7 承接）：settings.diagrams.mermaidTheme 显式变更 → AppShell 派发
 *   vv:diagram-settings-applied → markdownRenderer per-instance 监听就地重画
 *   [data-mermaid] 视图。重画锚：mermaid render id 计数器（diagramEngines
 *   mermaidSeq，每次 render 递增写进 svg 根 id="md-mermaid-N"）——id 变化即
 *   重画发生的确定性指纹（innerHTML 全等比对受 id 计数器影响同义，取 id 精确锚）。
 *
 * 装置：injectDir + openTreeFile 注入通道（b-cdn-diagram-engines 同款）；DSV-03b/
 * T7 预设 settings 走 localStorage 直写（b-md-diagrams 同款）；设置中心 UI 管线走
 * settings-center.ts 共用装置（openSettings/gotoGroup/applySettings）。
 */

/** 注入单文件文档并打开（等待 markdown 视图挂载） */
async function openDoc(page: Page, name: string, content: string): Promise<void> {
  await injectDir(page, [{ name, content }]);
  await openTreeFile(page, name);
  await expect(page.locator('.vv-markdown')).toBeVisible({ timeout: 20_000 });
}

/** settings 预注入（loadSettings 白名单直读；须先于 goto 注册） */
function injectSettings(page: Page, settings: Record<string, unknown>): void {
  void page.addInitScript((s) => {
    localStorage.setItem('vviewer:settings', JSON.stringify(s));
  }, settings);
}

/** 按语言徽标定位 wrapper（徽标为注册表归一后的 type.id） */
function wrapByLang(page: Page, lang: string): ReturnType<Page['locator']> {
  return page
    .locator('.vv-markdown .md-diagram')
    .filter({ has: page.locator('.md-diagram-lang', { hasText: lang }) });
}

/** jsdelivr 连通探测（DSV-04 skipIf offline 判据；API request 不走页面 route/SW） */
async function cdnReachable(page: Page): Promise<boolean> {
  try {
    await page.request.get('https://cdn.jsdelivr.net/', { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

/** kroki.io 请求收集器（先于注入挂载） */
function collectKrokiRequests(page: Page): string[] {
  const hits: string[] = [];
  page.on('request', (r) => {
    if (/kroki\.io/.test(r.url())) hits.push(r.url());
  });
  return hits;
}

/** wavedrom 最小时序图（经典入门样例裁剪：时钟 + 数据总线） */
const WAVEJSON = JSON.stringify({
  signal: [
    { name: 'clk', wave: 'p...' },
    { name: 'dat', wave: 'x3.4x', data: ['A', 'B'] }
  ]
});

test.describe('b-diagram-server-kroki 消费面（默认通道）', () => {
  test('DSV-03a 未连接：Kroki 通道 select 恒 client、「服务端代发」option 禁用（能力协商 UI 面）', async ({
    page
  }) => {
    test.setTimeout(60_000);
    await page.goto('/');
    await openSettings(page);
    await gotoGroup(page, '图表');

    const via = page.locator('select[aria-label="Kroki 通道"]');
    await expect(via).toHaveValue('client');
    await expect(via.locator('option[value="client"]')).toBeEnabled();
    // option 的 disabled 判定走 HTMLOptionElement.disabled 属性（toBeDisabled 对
    // <option> 的可禁用面在实测中不稳定，属性/JS 属性双锚）
    const serverOpt = via.locator('option[value="server"]');
    await expect(serverOpt).toHaveJSProperty('disabled', true);
    await expect(serverOpt).toHaveAttribute('disabled', '');
    // 禁用档不可被 UI 选中（selectOption 于 disabled option 会抛错——以状态断言为准）
    await closeSettings(page);
  });

  test('DSV-03b 预设 krokiVia=server 但 krokiProxy 能力缺失：plantuml 回落 client img 直发', async ({
    page
  }) => {
    test.setTimeout(60_000);
    // client 直发 img URL 段 <host>/<type>/svg/…（默认 kroki.io），fulfill 供 img 可见
    await page.route('**/plantuml/svg/*', (route) =>
      route.fulfill({
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>'
      })
    );
    injectSettings(page, { diagrams: { krokiVia: 'server' } });
    await openDoc(page, 'dsv-03-fallback.md', '```plantuml\nAlice -> Bob: dsv\n```\n');

    const view = wrapByLang(page, 'plantuml').locator('.md-diagram-view');
    // 回落面：img 直发可见（fulfill 应答）；无 kroki-proxy 标容器（能力缺失不得走代发）
    const img = view.locator('img[src^="https://kroki.io/plantuml/svg/"]');
    await expect(img).toBeVisible({ timeout: 30_000 });
    await expect(view.locator('[data-vv-diagram="kroki-proxy"]')).toHaveCount(0);
  });

  test('DSV-04 可达网络下 wavedrom fence CDN 引擎出 svg（真网面，skipIf offline）', async ({ page }) => {
    test.setTimeout(180_000);
    if (!(await cdnReachable(page))) {
      test.skip(true, '离线环境：DSV-04 依赖真网 jsdelivr（CDN-01 同策略）');
    }
    const krokiHits = collectKrokiRequests(page);
    await openDoc(
      page,
      'dsv-04-wavedrom.md',
      ['# wavedrom', '', '```wavedrom', WAVEJSON, '```', ''].join('\n')
    );
    const view = wrapByLang(page, 'wavedrom').locator('.md-diagram-view');
    // CDN 引擎（wavedrom@3.7.0 +esm）成功路径：svg 直出、无失败态、零 kroki 请求
    await expect(view.locator('svg')).toBeVisible({ timeout: 120_000 });
    await expect(view).not.toHaveClass(/md-diagram-error/);
    expect(krokiHits).toHaveLength(0);
  });

  test('DSV-06 modes.d2=local 显式档：d2 官方 wasm CDN 引擎出 svg（T8 承接真网面，skipIf offline）', async ({
    page
  }) => {
    test.setTimeout(240_000); // @d2lang/d2 wasm 11.5MB，慢网加载上界放宽（CDN-01 同口径）
    if (!(await cdnReachable(page))) {
      test.skip(true, '离线环境：DSV-06 依赖真网 jsdelivr（CDN-01/DSV-04 同策略）');
    }
    const krokiHits = collectKrokiRequests(page);
    // defaultMode=kroki（spec §10 拍板）——settings 显式覆盖 local 才走 CDN 引擎
    injectSettings(page, { diagrams: { modes: { d2: 'local' } } });
    await openDoc(page, 'dsv-06-d2.md', ['# d2', '', '```d2', 'x -> y', '```', ''].join('\n'));
    const view = wrapByLang(page, 'd2').locator('.md-diagram-view');
    // CDN 引擎成功路径：svg 直出、无失败态、零 kroki 请求。d2 产物嵌套双 svg
    //（外层背景板 + 内层图形，data-d2-version 在外层根），first() 防 strict violation
    await expect(view.locator('svg').first()).toBeVisible({ timeout: 180_000 });
    await expect(view).not.toHaveClass(/md-diagram-error/);
    expect(krokiHits).toHaveLength(0);
  });

  test('T7 设置中心 Mermaid 主题切换即时重画已打开文档（vv:diagram-settings-applied 就地重渲）', async ({
    page
  }) => {
    test.setTimeout(120_000);
    await page.route('**kroki.io/**', (route) => route.abort()); // mermaid 本地引擎，环境无关
    injectSettings(page, { themeMode: 'light' });
    await openDoc(
      page,
      't7-mermaid-theme.md',
      ['# mermaid 主题', '', '```mermaid', 'graph TD', '  A[主题] --> B[森林]', '```', ''].join('\n')
    );

    const view = wrapByLang(page, 'mermaid').locator('.md-diagram-view');
    await expect(view.locator('svg')).toBeVisible({ timeout: 60_000 });
    const initialId = await view.locator('svg').getAttribute('id');
    expect(initialId, 'mermaid svg 根 id（mermaidSeq 计数器）').toBeTruthy();

    // 设置中心 UI 全用户管线：图表组 → Mermaid 主题 forest → 应用（saveSettings 订阅链
    // → AppShell 仅 mermaidTheme 实际变化才派发 vv:diagram-settings-applied）
    await openSettings(page);
    await gotoGroup(page, '图表');
    await page.locator('select[aria-label="Mermaid 主题"]').selectOption('forest');
    await applySettings(page);

    // 重画锚：mermaidSeq 递增 → 新 svg 根 id 必异于初始（重画=整树替换，非原地改色）
    await expect
      .poll(async () => view.locator('svg').getAttribute('id'), {
        timeout: 30_000,
        message: '主题应用后 [data-mermaid] 视图应就地重画（svg 根 id 更替）'
      })
      .not.toBe(initialId);
    // 重画后健康态：新图可见、锚保留、无错误态
    await expect(view.locator('svg')).toBeVisible();
    await expect(view).toHaveAttribute('data-mermaid', /.+/);
    await expect(view).not.toHaveClass(/md-diagram-error/);
    await closeSettings(page);
  });
});
