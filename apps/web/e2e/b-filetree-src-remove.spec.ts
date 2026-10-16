import { test, expect, type Page } from '@playwright/test';
import { closeDrawerIfOpened, openDrawerIfNarrow } from './drawer';
import { startFakeFileServer } from './fake-file-server';

/**
 * 文件树源级移除全链（FTSRC-01..04，docs/e2e/filetree-src-remove.md；富化第三轮）。
 * 源级移除是文件树唯一源级操作（FileTree.svelte requestRemove confirm → AppShell
 * removeSource：关该组内该源全部 tab + workspaceStore.removeSource），e2e 此前零覆盖
 * （.vv-tree-src-remove 全仓零命中）。组内移除语义（AppShell 注释在案）：其他 workspace
 * 若共享同一 storeId 不受影响。
 *
 * 装置：本地源走 __vvOpenDirImpl 注入（label 决定 localfiles:<label> storeId）；
 * remote 走共享单根假服务 fake-file-server（审计 R1 M-2 下沉，quickopen 同款）。
 */

async function waitAppMounted(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(
    () => typeof (window as unknown as { __vvOpenDirImpl?: unknown }).__vvOpenDirImpl === 'function'
  );
  await expect(page.locator('.vv-topbar')).toBeVisible();
}

async function openLocalDir(page: Page, files: Array<{ name: string; content: string }>, label: string): Promise<void> {
  await page.evaluate(({ list, label }) => {
    const fs = list.map(({ name, content }) => {
      const f = new File([content], name, { type: 'text/plain' });
      Object.defineProperty(f, 'webkitRelativePath', { value: `${label}/${name}` });
      return f;
    });
    return (window as unknown as { __vvOpenDirImpl: (f: File[]) => void }).__vvOpenDirImpl(fs);
  }, { list: files, label });
}

async function connectForm(page: Page, base: string): Promise<void> {
  await page.getByRole('button', { name: '连接服务器' }).click();
  await page.getByLabel('服务器地址').fill(base);
  await page.getByRole('button', { name: '连接', exact: true }).click();
}

/** 树行点击（mobile 375px 树区在抽屉内：openDrawerIfNarrow 适配，T4a 先例同款） */
async function clickTreeRow(page: Page, name: string): Promise<void> {
  const drawer = await openDrawerIfNarrow(page);
  await page.locator('.vv-tree-row', { hasText: name }).click();
  await closeDrawerIfOpened(page, drawer);
}

async function removeSource(page: Page, label: string, accept: boolean): Promise<void> {
  const pendingDialog = page.waitForEvent('dialog').then((d) => {
    expect(d.message(), 'confirm 文案声明连带关 tab 语义').toContain('将关闭该来源下全部 tab');
    void (accept ? d.accept() : d.dismiss());
  });
  const drawer = await openDrawerIfNarrow(page);
  await page.locator('.vv-tree-src', { hasText: label }).locator('.vv-tree-src-remove').click();
  await pendingDialog;
  await closeDrawerIfOpened(page, drawer);
}

/** 断言活动工作区（b-wsx-recovery expectActiveWorkspace 同款：窄视口触发钮恒显
 * 「工作区 ▾」，经下拉活动行核对后 Esc 还原；宽视口直读触发钮文案） */
const WS_TRIGGER_NARROW_MQ = '(max-width: 600px)';

async function expectActiveWorkspace(page: Page, name: string): Promise<void> {
  if (await page.evaluate((mq) => window.matchMedia(mq).matches, WS_TRIGGER_NARROW_MQ)) {
    await page.locator('.vv-ws-trigger').click();
    await expect(page.locator('.vv-ws-item.active', { hasText: name })).toBeVisible();
    await page.keyboard.press('Escape');
    return;
  }
  await expect(page.locator('.vv-ws-trigger')).toContainText(name);
}

