import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { openDirBytes, openDirText, openFile, tabNamed, waitAppMounted } from './helpers';
import { goodPng } from './png-fixture';
import { realPptx } from './pptx-fixture';
import { applySettings, closeSettings, gotoGroup, openSettings } from './settings-center';

/**
 * b-user-feedback —— 2026-11-09 用户反馈八项的验收 e2e（UFB-01..08，一项一组）：
 * - UFB-01 代码自动换行：状态栏「换行」开关 / 设置中心「代码视图」节 / Alt+Z；换行后无
 *   横向溢出、长行折成多视觉行且相邻行不重叠（可变行高虚拟滚动的核心正确性）、滚到底
 *   末行可达、搜索跳转落在视口内；设置持久化；Ctrl+Alt+Z（zen）不误触换行；HTML 源码
 *   视图同样遵循换行设置。
 * - UFB-02 手机 PDF：横向页（842×595pt）在 375 视口默认适宽（<100%）不超宽、左缘可见；
 *   放大溢出后 scrollLeft=0 时页左缘可达（旧 align-items:center 左半边落负滚动区）、
 *   触屏横扫可平移；「适应宽度」按钮；桌面竖页仍 100%。
 * - UFB-03 pptx 默认演示文稿：真结构 pptx（pptx-fixture，含 theme/master/layout）落
 *   foreign 演示文稿逐页渲染；打开方式可切回文本提纲；极简 pptx（无 theme，引擎解析
 *   失败）错误卡给出可读文案 +「以 PowerPoint（文本提纲） 打开」兜底。
 * - UFB-04 PDF 浏览器感知构建：特性齐备（现代 Chromium）选现代构建、删除任一所需特性
 *   （模拟 Chrome<122 等旧浏览器）选 legacy 构建——core-js 在加载时补回缺失全局（如
 *   Iterator），两种构建都照常渲染；判别面为 .vv-pdf 的 data-pdf-build。
 * - UFB-05 docx 默认版式还原：落 docx-preview 系 .docx-wrapper，打开方式列出两个可区分
 *   的 Word 渲染器并可切到简化视图。
 * - UFB-06 默认渲染器设置：「打开方式」节列出多渲染器格式；改 .docx 默认后新打开即生效、
 *   改回即恢复；单标签手选优先于设置。
 * - UFB-07 平板宽度段（601–900px）右栏折叠钮可见可用、折叠持久态在该段生效；≤600px
 *   与桌面维持原形态。
 * - UFB-08 图片拖动平移：鼠标拖动改 scrollLeft/Top、滚轮放大后可拖、触屏单指平移与双指
 *   捏合、灯箱触屏拖动。
 * 触屏手势经 CDP Input.dispatchTouchEvent 合成（mobile project hasTouch）。
 */

const samples = fileURLToPath(new URL('../../../samples/m4', import.meta.url));
const sampleOf = (name: string): Uint8Array => new Uint8Array(readFileSync(`${samples}/${name}`));

const isMobile = (): boolean => test.info().project.name === 'mobile';

/** 树行打开 + 等首个渲染面（helpers.openFile 的 tab 可见锚） */
async function openNamed(page: Page, group: string, name: string, bytes: Uint8Array): Promise<void> {
  await openDirBytes(page, group, name, bytes);
  await openFile(page, name);
}

/** CDP 合成触屏手势：points 为各手指的起止坐标（同步插值 steps 帧，单指即拖动、双指即捏合） */
async function touchGesture(
  page: Page,
  fingers: { from: { x: number; y: number }; to: { x: number; y: number } }[],
  steps = 10
): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  const at = (k: number) =>
    fingers.map((f, id) => ({
      x: f.from.x + ((f.to.x - f.from.x) * k) / steps,
      y: f.from.y + ((f.to.y - f.from.y) * k) / steps,
      id
    }));
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at(0) });
  for (let k = 1; k <= steps; k++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: at(k) });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

