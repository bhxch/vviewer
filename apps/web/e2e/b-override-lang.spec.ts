import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, expect, type Locator, type Page } from '@playwright/test';
import { hash8 } from '@vviewer/core';
import { closeDrawerIfOpened, openDrawerIfNarrow } from './drawer';

/**
 * 手动高亮语言（overrideLang）全链 e2e（renderer-lang-override spec §4.1/§4.2，b- 前缀）。
 * 场景（LANG-01~06）：属性面板语言行（MetaPanel datalist input，Task 5）设语言 →
 * code 渲染按指定语言重渲染（setHighlightLang rev++ 复用渲染 effect 通道）→ 置空回
 * 自动 → 快照恢复（reload 后 Tab.overrideLang 读回）→ duplicate 继承 → 状态栏轻入口
 * 跳转聚焦（AppShell 单通道，metaLangFocus.ts）→ Tab 右键「语言」项文案与落点同 tab
 * （非激活 tab 点击后先激活被右键 tab，终审 I-1）。
 *
 * 断言锚口径：
 * - 本地注入路径（LANG-01/02/04）「按 rust 高亮」= `.vv-code-pre span[class^="ts-"]`
 *   （tree-sitter 产物）。前置对照：.txt 无语言检测（languages.json 无 txt 条目 →
 *   detectLanguage null）→ lang null 走 hljs 自动兜底（hljs-* span），ts-* 恒 0；
 *   overrideLang rust 后 tree-sitter rust grammar（lite 内嵌 rust.wasm）命中，ts-*
 *   出现——引擎级翻转只来自手动指定，不靠 hljs 自动检测的巧合命中。
 * - 远程快照恢复路径（LANG-03）：remote 文件带 computeSrc 且假服务器无 compute
 *   能力 → 按简报裁决不回退本地 wasm，高亮落 hljs 整文件层——生效主锚改用状态栏
 *   「语言: rust」（getMeta.lang 单源 = opts.langOverride ?? 服务端头 ?? det.lang，
 *   本夹具后两者恒空，rust 只能来自 overrideLang），span 断言引擎无关。
 * - 语言行提交：playwright fill 对文本框只派发 input 不派发 change（fillLocalInput
 *   的 change 派发仅限 color/date 等类型）——setLang 以 fill+blur 触发原生 change
 *   提交（MetaPanel onchange，spec §4.2 Task 5 契约）。
 * - 开序先开后设（TAX-13 教训）：overrideLang 经 setHighlightLang 写激活 tab——先开
 *   文件再填语言行，杜绝作用错 tab 的假阴性。
 * - 轮询断言一律 expect.poll（单次评估即放行的 waitForFunction 不用）。
 *
 * 通道：目录注入同 t-tab-actions（__vvOpenDirImpl）；LANG-03 快照恢复用测试内假
 * vviewer 文件服务器 + 旧键 'tabs' 快照种子（t-open-with BUG-69 同款装置，
 * migrateLegacyTabs 透传 TabSnapshot 全字段含 overrideLang——AppShell:707 读回）。
 */

/** rust 样例（fn/let 关键字必产 tree-sitter 捕获；.txt 载体防扩展名自动路由） */
const RUST_SNIPPET = 'fn main() {\n    let msg = "hello vviewer";\n    println!("{}", msg);\n}\n';

interface Payload {
  name: string;
  type: string;
  content?: string;
}

const REG_SPECIAL = /[.*+?^${}()|[\]\\]/g;

/** 等应用挂载（svelte:window drop 监听与 TopBar 就绪；t-tab-actions 同款） */
async function waitAppMounted(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(
    () => typeof (window as unknown as { __vvOpenDirImpl?: unknown }).__vvOpenDirImpl === 'function'
  );
  await expect(page.locator('.vv-topbar')).toBeVisible();
}

