import { existsSync, readFileSync } from 'node:fs';
import JSZip from 'jszip';
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
 *   附：损坏字体导入（非字体字节 woff）→ fontsOk=false 回退纯 caret（评审 Minor）。
 * - ICON-05 无匹配文件零位移：无 _file 回退的主题下，未命中行无图标元素且行高不变。
 *
 * 域内偏差备案（plan ICON-01 原文「seti hidesExplorerArrows=true 的 caret 替代」）：
 * vscode 1.141.0 上游 Seti 清单无 folder 关联、无 hidesExplorerArrows 键——caret
 * 替代移至 ICON-04 用导入夹具覆盖（语义等价：规则本体与主题来源无关）。
 *
 * - ICON-06..09 匹配链三面 + 手动 vsix 直导通道（测绘差距新增锚，文件尾 describe）：
 *   fileNames 精确名压扩展名 / languageIds 反向表（表外 id 静默零渲染）/ 多级后缀
 *   最长优先 / file input 直导 .vsix（source='vsix' 投影，OVX-01 网络路同内核）。
 *   字形断言一律 toHaveText(码点字符) 精确比对（Mini 夹具码点互异——「有无图标」
 *   弱断言区分不了命中层级）。定态化：SW block（OVX describe 先例）+ CDN/favicon
 *   噪声 fulfill（b-corpus-code-text mockExternalNoise 收敛到本域两条——build:e2e
 *   注入 VV_GRAMMAR_CDN，每次页面加载发 CDN manifest 请求，ICON-07/表外的「零
 *   console error」断言前提）；vendor woff 缺失整组容错 skip（语料 fs.existsSync 口径）。
 */

/** Mini 夹具生成器：单字体（默认复用 vendor seti.woff 字节）+ folder 回退键 +
 * hidesExplorerArrows；无 _file（ICON-05 的「无匹配零位移」需要回退链终点落空） */
