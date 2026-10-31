import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';
import { test, expect, type Page } from '@playwright/test';
import { closeDrawerIfOpened, openDrawerIfNarrow } from './drawer';
import { assertPortFree, stopServer, waitHealthy } from './serverHarness';
import { setComputePolicy } from './settings-center';

/**
 * t-hl E2E（t- 前缀 = 2026-10-10 代码高亮域覆盖缺口补齐轮，不改动任何既有 spec）。
 * 场景来源：docs/e2e/code-highlight-degrade.md——第 2 节 HL-01~11、第 3 节 BUG-06 验收判据、
 * 第 6 节阶段 4 三态降级链（≤2MiB tree-sitter 整文件 / ≤200MiB 可视区懒高亮 chunk /
 * >200MiB 纯文本；阈值出处 packages/vviewer-render-text/src/code.ts:57-60）。
 * 只补缺口分析（2026-10-10）认定未覆盖的面，与既有护栏分工：
 * - HL-01：自动/本地两策略主路径对照 + manifest 门控信息（fix-pwa「BUG-06」用例只断本地单路径）；
 * - HL-01/2：BUG-06 验收 2 后半——缓存就绪后断网打开未开过的同语言文件仍 tree-sitter；
 * - HL-02：hljs 整文件兜底完整验收（BUG-65 已修复转正见文末——CAND-hl-F1 定档编号：
 *   前端语言首表把 pl 误识为 prolog，hljs 按该语法着色 Perl 源得 0 个 hljs-keyword；
 *   原 HL-02 [CAND-hl-F1] 用例按一缺陷一锚点并入 BUG-65 用例）；
 * - HL-03/2：单行 3MB（行极少字节极大）chunk 边界——既有 HL-03 载体为 4.8 万行规则文本；
 * - HL-04/2：>200MiB plain 分支（纯文本虚拟滚动 + 提示条 + 零着色）——全仓库此前无用例；
 * - HL-08：3MB 滚到底末行行数一致 + 四次到底↔回顶折返无白屏——此前完全无用例；
 * - HL-10：bash 载体（此前全 e2e 零 .sh 载体）+ rs/ts/sh 三语言本地矩阵 + 远程对照占位；
 * - HL-11/2：解析期 rAF 帧率观测（既有 HL-11 只断交互 dispatch 耗时）。
 *
 * 构建形态前提（HL-02 依赖）：CI e2e 构建注入 VV_GRAMMAR_CDN=https://cdn.grammars.test/grammars/
 * （.github/workflows/ci.yml:88，假域名 DNS 必败 → CDN 层跳过）；本地 `pnpm build` 未注入时
 * vite define 置空串（apps/web/vite.config.ts:222）→ CDN 层不发起。两种形态下 perl 均不在
 * lite 内嵌集（apps/web/static/grammars/manifest.json 34 项无 perl）→ hljs 兜底。
 * 若本地以可达 CDN 构建，HL-02 会以 tree-sitter 到达而失败——属环境不符，非产品缺陷。
 * 通道同 m1-m3/b-hl：页面内 File + webkitRelativePath 经 __vvOpenDirImpl 注入（本地 store）。
 */

/** samples/m2 的 sample.pl 载体（BUG-65，原 HL-02；与 m2.spec.ts 同源同内容） */
const M2_SAMPLES = fileURLToPath(new URL('../../../samples/m2', import.meta.url));
const SAMPLE_PL = new Uint8Array(readFileSync(`${M2_SAMPLES}/sample.pl`));

/** rust 载体（HL-01/HL-01/2；两份内容不同，防「重开已打开文件」路径混入） */
const RS_A = [
  'use std::collections::HashMap;',
  '',
  'fn main() {',
  '    let mut counts: HashMap<String, i32> = HashMap::new();',
  '    counts.insert("alpha".to_string(), 1);',
  '    println!("{} entries", counts.len());',
  '}'
].join('\n');
const RS_B = [
  'pub struct Point {',
  '    pub x: f64,',
  '    pub y: f64,',
  '}',
  '',
  'impl Point {',
  '    pub fn origin() -> Self { Self { x: 0.0, y: 0.0 } }',
  '}'
].join('\n');

/** bash 载体（HL-10；真实语法特征：shebang/set/for/done，报告证据名 deploy.sh 同型） */
const SH_SRC = [
  '#!/usr/bin/env bash',
  'set -euo pipefail',
  '',
  'DEPLOY_DIR="${1:-/tmp/deploy}"',
  'mkdir -p "$DEPLOY_DIR"',
  'for f in "$@"; do',
  '  cp "$f" "$DEPLOY_DIR/"',
  '  echo "copied $f"',
  'done'
].join('\n');

/** typescript 载体（HL-10/2 矩阵件） */
const TS_SRC = [
  'export interface Point { x: number; y: number }',
  '',
  'export function dist(a: Point, b: Point): number {',
  '  return Math.hypot(a.x - b.x, a.y - b.y);',
  '}'
].join('\n');

interface FilePayload {
  name: string;
  type: string;
  content: string | Uint8Array;
}

async function openDir(page: Page, payloads: FilePayload[]): Promise<void> {
  await page.waitForFunction(
    () => typeof (window as unknown as { __vvOpenDirImpl?: unknown }).__vvOpenDirImpl === 'function'
  );
  await page.evaluate((payloads) => {
    const files = payloads.map(({ name, type, content }) => {
      const f = new File([content as BlobPart], name, { type });
      Object.defineProperty(f, 'webkitRelativePath', { value: `thl/${name}` });
      return f;
    });
    return (window as unknown as { __vvOpenDirImpl: (f: File[]) => void }).__vvOpenDirImpl(files);
  }, payloads);
}

async function openFile(page: Page, name: string): Promise<void> {
  const drawer = await openDrawerIfNarrow(page);
  // 精确匹配（caret span 前导空白；防前缀包含关系撞 strict mode，惯例同 b-code-highlight-degrade）
  await page
    .locator('.vv-tree-row')
    .filter({ hasText: new RegExp(`^\\s*${name.replace(/\./g, '\\.')}\\s*$`) })
    .click();
  await closeDrawerIfOpened(page, drawer);
  await expect(page.locator('.vv-tab.active', { hasText: name })).toBeVisible();
}

/** SW 首装/控制权交接窗口内 evaluate 可能命中未就绪 document——折叠为 null 供 poll 重试（fix-pwa 惯例） */
async function safeEval<T>(page: Page, fn: () => T | Promise<T>): Promise<T | null> {
  try {
    const v = await page.evaluate(fn);
    return (v ?? null) as T | null;
  } catch {
    return null;
  }
}

/** 等待 SW activated 且受控（缓存断言的前置；照 fix-pwa.spec.ts waitSwActivated 惯例重写，不改既有文件） */
async function waitSwActivated(page: Page): Promise<void> {
  await expect
    .poll(
      async () => {
        const s = await safeEval(page, async () => {
          const reg = await navigator.serviceWorker.ready;
          return {
            activated: reg.active?.state === 'activated',
            controlled: navigator.serviceWorker.controller !== null
          };
        });
        return s && s.activated && s.controlled ? true : null;
      },
      { timeout: 30_000, message: '等待 SW activated 且页面受控' }
    )
    .toBe(true);
}

