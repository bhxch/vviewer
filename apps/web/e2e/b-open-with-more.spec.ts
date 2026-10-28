import { test, expect, type Locator, type Page } from '@playwright/test';
import { closeDrawerIfOpened, openDrawerIfNarrow } from './drawer';

/**
 * 打开方式「更多渲染器」展开三入口 e2e（议题一，域文档条目 OWM-01~03）：
 * - OWM-01 MetaPanel 下拉（入口 B）：受限候选尾「更多渲染器…」哨兵（value=__more__）
 *   就地展开为「自动 + registry 全量 12 + 收起附加候选」（value=__less__），全量选择
 *   archive 落 override + （手动）徽标；
 * - OWM-02 状态栏浮层（壳 A）：指示器钮弹候选浮层，「更多渲染器…」就地展开，选
 *   JSON Lines 即时重渲染（jsonl 专有视图上位）+ 指示器跟随 + （手动）徽标；
 * - OWM-03 Tab 右键（壳 B）：「打开方式」子菜单内「更多渲染器」二级子菜单（registry
 *   全量）可选 PDF，run 必关 + 即时重渲染 + ✓ 回显 + （手动）徽标。
 *
 * 简报 Step 2 四处校准的实测事实（2026-10-28 核对源码）：
 * ① 状态栏指示器钮 = `.vv-status-openwith`（aria-label「打开方式」，非简报草稿的
 *   「渲染器」）；浮层项为 `.vv-status-picker[role=menu]` 内 role=menuitem 按钮
 *   （ViewerPane.svelte :527-536），简报 getByRole('button') 按 menuitem 校准。
 * ② registry 真实 label：jsonl = 「JSON Lines」（render-text/src/jsonl/index.ts:950）、
 *   pdf = 「PDF」（render-doc/src/pdf.ts:52）；全量 12 项 = 代码/文本、Markdown、
 *   HTML 预览、图片、音视频、PDF、Word 文档、Excel 表格、PowerPoint（文本提纲）、
 *   二进制、压缩包、JSON Lines（viewer.ts install 序，展开面 OWM-01 断言钉住）。
 * ③ TabContextMenu 项确为 role=menuitem；但父项（子菜单）经 onclick 展开无 hover
 *   路径（toggleSub，TA-09 先例），且父项可访问名带「 ›」尾缀——简报的 hover/exact
 *   按 click + 子串匹配校准。
 * ④ tab 定位复用 t-tab-actions 的 tabNamed 装置（.vv-tab-name 子元素锚定，右键菜单
 *   同款）；简报 getByRole('tab') 弃用（tab 根级 textContent 含关闭钮「×」）。
 *
 * 已知语义（Task 2 评审裁定，断言面据此校准）：override 指向受限候选外的渲染器时
 * MetaPanel select 回退显示「自动」（受限面无匹配项，回退自动 > 空白选中——Svelte
 * value effect 随 openWithUi 重写），（手动）徽标为生效标识——故 OWM-01 简报的
 * toHaveValue('archive') 校准为「错误卡片上位（重渲染产物）+ 回退自动 + 徽标」，
 * OWM-02/03 同理断言徽标 + 重渲染产物而非 select value。
 *
 * 通道：目录注入经 __vvOpenDirImpl（b-binary-hex-archive :48-67 同款）+ 树行点击开
 * 文件 tab（openDir 只建目录 store tab，文件 tab 须树行打开——t-tab-actions 同款）。
 * default 套件双 project 全跑，窄视口经 drawer.ts / openRightIfNarrow 适配。
 */

const REG_SPECIAL = /[.*+?^${}()|[\]\\]/g;

/** 等应用挂载（__vvOpenDirImpl 注入钩子 + TopBar 就绪；t-tab-actions 同款） */
async function waitAppMounted(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(
    () => typeof (window as unknown as { __vvOpenDirImpl?: unknown }).__vvOpenDirImpl === 'function'
  );
  await expect(page.locator('.vv-topbar')).toBeVisible();
}

/** 目录注入通道（__vvOpenDirImpl；label = webkitRelativePath 首段，只建目录 store tab） */
async function openDir(page: Page): Promise<void> {
  await page.waitForFunction(
    () => typeof (window as unknown as { __vvOpenDirImpl?: unknown }).__vvOpenDirImpl === 'function'
  );
  await page.evaluate(() => {
    const f = new File(['hello vviewer'], 'aa.txt', { type: 'text/plain' });
    Object.defineProperty(f, 'webkitRelativePath', { value: `owm/${f.name}` });
    return (window as unknown as { __vvOpenDirImpl: (f: File[]) => void }).__vvOpenDirImpl([f]);
  });
}

