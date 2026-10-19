import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { injectDir, openTreeFile } from './b-markdown-html-docs-helpers';

/**
 * b-md-lightbox 灯箱全交互冒烟（md-lightbox 计划 Task 3）：
 * - 开/导航/关：点击图开 body 级单例 overlay，←/→（环绕）计数徽标变化，Esc 关；
 * - 画廊共集：graphviz 本地引擎（viz-js 动态 import）渲染的图表 svg 经
 *   collectGallery 入列——开灯箱后 next 三步到位（img 宿主隐藏/svg 宿主显示）；
 * - 缩放：+ 键视口中心 1.25 倍步进（stage transform scale 变化）、r 键复位 1:1；
 * - 平移：鼠标拖拽 stage → transform translate 增量变化（chromium project 桌面
 *   基准，375px 移动视口拖拽坐标不可靠沿用 TA-02 惯例跳过）；拖尾 click 被吞
 *   （dragMoved >3px 阈值）——overlay 仍开即证。
 * 断言面读 stage 内联 style（applyState 直写 transform，真实浏览器行为；jsdom 之外
 * 才可测缩放/拖拽——台账雷区）。注入通道与 b-md-diagrams 组一致（injectDir +
 * openTreeFile）；夹具落 samples/md/（readFileSync 注入，样例库与 e2e 共用）。
 * 采样文档仅 graphviz 围栏（本地渲染无外部网络），无需 kroki 拦截。
 */
const samplerPath = fileURLToPath(new URL('../../../samples/md/lightbox-sampler.md', import.meta.url));
const SAMPLER = readFileSync(samplerPath, 'utf-8');

async function openSampler(page: Parameters<typeof injectDir>[0]): Promise<void> {
  await injectDir(page, [{ name: 'lightbox-sampler.md', content: SAMPLER }]);
  await openTreeFile(page, 'lightbox-sampler.md');
  await expect(page.locator('.vv-markdown')).toBeVisible({ timeout: 20_000 });
}

test.describe('b-md-lightbox 灯箱全交互', () => {
  test('开-导航-关：点击图开 overlay，←/→ 计数徽标环绕变化，Esc 关', async ({ page }) => {
    test.setTimeout(60_000);
    await openSampler(page);
    const imgs = page.locator('.vv-markdown img[data-md-lightbox]');
    await expect(imgs).toHaveCount(3);
    const overlay = page.locator('#md-lightbox-overlay');

    // 开：点击首图 → 画廊计 4 条（3 img + 1 图表 svg），计数徽标 1/4
    await imgs.first().click();
    await expect(overlay).toBeVisible();
    const count = overlay.locator('.md-lightbox-count');
    await expect(count).toHaveText('1/4');

    // →/→ 环绕导航：1→2→1→4（index 0 左移环绕到末位）
    await page.keyboard.press('ArrowRight');
    await expect(count).toHaveText('2/4');
    await page.keyboard.press('ArrowLeft');
    await expect(count).toHaveText('1/4');
    await page.keyboard.press('ArrowLeft');
    await expect(count).toHaveText('4/4');

    // 关：Esc 摘除 body 级 overlay
    await page.keyboard.press('Escape');
    await expect(overlay).toHaveCount(0);
  });

  test('图表 svg 在画廊内：开灯箱后 next 三步到 graphviz 图', async ({ page }) => {
    test.setTimeout(60_000);
    await openSampler(page);
    // 图表先真实渲染（collectGallery 点击时收集 .md-diagram-view svg）
    await expect(page.locator('.vv-markdown .md-diagram-view svg')).toBeVisible({ timeout: 30_000 });
    const overlay = page.locator('#md-lightbox-overlay');
    await page.locator('.vv-markdown img[data-md-lightbox]').first().click();
    await expect(overlay).toBeVisible();

    // next 按钮三步到画廊末位（图表 svg 条目）：svg 宿主注入显示、img 克隆隐藏
    await overlay.locator('.md-lightbox-btn-next').click();
    await overlay.locator('.md-lightbox-btn-next').click();
    await overlay.locator('.md-lightbox-btn-next').click();
    await expect(overlay.locator('.md-lightbox-count')).toHaveText('4/4');
    const svgHost = overlay.locator('.md-lightbox-svg');
    await expect(svgHost).toBeVisible();
    await expect(svgHost.locator('svg')).toBeVisible();
    await expect(overlay.locator('img.md-lightbox')).toBeHidden();
  });

  test('缩放：+ 键 transform scale 步进、r 键复位 1:1', async ({ page }) => {
    test.setTimeout(60_000);
    await openSampler(page);
    const overlay = page.locator('#md-lightbox-overlay');
    await page.locator('.vv-markdown img[data-md-lightbox]').first().click();
    await expect(overlay).toBeVisible();
    const stage = overlay.locator('.md-lightbox-stage');
    await expect(stage).toHaveAttribute('style', /scale\(1\)/);

    // + 键视口中心 1.25 倍步进：scale 变化（中心锚定连带 translate 偏移，不锁定值）
    await page.keyboard.press('+');
    await expect(stage).toHaveAttribute('style', /scale\(1\.25\)/);
    await page.keyboard.press('+');
    await expect(stage).toHaveAttribute('style', /scale\(1\.5625\)/);

    // r 键复位：translate 归零、scale 回 1
    await page.keyboard.press('r');
    await expect(stage).toHaveAttribute('style', /translate\(0px, 0px\) scale\(1\)/);
  });

  test('平移：鼠标拖拽后 transform translate 增量变化', async ({ page }) => {
    test.skip(test.info().project.name !== 'chromium', '鼠标拖拽平移桌面基准（chromium project，TA-02 惯例）');
    test.setTimeout(60_000);
    await openSampler(page);
    const overlay = page.locator('#md-lightbox-overlay');
    await page.locator('.vv-markdown img[data-md-lightbox]').first().click();
    await expect(overlay).toBeVisible();
    const stage = overlay.locator('.md-lightbox-stage');
    await expect(stage).toHaveAttribute('style', /translate\(0px, 0px\) scale\(1\)/);

    // 拖拽 (+96, +48)（分步位移，越过 3px dragMoved 阈值）→ translate 增量写入。
    // 起点取视口中心：stage 铺满 overlay，命中克隆图也经冒泡触发 stage mousedown
    const vx = page.viewportSize()!.width / 2;
    const vy = page.viewportSize()!.height / 2;
    await page.mouse.move(vx, vy);
    await page.mouse.down();
    await page.mouse.move(vx + 96, vy + 48, { steps: 8 });
    await page.mouse.up();

    await expect(stage).toHaveAttribute('style', /translate\(96px, 48px\) scale\(1\)/);
    // 拖拽吞尾 click（dragMoved）：不误关，overlay 仍开
    await expect(overlay).toBeVisible();
  });
});