/** 虚拟滚动首可见行自洽判定（无白屏 = 行在位且行号与内容匹配；照既有 HL-03 poll 模式） */
function firstLineReady(page: Page, rowToken: string) {
  return expect.poll(
    () =>
      page.evaluate((token) => {
        const first = document.querySelector('.vv-code-pre .vv-code-line');
        if (!(first instanceof HTMLElement)) return false;
        const gutter = first.querySelector('.vv-code-gutter')?.textContent ?? '';
        return gutter === '1' && (first.textContent ?? '').includes(token);
      }, rowToken),
    { timeout: 30_000, message: `等待回顶后首行渲染（含 gutter=1 与 ${rowToken}）` }
  );
}

/** 虚拟滚动末可见行 gutter 判定（gutter 为 1 基行号，code.ts:654 String(i+1)） */
function lastGutterIs(page: Page, rows: number) {
  return expect.poll(
    () =>
      page.evaluate(() => {
        const lines = document.querySelectorAll('.vv-code-pre .vv-code-line');
        const last = lines[lines.length - 1];
        return last?.querySelector('.vv-code-gutter')?.textContent ?? '';
      }),
    { timeout: 30_000, message: `等待滚动到底后末行 gutter=${rows}` }
  );
}

test('HL-01: 自动与本地策略下 rust 均走本地 tree-sitter 主路径（.wasm 请求 + ts-* span + 执行位 + manifest 门控信息）', async ({
  page
}) => {
  test.setTimeout(120_000);
  const wasmRequests: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('.wasm')) wasmRequests.push(r.url());
  });
  await page.goto('/');
  await openDir(page, [
    { name: 'rs-auto.rs', type: 'text/plain', content: RS_A },
    { name: 'transit.txt', type: 'text/plain', content: 'transit marker\n' },
    { name: 'rs-local.rs', type: 'text/plain', content: RS_B }
  ]);

  // ① 自动策略（默认）：ts-* span（hljs 兜底产物是 hljs-*，引擎可分辨）+ 状态栏引擎/执行位
  await openFile(page, 'rs-auto.rs');
  await expect(page.locator('.vv-code-pre span[class^="ts-keyword"]').first()).toBeVisible({
    timeout: 30_000
  });
  await expect(page.locator('.vv-statusbar')).toContainText('高亮: tree-sitter', { timeout: 20_000 });
  await expect(page.locator('.vv-statusbar')).toContainText('执行: 本地', { timeout: 20_000 });
  // network 层真实发生 runtime 与 grammar wasm 请求（报告缺陷态为零请求）
  expect(wasmRequests.some((u) => u.endsWith('/tree-sitter.wasm'))).toBe(true);
  expect(wasmRequests.some((u) => u.includes('/grammars/') && u.endsWith('/rust.wasm'))).toBe(true);

  // ② manifest 提供门控信息（现时形态：条目含 file/sha256。文档第 2 节步骤④「abi 非 null」
  //    判据已随阶段 1 重构退役——manifest note 明示 abi 恒 null 且无 ABI 门控，见 stale note）
  const manifestRes = await page.request.get('/grammars/manifest.json');
  expect(manifestRes.ok()).toBeTruthy();
  const manifest = (await manifestRes.json()) as {
    grammars: Record<string, { file?: string; sha256?: string } | undefined>;
  };
  expect(manifest.grammars.rust?.file).toBe('rust.wasm');
  expect(manifest.grammars.rust?.sha256).toBeTruthy();

  // ③ 切「本地」策略（设置中心「计算」组+应用）：重开已打开文件不触发重载，需换文件中转（域文档 4.4-2 复核要点）
  await setComputePolicy(page, 'local');
  await openFile(page, 'transit.txt');
  await openFile(page, 'rs-local.rs');
  await expect(page.locator('.vv-code-pre span[class^="ts-keyword"]').first()).toBeVisible({
    timeout: 30_000
  });
  await expect(page.locator('.vv-statusbar')).toContainText('高亮: tree-sitter', { timeout: 20_000 });
  await expect(page.locator('.vv-statusbar')).toContainText('执行: 本地', { timeout: 20_000 });
  await expect(page.locator('.vv-error-card')).toHaveCount(0);
});

test('HL-01/2: BUG-06 验收 2 后半——vv-grammars/vv-runtime 缓存就绪后断网，打开未开过的同语言文件仍 tree-sitter', async ({
  page
}) => {
  test.setTimeout(150_000);
  await page.goto('/');
  await openDir(page, [
    { name: 'warm-rs.rs', type: 'text/plain', content: RS_A },
    { name: 'cold-offline.rs', type: 'text/plain', content: RS_B }
  ]);

  // 在线先开 warm-rs.rs：rust 语言完整加载进 worker（进程内缓存），且主线程预热通道
  // 把 rust.wasm/tree-sitter.wasm 写入 vv-grammars-*/vv-runtime-* CacheFirst
  // （highlightClient.ts:68-82,171,261；SW 路由 /grammars/.*\.wasm$ 等）
  await openFile(page, 'warm-rs.rs');
  await expect(page.locator('.vv-code-pre span[class^="ts-keyword"]').first()).toBeVisible({
    timeout: 30_000
  });
  await waitSwActivated(page);
  // 缓存就绪显式轮询（不盲等）：两缓存各自出现目标资产条目
  await expect
    .poll(
      async () => {
        const ready = await safeEval(page, async () => {
          const keys = await caches.keys();
          const gram = keys.find((k) => k.startsWith('vv-grammars-'));
          const runtime = keys.find((k) => k.startsWith('vv-runtime-'));
          const gramHas =
            gram !== undefined &&
            (await (await caches.open(gram)).keys()).some((r) => r.url.endsWith('/rust.wasm'));
          const runtimeHas =
            runtime !== undefined &&
            (await (await caches.open(runtime)).keys()).some((r) =>
              r.url.endsWith('/tree-sitter.wasm')
            );
          return gramHas && runtimeHas;
        });
        return ready ?? false;
      },
      { timeout: 30_000, message: '等待 rust.wasm 与 tree-sitter.wasm 进入运行时缓存' }
    )
    .toBe(true);

  // 断网打开未开过的 rust 文件：语言已在 worker 内存（同语言零新 fetch），离线高亮成立
  // （域文档 §5.3 实测口径：offline cold.rs → tree-sitter 本地）
  await page.context().setOffline(true);
  try {
    await openFile(page, 'cold-offline.rs');
    await expect(page.locator('.vv-code-pre span[class^="ts-keyword"]').first()).toBeVisible({
      timeout: 30_000
    });
    await expect(page.locator('.vv-statusbar')).toContainText('高亮: tree-sitter', { timeout: 20_000 });
    await expect(page.locator('.vv-statusbar')).toContainText('执行: 本地', { timeout: 20_000 });
    await expect(page.locator('.vv-error-card')).toHaveCount(0);
  } finally {
    await page.context().setOffline(false);
  }
});

