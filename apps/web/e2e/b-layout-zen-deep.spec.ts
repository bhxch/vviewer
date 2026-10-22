import { test, expect, type Page } from '@playwright/test';

/**
 * 布局与专注模式补强批（b-layout-zen-deep）：六批落地后的边界/负路径/组合交互。
 * 既有 b-layout-zen（LZ-01~07 桌面主路径 + mLZ-01~05 移动主路径）不重复，本文件
 * 只补其空隙，用例编号顺延：
 *
 * 桌面（chromium project）：
 * - LZ-08 双栏组合折叠 + 各自独立调宽后 reload 全量还原（LZ-01/02 均单面）
 * - LZ-09 拖拽实时预览通道：途中 CSS 变量即时变 + 越界途中即夹紧 + localStorage
 *   不落盘（松手才写）——LZ-02 只锚松手落盘值，预览/持久双通道与其负路径未锚
 * - LZ-10 chromeVisible 逆组合：TopBar 隐+TabBar 显 → 双隐双热区各归各互不串扰
 *   → 逐条重显全量还原（LZ-03 单隐、LZ-07 的 T+F 逆组合）
 * - LZ-11 热区 1.5s 定时器竞态：窗口内重进取消已排定的收回（summonTemp 清定时器）、
 *   重进后持续钉住 temp 证明无早收、终离一次收回回归 off（无常驻临时条/闪烁）
 * - LZ-12 zen×overlay 组合矩阵：目录管理(Ctrl+Alt+M)/快速打开(Ctrl+P)/设置中心
 *   (Ctrl+,) 逐层 Esc 先关面板再退 zen（zenEscAction 完整锚；LZ-05 只锚设置中心）
 * - LZ-13 输入焦点放行：快速打开输入框聚焦态 Ctrl+Alt+Z 仍切 zen 且面板不被连带
 *   关闭——AppShell onKey 评审 L2「组合键置于 inField 判定之前」的有意语义
 *   （注意与「输入框内快捷键不触发」的直觉相反，非 inField 拦截面）
 * - LZ-15 .vv-status-picker 入册 OVERLAY_SELECTOR：zen 中开状态栏 picker，Esc 只关
 *   picker 不退 zen——桌面 Esc capture 相快照以该选择器判定「面板在场」，缺册会
 *   关面板+退 zen 双动作
 *
 * 双 project：
 * - LZ-14 渲染器双入口接力：状态栏 picker 置 override → Tab 右键子菜单「自动」
 *   清除，两壳 ✓ 标记/指示器互相同步（candidatesOf 同源；TA-09/OPEN-08 各壳单测
 *   的跨壳组合，jsonl 载体）
 *
 * 移动（mobile project）：
 * - mLZ-06 zen 链加深：进 zen → reload（守卫存活）→ Ctrl+, 开面板 → 返回键关面板
 *   （守卫重压）→ 返回键退 zen → toggles 回归 + 抽屉复用（mLZ-02/03/04 的次序组合）
 *
 * 共享装置说明：本文件自带 waitApp/layoutOf/barState/chromeMenuItem/hoverTopEdge/
 * dropFile 局部副本（b-layout-zen 与 t-open-with 同款，spec 间不互 import 的惯例）。
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

/** 中缝把手拖拽（桌面断点）：dx>0 左栏增宽 / 右栏减宽（同一条增量数学取反） */
async function dragHandle(page: Page, side: 'left' | 'right', dx: number): Promise<void> {
  const box = (await page.locator(`.vv-colhandle[data-side="${side}"]`).boundingBox())!;
  const y = box.y + box.height / 2;
  const x = box.x + box.width / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y, { steps: 4 });
  await page.mouse.up();
}

interface DropPayload {
  name: string;
  type: string;
  content?: string;
}

/** 合成 drop 注入单文件并等 tab 激活（t-open-with 同款通道） */
async function dropFile(page: Page, payload: DropPayload): Promise<void> {
  await page.evaluate((p) => {
    const file = new File([p.content ?? ''], p.name, { type: p.type });
    const dt = new DataTransfer();
    dt.items.add(file);
    window.dispatchEvent(
      new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })
    );
  }, payload);
  await expect(page.locator('.vv-tab.active', { hasText: payload.name })).toBeVisible();
}

