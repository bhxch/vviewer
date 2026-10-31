import { inflateSync } from 'node:zlib';
import { expect, test, type Page } from '@playwright/test';
import { injectDir, openTreeFile } from './b-markdown-html-docs-helpers';

/**
 * b-md-diagrams-deep 图表三通道矩阵补强（DM-01~DM-10，不与 b-md-diagrams /
 * e2e-server b-compute-diagrams 既有覆盖重复）：
 * - DM-01 kroki img 真实 error 事件（kroki/官方服务器 404 双跳全失败）→ 错误卡 + 源码
 *  同展 + 可切回（4-3 可见化回归锚，jsdom 外专属面；fallback 成功跳锚在 DM-11）；
 * - DM-02 settings 白名单负注入：非法 krokiHost 归空回默认、非法 modes 键/值剔除（mermaid 'wasm'
 *   若未被剔除会落 source 模式无 svg——归一语义的行为级甄别）；
 * - DM-03 diagram-engines chunk 动态 import 失败（route abort）→ spec §6 运行时回退链
 *   降级 kroki img（f807636，fulfill 确定性接管），同文档 mermaid（另一 chunk）不受累
 *   ——负路径 + chunk 边界；阻断 SW 保证同源 chunk 网络面可拦截
 *  （page.route 拦不到经 SW 的请求，b-grammar-layers 备案同源）；
 * - DM-04 别名归一：```dot/```latex/```vega-lite → 徽标 graphviz/math/vegalite + 各走其通道
 *  （vegalite kroki 断言面经 settings 强制 kroki 保留——defaultMode 已翻 CDN local，spec §6）；
 * - DM-05 effectiveModeOf 回退链：plantuml 强制 local（无本地引擎）→ 回退 kroki img；
 *   math 强制 kroki（krokiType 空）→ 回退 source（无假交互钮）；
 * - DM-06 图/源码切换惰性高亮：vega-lite 切源码后 code.language-json 产出高亮 span；
 * - DM-07 大源码 kroki URL：deflate+base64url 编码形态（无填充/无 +/）+ node zlib inflate 往返一致；
 * - DM-08 mermaid 主题联动端到端：亮→暗（TopBar 主题钮→saveSettings→vv:appearance-applied）
 *   svg 就地重画且内容变化（真浏览器才可测面）；
 * - DM-09 多图表文档性能锚：12 围栏（6 本地 + 6 kroki）45s 内全终态、引擎 chunk 只加载一次、
 *   kroki 每围栏恰一次请求；
 * - DM-10 纯 web auto 策略（无服务端）：纯图表文档恒本地通道——「渲染: 本地」+ 零 compute POST。
 * - DM-11 plantuml 官方服务器 fallback 档（2026-10-30）：kroki 404 → src 换官方服务器
 *  URL 出图（注册表 officialServer + krokiHost 公共默认双判据，jsdom 手派 error 的
 *  单测面之外的真实网络跳）；自建 host 不回落为单测裁决面（隐私防线，无网络面）。
 * - DM-12 官方服务器显式第五档：modes.plantuml='official' 直连官方 URL 出图且零
 *  kroki.io 请求（通道纯净性；kroki abort 兜底令误回落必被计数锚抓到）。
 *
 * 契约锚：注册表/别名 packages/vviewer-render-text/src/markdown/diagrams.ts:20-39；生效模式回退链
 * pipeline.ts:135-143；kroki error 同展兜底 pipeline.ts:297-305；source 模式无 toggle
 * pipeline.ts:274-287；惰性高亮 pipeline.ts:152-173；mermaid 锚与重渲染 markdownRenderer.ts:527-556；
 * settings 归一 apps/web/src/lib/stores/settings.ts:99-109；主题派发 theme.ts:312-324。
 * 移动端形态：树行点击经 openTreeFile（drawer 自适配），其余断言全 DOM 化，双 project 同参。
 * 注入通道与 b-md-diagrams 一致（injectDir + openTreeFile，夹具内联构造，不另落 samples）。
 */

const SVG_BODY = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>';

