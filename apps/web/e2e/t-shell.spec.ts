import { readFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { test, expect, type Page } from '@playwright/test';
import { closeDrawerIfOpened, openDrawerIfNarrow } from './drawer';

/**
 * app-shell-sources 域缺口补齐（docs/e2e/app-shell-sources.md，t- 前缀标记本轮新增）。
 * 既有 b-app-shell-sources.spec.ts 已覆盖 SHELL-01②/03②/05/08/09①/11/12①/13 的编号用例，
 * 本文件只补缺口分析（2026-10-10）指出的断言弱项与无用例场景：
 * - SHELL-01①：sort-demo 树序（目录优先 + a2<a10 自然排序）
 * - SHELL-02：两文件追加 tab 接管激活、原 tab 保留、内容不串扰
 * - SHELL-03①：合成 drop（DataTransfer）通道新建 tab 渲染 + 无扩展名 drop 不被拒
 * - SHELL-04：文件 URL 三路径（有效渲染 / 404 / CORS 失败原因提示）
 * - SHELL-06：3 tab 切换内容跟随、逐个关闭递减、全关空态；目录 tab 追加/去重
 *   语义（workspace T3：废除替换扫描——第二文件夹为追加、同 storeId 激活既有）
 * - SHELL-07：test.fixme 占位（headless 无法驱动 FS Access 原生 picker/requestPermission）
 * - SHELL-09②：排除规则跨刷新持久——重载后重建树仍排除（设置面板回显持久已由既有用例覆盖）
 * - SHELL-10：800px 平板段树抽屉 + 右栏内联；550px 双抽屉独立开合
 * - SHELL-12②：UTF-8 BOM 中文件编码段；视频状态栏大小段
 * - SHELL-13①：计算策略 UI 修改落盘并跨刷新恢复（代码主题持久已由 b-theme-system 覆盖）
 *
 * 通道同 m1/b-*：页面内 new File + defineProperty 写 webkitRelativePath，
 * 经调试钩子 __vvOpenDirImpl 注入（openFlow.svelte.ts 的 openDirectoryViaInput 同路）。
 */

interface Payload {
  name: string;
  type: string;
  content?: string;
  b64?: string;
}

/** 同 m1/b-* 的 openDir 通道（内容在页内构造 File，避免大 base64 往返）；
 * label = webkitRelativePath 首段（store 显示名 + localfiles:<label> storeId 的来源） */
async function openDir(page: Page, payloads: Payload[], label = 'tshell'): Promise<void> {
  await page.waitForFunction(
    () => typeof (window as unknown as { __vvOpenDirImpl?: unknown }).__vvOpenDirImpl === 'function'
  );
  await page.evaluate(
    ({ payloads, label }) => {
      const files = payloads.map(({ name, type, content, b64 }) => {
        const f = new File(
          [content !== undefined ? content : Uint8Array.from(atob(b64!), (c) => c.charCodeAt(0))],
          name,
          { type }
        );
        // webkitRelativePath 是原型上仅 getter 的访问器，defineProperty 写自有属性遮蔽（与真实 input 一致）
        Object.defineProperty(f, 'webkitRelativePath', { value: `${label}/${name}` });
        return f;
      });
      return (window as unknown as { __vvOpenDirImpl: (f: File[]) => void }).__vvOpenDirImpl(files);
    },
    { payloads, label }
  );
}

async function openFile(page: Page, name: string): Promise<void> {
  const drawer = await openDrawerIfNarrow(page);
  await page.locator('.vv-tree-row', { hasText: name }).click();
  await closeDrawerIfOpened(page, drawer);
  await expect(page.locator('.vv-tab.active', { hasText: name })).toBeVisible();
}

/** ≤600px 断点右栏（MetaPanel）收进抽屉：AppShell.svelte 的 @media (max-width: 600px) */
async function openRightIfNarrow(page: Page): Promise<boolean> {
  const narrow = await page.evaluate(() => window.innerWidth <= 600);
  if (!narrow) return false;
  await page.locator('.vv-right-toggle').click();
  return true;
}

/** 等待应用挂载完成（svelte:window 的 drop 监听与 TopBar 均就绪） */
async function waitAppMounted(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(
    () => typeof (window as unknown as { __vvOpenDirImpl?: unknown }).__vvOpenDirImpl === 'function'
  );
  await expect(page.locator('.vv-topbar')).toBeVisible();
}

/** 根层树名按 DOM 顺序读取（workspace T4 多源后顶层为 div[role=tree] 包逐源
 * ul[role=group]，每源一个组；行按钮在其 li 下——直接子组合子限定根层，
 * TreeNodeRow 的嵌套 ul[role=group] 不受影响） */
function rootTreeNames(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [
      ...document.querySelectorAll(
        'div[role="tree"] > ul[role="group"] > li > button.vv-tree-row .vv-tree-name'
      )
    ].map((el) => el.textContent ?? '')
  );
}

// ---------------------------------------------------------------- SHELL-01①