/** 目录注入通道（t-tab-actions openDir 同款；label = webkitRelativePath 首段） */
async function openDir(page: Page, payloads: Payload[], label = 'olang'): Promise<void> {
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

/** 树行点击打开文件 tab（≤900px 抽屉断点适配，t-tab-actions 同款） */
async function openFile(page: Page, name: string): Promise<void> {
  const drawer = await openDrawerIfNarrow(page);
  await page.locator('.vv-tree-row', { hasText: name }).click();
  await closeDrawerIfOpened(page, drawer);
  await expect(tabNamed(page, name)).toBeVisible();
}

/** 精确名 tab 定位（.vv-tab-name 子元素锚定） */
function tabNamed(page: Page, name: string): Locator {
  return page
    .locator('.vv-tab')
    .filter({
      has: page.locator('.vv-tab-name', { hasText: new RegExp(`^${name.replace(REG_SPECIAL, '\\$&')}$`) })
    });
}

/** 当前 tab 名序（DOM 序 = 组内 tab 序） */
function tabNames(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('.vv-tab .vv-tab-name')].map((el) => (el.textContent ?? '').trim())
  );
}

/** 右键打开 tab 菜单（TabContextMenu 浮层出现） */
async function openTabMenu(page: Page, name: string, nth = 0): Promise<void> {
  await tabNamed(page, name).nth(nth).click({ button: 'right' });
  await expect(page.locator('.vv-tabctx')).toBeVisible();
}

/** 执行可用菜单项（动作执行后必关——TabContextMenu.run 语义） */
async function runMenuItem(page: Page, label: string): Promise<void> {
  await page.getByRole('menuitem', { name: label, exact: true }).click();
  await expect(page.locator('.vv-tabctx')).toHaveCount(0);
}

/** ≤600px 断点右栏（MetaPanel）收进抽屉（t-open-with openRightIfNarrow 同款） */
async function openRightIfNarrow(page: Page): Promise<boolean> {
  const narrow = await page.evaluate(() => window.innerWidth <= 600);
  if (!narrow) return false;
  await page.locator('.vv-right-toggle').click();
  return true;
}

/** MetaPanel「语言」行（.meta-lang-input 所在 meta-row）：手动徽标按行圈定——
 * 「打开方式」手选后的（手动）徽标同类名，根级定位会双计 */
function langRow(page: Page): Locator {
  return page.locator('.meta-row', { has: page.locator('.meta-lang-input') });
}

/** 属性面板语言行填语言并提交：fill 对文本框走逐键输入路径只派发 input（playwright
 * fillLocalInput 的 change 派发仅限 color/date 等类型）——blur 触发原生 change 提交
 * （onLangCommit → setHighlightLang）。fill 前先聚焦，blur 时值已变必派 change。 */
async function setLang(page: Page, lang: string): Promise<void> {
  const input = page.locator('.meta-lang-input');
  await expect(input).toBeVisible();
  await input.fill(lang);
  await input.blur();
}

// ---------------------------------------------------------------- LANG-01

test('LANG-01 属性面板设语言 → 重渲染按指定语言高亮（tree-sitter rust）', async ({ page }) => {
  test.setTimeout(60_000);
  await waitAppMounted(page);
  await openDir(page, [{ name: 'rusty.txt', type: 'text/plain', content: RUST_SNIPPET }]);
  await openFile(page, 'rusty.txt');
  await expect(page.locator('.vv-code-pre')).toContainText('fn main()', { timeout: 20_000 });
  // 前置对照：.txt 无语言检测 → lang null → hljs 自动兜底（hljs-*），ts-* 恒 0
  await expect(page.locator('.vv-code-pre span[class^="ts-"]')).toHaveCount(0);

  await openRightIfNarrow(page);
  await setLang(page, 'rust');

  // rev++ 重渲染：tree-sitter rust grammar 命中 → ts-* span 出现（expect.poll 轮询，
  // 高亮客户端 attach 与 worker 解析异步）
  await expect
    .poll(() => page.locator('.vv-code-pre span[class^="ts-"]').count(), { timeout: 30_000 })
    .toBeGreaterThan(0);
  // getMeta.lang 以 opts.langOverride 为单源 → 状态栏语言段显式落「语言: rust」
  await expect(page.locator('.vv-statusbar')).toContainText('语言: rust');
  // （手动）徽标现于语言行（spec §4.2 生效态标识）
  await expect(langRow(page).locator('.meta-openwith-manual')).toBeVisible();
});