test('HL-03/2: 单行 3MB（行极少字节极大）chunk 边界——整行文本零错位且 tree-sitter 着色到达', async ({
  page
}) => {
  test.setTimeout(150_000);
  await page.goto('/');
  // 单行（无换行符）3,145,010B > TREE_SITTER_MAX_BYTES(2MiB) → lazy chunk；
  // 200 行对齐（CHUNK_LINES=200）下仅 1 个 chunk：既有 HL-03（4.8 万行）不覆盖的形态
  const X_COUNT = 3_145_000;
  // __vvOpenDirImpl 由 openFlow 模块级安装（openFlow.svelte.ts:451-453），分包在
  // goto 的 load 事件后未必就位——与 HL-04/2、HL-08 同一等待前置（缺它 evaluate 必竞态：
  // 首轮实测 TypeError: __vvOpenDirImpl is not a function，~190ms 即失败）
  await page.waitForFunction(
    () => typeof (window as unknown as { __vvOpenDirImpl?: unknown }).__vvOpenDirImpl === 'function'
  );
  await page.evaluate((xCount) => {
    const src = `const a="${'x'.repeat(xCount)}";`;
    const f = new File([src], 'one-line-3mb.js', { type: 'text/javascript' });
    Object.defineProperty(f, 'webkitRelativePath', { value: 'thl/one-line-3mb.js' });
    (window as unknown as { __vvOpenDirImpl: (f: File[]) => void }).__vvOpenDirImpl([f]);
  }, X_COUNT);
  await openFile(page, 'one-line-3mb.js');
  await expect(page.locator('.vv-code-pre .vv-code-line').first()).toBeVisible({ timeout: 30_000 });
  // chunk 着色到达（3MB 单 chunk 解析预算宽松 90s）
  await expect(page.locator('.vv-code-pre span[class^="ts-keyword"]').first()).toBeVisible({
    timeout: 90_000
  });
  await expect(page.locator('.vv-statusbar')).toContainText('高亮: tree-sitter', { timeout: 20_000 });
  // 零错位硬断言：着色 span 只包裹不增删字符，整行 textContent 必须与源逐字符一致
  // （escapeHtml 全量 slice 无截断，code.ts:397-423；长串页内比对不回传）。
  // 注意取行体 .vv-code-body：gutter 与 body 同 append 进行元素（code.ts:657），pre 的
  // textContent 混入行号「1」——既有 HL-3 护栏亦按行体比对，整 pre 比对必假
  const identical = await page.evaluate((xCount) => {
    const src = `const a="${'x'.repeat(xCount)}";`;
    const text = document.querySelector('.vv-code-pre .vv-code-body')?.textContent ?? '';
    return text === src;
  }, X_COUNT);
  expect(identical).toBe(true);
  // chunk 主路径不落 hljs 兜底
  await expect(page.locator('.vv-code-pre span[class^="hljs-"]')).toHaveCount(0);
  await expect(page.locator('.vv-error-card')).toHaveCount(0);
});

test('HL-04/2: >200MiB 窗口流式 lazy——提示条 + 行数 + 一步到底 + 懒着色（io 防线换代后 200MiB plain 档对 ctx 来源退役）', async ({
  page
}, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', '210MB 级内存构造仅桌面基准跑（PERF-LAZY 前例）');
  test.setTimeout(240_000);
  await page.goto('/');
  await page.waitForFunction(
    () => typeof (window as unknown as { __vvOpenDirImpl?: unknown }).__vvOpenDirImpl === 'function'
  );
  // 1,992B × 105,500 ≈ 210.2MB：io-streaming 防线换代（spec §4.3）后 >200MiB 对
  // rangeCapable 来源不再纯文本——窗口流式 lazy 接管，新上限档为 512MB
  // STREAM_MAX_BYTES；原「>200MiB 纯文本零着色」仅存于非 ctx 全量路径（e2e 不可达，
  // resolveStrategy 单测 code.test.ts「>200MB → plain」锁档位）
  const ROWS = 105_500;
  await page.evaluate((rows) => {
    const row = `const a="${'x'.repeat(1980)}";\n`; // 1992B/行
    const f = new File([row.repeat(rows)], 'huge-plain.js', { type: 'text/javascript' });
    Object.defineProperty(f, 'webkitRelativePath', { value: 'thl/huge-plain.js' });
    (window as unknown as { __vvOpenDirImpl: (f: File[]) => void }).__vvOpenDirImpl([f]);
  }, ROWS);
  await openFile(page, 'huge-plain.js');

  // 提示条（>HLJS_MAX_BYTES 懒高亮说明）且不阻断首屏
  const notice = page.locator('.vv-code-oversize-card');
  await expect(notice).toBeVisible({ timeout: 90_000 });
  await expect(notice).toContainText('20MB');
  await expect(notice).toContainText('懒高亮');
  await expect(page.locator('.vv-code-pre .vv-code-line').first()).toBeVisible({ timeout: 60_000 });
  // 可视区 chunk tree-sitter 着色在 210MB 仍工作（原「零着色」随 plain 档退役）
  await expect(page.locator('.vv-code-pre span[class^="ts-"]').first()).toBeVisible({
    timeout: 90_000
  });
  // 行数与 wc 口径一致（后台索引泵推进至 EOF；末行带 \n：状态栏行数 = 恰 ROWS）
  await expect(page.locator('.vv-statusbar')).toContainText(`行: ${ROWS}`, { timeout: 90_000 });

  // 一步到底：末行行号 = ROWS（渲染/滚动/行号正确性不回退，BUG-20 验收 2）
  const pre = page.locator('.vv-code-pre');
  await pre.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  lastGutterIs(page, ROWS); // poll 到 '105500'

  // 提示条常驻（滚动后仍在，非一次性 toast 形态）
  await expect(notice).toBeVisible();
});

test('HL-08: 3MB 长文本滚到底末行行数一致，四次「到底↔回顶」折返均即时渲染无白屏', async ({
  page
}) => {
  test.setTimeout(150_000);
  await page.goto('/');
  // 62B × 48,000 ≈ 2.98MB ∈ (2MiB, 200MiB] → lazy + 虚拟滚动；末行不带 \n（渲染与 wc 口径行数一致）
  const ROWS = 48_000;
  await page.waitForFunction(
    () => typeof (window as unknown as { __vvOpenDirImpl?: unknown }).__vvOpenDirImpl === 'function'
  );
  await page.evaluate((rows) => {
    const lines: string[] = [];
    for (let i = 0; i < rows; i++) {
      const no = String(i).padStart(6, '0');
      lines.push(`const row${no} = '${'x'.repeat(30)}'; // ${no}`);
    }
    const f = new File([lines.join('\n')], 'fold-3mb.js', { type: 'text/javascript' });
    Object.defineProperty(f, 'webkitRelativePath', { value: 'thl/fold-3mb.js' });
    (window as unknown as { __vvOpenDirImpl: (f: File[]) => void }).__vvOpenDirImpl([f]);
  }, ROWS);
  await openFile(page, 'fold-3mb.js');
  await expect(page.locator('.vv-code-pre .vv-code-line').first()).toBeVisible({ timeout: 30_000 });
  // 行数锚（末行行号与构造行数一致；「行:」无千分位）
  await expect(page.locator('.vv-statusbar')).toContainText(`行: ${ROWS}`, { timeout: 30_000 });

  const pre = page.locator('.vv-code-pre');
  // ① 滚动到底：末行行号 = ROWS（报告口径「末行 54,237 与 wc -l 一致」的现时等价断言）
  await pre.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  lastGutterIs(page, ROWS); // poll 到 '48000'

  // ② 四次「到底↔回顶」折返：每次落点行内容在位（行号与文本匹配）即无白屏
  for (let trip = 1; trip <= 4; trip++) {
    await pre.evaluate((el) => {
      el.scrollTop = 0;
    });
    await firstLineReady(page, 'row000000');
    await pre.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    lastGutterIs(page, ROWS);
  }
  // 折返全程无降级痕迹
  await expect(page.locator('.vv-error-card')).toHaveCount(0);
});

