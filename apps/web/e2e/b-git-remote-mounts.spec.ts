import { test, expect, type Page } from '@playwright/test';
import { closeDrawerIfOpened, openDrawerIfNarrow } from './drawer';
import { openMenu } from './tabbar-menu';

/**
 * b-git-remote-mounts Git 直连挂载（spec I §5；plan Task 4，Errata ⑥）：
 * - GIT-01 GitHub 全链：挂载→测试连接（匿名——无 authorization 头）→保存→打开→
 *   浏览→读文件；raw URL ref 槽 = 解析后 commit sha（Review Focus 4 快照一致性）
 * - GIT-02 凭据库命中与轮换即生效（spec §7-2 运行时面）：组④添加凭据→表单 token
 *   留空探测带 Bearer T1→保存→打开（credentialKey 查库 T1）→组④重提同键覆盖 T2
 *   （评审 ③：无独立编辑钮）→编辑保存触发 releaseDirectMountStore→行打开重建
 *   （查库 T2——实查 5 凭据轮换释放链）
 * - GIT-03 限速与认证特征化（spec §5）：403+x-ratelimit-remaining:0 → 限速文案；
 *   401 → 认证提示（断言走表单回显区 .vv-mm-probe role=status）
 * - GIT-04 GitLab 全链：Link rel=next 顺序两页拉 + PRIVATE-TOKEN 头 + 读文件；
 *   自建域 CORS 失败 → TypeError 特征化文案（不提示代理通道）
 * - GIT-05 快照恢复链：githubdirect 记录 id = storeId（hash8 镜像闭环）+ gitcred
 *   条目 → reload 重建目录/文件 tab 且请求带凭据库 token（恢复链查库——Errata ③
   recordCache 同步镜像时序）；记录删除 → 落占位（MM-08 降级链形态）
 *
 * mock 纪律（Errata ⑥）：git mock = page.route 拦截 GitHub/GitLab 真实域名形态——
 * GitHub 域名固定无法指 fake host（node:http fixture 不可达），route 先于网络零出
 * 网、不烧限速；未命中兜底 404（台账 3-3 防静默假绿）。CORS 响应头含
 * Access-Control-Expose-Headers: link/x-ratelimit-remaining（ensureGitOk 限速判定
 * 与 parseLinkNext 分页解析读响应头——非 Expose 头在 CORS 下读到 null）。
 */

/**
 * FNV-1a hash8（core singleFile.ts 同算法镜像；b-mounts-manager :54 先例）：
 * e2e 侧预置快照 storeId 需与 githubDirectStoreId 精确闭环。
 */
function hash8(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** 跨源 mock 的 CORS 响应头（含 Expose——限速判定与 Link 分页读响应头的前提）。 */
const GIT_CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization,content-type,private-token',
  'access-control-allow-methods': 'GET,OPTIONS',
  'access-control-expose-headers': 'link,x-ratelimit-limit,x-ratelimit-remaining'
};

/** GitHub 固定身份（单测 fixture 同名 octo/repo；40 位 commit sha——sha8 断言用）。 */
const GH_COMMIT = '1234567890abcdef1234567890abcdef12345678';
const GH_SHA8 = GH_COMMIT.slice(0, 8);
const GL_COMMIT = 'eeeeeeeeffffffffeeeeeeeeffffffffeeeeeeee';
const GL_SHA8 = GL_COMMIT.slice(0, 8);
const GL_PID = 42;

interface GitTreeItem {
  path: string;
  type: string;
  size?: number;
  sha?: string;
}

interface GithubMockOpts {
  /** recursive trees 响应条目。 */
  tree?: GitTreeItem[];
  /** recursive 响应 truncated 标记（store 打开路径走 BFS——本批用例不触；probe 不 BFS）。 */
  truncated?: boolean;
  /** raw 对象分发：repo 相对 path → 实体。 */
  files?: Record<string, string>;
  /** commits 端点状态码（401/403 变体）；缺省 200 返回 GH_COMMIT。 */
  commitsStatus?: number;
  /** commits 端点附加响应头（403 限速形态 x-ratelimit-remaining:0）。 */
  commitsHeaders?: Record<string, string>;
  /** api.github.com 请求 authorization 头采集（commits/trees——探测/清单通道）。 */
  authLog?: string[];
  /** raw.githubusercontent.com 请求 authorization 头采集（read 通道）。 */
  rawAuthLog?: string[];
  /** raw 请求 URL 采集（ref 槽 = 解析 sha 断言，Review Focus 4）。 */
  rawUrlLog?: string[];
}

