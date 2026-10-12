import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, expect, type Page } from '@playwright/test';
import { closeDrawerIfOpened, openDrawerIfNarrow } from './drawer';

/**
 * workspace 多根域端到端锚点（workspace 计划 T7；t- 前缀标记本轮新增）：
 * - WS-01：新建工作区（切换器 → 新建模态，跳过来源直接完成）+ 切换器重命名 +
 *   删除（window.confirm 对话框，page.on('dialog') 接受）
 * - WS-02：远端来源经 connectServer 通道入组 + localfiles 注入第二来源——
 *   多源 tab 来源徽标、树多源分组、tab 归组（同组 TabBar 并存）
 * - WS-03：Alt+W 管理面板（e.code 判定回归锚）——搜索过滤、跨组激活
 *   （面板行激活 → 切组 → TabBar/查看区/面板三处一致）、行内快捷关闭
 * - WS-04：刷新恢复——双 workspace 结构、remote 来源重连内容恢复（BUG-08 通道）、
 *   localfiles 来源落占位（本地内容不跨刷新）
 * - WS-05：后端路径 basePath 来源重载两次不落占位——T5 评审 I-1「快照 storeLabel
 *   原值回环（label 参与 storeId hash）」修复的 e2e 锚
 *
 * 通道：目录注入同 m1/t-shell（__vvOpenDirImpl，webkitRelativePath 首段 = label）；
 * 单文件经合成 drop（t-shell SHELL-03① 先例）；远端用测试内假 vviewer 服务器
 * （t-open-with BUG-69 先例：health/ticket/events SSE 持挂 + CORS 头，跨源 4173 页面）。
 */

interface Payload {
  name: string;
  type: string;
  content?: string;
}

/** 等应用挂载（svelte:window drop 监听与 TopBar 就绪；t-shell waitAppMounted 同款） */
async function waitAppMounted(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(
    () => typeof (window as unknown as { __vvOpenDirImpl?: unknown }).__vvOpenDirImpl === 'function'
  );
  await expect(page.locator('.vv-topbar')).toBeVisible();
}

/** 目录注入通道（t-shell openDir 同款；label = webkitRelativePath 首段 = store 名） */
async function openDir(page: Page, payloads: Payload[], label: string): Promise<void> {
  await page.waitForFunction(
    () => typeof (window as unknown as { __vvOpenDirImpl?: unknown }).__vvOpenDirImpl === 'function'
  );
  await page.evaluate(
    ({ payloads, label }) => {
      const files = payloads.map(({ name, type, content }) => {
        const f = new File([content ?? ''], name, { type });
        Object.defineProperty(f, 'webkitRelativePath', { value: `${label}/${name}` });
        return f;
      });
      return (window as unknown as { __vvOpenDirImpl: (f: File[]) => void }).__vvOpenDirImpl(files);
    },
    { payloads, label }
  );
}

/** 合成 drop 注入单文件并等 tab 激活（t-shell SHELL-03① 同款通道） */
async function dropFile(page: Page, name: string, content: string): Promise<void> {
  await page.evaluate(
    ({ name, content }) => {
      const dt = new DataTransfer();
      dt.items.add(new File([content], name, { type: 'text/plain' }));
      window.dispatchEvent(
        new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })
      );
    },
    { name, content }
  );
  await expect(page.locator('.vv-tab.active', { hasText: name })).toBeVisible();
}

/** 新建工作区（切换器 → 模态命名 → 创建并激活；WS-01/03/04/05 复用） */
async function createWorkspace(page: Page, name: string): Promise<void> {
  await page.locator('.vv-ws-trigger').click();
  await page.getByRole('button', { name: '＋ 新建工作区…' }).click();
  const modal = page.locator('.vv-wscreate');
  await expect(modal).toBeVisible();
  await page.getByLabel('工作区名称').fill(name);
  await modal.getByRole('button', { name: '创建并激活' }).click();
  await expect(modal).toHaveCount(0);
  await expectActiveWorkspace(page, name); // 新建即激活（T4 裁决；窄视口经下拉活动行核对）
}

