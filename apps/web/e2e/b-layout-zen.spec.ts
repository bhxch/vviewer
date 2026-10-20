import { test, expect, type Page } from '@playwright/test';

/**
 * 布局自由化与 zen mode 冒烟（spec 2026-10-19 §2/§3/§3.1，plan Task 5）。
 *
 * 桌面（chromium project）：
 * - LZ-01 双栏折叠/展开 + reload 保持（layout 节持久化）
 * - LZ-02 中缝拖拽调宽 + clamp（180–480/160–420）+ 双击重置
 * - LZ-03 TopBar 右键隐藏 → 边缘热区唤出临时条 → 右键重显（无 temp 残留）
 * - LZ-04 TopBar 隐藏态 Ctrl+, 设置面板/新建工作区模态仍可见（台账带入断言：
 *   visibility 逃生门，b-layout-zen 钉住「隐藏条不影响挂点面板」不变式）
 * - LZ-05 zen：Ctrl+Alt+Z 进出、正交性（显式字段不改写）、Esc 面板优先、
 *   边缘条右键退出、桌面无浮钮
 * - LZ-06 reload 落 zen
 * - LZ-07 TopBar 可见+TabBar 隐藏组合：临时标签条指针移入内容区 1.5s 自动收回
 *   （终审 I-1——热区 pointerleave 是「移开」语义锚点，条 fixed top:0 压住可见
 *   邻条时条本体 onleave 不可达）
 *
 * 移动（mobile project，375×667 触摸）：
 * - mLZ-01 ☰ 抽屉头部「专注模式」进 zen + 右下浮钮（44px 触控标准）退出
 * - mLZ-02 返回键（page.goBack）先关面板再退 zen（zenPopAction 分派）
 * - mLZ-03 reload 落 zen：浮钮在场 + 守卫项经 history.state 存活、返回键仍退 zen
 * - mLZ-04 zen 隐抽屉 toggles/本体，退出还原进入前开合态
 * - mLZ-05 返回键先关 .vv-ws-pop 工作区菜单（终审 I-2——pop 是九类 overlay 中唯一
 *   无容器 keydown 的，合成 Esc 派发目标即本体被 window 兜底 contains 守卫挡下，
 *   closeOverlay 空转+守卫重压成返回键死循环；修复后通道闭合、二次返回退 zen）
 *
 * 渲染器双入口（状态栏指示器浮层/Tab 右键子菜单）已由 t-tab-actions TA-09 与
 * t-open-with OPEN-08 覆盖，本文件不重复。
 *
 * 锚点注意（Task 1–4 报告交接）：.vv-chrome-off 为 translateY(-100%) +
 * visibility:hidden（translateY 保留非空包围盒，isVisible 不适用——用 evaluate 查
 * computed visibility / className）；边缘热区用裸 page.mouse.move 进区（不用
 * locator.hover 的可操作性重试），唤出移动先落到内容区再进热区以触发 pointerenter。
 */

/** 读取持久化 layout 节（vviewer:settings） */
function layoutOf(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(
    () =>
      (JSON.parse(localStorage.getItem('vviewer:settings') ?? '{}') as { layout?: Record<string, unknown> })
        .layout ?? {}
  );
}

/** chrome 条状态：className + computed visibility（chrome-off 断言不用 isVisible） */
function barState(page: Page, selector: string): Promise<{ cls: string; visibility: string }> {
  return page.evaluate((sel) => {
    const el = document.querySelector<HTMLElement>(sel);
    if (el === null) return { cls: '', visibility: 'absent' };
    return { cls: el.className, visibility: getComputedStyle(el).visibility };
  }, selector);
}

/** 等应用挂载（AppShell 渲染出顶栏） */
async function waitApp(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('.vv-topbar')).toBeVisible();
}

/** 右键顶栏空白处（.vv-brand）打开 chrome 菜单并点指定条目 */
async function chromeMenuItem(page: Page, label: string): Promise<void> {
  await page.locator('.vv-brand').click({ button: 'right' });
  await page.locator('.vv-chromemenu button', { hasText: label }).click();
}