/**
 * GitHub mock（route 拦截 api.github.com + raw.githubusercontent.com 真实域名）：
 * commits/{ref} → {sha}；git/trees/{sha}?recursive=1 → {tree, truncated}；
 * raw path 逐段解码分发 files；未命中兜底 404（台账 3-3）。
 */
async function mockGithub(page: Page, opts: GithubMockOpts = {}): Promise<void> {
  const tree = opts.tree ?? [];
  await page.route('**api.github.com/**', (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') {
      return void route.fulfill({ status: 200, headers: GIT_CORS_HEADERS, body: '' });
    }
    const url = req.url();
    if (/\/repos\/[^/]+\/repo\/commits\/[^/]+$/.test(url)) {
      opts.authLog?.push(req.headers()['authorization'] ?? '');
      if (opts.commitsStatus !== undefined && opts.commitsStatus !== 200) {
        return void route.fulfill({
          status: opts.commitsStatus,
          headers: { ...GIT_CORS_HEADERS, ...(opts.commitsHeaders ?? {}) },
          body: JSON.stringify({ message: 'err' })
        });
      }
      return void route.fulfill({
        status: 200,
        headers: GIT_CORS_HEADERS,
        body: JSON.stringify({ sha: GH_COMMIT })
      });
    }
    const treeMatch = /\/repos\/[^/]+\/repo\/git\/trees\/([0-9a-f]+)(\?|$)/.exec(url);
    if (treeMatch !== null) {
      opts.authLog?.push(req.headers()['authorization'] ?? '');
      if (url.includes('recursive=1')) {
        return void route.fulfill({
          status: 200,
          headers: GIT_CORS_HEADERS,
          body: JSON.stringify({ sha: GH_COMMIT, truncated: opts.truncated === true, tree })
        });
      }
      return void route.fulfill({
        status: 200,
        headers: GIT_CORS_HEADERS,
        body: JSON.stringify({ sha: treeMatch[1], truncated: false, tree: [] })
      });
    }
    return void route.fulfill({ status: 404, headers: GIT_CORS_HEADERS, body: '{"message":"not found"}' });
  });
  await page.route('**raw.githubusercontent.com/**', (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') {
      return void route.fulfill({ status: 200, headers: GIT_CORS_HEADERS, body: '' });
    }
    opts.rawUrlLog?.push(req.url());
    opts.rawAuthLog?.push(req.headers()['authorization'] ?? '');
    // /octo/repo/{sha}/{path...} → repo 相对 path（逐段已由浏览器编码——decode 还原）
    const segs = new URL(req.url()).pathname.split('/').filter((s) => s !== '');
    const rel = segs.slice(3).join('/');
    const body = opts.files?.[rel];
    if (body !== undefined) {
      return void route.fulfill({ status: 200, headers: GIT_CORS_HEADERS, body });
    }
    return void route.fulfill({ status: 404, headers: GIT_CORS_HEADERS, body: 'not found' });
  });
}

interface GitlabMockOpts {
  /** tree 首页条目（Link rel=next 指 page=2）。 */
  treePage1?: Array<{ id: string; name: string; type: string; path: string }>;
  /** tree 第二页条目。 */
  treePage2?: Array<{ id: string; name: string; type: string; path: string }>;
  /** raw 对象分发：repo 相对 path → 实体。 */
  files?: Record<string, string>;
  /** PRIVATE-TOKEN 头采集（projects/commits/tree/raw 全通道）。 */
  authLog?: string[];
  /** tree/raw 请求 URL 采集（顺序两页断言）。 */
  urlLog?: string[];
}

/**
 * GitLab mock（route 拦截自建域真实形态）：/projects/{enc} → {id}；
 * /repository/commits/{ref} → {id}；/repository/tree 首页 + Link next → page=2；
 * /repository/files/{enc}/raw 分发 files；未命中兜底 404。
 */
