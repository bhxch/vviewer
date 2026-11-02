import { test, expect, type Page } from '@playwright/test';
import { closeDrawerIfOpened, isDrawerViewport, openDrawerIfNarrow } from './drawer';

/**
 * 侧栏多根源头行 e2e 锚（SRC-01..04，侧栏多根 spec Task 4 收官）：
 * - SRC-01：源头行 chevron 折叠整源树——aria-expanded 翻转、该源组行收敛、他源不受影响
 * - SRC-02：源级移除钮键盘可达——Tab 聚焦后 :focus-within 揭示（computed opacity；
 *   toBeVisible 判定不含 opacity，对 opacity:0 恒真，不构成揭示断言）
 * - SRC-03：行右让位几何（§2.2 重叠修复）——侧栏折叠钮 .vv-collapse-left 与首个
 *   移除钮 boundingBox 手写相交判定（桌面视口锚；抽屉断点无中缝重叠面跳过）
 * - SRC-04：0 目录空态引导区（§2.3）——三入口控件可见可用、连接服务器就地展开
 *   ServerConnectForm；空态控件与 ⋯ 菜单同名同屏，定位一律限定 .vv-side-empty
 *   容器（不含真实连接/打开动作）
 *
 * 装置：本地源走 __vvOpenDirImpl 注入（b-filetree-src-remove 同款通道，label 决定
 * localfiles:<label> storeId）；空态用 Playwright 每用例新 context 的零来源天然形态。
 *
 * SRC-05..08（测绘差距新增锚，docs/e2e/sidebar-shell-actions.md §2.2）：徽标消歧
 * 真实渲染层（同名跨源才显 / title 属性 / url 未登记形态不对称 / 同名目录 tab 跨源
 * 参与消歧 / 大小写敏感）、单源统一形态（chevron + hover ✕ + 折叠）、hover 揭示
 * 完整链（显 1 / 移出回 0 / 触屏 hover:none 恒显）。remote 面走共享单根假服务
 * fake-file-server；url 语料 route 定态化（外网面禁入）。
 */

import { overflowConnectServer, plusOpenUrl } from './tabbar-actions';
import { startFakeFileServer } from './fake-file-server';
import { tabNamed } from './helpers';

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