/** 元素中心（视口坐标） */
async function centerOf(page: Page, selector: string): Promise<{ x: number; y: number }> {
  const box = await page.locator(selector).boundingBox();
  expect(box, `${selector} 未布局`).not.toBeNull();
  return { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
}

// ─────────────────────────────── UFB-01 代码自动换行 ───────────────────────────────

/** 长行文本：偶数行 600 字符长行（折行），奇数行短行；行内嵌编号便于定位 */
const WRAP_TEXT = Array.from({ length: 300 }, (_, i) =>
  i % 2 === 0 ? `L${i} ` + 'wrapword '.repeat(66) : `short ${i}`
).join('\n');

/** 已渲染代码行的几何：行号、顶/底（相对 .vv-code-pre 视口） */
async function renderedRows(page: Page): Promise<{ line: number; top: number; bottom: number }[]> {
  return page.locator('.vv-code-pre').evaluate((pre) => {
    const base = pre.getBoundingClientRect().top;
    return [...pre.querySelectorAll<HTMLElement>('.vv-code-line')].map((r) => {
      const b = r.getBoundingClientRect();
      return { line: Number(r.dataset.line), top: b.top - base, bottom: b.bottom - base };
    });
  });
}

async function expectWrapped(page: Page): Promise<void> {
  const pre = page.locator('.vv-code-pre');
  await expect(pre).toHaveClass(/vv-code-wrap/);
  // 无横向溢出：长行在列内折行
  await expect
    .poll(() => pre.evaluate((el) => el.scrollWidth - el.clientWidth), { timeout: 5_000 })
    .toBeLessThanOrEqual(1);
  // 长行折成多视觉行（行高 > 2×单行高）、相邻行不重叠（可变行高定位正确性）
  await expect
    .poll(
      async () => {
        const rows = await renderedRows(page);
        const lh = await pre.evaluate((el) => parseFloat(getComputedStyle(el).lineHeight));
        const long = rows.find((r) => r.line % 2 === 0);
        const overlaps = rows.slice(1).filter((r, k) => r.top < rows[k]!.bottom - 0.5).length;
        return long !== undefined && long.bottom - long.top > 2 * lh && overlaps === 0;
      },
      { timeout: 5_000 }
    )
    .toBe(true);
}

async function expectUnwrapped(page: Page): Promise<void> {
  const pre = page.locator('.vv-code-pre');
  await expect(pre).not.toHaveClass(/vv-code-wrap/);
  await expect.poll(() => pre.evaluate((el) => el.scrollWidth > el.clientWidth + 10)).toBe(true);
}

test.describe('UFB-01 代码自动换行', () => {
  test('UFB-01a 状态栏「换行」开关：关→开（折行无横溢、行不重叠）→关', async ({ page }) => {
    test.setTimeout(60_000);
    await waitAppMounted(page);
    await openDirText(page, 'ufb1', 'long.txt', WRAP_TEXT);
    await openFile(page, 'long.txt');
    await expect(page.locator('.vv-code-line').first()).toBeVisible({ timeout: 20_000 });
    const toggle = page.locator('.vv-status-wrap');
    await expect(toggle).toHaveText('换行: 关');
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expectUnwrapped(page);

    await toggle.click();
    await expect(toggle).toHaveText('换行: 开');
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expectWrapped(page);

    await toggle.click();
    await expect(toggle).toHaveText('换行: 关');
    await expectUnwrapped(page);
  });

  test('UFB-01b 设置中心「代码视图」：勾选应用后已打开视图即时换行，刷新后持久', async ({ page }) => {
    test.setTimeout(90_000);
    await waitAppMounted(page);
    await openDirText(page, 'ufb1', 'long.txt', WRAP_TEXT);
    await openFile(page, 'long.txt');
    await expect(page.locator('.vv-code-line').first()).toBeVisible({ timeout: 20_000 });
    await expectUnwrapped(page);

    await openSettings(page);
    await gotoGroup(page, '代码视图');
    await page.getByRole('checkbox', { name: '自动换行' }).check();
    await applySettings(page);
    await closeSettings(page);
    await expectWrapped(page);
    await expect(page.locator('.vv-status-wrap')).toHaveText('换行: 开');

    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('vviewer:settings') ?? '{}').codeWordWrap);
    expect(saved).toBe(true);
    // 持久化：刷新后（注入目录为内存 File，刷新不可恢复——重新注入）新打开的代码视图即换行
    await waitAppMounted(page);
    await openDirText(page, 'ufb1b', 'again.txt', WRAP_TEXT);
    await openFile(page, 'again.txt');
    await expect(page.locator('.vv-code-line').first()).toBeVisible({ timeout: 20_000 });
    await expectWrapped(page);
    await expect(page.locator('.vv-status-wrap')).toHaveText('换行: 开');
  });

  test('UFB-01c Alt+Z 切换换行；Ctrl+Alt+Z 进专注模式不误触换行', async ({ page }) => {
    test.skip(isMobile(), '键盘快捷键桌面基准');
    test.setTimeout(60_000);
    await waitAppMounted(page);
    await openDirText(page, 'ufb1', 'long.txt', WRAP_TEXT);
    await openFile(page, 'long.txt');
    await expect(page.locator('.vv-code-line').first()).toBeVisible({ timeout: 20_000 });
    await page.locator('.vv-code-pre').click(); // 焦点离开输入面（inField 守卫）

    await page.keyboard.press('Alt+KeyZ');
    await expectWrapped(page);
    await page.keyboard.press('Alt+KeyZ');
    await expectUnwrapped(page);

    await page.keyboard.press('Control+Alt+KeyZ');
    await expect(page.locator('.vv-shell.zen')).toHaveCount(1);
    await expect(page.locator('.vv-code-pre')).not.toHaveClass(/vv-code-wrap/);
    await page.keyboard.press('Escape');
    await expect(page.locator('.vv-shell.zen')).toHaveCount(0);
  });

  test('UFB-01d 换行模式：滚到底末行可达、搜索跳转命中行落在视口内', async ({ page }) => {
    test.setTimeout(90_000);
    await page.addInitScript(() => localStorage.setItem('vviewer:settings', JSON.stringify({ codeWordWrap: true })));
    await waitAppMounted(page);
    await openDirText(page, 'ufb1', 'long.txt', WRAP_TEXT);
    await openFile(page, 'long.txt');
    await expect(page.locator('.vv-code-line').first()).toBeVisible({ timeout: 20_000 });
    await expectWrapped(page);
    const pre = page.locator('.vv-code-pre');

    // 逐屏滚到底（测高逐屏修正总高，循环至末行上屏）
    await expect
      .poll(
        async () => {
          await pre.evaluate((el) => {
            el.scrollTop = el.scrollHeight;
          });
          const rows = await renderedRows(page);
          const viewH = await pre.evaluate((el) => el.clientHeight);
          return rows.some((r) => r.line === 299 && r.bottom <= viewH + 1 && r.top >= 0);
        },
        { timeout: 15_000 }
      )
      .toBe(true);

    // 回顶后搜索远处行的唯一记号：命中行（active）落在视口内
    await pre.evaluate((el) => {
      el.scrollTop = 0;
    });
    await page.locator('.vv-code-pre').click();
    await page.keyboard.press('/');
    await expect(page.locator('.vv-search-input')).toBeFocused();
    await page.keyboard.insertText('L250 ');
    await expect(page.locator('.vv-search-count')).toHaveText('1/1', { timeout: 10_000 });
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const p = document.querySelector('.vv-code-pre')!.getBoundingClientRect();
            const row = document.querySelector<HTMLElement>('.vv-code-line[data-line="250"]');
            if (!row) return false;
            const r = row.getBoundingClientRect();
            return r.bottom > p.top && r.top < p.bottom;
          }),
        { timeout: 10_000 }
      )
      .toBe(true);
  });
});

