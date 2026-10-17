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
 * - CMP-02/2：BUG-10 验收 2「关标签重开二次打开可观测更快」——服务端响应缓存
 *   （highlight.rs 64 条 LRU）+ cacheId 会话校验协议（2026-10-17 spec 未决 #6
 *   清偿）：重开同 (path,lang,range) 回传令牌命中极小帧，不重复传输 intervals
 *   本体。断言按阶段 4 range chunk 契约重锚（同签名 chunk 二次体 < 首次 50%）。
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
  // BUG-56 载体：4 行 jsonc（∉ 服务端 301 宣告集；显式 remote 策略下 POST
  // /api/compute/highlight 真实 400——宣告门只在 auto 前置拦截，remote 不拦）
  writeFileSync(
    join(FIXTURE, 'tcmp-remote-fail.jsonc'),
    '{\n  "vv": "remote-fail", // jsonc\n  "n": 1\n}\n'
  );
  // BUG-57 载体：60 行 "vvneedle line N"（单文件命中数超服务端 RG_MAX_COUNT=50；
  // vvneedle 为本 spec 专属词，避免共享 fixture 其他夹具干扰命中计数）
  writeFileSync(
    join(FIXTURE, 'tcmp-many60.txt'),
    Array.from({ length: 60 }, (_, i) => `vvneedle line ${i + 1}`).join('\n') + '\n'
  );

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