async function mockGitlab(page: Page, host: string, opts: GitlabMockOpts = {}): Promise<void> {
  const page1 = opts.treePage1 ?? [];
  const page2 = opts.treePage2 ?? [];
  const treeUrl1 = `${host}/api/v4/projects/${GL_PID}/repository/tree?ref=main&recursive=true&per_page=100`;
  const treeUrl2 = `${treeUrl1}&page=2`;
  await page.route(`**${host}/**`, (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') {
      return void route.fulfill({ status: 200, headers: GIT_CORS_HEADERS, body: '' });
    }
    const url = req.url();
    const path = new URL(url).pathname;
    if (path === `/api/v4/projects/${encodeURIComponent('grp/rp')}`) {
      opts.authLog?.push(req.headers()['private-token'] ?? '');
      return void route.fulfill({
        status: 200,
        headers: GIT_CORS_HEADERS,
        body: JSON.stringify({ id: GL_PID })
      });
    }
    if (path === `/api/v4/projects/${GL_PID}/repository/commits/main`) {
      opts.authLog?.push(req.headers()['private-token'] ?? '');
      return void route.fulfill({
        status: 200,
        headers: GIT_CORS_HEADERS,
        body: JSON.stringify({ id: GL_COMMIT })
      });
    }
    if (path === `/api/v4/projects/${GL_PID}/repository/tree`) {
      opts.authLog?.push(req.headers()['private-token'] ?? '');
      opts.urlLog?.push(url);
      if (url === treeUrl1) {
        return void route.fulfill({
          status: 200,
          headers: { ...GIT_CORS_HEADERS, link: `<${treeUrl2}>; rel="next"` },
          body: JSON.stringify(page1)
        });
      }
      if (url === treeUrl2) {
        return void route.fulfill({ status: 200, headers: GIT_CORS_HEADERS, body: JSON.stringify(page2) });
      }
      return void route.fulfill({ status: 404, headers: GIT_CORS_HEADERS, body: '[]' });
    }
    const rawMatch = /\/api\/v4\/projects\/42\/repository\/files\/([^/]+)\/raw$/.exec(path);
    if (rawMatch !== null) {
      opts.authLog?.push(req.headers()['private-token'] ?? '');
      opts.urlLog?.push(url);
      const rel = decodeURIComponent(rawMatch[1]!);
      const body = opts.files?.[rel];
      if (body !== undefined) {
        return void route.fulfill({ status: 200, headers: GIT_CORS_HEADERS, body });
      }
    }
    return void route.fulfill({ status: 404, headers: GIT_CORS_HEADERS, body: '{}' });
  });
}

/** ⋯ 菜单通道打开目录管理页（b-mounts-manager :154 同款——本文件独立副本防跨文件耦合）。 */
async function openMountsPanel(page: Page): Promise<void> {
  await openMenu(page);
  await page.locator('button[aria-label="目录管理"]').click();
  await expect(page.locator('.vv-mounts-manager')).toBeVisible();
}

/** GitHub 表单 fill（#vv-mm-* 镜像 fillS3Form :228-240 形态——backend select 先选 github）。 */
async function fillGithubForm(
  page: Page,
  f: { label: string; owner: string; repo: string; ref: string; token?: string }
): Promise<void> {
  await page.locator('#vv-mm-backend').selectOption('github');
  await page.locator('#vv-mm-label').fill(f.label);
  await page.locator('#vv-mm-owner').fill(f.owner);
  await page.locator('#vv-mm-repo').fill(f.repo);
  await page.locator('#vv-mm-ref').fill(f.ref);
  if (f.token !== undefined) await page.locator('#vv-mm-secret').fill(f.token);
}

/** GitLab 表单 fill（host 复用 #vv-mm-endpoint 字段）。 */
async function fillGitlabForm(
  page: Page,
  f: { label: string; host: string; project: string; ref: string; token?: string }
): Promise<void> {
  await page.locator('#vv-mm-backend').selectOption('gitlab');
  await page.locator('#vv-mm-label').fill(f.label);
  await page.locator('#vv-mm-endpoint').fill(f.host);
  await page.locator('#vv-mm-repo').fill(f.project);
  await page.locator('#vv-mm-ref').fill(f.ref);
  if (f.token !== undefined) await page.locator('#vv-mm-secret').fill(f.token);
}

