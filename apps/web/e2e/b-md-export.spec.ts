import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { injectDir, openTreeFile, PIXEL_PNG_B64, type TextFileSpec } from './b-markdown-html-docs-helpers';

/**
 * b-md-export 导出链路冒烟（md-export 计划 Task 3）：
 * - 导出 HTML：playwright download 事件抓 Blob 下载，文件名 <原名>.html；内容经
 *   浏览器 DOMParser 结构断言——图片 data URI 化（相对图 blob→data）、TOC 静态锚
 *   （nav.vv-export-toc 与标题 id 一一对应）、交互壳剥离（徽标 button.md-code-lang
 *   转 span/`.md-diagram-toggle`/foldable 折叠类不残留且收起正文在）、KaTeX 排印全嵌
 *   （20 个 woff2 data URI、fonts/ 相对引用归零）、mermaid 图为 svg 成品；
 * - 导出区显隐：markdown tab 显示两钮，切非 markdown tab 句柄清空钮消失，切回恢复；
 * - 导出 PDF：print 系统对话框不可断言——printDocument 排入的隐藏 srcdoc iframe
 *   经 addInitScript MutationObserver 探针捕获（创建即记录，不受 print 后
 *   onload→finally 立即 remove 的时序影响），断言 srcdoc 含 @page A4 打印模板与
 *   自包含内容；removed 置位（onload 已跑 → print 已尝试）作生命周期佐证。
 * 注入通道与 b-md-syntax 组一致（injectDir + openTreeFile）；≤600px 视口右栏
 * （MetaPanel 宿主）收进右侧抽屉，导出钮先经 openExportArea 拉出（mobile project
 * 375px 命中）。夹具落 samples/md/（readFileSync 注入，样例库与 e2e 共用）。
 */
const samplerPath = fileURLToPath(new URL('../../../samples/md/export-sampler.md', import.meta.url));
const SAMPLER = readFileSync(samplerPath, 'utf-8');

/** 页面打开采样文档并等渲染异步面全部落定（导出克隆的是当前 DOM，早断会丢内容） */
async function openSampler(page: Page): Promise<void> {
  const files: TextFileSpec[] = [
    { name: 'export-sampler.md', content: SAMPLER },
    { name: 'export-sampler-pixel.png', type: 'image/png', b64: PIXEL_PNG_B64, content: '' }
  ];
  await injectDir(page, files);
  await openTreeFile(page, 'export-sampler.md');
  const md = page.locator('.vv-markdown');
  await expect(md).toBeVisible({ timeout: 20_000 });
  await expect(md.locator('.md-code-lang').first()).toBeAttached({ timeout: 20_000 });
  await expect(md.locator('.katex')).toHaveCount(2, { timeout: 30_000 });
  await expect(md.locator('.md-diagram-view svg')).toBeVisible({ timeout: 30_000 });
  await expect(md.locator('img[alt="像素图"][src^="blob:"]')).toBeAttached({ timeout: 20_000 });
  await expect(md.locator('img[data-vv-blocked-external]')).toBeAttached();
  await expect(md.locator('.markdown-alert-foldable')).toHaveCount(1);
}

/** 确保 MetaPanel 可交互：≤600px 视口右栏在抽屉内（transform 未复位），先点 toggle 拉出 */
async function openExportArea(page: Page): Promise<void> {
  const inDrawer = await page.evaluate(() => window.matchMedia('(max-width: 600px)').matches);
  if (inDrawer) {
    const opened = await page.evaluate(() => {
      const el = document.querySelector('.vv-right');
      return el !== null && getComputedStyle(el).transform === 'none';
    });
    if (!opened) await page.locator('.vv-right-toggle').click();
  }
  await expect(page.locator('.meta-export-btn', { hasText: '导出 HTML' })).toBeVisible();
  await expect(page.locator('.meta-export-btn', { hasText: '导出 PDF' })).toBeVisible();
}

interface ExportProbe {
  doctype: boolean;
  title: string;
  copyBadgeBtn: number;
  copyBadgeSpan: number;
  toggle: number;
  foldable: number;
  alertText: string;
  toc: Array<string | null>;
  headingIds: string[];
  levels: string[];
  blobImg: number;
  dataImg: number;
  blockedTitle: string;
  mermaidSvg: number;
  katex: number;
  katexFonts: number;
  katexRawFontUrl: boolean;
}