test(
  'CMP-02/2: 同文件关标签重开二次打开可观测更快（(path,mtime,size) 服务端缓存 + cacheId 会话校验极小帧）',
  async ({ page }) => {
    // 验收 2（BUG-10）：「同文件关标签重开，二次打开可观测地更快」。实现落点
    // （spec 未决 #6 清偿，2026-10-17）：服务端响应缓存早已落地（highlight.rs 64 条
    // LRU，键 (canonical_path, mtime, size, lang, startLine, lineCount)），本轮补
    // cacheId 会话校验协议——客户端重开同 (path,lang,range) 时回传上次响应令牌，
    // 服务端校验一致即回 `{"cached":true,"cacheId","baseLine"}` 极小帧，不再重复
    // 传输 intervals 本体（客户端复用其会话缓存，apps/web highlightRouter.ts）。
    // 断言按阶段 4 range 契约重锚（原「17MB 整文件单 POST」系阶段 4 之前的旧
    // 形态；3MB 文件现行走可视区 chunk 请求），验收意图不变：同签名 chunk 的
    // 二次响应体 < 首次 50%（intervals 本体 → 极小帧）。
    test.setTimeout(300_000);
    // 收集每次高亮 POST 响应体大小，按请求签名 (path|startLine|lineCount) 分组
    const postBodies = new Map<string, number[]>();
    page.on('response', async (r) => {
      if (r.request().method() === 'POST' && r.url().includes('/api/compute/highlight')) {
        const raw = r.request().postData() ?? '';
        let sig = raw;
        try {
          const b = JSON.parse(raw) as {
            path?: string;
            range?: { startLine: number; lineCount: number };
          };
          sig = `${b.path ?? ''}|${b.range?.startLine ?? ''}|${b.range?.lineCount ?? ''}`;
        } catch {
          // 签名解析失败保底用原文
        }
        try {
          const size = (await r.body()).length;
          postBodies.set(sig, [...(postBodies.get(sig) ?? []), size]);
        } catch {
          // body 可能已不可取（页面导航），跳过该次
        }
      }
    });

    await connectSameOriginCompute(page, 'remote');
    for (let round = 0; round < 2; round++) {
      const postCount = () => [...postBodies.values()].reduce((n, a) => n + a.length, 0);
      const before = postCount();
      await openFile(page, 'tcmp-code-3mb.js');
      await expect(page.locator('.vv-statusbar')).toContainText('执行: 远程', { timeout: 120_000 });
      await expect.poll(postCount, { timeout: 10_000 }).toBeGreaterThan(before);
      // 关标签重开（复现验收「同文件关标签重开」口径；关闭钮 aria-label 见 TabBar.svelte:31）
      await page.getByRole('button', { name: '关闭 tcmp-code-3mb.js' }).click();
      await expect(page.locator('.vv-tab', { hasText: 'tcmp-code-3mb.js' })).toHaveCount(0);
    }

    // 二次打开命中会话缓存：至少一个 chunk 签名两轮各一次 POST，且二次响应体
    // 显著小于首次（首次=intervals 本体，二次=服务端确认极小帧）
    const pairs = [...postBodies.entries()].filter(([, sizes]) => sizes.length >= 2);
    expect(pairs.length, '至少一个 chunk 签名被二次请求').toBeGreaterThan(0);
    for (const [sig, sizes] of pairs) {
      expect(sizes[0]!, `签名 ${sig} 首次为 intervals 本体`).toBeGreaterThan(1_000);
      expect(sizes[1]!, `签名 ${sig} 二次命中缓存极小帧`).toBeLessThan(sizes[0]! * 0.5);
    }
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

test(
  'CMP-05 [BUG-67]: 同文档 remote/local 两次渲染 DOM 指纹一致（无围栏 GFM：表格/任务列表/删除线）',
  async ({ browser }) => {
    // BUG-67（=CAND-cmp-F1，2026-10-10 分诊转 fixme，2026-10-17 清偿转正）：
    // 根因是本地 markdown-it 15.0.2 把 ~~x~~ 渲染为 <s>（v13 起默认 del→s）而远程
    // comrak 出 <del>（server/src/compute/markdown.rs ext.strikethrough），双引擎
    // DOM 指纹必然差一个标签。修复：本地引擎 renderer rule 把 strikethrough_open/
    // close 输出 <del>（packages/render-text/src/markdown/engine.ts，GFM 规范推荐
    // 标签，与 comrak 对齐）；sanitize 为 DOMPurify 默认标签表（del/s 均在表内）、
    // enrich 无 del/s 归一需求——标签级对齐后指纹一致。
    // 跨域编号对照（勿再互改）：同一删除线缺陷按 md 域权威清单定档 BUG-66——锚点
    // t-md.spec.ts 'BUG-66 [探索]'（场景用例 'MD-01/2 [CAND-md-F1]' 判据同源）。
    // 按 BUG-67 检索落本条，按 BUG-66/CAND-md-F1 检索落 t-md 侧锚点；他域锚点
    // 编号归承载域清单，双向不改写。
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
    expect(fingerprints[1]!.structure).toEqual(fingerprints[0]!.structure);
    expect(fingerprints[1]!.text).toBe(fingerprints[0]!.text);
  }
);

// ── 代码高亮域探索复核确认缺陷回归占位（2026-10-10 编号勘误轮补落；即 t-hl.spec.ts
// 「BUG-33~38/65 批次」节注释所指的本文件落点）──
// BUG-33 / BUG-36 根因在 server/src/compute/highlight.rs（服务端 compute 高亮链路），
// 按根因归属落本文件（README §3.2.1 一域一文件；需 spawn 二进制 / 直呼 compute API 的
// 断言归 e2e-server）。来源标注 [探索]：hl 域探索复核会话独立复现确认。注意两条缺陷态
// 都会破坏/拖垮共享 :4181 compute 实例，转正前保持 test.fixme，不与其他用例同跑。

test.fixme('BUG-33 [探索]: lang=djot 高亮含命中内容文本使服务端 SIGSEGV——单请求杀死整个 vviewer（文件服务+compute 同时不可用直至重启）', async () => {
  // 复核成立（severity high，text/path/range 三模式实测全触发，崩溃+功能完全不可用）。
  // 根因：run_highlight 直接调 tree-sitter-highlight C 层 Highlighter::highlight
  // （server/src/compute/highlight.rs:147-156），djot 语法在 C 层触发段错误；:297
  // parse_with_timeout 的响应侧超时保护对 SIGSEGV 无效（Rust panic 捕获亦不适用于段
  // 错误），日志无任何 panic/错误痕迹。三模式汇合点 spawn_blocking（highlight.rs:525）。
  // 复现工艺：实例启动后 queries 懒编译 301 语言需约 6~8s（服务日志可见编译 WARN），
  // 编译未就绪时请求表现为连接失败假象——需「health 200 + 任一无害高亮请求 200」双就绪。
  // 最小复现：curl -X POST /api/compute/highlight -H 'content-type: application/json'
  //   -d '{"text":"# Heading\n","lang":"djot"}' → curl 000 + shell 打印 'Segmentation
  //   fault (core dumped)'、进程退出码 139（128+11），随后 /api/health 连接失败、进程消失。
  //   最小触发文本另有 'text **bold**\n' 与 '`code`\n'（bisect 逐变体重启验证 4/4 全崩）；
  //   对照：纯文本 'x\n'/'Heading\n'/'#x\n' 不崩（200 零区间），同文本换 lang=markdown
  //   200 正常区间；path 模式（a.dj）与 range 模式（startLine 0/lineCount 10）同 139；
  //   coredumpctl 记三实例 PID 均 'SIGSEGV present'。
  // 证据（复核轮独立取得，release 二进制 --compute 端口 8441~8449 多实例）：
  //   apps/web/.temp/explore-hl/bisect-djot.sh（逐变体重启验证）；源码定位
  //   server/src/compute/highlight.rs:147-156、:525。
  // 修复方向：tree-sitter-highlight 升级/换 djot 生成物，或 run_highlight 前置拦该输入类
  // （子进程隔离/语法白名单验证）；修复后本用例转正。
  test.setTimeout(120_000);
  // 双就绪门：懒编译完成前请求呈连接失败假象，轮询无害高亮至 200 再触发（上限 30s）
  let warmOk = false;
  for (let i = 0; i < 30 && !warmOk; i++) {
    try {
      const warm = await fetch(`${COMPUTE_BASE}/api/compute/highlight`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'const a = 1;\n', lang: 'javascript' })
      });
      warmOk = warm.ok;
    } catch {
      await new Promise((r) => setTimeout(r, 1_000));
    }
  }
  expect(warmOk).toBe(true);
  // 缺陷触发（最小触发文本之一；text 模式即达 C 层，path/range 同根因不重复展开）
  const res = await fetch(`${COMPUTE_BASE}/api/compute/highlight`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '# Heading\n', lang: 'djot' })
  });
  // 修复判据 1：djot 高亮正常返回（缺陷态：服务端进程立即 SIGSEGV，本请求连接层失败）
  expect(res.status).toBe(200);
  // 修复判据 2：服务端进程仍存活——文件服务+compute 不被单请求带走（缺陷态：/api/health
  // 连接失败、退出码 139）
  expect((await fetch(`${COMPUTE_BASE}/api/health`)).ok).toBeTruthy();
});

