import { MENU_POP, TABBAR_MENU, TRIGGER, menuConnectServer, menuOpenFile, menuOpenFolder, menuOpenUrl, openMenu, openSubmenu } from './tabbar-menu';
import { mkdtempSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { closeDrawerIfOpened, openDrawerIfNarrow } from './drawer';

/**
 * TabBar 左端融合菜单新域（MEN-01..05 + MOB-01；标签栏收敛 spec §6.2 / plan Task 4）。
 * 域文档 docs/e2e/tabbar-menu.md 统一收册本文件与 b-tabbar-scroll.spec.ts（SCRL-01..07
 * ——spec §6.2「新域 b-tabbar-menu」的结构性拆分：箭头/滚动用例 Task 2 独立成文件，
 * 编号体系不变）。本文件场景：
 * - MEN-01 全条目触达矩阵：8 首层行逐一点开断言（打开文件 filechooser / 打开文件夹
 *   picker 通道 / 粘贴 URL 行内表单提交 openUrl 生效 / 刷新触发 rev 自增——远端 store
 *   重读重渲染 / 连接服务器表单开合+连接成功收菜单 / 主题三态切换生效 / 目录管理开
 *   管理页 / 设置开设置中心 / 专注进出 zen 类翻转）
 * - MEN-02 子菜单手风琴：三父项点击展开/再点收起/展开 A 后点 B 仅 A 收；
 *   aria-expanded 翻转 + chevron ▸→▾ 随态
 * - MEN-03 关闭通道：物理 Esc（焦点在浮层内=容器 onkeydown 通道）/ 合成 Esc
 *   （closeTopOverlayForZen 同款派发目标=pop 本体，window 兜底 contains 守卫放走——
 *   评审焦点 4）/ 外点 pointerdown，三通道各自零残留（pop 归零 + 触发钮 aria-expanded 回 false）
 * - MEN-04 互斥（TAX-14 随迁口径的域内主锚，docs/e2e/tab-actions-enrichment.md 该行
 *   类名已随迁）：融合菜单开（含子菜单展开态）→ tab 右键开菜单 → 菜单收；反向同刻至多一个
 * - MEN-05 管理 ▾ 触发：[aria-label="管理标签"] 点击 → wspanel 开
 *   （data-vv-wspanel-trigger 面板可见），Esc 收（Task 3 图标化形态回归）
 * - MOB-01 浮层触顶：5 工作区 modal 循环 → 开菜单+工作区子菜单+连接服务器表单叠加
 *   展开 → mobile project 断 pop scrollHeight > clientHeight 且内部可滚、top 未越
 *   视口、bottom ≤ 视口高 − 8（评审焦点 1，spec §3.3 超高策略；首版实现底缘 +2px
 *   越界 + 10px 内滚死窗经探针定性、属主修复 edad740，断言已收紧至精确锚——
 *   用例头注记缺陷史）；chromium project 断收合路径（max-height 清空、无内部
 *   滚动、整体落视口内）
 *
 * 装置：融合菜单流全经 Task 1 helper（e2e/tabbar-menu.ts 全部导出）；工作区创建走
 * WorkspaceCreateModal UI 流（b-wscreate-outside-close / t-workspace 先例）；MEN-01
 * 刷新断言用 node:http 假服务器（t-workspace / TAX-09 先例——远端 store read 每次
 * 真实 fetch，rev++ 重读可观测；url store 有 bytes 内存缓存，刷新不重读不可用）；
 * 合成 Esc 派发形态 = AppShell closeTopOverlayForZen（OVERLAY_SELECTOR 命中项
 * dispatchEvent keydown Escape bubbles，appShellZenEsc I-2 容器通道契约）；zen 内
 * 菜单触达经标签栏边缘热区唤出临时条（mLZ-05 同款两段移动）。
 */

/** 等应用挂载（__vvOpenDirImpl 就绪 + TabBar 可见；t-shell/t-workspace 同款） */
async function waitAppMounted(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(
    () => typeof (window as unknown as { __vvOpenDirImpl?: unknown }).__vvOpenDirImpl === 'function'
  );
  await expect(page.locator('.vv-tabbar')).toBeVisible();
}

/**
 * 假 vviewer 文件服务器（t-workspace 先例精简版：token 恒空——无 authorization 头
 * 全为简单请求，免 OPTIONS 预检）。files 表按引用持有：用例侧改 `fake.files[path]`
 * 即改服务端内容，供刷新段驱动 rev++ 重读（远端 store read 无内容缓存）。
 */
async function startFakeServer(
  files: Record<string, string>
): Promise<{ base: string; host: string; files: Record<string, string>; close: () => Promise<void> }> {
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
    files,
    close: async () => {
      server.closeAllConnections(); // /api/events 长连接需配套断连
      await new Promise<void>((ok) => server.close(() => ok()));
    }
  };
}

