import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, expect, type Page } from '@playwright/test';
import { closeDrawerIfOpened, openDrawerIfNarrow } from './drawer';

/**
 * workspace 富化域恢复链/错误语义面（WSX-07~12，编号对照
 * docs/e2e/workspace-enrichment.md 第 2/3 节；第二轮富化 default 套件）。
 * 与既有锚点分工：
 * - WS-05/06/07 只锚 basePath 源、根 0 源 pinned、单文件源的恢复；WSX-07 补
 *   根 1 整根源（storeId 带 :r1 段）刷新×2 回环 + rootIndex 透传恒 root=1；
 * - WS-02 的第二来源走 localfiles 注入；WSX-08 补「面板 ＋ 添加来源 → 后端路径…」
 *   把根 1 源并入既有组的双根双源并存恢复 + 根 1 pinned 目录 tab 跨根读回
 *   （上轮 MRF 缺口 c）；WS-04 只锚双组与根 0 remote/localfiles 恢复；
 * - MRF-07 只走通多根来源创建 happy-path；WSX-09/10 补 RemoteSourceModal 的
 *   断线/tree 越界 400/token 会话失效三种错误面（上轮 MRF 缺口 d）；
 * - WS-01 只锚删除活动组与合法重命名；WSX-11 补删最后一组兜底/重名允许/空名忽略，
 *   WSX-12 补三组切换后快照组序保序与逐组 tab 归属还原（WS-04 扩展面）。
 *
 * 通道：目录/文件注入走 drop（t-shell SHELL-03① 先例）；远端用 spec 内假双根
 * vviewer 服务器（t-workspace startFakeServer 扩展：health roots/rootPaths、
 * tree/file 携 root 参数路由、token 门可运行期轮换、指定 root 恒 400 注入、
 * events SSE 持挂；页面源 :4173 跨源 → 全响应带 ACAO:*，带 Authorization 头的
 * 请求回显 Access-Control-Request-Headers 放行预检）。
 * 双 project（chromium + mobile 375×667）：树行经 openDrawerIfNarrow 适配；
 * 切换器断言经 expectActiveWorkspace（≤600px 触发钮恒显「工作区 ▾」，走下拉活动行）。
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

/** 新建工作区（切换器 → 模态命名 → 创建并激活；t-workspace createWorkspace 同款） */
async function createWorkspace(page: Page, name: string): Promise<void> {
  await page.locator('.vv-ws-trigger').click();
  await page.getByRole('button', { name: '＋ 新建工作区…' }).click();
  const modal = page.locator('.vv-wscreate');
  await expect(modal).toBeVisible();
  await page.getByLabel('工作区名称').fill(name);
  await modal.getByRole('button', { name: '创建并激活' }).click();
  await expect(modal).toHaveCount(0);
  await expectActiveWorkspace(page, name); // 新建即激活（窄视口经下拉活动行核对）
}

/** 连接表单提交（t-srv connectForm 同款；token 留空——带 token 用例自行填访问令牌） */
async function connectForm(page: Page, base: string): Promise<void> {
  await page.getByRole('button', { name: '连接服务器' }).click();
  await page.getByLabel('服务器地址').fill(base);
  await page.getByRole('button', { name: '连接', exact: true }).click();
}

/** 经切换器下拉切组（switchTo 内 wsMenuOpen=false：选中即关） */
async function switchTo(page: Page, name: string): Promise<void> {
  await page.locator('.vv-ws-trigger').click();
  await page.locator('.vv-ws-name', { hasText: name }).click();
}

/**
 * 断言活动工作区名为 name（t-workspace expectActiveWorkspace 同款：宽视口直读
 * 触发钮文案；窄视口（≤600px）触发钮恒显「工作区 ▾」——经下拉活动行核对后 Esc 还原。
 * 须在下拉【关闭态】调用；重命名后下拉保持展开的场景请直断 .vv-ws-item.active）。
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

/** 快照三维视图：组序（登记序）/ 活动组名 / 逐组 tab 归属（WSX-12 保序断言面） */
interface SnapshotView {
  order: string[];
  activeName: string;
  groups: Array<{ name: string; tabs: string[] }>;
}