test('BUG-36 [探索]: 服务端 compute 高亮多区间超长单行不触超时——456KB 单行 json 200 且远低于 10s 预算', async () => {
  // 2026-10-10 复核成立（medium，text/path/range 三模式同病）；2026-10-17 清偿转正。
  // 根因：Utf16Index::to_utf16 按行建表 + 行内逐字符累加为 O(行长)（行长=全文时
  // 每次 O(n)），区间数 O(n) 的单行输入整体 O(n²)——实测 minified 形态 50KB
  // /2.6 万区间即 10s+（解析线程满核空转、响应 504，纯文本对照线性）。
  // 修复：Utf16Index 改字符边界前缀表（2×u32/字符，末尾哨兵），查询二分
  // O(log n)——release 实测多区间单行 285KB/14.9 万区间 15.0s → 0.21s（~70x，
  // 区间数翻倍耗时线性）。区间数上限 MAX_INTERVALS=2M 与 10s 响应预算不变。
  // 判据：单行 ~456KB json 200 且耗时显著低于 10s 预算；阈值 9.5s 仅拦截超时
  // 形态，二次方→线性的量化断言归性能套件。
  test.setTimeout(60_000);
  const name = 'tcmp-oneline-446kb.json';
  // 单行（无换行符）~456KB json 缺陷形态载体（测试体内自建，幂等，不动 beforeAll 夹具）
  writeFileSync(join(FIXTURE, name), '{"k":"' + 'x'.repeat(456_000) + '"}');
  const t0 = Date.now();
  const res = await fetch(`${COMPUTE_BASE}/api/compute/highlight`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: name, lang: 'json' })
  });
  expect(res.status).toBe(200);
  expect(Date.now() - t0).toBeLessThan(9_500);
});

// ── 计算卸载与全局搜索域探索复核确认缺陷回归占位（2026-10-10 编号勘误轮补落）──
// BUG-56 / BUG-57 由 cmp 域缺陷清单（2026-10-10 探索复核）确认，全仓库此前无任何占位
// 锚点（rg 两 e2e 目录全量核对），按清单落位规则新增于本文件（需 spawn 二进制 / API
// 断言的归 e2e-server；复用上方 :4181 同源 compute 实例拓扑与 helper）。来源标注
// [探索]：缺陷由探索/复核会话独立复现确认。转正前保持 test.fixme（修复 PR 转正）。