/** 树行点击打开文件 tab（≤900px 抽屉断点适配；t-workspace/b-tabbar-scroll 同款） */
async function openTreeFile(page: Page, name: string): Promise<void> {
  const drawer = await openDrawerIfNarrow(page);
  await page.locator('.vv-tree-row', { hasText: name }).click();
  await closeDrawerIfOpened(page, drawer);
  await expect(page.locator('.vv-tab.active', { hasText: name })).toBeVisible();
}

/** zen 中唤出临时标签条：两段移动保证 pointerenter（b-layout-zen hoverTabEdge /
 * mLZ-05 同款；x=180 两 project 视口均在界内，桌面落在中性内容区不误触） */
async function hoverTabEdge(page: Page): Promise<void> {
  const edge = await page.locator('.vv-edge[data-edge="tab"]').boundingBox();
  expect(edge).not.toBeNull(); // 热区未挂载时快速失败，不拿 null 算 NaN 坐标
  await page.mouse.move(180, 300);
  await page.mouse.move(edge!.x + 4, edge!.y + edge!.height / 2);
}

/** 合成 Esc（closeTopOverlayForZen 同款形态）：对 OVERLAY_SELECTOR 命中项（=pop
 * 本体）dispatchEvent keydown Escape bubbles。事件冒泡到 window 兜底监听时
 * contains(target) 守卫放走——只有浮层容器 onkeydown 通道能关（评审焦点 4：
 * 移动端返回键通道的 e2e 承接） */
function dispatchSyntheticEsc(page: Page): Promise<void> {
  return page.evaluate((sel) => {
    document.querySelector(sel)?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
    );
  }, MENU_POP);
}

/** 融合菜单浮层滚动/收敛度量（scrollHeight/clientHeight/maxHeight/top/bottom） */
function popMetrics(page: Page): Promise<{
  scrollHeight: number;
  clientHeight: number;
  maxHeight: string;
  overflowY: string;
  top: number;
  bottom: number;
  viewportH: number;
}> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLElement;
    const box = el.getBoundingClientRect();
    return {
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      maxHeight: el.style.maxHeight,
      overflowY: getComputedStyle(el).overflowY,
      top: box.top,
      bottom: box.bottom,
      viewportH: window.innerHeight
    };
  }, MENU_POP);
}

// ---------------------------------------------------------------- MEN-01

