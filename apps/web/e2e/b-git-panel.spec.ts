import { execSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { assertPortFree, startVviewerServer, stopServer, waitHealthy } from './serverHarness';
import { closeDrawerIfOpened, ensureRightDrawer, openDrawerIfNarrow } from './drawer';
import { menuConnectServer } from './tabbar-menu';

/**
 * b-git-panel —— 右面板 Git 段：基础信息卡 + 三元切换器（Task 2，GIT-01..04）+
 * diff 视图 / 文件历史 log / 行级 blame hover（Task 3，GIT-05..08）+
 * 测绘差距新增锚（GIT-09..12：detached HEAD / blame 200 截断 / diff 截断上限 /
 * untracked 无 diff 提示态，场景文档 docs/e2e/git-panel.md §2.2）。
 * spec：docs/superpowers/specs/2026-10-31-git-panel-design.md。
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
 * - T3：diff 折叠区（未提交 → worktree vs HEAD；clean → HEAD vs HEAD^——blobAt
 *   'HEAD^' 首父；显示层归一 BOM 剥+CRLF→LF，与状态判定的原始字节 hash 通道分轨）；
 *   文件历史 ≤50（isogit log filepath）；blame hover（ViewerPane 对 .vv-code-pre
 *   pointerover 委托 → closest('[data-line]') → 首 hover 触发全文件 blame worker
 *   计算 + 300ms 延迟 + fixed 浮层；firstVisibleLine+≤2MB 探门限全量域；滚动即收）。
 * - 负缓存（GIT-04）：probeCache 键 = store.id + 目录；server remote store 的 id 由
 *   base+label 派生（确定性），同连接同目录二次打开命中缓存——零新增 .git 请求，
 *   以 page.route 拦截 /api/file 计数断言（server 模式下 store.read 即网络请求）。
 *
 * 夹具（新先例：真实 git 仓库）：mkdtemp + execSync git init -b main/config（user +
 * core.autocrlf false 钉死字节原样入库）/三 commit 两作者（c3 经 `git -c user.name=…
 * -c user.email=…` 切作者，author+committer 同为 author2）/一次未提交改动（a.txt
 * 第 3 行）+ untracked 新文件（new.txt）+ 无 .git 对照目录（nogit/）。
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
/** crlf.txt 末次提交（c2）完整 oid——GIT-01 信息卡短 hash 断言锚（filepath 过滤
 *  口径：信息卡「末次提交」是**该文件**的末次提交，非仓库 HEAD） */
let CRLF_OID = '';
/** a.txt 末次提交（c3 = 仓库 HEAD）完整 oid——GIT-07 log 展开的 full hash 断言锚 */
let A_LAST_OID = '';
/** repo2 单提交完整 oid（checkout --detach 后 HEAD 即指向它）——GIT-09 末次提交
 *  短 hash 断言锚（游离态下 last-commit 走 log(filepath)，与分支解析无关） */
let DETACHED_OID = '';

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
  // blame 滚动载体（GIT-08）：c1 引入 30 行（>桌面视口高，.vv-code-pre 可真滚动）
  writeFileSync(
    join(repo, 'story.txt'),
    Array.from({ length: 30 }, (_, i) => `story v1 line ${i + 1}`).join('\n') + '\n'
  );
  git('add -A');
  git('commit -m "first: add readme and a"');
  writeFileSync(join(repo, 'a.txt'), 'alpha line 1\nalpha line 2\nalpha line 3 committed\n');
  // CRLF 载体（Review Focus）：\r\n 字节入库；工作区同字节 → 原始字节 hash 比对
  // 必 clean——若实现误走渲染归一文本（CRLF→LF）比对即误报 modified，本用例即红
  writeFileSync(join(repo, 'crlf.txt'), 'crlf line one\r\ncrlf line two\r\n');
  git('add -A');
  git('commit -m "second: update a.txt and add crlf"');
  CRLF_OID = git('rev-parse HEAD').trim();
  // c3 第二作者（brief 裁决：`git -c user.email/user.name` 逐提交切换，author 与
  // committer 同落 author2）——readme.txt 改写（GIT-06 clean 模式 HEAD^ 对比载体）
  // + a.txt 追加第 4 行（GIT-07 多条 log / GIT-08 blame 两作者向量）+ story.txt
  // 追加 30 行（author2 归属段）
  writeFileSync(join(repo, 'readme.txt'), 'readme v2\n');
  writeFileSync(join(repo, 'a.txt'), 'alpha line 1\nalpha line 2\nalpha line 3 committed\nalpha line 4 by author2\n');
  writeFileSync(
    join(repo, 'story.txt'),
    Array.from({ length: 60 }, (_, i) => (i < 30 ? `story v1 line ${i + 1}` : `story line ${i + 1} by author2`)).join('\n') + '\n'
  );
  git('add -A');
  execSync('git -c user.name=author2 -c user.email=author2@vviewer.local commit -m "third: author2 appends line 4"', {
    cwd: repo,
    encoding: 'utf8'
  });
  A_LAST_OID = git('rev-parse HEAD').trim();
  // 未提交改动（GIT-02 modified / GIT-05 diff 载体）：第 3 行工作区改写（首尾与
  // 追加行保持 → diff 恰 1 del + 1 add，计数断言可钉死）
  writeFileSync(
    join(repo, 'a.txt'),
    'alpha line 1\nalpha line 2\nalpha line 3 working tree\nalpha line 4 by author2\n'
  );
  // untracked（GIT-03 载体）：工作区在、HEAD 树无
  writeFileSync(join(repo, 'new.txt'), 'brand new file\n');

  // ── GIT-09..11 夹具扩展（场景文档 §4：各 repo 独立 HEAD/对象库，互不共享，
  // 不污染 repo1 的 oid 断言锚 GIT-01/07）──
  const mkRepo = (name: string): ((cmd: string) => string) => {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    const run = (cmd: string): string => execSync(`git ${cmd}`, { cwd: dir, encoding: 'utf8' });
    run('init -b main');
    run('config user.email e2e@vviewer.local');
    run('config user.name e2e');
    run('config core.autocrlf false');
    return run;
  };
  // repo2（GIT-09 detached 载体）：单 commit + checkout --detach——.git/HEAD 变裸
  // oid（gitProbe.ts:73 非 'gitdir:' 前缀照常命中），isogit currentBranch 返回
  // undefined（gitWorker.ts:272-280 detached → ok:true 无 branch → GitSection
  // 分支位兜底文案「（游离 HEAD）」）。subject 避开 'main'，供分支行负断言排除误显
  const git2 = mkRepo('repo2');
  writeFileSync(join(root, 'repo2', 'head.txt'), 'detached head carrier\n');
  git2('add -A');
  git2('commit -m "detach carrier commit"');
  DETACHED_OID = git2('rev-parse HEAD').trim();
  git2('checkout --detach');
  // repo3（GIT-10 blame 截断载体）：e2e-blame.txt 201 提交——首提交建文件 + 循环
  // 200 次追加一行提交（须改文件内容才计入 filepath 过滤 log——--allow-empty 不改
  // 文件不计，场景文档 §4 注意项）。末态全提交 = 文件 clean。execSync 循环装置期
  // 秒级完成（CI runner 自带 git，场景文档备案）
  const git3 = mkRepo('repo3');
  const blameFile = join(root, 'repo3', 'e2e-blame.txt');
  writeFileSync(blameFile, 'blame base line\n');
  git3('add -A');
  git3('commit -m "blame base commit"');
  for (let i = 1; i <= 200; i++) {
    appendFileSync(blameFile, `blame appended line ${i}\n`);
    git3(`commit -am "blame append ${i}"`);
  }
  // repo4（GIT-11 diff 截断载体）：首提交 1 行、工作区追加 2500 行保持未提交
  // （modified → diff 走工作区 vs HEAD）。行数门载体：≈40KB < 200KB 不触 bytes 门
  // （场景文档验收：bytes 门由 gitDiff 单测向量覆盖，不在 e2e 重复）
  const git4 = mkRepo('repo4');
  writeFileSync(join(root, 'repo4', 'big-diff.txt'), 'head line 1\n');
  git4('add -A');
  git4('commit -m "big diff base commit"');
  writeFileSync(
    join(root, 'repo4', 'big-diff.txt'),
    'head line 1\n' + Array.from({ length: 2500 }, (_, i) => `big diff line ${i + 2}`).join('\n') + '\n'
  );
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
  await menuConnectServer(page);
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
  // 末次提交四件（spec §3.1）：短 hash 与该文件末次提交（c2）一致 / 作者 / 相对时间 / subject
  await expect(card.locator('.vv-git-row', { hasText: '末次提交' })).toContainText(CRLF_OID.slice(0, 7));
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

/** 打开文件并激活 Git 段（T3 公共前缀：信息卡 ready 即 diff/log 数据链全通），
 *  返回 Git 段容器 locator。**保持右抽屉展开**：GIT-05..07 的后续交互全部发生在
 *  段内（mobile ≤600px 抽屉收起即移出视口，段内 click 永挂 actionability——首跑
 *  实证）；需要操作代码区（GIT-08 hover）的用例自行 ensureRightDrawer(page, false)。 */
async function openGitSection(page: Page, name: string): Promise<Locator> {
  return openGitSectionIn(page, 'repo1', name);
}

/** openGitSection 的带目录变体（GIT-09..11 夹具扩 repo2/repo3/repo4 后续用；前缀
 *  流与 openGitSection 同一：信息卡 ready + log 列表首条可见即 diff/log 数据链全通。
 *  注意 untracked 文件 log 空列表不适用本前缀——GIT-12 手写等 .vv-git 可见即收） */
async function openGitSectionIn(page: Page, dir: string, name: string): Promise<Locator> {
  await connect(page);
  await openFile(page, dir, name);
  await expect(page.locator('.vv-code-pre')).toBeVisible({ timeout: 30_000 });
  const gitBtn = await waitGitButton(page);
  await gitBtn.click();
  const section = page.locator('.vv-git');
  await expect(section).toBeVisible({ timeout: 30_000 });
  await expect(section.locator('.vv-git-log-list .vv-git-log-item').first()).toBeVisible({ timeout: 30_000 });
  return section;
}

test('GIT-05 · diff modified 模式：工作区 vs HEAD，+/- 行着色计数钉死', async ({ page }) => {
  test.setTimeout(90_000);
  const section = await openGitSection(page, 'a.txt');
  // 折叠默认收起（spec §4），展开即拉（modified → worktree vs HEAD）
  const foldBtn = section.locator('.vv-git-fold-btn');
  await expect(foldBtn).toContainText('工作区 vs HEAD');
  await foldBtn.click();
  const diff = section.locator('.vv-git-diff');
  await expect(diff).toBeVisible({ timeout: 30_000 });
  // 夹具钉死口径：仅第 3 行改写 → 恰 1 add + 1 del（统计行与着色行双计数）
  await expect(section.locator('.vv-git-diff-stat')).toContainText('+1');
  await expect(section.locator('.vv-git-diff-stat')).toContainText('−1');
  await expect(diff.locator('.vv-git-diff-row-add')).toHaveCount(1);
  await expect(diff.locator('.vv-git-diff-row-del')).toHaveCount(1);
  await expect(diff.locator('.vv-git-diff-row-add')).toContainText('alpha line 3 working tree');
  await expect(diff.locator('.vv-git-diff-row-del')).toContainText('alpha line 3 committed');
  // 上下文行（ctx）在场且不着色
  await expect(diff.locator('.vv-git-diff-row', { hasText: 'alpha line 1' })).toBeVisible();
  await expect(diff.locator('.vv-git-diff-trunc')).toHaveCount(0);
});

test('GIT-06 · diff clean 模式：HEAD^ vs HEAD（末次提交的改动）', async ({ page }) => {
  test.setTimeout(90_000);
  const section = await openGitSection(page, 'readme.txt');
  // readme.txt clean（c3 改写后工作区同字节）→ 模式标注 HEAD^ vs HEAD
  const foldBtn = section.locator('.vv-git-fold-btn');
  await expect(foldBtn).toContainText('HEAD^ vs HEAD');
  await foldBtn.click();
  const diff = section.locator('.vv-git-diff');
  await expect(diff).toBeVisible({ timeout: 30_000 });
  // c3 对 readme.txt 的改动：v1 → v2（blobAt HEAD^ 首父链路端到端）
  await expect(section.locator('.vv-git-diff-stat')).toContainText('+1');
  await expect(section.locator('.vv-git-diff-stat')).toContainText('−1');
  await expect(diff.locator('.vv-git-diff-row-add')).toHaveCount(1);
  await expect(diff.locator('.vv-git-diff-row-del')).toHaveCount(1);
  await expect(diff.locator('.vv-git-diff-row-add')).toContainText('readme v2');
  await expect(diff.locator('.vv-git-diff-row-del')).toContainText('readme v1');
});

test('GIT-07 · 文件历史：≤50 列表 + 点击展开详情（full hash/两时间戳/逐提交 diff）', async ({ page }) => {
  test.setTimeout(90_000);
  const section = await openGitSection(page, 'a.txt');
  const items = section.locator('.vv-git-log-list .vv-git-log-item');
  // 夹具三提交全触 a.txt：c3（author2）/c2/c1 新旧序
  await expect(items).toHaveCount(3);
  await expect(items.nth(0)).toContainText('author2');
  await expect(items.nth(0)).toContainText('third: author2 appends line 4');
  await expect(items.nth(1)).toContainText('second: update a.txt and add crlf');
  await expect(items.nth(2)).toContainText('first: add readme and a');
  // 展开首条目：full hash（40 位与仓库一致）+ author/committer 双行（夹具 U/V 异体
  // 置换在 c3 同体）+ 完整 message + 该提交该文件 diff（基线 = 文件史前一条目）
  await items.nth(0).locator('.vv-git-log-btn').click();
  const detail = section.locator('.vv-git-log-detail');
  await expect(detail).toBeVisible();
  await expect(detail).toContainText(A_LAST_OID);
  await expect(detail).toContainText('author2');
  await expect(detail).toContainText('提交者');
  await expect(detail).toContainText('third: author2 appends line 4');
  const diff = section.locator('.vv-git-log-diff .vv-git-diff');
  await expect(diff).toBeVisible({ timeout: 30_000 });
  await expect(diff.locator('.vv-git-diff-row-add', { hasText: 'alpha line 4 by author2' })).toHaveCount(1);
  // 单开互斥：再点收起
  await items.nth(0).locator('.vv-git-log-btn').click();
  await expect(detail).toHaveCount(0);
});

test('GIT-08 · blame hover：浮层字段（作者/日期/subject/未提交哨兵）+ 滚动即收', async ({ page }) => {
  test.setTimeout(120_000);
  await connect(page);
  await openFile(page, 'repo1', 'a.txt');
  await expect(page.locator('.vv-code-pre')).toBeVisible({ timeout: 30_000 });
  const gitBtn = await waitGitButton(page);
  await gitBtn.click();
  await expect(page.locator('.vv-git')).toBeVisible({ timeout: 30_000 });
  await ensureRightDrawer(page, false);
  const pop = page.locator('.vv-git-blame-pop');
  // a.txt 归属预期（blame 推进）：行 0 ← c1（e2e）、行 2 ← 工作区未提交改写（哨兵）
  await page.hover('.vv-code-line[data-line="0"]');
  await expect(pop).toBeVisible({ timeout: 30_000 });
  await expect(pop).toContainText('e2e');
  await expect(pop).toContainText('first: add readme and a');
  await expect(pop).toContainText(/刚刚|分钟前|小时前/);
  await page.hover('.vv-code-line[data-line="2"]');
  await expect(pop).toContainText('（未提交）');
  await expect(pop).toContainText('工作区未提交改动');

  // 切 60 行的 story.txt（切 tab 后 touched 台账保持 Git 段，probe 缓存命中速回）：
  // c3 归属段 + 真滚动（a.txt 仅 4 行滚不动，滚动即收需可滚容器）
  await switchFile(page, 'story.txt');
  await expect(page.locator('.vv-code-pre')).toBeVisible({ timeout: 30_000 });
  await ensureRightDrawer(page, true);
  await expect(page.locator('.vv-git')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.vv-git-log-list .vv-git-log-item').first()).toBeVisible({ timeout: 30_000 });
  await ensureRightDrawer(page, false);
  // 先滚动定位再悬停（真实用户两段式路径）：hover 手势内嵌的 scrollIntoView 会先
  // pointerover 后补发 scroll——scroll 即收语义掐掉已 arm 的定时器（调试实证），
  // 先滚动后移动才与应用「滚动即收 + 移动即查」语义同构。scrollTop=440 使行 40
  // （y≈800）落在双 project 视口内。
  await page.locator('.vv-code-pre').evaluate((el) => {
    el.scrollTop = 440;
  });
  await expect(page.locator('.vv-code-line[data-line="40"]')).toBeVisible({ timeout: 30_000 });
  // 新实例新缓存：首 hover 重触发 worker blame；行 40 ∈ c3 段（30..59）
  await page.hover('.vv-code-line[data-line="40"]');
  await expect(pop).toBeVisible({ timeout: 30_000 });
  await expect(pop).toContainText('author2');
  await expect(pop).toContainText('third: author2 appends line 4');

  // 滚动即收（scrollHost scroll 捕获——行 DOM 整批重建也不残留浮层）；回滚到顶后
  // 再 hover 复现（缓存已热，浮层字段即时；scrollTop=560 时行 1 不在虚拟滚动渲染
  // 窗内，须先滚回）
  await page.locator('.vv-code-pre').evaluate((el) => {
    el.scrollTop += 120;
  });
  await expect(pop).toHaveCount(0);
  await page.locator('.vv-code-pre').evaluate((el) => {
    el.scrollTop = 0;
  });
  await expect(page.locator('.vv-code-line[data-line="1"]')).toBeVisible({ timeout: 30_000 });
  await page.hover('.vv-code-line[data-line="1"]');
  await expect(pop).toBeVisible({ timeout: 30_000 });
  await expect(pop).toContainText('e2e');
  await expect(pop).toContainText('first: add readme and a');
});

// ───────────── GIT-09..12 测绘差距新增锚（场景文档 §2.2）─────────────

/** 环境去噪 route（b-md-corpus-markpad mockExternalNoise 同款，须先于 goto 注册）：
 *  GIT 域全链零网络（isomorphic-git 纯前端读 .git 字节，spec §2.1），本层不为被断
 *  断言链路服务，只把门禁构建注入的 grammar CDN manifest / favicon / CDN 直链面
 *  定态化——fulfill 合法空清单 / 204 / abort，防真网 socket 的资源级 console 噪声。
 *  kroki fulfill、jsdelivr abort、grammars 空清单三面与 markpad 逐字对齐。 */
async function mockGitNoise(page: Page): Promise<void> {
  await page.route('**kroki.io/**', (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>'
    })
  );
  await page.route('**/cdn.jsdelivr.net/**', (route) => route.abort());
  await page.route('**/favicon.ico', (route) => route.fulfill({ status: 204 }));
  await page.route('**/cdn.grammars.test/**', (route) =>
    route.fulfill({
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: '{"grammars":{}}'
    })
  );
}

test.describe('GIT-09..12（SW 阻断 + 外噪 mock 定态化）', () => {
  // SW 接管后请求经 SW fetch 不走页面网络栈，page.route 拦不到（b-md-corpus-markpad
  // 同源备案）；本组无 SW 依赖面（纯本地 git 管线 + serverHarness 文件通道），阻断后
  // mockGitNoise 拦截确定性成立。describe 级 test.use 只作用于本组，GIT-01..08 环境
  // 不动。
  test.use({ serviceWorkers: 'block' });

  test('GIT-09 · detached HEAD：分支位「（游离 HEAD）」+ 末次提交/状态不受游离态影响', async ({ page }) => {
    test.setTimeout(90_000);
    await mockGitNoise(page);
    const section = await openGitSectionIn(page, 'repo2', 'head.txt');
    // 分支位（GitSection.svelte:378）：probe 命中（gitProbe.ts:73 裸 oid 非 'gitdir:'
    // 前缀 → headOk:true），worker probe-head detached → 无 branch（gitWorker.ts:272-280）
    // → 固定兜底文案（实现为固定文案，非短 hash 标注——场景文档 §2.2 以实读为准注）
    await expect(section.locator('.vv-git-row', { hasText: '分支' })).toContainText('（游离 HEAD）');
    // 负断言：checkout --detach 后 main 分支仍存在但 HEAD 不指它——若游离态误显
    // 分支名即在此红；subject 已避开 'main' 措辞（夹具 'detach carrier commit'）
    await expect(section.locator('.vv-git-row', { hasText: '分支' })).not.toContainText('main');
    // 游离态不影响信息卡其余面：状态 clean（gitProbe/gitWorker 链路均与分支无关）+
    // 末次提交 = repo2 唯一提交（last-commit 走 log(filepath)，gitWorker.ts:287）
    await expect(section.locator('.vv-git-dot-clean')).toBeVisible({ timeout: 30_000 });
    await expect(section.locator('.vv-git-row', { hasText: '状态' })).toContainText('无改动');
    await expect(section.locator('.vv-git-row', { hasText: '末次提交' })).toContainText(DETACHED_OID.slice(0, 7));
    await expect(section.locator('.vv-git-row', { hasText: '说明' })).toContainText('detach carrier commit');
  });

  test('GIT-10 · blame 200 截断：说明行常驻模板 + 浮层截断真值 + 浮层不越窗（未超限对照）', async ({ page }) => {
    test.setTimeout(150_000);
    await mockGitNoise(page);
    const section = await openGitSectionIn(page, 'repo3', 'e2e-blame.txt');

    // ① 说明行（GitSection.svelte:397，插值 BLAME_MAX_COMMITS=200，gitDiff.ts:24）：
    //    渲染条件仅 phase.commit !== null（:396），措辞为模板常量——toHaveText 全串
    //    钉死（「超 200」措辞在场不随当前文件真实历史数变化，步骤③同串对照）
    const hint = section.locator('.vv-git-blame-hint');
    await expect(hint).toHaveText('悬停代码行可查看提交归属；文件历史超 200 提交仅最近 200 参与归属。');

    // ② hover 浮层：201 提交文件 blame worker 计算（log depth 201 探针，gitWorker.ts:363-367
    //    → truncated:true）→ 浮层 note 真值在场（ViewerPane.svelte:361-363 → :851）
    await ensureRightDrawer(page, false);
    const pop = page.locator('.vv-git-blame-pop');
    await page.hover('.vv-code-line[data-line="0"]');
    await expect(pop).toBeVisible({ timeout: 60_000 });
    await expect(pop.locator('.vv-git-blame-pop-note')).toContainText('仅最近 200 个参与归属', { timeout: 60_000 });
    // 几何（场景文档 §2.2 ②）：fixed 浮层 boundingBox 完整落在视口内（四边 ≤ 视口
    // 边界；mobile 375×667 更易越窗，双 project 同断）。夹具语料短 subject/短 note，
    // 浮层实际宽 ≈260px < 视口——备案：实现浮层无视口 clamp（x=行左缘，max-width
    // 24rem 上限，app.css:670-672），本锚钉的是夹具语料下的完整可视几何
    const box = await pop.boundingBox();
    const vp = page.viewportSize();
    expect(box).not.toBeNull();
    expect(vp).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(vp!.width);
    expect(box!.y + box!.height).toBeLessThanOrEqual(vp!.height);

    // ③ 常驻模板对照（场景文档 §2.2 ③/§3）：切未超限文件（repo1/crlf.txt，2 提交）
    //    ——说明行同串在场（模板恒显非真值插值；若未来改真值插值/行隐藏，本锚红即
    //    行为变化回写场景文档）。跨目录切换（本 page 只展开过 repo3，repo1 目录行
    //    从未展开——switchFile 只在已展开目录内点文件行，crlf 载体须先展开 repo1；
    //    本 page 未展开过 → 点一次即展开，无「再点折叠」风险）：mobile 左抽屉经
    //    openDrawerIfNarrow 开（BUG-61 点文件后自动收，closeDrawerIfOpened 兜底）
    const drawer = await openDrawerIfNarrow(page);
    await page.locator('.vv-tree-row', { hasText: 'repo1' }).first().click();
    await page.locator('.vv-tree-row', { hasText: 'crlf.txt' }).click();
    await closeDrawerIfOpened(page, drawer);
    await expect(page.locator('.vv-tab.active', { hasText: 'crlf.txt' })).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.vv-code-pre')).toBeVisible({ timeout: 30_000 });
    await ensureRightDrawer(page, true);
    // 切 tab 后 gitInfo 清空重 probe（repo1 目录本 page 未探过 → 真实探测 + worker
    // 链路），hint 渲染条件 phase.commit !== null——30s 与 GIT-02 等待口径一致
    await expect(page.locator('.vv-git-blame-hint')).toHaveText(
      '悬停代码行可查看提交归属；文件历史超 200 提交仅最近 200 参与归属。',
      { timeout: 30_000 }
    );
    // 浮层 note 为真值面（与说明行模板面互补）：未超限文件 blame truncated:false
    // （gitWorker.ts:367）→ 无 note span——超限/未超限两文件「说明行恒显 + 浮层
    // note 真值」双面齐断
    await ensureRightDrawer(page, false);
    await page.hover('.vv-code-line[data-line="0"]');
    await expect(pop).toBeVisible({ timeout: 60_000 });
    await expect(pop).toContainText('second: update a.txt and add crlf', { timeout: 60_000 });
    await expect(pop.locator('.vv-git-blame-pop-note')).toHaveCount(0);
  });

  test('GIT-11 · diff 截断上限：2500 行追加 → 截断尾注 + stat 全量口径钉死 + 渲染集有界 2000', async ({ page }) => {
    test.setTimeout(120_000);
    await mockGitNoise(page);
    const section = await openGitSectionIn(page, 'repo4', 'big-diff.txt');
    // HEAD 1 行 vs 工作区 2501 行（首行相同）→ modified 模式（GitSection.svelte:84-85）
    const foldBtn = section.locator('.vv-git-fold-btn');
    await expect(foldBtn).toContainText('工作区 vs HEAD');
    await foldBtn.click();
    const diff = section.locator('.vv-git-diff');
    await expect(diff).toBeVisible({ timeout: 30_000 });
    // 截断尾注（gitDiff.ts:291-293 note 拼装，DIFF_MAX_ROWS=2000 gitDiff.ts:20）
    await expect(section.locator('.vv-git-diff-trunc')).toContainText('diff 过大已截断（上限 2000 行');
    await expect(section.locator('.vv-git-diff-trunc')).toContainText('仅显示前段');
    // stat = 全量口径（gitDiff.ts:210「全量统计（含截断未显示部分——git diff --stat
    // 同口径）」+ :220「统计为全量（不受截断影响）」）：夹具构造全量 +2500/−0 可预知
    // 钉死。**注意与场景文档 GIT-11 期望②「stat=窗内着色行数」不同**：实读实现为
    // 全量统计知情裁决（git diff --stat 同口径），本锚按实读行为落地——stat 全量
    // 2500 与窗内着色 1999 刻意不等，两面各自钉死；若未来实现改窗内口径，本锚红
    // 即行为变化回写场景文档（文档 §3 GIT-10 同款处置原则）
    await expect(section.locator('.vv-git-diff-stat')).toContainText('+2500');
    await expect(section.locator('.vv-git-diff-stat')).toContainText('−0');
    // 渲染集有界（spec §3.3 渲染层承诺）：恰 2000 行 = 1 ctx（首行同）+ 1999 add
    // （hunk 前扩 3 context 由 op0 起步，行数门恰在第 2000 行收口）+ 0 del；
    // ≈34KB < 200KB bytes 门不参与（纯行数门截断）
    await expect(diff.locator('.vv-git-diff-row')).toHaveCount(2000);
    await expect(diff.locator('.vv-git-diff-row-add')).toHaveCount(1999);
    await expect(diff.locator('.vv-git-diff-row-del')).toHaveCount(0);
    // 窗内内容抽验：首行 ctx 与首个 add 行文本（前段内容 = 夹具构造序）
    await expect(diff.locator('.vv-git-diff-row', { hasText: 'head line 1' })).toBeVisible();
    await expect(diff.locator('.vv-git-diff-row-add').first()).toContainText('big diff line 2');
  });

  test('GIT-12 · untracked diff 提示态：折叠钮「（未跟踪文件无 diff）」+ 展开为 empty note 非空 diff', async ({ page }) => {
    test.setTimeout(90_000);
    await mockGitNoise(page);
    // untracked 文件 log 空列表，openGitSectionIn 的 log 前缀不适用（其注释）——
    // 手写前缀：GIT-03 同款 openFile + 等 .vv-git 可见即数据链全通
    await connect(page);
    await openFile(page, 'repo1', 'new.txt');
    await expect(page.locator('.vv-code-pre')).toBeVisible({ timeout: 30_000 });
    const gitBtn = await waitGitButton(page);
    await gitBtn.click();
    const section = page.locator('.vv-git');
    await expect(section).toBeVisible({ timeout: 30_000 });

    // ① 折叠钮三分支互斥（GitSection.svelte:81-85 diffLabel）：untracked 分支标注。
    //    30s 显式等待 phase ready（diffLabel 在 phase 非 ready 时返回 ''，:82）——本
    //    用例是手写前缀（untracked log 空，无 openGitSectionIn 的 log 前缀隐式等到
    //    phase ready），折叠钮文案要等 isogit chunk 首拉 + worker probe-head/
    //    last-commit 往返，30s 与 GIT-02/GIT-03 的 phase-ready 等待口径一致
    const foldBtn = section.locator('.vv-git-fold-btn');
    await expect(foldBtn).toContainText('（未跟踪文件无 diff）', { timeout: 30_000 });
    await expect(foldBtn).not.toContainText('工作区 vs HEAD');
    await expect(foldBtn).not.toContainText('HEAD^ vs HEAD');
    // ② 展开即提示态（GitSection.svelte:220 同步 empty note，无 worker 调用即现）：
    //    note 文案精确钉死（GitDiffView.svelte:27-28 直显）
    await foldBtn.click();
    const body = section.locator('.vv-git-fold-body');
    await expect(body).toBeVisible();
    await expect(body.locator('.vv-git-note')).toHaveText('未跟踪文件无 diff（HEAD 树无此路径）');
    // 非空 diff 面（场景文档 §2.2 ②）：无 diff 渲染集/着色行/截断尾注、无报错卡——
    // 提示态替代空 diff（spec §3.3），GIT-05/06 正常分支文案锚零翻转
    await expect(body.locator('.vv-git-diff')).toHaveCount(0);
    await expect(body.locator('.vv-git-diff-row')).toHaveCount(0);
    await expect(body.locator('.vv-git-diff-trunc')).toHaveCount(0);
    await expect(body.locator('.vv-git-error')).toHaveCount(0);
  });
});
