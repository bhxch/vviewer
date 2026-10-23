import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { injectDir, openTreeFile, PIXEL_PNG_B64, type TextFileSpec } from './b-markdown-html-docs-helpers';

/**
 * b-md-lightbox-export-deep 灯箱与导出域补强（LE-01~LE-12）：六批主路径
 * （b-md-lightbox 四用例 / b-md-export 三用例 / MD-09）之外的边界、负路径、
 * 组合交互与性能锚批次，编号沿用域内自建段惯例（LZ/TA 同款）。
 *
 * 灯箱侧：
 * - LE-01 同 src 元素身份定位（5-5 修复面）：两张同 src 图各归各位
 * - LE-02 图表 svg 点击直开（5-4 修复面）：svg 成为画廊成员直开到末位
 * - LE-03 输入守卫（5-2 修复面）：input 聚焦时 Esc/←→ 不开合，blur 后恢复
 * - LE-04 a11y 基线（5-3）：role=dialog/aria-modal/焦点入/计数 aria-live/
 *   关闭焦点还原（focus 原型包装 spy——img 无 tabindex，还原调用不可经
 *   activeElement 观察，只能锚「还原目标被 focus()」这一行为面）
 * - LE-05 缩放限幅边界：+ 连按顶格 8x、- 连按底格 0.2x、= 同 +、f 复位、
 *   滚轮放大/缩小（现有用例只锚 1.25/1.5625 两步与 r 复位）
 * - LE-06 kroki img 形态画廊条目：settings 直写 krokiHost + route mock 伺服，
 *   next 导航到 kroki img 条目（collectGallery 对 .md-diagram-view img 的收集）
 * - LE-07 点击关闭语义（T1 裁决）：点内容与控制件不关、stage 空白关
 *   （既有覆盖：Esc / overlay 本体 click / 拖拽吞 click）
 * - LE-08 移动端可用性：全按钮链（next/放大/重置/关闭）无键盘依赖，双 project
 * - LE-09 媒体占位组合：video/audio 不入画廊 + 单张画廊 hidden 态 + MD-13 导出
 *   降级源地址链接（防 data URI 爆炸，spec 非目标项的行为锚）
 *
 * 导出侧：
 * - LE-10 暗色主题导出 WYSIWYG：亮/暗两段导出，data-vv-mode/data-theme-mode
 *   双标随当前模式（8b7732a 暗色提权回归的 e2e 面），主题变量注入链路恒在
 * - LE-11 非 markdown 视图（图片/二进制 hex）导出句柄清空与切回恢复
 *   （既有覆盖仅 txt 形态）
 * - LE-12 大文档导出时长锚（chromium-only 桌面基准，TA-02 惯例）
 *
 * 夹具全部内联（既有 spec 同款 injectDir + openTreeFile 通道，不为补强批新增
 * samples 文件）；LE-02/LE-08/LE-10 readFileSync 复用既有 samples 采样。
 */
const LIGHTBOX_SAMPLER_PATH = fileURLToPath(new URL('../../../samples/md/lightbox-sampler.md', import.meta.url));
const LIGHTBOX_SAMPLER = readFileSync(LIGHTBOX_SAMPLER_PATH, 'utf-8');
const EXPORT_SAMPLER_PATH = fileURLToPath(new URL('../../../samples/md/export-sampler.md', import.meta.url));
const EXPORT_SAMPLER = readFileSync(EXPORT_SAMPLER_PATH, 'utf-8');

const PIXEL_IMG = `![像素图](data:image/png;base64,${PIXEL_PNG_B64})`;

/** 二进制夹具（bin 视图路由素材）：数个非文本字节 */
const BIN_B64 = 'AAECAwQFBgc=';

/** 打开注入文档并等渲染管线异步面（markdown 根可见）落定 */
async function openDocs(page: Page, files: TextFileSpec[], name: string): Promise<void> {
  await injectDir(page, files);
  await openTreeFile(page, name);
  await expect(page.locator('.vv-markdown')).toBeVisible({ timeout: 20_000 });
}