test('MEN-01：全条目触达矩阵——8 首层行逐一点开断言（打开三通道/刷新 rev/连接/主题/目录管理/设置/专注）', async ({
  page
}) => {
  test.setTimeout(120_000);
  const fake = await startFakeServer({ 'rev.txt': 'rev-one body\n' });
  try {
    await waitAppMounted(page);

    // ① 打开文件（filechooser 通道）：条目点击先收菜单再弹原生选择器（hidden input
    //    常驻挂载不丢），选择落 localfiles 单文件 tab 且内容渲染。helper files 参数
    //    是本地路径（string|string[]）——临时文件落 os.tmpdir，tab 名 = basename
    const tmpDir = mkdtempSync(join(tmpdir(), 'vv-menu-e2e-'));
    const menuFile = join(tmpDir, 'menu-open.txt');
    writeFileSync(menuFile, 'menu file body\n');
    await menuOpenFile(page, menuFile);
    await expect(page.locator('.vv-tab.active', { hasText: 'menu-open.txt' })).toBeVisible();
    await expect(page.locator('.vv-code-pre')).toContainText('menu file body', { timeout: 20_000 });
    await expect(page.locator(MENU_POP)).toHaveCount(0);

    // ② 打开文件夹（picker 通道）：hook 计数证 showDirectoryPicker 真被调用；headless
    //    立即 AbortError → 状态栏取消提示（BUG-19 通道，b-app-shell-sources 同款）
    await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      const orig = (w.showDirectoryPicker as (o?: unknown) => Promise<FileSystemDirectoryHandle>).bind(
        w
      );
      w.__vvPickerCalls = 0;
      w.showDirectoryPicker = (o?: unknown) => {
        w.__vvPickerCalls = ((w.__vvPickerCalls as number) ?? 0) + 1;
        return orig(o);
      };
    });
    await menuOpenFolder(page);
    await expect
      .poll(() =>
        page.evaluate(() => (window as unknown as { __vvPickerCalls?: number }).__vvPickerCalls)
      )
      .toBe(1);
    await expect(page.locator('.vv-statusbar')).toContainText('已取消选择文件夹', { timeout: 10_000 });
    await expect(page.locator(MENU_POP)).toHaveCount(0);

    // ③ 粘贴 URL（行内单行表单就地展开，提交 openUrl 生效）：提交后展开行收起
    //    （aria-expanded 回 false）、菜单保持开、URL tab 内容渲染
    await page.route('**/vv-menu-url.txt', (route) =>
      route.fulfill({ status: 200, contentType: 'text/plain; charset=utf-8', body: 'url-open body' })
    );
    await menuOpenUrl(page, 'http://127.0.0.1:4173/vv-menu-url.txt');
    await expect(page.locator(MENU_POP)).toBeVisible(); // openUrl 通道菜单保持开
    await expect(page.locator(MENU_POP).getByRole('button', { name: '粘贴 URL' })).toHaveAttribute(
      'aria-expanded',
      'false'
    );
    await expect(page.locator('.vv-tab.active', { hasText: 'vv-menu-url.txt' })).toBeVisible();
    await expect(page.locator('.vv-code-pre')).toContainText('url-open body', { timeout: 20_000 });
    await page.keyboard.press('Escape'); // 段间收菜单
    await expect(page.locator(MENU_POP)).toHaveCount(0);

    // ④ 连接服务器：行内 ServerConnectForm 开合（再点收起/复点展开，常驻挂载 hidden
    //    控制而非卸载）+ 连接成功收起整个菜单 + 目录 tab 落组
    const form = await menuConnectServer(page);
    await page.locator(MENU_POP).getByRole('button', { name: '连接服务器', exact: true }).click();
    await expect(form).toBeHidden();
    await page.locator(MENU_POP).getByRole('button', { name: '连接服务器', exact: true }).click();
    await expect(form).toBeVisible();
    await page.getByLabel('服务器地址').fill(fake.base);
    await page.getByRole('button', { name: '连接', exact: true }).click();
    await expect(page.locator(MENU_POP)).toHaveCount(0);
    await expect(page.locator('.vv-tab', { hasText: fake.host })).toBeVisible({ timeout: 10_000 });

    // ⑤ 刷新当前文件（rev 自增 → ViewerPane 渲染 effect 重跑 → 远端 store 重读）：
    //    改服务端内容后点菜单刷新条目，新内容落渲染面（url store 有 bytes 缓存不可
    //    观测，故走远端 store）；动作类条目点击即收菜单
    await openTreeFile(page, 'rev.txt');
    await expect(page.locator('.vv-code-pre')).toContainText('rev-one body', { timeout: 20_000 });
    fake.files['rev.txt'] = 'rev-two body\n';
    await openMenu(page);
    await page.locator(MENU_POP).locator('button[aria-label="刷新当前文件"]').click();
    await expect(page.locator(MENU_POP)).toHaveCount(0);
    await expect(page.locator('.vv-code-pre')).toContainText('rev-two body', { timeout: 20_000 });

    // ⑥ 主题三态切换生效（三显式项子菜单；当前项 ✓ 前缀回显，选择即应用并收菜单）
    await openSubmenu(page, '主题');
    const themeItem = (label: string) => page.locator(MENU_POP).getByRole('button', { name: label });
    await expect(themeItem('跟随系统')).toHaveText('✓ 跟随系统'); // 初态 system（settings 默认）
    await themeItem('亮').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme-mode', 'light');
    await expect(page.locator(MENU_POP)).toHaveCount(0);
    await openSubmenu(page, '主题');
    await themeItem('暗').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme-mode', 'dark');
    await openSubmenu(page, '主题');
    await expect(themeItem('暗')).toHaveText('✓ 暗'); // ✓ 随 themeMode 回显
    await themeItem('跟随系统').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme-mode', 'system');

    // ⑦ 目录管理开管理页（aria/title 逐字红线锚）
    await openMenu(page);
    await page.locator(MENU_POP).getByRole('button', { name: '目录管理' }).click();
    await expect(page.locator('.vv-mounts-manager')).toBeVisible();
    await expect(page.locator(MENU_POP)).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.locator('.vv-mounts-manager')).toHaveCount(0);

    // ⑧ 设置开设置中心
    await openMenu(page);
    await page.locator(MENU_POP).getByRole('button', { name: '设置', exact: true }).click();
    await expect(page.locator('.vv-settings-center')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.vv-settings-center')).toHaveCount(0);

    // ⑨ 专注进出 zen 类翻转：菜单条目进 zen（aria-label 随态文案「进入专注模式」）；
    //    zen 下标签栏隐藏——热区唤出临时条再经菜单「退出专注模式」退出（进/出双程
    //    都走第 8 行条目，触达矩阵完整）
    await openMenu(page);
    const zenBtn = page
      .locator(MENU_POP)
      .getByRole('button', { name: '进入专注模式', exact: true });
    await zenBtn.click();
    await expect(page.locator('.vv-shell.zen')).toHaveCount(1);
    await hoverTabEdge(page);
    await expect(page.locator('.vv-tabbar.vv-chrome-temp')).toBeVisible();
    await openMenu(page);
    await page
      .locator(MENU_POP)
      .getByRole('button', { name: '退出专注模式', exact: true })
      .click();
    await expect(page.locator('.vv-shell.zen')).toHaveCount(0);
    await expect(page.locator('.vv-tabbar')).toBeVisible();
  } finally {
    await fake.close();
  }
});