async function readWorkspacesSnapshot(page: Page): Promise<SnapshotView | null> {
  return page.evaluate(() => {
    return new Promise<SnapshotView | null>((resolve) => {
      const open = indexedDB.open('vviewer', 2);
      open.onsuccess = () => {
        const db = open.result;
        try {
          const get = db.transaction('kv', 'readonly').objectStore('kv').get('workspaces');
          get.onsuccess = () => {
            db.close();
            const snap = get.result as
              | {
                  activeId?: string;
                  workspaces?: { id?: string; name?: string; tabs?: { name?: string }[] }[];
                }
              | undefined;
            const items = snap?.workspaces;
            if (snap === undefined || !Array.isArray(items) || items.length === 0) {
              resolve(null);
              return;
            }
            const order = items.map((w) => w.name ?? '');
            const active = items.find((w) => w.id !== undefined && w.id === snap?.activeId);
            resolve({
              order,
              activeName: active?.name ?? '',
              groups: items.map((w) => ({
                name: w.name ?? '',
                tabs: (w.tabs ?? []).map((t) => t.name ?? '')
              }))
            });
          };
          get.onerror = () => {
            db.close();
            resolve(null);
          };
        } catch {
          db.close();
          resolve(null);
        }
      };
      open.onerror = () => resolve(null);
    });
  });
}

/**
 * 假双根 vviewer 文件服务器（t-workspace startFakeServer 扩展多根/token/故障注入）：
 * - health 免鉴权宣告 file-server；roots>1 时宣告 roots + rootPaths（根选择面）；
 * - ticket：token 门（tokenHolder.current 非 null 时校验 Bearer）→ 发票；
 * - tree/file：token 门（401 invalid token）+ root 参数路由（缺省 0；越界 400）+
 *   treeFailRoot 注入（指定 root 恒 400——服务端状态漂移模拟，WSX-09B）；
 * - events SSE 持挂（无数据帧）；全响应 ACAO:*，带 Authorization 的请求回显
 *   Access-Control-Request-Headers 放行预检（:4173 跨源）。
 */
interface FakeOptions {
  /** health rootPaths 宣告；长度即 roots 数（1 个时不宣告 roots——单根形状） */
  rootPaths: string[];
  /** rootIndex → (path → content) */
  files: Record<number, Record<string, string>>;
  /** 非空 = tree/ticket/file 需 `Bearer <current>`；运行期改写 current 模拟轮换 */
  tokenHolder?: { current: string | null };
  /** 指定 root 的 /api/tree 恒 400（treeFailDetail 为错误体 detail） */
  treeFailRoot?: number;
  treeFailDetail?: string;
}

interface FakeHandle {
  base: string;
  host: string;
  /** /api/file 请求记录（rootIndex 透传断言：query 的 root 参数） */
  fileRequests: Array<{ path: string; root: string | null }>;
  close: () => Promise<void>;
}

async function startWsxFakeServer(opts: FakeOptions): Promise<FakeHandle> {
  const fileRequests: Array<{ path: string; root: string | null }> = [];
  const roots = opts.rootPaths;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const cors: Record<string, string> = { 'Access-Control-Allow-Origin': '*' };
    if (req.method === 'OPTIONS') {
      // 带 Authorization/Content-Type 的跨源请求预检（token 用例；回显请求头清单）
      cors['Access-Control-Allow-Methods'] = 'GET,POST,OPTIONS';
      const reqHeaders = req.headers['access-control-request-headers'];
      cors['Access-Control-Allow-Headers'] = reqHeaders ?? 'authorization,content-type';
      res.writeHead(204, cors);
      res.end();
      return;
    }
    const auth = req.headers.authorization ?? '';
    const tokenOk =
      opts.tokenHolder === undefined ||
      opts.tokenHolder.current === null ||
      auth === `Bearer ${opts.tokenHolder.current}`;
    if (url.pathname === '/api/health') {
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          capabilities: ['file-server'],
          ...(roots.length > 1 ? { roots: roots.length, rootPaths: roots } : {})
        })
      );
      return;
    }
    if (url.pathname === '/api/ticket') {
      if (!tokenOk) {
        res.writeHead(401, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid token' }));
        return;
      }
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ticket: 'e2e' }));
      return;
    }
    if (url.pathname === '/api/events') {
      res.writeHead(200, { ...cors, 'Content-Type': 'text/event-stream' });
      return; // 保持打开、无数据帧：SSE 挂起即可（测试结束统一断连）
    }
    if (url.pathname === '/api/tree' || url.pathname === '/api/file') {
      if (!tokenOk) {
        res.writeHead(401, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid token' }));
        return;
      }
      const p = (url.searchParams.get('path') ?? '').replace(/^\/+|\/+$/g, '');
      const root = Number(url.searchParams.get('root') ?? '0');
      if (url.pathname === '/api/file') fileRequests.push({ path: p, root: url.searchParams.get('root') });
      if (!Number.isInteger(root) || root < 0 || root >= roots.length) {
        res.writeHead(400, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `root index out of range: ${root}` }));
        return;
      }
      if (url.pathname === '/api/tree' && opts.treeFailRoot === root) {
        res.writeHead(400, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: opts.treeFailDetail ?? `root index out of range: ${root}` }));
        return;
      }
      const table = opts.files[root] ?? {};
      if (url.pathname === '/api/tree') {
        const entries = new Map<string, 'dir' | 'file'>();
        const prefix = p === '' ? '' : `${p}/`;
        for (const key of Object.keys(table)) {
          if (!key.startsWith(prefix)) continue;
          const rest = key.slice(prefix.length);
          const head = rest.split('/')[0]!;
          entries.set(head, rest.includes('/') ? 'dir' : 'file');
        }
        res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            entries: [...entries].map(([name, kind]) => ({
              name,
              kind,
              ...(kind === 'file' ? { size: (table[`${prefix}${name}`] ?? '').length } : {})
            }))
          })
        );
        return;
      }
      const content = table[p];
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
    fileRequests,
    close: async () => {
      server.closeAllConnections(); // /api/events 长连接不 end：close() 需配套断连
      await new Promise<void>((ok) => server.close(() => ok()));
    }
  };
}

