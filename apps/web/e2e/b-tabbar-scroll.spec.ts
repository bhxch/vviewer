import { test, expect, type CDPSession, type Page } from '@playwright/test';
import { closeDrawerIfOpened, openDrawerIfNarrow } from './drawer';

/**
 * tab 条优雅滚动域（SCRL-01..08；标签栏收敛 spec §4 / Task 2）。域文档于 Task 4
 * 与 b-tabbar-menu（融合菜单域）统一收册 docs/e2e/tabbar-menu.md——本文件为 spec
 * §6.2「新域」结构性拆分的一半（箭头/滚动用例独立成文件），编号体系不变。
 *
 * - SCRL-01 可见性翻转 + 随 tab 数刷新（初态右显/滚到底翻转/关至不溢出双隐/新开复现）
 * - SCRL-02 单击滚动：0.8×视宽平滑滚（断言 ≥0.5×clientWidth 位移）
 * - SCRL-03 按住连滚：350ms 延迟后 80ms×64px 步进，位移显著大于单击档、释放即停
 * - SCRL-04 滚轮横移：mouse.wheel(0,240) → scrollLeft ≈ +240 且页面未竖滚
 * - SCRL-05 激活滚入：QO 通道激活远端 tab → 包围盒进入滚动区可视范围
 * - SCRL-06 滚动条隐藏：computed scrollbar-width:none
 * - SCRL-07 拖拽边缘自动滚：native-first 探针红（CDP 真实输入不进 drag session、
 *   无原生 autoscroll）→ TabBar 补手工 rAF 实现，用例以合成 dnd 事件序列驱动
 *   （仅 chromium project——375px 拖拽坐标不可靠，TA-02/THEME-03 桌面基准惯例）
 * - SCRL-08 触屏滑动横移：tab 条 touch swipe → scrollLeft 前移（spec §6.2「触屏
 *   滑动（mobile project 抽查）」计划 Task 2 静默收窄，终审裁决补口；仅 mobile
 *   project——hasTouch 触摸视口，SCRL-07 桌面基准的镜像。先行探针实证 headless
 *   一次性触摸滑动真产生位移（单滑满程），不落 PWA-06/2「触摸动量恒 0」受限域——
 *   本用例断跟手 panning，不断 touchend 惯性）
 *
 * 装置：目录注入同 t-shell/t-tab-actions（__vvOpenDirImpl，webkitRelativePath 首
 * 段 = label）连开 25 文件 tab（+1 目录 tab）保溢出；树行点击开 tab（抽屉断点经
 * drawer.ts 适配，mobile project 同套装置可跑——25 tab 在 375px 溢出更甚）。
 */

const SCROLLER = '.vv-tabbar-tabs';
// 25 枚（简报 ~15 的加量）：desktop 1280 视口 15 枚实测溢出仅 374px（maxScroll < 0.5×
// clientWidth），SCRL-02 的 0.5×cw 位移断言物理不可达——加量保溢出余量 ≈1500px
const FILES = Array.from({ length: 25 }, (_, i) => `scrl-${String(i + 1).padStart(2, '0')}.txt`);
const REG_SPECIAL = /[.*+?^${}()|[\]\\]/g;

const arrowR = (page: Page) => page.locator('.vv-tabbar-arrow[data-side="right"]');
const arrowL = (page: Page) => page.locator('.vv-tabbar-arrow[data-side="left"]');

/** 精确名 tab 定位（t-tab-actions 同款：.vv-tab-name 锚定，根 textContent 含 ✕） */
function tabNamed(page: Page, name: string) {
  return page.locator('.vv-tab').filter({
    has: page.locator('.vv-tab-name', { hasText: new RegExp(`^${name.replace(REG_SPECIAL, '\\$&')}$`) })
  });
}

async function waitAppMounted(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(
    () => typeof (window as unknown as { __vvOpenDirImpl?: unknown }).__vvOpenDirImpl === 'function'
  );
  await expect(page.locator('.vv-tabbar')).toBeVisible();
}

/** 目录注入（25 文件同源；产生 1 个「scrl」目录 tab + 树行） */
async function injectDir(page: Page): Promise<void> {
  await page.evaluate((names) => {
    const files = names.map((name) => {
      const f = new File(['scrl body\n'], name, { type: 'text/plain' });
      Object.defineProperty(f, 'webkitRelativePath', { value: `scrl/${name}` });
      return f;
    });
    return (window as unknown as { __vvOpenDirImpl: (f: File[]) => void }).__vvOpenDirImpl(files);
  }, FILES);
  await expect(page.locator('.vv-tree-row').first()).toBeVisible();
}

