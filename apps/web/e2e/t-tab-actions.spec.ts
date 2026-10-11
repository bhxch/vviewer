import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, expect, type Locator, type Page } from '@playwright/test';
import { closeDrawerIfOpened, openDrawerIfNarrow } from './drawer';

/**
 * 浏览器式 tab 管理动作端到端（F 项 T3 收口；t- 前缀标记本轮新增）。
 * 用例（brief Step 2 的 6 条 + 控制器补充的 remote 撤销占位）：
 * - TA-01：右键菜单六动作逐一（含置灰态断言：关闭右侧/重新打开已关闭标签在
 *   置灰态可点击但无动作——TabContextMenu aria-disabled 语义）
 * - TA-02：pinned 豁免与拖拽（关闭其他 → pinned 幸存；dragTo 到 pinned 区拒绝
 *   序不变；普通区受理移动成立——后者同时证明 dragTo 机制真实触发 dnd，
 *   防拒绝断言的假通过）※仅 chromium project：375px 下四 tab 触发横向滚动，
 *   拖拽坐标不可靠（THEME-03 桌面基准惯例）
 * - TA-03：中键关闭 + Alt+Shift+T 撤销（关 2 个 → 两次撤销按 LIFO 恢复——批量
 *   关闭逐个入栈、单次撤销只恢复一个的记档口径；栈空 → 状态栏一次性提示）
 * - TA-04：复制标签页（新 tab 激活于原 tab 右侧且内容渲染，原件退居非激活）
 * - TA-05：刷新恢复——pinned + 组内快照序保持（restore 按快照数组序 addTab）；
 *   撤销栈清空（会话级内存态）+ unrestorable 占位的「复制标签页」置灰。
 *   注意（ledger M-5 规避）：不断言 pinned 目录 tab 跨刷新——restore 跳过
 *   path==='' 目录条目会丢 pin，T1 已记档为已知项，本任务不修
 * - TA-06：组内语义——双 workspace 下 closeOthers/撤销不泄漏到他组；撤销恢复
 *   落回原组（reopenClosed 的 workspaceId 归组）并切回该组；管理面板 pinned 徽标
 * - TA-07：remote tab 撤销 = 占位恢复（T1 记档口径：close 实现型 store 不捕获
 *   实例）——断言占位错误卡文案而非内容恢复；需先关目录 tab 使 store 无持有者
 *   （dir tab 仍在时 storeById 命中，撤销会拿回真实内容，不落占位）
 *
 * 通道：目录注入同 t-shell（__vvOpenDirImpl，webkitRelativePath 首段 = label）；
 * 右键 button:'right'、中键 button:'middle'、拖拽 dragTo（T2 报告接口提示）。
 */

interface Payload {
  name: string;
  type: string;
  content?: string;
}

const REG_SPECIAL = /[.*+?^${}()|[\]\\]/g;

/** 等应用挂载（svelte:window drop 监听与 TopBar 就绪；t-shell 同款） */
async function waitAppMounted(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(
    () => typeof (window as unknown as { __vvOpenDirImpl?: unknown }).__vvOpenDirImpl === 'function'
  );
  await expect(page.locator('.vv-topbar')).toBeVisible();
}

/** 目录注入通道（t-shell openDir 同款；label = webkitRelativePath 首段 = store 名） */
async function openDir(page: Page, payloads: Payload[], label = 'ttab'): Promise<void> {
  await page.waitForFunction(
    () => typeof (window as unknown as { __vvOpenDirImpl?: unknown }).__vvOpenDirImpl === 'function'
  );
  await page.evaluate(
    ({ payloads, label }) => {
      const files = payloads.map(({ name, type, content }) => {
        const f = new File([content ?? ''], name, { type: type ?? 'text/plain' });
        Object.defineProperty(f, 'webkitRelativePath', { value: `${label}/${name}` });
        return f;
      });
      return (window as unknown as { __vvOpenDirImpl: (f: File[]) => void }).__vvOpenDirImpl(files);
    },
    { payloads, label }
  );
}