test.describe('侧栏多根源头行（SRC-01..04）', () => {
  test('SRC-01：源头行折叠——aria-expanded 翻转、该源组行收敛、他源不受影响', async ({
    page
  }) => {
    await waitAppMounted(page);
    await openLocalDir(page, [{ name: 'a1.txt', content: 'a1 body\n' }], 'src-a');
    await openLocalDir(page, [{ name: 'b1.txt', content: 'b1 body\n' }], 'src-b');
    const drawer = await openDrawerIfNarrow(page);
    const toggleA = page.locator('.vv-tree-src', { hasText: 'src-a' }).locator('.vv-tree-src-toggle');
    const toggleB = page.locator('.vv-tree-src', { hasText: 'src-b' }).locator('.vv-tree-src-toggle');
    // 相邻兄弟组合器锚定「该源」的组行：折叠时组行卸载、紧邻变为他源行，不会误吞他源组
    const groupA = page.locator('.vv-tree-src:has-text("src-a") + .vv-tree-group');
    const groupB = page.locator('.vv-tree-src:has-text("src-b") + .vv-tree-group');
    await expect(toggleA).toHaveAttribute('aria-expanded', 'true');
    await expect(toggleB).toHaveAttribute('aria-expanded', 'true');
    await expect(groupA.locator('.vv-tree-row', { hasText: 'a1.txt' })).toBeVisible();
    await expect(groupB.locator('.vv-tree-row', { hasText: 'b1.txt' })).toBeVisible();

    await toggleA.click();
    await expect(toggleA).toHaveAttribute('aria-expanded', 'false');
    await expect(groupA).toHaveCount(0);
    await expect(toggleB).toHaveAttribute('aria-expanded', 'true');
    await expect(groupB.locator('.vv-tree-row', { hasText: 'b1.txt' })).toBeVisible();

    await toggleA.click();
    await expect(toggleA).toHaveAttribute('aria-expanded', 'true');
    await expect(groupA.locator('.vv-tree-row', { hasText: 'a1.txt' })).toBeVisible();
    await closeDrawerIfOpened(page, drawer);
  });

  test('SRC-02：移除钮键盘可达——Tab 聚焦后 :focus-within 揭示（computed opacity=1）', async ({
    page
  }) => {
    await waitAppMounted(page);
    await openLocalDir(page, [{ name: 'a1.txt', content: 'a1 body\n' }], 'src-a');
    const drawer = await openDrawerIfNarrow(page);
    const srcRow = page.locator('.vv-tree-src', { hasText: 'src-a' });
    const removeBtn = srcRow.locator('.vv-tree-src-remove');
    // 行内 Tab 序：toggle（button）→ 移除钮（label span 不入焦点链）
    await srcRow.locator('.vv-tree-src-toggle').focus();
    await page.keyboard.press('Tab');
    await expect(removeBtn).toBeFocused();
    await expect(removeBtn).toHaveCSS('opacity', '1');
    await closeDrawerIfOpened(page, drawer);
  });

  test('SRC-03：折叠钮与移除钮几何不重叠（§2.2 行右让位，桌面视口）', async ({ page }) => {
    await waitAppMounted(page);
    test.skip(await isDrawerViewport(page), '几何锚限定桌面视口：抽屉断点无中缝折叠钮重叠面');
    await openLocalDir(page, [{ name: 'a1.txt', content: 'a1 body\n' }], 'src-a');
    const collapseBox = await page.locator('.vv-collapse-btn.vv-collapse-left').boundingBox();
    const removeBox = await page.locator('.vv-tree-src-remove').first().boundingBox();
    expect(collapseBox).not.toBeNull();
    expect(removeBox).not.toBeNull();
    // 手写相交判定（无断言库依赖）：至少一轴分离即不相交（贴边不计交叠）
    const separated =
      collapseBox!.x + collapseBox!.width <= removeBox!.x ||
      removeBox!.x + removeBox!.width <= collapseBox!.x ||
      collapseBox!.y + collapseBox!.height <= removeBox!.y ||
      removeBox!.y + removeBox!.height <= collapseBox!.y;
    expect(separated).toBe(true);
  });

  test('SRC-04：0 目录空态引导区——三入口可见可用，连接服务器就地展开共享表单', async ({
    page
  }) => {
    await waitAppMounted(page); // 每用例新 context 零来源：天然空态
    const empty = page.locator('.vv-side-empty');
    await expect(empty).toBeVisible();
    await openDrawerIfNarrow(page);
    const openBtn = empty.getByRole('button', { name: '打开文件夹' });
    await expect(openBtn).toBeVisible();
    await expect(openBtn).toBeEnabled();
    await expect(empty.getByLabel('文件 URL')).toBeVisible();
    // 空态「连接服务器」与 ⋯ 菜单同名同屏：限定 .vv-side-empty 容器
    await empty.getByRole('button', { name: '连接服务器' }).click();
    await expect(empty.locator('.vv-server-form')).toBeVisible();
  });
});

// ---------------------------------------------------------------- SRC-05..08