// ---------------------------------------------------------------- LANG-02

test('LANG-02 置空回自动：手动徽标消失、高亮回落 hljs 自动兜底', async ({ page }) => {
  test.setTimeout(60_000);
  await waitAppMounted(page);
  await openDir(page, [{ name: 'reset.txt', type: 'text/plain', content: RUST_SNIPPET }]);
  await openFile(page, 'reset.txt');
  await expect(page.locator('.vv-code-pre')).toContainText('fn main()', { timeout: 20_000 });

  await openRightIfNarrow(page);
  await setLang(page, 'rust');
  await expect
    .poll(() => page.locator('.vv-code-pre span[class^="ts-"]').count(), { timeout: 30_000 })
    .toBeGreaterThan(0);
  await expect(langRow(page).locator('.meta-openwith-manual')).toBeVisible();

  // 置空提交（spec §4.2：'' = null 清除回自动检测）
  await setLang(page, '');
  await expect(langRow(page).locator('.meta-openwith-manual')).toHaveCount(0); // 手动徽标消失
  await expect(page.locator('.meta-lang-input')).toHaveValue('');
  // 回自动：tree-sitter（ts-*）消退，lang null 走 hljs 自动兜底（hljs-* 可现）
  await expect
    .poll(() => page.locator('.vv-code-pre span[class^="ts-"]').count(), { timeout: 30_000 })
    .toBe(0);
  await expect(page.locator('.vv-statusbar')).not.toContainText('语言: rust');
});

// ---------------------------------------------------------------- LANG-03

