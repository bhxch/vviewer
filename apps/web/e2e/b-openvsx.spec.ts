import { readFileSync } from 'node:fs';
import JSZip from 'jszip';
import { test, expect, type Page } from '@playwright/test';
import { applySettings, closeSettings, gotoGroup, openSettings } from './settings-center';

/**
 * b-openvsx —— Open VSX 安装与更新通道（图标主题+Open VSX spec §6.5，Task 5
 * OVX-01..05）。settings-center 装置（openSettings/gotoGroup('外观')/applySettings）。
 *
 * - OVX-01 安装图标主题生效：单行输入标识 → manifest 预检 → 拉 vsix → 走
 *   importIconThemeFiles 内核 → 选择应用后树图标在场（真实 seti.woff 字节）。
 * - OVX-02 非主题扩展快速报错：manifest 预检拒（contributes 无 themes/iconThemes）
 *   → 错误文案可见且不触发整包下载（省多 MB，§6.2）。
 * - OVX-03 更新闭环（v1 装 → 路由改 v2 → 检查 → 更新）：图标主题——设置引用 id
 *   不变（select value 相同）+ 运行时字形随新 manifest 刷新（iconSig 不含记录
 *   内容的缝隙由 invalidateIcons + 重应用闭合）；颜色主题——同 id 覆盖后
 *   style#vv-code-theme 注入文本刷新（invalidateAppearance 缝）。
 * - OVX-04 超限：30MB+1 vsix 下载后拒绝，错误卡文案可见、不部分入库。
 * - OVX-05 真网冒烟（skipIf offline 探测，仿 CDN-04 cdnReachable 先例）：真拉
 *   One Dark Pro（zhuangtongfa.material-theme）安装成功。
 *
 * mock 装置：page.route 全域拦截 open-vsx.org 请求、按 pathname 分流（元数据/
 * manifest/vsix 三端点，§6.1 形状）；vsix 夹具 jszip Node 侧构造（颜色/图标两
 * 通道，字形码点与背景色随版本变化供 OVX-03 断言）。SW block（CDN-02 同备案）：
 * workbox runtimeCaching 虽不含 open-vsx 域，阻断 SW 保证请求必经页面网络栈、
 * page.route 拦截面确定（真网冒烟同 block，语义不受影响）。
 */

const OVX = 'https://open-vsx.org';
const META_PATH = '/api/pub/mini-icons';
const WOFF_PATH = new URL('../../../packages/vviewer-highlight/assets/vscode-icons/seti/seti.woff', import.meta.url);

/** 图标主题 vsix 夹具：字形码点随版本变化（OVX-03 运行时刷新断言锚）。 */
async function iconVsix(v: string, char: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    'extension/package.json',
    JSON.stringify({ name: 'mini-icons', contributes: { iconThemes: [{ label: 'OVX Mini', path: './icons/mini.json' }] } })
  );
  zip.file(
    'extension/icons/mini.json',
    JSON.stringify({
      name: 'OVX Mini',
      iconDefinitions: { file: { fontCharacter: char } },
      fonts: [{ id: 'm', src: ['./m.woff'] }],
      fileExtensions: { ts: 'file' }
    })
  );
  zip.file('extension/icons/m.woff', readFileSync(WOFF_PATH));
  return zip.generateAsync({ type: 'nodebuffer' });
}

/** 颜色主题 vsix 夹具：背景色随版本变化（OVX-03 注入刷新断言锚）。 */
async function colorVsix(v: string, bg: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    'extension/package.json',
    JSON.stringify({ name: 'night', contributes: { themes: [{ label: 'OVX Night', path: './themes/night.json' }] } })
  );
  zip.file(
    'extension/themes/night.json',
    JSON.stringify({ name: 'OVX Night', type: 'dark', colors: { 'editor.background': bg } })
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}

interface MockResponse {
  status?: number;
  contentType?: string;
  body: Buffer | string;
}

/** open-vsx mock 路由：按 pathname 分流；未注册路径 404（拦截面确定性）。 */
async function mockOvx(page: Page, handler: (pathname: string) => MockResponse | undefined): Promise<void> {
  await page.route('**/open-vsx.org/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const res = handler(pathname);
    if (res === undefined) {
      await route.fulfill({ status: 404, contentType: 'text/plain', body: `not mocked: ${pathname}` });
      return;
    }
    await route.fulfill({ status: res.status ?? 200, contentType: res.contentType ?? 'application/json', body: res.body });
  });
}

