import { expect, test, type Page } from '@playwright/test';
import { injectDir, openTreeFile } from './b-markdown-html-docs-helpers';
import { WOFF2_B64 } from './font-fixture';
import { applySettings, closeSettings, gotoGroup, openSettings } from './settings-center';

/**
 * b-fonts 字体系统冒烟（字体系统计划 Task 6，spec 2026-10-19；设置中心迁移）：
 * - 代码字号 16 → style#vv-font 双变量（16px/24px 行高）+ 渲染行随动 + j 滚动
 *   步长恰一行 + 顶行 data-line 映射不错位（行高错位即落 '2'）；重开页面（本地
 *   File 会话不跨刷新，重新注入打开）字号自 localStorage 恢复全链保持；
 * - UI 字号 → body 继承面生效（getComputedStyle 断言）；
 * - 网络字体列表：playwright route 伺服 https://fonts.mock/x.woff2（真 woff2
 *   字节 + CORS 头）→ 添加入库（样张行/管理行/两槽下拉「（网络）」选项）→
 *   槽位应用（style#vv-font）→ 删除确认后记录移除、document.fonts 注销、引用
 *   槽位回落默认栈；
 * - 预设切换生效（style#vv-font 内容断言，无刷新）；
 * - 台账 M2 披露：删除被引用字体只写草稿，放弃后悬空引用残留（CSS 多级回退兜底）。
 * 注入通道同 b-md-syntax（injectDir + openTreeFile，抽屉适配移动视口）；
 * 设置中心入口 ⚙（aria-label「设置」）→「字体」组；草稿改动统一「应用」后经
 * 订阅链注入（e2e/settings-center.ts 装置）。
 */