/** 围栏构造（markdown-it fence 内容恒带尾换行，与 samples 采样文档同构） */
function fence(lang: string, body: string): string {
  return ['```' + lang, body, '```'].join('\n');
}

/** 直写 settings（addInitScript 白名单合法/非法形态均直写，归一在 loadSettings） */
function injectSettings(page: Page, settings: Record<string, unknown>): void {
  void page.addInitScript((s) => {
    localStorage.setItem('vviewer:settings', JSON.stringify(s));
  }, settings);
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

test.describe('b-md-diagrams-deep 图表三通道矩阵补强', () => {
  // kroki 渲染失败必须用户可见：错误卡文案 + 源码同展 + toggle 可切回（4-3 修复的回归锚，jsdom 外专属面）
  // fallback 档语义（DM-11 承接成功跳）：plantuml kroki 失败先换官方服务器重试，两跳
  // 全败才落错误卡——本用例按 host 分路由双 404，终态文案标注两跳
  test('DM-01 kroki img 真实 error 事件（kroki+官方双跳全失败）：两跳文案错误卡 + 源码同展兜底 + 可切回（4-3 回归锚）', async ({
    page
  }) => {
    test.setTimeout(60_000);
    // 404 触发真浏览器 img error 事件（jsdom 不派发——单测手派事件，此为 e2e 专属面）；
    // 两条路由按 host 分开拦截：kroki 第一跳与官方服务器第二跳各自命中
    await page.route('**kroki.io/plantuml/svg/*', (route) =>
      route.fulfill({ status: 404, contentType: 'text/plain', body: 'nope' })
    );
    await page.route('**plantuml.com/plantuml/svg/*', (route) =>
      route.fulfill({ status: 404, contentType: 'text/plain', body: 'nope' })
    );
    await openDoc(
      page,
      'dd-01-kroki-error.md',
      ['# kroki 失败', '', fence('plantuml', '@startuml\nA -> B\n@enduml'), ''].join('\n')
    );
    const wrap = wrapByLang(page, 'plantuml');
    // 错误卡：md-diagram-error + 文案带类型 id（不得 hidden——4-3 修复的可见化判据）；
    // fallback 档后文案标注两跳全败（kroki 与官方服务器）
    const errView = wrap.locator('.md-diagram-view.md-diagram-error');
    await expect(errView).toBeVisible({ timeout: 30_000 });
    await expect(errView).toHaveText('kroki 与官方服务器渲染失败（plantuml）');
    // 源码同展兜底：面板展开、原文可读（缺陷态只露源码无失败文案）
    const sourcePane = wrap.locator('.md-diagram-source');
    await expect(sourcePane).toBeVisible();
    await expect(sourcePane.locator('code')).toContainText('@startuml');
    // 失败态 toggle 留「图」，点击切回文案卡（源码隐藏、错误卡重见）
    const toggle = wrap.locator('.md-diagram-toggle');
    await expect(toggle).toHaveText('图');
    await toggle.click();
    await expect(sourcePane).toBeHidden();
    await expect(errView).toBeVisible();
  });

  // 脏 settings 不得污染渲染：host 非法归空回官方默认、modes 非法键值剔除后各类型仍走默认通道
  test('DM-02 settings 白名单负注入：非法 krokiHost 归空回默认、非法 modes 键/值剔除后渲染走默认', async ({
    page
  }) => {
    test.setTimeout(60_000);
    const krokiHits: number[] = [];
    await page.route('**/plantuml/svg/*', (route) => {
      krokiHits.push(1);
      return route.fulfill({ contentType: 'image/svg+xml', body: SVG_BODY });
    });
    // krokiHost 'ftp://x' 须归空（→ 默认 https://kroki.io）；modes 键 rust 不在注册表剔除、
    // 值 wasm 非三枚举剔除——mermaid 若被污染成 'wasm' 会落 source 模式（无 svg）
    injectSettings(page, {
      diagrams: { krokiHost: 'ftp://x', modes: { rust: 'wasm', mermaid: 'wasm', plantuml: 'kroki' } }
    });
    await openDoc(
      page,
      'dd-02-neg-settings.md',
      ['# 负注入', '', fence('plantuml', '@startuml\nA -> B\n@enduml'), '', fence('mermaid', 'graph LR; A --> B'), ''].join(
        '\n'
      )
    );
    // plantuml：img src 锚定默认官方 host（非法 ftp host 归空的直接证据）+ mock 命中
    const img = page.locator('.vv-markdown .md-diagram-view img[src^="https://kroki.io/plantuml/svg/"]');
    await expect(img).toHaveCount(1);
    await expect(img).toBeVisible({ timeout: 30_000 });
    expect(krokiHits.length).toBeGreaterThanOrEqual(1);
    // mermaid：非法值剔除后回默认 local——svg 真渲染（缺陷态为 source 模式无 svg）
    await expect(wrapByLang(page, 'mermaid').locator('.md-diagram-view svg')).toBeVisible({ timeout: 30_000 });
  });

  // 别名围栏与主 id 渲染必须同权：徽标显示归一后的注册表 id，通道按 id 各自分发
  test('DM-04 别名归一：```dot/```latex/```vega-lite 徽标落注册表 id 且各走其通道', async ({ page }) => {
    test.setTimeout(60_000);
    // spec §6 翻转注记：vegalite defaultMode 已翻 CDN local——krokiType 归一断言面（kroki
    // 段 URL 形态）经 settings 强制 kroki 保留，离线稳定（真网 CDN 实渲染由 CDN-01 锚定）
    injectSettings(page, { diagrams: { modes: { vegalite: 'kroki' } } });
    await page.route('**/vegalite/svg/*', (route) =>
      route.fulfill({ contentType: 'image/svg+xml', body: SVG_BODY })
    );
    await openDoc(
      page,
      'dd-04-alias.md',
      [
        '# 别名',
        '',
        fence('dot', 'digraph { dot -> alias }'),
        '',
        fence('latex', '\\alpha + \\beta = \\gamma'),
        '',
        fence('vega-lite', '{ "mark": "bar" }'),
        ''
      ].join('\n')
    );
    // dot → graphviz 本地 svg
    const dotWrap = wrapByLang(page, 'graphviz');
    await expect(dotWrap.locator('.md-diagram-lang')).toHaveText('graphviz');
    await expect(dotWrap.locator('.md-diagram-view svg')).toBeVisible({ timeout: 30_000 });
    // latex → math 本地 katex（displayMode）
    const latexWrap = wrapByLang(page, 'math');
    await expect(latexWrap.locator('.md-diagram-lang')).toHaveText('math');
    await expect(latexWrap.locator('.md-diagram-view .katex-display .katex')).toBeVisible({ timeout: 30_000 });
    // vega-lite → vegalite kroki（krokiType 归一走 vegalite 段）
    const vlWrap = wrapByLang(page, 'vegalite');
    await expect(vlWrap.locator('.md-diagram-lang')).toHaveText('vegalite');
    await expect(
      vlWrap.locator('.md-diagram-view img[src^="https://kroki.io/vegalite/svg/"]')
    ).toBeVisible({ timeout: 30_000 });
  });

  // 设置覆盖不能制造不可能形态：无本地引擎强制 local 回退 kroki、kroki 不支持强制 kroki 回退 source
  test('DM-05 effectiveModeOf 回退链：plantuml 强制 local 回退 kroki img；math 强制 kroki 回退 source 无假交互钮', async ({
    page
  }) => {
    test.setTimeout(60_000);
    const krokiHits: number[] = [];
    await page.route('**/plantuml/svg/*', (route) => {
      krokiHits.push(1);
      return route.fulfill({ contentType: 'image/svg+xml', body: SVG_BODY });
    });
    injectSettings(page, { diagrams: { modes: { plantuml: 'local', math: 'kroki' } } });
    await openDoc(
      page,
      'dd-05-mode-fallback.md',
      ['# 回退链', '', fence('plantuml', '@startuml\nA -> B\n@enduml'), '', fence('math', 'E = mc^2'), ''].join('\n')
    );
    // plantuml 强制 local：不在本地启用集（local=false）→ 有 krokiType 回退 kroki img
    const pWrap = wrapByLang(page, 'plantuml');
    await expect(
      pWrap.locator('.md-diagram-view img[src^="https://kroki.io/plantuml/svg/"]')
    ).toBeVisible({ timeout: 30_000 });
    expect(krokiHits.length).toBeGreaterThanOrEqual(1);
    // math 强制 kroki：krokiType 为空（kroki 不支持）→ 回退 source——无 toggle（无假交互钮）、
    // 源码面板展开原文、视图隐藏、不当 katex 排版（fence 通道未渲染公式）
    const mWrap = wrapByLang(page, 'math');
    await expect(mWrap.locator('.md-diagram-toggle')).toHaveCount(0);
    await expect(mWrap.locator('.md-diagram-source')).toBeVisible();
    await expect(mWrap.locator('.md-diagram-source code')).toContainText('E = mc^2');
    await expect(mWrap.locator('.md-diagram-view')).toBeHidden();
    await expect(mWrap.locator('.md-diagram-view .katex')).toHaveCount(0);
  });

  // 图视图优先出图，源码高亮只在首次切换时惰性发生且按注册表 highlightLang 命中
  test('DM-06 图/源码切换惰性高亮：vega-lite 切源码后 language-json 产出高亮 span', async ({ page }) => {
    test.setTimeout(60_000);
    // spec §6 翻转注记：vegalite defaultMode 已翻 CDN local——img 出图锚经 settings 强制
    // kroki 保留（离线稳定；CDN local 通道由 CDN-01 锚定）
    injectSettings(page, { diagrams: { modes: { vegalite: 'kroki' } } });
    await page.route('**/vegalite/svg/*', (route) =>
      route.fulfill({ contentType: 'image/svg+xml', body: SVG_BODY })
    );
    await openDoc(
      page,
      'dd-06-lazy-hl.md',
      [
        '# 惰性高亮',
        '',
        fence(
          'vega-lite',
          ['{', '  "$schema": "https://vega.github.io/schema/vega-lite/v5.json",', '  "mark": "bar"', '}'].join('\n')
        ),
        ''
      ].join('\n')
    );
    const wrap = wrapByLang(page, 'vegalite');
    await expect(wrap.locator('.md-diagram-view img')).toBeVisible({ timeout: 30_000 });
    // 图视图优先出图（高亮不挡首屏）；首次切源码才按 highlightLang=json 惰性高亮
    const toggle = wrap.locator('.md-diagram-toggle');
    await expect(toggle).toHaveText('源码');
    await toggle.click();
    const sourceCode = wrap.locator('.md-diagram-source code.language-json');
    await expect(sourceCode).toBeVisible();
    await expect(sourceCode).toContainText('vega-lite/v5.json');
    await expect(sourceCode.locator('span').first()).toBeVisible({ timeout: 30_000 });
    await expect(toggle).toHaveText('图');
    await expect(wrap.locator('.md-diagram-view')).toBeHidden();
  });

  // kroki URL 编码端到端可逆：大源码压缩进 URL、形态是纯 base64url、能无损还原原文
  test('DM-07 大源码 kroki URL：base64url 编码形态（无填充无 +/）+ deflate 往返还原一致', async ({ page }) => {
    test.setTimeout(60_000);
    // 42KB 重复源码：deflate(level 9) 压缩后走 URL（浏览器 URL 上限内），编码量级锚
    const BIG_SRC = 'A -> B\n'.repeat(6000);
    // fence() 构造的 content = BIG_SRC + '\n'（markdown-it fence 内容恒以 \n 收尾）；
    // 管线 kroki 步对 fence 内容剥一个尾换行（pipeline.ts:262）→ URL 载荷源 = BIG_SRC 原样
    const expectDecoded = BIG_SRC;
    let decoded = '';
    await page.route('**/plantuml/svg/*', (route) => {
      const seg = route.request().url().split('/plantuml/svg/')[1] ?? '';
      decoded = inflateSync(Buffer.from(seg.replace(/-/g, '+').replace(/_/g, '/'), 'base64')).toString('utf-8');
      return route.fulfill({ contentType: 'image/svg+xml', body: SVG_BODY });
    });
    await openDoc(
      page,
      'dd-07-big-kroki.md',
      ['# 大源码', '', fence('plantuml', BIG_SRC), ''].join('\n')
    );
    const img = page.locator('.vv-markdown .md-diagram-view img[src^="https://kroki.io/plantuml/svg/"]');
    await expect(img).toBeVisible({ timeout: 30_000 });
    const seg = (await img.getAttribute('src'))?.split('/plantuml/svg/')[1] ?? '';
    // 编码形态：纯 base64url 字符（-/_ 替换 + 无 = 填充）
    expect(seg).toMatch(/^[A-Za-z0-9_-]+$/);
    // 压缩真实生效：编码段远小于原文（重复内容 level 9 压缩比 >10×）
    expect(seg.length).toBeLessThan(BIG_SRC.length / 10);
    // 往返一致：URL 携带的 deflate 载荷可无损还原为原文
    expect(decoded).toBe(expectDecoded);
  });

  // 亮暗切换必须即时作用于已挂载的 mermaid 图（事件驱动就地重画，无需重开文档）
  test('DM-08 mermaid 主题联动端到端：亮→暗切换 svg 就地重画且内容变化（vv:appearance-applied）', async ({
    page
  }) => {
    test.setTimeout(60_000);
    // 起点钉亮色（headless prefers-color-scheme 默认 light，显式钉死防环境漂移）
    injectSettings(page, { themeMode: 'light' });
    await openDoc(
      page,
      'dd-08-mermaid-theme.md',
      ['# 主题联动', '', fence('mermaid', 'graph LR; A --> B'), ''].join('\n')
    );
    const view = page.locator('.vv-markdown .md-diagram-view[data-mermaid]');
    await expect(view.locator('svg')).toBeVisible({ timeout: 30_000 });
    const snap = () =>
      page.evaluate(() => document.querySelector('.vv-markdown .md-diagram-view[data-mermaid]')?.outerHTML ?? '');
    const before = await snap();
    // TopBar 主题快切（与设置中心同一 themeMode 字段）→ saveSettings → 订阅派发事件
    const themeBtn = page.getByRole('button', { name: /主题：/ });
    await expect(themeBtn).toHaveText('主题：亮');
    await themeBtn.click();
    await expect(themeBtn).toHaveText('主题：暗');
    // 事件驱动 [data-mermaid] 容器就地重画：外层 HTML 变化（新 svg 节点/新主题配色）且不重开 tab
    await expect(view).toBeVisible();
    await expect.poll(snap, { timeout: 30_000, message: 'mermaid 应随主题就地重画' }).not.toBe(before);
    await expect(view.locator('svg')).toBeVisible();
    // 重渲染成功不残留错误态
    await expect(view).not.toHaveClass(/md-diagram-error/);
  });

  // 多图文档不放大资源面：全部围栏限时到终态、引擎 chunk 只加载一次、kroki 编码每围栏恰一次
  test('DM-09 多图表文档性能锚：12 围栏 45s 内全终态、引擎 chunk 恰加载一次、kroki 每围栏恰一次', async ({
    page
  }) => {
    test.setTimeout(90_000);
    const krokiHits: number[] = [];
    await page.route('**/plantuml/svg/*', (route) => {
      krokiHits.push(1);
      return route.fulfill({ contentType: 'image/svg+xml', body: SVG_BODY });
    });
    const fences: string[] = ['# 多图', ''];
    for (let i = 0; i < 6; i += 1) {
      fences.push(fence('graphviz', `digraph { n${i} -> m${i} }`), '');
      fences.push(fence('plantuml', `@startuml\nP${i} -> Q${i}\n@enduml`), '');
    }
    await openDoc(page, 'dd-09-many.md', fences.join('\n'));
    // 12 个 wrapper 全部落位
    await expect(page.locator('.vv-markdown .md-diagram')).toHaveCount(12, { timeout: 20_000 });
    // 性能锚：6 个本地 wasm 图 + 6 个 kroki img 全部到终态（45s 上界，CI 双核口径）
    await expect(page.locator('.md-diagram-view svg')).toHaveCount(6, { timeout: 45_000 });
    await expect(
      page.locator('.md-diagram-view img[src^="https://kroki.io/plantuml/svg/"]')
    ).toHaveCount(6, { timeout: 45_000 });
    // kroki 编码每围栏恰一次（无重复编码/重排重请求）
    expect(krokiHits).toHaveLength(6);
    // 引擎懒加载 chunk 与文档围栏数无关：全文档只发起一次加载（模块缓存；resource
    // entries 在渲染层记账，SW 是否激活均可见）
    await expect
      .poll(
        () =>
          page.evaluate(() =>
            performance.getEntriesByType('resource').filter((e) => e.name.includes('diagram-engines')).length
          ),
        { timeout: 30_000, message: 'diagram-engines chunk 应恰好加载一次' }
      )
      .toBe(1);
  });

  // 无服务端连接时 auto 策略不得产生远程计算面：本地通道出图 + 状态栏本地 + 零 compute POST
  test('DM-10 纯 web auto 策略（无服务端）：纯图表文档恒本地通道——「渲染: 本地」+ 零 compute POST', async ({
    page
  }) => {
    test.setTimeout(60_000);
    const mdPosts: string[] = [];
    page.on('request', (r) => {
      if (r.method() === 'POST' && r.url().includes('/api/compute/markdown')) mdPosts.push(r.url());
    });
    await openDoc(
      page,
      'dd-10-local-auto.md',
      ['# 本地通道', '', fence('dot', 'digraph { local -> only }'), ''].join('\n')
    );
    // 本地通道正常出图（viz wasm svg）
    await expect(wrapByLang(page, 'graphviz').locator('.md-diagram-view svg')).toBeVisible({ timeout: 30_000 });
    // 状态栏引擎指示本地（auto 对无远程来源文档不提供远程路径）
    await expect(page.locator('.vv-statusbar')).toContainText('渲染: 本地', { timeout: 30_000 });
    // 零计算卸载请求：无服务端连接时 auto 不发 POST /api/compute/markdown
    expect(mdPosts).toHaveLength(0);
  });

  // plantuml 官方服务器 fallback 档真实网络跳：kroki 404 → 同一 img 换官方服务器
  // URL 出图（无错误卡）。kroki.io abort / 官方 fulfill 按 host 分路由（**/plantuml/svg/*
  // 通配会双命中，分 host 才能单跳定向失败）；全 route mock 离线稳定，编码正确性由
  // 单测官方向量锚 + DM-01 双跳往返锚承接
  test('DM-11 plantuml 官方服务器 fallback 档：kroki 失败后 src 换官方 URL 出图无错误卡', async ({
    page
  }) => {
    test.setTimeout(60_000);
    await page.route('**kroki.io/plantuml/svg/*', (route) =>
      route.fulfill({ status: 404, contentType: 'text/plain', body: 'nope' })
    );
    await page.route('**plantuml.com/plantuml/svg/*', (route) =>
      route.fulfill({ contentType: 'image/svg+xml', body: SVG_BODY })
    );
    await openDoc(
      page,
      'dd-11-official-fallback.md',
      ['# 官方回落', '', fence('plantuml', '@startuml\nA -> B\n@enduml'), ''].join('\n')
    );
    const wrap = wrapByLang(page, 'plantuml');
    const view = wrap.locator('.md-diagram-view');
    // fallback 成功跳：src 换官方服务器 URL 段（编码为官方字母表），img 出图
    const img = view.locator('img[src^="https://www.plantuml.com/plantuml/svg/"]');
    await expect(img).toBeVisible({ timeout: 30_000 });
    expect(await img.getAttribute('src')).toMatch(
      /^https:\/\/www\.plantuml\.com\/plantuml\/svg\/[0-9A-Za-z_-]+$/
    );
    // 无错误卡无降级：官方跳接管后失败态不出现
    await expect(view).not.toHaveClass(/md-diagram-error/);
    await expect(wrap.locator('.md-diagram-toggle')).toHaveText('源码');
  });

  // 官方服务器显式第五档（2026-10-30）：settings UI modes.plantuml='official' →
  // img 直连官方服务器 URL、零 kroki.io 请求。kroki.io abort 兜底：若实现误回落
  // kroki（img error → fallback 档换官方），请求计数锚必现非零——终态图一样时
  // 通道纯净性仍被锁死
  test('DM-12 官方服务器显式档：modes.plantuml=official 直连官方 URL 出图且零 kroki 请求', async ({
    page
  }) => {
    test.setTimeout(60_000);
    const krokiHits: string[] = [];
    page.on('request', (r) => {
      if (/kroki\.io/.test(r.url())) krokiHits.push(r.url());
    });
    await page.route('**kroki.io/**', (route) => route.abort());
    await page.route('**plantuml.com/plantuml/svg/*', (route) =>
      route.fulfill({ contentType: 'image/svg+xml', body: SVG_BODY })
    );
    injectSettings(page, { diagrams: { modes: { plantuml: 'official' } } });
    await openDoc(
      page,
      'dd-12-official-mode.md',
      ['# 官方档', '', fence('plantuml', '@startuml\nA -> B\n@enduml'), ''].join('\n')
    );
    const view = wrapByLang(page, 'plantuml').locator('.md-diagram-view');
    await expect(view.locator('img[src^="https://www.plantuml.com/plantuml/svg/"]')).toBeVisible({
      timeout: 30_000
    });
    await expect(view).not.toHaveClass(/md-diagram-error/);
    expect(krokiHits).toHaveLength(0);
  });
});

test.describe('DM-03 引擎 chunk 失败负路径（阻断 SW 保证同源 chunk 网络面可拦截）', () => {
  // page.route 拦不到经 SW 的请求（b-grammar-layers 同源备案）：阻断 SW 使 chunk
  // 请求必经页面网络栈，abort 才能确定性地令动态 import 失败
  test.use({ serviceWorkers: 'block' });

  test('DM-03 diagram-engines chunk 加载失败：graphviz 按 spec §6 回退链降级 kroki img，同文档 mermaid 不受累', async ({
    page
  }) => {
    test.setTimeout(60_000);
    await page.route('**/chunks/diagram-engines-*.js', (route) => route.abort());
    // spec §6 翻转注记：运行时回退（f807636）后 graphviz 引擎 chunk 失败不再落错误卡，
    // 有 krokiType 先降 kroki img——fulfill 确定性接管（离线稳定，img error 不触发）
    await page.route('**/kroki.io/**', (route) =>
      route.fulfill({ contentType: 'image/svg+xml', body: SVG_BODY })
    );
    await openDoc(
      page,
      'dd-03-chunk-fail.md',
      [
        '# chunk 失败',
        '',
        fence('graphviz', 'digraph { chunkfail -> kept }'),
        '',
        fence('mermaid', 'graph LR; A --> B'),
        ''
      ].join('\n')
    );
    // graphviz：viz 动态 import 被打断 → 引擎渲染抛错 → 回退链第一跳 kroki img
    //（fulfill 加载成功：无错误卡、view 内无引擎 svg 产物）
    const gvWrap = wrapByLang(page, 'graphviz');
    const gvView = gvWrap.locator('.md-diagram-view');
    await expect(
      gvView.locator('img[src^="https://kroki.io/graphviz/svg/"]')
    ).toBeVisible({ timeout: 30_000 });
    await expect(gvView).not.toHaveClass(/md-diagram-error/);
    await expect(gvView.locator('svg')).toHaveCount(0);
    // chunk 边界：mermaid 在独立 chunk（kit 默认分块），不受 graphviz 引擎失败牵连
    await expect(wrapByLang(page, 'mermaid').locator('.md-diagram-view svg')).toBeVisible({ timeout: 30_000 });
    // 徽标仍为归一 id；toggle 留「源码」可切源码复核原文
    await expect(gvWrap.locator('.md-diagram-lang')).toHaveText('graphviz');
    await expect(gvWrap.locator('.md-diagram-toggle')).toHaveText('源码');
  });
});
