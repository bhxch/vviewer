import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, expect, type Locator, type Page } from '@playwright/test';
import { closeDrawerIfOpened, openDrawerIfNarrow } from './drawer';

/**
 * tab 动作富化（撤销栈与拖拽受理边界）e2e（b- 前缀第二轮富化；场景文档
 * docs/e2e/tab-actions-enrichment.md，与既有锚 TA-01~08 无重叠）：
 * - TAX-01：撤销栈容量 10 挤出——连关 11 个第 1 个不可恢复（CLOSED_STACK_MAX），
 *   10 次恢复严格 LIFO 逐个落组尾，第 11 次状态栏提示
 * - TAX-02：拖拽受理边界·普通区——自身原位拒（序不变）、邻位交换受理、drop 落
 *   tabbar 容器外取消（dragend 清理；窗口级 drop 对无文件拖拽 no-op）※仅 chromium
 * - TAX-03：拖拽受理边界·pinned 区——普通 tab 恰区尾（第一个普通位）受理、落
 *   pinned 区内拒（悬停中无 dragover 指示）、pinned 越区尾拒（回弹=序不变）、
 *   pinned 区内受理（悬停中有指示 + data-drop-before）※仅 chromium
 * - TAX-04：全 pinned 批量关闭——closeRight 置灰可点击无动作、closeOthers 无动作
 *   （全员豁免，含 pin 了 dir tab 的纯化形态）、unpin 后放行（非 pinned 被关）
 * - TAX-05：duplicate(pinned)——副本插原 tab 右侧（pinned 区内）继承 pinned 且激活；
 *   关闭副本撤销恢复归位 pinned 区尾而非原位（regroupAfterPinFlip）
 * - TAX-06：中键双事件防御——mousedown(button1) preventDefault 且不关闭（左键不拦）、
 *   auxclick(button1) 才接线关闭恰一次；两次点击恰 2 条撤销条目，第 3 次撤销提示
 * - TAX-07：焦点在 .vv-search-input 内 Alt+Shift+T 不误触（AppShell inField 拦截：
 *   不恢复、无栈空提示、焦点保持）；Esc 出框后同键恢复生效（现状锚定）
 * - TAX-08：快照恢复后立即撤销——栈为会话级（刷新即清）：提示、无幽灵恢复、
 *   重复按幂等
 * - TAX-09：同 base 重连清扫豁免撤销栈（undoable:false）——换 token 重连触发清扫
 *   （token 一致走实例复用不清扫），目录与文件 tab 一并清扫（SUS-TAX-1 修复：
 *   先收集后关，不依赖逐一关闭后的 remoteBaseById 存活）且不入栈不复活：撤销
 *   恢复的是先前用户关闭的本地 tab；node:http 假服务器自包含
 * - TAX-10：拖拽重排不入撤销栈——重排后撤销仍恢复最近「关闭」的 tab 且重排序保持
 *   ※仅 chromium
 *
 * 通道：目录注入同 t-shell/t-tab-actions（__vvOpenDirImpl，webkitRelativePath 首段
 * = label）；组序断言 .vv-tab .vv-tab-name DOM 序（pinned 锁形 ::before 不入
 * textContent）；右键 button:'right'、中键 button:'middle'、拖拽 dragTo/手动 mouse
 * 序（悬停中读受理指示）。窄视口经 drawer.ts 适配，不修改任何既有文件。
 */

interface Payload {
  name: string;
  type: string;
  content?: string;
}

const REG_SPECIAL = /[.*+?^${}()|[\]\\]/g;

const UNDO_NOTICE = '没有可重新打开的标签页';

/** 等应用挂载（svelte:window drop 监听与 TopBar 就绪；t-shell 同款） */
async function waitAppMounted(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(
    () => typeof (window as unknown as { __vvOpenDirImpl?: unknown }).__vvOpenDirImpl === 'function'
  );
  await expect(page.locator('.vv-topbar')).toBeVisible();
}

/** 目录注入通道（__vvOpenDirImpl；label = webkitRelativePath 首段 = store 名 = dir tab 名） */
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

/** 当前 tab 名序（DOM 序 = 组内 tab 序） */
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

/** 菜单项精确定位（role=menuitem + exact：「固定」不被「取消固定」吞） */
function menuItem(page: Page, label: string): Locator {
  return page.getByRole('menuitem', { name: label, exact: true });
}

/** 执行可用菜单项（动作执行后必关——TabContextMenu.run 语义） */
async function runMenuItem(page: Page, label: string): Promise<void> {
  await menuItem(page, label).click();
  await expect(page.locator('.vv-tabctx')).toHaveCount(0);
}

/** 经菜单固定/取消固定（pinned 动态换标签；nth 消歧同名 tab） */
async function pinTab(page: Page, name: string, nth = 0): Promise<void> {
  await openTabMenu(page, name, nth);
  await runMenuItem(page, '固定');
}