test('LANG-03 快照恢复：reload 后 overrideLang 仍在且生效', async ({ page }) => {
  test.setTimeout(90_000);
  // 假 vviewer 文件服务器（t-open-with BUG-69 同款）：restore 期 reconnectRemoteStore
  // 只探测 GET /api/health；ViewerPane 经 RemoteStore.read 拉 GET /api/file。
  // 跨源（4173 页面源）必须带 ACAO:*；/api/ticket+/api/events 给合法 SSE 通道。
  // capabilities 只报 file-server（无 compute）→ 高亮路由不走远程，本地 tree-sitter。
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const cors = { 'Access-Control-Allow-Origin': '*' };
    if (url.pathname === '/api/health') {
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ capabilities: ['file-server'] }));
      return;
    }
    if (url.pathname === '/api/file') {
      res.writeHead(200, { ...cors, 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(RUST_SNIPPET);
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
    res.writeHead(404, cors);
    res.end();
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  try {
    await waitAppMounted(page);
    // 预置恢复现场（BUG-69 同款）：sessionStorage last-server + IDB 旧键 'tabs' 快照
    // → reload 触发 restore 走迁移 + remote 重连分支。overrideLang 随 TabSnapshot
    // 全字段迁移（migrateLegacyTabs 浅拷贝透传）→ AppShell 读回（AppShell:707）。
    const remoteId = `remote:${hash8(`${base}:e2e-fake`)}`;
    const baseTab = {
      storeId: remoteId,
      storeLabel: 'e2e-fake',
      storeBase: base,
      kind: 'rename-only' as const,
      scrollTop: 0
    };
    await page.evaluate(
      (seed) =>
        new Promise<void>((resolve, reject) => {
          sessionStorage.setItem(
            'vviewer-last-server',
            JSON.stringify({ baseUrl: seed.base, token: null })
          );
          const open = indexedDB.open('vviewer');
          open.onupgradeneeded = () => {
            if (!open.result.objectStoreNames.contains('kv')) open.result.createObjectStore('kv');
          };
          open.onsuccess = () => {
            const db = open.result;
            const tx = db.transaction('kv', 'readwrite');
            tx.objectStore('kv').put(
              [
                {
                  ...seed.baseTab,
                  id: 't0',
                  path: '',
                  name: 'e2e-fake',
                  active: false
                },
                {
                  ...seed.baseTab,
                  id: 't1',
                  path: 'lang-restore.txt',
                  name: 'lang-restore.txt',
                  active: true,
                  overrideLang: 'rust'
                }
              ],
              'tabs'
            );
            tx.oncomplete = () => {
              db.close();
              resolve();
            };
            tx.onerror = () => {
              db.close();
              reject(tx.error);
            };
          };
          open.onerror = () => reject(open.error);
        }),
      { base, baseTab }
    );
    await page.reload();
    await expect(page.locator('.vv-tab', { hasText: 'lang-restore.txt' })).toBeVisible({
      timeout: 10_000
    });
    await openRightIfNarrow(page);

    // 快照恢复链：Tab.overrideLang 回读 → 语言行回显 rust + （手动）徽标
    const langInput = page.locator('.meta-lang-input');
    await expect(langInput).toBeVisible({ timeout: 20_000 });
    await expect(langInput).toHaveValue('rust');
    await expect(langRow(page).locator('.meta-openwith-manual')).toBeVisible();
    // 生效主锚：状态栏语言段「语言: rust」——getMeta.lang 单源 = opts.langOverride ??
    // 服务端检测头 ?? det.lang，本夹具假服务器无 X-VV-Lang、.txt 无 det.lang，
    // 「rust」只能来自 overrideLang（快照恢复 → dispatch 透传全链证毕）
    await expect(page.locator('.vv-statusbar')).toContainText('语言: rust');
    // 高亮产物（引擎无关断言）：本夹具 remote 文件带 computeSrc 且服务器无 compute
    // 能力 → 按简报裁决不回退本地 wasm，overrideLang rust 落 hljs 整文件层
    // （hljs-* span）；ts-* 为本地注入路径的产物，已在 LANG-01 钉死
    await expect
      .poll(
        () =>
          page
            .locator('.vv-code-pre span[class^="ts-"], .vv-code-pre span[class^="hljs-"]')
            .count(),
        { timeout: 30_000 }
      )
      .toBeGreaterThan(0);
  } finally {
    server.close();
    server.closeAllConnections(); // /api/events 长连接不 end：close() 需配套断连
  }
});

// ---------------------------------------------------------------- LANG-04

test('LANG-04 duplicate 继承 overrideLang：新 tab 语言行 rust 且渲染生效', async ({ page }) => {
  test.setTimeout(60_000);
  await waitAppMounted(page);
  await openDir(page, [{ name: 'dup-lang.txt', type: 'text/plain', content: RUST_SNIPPET }]);
  await openFile(page, 'dup-lang.txt');
  await expect(page.locator('.vv-code-pre')).toContainText('fn main()', { timeout: 20_000 });
  await openRightIfNarrow(page);
  await setLang(page, 'rust');
  await expect
    .poll(() => page.locator('.vv-code-pre span[class^="ts-"]').count(), { timeout: 30_000 })
    .toBeGreaterThan(0);

  // TA-04 装置：右键「复制标签页」→ 新 tab 激活于原 tab 右侧
  await openTabMenu(page, 'dup-lang.txt');
  await runMenuItem(page, '复制标签页');
  await expect.poll(() => tabNames(page)).toEqual(['olang', 'dup-lang.txt', 'dup-lang.txt']);
  await expect(page.locator('.vv-tab.active', { hasText: 'dup-lang.txt' })).toBeVisible();

  // 副本语言行回显 rust（openFlow.duplicate 读回拷贝，spec §4.1）+（手动）徽标
  await expect(page.locator('.meta-lang-input')).toHaveValue('rust');
  await expect(langRow(page).locator('.meta-openwith-manual')).toBeVisible();
  // 副本渲染生效（overrideLang 随 dispatch.langOverride 注入，非仅 UI 回显）
  await expect
    .poll(() => page.locator('.vv-code-pre span[class^="ts-"]').count(), { timeout: 30_000 })
    .toBeGreaterThan(0);
  await expect(page.locator('.vv-statusbar')).toContainText('语言: rust');
});

// ---------------------------------------------------------------- LANG-05

test('LANG-05 状态栏轻入口「语言：…」→ 跳转属性面板聚焦语言输入框', async ({ page }) => {
  test.setTimeout(60_000);
  await waitAppMounted(page);
  await openDir(page, [{ name: 'status-lang.txt', type: 'text/plain', content: 'plain body\n' }]);
  await openFile(page, 'status-lang.txt');
  await expect(page.locator('.vv-code-pre')).toContainText('plain body', { timeout: 20_000 });
  // 先可见后聚焦（语言行随 fileMeta.name 渲染；右栏折叠/移动抽屉由 AppShell 展开）
  const langInput = page.locator('input[list="vv-lang-datalist"]');
  await expect(langInput).toBeVisible();

  // 状态栏浮层尾部「语言」项（Task 6 轻入口）→ vv:focus-meta-lang → AppShell 聚焦
  await page.locator('.vv-status-openwith').click();
  const picker = page.locator('.vv-status-picker');
  await expect(picker).toBeVisible();
  await expect(picker.locator('.vv-status-picker-lang')).toContainText('语言：自动');
  await picker.locator('.vv-status-picker-lang').click();
  await expect(langInput).toBeFocused();
});

// ---------------------------------------------------------------- LANG-06

test('LANG-06 Tab 右键「语言」项作用于被右键 tab：点击后该 tab 先激活（终审 I-1）', async ({
  page
}) => {
  test.setTimeout(60_000);
  await waitAppMounted(page);
  await openDir(page, [
    { name: 'left-lang.txt', type: 'text/plain', content: RUST_SNIPPET },
    { name: 'plain-right.txt', type: 'text/plain', content: 'plain body\n' }
  ]);
  // 开序先开后设（TAX-13 同款）：rust 写在 left-lang 上，再开第二个 tab 让激活态离开
  await openFile(page, 'left-lang.txt');
  await expect(page.locator('.vv-code-pre')).toContainText('fn main()', { timeout: 20_000 });
  await openRightIfNarrow(page);
  await setLang(page, 'rust');
  await openFile(page, 'plain-right.txt');
  await expect(page.locator('.vv-tab.active', { hasText: 'plain-right.txt' })).toBeVisible();

  // 右键非激活 tab：菜单「语言」项文案读被右键 tab 的 overrideLang（rust（手动）），
  // 而非激活 tab 的「自动」——文案 tab 与落点 tab 同源的前置证据
  await openTabMenu(page, 'left-lang.txt');
  const langItemName = '语言：rust（手动）（在属性面板中修改）';
  await expect(page.getByRole('menuitem', { name: langItemName })).toBeVisible();

  // 点击 → 被右键 tab 变激活（终审 I-1 契约：文案 tab == 聚焦落点 tab，修复前
  // 只派发聚焦，激活态留在 plain-right，此断言必失败）
  await runMenuItem(page, langItemName);
  await expect(page.locator('.vv-tab.active', { hasText: 'left-lang.txt' })).toBeVisible();
  // 属性面板语言行随激活切换回显被右键 tab 的 overrideLang（meta 异步上行，poll 收口；
  // rAF 聚焦在新 tab meta 未上行期间按 AppShell 静默跳过语义，不作焦点断言）
  await expect(page.locator('.meta-lang-input')).toHaveValue('rust', { timeout: 20_000 });
});
