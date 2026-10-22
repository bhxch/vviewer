import { test, expect, type Page, type Route } from '@playwright/test';
import { closeDrawerIfOpened, openDrawerIfNarrow } from './drawer';

/**
 * b-mounts-deep 目录挂载补强（MM-11~MM-19，续 b-mounts-manager MM-01~10；
 * 本轮补强验证：边界/负路径/组合交互/性能锚）。与既有覆盖分工（不重复）：
 * - MM-11 降级重探转健康（台账 3-18 的 e2e 面，单测锚 b2bf99a 在案 e2e 为零）
 *   + 失败记录不残留失效索引（台账 3-11）：pendingRetry 记录徽标「待注册（原因）」
 *   无打开钮 → 刷新对账同指纹命中运行时段 → probe 成功即转「已注册」且零 POST/
 *   零 DELETE（重探不做后台轮询、无凭据轮换面）；
 * - MM-12 tab 显示名映射（台账 3-20/419aa4a）proxy 恢复链回归锚：快照 tab 名
 *   冻结「host · 根2/」旧形态 + 记录在场 → 恢复目录 tab 名=挂载 label 而非「根N」；
 * - MM-13 同锚的 direct 侧：快照存旧名、记录已改名（storeId 不含 label，改名
 *   不换 id）→ 恢复 tab 名跟随新 label（映射优先、storeLabel 仅 hash 输入）；
 * - MM-14 WebDAV PROPFIND 命名空间变体（d4b0955 解析前缀无关锚的 e2e 化）：
 *   默认命名空间（无前缀 xmlns="DAV:"）全链树渲染 + 自定义前缀（R:）行内测试；
 * - MM-15 S3 ListObjectsV2 分页聚合：IsTruncated+NextContinuationToken 两页链
 *   （continuation-token 线格式断言）+ 两页条目全渲染；
 * - MM-16 大目录 1000 条渲染性能锚（宽松上界冒烟，CI 双核不挟时序脆弱断言）；
 * - MM-17 Range 防线（dav 忽略 Range 回 200 全量→切窗+rangeCapable=false 后
 *   续走全量切片通道）：文件内容首尾哨兵完整可读 + Range 头确实发出过；
 * - MM-18 直连凭据轮换（终审 I-3/d396b87 回归面）：编辑表单 secret 明文回填→
 *   改密保存→releaseDirectMountStore 关闭持有 tab（状态栏「已关闭 N 个标签页
 *  （挂载已释放）」）→重开新实例以新凭据发 Basic（authLog 时序断言）；
 * - MM-19 DELETE 活跃 tab 组合：删除正被 tab 引用的运行时挂载→服务端注销→
 *   行消失、已开 tab 不中断（内容留存）→手动刷新树对已注销根 404 降级显式化
 *   （SUSP-07 状态栏通道）。
 *
 * 区域贯通注记：suggestedAngles 中「region 非默认配置贯通」在纯 web 套件无落点
 * （region 是服务端 TOML/env/API 字段，前端记录/表单/SigV4 直连 opts 均无该
 * 字段——openFlow createS3DirectStore 不传 opts.region，恒 us-east-1），归
 * e2e-server 通道，本轮不做。
 */

/** FNV-1a hash8（core singleFile.ts 同算法镜像；与 b-mounts-manager 同款）。 */
function hash8(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** 跨源 mock API 的 CORS 响应头（页面 origin :4173 → 各 mock 端口均为跨域 fetch）。 */
const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization,content-type,depth,x-amz-content-sha256,x-amz-date,range',
  'access-control-allow-methods': 'GET,POST,DELETE,PROPFIND,OPTIONS',
  'access-control-expose-headers': 'content-range,content-length,etag'
};