async function unpinTab(page: Page, name: string, nth = 0): Promise<void> {
  await openTabMenu(page, name, nth);
  await runMenuItem(page, '取消固定');
}

/** 假 vviewer 文件服务器（t-workspace/TA-07 先例：health/ticket/events SSE 持挂 +
 * CORS；tree/file 内存表。页面源 4173 跨源，所有响应带 ACAO:*） */
async function startFakeServer(
  files: Record<string, string>
): Promise<{ base: string; host: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const cors = { 'Access-Control-Allow-Origin': '*' };
    if (req.method === 'OPTIONS') {
      // CORS 预检：带 authorization 头的请求（token 重连）是非简单请求——
      // 无预检应答则浏览器判预检失败，fetch 抛网络错误（夹具缺陷，先例只覆盖
      // 无鉴权简单请求）
      res.writeHead(204, {
        ...cors,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'authorization, content-type',
        'Access-Control-Max-Age': '600'
      });
      res.end();
      return;
    }
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

/** 连接表单提交（TopBar 内联表单；token 缺省留空——留空/有值决定重连清扫 vs 实例复用） */
async function connectForm(page: Page, base: string, token = ''): Promise<void> {
  await page.getByRole('button', { name: '连接服务器' }).click();
  await page.getByLabel('服务器地址').fill(base);
  if (token !== '') await page.getByLabel('访问令牌').fill(token);
  await page.getByRole('button', { name: '连接', exact: true }).click();
}

/** 等 workspaces 快照落盘（IndexedDB 'workspaces' 键；异步 persist 的确定性等待，
 * t-tab-actions waitSnapshotTabs 同款） */
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

/** 对指定名的 tab 合成派发事件并返回该事件是否被 preventDefault（TAX-06 接线判定） */
async function dispatchOnTab(
  page: Page,
  name: string,
  type: 'mousedown' | 'auxclick',
  button: number
): Promise<boolean | null> {
  return page.evaluate(
    ({ name, type, button }) => {
      const tabs = [...document.querySelectorAll('.vv-tab')];
      const el = tabs.find(
        (t) => t.querySelector('.vv-tab-name')?.textContent?.trim() === name
      );
      if (el === undefined || el === null) return null;
      const ev = new MouseEvent(type, { button, bubbles: true, cancelable: true });
      el.dispatchEvent(ev);
      return ev.defaultPrevented;
    },
    { name, type, button }
  );
}

// ---------------------------------------------------------------- TAX-01

test('TAX-01：撤销栈容量 10 挤出——连关 11 个第 1 个不可恢复，LIFO 严格，栈空提示', async ({
  page
}) => {
  test.setTimeout(120_000);
  await waitAppMounted(page);
  const names = Array.from({ length: 11 }, (_, i) => `f${String(i + 1).padStart(2, '0')}.txt`);
  await openDir(
    page,
    names.map((n, i) => ({ name: n, type: 'text/plain', content: `body-${String(i + 1).padStart(2, '0')}\n` }))
  );
  for (const n of names) await openFile(page, n);
  await expect(fileTabs(page)).toHaveCount(11);
  await expect.poll(() => tabNames(page)).toEqual(['ttab', ...names]);

  // ① 按序中键关闭 f01→f11：11 条入栈请求，容量 10 淘汰栈底（f01）
  for (const n of names) await tabNamed(page, n).click({ button: 'middle' });
  await expect(fileTabs(page)).toHaveCount(0);
  await expect.poll(() => tabNames(page)).toEqual(['ttab']);

  // ② 10 次撤销严格 LIFO：恢复序 f11→f02，逐个落组尾；f01 从不出现
  for (let i = 1; i <= 10; i++) {
    await page.keyboard.press('Alt+Shift+T');
    const restored = names.slice(11 - i).reverse(); // [f11, f10, …, f(12-i)]
    await expect.poll(() => tabNames(page)).toEqual(['ttab', ...restored]);
    // 首次恢复即渲染内容非占位（localfiles store 经撤销栈捕获/注册表存活；
    // 此刻活动 tab = 刚恢复的 f11）
    if (i === 1) {
      await expect(page.locator('.vv-code-pre')).toContainText('body-11', { timeout: 20_000 });
      await expect(page.locator('.vv-error-card')).toHaveCount(0);
    }
  }
  // 循环结束后活动 tab = 最后恢复的 f02（内容渲染旁证）
  await expect(page.locator('.vv-code-pre')).toContainText('body-02', { timeout: 20_000 });

  // ③ 第 11 次：栈空提示；f01 被挤出永不可恢复，现场不变
  await page.keyboard.press('Alt+Shift+T');
  await expect(page.locator('.vv-statusbar')).toContainText(UNDO_NOTICE);
  await expect.poll(() => tabNames(page)).toEqual(['ttab', ...names.slice(1).reverse()]);
  await expect(tabNamed(page, 'f01.txt')).toHaveCount(0);
  await expect(fileTabs(page)).toHaveCount(10);
});

// ---------------------------------------------------------------- TAX-02

test('TAX-02：拖拽受理边界·普通区——自身原位拒、邻位交换受理、容器外 drop 取消', async ({
  page
}, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', '375px 下多 tab 横向滚动拖拽坐标不可靠——桌面基准（TA-02 惯例）');
  await waitAppMounted(page);
  await openDir(page, [
    { name: 'aa.txt', type: 'text/plain', content: 'alpha\n' },
    { name: 'bb.txt', type: 'text/plain', content: 'beta\n' },
    { name: 'cc.txt', type: 'text/plain', content: 'gamma\n' }
  ]);
  await openFile(page, 'aa.txt');
  await openFile(page, 'bb.txt');
  await openFile(page, 'cc.txt');
  const BASE = ['ttab', 'aa.txt', 'bb.txt', 'cc.txt'];
  await expect.poll(() => tabNames(page)).toEqual(BASE);

  // ① 拖到自身左沿：fromId===toId → reorderIds null 拒绝，序不变
  await tabNamed(page, 'aa.txt').dragTo(tabNamed(page, 'aa.txt'), {
    targetPosition: { x: 3, y: 10 }
  });
  await expect.poll(() => tabNames(page)).toEqual(BASE);
  await expect(page.locator('.vv-tab-dragover')).toHaveCount(0); // 拒绝落点无指示、无残留

  // ② 邻位交换：aa 拖到 bb 右沿（before=false）→ 受理 [ttab,bb,aa,cc]
  const bbBox = await tabNamed(page, 'bb.txt').boundingBox();
  expect(bbBox).not.toBeNull();
  await tabNamed(page, 'aa.txt').dragTo(tabNamed(page, 'bb.txt'), {
    targetPosition: { x: bbBox!.width - 3, y: 10 }
  });
  await expect.poll(() => tabNames(page)).toEqual(['ttab', 'bb.txt', 'aa.txt', 'cc.txt']);

  // ③ drop 落 tabbar 容器外（状态栏）：无受理方不重排，dragend 清理
  await tabNamed(page, 'aa.txt').dragTo(page.locator('.vv-statusbar'));
  await expect.poll(() => tabNames(page)).toEqual(['ttab', 'bb.txt', 'aa.txt', 'cc.txt']);
  await expect(page.locator('.vv-tab-dragover')).toHaveCount(0);
});

// ---------------------------------------------------------------- TAX-03

/** dragover 事件内指示快照条目：事件落点 tab（on）× 当时的 dragover 指示（over/before） */
interface OverEntry {
  on: string | null;
  over: string | null;
  before: string | null;
}

/** 装 dragover 事件快照器（window 冒泡相）：真 CDP 拖拽进行中无法从测试侧间歇读
 * DOM——Playwright 手动 mouse 序在 dragstart 拦截后的 move 被原生拖拽控制器消费
 * （实测无 dragover 派发），故在事件内同步记「落点 tab × 指示状态」，拖后取切片
 * 断言。冒泡相监听在元素 handler 之后执行，读到的状态是该事件处理后的即时结果
 * （capture 相会读到上一事件的残留状态）。 */
async function installOverLog(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { __overLog: OverEntry[] }).__overLog = [];
    window.addEventListener('dragover', (e) => {
      const t = (e.target as HTMLElement).closest?.('.vv-tab') ?? null;
      const over = document.querySelector('.vv-tab-dragover');
      (window as unknown as { __overLog: OverEntry[] }).__overLog.push({
        on: t?.querySelector('.vv-tab-name')?.textContent?.trim() ?? null,
        over: over?.querySelector('.vv-tab-name')?.textContent?.trim() ?? null,
        before: over?.getAttribute('data-drop-before') ?? null
      });
    });
  });
}