/** 树行点击开文件 tab（≤900px 抽屉断点适配，t-tab-actions openFile 同款） */
async function openFileTab(page: Page, name: string): Promise<void> {
  const drawer = await openDrawerIfNarrow(page);
  await page.locator('.vv-tree-row', { hasText: name }).click();
  await closeDrawerIfOpened(page, drawer);
  await expect(tabNamed(page, name)).toBeVisible();
}

/** 溢出装置：注入 + 连开 25 文件 tab（+目录 tab = 26），回卷最左后钉可见性断言。
 * 注意：连开 tab 时激活滚入（SCRL-05 行为）会把 scrollLeft 带到最右端——装置统一
 * setScrollLeft(0) 回到「初态」再断言右显左隐 */
async function openOverflowTabs(page: Page): Promise<void> {
  await waitAppMounted(page);
  await injectDir(page);
  for (const name of FILES) await openFileTab(page, name);
  await expect(page.locator('.vv-tab')).toHaveCount(FILES.length + 1);
  await setScrollLeft(page, 0);
  await expect(arrowR(page)).toBeVisible();
  await expect(arrowL(page)).toHaveCount(0);
}

const scrollLeftOf = (page: Page): Promise<number> =>
  page.evaluate((sel) => (document.querySelector(sel) as HTMLElement).scrollLeft, SCROLLER);

const clientWidthOf = (page: Page): Promise<number> =>
  page.evaluate((sel) => (document.querySelector(sel) as HTMLElement).clientWidth, SCROLLER);

/** 置 scrollLeft（scroll 事件照常派发 → 可见性重算；浏览器自行 clamp） */
const setScrollLeft = (page: Page, v: number): Promise<void> =>
  page.evaluate(
    ({ sel, v }) => {
      (document.querySelector(sel) as HTMLElement).scrollLeft = v;
    },
    { sel: SCROLLER, v }
  );

/** CDP 触摸滑动（hasTouch 下 Playwright touchscreen 只有 tap，滑动走 CDP 触摸事件；
 * mobile.spec.ts touchSwipe 同款） */
async function touchSwipe(
  page: Page,
  cdp: CDPSession,
  from: { x: number; y: number },
  to: { x: number; y: number }
): Promise<void> {
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: from.x, y: from.y, id: 1 }]
  });
  // 分步 move 模拟真实滑动轨迹（一步跳变可能被识别为 tap）
  const steps = 5;
  for (let i = 1; i <= steps; i++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [
        {
          x: from.x + ((to.x - from.x) * i) / steps,
          y: from.y + ((to.y - from.y) * i) / steps,
          id: 1
        }
      ]
    });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

async function closeTab(page: Page, name: string): Promise<void> {
  await tabNamed(page, name).locator('.vv-tab-close').click();
}