/** 树行点击打开文件 tab（≤900px 抽屉断点适配，t-shell openFile 同款） */
async function openFile(page: Page, name: string): Promise<void> {
  const drawer = await openDrawerIfNarrow(page);
  await page.locator('.vv-tree-row', { hasText: name }).click();
  await closeDrawerIfOpened(page, drawer);
  await expect(tabNamed(page, name)).toBeVisible();
}

/** 精确名 tab 定位（.vv-tab-name 子元素锚定——tab 根级 textContent 含关闭钮「×」） */
function tabNamed(page: Page, name: string): Locator {
  return page
    .locator('.vv-tab')
    .filter({ has: page.locator('.vv-tab-name', { hasText: new RegExp(`^${name.replace(REG_SPECIAL, '\\$&')}$`) }) });
}

/** 非 ttab* 目录 tab 的文件 tab 集（t-shell SHELL-06 同口径） */
function fileTabs(page: Page): Locator {
  return page.locator('.vv-tab').filter({ has: page.locator('.vv-tab-name', { hasNotText: /^ttab/ }) });
}

/** 当前 tab 名序（DOM 序 = 组内 tab 序；pinned 锁形为 ::before 伪元素不入 textContent） */
function tabNames(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('.vv-tab .vv-tab-name')].map((el) => (el.textContent ?? '').trim())
  );
}

/** 右键打开 tab 菜单（TabContextMenu 浮层出现；同名 tab 用 nth 消歧） */
async function openTabMenu(page: Page, name: string, nth = 0): Promise<void> {
  await tabNamed(page, name).nth(nth).click({ button: 'right' });
  await expect(page.locator('.vv-tabctx')).toBeVisible();
}

/** 菜单项精确定位（role=menuitem + exact：「关闭」不被「关闭其他/关闭右侧」吞） */
function menuItem(page: Page, label: string): Locator {
  return page.getByRole('menuitem', { name: label, exact: true });
}

/** 执行可用菜单项（动作执行后必关——TabContextMenu.run 语义） */
async function runMenuItem(page: Page, label: string): Promise<void> {
  await menuItem(page, label).click();
  await expect(page.locator('.vv-tabctx')).toHaveCount(0);
}

/** 新建工作区并激活（t-workspace createWorkspace 同款） */
async function createWorkspace(page: Page, name: string): Promise<void> {
  await page.locator('.vv-ws-trigger').click();
  await page.getByRole('button', { name: '＋ 新建工作区…' }).click();
  const modal = page.locator('.vv-wscreate');
  await expect(modal).toBeVisible();
  await page.getByLabel('工作区名称').fill(name);
  await modal.getByRole('button', { name: '创建并激活' }).click();
  await expect(modal).toHaveCount(0);
  await expectActiveWorkspace(page, name);
}

/** 断言活动工作区名（t-workspace 同款：窄视口触发钮无组名，经下拉活动行核对） */
const WS_TRIGGER_NARROW_MQ = '(max-width: 600px)';

async function expectActiveWorkspace(page: Page, name: string): Promise<void> {
  const narrow = await page.evaluate((q) => window.matchMedia(q).matches, WS_TRIGGER_NARROW_MQ);
  if (!narrow) {
    await expect(page.locator('.vv-ws-trigger')).toContainText(name);
    return;
  }
  await page.locator('.vv-ws-trigger').click();
  await expect(page.locator('.vv-ws-item.active .vv-ws-name', { hasText: name })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.vv-ws-pop')).toHaveCount(0);
}

/** 切换工作区（TopBar switchTo 选中即关下拉） */
async function switchWorkspace(page: Page, name: string): Promise<void> {
  await page.locator('.vv-ws-trigger').click();
  await page.locator('.vv-ws-name', { hasText: name }).click();
  await expect(page.locator('.vv-ws-pop')).toHaveCount(0);
}

/** 等 workspaces 快照落盘（IndexedDB 'workspaces' 键；异步 persist 的确定性等待，
 * t-workspace waitSnapshotTabs 同款） */
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

/** 假 vviewer 文件服务器（t-workspace startFakeServer 同款：health/ticket/events SSE
 * 持挂 + CORS；tree/file 内存表。页面源 4173 跨源，所有响应带 ACAO:*） */
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
      return; // 保持打开、无数据帧
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
      server.closeAllConnections(); // /api/events 长连接需配套断连
      await new Promise<void>((ok) => server.close(() => ok()));
    }
  };
}