/** 取快照器自 from 起的切片 */
async function overLogSince(page: Page, from: number): Promise<OverEntry[]> {
  return page.evaluate(
    (f) => (window as unknown as { __overLog: OverEntry[] }).__overLog.slice(f),
    from
  );
}

async function overLogMark(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { __overLog: OverEntry[] }).__overLog.length);
}

test('TAX-03：拖拽受理边界·pinned 区——恰区尾受理、入区拒、越区尾回弹、受理指示', async ({
  page
}, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', '375px 下多 tab 横向滚动拖拽坐标不可靠——桌面基准（TA-02 惯例）');
  test.setTimeout(60_000);
  await waitAppMounted(page);
  await openDir(page, [
    { name: 'aa.txt', type: 'text/plain', content: 'alpha\n' },
    { name: 'bb.txt', type: 'text/plain', content: 'beta\n' },
    { name: 'cc.txt', type: 'text/plain', content: 'gamma\n' }
  ]);
  await openFile(page, 'aa.txt');
  await openFile(page, 'bb.txt');
  await openFile(page, 'cc.txt');
  await pinTab(page, 'bb.txt');
  await pinTab(page, 'cc.txt');
  await expect.poll(() => tabNames(page)).toEqual(['bb.txt', 'cc.txt', 'ttab', 'aa.txt']);
  await installOverLog(page);

  // ① 普通 tab 恰区尾（第一个普通位 = pinned 区后第一位）：唯一受理的邻区落点
  await tabNamed(page, 'aa.txt').dragTo(tabNamed(page, 'ttab'), {
    targetPosition: { x: 3, y: 10 }
  });
  await expect.poll(() => tabNames(page)).toEqual(['bb.txt', 'cc.txt', 'aa.txt', 'ttab']);

  // ② 普通 tab 落 pinned 区内（cc 左沿）：拒——dragover 落在 cc 上的事件全部无指示
  //   （dropRejected→dragOver=null），序不变
  let mark = await overLogMark(page);
  await tabNamed(page, 'aa.txt').dragTo(tabNamed(page, 'cc.txt'), {
    targetPosition: { x: 3, y: 10 }
  });
  await expect.poll(() => tabNames(page)).toEqual(['bb.txt', 'cc.txt', 'aa.txt', 'ttab']);
  const log2 = await overLogSince(page, mark);
  const onCc = log2.filter((e) => e.on === 'cc.txt');
  expect(onCc.length).toBeGreaterThan(0); // 确有落在 cc 上的 dragover（装置自检）
  expect(onCc.every((e) => e.over === null)).toBe(true); // 拒绝落点恒无指示
  await expect(page.locator('.vv-tab-dragover')).toHaveCount(0); // 无残留

  // ③ pinned tab 越区尾（插到普通区 aa 右沿）：拒——「回弹」= 序不变（对齐 Chrome
  //   拖过固定区弹回的观测形态），dragend 清理无指示残留
  const aaBox = await tabNamed(page, 'aa.txt').boundingBox();
  expect(aaBox).not.toBeNull();
  await tabNamed(page, 'cc.txt').dragTo(tabNamed(page, 'aa.txt'), {
    targetPosition: { x: aaBox!.width - 3, y: 10 }
  });
  await expect.poll(() => tabNames(page)).toEqual(['bb.txt', 'cc.txt', 'aa.txt', 'ttab']);
  await expect(page.locator('.vv-tab-dragover')).toHaveCount(0);

  // ④ pinned tab 区内重排（bb → aa 左沿，恰区尾/区内任意位）：受理——dragover 落在
  //   aa 上的事件出现指示 .vv-tab-dragover + data-drop-before="true"
  mark = await overLogMark(page);
  await tabNamed(page, 'bb.txt').dragTo(tabNamed(page, 'aa.txt'), {
    targetPosition: { x: 3, y: 10 }
  });
  await expect.poll(() => tabNames(page)).toEqual(['cc.txt', 'bb.txt', 'aa.txt', 'ttab']);
  const log4 = await overLogSince(page, mark);
  const onAa = log4.filter((e) => e.on === 'aa.txt');
  expect(onAa.length).toBeGreaterThan(0);
  expect(onAa.some((e) => e.over === 'aa.txt' && e.before === 'true')).toBe(true); // 受理落点有指示

  // 终态：pinned 区不变式保持（bb/cc 仍 pinned、靠左连续）
  await expect(tabNamed(page, 'bb.txt')).toHaveAttribute('data-pinned', 'true');
  await expect(tabNamed(page, 'cc.txt')).toHaveAttribute('data-pinned', 'true');
  await expect(tabNamed(page, 'aa.txt')).not.toHaveClass(/vv-tab-pinned/);
});