/** 预检 + JSON 伺服（health/mounts/ticket/tree 等 Bearer API 通道）。 */
function jsonFulfill(route: Route, body: unknown, status = 200): void {
  void route.fulfill({ status, headers: { ...CORS_HEADERS, 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

/** 会话种子（addInitScript）：last-server + server-health 摘要（b-mounts-manager 同款）。 */
async function seedServerSession(page: Page, base: string, fsRoots: number | null): Promise<void> {
  await page.addInitScript(
    ({ base, fsRoots }) => {
      sessionStorage.setItem('vviewer-last-server', JSON.stringify({ baseUrl: base, token: null }));
      if (fsRoots !== null) {
        sessionStorage.setItem(
          'vv:server-health',
          JSON.stringify({ version: '1.0.0-e2e', capabilities: ['file-server'], searchEngine: null, roots: 3, fsRoots })
        );
      }
    },
    { base, fsRoots }
  );
}

/** IndexedDB 直写 v4 mounts store 记录（应用首导航建库后调用）。onupgradeneeded
 *  自带四 store 补建（b-settings-center-deep seedKv 同款）：goto 后产品建库是异步的，
 *  若本 evaluate 先到，open('vviewer',4) 触发升级而无补建处理器会落成空库，
 *  transaction('mounts') 抛 NotFoundError（MM-17/18 flaky 根因）。 */
async function seedMountRecord(page: Page, rec: Record<string, unknown>): Promise<void> {
  await page.evaluate(async (rec) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('vviewer', 4);
      req.onupgradeneeded = () => {
        const d = req.result;
        for (const s of ['kv', 'themes', 'fonts', 'mounts']) {
          if (!d.objectStoreNames.contains(s)) d.createObjectStore(s);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction('mounts', 'readwrite');
      tx.objectStore('mounts').put(rec, (rec as { id: string }).id);
      tx.oncomplete = () => resolve(undefined);
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, rec);
}

/** IndexedDB 直写 kv 'workspaces' 快照（restore 装置：seed 后 reload 走恢复链；补建同上）。 */
async function seedSnapshot(page: Page, snap: Record<string, unknown>): Promise<void> {
  await page.evaluate(async (snap) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('vviewer', 4);
      req.onupgradeneeded = () => {
        const d = req.result;
        for (const s of ['kv', 'themes', 'fonts', 'mounts']) {
          if (!d.objectStoreNames.contains(s)) d.createObjectStore(s);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(snap, 'workspaces');
      tx.oncomplete = () => resolve(undefined);
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, snap);
}

/** 树行可见断言的抽屉适配（b-mounts-manager seeTreeRow 同款）。 */
async function seeTreeRow(page: Page, text: string): Promise<void> {
  await openDrawerIfNarrow(page);
  await expect(page.locator('.vv-tree-row', { hasText: text }).first()).toBeVisible();
}

/** 树行点击（窄视口先开抽屉；点击后应用自动收起，closeDrawerIfOpened 幂等还原）。 */
async function clickTreeRow(page: Page, text: string): Promise<void> {
  const drawer = await openDrawerIfNarrow(page);
  await page.locator('.vv-tree-row', { hasText: text }).first().click();
  await closeDrawerIfOpened(page, drawer);
}

async function openManager(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('.vv-topbar')).toBeVisible();
  await page.locator('button[aria-label="目录管理"]').click();
  await expect(page.locator('.vv-mounts-manager')).toBeVisible();
}

/** multistatus 构造（命名空间变体参数化）：entries 含集合自身（isSelf 跳过）。
 * flavor：'dav-prefix' = 传统 D: 前缀；'default-ns' = 默认命名空间无前缀；
 * 'custom-prefix' = 任意前缀 R:（d4b0955：解析按命名空间 URI 而非字面前缀）。 */
function multistatusXml(
  entries: Array<{ href: string; dir?: boolean; size?: number }>,
  flavor: 'dav-prefix' | 'default-ns' | 'custom-prefix'
): string {
  const tag = (name: string): string => (flavor === 'default-ns' ? name : flavor === 'custom-prefix' ? `R:${name}` : `D:${name}`);
  const attrs = flavor === 'default-ns' ? ' xmlns="DAV:"' : flavor === 'custom-prefix' ? ' xmlns:R="DAV:"' : ' xmlns:D="DAV:"';
  const body = entries
    .map(
      (e) =>
        `<${tag('response')}><${tag('href')}>${e.href}</${tag('href')}>` +
        (e.dir
          ? `<${tag('resourcetype')}><${tag('collection')}/></${tag('resourcetype')}>`
          : `<${tag('resourcetype')}/><${tag('getcontentlength')}>${e.size ?? 3}</${tag('getcontentlength')}>`) +
        `</${tag('response')}>`
    )
    .join('');
  return `<?xml version="1.0"?><${tag('multistatus')}${attrs}>${body}</${tag('multistatus')}>`;
}

/** mock WebDAV（变体驱动）：PROPFIND 回 flavor 构造的 multistatus；GET 按 files
 * 分发且恒回 200 全量（Range 防线降级面——服务器无视 Range 的形态），readLog 采集
 * Range 请求头、authLog 采集 authorization 头；未命中兜底 404（与既有 mockDav 对齐）。 */
async function mockDavEx(
  page: Page,
  origin: string,
  opts: {
    entries: Array<{ href: string; dir?: boolean; size?: number }>;
    flavor: 'dav-prefix' | 'default-ns' | 'custom-prefix';
    files?: Record<string, string>;
    authLog?: string[];
    readLog?: string[];
  }
): Promise<void> {
  await page.route(`**${origin}/**`, (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') {
      return void route.fulfill({ status: 200, headers: CORS_HEADERS, body: '' });
    }
    if (req.method() === 'PROPFIND') {
      opts.authLog?.push(req.headers()['authorization'] ?? '');
      return void route.fulfill({
        status: 207,
        headers: { ...CORS_HEADERS, 'content-type': 'application/xml' },
        body: multistatusXml(opts.entries, opts.flavor)
      });
    }
    const path = new URL(req.url()).pathname;
    for (const [key, body] of Object.entries(opts.files ?? {})) {
      if (path.endsWith(`/${key}`)) {
        opts.readLog?.push(req.headers()['range'] ?? '');
        return void route.fulfill({ status: 200, headers: CORS_HEADERS, body });
      }
    }
    return void route.fulfill({ status: 404, headers: CORS_HEADERS, body: 'not found' });
  });
}

test.describe('b-mounts-deep 目录挂载补强', () => {
  // 降级重探（3-18）+ 失败记录不残留索引（3-11）：pending 态不误导 → 对账重探成功即转健康且零重注册
  test('MM-11 失败记录徽标待注册无打开钮→刷新对账重探成功转已注册（零 POST/DELETE）', async ({ page }) => {
    test.setTimeout(60_000);
    const API = 'http://127.0.0.1:8794';
    await seedServerSession(page, API, null);
    let mountsGet = 0;
    let root2Probe = 0;
    let postCount = 0;
    let deleteCount = 0;
    const entry = {
      rootIndex: 2,
      kind: 's3',
      label: '重探桶',
      endpoint: 'http://127.0.0.1:9006',
      bucket: 'bkt',
      prefix: '',
      capabilities: { watch: false, search: false }
    };
    await page.route(`**${API}/**`, (route) => {
      const req = route.request();
      if (req.method() === 'OPTIONS') return void route.fulfill({ status: 200, headers: CORS_HEADERS, body: '' });
      const path = new URL(req.url()).pathname;
      if (path === '/api/health') return jsonFulfill(route, { version: '1.0.0-e2e', capabilities: ['file-server'] });
      if (path === '/api/mounts' && req.method() === 'GET') {
        mountsGet++;
        return jsonFulfill(route, { fsRoots: 1, staticMounts: [], runtimeMounts: [entry], mounts: [entry] });
      }
      if (path === '/api/mounts' && req.method() === 'POST') {
        postCount++;
        return jsonFulfill(route, { rootIndex: 2 });
      }
      if (path.startsWith('/api/mounts/') && req.method() === 'DELETE') {
        deleteCount++;
        return void route.fulfill({ status: 204, headers: CORS_HEADERS, body: '' });
      }
      if (path === '/api/tree') {
        if (new URL(req.url()).searchParams.get('root') === '2') root2Probe++;
        return jsonFulfill(route, { entries: [{ name: 'r.txt', kind: 'file', size: 2 }] });
      }
      if (path === '/api/ticket') return jsonFulfill(route, { ticket: 'e2e' });
      if (path === '/api/events') {
        return void route.fulfill({ status: 200, headers: { ...CORS_HEADERS, 'content-type': 'text/event-stream' }, body: '' });
      }
      return void route.fulfill({ status: 404, headers: CORS_HEADERS, body: '{}' });
    });

    // ① 刷新前：pendingRetry 记录（注册失败遗留）→ 徽标「待注册（原因）」，
    // 不残留「已注册」误导、无打开钮（3-11：失败记录清失效索引，展示机不供打开消费）
    await page.goto('/');
    await expect(page.locator('.vv-topbar')).toBeVisible();
    await seedMountRecord(page, {
      id: 'mount:mm11',
      kind: 'proxy',
      backend: 's3',
      label: '重探桶',
      endpoint: 'http://127.0.0.1:9006',
      bucket: 'bkt',
      prefix: '',
      username: 'AK',
      secret: 'SK',
      fingerprint: 'mm11-fp',
      serverBase: API,
      createdAt: 1700000000000,
      pendingRetry: true,
      lastError: '注册失败：HTTP 500'
    });
    await page.locator('button[aria-label="目录管理"]').click();
    const row = page.locator('.vv-mm-item', { hasText: '重探桶' });
    await expect(row.locator('.vv-mm-state')).toContainText('待注册（注册失败：HTTP 500）');
    await expect(row.locator('.vv-mm-state')).not.toContainText('已注册');
    // 「无打开钮」锚组②（配置挂载行，has .vv-mm-state 唯一甄别——同名 label 也会出现在
    // 组① 运行时清单行，其「在树中打开」是运行时入口不属本断言面；exact 避子串误配）
    await expect(
      row
        .filter({ has: page.locator('.vv-mm-state') })
        .getByRole('button', { name: '打开', exact: true })
    ).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.locator('.vv-mounts-manager')).toHaveCount(0);

    // ② 刷新走 restore 重连对账（快照 host 源触发）：同指纹命中运行时段 → probe
    // 成功即转健康——重探不做凭据轮换（零 DELETE+POST），3-18「失败记录不被短路」
    await seedSnapshot(page, {
      activeId: 'w1',
      workspaces: [
        {
          id: 'w1',
          name: '默认',
          createdAt: 1700000000000,
          sources: [{ kind: 'remote', storeId: `remote:${hash8(`${API}:srv`)}`, storeLabel: 'srv', storeBase: API }],
          tabs: [],
          activeTabId: null
        }
      ]
    });
    await page.reload();
    await expect(page.locator('.vv-topbar')).toBeVisible();
    await expect.poll(() => mountsGet, { timeout: 15_000 }).toBeGreaterThan(0);
    await expect.poll(() => root2Probe, { timeout: 15_000 }).toBeGreaterThan(0); // probe 已飞行
    await page.locator('button[aria-label="目录管理"]').click();
    await expect(page.locator('.vv-mm-item', { hasText: '重探桶' }).locator('.vv-mm-state')).toContainText(
      '已注册 rootIndex=2'
    );
    expect(postCount).toBe(0); // 重探成功：不做 DELETE+POST 凭据轮换
    expect(deleteCount).toBe(0);
  });

  // 显示名映射（3-20）proxy 恢复链回归锚：恢复的挂载根目录 tab 名=label 而非冻结「根N」旧形态
  test('MM-12 proxy 挂载根恢复：快照 tab 冻结名「host · 根2/」→ 恢复 tab 名映射为挂载 label', async ({ page }) => {
    test.setTimeout(60_000);
    const API = 'http://127.0.0.1:8795';
    await seedServerSession(page, API, null);
    let postCount = 0;
    const entry = {
      rootIndex: 2,
      kind: 's3',
      label: 'docs挂载',
      endpoint: 'http://127.0.0.1:9007',
      bucket: 'bkt',
      prefix: '',
      capabilities: { watch: false, search: false }
    };
    await page.route(`**${API}/**`, (route) => {
      const req = route.request();
      if (req.method() === 'OPTIONS') return void route.fulfill({ status: 200, headers: CORS_HEADERS, body: '' });
      const path = new URL(req.url()).pathname;
      if (path === '/api/health') return jsonFulfill(route, { version: '1.0.0-e2e', capabilities: ['file-server'] });
      if (path === '/api/mounts' && req.method() === 'GET') {
        return jsonFulfill(route, { fsRoots: 1, staticMounts: [], runtimeMounts: [entry], mounts: [entry] });
      }
      if (path === '/api/mounts' && req.method() === 'POST') {
        postCount++;
        return jsonFulfill(route, { rootIndex: 2 });
      }
      if (path === '/api/tree') {
        const root = new URL(req.url()).searchParams.get('root');
        return jsonFulfill(route, {
          entries: root === '2' ? [{ name: 'doc-a.txt', kind: 'file', size: 5 }] : []
        });
      }
      if (path === '/api/file') return void route.fulfill({ status: 200, headers: CORS_HEADERS, body: 'doc body\n' });
      if (path === '/api/ticket') return jsonFulfill(route, { ticket: 'e2e' });
      if (path === '/api/events') {
        return void route.fulfill({ status: 200, headers: { ...CORS_HEADERS, 'content-type': 'text/event-stream' }, body: '' });
      }
      return void route.fulfill({ status: 404, headers: CORS_HEADERS, body: '{}' });
    });

    await page.goto('/');
    await expect(page.locator('.vv-topbar')).toBeVisible();
    // storeLabel 是 remoteSourceLabel 冻结形态（hash 输入，恢复链原值回环）；
    // displayLabelForStore 按（registeredRootIndex, serverBase）命中挂载 label
    const storeLabel = '127.0.0.1:8795 · 根2/';
    const storeId = `remote:${hash8(`${API}:${storeLabel}`)}:r2`;
    await seedMountRecord(page, {
      id: 'mount:mm12',
      kind: 'proxy',
      backend: 's3',
      label: 'docs挂载',
      endpoint: 'http://127.0.0.1:9007',
      bucket: 'bkt',
      prefix: '',
      username: 'AK',
      secret: 'SK',
      fingerprint: 'mm12-fp',
      serverBase: API,
      createdAt: 1700000000000,
      registeredRootIndex: 2
    });
    await seedSnapshot(page, {
      activeId: 'w1',
      workspaces: [
        {
          id: 'w1',
          name: '默认',
          createdAt: 1700000000000,
          sources: [{ kind: 'remote', storeId, storeLabel, storeBase: API, rootIndex: 2 }],
          tabs: [
            { id: 't1', storeId, storeLabel, path: '', name: storeLabel, kind: 'rename-only', scrollTop: 0, active: true }
          ],
          activeTabId: 't1'
        }
      ]
    });
    await page.reload();
    // 目录 tab 名映射优先：显示挂载 label；冻结「根2」形态不得露 tab 面
    await expect(page.locator('.vv-tab.active', { hasText: 'docs挂载' })).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('.vv-tab', { hasText: '根2' })).toHaveCount(0);
    await seeTreeRow(page, 'doc-a.txt');
    await expect.poll(() => postCount, { timeout: 10_000 }).toBe(0); // 清单同指纹命中：对账零重注册
  });

  // 显示名映射 direct 侧：改名不换 id，旧快照恢复后 tab 名跟随记录新 label
  test('MM-13 direct 改名恢复：快照存旧名「老名桶」、记录已改名「新名桶」→ 恢复 tab 名=新名', async ({ page }) => {
    test.setTimeout(60_000);
    const recId = `s3direct:${hash8(['s3', 'http://127.0.0.1:9010', 'bkt', '', 'path'].join('\u{1f}'))}`;
    const rec = {
      id: recId,
      kind: 'direct',
      backend: 's3',
      label: '新名桶',
      endpoint: 'http://127.0.0.1:9010',
      bucket: 'bkt',
      prefix: '',
      username: 'AK',
      secret: 'SK',
      createdAt: 1700000000000
    };
    await page.route('**127.0.0.1:9010/**', (route) => {
      const req = route.request();
      if (req.method() === 'OPTIONS') return void route.fulfill({ status: 200, headers: CORS_HEADERS, body: '' });
      if (req.url().includes('list-type=2')) {
        return void route.fulfill({
          status: 200,
          headers: { ...CORS_HEADERS, 'content-type': 'application/xml' },
          body:
            '<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated>' +
            '<Contents><Key>a.txt</Key><Size>19</Size></Contents></ListBucketResult>'
        });
      }
      if (new URL(req.url()).pathname.endsWith('/a.txt')) {
        return void route.fulfill({ status: 200, headers: CORS_HEADERS, body: 'renamed direct body\n' });
      }
      return void route.fulfill({ status: 404, headers: CORS_HEADERS, body: 'not found' });
    });
    await page.goto('/');
    await expect(page.locator('.vv-topbar')).toBeVisible();
    await seedMountRecord(page, rec);
    await seedSnapshot(page, {
      activeId: 'w1',
      workspaces: [
        {
          id: 'w1',
          name: '默认',
          createdAt: 1700000000000,
          sources: [{ kind: 'direct', storeId: recId, storeLabel: '老名桶' }],
          tabs: [
            { id: 't1', storeId: recId, storeLabel: '老名桶', path: '', name: '老名桶', kind: 'rename-only', scrollTop: 0, active: false },
            { id: 't2', storeId: recId, storeLabel: '老名桶', path: 'a.txt', name: 'a.txt', kind: 'rename-only', scrollTop: 0, active: true }
          ],
          activeTabId: 't2'
        }
      ]
    });
    await page.reload();
    // 目录 tab 名映射到记录新 label；旧名只活在快照冻结字段（hash 输入），不露 tab
    await expect(page.locator('.vv-tab.active', { hasText: 'a.txt' })).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('.vv-code-pre')).toContainText('renamed direct body');
    await expect(page.locator('.vv-tab', { hasText: '新名桶' })).toBeVisible();
    await expect(page.locator('.vv-tab', { hasText: '老名桶' })).toHaveCount(0);
    // 管理页行同为新名（记录 label 单一事实源）
    await page.locator('button[aria-label="目录管理"]').click();
    await expect(page.locator('.vv-mm-item', { hasText: '新名桶' })).toBeVisible();
    await page.keyboard.press('Escape');
    await seeTreeRow(page, 'a.txt');
  });

  // PROPFIND 命名空间变体（d4b0955 e2e 化）：默认命名空间无前缀全链 + 自定义前缀 R: 行内测试
  test('MM-14 WebDAV 命名空间变体：默认命名空间（无前缀）恢复树渲染 + 自定义前缀（R:）探测', async ({ page }) => {
    test.setTimeout(60_000);
    const recId = `davdirect:${hash8(['dav', 'http://127.0.0.1:9012/dav', ''].join('\u{1f}'))}`;
    const rec = {
      id: recId,
      kind: 'direct',
      backend: 'webdav',
      label: 'ns桶',
      endpoint: 'http://127.0.0.1:9012/dav',
      prefix: '',
      username: 'u',
      secret: 'p',
      createdAt: 1700000000000
    };
    const entries = [
      { href: '/dav/', dir: true },
      { href: '/dav/one.txt', size: 18 },
      { href: '/dav/zdir/', dir: true }
    ];
    let flavor: 'default-ns' | 'custom-prefix' = 'default-ns';
    await mockDavEx(page, 'http://127.0.0.1:9012', {
      entries,
      get flavor() {
        return flavor;
      },
      files: { 'one.txt': 'namespace-free body\n' }
    });
    await page.goto('/');
    await expect(page.locator('.vv-topbar')).toBeVisible();
    await seedMountRecord(page, rec);
    await seedSnapshot(page, {
      activeId: 'w1',
      workspaces: [
        {
          id: 'w1',
          name: '默认',
          createdAt: 1700000000000,
          sources: [{ kind: 'direct', storeId: recId, storeLabel: 'ns桶' }],
          tabs: [
            { id: 't1', storeId: recId, storeLabel: 'ns桶', path: '', name: 'ns桶', kind: 'rename-only', scrollTop: 0, active: true }
          ],
          activeTabId: 't1'
        }
      ]
    });
    // ① 默认命名空间（xmlns="DAV:" 无前缀标签）：DOMParser 命名空间感知解析 → 全链树渲染
    await page.reload();
    await expect(page.locator('.vv-tab.active', { hasText: 'ns桶' })).toBeVisible({ timeout: 20_000 });
    await seeTreeRow(page, 'one.txt');
    await seeTreeRow(page, 'zdir');
    await clickTreeRow(page, 'one.txt');
    await expect(page.locator('.vv-code-pre')).toContainText('namespace-free body');

    // ② 自定义前缀（R: + xmlns:R="DAV:"）：行内「测试」走同一探测链 → 前缀无关解析
    flavor = 'custom-prefix';
    await page.locator('button[aria-label="目录管理"]').click();
    const row = page.locator('.vv-mm-item', { hasText: 'ns桶' });
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: '测试', exact: true }).click();
    await expect(row.locator('.vv-mm-probe')).toContainText(/连接成功：根目录 2 个条目，延迟 \d+ ms/);
  });

  // S3 分页（IsTruncated+NextContinuationToken 两页链）：continuation-token 线格式 + 两页条目聚合渲染
  test('MM-15 S3 分页聚合：首页 IsTruncated → 续传 token 第二页，两页 4 文件+1 目录全渲染', async ({ page }) => {
    test.setTimeout(60_000);
    const recId = `s3direct:${hash8(['s3', 'http://127.0.0.1:9014', 'bkt', '', 'path'].join('\u{1f}'))}`;
    const rec = {
      id: recId,
      kind: 'direct',
      backend: 's3',
      label: '分页桶',
      endpoint: 'http://127.0.0.1:9014',
      bucket: 'bkt',
      prefix: '',
      username: 'AK',
      secret: 'SK',
      createdAt: 1700000000000
    };
    const listReqs: string[] = [];
    await page.route('**127.0.0.1:9014/**', (route) => {
      const req = route.request();
      if (req.method() === 'OPTIONS') return void route.fulfill({ status: 200, headers: CORS_HEADERS, body: '' });
      if (req.url().includes('list-type=2')) {
        listReqs.push(req.url());
        const second = req.url().includes('continuation-token=');
        const xml = second
          ? '<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated>' +
            '<Contents><Key>p2-a.txt</Key><Size>1</Size></Contents>' +
            '<Contents><Key>p2-b.txt</Key><Size>1</Size></Contents></ListBucketResult>'
          : '<?xml version="1.0"?><ListBucketResult><IsTruncated>true</IsTruncated>' +
            '<NextContinuationToken>tok-2</NextContinuationToken>' +
            '<Contents><Key>p1-a.txt</Key><Size>1</Size></Contents>' +
            '<Contents><Key>p1-b.txt</Key><Size>1</Size></Contents>' +
            '<CommonPrefixes><Prefix>sub/</Prefix></CommonPrefixes></ListBucketResult>';
        return void route.fulfill({ status: 200, headers: { ...CORS_HEADERS, 'content-type': 'application/xml' }, body: xml });
      }
      return void route.fulfill({ status: 404, headers: CORS_HEADERS, body: 'not found' });
    });
    await page.goto('/');
    await expect(page.locator('.vv-topbar')).toBeVisible();
    await seedMountRecord(page, rec);
    await seedSnapshot(page, {
      activeId: 'w1',
      workspaces: [
        {
          id: 'w1',
          name: '默认',
          createdAt: 1700000000000,
          sources: [{ kind: 'direct', storeId: recId, storeLabel: '分页桶' }],
          tabs: [
            { id: 't1', storeId: recId, storeLabel: '分页桶', path: '', name: '分页桶', kind: 'rename-only', scrollTop: 0, active: true }
          ],
          activeTabId: 't1'
        }
      ]
    });
    await page.reload();
    await expect(page.locator('.vv-tab.active', { hasText: '分页桶' })).toBeVisible({ timeout: 20_000 });
    // 两页条目聚合渲染（目录优先：sub 在前；文件跨页齐聚）
    await seeTreeRow(page, 'sub');
    await seeTreeRow(page, 'p1-a.txt');
    await seeTreeRow(page, 'p1-b.txt');
    await seeTreeRow(page, 'p2-a.txt');
    await seeTreeRow(page, 'p2-b.txt');
    // 分页链线格式：第二页请求携带首页下发的 continuation-token
    await expect.poll(() => listReqs.length).toBe(2);
    expect(listReqs[0]!).not.toContain('continuation-token=');
    expect(listReqs[1]!).toContain('continuation-token=tok-2');
  });

  // 大目录渲染性能锚（宽松上界冒烟）：1000 条根条目全量渲染有界完成
  test('MM-16 大目录 1000 条渲染性能锚：树行计数 1000 且完成耗时在宽松上界内', async ({ page }) => {
    test.setTimeout(60_000);
    const recId = `s3direct:${hash8(['s3', 'http://127.0.0.1:9015', 'bkt', '', 'path'].join('\u{1f}'))}`;
    const rec = {
      id: recId,
      kind: 'direct',
      backend: 's3',
      label: '大桶',
      endpoint: 'http://127.0.0.1:9015',
      bucket: 'bkt',
      prefix: '',
      username: 'AK',
      secret: 'SK',
      createdAt: 1700000000000
    };
    const keys = Array.from({ length: 1000 }, (_, i) => `f${String(i).padStart(4, '0')}.txt`);
    const xml =
      '<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated>' +
      keys.map((k) => `<Contents><Key>${k}</Key><Size>3</Size></Contents>`).join('') +
      '</ListBucketResult>';
    await page.route('**127.0.0.1:9015/**', (route) => {
      const req = route.request();
      if (req.method() === 'OPTIONS') return void route.fulfill({ status: 200, headers: CORS_HEADERS, body: '' });
      if (req.url().includes('list-type=2')) {
        return void route.fulfill({ status: 200, headers: { ...CORS_HEADERS, 'content-type': 'application/xml' }, body: xml });
      }
      return void route.fulfill({ status: 404, headers: CORS_HEADERS, body: 'not found' });
    });
    await page.goto('/');
    await expect(page.locator('.vv-topbar')).toBeVisible();
    await seedMountRecord(page, rec);
    await seedSnapshot(page, {
      activeId: 'w1',
      workspaces: [
        {
          id: 'w1',
          name: '默认',
          createdAt: 1700000000000,
          sources: [{ kind: 'direct', storeId: recId, storeLabel: '大桶' }],
          tabs: [
            { id: 't1', storeId: recId, storeLabel: '大桶', path: '', name: '大桶', kind: 'rename-only', scrollTop: 0, active: true }
          ],
          activeTabId: 't1'
        }
      ]
    });
    const started = Date.now();
    await page.reload();
    // 1000 行全量 DOM（TreeNodeRow 递归 {#each}，无虚拟化）——计数即渲染完成信号
    await expect.poll(async () => page.locator('.vv-tree-row').count(), { timeout: 20_000 }).toBe(1000);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(20_000); // 宽松上界（CI 双核冒烟）：防退化成永久挂起，非精确计时
    await seeTreeRow(page, 'f0000.txt');
  });

  // Range 防线（dav 忽略 Range 回 200 全量）：切窗降级 + 后续全量切片通道，文件仍完整可读
  test('MM-17 dav 忽略 Range 回 200 全量：Range 头曾发出、文件经全量通道首尾哨兵完整渲染', async ({ page }) => {
    test.setTimeout(60_000);
    const recId = `davdirect:${hash8(['dav', 'http://127.0.0.1:9016/dav', ''].join('\u{1f}'))}`;
    const rec = {
      id: recId,
      kind: 'direct',
      backend: 'webdav',
      label: '降级桶',
      endpoint: 'http://127.0.0.1:9016/dav',
      prefix: '',
      username: 'u',
      secret: 'p',
      createdAt: 1700000000000
    };
    const full = `RANGEFAIL-HEAD;${'x'.repeat(40_000)};RANGEFAIL-TAIL`;
    const readLog: string[] = [];
    await mockDavEx(page, 'http://127.0.0.1:9016', {
      entries: [
        { href: '/dav/', dir: true },
        { href: '/dav/one.txt', size: full.length }
      ],
      flavor: 'dav-prefix',
      files: { 'one.txt': full },
      readLog
    });
    await page.goto('/');
    await expect(page.locator('.vv-topbar')).toBeVisible();
    await seedMountRecord(page, rec);
    await seedSnapshot(page, {
      activeId: 'w1',
      workspaces: [
        {
          id: 'w1',
          name: '默认',
          createdAt: 1700000000000,
          sources: [{ kind: 'direct', storeId: recId, storeLabel: '降级桶' }],
          tabs: [
            { id: 't1', storeId: recId, storeLabel: '降级桶', path: '', name: '降级桶', kind: 'rename-only', scrollTop: 0, active: false },
            // size 不宣告：restore 后 headOnly → 首读带 Range 头（防线触发点）
            { id: 't2', storeId: recId, storeLabel: '降级桶', path: 'one.txt', name: 'one.txt', kind: 'rename-only', scrollTop: 0, active: true }
          ],
          activeTabId: 't2'
        }
      ]
    });
    await page.reload();
    await expect(page.locator('.vv-tab.active', { hasText: 'one.txt' })).toBeVisible({ timeout: 20_000 });
    // 防线语义：Range 探测确实发出过；回 200 被切窗交付后 rangeCapable=false，
    // 后续全量切片通道兜底——内容首尾哨兵齐备（非 8KB 截断面）
    await expect.poll(() => readLog.some((h) => h !== '')).toBe(true);
    await expect(page.locator('.vv-code-pre')).toContainText('RANGEFAIL-HEAD');
    await expect(page.locator('.vv-code-pre')).toContainText('RANGEFAIL-TAIL');
    await seeTreeRow(page, 'one.txt');
  });

  // 直连凭据轮换（终审 I-3）：明文回填→改密保存释放实例（状态栏提示）→重开新实例新凭据
  test('MM-18 direct 凭据轮换：编辑 secret 明文回填→保存关闭 2 个持有 tab→重开 Basic 用新凭据', async ({ page }) => {
    test.setTimeout(60_000);
    const basic1 = `Basic ${Buffer.from('davuser:pass-1').toString('base64')}`;
    const basic2 = `Basic ${Buffer.from('davuser:pass-2').toString('base64')}`;
    const recId = `davdirect:${hash8(['dav', 'http://127.0.0.1:9018/dav', ''].join('\u{1f}'))}`;
    const rec = {
      id: recId,
      kind: 'direct',
      backend: 'webdav',
      label: '轮换桶',
      endpoint: 'http://127.0.0.1:9018/dav',
      prefix: '',
      username: 'davuser',
      secret: 'pass-1',
      createdAt: 1700000000000
    };
    const authLog: string[] = [];
    await mockDavEx(page, 'http://127.0.0.1:9018', {
      entries: [
        { href: '/dav/', dir: true },
        { href: '/dav/one.txt', size: 18 }
      ],
      flavor: 'dav-prefix',
      files: { 'one.txt': 'rotated body\n' },
      authLog
    });
    await page.goto('/');
    await expect(page.locator('.vv-topbar')).toBeVisible();
    await seedMountRecord(page, rec);
    await page.reload();
    await expect(page.locator('.vv-topbar')).toBeVisible();

    // ① 打开全链：目录 tab + 文件读（Basic pass-1）
    await page.locator('button[aria-label="目录管理"]').click();
    await page.locator('.vv-mm-item', { hasText: '轮换桶' }).getByRole('button', { name: '打开' }).click();
    await page.keyboard.press('Escape');
    await expect(page.locator('.vv-tab.active', { hasText: '轮换桶' })).toBeVisible();
    await clickTreeRow(page, 'one.txt');
    await expect(page.locator('.vv-code-pre')).toContainText('rotated body');
    expect(authLog).toContain(basic1);

    // ② 编辑表单：secret 明文回填（管理页即凭据管理面）→ 改密保存 → 释放持有
    // 实例（目录+文件两 tab 系统替换关闭，状态栏计数提示）
    await page.locator('button[aria-label="目录管理"]').click();
    await page.locator('.vv-mm-item', { hasText: '轮换桶' }).getByRole('button', { name: '编辑' }).click();
    await expect(page.locator('.vv-mm-form')).toBeVisible();
    await expect(page.getByRole('heading', { name: '编辑挂载：轮换桶' })).toBeVisible();
    await expect(page.locator('#vv-mm-secret')).toHaveValue('pass-1');
    await page.locator('#vv-mm-secret').fill('pass-2');
    await page.locator('.vv-mm-form').getByRole('button', { name: '保存' }).click();
    await expect(page.locator('.vv-mm-form')).toHaveCount(0);
    await expect(page.locator('.vv-statusbar')).toContainText('已关闭 2 个标签页（挂载已释放）');
    await page.keyboard.press('Escape');
    await expect(page.locator('.vv-mounts-manager')).toHaveCount(0);

    // ③ 重开：存活实例已释放 → 新实例持新凭据（Basic pass-2 晚于全部 pass-1 请求）
    await page.locator('button[aria-label="目录管理"]').click();
    await page.locator('.vv-mm-item', { hasText: '轮换桶' }).getByRole('button', { name: '打开' }).click();
    await page.keyboard.press('Escape');
    await clickTreeRow(page, 'one.txt');
    await expect(page.locator('.vv-code-pre')).toContainText('rotated body');
    expect(authLog).toContain(basic2);
    expect(authLog.lastIndexOf(basic1)).toBeLessThan(authLog.indexOf(basic2));
  });

  // DELETE 活跃 tab 组合：删除正被 tab 引用的运行时挂载→行消失、tab 不中断、刷新树 404 显式降级
  test('MM-19 删除使用中的运行时挂载：确认注销→行消失 tab 留存内容→手动刷新树报 404', async ({ page }) => {
    test.setTimeout(60_000);
    const API = 'http://127.0.0.1:8796';
    await seedServerSession(page, API, null);
    let deleteArmed = false; // DELETE 后模拟服务端运行时项真删：root=2 面转 404
    await page.route(`**${API}/**`, (route) => {
      const req = route.request();
      if (req.method() === 'OPTIONS') return void route.fulfill({ status: 200, headers: CORS_HEADERS, body: '' });
      const path = new URL(req.url()).pathname;
      if (path === '/api/health') return jsonFulfill(route, { version: '1.0.0-e2e', capabilities: ['file-server'] });
      if (path === '/api/mounts' && req.method() === 'GET') {
        const entry = {
          rootIndex: 2,
          kind: 's3',
          label: '使用中挂载',
          endpoint: 'http://127.0.0.1:9008',
          bucket: 'bkt',
          prefix: '',
          capabilities: { watch: false, search: false }
        };
        return jsonFulfill(route, deleteArmed ? { fsRoots: 1, staticMounts: [], runtimeMounts: [], mounts: [] } : { fsRoots: 1, staticMounts: [], runtimeMounts: [entry], mounts: [entry] });
      }
      if (path === '/api/mounts' && req.method() === 'POST') return jsonFulfill(route, { rootIndex: 2 });
      if (path.startsWith('/api/mounts/') && req.method() === 'DELETE') {
        deleteArmed = true;
        return void route.fulfill({ status: 204, headers: CORS_HEADERS, body: '' });
      }
      if (path === '/api/tree') {
        if (deleteArmed && new URL(req.url()).searchParams.get('root') === '2') {
          return jsonFulfill(route, { error: 'mount unregistered' }, 404);
        }
        return jsonFulfill(route, {
          entries: [{ name: 'notes.txt', kind: 'file', size: 17 }]
        });
      }
      if (path === '/api/file') {
        if (deleteArmed) return jsonFulfill(route, { error: 'mount unregistered' }, 404);
        return void route.fulfill({ status: 200, headers: CORS_HEADERS, body: 'still alive body\n' });
      }
      if (path === '/api/ticket') return jsonFulfill(route, { ticket: 'e2e' });
      if (path === '/api/events') {
        return void route.fulfill({ status: 200, headers: { ...CORS_HEADERS, 'content-type': 'text/event-stream' }, body: '' });
      }
      return void route.fulfill({ status: 404, headers: CORS_HEADERS, body: '{}' });
    });

    // ① 注册代理挂载 → 打开 → 文件读（健康基线；快照空表不参与）
    await openManager(page);
    await page.getByRole('button', { name: '＋ 新增挂载' }).click();
    await page.locator('#vv-mm-mode').selectOption('proxy');
    await page.locator('#vv-mm-label').fill('使用中挂载');
    await page.locator('#vv-mm-endpoint').fill('http://127.0.0.1:9008');
    await page.locator('#vv-mm-bucket').fill('bkt');
    await page.locator('#vv-mm-username').fill('AK');
    await page.locator('#vv-mm-secret').fill('SK');
    await page.locator('.vv-mm-form').getByRole('button', { name: '保存' }).click();
    await expect(page.locator('.vv-mm-form')).toHaveCount(0);
    await expect(
      page.locator('.vv-mm-item', { hasText: '使用中挂载' }).locator('.vv-mm-state')
    ).toContainText('已注册 rootIndex=2');
    // 点组②（配置挂载）行的「打开」：组① 同名运行时行的「在树中打开」是另一入口，
    // 子串匹配会 strict violation——has .vv-mm-state 甄别组② + exact 锚定
    await page
      .locator('.vv-mm-item', { hasText: '使用中挂载' })
      .filter({ has: page.locator('.vv-mm-state') })
      .getByRole('button', { name: '打开', exact: true })
      .click();
    await page.keyboard.press('Escape');
    await expect(page.locator('.vv-mounts-manager')).toHaveCount(0);
    await clickTreeRow(page, 'notes.txt');
    await expect(page.locator('.vv-code-pre')).toContainText('still alive body');

    // ② 删除：服务端先撤（204 记录在 mock）、本地记录后删 → 行消失（暂无前端配置挂载）
    const dialogText = page
      .waitForEvent('dialog')
      .then((d) => {
        const t = d.message();
        void d.accept();
        return t;
      });
    await page.locator('button[aria-label="目录管理"]').click();
    await page.locator('.vv-mm-item', { hasText: '使用中挂载' }).getByRole('button', { name: '删除' }).click();
    expect(await dialogText).toContain('删除挂载「使用中挂载」');
    await expect(page.getByText('暂无前端配置挂载。')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.vv-mounts-manager')).toHaveCount(0);

    // ③ 运行中 tab 不中断：已载入内容留存；手动刷新树对已注销根 404 → 状态栏显式化
    await expect(page.locator('.vv-tab.active', { hasText: 'notes.txt' })).toBeVisible();
    await expect(page.locator('.vv-code-pre')).toContainText('still alive body');
    await page.locator('button[aria-label="刷新当前文件"]').click();
    await expect(page.locator('.vv-statusbar')).toContainText(/加载失败.*HTTP 404/, { timeout: 15_000 });
  });
});