/** 把指针从内容区移入顶边缘热区（两段移动保证 pointerenter 触发） */
async function hoverTopEdge(page: Page): Promise<void> {
  await page.mouse.move(400, 300);
  await page.mouse.move(640, 4);
}

// ---------------------------------------------------------------- 桌面（chromium）

test.describe('布局与 zen（桌面）', () => {
  test.beforeEach(({}, testInfo) => {
    testInfo.skip(testInfo.project.name !== 'chromium', '桌面视口专属（仅 chromium project）');
  });

  test('LZ-01：双栏折叠/展开 + reload 保持（layout 节持久化）', async ({ page }) => {
    await waitApp(page);

    // 左栏折叠：竖条上岗、aside 挂 off 类、落盘
    await page.locator('.vv-collapse-left').click();
    await expect(page.locator('.vv-strip[data-side="left"]')).toBeVisible();
    await expect(page.locator('.vv-side')).toHaveClass(/vv-side-off/);
    expect(await layoutOf(page)).toMatchObject({ leftCollapsed: true });

    // reload 保持折叠态
    await page.reload();
    await expect(page.locator('.vv-strip[data-side="left"]')).toBeVisible();

    // 竖条展开钮还原
    await page.locator('.vv-strip[data-side="left"] .vv-strip-expand').click();
    await expect(page.locator('.vv-strip[data-side="left"]')).toHaveCount(0);
    await expect(page.locator('.vv-side')).not.toHaveClass(/vv-side-off/);
    expect(await layoutOf(page)).toMatchObject({ leftCollapsed: false });

    // 右栏同语义（不 reload）
    await page.locator('.vv-collapse-right').click();
    await expect(page.locator('.vv-strip[data-side="right"]')).toBeVisible();
    await expect(page.locator('.vv-right')).toHaveClass(/vv-right-off/);
    await page.locator('.vv-strip[data-side="right"] .vv-strip-expand').click();
    await expect(page.locator('.vv-strip[data-side="right"]')).toHaveCount(0);
  });

  test('LZ-02：中缝拖拽调宽 + clamp + 双击重置', async ({ page }) => {
    test.setTimeout(60_000);
    await waitApp(page);

    const readLeft = async (): Promise<number> =>
      (await layoutOf(page)).leftWidth as number;

    // +200 → 460（范围内不 clamp，松手落盘）
    let box = (await page.locator('.vv-colhandle[data-side="left"]').boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 200, box.y + box.height / 2, { steps: 4 });
    await page.mouse.up();
    expect(await readLeft()).toBe(460);

    // 再 +400 → 860 → clamp 上界 480
    box = (await page.locator('.vv-colhandle[data-side="left"]').boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 400, box.y + box.height / 2, { steps: 4 });
    await page.mouse.up();
    expect(await readLeft()).toBe(480);

    // 拖到视口最左 → 负增量 → clamp 下界 180
    box = (await page.locator('.vv-colhandle[data-side="left"]').boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(2, box.y + box.height / 2, { steps: 4 });
    await page.mouse.up();
    expect(await readLeft()).toBe(180);

    // 双击重置默认 260；宽度经内联 CSS 变量落 DOM（同一通道）
    await page.locator('.vv-colhandle[data-side="left"]').dblclick();
    expect(await readLeft()).toBe(260);
    await expect(page.locator('.vv-side')).toHaveAttribute('style', /--vv-side-w:\s*260px/);

    // 右栏 clamp 快验（右栏向左拖增宽）：230+400 → clamp 上界 420，双击重置 230
    const rbox = (await page.locator('.vv-colhandle[data-side="right"]').boundingBox())!;
    await page.mouse.move(rbox.x + rbox.width / 2, rbox.y + rbox.height / 2);
    await page.mouse.down();
    await page.mouse.move(rbox.x + rbox.width / 2 - 400, rbox.y + rbox.height / 2, { steps: 4 });
    await page.mouse.up();
    expect(await layoutOf(page)).toMatchObject({ rightWidth: 420 });
    await page.locator('.vv-colhandle[data-side="right"]').dblclick();
    expect(await layoutOf(page)).toMatchObject({ rightWidth: 230 });
  });

  test('LZ-03：TopBar 右键隐藏 → 边缘热区唤出临时条 → 右键重显（无 temp 残留）', async ({
    page
  }) => {
    await waitApp(page);

    // 右键顶栏 → 隐藏顶栏：chrome-off（translateY + visibility:hidden，不用 isVisible）
    await chromeMenuItem(page, '隐藏顶栏');
    let st = await barState(page, '.vv-topbar');
    expect(st.cls).toContain('vv-chrome-off');
    expect(st.visibility).toBe('hidden');
    expect(await page.locator('.vv-edge[data-edge="top"]').count()).toBe(1);
    expect(await layoutOf(page)).toMatchObject({ topBarVisible: false });

    // 边缘热区悬停 → 唤出临时条（真实条本体半透形态，visibility 恢复 visible）
    await hoverTopEdge(page);
    st = await barState(page, '.vv-topbar');
    expect(st.cls).toContain('vv-chrome-temp');
    expect(st.visibility).toBe('visible');

    // 临时条右键 → 显示顶栏；L1：重显后无 temp/off 残留类
    await chromeMenuItem(page, '显示顶栏');
    await expect(page.locator('.vv-chromemenu')).toHaveCount(0);
    st = await barState(page, '.vv-topbar');
    expect(st.cls).not.toContain('vv-chrome-off');
    expect(st.cls).not.toContain('vv-chrome-temp');
    expect(st.visibility).toBe('visible');
    expect(await layoutOf(page)).toMatchObject({ topBarVisible: true });
    expect(await page.locator('.vv-edge[data-edge="top"]').count()).toBe(0);
  });

  test('LZ-04：TopBar 隐藏态 Ctrl+, 设置面板与热区唤出打开的新建工作区模态仍可见（台账）', async ({
    page
  }) => {
    await waitApp(page);
    await chromeMenuItem(page, '隐藏顶栏');
    expect((await barState(page, '.vv-topbar')).cls).toContain('vv-chrome-off');

    // Ctrl+, （TopBar window 级监听，隐藏不失效）→ 设置面板可见。
    // 若面板落入隐藏条 visibility 继承域，toBeVisible（bbox + 非 visibility:hidden）在此拦截
    await page.keyboard.press('Control+,');
    const panel = page.locator('.vv-settings');
    await expect(panel).toBeVisible();
    expect(await panel.evaluate((el) => getComputedStyle(el).visibility)).toBe('visible');
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);

    // 热区唤出临时条 → 工作区菜单 → 新建工作区模态（TopBar 内挂点第二面板根）同不变式
    await hoverTopEdge(page);
    await page.locator('.vv-ws-trigger').click();
    await page.locator('.vv-ws-new').click();
    const modal = page.locator('.vv-wscreate');
    await expect(modal).toBeVisible();
    expect(await modal.evaluate((el) => getComputedStyle(el).visibility)).toBe('visible');
    await page.keyboard.press('Escape');
    await expect(modal).toHaveCount(0);
  });

  test('LZ-05：zen Ctrl+Alt+Z 进出 + 显式字段正交 + Esc 面板优先 + 边缘条退出', async ({
    page
  }) => {
    await waitApp(page);
    // 指针先移离顶热区：键盘进 zen 后热区插入 DOM，若光标恰在其上 Chromium 会
    // 补发 pointerenter 唤出临时条（真实行为）——中性区起点避免误唤出
    await page.mouse.move(400, 300);

    // 进入：shell 挂 zen 类、双条 chrome-off、落盘；正交性——显式字段不被改写
    await page.keyboard.press('Control+Alt+z');
    await expect(page.locator('.vv-shell.zen')).toHaveCount(1);
    expect((await barState(page, '.vv-topbar')).cls).toContain('vv-chrome-off');
    expect((await barState(page, '.vv-tabbar')).cls).toContain('vv-chrome-off');
    expect(await layoutOf(page)).toMatchObject({
      zen: true,
      topBarVisible: true,
      tabBarVisible: true,
      leftCollapsed: false,
      rightCollapsed: false
    });
    // 桌面无退出浮钮（≤900px 媒体查询外）
    await expect(page.locator('.vv-zen-exit')).toBeHidden();

    // Esc 面板优先：zen 中开设置面板 → Esc 只关面板、zen 保持
    await page.keyboard.press('Control+,');
    await expect(page.locator('.vv-settings')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.vv-settings')).toHaveCount(0);
    await expect(page.locator('.vv-shell.zen')).toHaveCount(1);

    // 无面板 Esc → 退 zen
    await page.keyboard.press('Escape');
    await expect(page.locator('.vv-shell.zen')).toHaveCount(0);
    expect(await layoutOf(page)).toMatchObject({ zen: false, topBarVisible: true });

    // 再进 zen：顶边缘热区唤出临时条 → 右键 → 退出专注模式（无 temp 残留）
    await page.keyboard.press('Control+Alt+z');
    await expect(page.locator('.vv-shell.zen')).toHaveCount(1);
    await hoverTopEdge(page);
    expect((await barState(page, '.vv-topbar')).cls).toContain('vv-chrome-temp');
    await chromeMenuItem(page, '退出专注模式');
    await expect(page.locator('.vv-shell.zen')).toHaveCount(0);
    const st = await barState(page, '.vv-topbar');
    expect(st.cls).not.toContain('vv-chrome-temp');
    expect(st.visibility).toBe('visible');
    expect(await layoutOf(page)).toMatchObject({ zen: false });
  });

  test('LZ-07：TopBar 可见+TabBar 隐藏——临时标签条移开 1.5s 自动收回（终审 I-1）', async ({
    page
  }) => {
    await waitApp(page);

    // 右键 tabbar 非条目区（管理钮）→ 隐藏标签栏：顶栏保持可见的 T+F 组合
    await page.locator('.vv-tabbar-manage').click({ button: 'right' });
    await page.locator('.vv-chromemenu button', { hasText: '隐藏标签栏' }).click();
    expect((await barState(page, '.vv-tabbar')).cls).toContain('vv-chrome-off');
    expect((await barState(page, '.vv-topbar')).cls).not.toContain('vv-chrome-off');
    expect(await page.locator('.vv-edge[data-edge="tab"]').count()).toBe(1);
    expect(await layoutOf(page)).toMatchObject({ topBarVisible: true, tabBarVisible: false });

    // 悬停 tab 热区（顶栏下方自然槽位）→ 临时标签条 fixed top:0 压住可见顶栏
    const edge = (await page.locator('.vv-edge[data-edge="tab"]').boundingBox())!;
    await page.mouse.move(400, 300);
    await page.mouse.move(edge.x + edge.width / 2, edge.y + edge.height / 2);
    expect((await barState(page, '.vv-tabbar')).cls).toContain('vv-chrome-temp');

    // 指针从热区直入内容区（不经过条本体——条自带 onleave 不可达的原始缺陷路径）：
    // 热区 pointerleave 排定 1.5s 收回
    await page.mouse.move(400, 300);
    await expect
      .poll(async () => (await barState(page, '.vv-tabbar')).cls, { timeout: 4_000 })
      .not.toContain('vv-chrome-temp');
    // 收回后回归隐藏态（off 类恢复），顶栏不受牵连
    expect((await barState(page, '.vv-tabbar')).cls).toContain('vv-chrome-off');
    expect((await barState(page, '.vv-topbar')).cls).not.toContain('vv-chrome-temp');
  });

  test('LZ-06：reload 落 zen（layout.zen 持久化，桌面无浮钮、Esc 退出）', async ({ page }) => {
    await waitApp(page);
    // 同 LZ-05：光标离开顶热区再进 zen（reload 前置态干净）
    await page.mouse.move(400, 300);
    await page.keyboard.press('Control+Alt+z');
    await expect(page.locator('.vv-shell.zen')).toHaveCount(1);

    await page.reload();
    await expect(page.locator('.vv-shell.zen')).toHaveCount(1);
    expect((await barState(page, '.vv-topbar')).cls).toContain('vv-chrome-off');
    expect(await layoutOf(page)).toMatchObject({ zen: true });
    await expect(page.locator('.vv-zen-exit')).toBeHidden();

    await page.keyboard.press('Escape');
    await expect(page.locator('.vv-shell.zen')).toHaveCount(0);
  });
});

// ---------------------------------------------------------------- 移动（mobile project）

test.describe('zen 移动端（mobile project）', () => {
  test.beforeEach(({}, testInfo) => {
    testInfo.skip(testInfo.project.name !== 'mobile', '移动视口专属（仅 mobile project）');
  });

  /** 经 ☰ 抽屉头部「专注模式」进入 zen（iOS Safari 不派发 contextmenu 的回落入口） */
  async function enterZenViaDrawer(page: Page): Promise<void> {
    await page.locator('.vv-drawer-toggle').click();
    await page.locator('.vv-drawer-zen').click();
    await expect(page.locator('.vv-shell.zen')).toHaveCount(1);
  }

  test('mLZ-01：☰ 抽屉头部进 zen + 右下浮钮（44px）退出', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.vv-topbar')).toBeVisible();
    await enterZenViaDrawer(page);
    expect(await layoutOf(page)).toMatchObject({ zen: true });
    await expect(page.locator('.vv-drawer-toggle')).toBeHidden();

    // 退出浮钮在场，44×44 触控标准
    const exit = page.locator('.vv-zen-exit');
    await expect(exit).toBeVisible();
    const box = (await exit.boundingBox())!;
    expect(box.width).toBe(44);
    expect(box.height).toBe(44);

    await exit.click();
    await expect(page.locator('.vv-shell.zen')).toHaveCount(0);
    expect(await layoutOf(page)).toMatchObject({ zen: false });
  });

  test('mLZ-02：返回键先关面板再退 zen（page.goBack，zenPopAction 双段分派）', async ({
    page
  }) => {
    await page.goto('/');
    await expect(page.locator('.vv-topbar')).toBeVisible();
    await enterZenViaDrawer(page);

    // 移动断点进 zen 即压守卫历史项（{vvZen:1} 在当前项）
    expect(await page.evaluate(() => (history.state as { vvZen?: number } | null)?.vvZen)).toBe(1);

    // zen 中 Ctrl+, 开设置面板（隐藏条挂点面板可见性同桌面不变式）
    await page.keyboard.press('Control+,');
    await expect(page.locator('.vv-settings')).toBeVisible();

    // 第一次返回：只关面板，zen 与守卫保持（closeOverlay 后守卫重压）
    await page.goBack();
    await expect(page.locator('.vv-settings')).toHaveCount(0);
    await expect(page.locator('.vv-shell.zen')).toHaveCount(1);
    expect(await page.evaluate(() => (history.state as { vvZen?: number } | null)?.vvZen)).toBe(1);

    // 第二次返回：退 zen（非离页）
    await page.goBack();
    await expect(page.locator('.vv-shell.zen')).toHaveCount(0);
    expect(await layoutOf(page)).toMatchObject({ zen: false });
    await expect(page.locator('.vv-topbar')).toBeVisible();
  });

  test('mLZ-03：reload 落 zen——浮钮在场、守卫项经 history.state 存活、返回键仍退 zen', async ({
    page
  }) => {
    await page.goto('/');
    await expect(page.locator('.vv-topbar')).toBeVisible();
    await enterZenViaDrawer(page);

    await page.reload();
    await expect(page.locator('.vv-shell.zen')).toHaveCount(1);
    await expect(page.locator('.vv-zen-exit')).toBeVisible();
    expect(await layoutOf(page)).toMatchObject({ zen: true });
    // 守卫历史项跨 reload 存活（history.state 持久，onMount 认领）
    expect(await page.evaluate(() => (history.state as { vvZen?: number } | null)?.vvZen)).toBe(1);

    // reload 后返回键仍先于离页退 zen
    await page.goBack();
    await expect(page.locator('.vv-shell.zen')).toHaveCount(0);
    await expect(page.locator('.vv-topbar')).toBeVisible();
  });

  test('mLZ-05：返回键先关 .vv-ws-pop 菜单（合成 Esc 容器通道，终审 I-2 死循环回归锚）', async ({
    page
  }) => {
    await page.goto('/');
    await expect(page.locator('.vv-topbar')).toBeVisible();
    await enterZenViaDrawer(page);

    // zen 顶栏隐藏（visibility:hidden 不可点）：顶部边缘热区唤出临时条再点触发钮
    const topEdge = (await page.locator('.vv-edge[data-edge="top"]').boundingBox())!;
    await page.mouse.move(180, 300);
    await page.mouse.move(topEdge.x + 4, topEdge.y + topEdge.height / 2);
    await expect(page.locator('.vv-topbar.vv-chrome-temp')).toBeVisible();
    await page.locator('.vv-ws-trigger').click();
    await expect(page.locator('.vv-ws-pop')).toBeVisible();

    // 第一次返回：只关菜单，zen 与守卫保持（修复前 closeOverlay 空转+守卫重压，
    // 菜单永不关、返回键连续无效的死循环）
    await page.goBack();
    await expect(page.locator('.vv-ws-pop')).toHaveCount(0);
    await expect(page.locator('.vv-shell.zen')).toHaveCount(1);
    expect(await page.evaluate(() => (history.state as { vvZen?: number } | null)?.vvZen)).toBe(1);

    // 第二次返回：退 zen（通道未被空转消耗）
    await page.goBack();
    await expect(page.locator('.vv-shell.zen')).toHaveCount(0);
    await expect(page.locator('.vv-topbar')).toBeVisible();
  });

  test('mLZ-04：zen 隐抽屉 toggles/本体，浮钮退出还原进入前开合态', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.vv-topbar')).toBeVisible();

    // 进入前左抽屉开着（还原基准）；抽屉头部入口直接进 zen
    // （勿再走 enterZenViaDrawer——其会再点一次 ☰ 把已开的抽屉关上，
    //  专注模式按钮随抽屉滑出视口，点击永等可操作性）
    await page.locator('.vv-drawer-toggle').click();
    await expect.poll(
      async () => (await page.locator('.vv-side').boundingBox())?.x ?? -1,
      { timeout: 3_000 }
    ).toEqual(0);
    await page.locator('.vv-drawer-zen').click();
    await expect(page.locator('.vv-shell.zen')).toHaveCount(1);
    // toggles 与抽屉本体全隐（zen 覆盖规则）
    await expect(page.locator('.vv-drawer-toggle')).toBeHidden();
    await expect(page.locator('.vv-right-toggle')).toBeHidden();
    expect(
      await page.locator('.vv-side').evaluate((el) => getComputedStyle(el).display)
    ).toBe('none');

    // 浮钮退出：toggles 回归 + 抽屉还原进入前的开态（drawerOpen 字段未被 zen 改写）
    await page.locator('.vv-zen-exit').click();
    await expect(page.locator('.vv-shell.zen')).toHaveCount(0);
    await expect(page.locator('.vv-drawer-toggle')).toBeVisible();
    await expect(page.locator('.vv-right-toggle')).toBeVisible();
    await expect.poll(
      async () => (await page.locator('.vv-side').boundingBox())?.x ?? -1,
      { timeout: 3_000 }
    ).toEqual(0);
  });
});