// ---------------------------------------------------------------- TAX-04

test('TAX-04：全 pinned 批量关闭——closeRight 置灰无动作、closeOthers 无动作、unpin 放行', async ({
  page
}) => {
  test.setTimeout(90_000);
  await waitAppMounted(page);
  await openDir(page, [
    { name: 'aa.txt', type: 'text/plain', content: 'alpha\n' },
    { name: 'bb.txt', type: 'text/plain', content: 'beta\n' },
    { name: 'cc.txt', type: 'text/plain', content: 'gamma\n' }
  ]);
  await openFile(page, 'aa.txt');
  await openFile(page, 'bb.txt');
  await openFile(page, 'cc.txt');
  // 全员 pinned（含 dir tab——不 pin 则 closeOthers 会关掉它，「无动作」判据失真）
  await pinTab(page, 'aa.txt');
  await pinTab(page, 'bb.txt');
  await pinTab(page, 'cc.txt');
  await pinTab(page, 'ttab');
  const ALL = ['aa.txt', 'bb.txt', 'cc.txt', 'ttab'];
  await expect.poll(() => tabNames(page)).toEqual(ALL);
  for (const n of ALL) await expect(tabNamed(page, n)).toHaveAttribute('data-pinned', 'true');

  // ① closeRight 置灰态（右侧无普通 tab）：可点击但无动作（aria-disabled 语义，TA-01 同款）
  await openTabMenu(page, 'cc.txt');
  await expect(menuItem(page, '关闭右侧')).toHaveAttribute('aria-disabled', 'true');
  await menuItem(page, '关闭右侧').click({ force: true });
  await expect(page.locator('.vv-tabctx')).toBeVisible();
  await expect.poll(() => tabNames(page)).toEqual(ALL);
  await page.keyboard.press('Escape');
  await expect(page.locator('.vv-tabctx')).toHaveCount(0);

  // ② closeOthers 无动作：除锚外全员 pinned 豁免
  await openTabMenu(page, 'bb.txt');
  await runMenuItem(page, '关闭其他');
  await expect.poll(() => tabNames(page)).toEqual(ALL);
  await expect(fileTabs(page)).toHaveCount(3);

  // ③ unpin bb：落普通区首位
  await unpinTab(page, 'bb.txt');
  await expect.poll(() => tabNames(page)).toEqual(['aa.txt', 'cc.txt', 'ttab', 'bb.txt']);
  await expect(tabNamed(page, 'bb.txt')).not.toHaveClass(/vv-tab-pinned/);

  // ④ 放行：以 pinned aa 为锚 closeOthers——非 pinned 的 bb 被关（豁免解除，对照②），
  //    ttab 仍 pinned 故豁免幸存
  await openTabMenu(page, 'aa.txt');
  await runMenuItem(page, '关闭其他');
  await expect.poll(() => tabNames(page)).toEqual(['aa.txt', 'cc.txt', 'ttab']);
  await expect(tabNamed(page, 'aa.txt')).toHaveAttribute('data-pinned', 'true');
  await expect(tabNamed(page, 'cc.txt')).toHaveAttribute('data-pinned', 'true');
  await expect(tabNamed(page, 'ttab')).toHaveAttribute('data-pinned', 'true');

  // ⑤ 批量关闭逐个入栈：一次撤销恢复 bb 落组尾
  await page.keyboard.press('Alt+Shift+T');
  await expect.poll(() => tabNames(page)).toEqual(['aa.txt', 'cc.txt', 'ttab', 'bb.txt']);
});

