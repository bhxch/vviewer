import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { injectDir, openTreeFile } from './b-markdown-html-docs-helpers';

/**
 * b-md-diagrams 图表矩阵冒烟（md-diagrams 计划 Task 9）：
 * - graphviz 本地引擎（viz-js 动态 import）真实 svg + 图/源码切换；
 * - plantuml kroki 模式：krokiHost 指向不可达 mock host，page.route 拦截
 *   `<host>/plantuml/svg/<base64url>` 供图——img 可见即证走 mock（host 不可达，
 *   真实网络必然 img error 降级源码面板），另有命中计数双保险；
 * - math 围栏本地 katex 渲染。
 * 契约（Task 3 wrapper）：.md-diagram > .md-diagram-bar(.md-diagram-lang+
 * .md-diagram-toggle) + .md-diagram-view + .md-diagram-source。
 * 注入通道与 b-markdown-html-docs 组一致（injectDir + openTreeFile，抽屉适配移动视口）；
 * 夹具落 samples/md/（m3.spec 同款 readFileSync 注入，样例库与 e2e 共用）。
 */
const samplerPath = fileURLToPath(new URL('../../../samples/md/diagrams-sampler.md', import.meta.url));
const SAMPLER = readFileSync(samplerPath, 'utf-8');

async function openSampler(page: Parameters<typeof injectDir>[0]): Promise<void> {
  await injectDir(page, [{ name: 'diagrams-sampler.md', content: SAMPLER }]);
  await openTreeFile(page, 'diagrams-sampler.md');
  await expect(page.locator('.vv-markdown')).toBeVisible({ timeout: 20_000 });
}

test.describe('b-md-diagrams 图表矩阵', () => {
  test('graphviz 本地渲染 svg + 图/源码切换', async ({ page }) => {
    test.setTimeout(60_000);
    // plantuml 默认 kroki 模式：拦掉真实 kroki.io 与 fallback 档官方服务器
    //（2026-10-30：kroki 失败会自动换 plantuml.com 重试，双 abort 保环境无关）
    await page.route('**kroki.io/**', (route) => route.abort());
    await page.route('**plantuml.com/**', (route) => route.abort());
    await openSampler(page);
    const wrap = page.locator('.vv-markdown .md-diagram').first();
    // 采样文档首个围栏是 graphviz（lang 标签实证 first() 指向），viz-js 本地渲染真实 svg
    await expect(wrap.locator('.md-diagram-lang')).toHaveText('graphviz');
    await expect(wrap.locator('.md-diagram-view svg')).toBeVisible({ timeout: 30_000 });

    // 图/源码切换：源码面板展开、视图隐藏、按钮文案反转
    await wrap.locator('.md-diagram-toggle').click();
    await expect(wrap.locator('.md-diagram-source')).toBeVisible();
    await expect(wrap.locator('.md-diagram-source code')).toContainText('digraph');
    await expect(wrap.locator('.md-diagram-view')).toBeHidden();
    await expect(wrap.locator('.md-diagram-toggle')).toHaveText('图');
  });

  test('kroki host 指向本地 mock：plantuml 走 kroki img', async ({ page }) => {
    test.setTimeout(60_000);
    // 拦截须在 goto（injectDir 内）前注册；krokiHost 用不可达 host，命中 mock 才可能有 img
    let krokiHits = 0;
    await page.route('**/plantuml/svg/*', (route) => {
      krokiHits += 1;
      return route.fulfill({
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>'
      });
    });
    // settings 白名单：krokiHost 须 http(s):// 前缀、modes 键须在注册表（plantuml）——
    // 注入值即白名单合法形态，一次 addInitScript 写全（loadSettings 直读）
    await page.addInitScript(() => {
      localStorage.setItem(
        'vviewer:settings',
        JSON.stringify({ diagrams: { krokiHost: 'http://kroki.mock', modes: { plantuml: 'kroki' } } })
      );
    });
    await openSampler(page);

    // kroki img：src = <host>/<type>/svg/<deflate+base64url>；kroki.mock 不可达，
    // img 可见 + mock 命中计数 ≥1 双证走的是 mock 而非真实 kroki
    const img = page.locator('.vv-markdown .md-diagram-view img[src^="http://kroki.mock/plantuml/svg/"]');
    await expect(img).toHaveCount(1);
    await expect(img).toBeVisible({ timeout: 30_000 });
    expect(krokiHits).toBeGreaterThanOrEqual(1);
    // kroki 视图不带 mermaid 重渲染锚（锚仅 mermaid 设置——Task 3 契约）
    await expect(img.locator('xpath=..')).not.toHaveAttribute('data-mermaid', /.+/);
  });

  test('math 围栏渲染 katex', async ({ page }) => {
    test.setTimeout(60_000);
    // 双 abort 同首用例：sampler 的 plantuml 围栏 kroki 失败后不得外发 fallback 档
    await page.route('**kroki.io/**', (route) => route.abort());
    await page.route('**plantuml.com/**', (route) => route.abort());
    await openSampler(page);
    // math 围栏 displayMode 渲染：.katex-display 包 .katex（区别于 $...$ 行内公式的 katex 步）
    const view = page.locator('.vv-markdown .md-diagram-view').filter({ has: page.locator('.katex') });
    await expect(view).toHaveCount(1);
    await expect(view.locator('.katex-display .katex')).toBeVisible({ timeout: 30_000 });
  });
});
