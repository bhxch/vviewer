import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import { stopServer, waitHealthy } from '../e2e/serverHarness';

/**
 * 服务端图表 e2e（spec 2026-10-19 §2.5，计划 Task 4）：--compute 实例 comrak 后处理
 * （server/src/compute/diagrams.rs replace_diagram_fences）把原生图表围栏（graphviz/
 * dot/svgbob）替换为契约 div（data-vv-diagram="server" + data-diagram-lang/src，内联
 * 引擎 SVG 含 style），前端管线 wrapServerDiagrams（packages/render-text
 * markdown/pipeline.ts）把它接回 .md-diagram 标准 wrapper——view 收 svg、source 收
 * 原文、切换钮与本地 fence 同构；容器带 data-md-diagram-wrapped（服务端产物的唯一
 * DOM 指纹——本地 fence 路径的 wrapper 不带该属性）。
 *
 * 四用例（viewer.ts hasNonDiagramFence 细化后的 auto 路由矩阵新面）：
 * ① auto 策略纯图表围栏文档路由服务端——服务端产物可见（[data-md-diagram-wrapped]
 *   内 svg）+ 真实 POST /api/compute/markdown 200 + 状态栏「渲染: 远程」（修复前：
 *   auto 含任意围栏即留本地，hasNonDiagramFence 细化前形态）；
 * ② 服务端 svg + 图/源码切换——toggle「源码」→ 源码面板展示原文（getAttribute 经
 *   DOM 解析反解码服务端 escape_attr 实体）、视图隐藏、钮变「图」；
 * ③ 解析失败围栏客户端接手——非法 dot 服务端保留 fence（diagrams.rs 失败保留语义，
 *   parse_failure_leaves_fence_untouched 同源）→ 客户端管线 local 引擎（viz wasm）
 *   渲染失败 → f807636 运行时回退链降 kroki img（abort kroki 定态化，Task 9 承接）
 *   → .md-diagram-view.md-diagram-error「kroki 渲染失败（graphviz）」+ 源码面板同展
 *   原文（DM-01/CDN-02 终点同构）；
 *   「渲染: 远程」仍在——证明文档确实走了远程、失败发生在客户端接手段。
 * ④ svgbob 真实引擎直出 style 端到端存活（终审 C1 钉子）——svgbob 0.7.6 恒在 style
 *   写 `marker-start: url(#arrow)` 等片段引用（修复前 sanitize「含 url( 即整节点丢弃」
 *   把全部 svgbob 服务端图杀掉）：断言 wrapper 内 svg + style 含 url(#arrow) 与
 *   marker 定义，钉住「片段引用放行」穿过真实 sanitize 层。
 *
 * 拓扑：主实例 :4174（webServer，无 compute）不参与；同源 --compute 实例 :4185
 * （beforeAll ensureServe 拉起，afterAll 停止，同 t-cmp.spec.ts:4181 模式——端口错开
 * 既有 4178-4182）承担全部四用例（同源部署无需 CORS/token，契约链端到端走真实
 * POST /api/compute/markdown）。夹具 bcd- 前缀写入共享 fixture 根。
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const BIN = join(repoRoot, 'server/target/release/vviewer');
const WEB_DIST = join(repoRoot, 'apps/web/build');
const FIXTURE = process.env.VV_E2E_SERVER_FIXTURE ?? join(repoRoot, '.temp/e2e-server-fixture');
const PORT_COMPUTE = 4185; // 同源 --compute 实例（本轮专用，错开既有 4174/4178-4182）
const COMPUTE_BASE = `http://127.0.0.1:${PORT_COMPUTE}`;

function spawnServe(port: number, extraArgs: string[]): ChildProcess {
  return spawn(
    BIN,
    ['serve', '--root', FIXTURE, '--web-dist', WEB_DIST, '--port', String(port), ...extraArgs],
    { stdio: ['ignore', 'inherit', 'inherit'] }
  );
}

let computeServer: ChildProcess | null = null;

test.beforeAll(async () => {
  // ---- 夹具（bcd- 前缀，幂等） ----
  mkdirSync(FIXTURE, { recursive: true });
  // ① auto 路由载体：纯图表围栏文档（标题+段落+唯一 dot 围栏，无非图表围栏——
  //    hasNonDiagramFence=false 才放行远程；源样布局参数 layout-rs 未必支持，用
  //    server 单测同款最小 digraph 保证两端引擎都能吃）
  writeFileSync(
    join(FIXTURE, 'bcd-auto-route.md'),
    [
      '# 自动路由',
      '',
      '下图为服务端直出的 graphviz。',
      '',
      '```dot',
      'digraph { auto -> ok }',
      '```',
      ''
    ].join('\n')
  );
  // ② 切换载体：源码可辨识节点名（源码面板断言锚）
  writeFileSync(
    join(FIXTURE, 'bcd-toggle.md'),
    [
      '# 切换样例',
      '',
      '```dot',
      'digraph { src -> view }',
      '```',
      ''
    ].join('\n')
  );
  // ③ 失败接手载体：悬空边 + 未闭花括号——layout-rs 解析失败（服务端保留 fence，
  //    diagrams.rs 单测同形态 `digraph { a ->`），viz（真 graphviz wasm）同样语法报错
  writeFileSync(
    join(FIXTURE, 'bcd-invalid.md'),
    [
      '# 失败接手',
      '',
      '```dot',
      'digraph { broken ->',
      '```',
      ''
    ].join('\n')
  );
  // ④ svgbob 载体（终审 C1 端到端钉子）：含箭头的盒图——svgbob crate 直出 style 恒含
  //    marker-start/end: url(#arrow) 片段引用（0.7.6 固定规则），容器豁免钩子必须放行
  writeFileSync(
    join(FIXTURE, 'bcd-svgbob.md'),
    [
      '# svgbob 样例',
      '',
      '```svgbob',
      '+------+       +------+',
      '|  in  | ----> |  out |',
      '+------+       +------+',
      '```',
      ''
    ].join('\n')
  );

  // ---- 同源 compute 实例（重试安全复用，同 t-cmp.spec.ts 口径） ----
  try {
    if ((await fetch(`${COMPUTE_BASE}/api/health`)).ok) return;
  } catch {
    // 端口空闲
  }
  computeServer = spawnServe(PORT_COMPUTE, ['--compute']);
  await waitHealthy(COMPUTE_BASE);
});

test.afterAll(async () => {
  await stopServer(computeServer, 'bcd-compute');
});

/** 同源连接（页面即 compute 实例伺服；策略经 localStorage 预注入，同 t-cmp gotoWithPolicy） */
async function connectSameOriginCompute(page: Page, policy: 'auto' | 'remote' | 'local'): Promise<void> {
  await page.addInitScript((p) => {
    localStorage.setItem('vviewer:settings', JSON.stringify({ computePolicy: p }));
  }, policy);
  await page.goto(COMPUTE_BASE + '/');
  await page.getByRole('button', { name: '连接服务器' }).click();
  await page.getByLabel('服务器地址').fill(COMPUTE_BASE);
  await page.getByRole('button', { name: '连接', exact: true }).click();
  await expect(page.locator('.vv-tree-row', { hasText: 'bcd-' }).first()).toBeVisible({ timeout: 10_000 });
}