test('HL-10: bash 脚本走本地 tree-sitter 主路径（ts-* span + bash.wasm 请求）', async ({ page }) => {
  test.setTimeout(90_000);
  const wasmRequests: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('.wasm')) wasmRequests.push(r.url());
  });
  await page.goto('/');
  await openDir(page, [{ name: 'deploy.sh', type: 'text/x-shellscript', content: SH_SRC }]);
  await openFile(page, 'deploy.sh');
  await expect(page.locator('.vv-code-pre span[class^="ts-keyword"]').first()).toBeVisible({
    timeout: 30_000
  });
  await expect(page.locator('.vv-statusbar')).toContainText('高亮: tree-sitter', { timeout: 20_000 });
  await expect(page.locator('.vv-statusbar')).toContainText('执行: 本地', { timeout: 20_000 });
  expect(wasmRequests.some((u) => u.includes('/grammars/') && u.endsWith('/bash.wasm'))).toBe(true);
  await expect(page.locator('.vv-error-card')).toHaveCount(0);
});

test('HL-10/2: rs/ts/sh 三语言本地路径矩阵均获 tree-sitter 高亮（自动策略下路由正确）', async ({
  page
}) => {
  test.setTimeout(150_000);
  await page.goto('/');
  await openDir(page, [
    { name: 'matrix.rs', type: 'text/plain', content: RS_A },
    { name: 'matrix.ts', type: 'text/plain', content: TS_SRC },
    { name: 'matrix.sh', type: 'text/x-shellscript', content: SH_SRC }
  ]);
  // HL-10 现状缺陷「自动 rust 失败」的回归护栏：三语言逐个打开，ts-keyword 到达 + 零 hljs
  for (const name of ['matrix.rs', 'matrix.ts', 'matrix.sh']) {
    await openFile(page, name);
    await expect(page.locator('.vv-code-pre span[class^="ts-keyword"]').first()).toBeVisible({
      timeout: 30_000
    });
    await expect(page.locator('.vv-statusbar')).toContainText('高亮: tree-sitter', {
      timeout: 20_000
    });
    await expect(page.locator('.vv-code-pre span[class^="hljs-"]')).toHaveCount(0);
    await expect(page.locator('.vv-error-card')).toHaveCount(0);
  }
});

test('HL-10/3: 远程策略 rs/ts/sh 三语言 POST /api/compute/highlight 对照（报告实测 rs=98/ts=87/sh=23 个 ts-* span）', async ({
  page
}, testInfo) => {
  // 前端套件 :4173 为 vite preview 纯 web 形态，无 --compute 实例可连，远程对照此前
  // 不可执行。转正（2026-10-16，Wave 2）：用例内自起 release server --compute 同源
  // 实例（:4181，非常驻，起停拓扑照 e2e-server/b-compute-global-search-server.spec.ts
  // 的 :4180 同源辅助实例模式 + serverHarness 的 waitHealthy/stopServer）；服务端
  // compute 已对齐 301 语言（server/src/compute/queries.rs:288 断言 301），rs/ts/sh
  // 均在宣告集内。远程路径要求 server-served 来源（注入通道的本地 store 无
  // remoteBase，highlightClient 的 remoteAttempted 前置 !!src 恒本地）——文件经
  // fixture root 下发、同源连接表单进入 server store 树打开。
  // 数量判据按报告量级放宽为「>0」：区间数随 web-tree-sitter/查询资产版本漂移，
  // 硬编码 98/87/23 会随资产升级假红（同 BUG-65 判据「量级随 hljs 版本漂移不作
  // 硬编码」口径）。
  test.skip(testInfo.project.name !== 'chromium', '自起 --compute 实例仅桌面基准跑（HL-04/2 前例；移动视口连接表单无既有用例背书）');
  const specDir = dirname(fileURLToPath(import.meta.url));
  const BIN = resolve(specDir, '../../../server/target/release/vviewer');
  test.skip(!existsSync(BIN), 'release server 未构建（cargo build --release 后可用）');
  test.setTimeout(180_000);
  const highlightPosts: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().includes('/api/compute/highlight')) highlightPosts.push(r.url());
  });

  const root = mkdtempSync(join(tmpdir(), 'thl-compute-'));
  writeFileSync(join(root, 'thl-rs.rs'), RS_A);
  writeFileSync(join(root, 'thl-matrix.ts'), TS_SRC);
  writeFileSync(join(root, 'thl-deploy.sh'), SH_SRC);
  const BASE = 'http://127.0.0.1:4181'; // 避开 e2e-server 套件的 4178/4179/4180
  await assertPortFree(BASE); // 遗留进程预检（须在 spawn 前——spawn 后 health 命中的是自己）
  const server = spawn(
    BIN,
    ['serve', '--root', root, '--web-dist', resolve(specDir, '../build'), '--port', '4181', '--compute'],
    { stdio: 'ignore' }
  );
  try {
    await waitHealthy(BASE);
    // 同源连接（页面即该实例伺服，无 token）：server store 树出现即连接完成
    await page.goto(`${BASE}/`);
    await page.getByRole('button', { name: '连接服务器' }).click();
    await page.getByLabel('服务器地址').fill(BASE);
    await page.getByRole('button', { name: '连接', exact: true }).click();
    await expect(page.locator('.vv-tree-row', { hasText: 'thl-' }).first()).toBeVisible({ timeout: 10_000 });
    // 先切策略再开文件（切策略对已打开文件不回溯，域文档 4.4-2 复核要点；设置中心「计算」组+应用）
    await setComputePolicy(page, 'remote');
    for (const [name, lang] of [
      ['thl-rs.rs', 'rust'],
      ['thl-matrix.ts', 'typescript'],
      ['thl-deploy.sh', 'bash']
    ] as const) {
      const drawer = await openDrawerIfNarrow(page);
      await page.locator('.vv-tree-row', { hasText: name }).first().click();
      await closeDrawerIfOpened(page, drawer);
      await expect(page.locator('.vv-tab.active', { hasText: name })).toBeVisible();
      await expect(page.locator('.vv-code-pre span[class^="ts-keyword"]').first()).toBeVisible({
        timeout: 60_000
      });
      await expect(page.locator('.vv-statusbar')).toContainText('高亮: tree-sitter', { timeout: 20_000 });
      await expect(page.locator('.vv-statusbar')).toContainText('执行: 远程', { timeout: 20_000 });
      await expect(page.locator('.vv-statusbar')).toContainText(`语言: ${lang}`, { timeout: 20_000 });
      await expect(page.locator('.vv-code-pre span[class^="hljs-"]')).toHaveCount(0);
      await expect(page.locator('.vv-error-card')).toHaveCount(0);
    }
    // 远程对照核心：三语言均真实发生服务端 compute POST（报告缺陷态为零请求）
    expect(highlightPosts.length).toBeGreaterThanOrEqual(3);
  } finally {
    await stopServer(server, 'thl-10-3');
    rmSync(root, { recursive: true, force: true });
  }
});

