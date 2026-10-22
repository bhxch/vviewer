import { expect, test, type Locator, type Page } from '@playwright/test';
import { injectDir, openTreeFile } from './b-markdown-html-docs-helpers';
import { WOFF2_B64 } from './font-fixture';
import { applySettings, closeSettings, gotoGroup, openSettings } from './settings-center';

/**
 * b-fonts-deep 字体系统补强（b-fonts 冒烟五例之外的边界/负路径/组合交互面，
 * spec 2026-10-19 字体系统 + settings center §2；断言口径沿用 b-fonts：
 * style#vv-font textContent（innerText 恒空串）+ 用户可见结果，不锚实现细节）：
 * - FNT-01 字号 clamp 边界（UI 通道）：codeSize 35→28 / 0→9 / 13.7→14（终审 M-2
 *   取整回正），行高公式边界 28→42、9→16（max(16,·) 下限）、14→21 + j 步长恰 16；
 *   uiSize 0→10 / 99→28 body 继承面
 * - FNT-02 脏 localStorage 直写：fonts 节白名单字段级归位——uiSize 999→28、
 *   codeSize -3→9、codeFamily 非字符串→默认栈、合法 uiFamily 原样保留
 * - FNT-03 family 注入转义对抗 + 逗号栈语义：含引号/分号/花括号的 family 不破
 *   style#vv-font 规则（行高 36px 不回落 app.css 20px、99px 毒值不生效）、
 *   通用族关键字段裸写、原文落 localStorage、重开设置手输值保留
 * - FNT-04 hex 行高同步 + 点击/键盘字节映射：行盒随 codeSize 重渲（20→36px）、
 *   行点击 ASCII 列定位字节、→ 步进、跳转 0x400 在新行高下落对行
 * - FNT-05 markdown 行内 code：codeSize 变化不改变行内 code 计算字号（.9em 相对
 *   面不变）、codeFamily 变化即时联动 font-family
 * - FNT-06 本地上传通道全链：input[type=file] 上传 woff2（样张/体积/下拉/FontFace）
 *   + 同名门禁 + 30MB 超限拒收
 * - FNT-07 URL 负路径：http 拒收（混合内容防线）、非字体内容错误态（先装载验证
 *   后入库不留死记录）、重试恢复、忽略清理
 * - FNT-08 名称门禁与下拉撞车过滤：逗号名/同同名拒收；名为 __custom__ 的字体不进
 *   下拉（哨兵撞车过滤，3d8454e 回归锚）且哨兵语义不坏；预设撞名（Roboto）同过滤
 * - FNT-09 IDB 持久化与启停全链：reload 后记录/FontFace/下拉重建、停用注销且
 *   下拉移除、再启用重建
 * - FNT-10 配额超限引导：mock fonts store 写入 QuotaExceededError（1823660）→
 *   错误态附「设置→存储与数据」清理引导、记录不落库
 * 装置：injectDir/openTreeFile（抽屉适配移动视口）+ settings-center 管线 +
 * WOFF2_B64 真 woff2 字节（FontFace.load 要求真实格式）。全部用例双 project
 * （chromium/mobile）同形态可跑，无桌面专属交互。
 */

/** style#vv-font 注入文本（textContent 口径——style 元素 innerText 为空串）。 */
function fontCss(page: Page): Promise<string> {
  return page.evaluate(() => document.getElementById('vv-font')?.textContent ?? '');
}

/** document.fonts 内是否存在指定 family 的 Face（quotedFamily 引号包裹原文形态）。 */
function hasFontFace(page: Page, family: string): Promise<boolean> {
  return page.evaluate(
    (f) => [...document.fonts].some((face) => face.family === f),
    `"${family}"`
  );
}

/** :root 上 CSS 变量计算值（毒值/规则整体失效的行为面探针——style#vv-font 命中
 * app.css :root 之后，规则被破即回落 app.css 兜底值）。 */