async function openFile(page: Page, name: string): Promise<void> {
  await page.locator('.vv-tree-row', { hasText: name }).first().click();
  await expect(page.locator('.vv-tab.active', { hasText: name })).toBeVisible({ timeout: 10_000 });
}

test('服务端图表①: auto 策略纯图表围栏文档路由服务端——契约 div 接回 wrapper（svg+wrapped 标记）+ markdown 真实远程 POST + 「渲染: 远程」', async ({
  page
}) => {
  test.setTimeout(120_000);
  // 观测真实远程渲染请求（auto 路由服务端的直接证据）
  const mdPosts: number[] = [];
  page.on('response', (r) => {
    if (r.request().method() === 'POST' && r.url().includes('/api/compute/markdown')) {
      mdPosts.push(r.status());
    }
  });

  await connectSameOriginCompute(page, 'auto');
  await openFile(page, 'bcd-auto-route.md');

  // ① 真实远程 POST 发生且成功（缺陷态：auto 含围栏即留本地，零 POST——router 只在
  //    裁决 remote 时才提供 remoteFn，POST 存在即路由成立的直接证据；POST 在 tab
  //    激活后异步完成，poll 轮询而非同步断言）
  await expect
    .poll(() => mdPosts.length, { timeout: 30_000, message: 'POST /api/compute/markdown 应发生' })
    .toBeGreaterThan(0);
  for (const s of mdPosts) expect(s, '远程 markdown 全部 200').toBe(200);

  // ② 服务端产物可见：契约 div 被 wrapServerDiagrams 接回标准 wrapper——
  //    data-md-diagram-wrapped 是服务端产物唯一 DOM 指纹（本地 fence wrapper 不带），
  //    svg 在视图面板内；原 fence 不再以 pre>code 存在（服务端已替换，客户端未重渲染）
  const product = page.locator('.md-diagram-view [data-md-diagram-wrapped]');
  await expect(product).toBeVisible({ timeout: 30_000 });
  await expect(product.locator('svg')).toHaveCount(1);
  await expect(page.locator('.md-diagram-view pre code')).toHaveCount(0);

  // ③ 状态栏引擎指示：远程（getEngine=where 的既有展示；缺陷态为「渲染: 本地」）
  const sb = page.locator('.vv-statusbar');
  await expect(sb).toContainText('渲染: 远程', { timeout: 30_000 });
  await expect(sb).not.toContainText('渲染: 本地');
});