// ---------------------------------------------------------------- TAX-05

test('TAX-05：duplicate(pinned)——副本落 pinned 区内继承；关闭撤销恢复归位区尾非原位', async ({
  page
}) => {
  test.setTimeout(90_000);
  await waitAppMounted(page);
  await openDir(page, [
    { name: 'aa.txt', type: 'text/plain', content: 'dup pinned body\n' },
    { name: 'bb.txt', type: 'text/plain', content: 'beta\n' },
    { name: 'cc.txt', type: 'text/plain', content: 'gamma\n' }
  ]);
  await openFile(page, 'aa.txt');
  await openFile(page, 'bb.txt');
  await openFile(page, 'cc.txt');
  await pinTab(page, 'aa.txt');
  await expect.poll(() => tabNames(page)).toEqual(['aa.txt', 'ttab', 'bb.txt', 'cc.txt']);

  // ① 复制 pinned tab：副本插原 tab 右侧（pinned 区内）+ pinned 继承 + 副本激活
  await openTabMenu(page, 'aa.txt');
  await runMenuItem(page, '复制标签页');
  await expect.poll(() => tabNames(page)).toEqual(['aa.txt', 'aa.txt', 'ttab', 'bb.txt', 'cc.txt']);
  await expect(tabNamed(page, 'aa.txt').nth(0)).toHaveAttribute('data-pinned', 'true');
  await expect(tabNamed(page, 'aa.txt').nth(1)).toHaveAttribute('data-pinned', 'true');
  await expect(tabNamed(page, 'aa.txt').nth(0)).not.toHaveClass(/active/);
  await expect(page.locator('.vv-tab.active', { hasText: 'aa.txt' })).toBeVisible();
  await expect(page.locator('.vv-code-pre')).toContainText('dup pinned body', { timeout: 20_000 });

  // ② 再 pin bb（拉开副本原位与 pinned 区尾的距离，使④的「区尾」与「原位」可分辨）
  await pinTab(page, 'bb.txt');
  await expect.poll(() => tabNames(page)).toEqual(['aa.txt', 'aa.txt', 'bb.txt', 'ttab', 'cc.txt']);

  // ③ 中键关闭副本（DOM 第 2 个 aa）：快照带 pinned 入栈
  await tabNamed(page, 'aa.txt').nth(1).click({ button: 'middle' });
  await expect.poll(() => tabNames(page)).toEqual(['aa.txt', 'bb.txt', 'ttab', 'cc.txt']);

  // ④ 撤销恢复：snap.pinned → 归位 pinned 区尾（[aa,bb,aa2] 而非原位 [aa,aa2,bb,…]），
  //    恢复件激活且内容渲染（存活实例捕获非占位）
  await page.keyboard.press('Alt+Shift+T');
  await expect.poll(() => tabNames(page)).toEqual(['aa.txt', 'bb.txt', 'aa.txt', 'ttab', 'cc.txt']);
  await expect(tabNamed(page, 'aa.txt').nth(1)).toHaveAttribute('data-pinned', 'true');
  await expect(page.locator('.vv-tab.active', { hasText: 'aa.txt' })).toBeVisible();
  await expect(page.locator('.vv-code-pre')).toContainText('dup pinned body', { timeout: 20_000 });
  await expect(page.locator('.vv-error-card')).toHaveCount(0);
});