/**
 * 假 vviewer 文件服务器（t-open-with BUG-69 先例）：health 免鉴权宣告 file-server、
 * ticket 发票、events SSE 持挂（无数据帧）；tree/file 按内存 files 表服务——
 * tree 列「path 下直接子项」（中间段推导目录），file 按 path 取内容。
 * 页面源 4173 跨源：所有响应带 ACAO:*（EventSource 亦要求 CORS）。
 */
async function startFakeServer(
  files: Record<string, string>
): Promise<{ base: string; host: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const cors = { 'Access-Control-Allow-Origin': '*' };
    if (url.pathname === '/api/health') {
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ capabilities: ['file-server'] }));
      return;
    }
    if (url.pathname === '/api/ticket') {
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ticket: 'e2e' }));
      return;
    }
    if (url.pathname === '/api/events') {
      res.writeHead(200, { ...cors, 'Content-Type': 'text/event-stream' });
      return; // 保持打开、无数据帧：SSE 挂起即可（测试结束统一断连）
    }
    if (url.pathname === '/api/tree') {
      const p = (url.searchParams.get('path') ?? '').replace(/^\/+|\/+$/g, '');
      const entries = new Map<string, 'dir' | 'file'>();
      const prefix = p === '' ? '' : `${p}/`;
      for (const key of Object.keys(files)) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        const head = rest.split('/')[0]!;
        entries.set(head, rest.includes('/') ? 'dir' : 'file');
      }
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ entries: [...entries].map(([name, kind]) => ({ name, kind })) }));
      return;
    }
    if (url.pathname === '/api/file') {
      const p = url.searchParams.get('path') ?? '';
      const content = files[p];
      if (content === undefined) {
        res.writeHead(404, cors);
        res.end('no such file');
        return;
      }
      res.writeHead(200, { ...cors, 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(content);
      return;
    }
    res.writeHead(404, cors);
    res.end();
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  return {
    base,
    host: `127.0.0.1:${port}`,
    close: async () => {
      server.closeAllConnections(); // /api/events 长连接不 end：close() 需配套断连
      await new Promise<void>((ok) => server.close(() => ok()));
    }
  };
}

/** 连接表单提交（t-srv connectForm 同款；token 留空） */
async function connectForm(page: Page, base: string): Promise<void> {
  await page.getByRole('button', { name: '连接服务器' }).click();
  await page.getByLabel('服务器地址').fill(base);
  await page.getByRole('button', { name: '连接', exact: true }).click();
}

/**
 * 断言活动工作区名为 name。宽视口直读触发钮文案（`${name} ▾`）；窄视口
 * （≤600px，TopBar 断点 spec E §2.3）触发钮恒显「工作区 ▾」不含组名——经下拉内
 * 活动行（.vv-ws-item.active）核对，断言后 Esc 还原关闭态。
 */
const WS_TRIGGER_NARROW_MQ = '(max-width: 600px)';

async function expectActiveWorkspace(page: Page, name: string): Promise<void> {
  const narrow = await page.evaluate((q) => window.matchMedia(q).matches, WS_TRIGGER_NARROW_MQ);
  if (!narrow) {
    await expect(page.locator('.vv-ws-trigger')).toContainText(name);
    return;
  }
  await page.locator('.vv-ws-trigger').click();
  await expect(page.locator('.vv-ws-item.active .vv-ws-name', { hasText: name })).toBeVisible();
  await page.keyboard.press('Escape'); // 焦点在 body：window 兜底通道关下拉
  await expect(page.locator('.vv-ws-pop')).toHaveCount(0);
}

/** 等待 workspaces 快照落盘（跨全部组包含指定 tab 名——异步 persist 的确定性等待） */
async function waitSnapshotTabs(page: Page, wanted: string[]): Promise<void> {
  await page.waitForFunction(
    (names) =>
      new Promise<boolean>((resolve) => {
        const open = indexedDB.open('vviewer', 2);
        open.onsuccess = () => {
          const db = open.result;
          try {
            const get = db.transaction('kv', 'readonly').objectStore('kv').get('workspaces');
            get.onsuccess = () => {
              const snap = get.result as
                | { workspaces?: { tabs?: { name?: string }[] }[] }
                | undefined;
              const have = (snap?.workspaces ?? []).flatMap((w) =>
                (w.tabs ?? []).map((t) => t.name ?? '')
              );
              resolve(names.every((n) => have.includes(n)));
              db.close();
            };
            get.onerror = () => {
              resolve(false);
              db.close();
            };
          } catch {
            resolve(false);
            db.close();
          }
        };
        open.onerror = () => resolve(false);
      }),
    wanted,
    { polling: 100, timeout: 15_000 }
  );
}

// ---------------------------------------------------------------- WS-01

test('WS-01：切换器新建工作区（模态跳过来源）→ 重命名 → 删除需 confirm', async ({ page }) => {
  await waitAppMounted(page);
  const trigger = page.locator('.vv-ws-trigger');
  await expectActiveWorkspace(page, '默认');

  // ① 新建：模态不选来源（「可跳过」）→ 创建并激活
  await createWorkspace(page, '研究');

  // ② 切换器重命名：行内 ✎ → 表单 Enter/✓ 提交
  await trigger.click();
  await page.getByRole('button', { name: '重命名工作区 研究' }).click();
  // exact 定位输入框：各行 ✎ 按钮的 aria-label 同以「重命名工作区」开头
  //（"重命名工作区 {组名}"），getByLabel 子串匹配会连同按钮一并命中（strict violation）
  const rename = page.getByLabel('重命名工作区', { exact: true });
  await expect(rename).toBeVisible();
  await rename.fill('深研');
  await page.getByRole('button', { name: '确认重命名' }).click();
  // 下拉保持展开：重命名后活动行即新名（窄视口触发钮无组名，经活动行断言）
  await expect(page.locator('.vv-ws-item.active .vv-ws-name', { hasText: '深研' })).toBeVisible();
  await expect(page.locator('.vv-ws-name', { hasText: '深研' })).toBeVisible();
  await page.keyboard.press('Escape'); // 关下拉（焦点已回 body，window 兜底通道）
  await expect(page.locator('.vv-ws-pop')).toHaveCount(0);

  // ③ 删除工作区：window.confirm 需接受（Playwright 默认 dismiss——必须挂 handler）
  page.on('dialog', (d) => void d.accept());
  await trigger.click();
  await page.getByRole('button', { name: '删除工作区 深研' }).click();
  // 删活动组 → remove 内部切到剩余组首（默认），且至少一个不变式保持
  await expect(page.locator('.vv-ws-item.active .vv-ws-name', { hasText: '默认' })).toBeVisible();
  await expect(page.locator('.vv-ws-item')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(page.locator('.vv-ws-pop')).toHaveCount(0);
});

// ---------------------------------------------------------------- WS-02

test('WS-02：远端来源连接入组 + localfiles 注入第二来源——来源徽标与树多源分组', async ({
  page
}) => {
  test.setTimeout(60_000);
  const fake = await startFakeServer({ 'hello.js': 'const wsRemote = 1;\n' });
  try {
    await waitAppMounted(page);
    await connectForm(page, fake.base);
    // 目录 tab（显示名 = host）+ 树来源标签行
    await expect(page.locator('.vv-tab', { hasText: fake.host })).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.vv-tree-src-label', { hasText: fake.host })).toBeVisible({
      timeout: 10_000
    });

    // 第二来源：localfiles 注入通道（纯前端套件域内第二来源的最小构造）
    await openDir(page, [{ name: 'note.md', type: 'text/markdown', content: '# 本地\n' }], '本地夹');
    await expect(page.locator('.vv-tab', { hasText: '本地夹' })).toBeVisible();
    // 多源 workspace：来源徽标出现（TabBar badgeOf——单源省略，多源才显示）
    await expect(page.locator('.vv-tab-src')).toHaveCount(2);
    // 树两个来源分组（FileTree 逐源标签行）
    await expect(page.locator('.vv-tree-src-label')).toHaveCount(2);

    // tab 归组：远端文件 tab 与两目录 tab 同组并存（同一 workspace 的 TabBar）
    const drawer = await openDrawerIfNarrow(page);
    await page.locator('.vv-tree-row', { hasText: 'hello.js' }).click();
    await closeDrawerIfOpened(page, drawer);
    await expect(page.locator('.vv-tab.active', { hasText: 'hello.js' })).toBeVisible();
    await expect(page.locator('.vv-code-pre')).toContainText('wsRemote', { timeout: 20_000 });
    await expect(page.locator('.vv-tab-src')).toHaveCount(3); // 目录×2 + 文件×1 均带来源徽标
  } finally {
    await fake.close();
  }
});

