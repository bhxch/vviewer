import { expect, test, type Page } from '@playwright/test';
import { injectDir, openTreeFile } from './b-markdown-html-docs-helpers';

/**
 * b-fonts 字体系统冒烟（字体系统计划 Task 6，spec 2026-10-19）：
 * - 代码字号 16 → style#vv-font 双变量（16px/24px 行高）+ 渲染行随动 + j 滚动
 *   步长恰一行 + 顶行 data-line 映射不错位（行高错位即落 '2'）；重开页面（本地
 *   File 会话不跨刷新，重新注入打开）字号自 localStorage 恢复全链保持；
 * - UI 字号 → body 继承面即时生效（getComputedStyle 断言）；
 * - 网络字体列表：playwright route 伺服 https://fonts.mock/x.woff2（真 woff2
 *   字节 + CORS 头）→ 添加入库（样张行/管理行/两槽下拉「（网络）」选项）→
 *   槽位应用（style#vv-font）→ 删除确认后记录移除、document.fonts 注销、引用
 *   槽位回落默认栈；
 * - 预设切换即时生效（style#vv-font 内容断言，无刷新）。
 * 注入通道同 b-md-syntax（injectDir + openTreeFile，抽屉适配移动视口）；
 * 设置面板入口 ⚙（aria-label「设置」，b-app-shell-sources 同手法）。
 */

const LONG_CODE = 'const vv = 1; // c\n'.repeat(301);

// 最小真实 woff2 夹具（KaTeX_Size3-Regular.woff2，3624B，取自 katex dist——仅作
// 字体字节载体，名称/字形与断言无语义绑定）：FontFace.load 要求真实字体格式，
// 内嵌 base64 使本 spec 自包含（不依赖 node_modules 运行时路径与外部网络）。
const WOFF2_B64 = [
  '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',
  'WohG+LugzXiQRDeM3XYXlULv4dp5VFYC'
].join('');

/** 打开设置面板（⚙ aria-label「设置」→ role=dialog，t-theme 同手法）。 */
async function openSettings(page: Page): Promise<void> {
  await page.locator('button[aria-label="设置"]').click();
  await expect(page.getByRole('dialog', { name: '设置' })).toBeVisible();
}

/** document.fonts 内是否存在指定 family 的 Face（quotedFamily 引号包裹原文形态）。 */
function hasFontFace(page: Page, family: string): Promise<boolean> {
  return page.evaluate(
    (f) => [...document.fonts].some((face) => face.family === f),
    `"${family}"`
  );
}

/** style#vv-font 注入文本（textContent 口径——style 元素 innerText 为空串，
 * toContainText 不可用；b-theme-system 的 vv-code-theme 断言同手法）。 */
function fontCss(page: Page): Promise<string> {
  return page.evaluate(() => document.getElementById('vv-font')?.textContent ?? '');
}