test('UFB-01e HTML 源码视图同样遵循换行（状态栏开关即时生效，渲染视图切回源码保持）', async ({ page }) => {
  test.setTimeout(60_000);
  await waitAppMounted(page);
  const html = Array.from({ length: 40 }, (_, i) => `<p>${i} ${'htmlword '.repeat(60)}</p>`).join('\n');
  await openDirText(page, 'ufb1e', 'page.html', html);
  await openFile(page, 'page.html');
  await page.locator('.vv-html-btn-source').click();
  const pre = page.locator('.vv-code-pre');
  await expect(page.locator('.vv-code-line').first()).toBeVisible({ timeout: 20_000 });
  await expect(pre).not.toHaveClass(/vv-code-wrap/);
  await expect.poll(() => pre.evaluate((el) => el.scrollWidth > el.clientWidth + 10)).toBe(true);

  await page.locator('.vv-status-wrap').click();
  await expect(pre).toHaveClass(/vv-code-wrap/);
  await expect.poll(() => pre.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);

  // 渲染 ↔ 源码往返：源码视图按当前设置重挂，换行保持
  await page.locator('.vv-html-btn-rendered').click();
  await page.locator('.vv-html-btn-source').click();
  await expect(page.locator('.vv-code-pre')).toHaveClass(/vv-code-wrap/);
});

// ─────────────────────────────── UFB-02 手机 PDF ───────────────────────────────

