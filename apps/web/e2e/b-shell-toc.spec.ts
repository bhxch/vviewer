import { test, expect, type Page } from '@playwright/test';
import { isDrawerViewport, openDrawerIfNarrow } from './drawer';
import { injectDir, openTreeFile, type TextFileSpec } from './b-markdown-html-docs-helpers';

/**
 * 壳层目录批 TOC 域锚（spec A §6 ①~④ + 移动通道，计划 Task 5）：
 * - TOC-01 左栏树|目录 tab（桌面）：切换器可见可切、FileTree hidden 保留实例、
 *   aria-pressed 翻转、树钮还原
 * - TOC-02 code 大纲优先互斥 + 左右同源同显（.py 载体 PY_OUTLINE 页内构造，
 *   b-code-outline.spec.ts:56 先例；outlineDefinitions 在场不落 md TOC）
 * - TOC-03 无目录数据左栏保持纯树（.txt，切换器 count 0）
 * - TOC-04 zen 右浮钮：data-zen-side 放行、栏内仅目录（切换器/折叠钮隐，spec §8
 *   落定 3）、Esc 两段退出（closeZenSide 新档 → exitZen）
 * - TOC-05 zen 左浮钮同构 + 显隐门空态面（.txt 下双浮钮 count 0，spec §8 落定 2）
 * - TOC-06 折叠钮几何固定（SRC-03 式）：滚动左右滚动体后包围盒逐值不变（spec §6 ③）
 * - TOC-07 切换器与折叠钮包围盒手写相交判定不相交（左右两栏，b-sidebar-roots
 *   SRC-03 :106-112 同款判定式，spec §6 ④）
 * - mTOC-01 ≤900px 抽屉形态：抽屉头下方切换器可见可切（spec §4.1 抽屉形态可用）
 * - mTOC-02 zen 左浮钮抽屉通道：goBack 先关侧（closeZenSide 含关抽屉、zenGuard
 *   重压 history.state.vvZen===1）再退 zen（mLZ-02 分派先例同构）
 * - mTOC-03 ≤600px 右浮钮右抽屉通道同构（移动无 Esc——返回键承接，goBack 两段）
 *
 * 断言口径注：栏内切换器/折叠钮的 zen 隐藏与 FileTree 的视图隐藏均为元素在 DOM
 * （display:none）——一律 toBeHidden 表达「隐藏」而非 toHaveCount(0)（元素保留
 * 是 hidden 保留实例/登记在册形态的本体，计划文中「count 0」按隐藏语义落）
 *
 * 装置复用：injectDir + openTreeFile（b-markdown-html-docs-helpers，__vvOpenDirImpl
 * 本地管线，md/py MIME 按扩展名落）；openLocalDir + waitAppMounted（b-sidebar-roots
 * 先例，.txt 用）；zen 进出桌面 Ctrl+Alt+Z（AppShell 既有快捷键）/移动 ☰ 抽屉头部
 * （mLZ-01 enterZenViaDrawer 同款）；goBack 断言 history.state.vvZen（mLZ-02 先例）。
 */

/** 本地源注入（b-sidebar-roots.spec.ts:37 同款通道，label 决定 storeId） */
async function waitAppMounted(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(
    () => typeof (window as unknown as { __vvOpenDirImpl?: unknown }).__vvOpenDirImpl === 'function'
  );
  await expect(page.locator('.vv-tabbar')).toBeVisible();
}

async function openLocalDir(
  page: Page,
  files: Array<{ name: string; content: string }>,
  label: string
): Promise<void> {
  await page.evaluate(({ list, label }) => {
    const fs = list.map(({ name, content }) => {
      const f = new File([content], name, { type: 'text/plain' });
      Object.defineProperty(f, 'webkitRelativePath', { value: `${label}/${name}` });
      return f;
    });
    return (window as unknown as { __vvOpenDirImpl: (f: File[]) => void }).__vvOpenDirImpl(fs);
  }, { list: files, label });
}

/** SRC-03（b-sidebar-roots.spec.ts:106-112）同款手写相交判定：至少一轴分离即
 * 不相交（贴边不计交叠） */