/** 确保导出区可交互：≤600px 视口右栏在抽屉内，先点 toggle 拉出（b-md-export 同款） */
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
}

/** 点击导出 HTML 并抓 download（与既有 spec 同款 Promise.all 防丢事件） */
async function exportHtml(page: Page): Promise<{ fileName: string; html: string }> {
  const download = await Promise.all([
    page.waitForEvent('download', { timeout: 30_000 }),
    page.locator('.meta-export-btn', { hasText: '导出 HTML' }).click()
  ]).then(([d]) => d);
  return { fileName: download.suggestedFilename(), html: readFileSync(await download.path(), 'utf-8') };
}

/** 导出产物亮暗双标探针（浏览器 DOMParser 解析，正则对整 HTML 脆弱——b-md-export 同款手法） */
interface ExportModeProbe {
  vvMode: string | null;
  themeMode: string | null;
  /** 主题注入文本的变量「定义形态」数（--vv-ts-x:）——exportBaseCss 只有 var() 引用形态，
   * 定义形态出现即 style#vv-code-theme 注入链路在产物中 */
  tsVarDefs: number;
  katexFonts: number;
}

async function probeExportMode(page: Page, html: string): Promise<ExportModeProbe> {
  return page.evaluate((src) => {
    const doc = new DOMParser().parseFromString(src, 'text/html');
    return {
      vvMode: doc.documentElement.getAttribute('data-vv-mode'),
      themeMode: doc.documentElement.getAttribute('data-theme-mode'),
      tsVarDefs: (doc.documentElement.outerHTML.match(/--vv-ts-[a-z-]+\s*:/g) ?? []).length,
      katexFonts: (doc.documentElement.outerHTML.match(/data:font\/woff2;base64,/g) ?? []).length
    };
  }, html);
}