function miniJson(name: string): string {
  return JSON.stringify({
    name,
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
}

const WOFF_PATH = new URL('../../../packages/vviewer-highlight/assets/vscode-icons/seti/seti.woff', import.meta.url);

/** vendor 字体在场性（语料容错 skip 口径）：ICON-06..09 夹具字体字节同源依赖 */
const WOFF_OK = existsSync(WOFF_PATH);

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

/** 图标主题导入（Mini 夹具：json + woff 同批——缺字体整条拒绝的管线契约）。
 * opts：name 换主题名（下拉 label `{name}（json）`）、woff 换字体字节（损坏字体
 * 回退用例传非字体字节——导入管线不验内容，FontFace.load 时才 reject）。 */
async function importMini(page: Page, opts: { name?: string; woff?: Buffer } = {}): Promise<string> {
  const name = opts.name ?? 'Mini';
  await openSettings(page);
  await gotoGroup(page, '外观');
  await page.locator('.vv-settings-center input[type="file"][accept*="woff"]').setInputFiles([
    { name: 'mini.json', mimeType: 'application/json', buffer: Buffer.from(miniJson(name)) },
    { name: 'm.woff', mimeType: 'font/woff', buffer: opts.woff ?? readFileSync(WOFF_PATH) }
  ]);
  await expect(page.locator('.vv-settings-note')).toHaveText('已导入 1 个图标主题');
  await expect(page.locator('.vv-settings-theme-name', { hasText: name })).toBeVisible();
  return `${name}（json）`;
}

// ---------- ICON-06..09 新增装置（匹配链三面 + 手动 vsix 直导） ----------

/** Mini 变体基座（miniJson 同口径收敛出参）：单字体（vendor seti.woff 字节）+
 * 传入匹配表；fontCharacter 用 CSS 转义形（decodeFontCharacter 解码口径），无
 * _file 键（未命中回退链终点落空——零渲染语义与 ICON-05 夹具一致）。 */
function variantJson(
  name: string,
  iconDefinitions: Record<string, { fontCharacter: string }>,
  tables: {
    fileNames?: Record<string, string>;
    fileExtensions?: Record<string, string>;
    languageIds?: Record<string, string>;
  }
): string {
  return JSON.stringify({ name, fonts: [{ id: 'm', src: ['./m.woff'], format: 'woff' }], iconDefinitions, ...tables });
}

/** Mini 变体导入（importMini 同管线：json + vendor woff 同批 file input——缺字体
 * 整条拒绝的契约不变）；返回下拉 label `{name}（json）`。既有 importMini（固定
 * miniJson 形状）不动，本 helper 供 ICON-06..08 变体夹具走同一导入通道。 */
async function importIconThemeFixture(page: Page, name: string, json: string): Promise<string> {
  await openSettings(page);
  await gotoGroup(page, '外观');
  await page.locator('.vv-settings-center input[type="file"][accept*="woff"]').setInputFiles([
    { name: 'variant.json', mimeType: 'application/json', buffer: Buffer.from(json) },
    { name: 'm.woff', mimeType: 'font/woff', buffer: readFileSync(WOFF_PATH) }
  ]);
  await expect(page.locator('.vv-settings-note')).toHaveText('已导入 1 个图标主题');
  await expect(page.locator('.vv-settings-theme-name', { hasText: name })).toBeVisible();
  return `${name}（json）`;
}

/** 导入后应用：selectOption（label）→ 应用 → 关页（ICON-04/05 同流程收敛）。 */
async function applyImportedTheme(page: Page, label: string): Promise<void> {
  await page.getByLabel('图标主题', { exact: true }).selectOption({ label });
  await applySettings(page);
  await closeSettings(page);
}

/** CDN/favicon 噪声去噪（b-corpus-code-text mockExternalNoise 收敛到本域两条）：
 * build:e2e 固定注入 VV_GRAMMAR_CDN=cdn.grammars.test（apps/web/package.json），
 * 每次页面加载发 grammar manifest 请求——.test 保留 TLD 真实 DNS 行为不定，fulfill
 * 合法空清单定态化（ICON-07/表外「零 console error」断言前提）；favicon fulfill 204。
 * 本域无 md 语料（无 kroki 面），mockExternalNoise 的 kroki 条目不收。须先于 goto 注册。 */
async function mockIconNoise(page: Page): Promise<void> {
  await page.route('**/cdn.grammars.test/**', (route) =>
    route.fulfill({
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: '{"grammars":{}}'
    })
  );
  await page.route('**/favicon.ico', (route) => route.fulfill({ status: 204 }));
}

/** console error / 未捕获异常收集（断言形态沿 b-grammar-spa-fallback：SW block
 * （:41）下 pageerror 探针（:145）+ expect(probe.pageErrors).toEqual([]) 同款；
 * console error 按 msg.type()==='error' 收集沿 t-hl 同形态——编号勘误轮定档
 * BUG-35（t-hl.spec.ts:638））：ICON-07/表外「表外 id 静默不报错」断言面
 * （spec §3.4）。 */
function collectPageNoise(page: Page): { consoleErrors: string[]; pageErrors: string[] } {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  return { consoleErrors, pageErrors };
}

/** 手动 vsix 夹具（b-openvsx iconVsix 同构：jszip Node 侧构造 contributes.iconThemes
 * + 包内字体）；码点参数化供字形精确比对。ICON-09 断通道入口（file input 直供）与
 * OVX-01 网络路产物同型——同一 importIconVsixFile 内核。 */
async function iconVsixFixture(char: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    'extension/package.json',
    JSON.stringify({ name: 'local-icons', contributes: { iconThemes: [{ label: 'Local Vsix', path: './icons/local.json' }] } })
  );
  zip.file(
    'extension/icons/local.json',
    JSON.stringify({
      name: 'Local Vsix',
      iconDefinitions: { f: { fontCharacter: char } },
      fonts: [{ id: 'm', src: ['./m.woff'] }],
      fileExtensions: { ts: 'f' }
    })
  );
  zip.file('extension/icons/m.woff', readFileSync(WOFF_PATH));
  return zip.generateAsync({ type: 'nodebuffer' });
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

test('ICON-04 附：损坏字体导入——fontsOk=false 回退纯 caret（展开指示不丢）', async ({ page }) => {
  await page.goto('/');
  await openDir(page, [
    { name: 'pkg/app.ts', content: 'const a = 1;\n' },
    { name: 'notes.md', content: '# t\n' }
  ]);
  // 损坏 woff 夹具（非字体字节）：导入管线不验字体内容（仅扩展名白名单），
  // FontFace.load 在换装时才 reject → runtime.fontsOk=false
  const label = await importMini(page, { name: 'MiniBad', woff: Buffer.from('not-a-font-bytes') });
  await page.getByLabel('图标主题', { exact: true }).selectOption({ label });
  await applySettings(page);
  await closeSettings(page);

  // caret 替代回退（评审 Minor）：字体残缺主题（hidesExplorerArrows + folderNames
  // 本可替代）不替代——目录行 caret 在场（折叠 ▸），宁保守不丢展开指示。
  // 对照 ICON-04 同形态好字体主题：dirRow caret count=0（替代发生）
  const dirRow = treeRowByName(page, 'pkg');
  await expect(dirRow.locator('.vv-tree-caret')).toHaveText('▸');
});

test.describe('ICON-06..09 匹配链三面与手动 vsix 直导（SW block + CDN 去噪定态）', () => {
  test.use({ serviceWorkers: 'block' }); // OVX describe 先例：网络面定态、拦截面确定
  test.skip(!WOFF_OK, 'vendor seti.woff 缺失：Mini 变体夹具字体字节不可用（语料容错 skip 口径）');

  test('ICON-06：fileNames 精确名压过 fileExtensions——app.ts 命中专属字形 x 而非扩展名 y', async ({ page }) => {
    await mockIconNoise(page);
    await page.goto('/');
    await openDir(page, [
      { name: 'app.ts', content: 'const a = 1;\n' },
      { name: 'util.ts', content: 'const b = 2;\n' }
    ]);
    await expect(page.locator('.vv-tree-row').first()).toBeVisible();

    // 码点互异（\ue6a1/\ue6a2）：弱断言区分不了命中层级，字形全等才是优先级锚
    const label = await importIconThemeFixture(
      page,
      'PriName',
      variantJson(
        'PriName',
        { x: { fontCharacter: '\\e6a1' }, y: { fontCharacter: '\\e6a2' } },
        { fileNames: { 'app.ts': 'x' }, fileExtensions: { ts: 'y' } }
      )
    );
    await applyImportedTheme(page, label);

    // fileNames 全名精确命中在 fileSuffixes 枚举之前短路返回（vscodeIcon.ts:369-370）：
    // app.ts 走 fileNames.x（\ue6a1），未落 fileExtensions.ts 的 y（\ue6a2）
    await expect(treeRowByName(page, 'app.ts').locator('.vv-file-icon')).toHaveCount(1);
    await expect(treeRowByName(page, 'app.ts').locator('.vv-file-icon')).toHaveText('\ue6a1');
    // 对照行：无精确名映射的 util.ts 走扩展名 y（证明 y 定义可渲染——「压过」
    // 非「y 缺席」，同时锁单级扩展名路径在本夹具下不回归）
    await expect(treeRowByName(page, 'util.ts').locator('.vv-file-icon')).toHaveText('\ue6a2');
  });

  test('ICON-07/lang：languageIds 反向表——.ts 经 EXT_TO_LANGS 命中 typescript 字形 t，零 detect 依赖', async ({ page }) => {
    await mockIconNoise(page);
    await page.goto('/');
    // 文件不打开（树是默认唯一开启作用域）：反向表匹配输入 = 文件名扩展名本身
    // （vscodeIcon.ts:375-380），树行命中即证零 detect 依赖（spec §3.4）
    await openDir(page, [
      { name: 'app.ts', content: 'const a = 1;\n' },
      { name: 'util.js', content: 'const b = 2;\n' }
    ]);
    await expect(page.locator('.vv-tree-row').first()).toBeVisible();

    const label = await importIconThemeFixture(
      page,
      'LangMap',
      variantJson('LangMap', { t: { fontCharacter: '\\e6b1' } }, { languageIds: { typescript: 't' } })
    );
    await applyImportedTheme(page, label);

    // .ts → EXT_TO_LANGS ['typescript'] → languageIds.t 命中（\ue6b1）
    await expect(treeRowByName(page, 'app.ts').locator('.vv-file-icon')).toHaveCount(1);
    await expect(treeRowByName(page, 'app.ts').locator('.vv-file-icon')).toHaveText('\ue6b1');
    // 对照行：.js 反向命中 'javascript'，表内未配置该 id → 落空零渲染（反向表按
    // id 精确查，非「有 languageIds 表就给所有文件图标」）
    await expect(treeRowByName(page, 'util.js').locator('.vv-file-icon')).toHaveCount(0);
  });

  test('ICON-07/表外：EXT_TO_LANGS 表外 id（zig）静默零渲染——零元素零位移零报错', async ({ page }) => {
    await mockIconNoise(page);
    const noise = collectPageNoise(page);
    await page.goto('/');
    await openDir(page, [{ name: 'code.zig', content: 'const x = 1;\n' }]);
    const zigRow = treeRowByName(page, 'code.zig');
    await expect(zigRow).toBeVisible();
    // 基线：主题 'none' 时 code.zig 行高（ICON-05 同锚零位移）
    const drawer = await openDrawerIfNarrow(page);
    const before = (await zigRow.boundingBox())?.height ?? 0;
    await closeDrawerIfOpened(page, drawer);
    expect(before).toBeGreaterThan(0);

    const label = await importIconThemeFixture(
      page,
      'LangUnknown',
      variantJson('LangUnknown', { z: { fontCharacter: '\\e6b2' } }, { languageIds: { zig: 'z' } })
    );
    await applyImportedTheme(page, label);

    // zig 表外（EXT_TO_LANGS 无此扩展）→ 反向表层整体落空（vscodeIcon.ts:375-381）
    // → 无 _file 回退 → null 不渲染（vscodeIcon.ts:383 尾回退）
    await expect(zigRow.locator('.vv-file-icon')).toHaveCount(0);
    const drawer2 = await openDrawerIfNarrow(page);
    const after = (await zigRow.boundingBox())?.height ?? 0;
    await closeDrawerIfOpened(page, drawer2);
    expect(Math.abs(after - before), 'code.zig 行高启用主题前后一致').toBeLessThan(0.5);
    // 静默面（spec §3.4「表外 id 无匹配（静默，不报错）」）：零错误卡 + 零 console
    // error + 零未捕获异常（SW 注册失败经 registerSW 内部 catch 吞——注册面无噪声）
    await expect(page.locator('.vv-error-card')).toHaveCount(0);
    expect(noise.consoleErrors, '表外 id 静默：零 console error').toEqual([]);
    expect(noise.pageErrors, '表外 id 静默：零未捕获异常').toEqual([]);
  });

  test('ICON-08：多级后缀最长优先——a.d.ts 命中 .d.ts 专属字形 dt 而非单级 ts', async ({ page }) => {
    await mockIconNoise(page);
    await page.goto('/');
    await openDir(page, [
      { name: 'a.d.ts', content: 'export type A = 1;\n' },
      { name: 'b.ts', content: 'export const b = 2;\n' }
    ]);
    await expect(page.locator('.vv-tree-row').first()).toBeVisible();

    const label = await importIconThemeFixture(
      page,
      'MultiSuffix',
      variantJson(
        'MultiSuffix',
        { dt: { fontCharacter: '\\e6c1' }, ts: { fontCharacter: '\\e6c2' } },
        { fileExtensions: { 'd.ts': 'dt', ts: 'ts' } }
      )
    );
    await applyImportedTheme(page, label);

    // fileSuffixes('a.d.ts') = ['d.ts','ts'] 最长优先（vscodeIcon.ts:184-190）：
    // 先试 .d.ts 命中 dt（\ue6c1）——专属字形非单级 .ts 的 ts 字形
    await expect(treeRowByName(page, 'a.d.ts').locator('.vv-file-icon')).toHaveCount(1);
    await expect(treeRowByName(page, 'a.d.ts').locator('.vv-file-icon')).toHaveText('\ue6c1');
    // 对照行：b.ts 单级路径命中 ts（\ue6c2）不回归
    await expect(treeRowByName(page, 'b.ts').locator('.vv-file-icon')).toHaveText('\ue6c2');
  });

  test('ICON-09：手动 file input 直导 .vsix——导入生效且 source 投影 vsix（OVX-01 网络路同内核）', async ({ page }) => {
    await mockIconNoise(page);
    await page.goto('/');
    await openDir(page, [{ name: 'app.ts', content: 'const a = 1;\n' }]);
    await expect(page.locator('.vv-tree-row').first()).toBeVisible();

    const vsix = await iconVsixFixture('\\e6d1');
    await openSettings(page);
    await gotoGroup(page, '外观');
    // 通道入口断言：file input（accept 含 .vsix，AppearanceSection.svelte:555）直供
    // 整包——与 OVX-01 的分界仅在 vsix 来源（本机文件 vs Open VSX 下载），导入
    // 内核/校验链同一（importIconVsixFile，spec §6.2）
    await page.locator('.vv-settings-center input[type="file"][accept*="woff"]').setInputFiles([
      { name: 'local-icons.vsix', mimeType: 'application/octet-stream', buffer: vsix }
    ]);
    await expect(page.locator('.vv-settings-note')).toHaveText('已导入 1 个图标主题');
    // source 投影：下拉 option label 带「（vsix）」后缀（session.ts:50 source 字段
    // 的 UI 投影，OVX-01 同锚形态）
    const sel = page.getByLabel('图标主题', { exact: true });
    await expect(sel.locator('option', { hasText: 'Local Vsix' })).toHaveText('Local Vsix（vsix）');
    await sel.selectOption({ label: 'Local Vsix（vsix）' });
    await applySettings(page);
    // 已导入列表行：.vv-settings-theme-src = source 原文 'vsix'（手动导入无 origin
    // ——无版本 pill，行内仅单 src span，AppearanceSection.svelte:594/595）
    const row = page.locator('.vv-settings-theme', { hasText: 'Local Vsix' });
    await expect(row).toHaveCount(1);
    await expect(row.locator('.vv-settings-theme-src')).toHaveCount(1);
    await expect(row.locator('.vv-settings-theme-src')).toHaveText('vsix');
    await closeSettings(page);

    // 导入生效：树行字形 = 包内 manifest 码点（与 OVX-01 网络路产物同型的渲染面）
    await expect(treeRowByName(page, 'app.ts').locator('.vv-file-icon')).toHaveCount(1);
    await expect(treeRowByName(page, 'app.ts').locator('.vv-file-icon')).toHaveText('\ue6d1');
  });
});