function rootVar(page: Page, name: string): Promise<string> {
  return page.evaluate(
    (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(),
    name
  );
}

/** 元素布局高度（行盒断言用）。 */
async function boxHeight(loc: Locator): Promise<number | undefined> {
  return (await loc.boundingBox())?.height;
}

/** 网络字体 woff2 源（真字节 + CORS 头——fetch 默认 cors 模式）。 */
async function routeWoff2(page: Page, url: string, body: Buffer | string): Promise<void> {
  await page.route(url, (r) =>
    r.fulfill({
      status: 200,
      headers: { 'content-type': 'font/woff2', 'access-control-allow-origin': '*' },
      body
    })
  );
}

/** 网络字体组：填地址 → 提交。 */
async function submitFontUrl(page: Page, url: string, name?: string): Promise<void> {
  await page.locator('input[aria-label="网络字体地址"]').fill(url);
  if (name !== undefined) {
    await page.locator('input[aria-label="网络字体名称（可选）"]').fill(name);
  }
  await page.locator('form.vv-settings-add').locator('button[type="submit"]').click();
}

/** 字号输入（onchange 提交语义：fill 后回车才进草稿——同 b-fonts 冒烟手法）。 */
async function commitSize(page: Page, ariaLabel: string, value: string): Promise<void> {
  const inp = page.locator(`input[aria-label="${ariaLabel}"]`);
  await inp.fill(value);
  await inp.press('Enter');
}

test.describe('b-fonts-deep 字体系统补强', () => {
  // FNT-01：字号 clamp 边界——越界值经 onchange 规范化回写、行高公式两处边界
  //（28→42 上界、9→16 下限）与 j 滚动步长联动、小数输入终审 M-2 取整回正。
  test('FNT-01 字号边界：越界钳制 + 行高公式边界 + j 步长联动', async ({ page }) => {
    test.setTimeout(60_000);
    const LONG_CODE = 'const vv = 1; // c\n'.repeat(301);
    await injectDir(page, [{ name: 'clamp.js', type: 'text/javascript', content: LONG_CODE }]);
    await openTreeFile(page, 'clamp.js');
    const rowHeight = () => boxHeight(page.locator('.vv-code-line').first());

    await openSettings(page);
    await gotoGroup(page, '字体');
    const codeSize = page.locator('input[aria-label="代码字号（px）"]');

    // 越界上抛 35 → 规范化回写 28；行高 round(28×1.5)=42
    await commitSize(page, '代码字号（px）', '35');
    await expect(codeSize).toHaveValue('28');
    await applySettings(page);
    await expect.poll(() => fontCss(page), { timeout: 20_000 }).toContain('--vv-code-font-size: 28px');
    await expect.poll(() => fontCss(page)).toContain('--vv-code-line-height: 42px');
    await expect.poll(rowHeight, { timeout: 20_000 }).toBe(42);

    // 越界下探 0 → 钳到下界 9；行高 max(16, round(9×1.5)=14) = 16（下限兜底）
    await commitSize(page, '代码字号（px）', '0');
    await expect(codeSize).toHaveValue('9');
    await applySettings(page);
    await expect.poll(() => fontCss(page)).toContain('--vv-code-line-height: 16px');
    await expect.poll(rowHeight, { timeout: 20_000 }).toBe(16);

    // 行高联动滚动常数：j 恰滚一行 16px，顶行映射 data-line=1（错位即落 '2'）。
    // 设置中心是全屏 overlay——代码 pre 在其覆盖下 click 等 actionability 永不满足
    //（60s 测试超时无栈），交互段前必须先关页；草稿已应用（applySettings 脏态清）
    // Esc 直接关不弹确认
    await closeSettings(page);
    const pre = page.locator('.vv-code-pre');
    await pre.click({ position: { x: 40, y: 40 } });
    await page.keyboard.press('j');
    await expect.poll(() => pre.evaluate((el) => el.scrollTop), { timeout: 20_000 }).toBe(16);
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

    // 小数 13.7 → round 14（终审 M-2：输入侧与白名单侧同一取整口径），行高 21
    await openSettings(page);
    await gotoGroup(page, '字体');
    await commitSize(page, '代码字号（px）', '13.7');
    await expect(codeSize).toHaveValue('14');
    await applySettings(page);
    await expect.poll(() => fontCss(page)).toContain('--vv-code-line-height: 21px');
    await expect.poll(rowHeight, { timeout: 20_000 }).toBe(21);

    // UI 字号边界：0→10 / 99→28，body 继承面随钳制值生效
    const uiSize = page.locator('input[aria-label="界面字号（px）"]');
    await commitSize(page, '界面字号（px）', '0');
    await expect(uiSize).toHaveValue('10');
    await applySettings(page);
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).fontSize)).toBe('10px');
    await commitSize(page, '界面字号（px）', '99');
    await expect(uiSize).toHaveValue('28');
    await applySettings(page);
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).fontSize)).toBe('28px');
  });

  // FNT-02：脏 localStorage 直写负路径——fonts 节白名单对脏 JSON 字段级归位
  //（字号钳制/非数字归默认/family 非字符串归空栈）且合法字段原样保留，不抛不整页回落。
  test('FNT-02 脏 localStorage：fonts 节字段级钳制与归位', async ({ page }) => {
    test.setTimeout(60_000);
    await page.addInitScript(() => {
      localStorage.setItem(
        'vviewer:settings',
        JSON.stringify({
          fonts: { uiFamily: '微软雅黑', uiSize: 999, codeFamily: 42, codeSize: -3 }
        })
      );
    });
    await page.goto('/');
    await expect.poll(() => fontCss(page), { timeout: 20_000 }).toContain('--vv-ui-font: "微软雅黑"');
    await expect.poll(() => fontCss(page)).toContain('--vv-ui-font-size: 28px'); // 999 → 上界
    await expect.poll(() => fontCss(page)).toContain('--vv-code-font: ui-monospace'); // 非字符串 → 默认栈
    await expect.poll(() => fontCss(page)).toContain('--vv-code-font-size: 9px'); // -3 → 下界
    await expect.poll(() => fontCss(page)).toContain('--vv-code-line-height: 16px'); // max(16, round(13.5))
    await expect
      .poll(() => page.evaluate(() => getComputedStyle(document.body).fontSize))
      .toBe('28px');

    // 设置面板回显钳制后的生效值（非脏原文）
    await openSettings(page);
    await gotoGroup(page, '字体');
    await expect(page.locator('input[aria-label="界面字号（px）"]')).toHaveValue('28');
    await expect(page.locator('input[aria-label="代码字号（px）"]')).toHaveValue('9');
    await expect(page.locator('select[aria-label="界面字体族"]')).toHaveValue('微软雅黑');
    await expect(page.locator('select[aria-label="代码字体族"]')).toHaveValue('');
  });

  // FNT-03：family 注入转义对抗——引号/分号/花括号在逐段引号包裹后失去语法效力，
  // style#vv-font 规则整体存活（行高 36px 不回落 app.css 兜底 20px、毒值 99px 不生效）；
  // 逗号栈逐段引号、通用族关键字裸写；原文落 localStorage；重开设置手输值保留。
  test('FNT-03 family 转义对抗与逗号栈：注入不失控 + 原文持久化', async ({ page }) => {
    test.setTimeout(60_000);
    const EVIL_UI = 'x"y; } :root{--vv-ui-font-size:99px}';
    await page.goto('/');
    await openSettings(page);
    await gotoGroup(page, '字体');

    // 先立 36px 行高基线（style#vv-font 规则存活的判别锚：若被毒坏整体回落 20px）
    await commitSize(page, '代码字号（px）', '24');
    await applySettings(page);
    await expect.poll(() => rootVar(page, '--vv-code-line-height'), { timeout: 20_000 }).toBe('36px');

    // 界面槽手输毒值 family：不出现注入失控
    await page.locator('select[aria-label="界面字体族"]').selectOption('__custom__');
    await page.locator('input[aria-label="自定义界面字体族"]').fill(EVIL_UI);
    await applySettings(page);
    await expect
      .poll(() => fontCss(page), { timeout: 20_000 })
      .toContain('--vv-ui-font: "x\\"y; } :root{--vv-ui-font-size:99px}", system-ui');
    await expect.poll(() => rootVar(page, '--vv-ui-font-size')).toBe('16px'); // 毒值未生效
    await expect.poll(() => rootVar(page, '--vv-code-line-height')).toBe('36px'); // 规则未被破
    await expect
      .poll(() => page.evaluate(() => getComputedStyle(document.body).fontSize))
      .toBe('16px');

    // 代码槽手输逗号栈：自定义名逐段引号、通用族关键字 monospace 裸写、末接默认栈
    await page.locator('select[aria-label="代码字体族"]').selectOption('__custom__');
    await page.locator('input[aria-label="自定义代码字体族"]').fill('JetBrains Mono, monospace');
    await applySettings(page);
    await expect
      .poll(() => fontCss(page))
      .toContain('--vv-code-font: "JetBrains Mono", monospace, ui-monospace');

    // 槽位存原文（转义只在注入侧），不拆栈语义
    const saved = await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem('vviewer:settings') ?? '{}') as {
          fonts?: { uiFamily?: string; codeFamily?: string };
        }
    );
    expect(saved.fonts?.uiFamily).toBe(EVIL_UI);
    expect(saved.fonts?.codeFamily).toBe('JetBrains Mono, monospace');

    // 重开设置：两槽均回「自定义…」哨兵 + 手输框保留原文（转义后值可往返编辑）
    await closeSettings(page);
    await openSettings(page);
    await gotoGroup(page, '字体');
    await expect(page.locator('select[aria-label="界面字体族"]')).toHaveValue('__custom__');
    await expect(page.locator('input[aria-label="自定义界面字体族"]')).toHaveValue(EVIL_UI);
    await expect(page.locator('select[aria-label="代码字体族"]')).toHaveValue('__custom__');
    await expect(page.locator('input[aria-label="自定义代码字体族"]')).toHaveValue('JetBrains Mono, monospace');
  });

  // FNT-04：hex 视图行高同步与字节定位——codeSize 变化经 lineMetrics 协议重渲
  // hex（行盒 20→36px）、行点击 ASCII 列/键盘 → 的字节映射不错位、跳转 0x20
  // 在新行高下落对行（滚动常数与行盒同源一致性）。
  test('FNT-04 hex 行高同步：点击/键盘字节映射 + 跳转常数一致', async ({ page }) => {
    test.setTimeout(60_000);
    // 4096 字节（256 行）：byte0=0x41 供点击定位，余下 00/ff 交替——NUL 在场使
    // looksTextual 判二进制（NUL 出现即非文本），确保 .bin 落 hex 渲染器
    const bytes = new Uint8Array(4096);
    bytes[0] = 0x41;
    for (let i = 1; i < bytes.length; i++) bytes[i] = i % 2 === 1 ? 0x00 : 0xff;
    await injectDir(page, [
      {
        name: 'metrics.bin',
        type: 'application/octet-stream',
        content: '', // 二进制素材走 b64，content 忽略
        b64: Buffer.from(bytes).toString('base64')
      }
    ]);
    await openTreeFile(page, 'metrics.bin');
    await expect(page.locator('.vv-hex-row').first()).toBeVisible({ timeout: 20_000 });
    const dump = page.locator('.vv-hex-dump');
    await expect
      .poll(() => boxHeight(dump.locator('.vv-hex-row').first()), { timeout: 20_000 })
      .toBe(20); // 默认 codeSize 13 → 行高 20

    // 行点击映射：点击行 0 ASCII 列首字符（列 60 = 偏移 8 + 2 + hex 47 + 2 + '|'）→
    // 光标落字节 0（0x41），hex/ASCII 两列同档高亮
    const firstRow = dump.locator('.vv-hex-row').first();
    await expect(firstRow).toHaveText(/^00000000 {2}41/);
    const box = (await firstRow.boundingBox())!;
    await firstRow.click({
      position: { x: Math.round((box.width * 60.5) / 77), y: Math.round(box.height / 2) }
    });
    await expect(dump.locator('.vv-hex-cursor').first()).toHaveText('41', { timeout: 20_000 });
    await expect(dump.locator('.vv-hex-cursor')).toHaveCount(2);
    // 键盘 → 字节步进 0x41 → 0x00
    await page.keyboard.press('ArrowRight');
    await expect(dump.locator('.vv-hex-cursor').first()).toHaveText('00', { timeout: 20_000 });

    // 字号 24 → fonts rev 触发 hex 重渲：行盒随动 36px，数据面完整
    await openSettings(page);
    await gotoGroup(page, '字体');
    await commitSize(page, '代码字号（px）', '24');
    await applySettings(page);
    await closeSettings(page);
    await expect
      .poll(() => boxHeight(dump.locator('.vv-hex-row').first()), { timeout: 20_000 })
      .toBe(36);
    await expect(dump.locator('.vv-hex-row').first()).toHaveText(/^00000000 {2}41/);

    // 跳转 0x400：虚拟滚动器以新行高换算目标行坐标——行高错位即落错行
    await page.locator('input[aria-label="跳转到偏移"]').fill('0x400');
    await page.locator('input[aria-label="跳转到偏移"]').press('Enter');
    await expect(
      dump.locator('.vv-hex-row', { hasText: /^00000400/ })
    ).toBeVisible({ timeout: 20_000 });
  });

  // FNT-05：markdown 行内 code 相对字号约束——codeSize 变化不改变行内 code 的
  // 计算字号（.9em 相对面 = 界面字号，与代码字号解耦），codeFamily 变化即时联动。
  test('FNT-05 markdown 行内 code：字号相对不变 + 字族联动', async ({ page }) => {
    test.setTimeout(60_000);
    await injectDir(page, [
      { name: 'inline-code.md', content: '# 字体样张\n\n正文 inline 样张 `const vv = 1;` 结束。\n' }
    ]);
    await openTreeFile(page, 'inline-code.md');
    const inlineCode = page.locator('.vv-markdown p code');
    await expect(inlineCode).toBeVisible({ timeout: 20_000 });
    const inlineFontSize = () =>
      inlineCode.evaluate((el) => getComputedStyle(el).fontSize);
    await expect.poll(inlineFontSize, { timeout: 20_000 }).toBe('14.4px'); // 0.9 × uiSize 16

    await openSettings(page);
    await gotoGroup(page, '字体');
    await commitSize(page, '代码字号（px）', '24');
    await page.locator('select[aria-label="代码字体族"]').selectOption('Fira Code');
    await applySettings(page);
    await expect.poll(() => fontCss(page), { timeout: 20_000 }).toContain('--vv-code-font-size: 24px');
    await expect.poll(() => fontCss(page)).toContain('--vv-code-font: "Fira Code"');

    // 行内 code 计算字号不随 codeSize 变（仍 0.9 × 16），字族随 --vv-code-font 联动
    await expect.poll(inlineFontSize, { timeout: 20_000 }).toBe('14.4px');
    await expect
      .poll(() => inlineCode.evaluate((el) => getComputedStyle(el).fontFamily))
      .toContain('Fira Code');
  });

  // FNT-06：本地上传通道全链——File 注入上传 woff2（名称取文件名去扩展）→
  // 样张/体积/下拉/FontFace；同名门禁（重传同名文件）；30MB 超限拒收（体积门禁）。
  test('FNT-06 上传通道：woff2 入库 + 同名门禁 + 30MB 拒收', async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto('/');
    await openSettings(page);
    await gotoGroup(page, '字体');
    const fileInput = page.locator('input[type="file"][accept=".ttf,.otf,.woff,.woff2"]');
    const woff2 = Buffer.from(WOFF2_B64, 'base64');

    await fileInput.setInputFiles({ name: 'specimen.woff2', mimeType: 'font/woff2', buffer: woff2 });
    await expect(page.locator('.vv-settings-note', { hasText: '已添加字体「specimen」' })).toBeVisible({
      timeout: 20_000
    });
    const row = page.locator('.vv-settings-font', {
      has: page.locator('.vv-settings-font-name', { hasText: /^specimen$/ })
    });
    await expect(row.locator('.vv-settings-font-sample')).toBeVisible();
    await expect(row.locator('.vv-settings-font-size')).toHaveText('4 KB'); // 3624B → round 4KB
    await expect
      .poll(() => hasFontFace(page, 'specimen'), { timeout: 20_000 })
      .toBe(true);
    await expect(
      page.locator('select[aria-label="代码字体族"] option', { hasText: 'specimen（网络）' })
    ).toHaveCount(1);

    // 同名门禁：重传同名文件（名称仍取 specimen）→ 注记报错、不产生第二条记录
    await fileInput.setInputFiles({ name: 'specimen.woff2', mimeType: 'font/woff2', buffer: woff2 });
    await expect(
      page.locator('.vv-settings-note', { hasText: '已存在同名字体「specimen」' })
    ).toBeVisible({ timeout: 20_000 });
    await expect(
      page.locator('.vv-settings-font-name', { hasText: /^specimen$/ })
    ).toHaveCount(1);

    // 30MB 门禁：30MB+1 文件在装载验证前拒收（体积门禁先于 FontFace 解析）
    await fileInput.setInputFiles({
      name: 'huge.woff2',
      mimeType: 'font/woff2',
      buffer: Buffer.alloc(30 * 1024 * 1024 + 1, 0x41)
    });
    await expect(
      page.locator('.vv-settings-note', { hasText: '字体文件超过 30MB 上限' })
    ).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('.vv-settings-font-name', { hasText: /^huge$/ })).toHaveCount(0);
    await expect(page.locator('.vv-settings-font')).toHaveCount(1);
  });

  // FNT-07：URL 添加负路径——http 直链拒收（混合内容防线）、非字体内容先装载验证
  // 不落库（错误态 + 重试钮，store 不留死记录）、修复源后重试恢复、忽略清理错误态。
  test('FNT-07 URL 负路径：http 拒收 + 非字体错误态 + 重试/忽略', async ({ page }) => {
    test.setTimeout(60_000);
    await routeWoff2(page, 'https://fonts.mock/bad.woff2', 'this is not a font payload');
    await page.goto('/');
    await openSettings(page);
    await gotoGroup(page, '字体');

    // 非字体内容：FontFace load reject → 错误态行（重试/忽略），无正常记录
    await submitFontUrl(page, 'https://fonts.mock/bad.woff2');
    const failedRow = page.locator('.vv-settings-font-failed', {
      has: page.locator('.vv-settings-font-name', { hasText: /^bad$/ })
    });
    await expect(failedRow).toBeVisible({ timeout: 20_000 });
    await expect(failedRow.locator('.vv-settings-font-errmsg')).toContainText(
      '字体解析失败（内容不是有效字体？）'
    );
    await expect(page.locator('.vv-settings-font:not(.vv-settings-font-failed)')).toHaveCount(0);
    await expect(
      failedRow.locator('button[aria-label="重试添加网络字体 bad"]')
    ).toBeEnabled();

    // http 直链：https 白名单门禁（fetch 发起前拒收）
    await submitFontUrl(page, 'http://fonts.mock/a.woff2');
    const httpRow = page.locator('.vv-settings-font-failed', {
      has: page.locator('.vv-settings-font-name', { hasText: /^a$/ })
    });
    await expect(httpRow).toBeVisible({ timeout: 20_000 });
    await expect(httpRow.locator('.vv-settings-font-errmsg')).toContainText(
      '仅支持 https 字体地址（混合内容防线）'
    );

    // 忽略：错误态行移除（另一错误态不受影响）
    await httpRow.locator('button[aria-label="忽略网络字体 a"]').click();
    await expect(httpRow).toHaveCount(0);
    await expect(failedRow).toBeVisible();

    // 修复源后重试：同一 URL 管线复跑成功 → 错误态清除、记录入库、FontFace 注册
    await page.unroute('https://fonts.mock/bad.woff2');
    await routeWoff2(page, 'https://fonts.mock/bad.woff2', Buffer.from(WOFF2_B64, 'base64'));
    await failedRow.locator('button[aria-label="重试添加网络字体 bad"]').click();
    await expect(page.locator('.vv-settings-note', { hasText: '已添加字体「bad」' })).toBeVisible({
      timeout: 20_000
    });
    await expect(page.locator('.vv-settings-font-failed')).toHaveCount(0);
    await expect(
      page.locator('.vv-settings-font-name', { hasText: /^bad$/ })
    ).toBeVisible();
    await expect.poll(() => hasFontFace(page, 'bad'), { timeout: 20_000 }).toBe(true);
  });

  // FNT-08：名称门禁与下拉撞车过滤——逗号名/同同名拒收（name 是槽位与下拉的键）；
  // 名为 __custom__ 的字体被哨兵撞车过滤不进下拉（3d8454e 回归锚）且哨兵语义不坏；
  // 预设撞名（Roboto）同过滤；管理列表照常收录。
  test('FNT-08 名称门禁：逗号/同名拒收 + __custom__ 与预设撞车过滤', async ({ page }) => {
    test.setTimeout(60_000);
    const woff2 = Buffer.from(WOFF2_B64, 'base64');
    for (const f of ['one', 'two', 'three', 'four', 'five']) {
      await routeWoff2(page, `https://fonts.mock/${f}.woff2`, woff2);
    }
    await page.goto('/');
    await openSettings(page);
    await gotoGroup(page, '字体');

    await submitFontUrl(page, 'https://fonts.mock/one.woff2', 'dup');
    await expect(page.locator('.vv-settings-note', { hasText: '已添加字体「dup」' })).toBeVisible({
      timeout: 20_000
    });

    // 同名拒收
    await submitFontUrl(page, 'https://fonts.mock/two.woff2', 'dup');
    await expect(
      page.locator('.vv-settings-font-errmsg', { hasText: '已存在同名字体「dup」，请改名或先删除原字体' })
    ).toBeVisible({ timeout: 20_000 });

    // 逗号名拒收（name 进槽位会被拆成回退栈，语义漂移）
    await submitFontUrl(page, 'https://fonts.mock/three.woff2', 'a,b');
    await expect(
      page.locator('.vv-settings-font-errmsg', {
        hasText: '字体名称不能包含逗号：「a,b」（逗号是 family 多级回退分隔符）'
      })
    ).toBeVisible({ timeout: 20_000 });

    // 哨兵撞车名 + 预设撞名：均入库成功（管理列表照常），但均不进两槽下拉
    await submitFontUrl(page, 'https://fonts.mock/four.woff2', '__custom__');
    await expect(page.locator('.vv-settings-note', { hasText: '已添加字体「__custom__」' })).toBeVisible({
      timeout: 20_000
    });
    await submitFontUrl(page, 'https://fonts.mock/five.woff2', 'Roboto');
    await expect(page.locator('.vv-settings-note', { hasText: '已添加字体「Roboto」' })).toBeVisible({
      timeout: 20_000
    });
    await expect(
      page.locator('.vv-settings-font-name', { hasText: /^__custom__$/ })
    ).toBeVisible();
    await expect(page.locator('.vv-settings-font-name', { hasText: /^Roboto$/ })).toBeVisible();

    const codeSelect = page.locator('select[aria-label="代码字体族"]');
    await expect(codeSelect.locator('option[value="__custom__"]')).toHaveCount(1); // 仅哨兵本体
    await expect(page.locator('select[aria-label="代码字体族"] option', { hasText: '__custom__（网络）' })).toHaveCount(0);
    // 撞车过滤按槽位预设清单判定（mergedFamilyOptions taken.has）：Roboto 是 UI 槽预设
    //（fonts.ts UI_FONT_PRESETS），代码槽无 Roboto——网络字体 Roboto 按语义进代码下拉、
    // 被 UI 槽过滤；撞车断言锚 UI 槽（预设本体「Roboto（Android）」不含「（网络）」子串）
    const uiSelect = page.locator('select[aria-label="界面字体族"]');
    await expect(uiSelect.locator('option[value="Roboto"]')).toHaveCount(1); // 仅预设本体
    await expect(page.locator('select[aria-label="界面字体族"] option', { hasText: 'Roboto（网络）' })).toHaveCount(0);

    // 哨兵语义未被撞车名破坏：选中仍展开手输框（不改值，草稿保持干净可 Esc 关页）
    await codeSelect.selectOption('__custom__');
    await expect(page.locator('input[aria-label="自定义代码字体族"]')).toBeVisible();
    await closeSettings(page);
  });

  // FNT-09：IDB 持久化与启停全链——添加后 reload 记录仍在 + 启动 loadEnabledFontFaces
  // 重建 document.fonts + 下拉恢复；停用即时注销且下拉移除（reload 后停用态保持）；
  // 再启用从 store buffer 重建。
  test('FNT-09 IDB 持久化：reload 重建 + 停用/再启用全链', async ({ page }) => {
    test.setTimeout(90_000);
    await routeWoff2(page, 'https://fonts.mock/keep.woff2', Buffer.from(WOFF2_B64, 'base64'));
    await page.goto('/');
    await openSettings(page);
    await gotoGroup(page, '字体');
    await submitFontUrl(page, 'https://fonts.mock/keep.woff2');
    await expect(page.locator('.vv-settings-note', { hasText: '已添加字体「keep」' })).toBeVisible({
      timeout: 20_000
    });
    await expect.poll(() => hasFontFace(page, 'keep'), { timeout: 20_000 }).toBe(true);

    const toggle = page.locator('input[aria-label="启用网络字体 keep"]');
    const option = page.locator('select[aria-label="代码字体族"] option', { hasText: 'keep（网络）' });

    // reload：IDB 记录 → 列表重建 + enabled FontFace 重建 + 下拉选项恢复
    await page.goto('/');
    await openSettings(page);
    await gotoGroup(page, '字体');
    await expect(
      page.locator('.vv-settings-font-name', { hasText: /^keep$/ })
    ).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => hasFontFace(page, 'keep'), { timeout: 20_000 }).toBe(true);
    await expect(option).toHaveCount(1);
    await expect(toggle).toBeChecked();

    // 停用：document.fonts 即时注销 + 下拉移除（管理行保留、勾选态翻转）
    await toggle.uncheck();
    await expect.poll(() => hasFontFace(page, 'keep'), { timeout: 20_000 }).toBe(false);
    await expect(option).toHaveCount(0);
    await expect(page.locator('.vv-settings-font-name', { hasText: /^keep$/ })).toBeVisible();

    // reload 后停用态保持：记录在、Face 不重建、下拉无选项
    await page.goto('/');
    await openSettings(page);
    await gotoGroup(page, '字体');
    await expect(
      page.locator('.vv-settings-font-name', { hasText: /^keep$/ })
    ).toBeVisible({ timeout: 20_000 });
    await expect(toggle).not.toBeChecked();
    await expect.poll(() => hasFontFace(page, 'keep'), { timeout: 20_000 }).toBe(false);
    await expect(option).toHaveCount(0);

    // 再启用：从 store buffer 重建 Face（免重新下载）+ 下拉恢复
    await toggle.check();
    await expect.poll(() => hasFontFace(page, 'keep'), { timeout: 20_000 }).toBe(true);
    await expect(option).toHaveCount(1);
  });

  // FNT-10：配额超限引导（1823660）——页面级 mock fonts store 写入路径抛
  // QuotaExceededError：错误态文案附「设置→存储与数据」清理引导、记录不落库
  //（先装载验证后入库的 put 是唯一写盘漏斗）。
  test('FNT-10 配额超限：错误文案附存储清理引导 + 记录不落库', async ({ page }) => {
    test.setTimeout(60_000);
    // 拦截 fonts store 的 readwrite put：事务 active 期同步 abort（写盘不落），
    // 并以自有 error 属性遮蔽为 QuotaExceededError——putFontRecord 的 reject 漏斗
    // 经 withQuotaGuidance 包装出引导文案。其余 store / readonly 路径不受影响。
    await page.addInitScript(() => {
      const proto = IDBObjectStore.prototype as unknown as {
        put: (this: IDBObjectStore, ...args: unknown[]) => unknown;
      };
      const orig = proto.put;
      proto.put = function (this: IDBObjectStore, ...args: unknown[]) {
        if (this.name === 'fonts' && this.transaction?.mode === 'readwrite') {
          const tx = this.transaction;
          Object.defineProperty(tx, 'error', {
            value: new DOMException('mock quota exceeded', 'QuotaExceededError'),
            configurable: true
          });
          tx.abort();
          return undefined;
        }
        return orig.apply(this, args);
      };
    });
    await routeWoff2(page, 'https://fonts.mock/quota.woff2', Buffer.from(WOFF2_B64, 'base64'));
    await page.goto('/');
    await openSettings(page);
    await gotoGroup(page, '字体');
    await submitFontUrl(page, 'https://fonts.mock/quota.woff2');

    const failedRow = page.locator('.vv-settings-font-failed', {
      has: page.locator('.vv-settings-font-name', { hasText: /^quota$/ })
    });
    await expect(failedRow).toBeVisible({ timeout: 20_000 });
    await expect(failedRow.locator('.vv-settings-font-errmsg')).toContainText(
      '存储空间不足：前往 设置→存储与数据 清理空间后重试'
    );
    // 记录不落库：无正常行、FontFace 未注册、列表非空态由错误态行承担
    await expect(page.locator('.vv-settings-font:not(.vv-settings-font-failed)')).toHaveCount(0);
    await expect.poll(() => hasFontFace(page, 'quota'), { timeout: 20_000 }).toBe(false);
  });
});