/** 连接表单提交（token 留空；t-workspace connectForm 同款） */
async function connectForm(page: Page, base: string): Promise<void> {
  await page.getByRole('button', { name: '连接服务器' }).click();
  await page.getByLabel('服务器地址').fill(base);
  await page.getByRole('button', { name: '连接', exact: true }).click();
}

// ---------------------------------------------------------------- TA-01

test('TA-01：右键菜单六动作逐一 + 置灰态可点击无动作', async ({ page }) => {
  test.setTimeout(60_000);
  await waitAppMounted(page);
  await openDir(page, [
    { name: 'aa.txt', type: 'text/plain', content: 'alpha body\n' },
    { name: 'bb.txt', type: 'text/plain', content: 'beta body\n' },
    { name: 'cc.txt', type: 'text/plain', content: 'gamma body\n' }
  ]);
  await openFile(page, 'aa.txt');
  await openFile(page, 'bb.txt');
  await openFile(page, 'cc.txt');
  await expect(fileTabs(page)).toHaveCount(3);

  // ① 置灰态（栈空 + 最右 tab 右侧无普通 tab）：项齐全、置灰项可点击但无动作
  await openTabMenu(page, 'cc.txt');
  await expect(page.locator('.vv-tabctx-item')).toHaveCount(6);
  await expect(menuItem(page, '关闭右侧')).toHaveAttribute('aria-disabled', 'true');
  await expect(menuItem(page, '重新打开已关闭标签')).toHaveAttribute('aria-disabled', 'true');
  await expect(menuItem(page, '关闭')).not.toHaveAttribute('aria-disabled', 'true');
  await expect(menuItem(page, '关闭其他')).not.toHaveAttribute('aria-disabled', 'true');
  await expect(menuItem(page, '复制标签页')).not.toHaveAttribute('aria-disabled', 'true');
  // 置灰项点击：Playwright 的 actionability 把 aria-disabled='true' 视为 disabled
  // （普通 click 会等待到超时）——force 跳过检查派发真实点击，组件 run() 对
  // disabled 不动作：菜单不关、tab 数不变
  await menuItem(page, '关闭右侧').click({ force: true });
  await expect(page.locator('.vv-tabctx')).toBeVisible();
  await expect(fileTabs(page)).toHaveCount(3);
  await menuItem(page, '重新打开已关闭标签').click({ force: true });
  await expect(page.locator('.vv-tabctx')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.vv-tabctx')).toHaveCount(0);

  // ② 关闭右侧（aa 右侧有普通 tab）：bb/cc 关闭，aa 幸存
  await openTabMenu(page, 'aa.txt');
  await expect(menuItem(page, '关闭右侧')).not.toHaveAttribute('aria-disabled', 'true');
  await runMenuItem(page, '关闭右侧');
  await expect(fileTabs(page)).toHaveCount(1);
  await expect.poll(() => tabNames(page)).toEqual(['ttab', 'aa.txt']);

  // ③ 重新打开已关闭标签（栈深 2）：LIFO 弹出 cc
  await openTabMenu(page, 'aa.txt');
  await expect(menuItem(page, '重新打开已关闭标签')).not.toHaveAttribute('aria-disabled', 'true');
  await runMenuItem(page, '重新打开已关闭标签');
  await expect.poll(() => tabNames(page)).toEqual(['ttab', 'aa.txt', 'cc.txt']);

  // ④ 固定/取消固定（动态换标签 + pinned 区靠左；unpin 落普通区首位——aa 原在
  //    pinned 槽即组首，空 pinned 区的普通区首位 = 原位，故序不变，去 data-pinned 即证据）
  await openTabMenu(page, 'aa.txt');
  await runMenuItem(page, '固定');
  await expect.poll(() => tabNames(page)).toEqual(['aa.txt', 'ttab', 'cc.txt']);
  await expect(tabNamed(page, 'aa.txt')).toHaveAttribute('data-pinned', 'true');
  await openTabMenu(page, 'aa.txt');
  await runMenuItem(page, '取消固定');
  await expect.poll(() => tabNames(page)).toEqual(['aa.txt', 'ttab', 'cc.txt']);
  await expect(tabNamed(page, 'aa.txt')).not.toHaveClass(/vv-tab-pinned/);

  // ⑤ 复制标签页：新 tab 激活于原 tab 右侧（aa 原在组首，副本插其右）
  await openTabMenu(page, 'aa.txt');
  await runMenuItem(page, '复制标签页');
  await expect.poll(() => tabNames(page)).toEqual(['aa.txt', 'aa.txt', 'ttab', 'cc.txt']);
  await expect(page.locator('.vv-tab.active', { hasText: 'aa.txt' })).toBeVisible();

  // ⑥ 关闭其他（锚 = 副本 nth(1)）：原件/ttab/cc 全关，仅副本幸存
  await openTabMenu(page, 'aa.txt', 1);
  await runMenuItem(page, '关闭其他');
  await expect.poll(() => tabNames(page)).toEqual(['aa.txt']);

  // ⑦ 关闭：归零空态
  await openTabMenu(page, 'aa.txt');
  await runMenuItem(page, '关闭');
  await expect(page.locator('.vv-tab')).toHaveCount(0);
  await expect(page.locator('.vv-empty')).toContainText('拖入文件/文件夹');
});

// ---------------------------------------------------------------- TA-02

test('TA-02：pinned 批量关闭豁免 + 拖拽跨区拒绝（dragTo）', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', '375px 下多 tab 横向滚动拖拽坐标不可靠——桌面基准（THEME-03 惯例）');
  test.setTimeout(60_000);
  await waitAppMounted(page);
  await openDir(page, [
    { name: 'aa.txt', type: 'text/plain', content: 'alpha body\n' },
    { name: 'bb.txt', type: 'text/plain', content: 'beta body\n' },
    { name: 'cc.txt', type: 'text/plain', content: 'gamma body\n' }
  ]);
  await openFile(page, 'aa.txt');
  await openFile(page, 'bb.txt');
  await openFile(page, 'cc.txt');

  // 固定 bb → pinned 区靠左
  await openTabMenu(page, 'bb.txt');
  await runMenuItem(page, '固定');
  await expect.poll(() => tabNames(page)).toEqual(['bb.txt', 'ttab', 'aa.txt', 'cc.txt']);

  // 跨区拒绝：普通 aa 拖到 pinned bb 左沿（before=true → 插入点落 pinned 区内 → 拒）
  await tabNamed(page, 'aa.txt').dragTo(tabNamed(page, 'bb.txt'), {
    targetPosition: { x: 3, y: 10 }
  });
  await expect.poll(() => tabNames(page)).toEqual(['bb.txt', 'ttab', 'aa.txt', 'cc.txt']);

  // 普通区受理（机制对照——证明 dragTo 真实触发 dnd，拒绝断言非假通过）：
  // aa 拖到 cc 右沿（显式坐标——dragTo 默认落点实测落在左半 before=true，
  // 对「aa 本就在 cc 左侧」是 no-op 重排；右沿 x=width-3 保证 before=false）
  const ccBox = await tabNamed(page, 'cc.txt').boundingBox();
  expect(ccBox).not.toBeNull();
  await tabNamed(page, 'aa.txt').dragTo(tabNamed(page, 'cc.txt'), {
    targetPosition: { x: ccBox!.width - 3, y: 10 }
  });
  await expect.poll(() => tabNames(page)).toEqual(['bb.txt', 'ttab', 'cc.txt', 'aa.txt']);

  // 批量关闭豁免：关闭其他（锚 aa）→ 非 pinned 的 ttab/cc 全关，pinned bb 幸存
  await openTabMenu(page, 'aa.txt');
  await runMenuItem(page, '关闭其他');
  await expect.poll(() => tabNames(page)).toEqual(['bb.txt', 'aa.txt']);
  await expect(tabNamed(page, 'bb.txt')).toHaveAttribute('data-pinned', 'true');
});

