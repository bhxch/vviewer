import { test, expect, type Page, type Route } from '@playwright/test';
import { PIXEL_PNG_B64, injectDir, openTreeFile } from './b-markdown-html-docs-helpers';
import { closeDrawerIfOpened, openDrawerIfNarrow } from './drawer';
import { tabNamed } from './helpers';
import { applySettings, closeSettings, gotoGroup, openSettings } from './settings-center';

/**
 * b-markdown-links-media — spec D（markdown 外链媒体三档放行 + 相对链接站内导航）e2e 锚批：
 * - MDX- 外链媒体域（spec §4 ①②）：
 *   MDX-01 默认 manual 档占位与防线（外域请求 0 判据 + 占位形态元素级断言，五类向量
 *   同观察窗承防——元素级剥除矩阵由 sanitizeHtml/markdownSanitize 单测承接，e2e 不重复落笔）
 *   MDX-02 点击「加载图片」放行（防线时序判据：放行前零/放行后恰 1 条外域请求）
 *   MDX-03 blocked/auto 档与白名单优先（每档独立 test，设置中心 Markdown 组 UI 管线
 *   应用后重开文件重渲染——设置变更不回溯重渲已打开文档）
 * - MDL- 相对链接域（spec §4 ③④）：装置按计划评审 ② 修正——链接须从子目录文件出发
 *   才能命中（根文件 ../ 弹空越根返回 null），injectDir 子路径经 localFiles store
 *   rel 剥根建树（core localFiles.ts:27-38 实查）
 *   MDL-01 同目录/上级/hash 形态新 tab 打开（hash 跨文件 fragment 丢弃不定位，§6 落定 4）
 *   MDL-02 缺失目标状态栏提示（期望串含完整解析路径 sub/missing.md——opener 不取
 *   basename，T5 Interfaces 锁口径；计划评审二轮 ①）
 *   MDL-03 不接管面：外域/页内锚无 data-vv-rel-link（分类面断言，不实点外域防导航离场）
 *   MDL-04 wikilink 升级可点（[[b]] 裸名经 .md 变体探测命中 b.md）
 */

/** 外域请求收集器（t-md BUG-40 同款 inline 形态：request 事件发起即触发，不依赖响应） */
function trackExternal(page: Page): string[] {
  const urls: string[] = [];
  page.on('request', (req) => {
    if (req.url().includes('external.example')) urls.push(req.url());
  });
  return urls;
}

const V = 'http://external.example.com';

/** MDX-01 装置内容：外域 img + 五类等价向量（t-md BUG-40 content 同款语料形态） */
function vectorsContent(): string {
  return [
    `<img alt="plain" src="${V}/pic.png">`,
    '',
    `<video controls poster="${V}/poster.jpg"></video>`,
    '',
    `<svg><image href="${V}/svg-img.png"></image><image xlink:href="${V}/svg-xlink.png"></image></svg>`,
    '',
    `<div style="background:url(${V}/bg.png)">行内样式 url 外联</div>`,
    '',
    `<table background="${V}/tbg.png"><tr><td>表格背景外联</td></tr></table>`,
    '',
    `<p><input type="image" src="${V}/input.png" alt="input 外联"></p>`,
    ''
  ].join('\n');
}

/** 设置中心「Markdown」组：外链图片档位切换（UI 管线应用后落盘） */
async function setExternalImages(page: Page, policy: 'blocked' | 'manual' | 'auto'): Promise<void> {
  await openSettings(page);
  await gotoGroup(page, 'Markdown');
  await page.getByLabel('外链图片加载策略').selectOption(policy);
  await applySettings(page);
  await closeSettings(page);
}

/** 设置中心「Markdown」组：blocked 档 + 域名白名单逐条添加（chip 列表） */
async function setBlockedWithAllowlist(page: Page, domains: string[]): Promise<void> {
  await openSettings(page);
  await gotoGroup(page, 'Markdown');
  await page.getByLabel('外链图片加载策略').selectOption('blocked');
  const input = page.getByLabel('白名单域名输入');
  for (const d of domains) {
    await input.fill(d);
    await page.locator('form.vv-settings-add').getByRole('button', { name: '添加' }).click();
  }
  await applySettings(page);
  await closeSettings(page);
}