// ---------------------------------------------------------------- TAX-06

test('TAX-06：中键双事件防御——mousedown 拦默认不关闭、auxclick 恰一次恰一条撤销条目', async ({
  page
}) => {
  test.setTimeout(90_000);
  await waitAppMounted(page);
  await openDir(page, [
    { name: 'aa.txt', type: 'text/plain', content: 'mid aa body\n' },
    { name: 'bb.txt', type: 'text/plain', content: 'mid bb body\n' }
  ]);
  await openFile(page, 'aa.txt');
  await openFile(page, 'bb.txt');

  // ① 中键 mousedown：preventDefault（拦自动滚动默认行为）但不关闭——关闭不接在 mousedown
  await expect(await dispatchOnTab(page, 'bb.txt', 'mousedown', 1)).toBe(true);
  await expect(fileTabs(page)).toHaveCount(2);
  // ② 左键 mousedown 不拦（聚焦/文本选择默认行为不动）
  await expect(await dispatchOnTab(page, 'bb.txt', 'mousedown', 0)).toBe(false);

  // ③ auxclick(button1) 才是关闭接线：bb 恰关一次（onaux 对中键同样 preventDefault
  //   防默认行为——brief「防中键滚动」，与 mousedown 拦截成双保险）
  await expect(await dispatchOnTab(page, 'bb.txt', 'auxclick', 1)).toBe(true);
  await expect(fileTabs(page)).toHaveCount(1);
  await expect(tabNamed(page, 'bb.txt')).toHaveCount(0);

  // ④ 真实中键关 aa（原生 mousedown+auxclick 对）：恰关一次
  await tabNamed(page, 'aa.txt').click({ button: 'middle' });
  await expect(fileTabs(page)).toHaveCount(0);

  // ⑤ 两次点击恰 2 条撤销条目（mousedown+auxclick 不双开）：LIFO 恢复 aa→bb，第 3 次提示
  await page.keyboard.press('Alt+Shift+T');
  await expect.poll(() => tabNames(page)).toEqual(['ttab', 'aa.txt']);
  await expect(page.locator('.vv-code-pre')).toContainText('mid aa body', { timeout: 20_000 });
  await page.keyboard.press('Alt+Shift+T');
  await expect.poll(() => tabNames(page)).toEqual(['ttab', 'aa.txt', 'bb.txt']);
  await expect(page.locator('.vv-statusbar')).not.toContainText(UNDO_NOTICE);
  await page.keyboard.press('Alt+Shift+T');
  await expect(page.locator('.vv-statusbar')).toContainText(UNDO_NOTICE);
  await expect(fileTabs(page)).toHaveCount(2);
});

// ---------------------------------------------------------------- TAX-07

test('TAX-07：搜索输入框内 Alt+Shift+T 不误触（inField 拦截），出框后恢复生效', async ({
  page
}) => {
  test.setTimeout(90_000);
  await waitAppMounted(page);
  await openDir(page, [
    { name: 'aa.txt', type: 'text/plain', content: 'field aa body\n' },
    { name: 'bb.txt', type: 'text/plain', content: 'field bb body\n' }
  ]);
  await openFile(page, 'aa.txt');
  await openFile(page, 'bb.txt');
  await tabNamed(page, 'aa.txt').click({ button: 'middle' });
  await expect(fileTabs(page)).toHaveCount(1);

  // ① '/' 打开文件内搜索，输入框聚焦（m3-search 同款）
  await page.keyboard.press('/');
  await expect(page.locator('.vv-search-input')).toBeFocused();

  // ② 输入焦点内按 Alt+Shift+T：inField 拦截（AppShell 全局键位统一判定）——
  //    不恢复、不提示、焦点保持。500ms 静置窗口防「拦截失效但断言先跑」竞态假绿
  await page.keyboard.press('Alt+Shift+T');
  await page.waitForTimeout(500);
  await expect(fileTabs(page)).toHaveCount(1);
  await expect(tabNamed(page, 'aa.txt')).toHaveCount(0);
  await expect(page.locator('.vv-statusbar')).not.toContainText(UNDO_NOTICE);
  await expect(page.locator('.vv-search-input')).toBeFocused();

  // ③ Esc 出框后同键生效：aa 恢复、内容渲染、成功路径无提示
  await page.keyboard.press('Escape');
  await expect(page.locator('.vv-search-input')).toHaveCount(0);
  await page.keyboard.press('Alt+Shift+T');
  await expect.poll(() => tabNames(page)).toEqual(['ttab', 'bb.txt', 'aa.txt']);
  await expect(page.locator('.vv-code-pre')).toContainText('field aa body', { timeout: 20_000 });
  await expect(page.locator('.vv-statusbar')).not.toContainText(UNDO_NOTICE);
});