// ---------------------------------------------------------------- TA-03

test('TA-03：中键关闭 + Alt+Shift+T 两次撤销按 LIFO 恢复；栈空状态栏提示', async ({ page }) => {
  test.setTimeout(60_000);
  await waitAppMounted(page);
  await openDir(page, [
    { name: 'aa.txt', type: 'text/plain', content: 'alpha undo body\n' },
    { name: 'bb.txt', type: 'text/plain', content: 'beta undo body\n' }
  ]);
  await openFile(page, 'aa.txt');
  await openFile(page, 'bb.txt');

  // 中键关闭（auxclick button 1）两个：入栈序 [aa, bb]
  await tabNamed(page, 'aa.txt').click({ button: 'middle' });
  await expect(fileTabs(page)).toHaveCount(1);
  await tabNamed(page, 'bb.txt').click({ button: 'middle' });
  await expect(fileTabs(page)).toHaveCount(0);

  // Alt+Shift+T（e.code 判定）：LIFO 先恢复 bb——存活实例复用，内容渲染非占位
  await page.keyboard.press('Alt+Shift+T');
  await expect(page.locator('.vv-tab.active', { hasText: 'bb.txt' })).toBeVisible();
  await expect(page.locator('.vv-code-pre')).toContainText('beta undo body', { timeout: 20_000 });
  await expect(page.locator('.vv-error-card')).toHaveCount(0);

  // 第二次：恢复 aa
  await page.keyboard.press('Alt+Shift+T');
  await expect(page.locator('.vv-tab.active', { hasText: 'aa.txt' })).toBeVisible();
  await expect(page.locator('.vv-code-pre')).toContainText('alpha undo body', { timeout: 20_000 });
  await expect(page.locator('.vv-error-card')).toHaveCount(0);
  await expect(fileTabs(page)).toHaveCount(2);

  // 栈空：状态栏一次性提示（选型：反馈优于静默——BUG-19 同通道）
  await page.keyboard.press('Alt+Shift+T');
  await expect(page.locator('.vv-statusbar')).toContainText('没有可重新打开的标签页');
  await expect(fileTabs(page)).toHaveCount(2);
});

