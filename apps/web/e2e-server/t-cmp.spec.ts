import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import { stopServer, waitHealthy } from '../e2e/serverHarness';

/**
 * compute-global-search 域补缺 · 本轮新增（t- 前缀，docs/e2e/compute-global-search.md）。
 * 缺口口径见 e2e 域盘点（2026-10-10）：既有覆盖 b-compute-global-search-server.spec.ts
 * 已锚定 CMP-02 主链路 / CMP-03 指示 / CMP-04 / CMP-06~12，本文件只补四条缺口，不重写：
 *
 * - CMP-01/2：/api/health 的 computeLanguages 宣告端到端锚点——设计文档
 *   （2026-10-09-full-grammar-alignment-design.md L56/L125）阶段 1 验收「health 宣告
 *   301」，此前仅 server 单测覆盖（queries.rs:288 长度 301、health.rs:152 排序+抽样），
 *   两个 e2e 套件零断言。compute 实例断言 301 条 + canonical 排序 + 集内抽样；
 *   无 --compute 对照实例断言字段整体省略（health.rs:58 单测同口径）。
 * - CMP-02/2：BUG-10 验收 2「关标签重开二次打开可观测更快（(path,mtime,size) 缓存）」
 *   占位（test.fixme）——实现裁决记录（域文档 L66）：服务端 intervals 缓存与 gzip 随
 *   spec 未决 #6 顺延，现状必失败；缓存落地后转正式断言。
 * - CMP-03/2：BUG-22 验收 3 路由矩阵重锚定——原矩阵「rs/go/c/cpp/java/sql→hljs 兜底·
 *   本地」系阶段 1（injections 接线）/阶段 3（auto 不限大小走服务端，文档 L67/L131）
 *   之前的实测；按新契约这些 server-served 宣告集内语言在 auto 下应走 tree-sitter·远程。
 *   既有用例（b-compute-global-search-server.spec.ts:308）仅抽样 py，本用例补原本地组。
 * - CMP-05：同文档 remote/local 两次渲染 DOM 指纹一致（验收①②）——既有覆盖仅有
 *   comrak 直连（m6.spec.ts:180）与 remote 渲染（m6.spec.ts:218），无本地对照。
 *   样例为无围栏 GFM（表格/任务列表/删除线）：围栏会触发本地二级高亮扰动指纹；
 *   数学内容属偏差 #6 已裁决范围，样例不含。comrak 与本地 markdown-it 产物均经
 *   同一 sanitize+enrich 管线（apps/web/src/lib/viewer.ts:104）。首轮执行分诊：
 *   remote 轮护栏全过，local 轮 del 断言 0 命中——删除线双引擎标签不一致
 *   （本地 <s> vs 远程 <del>，同 CAND-md-F1 缺陷类）直接破坏指纹一致验收①②，
 *   整用例转 fixme（CAND-cmp-F1，断言原强度保留）。
 *
 * 拓扑：主实例 :4174（webServer 自带，无 compute）承担 CMP-01 对照半；
 * 同源 --compute 实例 :4181（beforeAll ensureServe 拉起，afterAll 停止，同
 * b-compute-global-search-server.spec.ts:46-47 模式，端口错开其 4178/4179/4180）
 * 承担宣告/矩阵/指纹——同源部署 X-VV-Lang 无需 CORS expose，宣告门语义完整
 * （跨源边界见该文件 CMP-02 描述组 jsonc 用例注释）。夹具 tcmp- 前缀写入共享
 * fixture 根，与既有 cg- 前缀互不干扰。
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const BIN = join(repoRoot, 'server/target/release/vviewer');
const WEB_DIST = join(repoRoot, 'apps/web/build');
const FIXTURE = process.env.VV_E2E_SERVER_FIXTURE ?? join(repoRoot, '.temp/e2e-server-fixture');
const BASE = 'http://127.0.0.1:4174'; // webServer 主实例（无 compute）
const PORT_COMPUTE = 4181; // 同源 --compute 实例（本轮专用）
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
  // ---- 夹具（tcmp- 前缀，幂等） ----
  mkdirSync(FIXTURE, { recursive: true });
  // CMP-05：无围栏 GFM 样例（表格 + 任务列表 + 删除线；不含数学——偏差 #6 已裁决范围）
  writeFileSync(
    join(FIXTURE, 'tcmp-md-gfm.md'),
    [
      '# 指纹样例',
      '',
      '普通段落，含 **粗体**、*斜体* 与 ~~删除线文本~~。',
      '',
      '| 设备 | 状态 |',
      '| --- | --- |',
      '| 传感器 A | 在线 |',
      '| 传感器 B | 离线 |',
      '',
      '- [x] 已完成任务',
      '- [ ] 待办任务',
      ''
    ].join('\n')
  );
  // CMP-02/2 占位载体（>2MiB，同 b-compute 的 cg-code-3mb.js 口径）
  writeFileSync(join(FIXTURE, 'tcmp-code-3mb.js'), 'const vv = 1; // c\n'.repeat(160_000));
  // CMP-03/2：原矩阵「hljs 兜底·本地」组抽样（canonical 名已对生成物
  // server/target/release/build/*/out/grammar_entries.rs 核验在 301 集内）
  writeFileSync(join(FIXTURE, 'tcmp-matrix.rs'), 'fn main() {\n    let a = 42;\n    println!("v={a}");\n}\n');
  writeFileSync(join(FIXTURE, 'tcmp-matrix.go'), 'package main\n\nimport "fmt"\n\nfunc main() {\n\ta := 42\n\tfmt.Println(a)\n}\n');
  writeFileSync(join(FIXTURE, 'tcmp-matrix.c'), '#include <stdio.h>\n\nint main(void) {\n    int a = 42;\n    printf("%d\\n", a);\n    return 0;\n}\n');
  writeFileSync(join(FIXTURE, 'tcmp-matrix.cpp'), '#include <iostream>\n\nint main() {\n    int a = 42;\n    std::cout << a << std::endl;\n    return 0;\n}\n');
  writeFileSync(join(FIXTURE, 'tcmp-matrix.java'), 'public class TcmpMatrix {\n    public static void main(String[] args) {\n        int a = 42;\n        System.out.println(a);\n    }\n}\n');
  writeFileSync(join(FIXTURE, 'tcmp-matrix.sql'), 'SELECT id, name FROM devices WHERE status = 1;\n');

  // ---- 同源 compute 实例（重试安全复用，同 b-server-file-service 口径） ----
  try {
    if ((await fetch(`${COMPUTE_BASE}/api/health`)).ok) return;
  } catch {
    // 端口空闲
  }
  computeServer = spawnServe(PORT_COMPUTE, ['--compute']);
  await waitHealthy(COMPUTE_BASE);
});

