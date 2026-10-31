import { readFileSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import { closeDrawerIfOpened, openDrawerIfNarrow } from './drawer';
import { applySettings, closeSettings, gotoGroup, openSettings } from './settings-center';

/**
 * 图标主题域（图标主题+Open VSX spec，Task 4 ICON-01..05）。settings-center 装置：
 * openSettings/gotoGroup('外观')/applySettings——草稿统一落盘（e2e/settings-center.ts）。
 *
 * - ICON-01 seti 预置默认作用域（仅文件树）：文件行 .vv-file-icon 非空字形；Seti
 *   上游无 folder 图标（见 vendor README）→ 源头行零渲染、tab 无图标（零位移语义）。
 *   T5 携修补 tabs 开关双向断言（开 tabs + 有打开 tab → tab 图标在场；关 tabs →
 *   tab 零图标——原「tab 无图标」断言无打开 tab 时是空洞）。
 * - ICON-02 scopes 门控：关 tree 开 tabs → 树零图标 / tab 图标在场。
 * - ICON-03 scopes quickOpen/search：行首/文件头行首图标。
 * - ICON-04 导入 json+字体同批（Mini 夹具：folder 图标 + hidesExplorerArrows）→
 *   源头行/目录行 folder 图标 + caret 替代（展开变体）；删除回退 none（引用回落）。
 * - ICON-05 无匹配文件零位移：无 _file 回退的主题下，未命中行无图标元素且行高不变。
 *
 * 域内偏差备案（plan ICON-01 原文「seti hidesExplorerArrows=true 的 caret 替代」）：
 * vscode 1.141.0 上游 Seti 清单无 folder 关联、无 hidesExplorerArrows 键——caret
 * 替代移至 ICON-04 用导入夹具覆盖（语义等价：规则本体与主题来源无关）。
 */

/** Mini 夹具：单字体（复用 vendor seti.woff 字节）+ folder 回退键 + hidesExplorerArrows；
 * 无 _file（ICON-05 的「无匹配零位移」需要回退链终点落空） */
const MINI_JSON = JSON.stringify({
  name: 'Mini',
  fonts: [{ id: 'm', src: ['./m.woff'], format: 'woff' }],
  iconDefinitions: {
    // fontCharacter 用 CSS 转义形（\ea0b，无 'u' 前缀——官方主题惯例，T1
    // decodeFontCharacter 的解码口径）；JSON.parse 后落单字符
    _folder: { fontCharacter: '\\ea0b', fontColor: '#8a9199' },
    _folder_open: { fontCharacter: '\\ea0c', fontColor: '#8a9199' },
    ts: { fontCharacter: '\\e6e4', fontColor: '#519aba' }
  },
  fileExtensions: { ts: 'ts' },
  folderNames: { pkg: '_folder' },
  hidesExplorerArrows: true
});

const WOFF_PATH = new URL('../../../packages/vviewer-highlight/assets/vscode-icons/seti/seti.woff', import.meta.url);

interface Payload {
  name: string;
  content: string;
}

/** 目录注入（b-theme-system openDir 同构）：webkitRelativePath 首段 = 来源名，
 * 中段目录生成树目录行 */
async function openDir(page: Page, payloads: Payload[]): Promise<void> {
  await page.waitForFunction(
    () => typeof (window as unknown as { __vvOpenDirImpl?: unknown }).__vvOpenDirImpl === 'function'
  );
  await page.evaluate((payloads) => {
    const files = payloads.map(({ name, content }) => {
      const f = new File([content], name, { type: 'text/plain' });
      Object.defineProperty(f, 'webkitRelativePath', { value: `bicon/${name}` });
      return f;
    });
    return (window as unknown as { __vvOpenDirImpl: (f: File[]) => void }).__vvOpenDirImpl(files);
  }, payloads);
}

/** 树行精确名定位：name span 全等匹配（hasText 子串会同时命中目录行与其子行——
 * 注入的 localfiles store 子行 name 为根内全路径 'pkg/app.ts'，含目录名前缀） */
function treeRowByName(page: Page, name: string): ReturnType<Page['locator']> {
  return page
    .locator('.vv-tree-row')
    .filter({ has: page.locator('.vv-tree-name', { hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) });
}

/** 树行点击打开文件（抽屉断点适配，theme-system openFile 同法） */
async function openTreeFile(page: Page, name: string): Promise<void> {
  const drawer = await openDrawerIfNarrow(page);
  await treeRowByName(page, name.split('/').pop() ?? name).click();
  await closeDrawerIfOpened(page, drawer);
  await expect(page.locator('.vv-tab.active', { hasText: name })).toBeVisible();
}

/** 图标主题设置驱动：开设置→外观组→单选+scopes→应用→关页 */
async function setIconTheme(
  page: Page,
  theme: { label: string } | 'seti' | 'none',
  scopes: { tree?: boolean; tabs?: boolean; quickOpen?: boolean; search?: boolean } = {}
): Promise<void> {
  await openSettings(page);
  await gotoGroup(page, '外观');
  const sel = page.getByLabel('图标主题', { exact: true });
  if (theme === 'seti' || theme === 'none') await sel.selectOption(theme);
  else await sel.selectOption({ label: theme.label });
  const labelOf = { tree: '文件树', tabs: '标签栏', quickOpen: '快速打开', search: '全局搜索' } as const;
  for (const [key, value] of Object.entries(scopes)) {
    await page.getByLabel(`图标主题出现范围：${labelOf[key as keyof typeof labelOf]}`).setChecked(value!);
  }
  await applySettings(page);
  await closeSettings(page);
}

/** 图标主题导入（Mini 夹具：json + woff 同批——缺字体整条拒绝的管线契约） */
async function importMini(page: Page): Promise<void> {
  await openSettings(page);
  await gotoGroup(page, '外观');
  await page.locator('.vv-settings-center input[type="file"][accept*="woff"]').setInputFiles([
    { name: 'mini.json', mimeType: 'application/json', buffer: Buffer.from(MINI_JSON) },
    { name: 'm.woff', mimeType: 'font/woff', buffer: readFileSync(WOFF_PATH) }
  ]);
  await expect(page.locator('.vv-settings-note')).toHaveText('已导入 1 个图标主题');
  await expect(page.locator('.vv-settings-theme-name', { hasText: 'Mini' })).toBeVisible();
}

test('ICON-01：seti 预置默认仅文件树——文件行非空字形，源头行/tab 零图标（tabs 开关双向）', async ({ page }) => {
  await page.goto('/');
  await openDir(page, [
    { name: 'app.ts', content: 'const a = 1;\n' },
    { name: 'readme.md', content: '# t\n' }
  ]);
  await openTreeFile(page, 'app.ts'); // 先开一个文件 tab：tab 零图标断言非空洞
  await expect(page.locator('.vv-tree-row').first()).toBeVisible();

  await setIconTheme(page, 'seti');

  // 文件行字形：两条文件行均有 .vv-file-icon 且字形字符非空（FontFace 换装后的
  // 真实 PUA 字符；空串即占位渲染回归）
  const rows = page.locator('.vv-tree .vv-tree-row', { hasText: /\.ts|\.md/ });
  await expect(rows).toHaveCount(2);
  for (const row of await rows.all()) {
    await expect(row.locator('.vv-file-icon')).toHaveCount(1);
    await expect(row.locator('.vv-file-icon')).not.toHaveText('');
  }
  // 上游 Seti 无 folder 图标（vendor README 备注）：源头行零渲染（零位移）；
  // 默认 scopes.tree 仅树——有打开的文件 tab 亦零图标（默认关 tabs 的真断言）
  await expect(page.locator('.vv-tree-src .vv-file-icon')).toHaveCount(0);
  await expect(page.locator('.vv-tab .vv-file-icon')).toHaveCount(0);

  // 方向补（T5 携修）：开 tabs + 有打开 tab → tab 图标在场且非空；再关 tabs →
  // tab 零图标（scopes 门控双向）
  await setIconTheme(page, 'seti', { tabs: true });
  await expect(page.locator('.vv-tab .vv-file-icon')).toHaveCount(1);
  await expect(page.locator('.vv-tab.active .vv-file-icon')).not.toHaveText('');
  await setIconTheme(page, 'seti', { tabs: false });
  await expect(page.locator('.vv-tab .vv-file-icon')).toHaveCount(0);
});

test('ICON-02：scopes 门控——关 tree 开 tabs，树零图标 / 文件 tab 图标在场', async ({ page }) => {
  await page.goto('/');
  await openDir(page, [{ name: 'app.ts', content: 'const a = 1;\n' }]);
  await openTreeFile(page, 'app.ts');

  await setIconTheme(page, 'seti', { tree: false, tabs: true });

  await expect(page.locator('.vv-tree .vv-file-icon')).toHaveCount(0);
  await expect(page.locator('.vv-tab .vv-file-icon')).toHaveCount(1);
  // 文件 tab 的字形非空
  await expect(page.locator('.vv-tab.active .vv-file-icon')).not.toHaveText('');
});

test('ICON-03：scopes quickOpen/search——行首与文件头行首图标', async ({ page }) => {
  await page.goto('/');
  await openDir(page, [{ name: 'app.ts', content: 'const needle = 42;\n' }]);

  await setIconTheme(page, 'seti', { tree: false, quickOpen: true, search: true });

  // 快速打开（Ctrl+P）：结果行行首图标
  await page.keyboard.press('Control+p');
  const qoRow = page.locator('.vv-quickopen-row', { hasText: 'app.ts' });
  await expect(qoRow).toBeVisible();
  await expect(qoRow.locator('.vv-file-icon')).toHaveCount(1);
  await expect(qoRow.locator('.vv-file-icon')).not.toHaveText('');
  await page.keyboard.press('Escape');
  await expect(page.locator('.vv-quickopen')).toHaveCount(0);

  // 全局搜索（Ctrl+Shift+F）：仅文件头行加图标
  await page.keyboard.press('Control+Shift+f');
  await page.getByLabel('全局搜索内容').fill('needle');
  const fileHead = page.locator('.vv-gsearch-file', { hasText: 'app.ts' });
  await expect(fileHead).toBeVisible();
  await expect(fileHead.locator('.vv-file-icon')).toHaveCount(1);
  await expect(fileHead.locator('.vv-file-icon')).not.toHaveText('');
  // 命中行不加图标（spec §3.3：仅文件头行）
  await expect(page.locator('.vv-gsearch-row .vv-file-icon')).toHaveCount(0);
});

test('ICON-04：导入 json+字体同批生效——folder 图标 + caret 替代；删除回退 none', async ({ page }) => {
  page.on('dialog', (d) => void d.accept()); // 删除确认（window.confirm）
  await page.goto('/');
  await openDir(page, [
    { name: 'pkg/app.ts', content: 'const a = 1;\n' },
    { name: 'notes.md', content: '# t\n' }
  ]);
  await expect(page.locator('.vv-tree-row', { hasText: 'pkg' })).toBeVisible();

  await importMini(page);
  await page.getByLabel('图标主题', { exact: true }).selectOption({ label: 'Mini（json）' });
  await applySettings(page);
  await closeSettings(page);

  // 源头行 folder 图标（bicon 不在 folderNames → _folder 回退命中）
  await expect(page.locator('.vv-tree-src .vv-file-icon')).toHaveCount(1);
  // 目录行 caret 替代（hidesExplorerArrows + folderNames.pkg 命中）：折叠态无 caret
  // span、由 folder 图标承担展开指示；展开态走 folderExpanded 变体（跨向回退同字形）
  const dirRow = treeRowByName(page, 'pkg');
  await expect(dirRow.locator('.vv-tree-caret')).toHaveCount(0);
  await expect(dirRow.locator('.vv-file-icon')).toHaveCount(1);
  await expect(dirRow.locator('.vv-file-icon')).not.toHaveText('');
  // notes.md 无映射且无 _file → 零渲染（未命中零位移）
  await expect(treeRowByName(page, 'notes.md').locator('.vv-file-icon')).toHaveCount(0);

  // 展开目录：子行 .ts 命中 fileExtensions（子行 name 为根内全路径 'pkg/app.ts'，
  // 后缀匹配仍命中）；folderExpanded 变体在场（字形随展开态切换，行内仍无 caret）
  const drawer = await openDrawerIfNarrow(page);
  await dirRow.click();
  const childRow = page.locator('.vv-tree-row', { hasText: 'app.ts' });
  await expect(childRow).toBeVisible();
  await expect(dirRow.locator('.vv-tree-caret')).toHaveCount(0);
  await expect(dirRow.locator('.vv-file-icon')).toHaveCount(1);
  await expect(childRow.locator('.vv-file-icon')).toHaveCount(1);
  await closeDrawerIfOpened(page, drawer);

  // 删除被引用的导入主题：槽位回退 none（draft 同步归位）→ 应用后树零图标、caret 回归
  await openSettings(page);
  await gotoGroup(page, '外观');
  await page.getByLabel('删除已导入图标主题 Mini').click();
  await expect(page.getByLabel('图标主题', { exact: true })).toHaveValue('none');
  await applySettings(page);
  await closeSettings(page);
  await expect(page.locator('.vv-tree .vv-file-icon')).toHaveCount(0);
  // caret 回归（pkg 在展开流程中已被打开过，恢复为展开态箭头 ▾）
  await expect(treeRowByName(page, 'pkg').locator('.vv-tree-caret')).toHaveText('▾');
  await expect(page.locator('.vv-settings-center')).toHaveCount(0);
});

test('ICON-05：无匹配文件零位移——未命中行无图标元素且行高不变', async ({ page }) => {
  page.on('dialog', (d) => void d.accept());
  await page.goto('/');
  await openDir(page, [
    { name: 'match.ts', content: 'const a = 1;\n' },
    { name: 'odd.zzz', content: 'x\n' }
  ]);
  const oddRow = page.locator('.vv-tree-row', { hasText: 'odd.zzz' });
  await expect(oddRow).toBeVisible();
  // 基线：主题 'none' 时 odd.zzz 行高
  const drawer = await openDrawerIfNarrow(page);
  const before = (await oddRow.boundingBox())?.height ?? 0;
  await closeDrawerIfOpened(page, drawer);
  expect(before).toBeGreaterThan(0);

  await importMini(page);
  await page.getByLabel('图标主题', { exact: true }).selectOption({ label: 'Mini（json）' });
  await applySettings(page);
  await closeSettings(page);

  // 命中行有图标；未命中行（无 _file 回退）零元素
  await expect(page.locator('.vv-tree-row', { hasText: 'match.ts' }).locator('.vv-file-icon')).toHaveCount(1);
  await expect(oddRow.locator('.vv-file-icon')).toHaveCount(0);
  // 行高断言：零位移（boundingBox 亚像素级一致）
  const drawer2 = await openDrawerIfNarrow(page);
  const after = (await oddRow.boundingBox())?.height ?? 0;
  await closeDrawerIfOpened(page, drawer2);
  expect(Math.abs(after - before), 'odd.zzz 行高启用主题前后一致').toBeLessThan(0.5);
});