test.describe('文件树源级移除（FTSRC-01..04）', () => {
  test('FTSRC-01/03：confirm 接受——该源 tab 全关 + 源标签消失；同组他源 tab 与标签保留', async ({ page }) => {
    const fake = await startFakeFileServer({ rootPath: '/ft-root', files: { 'hello-remote.txt': 'remote body\n' } });
    try {
      await waitAppMounted(page);
      await openLocalDir(page, [{ name: 'alpha-local.txt', content: 'local alpha\n' }], 'ftsrc-local');
      await connectForm(page, fake.base);
      // 两源各开一个 tab（树行点击；本地行 + remote 行）
      await clickTreeRow(page, 'alpha-local.txt');
      await expect(page.locator('.vv-tab', { hasText: 'alpha-local.txt' })).toBeVisible();
      await clickTreeRow(page, 'hello-remote.txt');
      await expect(page.locator('.vv-tab', { hasText: 'hello-remote.txt' })).toBeVisible();
      // 接受 confirm：移除 remote 源
      await removeSource(page, fake.host, true);
      // 该源 tab 全关 + 源标签消失
      await expect(page.locator('.vv-tab', { hasText: 'hello-remote.txt' })).toHaveCount(0);
      await expect(page.locator('.vv-tree-src', { hasText: fake.host })).toHaveCount(0);
      // 同组他源保留（FTSRC-03）：本地源 tab 在、标签在
      await expect(page.locator('.vv-tab', { hasText: 'alpha-local.txt' })).toBeVisible();
      await expect(page.locator('.vv-tree-src', { hasText: 'ftsrc-local' })).toBeVisible();
    } finally {
      await fake.close();
    }
  });

  test('FTSRC-02：confirm 取消——tab 与源标签均不动', async ({ page }) => {
    const fake = await startFakeFileServer({ rootPath: '/ft-root', files: { 'hello-remote.txt': 'remote body\n' } });
    try {
      await waitAppMounted(page);
      await openLocalDir(page, [{ name: 'alpha-local.txt', content: 'local alpha\n' }], 'ftsrc-local');
      await connectForm(page, fake.base);
      await clickTreeRow(page, 'hello-remote.txt');
      await expect(page.locator('.vv-tab', { hasText: 'hello-remote.txt' })).toBeVisible();
      await removeSource(page, fake.host, false);
      await expect(page.locator('.vv-tab', { hasText: 'hello-remote.txt' })).toBeVisible();
      await expect(page.locator('.vv-tree-src', { hasText: fake.host })).toBeVisible();
    } finally {
      await fake.close();
    }
  });

  test('FTSRC-04：跨组同 storeId 并存在当前 UI 不可达（openDir 路由回原组）——组内移除保护为防御性', async ({ page }) => {
    // 裁决记录（spec §2 预授权降级路径 + 实测结论）：localfiles 同 label 二次注入经
    // addDirStoreTab existing 分支路由回原组（setActive 原组 + 激活既有目录 tab），
    // 新组不产生重复源——「他组同 storeId 不受影响」的组内移除保护（AppShell
    // removeSource 注释在案）在当前 UI 无自然触发面，属防御性实现。本用例锚定该
    // 路由行为本身（行为变更须经评审）。
    const fake = await startFakeFileServer({ rootPath: '/ft-root', files: {} });
    try {
      await waitAppMounted(page);
      await openLocalDir(page, [{ name: 'shared-file.txt', content: 'shared body\n' }], 'shared-src');
      await expect(page.locator('.vv-tree-src', { hasText: 'shared-src' })).toBeVisible();
      // 新建工作区 ftsrc-group-b（创建即激活；b-wsx-recovery createWorkspace 同款）
      await page.locator('.vv-ws-trigger').click();
      await page.getByRole('button', { name: '＋ 新建工作区…' }).click();
      const modal = page.locator('.vv-wscreate');
      await expect(modal).toBeVisible();
      await page.getByLabel('工作区名称').fill('ftsrc-group-b');
      await modal.getByRole('button', { name: '创建并激活' }).click();
      await expect(modal).toHaveCount(0);
      // 组 B 内二次同 label 注入：路由回原组（默认）——不产生重复源
      await openLocalDir(page, [{ name: 'shared-file.txt', content: 'shared body\n' }], 'shared-src');
      await expectActiveWorkspace(page, '默认');
      await expect(page.locator('.vv-tree-src', { hasText: 'shared-src' })).toBeVisible();
      await expect(page.locator('.vv-tab', { hasText: 'shared-src' })).toBeVisible(); // 既有目录 tab 激活
      // 组 B 仍空（无重复源）
      await page.locator('.vv-ws-trigger').click();
      await page.locator('.vv-ws-name', { hasText: 'ftsrc-group-b' }).click();
      await expect(page.locator('main')).toContainText('拖入文件');
    } finally {
      await fake.close();
    }
  });
});