// ---------------------------------------------------------------- MEN-02

test('MEN-02：子菜单手风琴——三父项展开/再点收起、展开 A 后点 B 仅 A 收、aria-expanded 翻转', async ({
  page
}) => {
  await waitAppMounted(page);
  const parent = (which: '工作区' | '打开' | '主题') =>
    page.locator(MENU_POP).getByRole('button', { name: which, exact: true });
  const caret = (which: '工作区' | '打开' | '主题') => parent(which).locator('.vv-tbmenu-caret');
  const sub = page.locator(`${MENU_POP} > .vv-tbmenu-sub`); // 就地手风琴子区（单槽）

  // ① 三父项逐个：点击展开（aria-expanded=true + ▸→▾ + 子区在 DOM 且内容成形）
  //    → 再点收起（翻转 + 子区卸载）
  for (const which of ['工作区', '打开', '主题'] as const) {
    await openSubmenu(page, which); // helper 内含父项点击 + aria-expanded=true 断言
    await expect(parent(which)).toHaveAttribute('aria-expanded', 'true');
    await expect(caret(which)).toHaveText('▾');
    await expect(sub).toHaveCount(1);
    if (which === '工作区') {
      await expect(page.locator(`${MENU_POP} .vv-ws-item`)).toHaveCount(1); // 默认组单行
      await expect(page.locator(`${MENU_POP} .vv-ws-new`)).toBeVisible(); // ＋新建入口
    } else if (which === '打开') {
      for (const item of ['打开文件', '打开文件夹', '粘贴 URL']) {
        await expect(
          page.locator(MENU_POP).getByRole('button', { name: item, exact: true })
        ).toBeVisible();
      }
    } else {
      for (const label of ['跟随系统', '亮', '暗']) {
        await expect(page.locator(MENU_POP).getByRole('button', { name: label })).toBeVisible();
      }
    }
    await parent(which).click(); // 再点收起（就地手风琴 toggle）
    await expect(parent(which)).toHaveAttribute('aria-expanded', 'false');
    await expect(caret(which)).toHaveText('▸');
    await expect(sub).toHaveCount(0);
    await page.keyboard.press('Escape'); // 段间收菜单，下一段从首层起
    await expect(page.locator(MENU_POP)).toHaveCount(0);
  }

  // ② 展开 A 后点 B：仅 A 收（sub 单槽状态互斥，spec §3.2「同刻至多一个子菜单展开」）
  await openSubmenu(page, '工作区');
  await expect(page.locator(`${MENU_POP} .vv-ws-item`)).toHaveCount(1);
  await parent('打开').click();
  await expect(parent('工作区')).toHaveAttribute('aria-expanded', 'false');
  await expect(parent('打开')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator(`${MENU_POP} .vv-ws-item`)).toHaveCount(0); // A 的子区随收卸载
  await expect(
    page.locator(MENU_POP).getByRole('button', { name: '打开文件', exact: true })
  ).toBeVisible();
  await expect(sub).toHaveCount(1);
  await parent('主题').click();
  await expect(parent('打开')).toHaveAttribute('aria-expanded', 'false');
  await expect(parent('主题')).toHaveAttribute('aria-expanded', 'true');
  await expect(
    page.locator(MENU_POP).getByRole('button', { name: '打开文件', exact: true })
  ).toHaveCount(0);
  await expect(page.locator(MENU_POP).getByRole('button', { name: '跟随系统' })).toBeVisible();
  await expect(sub).toHaveCount(1);
});