// ---------------------------------------------------------------- TAX-08

test('TAX-08：快照恢复后立即撤销——栈空幂等无幽灵恢复', async ({ page }) => {
  test.setTimeout(90_000);
  await waitAppMounted(page);
  await openDir(page, [
    { name: 'aa.txt', type: 'text/plain', content: 'ghost aa body\n' },
    { name: 'bb.txt', type: 'text/plain', content: 'ghost bb body\n' }
  ]);
  await openFile(page, 'aa.txt');
  await openFile(page, 'bb.txt');
  await pinTab(page, 'bb.txt');
  await tabNamed(page, 'aa.txt').click({ button: 'middle' });
  await expect(fileTabs(page)).toHaveCount(1);

  // 快照落盘后刷新：撤销栈会话级不持久化 → 栈空
  await waitSnapshotTabs(page, ['bb.txt']);
  await page.reload();
  await expect(page.locator('.vv-error-card').first()).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => tabNames(page), { timeout: 10_000 }).toEqual(['bb.txt']);
  await expect(tabNamed(page, 'bb.txt')).toHaveAttribute('data-pinned', 'true');

  // ① 立即撤销：无幽灵恢复（aa 不复活），唯一反馈是栈空提示
  await page.keyboard.press('Alt+Shift+T');
  await expect(page.locator('.vv-statusbar')).toContainText(UNDO_NOTICE);
  await expect(page.locator('.vv-tab')).toHaveCount(1);
  await expect(tabNamed(page, 'aa.txt')).toHaveCount(0);

  // ② 重复按幂等：提示仍在（连发重置计时）、无新增 tab/错误卡
  await page.keyboard.press('Alt+Shift+T');
  await expect(page.locator('.vv-statusbar')).toContainText(UNDO_NOTICE);
  await expect(page.locator('.vv-tab')).toHaveCount(1);
  await expect(page.locator('.vv-error-card')).toHaveCount(1);
});

// ---------------------------------------------------------------- TAX-09

test('TAX-09：同 base 重连清扫豁免撤销栈（undoable:false）——目录与文件 tab 一并清扫、不入栈不复活', async ({
  page
}) => {
  test.setTimeout(90_000);
  const fake = await startFakeServer({ 'hello.js': 'const resweep = 1;\n' });
  try {
    await waitAppMounted(page);
    // 预载撤销栈恰 1 条本地条目（用户关闭）
    await openDir(page, [{ name: 'lfile.txt', type: 'text/plain', content: 'local undo body\n' }]);
    await openFile(page, 'lfile.txt');
    await tabNamed(page, 'lfile.txt').click({ button: 'middle' });
    await expect(fileTabs(page)).toHaveCount(0);

    // 连接（token 空）→ 打开 remote 文件
    await connectForm(page, fake.base);
    await expect(tabNamed(page, fake.host)).toBeVisible({ timeout: 10_000 });
    const drawer = await openDrawerIfNarrow(page);
    await page.locator('.vv-tree-row', { hasText: 'hello.js' }).click();
    await closeDrawerIfOpened(page, drawer);
    await expect(page.locator('.vv-code-pre')).toContainText('resweep', { timeout: 20_000 });

    // 换 token 重连同 base：token 不一致不走存活实例复用 → 清扫路径。
    // 修复后期望（SUS-TAX-1，清扫先收集后关）：同 base 的目录 + 文件 tab 一并
    // 清扫——匹配在任一关闭发生前一次性计算，不再依赖逐一关闭后的
    // remoteBaseById 存活（旧实现关目录 tab 先终结实例 → 文件 tab 匹配落空幸存）
    await connectForm(page, fake.base, 'tok-b');
    await expect(tabNamed(page, fake.host)).toHaveCount(1, { timeout: 10_000 }); // 目录 tab 唯一
    await expect.poll(() => tabNames(page)).toEqual(['ttab', fake.host]); // 文件 tab 一并清扫
    await expect(tabNamed(page, 'hello.js')).toHaveCount(0); // 幸存缺陷已修（SUS-TAX-1）

    // 撤销恢复的是先前用户关闭的 lfile.txt——被清扫的目录/文件 tab 贡献 0 条目
    //（undoable:false；若入栈，栈顶是其快照，恢复的会是 remote tab 而非 lfile）
    await page.keyboard.press('Alt+Shift+T');
    await expect.poll(() => tabNames(page)).toEqual(['ttab', fake.host, 'lfile.txt']);
    await expect(page.locator('.vv-tab.active', { hasText: 'lfile.txt' })).toBeVisible();
    await expect(page.locator('.vv-code-pre')).toContainText('local undo body', { timeout: 20_000 });
    await expect(page.locator('.vv-error-card')).toHaveCount(0);

    // 栈深恰 1 旁证：再按即栈空提示，tab 数不变
    await page.keyboard.press('Alt+Shift+T');
    await expect(page.locator('.vv-statusbar')).toContainText(UNDO_NOTICE);
    await expect(page.locator('.vv-tab')).toHaveCount(3);
  } finally {
    await fake.close();
  }
});