// ---------------------------------------------------------------- WS-03

test('WS-03：Alt+W 管理面板——搜索过滤、跨组激活三处一致、行内快捷关闭', async ({ page }) => {
  test.setTimeout(60_000);
  await waitAppMounted(page);
  // 组一（默认）：drop 单文件 tab
  await dropFile(page, 'alpha-note.txt', 'alpha content\n');
  // 组二：新建工作区（创建即激活）→ drop 单文件 tab
  await createWorkspace(page, '第二组');
  await dropFile(page, 'beta-note.txt', 'beta content\n');
  await expect(page.locator('.vv-tab.active', { hasText: 'beta-note.txt' })).toBeVisible();

  // ① Alt+W 打开面板（e.code 判定——macOS Option+W e.key='∑' 失效的回归锚）
  await page.keyboard.press('Alt+w');
  const panel = page.locator('.vv-wspanel');
  await expect(panel).toBeVisible();
  // 活动组排最前：两组齐全（第二组 + 默认），共两行
  await expect(panel.locator('.vv-wspanel-group')).toHaveCount(2);
  await expect(panel.locator('.vv-wspanel-row')).toHaveCount(2);

  // ② 搜索过滤：命中行保留、无匹配组整组隐藏（组头只剩第二组）
  await page.getByLabel('过滤标签').fill('beta');
  await expect(panel.locator('.vv-wspanel-row')).toHaveCount(1);
  await expect(panel.locator('.vv-wspanel-row', { hasText: 'beta-note.txt' })).toBeVisible();
  await expect(panel.locator('.vv-wspanel-group')).toHaveCount(1);
  await expect(panel.locator('.vv-wspanel-group')).toContainText('第二组');
  await page.getByLabel('过滤标签').fill('');
  await expect(panel.locator('.vv-wspanel-row')).toHaveCount(2);

  // ③ 跨组激活：点默认组行 → 面板关（选中即走）、切组、TabBar 与查看区跟随
  await panel.locator('.vv-wspanel-row', { hasText: 'alpha-note.txt' }).click();
  await expect(panel).toHaveCount(0);
  await expectActiveWorkspace(page, '默认');
  await expect(page.locator('.vv-tab.active', { hasText: 'alpha-note.txt' })).toBeVisible();
  await expect(page.locator('.vv-code-pre')).toContainText('alpha content');

  // ④ 三处一致（面板侧）：重开面板，alpha 行处于 active 态（第二组行不标）
  await page.keyboard.press('Alt+w');
  await expect(panel).toBeVisible();
  const row = panel.locator('.vv-wspanel-row', { hasText: 'alpha-note.txt' });
  await expect(row).toHaveClass(/active/);

  // ⑤ 快捷关闭：行内 ×（stopPropagation——只关 tab，不触发行激活/不切组/不关面板）
  await row.locator('.vv-wspanel-close').click();
  await expect(panel.locator('.vv-wspanel-row', { hasText: 'alpha-note.txt' })).toHaveCount(0);
  await expect(panel).toBeVisible(); // 管理态保持
  // 未切组核对：先 Esc 关面板再断言（窄视口断言经下拉活动行，面板浮层在位时
  // 点触发钮会被面板挡住）
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await expectActiveWorkspace(page, '默认');
});

