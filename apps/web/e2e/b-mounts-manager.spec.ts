import { test, expect, type Page, type Route } from '@playwright/test';
import { closeDrawerIfOpened, openDrawerIfNarrow } from './drawer';

/**
 * b-mounts-manager 目录管理页（目录挂载 spec §5 阶段四；plan Task 2 冒烟兜底 +
 * Task 3 深矩阵收口；b-filetree-src-remove.spec.ts 先例形态）：
 * - MM-01 双入口与骨架：📁/Ctrl+Alt+M 开合、三组渲染、Esc 关闭
 * - MM-02 新增表单：L1 endpoint userinfo 拒绝 → 修正保存 → 列表落库（刷新存活）
 *   → 删除联动；凭据警示双处可见（表单 + 列表详情，spec §6）
 * - MM-03 测试连接：route 拦截 S3 ListObjectsV2（免验签 mock）成功回显条目数与
 *   延迟；CORS 头缺失 → 特征化文案（Task 1 疑虑①场景族）
 * - MM-04 跨服务器作用域（M1）：他机注册记录徽标「注册于他机」+ 强制本地删除逃生口
 * - MM-05 组①已连接三组渲染（mock health/mounts API）→「在树中打开」运行时挂载根
 *   → 树渲染/文件浏览/挂载根 per-source watch 态（Task 3 Step 1 ①③）
 * - MM-06 direct 全链：表单→测试连接→保存→打开→直连树渲染→文件读；SigV4 头
 *   存在性断言（mock 不验签）；状态栏 per-source「此源不支持变更推送」且不显
 *   全局「自动刷新不可用」（Task 3 收口项 e2e 锚）②
 * - MM-07 mock dav 全链：WebDAV 表单（CORS 预检提示）→ PROPFIND 探测→保存→
 *   打开→树渲染→文件读；Basic 头存在性断言
 * - MM-08 直连恢复链：快照+记录在场 → 刷新重建目录/文件 tab；记录删除 → 刷新
 *   落占位（评审带入①降级链）
 * - MM-09 代理注册→重连幂等（restore 对账 POST）→删除失效帧（DELETE 404 幂等）
 *
 * mock 纪律（Task 2 报告坑注记）：S3 mock XML 符合 delimiter=/ 语义（次级 key/
 * 嵌套前缀会被直连 store 越层防御丢弃）；CORS 失败面用「从未成功过」的端点。
 */

/**
 * 最小 ListObjectsV2 响应（2 文件 + 1 目录 → 根目录 3 条目）。条目须符合
 * delimiter=/ 语义（prefix 为空时 Contents 只含顶层 key、子目录走 CommonPrefixes
 * 顶层前缀）——次级 key/嵌套前缀会被直连 store 的越层防御丢弃（directS3
 * listChildren 注）。
 */
const S3_LIST_XML = `<?xml version="1.0"?><ListBucketResult>
  <IsTruncated>false</IsTruncated>
  <Contents><Key>a.txt</Key><Size>3</Size></Contents>
  <Contents><Key>b.txt</Key><Size>1</Size></Contents>
  <CommonPrefixes><Prefix>sub/</Prefix></CommonPrefixes>
</ListBucketResult>`;

/**
 * FNV-1a hash8（core singleFile.ts 同算法镜像）：e2e 侧预置快照 storeId 需与
 * createRemoteStore/s3DirectStoreId 精确闭环（label/身份串参与 hash，不可反解
 * ——快照 storeId 必须按同公式算出）。
 */
function hash8(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** 跨源 mock API 的 CORS 响应头（页面 origin :4173 → API 各端口均为跨域 fetch）。 */
const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization,content-type,depth,x-amz-content-sha256,x-amz-date',
  'access-control-allow-methods': 'GET,POST,DELETE,PROPFIND,OPTIONS'
};

