import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { assertPortFree, startVviewerServer, stopServer, waitHealthy } from './serverHarness';
import { closeDrawerIfOpened, ensureRightDrawer, openDrawerIfNarrow } from './drawer';
import { overflowConnectServer } from './tabbar-actions';

/**
 * b-git-panel —— 右面板 Git 段基础信息卡 + 三元切换器（2026-10-31 git-panel Task 2，
 * GIT 域）。spec：docs/superpowers/specs/2026-10-31-git-panel-design.md。
 *
 * 链路事实（源码锚，写作时已读）：
 * - 探测：ViewerPane 渲染完成 fire-and-forget probeGitAvailability（gitProbe.ts：
 *   目录向上 ≤5 级读 .git/HEAD，命中返回 repoDir；目录级缓存 + 负缓存同会话不重试）
 *   → ongitAvailable 上行 → AppShell gitInfo（per active tab，tab 切换即清空）。
 * - 切换器：三元 [目录|属性|Git]——Git 钮显隐 = gitInfo !== null（探测可用才出现，
 *   spec §4 显隐合并）；默认落位 effect 永不选 'git'（无 toc/outline 文件默认属性）；
 *   激活 Git 置 rightViewTouched（用户显式选择），切文件后台账保持——gitInfo 清空后
 *   新 tab probe 异步上行，GitSection 以新文件现值重挂。
 * - 信息卡（GitSection.svelte）：激活时 ensureGitClient（worker 单例，isogit chunk
 *   首次激活即拉）→ bindFs 登记 → 并发拉 probeHead/lastCommit/store.read（工作区
 *   原始字节）→ statusOf（worker 内 hashBlob(工作区字节) vs HEAD blob oid）。原始
 *   字节通道端到端：CRLF 原样入 hash——**CRLF 文件必须 clean**（Review Focus 误报
 *   红线：渲染归一文本 CRLF→LF 的比对通道会误报 modified）。HEAD 树无此路径 →
 *   lastCommit null + status untracked（worker 分流，T1 验通）。
 * - 负缓存（GIT-04）：probeCache 键 = store.id + 目录；server remote store 的 id 由
 *   base+label 派生（确定性），同连接同目录二次打开命中缓存——零新增 .git 请求，
 *   以 page.route 拦截 /api/file 计数断言（server 模式下 store.read 即网络请求）。
 *
 * 夹具（新先例：真实 git 仓库）：mkdtemp + execSync git init -b main/config（user +
 * core.autocrlf false 钉死字节原样入库）/两次 commit（第二次含 CRLF 文件）/一次
 * 未提交改动（a.txt）+ untracked 新文件（new.txt）+ 无 .git 对照目录（nogit/）。
 * server 生命周期复用 serverHarness（m6 先例：--root 指向夹具，preview :4173 前端
 * 跨源连接）；打开文件走树点击真实全链路（连接→树→store→渲染→probe→GitSection）。
 * 双 project（chromium/mobile）：mobile 右栏在 ≤600px 抽屉内，断言前 ensureRightDrawer。
 */
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const binPath = `${repoRoot}/server/target/debug/vviewer`;
// 双 project 下同一 spec 文件在两个 worker 并发跑，各 project 错开端口避免 beforeAll
// spawn 时 bind 冲突（m6 先例 8401/8451；8501/8551 同样避开其余 spec 占用段）
let PORT = 8501;
let BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'e2egitpanel';
const PREVIEW_ORIGIN = 'http://127.0.0.1:4173';

let server: ReturnType<typeof startVviewerServer> | null = null;
let fixtureRoot: string | null = null;
/** HEAD 提交完整 oid（GIT-01 断言信息卡短 hash = 前 7 位与仓库实际一致） */
let HEAD_OID = '';

/** 构建真实 git 仓库夹具（同步 execSync——beforeAll 装置期，CI runner 自带 git）。 */
function buildGitFixture(root: string): void {
  const repo = join(root, 'repo1');
  mkdirSync(repo, { recursive: true });
  const git = (cmd: string): string => execSync(`git ${cmd}`, { cwd: repo, encoding: 'utf8' });
  git('init -b main');
  git('config user.email e2e@vviewer.local');
  git('config user.name e2e');
  // CRLF 红线前提：钉死 autocrlf=false，字节（含 \r\n）原样入库与检出，无过滤
  git('config core.autocrlf false');
  writeFileSync(join(repo, 'readme.txt'), 'readme v1\n');
  writeFileSync(join(repo, 'a.txt'), 'alpha line 1\nalpha line 2\n');
  git('add -A');
  git('commit -m "first: add readme and a"');
  writeFileSync(join(repo, 'a.txt'), 'alpha line 1\nalpha line 2\nalpha line 3 committed\n');
  // CRLF 载体（Review Focus）：\r\n 字节入库；工作区同字节 → 原始字节 hash 比对
  // 必 clean——若实现误走渲染归一文本（CRLF→LF）比对即误报 modified，本用例即红
  writeFileSync(join(repo, 'crlf.txt'), 'crlf line one\r\ncrlf line two\r\n');
  git('add -A');
  git('commit -m "second: update a.txt and add crlf"');
  HEAD_OID = git('rev-parse HEAD').trim();
  // 未提交改动（GIT-02 modified 载体）：工作区 ≠ HEAD blob
  writeFileSync(join(repo, 'a.txt'), 'alpha line 1\nalpha line 2\nalpha line 3 working tree\n');
  // untracked（GIT-03 载体）：工作区在、HEAD 树无
  writeFileSync(join(repo, 'new.txt'), 'brand new file\n');
  // 无 .git 对照目录（GIT-04 载体）：root 本身也无 .git，向上两级皆 404
  const nogit = join(root, 'nogit');
  mkdirSync(nogit, { recursive: true });
  writeFileSync(join(nogit, 'plain.txt'), 'plain content\n');
  writeFileSync(join(nogit, 'second.txt'), 'second content\n');
}