test('SHELL-01：sort-demo 树序——目录优先 + a2<a10 自然排序（既有编号用例只覆盖打开文件夹反馈）', async ({
  page
}) => {
  await waitAppMounted(page);
  // 域文档 4.2：sub/ + a2、a10、b，覆盖「目录优先 + 自然排序 a2<a10」
  // （createLocalFilesStore 剥首段路径，localFiles.ts:53 排序：dir 在前、同 kind 自然序）
  await openDir(page, [
    { name: 'sub/inner.txt', type: 'text/plain', content: 'x\n' },
    { name: 'a2', type: 'text/plain', content: 'a2\n' },
    { name: 'a10', type: 'text/plain', content: 'a10\n' },
    { name: 'b', type: 'text/plain', content: 'b\n' }
  ]);
  // expect.poll 首参须为函数（传 Promise 会直接抛 "accepts only function"）
  await expect.poll(() => rootTreeNames(page), { timeout: 5_000 }).toEqual(['sub', 'a2', 'a10', 'b']);
});

// ---------------------------------------------------------------- SHELL-02

test('SHELL-02：树点击两文件——第二个追加为新 tab 接管激活，原 tab 保留且内容不串扰', async ({
  page
}) => {
  await waitAppMounted(page);
  await openDir(page, [
    { name: 'hello-a.js', type: 'text/javascript', content: 'const helloA = 1;\n' },
    { name: 'notes-b.md', type: 'text/markdown', content: '# notes B\n' }
  ]);

  // ① 点击 hello-a.js：新建 tab 激活，代码内容渲染
  await openFile(page, 'hello-a.js');
  await expect(page.locator('.vv-code-pre')).toContainText('helloA', { timeout: 20_000 });

  // ② 点击 notes-b.md：追加为新 tab 并接管激活，原 tab 保留
  await openFile(page, 'notes-b.md');
  await expect(page.locator('.vv-tab.active', { hasText: 'notes-b.md' })).toBeVisible();
  await expect(page.locator('.vv-tab', { hasText: 'hello-a.js' })).toBeVisible();
  await expect(page.locator('.vv-markdown')).toContainText('notes B', { timeout: 20_000 });

  // 内容不串扰：切回 A 显示代码，markdown 视图退场；再切回 B 恢复 markdown
  await page.locator('.vv-tab', { hasText: 'hello-a.js' }).click();
  await expect(page.locator('.vv-tab.active', { hasText: 'hello-a.js' })).toBeVisible();
  await expect(page.locator('.vv-code-pre')).toContainText('helloA', { timeout: 20_000 });
  await expect(page.locator('.vv-markdown')).toHaveCount(0);
  await page.locator('.vv-tab', { hasText: 'notes-b.md' }).click();
  await expect(page.locator('.vv-markdown')).toContainText('notes B', { timeout: 20_000 });
});

// ---------------------------------------------------------------- SHELL-03①

test('SHELL-03：合成 drop 通道——单文件 drop 新建 tab 渲染，无扩展名 drop 不被拒', async ({
  page
}) => {
  test.setTimeout(60_000);
  await waitAppMounted(page);

  // 页内构造 DataTransfer 携带 File 派发 drop（+page.svelte svelte:window ondrop → openFiles；
  // 构造 File 的 webkitGetAsEntry 恒 null → collectDirectoryFiles 返回 null 走单文件通道）
  const drop = (name: string, type: string, content: string): Promise<void> =>
    page.evaluate(
      ({ name, type, content }) => {
        const dt = new DataTransfer();
        dt.items.add(new File([content], name, { type }));
        window.dispatchEvent(
          new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })
        );
      },
      { name, type, content }
    );

  // ① drop 代码文件：新建 tab 并正确渲染内容
  await drop('dropped.js', 'text/javascript', 'const droppedMarker = 7;\n');
  await expect(page.locator('.vv-tab.active', { hasText: 'dropped.js' })).toBeVisible();
  await expect(page.locator('.vv-code-pre')).toContainText('droppedMarker', { timeout: 20_000 });

  // ② drop 无扩展名 Makefile：BUG-07 修复后不被「不支持的扩展名 "."」拒绝，文本预览
  await drop('Makefile', 'text/plain', 'all:\n\techo hi\n');
  await expect(page.locator('.vv-tab.active', { hasText: 'Makefile' })).toBeVisible();
  await expect(page.locator('.vv-error-card')).toHaveCount(0);
  await expect(page.locator('.vv-code-pre')).toContainText('echo hi', { timeout: 20_000 });
});

// ---------------------------------------------------------------- SHELL-04

test('SHELL-04/valid：文件 URL 有效路径正确渲染内容', async ({ page }) => {
  // 同源 URL（4173 预览服），route 拦截提供确定性 200，不经真实网络
  await page.route('**/vv-e2e-ok.txt', (route) =>
    route.fulfill({ status: 200, contentType: 'text/plain; charset=utf-8', body: 'url-ok-marker' })
  );
  await waitAppMounted(page);
  await page.getByLabel('文件 URL').fill('http://127.0.0.1:4173/vv-e2e-ok.txt');
  await page.getByLabel('文件 URL').press('Enter');
  await expect(page.locator('.vv-tab.active', { hasText: 'vv-e2e-ok.txt' })).toBeVisible();
  await expect(page.locator('.vv-code-pre')).toContainText('url-ok-marker', { timeout: 20_000 });
});