/** 树内子目录文件打开：目录行展开（TreeNodeRow 默认折叠）→ 文件行点击 */
async function openNestedTreeFile(page: Page, dir: string, name: string): Promise<void> {
  const drawer = await openDrawerIfNarrow(page);
  await page.locator('.vv-tree-row', { hasText: dir }).first().click();
  await page.locator('.vv-tree-row', { hasText: name }).click();
  await closeDrawerIfOpened(page, drawer);
  await expect(page.locator('.vv-tab.active', { hasText: name })).toBeVisible();
}

test.describe('b-markdown-links-media 外链媒体域（MDX）', () => {
  test('MDX-01 默认 manual 档：外域请求 0（观察窗判据）+ 占位构建元素级断言（含五类向量同窗防线）', async ({
    page
  }) => {
    const external = trackExternal(page); // 监听先于注入装载（t-md BUG-40 同款时序）
    await injectDir(page, [{ name: 'mdx01-vectors.md', content: vectorsContent() }]);
    await openTreeFile(page, 'mdx01-vectors.md');
    const md = page.locator('.vv-markdown');
    await expect(md).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(1_500); // 网络观察窗：覆盖属性加载触发的外域请求
    expect(external).toEqual([]); // manual 档下 DOM 无 src 即不发请求（BUG-17 防线真实维持）

    // 占位形态元素级断言（enrich buildExternalMediaPlaceholders 产出面）
    const img = md.locator('img[alt="plain"]');
    await expect(img).not.toHaveAttribute('src'); // DOM 无 src=不发请求的 DOM 判据
    await expect(img).toHaveAttribute('data-vv-external-src', `${V}/pic.png`); // 原值迁移
    await expect(img).toHaveAttribute('data-vv-blocked-external', '1');
    await expect(img).toHaveAttribute('title', '已拦截外部图片：external.example.com');
    const wrap = md.locator('.md-ext-media');
    await expect(wrap).toBeVisible();
    const btn = md.locator('.md-ext-media-load');
    await expect(btn).toHaveCount(1);
    await expect(btn).toHaveText('加载图片');
    await expect(page.locator('.vv-error-card')).toHaveCount(0);
  });

  test('MDX-02 点击「加载图片」放行：route fulfill + 外域请求恰 1 条（放行前零/放行后一的防线时序）', async ({
    page
  }) => {
    await page.route('**external.example.com**/pic.png', (route: Route) =>
      route.fulfill({
        status: 200,
        headers: { 'content-type': 'image/png' },
        body: Buffer.from(PIXEL_PNG_B64, 'base64')
      })
    );
    const external = trackExternal(page);
    await injectDir(page, [{ name: 'mdx02-load.md', content: `![外域图](${V}/pic.png)` }]);
    await openTreeFile(page, 'mdx02-load.md');
    const md = page.locator('.vv-markdown');
    await expect(md.locator('.md-ext-media-load')).toBeVisible({ timeout: 20_000 });
    expect(external).toEqual([]); // 放行前零请求
    await md.locator('.md-ext-media-load').click();

    // 放行后：src 回填 → 恰 1 条外域请求（防线下界；双击防抖+解包后无第二来源）
    await expect(md.locator('img')).toHaveAttribute('src', `${V}/pic.png`);
    await expect(md.locator('img')).toBeVisible(); // wrapper 解包后 img 不再 CSS 隐藏
    await expect(md.locator('.md-ext-media')).toHaveCount(0); // 解包
    await expect(md.locator('img')).not.toHaveAttribute('data-vv-external-src');
    await expect(md.locator('img')).not.toHaveAttribute('data-vv-blocked-external');
    await expect
      .poll(() => external.length, { timeout: 10_000 })
      .toBe(1);
  });

  test('MDX-03① blocked 档：占位仍在（无按钮）+ 零请求（applySettings 后重开文件重渲染）', async ({
    page
  }) => {
    await injectDir(page, [{ name: 'mdx03-blocked.md', content: `![外域图](${V}/pic.png)` }]);
    await setExternalImages(page, 'blocked');
    const external = trackExternal(page);
    await openTreeFile(page, 'mdx03-blocked.md');
    const md = page.locator('.vv-markdown');
    await expect(md).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(1_500);
    expect(external).toEqual([]);
    const img = md.locator('img');
    await expect(img).not.toHaveAttribute('src');
    await expect(img).toHaveAttribute('data-vv-blocked-external', '1'); // BLOCKED_EXTERNAL_CSS 虚线占位形态
    await expect(img).toBeVisible();
    await expect(md.locator('.md-ext-media')).toHaveCount(0);
    await expect(md.locator('.md-ext-media-load')).toHaveCount(0);
  });

  test('MDX-03② blocked + 白名单：命中域名 src 在场直接可见（白名单优先于档位，route fulfill）', async ({
    page
  }) => {
    await page.route('**external.example.com**/pic.png', (route: Route) =>
      route.fulfill({
        status: 200,
        headers: { 'content-type': 'image/png' },
        body: Buffer.from(PIXEL_PNG_B64, 'base64')
      })
    );
    await injectDir(page, [{ name: 'mdx03-allow.md', content: `![外域图](${V}/pic.png)` }]);
    await setBlockedWithAllowlist(page, ['external.example.com']);
    await openTreeFile(page, 'mdx03-allow.md');
    const md = page.locator('.vv-markdown');
    const img = md.locator('img');
    await expect(img).toHaveAttribute('src', `${V}/pic.png`);
    await expect(img).toBeVisible(); // 直接加载（无占位无确认）
    await expect(img).not.toHaveAttribute('data-vv-blocked-external');
    await expect(img).not.toHaveAttribute('data-vv-external-src');
    await expect(md.locator('.md-ext-media')).toHaveCount(0);
    await expect(md.locator('.md-ext-media-load')).toHaveCount(0);
  });

  test('MDX-03③ auto 档：src 在场零按钮零占位（钩子 IMG 分支直接放行）', async ({
    page
  }) => {
    await injectDir(page, [{ name: 'mdx03-auto.md', content: `![外域图](${V}/pic.png)` }]);
    await setExternalImages(page, 'auto');
    await openTreeFile(page, 'mdx03-auto.md');
    const md = page.locator('.vv-markdown');
    const img = md.locator('img');
    await expect(img).toHaveAttribute('src', `${V}/pic.png`);
    await expect(img).not.toHaveAttribute('data-vv-blocked-external');
    await expect(img).not.toHaveAttribute('data-vv-external-src');
    await expect(md.locator('.md-ext-media')).toHaveCount(0);
    await expect(md.locator('.md-ext-media-load')).toHaveCount(0);
  });
});