test.beforeAll(async () => {
  if (test.info().project.name === 'mobile') {
    PORT = 8551;
    BASE = `http://127.0.0.1:${PORT}`;
  }
  test.setTimeout(300_000); // cargo 增量编译余量（serverHarness 先例）
  await assertPortFree(BASE);
  fixtureRoot = mkdtempSync(join(tmpdir(), 'vviewer-e2e-git-'));
  buildGitFixture(fixtureRoot);
  server = startVviewerServer({
    repoRoot,
    binPath,
    root: fixtureRoot,
    webDist: `${repoRoot}/apps/web/build`,
    port: PORT,
    token: TOKEN,
    corsOrigin: PREVIEW_ORIGIN,
    tag: 'b-git-panel'
  });
  await waitHealthy(BASE);
});

test.afterAll(async () => {
  await stopServer(server, 'b-git-panel');
  if (fixtureRoot !== null) rmSync(fixtureRoot, { recursive: true, force: true });
});

/** ⋯ 菜单连接表单提交并等树挂载（m6 connect 先例：每 test 新 page） */
async function connect(page: Page): Promise<void> {
  await page.goto('/');
  await overflowConnectServer(page);
  await page.getByLabel('服务器地址').fill(BASE);
  await page.getByLabel('访问令牌').fill(TOKEN);
  await page.getByRole('button', { name: '连接', exact: true }).click();
  await expect(page.locator('.vv-tree-row', { hasText: 'repo1' }).first()).toBeVisible({ timeout: 15_000 });
}

/** 树点击打开文件（首次展开目录行 + 文件行点击，m6 openFile 先例；窄视口抽屉适配） */
async function openFile(page: Page, dir: string, name: string): Promise<void> {
  const drawer = await openDrawerIfNarrow(page);
  await page.locator('.vv-tree-row', { hasText: dir }).first().click();
  await page.locator('.vv-tree-row', { hasText: name }).click();
  await closeDrawerIfOpened(page, drawer);
  await expect(page.locator('.vv-tab.active', { hasText: name })).toBeVisible({ timeout: 15_000 });
}

/** 已展开目录内切换文件（openFile 首次展开后复用——再点目录行会折叠，分开两个口） */
async function switchFile(page: Page, name: string): Promise<void> {
  const drawer = await openDrawerIfNarrow(page);
  await page.locator('.vv-tree-row', { hasText: name }).click();
  await closeDrawerIfOpened(page, drawer);
  await expect(page.locator('.vv-tab.active', { hasText: name })).toBeVisible({ timeout: 15_000 });
}

/** 等 probe 上行完成（Git 钮出现 = 渲染完成→store read→gitInfo 上行链路全通），
 *  返回 Git 钮 locator；右栏断言前先确保右抽屉（mobile ≤600px）展开。 */
async function waitGitButton(page: Page): Promise<Locator> {
  await ensureRightDrawer(page, true);
  const btn = page.locator('.vv-right-switch-btn', { hasText: 'Git' });
  await expect(btn).toBeVisible({ timeout: 30_000 });
  return btn;
}