// ---------------------------------------------------------------- WS-04

test('WS-04：刷新恢复——双 workspace 结构、remote 重连内容恢复、localfiles 落占位', async ({
  page
}) => {
  test.setTimeout(90_000);
  const fake = await startFakeServer({ 'hello.js': 'const wsRestore = 42;\n' });
  try {
    await waitAppMounted(page);
    // 默认组：远端来源 + 文件 tab
    await connectForm(page, fake.base);
    const drawer1 = await openDrawerIfNarrow(page);
    await page.locator('.vv-tree-row', { hasText: 'hello.js' }).click();
    await closeDrawerIfOpened(page, drawer1);
    await expect(page.locator('.vv-code-pre')).toContainText('wsRestore', { timeout: 20_000 });

    // 第二组：localfiles 来源 + 文件 tab（本地内容不跨刷新 → 恢复必为占位）
    await createWorkspace(page, '本地组');
    await openDir(
      page,
      [{ name: 'local-note.txt', type: 'text/plain', content: 'local body\n' }],
      '本地夹'
    );
    const drawer2 = await openDrawerIfNarrow(page);
    await page.locator('.vv-tree-row', { hasText: 'local-note.txt' }).click();
    await closeDrawerIfOpened(page, drawer2);
    await expect(page.locator('.vv-tab.active', { hasText: 'local-note.txt' })).toBeVisible();

    // 快照落盘（两组 + 两条文件 tab）后再刷新
    await waitSnapshotTabs(page, ['hello.js', 'local-note.txt']);
    await page.reload();

    // 恢复后活动组 = 快照记录（本地组）：localfiles 文件 tab 落占位错误卡
    await expect(page.locator('.vv-error-card')).toContainText('需要重新打开', {
      timeout: 15_000
    });
    // 组结构恢复：切换器两组齐全、活动组为快照记录的本地组
    await expectActiveWorkspace(page, '本地组');
    await page.locator('.vv-ws-trigger').click();
    await expect(page.locator('.vv-ws-item')).toHaveCount(2);
    // 切回默认组：remote 来源重连（BUG-08 通道）→ 文件内容恢复，非占位
    await page.locator('.vv-ws-name', { hasText: '默认' }).click();
    await expect(page.locator('.vv-tab', { hasText: 'hello.js' })).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.vv-code-pre')).toContainText('wsRestore', { timeout: 20_000 });
    await expect(page.locator('.vv-error-card')).toHaveCount(0);
  } finally {
    await fake.close();
  }
});