test('SHELL-04/404：文件 URL 404 给出含失败原因的明确提示', async ({ page }) => {
  await page.route('**/vv-e2e-missing.txt', (route) =>
    route.fulfill({ status: 404, contentType: 'text/plain', body: 'no' })
  );
  await waitAppMounted(page);
  await page.getByLabel('文件 URL').fill('http://127.0.0.1:4173/vv-e2e-missing.txt');
  await page.getByLabel('文件 URL').press('Enter');
  await expect(page.locator('.vv-error-card')).toBeVisible({ timeout: 10_000 });
  // 错误卡片：标题 + 详情（createUrlStore 的 HTTP ${status} 文案，singleFile.ts）+ 文件名
  await expect(page.locator('.vv-error-card')).toContainText('无法预览此文件');
  await expect(page.locator('.vv-error-detail')).toContainText('HTTP 404');
  await expect(page.locator('.vv-error-meta')).toHaveText('vv-e2e-missing.txt');
  await expect(page.locator('.vv-code-pre')).toHaveCount(0);
});

test('SHELL-04/cors：文件 URL 跨源被 CORS 拒绝给出明确提示', async ({ page }) => {
  // 跨源 200 但不带 Access-Control-Allow-Origin → 浏览器拦截 fetch（TypeError: Failed to fetch）
  // 注意：不能用 page.route().fulfill 构造——模拟响应绕过 CORS 检查（实测 fetch 照常
  // resolve、内容正常渲染），必须走真实网络让浏览器自己执行 CORS 检查。
  // 测试内起 127.0.0.1 随机端口 HTTP 服务（无 CORS 头），对 4173 页面源即跨源。
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('should-not-render');
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const port = (server.address() as AddressInfo).port;
  try {
    await waitAppMounted(page);
    await page.getByLabel('文件 URL').fill(`http://127.0.0.1:${port}/vv-e2e-cors.txt`);
    await page.getByLabel('文件 URL').press('Enter');
    await expect(page.locator('.vv-error-card')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.vv-error-card')).toContainText('无法预览此文件');
    await expect(page.locator('.vv-error-detail')).toContainText('Failed to fetch');
    await expect(page.locator('.vv-code-pre')).toHaveCount(0);
  } finally {
    server.close();
  }
});

// ---------------------------------------------------------------- SHELL-06

test('SHELL-06：3 tab 切换内容跟随、逐个关闭递减、全部关闭后空态；目录 tab 追加/去重语义', async ({
  page
}) => {
  test.setTimeout(60_000);
  await waitAppMounted(page);
  await openDir(page, [
    { name: 't6-a1.txt', type: 'text/plain', content: 'content-alpha\n' },
    { name: 't6-b2.txt', type: 'text/plain', content: 'content-beta\n' },
    { name: 't6-c3.txt', type: 'text/plain', content: 'content-gamma\n' }
  ]);
  await openFile(page, 't6-a1.txt');
  await openFile(page, 't6-b2.txt');
  await openFile(page, 't6-c3.txt');
  // 产品设计：目录来源以一个"目录 tab"表达（openFlow.svelte.ts addDirStoreTab 经
  // addTab 入 tabStore.list，TabBar 全量渲染；m1-skeleton plan 同款），注入目录
  // （webkitRelativePath 首段 tshell）会产生一个目录 tab——判据「3 个 tab」指文件
  // tab，计数口径排除它（服务器场景「已连接服务器」前置下目录 tab 同样存在）。
  // 目录 tab 精确名匹配经 .vv-tab-name 子元素：tab 元素 textContent 含关闭钮
  // 「×」，根级 /^tshell$/ 永不匹配（SHELL-06 首轮全量失败根因）；^tshell$ 锚定
  // .vv-tab-name 使追加语义后的第二个目录 tshell2 不被误吞
  const dirTab = page.locator('.vv-tab').filter({
    has: page.locator('.vv-tab-name', { hasText: /^tshell$/ })
  });
  // 文件 tab 同经 .vv-tab-name 锚定排除：多源 workspace（T4）下每个 tab 织入来源
  // 徽标（.vv-tab-src 文本=来源名），根级 hasNotText 'tshell' 会把文件 tab 一并排除
  const fileTabs = page.locator('.vv-tab').filter({
    has: page.locator('.vv-tab-name', { hasNotText: /^tshell/ })
  });
  await expect(dirTab).toHaveCount(1);
  await expect(fileTabs).toHaveCount(3);

  // 目录 tab 追加语义（workspace T3；旧语义→新语义：旧 addDirStoreTab 的替换扫描
  // 会关闭既有目录 tab——打开第二个文件夹后 count 恒 1；废除后为追加，两个目录
  // tab 并存、树多一个来源）
  await openDir(page, [{ name: 't6-z.txt', type: 'text/plain', content: 'zeta\n' }], 'tshell2');
  const dirTab2 = page.locator('.vv-tab').filter({
    has: page.locator('.vv-tab-name', { hasText: /^tshell2$/ })
  });
  await expect(dirTab).toHaveCount(1);
  await expect(dirTab2).toHaveCount(1);
  await expect(fileTabs).toHaveCount(3); // 文件不自动打开：文件 tab 数不变

  // 目录 tab 去重语义（T3 遗留裁决）：同 storeId（localfiles:tshell）再注入 →
  // 激活既有目录 tab 并切到其所在 workspace，不重复建
  await openDir(page, [{ name: 't6-dup.txt', type: 'text/plain', content: 'dup\n' }]);
  await expect(dirTab).toHaveCount(1);
  await expect(dirTab2).toHaveCount(1);
  await expect(
    page.locator('.vv-tab.active').filter({
      has: page.locator('.vv-tab-name', { hasText: /^tshell$/ })
    })
  ).toBeVisible();

  // ② 依次切换：内容跟随所点文件
  await page.locator('.vv-tab', { hasText: 't6-a1.txt' }).click();
  await expect(page.locator('.vv-tab.active', { hasText: 't6-a1.txt' })).toBeVisible();
  await expect(page.locator('.vv-code-pre')).toContainText('content-alpha');
  await expect(page.locator('.vv-code-pre')).not.toContainText('content-beta');
  await page.locator('.vv-tab', { hasText: 't6-b2.txt' }).click();
  await expect(page.locator('.vv-code-pre')).toContainText('content-beta');
  await page.locator('.vv-tab', { hasText: 't6-c3.txt' }).click();
  await expect(page.locator('.vv-code-pre')).toContainText('content-gamma');

  // ③ 逐个关闭：剩余文件 tab 数递减；目录 tab 一并关闭后为真·无 tab 空态
  await page.locator('.vv-tab', { hasText: 't6-c3.txt' }).locator('.vv-tab-close').click();
  await expect(fileTabs).toHaveCount(2);
  await page.locator('.vv-tab', { hasText: 't6-b2.txt' }).locator('.vv-tab-close').click();
  await expect(fileTabs).toHaveCount(1);
  await page.locator('.vv-tab', { hasText: 't6-a1.txt' }).locator('.vv-tab-close').click();
  await expect(fileTabs).toHaveCount(0);
  // 文件 tab 关完但目录 tab 尚在：ViewerPane 显示「目录来源」引导而非空态
  await expect(page.locator('.vv-empty')).toContainText('目录来源');
  await dirTab2.locator('.vv-tab-close').click();
  await dirTab.locator('.vv-tab-close').click();
  await expect(page.locator('.vv-tab')).toHaveCount(0);
  // ViewerPane.svelte：无 tab 时 .vv-empty「拖入文件/文件夹，或使用顶栏打开」
  const empty = page.locator('.vv-empty');
  await expect(empty).toBeVisible();
  await expect(empty).toContainText('拖入文件/文件夹');
});

// ---------------------------------------------------------------- SHELL-07

test.fixme(
  'SHELL-07：FS Access 真实链路——选目录建树、双 tab 滚动、F5 授权后恢复文件树/双 tab/滚动位置',
  async () => {
    // headless Chromium 无法显示/驱动 FS Access 原生目录选择器与刷新后 requestPermission
    // 权限弹窗（域文档 4.3 边界 1、docs/e2e/README.md §3.1.4），需真实桌面 Chromium 补测。
    // 已证实子项 IndexedDB tab 快照恢复由 m1.spec.ts（本地占位恢复）与
    // e2e-server/b-server-regression.spec.ts（服务器来源自动重读）覆盖。
  }
);

// ---------------------------------------------------------------- SHELL-09②

test('SHELL-09/2：排除规则跨刷新持久——重载后重建树仍排除 .git/node_modules（既有用例只断言面板回显）', async ({
  page
}) => {
  test.setTimeout(60_000);
  await waitAppMounted(page);
  const demoDir: Payload[] = [
    { name: '.git/HEALTH.txt', type: 'text/plain', content: 'x\n' },
    { name: 'node_modules/left-pad/index.js', type: 'text/javascript', content: 'x\n' },
    { name: 'src/keep.txt', type: 'text/plain', content: 'keep\n' }
  ];
  await openDir(page, demoDir);
  await expect(page.locator('.vv-tree-row', { hasText: '.git' })).toBeVisible();
  await expect(page.locator('.vv-tree-row', { hasText: 'node_modules' })).toBeVisible();

  // 设置面板加入预设 → 树即时重建（入口可达性本身由既有 SHELL-09 编号用例覆盖）
  await page.locator('button[aria-label="设置"]').click();
  const panel = page.locator('.vv-settings');
  await expect(panel).toBeVisible();
  await panel.locator('button[aria-label="加入预设排除规则 .git"]').click();
  await panel.locator('button[aria-label="加入预设排除规则 node_modules"]').click();
  await expect(page.locator('.vv-tree-row', { hasText: '.git' })).toHaveCount(0);
  await expect(page.locator('.vv-tree-row', { hasText: 'node_modules' })).toHaveCount(0);

  // 跨刷新：重载（排除规则持久于 localStorage vviewer:settings）后重建同结构树，
  // 树级仍被排除——本地 File 会话不能跨刷新还原树，重注入是纯 web 模式下
  // 「持久化的规则作用于新树」的可达验证；服务器树级的重连恢复归服务端套件。
  // 重注入必须换新 label（tshell-r2）：T3 去重语义下同 storeId（localfiles:tshell）
  // 再注入只激活重载后的占位目录 tab、不重建 store/树（SHELL-06 去重锚同款），
  // 新 label 才产生新 store 与新树——规则丢失时 .git/node_modules 行将出现在新树
  await page.reload();
  // 等会话恢复落定（本地目录 tab 恢复为占位 → 错误卡/空态，m1.spec.ts:104 同款信号），
  // 再重注入目录，避免注入与会话恢复竞态导致快照覆盖新树
  await expect(page.locator('.vv-error-card, .vv-empty').first()).toBeVisible({ timeout: 10_000 });
  await openDir(page, demoDir, 'tshell-r2');
  await expect(page.locator('.vv-tree-row', { hasText: '.git' })).toHaveCount(0);
  await expect(page.locator('.vv-tree-row', { hasText: 'node_modules' })).toHaveCount(0);
  const drawer = await openDrawerIfNarrow(page);
  await page.locator('.vv-tree-row', { hasText: 'src' }).click();
  await closeDrawerIfOpened(page, drawer);
  await expect(page.locator('.vv-tree-row', { hasText: 'keep.txt' })).toBeVisible();
});

// ---------------------------------------------------------------- SHELL-10

test.describe('SHELL-10 800px 平板段（601-900）', () => {
  test.use({ viewport: { width: 800, height: 600 } });

  test('SHELL-10：树收为抽屉（开合生效），右栏保留主区内联（右栏 toggle 不出现）', async ({
    page
  }) => {
    await waitAppMounted(page);

    // ① 文件树收为抽屉：toggle 可见、初始收起（滑出视口）、开合生效
    const toggle = page.locator('.vv-drawer-toggle');
    await expect(toggle).toBeVisible();
    const side = page.locator('.vv-side');
    const closedBox = await side.boundingBox();
    expect(closedBox).not.toBeNull();
    expect(closedBox!.x).toBeLessThan(0);
    await toggle.click();
    await expect(page.locator('.vv-shell.drawer')).toHaveCount(1);
    await expect.poll(async () => (await side.boundingBox())?.x ?? -1, { timeout: 3_000 }).toEqual(0);
    await toggle.click();
    await expect(page.locator('.vv-shell.drawer')).toHaveCount(0);

    // ② 右栏不收抽屉：.vv-right-toggle 仅 ≤600px 显示（AppShell.svelte:302 按钮无条件
    //    在 DOM，:347-350 默认 display:none，:391-397 嵌套媒体查询内才 display:block），
    //    800px 段断言维度是可见性而非 DOM 不存在；.vv-right 保持 230px 内联在视口内
    await expect(page.locator('.vv-right-toggle')).toBeHidden();
    await openDir(page, [{ name: 't10.md', type: 'text/markdown', content: '# 平板段\n\n正文\n' }]);
    await openFile(page, 't10.md');
    const right = page.locator('.vv-right');
    const rightBox = await right.boundingBox();
    expect(rightBox).not.toBeNull();
    expect(rightBox!.x).toBeGreaterThanOrEqual(0);
    expect(rightBox!.x + rightBox!.width).toBeLessThanOrEqual(800);
    // 属性面板内容直接内联可见（无需任何 toggle）
    await expect(right.locator('.meta-title')).toBeVisible();
  });
});

test.describe('SHELL-10 550px 手机段（≤600）', () => {
  test.use({ viewport: { width: 550, height: 600 } });

  test('SHELL-10/2：双抽屉独立开合（左抽屉与右抽屉互不连带）', async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto('/');
    await openDir(page, [
      { name: 't10b.md', type: 'text/markdown', content: '# 手机段\n\n正文\n' }
    ]);
    await openFile(page, 't10b.md');

    const leftToggle = page.locator('.vv-drawer-toggle');
    const rightToggle = page.locator('.vv-right-toggle');
    await expect(leftToggle).toBeVisible();
    await expect(rightToggle).toBeVisible();

    // 开左抽屉：仅 drawer 类
    await leftToggle.click();
    await expect(page.locator('.vv-shell.drawer')).toHaveCount(1);
    await expect(page.locator('.vv-shell.rightopen')).toHaveCount(0);

    // 开右抽屉：rightopen 类叠加，两抽屉同时展开（独立通道）
    await rightToggle.click();
    await expect(page.locator('.vv-shell.rightopen')).toHaveCount(1);
    await expect(page.locator('.vv-shell.drawer')).toHaveCount(1);
    await expect(page.locator('.vv-right').locator('.meta-title')).toBeVisible();

    // 关左抽屉：rightopen 保持
    await leftToggle.click();
    await expect(page.locator('.vv-shell.drawer')).toHaveCount(0);
    await expect(page.locator('.vv-shell.rightopen')).toHaveCount(1);

    // 关右抽屉：全收
    await rightToggle.click();
    await expect(page.locator('.vv-shell.rightopen')).toHaveCount(0);
  });
});