/** 精确名 tab 定位（t-tab-actions tabNamed 同款：.vv-tab-name 子元素锚定） */
function tabNamed(page: Page, name: string): Locator {
  return page
    .locator('.vv-tab')
    .filter({
      has: page.locator('.vv-tab-name', { hasText: new RegExp(`^${name.replace(REG_SPECIAL, '\\$&')}$`) })
    });
}

/** 树行点击打开文件 tab（≤900px 抽屉断点适配，t-tab-actions openFile 同款） */
async function openFile(page: Page, name: string): Promise<void> {
  const drawer = await openDrawerIfNarrow(page);
  await page.locator('.vv-tree-row', { hasText: name }).click();
  await closeDrawerIfOpened(page, drawer);
  await expect(tabNamed(page, name)).toBeVisible();
}

/** ≤600px 断点右栏（MetaPanel）收进抽屉（t-open-with openRightIfNarrow 同款） */
async function openRightIfNarrow(page: Page): Promise<boolean> {
  const narrow = await page.evaluate(() => window.innerWidth <= 600);
  if (!narrow) return false;
  await page.locator('.vv-right-toggle').click();
  return true;
}

test.describe('打开方式「更多渲染器」展开（OWM）', () => {
  test('OWM-01 MetaPanel：受限候选尾有「更多渲染器…」，激活后展开全量并可选 archive', async ({
    page
  }) => {
    test.setTimeout(60_000);
    await waitAppMounted(page);
    await openDir(page);
    await openFile(page, 'aa.txt');
    await expect(page.locator('.vv-code-pre')).toBeVisible({ timeout: 20_000 });

    await openRightIfNarrow(page);
    const sel = page.locator('.meta-openwith');
    await expect(sel).toBeVisible();
    // .txt 受限候选：自动/code/markdown/hex + 哨兵「更多渲染器…」（value=__more__）
    await expect(sel.locator('option')).toHaveCount(5);
    await expect(sel.locator('option[value="__more__"]')).toHaveCount(1);
    await expect(sel.locator('option[value="__more__"]')).toHaveText('更多渲染器…');
    await sel.selectOption('__more__');
    // 展开面 = 自动 头项 + registry 全量 12 + 「收起附加候选」（__less__）= 14 项
    await expect(sel.locator('option')).toHaveCount(14);
    await expect(sel.locator('option').first()).toHaveText('自动（按扩展名）');
    await expect(sel.locator('option[value="__less__"]')).toHaveText('收起附加候选');
    // 全量 12 项按 registry install 序钉住（viewer.ts 装配序，议题一「更多=任意」面）
    await expect(sel.locator('option')).toHaveText([
      '自动（按扩展名）',
      '代码/文本',
      'Markdown',
      'HTML 预览',
      '图片',
      '音视频',
      'PDF',
      'Word 文档',
      'Excel 表格',
      'PowerPoint（文本提纲）',
      '二进制',
      '压缩包',
      'JSON Lines',
      '收起附加候选'
    ]);
    // 全量面选择 archive：override 落盘即时重渲染（rev++ 复用渲染 effect 通道）——
    // txt 字节非压缩包 → archive 构造失败抛中文错误，dispatcher 错误卡兜底上位。
    // select 显示回「自动」为既有语义：override 指向受限候选外的渲染器时 openWithUi
    // current 落空、Svelte value effect 重写回 ''（Task 2 评审裁定「受限外回退自动」，
    // 简报的 toHaveValue('archive') 按此校准），（手动）徽标为生效标识
    await sel.selectOption('archive');
    await expect(page.locator('.vv-error-card')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('.vv-code-pre')).toHaveCount(0);
    await expect(sel).toHaveValue('');
    await expect(page.locator('.meta-openwith-manual')).toBeVisible();
  });

  test('OWM-02 状态栏浮层：「更多渲染器…」就地展开，选 JSON Lines 生效', async ({ page }) => {
    test.setTimeout(60_000);
    await waitAppMounted(page);
    await openDir(page);
    await openFile(page, 'aa.txt');
    await expect(page.locator('.vv-code-pre')).toBeVisible({ timeout: 20_000 });

    // 指示器钮（aria-label「打开方式」——校准①）弹候选浮层（壳 A 既有交互）
    const btn = page.locator('.vv-status-openwith');
    await btn.click();
    const picker = page.locator('.vv-status-picker');
    await expect(picker).toBeVisible();
    // 收起面：✓ 自动 头项 + 受限候选 + 「更多渲染器…」哨兵（项形态 role=menuitem）
    await expect(picker.getByRole('menuitem', { name: '✓ 自动（按扩展名）' })).toBeVisible();
    const more = picker.getByRole('menuitem', { name: '更多渲染器…' });
    await expect(more).toBeVisible();
    await more.click();
    // 就地展开（浮层不关）：自动 头项 + 全量 + 收起哨兵
    await expect(picker.getByRole('menuitem', { name: '自动（按扩展名）' })).toBeVisible();
    await expect(picker.getByRole('menuitem', { name: '收起附加候选' })).toBeVisible();
    const jsonl = picker.getByRole('menuitem', { name: 'JSON Lines' });
    await expect(jsonl).toBeVisible();
    await jsonl.click();
    // pickRenderer 收口（浮层关）+ setRendererOverride rev++ 即时重渲染：
    // jsonl 专有视图上位、指示器跟随 override 的 label
    await expect(picker).toHaveCount(0);
    await expect(btn).toContainText('JSON Lines');
    await expect(page.locator('.vv-jsonl')).toBeVisible({ timeout: 20_000 });
    // override 回显：（手动）徽标。MetaPanel 受限候选无 JSON Lines 项 → select 显示
    // 回「自动」为既有语义（Task 2 评审裁定），徽标为生效标识（校准④注）
    await openRightIfNarrow(page);
    await expect(page.locator('.meta-openwith-manual')).toBeVisible();
  });

  test('OWM-03 Tab 右键：打开方式 ▸ 更多渲染器 二级子菜单可选 PDF', async ({ page }) => {
    test.setTimeout(60_000);
    await waitAppMounted(page);
    await openDir(page);
    await openFile(page, 'aa.txt');
    await expect(page.locator('.vv-code-pre')).toBeVisible({ timeout: 20_000 });

    // 右键菜单（壳 B）：「打开方式」父项点击展开（无 hover 展开路径——校准③，
    // TA-09 先例）；子菜单内「更多渲染器」二级父项再展开 registry 全量
    await tabNamed(page, 'aa.txt').click({ button: 'right' });
    await expect(page.locator('.vv-tabctx')).toBeVisible();
    await page.getByRole('menuitem', { name: '打开方式' }).click();
    const sub = page.locator('.vv-tabctx-sub');
    await expect(sub).toBeVisible();
    const moreParent = page.getByRole('menuitem', { name: '更多渲染器' });
    await expect(moreParent).toBeVisible();
    await moreParent.click();
    const pdf = page.getByRole('menuitem', { name: 'PDF', exact: true });
    await expect(pdf).toBeVisible();
    await pdf.click();
    // run 语义（动作后必关）+ override pdf 即时重派 dispatch：txt 字节非 PDF →
    // 错误卡片上位（code 退场）
    await expect(page.locator('.vv-tabctx')).toHaveCount(0);
    await expect(page.locator('.vv-code-pre')).toHaveCount(0);
    await expect(page.locator('.vv-error-card')).toBeVisible({ timeout: 20_000 });

    // ✓ 随 override 回显于二级子菜单（TabBar 按 overrideRenderer 打标）；Esc 逐层收
    // 子菜单（一层一次，收尽再关主菜单——TabContextMenu onKey 语义，两层展开共三次）
    await tabNamed(page, 'aa.txt').click({ button: 'right' });
    await expect(page.locator('.vv-tabctx')).toBeVisible();
    await page.getByRole('menuitem', { name: '打开方式' }).click();
    await page.getByRole('menuitem', { name: '更多渲染器' }).click();
    await expect(page.getByRole('menuitem', { name: '✓ PDF' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.vv-tabctx-sub')).toHaveCount(1); // 二级收、一级留
    await expect(page.locator('.vv-tabctx')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.vv-tabctx-sub')).toHaveCount(0);
    await expect(page.locator('.vv-tabctx')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.vv-tabctx')).toHaveCount(0);

    // override 回显：（手动）徽标（受限候选无 PDF 项 → select 显示回「自动」为既有
    // 语义，OWM-02 注同源）；窄视口右栏在抽屉里，先断言菜单面后开抽屉
    await openRightIfNarrow(page);
    await expect(page.locator('.meta-openwith-manual')).toBeVisible();
  });
});