test.describe('侧栏多根测绘差距（SRC-05..08）', () => {
  /** 组作用域树行点击开文件（同名文件跨组消歧——readme.md 在两组各一行；
   * Playwright hasText 字符串匹配大小写不敏感，组作用域是唯一消歧手段） */
  async function openFileInGroup(page: Page, label: string, name: string): Promise<void> {
    const drawer = await openDrawerIfNarrow(page);
    await page
      .locator(`.vv-tree-src:has-text("${label}") + .vv-tree-group`)
      .locator('.vv-tree-row', { hasText: name })
      .click();
    await closeDrawerIfOpened(page, drawer);
    await expect(tabNamed(page, name).first()).toBeVisible({ timeout: 20_000 });
  }

  /** SRC-05 装置（场景表前置条件）：双本地源 src-a/src-b 各含同名 readme.md +
   * 异名文件，两组树行各开同名 readme tab */
  async function seedConflictPair(page: Page): Promise<void> {
    await waitAppMounted(page);
    await openLocalDir(
      page,
      [
        { name: 'readme.md', content: 'src-a readme\n' },
        { name: 'a1.txt', content: 'a1 body\n' }
      ],
      'src-a'
    );
    await openLocalDir(
      page,
      [
        { name: 'readme.md', content: 'src-b readme\n' },
        { name: 'b1.txt', content: 'b1 body\n' }
      ],
      'src-b'
    );
    await openFileInGroup(page, 'src-a', 'readme.md');
    await openFileInGroup(page, 'src-b', 'readme.md');
  }

  test('SRC-05：同名跨源消歧——双源同名 tab 都显徽标（文本=title=storeLabel），异名对不显', async ({
    page
  }) => {
    await seedConflictPair(page);
    await openFileInGroup(page, 'src-a', 'a1.txt');
    await openFileInGroup(page, 'src-b', 'b1.txt');

    // ① 同名对都显徽标：文本 = title 属性 = 各自 storeLabel（TabBar.svelte:313
    //    title={badge}；开序决定 DOM 序 nth(0)=src-a 件、nth(1)=src-b 件）
    const badgeA = tabNamed(page, 'readme.md').nth(0).locator('.vv-tab-src');
    const badgeB = tabNamed(page, 'readme.md').nth(1).locator('.vv-tab-src');
    await expect(badgeA).toHaveText('src-a');
    await expect(badgeA).toHaveAttribute('title', 'src-a');
    await expect(badgeB).toHaveText('src-b');
    await expect(badgeB).toHaveAttribute('title', 'src-b');

    // ② 对照面：异名对 a1.txt/b1.txt 不显徽标（消歧语义：仅同名冲突才显，
    //    tabBadge.ts:21-24）；两组目录 tab 名异亦不冲突——全场恰 2 枚
    await expect(tabNamed(page, 'a1.txt').locator('.vv-tab-src')).toHaveCount(0);
    await expect(tabNamed(page, 'b1.txt').locator('.vv-tab-src')).toHaveCount(0);
    await expect(page.locator('.vv-tab-src')).toHaveCount(2);
  });

  test('SRC-05/remote：URL 单文件来源同名同屏不对称——url tab 无徽标、本地同名对手徽标在场', async ({
    page
  }) => {
    // url 语料 route 定态化（外网面禁入）：openUrl → createUrlStore 拉流走本地 fulfill
    await page.route('**/fake.src.test/readme.md', (route) =>
      route.fulfill({ contentType: 'text/plain; charset=utf-8', body: 'url readme body\n' })
    );
    await seedConflictPair(page);

    // ＋ 菜单「粘贴 URL」开同名 readme.md（场景表指定 openUrl 通道既有先例装置）：
    // url 文件 tab 不登记 workspace 来源（TabCollection.add 无 addSource 面）——
    // 徽标名册外的单文件形态无徽标，且不清掉本地对手对的冲突计数（对手对称性保持）
    await plusOpenUrl(page, 'https://fake.src.test/readme.md');
    const urlTab = tabNamed(page, 'readme.md').nth(2);
    await expect(urlTab).toBeVisible();
    await expect(urlTab.locator('.vv-tab-src')).toHaveCount(0);
    await expect(tabNamed(page, 'readme.md').nth(0).locator('.vv-tab-src')).toHaveText('src-a');
    await expect(tabNamed(page, 'readme.md').nth(1).locator('.vv-tab-src')).toHaveText('src-b');
  });

  test('SRC-05/dir：同名目录 tab 跨源同样消歧——remote 目录 tab（path=\'\'）不触发单文件抑制', async ({
    page
  }) => {
    const fake = await startFakeFileServer({ files: {} });
    try {
      await waitAppMounted(page);
      // 同 label 跨源唯一合法构造：localfiles 同 label 二次注入会路由回原组（FTSRC-04
      // 裁决），须 local + remote 异 storeId——本地组 label 取假服务 host，remote 根源
      // storeLabel = serverLabel(base) = host，两侧目录 tab（path=''，name=displayName）
      // 同名异 storeId（场景表 §4 同 label 构造口径）
      await openLocalDir(page, [{ name: 'note.txt', content: 'local note\n' }], fake.host);
      await overflowConnectServer(page);
      await page.getByLabel('服务器地址').fill(fake.base);
      await page.getByRole('button', { name: '连接', exact: true }).click();
      await expect(tabNamed(page, fake.host)).toHaveCount(2, { timeout: 15_000 }); // 双目录 tab 同屏

      // 双方均显徽标：文本 = title = host（=两侧 storeLabel）；remote 抑制仅文件 tab
      // 形态（tabBadge.ts:27 path!=='' 门），目录 tab path==='' 不抑制（:11-14 注释口径）
      const badges = page.locator('.vv-tab-src');
      await expect(badges).toHaveCount(2);
      await expect(badges.nth(0)).toHaveText(fake.host);
      await expect(badges.nth(0)).toHaveAttribute('title', fake.host);
      await expect(badges.nth(1)).toHaveText(fake.host);
      await expect(badges.nth(1)).toHaveAttribute('title', fake.host);
    } finally {
      await fake.close();
    }
  });

  test('SRC-06：大小写敏感消歧基准名——A.md 与 a.md 跨源不构冲突，双 tab 零徽标', async ({
    page
  }) => {
    await waitAppMounted(page);
    await openLocalDir(page, [{ name: 'A.md', content: 'upper case body\n' }], 'src-a');
    await openLocalDir(page, [{ name: 'a.md', content: 'lower case body\n' }], 'src-b');
    await openFileInGroup(page, 'src-a', 'A.md');
    await openFileInGroup(page, 'src-b', 'a.md');
    // 开档自证：严格正则定位下两 tab 各一（大小写确为异名 tab 而非同名重复）
    await expect(tabNamed(page, 'A.md')).toHaveCount(1);
    await expect(tabNamed(page, 'a.md')).toHaveCount(1);
    // 基准名 = tab.source.name 原样严格 ===（tabBadge.ts:22，spec §2.4 有意语义）：
    // 大小写异名不触发消歧——casefold 回归在此翻红
    await expect(page.locator('.vv-tab-src')).toHaveCount(0);
  });

  test('SRC-07：单源统一形态（spec §2.1）——chevron 初值、hover ✕ 揭示、折叠收敛复点恢复', async ({
    page
  }) => {
    await waitAppMounted(page);
    await openLocalDir(page, [{ name: 'solo.txt', content: 'solo body\n' }], 'solo-src');
    const drawer = await openDrawerIfNarrow(page);
    // 单源不是「多源专用 UI」的特化分支：恰一行、同款三段式（chevron + label + hover ✕）
    await expect(page.locator('.vv-tree-src')).toHaveCount(1);
    const srcRow = page.locator('.vv-tree-src', { hasText: 'solo-src' });
    const toggle = srcRow.locator('.vv-tree-src-toggle');
    const removeBtn = srcRow.locator('.vv-tree-src-remove');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(removeBtn).toBeVisible();
    await srcRow.hover();
    await expect(removeBtn).toHaveCSS('opacity', '1');
    // 折叠生命周期（相邻兄弟组合器锚定该源组行，SRC-01 同款选择器）
    const group = page.locator('.vv-tree-src:has-text("solo-src") + .vv-tree-group');
    await expect(group.locator('.vv-tree-row', { hasText: 'solo.txt' })).toBeVisible();
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(group).toHaveCount(0);
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(group.locator('.vv-tree-row', { hasText: 'solo.txt' })).toBeVisible();
    await closeDrawerIfOpened(page, drawer);
  });

  test('SRC-08：hover 揭示完整链——悬停显 1、移出回 0、触屏形态（hover:none）恒显', async ({
    page
  }) => {
    await waitAppMounted(page);
    test.skip(await isDrawerViewport(page), '场景表限定桌面视口：抽屉断点无独立 hover 揭示面（SRC-03 同口径）');
    await openLocalDir(page, [{ name: 'solo.txt', content: 'solo body\n' }], 'src-a');
    const srcRow = page.locator('.vv-tree-src', { hasText: 'src-a' });
    const removeBtn = srcRow.locator('.vv-tree-src-remove');
    // ① hover 揭示 opacity 1（FileTree.svelte:147-148）
    await srcRow.hover();
    await expect(removeBtn).toHaveCSS('opacity', '1');
    // ② 移出源行（主区右下空白）：.12s transition 落定后回 0（:144-145；toHaveCSS
    //    自动重试吸收过渡中间帧，FTSRC 装置只锚了「移除前 hover 显 1」半链，此处补全）
    const vp = page.viewportSize();
    expect(vp).not.toBeNull();
    await page.mouse.move(vp!.width - 6, vp!.height - 6);
    await expect(removeBtn).toHaveCSS('opacity', '0');
    // ③ 触屏形态 @media(hover:none) 恒显（:151-153）：desktop chromium 默认 hover:hover
    //    断言不到——CDP setEmulatedMedia 的 hover 特征模拟对 Blink 静默无效（探针实证
    //    matchMedia 不翻转），触屏模拟通道 setTouchEmulationEnabled 才翻转 hover/pointer
    //    媒介特征；不支持的环境 skip 备案（真 skip 先例 SRC-03，本文件 :100；
    //    FTSRC :55-56 为注释口径无 skip 实装）。skip 判定置于 ①② 之后：环境缺失
    //    只豁免 ③，揭示/回零主链照常受锚
    let touchForm = false;
    try {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
      touchForm = await page.evaluate(() => window.matchMedia('(hover: none)').matches);
    } catch {
      touchForm = false;
    }
    test.skip(!touchForm, '当前环境不支持触屏模拟，hover:none 恒显形态断言不到——备案');
    await expect(removeBtn).toHaveCSS('opacity', '1'); // 无 hover（指针在右下空白）仍恒显
  });
});