// ---------------------------------------------------------------- WS-05

test('WS-05：后端路径 basePath 来源重载两次不落占位（T5 I-1 storeLabel 回环 e2e 锚）', async ({
  page
}) => {
  test.setTimeout(90_000);
  const fake = await startFakeServer({ 'sub/notes.txt': 'sub source body\n' });
  try {
    await waitAppMounted(page);
    // 连接（写入 sessionStorage last-server——RemoteSourceModal 已连接判定与恢复重连依据）
    await connectForm(page, fake.base);
    await expect(page.locator('.vv-tab', { hasText: fake.host })).toBeVisible({ timeout: 10_000 });

    // 切换器 → 新建模态 → 后端路径浏览 → 选 sub 目录为来源（basePath 源，
    // label = `${host}/sub`——参与 storeId hash，恢复必须原值回环）
    await page.locator('.vv-ws-trigger').click();
    await page.getByRole('button', { name: '＋ 新建工作区…' }).click();
    const modal = page.locator('.vv-wscreate');
    await expect(modal).toBeVisible();
    await page.getByLabel('工作区名称').fill('子源组');
    await modal.getByRole('button', { name: '后端路径…' }).click();
    const browse = page.locator('.vv-remotesrc');
    await expect(browse).toBeVisible();
    await expect(browse.locator('.vv-remotesrc-row')).toHaveCount(1);
    // exact 定位行内「作为来源」：「将当前目录作为来源（根 0）」的 pickcurrent
    // 按钮名含同段子串，非 exact 会连同命中（strict violation）
    await browse.getByRole('button', { name: '作为来源', exact: true }).click();
    await expect(browse).toHaveCount(0); // onpicked → 关浏览层
    await modal.getByRole('button', { name: '创建并激活' }).click();
    await expect(modal).toHaveCount(0);

    // 打开子源内文件（树行 → 文件 tab；store 路径相对 basePath，请求剥前缀拼回 sub/）
    const drawer = await openDrawerIfNarrow(page);
    await page.locator('.vv-tree-row', { hasText: 'notes.txt' }).click();
    await closeDrawerIfOpened(page, drawer);
    await expect(page.locator('.vv-code-pre')).toContainText('sub source body', { timeout: 20_000 });

    // 快照落盘后重载两次：来源按快照 storeLabel 原值回环重建（label 参与 storeId
    // hash）→ 文件 tab 按快照 storeId 挂靠恢复内容——任何一次落占位即回环断裂
    await waitSnapshotTabs(page, ['notes.txt']);
    for (let i = 0; i < 2; i++) {
      await page.reload();
      await expect(page.locator('.vv-tab', { hasText: 'notes.txt' })).toBeVisible({
        timeout: 15_000
      });
      await expect(page.locator('.vv-code-pre')).toContainText('sub source body', {
        timeout: 20_000
      });
      await expect(page.locator('.vv-error-card')).toHaveCount(0);
    }
  } finally {
    await fake.close();
  }
});