// ---------------------------------------------------------------- TA-04

test('TA-04：复制标签页——新 tab 激活于原 tab 右侧且内容渲染', async ({ page }) => {
  await waitAppMounted(page);
  await openDir(page, [{ name: 'aa.txt', type: 'text/plain', content: 'duplicable body\n' }]);
  await openFile(page, 'aa.txt');

  await openTabMenu(page, 'aa.txt');
  await runMenuItem(page, '复制标签页');
  await expect.poll(() => tabNames(page)).toEqual(['ttab', 'aa.txt', 'aa.txt']);
  // 副本激活 + 内容渲染（非占位）；原件退居非激活
  await expect(page.locator('.vv-tab.active', { hasText: 'aa.txt' })).toBeVisible();
  await expect(page.locator('.vv-code-pre')).toContainText('duplicable body', { timeout: 20_000 });
  await expect(page.locator('.vv-error-card')).toHaveCount(0);
  await expect(tabNamed(page, 'aa.txt').first()).not.toHaveClass(/active/);
});

// ---------------------------------------------------------------- TA-05

test('TA-05：刷新恢复——pinned 与组内快照序保持、撤销栈清空、占位复制置灰', async ({ page }) => {
  test.setTimeout(90_000);
  await waitAppMounted(page);
  await openDir(page, [
    { name: 'aa.txt', type: 'text/plain', content: 'alpha persist\n' },
    { name: 'bb.txt', type: 'text/plain', content: 'beta persist\n' },
    { name: 'cc.txt', type: 'text/plain', content: 'gamma persist\n' }
  ]);
  await openFile(page, 'aa.txt');
  await openFile(page, 'bb.txt');
  await openFile(page, 'cc.txt');
  await openTabMenu(page, 'bb.txt');
  await runMenuItem(page, '固定');
  await expect.poll(() => tabNames(page)).toEqual(['bb.txt', 'ttab', 'aa.txt', 'cc.txt']);

  // 快照落盘后刷新；本地 File 内容不跨刷新 → 文件 tab 恢复为占位（错误卡为信号）
  await waitSnapshotTabs(page, ['aa.txt', 'bb.txt', 'cc.txt']);
  await page.reload();
  await expect(page.locator('.vv-error-card').first()).toBeVisible({ timeout: 15_000 });

  // pinned + 顺序按快照数组序恢复（目录条目 path==='' 被跳过——既有 restore 行为；
  // ledger M-5 规避：不对 pinned 目录 tab 跨刷新设断言）
  await expect.poll(() => tabNames(page), { timeout: 10_000 }).toEqual(['bb.txt', 'aa.txt', 'cc.txt']);
  await expect(tabNamed(page, 'bb.txt')).toHaveAttribute('data-pinned', 'true');
  await expect(tabNamed(page, 'aa.txt')).not.toHaveClass(/vv-tab-pinned/);
  await expect(tabNamed(page, 'cc.txt')).not.toHaveClass(/vv-tab-pinned/);

  // 撤销栈会话级内存态：刷新即清空 → 「重新打开已关闭标签」置灰；
  // 占位 tab unrestorable → 「复制标签页」置灰
  await openTabMenu(page, 'bb.txt');
  await expect(menuItem(page, '重新打开已关闭标签')).toHaveAttribute('aria-disabled', 'true');
  await expect(menuItem(page, '复制标签页')).toHaveAttribute('aria-disabled', 'true');
  await expect(menuItem(page, '取消固定')).toBeVisible(); // pinned 动态标签读回后仍成立
  await page.keyboard.press('Escape');
  await expect(page.locator('.vv-tabctx')).toHaveCount(0);
});