test.afterAll(async () => {
  await stopServer(computeServer, 'tcmp-compute');
});

/** 同源连接（页面即 compute 实例伺服；策略经 localStorage 预注入，同 m6 gotoWithPolicy） */
async function connectSameOriginCompute(page: Page, policy: 'auto' | 'remote' | 'local'): Promise<void> {
  await page.addInitScript((p) => {
    localStorage.setItem('vviewer:settings', JSON.stringify({ computePolicy: p }));
  }, policy);
  await page.goto(COMPUTE_BASE + '/');
  await page.getByRole('button', { name: '连接服务器' }).click();
  await page.getByLabel('服务器地址').fill(COMPUTE_BASE);
  await page.getByRole('button', { name: '连接', exact: true }).click();
  await expect(page.locator('.vv-tree-row', { hasText: 'tcmp-' }).first()).toBeVisible({ timeout: 10_000 });
}

async function openFile(page: Page, name: string): Promise<void> {
  await page.locator('.vv-tree-row', { hasText: name }).first().click();
  await expect(page.locator('.vv-tab.active', { hasText: name })).toBeVisible({ timeout: 10_000 });
}

test('CMP-01/2: --compute 实例 health computeLanguages 宣告 301 条（排序+集内抽样），无 --compute 实例字段整体省略', async () => {
  test.setTimeout(60_000);
  // ① compute 实例（:4181）：capabilities 尾部追加 + computeLanguages 301
  const withCompute = (await (await fetch(`${COMPUTE_BASE}/api/health`)).json()) as {
    capabilities: string[];
    computeLanguages?: string[];
  };
  expect(withCompute.capabilities).toEqual(['file-server', 'compute']);
  const langs = withCompute.computeLanguages;
  expect(Array.isArray(langs)).toBe(true);
  expect(langs).toHaveLength(301); // 与 server/src/compute/queries.rs:288 单测同源锚定（设计文档 L125）
  expect(JSON.stringify(langs)).toBe(JSON.stringify([...langs!].sort())); // canonical 排序（health.rs:156 同口径）
  for (const name of ['rust', 'python', 'go', 'cpp', 'java', 'sql']) {
    expect(langs).toContain(name);
  }

  // ② 对照（:4174 主实例，无 --compute）：仅 file-server，computeLanguages 字段整体省略
  const bare = (await (await fetch(`${BASE}/api/health`)).json()) as Record<string, unknown>;
  expect(bare['capabilities']).toEqual(['file-server']);
  expect('computeLanguages' in bare).toBe(false);
});