/** 预检 + JSON 伺服（health/mounts/ticket 等 Bearer API 通道）。 */
function jsonFulfill(route: Route, body: unknown, status = 200): void {
  void route.fulfill({ status, headers: { ...CORS_HEADERS, 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

/** 会话种子（addInitScript——每次导航前注入）：last-server（core
 * SESSION_LAST_SERVER_KEY='vviewer-last-server'）+ server-health 摘要
 * （serverHealthCache KEY='vv:server-health'，fsRoots 供挂载根判定）。 */
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

/** IndexedDB 直写装置（MM-04 先例形态）：v4 `mounts` store 预置记录。 */
async function seedMountRecord(page: Page, rec: Record<string, unknown>): Promise<void> {
  await page.evaluate(async (rec) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('vviewer', 4);
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

/** IndexedDB 直写 kv 'workspaces' 快照（restore 装置——seed 后 reload 走恢复链）。 */
async function seedSnapshot(page: Page, snap: Record<string, unknown>): Promise<void> {
  await page.evaluate(async (snap) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('vviewer', 4);
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

/** 树行可见断言的抽屉适配：桌面视口直读，mobile（≤900px）先开抽屉。 */
async function seeTreeRow(page: Page, text: string): Promise<void> {
  const drawer = await openDrawerIfNarrow(page);
  await expect(page.locator('.vv-tree-row', { hasText: text }).first()).toBeVisible();
  await closeDrawerIfOpened(page, drawer);
}

async function openManager(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('.vv-topbar')).toBeVisible();
  await page.locator('button[aria-label="目录管理"]').click();
  await expect(page.locator('.vv-mounts-manager')).toBeVisible();
}

/** CORS 预检 + 响应头齐备的 S3 mock（浏览器直连 fetch 会被预检与 CORS 双关卡）。
 * files：对象 key → 响应体（对象 GET 分发）；authLog：ListObjectsV2 请求的
 * authorization 头采集（SigV4 存在性断言——mock 不验签）。 */
async function mockS3(
  page: Page,
  origin: string,
  files: Record<string, string> = {},
  authLog?: string[]
): Promise<void> {
  await page.route(`**${origin}/**`, (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') {
      return void route.fulfill({ status: 200, headers: CORS_HEADERS, body: '' });
    }
    if (req.url().includes('list-type=2')) {
      authLog?.push(req.headers()['authorization'] ?? '');
      return void route.fulfill({
        status: 200,
        headers: { ...CORS_HEADERS, 'content-type': 'application/xml' },
        body: S3_LIST_XML
      });
    }
    const path = new URL(req.url()).pathname;
    for (const [key, body] of Object.entries(files)) {
      if (path.endsWith(`/${key}`)) {
        return void route.fulfill({ status: 200, headers: CORS_HEADERS, body });
      }
    }
    return void route.fulfill({ status: 200, headers: CORS_HEADERS, body: '' });
  });
}

/** mock WebDAV 伺服（PROPFIND 207 multistatus + 对象 GET；authLog 采集
 * authorization 头——Basic 存在性断言）。XML 含集合自身（isSelf 跳过）+
 * 1 文件 + 1 目录，命名空间前缀 D:。 */
async function mockDav(page: Page, origin: string, files: Record<string, string>, authLog?: string[]): Promise<void> {
  const MULTISTATUS = `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:">
    <D:response><D:href>/dav/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>
    <D:response><D:href>/dav/one.txt</D:href><D:propstat><D:prop><D:resourcetype/><D:getcontentlength>18</D:getcontentlength></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>
    <D:response><D:href>/dav/zdir/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>
  </D:multistatus>`;
  await page.route(`**${origin}/**`, (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') {
      return void route.fulfill({ status: 200, headers: CORS_HEADERS, body: '' });
    }
    if (req.method() === 'PROPFIND') {
      authLog?.push(req.headers()['authorization'] ?? '');
      return void route.fulfill({ status: 207, headers: CORS_HEADERS, body: MULTISTATUS });
    }
    const path = new URL(req.url()).pathname;
    for (const [key, body] of Object.entries(files)) {
      if (path.endsWith(`/${key}`)) {
        return void route.fulfill({ status: 200, headers: CORS_HEADERS, body });
      }
    }
    return void route.fulfill({ status: 404, headers: CORS_HEADERS, body: 'not found' });
  });
}

async function fillS3Form(
  page: Page,
  fields: { label: string; endpoint: string; bucket: string; ak: string; sk: string }
): Promise<void> {
  // 访问方式/类型使用表单缺省（直连 + S3）——未连接服务器时「访问方式」禁用
  // （代理不可选），不做 selectOption
  await page.locator('#vv-mm-label').fill(fields.label);
  await page.locator('#vv-mm-endpoint').fill(fields.endpoint);
  await page.locator('#vv-mm-bucket').fill(fields.bucket);
  await page.locator('#vv-mm-username').fill(fields.ak);
  await page.locator('#vv-mm-secret').fill(fields.sk);
}

test.describe('b-mounts-manager 目录管理页', () => {
  test('MM-01 双入口与骨架：📁/Ctrl+Alt+M 开合、三组渲染、Esc 关闭', async ({ page }) => {
    await openManager(page);
    const root = page.locator('.vv-mounts-manager');
    await expect(root).toHaveAttribute('aria-label', '目录管理');
    // 三组标题（role=heading——组②标题含「新增挂载」按钮文案，getByText 会与
    // 空态段落「暂无前端配置挂载」子串双命中）
    await expect(root.getByRole('heading', { name: '服务端根与挂载' })).toBeVisible();
    await expect(root.getByRole('heading', { name: /前端配置挂载/ })).toBeVisible();
    await expect(root.getByRole('heading', { name: /本机授权来源/ })).toBeVisible();
    // 未连接降级（组①）与空态（组②③）
    await expect(root.getByText(/未连接服务器/)).toBeVisible();
    await expect(root.getByText('暂无前端配置挂载。')).toBeVisible();
    // Esc 关闭（面板优先——无 zen 态时直接关面板）
    await page.keyboard.press('Escape');
    await expect(page.locator('.vv-mounts-manager')).toHaveCount(0);

    // 入口② Ctrl+Alt+M：开 → 再按经 requestClose 关（Toggle 语义）
    await page.keyboard.press('Control+Alt+KeyM');
    await expect(page.locator('.vv-mounts-manager')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.vv-mounts-manager')).toHaveCount(0);
  });

  test('MM-02 新增表单：L1 userinfo 拒绝 → 修正保存 → 刷新存活 → 删除联动；警示双处可见', async ({ page }) => {
    await openManager(page);
    await page.getByRole('button', { name: '＋ 新增挂载' }).click();
    const form = page.locator('.vv-mm-form');
    await expect(form).toBeVisible();

    // spec §6：凭据警示双处固定（列表详情 + 新增表单）
    await expect(page.getByText(/明文保存在浏览器 IndexedDB/)).toHaveCount(2);

    // L1：endpoint 带 userinfo → 保存被拦并提示（不落库）
    await fillS3Form(page, {
      label: '测试桶',
      endpoint: 'https://user:pass@s3.example.com',
      bucket: 'bkt',
      ak: 'AK',
      sk: 'SK'
    });
    await form.getByRole('button', { name: '保存' }).click();
    await expect(form.getByText('请使用不含凭据的 endpoint，凭据在下方字段填写')).toBeVisible();
    await expect(form).toBeVisible(); // 未保存：表单在场

    // 修正后保存 → 列表出现（直连徽标 + 凭据已存指示）
    await page.locator('#vv-mm-endpoint').fill('https://s3.example.com');
    await form.getByRole('button', { name: '保存' }).click();
    await expect(form).toHaveCount(0);
    const row = page.locator('.vv-mm-item', { hasText: '测试桶' });
    await expect(row).toBeVisible();
    await expect(row.getByText('直连')).toBeVisible();
    await expect(row.getByText('凭据已存')).toBeVisible();

    // IndexedDB 持久化：刷新后重开仍在
    await page.reload();
    await openManager(page);
    await expect(page.locator('.vv-mm-item', { hasText: '测试桶' })).toBeVisible();

    // 删除联动（confirm 接受 → 列表空）
    page.on('dialog', (d) => void d.accept());
    await page.locator('.vv-mm-item', { hasText: '测试桶' }).getByRole('button', { name: '删除' }).click();
    await expect(page.getByText('暂无前端配置挂载。')).toBeVisible();
  });

  test('MM-03 测试连接：S3 探测回显条目数与延迟；CORS 头缺失给特征化文案', async ({ page }) => {
    await openManager(page);
    await page.getByRole('button', { name: '＋ 新增挂载' }).click();
    await fillS3Form(page, {
      label: '直连桶',
      endpoint: 'http://127.0.0.1:9000',
      bucket: 'bkt',
      ak: 'AK',
      sk: 'SK'
    });

    // 成功路径：CORS 齐备 mock → 条目数 + 延迟回显（spec §5 list_dir 探测）
    await mockS3(page, 'http://127.0.0.1:9000');
    await page.getByRole('button', { name: '测试连接' }).click();
    await expect(page.locator('.vv-mm-form').getByText(/连接成功：根目录 3 个条目，延迟 \d+ ms/)).toBeVisible();

    // 失败路径：CORS 拦截特征（fetch TypeError）→ 特征化文案回显。用全新 origin
    // 的 route.abort——同 URL 复测会被缓存层回放首个成功响应（SW/HTTP cache，
    // CORS 失败面必须是「从未成功过」的端点，这也是真实场景形态）
    await page.locator('#vv-mm-endpoint').fill('http://127.0.0.1:9001');
    await page.route('**/127.0.0.1:9001/**', (route) => void route.abort());
    await page.getByRole('button', { name: '测试连接' }).click();
    await expect(
      page.locator('.vv-mm-form').getByText('连接失败：S3 直连失败：bucket CORS 未配置或网络不可达')
    ).toBeVisible();

    // 表单不保存关闭：未落库（mock 面不影响持久化）
    await page.getByRole('button', { name: '取消' }).click();
    await expect(page.locator('.vv-mm-form')).toHaveCount(0);
    await expect(page.getByText('暂无前端配置挂载。')).toBeVisible();
  });

  test('MM-04 跨服务器作用域（M1）：他机注册记录徽标「注册于他机」、无打开钮、删除走强制本地删除逃生口', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.vv-topbar')).toBeVisible();
    // 装置：直写 IndexedDB v4 mounts store 预置「他机注册」代理记录
    // （serverBase 指向另一台服务器；本会话未连接 → 恒 offsite）
    await page.evaluate(async () => {
      const rec = {
        id: 'mount:offsite-e2e',
        kind: 'proxy',
        backend: 'webdav',
        label: '他机挂载',
        endpoint: 'https://dav.other.example',
        prefix: '',
        username: 'u',
        secret: 'p',
        fingerprint: 'offsite-fp',
        serverBase: 'http://other-host:9999',
        createdAt: 1700000000000,
        registeredRootIndex: 7
      };
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open('vviewer', 4);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      await new Promise((resolve, reject) => {
        const tx = db.transaction('mounts', 'readwrite');
        tx.objectStore('mounts').put(rec, rec.id);
        tx.oncomplete = () => resolve(undefined);
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    });
    await page.locator('button[aria-label="目录管理"]').click();
    const row = page.locator('.vv-mm-item', { hasText: '他机挂载' });
    await expect(row).toBeVisible();

    // ② 徽标不误导：已注册 rootIndex=7 但注册在他机 → 「注册于他机」
    await expect(row.getByText('注册于他机')).toBeVisible();
    // ① 打开禁用：offsite 行不渲染打开钮（rootIndex 是他机命名空间）
    await expect(row.getByRole('button', { name: '打开' })).toHaveCount(0);

    // ③ 删除逃生口：确认文案声明强制本地删除（跳过服务端注销），接受后本地删除
    const dialogText = page
      .waitForEvent('dialog')
      .then((d) => {
        const t = d.message();
        void d.accept();
        return t;
      });
    await row.getByRole('button', { name: '删除' }).click();
    expect(await dialogText).toContain('强制本地删除');
    await expect(page.locator('.vv-mm-item', { hasText: '他机挂载' })).toHaveCount(0);
    await expect(page.getByText('暂无前端配置挂载。')).toBeVisible();
  });

  test('MM-05 组①已连接三组渲染→「在树中打开」运行时挂载根→树渲染与文件浏览', async ({ page }) => {
    test.setTimeout(60_000);
    const API = 'http://127.0.0.1:8791';
    await seedServerSession(page, API, 1);
    const staticMounts = [
      {
        rootIndex: 1,
        kind: 'webdav',
        label: 'static-dav',
        endpoint: 'https://nas.local/dav',
        prefix: '',
        capabilities: { watch: false, search: false }
      }
    ];
    const runtimeMounts = [
      {
        rootIndex: 2,
        kind: 's3',
        label: 'runtime-s3',
        endpoint: 'http://127.0.0.1:9000',
        bucket: 'bkt',
        prefix: 'mnt/',
        capabilities: { watch: false, search: false }
      }
    ];
    const manifest = {
      fsRoots: 1,
      staticMounts,
      runtimeMounts,
      mounts: [...staticMounts, ...runtimeMounts]
    };
    await page.route(`**${API}/**`, (route) => {
      const req = route.request();
      if (req.method() === 'OPTIONS') return void route.fulfill({ status: 200, headers: CORS_HEADERS, body: '' });
      const path = new URL(req.url()).pathname;
      if (path === '/api/health') {
        return jsonFulfill(route, { version: '1.0.0-e2e', capabilities: ['file-server'], fsRoots: 1, roots: 3, rootPaths: ['/data'] });
      }
      if (path === '/api/mounts') return jsonFulfill(route, manifest);
      if (path === '/api/ticket') return jsonFulfill(route, { ticket: 'e2e' });
      if (path === '/api/events') {
        return void route.fulfill({ status: 200, headers: { ...CORS_HEADERS, 'content-type': 'text/event-stream' }, body: '' });
      }
      if (path === '/api/tree') {
        // root=2（运行时挂载根）：1 文件 + 1 目录（root=0/1 空树即可）
        const root = new URL(req.url()).searchParams.get('root');
        return jsonFulfill(route, {
          entries:
            root === '2'
              ? [
                  { name: 'notes.txt', kind: 'file', size: 19 },
                  { name: 'sub', kind: 'dir' }
                ]
              : []
        });
      }
      if (path === '/api/file') {
        return void route.fulfill({ status: 200, headers: CORS_HEADERS, body: 'runtime notes body\n' });
      }
      return void route.fulfill({ status: 404, headers: CORS_HEADERS, body: '{}' });
    });

    await openManager(page);
    const root = page.locator('.vv-mounts-manager');
    // 组①三段行：fs 根（rootPaths 宣告名）+ 静态挂载 + 运行时挂载，徽标分段
    await expect(root.locator('.vv-mm-item', { hasText: '/data' }).getByText('fs 根')).toBeVisible();
    const staticRow = root.locator('.vv-mm-item', { hasText: 'static-dav' });
    await expect(staticRow.getByText('静态挂载')).toBeVisible();
    await expect(staticRow.getByText('无推送·无搜索')).toBeVisible();
    const runtimeRow = root.locator('.vv-mm-item', { hasText: 'runtime-s3' });
    await expect(runtimeRow.getByText('运行时')).toBeVisible();
    await expect(runtimeRow.getByText(/S3 · http:\/\/127\.0\.0\.1:9000 · bkt · mnt\//)).toBeVisible();

    // ③「在树中打开」挂载根 → 目录 tab + 左栏树渲染（label 覆写为清单显示名）
    await runtimeRow.getByRole('button', { name: '在树中打开' }).click();
    await page.keyboard.press('Escape');
    await expect(page.locator('.vv-mounts-manager')).toHaveCount(0);
    await expect(page.locator('.vv-tab.active', { hasText: 'runtime-s3' })).toBeVisible();
    await seeTreeRow(page, 'notes.txt');
    await seeTreeRow(page, 'sub');
    // 挂载根 per-source watch 态（能力位 watch=false 常量——非全局降级指示）
    await expect(page.locator('.vv-statusbar')).toContainText('此源不支持变更推送');

    // 挂载根文件浏览：树行点击 → /api/file 读 → code 视图
    const drawer = await openDrawerIfNarrow(page);
    await page.locator('.vv-tree-row', { hasText: 'notes.txt' }).click();
    await closeDrawerIfOpened(page, drawer);
    await expect(page.locator('.vv-tab.active', { hasText: 'notes.txt' })).toBeVisible();
    await expect(page.locator('.vv-code-pre')).toContainText('runtime notes body');
    await expect(page.locator('.vv-statusbar')).toContainText('此源不支持变更推送');
  });

  test('MM-06 direct 全链：测试连接→保存→打开→直连树渲染/文件读；SigV4 头存在+per-source watch 态', async ({ page }) => {
    test.setTimeout(60_000);
    const authLog: string[] = [];
    await mockS3(page, 'http://127.0.0.1:9003', { 'a.txt': 'const aDirect = 1;\n' }, authLog);

    await openManager(page);
    await page.getByRole('button', { name: '＋ 新增挂载' }).click();
    await fillS3Form(page, {
      label: 'e2e直连桶',
      endpoint: 'http://127.0.0.1:9003',
      bucket: 'bkt',
      ak: 'AKIDEXAMPLE',
      sk: 'wJalrXUtnFEMI'
    });
    // ②测试连接（mock 拦截）→ 成功回显
    await page.getByRole('button', { name: '测试连接' }).click();
    await expect(page.locator('.vv-mm-form').getByText(/连接成功：根目录 3 个条目，延迟 \d+ ms/)).toBeVisible();
    // SigV4 头存在性断言（mock 不验签——签名的可计算性由 core 单测 AWS 向量锚定）
    expect(authLog.length).toBeGreaterThan(0);
    expect(authLog.every((h) => h.startsWith('AWS4-HMAC-SHA256'))).toBe(true);

    // 保存 → 列表行 → 打开（直连目录 tab 通道）
    await page.locator('.vv-mm-form').getByRole('button', { name: '保存' }).click();
    await expect(page.locator('.vv-mm-form')).toHaveCount(0);
    const row = page.locator('.vv-mm-item', { hasText: 'e2e直连桶' });
    await expect(row.getByText('直连', { exact: true })).toBeVisible(); // exact：行名「e2e直连桶」含「直连」子串
    await row.getByRole('button', { name: '打开' }).click();
    await page.keyboard.press('Escape');
    await expect(page.locator('.vv-mounts-manager')).toHaveCount(0);

    // 直连树渲染：目录优先（sub）+ 自然序条目；active 目录 tab
    await expect(page.locator('.vv-tab.active', { hasText: 'e2e直连桶' })).toBeVisible();
    await seeTreeRow(page, 'sub');
    await seeTreeRow(page, 'a.txt');
    // per-source watch 态（Task 3 收口项）：非全局「自动刷新不可用」
    await expect(page.locator('.vv-statusbar')).toContainText('此源不支持变更推送');
    await expect(page.locator('.vv-statusbar')).not.toContainText('自动刷新不可用');

    // 直连文件读：树行点击 → SigV4 GET 对象 → code 视图渲染
    const drawer = await openDrawerIfNarrow(page);
    await page.locator('.vv-tree-row', { hasText: 'a.txt' }).click();
    await closeDrawerIfOpened(page, drawer);
    await expect(page.locator('.vv-tab.active', { hasText: 'a.txt' })).toBeVisible();
    await expect(page.locator('.vv-code-pre')).toContainText('const aDirect');
  });

  test('MM-07 mock dav 全链：CORS 预检提示→PROPFIND 探测→保存→打开→树渲染/文件读；Basic 头存在', async ({ page }) => {
    test.setTimeout(60_000);
    const authLog: string[] = [];
    await mockDav(page, 'http://127.0.0.1:9002', { 'one.txt': 'const davOne = 2;\n' }, authLog);

    await openManager(page);
    await page.getByRole('button', { name: '＋ 新增挂载' }).click();
    await page.locator('#vv-mm-backend').selectOption('webdav');
    // spec §4：WebDAV 直连 UI 预检明确提示服务器需配 CORS（大概率被拦，知情使用）
    await expect(page.locator('.vv-mm-form').getByText(/WebDAV 服务器需配置 CORS/)).toBeVisible();
    await page.locator('#vv-mm-label').fill('e2e dav');
    await page.locator('#vv-mm-endpoint').fill('http://127.0.0.1:9002/dav');
    await page.locator('#vv-mm-username').fill('davuser');
    await page.locator('#vv-mm-secret').fill('davpass');

    // PROPFIND 探测：207 multistatus（集合自身被 isSelf 跳过 → 2 条目）
    await page.getByRole('button', { name: '测试连接' }).click();
    await expect(page.locator('.vv-mm-form').getByText(/连接成功：根目录 2 个条目，延迟 \d+ ms/)).toBeVisible();
    expect(authLog.length).toBeGreaterThan(0);
    expect(authLog.every((h) => h === `Basic ${Buffer.from('davuser:davpass').toString('base64')}`)).toBe(true);

    // 保存 → WebDAV 直连行 → 打开 → 树渲染 + 文件读
    await page.locator('.vv-mm-form').getByRole('button', { name: '保存' }).click();
    await expect(page.locator('.vv-mm-form')).toHaveCount(0);
    const row = page.locator('.vv-mm-item', { hasText: 'e2e dav' });
    await expect(row.getByText('直连')).toBeVisible();
    await expect(row.getByText('WebDAV')).toBeVisible();
    await row.getByRole('button', { name: '打开' }).click();
    await page.keyboard.press('Escape');
    await expect(page.locator('.vv-mounts-manager')).toHaveCount(0);

    await expect(page.locator('.vv-tab.active', { hasText: 'e2e dav' })).toBeVisible();
    await seeTreeRow(page, 'zdir');
    await seeTreeRow(page, 'one.txt');
    const drawer = await openDrawerIfNarrow(page);
    await page.locator('.vv-tree-row', { hasText: 'one.txt' }).click();
    await closeDrawerIfOpened(page, drawer);
    await expect(page.locator('.vv-code-pre')).toContainText('const davOne');
    await expect(page.locator('.vv-statusbar')).toContainText('此源不支持变更推送');
  });

  test('MM-08 直连恢复链：快照+记录在场重建目录/文件 tab；记录删除 → 刷新落占位', async ({ page }) => {
    test.setTimeout(60_000);
    // 直连 storeId = 记录 id（core s3DirectStoreId 闭环——身份串不含凭据与 label）
    const recId = `s3direct:${hash8(['s3', 'http://127.0.0.1:9004', 'bkt', '', 'path'].join('\u{1f}'))}`;
    const rec = {
      id: recId,
      kind: 'direct',
      backend: 's3',
      label: 'e2e直连桶',
      endpoint: 'http://127.0.0.1:9004',
      bucket: 'bkt',
      prefix: '',
      username: 'AK',
      secret: 'SK',
      createdAt: 1700000000000
    };
    await mockS3(page, 'http://127.0.0.1:9004', { 'a.txt': 'restored direct body\n' });
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
          sources: [{ kind: 'direct', storeId: recId, storeLabel: 'e2e直连桶' }],
          tabs: [
            { id: 't1', storeId: recId, storeLabel: 'e2e直连桶', path: '', name: 'e2e直连桶', kind: 'rename-only', scrollTop: 0, active: false },
            { id: 't2', storeId: recId, storeLabel: 'e2e直连桶', path: 'a.txt', name: 'a.txt', kind: 'rename-only', scrollTop: 0, active: true }
          ],
          activeTabId: 't2'
        }
      ]
    });

    // 刷新 → restore 按 storeId 查记录重建（registerStore + 目录/文件 tab 恢复）
    await page.reload();
    await expect(page.locator('.vv-tab.active', { hasText: 'a.txt' })).toBeVisible();
    await expect(page.locator('.vv-code-pre')).toContainText('restored direct body');
    await seeTreeRow(page, 'a.txt');
    // 恢复的直连 tab 同走 per-source watch 态
    await expect(page.locator('.vv-statusbar')).toContainText('此源不支持变更推送');

    // 记录删除（用户删了挂载）→ 刷新：来源不重建，文件 tab 落占位（既有降级链）
    await page.evaluate(async (id) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open('vviewer', 4);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      await new Promise((resolve, reject) => {
        const tx = db.transaction('mounts', 'readwrite');
        tx.objectStore('mounts').delete(id);
        tx.oncomplete = () => resolve(undefined);
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    }, recId);
    await page.reload();
    await expect(page.locator('.vv-error-card')).toBeVisible();
    await expect(page.locator('.vv-error-card')).toContainText('需要重新打开');
  });

  test('MM-09 代理注册→重连幂等（restore 对账 POST）→删除失效帧（DELETE 404 幂等）', async ({ page }) => {
    test.setTimeout(60_000);
    const API = 'http://127.0.0.1:8792';
    await seedServerSession(page, API, null);
    const postBodies: string[] = [];
    let deleteSeen = '';
    const manifest = { fsRoots: 1, staticMounts: [], runtimeMounts: [], mounts: [] as unknown[] };
    await page.route(`**${API}/**`, (route) => {
      const req = route.request();
      if (req.method() === 'OPTIONS') return void route.fulfill({ status: 200, headers: CORS_HEADERS, body: '' });
      const path = new URL(req.url()).pathname;
      if (path === '/api/health') return jsonFulfill(route, { version: '1.0.0-e2e', capabilities: ['file-server'] });
      if (path === '/api/mounts' && req.method() === 'GET') return jsonFulfill(route, manifest);
      if (path === '/api/mounts' && req.method() === 'POST') {
        postBodies.push(req.postData() ?? '');
        return jsonFulfill(route, { rootIndex: 2 });
      }
      if (path.startsWith('/api/mounts/') && req.method() === 'DELETE') {
        deleteSeen = path;
        return void route.fulfill({ status: 404, headers: CORS_HEADERS, body: '{"error":"gone"}' }); // 服务端失效帧（重启清空）
      }
      if (path === '/api/ticket') return jsonFulfill(route, { ticket: 'e2e' });
      if (path === '/api/events') {
        return void route.fulfill({ status: 200, headers: { ...CORS_HEADERS, 'content-type': 'text/event-stream' }, body: '' });
      }
      if (path === '/api/tree') return jsonFulfill(route, { entries: [] });
      return void route.fulfill({ status: 404, headers: CORS_HEADERS, body: '{}' });
    });

    // ① 表单注册：保存即 POST /api/mounts（成功才落 IndexedDB，spec §5 一致态）
    await openManager(page);
    await page.getByRole('button', { name: '＋ 新增挂载' }).click();
    await page.locator('#vv-mm-mode').selectOption('proxy'); // 已连接服务器：代理可选
    await page.locator('#vv-mm-label').fill('proxy-e2e');
    await page.locator('#vv-mm-endpoint').fill('http://127.0.0.1:9005');
    await page.locator('#vv-mm-bucket').fill('bkt');
    await page.locator('#vv-mm-username').fill('AK');
    await page.locator('#vv-mm-secret').fill('SK');
    await page.locator('.vv-mm-form').getByRole('button', { name: '保存' }).click();
    await expect(page.locator('.vv-mm-form')).toHaveCount(0);
    expect(postBodies).toHaveLength(1);
    expect(JSON.parse(postBodies[0]!)).toMatchObject({ kind: 's3', label: 'proxy-e2e', bucket: 'bkt' });
    const row = page.locator('.vv-mm-item', { hasText: 'proxy-e2e' });
    await expect(row.getByText('已注册 rootIndex=2')).toBeVisible();

    // ② 重连幂等：预置含同 base remote 来源的快照 → 刷新走 restore 重连对账——
    // 清单无同指纹运行时项 → 幂等 POST 重注册（记录状态保持已注册）
    const remoteStoreId = `remote:${hash8(`${API}:srv`)}`;
    await seedSnapshot(page, {
      activeId: 'w1',
      workspaces: [
        {
          id: 'w1',
          name: '默认',
          createdAt: 1700000000000,
          sources: [{ kind: 'remote', storeId: remoteStoreId, storeLabel: 'srv', storeBase: API }],
          tabs: [],
          activeTabId: null
        }
      ]
    });
    await page.reload();
    await expect(page.locator('.vv-topbar')).toBeVisible();
    await expect.poll(() => postBodies.length, { timeout: 10_000 }).toBe(2); // 对账幂等 POST
    await page.locator('button[aria-label="目录管理"]').click();
    await expect(page.locator('.vv-mm-item', { hasText: 'proxy-e2e' }).getByText('已注册 rootIndex=2')).toBeVisible();

    // ③ 删除失效帧：服务端注册已消失（404）→ 幂等视为成功，本地记录照常删除
    page.on('dialog', (d) => void d.accept());
    await page.locator('.vv-mm-item', { hasText: 'proxy-e2e' }).getByRole('button', { name: '删除' }).click();
    await expect(page.getByText('暂无前端配置挂载。')).toBeVisible();
    expect(deleteSeen).toBe('/api/mounts/2');
  });
});