// ---------------------------------------------------------------- TA-06

test('TA-06：组内语义——批量关闭/撤销不泄漏他组，撤销落回原组；面板 pinned 徽标', async ({
  page
}) => {
  test.setTimeout(90_000);
  await waitAppMounted(page);
  await openDir(page, [{ name: 'aa.txt', type: 'text/plain', content: 'group one body\n' }], 'ttab1');
  await openFile(page, 'aa.txt');
  await createWorkspace(page, '第二组');
  await openDir(page, [{ name: 'bb.txt', type: 'text/plain', content: 'group two body\n' }], 'ttab2');
  await openFile(page, 'bb.txt');

  // 第二组内固定 bb + 关闭其他
  await openTabMenu(page, 'bb.txt');
  await runMenuItem(page, '固定');
  await expect.poll(() => tabNames(page)).toEqual(['bb.txt', 'ttab2']);
  await openTabMenu(page, 'bb.txt');
  await runMenuItem(page, '关闭其他');
  await expect.poll(() => tabNames(page)).toEqual(['bb.txt']);

  // 管理面板：跨组总览（活动组在前）+ pinned 徽标（本任务 WorkspaceTabsPanel 交付）
  await page.keyboard.press('Alt+w');
  const panel = page.locator('.vv-wspanel');
  await expect(panel).toBeVisible();
  await expect(panel.locator('.vv-wspanel-row')).toHaveCount(3); // bb + ttab1 + aa
  await expect(
    panel.locator('.vv-wspanel-row', { hasText: 'bb.txt' }).locator('.vv-wspanel-pin')
  ).toBeVisible();
  await expect(
    panel.locator('.vv-wspanel-row', { hasText: 'aa.txt' }).locator('.vv-wspanel-pin')
  ).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);

  // 默认组未被第二组动作波及：ttab1 + aa 原样、内容可渲染
  await switchWorkspace(page, '默认');
  await expect.poll(() => tabNames(page)).toEqual(['ttab1', 'aa.txt']);
  await expect(page.locator('.vv-code-pre')).toContainText('group one body', { timeout: 20_000 });

  // 默认组中键关 aa → 切到第二组 → Alt+Shift+T：恢复落回「原组」默认并切回，
  // 不落当前组（reopenClosed 的 workspaceId 归组语义）
  await tabNamed(page, 'aa.txt').click({ button: 'middle' });
  await expect(fileTabs(page)).toHaveCount(0);
  await switchWorkspace(page, '第二组');
  await expect(page.locator('.vv-tab.active', { hasText: 'bb.txt' })).toBeVisible();
  await page.keyboard.press('Alt+Shift+T');
  await expectActiveWorkspace(page, '默认');
  await expect.poll(() => tabNames(page)).toEqual(['ttab1', 'aa.txt']);
  await expect(page.locator('.vv-tab.active', { hasText: 'aa.txt' })).toBeVisible();
});