test.describe('tab 条优雅滚动（SCRL-01..08）', () => {
  test('SCRL-01：箭头可见性随滚动翻转并随 tab 数刷新', async ({ page }) => {
    await openOverflowTabs(page);
    // 初态（scrollLeft=0）：右钮可见左钮不渲染
    await expect(arrowR(page)).toBeVisible();
    await expect(arrowL(page)).toHaveCount(0);
    // 滚到底：左显右隐（{#if} 不渲染，count 0 锚定）
    await setScrollLeft(page, 999999);
    await expect(arrowL(page)).toBeVisible();
    await expect(arrowR(page)).toHaveCount(0);
    // 关闭若干 tab 至不溢出：双钮皆隐（保留目录 tab 持有来源）
    for (const name of FILES.slice(1)) await closeTab(page, name);
    await expect(page.locator('.vv-tab')).toHaveCount(2);
    await expect(arrowL(page)).toHaveCount(0);
    await expect(arrowR(page)).toHaveCount(0);
    // 新开 tab 至溢出：右钮复现（tabs 依赖驱动重算）。逐枚开、每枚开后回卷最左
    // 再查右钮——新开 tab 的激活滚入（SCRL-05 行为）会把 scrollLeft 追到最右端，
    // mobile 窄视口下右钮在滚定态恒不可见（scrollLeft+cw 恰达 scrollWidth），
    // 不回卷则循环开满全表仍判负
    for (const name of FILES.slice(1)) {
      await setScrollLeft(page, 0);
      if (await arrowR(page).isVisible()) break;
      await openFileTab(page, name);
    }
    await setScrollLeft(page, 0);
    await expect(arrowR(page)).toBeVisible();
  });

  test('SCRL-02：单击箭头平滑滚——位移 ≥ 0.5×clientWidth', async ({ page }) => {
    await openOverflowTabs(page);
    await setScrollLeft(page, 0);
    const cw = await clientWidthOf(page);
    await arrowR(page).click();
    // smooth 动画异步：poll 至位移达标（目标 0.8×cw，断言 0.5 留动画观察余量）
    await expect
      .poll(async () => await scrollLeftOf(page), { timeout: 5000 })
      .toBeGreaterThanOrEqual(Math.floor(cw * 0.5));
  });

  test('SCRL-03：按住连滚——位移显著大于单击档且释放即停', async ({ page }) => {
    await openOverflowTabs(page);
    await setScrollLeft(page, 0);
    const cw = await clientWidthOf(page);
    const box = await arrowR(page).boundingBox();
    if (box === null) throw new Error('右箭头无包围盒');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    // 按住直至连滚位移显著超过单击档（0.8×cw）：350ms 延迟 + 80ms 间隔×64px 步进。
    // 按住时长由位移达标驱动（poll）而非固定 600ms——600ms 档仅在窄视口数学成立
    // （desktop 1280 单击档 ≈880px，600ms 连滚仅 ~3 步 192px），语义锚 = 位移超档
    await expect
      .poll(async () => await scrollLeftOf(page), { timeout: 15000 })
      .toBeGreaterThanOrEqual(Math.ceil(cw * 0.9));
    await page.mouse.up();
    // 释放即停：连滚 held 旗标抑制随后 click 补滚——位移不再增长（若 click 未被
    // 抑制，smooth +0.8×cw 动画会在观察窗内继续位移）
    await page.waitForTimeout(300);
    const stopped = await scrollLeftOf(page);
    await page.waitForTimeout(400);
    expect(await scrollLeftOf(page)).toBe(stopped);
    expect(stopped).toBeGreaterThanOrEqual(Math.ceil(cw * 0.9));
  });

  test('SCRL-04：滚轮竖向分量归一横移——scrollLeft ≈ +240 且页面未竖滚', async ({ page }) => {
    await openOverflowTabs(page);
    await setScrollLeft(page, 0);
    const sb = await page.locator(SCROLLER).boundingBox();
    if (sb === null) throw new Error('滚动容器无包围盒');
    await page.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2);
    const scrollY0 = await page.evaluate(() => window.scrollY);
    await page.mouse.wheel(0, 240);
    // handler 非被动 preventDefault + scrollLeft += 归一 delta（instant，无动画尾）。
    // 期望位移按 devicePixelRatio 修正：CDP wheel delta 按设备像素换算 CSS px，
    // mobile project（deviceScaleFactor:2）实测 240 → 120（chromium DSF=1 → 240）
    const dsf = await page.evaluate(() => window.devicePixelRatio);
    const expected = Math.round(240 / dsf);
    await expect.poll(async () => await scrollLeftOf(page)).toBeGreaterThanOrEqual(expected - 10);
    expect(await scrollLeftOf(page)).toBeLessThanOrEqual(expected + 10);
    expect(await page.evaluate(() => window.scrollY)).toBe(scrollY0);
  });

  test('SCRL-05：激活滚入——QO 通道激活最右 tab 进入滚动区可视范围', async ({ page }) => {
    await openOverflowTabs(page);
    await setScrollLeft(page, 0);
    // QO 通道（Ctrl+P）激活远端 tab：scrl-25 = 25 枚中的最右
    await page.keyboard.press('Control+p');
    await expect(page.locator('.vv-quickopen')).toBeVisible();
    await page.keyboard.type('scrl-25');
    await page.keyboard.press('Enter');
    const active = page.locator('.vv-tab.active');
    await expect(active).toContainText('scrl-25');
    // 包围盒断言：nearest 滚入后激活 tab 完整落在滚动区可视区间内
    await expect
      .poll(async () => {
        const ab = await active.boundingBox();
        const sb = await page.locator(SCROLLER).boundingBox();
        if (ab === null || sb === null) return false;
        return ab.x >= sb.x - 1 && ab.x + ab.width <= sb.x + sb.width + 1;
      })
      .toBeTruthy();
  });

  test('SCRL-06：滚动条隐藏——computed scrollbar-width:none', async ({ page }) => {
    await openOverflowTabs(page);
    const sw = await page.evaluate(
      (sel) => getComputedStyle(document.querySelector(sel) as HTMLElement).scrollbarWidth,
      SCROLLER
    );
    expect(sw).toBe('none');
  });

  test('SCRL-07：拖拽右缘 36px 带悬置 ≥1s → scrollLeft 自增（探针红→手工实现终态）', async ({
    page
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== 'chromium',
      '375px 下多 tab 横向滚动拖拽坐标不可靠——桌面基准（TA-02/THEME-03 惯例）'
    );
    await openOverflowTabs(page);
    await setScrollLeft(page, 0);
    // 探针结论（TabBar.svelte 注释同步记档）：真实输入通道（CDP）——dragTo 无
    // 悬置窗口、手动 mouse down/move 序列实测不进入 drag session（dragover 派发
    // 为 0）——Chromium headless 无原生 autoscroll 可言。终态改以合成 dnd 事件
    // 序列驱动手工 rAF 实现：dragstart 置源（tab 上，置 dragFromId 门禁）→
    // dragover 右缘 36px 带内 ×12 次/100ms（与真实悬置 dragover 持续派发同频，
    // ~100-350ms 间隔）→ dragend 清理（断言滚停）
    const fireDnd = (type: string, targetSel: string, x: number): Promise<void> =>
      page.evaluate(
        ({ type, targetSel, x }) => {
          const target = document.querySelector(targetSel) as HTMLElement;
          const dt = new DataTransfer();
          dt.setData('text/plain', 'scrl-dnd');
          target.dispatchEvent(
            new DragEvent(type, {
              bubbles: true,
              cancelable: true,
              clientX: x,
              clientY: 20,
              dataTransfer: dt
            })
          );
        },
        { type, targetSel, x }
      );
    const edgeX = await page.evaluate((sel) => {
      const el = document.querySelector(sel) as HTMLElement;
      return el.getBoundingClientRect().right - 18;
    }, SCROLLER);
    // dragstart 派发到首个 tab（per-tab 闭包 handler 置 dragFromId；dataTransfer
    // 非空过 Firefox 兼容分支）
    await fireDnd('dragstart', '.vv-tab', 40);
    const s0 = await scrollLeftOf(page);
    for (let i = 0; i < 12; i++) {
      await fireDnd('dragover', SCROLLER, edgeX);
      await page.waitForTimeout(100);
    }
    const s1 = await scrollLeftOf(page);
    expect(s1, '右缘 36px 带悬置 1.2s 应持续步进滚动').toBeGreaterThan(s0);
    // dragend 清理：rAF 链终止。s1 取于链仍活跃期（末次 dragover 与 dragend 间
    // 可能多滚 ≤ 数帧），故停此断言只比较 dragend 之后的两个时间点
    await fireDnd('dragend', '.vv-tab', edgeX);
    await page.waitForTimeout(250);
    const stopped = await scrollLeftOf(page);
    await page.waitForTimeout(300);
    expect(await scrollLeftOf(page)).toBe(stopped);
  });

  test('SCRL-08：触屏滑动横移——tab 条 touch swipe → scrollLeft 前移（仅 mobile）', async ({
    page
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== 'mobile',
      '触屏滑动需 hasTouch 触摸视口——mobile project 限定（SCRL-07 桌面基准的镜像）'
    );
    await openOverflowTabs(page);
    await setScrollLeft(page, 0);
    const sb = await page.locator(SCROLLER).boundingBox();
    if (sb === null) throw new Error('滚动容器无包围盒');
    // 手指右→左滑（内容左移 → scrollLeft 增），落滚动区包围盒中带
    const cy = sb.y + sb.height / 2;
    const cdp = await page.context().newCDPSession(page);
    await touchSwipe(
      page,
      cdp,
      { x: sb.x + sb.width * 0.8, y: cy },
      { x: sb.x + sb.width * 0.2, y: cy }
    );
    // 触摸 panning 走浏览器合成器，滑动到位有异步尾——poll 至位移出现（先行探针
    // 实测单滑即满程；无惯性断言面，PWA-06/2 touchend 动量恒 0 受限域不属本用例）
    await expect.poll(async () => await scrollLeftOf(page), { timeout: 5000 }).toBeGreaterThan(0);
  });
});