// ---------------------------------------------------------------- MEN-03

test('MEN-03：关闭通道——物理 Esc（浮层内焦点）/合成 Esc（pop 本体派发）/外点 pointerdown 三通道零残留', async ({
  page
}) => {
  await waitAppMounted(page);

  // 通道① 物理 Esc，焦点在浮层内：先点父项置焦（keydown target 落浮层内 → 容器
  // onkeydown 通道；window 兜底 contains 守卫放走，同事件不双触发）
  await openMenu(page);
  await page.locator(MENU_POP).getByRole('button', { name: '主题', exact: true }).click();
  await expect(page.locator(MENU_POP).getByRole('button', { name: '跟随系统' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator(MENU_POP)).toHaveCount(0);
  await expect(page.locator(TRIGGER)).toHaveAttribute('aria-expanded', 'false'); // 零残留

  // 通道② 合成 Esc：派发目标 = OVERLAY_SELECTOR 命中项 = pop 本体（closeTopOverlay
  // ForZen 的移动端返回键通道）——window 兜底被 contains 守卫挡下，只有容器通道能关
  await openMenu(page);
  await dispatchSyntheticEsc(page);
  await expect(page.locator(MENU_POP)).toHaveCount(0);
  await expect(page.locator(TRIGGER)).toHaveAttribute('aria-expanded', 'false');

  // 通道③ 外点 pointerdown（浮层外落点即收；fixed 定位无 scroll-close 通道）。
  // 外点落位用裸坐标 page.mouse.click（x=200,y=560 两 project 视口均在界内、落在
  // 空 viewer 主体/侧栏空白——无业务 handler）：locator.click 的 actionability 对
  // 空态元素不可靠（statusbar 空态不渲染、.vv-tabbar-tabs 空态零高空包围盒恒等
  // 不可点，两轮实测挂满 30s），裸坐标只派发 pointerdown 关闭通道本身
  await openMenu(page);
  await page.mouse.click(200, 560);
  await expect(page.locator(MENU_POP)).toHaveCount(0);
  await expect(page.locator(TRIGGER)).toHaveAttribute('aria-expanded', 'false');
});

// ---------------------------------------------------------------- MEN-04

// TAX-14 随迁口径的域内主锚（docs/e2e/tab-actions-enrichment.md 该行类名已随迁
// .vv-tbmenu-pop）：融合菜单浮层与 tab 右键菜单同为 .vv-tabbar 后代的瞬态浮层，
// 「同刻至多一个」由双方外点 pointerdown 关闭器自然合成。本锚加压点：① 以子菜单
// 展开态开菜单——子菜单随宿主浮层同生命周期（无独立关闭态），一次外点全收。
test('MEN-04：融合菜单与 tab 右键菜单互斥——双向接管同刻至多一个（含子菜单展开态）', async ({
  page
}) => {
  test.setTimeout(60_000);
  await waitAppMounted(page);
  // 右键载体：合成 drop 单文件 tab（t-workspace dropFile 先例；注入空目录被
  // openDirectoryViaInput「所选文件夹为空」拒收不建 tab，载荷不可省）
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['mutex body\n'], 'mutex.txt', { type: 'text/plain' }));
    window.dispatchEvent(
      new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })
    );
  });
  await expect(page.locator('.vv-tab.active', { hasText: 'mutex.txt' })).toBeVisible();

  const pop = page.locator(MENU_POP);
  const ctx = page.locator('.vv-tabctx');
  const overlayCount = async (): Promise<number> => page.locator(`${MENU_POP}, .vv-tabctx`).count();

  // ① 融合菜单开（含「打开」子菜单展开态）→ 右键 tab：pointerdown(button 2) 落浮层
  //    外先收菜单（含子菜单区），contextmenu 再挂右键菜单——右键接管
  await openSubmenu(page, '打开');
  await expect(
    page.locator(MENU_POP).getByRole('button', { name: '打开文件', exact: true })
  ).toBeVisible();
  await page.locator('.vv-tab.active', { hasText: 'mutex.txt' }).click({ button: 'right' });
  await expect(ctx).toBeVisible();
  await expect(pop).toHaveCount(0);
  expect(await overlayCount()).toBe(1);

  // ② 反向：右键菜单开 → 点触发钮：外点 pointerdown 关右键菜单、click toggle 开菜单
  await openMenu(page);
  await expect(ctx).toHaveCount(0);
  await expect(pop).toBeVisible();
  expect(await overlayCount()).toBe(1);
  await expect(page.locator(`${TABBAR_MENU} [aria-label="切换工作区"]`)).toHaveAttribute(
    'aria-expanded',
    'true'
  );

  // ③ Esc 全收零残留（两浮层合计 0）
  await page.keyboard.press('Escape');
  await expect(pop).toHaveCount(0);
  await expect(ctx).toHaveCount(0);
  expect(await overlayCount()).toBe(0);
});