// ---------------------------------------------------------------- 桌面（chromium）

test.describe('布局与 zen 补强（桌面）', () => {
  test.beforeEach(({}, testInfo) => {
    testInfo.skip(testInfo.project.name !== 'chromium', '桌面视口专属（仅 chromium project）');
  });

  test('LZ-08：双栏组合折叠 + 各自独立调宽后 reload 全量还原', async ({ page }) => {
    await waitApp(page);

    // 左 +60 → 320、右 -70 → 300：两栏增量数学各自独立（右栏向左拖增宽）
    await dragHandle(page, 'left', 60);
    expect(await layoutOf(page)).toMatchObject({ leftWidth: 320 });
    await dragHandle(page, 'right', -70);
    expect(await layoutOf(page)).toMatchObject({ rightWidth: 300 });

    // 双栏同时折叠：双竖条上岗
    await page.locator('.vv-collapse-left').click();
    await page.locator('.vv-collapse-right').click();
    await expect(page.locator('.vv-strip[data-side="left"]')).toBeVisible();
    await expect(page.locator('.vv-strip[data-side="right"]')).toBeVisible();

    // reload 全量还原：折叠态 + 两宽各自保留（四字段互不挤占）
    await page.reload();
    await expect(page.locator('.vv-strip[data-side="left"]')).toBeVisible();
    await expect(page.locator('.vv-strip[data-side="right"]')).toBeVisible();
    expect(await layoutOf(page)).toMatchObject({
      leftCollapsed: true,
      rightCollapsed: true,
      leftWidth: 320,
      rightWidth: 300
    });

    // 双竖条展开：还原的是折叠位而非默认宽（320/300 经内联 CSS 变量回 DOM）
    await page.locator('.vv-strip[data-side="left"] .vv-strip-expand').click();
    await page.locator('.vv-strip[data-side="right"] .vv-strip-expand').click();
    await expect(page.locator('.vv-colhandle[data-side="left"]')).toBeVisible();
    await expect(page.locator('.vv-colhandle[data-side="right"]')).toBeVisible();
    await expect(page.locator('.vv-side')).toHaveAttribute('style', /--vv-side-w:\s*320px/);
    await expect(page.locator('.vv-right')).toHaveAttribute('style', /--vv-right-w:\s*300px/);
    expect(await layoutOf(page)).toMatchObject({ leftCollapsed: false, rightCollapsed: false });
  });

  test('LZ-09：拖拽实时预览——途中 CSS 变量即时夹紧且不落盘，松手才写', async ({ page }) => {
    test.setTimeout(60_000);
    await waitApp(page);

    // 按下后小步 +30：预览 290（未越界的实时跟踪），localStorage 未写
    //（layoutOf 的 {} 即「未落盘」形态：新会话产品启动不落盘 settings，layout 节缺省；
    // 对照组在松手后——落盘值出现即预览/持久双通道分离的行为锚）
    const box = (await page.locator('.vv-colhandle[data-side="left"]').boundingBox())!;
    const y = box.y + box.height / 2;
    const x0 = box.x + box.width / 2;
    await page.mouse.move(x0, y);
    await page.mouse.down();
    await page.mouse.move(x0 + 30, y, { steps: 2 });
    await expect(page.locator('.vv-side')).toHaveAttribute('style', /--vv-side-w:\s*290px/);
    expect(await layoutOf(page)).toEqual({});

    // 拉到远超上界（+700）：预览途中即夹紧上界 480，仍未落盘
    await page.mouse.move(x0 + 700, y, { steps: 4 });
    await expect(page.locator('.vv-side')).toHaveAttribute('style', /--vv-side-w:\s*480px/);
    expect(await layoutOf(page)).toEqual({});

    // 拉到视口最左（负增量）：预览即夹紧下界 180；松手才一次性落盘
    await page.mouse.move(2, y, { steps: 4 });
    await expect(page.locator('.vv-side')).toHaveAttribute('style', /--vv-side-w:\s*180px/);
    expect(await layoutOf(page)).toEqual({});
    await page.mouse.up();
    expect(await layoutOf(page)).toMatchObject({ leftWidth: 180 });

    // 右栏负值负路径：向右拖 200（230-200=30 → 预览夹下界 160），松手落盘 160
    const rb = (await page.locator('.vv-colhandle[data-side="right"]').boundingBox())!;
    const ry = rb.y + rb.height / 2;
    const rx = rb.x + rb.width / 2;
    await page.mouse.move(rx, ry);
    await page.mouse.down();
    await page.mouse.move(rx + 200, ry, { steps: 4 });
    await expect(page.locator('.vv-right')).toHaveAttribute('style', /--vv-right-w:\s*160px/);
    expect(await layoutOf(page)).toMatchObject({ rightWidth: 230 });
    await page.mouse.up();
    expect(await layoutOf(page)).toMatchObject({ rightWidth: 160 });
  });

  test('LZ-10：TopBar 隐+TabBar 显逆组合 → 双隐双热区各归各 → 逐条重显全量还原', async ({
    page
  }) => {
    test.setTimeout(60_000);
    await waitApp(page);
    await page.mouse.move(400, 300);

    // F+T：隐顶栏（标签栏保持可见）——仅顶热区上岗
    await chromeMenuItem(page, '隐藏顶栏');
    expect((await barState(page, '.vv-topbar')).cls).toContain('vv-chrome-off');
    expect((await barState(page, '.vv-tabbar')).cls).not.toContain('vv-chrome-off');
    expect(await page.locator('.vv-edge[data-edge="top"]').count()).toBe(1);
    expect(await page.locator('.vv-edge[data-edge="tab"]').count()).toBe(0);

    // 再隐标签栏 → 双隐：双热区同场（shell flex 流各归各槽位）
    await page.locator('.vv-tabbar-manage').click({ button: 'right' });
    await page.locator('.vv-chromemenu button', { hasText: '隐藏标签栏' }).click();
    expect(await page.locator('.vv-edge[data-edge="top"]').count()).toBe(1);
    expect(await page.locator('.vv-edge[data-edge="tab"]').count()).toBe(1);
    expect(await layoutOf(page)).toMatchObject({ topBarVisible: false, tabBarVisible: false });

    // 顶热区只唤顶栏、标签栏不被牵连；移开收回后仍 off
    await hoverTopEdge(page);
    expect((await barState(page, '.vv-topbar')).cls).toContain('vv-chrome-temp');
    expect((await barState(page, '.vv-tabbar')).cls).toContain('vv-chrome-off');
    await page.mouse.move(400, 300);
    await expect
      .poll(async () => (await barState(page, '.vv-topbar')).cls, { timeout: 4_000 })
      .not.toContain('vv-chrome-temp');

    // tab 热区只唤标签栏、顶栏保持 off（互不串扰的第二向）
    const tedge = (await page.locator('.vv-edge[data-edge="tab"]').boundingBox())!;
    await page.mouse.move(tedge.x + tedge.width / 2, tedge.y + tedge.height / 2);
    expect((await barState(page, '.vv-tabbar')).cls).toContain('vv-chrome-temp');
    expect((await barState(page, '.vv-topbar')).cls).toContain('vv-chrome-off');
    await page.mouse.move(400, 300);
    await expect
      .poll(async () => (await barState(page, '.vv-tabbar')).cls, { timeout: 4_000 })
      .not.toContain('vv-chrome-temp');

    // 逐条重显（隐藏态只能经各自热区唤临时条右键）：先标签栏再顶栏
    const tedge2 = (await page.locator('.vv-edge[data-edge="tab"]').boundingBox())!;
    await page.mouse.move(400, 300);
    await page.mouse.move(tedge2.x + tedge2.width / 2, tedge2.y + tedge2.height / 2);
    await page.locator('.vv-tabbar-manage').click({ button: 'right' });
    await page.locator('.vv-chromemenu button', { hasText: '显示标签栏' }).click();
    await expect(page.locator('.vv-edge[data-edge="tab"]')).toHaveCount(0);
    await hoverTopEdge(page);
    await chromeMenuItem(page, '显示顶栏');

    // 全量还原：无 off/temp 残留、热区清空、字段双 true
    const top = await barState(page, '.vv-topbar');
    const tab = await barState(page, '.vv-tabbar');
    expect(top.cls).not.toContain('vv-chrome-off');
    expect(top.cls).not.toContain('vv-chrome-temp');
    expect(tab.cls).not.toContain('vv-chrome-off');
    expect(tab.cls).not.toContain('vv-chrome-temp');
    expect(await page.locator('.vv-edge').count()).toBe(0);
    expect(await layoutOf(page)).toMatchObject({ topBarVisible: true, tabBarVisible: true });
  });

  test('LZ-11：热区 1.5s 定时器竞态——窗口内重进取消收回、终离一次收回（无常驻条）', async ({
    page
  }) => {
    test.setTimeout(60_000);
    await waitApp(page);
    await chromeMenuItem(page, '隐藏顶栏');
    expect((await barState(page, '.vv-topbar')).cls).toContain('vv-chrome-off');

    // 唤出后移开（排定 1.5s 收回），~600ms 处重进：summonTemp 应清未决定时器
    await hoverTopEdge(page);
    expect((await barState(page, '.vv-topbar')).cls).toContain('vv-chrome-temp');
    await page.mouse.move(400, 300);
    let reentered = false;
    const leftAt = Date.now();
    await expect.poll(async () => {
      // 窗口内（<1.5s）temp 必须一直在——若提前收回，此处先炸
      expect((await barState(page, '.vv-topbar')).cls).toContain('vv-chrome-temp');
      if (!reentered && Date.now() - leftAt >= 600) {
        reentered = true;
        await hoverTopEdge(page);
      }
      return reentered;
    }, { timeout: 5_000 }).toBe(true);
    expect(reentered, '重进须发生在 1.5s 窗口内（轮询节奏异常时此锚先炸）').toBe(true);

    // 重进后持续钉住 temp ≥2.1s：首离排定的定时器若未被清除，至迟 1.5s 处已收回
    const reenteredAt = Date.now();
    await expect.poll(async () => {
      expect((await barState(page, '.vv-topbar')).cls).toContain('vv-chrome-temp');
      return Date.now() - reenteredAt;
    }, { timeout: 6_000 }).toBeGreaterThanOrEqual(2_100);

    // 终离一次：1.5s 内收回且回归 off 隐藏态（清定时器语义，无残留临时条）
    await page.mouse.move(400, 300);
    await expect
      .poll(async () => (await barState(page, '.vv-topbar')).cls, { timeout: 4_000 })
      .not.toContain('vv-chrome-temp');
    expect((await barState(page, '.vv-topbar')).cls).toContain('vv-chrome-off');
  });

  test('LZ-12：zen×overlay 组合矩阵——目录管理/快速打开/设置中心逐层 Esc 先关面板再退 zen', async ({
    page
  }) => {
    test.setTimeout(60_000);
    await waitApp(page);
    await page.mouse.move(400, 300);
    await page.keyboard.press('Control+Alt+z');
    await expect(page.locator('.vv-shell.zen')).toHaveCount(1);

    // 目录管理（Ctrl+Alt+M，OVERLAY_SELECTOR 第二员）：Esc 只关管理页
    await page.keyboard.press('Control+Alt+m');
    const mounts = page.locator('.vv-mounts-manager');
    await expect(mounts).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(mounts).toHaveCount(0);
    await expect(page.locator('.vv-shell.zen')).toHaveCount(1);

    // 快速打开（Ctrl+P）：Esc 只关面板
    await page.keyboard.press('Control+p');
    const quick = page.locator('.vv-quickopen');
    await expect(quick).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(quick).toHaveCount(0);
    await expect(page.locator('.vv-shell.zen')).toHaveCount(1);

    // 设置中心（Ctrl+,）：Esc 只关设置页；无面板 Esc 才退 zen
    await page.keyboard.press('Control+,');
    await expect(page.locator('.vv-settings-center')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.vv-settings-center')).toHaveCount(0);
    await expect(page.locator('.vv-shell.zen')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(page.locator('.vv-shell.zen')).toHaveCount(0);
    expect(await layoutOf(page)).toMatchObject({ zen: false, topBarVisible: true });
  });

  test('LZ-13：输入焦点放行——快速打开输入框聚焦态 Ctrl+Alt+Z 仍切 zen（组合键先于 inField）', async ({
    page
  }) => {
    test.setTimeout(60_000);
    await waitApp(page);
    await page.keyboard.press('Control+p');
    const input = page.locator('.vv-quickopen-input');
    await expect(input).toBeVisible();
    await expect(input).toBeFocused();
    await input.fill('zen');

    // 焦点在输入框：Ctrl+Alt+Z 仍切换 zen（AppShell 评审 L2 有意语义——组合键不被
    // inField 拦截），且快速打开面板不被连带关闭（zen 只翻 zen 字段）
    await page.keyboard.press('Control+Alt+z');
    await expect(page.locator('.vv-shell.zen')).toHaveCount(1);
    expect(await layoutOf(page)).toMatchObject({ zen: true });
    await expect(page.locator('.vv-quickopen')).toBeVisible();

    // Esc 面板优先：先关快速打开，zen 保持；再次 Esc 退 zen
    await page.keyboard.press('Escape');
    await expect(page.locator('.vv-quickopen')).toHaveCount(0);
    await expect(page.locator('.vv-shell.zen')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(page.locator('.vv-shell.zen')).toHaveCount(0);
    expect(await layoutOf(page)).toMatchObject({ zen: false });
  });

  test('LZ-15：.vv-status-picker 入册 OVERLAY_SELECTOR——zen 中开 picker，Esc 只关 picker 不退 zen', async ({
    page
  }) => {
    test.setTimeout(60_000);
    await waitApp(page);
    await dropFile(page, { name: 'picker-zen.txt', type: 'text/plain', content: 'picker zen body\n' });
    await expect(page.locator('.vv-code-pre')).toContainText('picker zen body', { timeout: 20_000 });

    // 进 zen（状态栏属内容区不隐）：开状态栏 picker
    await page.mouse.move(400, 300);
    await page.keyboard.press('Control+Alt+z');
    await expect(page.locator('.vv-shell.zen')).toHaveCount(1);
    await page.locator('.vv-status-openwith').click();
    const picker = page.locator('.vv-status-picker');
    await expect(picker).toBeVisible();

    // Esc：picker 关（ViewerPane 自有 window handler 同步动作），zen 不动——
    // capture 相快照按 OVERLAY_SELECTOR 判「面板在场」，缺册会连带退 zen（双动作）
    await page.keyboard.press('Escape');
    await expect(picker).toHaveCount(0);
    await expect(page.locator('.vv-shell.zen')).toHaveCount(1);

    // 无面板 Esc → 退 zen
    await page.keyboard.press('Escape');
    await expect(page.locator('.vv-shell.zen')).toHaveCount(0);
  });
});

// ---------------------------------------------------------------- 双 project

test.describe('渲染器双入口接力（chromium + mobile）', () => {
  test('LZ-14：状态栏 picker 置 override → Tab 子菜单「自动」清除，两壳 ✓/指示器同步', async ({
    page
  }) => {
    test.setTimeout(60_000);
    await waitApp(page);
    await dropFile(page, {
      name: 'relay.jsonl',
      type: 'application/jsonl',
      content: '{"n":1}\n{"n":2}\n'
    });
    await expect(page.locator('.vv-jsonl-card').first()).toBeVisible({ timeout: 20_000 });

    // 壳 A（状态栏指示器浮层）：置 override code——即时重渲染 + 指示器跟随
    const btn = page.locator('.vv-status-openwith');
    await expect(btn).toContainText('打开方式: JSON Lines');
    await btn.click();
    const picker = page.locator('.vv-status-picker');
    await expect(picker.getByRole('menuitem', { name: '✓ 自动（按扩展名）' })).toBeVisible();
    await picker.getByRole('menuitem', { name: '代码/文本' }).click();
    await expect(page.locator('.vv-code-pre')).toBeVisible({ timeout: 20_000 });
    await expect(btn).toContainText('打开方式: 代码/文本');

    // 壳 B（Tab 右键子菜单）：✓ 已跨壳同步（candidatesOf 同源）；「自动」清 override
    await page.locator('.vv-tab.active').click({ button: 'right' });
    await expect(page.locator('.vv-tabctx')).toBeVisible();
    await page.getByRole('menuitem', { name: '打开方式' }).click();
    const sub = page.locator('.vv-tabctx-sub');
    await expect(sub).toBeVisible();
    await expect(sub.getByRole('menuitem', { name: '✓ 代码/文本' })).toBeVisible();
    await sub.getByRole('menuitem', { name: '自动（按扩展名）' }).click();
    await expect(page.locator('.vv-tabctx')).toHaveCount(0);
    await expect(page.locator('.vv-jsonl-card').first()).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('.vv-code-pre')).toHaveCount(0);
    await expect(btn).toContainText('打开方式: JSON Lines');

    // 壳 A 复读：✓ 回到「自动」（清除在两壳一致）；Esc 收口
    await btn.click();
    await expect(picker.getByRole('menuitem', { name: '✓ 自动（按扩展名）' })).toBeVisible();
    await expect(picker.getByRole('menuitem', { name: '代码/文本' })).toBeVisible();
    await expect(picker.getByRole('menuitem', { name: '代码/文本' })).not.toHaveAttribute(
      'aria-current',
      'true'
    );
    await page.keyboard.press('Escape');
    await expect(picker).toHaveCount(0);
  });
});

// ---------------------------------------------------------------- 移动（mobile project）

test.describe('zen 移动端补强（mobile project）', () => {
  test.beforeEach(({}, testInfo) => {
    testInfo.skip(testInfo.project.name !== 'mobile', '移动视口专属（仅 mobile project）');
  });

  test('mLZ-06：zen 链加深——reload 后 面板→返回 关面板 → 返回 退 zen，toggles 回归可用', async ({
    page
  }) => {
    await page.goto('/');
    await expect(page.locator('.vv-topbar')).toBeVisible();

    // 抽屉头部进 zen（进入前抽屉开——还原基准的默认关由 reload 段自然重置）
    await page.locator('.vv-drawer-toggle').click();
    await expect.poll(
      async () => (await page.locator('.vv-side').boundingBox())?.x ?? -1,
      { timeout: 3_000 }
    ).toEqual(0);
    await page.locator('.vv-drawer-zen').click();
    await expect(page.locator('.vv-shell.zen')).toHaveCount(1);
    await expect(page.locator('.vv-drawer-toggle')).toBeHidden();
    expect(await page.evaluate(() => (history.state as { vvZen?: number } | null)?.vvZen)).toBe(1);

    // zen 中 reload：浮钮在场 + 守卫项经 history.state 存活
    await page.reload();
    await expect(page.locator('.vv-shell.zen')).toHaveCount(1);
    await expect(page.locator('.vv-zen-exit')).toBeVisible();
    expect(await page.evaluate(() => (history.state as { vvZen?: number } | null)?.vvZen)).toBe(1);

    // reload 后再开面板 → 返回键先关面板（守卫重压）→ 再返回退 zen
    await page.keyboard.press('Control+,');
    await expect(page.locator('.vv-settings-center')).toBeVisible();
    await page.goBack();
    await expect(page.locator('.vv-settings-center')).toHaveCount(0);
    await expect(page.locator('.vv-shell.zen')).toHaveCount(1);
    expect(await page.evaluate(() => (history.state as { vvZen?: number } | null)?.vvZen)).toBe(1);
    await page.goBack();
    await expect(page.locator('.vv-shell.zen')).toHaveCount(0);

    // toggles 回归 + 抽屉复用（退出后移动端导航面完好，非困死态）
    await expect(page.locator('.vv-drawer-toggle')).toBeVisible();
    await expect(page.locator('.vv-right-toggle')).toBeVisible();
    await page.locator('.vv-drawer-toggle').click();
    await expect.poll(
      async () => (await page.locator('.vv-side').boundingBox())?.x ?? -1,
      { timeout: 3_000 }
    ).toEqual(0);
  });
});