/** IndexedDB 直写 `mounts` store（b-mounts-manager seedMountRecord :98 同款——五 store 幂等补建）。 */
async function seedMountRecord(page: Page, rec: Record<string, unknown>): Promise<void> {
  await page.evaluate(async (rec) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('vviewer');
      req.onupgradeneeded = () => {
        const d = req.result;
        for (const s of ['kv', 'themes', 'fonts', 'mounts', 'iconThemes']) {
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

/** IndexedDB 直写 kv 'workspaces' 快照（b-mounts-manager seedSnapshot :122 同款）。 */
async function seedSnapshot(page: Page, snap: Record<string, unknown>): Promise<void> {
  await page.evaluate(async (snap) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('vviewer');
      req.onupgradeneeded = () => {
        const d = req.result;
        for (const s of ['kv', 'themes', 'fonts', 'mounts', 'iconThemes']) {
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

/** 树行可见断言的抽屉适配（b-mounts-manager seeTreeRow :146 同款）。 */
async function seeTreeRow(page: Page, text: string): Promise<void> {
  const drawer = await openDrawerIfNarrow(page);
  await expect(page.locator('.vv-tree-row', { hasText: text }).first()).toBeVisible();
  await closeDrawerIfOpened(page, drawer);
}

/** GitHub 标准 recursive 清单（2 blob + 1 tree + 1 子 blob——probe 计数 2 blob）。 */
/** 根级文件用 .txt（code 渲染容器 .vv-code-pre——.md 走 markdown 渲染器非本批断言面）。 */
const GH_TREE: GitTreeItem[] = [
  { path: 'a.txt', type: 'blob', size: 18, sha: 'b1' },
  { path: 'docs', type: 'tree', sha: 't1' },
  { path: 'docs/guide.md', type: 'blob', size: 8, sha: 'b2' }
];

test.describe('b-git-remote-mounts Git 直连挂载', () => {
  test('GIT-01 GitHub 全链：挂载→测试连接（匿名）→保存→打开→浏览→读文件（raw ref 槽=解析 sha）', async ({ page }) => {
    test.setTimeout(60_000);
    const authLog: string[] = [];
    const rawAuthLog: string[] = [];
    const rawUrlLog: string[] = [];
    await mockGithub(page, { tree: GH_TREE, files: { 'a.txt': 'git direct body\n' }, authLog, rawAuthLog, rawUrlLog });

    await page.goto('/');
    await expect(page.locator('.vv-tabbar')).toBeVisible();
    await openMountsPanel(page);
    await page.getByRole('button', { name: '＋ 新增挂载' }).click();
    await fillGithubForm(page, { label: 'e2e github', owner: 'octo', repo: 'repo', ref: 'main' });

    // 测试连接（匿名——无 authorization 头）→ 文件数 + ref sha 回显
    await page.getByRole('button', { name: '测试连接' }).click();
    await expect(
      page.locator('.vv-mm-form').getByText(new RegExp(`连接成功：2 个文件，ref ${GH_SHA8}，延迟 \\d+ ms`))
    ).toBeVisible();
    expect(authLog.length).toBeGreaterThan(0); // commits + trees 探测通道
    expect(authLog.every((h) => h === '')).toBe(true); // 匿名：无 token 头（spec §7-3 匿名限速知情）

    // 保存 → 行徽标 GitHub → 打开
    await page.locator('.vv-mm-form').getByRole('button', { name: '保存' }).click();
    await expect(page.locator('.vv-mm-form')).toHaveCount(0);
    const row = page.locator('.vv-mm-item', { hasText: 'e2e github' });
    await expect(row.getByText('GitHub', { exact: true })).toBeVisible(); // exact：行名/endpoint 含 github 子串（MM-06 直连 exact 同款）
    await row.getByRole('button', { name: '打开' }).click();
    await page.keyboard.press('Escape');
    await expect(page.locator('.vv-mounts-manager')).toHaveCount(0);

    // 树渲染（目录优先）+ per-source watch 态 + 文件读
    await expect(page.locator('.vv-tab.active', { hasText: 'e2e github' })).toBeVisible();
    await seeTreeRow(page, 'docs');
    await seeTreeRow(page, 'a.txt');
    await expect(page.locator('.vv-statusbar')).toContainText('此源不支持变更推送');
    await expect(page.locator('.vv-statusbar')).not.toContainText('自动刷新不可用');
    const drawer = await openDrawerIfNarrow(page);
    await page.locator('.vv-tree-row', { hasText: 'a.txt' }).click();
    await closeDrawerIfOpened(page, drawer);
    await expect(page.locator('.vv-tab.active', { hasText: 'a.txt' })).toBeVisible();
    await expect(page.locator('.vv-code-pre')).toContainText('git direct body');
    // raw ref 槽 = 解析后 commit sha（Review Focus 4——branch 移动后清单/内容同代际）
    expect(rawUrlLog.some((u) => u.includes(`/${GH_COMMIT}/a.txt`))).toBe(true);
    expect(rawUrlLog.every((u) => !u.includes('/main/'))).toBe(true); // 非 ref 文本
    expect(rawAuthLog.every((h) => h === '')).toBe(true); // 匿名 read 无头
  });

  test('GIT-02 凭据库命中与重提覆盖轮换：探测带 Bearer T1→打开查库 T1→组④重提 T2→编辑保存释放→重开查库 T2', async ({ page }) => {
    test.setTimeout(90_000);
    const authLog: string[] = [];
    const rawAuthLog: string[] = [];
    await mockGithub(page, {
      tree: [...GH_TREE, { path: 'notes.txt', type: 'blob', size: 19, sha: 'b3' }],
      files: { 'notes.txt': 'cred rotation body\n' },
      authLog,
      rawAuthLog
    });

    await page.goto('/');
    await expect(page.locator('.vv-tabbar')).toBeVisible();
    await openMountsPanel(page);

    // ① 组④添加凭据 github.com/alice T1
    await page.getByRole('button', { name: '＋ 添加凭据' }).click();
    await page.locator('#vv-mm-cred-host').fill('github.com');
    await page.locator('#vv-mm-cred-owner').fill('alice');
    await page.locator('#vv-mm-cred-token').fill('T1');
    await page.locator('.vv-mm-form').getByRole('button', { name: '保存凭据' }).click();
    await expect(page.locator('.vv-mm-item', { hasText: 'github.com:alice' })).toBeVisible();

    // ② mount 表单 token 留空 + owner=alice → 测试连接带 Bearer T1（credentialKey 查库——精确 owner 匹配）
    await page.getByRole('button', { name: '＋ 新增挂载' }).click();
    await fillGithubForm(page, { label: 'cred mount', owner: 'alice', repo: 'repo', ref: 'main' });
    await page.getByRole('button', { name: '测试连接' }).click();
    await expect(page.locator('.vv-mm-form').getByText(/连接成功：3 个文件/)).toBeVisible(); // GH_TREE 3 blob + notes.txt
    expect(authLog.length).toBeGreaterThan(0);
    expect(authLog.every((h) => h === 'Bearer T1')).toBe(true);

    // ③ 保存 → 行「凭据已存」（credentialKey 形态）→ 打开 → read raw 带 Bearer T1
    await page.locator('.vv-mm-form').getByRole('button', { name: '保存' }).click();
    await expect(page.locator('.vv-mm-form')).toHaveCount(0);
    const row = page.locator('.vv-mm-item', { hasText: 'cred mount' });
    await expect(row.getByText('凭据已存')).toBeVisible();
    await row.getByRole('button', { name: '打开' }).click();
    await page.keyboard.press('Escape');
    await expect(page.locator('.vv-mounts-manager')).toHaveCount(0);
    const drawer = await openDrawerIfNarrow(page);
    await page.locator('.vv-tree-row', { hasText: 'notes.txt' }).click();
    await closeDrawerIfOpened(page, drawer);
    await expect(page.locator('.vv-code-pre')).toContainText('cred rotation body');
    expect(rawAuthLog).toEqual(['Bearer T1']); // 打开链查库 T1

    // ④ 轮换 = 组④重提同键覆盖（评审 ③：put(rec, rec.id) 键覆盖即更新，无独立编辑钮）
    await openMountsPanel(page);
    await page.getByRole('button', { name: '＋ 添加凭据' }).click();
    await page.locator('#vv-mm-cred-host').fill('github.com');
    await page.locator('#vv-mm-cred-owner').fill('alice');
    await page.locator('#vv-mm-cred-token').fill('T2');
    await page.locator('.vv-mm-form').getByRole('button', { name: '保存凭据' }).click();
    await expect(page.locator('.vv-mm-item', { hasText: 'github.com:alice' })).toHaveCount(1); // 同键覆盖不增行

    // ⑤ 编辑保存 → releaseDirectMountStore（关闭持有 tab——实查 5 凭据轮换释放链）
    // → 行打开重建实例 → credentialKey 查库 T2 → read raw 带 Bearer T2
    await page.locator('.vv-mm-item', { hasText: 'cred mount' }).getByRole('button', { name: '编辑' }).click();
    await page.locator('.vv-mm-form').getByRole('button', { name: '保存' }).click();
    await expect(page.locator('.vv-mm-form')).toHaveCount(0);
    await expect(page.locator('.vv-statusbar')).toContainText('已关闭 2 个标签页（挂载已释放）'); // 目录+文件 tab
    await page.locator('.vv-mm-item', { hasText: 'cred mount' }).getByRole('button', { name: '打开' }).click();
    await page.keyboard.press('Escape');
    await expect(page.locator('.vv-mounts-manager')).toHaveCount(0);
    const drawer2 = await openDrawerIfNarrow(page);
    await page.locator('.vv-tree-row', { hasText: 'notes.txt' }).click();
    await closeDrawerIfOpened(page, drawer2);
    await expect(page.locator('.vv-code-pre')).toContainText('cred rotation body');
    expect(rawAuthLog).toContain('Bearer T1'); // 轮换前
    expect(rawAuthLog[rawAuthLog.length - 1]).toBe('Bearer T2'); // 重开查库 T2
  });

  test('GIT-03 限速与认证特征化：403+x-ratelimit-remaining:0 → 限速文案；401 → 认证提示', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.vv-tabbar')).toBeVisible();
    await openMountsPanel(page);
    await page.getByRole('button', { name: '＋ 新增挂载' }).click();
    await fillGithubForm(page, { label: 'rate lim', owner: 'octo', repo: 'repo', ref: 'main' });

    // 403 + x-ratelimit-remaining:0（匿名限速形态）→ 限速特征化（限速优先于 403 兜底面）
    await mockGithub(page, { commitsStatus: 403, commitsHeaders: { 'x-ratelimit-remaining': '0' } });
    await page.getByRole('button', { name: '测试连接' }).click();
    await expect(page.locator('.vv-mm-probe')).toContainText('连接失败：GitHub API 限速：额度已用尽');

    // 401 → 认证提示（换 ref 防同端点复测的缓存形态——MM-03 坑注记同源）
    await page.locator('#vv-mm-ref').fill('dev');
    await mockGithub(page, { commitsStatus: 401 });
    await page.getByRole('button', { name: '测试连接' }).click();
    await expect(page.locator('.vv-mm-probe')).toContainText('连接失败：GitHub 请求失败: HTTP 401（认证失败');
    // 取消关闭：不落库
    await page.getByRole('button', { name: '取消' }).click();
    await expect(page.locator('.vv-mm-form')).toHaveCount(0);
    await expect(page.getByText('暂无前端配置挂载。')).toBeVisible();
  });

  test('GIT-04 GitLab 全链：Link 两页顺序拉 + PRIVATE-TOKEN 头 + 读文件', async ({ page }) => {
    test.setTimeout(90_000);
    const authLog: string[] = [];
    const urlLog: string[] = [];
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      id: `g1_${i}`,
      name: `f1_${i}.txt`,
      type: 'blob',
      path: `f1_${i}.txt`
    }));
    const page2: Array<{ id: string; name: string; type: string; path: string }> = [
      { id: 'g2_notes', name: 'notes.txt', type: 'blob', path: 'notes.txt' },
      { id: 'g2_docs', name: 'docs', type: 'tree', path: 'docs' }
    ];
    await mockGitlab(page, 'https://gitlab.test', {
      treePage1: page1,
      treePage2: page2,
      files: { 'notes.txt': 'gitlab body\n' },
      authLog,
      urlLog
    });

    await page.goto('/');
    await expect(page.locator('.vv-tabbar')).toBeVisible();
    await openMountsPanel(page);
    await page.getByRole('button', { name: '＋ 新增挂载' }).click();
    await fillGitlabForm(page, {
      label: 'e2e gitlab',
      host: 'https://gitlab.test',
      project: 'grp/rp',
      ref: 'main',
      token: 'GLT'
    });

    // 测试连接（首页采样 100 条——per_page=100 不翻页，Errata ⑩ 对偶语义）
    await page.getByRole('button', { name: '测试连接' }).click();
    await expect(
      page.locator('.vv-mm-form').getByText(new RegExp(`连接成功：100 个文件，ref ${GL_SHA8}，延迟 \\d+ ms`))
    ).toBeVisible();
    expect(authLog.every((h) => h === 'GLT')).toBe(true);
    expect(authLog.length).toBe(3); // projects + commits + tree 首页（probe 恰 1 页）

    // 保存 → 行徽标 GitLab → 打开（listChildren 重拉分页——Link rel=next 顺序 follow）
    await page.locator('.vv-mm-form').getByRole('button', { name: '保存' }).click();
    await expect(page.locator('.vv-mm-form')).toHaveCount(0);
    const row = page.locator('.vv-mm-item', { hasText: 'e2e gitlab' });
    await expect(row.getByText('GitLab', { exact: true })).toBeVisible(); // exact：行名/endpoint 含 gitlab 子串
    await row.getByRole('button', { name: '打开' }).click();
    await page.keyboard.press('Escape');
    await expect(page.locator('.vv-mounts-manager')).toHaveCount(0);
    await expect(page.locator('.vv-tab.active', { hasText: 'e2e gitlab' })).toBeVisible();
    await seeTreeRow(page, 'f1_0.txt'); // 第一页条目
    await seeTreeRow(page, 'notes.txt'); // 第二页条目（两页顺序拉齐）

    // tree 请求顺序断言：probe 首页 → 清单首页 → page=2（禁并发深分页——顺序 URL 序列）
    const treeUrls = urlLog.filter((u) => u.includes('/repository/tree'));
    expect(treeUrls.length).toBe(3);
    expect(treeUrls[0]).not.toContain('page=2'); // probe 首页采样
    expect(treeUrls[1]).not.toContain('page=2'); // 清单首页
    expect(treeUrls[2]).toContain('page=2'); // Link follow 第 2 页
    expect(authLog.every((h) => h === 'GLT')).toBe(true);

    // 读文件：files/{path}/raw PRIVATE-TOKEN 头 + 内容渲染
    const drawer = await openDrawerIfNarrow(page);
    await page.locator('.vv-tree-row', { hasText: 'notes.txt' }).click();
    await closeDrawerIfOpened(page, drawer);
    await expect(page.locator('.vv-tab.active', { hasText: 'notes.txt' })).toBeVisible();
    await expect(page.locator('.vv-code-pre')).toContainText('gitlab body');
    expect(urlLog.some((u) => u.includes('/repository/files/notes.txt/raw?ref=main'))).toBe(true);
  });

  test('GIT-04b 自建域 CORS 失败：TypeError 特征化文案（不提示代理通道）', async ({ page }) => {
    // route.abort = 网络层失败特征（「从未成功过」的端点——MM-03 坑注记同源）
    await page.route('**gitlab-cors-fail.test/**', (route) => void route.abort());
    await page.goto('/');
    await expect(page.locator('.vv-tabbar')).toBeVisible();
    await openMountsPanel(page);
    await page.getByRole('button', { name: '＋ 新增挂载' }).click();
    await fillGitlabForm(page, { label: 'cors fail', host: 'https://gitlab-cors-fail.test', project: 'grp/rp', ref: 'main' });
    await page.getByRole('button', { name: '测试连接' }).click();
    await expect(page.locator('.vv-mm-probe')).toContainText(
      '连接失败：GitLab 直连失败：实例 CORS 未配置或网络不可达'
    );
  });

  test('GIT-06 行删除 UI 链（spec §5 删除步）：打开挂载→面板行删除 confirm→行消失/已开 tab 存活可读→刷新落占位', async ({ page }) => {
    test.setTimeout(60_000);
    const recId = `githubdirect:${hash8(['github', 'octo', 'repo', 'main', ''].join('\u001f'))}`;
    await mockGithub(page, { tree: GH_TREE, files: { 'a.txt': 'delete chain body\n' } });

    await page.goto('/');
    await expect(page.locator('.vv-tabbar')).toBeVisible();
    await seedMountRecord(page, {
      id: recId,
      kind: 'direct',
      backend: 'github',
      label: '删除链挂载',
      endpoint: 'https://github.com/octo/repo',
      prefix: '',
      owner: 'octo',
      repo: 'repo',
      ref: 'main',
      createdAt: 1700000000000
    });
    await seedSnapshot(page, {
      activeId: 'w1',
      workspaces: [
        {
          id: 'w1',
          name: '默认',
          createdAt: 1700000000000,
          sources: [{ kind: 'direct', storeId: recId, storeLabel: '删除链挂载' }],
          tabs: [
            { id: 't1', storeId: recId, storeLabel: '删除链挂载', path: '', name: '删除链挂载', kind: 'rename-only', scrollTop: 0, active: false },
            { id: 't2', storeId: recId, storeLabel: '删除链挂载', path: 'a.txt', name: 'a.txt', kind: 'rename-only', scrollTop: 0, active: true }
          ],
          activeTabId: 't2'
        }
      ]
    });

    // restore 打开（记录在场——git 记录恢复链 MM-08 形态复用）
    await page.reload();
    await expect(page.locator('.vv-tab.active', { hasText: 'a.txt' })).toBeVisible();
    await seeTreeRow(page, 'a.txt');

    // 面板行删除：confirm 文案断言（挂载删除后果声明 + 引用计数）→ 接受 → 行消失
    await openMountsPanel(page);
    const row = page.locator('.vv-mm-item', { hasText: '删除链挂载' });
    await expect(row.getByText('GitHub', { exact: true })).toBeVisible();
    const dialogText = page
      .waitForEvent('dialog')
      .then((d) => {
        const t = d.message();
        void d.accept();
        return t;
      });
    await row.getByRole('button', { name: '删除' }).click();
    expect(await dialogText).toContain('删除挂载「删除链挂载」');
    expect(await dialogText).toContain('相关标签页将无法自动恢复');
    await expect(page.getByText('暂无前端配置挂载。')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.vv-mounts-manager')).toHaveCount(0);

    // 已开 tab 存活可读（removeRecord 语义：运行中 tab 不中断——store 随最后持有
    // 者释放；删除只摘记录面）
    await expect(page.locator('.vv-tab', { hasText: '删除链挂载' })).toBeVisible();
    const drawer = await openDrawerIfNarrow(page);
    await page.locator('.vv-tree-row', { hasText: 'a.txt' }).click();
    await closeDrawerIfOpened(page, drawer);
    await expect(page.locator('.vv-tab.active', { hasText: 'a.txt' })).toBeVisible();
    await expect(page.locator('.vv-code-pre')).toContainText('delete chain body');

    // 刷新 → 记录已删 → 占位（MM-08 降级链的 git 记录 UI 删除形态）
    await page.reload();
    await expect(page.locator('.vv-error-card')).toBeVisible();
    await expect(page.locator('.vv-error-card')).toContainText('需要重新打开');
  });

  test('GIT-05 快照恢复链：记录+凭据库条目 → reload 重建（请求带凭据库 token）；记录删除 → 占位', async ({ page }) => {
    test.setTimeout(60_000);
    // storeId = 记录 id（core githubDirectStoreId 闭环——identity 五段 join，prefix 空 = 尾分隔符）
    const recId = `githubdirect:${hash8(['github', 'octo', 'repo', 'main', ''].join('\u001f'))}`;
    const rawAuthLog: string[] = [];
    await mockGithub(page, { tree: GH_TREE, files: { 'a.txt': 'restored git body\n' }, rawAuthLog });

    await page.goto('/');
    await expect(page.locator('.vv-tabbar')).toBeVisible();
    // 装置：githubdirect 记录（credentialKey 引用形态）+ gitcred 凭据条目 + 快照
    //（workspace direct 来源 + 目录/文件 tab——MM-08 :564 形态）
    await seedMountRecord(page, {
      id: recId,
      kind: 'direct',
      backend: 'github',
      label: 'e2e git 直连',
      endpoint: 'https://github.com/octo/repo',
      prefix: '',
      owner: 'octo',
      repo: 'repo',
      ref: 'main',
      credentialKey: 'github.com:octo',
      createdAt: 1700000000000
    });
    await seedMountRecord(page, {
      id: 'gitcred:github.com:octo',
      kind: 'gitcred',
      host: 'github.com',
      owner: 'octo',
      token: 'T1',
      createdAt: 1700000000000
    });
    await seedSnapshot(page, {
      activeId: 'w1',
      workspaces: [
        {
          id: 'w1',
          name: '默认',
          createdAt: 1700000000000,
          sources: [{ kind: 'direct', storeId: recId, storeLabel: 'e2e git 直连' }],
          tabs: [
            { id: 't1', storeId: recId, storeLabel: 'e2e git 直连', path: '', name: 'e2e git 直连', kind: 'rename-only', scrollTop: 0, active: false },
            { id: 't2', storeId: recId, storeLabel: 'e2e git 直连', path: 'a.txt', name: 'a.txt', kind: 'rename-only', scrollTop: 0, active: true }
          ],
          activeTabId: 't2'
        }
      ]
    });

    // reload → restore 按 storeId 查记录重建（registerStore + tab 恢复）——raw 请求带
    // 凭据库 token（恢复链查库：restore listDirectMounts 先建 recordCache →
    // directConfigOf credentialKey 查库——Errata ③ 同步镜像时序）
    await page.reload();
    await expect(page.locator('.vv-tab.active', { hasText: 'a.txt' })).toBeVisible();
    await expect(page.locator('.vv-code-pre')).toContainText('restored git body');
    await seeTreeRow(page, 'a.txt');
    await expect(page.locator('.vv-statusbar')).toContainText('此源不支持变更推送');
    expect(rawAuthLog.length).toBeGreaterThan(0);
    expect(rawAuthLog.every((h) => h === 'Bearer T1')).toBe(true);

    // 变体：记录删除（用户删了挂载）→ 刷新落占位（MM-08 降级链形态，git 记录一例）
    await page.evaluate(async (id) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open('vviewer');
        req.onupgradeneeded = () => {
          const d = req.result;
          for (const s of ['kv', 'themes', 'fonts', 'mounts', 'iconThemes']) {
            if (!d.objectStoreNames.contains(s)) d.createObjectStore(s);
          }
        };
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
});