test.describe('b-md-lightbox-export-deep 灯箱与导出补强', () => {
  // 意图：锚定 5-5 同 src 多图错位修复——画廊条目按元素引用定位，点哪张开哪张
  test('LE-01 同 src 元素身份定位：两张同 src 图点第二张开第二张、点第一张开第一张', async ({ page }) => {
    test.setTimeout(60_000);
    await openDocs(page, [{ name: 'deep-same-src.md', content: `${PIXEL_IMG}\n\n${PIXEL_IMG}\n` }], 'deep-same-src.md');
    const imgs = page.locator('.vv-markdown img[data-md-lightbox]');
    await expect(imgs).toHaveCount(2);
    const overlay = page.locator('#md-lightbox-overlay');

    // 5-5 修复面：画廊按元素引用定位（itemEls 副表），同 src 不复用首个条目——
    // 点第二张必须落到 index 1（修复前按 src 查找恒 0，两图都开成 1/2）
    await imgs.nth(1).click();
    await expect(overlay).toBeVisible();
    await expect(overlay.locator('.md-lightbox-count')).toHaveText('2/2');
    await page.keyboard.press('Escape');
    await expect(overlay).toHaveCount(0);

    // 点第一张落 index 0：身份定位双向正确
    await imgs.nth(0).click();
    await expect(overlay).toBeVisible();
    await expect(overlay.locator('.md-lightbox-count')).toHaveText('1/2');
  });

  // 意图：锚定 5-4 图表 svg 直开灯箱——svg 与 img 同为画廊一等成员，直开落自身索引
  test('LE-02 图表 svg 点击直开灯箱：svg 成为画廊成员，直开落末位 svg 宿主', async ({ page }) => {
    test.setTimeout(60_000);
    await injectDir(page, [{ name: 'deep-svg-open.md', content: LIGHTBOX_SAMPLER }]);
    await openTreeFile(page, 'deep-svg-open.md');
    await expect(page.locator('.vv-markdown')).toBeVisible({ timeout: 20_000 });
    // 采样文档 3 img + 1 graphviz svg；先等图表真实渲染（collectGallery 点击时收集）
    const diagramSvg = page.locator('.vv-markdown .md-diagram-view svg');
    await expect(diagramSvg).toBeVisible({ timeout: 30_000 });

    // 5-4 修复面：直接点图表 svg（不经 img 中转）开灯箱，画廊 4 条落末位
    const overlay = page.locator('#md-lightbox-overlay');
    await diagramSvg.click();
    await expect(overlay).toBeVisible();
    await expect(overlay.locator('.md-lightbox-count')).toHaveText('4/4');
    await expect(overlay.locator('.md-lightbox-svg svg')).toBeVisible();
    await expect(overlay.locator('img.md-lightbox')).toBeHidden();
  });

  // 意图：锚定 5-2 输入元素守卫——输入焦点内按键直通不劫持灯箱键集，焦点移出恢复
  test('LE-03 输入守卫：input 聚焦时 Esc/←→ 不开合灯箱，焦点移出后恢复', async ({ page }) => {
    test.setTimeout(60_000);
    const doc = [
      PIXEL_IMG,
      '<input type="text" aria-label="守卫输入框">',
      PIXEL_IMG
    ].join('\n\n');
    await openDocs(page, [{ name: 'deep-guard.md', content: doc }], 'deep-guard.md');
    const input = page.locator('.vv-markdown input[type="text"]');
    await expect(input).toHaveCount(1, { timeout: 20_000 }); // raw HTML 透传前提（comrak unsafe + 净化放行）
    const overlay = page.locator('#md-lightbox-overlay');
    await page.locator('.vv-markdown img[data-md-lightbox]').first().click();
    await expect(overlay).toBeVisible();
    await expect(overlay.locator('.md-lightbox-count')).toHaveText('1/2');

    // 焦点入文档内 input（overlay 铺满挡 pointer，focus 是守卫读的 target 面）：
    // Esc 不关、←→ 不导航——5-2 输入控件按键直通
    await input.focus();
    await page.keyboard.press('Escape');
    await expect(overlay).toBeVisible();
    await page.keyboard.press('ArrowRight');
    await expect(overlay.locator('.md-lightbox-count')).toHaveText('1/2');

    // 焦点移出 input（Locator 无 blur，经 evaluate）：键集恢复劫持，Esc 关闭
    await input.evaluate((el) => el.blur());
    await page.keyboard.press('Escape');
    await expect(overlay).toHaveCount(0);
  });

  // 意图：锚定 5-3 a11y 基线——对话框语义/焦点入/读屏播报/关闭焦点还原全链在真浏览器可达
  test('LE-04 a11y 基线：对话框语义/焦点入 overlay/计数 aria-live/关闭焦点还原触发图', async ({ page }) => {
    test.setTimeout(60_000);
    // focus 原型包装 spy：应用脚本前注册（addInitScript），记录全部 focus 调用目标。
    // 焦点还原的还原目标 img 默认不可聚焦（focus 为 no-op、activeElement 不可观察），
    // 只能锚「removeLightboxOverlay 对触发元素调用了 focus()」这一行为面
    await page.addInitScript(() => {
      const w = window as unknown as { __vvFocusLog?: Element[] };
      w.__vvFocusLog = [];
      for (const proto of [HTMLElement.prototype, SVGElement.prototype]) {
        const orig = proto.focus;
        proto.focus = function (this: Element, ...args: unknown[]) {
          w.__vvFocusLog!.push(this);
          (orig as (this: Element, ...args: unknown[]) => void).apply(this, args);
        };
      }
    });
    await openDocs(page, [{ name: 'deep-a11y.md', content: `${PIXEL_IMG}\n\n${PIXEL_IMG}\n` }], 'deep-a11y.md');
    const trigger = page.locator('.vv-markdown img[data-md-lightbox]').first();
    const overlay = page.locator('#md-lightbox-overlay');
    await trigger.click();
    await expect(overlay).toBeVisible();

    // 对话框语义（5-3）：role=dialog + aria-modal + 程序化焦点入 overlay 本体
    await expect(overlay).toHaveAttribute('role', 'dialog');
    await expect(overlay).toHaveAttribute('aria-modal', 'true');
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('md-lightbox-overlay');
    // 计数徽标对读屏播报（aria-live=polite）
    await expect(overlay.locator('.md-lightbox-count')).toHaveAttribute('aria-live', 'polite');

    // 清空 spy 后 Esc：关闭链路对触发元素调用 focus()（焦点还原），且无其他 focus 调用
    await page.evaluate(() => {
      (window as unknown as { __vvFocusLog: Element[] }).__vvFocusLog.length = 0;
    });
    await page.keyboard.press('Escape');
    await expect(overlay).toHaveCount(0);
    const restored = await page.evaluate(() => {
      const log = (window as unknown as { __vvFocusLog: Element[] }).__vvFocusLog;
      const img = document.querySelector('.vv-markdown img[data-md-lightbox]');
      return log.length === 1 && log[0] === img;
    });
    expect(restored).toBe(true);
  });

  // 意图：锚定缩放限幅边界——0.2–8 限幅两端的输入被钳制、= 与滚轮同规、f 可复位
  test('LE-05 缩放限幅边界：+ 顶格 8x、- 底格 0.2x、= 同 +、f 复位、滚轮放大缩小', async ({ page }) => {
    test.setTimeout(60_000);
    await openDocs(page, [{ name: 'deep-zoom.md', content: `${PIXEL_IMG}\n` }], 'deep-zoom.md');
    const overlay = page.locator('#md-lightbox-overlay');
    await page.locator('.vv-markdown img[data-md-lightbox]').first().click();
    await expect(overlay).toBeVisible();
    const stage = overlay.locator('.md-lightbox-stage');

    // + 连按 10 次（1.25^10≈9.31 → clamp 8）：顶格后不再增长
    for (let i = 0; i < 10; i++) await page.keyboard.press('+');
    await expect(stage).toHaveAttribute('style', /scale\(8\)/);
    await page.keyboard.press('+');
    await expect(stage).toHaveAttribute('style', /scale\(8\)/);

    // - 连按 17 次（8×0.8^17≈0.18 → clamp 0.2）：底格后不再缩小（下限防缩没）
    for (let i = 0; i < 17; i++) await page.keyboard.press('-');
    await expect(stage).toHaveAttribute('style', /scale\(0\.2\)/);
    await page.keyboard.press('-');
    await expect(stage).toHaveAttribute('style', /scale\(0\.2\)/);

    // f 复位（既有用例只锚 r）；= 键与 + 同规
    await page.keyboard.press('f');
    await expect(stage).toHaveAttribute('style', /translate\(0px, 0px\) scale\(1\)/);
    await page.keyboard.press('=');
    await expect(stage).toHaveAttribute('style', /scale\(1\.25\)/);

    // 滚轮：上滚放大/下滚缩小（光标锚定仅影响 translate，不锚其值）
    await overlay.evaluate((el) => el.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, cancelable: true })));
    await expect(stage).toHaveAttribute('style', /scale\(1\.5625\)/);
    await overlay.evaluate((el) => el.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, cancelable: true })));
    await expect(stage).toHaveAttribute('style', /scale\(1\.25\)/);
    await page.keyboard.press('f');
    await expect(stage).toHaveAttribute('style', /translate\(0px, 0px\) scale\(1\)/);
  });

  // 意图：锚定 kroki img 形态条目入画廊——服务端图 img 与本地 svg/img 同列可导航
  test('LE-06 kroki img 形态画廊条目：mock 伺服 svg，next 导航到 kroki 条目', async ({ page }) => {
    test.setTimeout(60_000);
    // 拦截须在 goto（injectDir 内）前注册；krokiHost 指向不可达 mock host，
    // 命中 mock 才可能有 img（b-md-diagrams 同款通道）；kroki.io 兜底拦掉保环境无关
    await page.route('**/plantuml/svg/*', (route) =>
      route.fulfill({
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>'
      })
    );
    await page.route('**kroki.io/**', (route) => route.abort());
    await page.addInitScript(() => {
      localStorage.setItem(
        'vviewer:settings',
        JSON.stringify({ diagrams: { krokiHost: 'http://kroki.mock', modes: { plantuml: 'kroki' } } })
      );
    });
    const doc = `${PIXEL_IMG}\n\n\`\`\`plantuml\nAlice -> Bob\n\`\`\`\n`;
    await openDocs(page, [{ name: 'deep-kroki.md', content: doc }], 'deep-kroki.md');
    // kroki 形态：diagram-view 内 img（管线后置创建不经净化拦截），mock 命中加载成功
    await expect(
      page.locator('.vv-markdown .md-diagram-view img[src^="http://kroki.mock/plantuml/svg/"]')
    ).toBeVisible({ timeout: 30_000 });

    // 画廊 2 条（collectGallery 收所有 img 含 diagram-view 内）：本地图开 1/2，
    // next 到 kroki img 条目（src 记 kroki URL，img 克隆换 src）
    const overlay = page.locator('#md-lightbox-overlay');
    await page.locator('.vv-markdown img[data-md-lightbox]').first().click();
    await expect(overlay).toBeVisible();
    await expect(overlay.locator('.md-lightbox-count')).toHaveText('1/2');
    await page.keyboard.press('ArrowRight');
    await expect(overlay.locator('.md-lightbox-count')).toHaveText('2/2');
    await expect(overlay.locator('img.md-lightbox')).toHaveAttribute(
      'src',
      /^http:\/\/kroki\.mock\/plantuml\/svg\//
    );
  });

  // 意图：锚定 T1 关闭语义的负路径——点内容/控制件不关，只有 stage 空白背景关
  test('LE-07 点击关闭语义：点内容与控制件不关，点 stage 空白关（T1 裁决）', async ({ page }) => {
    test.setTimeout(60_000);
    await openDocs(page, [{ name: 'deep-close.md', content: `${PIXEL_IMG}\n\n${PIXEL_IMG}\n` }], 'deep-close.md');
    const overlay = page.locator('#md-lightbox-overlay');
    const stage = overlay.locator('.md-lightbox-stage');
    await page.locator('.vv-markdown img[data-md-lightbox]').first().click();
    await expect(overlay.locator('.md-lightbox-count')).toHaveText('1/2');

    // 点内容（stage 内克隆图）：mousedown 走 pan 逻辑（0 位移不置 dragMoved），
    // click 冒泡到 overlay 但 target 是内容 → 不关
    await overlay.locator('img.md-lightbox').click();
    await expect(overlay.locator('.md-lightbox-count')).toHaveText('1/2');

    // 点控制件：next 导航、放大生效，均不关
    await overlay.locator('.md-lightbox-btn-next').click();
    await expect(overlay.locator('.md-lightbox-count')).toHaveText('2/2');
    await overlay.locator('.md-lightbox-btn-zoom-in').click();
    await expect(stage).toHaveAttribute('style', /scale\(1\.25\)/);
    await expect(overlay).toBeVisible();

    // 点 stage 空白（视口左上角，bar 在底部、克隆图居中，必为空白）：关闭
    await page.mouse.click(20, 20);
    await expect(overlay).toHaveCount(0);
  });

  // 意图：锚定无键盘形态（移动端）的灯箱可用性——导航/缩放/复位/关闭全按钮可达
  test('LE-08 灯箱全按钮链可用性：next/放大/重置/关闭无键盘依赖（移动端触达基准）', async ({ page }) => {
    // 移动形态无物理键盘：灯箱可用性必须全按钮可达。断言面与输入通道无关，
    // chromium/mobile 双 project 同一链路（TA-02 惯例的按钮版——平移拖拽不在此列）
    test.setTimeout(60_000);
    await injectDir(page, [{ name: 'deep-btns.md', content: LIGHTBOX_SAMPLER }]);
    await openTreeFile(page, 'deep-btns.md');
    await expect(page.locator('.vv-markdown')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('.vv-markdown .md-diagram-view svg')).toBeVisible({ timeout: 30_000 });
    const overlay = page.locator('#md-lightbox-overlay');
    await page.locator('.vv-markdown img[data-md-lightbox]').first().click();
    await expect(overlay).toBeVisible();

    // next 三步到画廊末位（图表 svg 条目）
    const next = overlay.locator('.md-lightbox-btn-next');
    await next.click();
    await next.click();
    await next.click();
    await expect(overlay.locator('.md-lightbox-count')).toHaveText('4/4');
    await expect(overlay.locator('.md-lightbox-svg svg')).toBeVisible();

    // 缩放钮放大 → scale(1.25)；重置钮 → 1:1；关闭钮 → overlay 摘除
    await overlay.locator('.md-lightbox-btn-zoom-in').click();
    await expect(overlay.locator('.md-lightbox-stage')).toHaveAttribute('style', /scale\(1\.25\)/);
    await overlay.locator('.md-lightbox-btn-reset').click();
    await expect(overlay.locator('.md-lightbox-stage')).toHaveAttribute('style', /translate\(0px, 0px\) scale\(1\)/);
    await overlay.locator('.md-lightbox-btn-close').click();
    await expect(overlay).toHaveCount(0);
  });

  // 意图：锚定媒体占位与灯箱/导出的组合契约——媒体不入画廊、单张 UI 收敛、导出降级链接防 data URI 爆炸
  test('LE-09 媒体占位组合：video/audio 不入画廊、单张画廊 hidden 态、导出降级源地址链接', async ({ page }) => {
    test.setTimeout(90_000);
    const doc = [PIXEL_IMG, '![演示视频](demo.mp4)', '![示例音频](demo.mp3)'].join('\n\n');
    await openDocs(page, [{ name: 'deep-media.md', content: doc }], 'deep-media.md');
    // MD-13 预览形态：媒体扩展名渲染为 controls 占位（enrich 媒体替换）
    await expect(page.locator('.vv-markdown video[src="demo.mp4"]')).toHaveCount(1, { timeout: 20_000 });
    await expect(page.locator('.vv-markdown audio[src="demo.mp3"]')).toHaveCount(1);

    // 媒体不是 img/svg 不入画廊：唯一条目是像素图 → 单张画廊（prev/next/count 全 hidden）
    const overlay = page.locator('#md-lightbox-overlay');
    await page.locator('.vv-markdown img[data-md-lightbox]').first().click();
    await expect(overlay).toBeVisible();
    await expect(overlay.locator('.md-lightbox-count')).toHaveText('1/1');
    await expect(overlay.locator('.md-lightbox-count')).toHaveAttribute('hidden', '');
    await expect(overlay.locator('.md-lightbox-btn-prev')).toHaveAttribute('hidden', '');
    await expect(overlay.locator('.md-lightbox-btn-next')).toHaveAttribute('hidden', '');
    await page.keyboard.press('Escape');
    await expect(overlay).toHaveCount(0);

    // MD-13 导出降级：音视频占位替换为源地址超链接（防 data URI 爆炸），图片 data URI 保留
    await openExportArea(page);
    const { fileName, html } = await exportHtml(page);
    expect(fileName).toBe('deep-media.html');
    const probe = await page.evaluate((src) => {
      const doc = new DOMParser().parseFromString(src, 'text/html');
      const linkText = (href: string) => doc.querySelector(`a[href="${href}"]`)?.textContent ?? null;
      return {
        media: doc.querySelectorAll('video, audio').length,
        videoLink: linkText('demo.mp4'),
        audioLink: linkText('demo.mp3'),
        dataImg: doc.querySelectorAll('img[src^="data:image/png;base64,"]').length
      };
    }, html);
    expect(probe.media).toBe(0);
    expect(probe.videoLink).toBe('演示视频');
    expect(probe.audioLink).toBe('示例音频');
    expect(probe.dataImg).toBe(1);
  });

  // 意图：锚定导出 WYSIWYG 的亮暗双标——根元素模式标记随当前主题切换且变量注入恒在
  test('LE-10 暗色主题导出 WYSIWYG：亮/暗两段导出双标随当前模式，主题变量注入恒在', async ({ page }) => {
    test.setTimeout(120_000);
    await injectDir(page, [
      { name: 'export-sampler.md', content: EXPORT_SAMPLER },
      { name: 'export-sampler-pixel.png', type: 'image/png', b64: PIXEL_PNG_B64, content: '' }
    ]);
    await openTreeFile(page, 'export-sampler.md');
    const md = page.locator('.vv-markdown');
    await expect(md).toBeVisible({ timeout: 20_000 });
    await expect(md.locator('.katex').first()).toBeAttached({ timeout: 30_000 });
    await expect(md.locator('.md-diagram-view svg')).toBeVisible({ timeout: 30_000 });
    await openExportArea(page);

    // 亮色段：默认主题导出，根双标 light（stampMode 读注入主题 dataset.mode 回退亮色）
    const light = await exportHtml(page);
    const lightProbe = await probeExportMode(page, light.html);
    expect(lightProbe.vvMode).toBe('light');
    expect(lightProbe.themeMode).toBe('light');
    expect(lightProbe.tsVarDefs).toBeGreaterThan(0);
    expect(lightProbe.katexFonts).toBe(20);

    // 切暗（设置中心外观组 UI 通道，SC-03 同款）：订阅链生效后导出。
    // mobile 抽屉形态：右抽屉开着会遮 TopBar ⚙（click 等 actionability 直至超时）——
    // 先收抽屉；设置完成后 openExportArea 幂等拉出兜底
    const drawerOpen = await page.evaluate(() => {
      if (!window.matchMedia('(max-width: 600px)').matches) return false;
      const el = document.querySelector('.vv-right');
      return el !== null && getComputedStyle(el).transform === 'none';
    });
    if (drawerOpen) await page.locator('.vv-right-toggle').click();
    await page.locator('button[aria-label="设置"]').click();
    await expect(page.locator('.vv-settings-center')).toBeVisible();
    await page.getByLabel('亮暗模式').selectOption('dark');
    await page.locator('.vv-sc-apply').click();
    await expect(page.locator('.vv-sc-apply')).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(page.locator('.vv-settings-center')).toHaveCount(0);
    await expect(page.locator('html')).toHaveAttribute('data-theme-mode', 'dark');
    // 设置中心是全屏 overlay，关闭后右栏/抽屉状态应保持——幂等拉出兜底（mobile 抽屉形态）
    await openExportArea(page);

    // 暗色段：8b7732a 契约——data-vv-mode/data-theme-mode 双属性使注入块以同特异性
    // 稳定胜出 exportBaseCss 暗块默认值；主题变量注入链路恒在、KaTeX 排印不随主题丢
    const dark = await exportHtml(page);
    const darkProbe = await probeExportMode(page, dark.html);
    expect(darkProbe.vvMode).toBe('dark');
    expect(darkProbe.themeMode).toBe('dark');
    expect(darkProbe.tsVarDefs).toBeGreaterThan(0);
    expect(darkProbe.katexFonts).toBe(20);
  });

  // 意图：锚定句柄门控在非 markdown 视图族的完备性——图片/二进制 hex 同样清空导出区
  test('LE-11 非 markdown 视图导出句柄：图片/二进制 hex tab 清空导出区，切回 markdown 恢复', async ({ page }) => {
    test.setTimeout(90_000);
    await injectDir(page, [
      { name: 'deep-handle.md', content: `# 句柄门控\n\n${PIXEL_IMG}\n` },
      { name: 'deep-pixel.png', type: 'image/png', b64: PIXEL_PNG_B64, content: '' },
      { name: 'deep-blob.bin', type: 'application/octet-stream', b64: BIN_B64, content: '' }
    ]);
    // markdown tab：句柄上行两钮在
    await openTreeFile(page, 'deep-handle.md');
    await expect(page.locator('.meta-export-btn', { hasText: '导出 HTML' })).toBeAttached({ timeout: 20_000 });
    await expect(page.locator('.meta-export-btn', { hasText: '导出 PDF' })).toBeAttached();

    // 图片 tab（media 查看器）：句柄清空动作区消失
    await openTreeFile(page, 'deep-pixel.png');
    await expect(page.locator('.meta-export')).toHaveCount(0, { timeout: 20_000 });

    // 二进制 tab（hex/二进制查看器）：同样清空
    await openTreeFile(page, 'deep-blob.bin');
    await expect(page.locator('.meta-export')).toHaveCount(0, { timeout: 20_000 });

    // 切回 markdown：句柄重行两钮恢复
    await openTreeFile(page, 'deep-handle.md');
    await expect(page.locator('.meta-export-btn', { hasText: '导出 HTML' })).toBeAttached({ timeout: 20_000 });
    await expect(page.locator('.meta-export-btn', { hasText: '导出 PDF' })).toBeAttached();
  });

  // 意图：性能锚——大文档导出装配链（克隆/内联/KaTeX 排印）不发生数量级退化
  test('LE-12 大文档导出时长锚：150 段落 + 20 代码围栏 + 8 公式 + 5 图，导出 60s 内', async ({ page }) => {
    // 性能锚桌面基准（chromium-only，TA-02 惯例；mobile 同断言只翻倍套件时长无增量）。
    // 上限取实测的宽裕倍数（本地秒级）：锚「数量级退化」（如全量图 fetch 串行化/KaTeX
    // 装配失控）而非精确耗时，CI 双核负载波动不假红
    test.skip(test.info().project.name !== 'chromium', '性能锚桌面基准（chromium project，TA-02 惯例）');
    test.setTimeout(120_000);
    const parts: string[] = ['# 大文档导出性能锚', ''];
    for (let i = 0; i < 150; i++) parts.push(`段落 ${i}：导出装配链路的批量正文样本，覆盖 DOM 克隆与序列化成本。`);
    for (let i = 0; i < 20; i++) parts.push('```js', `function fn${i}() { return ${i}; }`, '```');
    for (let i = 0; i < 8; i++) parts.push(`行内公式 ${i}：$a_{${i}} + b_{${i}} = c_{${i}}$`);
    for (let i = 0; i < 5; i++) parts.push(`![锚图${i}](data:image/png;base64,${PIXEL_PNG_B64})`);
    await openDocs(page, [{ name: 'deep-big.md', content: parts.join('\n\n') + '\n' }], 'deep-big.md');
    // 管线异步面全部落定（语言徽标按钮 20 = copyCode 步完成，spec 2026-10-23 §5
    // 徽标即复制单入口；katex 8 = 排印步完成）再计时，排除渲染耗时对导出计时的污染
    await expect(page.locator('.vv-markdown .md-code-lang')).toHaveCount(20, { timeout: 30_000 });
    await expect(page.locator('.vv-markdown .katex')).toHaveCount(8, { timeout: 30_000 });
    await openExportArea(page);

    const started = Date.now();
    const { fileName } = await exportHtml(page);
    const elapsed = Date.now() - started;
    expect(fileName).toBe('deep-big.html');
    expect(elapsed).toBeLessThan(60_000);
  });
});