// ---------------------------------------------------------------- WS-06

test('WS-06：pinned 目录 tab 刷新保持（M-5——快照目录条目按来源重建并读回 pinned）', async ({
  page
}) => {
  test.setTimeout(90_000);
  const fake = await startFakeServer({ 'hello.js': 'const wsPinned = 1\n' });
  try {
    await waitAppMounted(page);
    await connectForm(page, fake.base);
    const dirTab = page.locator('.vv-tab', { hasText: fake.host });
    await expect(dirTab).toBeVisible({ timeout: 10_000 });

    // 打开一个文件 tab 与目录 tab 并存（锚「只重建快照目录条目，文件 tab 照常」）
    const drawer = await openDrawerIfNarrow(page);
    await page.locator('.vv-tree-row', { hasText: 'hello.js' }).click();
    await closeDrawerIfOpened(page, drawer);
    await expect(page.locator('.vv-code-pre')).toContainText('wsPinned', { timeout: 20_000 });

    // 右键固定目录 tab（host 含「:」正则元字符，用字符串文本精确定位）
    await dirTab.click({ button: 'right' });
    await expect(page.locator('.vv-tabctx')).toBeVisible();
    await page.getByRole('menuitem', { name: '固定', exact: true }).click();
    await expect(page.locator('.vv-tabctx')).toHaveCount(0);
    await expect(dirTab).toHaveAttribute('data-pinned', 'true');

    // 快照含目录条目（pinned:true）后刷新：远端重连重建来源（BUG-08 通道），
    // M-5 后快照目录条目忠实恢复（pinned 读回；此前整个目录 tab 丢失）
    await waitSnapshotTabs(page, [fake.host, 'hello.js']);
    await page.reload();
    await expect(page.locator('.vv-tab', { hasText: fake.host })).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.vv-tab', { hasText: fake.host })).toHaveAttribute(
      'data-pinned',
      'true'
    );
    await expect(page.locator('.vv-tab', { hasText: 'hello.js' })).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.vv-code-pre')).toContainText('wsPinned', { timeout: 20_000 });
    await expect(page.locator('.vv-error-card')).toHaveCount(0);
  } finally {
    await fake.close();
  }
});