/** §6.1 元数据形状：version + files.manifest / files.download 直链。 */
function metaJson(version: string): string {
  return JSON.stringify({
    version,
    files: {
      manifest: `${OVX}/api/pub/mini-icons/${version}/file/pub.mini-icons-${version}.manifest`,
      download: `${OVX}/api/pub/mini-icons/${version}/file/pub.mini-icons-${version}.vsix`
    }
  });
}

/** vsix 下载计数器（OVX-02 预检快错「不触发整包下载」断言用）。 */
function countOvxRequests(page: Page): string[] {
  const hits: string[] = [];
  page.on('request', (r) => {
    if (/open-vsx\.org\/api\/.+\.vsix$/.test(r.url())) hits.push(r.url());
  });
  return hits;
}

/** 目录注入（b-icon-themes openDir 同构）：webkitRelativePath 首段 = 来源名。 */
async function openDir(page: Page, payloads: { name: string; content: string }[]): Promise<void> {
  await page.waitForFunction(
    () => typeof (window as unknown as { __vvOpenDirImpl?: unknown }).__vvOpenDirImpl === 'function'
  );
  await page.evaluate((payloads) => {
    const files = payloads.map(({ name, content }) => {
      const f = new File([content], name, { type: 'text/plain' });
      Object.defineProperty(f, 'webkitRelativePath', { value: `bovx/${name}` });
      return f;
    });
    return (window as unknown as { __vvOpenDirImpl: (f: File[]) => void }).__vvOpenDirImpl(files);
  }, payloads);
}

