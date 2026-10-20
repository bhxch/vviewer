import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { test, expect, type Page } from '@playwright/test';
import { assertPortFree, stopServer, waitHealthy } from './serverHarness';
import { WOFF2_B64 } from './font-fixture';
import {
  applySettings,
  closeSettings,
  gotoGroup,
  openSettings,
  SETTINGS_ROOT
} from './settings-center';

/**
 * b-settings-center 统一设置中心冒烟（settings center spec 2026-10-19，plan Task 5）：
 * - SC-01 骨架与双入口：⚙/Ctrl+, 开合、九组定稿序、切组、Esc 关闭
 * - SC-02 表单↔JSON 双视图：表单改动即时反映 JSON、非法 JSON 阻断（停留标错+
 *   文本不丢+应用拦截）、合法 JSON 应用落盘
 * - SC-03 应用订阅链三线生效：外观+字体+布局一次提交（订阅链 diff 注入语义）；
 *   chromium 另断布局宽度应用生效（移动视口左栏在抽屉内，宽度断言不适用）
 * - SC-04 导入合并/替换两路径 + 校验失败阻断（不部分应用）
 * - SC-05 脏态关闭确认（继续编辑/放弃并关闭/应用并关闭三选一）
 * - SC-06 存储管理分类清除：字体清除 UI 回退（实时回落+列表空态）；设置清除
 *   重载回落默认；挂载配置禁用态（Spec 5 前向兼容裁决的骨架核验）
 * - SC-07 关于分节：estimate mock 用量+刷新、persist 状态行、health 摘要注入
 * - SC-08 TopBar 精简回归：代码主题/计算策略两下拉迁出、⚙ 指向设置中心、
 *   亮暗快切保留（双写同字段）
 * - SC-09 恢复出厂（**本文件最后**；且跑在独立 origin——spawn release server :4183，
 *   chromium-only，无二进制跳过）：SW 注销+清缓存会破坏共享源后续用例，独立
 *   origin 是「顺序保证」的强化形态（plan 裁决预留），文件内仍置最后双保险。
 */

/** style#vv-font 注入文本（b-fonts 同手法：style 元素 innerText 恒空串）。 */
function fontCss(page: Page): Promise<string> {
  return page.evaluate(() => document.getElementById('vv-font')?.textContent ?? '');
}

/** 持久化设置（vviewer:settings 单键对象）。 */
function savedSettings(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(() => JSON.parse(localStorage.getItem('vviewer:settings') ?? '{}'));
}

/** 导入文件构造（spec §4 导出同形：schemaVersion+exportedAt+settings）。 */
function exportFileBuffer(settings: Record<string, unknown>): Buffer {
  return Buffer.from(
    JSON.stringify({ schemaVersion: 1, exportedAt: '2026-10-19T00:00:00.000Z', settings })
  );
}