function separated(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number }
): boolean {
  return (
    a.x + a.width <= b.x ||
    b.x + b.width <= a.x ||
    a.y + a.height <= b.y ||
    b.y + b.height <= a.y
  );
}

/** md TOC 载体（3 个 h2 → 目录视图 3 项） */
const DEMO_MD = [
  '# 演示文档',
  '',
  '## 第一节',
  '',
  '内容一。',
  '',
  '## 第二节',
  '',
  '内容二。',
  '',
  '## 第三节',
  '',
  '内容三。',
  ''
].join('\n');

/** TOC-06 长目录载体：40 个 h2 → 目录视图 40 项（.toc 内滚溢出可滚动） */
const LONG_TOC_MD =
  Array.from({ length: 40 }, (_, i) => `## 章节 ${i + 1}\n\n第 ${i + 1} 章的正文内容。\n`).join('\n');

/** TOC-02 载体（b-code-outline.spec.ts:56 PY_OUTLINE 同源）：class + 同级 def +
 * 顶层 def + 引用调用——引用过滤后 5 条定义 */
const PY_OUTLINE = [
  'class Calculator:',
  '    def add(self, a, b):',
  '        return a + b',
  '',
  '    def run(self):',
  '        return self.add(1, 2)',
  '',
  '',
  'def top_level():',
  '    return Calculator()',
  '',
  '',
  'def helper():',
  '    pass',
  ''
].join('\n');

/** md 打开 + 右栏默认目录视图落位就绪（tocEntries 上行链路全通） */
async function openMdTocReady(page: Page, name = 'demo.md'): Promise<void> {
  await injectDir(page, [{ name, content: name === 'long.md' ? LONG_TOC_MD : DEMO_MD }]);
  await openTreeFile(page, name);
  await expect(page.locator('.vv-markdown')).toBeVisible({ timeout: 20_000 });
}

/** 左右抽屉滑入口径（drawer.ts isDrawerOpen/ensureRightDrawer 同款判定）：
 * position fixed + transform none（无样式窗误判防护同源） */
function drawerOpenState(page: Page, selector: string): Promise<boolean> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el === null) return false;
    const cs = getComputedStyle(el);
    return cs.position === 'fixed' && cs.transform === 'none';
  }, selector);
}

// ---------------------------------------------------------------- 桌面（chromium）