/** 下载产物结构断言面（正则对 HTML 脆弱，统一经浏览器 DOMParser 解析后取数） */
async function probeExportHtml(page: Page, html: string): Promise<ExportProbe> {
  return page.evaluate((src) => {
    const doc = new DOMParser().parseFromString(src, 'text/html');
    const all = doc.documentElement.outerHTML;
    return {
      doctype: src.startsWith('<!DOCTYPE html>'),
      title: doc.title,
      // spec 2026-10-23 §5：导出侧徽标 button 转 span（flattenCodeLangBadge）——
      // 交互面 button 归零、语言词以 span 徽标保留
      copyBadgeBtn: doc.querySelectorAll('button.md-code-lang').length,
      copyBadgeSpan: doc.querySelectorAll('.md-code-lang').length,
      toggle: doc.querySelectorAll('.md-diagram-toggle').length,
      foldable: doc.querySelectorAll('.markdown-alert-foldable, .markdown-alert-collapsed').length,
      alertText: doc.querySelector('.markdown-alert-content')?.textContent ?? '',
      toc: Array.from(doc.querySelectorAll('.vv-export-toc a')).map((a) => a.getAttribute('href')),
      headingIds: Array.from(
        doc.querySelectorAll('.vv-markdown h1, .vv-markdown h2, .vv-markdown h3, .vv-markdown h4')
      )
        .map((h) => h.id)
        .filter((id) => id !== ''),
      levels: Array.from(doc.querySelectorAll('.vv-export-toc li')).map((li) => li.className),
      blobImg: doc.querySelectorAll('img[src^="blob:"]').length,
      dataImg: doc.querySelectorAll('img[src^="data:image/png;base64,"]').length,
      blockedTitle: doc.querySelector('img[data-vv-blocked-external]')?.getAttribute('title') ?? '',
      mermaidSvg: doc.querySelectorAll('.md-diagram-view svg').length,
      katex: doc.querySelectorAll('.katex').length,
      katexFonts: (all.match(/data:font\/woff2;base64,/g) ?? []).length,
      katexRawFontUrl: /url\(fonts\/KaTeX_/.test(all)
    };
  }, html);
}

test.describe('b-md-export 导出链路', () => {
  test('导出 HTML：下载文件名与自包含内容（data URI 图/TOC 锚/壳剥离/katex/mermaid svg）', async ({ page }) => {
    test.setTimeout(90_000);
    await openSampler(page);
    await openExportArea(page);
    const download = await Promise.all([
      page.waitForEvent('download', { timeout: 30_000 }),
      page.locator('.meta-export-btn', { hasText: '导出 HTML' }).click()
    ]).then(([d]) => d);
    // 计划 Global Constraints：<原名>.html
    expect(download.suggestedFilename()).toBe('export-sampler.html');
    await expect(page.locator('.meta-export-notice')).toHaveText('已导出 HTML');
    const probe = await probeExportHtml(page, readFileSync(await download.path(), 'utf-8'));

    expect(probe.doctype).toBe(true);
    expect(probe.title).toBe('export-sampler.md');
    // 交互壳剥离：徽标 button 交互面不残留（flattenCodeLangBadge 转纯 span，语言词
    // 保留）、图表切换钮不残留，foldable 折叠类剥净且收起正文以展开形态在
    expect(probe.copyBadgeBtn).toBe(0);
    expect(probe.copyBadgeSpan).toBeGreaterThan(0); // rust 围栏徽标以 span 形态保留
    expect(probe.toggle).toBe(0);
    expect(probe.foldable).toBe(0);
    expect(probe.alertText).toContain('收起 callout 的正文');
    // 静态 TOC 锚：h1-h4 文档序，href 与标题 id 一一对应，层级类 l1..l4 齐全
    expect(probe.toc).toEqual(probe.headingIds.map((id) => `#${id}`));
    expect(probe.headingIds.length).toBe(5);
    expect(probe.levels[0]).toBe('vv-toc-l1');
    expect(probe.levels.at(-1)).toBe('vv-toc-l4');
    // 图片：相对图 blob→data URI 内联（无 blob: 残留）；外域图保持管线拦截形态（无 src）
    expect(probe.blobImg).toBe(0);
    expect(probe.dataImg).toBe(1);
    expect(probe.blockedTitle).toContain('example.com');
    // mermaid 图为 svg 成品（本地引擎渲染结果原样内联，非源码/占位）
    expect(probe.mermaidSvg).toBe(1);
    // KaTeX 公式成品 + 排印样式全嵌（Task 2b：20 个 woff2 data URI，fonts/ 相对引用归零）
    expect(probe.katex).toBe(2);
    expect(probe.katexFonts).toBe(20);
    expect(probe.katexRawFontUrl).toBe(false);
  });

  test('导出区显隐：markdown tab 两钮在，非 markdown tab 清空，切回恢复', async ({ page }) => {
    test.setTimeout(90_000);
    await injectDir(page, [
      { name: 'export-sampler.md', content: SAMPLER },
      { name: 'export-note.txt', content: 'plain text for non-markdown tab' }
    ]);
    // 显隐断言取 DOM 面（attached/count）：mobile project 下右栏在抽屉内，可视面
    // 属抽屉开合职责（AppShell 既有用例）；本用例锁定的是句柄门控语义本身
    await openTreeFile(page, 'export-sampler.md');
    await expect(page.locator('.meta-export-btn', { hasText: '导出 HTML' })).toBeAttached({ timeout: 20_000 });
    await expect(page.locator('.meta-export-btn', { hasText: '导出 PDF' })).toBeAttached();
    // 切非 markdown 文件：导出句柄清空（ViewerPane cleanup setExportHandle(null)），动作区消失
    await openTreeFile(page, 'export-note.txt');
    await expect(page.locator('.meta-export')).toHaveCount(0, { timeout: 20_000 });
    // 切回 markdown：句柄重上行，两钮恢复
    await openTreeFile(page, 'export-sampler.md');
    await expect(page.locator('.meta-export-btn', { hasText: '导出 HTML' })).toBeAttached({ timeout: 20_000 });
    await expect(page.locator('.meta-export-btn', { hasText: '导出 PDF' })).toBeAttached();
  });

  test('导出 PDF：打印 iframe srcdoc 含 @page A4 模板与自包含内容', async ({ page }) => {
    test.setTimeout(90_000);
    // print 探针：printDocument 的 iframe 在 print 后即被摘除（onload→finally），
    // DOM 轮询会漏——MutationObserver 在 append 的同一微任务先记下 srcdoc，
    // removed 由轮询 isConnected 置位（onload 已跑 = print 已尝试，成功或降级回调二选一）
    await page.addInitScript(() => {
      const w = window as unknown as { __vvPrintFrames?: Array<{ srcdoc: string; removed: boolean }> };
      w.__vvPrintFrames = [];
      new MutationObserver((muts) => {
        for (const m of muts) {
          for (const n of Array.from(m.addedNodes)) {
            if (!(n instanceof HTMLIFrameElement) || !n.hasAttribute('srcdoc')) continue;
            const rec = { srcdoc: n.getAttribute('srcdoc') ?? '', removed: false };
            w.__vvPrintFrames!.push(rec);
            const timer = setInterval(() => {
              if (!n.isConnected) {
                rec.removed = true;
                clearInterval(timer);
              }
            }, 25);
            setTimeout(() => clearInterval(timer), 60_000);
          }
        }
      }).observe(document, { childList: true, subtree: true });
    });
    await openSampler(page);
    await openExportArea(page);
    await page.locator('.meta-export-btn', { hasText: '导出 PDF' }).click();
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              (window as unknown as { __vvPrintFrames: Array<{ removed: boolean }> }).__vvPrintFrames.filter(
                (f) => f.removed
              ).length
          ),
        { timeout: 30_000 }
      )
      .toBeGreaterThanOrEqual(1);
    const srcdoc = await page.evaluate(
      () => (window as unknown as { __vvPrintFrames: Array<{ srcdoc: string }> }).__vvPrintFrames[0]!.srcdoc
    );
    expect(await page.evaluate(() => (window as unknown as { __vvPrintFrames: unknown[] }).__vvPrintFrames.length)).toBe(1);
    // collectPrintHtml 打印模板：@page A4 + data-vv-page 定位锚 + 分页保护
    expect(srcdoc).toContain('@page { size: A4 portrait; margin: 12mm; }');
    expect(srcdoc).toContain('data-vv-page="a4"');
    expect(srcdoc).toContain('@media print');
    // 打印源=导出装配同链：图片 data URI / katex 排印 / mermaid 浅色重画 svg 成品
    expect(srcdoc).toContain('data:image/png;base64,');
    expect(srcdoc).toContain('data:font/woff2;base64,');
    expect(srcdoc).toContain('<svg');
  });
});