// ---------------------------------------------------------------- WSX-07

test('WSX-07：根1 remote 源（storeId :r1 段）刷新×2 恢复全链——rootIndex 透传恒 root=1 与树分组归属', async ({
  page
}) => {
  test.setTimeout(150_000);
  const fake = await startWsxFakeServer({
    rootPaths: ['/wsx-fake-root-0', '/wsx-fake-root-1'],
    files: {
      0: { 'decoy-r0.txt': 'root0 decoy\n' },
      1: { 'hello-r1.txt': 'wsx root1 roundtrip body\n' }
    }
  });
  try {
    const fileReqs: string[] = [];
    page.on('request', (r) => {
      if (new URL(r.url()).pathname === '/api/file') fileReqs.push(r.url());
    });
    await waitAppMounted(page);
    // 连接（根 0 源入默认组，写 last-server——恢复重连依据）
    await connectForm(page, fake.base);
    await expect(page.locator('.vv-tab', { hasText: fake.host })).toBeVisible({ timeout: 10_000 });

    // 新建工作区 → 后端路径浏览 → 根选择两按钮（文案 = rootPaths）→ 选根 1 → 整根作来源
    await page.locator('.vv-ws-trigger').click();
    await page.getByRole('button', { name: '＋ 新建工作区…' }).click();
    const modal = page.locator('.vv-wscreate');
    await expect(modal).toBeVisible();
    await page.getByLabel('工作区名称').fill('根1源组');
    await modal.getByRole('button', { name: '后端路径…' }).click();
    const browse = page.locator('.vv-remotesrc');
    await expect(browse).toBeVisible();
    const rootButtons = browse.locator('.vv-remotesrc-roots button');
    await expect(rootButtons).toHaveCount(2);
    await expect(rootButtons.nth(0)).toContainText('/wsx-fake-root-0');
    await expect(rootButtons.nth(1)).toContainText('/wsx-fake-root-1');
    await rootButtons.nth(1).click();
    await expect(browse.locator('.vv-remotesrc-rootback')).toContainText('/wsx-fake-root-1');
    // root1 子树清单：不见 root0 条目（health roots=2 选根后的浏览不串根）
    await expect(browse.locator('.vv-remotesrc-row', { hasText: 'hello-r1.txt' })).toBeVisible({
      timeout: 10_000
    });
    await expect(browse.locator('.vv-remotesrc-row', { hasText: 'decoy-r0.txt' })).toHaveCount(0);
    await browse.getByRole('button', { name: /将当前目录作为来源/ }).click();
    await expect(browse).toHaveCount(0);
    await modal.getByRole('button', { name: '创建并激活' }).click();
    await expect(modal).toHaveCount(0);

    // 根1 源目录 tab + 树单源分组（openFlow remoteSourceLabel rootIndex!==0 → 「· 根1/」）
    await expect(page.locator('.vv-tab', { hasText: '根1' })).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.vv-tree-src-label', { hasText: '根1' })).toBeVisible({
      timeout: 10_000
    });
    await expect(page.locator('.vv-tree-src-label')).toHaveCount(1);

    // 打开文件：内容渲染 + 请求恒带 root=1 + 零串根请求
    const drawer = await openDrawerIfNarrow(page);
    await page.locator('.vv-tree-row', { hasText: 'hello-r1.txt' }).click();
    await closeDrawerIfOpened(page, drawer);
    await expect(page.locator('.vv-tab.active', { hasText: 'hello-r1.txt' })).toBeVisible();
    await expect(page.locator('.vv-code-pre')).toContainText('wsx root1 roundtrip body', {
      timeout: 20_000
    });
    const helloReqs = () => fileReqs.filter((u) => u.includes('path=hello-r1.txt'));
    expect(helloReqs().length).toBeGreaterThanOrEqual(1);
    for (const u of helloReqs()) {
      expect(u, `根1 源文件请求必须带 root=1: ${u}`).toContain('root=1');
    }
    expect(fileReqs.filter((u) => u.includes('decoy-r0.txt'))).toEqual([]);

    // 快照落盘 → 刷新×2：快照 storeLabel 原值 + rootIndex 回环重建（:r1 storeId）
    await waitSnapshotTabs(page, ['hello-r1.txt']);
    for (let i = 0; i < 2; i++) {
      fileReqs.length = 0; // 重置计量：恢复后的读取单独核对
      await page.reload();
      await expect(page.locator('.vv-tab', { hasText: 'hello-r1.txt' })).toBeVisible({
        timeout: 15_000
      });
      await expect(page.locator('.vv-code-pre')).toContainText('wsx root1 roundtrip body', {
        timeout: 20_000
      });
      // 恢复链三面：树源分组（storeId 回环 → 源重建成功）、组归属、无占位
      await expect(page.locator('.vv-tree-src-label', { hasText: '根1' })).toBeVisible({
        timeout: 15_000
      });
      await expectActiveWorkspace(page, '根1源组');
      await expect(page.locator('.vv-error-card')).toHaveCount(0);
      // 恢复后的文件读取仍恒带 root=1（rootIndex 经快照 source 透传，非回落 0 号根）
      await expect.poll(() => helloReqs().length, { timeout: 15_000 }).toBeGreaterThanOrEqual(1);
      for (const u of helloReqs()) {
        expect(u, `恢复后请求仍必须带 root=1: ${u}`).toContain('root=1');
      }
      expect(fileReqs.filter((u) => u.includes('decoy-r0.txt'))).toEqual([]);
    }
  } finally {
    await fake.close();
  }
});