/** 树行精确名定位（b-icon-themes 同款：全等匹配防目录前缀子串命中）。 */
function treeRowByName(page: Page, name: string): ReturnType<Page['locator']> {
  return page
    .locator('.vv-tree-row')
    .filter({ has: page.locator('.vv-tree-name', { hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) });
}

/** 两处安装行的表单定位（channel: 颜色='颜色主题' / 图标='图标主题'）。 */
function ovxForm(page: Page, channel: '颜色主题' | '图标主题'): ReturnType<Page['locator']> {
  return page.locator('.vv-settings-ovx').filter({ has: page.getByLabel(`从 Open VSX 安装${channel}`) });
}

/** Open VSX 连通探测（OVX-05 skipIf offline 判据；API request 不走页面 route/SW）。 */
async function ovxReachable(page: Page): Promise<boolean> {
  try {
    const res = await page.request.get(`${OVX}/api/zhuangtongfa/material-theme`, { timeout: 5000 });
    return res.ok();
  } catch {
    return false;
  }
}

test.describe('b-openvsx Open VSX 安装与更新通道（SW block，CDN-02 备案同款）', () => {
  test.use({ serviceWorkers: 'block' });

  test('OVX-01：安装图标主题生效——预检/下载/导入内核全链，应用后树图标在场', async ({ page }) => {
    const v1 = await iconVsix('1.0.0', '\\e6e4');
    await mockOvx(page, (pathname) => {
      if (pathname === META_PATH) return { body: metaJson('1.0.0') };
      if (pathname === `${META_PATH}/1.0.0/file/pub.mini-icons-1.0.0.manifest`)
        return {
          body: JSON.stringify({ name: 'mini-icons', contributes: { iconThemes: [{ label: 'OVX Mini', path: './icons/mini.json' }] } })
        };
      if (pathname.endsWith('.vsix')) return { body: v1, contentType: 'application/octet-stream' };
      return undefined;
    });
    await page.goto('/');
    await openDir(page, [{ name: 'app.ts', content: 'const a = 1;\n' }]);
    await expect(page.locator('.vv-tree-row').first()).toBeVisible();

    await openSettings(page);
    await gotoGroup(page, '外观');
    await page.getByLabel('从 Open VSX 安装图标主题').fill('pub.mini-icons');
    await ovxForm(page, '图标主题').getByRole('button').click();
    await expect(page.locator('.vv-settings-note')).toHaveText('已从 Open VSX 安装 1 个主题');
    // 行内 origin.version pill（更新 UI 的前置形态）
    const row = page.locator('.vv-settings-theme', { hasText: 'OVX Mini' });
    await expect(row.locator('.vv-settings-theme-src', { hasText: 'v1.0.0' })).toHaveCount(1);

    await page.getByLabel('图标主题', { exact: true }).selectOption({ label: 'OVX Mini（vsix）' });
    await applySettings(page);
    await closeSettings(page);

    await expect(treeRowByName(page, 'app.ts').locator('.vv-file-icon')).toHaveText('\ue6e4');
  });

  test('OVX-02：非主题扩展 manifest 预检快速报错，零整包下载', async ({ page }) => {
    await mockOvx(page, (pathname) => {
      if (pathname === META_PATH) return { body: metaJson('1.0.0') };
      if (pathname.endsWith('.manifest'))
        return { body: JSON.stringify({ name: 'mini-icons', contributes: { languages: [] } }) };
      return undefined;
    });
    const downloads = countOvxRequests(page);
    await page.goto('/');
    await openSettings(page);
    await gotoGroup(page, '外观');
    await page.getByLabel('从 Open VSX 安装图标主题').fill('pub.mini-icons');
    await ovxForm(page, '图标主题').getByRole('button').click();
    await expect(page.locator('.vv-settings-note')).toContainText('该扩展不含主题');
    expect(downloads).toHaveLength(0); // 预检拒：vsix 从未下载（§6.2 省多 MB）
  });

  test('OVX-03：更新闭环——v1 装 → 路由改 v2 → 检查 → 更新，引用 id 不变且运行时刷新', async ({ page }) => {
    test.setTimeout(90_000);
    // 路由按图标 currentVersion / 颜色 colorVersion 闭包出数：各自装 v1 后翻转，
    // 检查/更新读到 v2；vsix body 需按请求版本异步构造（jszip 小包毫秒级，handler
    // 内生成）。两 phase 共用同一 /api 元数据路径（同 publisher.extension）。
    let currentVersion = '1.0.0';
    let colorVersion = '1.0.0';
    let colorPhase = false;
    const vsixByVersion: Record<string, () => Promise<Buffer>> = {
      '1.0.0': () => iconVsix('1.0.0', '\\e6e4'),
      '2.0.0': () => iconVsix('2.0.0', '\\e626')
    };
    const colorByVersion: Record<string, () => Promise<Buffer>> = {
      '1.0.0': () => colorVsix('1.0.0', '#010101'),
      '2.0.0': () => colorVsix('2.0.0', '#020202')
    };
    await page.route('**/open-vsx.org/**', async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === META_PATH) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: metaJson(colorPhase ? colorVersion : currentVersion)
        });
        return;
      }
      if (pathname.endsWith('.vsix')) {
        const v = colorPhase ? colorVersion : currentVersion;
        const buf = await (colorPhase ? colorByVersion[v]!() : vsixByVersion[v]!());
        await route.fulfill({ status: 200, contentType: 'application/octet-stream', body: buf });
        return;
      }
      // manifest 预检（颜色/图标两形态按 phase 出对应 package.json）
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: colorPhase
          ? JSON.stringify({ name: 'night', contributes: { themes: [{ label: 'OVX Night', path: './themes/night.json' }] } })
          : JSON.stringify({ name: 'mini-icons', contributes: { iconThemes: [{ label: 'OVX Mini', path: './icons/mini.json' }] } })
      });
    });

    // ---- 图标主题闭环 ----
    await page.goto('/');
    await openDir(page, [{ name: 'app.ts', content: 'const a = 1;\n' }]);
    await openSettings(page);
    await gotoGroup(page, '外观');
    await page.getByLabel('从 Open VSX 安装图标主题').fill('pub.mini-icons');
    await ovxForm(page, '图标主题').getByRole('button').click();
    await expect(page.locator('.vv-settings-note')).toHaveText('已从 Open VSX 安装 1 个主题');
    const iconSel = page.getByLabel('图标主题', { exact: true });
    await iconSel.selectOption({ label: 'OVX Mini（vsix）' });
    const iconRef = await iconSel.inputValue(); // select value（引用 id 基线；须在关面板前读）
    await applySettings(page);
    await closeSettings(page);
    await expect(treeRowByName(page, 'app.ts').locator('.vv-file-icon')).toHaveText('\ue6e4');

    // 降级锚（§6.3 semver-lite 口径）：线上翻到更低版本 0.9.0 → 检查应判
    // 「已是最新」且不出更新钮（显式装到比 latest 新的版本是降级，非更新）
    currentVersion = '0.9.0';
    await openSettings(page);
    await gotoGroup(page, '外观');
    await page.getByLabel('检查更新图标主题 OVX Mini').click();
    await expect(page.locator('.vv-settings-note')).toHaveText('「OVX Mini」已是最新（0.9.0）');
    await expect(page.getByLabel('更新图标主题 OVX Mini 到 0.9.0')).toHaveCount(0);

    currentVersion = '2.0.0';
    await page.getByLabel('检查更新图标主题 OVX Mini').click();
    await page.getByLabel(/更新图标主题 OVX Mini 到 2\.0\.0/).click();
    await expect(page.locator('.vv-settings-note')).toHaveText('已更新「OVX Mini」到 v2.0.0');
    const iconRow = page.locator('.vv-settings-theme', { hasText: 'OVX Mini' });
    await expect(iconRow.locator('.vv-settings-theme-src', { hasText: 'v2.0.0' })).toHaveCount(1);
    // 引用 id 不变（设置槽仍指向同一 imported:<id>，零断链）；更新不产生 settings
    // 变更 → 草稿非脏、应用钮 disabled——运行时刷新已由更新流程内 invalidate+重
    // 应用完成，无需再走 applySettings
    await expect(iconSel).toHaveValue(iconRef);
    await closeSettings(page);
    // 运行时刷新：字形随新 manifest 变化（invalidateIcons + 重应用生效）
    await expect(treeRowByName(page, 'app.ts').locator('.vv-file-icon')).toHaveText('\ue626');

    // ---- 颜色主题闭环 ----
    colorPhase = true;
    colorVersion = '1.0.0'; // 颜色通道独立版本簿记（安装 v1 → 检查前翻 v2）
    await openSettings(page);
    await gotoGroup(page, '外观');
    await page.getByLabel('从 Open VSX 安装颜色主题').fill('pub.mini-icons');
    await ovxForm(page, '颜色主题').getByRole('button').click();
    await expect(page.locator('.vv-settings-note', { hasText: '已从 Open VSX 安装' })).toBeVisible();
    await page.getByLabel('亮色界面主题').selectOption({ label: 'OVX Night（暗）' });
    const colorRef = await page.getByLabel('亮色界面主题').inputValue(); // 关面板前读
    await applySettings(page);
    await closeSettings(page);
    await expect
      .poll(() => page.evaluate(() => document.getElementById('vv-code-theme')?.textContent ?? ''))
      .toContain('#010101');

    await openSettings(page);
    await gotoGroup(page, '外观');
    colorVersion = '2.0.0'; // 线上已是 v2
    await page.getByLabel('检查更新主题 OVX Night').click();
    await page.getByLabel(/更新主题 OVX Night 到 2\.0\.0/).click();
    await expect(page.locator('.vv-settings-note')).toHaveText('已更新「OVX Night」到 v2.0.0');
    await expect(page.getByLabel('亮色界面主题')).toHaveValue(colorRef); // 引用 id 不变
    await closeSettings(page); // 同上：更新非 settings 变更，草稿非脏，直接关页
    // 注入刷新：style#vv-code-theme 文本随新 colors 变化（invalidateAppearance 缝）
    await expect
      .poll(() => page.evaluate(() => document.getElementById('vv-code-theme')?.textContent ?? ''))
      .toContain('#020202');
  });

  test('OVX-04：vsix 超过 30MB 上限——错误卡文案可见，不部分入库', async ({ page }) => {
    const oversize = Buffer.alloc(30 * 1024 * 1024 + 1);
    await mockOvx(page, (pathname) => {
      if (pathname === META_PATH) return { body: metaJson('1.0.0') };
      if (pathname.endsWith('.manifest'))
        return {
          body: JSON.stringify({ name: 'mini-icons', contributes: { iconThemes: [{ label: 'OVX Mini', path: './icons/mini.json' }] } })
        };
      if (pathname.endsWith('.vsix')) return { body: oversize, contentType: 'application/octet-stream' };
      return undefined;
    });
    await page.goto('/');
    await openSettings(page);
    await gotoGroup(page, '外观');
    await page.getByLabel('从 Open VSX 安装图标主题').fill('pub.mini-icons');
    await ovxForm(page, '图标主题').getByRole('button').click();
    await expect(page.locator('.vv-settings-note')).toContainText('超过 30MB 上限');
    // 不部分入库：列表无该主题
    await expect(page.locator('.vv-settings-theme', { hasText: 'OVX Mini' })).toHaveCount(0);
  });

  test('OVX-05：真网冒烟——真拉 One Dark Pro 安装成功（skipIf offline）', async ({ page }) => {
    test.setTimeout(180_000);
    if (!(await ovxReachable(page))) {
      test.skip(true, '离线环境：OVX-05 依赖真网 open-vsx.org（CDN-04 cdnReachable 先例同策略）');
    }
    await page.goto('/');
    await openSettings(page);
    await gotoGroup(page, '外观');
    await page.getByLabel('从 Open VSX 安装颜色主题').fill('zhuangtongfa.material-theme');
    await ovxForm(page, '颜色主题').getByRole('button').click();
    await expect(page.locator('.vv-settings-note')).toHaveText(/已从 Open VSX 安装 \d+ 个主题/, { timeout: 120_000 });
    // 已导入列表出现 One Dark Pro 行（ODP 包多主题变体并列 → .first() 防 strict 冲突）
    await expect(page.locator('.vv-settings-theme', { hasText: 'One Dark' }).first()).toBeVisible();
  });
});