test.describe('左栏目录 tab（TOC-01..03，桌面）', () => {
  test.beforeEach(({}, testInfo) => {
    testInfo.skip(testInfo.project.name !== 'chromium', '桌面视口专属（仅 chromium project）');
  });

  test('TOC-01：树|目录切换——切换器可见可切、FileTree hidden 保留实例、aria-pressed 翻转还原', async ({
    page
  }) => {
    await openMdTocReady(page);
    // 左栏切换器在场（显隐门=目录数据非空，与右栏目录钮同源）
    const sw = page.locator('.vv-left-switch');
    await expect(sw).toBeVisible({ timeout: 10_000 });
    const treeBtn = page.locator('.vv-left-switch-btn', { hasText: '树' });
    const tocBtn = page.locator('.vv-left-switch-btn', { hasText: '目录' });
    await expect(treeBtn).toHaveAttribute('aria-pressed', 'true');
    await expect(tocBtn).toHaveAttribute('aria-pressed', 'false');

    // 切目录：TocView 共享件入左栏，FileTree hidden 但实例保留（保展开态）
    await tocBtn.click();
    await expect(page.locator('.vv-side .toc')).toBeVisible();
    const tree = page.locator('.vv-side .vv-tree');
    await expect(tree).toBeHidden();
    await expect(tree).toHaveCount(1);
    await expect(treeBtn).toHaveAttribute('aria-pressed', 'false');
    await expect(tocBtn).toHaveAttribute('aria-pressed', 'true');

    // 树钮还原：目录视图卸载、文件树回显
    await treeBtn.click();
    await expect(page.locator('.vv-side .toc')).toHaveCount(0);
    await expect(tree).toBeVisible();
  });

  test('TOC-02：code 大纲优先互斥 + 左右同源同显（PY_OUTLINE 载体）', async ({ page }) => {
    test.setTimeout(60_000);
    await injectDir(page, [{ name: 'calc.py', content: PY_OUTLINE }]);
    await openTreeFile(page, 'calc.py');
    await expect(page.locator('.vv-code-pre')).toBeVisible({ timeout: 30_000 });
    // 大纲到货（右栏切换器出现 = onoutline 上行链路全通，b-code-outline 同款门）
    await expect(page.locator('.vv-right-switch')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.vv-right .vv-outline')).toBeVisible();

    // 左栏切目录：outline 优先互斥（outlineDefinitions 在场渲染大纲，PY 无 md TOC）
    await expect(page.locator('.vv-left-switch')).toBeVisible();
    await page.locator('.vv-left-switch-btn', { hasText: '目录' }).click();
    await expect(page.locator('.vv-side .vv-outline')).toBeVisible();
    await expect(page.locator('.vv-side .vv-outline li')).toHaveCount(5);
    // 右栏同源同显（同 outlineDisplayed 单值下行，引用过滤后 5 条定义）
    await expect(page.locator('.vv-right .vv-outline')).toBeVisible();
    await expect(page.locator('.vv-right .vv-outline li')).toHaveCount(5);
  });

  test('TOC-03：无目录数据左栏保持纯树——切换器 count 0', async ({ page }) => {
    await waitAppMounted(page);
    await openLocalDir(page, [{ name: 'plain.txt', content: 'plain text body\n' }], 'src-plain');
    await openTreeFile(page, 'plain.txt'); // 文件在场打开（tab 激活）而目录数据仍空
    await expect(page.locator('.vv-left-switch')).toHaveCount(0);
    await expect(page.locator('.vv-side .vv-tree')).toBeVisible();
  });
});

test.describe('zen 目录入口（TOC-04/05，桌面）', () => {
  test.beforeEach(({}, testInfo) => {
    testInfo.skip(testInfo.project.name !== 'chromium', '桌面视口专属（仅 chromium project）');
  });

  test('TOC-04：右浮钮开右栏目录——栏内仅目录（切换器/折叠钮隐）+ Esc 两段退出', async ({
    page
  }) => {
    await openMdTocReady(page);
    await page.keyboard.press('Control+Alt+Z');
    await expect(page.locator('.vv-shell.zen')).toHaveCount(1);

    // 显隐门有数据面：双浮钮在场（md 有目录数据），右钮开侧
    const rightBtn = page.locator('.vv-zen-toc-right');
    await expect(rightBtn).toBeVisible();
    await expect(rightBtn).toHaveAttribute('aria-pressed', 'false');
    await rightBtn.click();

    // data-zen-side 放行：右栏可见且栏内仅目录——切换器/折叠钮隐藏（元素在 DOM）
    await expect(page.locator('.vv-shell.zen[data-zen-side="right"]')).toHaveCount(1);
    await expect(page.locator('.vv-right')).toBeVisible();
    await expect(page.locator('.vv-right-switch')).toBeHidden();
    await expect(page.locator('.vv-collapse-btn.vv-collapse-right')).toBeHidden();
    await expect(page.locator('.vv-right .toc')).toBeVisible();
    await expect(rightBtn).toHaveAttribute('aria-pressed', 'true');

    // 浮钮不压住所开栏（评审 important ⑪：浮钮原锚视口缘 → 压在目录条目上）
    const rightBox = await page.locator('.vv-right').boundingBox();
    const btnBox = await rightBtn.boundingBox();
    expect(rightBox).not.toBeNull();
    expect(btnBox).not.toBeNull();
    // 右浮钮在右栏**左侧**（内容区一侧）→ 其右缘不得越入右栏
    expect(btnBox!.x + btnBox!.width, '右浮钮压住右栏').toBeLessThanOrEqual(rightBox!.x);

    // Esc 两段退出：第一段 closeZenSide（栏隐、zen 保持），第二段 exitZen
    await page.keyboard.press('Escape');
    await expect(page.locator('.vv-shell.zen[data-zen-side="right"]')).toHaveCount(0);
    await expect(page.locator('.vv-right')).toBeHidden();
    await expect(page.locator('.vv-shell.zen')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(page.locator('.vv-shell.zen')).toHaveCount(0);
  });

  test('TOC-05：左浮钮开左栏目录——同构（切换器/树隐、目录在场）+ Esc 两段', async ({
    page
  }) => {
    await openMdTocReady(page);
    await page.keyboard.press('Control+Alt+Z');
    await expect(page.locator('.vv-shell.zen')).toHaveCount(1);

    const leftBtn = page.locator('.vv-zen-toc-left');
    await expect(leftBtn).toBeVisible();
    await leftBtn.click();
    await expect(page.locator('.vv-shell.zen[data-zen-side="left"]')).toHaveCount(1);
    await expect(page.locator('.vv-side')).toBeVisible();
    await expect(page.locator('.vv-left-switch')).toBeHidden();
    const tree = page.locator('.vv-side .vv-tree');
    await expect(tree).toBeHidden();
    await expect(tree).toHaveCount(1);
    await expect(page.locator('.vv-side .toc')).toBeVisible();

    // 浮钮不压住所开栏（评审 important ⑪：浮钮原锚视口缘 → 压在目录条目上）
    const sideBox = await page.locator('.vv-side').boundingBox();
    const btnBox = await leftBtn.boundingBox();
    expect(sideBox).not.toBeNull();
    expect(btnBox).not.toBeNull();
    // 左浮钮在左栏**右侧**（内容区一侧）→ 其左缘不得越入左栏
    expect(btnBox!.x, '左浮钮压住左栏').toBeGreaterThanOrEqual(sideBox!.x + sideBox!.width);

    await page.keyboard.press('Escape');
    await expect(page.locator('.vv-shell.zen[data-zen-side="left"]')).toHaveCount(0);
    await expect(page.locator('.vv-side')).toBeHidden();
    await expect(page.locator('.vv-shell.zen')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(page.locator('.vv-shell.zen')).toHaveCount(0);
  });

  test('TOC-05/2：zen 显隐门空态面——无目录数据双浮钮均不渲染（spec §8 落定 2）', async ({
    page
  }) => {
    await waitAppMounted(page);
    await openLocalDir(page, [{ name: 'plain.txt', content: 'plain text body\n' }], 'src-plain');
    await openTreeFile(page, 'plain.txt');
    await page.keyboard.press('Control+Alt+Z');
    await expect(page.locator('.vv-shell.zen')).toHaveCount(1);
    await expect(page.locator('.vv-zen-toc-left')).toHaveCount(0);
    await expect(page.locator('.vv-zen-toc-right')).toHaveCount(0);
    await page.keyboard.press('Escape'); // 退 zen 还原（无浮钮可关，直接退）
    await expect(page.locator('.vv-shell.zen')).toHaveCount(0);
  });
});

test.describe('折叠钮几何（TOC-06/07，桌面）', () => {
  test.beforeEach(({}, testInfo) => {
    testInfo.skip(testInfo.project.name !== 'chromium', '桌面视口专属（仅 chromium project）');
  });

  test('TOC-06：滚动左右滚动体后折叠钮包围盒逐值不变（spec §6 ③，SRC-03 式）', async ({
    page
  }) => {
    test.setTimeout(60_000);
    // 60 文件树（真溢出左滚动体）+ 40 项长目录 md（右栏目录视图内滚溢出）
    const files: TextFileSpec[] = Array.from({ length: 60 }, (_, i) => ({
      name: `f${String(i).padStart(2, '0')}.txt`,
      content: `file ${i} body\n`
    }));
    files.push({ name: 'long.md', content: LONG_TOC_MD });
    await injectDir(page, files);
    await openTreeFile(page, 'long.md');
    await expect(page.locator('.vv-markdown')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('.vv-right .toc button')).toHaveCount(40);

    const leftBox = await page.locator('.vv-collapse-btn.vv-collapse-left').boundingBox();
    const rightBox = await page.locator('.vv-collapse-btn.vv-collapse-right').boundingBox();
    expect(leftBox).not.toBeNull();
    expect(rightBox).not.toBeNull();

    // 左：滚动 .vv-side-scroll 至中部（60 文件树高于视口——真滚动）
    await page.locator('.vv-side-scroll').evaluate((el) => {
      el.scrollTop = el.scrollHeight / 2;
    });
    // 右：目录列表实际滚动容器为 .toc（flex:1 min-height:0 overflow:auto 内滚，
    // .vv-right-scroll 本体不溢出）——按计划滚 .vv-right-scroll（no-op 面）+
    // 内滚 .toc 承载「列表滚动而折叠钮不动」的断言意图
    await page.locator('.vv-right-scroll').evaluate((el) => {
      el.scrollTop = el.scrollHeight / 2;
    });
    await page.locator('.vv-right .toc').evaluate((el) => {
      el.scrollTop = el.scrollHeight / 2;
    });

    // 滚动**确已发生**（评审 minor：此前只断言折叠钮包围盒前后相等——若滚动体退化为
    // 不可滚（overflow 失效/内容变短），该锚仍绿（假绿面））。断言 scrollTop > 0。
    const leftScrollTop = await page.locator('.vv-side-scroll').evaluate((el) => el.scrollTop);
    const tocScrollTop = await page.locator('.vv-right .toc').evaluate((el) => el.scrollTop);
    expect(leftScrollTop, '左栏滚动体未滚动（overflow 失效或内容不足）').toBeGreaterThan(0);
    expect(tocScrollTop, '右栏目录未滚动（overflow 失效或内容不足）').toBeGreaterThan(0);

    const leftBox2 = await page.locator('.vv-collapse-btn.vv-collapse-left').boundingBox();
    const rightBox2 = await page.locator('.vv-collapse-btn.vv-collapse-right').boundingBox();
    // 包围盒逐值相等（x/y/width/height）
    expect(leftBox2!.x).toBe(leftBox!.x);
    expect(leftBox2!.y).toBe(leftBox!.y);
    expect(leftBox2!.width).toBe(leftBox!.width);
    expect(leftBox2!.height).toBe(leftBox!.height);
    expect(rightBox2!.x).toBe(rightBox!.x);
    expect(rightBox2!.y).toBe(rightBox!.y);
    expect(rightBox2!.width).toBe(rightBox!.width);
    expect(rightBox2!.height).toBe(rightBox!.height);
  });

  test('TOC-07：切换器与折叠钮包围盒不相交（左右两栏，SRC-03 同款判定式）', async ({
    page
  }) => {
    await openMdTocReady(page);
    // 左右切换器均在场（md 目录数据：左栏门与右栏目录钮同源）
    await expect(page.locator('.vv-left-switch')).toBeVisible({ timeout: 10_000 });
    const leftSwitch = await page.locator('.vv-left-switch').boundingBox();
    const leftCollapse = await page.locator('.vv-collapse-btn.vv-collapse-left').boundingBox();
    const rightSwitch = await page.locator('.vv-right-switch').boundingBox();
    const rightCollapse = await page.locator('.vv-collapse-btn.vv-collapse-right').boundingBox();
    expect(leftSwitch).not.toBeNull();
    expect(leftCollapse).not.toBeNull();
    expect(rightSwitch).not.toBeNull();
    expect(rightCollapse).not.toBeNull();
    expect(separated(leftSwitch!, leftCollapse!)).toBe(true);
    expect(separated(rightSwitch!, rightCollapse!)).toBe(true);
  });
});

// ---------------------------------------------------------------- 移动（mobile project）

test.describe('移动通道（mTOC-01..03，mobile project）', () => {
  test.beforeEach(({}, testInfo) => {
    testInfo.skip(testInfo.project.name !== 'mobile', '移动视口专属（仅 mobile project）');
  });

  test('mTOC-01：≤900px 抽屉形态——抽屉头下方切换器可见可切（spec §4.1 抽屉形态可用）', async ({
    page
  }) => {
    test.skip(await isDrawerViewport(page) === false, '本锚限定抽屉断点');
    await openMdTocReady(page);
    await openDrawerIfNarrow(page);
    const sw = page.locator('.vv-left-switch');
    await expect(sw).toBeVisible({ timeout: 10_000 });
    const treeBtn = page.locator('.vv-left-switch-btn', { hasText: '树' });
    const tocBtn = page.locator('.vv-left-switch-btn', { hasText: '目录' });
    await expect(treeBtn).toHaveAttribute('aria-pressed', 'true');
    await tocBtn.click();
    await expect(page.locator('.vv-side .toc')).toBeVisible();
    await expect(page.locator('.vv-side .vv-tree')).toBeHidden();
    await expect(tocBtn).toHaveAttribute('aria-pressed', 'true');
    await treeBtn.click();
    await expect(page.locator('.vv-side .toc')).toHaveCount(0);
    await expect(page.locator('.vv-side .vv-tree')).toBeVisible();
  });

  test('mTOC-02：zen 左浮钮抽屉通道——goBack 先关侧（zenGuard 重压 vvZen=1）再退 zen', async ({
    page
  }) => {
    await openMdTocReady(page);
    // ☰ 抽屉头部「专注模式」进 zen（mLZ-01 enterZenViaDrawer 同款装置）
    await openDrawerIfNarrow(page);
    await page.locator('.vv-drawer-zen').click();
    await expect(page.locator('.vv-shell.zen')).toHaveCount(1);
    expect(await page.evaluate(() => (history.state as { vvZen?: number } | null)?.vvZen)).toBe(1);

    // 左浮钮可见（显隐门有数据面）→ 点开：抽屉滑入（drawer 通道）+ 栏内仅目录
    const leftBtn = page.locator('.vv-zen-toc-left');
    await expect(leftBtn).toBeVisible();
    await leftBtn.click();
    await expect(page.locator('.vv-shell.zen[data-zen-side="left"]')).toHaveCount(1);
    await expect(page.locator('.vv-shell.drawer')).toHaveCount(1);
    await expect.poll(() => drawerOpenState(page, '.vv-side'), { timeout: 3_000 }).toBe(true);
    await expect(page.locator('.vv-side .toc')).toBeVisible();
    await expect(page.locator('.vv-side .vv-tree')).toBeHidden();
    await expect(page.locator('.vv-left-switch')).toBeHidden();

    // 第一次返回：closeZenSide（抽屉关、zen 保持、守卫重压——下次返回承接退 zen）
    await page.goBack();
    await expect(page.locator('.vv-shell.zen')).toHaveCount(1);
    await expect(page.locator('.vv-shell.drawer')).toHaveCount(0);
    await expect(page.locator('.vv-shell.zen[data-zen-side="left"]')).toHaveCount(0);
    expect(await page.evaluate(() => (history.state as { vvZen?: number } | null)?.vvZen)).toBe(1);

    // 第二次返回：退 zen（非离页）
    await page.goBack();
    await expect(page.locator('.vv-shell.zen')).toHaveCount(0);
    await expect(page.locator('.vv-tabbar')).toBeVisible();
  });

  test('mTOC-03：≤600px 右浮钮右抽屉通道——goBack 两段同构（移动无 Esc，返回键承接）', async ({
    page
  }) => {
    await openMdTocReady(page);
    await openDrawerIfNarrow(page);
    await page.locator('.vv-drawer-zen').click();
    await expect(page.locator('.vv-shell.zen')).toHaveCount(1);

    const rightBtn = page.locator('.vv-zen-toc-right');
    await expect(rightBtn).toBeVisible();
    await rightBtn.click();
    await expect(page.locator('.vv-shell.zen[data-zen-side="right"]')).toHaveCount(1);
    await expect(page.locator('.vv-shell.rightopen')).toHaveCount(1);
    await expect.poll(() => drawerOpenState(page, '.vv-right'), { timeout: 3_000 }).toBe(true);
    await expect(page.locator('.vv-right .toc')).toBeVisible();
    await expect(page.locator('.vv-right-switch')).toBeHidden();

    // 第一次返回：closeZenSide（右抽屉关、zen 保持、守卫重压）
    await page.goBack();
    await expect(page.locator('.vv-shell.zen')).toHaveCount(1);
    await expect(page.locator('.vv-shell.rightopen')).toHaveCount(0);
    await expect(page.locator('.vv-shell.zen[data-zen-side="right"]')).toHaveCount(0);
    expect(await page.evaluate(() => (history.state as { vvZen?: number } | null)?.vvZen)).toBe(1);

    // 第二次返回：退 zen
    await page.goBack();
    await expect(page.locator('.vv-shell.zen')).toHaveCount(0);
    await expect(page.locator('.vv-tabbar')).toBeVisible();
  });
});