// ---------------------------------------------------------------- TA-07

test('TA-07：remote tab 撤销为占位恢复（close 型 store 不捕获实例的记档口径）', async ({
  page
}) => {
  test.setTimeout(90_000);
  const fake = await startFakeServer({ 'hello.js': 'const remoteUndo = 7;\n' });
  try {
    await waitAppMounted(page);
    await connectForm(page, fake.base);
    await expect(tabNamed(page, fake.host)).toBeVisible({ timeout: 10_000 });
    const drawer = await openDrawerIfNarrow(page);
    await page.locator('.vv-tree-row', { hasText: 'hello.js' }).click();
    await closeDrawerIfOpened(page, drawer);
    await expect(page.locator('.vv-code-pre')).toContainText('remoteUndo', { timeout: 20_000 });

    // 先关文件 tab、再关目录 tab（顺序不可倒）：remote store 的 close() 会在失去
    // 最后持有者时清掉 remoteBaseById 的 base 登记（remote.ts close）——若先关目录
    //（store 随之终结），后关的文件 tab 快照取不到 storeBase，占位文案退化为本地版
    //（TA-07 首轮实测）。先文件（store 仍被目录 tab 持有，快照带 storeBase）后目录，
    // 撤销栈顶向下为 [目录, 文件]：两次撤销均落「服务器…重连后可恢复」占位
    await tabNamed(page, 'hello.js').locator('.vv-tab-close').click();
    await expect(tabNamed(page, 'hello.js')).toHaveCount(0);
    await tabNamed(page, fake.host).locator('.vv-tab-close').click();
    await expect(page.locator('.vv-tab')).toHaveCount(0);

    // 第一次撤销：目录 tab 占位（path==='' 显示目录来源引导，不在本用例断言）；
    // 第二次撤销：hello.js 占位——错误卡为服务器文案，内容不恢复（记档口径）
    await page.keyboard.press('Alt+Shift+T');
    await expect(page.locator('.vv-tab')).toHaveCount(1);
    await page.keyboard.press('Alt+Shift+T');
    await expect(page.locator('.vv-tab.active', { hasText: 'hello.js' })).toBeVisible();
    const card = page.locator('.vv-error-card');
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(card).toContainText(`服务器 ${fake.host} 的文件，重连后可恢复`);
    await expect(page.locator('.vv-code-pre')).toHaveCount(0);
  } finally {
    await fake.close();
  }
});