test('HL-11/2: 约 2MB 解析期间 rAF 帧率不掉（域文档实测 53fps；下限放宽防环境抖动）', async ({
  page
}) => {
  test.setTimeout(120_000);
  await page.goto('/');
  await openDir(page, [
    { name: 'raf-2m.ts', type: 'text/typescript', content: 'const vv = 1; // c\n'.repeat(100_000) }
  ]);
  // 先装 rAF 计数器再点击打开：观测窗口覆盖整个解析期（≤2MiB 整文件 tree-sitter 路径）
  const drawer = await openDrawerIfNarrow(page);
  await page.evaluate(() => {
    const w = window as unknown as {
      __vvRafFrames?: number;
      __vvRafStart?: number;
      __vvRafStop?: boolean;
    };
    w.__vvRafFrames = 0;
    w.__vvRafStart = performance.now();
    w.__vvRafStop = false;
    const tick = (): void => {
      w.__vvRafFrames = (w.__vvRafFrames ?? 0) + 1;
      if (!w.__vvRafStop) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await page.locator('.vv-tree-row', { hasText: 'raf-2m.ts' }).click();
  await closeDrawerIfOpened(page, drawer);

  // 解析完成（ts-* 到达）后停表：帧率覆盖「打开→着色到达」全程 + 500ms 收尾
  await expect(page.locator('.vv-code-pre span[class^="ts-"]').first()).toBeVisible({
    timeout: 60_000
  });
  await page.waitForTimeout(500);
  const raf = await page.evaluate(() => {
    const w = window as unknown as {
      __vvRafFrames?: number;
      __vvRafStart?: number;
      __vvRafStop?: boolean;
    };
    w.__vvRafStop = true;
    const dur = performance.now() - (w.__vvRafStart ?? 0);
    return { frames: w.__vvRafFrames ?? 0, durationMs: dur };
  });
  const fps = (raf.frames / raf.durationMs) * 1000;
  console.log(`[perf] 解析期 rAF 帧率: ${fps.toFixed(1)}fps（${raf.frames} 帧 / ${Math.round(raf.durationMs)}ms；域文档实测 53fps）`);
  // 下限 30fps：仅拦截「主线程被解析冻结」（headless 共享机器允许抖动；53fps 为参考值）
  expect(fps).toBeGreaterThanOrEqual(30);
  // 解析本身正常完成（不冻结的最终证据）
  await expect(page.locator('.vv-statusbar')).toContainText('高亮: tree-sitter', { timeout: 20_000 });
});

/** typescript 载体 B（BUG-35 判据 2 会话级短路验证件；与 TS_SRC 不同内容，防「重开已
 * 打开文件」缓存路径混入——先例 HL-01 的 RS_A/RS_B 惯例） */
const TS_SRC_B = [
  'export function sum(list: number[]): number {',
  '  return list.reduce((acc, n) => acc + n, 0);',
  '}'
].join('\n');

test('BUG-35: tree-sitter worker init 成功零回包——页面静置 >15s 看门狗误杀，全会话本地高亮静默降级 hljs', async ({
  page
}) => {
  // 缺陷（medium，唯一回归锚点）：init 成功路径不向主线程回任何 ack（worker.ts .then
  // 内仅排空排队请求），HighlightClient 看门狗（INIT_TIMEOUT_MS=15s）以「收到过任何
  // 消息」判活——页面加载后 15s 内无本地代码高亮请求的会话被误判初始化超时，worker
  // 永久短路：此后所有本地代码文件与 markdown 围栏静默降级 hljs + 一条误导性
  // console.error。修复（2026-10-16）：worker init 成功回 {kind:'init-ok'} ack（无论
  // debug 开关），client onmessage 现行 markWorkerAlive 路径解除看门狗；真挂起（无
  // ack）仍 15s 收口。历史证据/编号勘误史（原 BUG-43 等收编记录）见缺陷库与
  // 2026-10-16 卫生批 SDD 台账。
  test.setTimeout(120_000);
  const consoleErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  await page.goto('/');
  // 注入后静置 16s：预热 init 握手已发出（viewer.ts:51-56），期间零高亮请求——越过 15s
  // 看门狗窗口（现状在此窗口内被误杀；修复后 ack 到达解除看门狗）
  await openDir(page, [
    { name: 'watchdog43-a.ts', type: 'text/plain', content: TS_SRC },
    { name: 'watchdog43-b.ts', type: 'text/plain', content: TS_SRC_B }
  ]);
  await page.waitForTimeout(16_000);

  // 修复判据 1：越过看门狗窗口后首次打开代码文件仍走 tree-sitter（缺陷态：状态栏
  // 「高亮: hljs 兜底 · 执行: 本地」+ .vv-code-body 内 ts-* span=0）
  await openFile(page, 'watchdog43-a.ts');
  await expect(page.locator('.vv-code-pre span[class^="ts-"]').first()).toBeVisible({
    timeout: 30_000
  });
  await expect(page.locator('.vv-statusbar')).toContainText('高亮: tree-sitter', { timeout: 20_000 });
  await expect(page.locator('.vv-statusbar')).toContainText('执行: 本地', { timeout: 20_000 });
  await expect(page.locator('.vv-code-pre span[class^="hljs-"]')).toHaveCount(0);

  // 修复判据 2：全会话不短路——同会话再开第二个文件仍 tree-sitter（缺陷态：initFailed
  // 后所有 highlight() 直接 reject，watchdog-verify2 三文件全降级）
  await openFile(page, 'watchdog43-b.ts');
  await expect(page.locator('.vv-code-pre span[class^="ts-"]').first()).toBeVisible({
    timeout: 30_000
  });
  await expect(page.locator('.vv-statusbar')).toContainText('高亮: tree-sitter', { timeout: 20_000 });

  // 修复判据 3：误导性超时错误不出现（现状文案含「初始化超时」并把排查引向 worker chunk
  // 404/MIME，实测资产全 200）
  expect(consoleErrors.join('\n')).not.toContain('初始化超时');
  await expect(page.locator('.vv-error-card')).toHaveCount(0);
});

// ── 探索复核确认缺陷回归占位：发现于 Markdown 渲染域、根因属 hl（2026-10-10；README
// §3.2.1 一域一文件按根因归属落位，§3.2.4 修复合入前 test.fixme 占位、修复 PR 转正）──
// 本缺陷（BUG-42）上一轮按探索期编号 BUG-38 落在 t-md.spec.ts；缺陷库定档编号为 BUG-42
// 且根因在 packages/vviewer-highlight，按根因迁入本域文件，修复 PR 以本节为转正载体（t-md 侧
// 探索期编号占位一并转正）。同批探索期编号 BUG-40（worker 看门狗，md 围栏视角）与本文件
// 原 BUG-41 占位系上方 BUG-35（原探索期编号 BUG-43，编号勘误轮定档）同一缺陷的重复锚点，
// 已按权威编号收编删除（2026-10-10 整理）。

test('BUG-42 [探索]: 围栏代码块语言标识大小写不归一——Rust 大写写法静默丢失 tree-sitter 降级 hljs 兜底', async ({
  page
}) => {
  // 发现于 Markdown 渲染域、根因属 hl（packages/vviewer-highlight/src/core-parse.ts）；复核成立
  // （low）。= 探索期编号 BUG-38（t-md.spec.ts 'BUG-38 [探索]' 用例，同一缺陷同判据，
  // t-md 侧占位已按根因收编删除，本条为唯一锚点）。
  // 根因（已修 2026-10-16，Wave 2）：canonicalLang 两级查找（grammar 清单键/别名表）
  // 均区分大小写且未命中原样返回（core-parse.ts:310-312）；buildAliasTable 别名原样
  // 入表无 toLowerCase（core-parse.ts:451-457）；manifest 34 键全小写、无 Rust 键、
  // rust 别名仅 ['rs']——```Rust 不命中清单键与别名表，tree-sitter 路径静默丢失、
  // 降级 hljs（cls "language-Rust hljs"，仅 2 个 hljs-* span），```rust 得 10 个 ts-*
  // span；别名机制本身正常（```zsh 经别名表命中 bash grammar）。修复：canonicalLang
  // 与 buildAliasTable 双侧 toLowerCase 归一；pipeline highlight 步 tree-sitter 命中
  // 后语言类名同步小写（cls 与 ```rust 写法一致）。单测：runtime.test.ts（Rust 大写
  // 与小写高亮逐区间一致 + hasLanguage 大写命中）、markdownPipeline.test.ts（cls
  // 归一）。
  // 证据（复核轮独立取得）：/tmp/vv-recheck-md-e4/recheck.mjs（server-auto 档块1
  // {cls:"language-rust",spanTotal:10,ts:10,hljs:0} vs 块6 {cls:"language-Rust hljs",
  // spanTotal:2,ts:0,hljs:2}；server-remote 与 local-injected 三组逐块一致）。
  test.setTimeout(120_000);
  // 转正补课：fixme 占位期从未执行，骨架漏了导航——about:blank 上 __vvOpenDirImpl
  // 永不就位，openDir 的 waitForFunction 必超时（首轮转正实测 120s × 2 project）
  await page.goto('/');
  const content = [
    '```rust',
    'fn main() {',
    '    let x = 1;',
    '}',
    '```',
    '',
    '```Rust',
    'fn main() {',
    '    let y = 2;',
    '}',
    '```',
    '',
    '```zsh',
    'echo hi',
    '```',
    ''
  ].join('\n');
  await openDir(page, [{ name: 'fence-case42.md', type: 'text/markdown', content }]);
  await openFile(page, 'fence-case42.md');
  const blocks = page.locator('.vv-markdown pre code');
  await expect(blocks).toHaveCount(3, { timeout: 20_000 });

  // 基线护栏：小写 rust 块 grammar 命中（修复不回退既有路径）
  await expect(blocks.nth(0)).toHaveClass(/language-rust/);
  await expect(blocks.nth(0).locator('span[class^="ts-"]').first()).toBeVisible({
    timeout: 30_000
  });

  // 修复判据：Rust 大写写法归一命中 grammar——cls language-rust + ts-* span，无 hljs 兜底
  await expect(blocks.nth(1)).toHaveClass(/language-rust/);
  await expect(blocks.nth(1).locator('span[class^="ts-"]').first()).toBeVisible({
    timeout: 30_000
  });
  await expect(blocks.nth(1).locator('span[class^="hljs-"]')).toHaveCount(0);

  // 基线护栏：zsh 别名机制照常（别名表命中 bash grammar）
  await expect(blocks.nth(2).locator('span[class^="ts-"]').first()).toBeVisible({
    timeout: 30_000
  });
  await expect(page.locator('.vv-error-card')).toHaveCount(0);
});

// ── 代码高亮域探索复核确认缺陷回归占位（2026-10-10 轮，BUG-33~38/65 批次；README
// §3.2.1 一域一文件、§3.2.4 修复合入前 test.fixme 占位、修复 PR 转正）──
// 其中 BUG-33（djot SIGSEGV）/ BUG-36（单行大文本 O(n²)）根因在 server/src/compute/
// highlight.rs（服务端 compute 高亮链路），按根因归属改落 e2e-server/t-cmp.spec.ts（见
// 该文件同批次节注释）；以下五条根因在 packages/vviewer-highlight / packages/vviewer-render-text 前端
// 高亮与代码查看链路，落本文件。各用例注释给出复核结论、最小复现步骤、证据路径与源码定位。

test('BUG-34 [探索]: codeRenderer 扩展名白名单未跟随 301 语言全量重构——zig/hs/ex/erl/clj/scala/djot 等 7 类文件打开即「无法预览此文件」', async ({
  page
}) => {
  // 复核成立（medium，8445 实例 + Playwright 7/7 复现 + rs 正对照排除通路整体不可用）。
  // 根因（已随 C 项 2026-10-11 format-coverage-open-with 顺带修复，2026-10-16 Wave 2
  // 转正确认）：探索期时点 codeRenderer.extensions 手工白名单未含 zig/hs/ex/erl/
  // clj/scala/dj(ot) 且未知扩展名直接报错。C 项两步收口：① 选路层——dispatcher
  // resolveInitialRenderer 放宽（未知扩展名不再直接报错，与无扩展名同走内容探测链，
  // looksTextual → code 渲染器，链尾 hex 兜底）；② 注册层——viewer.ts 装配
  // installFallbackExtensions('code', GENERATED_EXTENSIONS)，packages/vviewer-core/src/registry/
  // generated-extensions.ts（tools/grammar-builder/gen-code-extensions.mjs 从
  // languages.json 342 条 fileTypes 生成的全集，CI --check 校验新鲜度）把手工清单
  // 之外的语法类扩展名全部补注册到 code（专有渲染器冲突跳过）。7 类缺口扩展名两步
  // 均已覆盖（zig/hs/ex/erl/clj/scala/dj/djot 全在生成物内），识别与高亮资产路
  // （服务端 x-vv-lang 7/7 正确、languages.json 各条目 fileTypes 齐备、构建产物
  // zig.wasm 实有）在复核时已就绪。
  // 证据（复核轮独立取得）：自起实例 8445（vviewer serve --root .temp/explore/hl/data
  // --web-dist apps/web/build --port 8445 --compute）；Playwright 脚本
  // /tmp/vv-verify-hl-e2e/rep.mjs——sample.zig/.hs/.ex/.erl/.clj/.scala 与 range/crash.djot
  // 7/7 全部错误卡片（截图 shots/zig.png、shots/djot.png），正对照 sample2.rs 正常渲染
  // 「高亮: tree-sitter · 执行: 远程 · 语言: rust」（shots/rs-control.png）；服务端对照
  // curl -s -D - '/api/file?path=langs/sample.zig' → 200 + x-vv-lang: zig（7/7 同法）。
  test.setTimeout(120_000);
  await page.goto('/');
  // 正对照先于缺陷组：rs 在白名单内正常渲染，证明 UI 通路整体可用（排除「错误卡片系
  // 预览通路整体坏」的解释，同复核 evidence ④ 口径）
  await openDir(page, [
    { name: 'wl34-control.rs', type: 'text/plain', content: RS_A },
    { name: 'sample.zig', type: 'text/plain', content: 'pub fn main() void { }\n' },
    { name: 'sample.hs', type: 'text/plain', content: 'main :: IO ()\nmain = putStrLn "hi"\n' },
    {
      name: 'sample.ex',
      type: 'text/plain',
      content: 'defmodule Sample do\n  def hi, do: :ok\nend\n'
    },
    {
      name: 'sample.erl',
      type: 'text/plain',
      content: '-module(sample).\n-export([hi/0]).\nhi() -> ok.\n'
    },
    { name: 'sample.clj', type: 'text/plain', content: '(defn hi [] "hi")\n' },
    {
      name: 'sample.scala',
      type: 'text/plain',
      content: 'object Sample { def hi: String = "hi" }\n'
    },
    { name: 'sample.dj', type: 'text/plain', content: '# Heading\ntext **bold**\n' }
  ]);
  await openFile(page, 'wl34-control.rs');
  await expect(page.locator('.vv-code-pre span[class^="ts-"]').first()).toBeVisible({
    timeout: 30_000
  });
  await expect(page.locator('.vv-error-card')).toHaveCount(0);

  // 修复判据：7 类白名单缺口扩展名全部不再出错误卡片、内容真实渲染（现状：逐个
  // 「无法预览此文件 / 不支持的扩展名 ".xx"」）。引擎/语言段不作硬性约定——视 grammar
  // 资产形态落 tree-sitter 或 hljs/纯文本均属修复可接受形态，唯「选路层拒绝预览」必须消除。
  for (const name of [
    'sample.zig',
    'sample.hs',
    'sample.ex',
    'sample.erl',
    'sample.clj',
    'sample.scala',
    'sample.dj'
  ]) {
    await openFile(page, name);
    await expect(page.locator('.vv-error-card')).toHaveCount(0);
    await expect(page.locator('.vv-code-pre')).toBeVisible({ timeout: 20_000 });
  }
});

test.fixme('BUG-37 [探索]: yaml 本地 wasm 高亮全链静默失败——parse 首次调外置 scanner 抛 TypeError 被吞，恒降级 hljs 兜底且零日志', async ({
  page
}) => {
  // 复核确认（medium，4 次独立复现稳定）：缺陷态本地路径下任何正常 yaml 恒「hljs 兜底」
  // （ts-* span=0、hljs-* span=9），零 UI 错误、零 console 输出；同批 vue/php/html/python/
  // bash 本地 tree-sitter 全部正常，远程 compute 路径 yaml 正常——仅本地 wasm 路径坏。
  // 根因（已修 2026-10-16，Wave 2）：vendored 静态 yaml.wasm（tree-sitter-wasms 0.1.13
  // 时代预编译产物，C++ 外置 scanner 时代）在 web-tree-sitter 0.25.10 下 Parser.parse
  // 首次调用外置 scanner 抛 'TypeError: resolved is not a function'（glue stubs ← wasm
  // ts_parser_parse_wasm，scanner 符号解析为非函数；Language.load、setLanguage、查询编译
  // 均成功，失败阶段不在 load）。静默机制：doPrepare 成功故 prepare().catch 的 warn 不
  // 触发，parse 抛错被 highlight() 外层 catch 吞为 {ok:false}——全链零日志。
  // 修复（源再生而非日志补丁）：languages.toml yaml 源从 ikatyang（归档，scanner.cc）
  // 换 tree-sitter-grammars/tree-sitter-yaml v0.7.2（C 外置 scanner.c），cli 0.27 自建
  // yaml.wasm（specs-deviations §10 回补条件部分达成）；vendored fixture 删除，manifest
  // 条目转 self-built。长期锚：local-grammars.test.ts yaml 用例（Node 同构同资产锁死）。
  // 最小复现（缺陷态）：15s 内（避开 BUG-35 看门狗窗口）注入正常 yaml 并打开 → 状态栏
  // 「高亮: hljs 兜底 · 执行: 本地 · 语言: yaml」。证据（复核轮独立取得）：
  // /tmp/review-hl-e5/load-check.mjs（node 同构：yaml load OK → PARSE FAIL TypeError，
  // vue captures=28/php=15/html=21 同法全 OK）+ pinpoint.mjs（栈顶定位）；
  // e5.engine.test.ts 引擎级：yaml FAIL:resolved is not a function，vue 34/php 15/html 21/
  // tree-sitter ts=26。
  //
  // ⚠️ CI 环境敏感（2026-10-17 退回 fixme，产品修复本体维持）：本地 chromium 2.5s 绿
  // （含 2 核 taskset）、冷工具链重建 yaml.wasm sha=f89cf2a8 与暖构建逐字节等价、
  // local-grammars Node 同构单测全绿；CI chromium 4/4 确定性红（无 ts- span、console
  // 零 yaml 报错、manifest/yaml.wasm/queries 全 200、trace 归档于 run 39058802367
  // playwright-traces artifact）——CI 构建的 yaml wasm 在 CI chromium 的 scanner 行为
  // 待查（CI 冷缓存 fresh 工具链 vs 本地暖缓存版本标记缺失；WASI 工具链由 lockfile
  // 锁定的 CLI 0.27 自管下载）。下一步：CI 侧 dump wasm sha 对比 + Node 加载 CI 产物
  // 复跑 load-check。
  test.setTimeout(90_000);
  await page.goto('/');
  // 立即打开（看门狗 15s 窗口内），隔离 BUG-35 误杀缺陷对判据的干扰
  await openDir(page, [
    {
      name: 'config.yaml',
      type: 'text/yaml',
      content: 'server:\n  host: 127.0.0.1\n  port: 8443\n  debug: true\n'
    },
    {
      name: 'cmp37.vue',
      type: 'text/plain',
      content: '<script setup lang="ts">\nconst x = 1;\n</script>\n<template><p>{{ x }}</p></template>\n'
    }
  ]);
  await openFile(page, 'config.yaml');
  // 修复判据：yaml 走本地 tree-sitter（缺陷态：hljs 兜底、ts-*=0、hljs-*=9、零日志）
  await expect(page.locator('.vv-code-pre span[class^="ts-"]').first()).toBeVisible({
    timeout: 30_000
  });
  await expect(page.locator('.vv-statusbar')).toContainText('高亮: tree-sitter', { timeout: 20_000 });
  await expect(page.locator('.vv-statusbar')).toContainText('语言: yaml', { timeout: 20_000 });
  await expect(page.locator('.vv-code-pre span[class^="hljs-"]')).toHaveCount(0);

  // 基线护栏：同为 vendored 的 vue 不回退（复核 evidence 对照件；修复不得破坏）
  await openFile(page, 'cmp37.vue');
  await expect(page.locator('.vv-code-pre span[class^="ts-"]').first()).toBeVisible({
    timeout: 30_000
  });
  await expect(page.locator('.vv-error-card')).toHaveCount(0);
});

test('BUG-38 [探索]: 以 \\n 结尾文件 buildLineIndex 多出末尾虚行——gutter N+1 与状态栏「行: N」自相矛盾，服务端档滚到底虚 chunk 必发 400', async ({
  page
}) => {
  // 复核确认（low）。已修（2026-10-16，Wave 2）：缺陷态 text.split('\n')
  // （packages/vviewer-render-text/src/code.ts buildLineIndex）对以 \n 结尾的文本多出末尾
  // 空串元素，虚拟滚动以 lines.length 挂载遂多渲染一条不存在空行，而 getMeta 按
  // wc -l 口径减 1——渲染行数与状态栏行数自相矛盾。服务端档加重面：滚到底时
  // wantedChunkKeys/highlightChunk 以虚行行号发出 {startLine:N, lineCount:1}，服务端
  // StartBeyondEof 判 400（server/src/compute/highlight.rs），auto 策略下 catch 后
  // console.warn + null 静默落行级 hljs；显式 remote 策略下同 400 走抛错分支整页错误
  // 卡片停机。修复（尾终结符归一，行数 = wc -l 单口径）：① 全量 buildLineIndex 尾
  // \n 不产虚行（'' → 0 行、中间空行保留）；② buildByteLineOffsets 尾终结符不产
  // 伪起始（两域行号逐行一致）；③ 窗口流式 codeIndexStream.finishCodeIndex 悬挂
  // 空段不提交（与全量逐行等价，等价性参照改消费真实 buildLineIndex 钉住两侧同步）；
  // ④ 全量/窗口 getMeta 的「末元素空串减 1」展示层补偿随虚行消除一并退役（rows()/
  // lines.length 恒 wc 口径）；服务端档 400 面随虚行行号域消失一并消除（chunk 请求
  // 行号恒 ≤ wc 行数）。消费方核对：状态栏/spacer/chunk 边界/搜索行号/lineAtOffset/
  // lineAtByteOffset 单源 rows()/lines 数组，markdownRenderer 围栏（pipeline 已去尾
  // \n）不受影响。
  // 最小复现（缺陷态，纯 web 注入通道）：注入 'a\nb\nc\n' 打开 → 渲染 4 行（gutter 4
  // 为空行）而状态栏「行: 3」。服务端档证据（复核轮）：8440 实例 curl 直证 400 文案
  // 'range.startLine 48000 is beyond end of file: 48000 lines'；Playwright
  // /tmp/vv-recheck/repro.mjs（网络三相捕获 {0,200}→200、{47800,200}→200、{48000,1}→400
  // + console 恰 1 条 warn）；加重场景 /tmp/vv-recheck/repro-remote.mjs（显式 remote →
  // 错误卡片 + 引擎跌「纯文本」）。既有 HL-08 特意以「末行不带 \n」构造避开此口径
  // （构造注释自记），佐证套件此前未覆盖带尾换行形态。单测：code.test.ts（行表/getMeta/
  // lineAtOffset/lineAtByteOffset 全锚重钉）、code-index-stream.test.ts（索引语义 +
  // 等价性）、code-window-pump.test.ts（spacer 口径）。
  test.setTimeout(60_000);
  await page.goto('/');
  await openDir(page, [{ name: 'three-lines.txt', type: 'text/plain', content: 'a\nb\nc\n' }]);
  await openFile(page, 'three-lines.txt');

  // 修复判据：渲染行数与 wc/状态栏口径一致——恰 3 行、末 gutter '3'、状态栏「行: 3」
  // （缺陷态：4 行渲染、gutter 4 为空行，与「行: 3」自相矛盾）
  await expect(page.locator('.vv-code-pre .vv-code-line')).toHaveCount(3, { timeout: 20_000 });
  await lastGutterIs(page, 3); // poll 到 '3'
  await expect(page.locator('.vv-statusbar')).toContainText('行: 3', { timeout: 20_000 });
  await expect(page.locator('.vv-code-pre')).toContainText('a');
  await expect(page.locator('.vv-code-pre')).toContainText('c');
  await expect(page.locator('.vv-error-card')).toHaveCount(0);
});

test('BUG-65: .pl 前端语言首表误识 prolog——hljs 以 prolog 语法着色 Perl 源（0 个 hljs-keyword）且状态栏语言标注错误', async ({
  page
}) => {
  // = CAND-hl-F1 的复核定论缺陷库编号（2026-10-10 复核确认，severity 维持 medium）。
  // 原同名占位 HL-02 [CAND-hl-F1]（2026-10-10 分诊转 fixme 的 HL-02 场景用例）与本条
  // 同缺陷——2026-10-10 编号勘误轮按「一缺陷一锚点」删除该重复占位，本条为其唯一锚点：
  // 判据 = HL-02 原断言（hljs-keyword 到达 + 零 ts-* + 无错误卡片 + 内容真实渲染）+
  // 状态栏「语言:」段标注专项补强，判据出处 docs/e2e/code-highlight-degrade.md:38
  // HL-02（hljs-keyword=19、hljs-*=50）。
  // 根因（已修 2026-10-16，Wave 2）：packages/vviewer-highlight/src/langdetect.ts buildTables
  // 首表 first-wins 按插入序迭代，'pl' 命中 languages.json 中先出现的 prolog 条目
  // （fileTypes ["pl","prolog"]，perl 条目在后），hljs 整文件兜底遂以 prolog 语法着色
  // Perl 源——实测 hljs-keyword=0、hljs-*=9、ts-*=0、状态栏「高亮: hljs 兜底 · 执行:
  // 本地 · 语言: prolog」；服务端 detect.rs:97 同扩展名断言 pl→perl（'perl < prolog'
  // 字典序），客户端与服务端相悖。修复：首表构建按语言名排序迭代 + first-wins（与
  // 服务端 LANG_BY_EXT 的 BTreeMap 排序迭代 + or_insert 同语义），langdetect.test.ts
  // 补与服务端 detect.rs 断言同集的重复扩展胜负单测。
  // 最小复现（缺陷态）：注入 samples/m2/sample.pl 并打开 → 状态栏「语言: prolog」、
  // 代码无关键字着色。证据（复核轮独立取得）：Playwright 探针复刻 HL-02 操作与原样
  // 断言，两轮诊断一致——statusbar 含「语言: prolog」、hljsAll=9、hljsKeyword=0、
  // tsAll=0、errorCard=0、hasUseStrict=true；hljs 库直呼交叉验证：
  // highlight(sample.pl,{language:'prolog'}) 得 0/9 与浏览器逐数吻合（证明前端确实按
  // prolog 着色），{language:'perl'} 得 19/50 与文档判据吻合（检测正确即可通过）。
  test.setTimeout(60_000);
  await page.goto('/');
  await openDir(page, [{ name: 'sample.pl', type: 'text/plain', content: SAMPLE_PL }]);
  await openFile(page, 'sample.pl');

  // 场景判据原强度：hljs 以 perl 语法着色——keyword 捕获到达（报告实测 19 个，量级随
  // hljs 版本漂移不作硬编码；缺陷态 prolog 语法 0 个）
  await expect(page.locator('.vv-code-pre span.hljs-keyword').first()).toBeVisible({
    timeout: 20_000
  });
  const hljsTotal = await page.locator('.vv-code-pre span[class^="hljs-"]').count();
  expect(hljsTotal).toBeGreaterThan(0);
  // BUG-65 专项判据：语言标注正确——「语言: perl」且不再出现 prolog（缺陷态 prolog）
  await expect(page.locator('.vv-statusbar')).toContainText('语言: perl', { timeout: 20_000 });
  await expect(page.locator('.vv-statusbar')).not.toContainText('prolog');
  await expect(page.locator('.vv-statusbar')).toContainText('高亮: hljs 兜底', { timeout: 20_000 });
  // 主路径未介入：零 ts-* span（引擎可分辨）
  await expect(page.locator('.vv-code-pre span[class^="ts-"]')).toHaveCount(0);
  // 验收③：无错误卡片/提示浮层 + 内容真实渲染
  await expect(page.locator('.vv-error-card')).toHaveCount(0);
  await expect(page.locator('.vv-code-pre')).toContainText('use strict');
});