test.describe('b-fonts 字体系统', () => {
  test('代码字号 16：行点击映射不错位 + 重开页面字号保持', async ({ page }) => {
    test.setTimeout(60_000);
    await injectDir(page, [{ name: 'long-code.js', type: 'text/javascript', content: LONG_CODE }]);
    await openTreeFile(page, 'long-code.js');
    await expect(page.locator('.vv-code-pre .vv-code-line').first()).toBeVisible();

    const rowHeight = () => page.locator('.vv-code-line').first().boundingBox().then((b) => b?.height);
    // 基线：默认 codeSize 13 → 行高 max(16, round(13×1.5)) = 20
    await expect.poll(rowHeight).toBe(20);
    const pre = page.locator('.vv-code-pre');

    await openSettings(page);
    await page.locator('input[aria-label="代码字号（px）"]').fill('16');
    await expect.poll(() => fontCss(page)).toContain('--vv-code-font-size: 16px');
    await expect.poll(() => fontCss(page)).toContain('--vv-code-line-height: 24px');
    await page.keyboard.press('Escape'); // 焦点在面板输入内，Esc 关闭
    await expect(page.getByRole('dialog', { name: '设置' })).toBeHidden();

    // 渲染行随动：opts.lineMetrics → render-text 虚拟滚动器局部行高
    await expect.poll(rowHeight).toBe(24);

    // 行点击映射：点击代码区聚焦（BUG-03 焦点态①手法），j 恰滚一行 24px；
    // 与可视区顶对齐的行必为 data-line=1（行高错位——如 scroller 仍按 20px——则落 '2'）
    await pre.click({ position: { x: 40, y: 40 } });
    await page.keyboard.press('j');
    await expect.poll(() => pre.evaluate((el) => el.scrollTop)).toBe(24);
    const topLine = await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>('.vv-code-pre');
      if (!el) return null;
      const top = el.getBoundingClientRect().top;
      for (const row of el.querySelectorAll<HTMLElement>('.vv-code-line')) {
        const r = row.getBoundingClientRect();
        if (r.top >= top - 1 && r.top < top + r.height) return row.dataset.line ?? null;
      }
      return null;
    });
    expect(topLine).toBe('1');

    // 重开页面（= 重启；本地 File 会话不跨刷新，重新注入打开）：字号自
    // localStorage 恢复，注入与渲染全链保持
    await injectDir(page, [{ name: 'long-code.js', type: 'text/javascript', content: LONG_CODE }]);
    await openTreeFile(page, 'long-code.js');
    await expect(page.locator('.vv-code-pre .vv-code-line').first()).toBeVisible();
    await expect.poll(() => fontCss(page)).toContain('--vv-code-font-size: 16px');
    await expect.poll(() => fontCss(page)).toContain('--vv-code-line-height: 24px');
    await expect.poll(rowHeight).toBe(24);
    await openSettings(page);
    await expect(page.locator('input[aria-label="代码字号（px）"]')).toHaveValue('16');
  });

  test('UI 字号：body 继承面即时生效', async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto('/');
    await expect.poll(() => fontCss(page)).toContain('--vv-ui-font-size: 16px');
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).fontSize)).toBe('16px');

    await openSettings(page);
    await page.locator('input[aria-label="界面字号（px）"]').fill('20');
    await expect.poll(() => fontCss(page)).toContain('--vv-ui-font-size: 20px');
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).fontSize)).toBe('20px');
  });

  test('字体列表：route 伺服 woff2 添加 → 样张/下拉生效 → 删除回落', async ({ page }) => {
    test.setTimeout(60_000);
    // 本地伺服 mock 字体源：真 woff2 字节 + CORS 头（fetch 默认 cors 模式）
    await page.route('https://fonts.mock/x.woff2', (route) =>
      route.fulfill({
        status: 200,
        headers: { 'content-type': 'font/woff2', 'access-control-allow-origin': '*' },
        body: Buffer.from(WOFF2_B64, 'base64')
      })
    );
    await page.goto('/');
    await openSettings(page);

    const fontForm = page.locator('form.vv-settings-add', {
      has: page.locator('input[aria-label="网络字体地址"]')
    });
    await page.locator('input[aria-label="网络字体地址"]').fill('https://fonts.mock/x.woff2');
    await fontForm.locator('button[type="submit"]').click();
    await expect(page.locator('.vv-settings-note', { hasText: '已添加字体「x」' })).toBeVisible();

    // 管理行 + 样张行 + FontFace 注册（name 推导 = 地址末段去扩展）
    const nameEl = page.locator('.vv-settings-font-name', { hasText: /^x$/ });
    await expect(nameEl).toBeVisible();
    const row = page.locator('.vv-settings-font', { has: nameEl });
    await expect(row.locator('.vv-settings-font-sample')).toBeVisible();
    await expect.poll(() => hasFontFace(page, 'x')).toBe(true);

    // 已启用字体进代码槽下拉（label「（网络）」标注来源）；选中即槽位应用
    const codeSelect = page.locator('select[aria-label="代码字体族"]');
    await expect(codeSelect.locator('option', { hasText: 'x（网络）' })).toHaveCount(1);
    await codeSelect.selectOption('x');
    await expect.poll(() => fontCss(page)).toContain('--vv-code-font: "x",');

    // 删除（window.confirm 须挂接受，b-wsx-recovery 同手法）：记录移除 +
    // document.fonts 注销 + 引用槽位回落默认栈
    page.on('dialog', (d) => void d.accept());
    await page.locator('button[aria-label="删除网络字体 x"]').click();
    await expect(
      page.locator('.vv-settings-note', { hasText: '已删除「x」，代码字体槽已回落默认字体' })
    ).toBeVisible();
    await expect(nameEl).toHaveCount(0);
    await expect(page.locator('.vv-settings-empty', { hasText: '暂无网络字体' })).toBeVisible();
    await expect.poll(() => hasFontFace(page, 'x')).toBe(false);
    const css = await fontCss(page);
    expect(css).toContain(
      '--vv-code-font: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace'
    );
    expect(css).not.toContain('"x"');
  });

  test('预设切换即时生效：style#vv-font 变量内容断言', async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto('/');
    // 默认空栈语义：直接回落默认栈原文（poll 等 TopBar 挂载首次注入）
    await expect.poll(() => fontCss(page)).toContain('--vv-ui-font: system-ui, -apple-system, sans-serif');
    await expect.poll(() => fontCss(page)).toContain(
      '--vv-code-font: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace'
    );

    await openSettings(page);
    await page.locator('select[aria-label="界面字体族"]').selectOption('微软雅黑');
    await expect
      .poll(() => fontCss(page))
      .toContain('--vv-ui-font: "微软雅黑", system-ui, -apple-system, sans-serif');
    await page.locator('select[aria-label="代码字体族"]').selectOption('Fira Code');
    await expect.poll(() => fontCss(page)).toContain('--vv-code-font: "Fira Code", ui-monospace');
    // 代码槽切换不回滚 UI 槽（两槽独立持久化）
    await expect.poll(() => fontCss(page)).toContain('--vv-ui-font: "微软雅黑"');
  });
});