test(
  'BUG-56 [探索]: 显式 remote 策略远程高亮失败后 engine 置终值——状态栏不停留「解析中…」、不补出「执行: 远程」（与大文件 chunk 失败路径口径一致）',
  async ({ page }) => {
    // 2026-10-10 复核成立（low）；2026-10-17 清偿转正。缺陷态：整文件主路径
    // jsonc（∉ 301 宣告集）显式 remote 下 POST /api/compute/highlight 真实 400
    // （RemoteComputeError → 错误卡片）后直接 return，engine 停留初始 'pending'
    // （状态栏「高亮: 解析中…」永久驻留）且 computeWhere 停留请求期回填的
    // 'remote'（:242 补出「执行: 远程」不自愈）——与大文件 chunk 失败路径
    // （engine='plain' + computeWhere=null，状态栏「纯文本」、无执行段）口径不一。
    // 修复：packages/render-text/src/code.ts 整文件 tree-sitter 主路径
    // RemoteComputeError catch 分支补置终值（engine='plain' + computeWhere=null，
    // 错误卡片语义不变）。转正判据即下方末条断言：失败后状态栏不停留「解析中」。
    test.setTimeout(60_000);
    const statuses: number[] = [];
    page.on('response', (r) => {
      if (r.url().includes('/api/compute/highlight')) statuses.push(r.status());
    });
    await connectSameOriginCompute(page, 'remote');
    await openFile(page, 'tcmp-remote-fail.jsonc');

    // 护栏（缺陷态已成立，与 CMP-04 ④ 同口径）：错误卡片出现 + 真实 400
    await expect(page.locator('.vv-error-card')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.vv-error-card')).toContainText('远程高亮失败: HTTP 400');
    expect(statuses).toContain(400);

    // 转正判据（缺陷态失败：t15 状态栏仍逐字驻留「高亮: 解析中… · 执行: 远程…」）：
    // 失败后 engine 置终值——状态栏不再停留「解析中…」，与大文件 chunk 失败路径
    // （「纯文本」、无执行段）同口径
    await expect(page.locator('.vv-statusbar')).not.toContainText('解析中', { timeout: 10_000 });
    await expect(page.locator('.vv-statusbar')).not.toContainText('执行: 远程');
  }
);

test(
  'BUG-57 [探索]: 服务端档全局搜索单文件命中不设限——60 命中全量返回，与纯前端路径一致（截断统一由 1000 全局上限 + truncated 终帧承担）',
  async ({ page }) => {
    // 2026-10-10 复核成立（low）；2026-10-17 清偿转正。缺陷态：search.rs 定义
    // RG_MAX_COUNT=50 作为 rg --max-count（grep 路径 -m），单文件命中行超 50 即
    // 静默截断，终帧 truncated 仅由全局 1000 上限驱动——单文件 50 触达无任何信号，
    // 与纯前端 grepStoreLocal（同查询 60 条）双路径不一致。
    // 修复（两方向中取「放开」）：rg_args 去 --max-count、grep_args 去 -m，单文件
    // 命中不设限；截断语义统一由 pump 的 MAX_MATCHES=1000（truncated:true 终帧）
    // 承担——与纯前端 grepStoreLocal 的 1000 命中上限完全同构。服务端单测：
    // search.rs rg_grep_args_have_no_per_file_count_cap + tests/search.rs
    // per_file_matches_are_not_capped（60 行全量返回）。
    test.setTimeout(60_000);

    // API 半：60 帧全量返回（缺陷态恰 50 帧 + 终帧 truncated=false 双双违背）
    const res = await fetch(`${COMPUTE_BASE}/api/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pattern: 'vvneedle', caseSensitive: false, regex: false })
    });
    expect(res.ok).toBeTruthy();
    const frames = (await res.text())
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    const fileFrames = frames.filter(
      (f) => typeof f.file === 'string' && f.file.endsWith('tcmp-many60.txt')
    );
    expect(fileFrames.length, '60 个命中行全量返回（缺陷态 50）').toBe(60);
    expect(frames[frames.length - 1]?.truncated).toBe(false);

    // UI 半：远程 store 同查询——「60 个命中」（缺陷态「50 个命中」且无不完整提示）
    await connectSameOriginCompute(page, 'auto');
    await page.keyboard.press('Control+Shift+F');
    await expect(page.locator('.vv-gsearch')).toBeVisible();
    await page.getByLabel('全局搜索内容').fill('vvneedle');
    await expect(page.locator('.vv-gsearch-status')).toContainText('60 个命中', {
      timeout: 15_000
    });
    await page.keyboard.press('Escape');
  }
);