// ---------------------------------------------------------------- WSX-08

test('WSX-08：面板「＋ 添加来源」并入根1 源——双根双源并存恢复 + 根1 pinned 目录 tab 跨根读回（M-5）', async ({
  page
}) => {
  test.setTimeout(150_000);
  const fake = await startWsxFakeServer({
    rootPaths: ['/wsx-fake-root-0', '/wsx-fake-root-1'],
    files: {
      0: { 'decoy-r0.txt': 'root0 decoy\n' },
      1: { 'hello-r1.txt': 'wsx dual source body\n' }
    }
  });
  try {
    const fileReqs: string[] = [];
    page.on('request', (r) => {
      if (new URL(r.url()).pathname === '/api/file') fileReqs.push(r.url());
    });
    await waitAppMounted(page);
    await connectForm(page, fake.base);
    // host 目录 tab（根 0 整根源；根 1 tab 名含 host 但另有「· 根1/」——用 hasNotText 区分）
    const hostTab = page.locator('.vv-tab', { hasText: fake.host }).filter({ hasNotText: '根1' });
    await expect(hostTab).toBeVisible({ timeout: 10_000 });

    // Alt+W 面板 → 默认组「＋ 添加来源」→ 后端路径… → 选根 1 → 整根作来源（入当前组）
    await page.keyboard.press('Alt+w');
    const panel = page.locator('.vv-wspanel');
    await expect(panel).toBeVisible();
    await panel.locator('.vv-wspanel-addbtn', { hasText: '＋ 添加来源' }).click();
    await panel.getByRole('button', { name: '后端路径…' }).click();
    const browse = page.locator('.vv-remotesrc');
    await expect(browse).toBeVisible();
    await browse.locator('.vv-remotesrc-roots button').nth(1).click();
    await expect(browse.locator('.vv-remotesrc-row', { hasText: 'hello-r1.txt' })).toBeVisible({
      timeout: 10_000
    });
    await browse.getByRole('button', { name: /将当前目录作为来源/ }).click();
    await expect(browse).toHaveCount(0);
    await page.keyboard.press('Escape'); // 关面板（来源已入组）
    await expect(panel).toHaveCount(0);

    // 同组双源并存：两目录 tab、树两源分组、tab 来源徽标×2（多源才显示）。
    // root1 定位须排除文件 tab——多源下文件 tab 也带「· 根1/」来源徽标文本
    const root1Tab = page
      .locator('.vv-tab', { hasText: '根1' })
      .filter({ hasNotText: 'hello-r1.txt' });
    await expect(root1Tab).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.vv-tree-src-label', { hasText: '根1' })).toBeVisible({
      timeout: 10_000
    });
    await expect(page.locator('.vv-tree-src-label')).toHaveCount(2);
    await expect(page.locator('.vv-tab-src')).toHaveCount(2);

    // 右键固定根 1 目录 tab（跨根 pinned）；根 0 host tab 不固定（对照）。
    // 窄视口下双 tab + 管理钮溢出 tabbar：先滚入并等滚动安静——TabContextMenu
    // 对任意滚动（window capture）即关，右键自动滚动尾随的 scroll 事件会把
    // 刚弹出的菜单立即关掉（单 tab 的 WS-06 无溢出不触发）
    await root1Tab.scrollIntoViewIfNeeded();
    await page.waitForTimeout(250);
    await root1Tab.click({ button: 'right' });
    await expect(page.locator('.vv-tabctx')).toBeVisible();
    await page.getByRole('menuitem', { name: '固定', exact: true }).click();
    await expect(page.locator('.vv-tabctx')).toHaveCount(0);
    await expect(root1Tab).toHaveAttribute('data-pinned', 'true');
    await expect(hostTab).not.toHaveAttribute('data-pinned', 'true');

    // 打开根 1 文件：内容 + root=1 透传
    const drawer = await openDrawerIfNarrow(page);
    await page.locator('.vv-tree-row', { hasText: 'hello-r1.txt' }).click();
    await closeDrawerIfOpened(page, drawer);
    await expect(page.locator('.vv-code-pre')).toContainText('wsx dual source body', {
      timeout: 20_000
    });
    const helloReqs = () => fileReqs.filter((u) => u.includes('path=hello-r1.txt'));
    expect(helloReqs().length).toBeGreaterThanOrEqual(1);
    for (const u of helloReqs()) expect(u).toContain('root=1');

    // 快照落盘（双目录 tab + 文件 tab）→ 刷新：双源恢复 + pinned 跨根读回
    await waitSnapshotTabs(page, ['根1', 'hello-r1.txt']);
    fileReqs.length = 0;
    await page.reload();
    await expect(
      page.locator('.vv-tab', { hasText: fake.host }).filter({ hasNotText: '根1' })
    ).toBeVisible({ timeout: 15_000 });
    const restoredRoot1 = page
      .locator('.vv-tab', { hasText: '根1' })
      .filter({ hasNotText: 'hello-r1.txt' });
    await expect(restoredRoot1).toBeVisible({ timeout: 15_000 });
    await expect(restoredRoot1).toHaveAttribute('data-pinned', 'true'); // M-5 根 1 读回
    await expect(
      page.locator('.vv-tab', { hasText: fake.host }).filter({ hasNotText: '根1' })
    ).not.toHaveAttribute('data-pinned', 'true'); // 根 0 不被误标
    await expect(page.locator('.vv-tree-src-label')).toHaveCount(2);
    await expect(page.locator('.vv-code-pre')).toContainText('wsx dual source body', {
      timeout: 20_000
    });
    await expect(page.locator('.vv-error-card')).toHaveCount(0);
    await expect.poll(() => helloReqs().length, { timeout: 15_000 }).toBeGreaterThanOrEqual(1);
    for (const u of helloReqs()) {
      expect(u, `恢复后请求仍必须带 root=1: ${u}`).toContain('root=1');
    }
  } finally {
    await fake.close();
  }
});