test('GIT-01 · git 仓库文件：第三钮显隐、默认落位属性、信息卡字段（CRLF clean 红线）', async ({ page }) => {
  test.setTimeout(90_000);
  await connect(page);
  await openFile(page, 'repo1', 'crlf.txt');
  await expect(page.locator('.vv-code-pre')).toBeVisible({ timeout: 30_000 });

  // 显隐合并（spec §4）：无 toc/outline 文件 + git 可用 → 切换器仅属性/Git 两钮，
  // 默认落位永不选 git（属性面板先行，GitSection 未激活不渲染）
  const gitBtn = await waitGitButton(page);
  await expect(page.locator('.vv-right-switch-btn', { hasText: '目录' })).toHaveCount(0);
  await expect(page.locator('.meta-panel')).toBeVisible();
  await expect(page.locator('.vv-git')).toHaveCount(0);

  await gitBtn.click();
  const card = page.locator('.vv-git');
  await expect(card).toBeVisible();
  await expect(card.locator('.vv-git-row', { hasText: '分支' })).toContainText('main');
  // Review Focus 红线：CRLF 文件状态必须 clean（原始字节通道端到端验证）
  await expect(card.locator('.vv-git-row', { hasText: '状态' })).toContainText('无改动');
  await expect(card.locator('.vv-git-dot-clean')).toBeVisible();
  // 末次提交四件（spec §3.1）：短 hash 与仓库实际 HEAD 一致 / 作者 / 相对时间 / subject
  await expect(card.locator('.vv-git-row', { hasText: '末次提交' })).toContainText(HEAD_OID.slice(0, 7));
  await expect(card.locator('.vv-git-row', { hasText: '作者' })).toContainText('e2e');
  await expect(card.locator('.vv-git-row', { hasText: '时间' })).toContainText(/刚刚|分钟前|小时前/);
  await expect(card.locator('.vv-git-row', { hasText: '说明' })).toContainText('second: update a.txt and add crlf');
});

test('GIT-02 · touched 保持 + modified 徽标：Git 激活后切文件段随行（黄点）', async ({ page }) => {
  test.setTimeout(90_000);
  await connect(page);
  await openFile(page, 'repo1', 'crlf.txt');
  await expect(page.locator('.vv-code-pre')).toBeVisible({ timeout: 30_000 });
  const gitBtn = await waitGitButton(page);
  await gitBtn.click();
  await expect(page.locator('.vv-git-dot-clean')).toBeVisible({ timeout: 30_000 });

  // rightViewTouched 台账：切到未提交改动的 a.txt 后视图保持 'git'——gitInfo 随
  // tab 切换清空（per-tab 语义），新 probe 异步上行（目录缓存命中零成本）后
  // GitSection 以 a.txt 现值重挂：黄点 modified。先收右抽屉（mobile ≤600px 下
  // 开着的右栏盖住左树行，click 永等——b-code-outline「断言完即收」先例）
  await ensureRightDrawer(page, false);
  await switchFile(page, 'a.txt');
  await expect(page.locator('.vv-git-dot-modified')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.vv-git-row', { hasText: '状态' })).toContainText('已修改');
});

test('GIT-03 · untracked：HEAD 无此路径——灰点 + 无末次提交', async ({ page }) => {
  test.setTimeout(90_000);
  await connect(page);
  await openFile(page, 'repo1', 'new.txt');
  await expect(page.locator('.vv-code-pre')).toBeVisible({ timeout: 30_000 });
  const gitBtn = await waitGitButton(page);
  await gitBtn.click();
  await expect(page.locator('.vv-git-dot-untracked')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.vv-git-row', { hasText: '状态' })).toContainText('未跟踪');
  await expect(page.locator('.vv-git-row', { hasText: '末次提交' })).toContainText('无（未跟踪文件）');
});

test('GIT-04 · 无 .git 来源：无 Git 段 + probe 负缓存（二次打开零新增请求）', async ({ page }) => {
  test.setTimeout(90_000);
  // server 模式下 store.read 即网络请求：page.route 拦截 /api/file 计 .git 路径
  // （probe 对 .git/HEAD 的读取即走此通道；continue 放行不篡改响应）
  const gitReads: string[] = [];
  await page.route('**/api/file*', (route) => {
    const path = new URL(route.request().url()).searchParams.get('path') ?? '';
    if (path.includes('.git')) gitReads.push(path);
    return route.continue();
  });
  await connect(page);
  await openFile(page, 'nogit', 'plain.txt');
  await expect(page.locator('.vv-code-pre')).toBeVisible({ timeout: 30_000 });

  // 探测收敛 null：切换器整体不出现（无 toc/outline/git 的纯属性现状——spec §4
  // 「探测不可用时无 Git 段，右面板不出现空段」）；.git/HEAD 读取已发生（nogit
  // 级 + 根级各一次 404），poll 等 probe 链路落地而非即时断言（渲染与探测异步）
  await ensureRightDrawer(page, true);
  await expect(page.locator('.vv-right-switch')).toHaveCount(0, { timeout: 30_000 });
  await expect.poll(() => gitReads.length, { timeout: 15_000 }).toBe(2);

  // 负缓存：同目录二次打开（新 tab 渲染完成 → probe 再触发）命中 probeCache——
  // 零新增 .git 请求。渲染就绪后留实测窗口：负缓存若失效，新增读取在此窗口到账。
  // 先收右抽屉（mobile ≤600px 下开着的右栏盖住左树行，click 永等——先例同 GIT-02）
  await ensureRightDrawer(page, false);
  await switchFile(page, 'second.txt');
  await expect(page.locator('.vv-code-pre')).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1_500);
  expect(gitReads.length).toBe(2);
  await expect(page.locator('.vv-right-switch')).toHaveCount(0);
});