// ---------------------------------------------------------------- TAX-10

test('TAX-10：拖拽重排不入撤销栈——撤销仍恢复最近关闭且重排序保持', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', '375px 下多 tab 横向滚动拖拽坐标不可靠——桌面基准（TA-02 惯例）');
  test.setTimeout(60_000);
  await waitAppMounted(page);
  await openDir(page, [
    { name: 'aa.txt', type: 'text/plain', content: 'reorder aa body\n' },
    { name: 'bb.txt', type: 'text/plain', content: 'reorder bb body\n' },
    { name: 'cc.txt', type: 'text/plain', content: 'reorder cc body\n' }
  ]);
  await openFile(page, 'aa.txt');
  await openFile(page, 'bb.txt');
  await openFile(page, 'cc.txt');

  // 中键关 aa（栈恰 1 条），再拖拽邻位交换：重排不是 undoable 动作
  await tabNamed(page, 'aa.txt').click({ button: 'middle' });
  await expect(fileTabs(page)).toHaveCount(2);
  await tabNamed(page, 'cc.txt').dragTo(tabNamed(page, 'bb.txt'), {
    targetPosition: { x: 3, y: 10 }
  });
  await expect.poll(() => tabNames(page)).toEqual(['ttab', 'cc.txt', 'bb.txt']);

  // 撤销恢复的是最近「关闭」的 aa（非撤销重排），落组尾且重排序保持
  await page.keyboard.press('Alt+Shift+T');
  await expect.poll(() => tabNames(page)).toEqual(['ttab', 'cc.txt', 'bb.txt', 'aa.txt']);
  await expect(page.locator('.vv-tab.active', { hasText: 'aa.txt' })).toBeVisible();
  await expect(page.locator('.vv-code-pre')).toContainText('reorder aa body', { timeout: 20_000 });
  await expect(page.locator('.vv-error-card')).toHaveCount(0);

  // 栈深恰 1：重排未产生条目
  await page.keyboard.press('Alt+Shift+T');
  await expect(page.locator('.vv-statusbar')).toContainText(UNDO_NOTICE);
  await expect(page.locator('.vv-tab')).toHaveCount(4);
});

// ---------------------------------------------------------------- TAX-11

// WSX 观察 2（富化轮现象记录）的修复验收：TabBar 溢出时右键裁剪目标的动作性滚动
// （Playwright actionability / 触屏裁剪目标自动滚入）位移先于 contextmenu 完成，
// 但 scroll 事件在下一渲染帧异步派发——落在菜单挂载之后，原「任意滚动即关」
// （window capture）把刚弹出的菜单秒关。修复=开菜单后短宽限窗豁免自身触发的
// 尾随滚动；宽限窗后的容器滚动仍关闭（「任意滚动即关」设计意图保留）。
test('TAX-11：溢出 TabBar 右键菜单不被打开动作自身滚动秒关；宽限窗后用户滚动仍关', async ({
  page
}, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', '溢出面按桌面宽视口构造（豁免逻辑与视口无关，mobile 同路径覆盖）');
  test.setTimeout(60_000);
  await waitAppMounted(page);
  const names = Array.from({ length: 22 }, (_, i) => `ovr-${String(i).padStart(2, "0")}-overflow-case.txt`);
  await openDir(
    page,
    names.map((n, i) => ({ name: n, type: 'text/plain', content: `overflow ${i}\n` }))
  );
  for (const n of names) await openFile(page, n);
  // 自证非空转：22 长名 tab + 管理钮远超 1280px 视口，TabBar 横向溢出
  await expect
    .poll(() =>
      page.evaluate(() => {
        const bar = document.querySelector('.vv-tabbar');
        return bar !== null && bar.scrollWidth > bar.clientWidth + 1;
      })
    )
    .toBe(true);

  const menu = page.locator('.vv-tabctx');
  // 末位裁剪 tab：右键强制动作性滚动（位移同步完成，scroll 事件异步尾随）
  await page.locator('.vv-tab').last().click({ button: 'right' });
  await expect(menu).toBeVisible();
  await page.waitForTimeout(300); // 越过宽限窗：菜单仍开（缺陷态在此前已被秒关）
  await expect(menu).toBeVisible();

  // 宽限窗后的容器滚动仍关闭
  await page.evaluate(() => {
    (document.querySelector('.vv-tabbar') as HTMLElement).scrollTo({ left: 0 });
  });
  await expect(menu).toHaveCount(0);
});