// ---------------------------------------------------------------- WSX-09

test('WSX-09：RemoteSourceModal 错误语义——断线（网络层）与 tree 越界 400（服务端层）+ 重试/切根自愈', async ({
  page
}) => {
  test.setTimeout(150_000);
  await waitAppMounted(page);

  // ---- A 断线：连接成功后关停服务器 → 浏览层 init 的 health fetch 网络失败 ----
  const fakeA = await startWsxFakeServer({
    rootPaths: ['/wsx-a-root'],
    files: { 0: { 'a.txt': 'offline canary\n' } }
  });
  await connectForm(page, fakeA.base);
  await expect(page.locator('.vv-tree-row', { hasText: 'a.txt' })).toBeVisible({ timeout: 10_000 });
  await fakeA.close();

  await page.locator('.vv-ws-trigger').click();
  await page.getByRole('button', { name: '＋ 新建工作区…' }).click();
  const modal = page.locator('.vv-wscreate');
  await expect(modal).toBeVisible();
  await modal.getByRole('button', { name: '后端路径…' }).click();
  const browse = page.locator('.vv-remotesrc');
  await expect(browse).toBeVisible();
  const errA = browse.locator('.vv-remotesrc-error');
  await expect(errA).toContainText('无法连接', { timeout: 15_000 });
  await expect(errA).toContainText('网络错误或地址不可达');
  await expect(errA).toHaveAttribute('role', 'alert');
  await expect(browse.getByRole('button', { name: '重试' })).toBeVisible();
  // Esc 退出浏览层与创建模态（容器焦点 → 浏览层先关；焦点回外层 → 再 Esc 关模态）
  await page.keyboard.press('Escape');
  await expect(browse).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(modal).toHaveCount(0);

  // ---- B tree 越界 400（服务端状态漂移：health 宣告双根但 root=1 恒 400）----
  const fakeB = await startWsxFakeServer({
    rootPaths: ['/wsx-b-root-0', '/wsx-b-root-1'],
    files: { 0: { 'b0.txt': 'root0 fine\n' } },
    treeFailRoot: 1,
    treeFailDetail: 'root index out of range: 1'
  });
  await connectForm(page, fakeB.base);
  await expect(page.locator('.vv-tree-row', { hasText: 'b0.txt' }).first()).toBeVisible({
    timeout: 10_000
  });
  await page.locator('.vv-ws-trigger').click();
  await page.getByRole('button', { name: '＋ 新建工作区…' }).click();
  await expect(modal).toBeVisible();
  await modal.getByRole('button', { name: '后端路径…' }).click();
  await expect(browse).toBeVisible();
  await browse.locator('.vv-remotesrc-roots button').nth(1).click();
  // 错误体 detail 透传（`服务器请求失败: HTTP <status>: <detail>`，RemoteSourceModal:133-141）
  const errB = browse.locator('.vv-remotesrc-error');
  await expect(errB).toContainText('服务器请求失败: HTTP 400: root index out of range: 1', {
    timeout: 15_000
  });
  // 重试：服务端仍坏 → 错误持续（不崩溃、不假成功）
  await browse.getByRole('button', { name: '重试' }).click();
  await expect(errB).toContainText('HTTP 400', { timeout: 15_000 });
  // 切根自愈：「← 重选根」回根 0 → 条目正常列出、错误清除
  await browse.locator('.vv-remotesrc-rootback').click();
  await browse.locator('.vv-remotesrc-roots button').nth(0).click();
  await expect(browse.locator('.vv-remotesrc-row', { hasText: 'b0.txt' })).toBeVisible({
    timeout: 10_000
  });
  await expect(browse.locator('.vv-remotesrc-error')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(browse).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(modal).toHaveCount(0);
});

// ---------------------------------------------------------------- WSX-10

test('WSX-10：RemoteSourceModal token 会话失效 401——状态码与服务端 detail 透传、重试持续、应用不受伤', async ({
  page
}) => {
  test.setTimeout(120_000);
  const token = { current: 'wsx-tok-1' };
  const fake = await startWsxFakeServer({
    rootPaths: ['/wsx-c-root'],
    files: { 0: { 'c.txt': 'token gated\n' } },
    tokenHolder: token
  });
  try {
    await waitAppMounted(page);
    // 带 token 连接（访问令牌表单；ticket 鉴权预检 + tree 均过）
    await page.getByRole('button', { name: '连接服务器' }).click();
    await page.getByLabel('服务器地址').fill(fake.base);
    await page.getByLabel('访问令牌').fill('wsx-tok-1');
    await page.getByRole('button', { name: '连接', exact: true }).click();
    await expect(page.locator('.vv-tree-row', { hasText: 'c.txt' })).toBeVisible({
      timeout: 10_000
    });

    // 服务端轮换 token（模拟凭据会话中失效；health 免鉴权照常可达）
    token.current = 'wsx-tok-2';

    await page.locator('.vv-ws-trigger').click();
    await page.getByRole('button', { name: '＋ 新建工作区…' }).click();
    const modal = page.locator('.vv-wscreate');
    await expect(modal).toBeVisible();
    await modal.getByRole('button', { name: '后端路径…' }).click();
    // 单根（无 roots 宣告）直进浏览 → tree 401：状态码 + 服务端错误体 detail 透传
    const browse = page.locator('.vv-remotesrc');
    await expect(browse).toBeVisible();
    const err = browse.locator('.vv-remotesrc-error');
    await expect(err).toContainText('服务器请求失败: HTTP 401: invalid token', { timeout: 15_000 });
    // 重试：凭据仍失效 → 401 持续
    await browse.getByRole('button', { name: '重试' }).click();
    await expect(err).toContainText('HTTP 401', { timeout: 15_000 });
    // Esc 退出两层后应用不受伤（token 错误卡片语义不阻断会话）
    await page.keyboard.press('Escape');
    await expect(browse).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(modal).toHaveCount(0);
    await expect(page.locator('.vv-topbar')).toBeVisible();
  } finally {
    await fake.close();
  }
});

// ---------------------------------------------------------------- WSX-11

test('WSX-11：切换器删除/重命名边界——删最后一组建新默认、重命名重名允许（id 身份）、空名忽略', async ({
  page
}) => {
  test.setTimeout(120_000);
  await waitAppMounted(page);
  page.on('dialog', (d) => void d.accept()); // 删除确认走 window.confirm（默认 dismiss 须挂接受）
  await dropFile(page, 'wsx-a.txt', 'a body\n');
  const trigger = page.locator('.vv-ws-trigger');

  // ① 删除最后一组：新「默认」兜底（至少一个不变式）+ 连带关 tab
  await trigger.click();
  await page.getByRole('button', { name: '删除工作区 默认' }).click();
  await expect(page.locator('.vv-ws-item')).toHaveCount(1);
  await expect(page.locator('.vv-ws-item.active .vv-ws-name', { hasText: '默认' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.vv-ws-pop')).toHaveCount(0);
  await expect(page.locator('.vv-tab')).toHaveCount(0);

  // ② 重建两组成员：组乙（wsx-b）/ 默认（wsx-a2）
  await createWorkspace(page, '组乙');
  await dropFile(page, 'wsx-b.txt', 'b body\n');
  await switchTo(page, '默认');
  await dropFile(page, 'wsx-a2.txt', 'a2 body\n');

  // ③ 重命名默认 → 「组乙」（与既有组重名：允许；id 为身份不合并）
  await trigger.click();
  await page.getByRole('button', { name: '重命名工作区 默认' }).click();
  const rename = page.getByLabel('重命名工作区', { exact: true });
  await expect(rename).toBeVisible();
  await rename.fill('组乙');
  await page.getByRole('button', { name: '确认重命名' }).click();
  // 下拉保持展开：两行「组乙」并存；活动行即被改名组、其 tab 仍在（改名不清 tab）
  await expect(page.locator('.vv-ws-name', { hasText: '组乙' })).toHaveCount(2);
  await expect(page.locator('.vv-ws-item.active .vv-ws-name', { hasText: '组乙' })).toBeVisible();
  await expect(page.locator('.vv-tab.active', { hasText: 'wsx-a2.txt' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.vv-ws-pop')).toHaveCount(0);
  await expectActiveWorkspace(page, '组乙');

  // ④ 切到另一「组乙」行：身份独立、tab 各归各组（重名不串组）
  await trigger.click();
  await page
    .locator('.vv-ws-item:not(.active)')
    .filter({ hasText: '组乙' })
    .locator('.vv-ws-name')
    .click();
  await expect(page.locator('.vv-tab.active', { hasText: 'wsx-b.txt' })).toBeVisible();
  await expect(page.locator('.vv-tab')).toHaveCount(1);

  // ⑤ 活动组重命名为空串：commitRename 忽略（表单关闭、名称保持）
  await trigger.click();
  await page
    .locator('.vv-ws-item.active')
    .getByRole('button', { name: '重命名工作区 组乙' })
    .click();
  const rename2 = page.getByLabel('重命名工作区', { exact: true });
  await expect(rename2).toBeVisible();
  await rename2.fill('');
  await page.getByRole('button', { name: '确认重命名' }).click();
  await expect(page.locator('.vv-ws-name', { hasText: '组乙' })).toHaveCount(2);
  await page.keyboard.press('Escape');
  await expect(page.locator('.vv-ws-pop')).toHaveCount(0);
  await expectActiveWorkspace(page, '组乙');
});

// ---------------------------------------------------------------- WSX-12

test('WSX-12：三组切换后刷新——快照组序保序、活动组还原、组内 tab 归属逐组还原', async ({ page }) => {
  test.setTimeout(150_000);
  await waitAppMounted(page);
  await dropFile(page, 'wsx-d0.txt', 'd0 body\n');
  await createWorkspace(page, '甲组');
  await dropFile(page, 'wsx-d1.txt', 'd1 body\n');
  await createWorkspace(page, '乙组');
  await dropFile(page, 'wsx-d2.txt', 'd2 body\n');
  // 多组切换（活动组多次易主后停在末组）——切换不得重排组序
  await switchTo(page, '甲组');
  await switchTo(page, '默认');
  await switchTo(page, '乙组');
  await expectActiveWorkspace(page, '乙组');

  // ① 直读 IndexedDB 快照：组序 = 登记序、activeId = 乙组、tab 各归各组
  let snap: SnapshotView | null = null;
  await expect
    .poll(
      async () => {
        snap = await readWorkspacesSnapshot(page);
        return (
          snap !== null &&
          snap.groups.length === 3 &&
          snap.groups.every((g) => g.tabs.length === 1)
        );
      },
      { timeout: 15_000 }
    )
    .toBe(true);
  // TS 控制流不追踪 expect.poll 回调内对 snap 的赋值（窄化为 null），双跳断言取真值
  const finalSnap = snap as unknown as SnapshotView;
  expect(finalSnap.order).toEqual(['默认', '甲组', '乙组']);
  expect(finalSnap.activeName).toBe('乙组');
  expect(finalSnap.groups.map((g) => `${g.name}:${g.tabs.join(',')}`)).toEqual([
    '默认:wsx-d0.txt',
    '甲组:wsx-d1.txt',
    '乙组:wsx-d2.txt'
  ]);

  // ② 刷新 → ③ 活动组与组序还原（组序不因切换重排——replaceAll 按 list 序写回）
  await page.reload();
  await expectActiveWorkspace(page, '乙组');
  await page.locator('.vv-ws-trigger').click();
  await expect(page.locator('.vv-ws-item')).toHaveCount(3);
  const names = await page.locator('.vv-ws-item .vv-ws-name').allInnerTexts();
  expect(names.map((n) => n.trim())).toEqual(['默认', '甲组', '乙组']);
  await page.keyboard.press('Escape');
  await expect(page.locator('.vv-ws-pop')).toHaveCount(0);

  // ④ 组内 tab 归属逐组还原（single 源不跨刷新 → 占位错误卡）
  await expect(page.locator('.vv-tab.active', { hasText: 'wsx-d2.txt' })).toBeVisible({
    timeout: 15_000
  });
  await expect(page.locator('.vv-error-card')).toContainText('需要重新打开', { timeout: 15_000 });
  await switchTo(page, '甲组');
  await expect(page.locator('.vv-tab.active', { hasText: 'wsx-d1.txt' })).toBeVisible({
    timeout: 15_000
  });
  await expect(page.locator('.vv-error-card')).toContainText('需要重新打开', { timeout: 15_000 });
  await switchTo(page, '默认');
  await expect(page.locator('.vv-tab.active', { hasText: 'wsx-d0.txt' })).toBeVisible({
    timeout: 15_000
  });
  await expect(page.locator('.vv-error-card')).toContainText('需要重新打开', { timeout: 15_000 });
});