test.fixme(
  'CMP-02/2: 同文件关标签重开二次打开可观测更快（(path,mtime,size) intervals 缓存）',
  async ({ page }) => {
    // 占位原因（域文档 L66 实现裁决记录）：验收 2 的服务端 intervals 缓存与 gzip 随
    // spec 未决 #6 顺延——现状二次打开仅快 7.6~8% 且有波动、响应体 17MB 级无缓存
    // 字段，下述断言现状必失败。缓存落地后去掉 fixme 转正式断言。
    test.setTimeout(300_000);
    // 收集每次高亮 POST 的响应体大小（intervals 本体；缓存命中后二次应显著更小）
    const postSizes: number[] = [];
    page.on('response', async (r) => {
      if (r.request().method() === 'POST' && r.url().includes('/api/compute/highlight')) {
        try {
          postSizes.push((await r.body()).length);
        } catch {
          // body 可能已不可取（页面导航），跳过该次
        }
      }
    });

    await connectSameOriginCompute(page, 'remote');
    for (let round = 0; round < 2; round++) {
      const before = postSizes.length;
      await openFile(page, 'tcmp-code-3mb.js');
      await expect(page.locator('.vv-statusbar')).toContainText('执行: 远程', { timeout: 120_000 });
      await expect.poll(() => postSizes.length, { timeout: 10_000 }).toBeGreaterThan(before);
      // 关标签重开（复现验收「同文件关标签重开」口径；关闭钮 aria-label 见 TabBar.svelte:31）
      await page.getByRole('button', { name: '关闭 tcmp-code-3mb.js' }).click();
      await expect(page.locator('.vv-tab', { hasText: 'tcmp-code-3mb.js' })).toHaveCount(0);
    }

    // 二次打开命中缓存：响应体显著小于首次（首次≈intervals 本体 17MB 级）
    expect(postSizes.length).toBe(2);
    expect(postSizes[0]).toBeGreaterThan(1_000_000);
    expect(postSizes[1]).toBeLessThan(postSizes[0] * 0.5);
  }
);

test('CMP-03/2: 路由矩阵重锚定——原「hljs 兜底·本地」组 rs/go/c/cpp/java/sql 在 auto 下走 tree-sitter·远程', async ({
  page
}) => {
  test.setTimeout(180_000);
  await connectSameOriginCompute(page, 'auto');
  const sb = page.locator('.vv-statusbar');

  // 阶段 3 契约：auto 下 server-served 文件不限大小走服务端，前提过宣告门
  //（capabilities 含 compute + 语言已在 computeLanguages 宣告，六种语言均集内）。
  // 修复前矩阵（报告 §2.4 时代）这些语言落「hljs 兜底 · 执行: 本地」。
  for (const name of [
    'tcmp-matrix.rs',
    'tcmp-matrix.go',
    'tcmp-matrix.c',
    'tcmp-matrix.cpp',
    'tcmp-matrix.java',
    'tcmp-matrix.sql'
  ]) {
    await openFile(page, name);
    await expect(sb).toContainText('高亮: tree-sitter', { timeout: 30_000 }); // 修复前：高亮: hljs 兜底
    await expect(sb).toContainText('执行: 远程', { timeout: 30_000 }); // 修复前：执行: 本地
    await expect(sb).not.toContainText('hljs');
  }
});