test('服务端图表②: 服务端 svg + 图/源码切换——toggle 展示原文（实体反解码），再切回图', async ({ page }) => {
  test.setTimeout(120_000);
  await connectSameOriginCompute(page, 'auto');
  await openFile(page, 'bcd-toggle.md');

  // 服务端产物落位（同①指纹）
  const wrap = page.locator('.md-diagram', { has: page.locator('[data-md-diagram-wrapped]') });
  await expect(wrap).toBeVisible({ timeout: 30_000 });
  const view = wrap.locator('.md-diagram-view');
  await expect(view.locator('svg')).toHaveCount(1);
  // 引擎 <style> 随 sanitize 上下文豁免保留（layout-rs 字体规则，diagrams.rs 单测同锚）
  await expect(view.locator('[data-md-diagram-wrapped] style')).toHaveCount(1);
  // 源码面板初始隐藏，切换钮为「源码」
  const sourcePane = wrap.locator('.md-diagram-source');
  await expect(sourcePane).toBeHidden();
  const toggle = wrap.locator('.md-diagram-toggle');
  await expect(toggle).toHaveText('源码');

  // 切到源码：视图隐藏、源码面板展示原文（服务端 escape_attr 实体经 DOM 解析反解码）
  await toggle.click();
  await expect(sourcePane).toBeVisible();
  await expect(sourcePane).toContainText('digraph { src -> view }');
  await expect(view).toBeHidden();
  await expect(toggle).toHaveText('图');

  // 切回图：视图恢复
  await toggle.click();
  await expect(view).toBeVisible();
  await expect(sourcePane).toBeHidden();
  await expect(toggle).toHaveText('源码');
});

test('服务端图表③: 非法 dot 解析失败服务端保留 fence→客户端 local 引擎接手失败降 kroki img→错误卡+源码同展', async ({
  page
}) => {
  test.setTimeout(120_000);
  // 回退链终点定态化（Task 9 承接，MD-04 同款注记）：viz 失败后有 krokiType 降级
  // kroki img——本环境浏览器网络栈对 kroki.io 黑洞（连接挂起不回包不报错，实测
  // img 3 分钟无 onload/onerror），真网往返时序不可依赖；abort kroki 确定性令
  // img error 落错误卡，锚定「local 接手失败→错误卡+原文」的测试本意
  await page.route('**/kroki.io/**', (route) => route.abort());
  await connectSameOriginCompute(page, 'auto');
  await openFile(page, 'bcd-invalid.md');

  // 远程仍成立（comrak 正文渲染成功——失败只在图表围栏）：状态栏「渲染: 远程」，
  // 证明 fence 是服务端失败保留后由客户端管线接手，而非整篇留本地
  const sb = page.locator('.vv-statusbar');
  await expect(sb).toContainText('渲染: 远程', { timeout: 30_000 });

  // 服务端失败保留 → 无契约 div/无 wrapped 标记；客户端 fence 路径构造 wrapper
  //（语言徽标为注册表 type.id=graphviz——别名 dot 已归一，与服务端路径的原文
  // data-diagram-lang=dot 相区分）→ local 引擎 viz 渲染非法 dot 抛错 → 降级 kroki
  // img（abort 即 error）→ 错误卡；原文同展于源码面板（f807636 运行时回退链后
  // 失败终点 = kroki 文案卡 + 源码同展，DM-01/CDN-02 终点同构——Task 9 承接同步锚）
  await expect(page.locator('[data-md-diagram-wrapped]')).toHaveCount(0);
  const errView = page.locator('.md-diagram-view.md-diagram-error');
  await expect(errView).toBeVisible({ timeout: 30_000 });
  await expect(errView).toHaveText('kroki 渲染失败（graphviz）');
  const wrap = page.locator('.vv-markdown .md-diagram').first();
  await expect(wrap.locator('.md-diagram-source')).toBeVisible();
  await expect(wrap.locator('.md-diagram-source')).toContainText('digraph { broken ->');
  await expect(wrap.locator('.md-diagram-toggle')).toHaveText('图');
  await expect(page.locator('.md-diagram-lang', { hasText: 'graphviz' })).toBeVisible();
});

test('服务端图表④: svgbob 直出 style 端到端存活——url(#arrow) 片段引用穿过 sanitize（终审 C1 钉子）', async ({
  page
}) => {
  test.setTimeout(120_000);
  await connectSameOriginCompute(page, 'auto');
  await openFile(page, 'bcd-svgbob.md');

  // 服务端 svgbob 渲染落位：契约 div 接回 wrapper、svg 进视图面板
  const view = page.locator('.md-diagram-view [data-md-diagram-wrapped]');
  await expect(view).toBeVisible({ timeout: 30_000 });
  await expect(view.locator('svg')).toHaveCount(1);
  // 真实引擎 style 存活：svgbob 固定描边规则（线条样式）+ 箭头 marker 片段引用——
  // 修复前「含 url( 即整节点丢弃」会连 style 一起杀（线条全消失，缺陷态 style 计数 0）
  const style = view.locator('style');
  await expect(style).toHaveCount(1);
  await expect(style).toContainText('stroke: black');
  await expect(style).toContainText('marker-start: url(#arrow)');
  await expect(style).toContainText('marker-end: url(#arrow)');
  // 同文档引用目标（<marker id="arrow">）随 svg 存在，引用可解析
  await expect(view.locator('svg marker#arrow')).toHaveCount(1);
});