// ---------------------------------------------------------------- MEN-05

test('MEN-05：管理 ▾ 触发 wspanel——data-vv-wspanel-trigger 面板可见，Esc 收', async ({
  page
}) => {
  await waitAppMounted(page);
  const manage = page.locator('[aria-label="管理标签"]');
  // aria 锚 + 外点关闭豁免钩子不变（Task 3 仅缩形态：文本「管理」→ 字形 ▾）
  await expect(manage).toHaveAttribute('data-vv-wspanel-trigger', '');
  await expect(manage).toHaveText('▾');
  await manage.click();
  const panel = page.locator('.vv-wspanel');
  await expect(panel).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
});

// ---------------------------------------------------------------- MOB-01

// 浮层触顶（spec §3.3 超高策略的 e2e 承接，评审焦点 1）：mobile 667px 高、工作区
// 列表 + 连接服务器表单叠加展开触顶——$effect 实测内容高压 max-height 转内部滚动
// （该滚动条属面板滚动非 tab 条，不隐藏）；chromium 720px 不触顶走收合路径
// （max-height 清空 + top 拉回兜底）。两 project 同一用例分叉断言
// （b-tabbar-scroll SCRL-07 的 project 分叉写法同款）。
//
// 工作区 5 枚（简报原样）：修复 edad740 后钳制面跨 box-sizing 精确（content-box
// 扣 chrome = padding 8 + border 2 = 10），5 枚构造内容总高 628 > avail 620 必然
// 触顶内滚（实测 scrollHeight 626 > clientHeight 618、bottom 659 = innerH 667 − 8）。
// 修复前该构造落在 10px 死窗（钳制值 ≥ 内容高不产生溢出、内滚不触发），曾权宜
// 加量 8 枚绕过——死窗随修复消除，权宜回退。
//
// 超高策略缺陷史（Task 4 探针定性 → 属主修复 edad740 → 本用例断言收紧）：首版
// $effect 按 border-box 语义直写 avail，content-box 下钳制面实为内容盒——底缘越
// 视口 +2px（实测 669 > 667）且钳制值 ≥ 内容高不产生溢出。修复后 maxHeight =
// avail − chrome（getComputedStyle 分支扣 padding+border；border-box 下 chrome=0），
// 先清再测自然占高（rect 与「底缘 ≤ 视口」断言同源），底缘 ≤ 视口 − 8 精确成立。
test('MOB-01：浮层触顶——子菜单+连接服务器表单叠加，mobile 断内部滚动+top 不越视口，chromium 断收合路径', async ({
  page
}, testInfo) => {
  test.setTimeout(90_000);
  await waitAppMounted(page);
  // 新建 5 个工作区（WorkspaceCreateModal UI 循环，b-wscreate-outside-close /
  // t-workspace createWorkspace 同款两段流）
  for (let i = 1; i <= 5; i++) {
    await openSubmenu(page, '工作区');
    await page.getByRole('button', { name: '＋ 新建工作区…' }).click();
    const modal = page.locator('.vv-wscreate');
    await expect(modal).toBeVisible();
    await page.getByLabel('工作区名称').fill(`mob-ws-${i}`);
    await modal.getByRole('button', { name: '创建并激活' }).click();
    await expect(modal).toHaveCount(0);
  }

  // 开菜单 + 工作区子菜单 + 连接服务器表单（两展开面同刻齐开——srvOpen 与 sub 独立）
  await openSubmenu(page, '工作区');
  await expect(page.locator(`${MENU_POP} .vv-ws-item`)).toHaveCount(6); // 默认 + 5 新建
  await page.locator(MENU_POP).getByRole('button', { name: '连接服务器', exact: true }).click();
  await expect(page.locator(`${MENU_POP} .vv-server-form`)).toBeVisible();

  // top 未越视口（评审焦点 1 字面锚）
  const m = await popMetrics(page);
  expect(m.top).toBeGreaterThanOrEqual(0);

  if (testInfo.project.name === 'mobile') {
    // 触顶路径：scrollHeight > clientHeight + $effect 写入的 max-height + 内部确可滚
    await expect
      .poll(async () => {
        const v = await popMetrics(page);
        return v.scrollHeight - v.clientHeight;
      })
      .toBeGreaterThan(0);
    const over = await popMetrics(page);
    expect(over.overflowY).toBe('auto');
    expect(over.maxHeight, '$effect 实测写入限高（收合路径则恒空串）').not.toBe('');
    const scrolled = await page.evaluate((sel) => {
      const el = document.querySelector(sel) as HTMLElement;
      el.scrollTop = 40;
      return el.scrollTop;
    }, MENU_POP);
    expect(scrolled).toBeGreaterThan(0);
    // 底缘精确锚（spec §3.3 意图，edad740 修复后收紧）：bottom ≤ 视口底 − 8
    const after = await popMetrics(page);
    expect(after.bottom).toBeLessThanOrEqual(after.viewportH - 8);
  } else {
    // 收合路径（1280×720 不触顶）：max-height 清空、无溢出（scrollHeight <= clientHeight）、
    // 整体落视口内（内容远小于可用高，无 box-model 偏差面）
    await expect.poll(async () => (await popMetrics(page)).maxHeight).toBe('');
    const collapsed = await popMetrics(page);
    expect(collapsed.scrollHeight).toBeLessThanOrEqual(collapsed.clientHeight);
    expect(collapsed.bottom).toBeLessThanOrEqual(collapsed.viewportH);
  }
});
