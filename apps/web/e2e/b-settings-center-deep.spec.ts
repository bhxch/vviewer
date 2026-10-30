import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { injectDir, openTreeFile } from './b-markdown-html-docs-helpers';
import {
  SETTINGS_ROOT,
  applySettings,
  closeSettings,
  gotoGroup,
  openSettings
} from './settings-center';

/**
 * b-settings-center-deep 设置中心补强（SC-10~SC-19，续 b-settings-center
 * SC-01~09；本轮补强验证：边界/负路径/组合交互/性能锚）。与既有覆盖分工（不重复）：
 * - SC-10 图表组 UI 表单管线：18 语言模式网格+kroki host 应用落盘+非法 host
 *   读回归位+source 模式文档级生效（b-md-diagrams 走 localStorage 直写通道，
 *   此处走设置中心 UI 全用户管线——面板管线此前无 e2e）；
 * - SC-11 导入合并字段级语义细断言（I-1 修复 18ad55a 的行为锚：节内单字段
 *   覆盖、其余字段保留、modes 增量合并；SC-04 仅骨架两键）；
 * - SC-12 外部直写落盘不被应用覆盖（I-2 mergeDraftOnto 的手工外部变更通道：
 *   外部新增变更保留+草稿变更写入三方共存；SC-06 走存储管理 purge 通道防复活）；
 * - SC-13 JSON 校验三分类：未知字段/类型不符/clamp 截断三条各自可见+修复后
 *   四舍五入落值（SC-02 仅语法错误形态）；
 * - SC-14 schemaVersion 2 高版本导入警告面（尽力合并不阻断）+settings 缺失
 *   错误弹层（SC-04 仅类型违规阻断）；
 * - SC-15/16 存储七分类矩阵补全：会话快照/目录授权句柄（kv 键精确圈定+句柄
 *   保留语义）、导入主题清除引用实时回落 default+运行时缓存清普通保 precache
 *   区分断言（SC-06 仅字体+设置两分类实测）；
 * - SC-17 导出往返：a[download] 文件名/文件形状（schemaVersion+exportedAt+
 *   settings 全形）+导入以文件为准重建未应用草稿；
 * - SC-18 脏态负路径：Esc 连按不绕过确认、切组不弹确认、头部 ✕ 同确认通道
 *   （SC-05 仅三选正路径）；
 * - SC-19 性能锚（宽松上界冒烟）：大 draft 打开/九组逐组切换/JSON 视图大文本
 *   序列化与回切时限。
 */

/** 持久化设置（vviewer:settings 单键对象；b-settings-center 同款） */
function savedSettings(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(() => JSON.parse(localStorage.getItem('vviewer:settings') ?? '{}'));
}

/** 导入文件构造（spec §4 导出同形；schemaVersion 可调供高版本警告面用例） */
function exportFile(settings: Record<string, unknown>, schemaVersion = 1): Buffer {
  return Buffer.from(
    JSON.stringify({ schemaVersion, exportedAt: '2026-10-22T00:00:00.000Z', settings })
  );
}

/** kv store 现存键清单（分类删除精确圈定的读取面；种子同通道直构） */
function kvKeys(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open('vviewer', 4);
      open.onupgradeneeded = () => {
        const d = open.result;
        for (const s of ['kv', 'themes', 'fonts', 'mounts']) {
          if (!d.objectStoreNames.contains(s)) d.createObjectStore(s);
        }
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    try {
      return await new Promise<string[]>((resolve, reject) => {
        const rq = db.transaction('kv', 'readonly').objectStore('kv').getAllKeys();
        rq.onsuccess = () => resolve(rq.result as string[]);
        rq.onerror = () => reject(rq.error);
      });
    } finally {
      db.close();
    }
  });
}

/** kv 直构种子（页面加载后 evaluate 写入；b-wsx-recovery 同通道，自带补建防早挂载竞态） */
async function seedKv(page: Page, entries: Record<string, unknown>): Promise<void> {
  await page.evaluate(async (es) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open('vviewer', 4);
      open.onupgradeneeded = () => {
        const d = open.result;
        for (const s of ['kv', 'themes', 'fonts', 'mounts']) {
          if (!d.objectStoreNames.contains(s)) d.createObjectStore(s);
        }
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('kv', 'readwrite');
        for (const [k, v] of Object.entries(es)) tx.objectStore('kv').put(v, k);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  }, entries);
}