const LONG_CODE = 'const vv = 1; // c\n'.repeat(301);

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
    await gotoGroup(page, '字体');
    const codeSizeInput = page.locator('input[aria-label="代码字号（px）"]');
    // 逐键键入（终审 I-1 防回潮）：fill('') 清场（空串不落盘）后逐键「1」「6」——
    // oninput 若把中间值「1」clamp 成 10 回写输入框，下一位拼成「106」→ clamp 28；
    // 渐进语义保持则终值恰为 16（输入框原样 + 注入值）。草稿模型下字号 onchange
    // 单点回写（输入途中不写 draft），回车提交后再统一「应用」落盘注入
    await codeSizeInput.fill('');
    await codeSizeInput.pressSequentially('16');
    await expect(codeSizeInput).toHaveValue('16');
    await codeSizeInput.press('Enter'); // onchange 提交进草稿
    await applySettings(page);
    await expect.poll(() => fontCss(page)).toContain('--vv-code-font-size: 16px');
    await expect.poll(() => fontCss(page)).toContain('--vv-code-line-height: 24px');
    await closeSettings(page); // 已应用（非脏）→ Esc 直关

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
    await gotoGroup(page, '字体');
    await expect(page.locator('input[aria-label="代码字号（px）"]')).toHaveValue('16');
  });

  test('UI 字号：body 继承面即时生效', async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto('/');
    await expect.poll(() => fontCss(page)).toContain('--vv-ui-font-size: 16px');
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).fontSize)).toBe('16px');

    await openSettings(page);
    await gotoGroup(page, '字体');
    await page.locator('input[aria-label="界面字号（px）"]').fill('20');
    await page.locator('input[aria-label="界面字号（px）"]').press('Enter');
    await applySettings(page);
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
    await gotoGroup(page, '字体');

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

    // 已启用字体进代码槽下拉（label「（网络）」标注来源）；选中写草稿，应用后槽位生效
    const codeSelect = page.locator('select[aria-label="代码字体族"]');
    await expect(codeSelect.locator('option', { hasText: 'x（网络）' })).toHaveCount(1);
    await codeSelect.selectOption('x');
    await applySettings(page);
    await expect.poll(() => fontCss(page)).toContain('--vv-code-font: "x",');

    // 删除（window.confirm 须挂接受，b-wsx-recovery 同手法）：记录移除 +
    // document.fonts 注销 + 引用槽位草稿回落（「应用」后经订阅链注入默认栈）
    page.on('dialog', (d) => void d.accept());
    await page.locator('button[aria-label="删除网络字体 x"]').click();
    await expect(
      page.locator('.vv-settings-note', { hasText: '已删除「x」，代码字体槽已回落默认字体' })
    ).toBeVisible();
    await expect(nameEl).toHaveCount(0);
    await expect(page.locator('.vv-settings-empty', { hasText: '暂无网络字体' })).toBeVisible();
    await expect.poll(() => hasFontFace(page, 'x')).toBe(false);
    await applySettings(page);
    const css = await fontCss(page);
    expect(css).toContain(
      '--vv-code-font: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace'
    );
    expect(css).not.toContain('"x"');
  });

  test('预设切换生效：style#vv-font 变量内容断言', async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto('/');
    // 默认空栈语义：直接回落默认栈原文（poll 等 TopBar 挂载首次注入）
    await expect.poll(() => fontCss(page)).toContain('--vv-ui-font: system-ui, -apple-system, sans-serif');
    await expect.poll(() => fontCss(page)).toContain(
      '--vv-code-font: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace'
    );

    await openSettings(page);
    await gotoGroup(page, '字体');
    await page.locator('select[aria-label="界面字体族"]').selectOption('微软雅黑');
    await applySettings(page);
    await expect
      .poll(() => fontCss(page))
      .toContain('--vv-ui-font: "微软雅黑", system-ui, -apple-system, sans-serif');
    await page.locator('select[aria-label="代码字体族"]').selectOption('Fira Code');
    await applySettings(page);
    await expect.poll(() => fontCss(page)).toContain('--vv-code-font: "Fira Code", ui-monospace');
    // 代码槽切换不回滚 UI 槽（两槽独立持久化）
    await expect.poll(() => fontCss(page)).toContain('--vv-ui-font: "微软雅黑"');
  });

  // 台账 M2 披露（Task 1+2 报告同源取舍）：网络字体管理即时生效（IndexedDB 管线
  // 不属 settings schema），但删除被引用字体只把槽位回落写进草稿——「放弃」后草稿
  // 还原为最近应用值，悬空字体名残留于持久设置。此时不悬空失控：CSS 多级回退栈
  // 原样兜住渲染（fontFamilyValue 注入 "x", <默认栈>），字体系统 spec §5.2 语义。
  test('披露 M2：删除被引用字体后放弃草稿——悬空引用残留且渲染由回退栈兜底', async ({ page }) => {
    test.setTimeout(60_000);
    await page.route('https://fonts.mock/x.woff2', (route) =>
      route.fulfill({
        status: 200,
        headers: { 'content-type': 'font/woff2', 'access-control-allow-origin': '*' },
        body: Buffer.from(WOFF2_B64, 'base64')
      })
    );
    await page.goto('/');
    await openSettings(page);
    await gotoGroup(page, '字体');

    await page.locator('input[aria-label="网络字体地址"]').fill('https://fonts.mock/x.woff2');
    await page.locator('form.vv-settings-add').locator('button[type="submit"]').click();
    await expect(page.locator('.vv-settings-note', { hasText: '已添加字体「x」' })).toBeVisible();
    await page.locator('select[aria-label="代码字体族"]').selectOption('x');
    await applySettings(page);
    await expect.poll(() => fontCss(page)).toContain('--vv-code-font: "x",');

    // 删除被引用字体：库与 document.fonts 即时移除，槽位回落只写草稿
    page.on('dialog', (d) => void d.accept());
    await page.locator('button[aria-label="删除网络字体 x"]').click();
    await expect(
      page.locator('.vv-settings-note', { hasText: '已删除「x」，代码字体槽已回落默认字体' })
    ).toBeVisible();

    // 放弃（不应用）：草稿还原为最近应用值——悬空 "x" 残留持久设置（披露断言本体）
    await page.locator('.vv-sc-discard').click();
    await closeSettings(page);
    const saved = await page.evaluate(
      () => (JSON.parse(localStorage.getItem('vviewer:settings') ?? '{}') as { fonts?: { codeFamily?: string } }).fonts?.codeFamily
    );
    expect(saved).toBe('x');
    // 悬空不失控：document.fonts 已注销，CSS 回退栈兜住渲染（"x", 默认栈 形态保留）
    await expect.poll(() => hasFontFace(page, 'x')).toBe(false);
    await expect.poll(() => fontCss(page)).toContain('--vv-code-font: "x", ui-monospace');
  });
});