// ---------------------------------------------------------------- SHELL-12②

test('SHELL-12/utf8bom：UTF-8（带 BOM）中文文件状态栏编码段显示 utf-8', async ({ page }) => {
  const UTF8_BOM = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from('# 中文BOM验证\n内容行\n')
  ]);
  await waitAppMounted(page);
  await openDir(page, [
    { name: 'utf8-bom.txt', type: 'text/plain', b64: UTF8_BOM.toString('base64') }
  ]);
  await openFile(page, 'utf8-bom.txt');
  await expect(page.locator('.vv-code-pre')).toContainText('中文BOM验证', { timeout: 20_000 });
  await expect(page.locator('.vv-statusbar')).toContainText('编码: utf-8');
});

test('SHELL-12/video：视频状态栏呈现大小段（不再仅有「自动刷新不可用」）+ 属性面板字段', async ({
  page
}) => {
  test.setTimeout(60_000);
  const mp4 = fileURLToPath(new URL('../../../samples/m4/sample.mp4', import.meta.url));
  await waitAppMounted(page);
  await openDir(page, [
    { name: 'clip.mp4', type: 'video/mp4', b64: readFileSync(mp4).toString('base64') }
  ]);
  await openFile(page, 'clip.mp4');
  // 播放器挂载（mobile.spec 已证实该 921B 样例 headless 可初始化）；av 实例带 getMeta
  await expect(page.locator('.vv-artplayer')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.vv-statusbar')).toContainText(/大小: \d+/);
  await openRightIfNarrow(page);
  await expect(page.locator('.meta-name')).toHaveText('clip.mp4');
  await expect(page.locator('.meta-row', { hasText: '大小' })).toContainText(/字节/);
});

// ---------------------------------------------------------------- SHELL-13①

test('SHELL-13/1：计算策略 UI 修改写入 localStorage 并跨刷新恢复（代码主题持久已由 b-theme-system 覆盖）', async ({
  page
}) => {
  await waitAppMounted(page);
  // TopBar 计算策略下拉（aria-label="计算策略"）→ saveSettings 落盘单键对象
  await page.getByLabel('计算策略').selectOption('local');
  expect(
    await page.evaluate(
      () => JSON.parse(localStorage.getItem('vviewer:settings') ?? '{}').computePolicy
    )
  ).toBe('local');

  // F5 刷新后恢复逐字吻合
  await page.reload();
  await expect(page.getByLabel('计算策略')).toHaveValue('local');
  expect(
    await page.evaluate(
      () => JSON.parse(localStorage.getItem('vviewer:settings') ?? '{}').computePolicy
    )
  ).toBe('local');
});

// ---------------------------------------------------------------- BUG 回归占位（2026-10-10 探索复核）
//
// 本区块为 app-shell-sources 域本轮（2026-10-10）探索复核确认的新缺陷回归占位
// （docs/e2e/README.md §3.2.4 第 4 条：修复合入前以 test.fixme 落占位并在标题/注释标注
// 缺陷号，缺陷修复 PR 中转为正式断言）。每个用例注释给出最小复现步骤、证据路径与根因
// 代码定位；来源标注 [探索]：缺陷由探索/复核会话（CAND-shell / review / verify 系列）
// 独立复现确认，severity 见各用例注释。

test.fixme(
  'BUG-29 [探索]: 服务端档裸路径 URL 静默渲染 index.html——档伺服 fallback 200+text/html 被 createUrlStore 当文件内容，无错误卡片',
  async () => {
    // 现象（severity medium）：服务端档伺服层对一切非 .scm/.wasm 未命中路径（含真实存在
    // 的数据文件裸路径）以 200 + text/html 返回 index.html（server/src/lib.rs:55-85
    // serve_index，build_router:107-115 挂为 ServeDir fallback）；前端「文件 URL」通路的
    // createUrlStore 仅判 res.ok（packages/core/src/tree/singleFile.ts:29-31；openFlow.svelte.ts:423-431
    // TopBar URL 直通），粘贴裸路径 URL 时静默把 index.html 源码当该文件渲染，全程无错误卡片。
    //
    // 最小复现：
    //   1) 连接 http://127.0.0.1:8391；
    //   2) 顶栏「文件 URL」输入 http://127.0.0.1:8391/samples/m1/hello.js（真实 72B/2 行）回车；
    //   3) 新 tab「hello.js」渲染出 index.html 带行号源码，状态栏「语言: javascript · 大小: 1610 ·
    //      行: 36」，全程无错误提示。curl -i 同 URL → HTTP 200 + text/html + 1610B。
    //   对照：/api/file?path=samples/m1/hello.js 正常渲染（72B/2 行）；
    //         /api/file?path=no-such-xyz.js 有正确错误卡片「HTTP 404 获取 … 失败」
    //         ——「404 明确提示」仅 /api/file 形态可达，裸路径形态不可达。
    //
    // 证据（探索复核自跑，/tmp/vv-reverify-e3/）：
    //   - reverify.mjs（chromium 真实连 8391，无 route 拦截）三态对照：A 裸路径 →
    //     activeTab=hello.js、errorCard=0、codePre 以「1 <!doctype html>」开头、statusbar=
    //     「语言: javascript · 大小: 1610 · 行: 36」；B /api/file 好路径 → 72B/2 行正确渲染；
    //     C /api/file 缺路径 → errorCard=1「无法预览此文件 HTTP 404」。
    //   - stab.mjs 重复 A 态两次均复现；截图 A-barepath-indexhtml.png 属性面板
    //     「大小 1610字节 / 行数 36」。
    //
    // 为什么既有 SHELL-04/404 未覆盖：本文件 SHELL-04 两用例均 page.route 拦截虚构 URL
    // 提供确定性 200/404，从未打到真实伺服器裸路径 fallback（fetch 层 res.ok 逻辑本身正确）。
    //
    // 转正提示：需真实伺服器裸路径（不可 page.route 代替），归 e2e-server 套件可达；
    // 修复方向二选一后按方案落断言（伺服层对裸路径数据文件出正确 content-type，或前端按
    // content-type 拒渲染 text/html）——期望「错误卡片或正确内容渲染」而非 1610/36 伪渲染。
  }
);

test(
  'BUG-27: Ctrl+P 对单目录 listChildren 失败降级——其余条目照常可列可开（不整表否决）',
  async ({ page }) => {
    // 缺陷（high，服务端档数据集开箱即触发）：服务端档下「呈现为目录但 listChildren
    // 被拒」的条目（数据根自带 root 外 symlink edge/symlink/escape-etc -> /etc，403
    // 仅在越界子目录层）使 walk 整体 reject（listFilesRecursively 无单目录容错），
    // QuickOpenPanel 的 catch 整体置失败态、列表 0 行。修复（2026-10-16）：walk 单目录
    // try/catch 降级（树侧 TreeNodeRow 同款）——告警 + 跳过该子树，面板状态行透出
    // 「部分目录无法列出」，其余条目照常可列可开。历史证据路径见缺陷库。
    // 通道：内建 http 假服务（SHELL-04/cors 同款）实现最小 vviewer 文件服务器面
    // （/api/health、/api/ticket、/api/events SSE、/api/tree、/api/file），全部响应带
    // CORS 头（4173 页面源跨源访问）；'locked' 目录 listChildren 恒 403 复现越界
    // symlink 形态（真实数据集 edge/ 的确定性替身）。
    test.setTimeout(60_000);
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const cors = { 'Access-Control-Allow-Origin': '*' };
      const json = (status: number, body: unknown): void => {
        res.writeHead(status, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (url.pathname === '/api/health') return json(200, { capabilities: ['file-server'] });
      if (url.pathname === '/api/ticket') return json(200, { ticket: 'e2e-ticket' });
      if (url.pathname === '/api/events') {
        // SSE 空流挂住连接（watch 订阅），测试结束随 server 一并断开
        res.writeHead(200, { ...cors, 'Content-Type': 'text/event-stream' });
        return;
      }
      if (url.pathname === '/api/tree') {
        const path = url.searchParams.get('path') ?? '';
        if (path === 'locked') return json(403, { error: 'path escapes root' });
        if (path === '') {
          return json(200, {
            entries: [
              { name: 'locked', kind: 'dir' },
              { name: 'bug27-ok.txt', kind: 'file', size: 16 },
              { name: 'sub', kind: 'dir' }
            ]
          });
        }
        if (path === 'sub') {
          return json(200, { entries: [{ name: 'inner.md', kind: 'file', size: 8 }] });
        }
        return json(200, { entries: [] });
      }
      if (url.pathname === '/api/file') {
        if ((url.searchParams.get('path') ?? '') === 'bug27-ok.txt') {
          res.writeHead(200, { ...cors, 'Content-Type': 'text/plain; charset=utf-8' });
          return res.end('bug27-ok-marker\n');
        }
        return json(404, { error: 'no such file' });
      }
      json(404, { error: 'not found' });
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    const port = (server.address() as AddressInfo).port;
    try {
      await waitAppMounted(page);
      // 连接服务器（TopBar 内联表单）；目录 tab 出现即连接成功
      await page.getByRole('button', { name: '连接服务器' }).click();
      await page.getByLabel('服务器地址').fill(`http://127.0.0.1:${port}`);
      await page.locator('.vv-server-form').getByRole('button', { name: '连接', exact: true }).click();
      await expect(page.locator('.vv-tab')).not.toHaveCount(0, { timeout: 10_000 });

      // 修复前：locked 层 403 → 整表 reject → 列表 0 行；修复后其余条目照常列出
      await page.keyboard.press('Control+p');
      const panel = page.locator('.vv-quickopen');
      await expect(panel).toBeVisible();
      const statusLine = panel.locator('.vv-quickopen-status');
      await expect(statusLine).toContainText('部分目录无法列出', { timeout: 10_000 });
      await expect(statusLine).toContainText('HTTP 403: path escapes root');
      await expect(panel.locator('.vv-quickopen-row')).toHaveCount(2);
      await expect(panel.locator('.vv-quickopen-row').first()).toContainText('bug27-ok.txt');

      // 可开：Enter 打开选中首条（bug27-ok.txt），内容正确渲染
      await page.keyboard.press('Enter');
      await expect(page.locator('.vv-tab.active', { hasText: 'bug27-ok.txt' })).toBeVisible();
      await expect(page.locator('.vv-code-pre')).toContainText('bug27-ok-marker', {
        timeout: 20_000
      });
    } finally {
      server.close();
      (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
    }
  }
);

test(
  'BUG-31: 快速打开面板已开时再按 Ctrl+P 应 toggle 关闭且 preventDefault（inField 例外放行）',
  async ({ page }) => {
    // 缺陷（low，键位语义）：面板输入框自动聚焦（QuickOpenPanel.svelte），AppShell
    // 全局 keydown 的 inField 提前 return 吞掉 Ctrl+P toggle——面板已开再按不关闭、
    // 不 preventDefault（真实浏览器触发打印对话框）。修复（2026-10-16）：inField
    // 分支内 Ctrl/Cmd+P 组合键例外放行（恒走 toggle + preventDefault，VSCode 同
    // 惯例）；其余按键 inField 语义原样。历史证据路径见缺陷库。
    test.setTimeout(60_000);
    await page.goto('/');
    await openDir(page, [{ name: 'bug31.ts', type: 'text/plain', content: 'export const a = 1;\n' }]);
    // 第一按：打开面板（输入框自动聚焦）
    await page.keyboard.press('Control+p');
    const panel = page.locator('.vv-quickopen');
    await expect(panel).toBeVisible();
    // 第二按：面板已开（输入焦点）→ toggle 关闭（现状：inField 吞掉，面板不关）
    await page.keyboard.press('Control+p');
    await expect(panel, 'BUG-31：面板已开再按 Ctrl+P 应关闭').toBeHidden();
    // 第三按：toggle 双向——重开
    await page.keyboard.press('Control+p');
    await expect(panel, 'toggle 双向：再按重开').toBeVisible();
  }
);

test(
  'BUG-32: 图片状态栏/属性面板不再显示「编码」段（编码检测对二进制媒体不透出）',
  async ({ page }) => {
    // 缺陷（low，误导性呈现）：编码检测对二进制不豁免——严格 UTF-8 校验失败恒回退
    // gb18030，image/av 的 getMeta 透传致图片状态栏/属性面板恒显「编码: gb18030」
    // （服务端档与纯前端档一致，历史证据路径见缺陷库）。修复（2026-10-16）：detect
    // 对 binary 判定结果置 encoding undefined——消费方（ViewerPane 状态栏段组装 /
    // MetaPanel 行渲染）对 undefined 即隐藏「编码」段；文本媒体（含 gb18030 文本，
    // binary=false）编码照常透出，BUG-04「至少含大小」语义不变。
    // 通道：纯前端 b64 注入（历史复核 repro4199 已证实两档同现此缺陷，openDir 同款）。
    const png = fileURLToPath(new URL('../../../samples/m1/pixel.png', import.meta.url));
    await waitAppMounted(page);
    await openDir(page, [
      { name: 'pixel.png', type: 'image/png', b64: readFileSync(png).toString('base64') }
    ]);
    await openFile(page, 'pixel.png');
    // 图片渲染正常（无错误卡片）：编码修复不触碰渲染链
    await expect(page.locator('.vv-image img')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('.vv-error-card')).toHaveCount(0);
    // 状态栏：大小段仍在、编码段消失（修复前恒「编码: gb18030」）
    await expect(page.locator('.vv-statusbar')).toContainText(/大小: \d+/);
    await expect(page.locator('.vv-statusbar')).not.toContainText('编码:');
    // 属性面板：无编码行
    await openRightIfNarrow(page);
    await expect(page.locator('.meta-name')).toHaveText('pixel.png');
    await expect(page.locator('.meta-row', { hasText: '编码' })).toHaveCount(0);
  }
);

test.fixme(
  'BUG-30 [探索]: URL 尾斜杠产出空名伪目录 tab——内容区显示「目录来源」引导，不渲染内容也不报错',
  async () => {
    // 现象（severity low）：URL 以 / 结尾时 openUrl 对 split('/').pop() 得空串
    // （apps/web/src/lib/openFlow.svelte.ts:424，:431 addTab(createUrlStore(url),'','')），
    // 产出空名伪目录 tab：tab 名空白且激活（TabBar.svelte:27 渲染 source.name），内容区
    // 显示「目录来源：文件在左侧树中打开」（ViewerPane.svelte:222-223 的 path==='' 分支；
    // :131 使 URL 内容根本不渲染也不报错），语义错误。path==='' 与目录 tab 语义双向冲突
    // 均实测成立：服务端档真实目录 tab 在列表前部先被 find 命中（树未被顶掉）；纯前端档
    // 空名 tab 为唯一 tab 时 AppShell.svelte:164 的 dirStore 解析命中它，URL store 被误当
    // 目录 store，左栏渲染根名为空的 FileTree（加重观察）；经 __vvOpenDirImpl 注入真实目录
    // 后，addDirStoreTab 的 path==='' 替换扫描（openFlow.svelte.ts:411-413）把空名 URL tab
    // 一并静默误关。reload 后空 tab 消失（自愈，但归因分支未能单独确认）。
    //
    // 最小复现：
    //   1) 连接 http://127.0.0.1:8391；
    //   2) 顶栏 URL 输入 http://127.0.0.1:8391/samples/m1/ 回车；
    //   3) 出现新 tab，名字为空字符串且激活，内容区显示「目录来源：文件在左侧树中打开」
    //      而非文件内容或错误提示。
    //
    // 证据（复核会话，/tmp/verify-shell-e4/）：
    //   - probe.mjs（Playwright 直连 8391）：提交前 tabs=[{name:'127.0.0.1:8391',active:true}]；
    //     提交后 tabs=[{name:'127.0.0.1:8391',active:false},{name:'',active:true}]、
    //     paneEmptyDiv='目录来源：文件在左侧树中打开'、treeVisible=true（树未被顶掉）；
    //     第二个空名 URL 后两个空 tab 并存；reload 后 tabs=[]。截图 e4-empty-tab.png。
    //   - probe-pure.mjs（4199 纯前端档）：尾斜杠 URL 为首个动作即 {name:'',active:true} +
    //     paneEmptyDiv 同上 + treeRows=['']（URL store 被误渲染为文件树）；注入目录后仅剩
    //     {name:'folder',active:true}（空名 tab 被替换扫描误关）。截图 e4-pure-first.png。
    //
    // 转正提示：修复方向为 openUrl 对空名（尾斜杠/目录形态）拒绝或明确提示；期望断言
    // 「提交尾斜杠 URL 不产出空名激活 tab」（或出明确错误提示），不落「目录来源」空态。
  }
);

// BUG-64（服务器模式重载后滚动位置不还原）已转正至 e2e-server/b-server-regression
// BUG-08 用例硬断言：根因①（AppShell.restore 赋值对象与 ViewerPane effect 读取对象
// 非同一引用）由 BUG-69 修复一并解决（90a2166，add 返回响应式代理），原文档探索注释
// （最小复现/证据链）随本占位删除，修复验证见 b-server-regression。