test.describe('b-settings-center-deep 设置中心补强', () => {
  test('SC-10 图表组 UI 表单管线：模式网格应用落盘、source 模式文档级生效、非法 host 读回归位', async ({
    page
  }) => {
    // 拦掉真实 kroki.io：source 模式不应有任何网络面（环境无关）
    await page.route('**kroki.io/**', (route) => route.abort());
    await page.goto('/');
    await openSettings(page);
    await gotoGroup(page, '图表');

    // 30 类型模式网格（DIAGRAM_TYPES 注册表全量，spec §10 扩容 18→30），行=注册表
    // id；graphviz 行带渲染器 select（spec §9.1）且含「服务端」档（server 旗标），
    // plantuml 行含「官方服务器」档（officialServer 旗标，2026-10-30 第五档），
    // 其余类型按旗标出 本地/Kroki/源码 档集；plantuml/d2 默认 kroki（defaultMode），
    // mermaid/math/wavedrom 默认 local（Task 9 承接：扩容后网格行数锚同步 18→30）
    const grid = page.locator('.vv-diagram-mode-grid');
    await expect(grid.locator('.vv-diagram-mode-item')).toHaveCount(30);
    for (const id of ['mermaid', 'graphviz', 'plantuml', 'math']) {
      // 锚定整词：hasText 子串匹配会把 c4plantuml 误收进 'plantuml'（strict violation）
      await expect(
        grid.locator('.vv-diagram-mode-lang', { hasText: new RegExp(`^${id}$`) })
      ).toBeVisible();
    }
    await expect(page.locator('select[aria-label="plantuml 渲染模式"]')).toHaveValue('kroki');
    await expect(page.locator('select[aria-label="graphviz 渲染模式"]')).toHaveValue('local');
    // 官方服务器档仅 officialServer 旗标类型出 option（plantuml 有、mermaid 无）
    await expect(
      page.locator('select[aria-label="plantuml 渲染模式"] option[value="official"]')
    ).toHaveCount(1);
    await expect(
      page.locator('select[aria-label="mermaid 渲染模式"] option[value="official"]')
    ).toHaveCount(0);

    // UI 改 host+plantuml→source：应用后按注册表 id 键落盘（白名单合法形态）。
    // spec §8.3/§9.2 起 diagrams 节落盘含全形五键（krokiVia/mermaidTheme 恒默认
    // 归一值、renderers 空 = 注册表默认）——toEqual 全形断言（Task 9 承接补全）
    await page.getByLabel('Kroki 服务地址').fill('http://kroki.mock');
    await page.locator('select[aria-label="plantuml 渲染模式"]').selectOption('source');
    await applySettings(page);
    const saved = (await savedSettings(page)) as {
      diagrams?: {
        krokiHost?: string;
        krokiVia?: string;
        mermaidTheme?: string;
        modes?: Record<string, string>;
        renderers?: Record<string, string>;
      };
    };
    expect(saved.diagrams).toEqual({
      krokiHost: 'http://kroki.mock',
      krokiVia: 'client',
      mermaidTheme: 'auto',
      modes: { plantuml: 'source' },
      renderers: {}
    });
    await closeSettings(page);

    // 文档级生效（重开文档管线）：source 模式=无切换钮+源码面板展开+视图隐藏无 img
    await injectDir(page, [
      { name: 'sc10-plantuml.md', content: '```plantuml\nAlice -> Bob: hi\n```\n' }
    ]);
    await openTreeFile(page, 'sc10-plantuml.md');
    const wrap = page.locator('.vv-markdown .md-diagram').first();
    await expect(wrap.locator('.md-diagram-lang')).toHaveText('plantuml');
    await expect(wrap.locator('.md-diagram-toggle')).toHaveCount(0);
    await expect(wrap.locator('.md-diagram-source')).toBeVisible();
    await expect(wrap.locator('.md-diagram-source code')).toContainText('Alice -> Bob: hi');
    await expect(wrap.locator('.md-diagram-view')).toBeHidden();
    await expect(wrap.locator('.md-diagram-view img')).toHaveCount(0);

    // 非法 host（非 http(s):// 前缀）：表单路径 apply 不经 normalize 落盘，但
    // doApply 后 draft 以 loadSettings() 重建——输入框立即回落空（读回归位默认）
    await openSettings(page);
    await gotoGroup(page, '图表');
    await page.getByLabel('Kroki 服务地址').fill('kroki.example');
    await applySettings(page);
    await expect(page.getByLabel('Kroki 服务地址')).toHaveValue('');
    await closeSettings(page);
  });

  test('SC-11 导入合并字段级语义：节内单字段覆盖其余保留、modes 增量合并、字段级 diff 可见', async ({
    page
  }) => {
    // 现状：codeSize=16 + plantuml=kroki（I-1 行为锚的现状面）
    await page.addInitScript(() => {
      localStorage.setItem(
        'vviewer:settings',
        JSON.stringify({ fonts: { codeSize: 16 }, diagrams: { modes: { plantuml: 'kroki' } } })
      );
    });
    await page.goto('/');
    await openSettings(page);
    const importInput = page.locator('.vv-sc-navactions input[type="file"]');

    // ① fonts 节仅携 uiSize：合并后 uiSize 覆盖、codeSize 保留 16（节整体覆盖会退默认）
    await importInput.setInputFiles({
      name: 'sc11a.json',
      mimeType: 'application/json',
      buffer: exportFile({ fonts: { uiSize: 20 } })
    });
    await expect(page.getByRole('dialog', { name: '导入设置' })).toBeVisible();
    await expect(
      page.locator('.vv-sc-importline', { hasText: 'fonts.uiSize: 16 → 20' })
    ).toBeVisible(); // 字段级 diff（非节整体）；现状 uiSize=16（stores/settings.ts DEFAULTS）
    await page.getByRole('button', { name: '导入并应用' }).click();
    let saved = (await savedSettings(page)) as {
      fonts?: { uiSize?: number; codeSize?: number };
      diagrams?: { modes?: Record<string, string> };
    };
    expect(saved.fonts?.uiSize).toBe(20);
    expect(saved.fonts?.codeSize).toBe(16);

    // ② diagrams.modes 仅携 graphviz：增量合并——graphviz 新增、plantuml 保留
    await importInput.setInputFiles({
      name: 'sc11b.json',
      mimeType: 'application/json',
      buffer: exportFile({ diagrams: { modes: { graphviz: 'source' } } })
    });
    await expect(page.getByRole('dialog', { name: '导入设置' })).toBeVisible();
    await expect(
      page.locator('.vv-sc-importline', { hasText: '+ diagrams.modes.graphviz = source' })
    ).toBeVisible();
    await page.getByRole('button', { name: '导入并应用' }).click();
    saved = await savedSettings(page);
    expect(saved.diagrams?.modes).toEqual({ plantuml: 'kroki', graphviz: 'source' });
    await closeSettings(page);
  });

  test('SC-12 应用不覆盖外部变更：外部直写与草稿变更三方共存（mergeDraftOnto 手工通道）', async ({
    page
  }) => {
    await page.goto('/');
    await openSettings(page);
    // 草稿两笔变更（相对出发快照）：外观暗色+代码字号 27
    await page.getByLabel('亮暗模式').selectOption('dark');
    await gotoGroup(page, '字体');
    const size = page.locator('input[aria-label="代码字号（px）"]');
    await size.fill('27');
    await size.press('Enter');
    // 打开期间外部直写（模拟他方标签页绕过订阅链落盘）——不重置内存 applied，
    // 脏态照常；合并只把草稿相对出发快照的变更字段写上，外部字段保留
    await page.evaluate(() => {
      const cur = JSON.parse(localStorage.getItem('vviewer:settings') ?? '{}');
      cur.autoRefresh = false;
      localStorage.setItem('vviewer:settings', JSON.stringify(cur));
    });
    await expect(page.locator('.vv-sc-dirty')).toHaveText('未应用');
    await applySettings(page);
    const saved = (await savedSettings(page)) as {
      themeMode?: string;
      autoRefresh?: boolean;
      fonts?: { codeSize?: number };
    };
    expect(saved.themeMode).toBe('dark'); // 草稿变更写入
    expect(saved.fonts?.codeSize).toBe(27);
    expect(saved.autoRefresh).toBe(false); // 外部变更保留（整体写回会复活 true）
    await closeSettings(page);
  });

  test('SC-13 JSON 校验三分类：未知字段/类型不符/clamp 截断各自可见，修复后四舍五入落值', async ({
    page
  }) => {
    await page.goto('/');
    await openSettings(page);
    const area = page.locator('textarea[aria-label="设置 JSON"]');
    await page.locator('.vv-sc-viewbtn', { hasText: 'JSON' }).click();
    await area.fill(JSON.stringify({ nope: 1, autoRefresh: 'yes', fonts: { uiSize: 99 } }));
    await page.locator('.vv-sc-apply').click();

    // 三条问题全量收集且各自可见（field 径+消息文案）
    const errors = page.locator('.vv-sc-jsonerrors .vv-sc-jsonerror');
    await expect(errors).toHaveCount(3);
    const lineOf = (field: string) =>
      page.locator('.vv-sc-jsonerror', { has: page.locator('code', { hasText: field }) });
    await expect(lineOf('nope')).toContainText('未知字段');
    await expect(lineOf('autoRefresh')).toContainText('应为布尔值');
    await expect(lineOf('fonts.uiSize')).toContainText('超出范围 10–28，将截断为 28');

    // 阻断语义：标错停留 JSON 视图（SC-02 同口径轻锚），修复为界内小数后放行
    await area.fill(JSON.stringify({ fonts: { uiSize: 27.6 } }));
    await page.locator('.vv-sc-apply').click();
    await expect(page.locator('.vv-sc-jsonerrors')).toHaveCount(0);
    const saved = (await savedSettings(page)) as { fonts?: { uiSize?: number } };
    expect(saved.fonts?.uiSize).toBe(28); // clampSize 四舍五入落值
    await closeSettings(page);
  });

  test('SC-14 schemaVersion 2 高版本导入警告面（尽力合并）+ settings 缺失错误弹层', async ({
    page
  }) => {
    await page.goto('/');
    await openSettings(page);
    const importInput = page.locator('.vv-sc-navactions input[type="file"]');

    // 高版本文件：警告注记可见但不阻断，合并应用照常
    await importInput.setInputFiles({
      name: 'future.json',
      mimeType: 'application/json',
      buffer: exportFile({ themeMode: 'dark' }, 2)
    });
    await expect(page.getByRole('dialog', { name: '导入设置' })).toBeVisible();
    await expect(page.locator('.vv-settings-warn')).toContainText('schemaVersion 2 > 1');
    await expect(page.locator('.vv-sc-importkey', { hasText: 'themeMode' })).toBeVisible();
    await page.getByRole('button', { name: '导入并应用' }).click();
    expect((await savedSettings(page)).themeMode).toBe('dark');

    // settings 缺失：明确报错弹层，不部分应用
    await importInput.setInputFiles({
      name: 'nosec.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ schemaVersion: 1, exportedAt: '2026-10-22T00:00:00.000Z' }))
    });
    const err = page.getByRole('alertdialog', { name: '导入设置错误' });
    await expect(err).toContainText('缺少 settings 对象');
    await err.getByRole('button', { name: '关闭' }).click();
    expect((await savedSettings(page)).themeMode).toBe('dark'); // 原值未动
    await closeSettings(page);
  });

  test('SC-15 存储矩阵·会话快照与目录授权句柄：kv 键精确圈定，句柄跨会话清除不连带', async ({
    page
  }) => {
    await page.goto('/');
    // 三键直构（tabs/workspaces=会话快照两键；dirHandle=句柄键）
    await seedKv(page, {
      workspaces: { workspaces: [], activeWorkspace: 'w1' },
      tabs: [{ id: 't1', path: '/a.md' }],
      dirHandle: {}
    });
    await openSettings(page);
    await gotoGroup(page, '存储与数据');

    // 会话快照行：占用估算已载入（非「…」占位）
    const sessions = page.locator('.vv-storage-cat', { hasText: '会话快照' });
    await expect(sessions.locator('.vv-storage-catsize')).not.toHaveText('…');

    // 清会话：确认文案列明「目录授权句柄保留」；两键删、句柄键不动
    await sessions.getByRole('button', { name: '清除' }).click();
    const confirmSessions = page.getByRole('alertdialog', { name: '清除会话快照确认' });
    await expect(confirmSessions).toContainText('目录授权句柄保留');
    await confirmSessions.getByRole('button', { name: '确认清除' }).click();
    await expect(page.locator('.vv-settings-note', { hasText: '已清除 2 项' })).toBeVisible();
    await expect
      .poll(async () => (await kvKeys(page)).filter((k) => k !== 'dirHandle'))
      .toEqual([]);
    await expect.poll(async () => (await kvKeys(page)).includes('dirHandle')).toBe(true);

    // 清句柄：确认文案「不再自动恢复」；删后 kv 全空
    const handles = page.locator('.vv-storage-cat', { hasText: '目录授权句柄' });
    await handles.getByRole('button', { name: '清除' }).click();
    const confirmHandles = page.getByRole('alertdialog', { name: '清除目录授权确认' });
    await expect(confirmHandles).toContainText('不再自动恢复');
    await confirmHandles.getByRole('button', { name: '确认清除' }).click();
    await expect(page.locator('.vv-settings-note', { hasText: '已清除 1 项' })).toBeVisible();
    await expect.poll(async () => kvKeys(page)).toEqual([]);
    await closeSettings(page);
  });

  test('SC-16 存储矩阵·导入主题清除引用实时回落 + 运行时缓存清普通保 precache 区分', async ({
    page
  }) => {
    await page.goto('/');
    await openSettings(page);

    // 外观节导入主题+暗色槽引用（t-theme 同通道；为存储清除提供引用回落前驱）
    await gotoGroup(page, '外观');
    await page.locator('.vv-sc-section input[type="file"]').setInputFiles({
      name: 'probe16.json',
      mimeType: 'application/json',
      buffer: Buffer.from(
        JSON.stringify({
          name: 'Probe16',
          type: 'dark',
          colors: { 'editor.background': '#165052' },
          tokenColors: []
        })
      )
    });
    await expect(page.locator('.vv-settings-note', { hasText: '已导入 1 个主题' })).toBeVisible();
    await page.getByLabel('暗色界面主题').selectOption({ label: 'Probe16（暗）' });
    await applySettings(page);
    expect(
      ((await savedSettings(page)).appearanceDark as string).startsWith('imported:')
    ).toBe(true);

    // 存储节：导入主题 1 条→清除→引用实时回落 default（订阅链，无需重载）+store 空
    await gotoGroup(page, '存储与数据');
    const themesCat = page.locator('.vv-storage-cat', { hasText: '导入主题' });
    await expect(themesCat).toContainText('（1 条）'); // 全角括号锚定避免「10 条」子串误配（产品渲染全角，StorageSection）
    await themesCat.getByRole('button', { name: '清除' }).click();
    const confirmThemes = page.getByRole('alertdialog', { name: '删除导入主题确认' });
    await expect(confirmThemes).toContainText('回落「默认」');
    await confirmThemes.getByRole('button', { name: '确认清除' }).click();
    await expect(page.locator('.vv-settings-note', { hasText: '已清除 1 项' })).toBeVisible();
    await expect
      .poll(() => savedSettings(page))
      .toEqual(expect.objectContaining({ appearanceDark: 'default' }));
    await expect(themesCat).toContainText('（0 条）');

    // 运行时缓存：伪造普通缓存+precache 名缓存各一→清除只删普通、precache 保留
    //（区分断言；清除断言不锚计数——同源真实运行时缓存名随并行域用例浮动）
    await page.evaluate(async () => {
      await (await caches.open('vv-sc16-runtime')).put('/sc16', new Response('x'));
      await (await caches.open('workbox-precache-sc16-fake')).put('/sc16-pre', new Response('y'));
    });
    const runtime = page.locator('.vv-storage-cat', { hasText: '运行时缓存' });
    await runtime.getByRole('button', { name: '清除' }).click();
    const confirmRuntime = page.getByRole('alertdialog', { name: '清除运行时缓存确认' });
    await expect(confirmRuntime).toContainText('precache 保留');
    await confirmRuntime.getByRole('button', { name: '确认清除' }).click();
    await expect
      .poll(async () => page.evaluate(async () => (await caches.keys()).includes('vv-sc16-runtime')))
      .toBe(false);
    await expect
      .poll(async () =>
        page.evaluate(async () => (await caches.keys()).includes('workbox-precache-sc16-fake'))
      )
      .toBe(true);

    // 收尾：清除把 applied 改了而草稿未动（I-2 如实显形）——Esc 弹确认条，放弃并关闭
    await page.keyboard.press('Escape');
    const stale = page.getByRole('alertdialog', { name: '未应用的修改' });
    await expect(stale).toBeVisible();
    await stale.getByRole('button', { name: '放弃并关闭' }).click();
    await expect(page.locator(SETTINGS_ROOT)).toHaveCount(0);
    expect(
      ((await savedSettings(page)) as { appearanceDark?: string }).appearanceDark
    ).toBe('default');
  });

  test('SC-17 导出往返：文件名/文件形状锚定，导入以文件为准重建未应用草稿', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('vviewer:settings', JSON.stringify({ autoRefresh: false }));
    });
    await page.goto('/');
    await openSettings(page);

    // 导出：a[download] 文件名 vviewer-settings-YYYYMMDD.json；内容 = schemaVersion
    // +exportedAt+settings 全形（loadSettings 规范化值）
    const dlPromise = page.waitForEvent('download', { timeout: 15_000 });
    await page.getByRole('button', { name: '导出…' }).click();
    const dl = await dlPromise;
    expect(dl.suggestedFilename()).toMatch(/^vviewer-settings-\d{8}\.json$/);
    const file = JSON.parse(readFileSync(await dl.path(), 'utf-8')) as {
      schemaVersion: number;
      exportedAt: string;
      settings: { autoRefresh?: boolean; themeMode?: string };
    };
    expect(file.schemaVersion).toBe(1);
    expect(typeof file.exportedAt).toBe('string');
    expect(file.settings.autoRefresh).toBe(false);

    // 未应用草稿（亮暗=dark 脏态不落盘）→ 导入同一文件（合并）→ 导入值整体胜出：
    // 草稿被以文件为准重建，themeMode 回落文件中的 system，未应用改动不残留
    await gotoGroup(page, '外观');
    await page.getByLabel('亮暗模式').selectOption('dark');
    await expect(page.locator('.vv-sc-dirty')).toHaveText('未应用');
    await page.locator('.vv-sc-navactions input[type="file"]').setInputFiles({
      name: 'roundtrip.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(file))
    });
    await expect(page.getByRole('dialog', { name: '导入设置' })).toBeVisible();
    await page.getByRole('button', { name: '导入并应用' }).click();
    const saved = (await savedSettings(page)) as { themeMode?: string; autoRefresh?: boolean };
    expect(saved.themeMode).toBe('system');
    expect(saved.autoRefresh).toBe(false);
    await expect(page.locator('html')).toHaveAttribute('data-theme-mode', 'system'); // 订阅链即时回退
    await expect(page.locator('.vv-sc-dirty')).toHaveCount(0); // 应用后脏态清
    await closeSettings(page);
  });

  test('SC-18 脏态负路径：Esc 连按不绕过确认、切组不弹确认、头部 ✕ 同确认通道', async ({
    page
  }) => {
    await page.goto('/');
    await openSettings(page);
    await gotoGroup(page, '字体');
    const uiSize = page.locator('input[aria-label="界面字号（px）"]');
    await uiSize.fill('20');
    await uiSize.press('Enter');
    await expect(page.locator('.vv-sc-dirty')).toHaveText('未应用');

    // Esc 弹确认条后连按：不绕过、不误关（确认条开着 canApply 仍真，requestClose 幂等）
    await page.keyboard.press('Escape');
    const confirm = page.getByRole('alertdialog', { name: '未应用的修改' });
    await expect(confirm).toBeVisible();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await expect(confirm).toBeVisible();
    await expect(page.locator(SETTINGS_ROOT)).toBeVisible();

    // 继续编辑→条关；切组不触发确认、脏态跨组保留
    await confirm.getByRole('button', { name: '继续编辑' }).click();
    await expect(confirm).toHaveCount(0);
    await gotoGroup(page, '布局');
    await expect(page.getByRole('alertdialog', { name: '未应用的修改' })).toHaveCount(0);
    await expect(page.locator('.vv-sc-dirty')).toHaveText('未应用');
    await expect(page.locator(SETTINGS_ROOT)).toBeVisible();

    // 头部 ✕（关闭设置）与 Esc 同一 requestClose 通道：同样弹确认
    await page.locator('button[aria-label="关闭设置"]').click();
    await expect(page.getByRole('alertdialog', { name: '未应用的修改' })).toBeVisible();

    // 放弃并关闭收尾：草稿丢弃、落盘值不动（键缺省回落默认 16）
    await page
      .getByRole('alertdialog', { name: '未应用的修改' })
      .getByRole('button', { name: '放弃并关闭' })
      .click();
    await expect(page.locator(SETTINGS_ROOT)).toHaveCount(0);
    const saved = (await savedSettings(page)) as { fonts?: { uiSize?: number } };
    expect(saved.fonts?.uiSize ?? 16).toBe(16);
  });

  test('SC-19 性能锚（宽松上界冒烟）：大 draft 打开/九组切换/JSON 视图大文本序列化时限', async ({
    page
  }) => {
    // 2000 项排除规则（合法白名单形态）→ draft JSON 约 2000+ 行
    const big = Array.from({ length: 2000 }, (_, i) => `pattern-${i}-${'x'.repeat(24)}`);
    await page.addInitScript((patterns) => {
      localStorage.setItem('vviewer:settings', JSON.stringify({ excludedPatterns: patterns }));
    }, big);
    await page.goto('/');

    // 打开时长：⚙ 点击→全屏页可见（纯 DOM，双核 CI 宽松上界 2s）
    const t0 = Date.now();
    await openSettings(page);
    expect(Date.now() - t0).toBeLessThan(2000);

    // 九组逐组切换（每步激活态断言）整轮 4s 上界
    const labels = [
      '外观',
      '字体',
      '图表',
      '布局',
      '搜索与排除',
      '自动刷新',
      '计算',
      '存储与数据',
      '关于'
    ];
    const t1 = Date.now();
    for (const label of labels) {
      await gotoGroup(page, label);
      await expect(page.locator('.vv-sc-navitem.active')).toHaveText(label);
    }
    expect(Date.now() - t1).toBeLessThan(4000);

    // JSON 视图大 draft 序列化：textarea 渲染全量文本+行号栏 2000+ 行+回切表单解析，4s 上界
    const t2 = Date.now();
    await page.locator('.vv-sc-viewbtn', { hasText: 'JSON' }).click();
    const area = page.locator('textarea[aria-label="设置 JSON"]');
    await expect
      .poll(async () => (await area.inputValue()).length, { timeout: 10_000 })
      .toBeGreaterThan(50_000);
    expect(await page.locator('.vv-sc-gutter span').count()).toBeGreaterThan(2000);
    await page.locator('.vv-sc-viewbtn', { hasText: '表单' }).click();
    await expect(page.locator('.vv-sc-viewbtn.active')).toHaveText('表单');
    expect(Date.now() - t2).toBeLessThan(4000);
    await closeSettings(page);
  });
});