test.describe('b-settings-center 统一设置中心', () => {
  test('SC-01 骨架与双入口：⚙/Ctrl+, 开合、九组定稿序、切组、Esc 关闭', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.vv-topbar')).toBeVisible();

    // 入口① ⚙：全屏页 + role=dialog 双通道
    await page.locator('button[aria-label="设置"]').click();
    const root = page.locator(SETTINGS_ROOT);
    await expect(root).toBeVisible();
    await expect(page.getByRole('dialog', { name: '设置' })).toBeVisible();

    // 九组定稿序（spec §2）+ 默认外观组激活
    const labels = await page.locator('.vv-sc-navitem').allTextContents();
    expect(labels).toEqual([
      '外观',
      '字体',
      '图表',
      '布局',
      '搜索与排除',
      '自动刷新',
      '计算',
      '存储与数据',
      '关于'
    ]);
    await expect(page.locator('.vv-sc-navitem.active')).toHaveText('外观');

    // 切组：字体节表单在位（节组件按注册表激活渲染）
    await gotoGroup(page, '字体');
    await expect(page.locator('input[aria-label="界面字号（px）"]')).toBeVisible();
    await expect(page.locator('.vv-sc-navitem.active')).toHaveText('字体');

    // Esc 关闭（非脏直关）
    await closeSettings(page);

    // 入口② Ctrl+,：开合（新页挂载即聚焦根元素，非输入焦点——inField 守卫不拦）
    await page.keyboard.press('Control+,');
    await expect(root).toBeVisible();
    await page.keyboard.press('Control+,');
    await expect(root).toHaveCount(0);
  });

  test('SC-02 表单↔JSON 双视图：表单反映 JSON、非法阻断不丢文本、合法应用', async ({ page }) => {
    await page.goto('/');
    await openSettings(page);
    const root = page.locator(SETTINGS_ROOT);
    const area = page.locator('textarea[aria-label="设置 JSON"]');
    const viewBtn = (label: string) => page.locator('.vv-sc-viewbtn', { hasText: label });

    // 表单改动（外观组代码主题=默认激活组）→ JSON 视图即时反映（共享同一草稿）
    await page.getByLabel('代码主题').selectOption('gruvbox');
    await viewBtn('JSON').click();
    await expect(area).toHaveValue(/"codeThemeLight": "gruvbox"/);

    // 非法 JSON：切回表单被拦（停留 JSON 标错），文本原样保留；「应用」同样拦截
    await area.fill('{"themeMode": ');
    await viewBtn('表单').click();
    await expect(page.locator('.vv-sc-jsonerrors')).toBeVisible();
    await expect(page.locator('.vv-sc-viewbtn.active')).toHaveText('JSON');
    await expect(area).toHaveValue('{"themeMode": ');
    await page.locator('.vv-sc-apply').click();
    await expect(page.locator('.vv-sc-jsonerrors')).toBeVisible();
    await expect(root).toBeVisible();

    // 修复为合法 JSON：应用成功（白名单规范化整体写回——缺项补默认），落盘生效
    await area.fill('{"themeMode": "dark"}');
    await page.locator('.vv-sc-apply').click();
    expect((await savedSettings(page)).themeMode).toBe('dark');
    await closeSettings(page); // 应用后非脏 → Esc 直关
  });

  test('SC-03 应用订阅链三线生效：外观+字体+布局一次提交', async ({ page }, testInfo) => {
    await page.goto('/');
    await openSettings(page);

    // 三组各改一笔（草稿不落盘）：外观暗色 / 字体代码字号 16 / 布局隐藏顶栏
    await page.getByLabel('亮暗模式').selectOption('dark');
    await gotoGroup(page, '字体');
    await page.locator('input[aria-label="代码字号（px）"]').fill('16');
    await page.locator('input[aria-label="代码字号（px）"]').press('Enter');
    await gotoGroup(page, '布局');
    await page.locator('input[aria-label="显示顶栏"]').uncheck();
    await expect(page.locator('.vv-sc-dirty')).toHaveText('未应用'); // 切组不丢草稿

    // 一次提交三线生效（统一 saveSettings 订阅链，diff 分发各注入器）
    await applySettings(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme-mode', 'dark');
    await expect.poll(() => fontCss(page)).toContain('--vv-code-font-size: 16px');
    await expect(page.locator('.vv-topbar')).toBeHidden(); // chrome-off = visibility:hidden
    const saved = (await savedSettings(page)) as {
      themeMode?: string;
      fonts?: { codeSize?: number };
      layout?: { topBarVisible?: boolean };
    };
    expect(saved.themeMode).toBe('dark');
    expect(saved.fonts?.codeSize).toBe(16);
    expect(saved.layout?.topBarVisible).toBe(false);

    // chromium 另断：宽度 number input 应用后生效（LZ-02 拖拽通道互补的表单半；
    // bbox 含 1px 边框故 400→401，精确值以持久化字段断言）
    if (testInfo.project.name === 'chromium') {
      await page.locator('input[aria-label="左栏宽度（px）"]').fill('400');
      await page.locator('input[aria-label="左栏宽度（px）"]').press('Enter');
      await applySettings(page);
      expect(
        ((await savedSettings(page)) as { layout?: { leftWidth?: number } }).layout?.leftWidth
      ).toBe(400);
      await expect
        .poll(async () => (await page.locator('.vv-side').boundingBox())?.width ?? -1)
        .toBeGreaterThan(399);
    }
  });

  test('SC-04 导入合并/替换两路径 + 校验失败阻断', async ({ page }) => {
    await page.goto('/');
    await openSettings(page);
    const importInput = page.locator('.vv-sc-navactions input[type="file"]');

    // 合并路径：仅携带两键（缺项保留现状）
    await importInput.setInputFiles({
      name: 'merge.json',
      mimeType: 'application/json',
      buffer: exportFileBuffer({ autoRefresh: false, fonts: { codeSize: 16 } })
    });
    await expect(page.getByRole('dialog', { name: '导入设置' })).toBeVisible();
    await expect(page.locator('.vv-sc-importkey', { hasText: 'autoRefresh' })).toBeVisible();
    await expect(page.locator('.vv-sc-importkey', { hasText: /^fonts$/ })).toBeVisible();
    await expect(page.locator('input[name="vv-import-mode"][value="merge"]')).toBeChecked();
    await page.getByRole('button', { name: '导入并应用' }).click();
    let saved = (await savedSettings(page)) as {
      autoRefresh?: boolean;
      themeMode?: string;
      fonts?: { codeSize?: number };
    };
    expect(saved.autoRefresh).toBe(false);
    expect(saved.fonts?.codeSize).toBe(16);
    expect(saved.themeMode).toBe('system'); // 缺项保留现状（默认值未被导入文件整体覆盖）

    // 替换路径：整体覆盖为导入值（现状不保留）
    await importInput.setInputFiles({
      name: 'replace.json',
      mimeType: 'application/json',
      buffer: exportFileBuffer({ themeMode: 'light' })
    });
    await expect(page.getByRole('dialog', { name: '导入设置' })).toBeVisible();
    await page.locator('input[name="vv-import-mode"][value="replace"]').check();
    await page.getByRole('button', { name: '导入并应用' }).click();
    saved = await savedSettings(page);
    expect(saved.themeMode).toBe('light');
    expect(saved.autoRefresh).toBe(true); // 替换后回落默认（合并写入的 false 不保留）
    expect((saved.fonts as { codeSize?: number })?.codeSize).toBe(13);

    // 校验失败阻断：类型违规报错弹层，不部分应用
    await importInput.setInputFiles({
      name: 'bad.json',
      mimeType: 'application/json',
      buffer: exportFileBuffer({ computePolicy: 'nope' })
    });
    const errDialog = page.getByRole('alertdialog', { name: '导入设置错误' });
    await expect(errDialog).toBeVisible();
    await expect(errDialog).toContainText('computePolicy');
    await errDialog.getByRole('button', { name: '关闭' }).click();
    expect((await savedSettings(page)).themeMode).toBe('light'); // 原值未动
    await closeSettings(page);
  });

  test('SC-05 脏态关闭确认：继续编辑/放弃并关闭/应用并关闭', async ({ page }) => {
    await page.goto('/');
    await openSettings(page);
    await gotoGroup(page, '字体');
    const uiSize = page.locator('input[aria-label="界面字号（px）"]');
    const fillDirty = async (): Promise<void> => {
      await uiSize.fill('20');
      await uiSize.press('Enter');
      await expect(page.locator('.vv-sc-dirty')).toHaveText('未应用');
    };

    // Esc → 确认条（内联 alertdialog，选择语义）；继续编辑留页
    await fillDirty();
    await page.keyboard.press('Escape');
    const confirm = page.getByRole('alertdialog', { name: '未应用的修改' });
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: '继续编辑' }).click();
    await expect(page.locator(SETTINGS_ROOT)).toBeVisible();

    // 放弃并关闭：草稿丢弃、落盘值不动（未应用过则键缺省——loadSettings 回落默认 16）
    await page.keyboard.press('Escape');
    await confirm.getByRole('button', { name: '放弃并关闭' }).click();
    await expect(page.locator(SETTINGS_ROOT)).toHaveCount(0);
    const discarded = (await savedSettings(page)) as { fonts?: { uiSize?: number } };
    expect(discarded.fonts?.uiSize ?? 16).toBe(16);

    // 应用并关闭：草稿落盘后关页
    await openSettings(page);
    await gotoGroup(page, '字体');
    await fillDirty();
    await page.keyboard.press('Escape');
    await confirm.getByRole('button', { name: '应用并关闭' }).click();
    await expect(page.locator(SETTINGS_ROOT)).toHaveCount(0);
    expect(((await savedSettings(page)) as { fonts?: { uiSize?: number } }).fonts?.uiSize).toBe(20);
    await expect.poll(() => fontCss(page)).toContain('--vv-ui-font-size: 20px');
  });

  test('SC-06 存储管理：字体分类清除 UI 回退 + 挂载配置禁用态', async ({ page }) => {
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

    // 存储与数据：挂载配置行禁用态（Spec 5 前向兼容裁决的骨架核验）
    await gotoGroup(page, '存储与数据');
    const mounts = page.locator('.vv-storage-cat', { hasText: '挂载配置' });
    await expect(mounts).toHaveClass(/vv-storage-cat-disabled/);
    await expect(mounts.getByRole('button', { name: '清除' })).toBeDisabled();

    // 网络字体分类清除：确认面板（列明后果）→ 即时生效（订阅链回退，无需再应用）
    const fontsCat = page.locator('.vv-storage-cat', { hasText: '网络字体' });
    await expect(fontsCat).toContainText('1 条');
    await fontsCat.getByRole('button', { name: '清除' }).click();
    const confirm = page.getByRole('alertdialog', { name: '删除网络字体确认' });
    await expect(confirm).toContainText('槽位回落默认字体栈');
    await confirm.getByRole('button', { name: '确认清除' }).click();
    await expect(page.locator('.vv-settings-note', { hasText: '已清除 1 项' })).toBeVisible();
    await expect.poll(() => fontCss(page)).not.toContain('"x"');

    // 字体组 UI 回退：管理列表回落空态（字体节重挂载重读 IndexedDB）
    await gotoGroup(page, '字体');
    await expect(page.locator('.vv-settings-empty', { hasText: '暂无网络字体' })).toBeVisible();

    // purge 不回写打开中的草稿（Task 3+4 报告 §3.5 披露）：设置页脏态基准（applied
    // 状态）不感知外部 purge 的 saveSettings——不显式「应用」即无复活路径。收尾断言
    // 槽位回落已持久（''），Esc 直关（无脏态确认条）
    await closeSettings(page);
    expect(
      ((await savedSettings(page)) as { fonts?: { codeFamily?: string } }).fonts?.codeFamily
    ).toBe('');
  });

  test('SC-06/2 存储管理：设置分类清除重载回落默认', async ({ page }) => {
    await page.goto('/');
    await openSettings(page);
    await gotoGroup(page, '字体');
    await page.locator('input[aria-label="代码字号（px）"]').fill('16');
    await page.locator('input[aria-label="代码字号（px）"]').press('Enter');
    await applySettings(page);
    await expect.poll(() => fontCss(page)).toContain('--vv-code-font-size: 16px');

    await gotoGroup(page, '存储与数据');
    await page
      .locator('.vv-storage-cat', { hasText: /^设置/ })
      .getByRole('button', { name: '清除' })
      .click();
    const confirm = page.getByRole('alertdialog', { name: '清除设置确认' });
    await expect(confirm).toContainText('全部回落默认值');
    await confirm.getByRole('button', { name: '确认清除' }).click();

    // 重载回落 DEFAULTS：键被删、注入回默认字号（13px）
    await expect(page.locator(SETTINGS_ROOT)).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => localStorage.getItem('vviewer:settings'))).toBeNull();
    await expect.poll(() => fontCss(page)).toContain('--vv-code-font-size: 13px');
  });

  test('SC-07 关于分节：estimate mock 用量+刷新、persist 状态行、health 摘要', async ({ page }) => {
    // estimate/persist mock（Task 3+4 报告移交形态）：usage 随调用次数递增供「刷新」可判定；
    // health 摘要经 sessionStorage 会话缓存注入（connectServer 写入侧由服务端套件覆盖）
    await page.addInitScript(() => {
      let calls = 0;
      Object.defineProperty(navigator, 'storage', {
        configurable: true,
        value: {
          estimate: async () => {
            calls += 1;
            return {
              usage: 1_234_567 + calls * 100_000,
              quota: 67_890_123,
              usageDetails: { indexedDB: 1000, caches: 2000 }
            };
          },
          persisted: async () => true,
          persist: async () => true
        }
      });
      sessionStorage.setItem(
        'vv:server-health',
        JSON.stringify({
          version: '0.9.9-e2e',
          capabilities: ['file-server', 'compute'],
          searchEngine: 'rg',
          roots: 2
        })
      );
    });
    await page.goto('/');
    await openSettings(page);
    await gotoGroup(page, '关于');

    // health 摘要（会话缓存读取）：版本/能力/搜索引擎/数据根并列
    await expect(page.locator('.vv-about-row', { hasText: '服务端版本' })).toContainText('0.9.9-e2e');
    await expect(page.locator('.vv-about-row', { hasText: '能力' })).toContainText('file-server');
    await expect(page.locator('.vv-about-row', { hasText: '搜索引擎' })).toContainText('rg');
    await expect(page.locator('.vv-about-row', { hasText: '数据根' })).toContainText('2 个');

    // estimate 聚合 + usageDetails 细分（formatBytes：1_334_567→1.3 MB / 67_890_123→64.7 MB）
    const usageRow = page.locator('.vv-about-row', { hasText: '已用 / 配额' });
    await expect(usageRow).toContainText('1.3 MB / 64.7 MB');
    // usageDetails 细分行（.vv-about-detail 限定——'IndexedDB · kv' 等汇总行同屏）
    await expect(
      page.locator('.vv-about-row.vv-about-detail', { hasText: /^indexedDB/ })
    ).toContainText('1000 B');
    await expect(
      page.locator('.vv-about-row.vv-about-detail', { hasText: /^caches/ })
    ).toContainText('2.0 KB');

    // 持久化状态行（mock persisted=true）+ 刷新钮重算（usage 递增 → 数值变化）
    await expect(page.locator('.vv-about-row', { hasText: '状态' })).toContainText('已持久化');
    const before = await usageRow.textContent();
    await page.getByRole('button', { name: '刷新', exact: true }).click();
    await expect(usageRow).not.toHaveText(before ?? '');
    await expect(usageRow).toContainText('1.4 MB');
  });

  test('SC-08 TopBar 精简回归：两下拉迁出、⚙ 指向设置中心、亮暗快切保留', async ({ page }) => {
    await page.goto('/');
    const topbar = page.locator('.vv-topbar');
    await expect(topbar).toBeVisible();

    // 代码主题/计算策略下拉迁出设置中心（设置中心 Task 1）
    await expect(topbar.locator('select[aria-label="代码主题"]')).toHaveCount(0);
    await expect(topbar.locator('select[aria-label="计算策略"]')).toHaveCount(0);

    // ⚙ 指向设置中心
    await topbar.locator('button[aria-label="设置"]').click();
    await expect(page.locator(SETTINGS_ROOT)).toBeVisible();
    await closeSettings(page);

    // 亮暗快切保留（cycleTheme 与设置中心亮暗模式控件双写同字段）
    const themeBtn = page.getByRole('button', { name: /主题：/ });
    await expect(themeBtn).toHaveText('主题：跟随系统');
    await themeBtn.click();
    await expect(page.locator('html')).toHaveAttribute('data-theme-mode', 'light');
    await expect.poll(() => savedSettings(page)).toEqual(expect.objectContaining({ themeMode: 'light' }));
  });

  // 恢复出厂（spec §2.2 最高危动作）：**本文件最后** + 独立 origin（spawn release
  // server :4183）——SW 注销与清缓存只作用于该源，不波及 4173 共享源的并行用例
  //（计划裁决预留「放最后或独立 project 顺序保证」的强化形态：origin 隔离彻底，
  // 文件内置底仍保留）。无 release 二进制时跳过（t-hl HL-04/2 前例）。
  test('SC-09 恢复出厂：全分类+缓存清空+SW 注销+重载回落全新会话', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', '自起独立 origin 实例仅桌面基准（HL-04/2 前例）');
    const specDir = dirname(fileURLToPath(import.meta.url));
    const BIN = resolve(specDir, '../../../server/target/release/vviewer');
    test.skip(!existsSync(BIN), 'release server 未构建（cargo build --release 后可用）');
    test.setTimeout(120_000);

    const root = mkdtempSync(join(tmpdir(), 'sc-factory-'));
    writeFileSync(join(root, 'note.md'), '# factory\n');
    const BASE = 'http://127.0.0.1:4183'; // 避开 4173（主套件）/4174（e2e-server）/4178-4182（t-hl/t-md）
    await assertPortFree(BASE);
    const server = spawn(
      BIN,
      ['serve', '--root', root, '--web-dist', resolve(specDir, '../build'), '--port', '4183'],
      { stdio: 'ignore' }
    );
    try {
      await waitHealthy(BASE);
      await page.goto(`${BASE}/`);
      await expect(page.locator('.vv-topbar')).toBeVisible();

      // 预置三面脏数据：SW 激活 + 设置落盘 + 伪造运行时缓存
      await expect
        .poll(
          async () =>
            page.evaluate(async () => {
              const regs = await navigator.serviceWorker.getRegistrations();
              return regs.some((r) => r.active?.state === 'activated');
            }),
          { timeout: 30_000 }
        )
        .toBe(true);
      await page.evaluate(() => void caches.open('vv-sc-probe').then((c) => c.put('/probe', new Response('x'))));
      await openSettings(page);
      await gotoGroup(page, '字体');
      await page.locator('input[aria-label="代码字号（px）"]').fill('16');
      await page.locator('input[aria-label="代码字号（px）"]').press('Enter');
      await applySettings(page);
      await expect(page.locator(SETTINGS_ROOT)).toBeVisible(); // 应用后留页继续操作
      await gotoGroup(page, '存储与数据');

      // 恢复出厂：确认面板措辞最强（不可恢复）→ 执行 → 重载全新会话
      await page.getByRole('button', { name: '恢复出厂…' }).click();
      const confirm = page.getByRole('alertdialog', { name: '恢复出厂确认' });
      await expect(confirm).toContainText('此操作不可恢复');
      await confirm.getByRole('button', { name: '确认恢复出厂（不可恢复）' }).click();

      await expect(page.locator(SETTINGS_ROOT)).toHaveCount(0); // 重载已发生
      await expect
        .poll(() => page.evaluate(() => localStorage.getItem('vviewer:settings')))
        .toBeNull(); // 设置回落默认
      await expect.poll(() => fontCss(page)).toContain('--vv-code-font-size: 13px');
      // 伪造缓存被清（重载新页面不会重建该名）；SW 注册面已在 storageHealth 单测
      // 锁全序列——重载后 PWA 自动重注册属预期行为，此处不断言注册数（竞态面）
      await expect
        .poll(async () => page.evaluate(async () => (await caches.keys()).includes('vv-sc-probe')))
        .toBe(false);
    } finally {
      await stopServer(server, 'sc-factory');
      rmSync(root, { recursive: true, force: true });
    }
  });
});