/** 抓 .vv-markdown 的 DOM 指纹：tag+类名结构序列（类名排序归一化）+ 空白规范化全文 */
type MdFingerprint = { structure: string[]; text: string };

async function readMarkdownFingerprint(page: Page): Promise<MdFingerprint> {
  return page.evaluate(() => {
    const root = document.querySelector('.vv-markdown');
    if (!root) throw new Error('.vv-markdown 不存在');
    const structure = Array.from(root.querySelectorAll('*')).map((el) => {
      const cls =
        typeof el.className === 'string' && el.className.trim() !== ''
          ? '.' + el.className.trim().split(/\s+/).sort().join('.')
          : '';
      return el.tagName.toLowerCase() + cls;
    });
    const text = (root.textContent ?? '').replace(/\s+/g, ' ').trim();
    return { structure, text };
  });
}

test.fixme(
  'CMP-05 [CAND-cmp-F1]: 同文档 remote/local 两次渲染 DOM 指纹一致（无围栏 GFM：表格/任务列表/删除线）',
  async ({ browser }) => {
    // CAND-cmp-F1（产品缺陷，2026-10-10 分诊转 fixme，断言不放宽）：
    // 首轮执行 remote 轮护栏全过（comrak <del> 经 sanitize 存活，del 计数 1），
    // local 轮 del 断言 0 命中（error-context 状态栏「渲染: 本地」）——本地
    // markdown-it 15.0.2（packages/render-text/package.json:13）把 ~~x~~ 渲染为
    // <s> 而非 <del>（v13 起默认标签 del→s；本仓库同 engine.ts:21 配置 node 实测
    // 输出 <s>删除线文本</s>），与远程 comrak 的 <del>（server/src/compute/markdown.rs:19）
    // 双引擎不一致。sanitize 为 DOMPurify 默认标签表（sanitize.ts:124-128）、enrich
    // 无 del/s 归一，结构指纹必然差一个标签——即使撤掉 del 护栏，验收①②「指纹一致」
    // 在指纹对比断言处同样失败。违反场景文档 §3 CMP-05 判据①②，与 t-md 的
    // CAND-md-F1 同一缺陷类（该裁决给出修复方向：本地引擎 renderer rule 把
    // strikethrough_open/close 输出 del，与 comrak/GFM 对齐；修复后本用例转正）。
    test.setTimeout(180_000);
    const fingerprints: MdFingerprint[] = [];

    for (const policy of ['remote', 'local'] as const) {
      const page = await browser.newPage();
      await connectSameOriginCompute(page, policy);
      await openFile(page, 'tcmp-md-gfm.md');

      // 引擎指示随策略切换（验收①②口径：计算: 远程 / 计算: 本地）
      const sb = page.locator('.vv-statusbar');
      await expect(sb).toContainText(policy === 'remote' ? '渲染: 远程' : '渲染: 本地', { timeout: 30_000 });
      await expect(sb).not.toContainText(policy === 'remote' ? '渲染: 本地' : '渲染: 远程');

      // 关键结构护栏先行（等待渲染管线含 enrich 落定再采指纹）
      const md = page.locator('.vv-markdown');
      await expect(md.locator('table tr')).toHaveCount(3); // 表头 1 + 数据 2
      await expect(md.locator('li.task-list-item')).toHaveCount(2); // comrak li 无类由前端 enrich 归一化（m6.spec.ts:186-188）
      await expect(md.locator('input[type="checkbox"]')).toHaveCount(2);
      await expect(md.locator('del')).toHaveCount(1);
      fingerprints.push(await readMarkdownFingerprint(page));
      await page.close();
    }

    // 验收①②：remote（comrak）与 local（markdown-it）经同一 sanitize+enrich 管线，指纹一致
    expect(fingerprints[1].structure).toEqual(fingerprints[0].structure);
    expect(fingerprints[1].text).toBe(fingerprints[0].text);
  }
);