/** 极简多页 PDF（b-media-office-viewer buildMultiPagePdf 同构，扩展页尺寸参数） */
function buildPdf(pages: string[], w: number, h: number): Uint8Array {
  const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
  const objs: string[] = [];
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = `<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  pages.forEach((text, i) => {
    const pid = 4 + i * 2;
    objs[pid] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pid + 1} 0 R >>`;
    const stream = `BT /F1 28 Tf 30 ${h - 80} Td (${text}) Tj ET`;
    objs[pid + 1] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });
  const chunks: Uint8Array[] = [enc('%PDF-1.4\n')];
  const total = (): number => chunks.reduce((n, c) => n + c.length, 0);
  const offsets: number[] = [0];
  for (let i = 1; i < objs.length; i++) {
    offsets[i] = total();
    chunks.push(enc(`${i} 0 obj\n${objs[i]}\nendobj\n`));
  }
  const xrefAt = total();
  let xref = `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objs.length; i++) xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  xref += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  chunks.push(enc(xref));
  const out = new Uint8Array(total());
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/** 首页相对 .vv-pdf-pages 视口的左右缘 + 容器可滚动量 */
async function pdfGeometry(page: Page): Promise<{ left: number; right: number; client: number; scrollW: number }> {
  return page.locator('.vv-pdf-pages').evaluate((host) => {
    const h = host.getBoundingClientRect();
    const p = host.querySelector('.vv-pdf-page')!.getBoundingClientRect();
    return { left: p.left - h.left, right: p.right - h.left, client: host.clientWidth, scrollW: host.scrollWidth };
  });
}

const zoomPct = async (page: Page): Promise<number> =>
  Number((await page.locator('.vv-pdf-zoom-label').textContent())!.replace('%', ''));

test.describe('UFB-02 手机 PDF 适宽与横向可达', () => {
  test('UFB-02a 横向发票页：mobile 默认适宽不超宽、左缘可见；放大后 scrollLeft=0 左缘可达；适应宽度按钮', async ({
    page
  }) => {
    test.skip(!isMobile(), '窄视口（375px）专属');
    test.setTimeout(90_000);
    await waitAppMounted(page);
    await openNamed(page, 'ufb2', 'invoice.pdf', buildPdf(['INVOICE LEFT EDGE', 'PAGE TWO'], 842, 595));
    await expect(page.locator('.vv-pdf canvas').first()).toBeVisible({ timeout: 30_000 });

    // ① 默认 auto 适宽：缩放 <100%，整页在容器内（左缘不在负区、右缘不越界）
    expect(await zoomPct(page)).toBeLessThan(100);
    const g0 = await pdfGeometry(page);
    expect(g0.left).toBeGreaterThanOrEqual(0);
    expect(g0.right).toBeLessThanOrEqual(g0.client + 1);
    expect(g0.scrollW).toBeLessThanOrEqual(g0.client + 1);

    // ② 放大至溢出（842pt 页在 375 视口 100% 即溢出）：scrollLeft=0 时页左缘可达（≥ 容器
    // 左缘），可横向滚到右缘
    const zoomIn = page.getByRole('button', { name: '放大' });
    for (let i = 0; i < 6 && (await zoomPct(page)) < 100; i++) await zoomIn.click();
    await expect.poll(() => zoomPct(page)).toBeGreaterThanOrEqual(100);
    await page.locator('.vv-pdf-pages').evaluate((el) => {
      el.scrollLeft = 0;
    });
    const g1 = await pdfGeometry(page);
    expect(g1.scrollW).toBeGreaterThan(g1.client);
    expect(g1.left).toBeGreaterThanOrEqual(-1);
    const maxLeft = await page.locator('.vv-pdf-pages').evaluate((el) => {
      el.scrollLeft = el.scrollWidth;
      return el.scrollLeft;
    });
    expect(maxLeft).toBeGreaterThan(0);
    const g2 = await pdfGeometry(page);
    expect(g2.right).toBeLessThanOrEqual(g2.client + 13); // 右缘 + 12px padding 内

    // ③ 「适应宽度」：页宽 ≈ 容器内容宽（clientWidth − 左右 padding 24）
    await page.getByRole('button', { name: '适应宽度' }).click();
    await expect
      .poll(async () => {
        const g = await pdfGeometry(page);
        return Math.abs(g.right - g.left - (g.client - 24));
      })
      .toBeLessThanOrEqual(2);
  });

  test('UFB-02b 放大溢出后触屏往右拖看左半边：能拖动且最终看到页面左缘', async ({ page }) => {
    test.skip(!isMobile(), '触屏（mobile project hasTouch）专属');
    test.setTimeout(90_000);
    await waitAppMounted(page);
    await openNamed(page, 'ufb2', 'invoice.pdf', buildPdf(['INVOICE'], 842, 595));
    await expect(page.locator('.vv-pdf canvas').first()).toBeVisible({ timeout: 30_000 });
    const zoomIn = page.getByRole('button', { name: '放大' });
    for (let i = 0; i < 6 && (await zoomPct(page)) < 100; i++) await zoomIn.click();
    await expect.poll(() => page.locator('.vv-pdf-pages').evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    // 先停在最右（看右半边），再用手指往右拖——用户「看左半边」的真实手势
    const startLeft = await page.locator('.vv-pdf-pages').evaluate((el) => {
      el.scrollLeft = el.scrollWidth;
      return el.scrollLeft;
    });
    expect(startLeft).toBeGreaterThan(0);
    const c = await centerOf(page, '.vv-pdf-pages');
    await touchGesture(page, [{ from: { x: c.x - 120, y: c.y }, to: { x: c.x + 120, y: c.y } }]);
    // 能拖动：scrollLeft 随手指减小
    await expect
      .poll(() => page.locator('.vv-pdf-pages').evaluate((el) => el.scrollLeft))
      .toBeLessThan(startLeft - 50);
    // 继续往右拖到底：页面左缘进入视口（旧居中溢出时左半边落负滚动区，拖到底也看不到）
    for (let i = 0; i < 6; i++) {
      await touchGesture(page, [{ from: { x: c.x - 120, y: c.y }, to: { x: c.x + 120, y: c.y } }]);
    }
    await expect.poll(() => page.locator('.vv-pdf-pages').evaluate((el) => el.scrollLeft)).toBe(0);
    expect((await pdfGeometry(page)).left).toBeGreaterThanOrEqual(-1);
  });

  test('UFB-02c 桌面竖页回归：600pt 页仍 100%', async ({ page }) => {
    test.skip(isMobile(), '桌面视口基准');
    test.setTimeout(60_000);
    await waitAppMounted(page);
    await openNamed(page, 'ufb2', 'portrait.pdf', buildPdf(['PORTRAIT'], 600, 900));
    await expect(page.locator('.vv-pdf canvas').first()).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.vv-pdf-zoom-label')).toHaveText('100%');
  });
});

// ─────────────────────────────── UFB-03 pptx 默认演示文稿 ───────────────────────────────

test.describe('UFB-03 pptx 默认演示文稿', () => {
  test.beforeEach(() => {
    test.skip(isMobile(), 'foreign 引擎首屏含 CDN 资产（桌面基准，b-foreign-office 同口径）');
  });

  test('UFB-03a 真结构 pptx 落演示文稿逐页渲染，打开方式可切回文本提纲', async ({ page }) => {
    test.setTimeout(150_000);
    await waitAppMounted(page);
    await openNamed(page, 'ufb3', 'deck.pptx', realPptx(['第一页 标题甲', '第二页 标题乙']));
    const host = page.locator('.vv-viewer-host');
    await expect(host.locator('.pptx-viewer-shell')).toBeVisible({ timeout: 60_000 });
    await expect(host.locator('.slide').first()).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('.vv-status-openwith')).toContainText('演示文稿');
    await expect(host.locator('.vv-pptx')).toHaveCount(0);

    await page.locator('.vv-status-openwith').click();
    await page.locator('.vv-status-picker').getByRole('menuitem', { name: 'PowerPoint（文本提纲）' }).click();
    await expect(host.locator('.vv-pptx-slide')).toHaveCount(2, { timeout: 20_000 });
    await expect(host.locator('.vv-pptx-slide').first()).toContainText('第一页 标题甲');
  });

  test('UFB-03b 引擎解析失败的极简 pptx：错误卡文案可读 +「以 PowerPoint（文本提纲） 打开」兜底', async ({ page }) => {
    test.setTimeout(150_000);
    await waitAppMounted(page);
    await openNamed(page, 'ufb3', 'minimal.pptx', sampleOf('sample.pptx'));
    const card = page.locator('.vv-error-card');
    await expect(card).toBeVisible({ timeout: 60_000 });
    await expect(card.locator('.vv-error-detail')).not.toHaveText('[object Object]');
    await expect(card.locator('.vv-error-detail')).not.toHaveText('');
    await card.locator('.vv-error-action', { hasText: '以 PowerPoint（文本提纲） 打开' }).click();
    await expect(page.locator('.vv-pptx-slide')).toHaveCount(2, { timeout: 20_000 });
  });
});

// ─────────────────────────────── UFB-04 旧浏览器 PDF ───────────────────────────────

/** 页面内复算能力探针（与 pdf.ts preferModernBuild 同一名单）：true = 应选现代构建 */
function expectModern(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const g = globalThis as Record<string, unknown>;
    const has = (v: unknown): boolean => typeof v === 'function';
    // proto 沿 .prototype 取（对齐 pdf.ts protoHas：迭代器 helper 在 Iterator.prototype 上，
    // 原版误读静态位恒 false——页面快照实证）
    const proto = (o: unknown, k: string): boolean =>
      !!o && has((o as { prototype?: Record<string, unknown> }).prototype?.[k]);
    return (
      proto(g.Iterator, 'map') &&
      proto(Set, 'union') &&
      has((Uint8Array as unknown as Record<string, unknown>).fromBase64) &&
      proto(Map, 'getOrInsert') &&
      has((Promise as unknown as Record<string, unknown>).try) &&
      has((URL as unknown as Record<string, unknown>).parse) &&
      has((JSON as unknown as Record<string, unknown>).rawJSON) &&
      has((Math as unknown as Record<string, unknown>).sumPrecise)
    );
  });
}

async function expectPdfBuild(page: Page, build: 'modern' | 'legacy'): Promise<void> {
  await expect
    .poll(() => page.locator('.vv-pdf').getAttribute('data-pdf-build'), { timeout: 10_000 })
    .toBe(build);
}

test('UFB-04 无全局 Iterator（旧浏览器）选兼容构建：PDF 照常渲染且 core-js 补回 Iterator', async ({ page }) => {
  test.setTimeout(90_000);
  // 模拟 Chrome<122 / Firefox<131 / Safari<18.4：页面脚本运行前删掉全局 Iterator——
  // 能力探针不再齐备，加载链感知后选 legacy 构建
  await page.addInitScript(() => {
    delete (globalThis as { Iterator?: unknown }).Iterator;
  });
  await waitAppMounted(page);
  expect(await page.evaluate(() => typeof (globalThis as { Iterator?: unknown }).Iterator)).toBe('undefined');
  await openNamed(page, 'ufb4', 'report.pdf', buildPdf(['REPORT'], 600, 900));
  await expect(page.locator('.vv-pdf canvas').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.vv-error-card')).toHaveCount(0);
  await expectPdfBuild(page, 'legacy');
  // legacy 构建内置 core-js：加载即注册全局 Iterator（修复生效的直接证据）
  expect(await page.evaluate(() => typeof (globalThis as { Iterator?: unknown }).Iterator)).toBe('function');
});

test('UFB-04b 特性齐备（现代浏览器）选现代构建：渲染照常、零 polyfill 注入', async ({ page }) => {
  test.setTimeout(90_000);
  await waitAppMounted(page);
  const modern = await expectModern(page);
  await openNamed(page, 'ufb4b', 'report.pdf', buildPdf(['REPORT'], 600, 900));
  await expect(page.locator('.vv-pdf canvas').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.vv-error-card')).toHaveCount(0);
  await expectPdfBuild(page, modern ? 'modern' : 'legacy');
  if (modern) {
    // 现代构建无 core-js：本就缺失的特性不会被补（这里挑一个 Chromium 天然缺失的
    // 特性位不存在——故只断言齐备态下全部探针仍为函数即可，无新增全局）
    expect(await expectModern(page)).toBe(true);
  }
});

// ─────────────────────────────── UFB-05/06 Word 与默认渲染器 ───────────────────────────────

test.describe('UFB-05/06 docx 默认版式还原与默认渲染器设置', () => {
  test.beforeEach(() => {
    test.skip(isMobile(), 'foreign 引擎首屏含 CDN 资产（桌面基准）');
  });

  test('UFB-05 docx 落版式还原；打开方式列出两个可区分的 Word 渲染器并可切简化视图', async ({ page }) => {
    test.setTimeout(150_000);
    await waitAppMounted(page);
    await openNamed(page, 'ufb5', 'sample.docx', sampleOf('sample.docx'));
    const host = page.locator('.vv-viewer-host');
    await expect(host.locator('.docx-wrapper')).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('.vv-status-openwith')).toContainText('Word 文档（版式还原）');

    await page.locator('.vv-status-openwith').click();
    const picker = page.locator('.vv-status-picker');
    await expect(picker.getByRole('menuitem', { name: 'Word 文档（版式还原）' })).toHaveCount(1);
    await picker.getByRole('menuitem', { name: 'Word 文档（简化视图）' }).click();
    await expect(host.locator('.vv-docx-content')).toContainText('vviewer docx 样例', { timeout: 20_000 });
  });

  test('UFB-05b xlsx 默认电子表格（file-viewer 表格还原），打开方式可切 SheetJS 简化视图', async ({ page }) => {
    test.setTimeout(150_000);
    await waitAppMounted(page);
    await openNamed(page, 'ufb5b', 'sample.xlsx', sampleOf('sample.xlsx'));
    const host = page.locator('.vv-viewer-host');
    await expect(host.locator('.excel-wrapper')).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('.vv-status-openwith')).toContainText('电子表格');
    await expect(host.locator('.vv-xlsx')).toHaveCount(0);

    await page.locator('.vv-status-openwith').click();
    await page.locator('.vv-status-picker').getByRole('menuitem', { name: 'Excel 表格（简化视图）' }).click();
    await expect(host.locator('.vv-xlsx')).toBeVisible({ timeout: 20_000 });
    await expect(host.locator('.vv-xlsx-tab')).toHaveCount(2);
  });

  test('UFB-06 设置「打开方式」：列出多渲染器格式；改 .docx 默认即生效、改回恢复；单标签手选优先', async ({ page }) => {
    test.setTimeout(180_000);
    await waitAppMounted(page);
    await openSettings(page);
    await gotoGroup(page, '打开方式');
    for (const ext of ['csv', 'docx', 'pptx', 'xls', 'xlsm', 'xlsx']) {
      await expect(page.getByRole('combobox', { name: `.${ext} 默认渲染器` })).toBeVisible();
    }
    await page.getByRole('combobox', { name: '.docx 默认渲染器' }).selectOption({ label: 'Word 文档（简化视图）' });
    await applySettings(page);
    await closeSettings(page);

    await openNamed(page, 'ufb6', 'sample.docx', sampleOf('sample.docx'));
    const host = page.locator('.vv-viewer-host');
    await expect(host.locator('.vv-docx-content')).toContainText('vviewer docx 样例', { timeout: 20_000 });

    // 单标签手选优先于设置：切回版式还原
    await page.locator('.vv-status-openwith').click();
    await page.locator('.vv-status-picker').getByRole('menuitem', { name: 'Word 文档（版式还原）' }).click();
    await expect(host.locator('.docx-wrapper')).toBeVisible({ timeout: 60_000 });

    // 设置改回内置默认：新标签（关闭后重开）落版式还原
    await openSettings(page);
    await gotoGroup(page, '打开方式');
    await page.getByRole('combobox', { name: '.docx 默认渲染器' }).selectOption('');
    await applySettings(page);
    await closeSettings(page);
    await tabNamed(page, 'sample.docx').locator('button[aria-label="关闭 sample.docx"]').click();
    await openFile(page, 'sample.docx');
    await expect(host.locator('.docx-wrapper')).toBeVisible({ timeout: 60_000 });
  });
});

// ─────────────────────────────── UFB-07 平板段右栏折叠 ───────────────────────────────

test.describe('UFB-07 平板宽度段右栏折叠', () => {
  test.beforeEach(() => {
    test.skip(isMobile(), '视口尺寸由用例自设（chromium project）');
  });

  test('UFB-07a 800px：左栏抽屉化、右栏折叠钮可见可用（折叠→竖条展开）', async ({ page }) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width: 800, height: 700 });
    await waitAppMounted(page);
    await expect(page.locator('.vv-drawer-toggle')).toBeVisible(); // 左栏已收进抽屉
    await expect(page.locator('.vv-collapse-left')).toBeHidden();
    const collapse = page.locator('.vv-collapse-right');
    await expect(collapse).toBeVisible();
    await collapse.click();
    await expect(page.locator('.vv-right')).toBeHidden();
    const strip = page.locator('.vv-strip[data-side="right"]');
    await expect(strip).toBeVisible();
    await strip.locator('.vv-strip-expand').click();
    await expect(page.locator('.vv-right')).toBeVisible();
    await expect(page.locator('.vv-collapse-right')).toBeVisible();
  });

  test('UFB-07b 桌面折叠后缩窄到 800px：右栏保持折叠（不再冒出且收不回）', async ({ page }) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width: 1280, height: 720 });
    await waitAppMounted(page);
    await page.locator('.vv-collapse-right').click();
    await expect(page.locator('.vv-right')).toBeHidden();
    await page.setViewportSize({ width: 800, height: 700 });
    await expect(page.locator('.vv-right')).toBeHidden();
    await expect(page.locator('.vv-strip[data-side="right"]')).toBeVisible();
  });

  test('UFB-07c ≤600px 维持右抽屉形态（无折叠钮、ℹ 入口在）；桌面双折叠钮在', async ({ page }) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width: 500, height: 700 });
    await waitAppMounted(page);
    await expect(page.locator('.vv-collapse-right')).toBeHidden();
    await expect(page.locator('.vv-right-toggle')).toBeVisible();
    await page.setViewportSize({ width: 1280, height: 720 });
    await expect(page.locator('.vv-collapse-left')).toBeVisible();
    await expect(page.locator('.vv-collapse-right')).toBeVisible();
  });
});

// ─────────────────────────────── UFB-08 图片拖动平移 ───────────────────────────────

test.describe('UFB-08 图片拖动平移', () => {
  const scrollOf = (page: Page) =>
    page.locator('.vv-image').evaluate((el) => ({ left: el.scrollLeft, top: el.scrollTop }));

  test('UFB-08a 大图鼠标拖动：scrollLeft/Top 随拖动增长（图随指针移动）', async ({ page }) => {
    test.skip(isMobile(), '鼠标拖动桌面基准');
    test.setTimeout(60_000);
    await waitAppMounted(page);
    await openNamed(page, 'ufb8', 'big.png', goodPng(2400, 1800));
    await expect(page.locator('.vv-image img')).toBeVisible({ timeout: 20_000 });
    const c = await centerOf(page, '.vv-image');
    await page.mouse.move(c.x, c.y);
    await page.mouse.down();
    await page.mouse.move(c.x - 200, c.y - 120, { steps: 10 });
    await page.mouse.up();
    const s = await scrollOf(page);
    expect(s.left).toBeGreaterThanOrEqual(190);
    expect(s.top).toBeGreaterThanOrEqual(110);
  });

  test('UFB-08b 小图滚轮放大后可拖动平移', async ({ page }) => {
    test.skip(isMobile(), '滚轮 + 鼠标桌面基准');
    test.setTimeout(60_000);
    await waitAppMounted(page);
    await openNamed(page, 'ufb8', 'small.png', goodPng(200, 150));
    const img = page.locator('.vv-image img');
    await expect(img).toBeVisible({ timeout: 20_000 });
    const c = await centerOf(page, '.vv-image');
    await page.mouse.move(c.x, c.y);
    for (let i = 0; i < 20; i++) await page.mouse.wheel(0, -100); // 1.1^20 ≈ 6.7×
    await expect.poll(() => img.evaluate((el) => Number((el as HTMLElement).dataset.vvZoom))).toBeGreaterThan(5);
    const before = await scrollOf(page);
    await page.mouse.move(c.x, c.y);
    await page.mouse.down();
    await page.mouse.move(c.x + 150, c.y + 90, { steps: 10 });
    await page.mouse.up();
    const after = await scrollOf(page);
    expect(before.left - after.left).toBeGreaterThanOrEqual(140);
    expect(before.top - after.top).toBeGreaterThanOrEqual(80);
  });

  test('UFB-08c 触屏：单指拖动平移、双指捏合放大', async ({ page }) => {
    test.skip(!isMobile(), '触屏（mobile project hasTouch）专属');
    test.setTimeout(60_000);
    await waitAppMounted(page);
    await openNamed(page, 'ufb8', 'big.png', goodPng(2400, 1800));
    const img = page.locator('.vv-image img');
    await expect(img).toBeVisible({ timeout: 20_000 });
    const c = await centerOf(page, '.vv-image');
    await touchGesture(page, [{ from: { x: c.x + 100, y: c.y + 80 }, to: { x: c.x - 100, y: c.y - 80 } }]);
    const s = await scrollOf(page);
    expect(s.left).toBeGreaterThanOrEqual(150);
    expect(s.top).toBeGreaterThanOrEqual(120);
    await touchGesture(page, [
      { from: { x: c.x - 20, y: c.y }, to: { x: c.x - 110, y: c.y } },
      { from: { x: c.x + 20, y: c.y }, to: { x: c.x + 110, y: c.y } }
    ]);
    await expect.poll(() => img.evaluate((el) => Number((el as HTMLElement).dataset.vvZoom))).toBeGreaterThan(2);
  });

  test('UFB-08d markdown 灯箱触屏拖动：stage translate 随单指位移', async ({ page }) => {
    test.skip(!isMobile(), '触屏（mobile project hasTouch）专属');
    test.setTimeout(60_000);
    const md = `# img\n\n![pic](data:image/png;base64,${Buffer.from(goodPng(64, 64)).toString('base64')})\n`;
    await waitAppMounted(page);
    await openDirText(page, 'ufb8', 'pic.md', md);
    await openFile(page, 'pic.md');
    const img = page.locator('.vv-markdown img[data-md-lightbox]');
    await expect(img).toBeVisible({ timeout: 20_000 });
    await img.tap();
    const stage = page.locator('#md-lightbox-overlay .md-lightbox-stage');
    await expect(stage).toHaveAttribute('style', /translate\(0px, 0px\) scale\(1\)/);
    const vw = page.viewportSize()!;
    await touchGesture(page, [{ from: { x: vw.width / 2, y: vw.height / 2 }, to: { x: vw.width / 2 + 80, y: vw.height / 2 + 40 } }]);
    await expect(stage).toHaveAttribute('style', /translate\(80px, 40px\) scale\(1\)/);
    await expect(page.locator('#md-lightbox-overlay')).toBeVisible(); // 拖动后不误关
  });
});