test.describe('b-markdown-links-media 相对链接域（MDL）', () => {
  /** MDL 装置（计划评审 ② 修正形态）：自子目录文件出发——根文件 ../ 弹空越根
   * 返回 null（markdownImages.ts:27-29），链接须命中须从 sub/a.md 出发；
   * 第四链接 [x](./missing.md) 供 MDL-02 缺失用例（missing.md 不注入）；
   * 外域/页内锚两链接供 MDL-03 不接管面分类断言。 */
  const INDEX_MD = [
    '# 目录页 a',
    '',
    '[b](./b.md) · [up](../sub/b.md) · [c](c.md#frag) · [x](./missing.md)',
    '',
    '[外域](https://example.org/page) · [锚](#目录页-a)',
    ''
  ].join('\n');
  const B_MD = '# 页面 b\n\n这是 b 的正文内容锚。\n';
  const C_MD = '# 页面 c\n\nc 的正文内容。\n';

  async function injectIndex(page: Page): Promise<void> {
    await injectDir(page, [
      { name: 'sub/a.md', content: INDEX_MD },
      { name: 'sub/b.md', content: B_MD },
      { name: 'sub/c.md', content: C_MD }
    ]);
    await openNestedTreeFile(page, 'sub', 'a.md');
  }

  test('MDL-01 同目录/上级/hash 形态：站内导航新 tab 打开且渲染目标内容', async ({ page }) => {
    await injectIndex(page);
    const md = page.locator('.vv-markdown');
    await expect(md).toBeVisible({ timeout: 20_000 });
    // 注入装置自开目录 tab（addDirStoreTab）：计数断言取打开前基线做相对比较
    const tabsBefore = await page.locator('.vv-tab').count();

    // [b](./b.md) → sub/b.md：新 tab 激活且渲染 b.md 内容（addTab 恒新建语义）
    await md.getByRole('link', { name: 'b', exact: true }).click();
    await expect(tabNamed(page, 'b.md')).toBeVisible();
    await expect(page.locator('.vv-tab')).toHaveCount(tabsBefore + 1);
    await expect(page.locator('.vv-markdown')).toContainText('这是 b 的正文内容锚');

    // [up](../sub/b.md) → ../ 弹回根再入 sub = sub/b.md：切回 a.md 后点击，新 tab 内容同为 b.md
    await tabNamed(page, 'sub/a.md').click();
    await md.getByRole('link', { name: 'up', exact: true }).click();
    await expect(page.locator('.vv-tab')).toHaveCount(tabsBefore + 2);
    await expect(page.locator('.vv-tab.active', { hasText: 'b.md' })).toBeVisible();
    await expect(page.locator('.vv-markdown')).toContainText('这是 b 的正文内容锚');

    // [c](c.md#frag) → sub/c.md（hash 丢弃）：打开即成（跨文件 fragment hash 不定位，
    // §6 落定 4——无锚滚动行为断言，记档不硬断）
    await tabNamed(page, 'sub/a.md').click();
    await md.getByRole('link', { name: 'c', exact: true }).click();
    await expect(page.locator('.vv-tab.active', { hasText: 'c.md' })).toBeVisible();
    await expect(page.locator('.vv-tab')).toHaveCount(tabsBefore + 3);
    await expect(page.locator('.vv-markdown')).toContainText('c 的正文内容');
    await expect(page.locator('.vv-error-card')).toHaveCount(0);
  });

  test('MDL-02 缺失目标：状态栏提示含完整解析路径 sub/missing.md（opener 不取 basename）', async ({
    page
  }) => {
    await injectIndex(page);
    const md = page.locator('.vv-markdown');
    await expect(md).toBeVisible({ timeout: 20_000 });
    const tabsBefore = await page.locator('.vv-tab').count();
    await md.getByRole('link', { name: 'x', exact: true }).click();
    await expect(page.locator('.vv-statusbar')).toContainText('目标不存在：sub/missing.md');
    // 缺失目标不开新 tab（仅提示）
    await expect(page.locator('.vv-tab')).toHaveCount(tabsBefore);
    await expect(page.locator('.vv-error-card')).toHaveCount(0);
  });

  test('MDL-03 不接管面：外域/页内锚无 data-vv-rel-link（分类面断言，不实点外域防导航离场）', async ({
    page
  }) => {
    await injectIndex(page);
    const md = page.locator('.vv-markdown');
    await expect(md).toBeVisible({ timeout: 20_000 });
    // 相对链接已接管（分类命中：b/up/c/missing 四相对链接）
    await expect(md.locator('a[data-vv-rel-link]')).toHaveCount(4);
    // 外域与页内锚不接管（isRelativeLinkHref 分类不命中——spec §3.2；反向选择器
    // 断言避并 heading 自产 a.anchor 同前缀干扰）
    const externalA = md.locator('a[href="https://example.org/page"]');
    await expect(externalA).toBeVisible();
    await expect(externalA).not.toHaveAttribute('data-vv-rel-link');
    await expect(md.locator('a[href^="#"][data-vv-rel-link]')).toHaveCount(0);
  });

  test('MDL-04 wikilink 升级可点：[[b]] 裸名经 .md 变体探测打开 b.md（升级后 a.md-wikilink 保 raw 文本）', async ({
    page
  }) => {
    await injectDir(page, [
      { name: 'wiki.md', content: '正文含 [[b]] 与 [[b|别名]] 两个跨文件 wikilink。\n' },
      { name: 'b.md', content: B_MD }
    ]);
    await openTreeFile(page, 'wiki.md');
    const md = page.locator('.vv-markdown');
    await expect(md).toBeVisible({ timeout: 20_000 });
    // 死链 span 升级为 a.md-wikilink（textContent=raw 维持、data-wikilink-path 恒写）
    await expect(md.locator('span.md-wikilink-dead')).toHaveCount(0);
    const wikis = md.locator('a.md-wikilink');
    await expect(wikis).toHaveCount(2);
    await expect(wikis.nth(0)).toHaveText('[[b]]');
    await expect(wikis.nth(1)).toHaveText('[[b|别名]]');
    await expect(wikis.nth(0)).toHaveAttribute('data-wikilink-path', 'b');
    // 点击裸名 wikilink → .md 变体探测命中 b.md → 新 tab 打开
    await wikis.nth(0).click();
    await expect(tabNamed(page, 'b.md')).toBeVisible();
    await expect(page.locator('.vv-markdown')).toContainText('这是 b 的正文内容锚');
    await expect(page.locator('.vv-error-card')).toHaveCount(0);
  });
});
