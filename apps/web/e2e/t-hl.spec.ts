import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect, type Page } from '@playwright/test';
import { closeDrawerIfOpened, openDrawerIfNarrow } from './drawer';

/**
 * t-hl E2E（t- 前缀 = 2026-10-10 代码高亮域覆盖缺口补齐轮，不改动任何既有 spec）。
 * 场景来源：docs/e2e/code-highlight-degrade.md——第 2 节 HL-01~11、第 3 节 BUG-06 验收判据、
 * 第 6 节阶段 4 三态降级链（≤2MiB tree-sitter 整文件 / ≤200MiB 可视区懒高亮 chunk /
 * >200MiB 纯文本；阈值出处 packages/render-text/src/code.ts:57-60）。
 * 只补缺口分析（2026-10-10）认定未覆盖的面，与既有护栏分工：
 * - HL-01：自动/本地两策略主路径对照 + manifest 门控信息（fix-pwa「BUG-06」用例只断本地单路径）；
 * - HL-01/2：BUG-06 验收 2 后半——缓存就绪后断网打开未开过的同语言文件仍 tree-sitter；
 * - HL-02：hljs 整文件兜底完整验收（现 test.fixme——CAND-hl-F1 产品缺陷：前端语言首表把
 *   pl 误识为 prolog，hljs 按该语法着色 Perl 源得 0 个 hljs-keyword，判据不满足）；
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

/** samples/m2 的 sample.pl 载体（HL-02；与 m2.spec.ts 同源同内容） */
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

  // ③ 切「本地」策略：重开已打开文件不触发重载，需换文件中转（域文档 4.4-2 复核要点）
  await page.getByLabel('计算策略').selectOption('local');
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

test.fixme('HL-02 [CAND-hl-F1]: sample.pl 由 hljs 整文件兜底着色——hljs-keyword 专项 + 零 ts-* span + 无错误卡片', async ({
  page
}) => {
  // CAND-hl-F1（产品缺陷，2026-10-10 分诊转 fixme，断言不放宽）：
  // detectLanguage('pl') 按 languages.json 首表序命中 prolog（languages.json:999 的
  // prolog fileTypes 含 pl，先于 :1083 的 perl），hljs 整文件兜底（code.ts:682-687）
  // 据此以 prolog 语法着色 Perl 源——实测 0 个 hljs-keyword、hljs-* 仅 9 个乱命中，
  // 状态栏「高亮: hljs 兜底 · 语言: prolog」。违反场景文档 §2 HL-02 判据（报告实测
  // 19 hljs-keyword / 50 hljs-*）；服务端 detect.rs:97 同扩展名断言 pl→perl
  //（"perl < prolog"），客户端首表序与服务端相悖。修复后本用例应转正回 test。
  test.setTimeout(60_000);
  await page.goto('/');
  await openDir(page, [{ name: 'sample.pl', type: 'text/plain', content: SAMPLE_PL }]);
  await openFile(page, 'sample.pl');

  // hljs 着色到达：keyword 捕获专项（验收②报告实测 19 个，量级随 hljs 版本漂移不作硬编码）
  await expect(page.locator('.vv-code-pre span.hljs-keyword').first()).toBeVisible({
    timeout: 20_000
  });
  const hljsTotal = await page.locator('.vv-code-pre span[class^="hljs-"]').count();
  expect(hljsTotal).toBeGreaterThan(0);
  // 主路径未介入：零 ts-* span（引擎可分辨）
  await expect(page.locator('.vv-code-pre span[class^="ts-"]')).toHaveCount(0);
  // 状态栏引擎段（hljs-block 已退役，兜底只此一种文案；验收：非「hljs 分块」）
  await expect(page.locator('.vv-statusbar')).toContainText('高亮: hljs 兜底', { timeout: 20_000 });
  // 验收③：无错误卡片/提示浮层
  await expect(page.locator('.vv-error-card')).toHaveCount(0);
  // 代码内容真实渲染（预览而非空壳）
  await expect(page.locator('.vv-code-pre')).toContainText('use strict');
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

test('HL-04/2: >200MiB plain 分支——纯文本虚拟滚动 + 提示条 + 零着色（阶段 4 三态上限档）', async ({
  page
}, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', '210MB 级内存构造仅桌面基准跑（PERF-LAZY 前例）');
  test.setTimeout(240_000);
  await page.goto('/');
  await page.waitForFunction(
    () => typeof (window as unknown as { __vvOpenDirImpl?: unknown }).__vvOpenDirImpl === 'function'
  );
  // 1,992B × 105,500 ≈ 210.2MB > PLAIN_MAX_BYTES(200MiB)：行数控制在 10.5 万降低行索引开销；
  // 阶段 4 前 >20MB 即纯文本（文档 §2 HL-04 旧口径），现仅 >200MiB 萰入本档（code.ts:554-555）
  const ROWS = 105_500;
  await page.evaluate((rows) => {
    const row = `const a="${'x'.repeat(1980)}";\n`; // 1992B/行
    const f = new File([row.repeat(rows)], 'huge-plain.js', { type: 'text/javascript' });
    Object.defineProperty(f, 'webkitRelativePath', { value: 'thl/huge-plain.js' });
    (window as unknown as { __vvOpenDirImpl: (f: File[]) => void }).__vvOpenDirImpl([f]);
  }, ROWS);
  await openFile(page, 'huge-plain.js');

  // 提示条（BUG-20 模式 plain 分支文案，code.ts:555）且不阻断首屏
  const notice = page.locator('.vv-code-oversize-card');
  await expect(notice).toBeVisible({ timeout: 90_000 });
  await expect(notice).toContainText('200MB');
  await expect(notice).toContainText('纯文本');
  await expect(page.locator('.vv-code-pre .vv-code-line').first()).toBeVisible({ timeout: 60_000 });
  // plain 引擎即终值（code.ts:583）——状态栏「纯文本」（ViewerPane ENGINE_LABELS）
  await expect(page.locator('.vv-statusbar')).toContainText('纯文本', { timeout: 60_000 });
  // 行数与 wc 口径一致（末行带 \n：状态栏行数 = 恰 ROWS；「行:」无千分位直插）
  await expect(page.locator('.vv-statusbar')).toContainText(`行: ${ROWS}`, { timeout: 60_000 });
  // 纯文本零着色：ts-*/hljs-* 均不出现（若回归成 lazy，ts-* 到达即判负）
  await expect(page.locator('.vv-code-pre span[class^="ts-"]')).toHaveCount(0);
  await expect(page.locator('.vv-code-pre span[class^="hljs-"]')).toHaveCount(0);

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

test.fixme('HL-10/3: 远程策略 rs/ts/sh 三语言 POST /api/compute/highlight 对照（报告实测 rs=98/ts=87/sh=23 个 ts-* span）', async () => {
  // 前端套件 :4173 为 vite preview 纯 web 形态，无 --compute 实例可连，远程对照现状必不可执行：
  // 需 release server --compute 同源实例（拓扑参照 e2e-server/b-compute-global-search-server.spec.ts
  // 的 :4180 同源辅助实例模式起停，非常驻）。服务端 compute 已对齐 301 语言
  // （server/src/compute/queries.rs:288 断言 301），rs/ts/sh 均在宣告集内，落位后按
  // 「状态栏『高亮: tree-sitter · 执行: 远程』+ POST 发生 + ts-* span > 0」落正式断言。
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

/** typescript 载体 B（BUG-43 判据 2 会话级短路验证件；与 TS_SRC 不同内容，防「重开已
 * 打开文件」缓存路径混入——先例 HL-01 的 RS_A/RS_B 惯例） */
const TS_SRC_B = [
  'export function sum(list: number[]): number {',
  '  return list.reduce((acc, n) => acc + n, 0);',
  '}'
].join('\n');

test.fixme('BUG-43 [探索]: tree-sitter worker init 成功零回包——页面静置 >15s 看门狗误杀，全会话本地高亮静默降级 hljs', async ({
  page
}) => {
  // 发现于文件内搜索域、根因属 hl（代码高亮链路，packages/highlight）。复核成立（medium，
  // 4199/8391 双实例 3/3 稳定，对照组全健康）：init 成功路径不向主线程回任何 ack
  // （packages/highlight/src/worker.ts:82-107——.then 内仅排空排队请求，队列空则零回包，
  // 仅失败走 console.error+postError）；HighlightClient 看门狗（client.ts:18
  // INIT_TIMEOUT_MS=15_000）以「收到过任何消息」判活（markWorkerAlive 仅由 onmessage 置位，
  // client.ts:85-92），超时即 failWorker 置 initFailed（client.ts:74-80,104-117），此后
  // highlight() 一律 reject（client.ts:126-128）——页面加载后 15s 内无本地代码高亮请求的
  // 会话（viewer.ts:51-56 启动即预热握手、无请求，打开页面→浏览/连接→再开文件的自然序列
  // 必然命中）被误判「初始化超时」，worker 永久短路：该会话内此后所有本地代码文件与
  // markdown 围栏静默降级 hljs 兜底（hljs 兜底仍正确渲染文本、搜索高亮不受影响），仅一条
  // 误导性 console.error「初始化超时（15s 无响应）·排查 worker chunk 是否 404/MIME 异常」
  // （highlightClient.ts:254-256；实测 manifest.json/ts-worker-*.js/tree-sitter.wasm 全 200）。
  // 本条为该缺陷全仓库唯一回归锚点（hl 域主视角：本地代码文件 + 同会话二次打开仍降级，
  // 全会话永久短路；markdown 围栏与服务端档 remote-first 视角同判据，并入本条影响面）。
  // 原同源多份占位已按缺陷库权威编号收编删除（2026-10-10 占位整理，fsearch 域清单）：
  // t-md.spec.ts 'BUG-40 [探索]'、本文件 'BUG-41 [探索]'（md 围栏视角）、'BUG-35 [探索]'
  // （hl 域立档）、t-shell.spec.ts 'BUG-34 [探索]'（服务端档视角）——按旧编号检索请落本条。
  // 最小复现：cwd=apps/web，node .temp/explore-fsearch/p5d-watchdog.mjs（空闲 20s 再开
  // crossline.ts；对照组不空闲）；影响面 p6-confirm.mjs（md 围栏）、p7-final.mjs（含 8391）。
  // 证据：node .temp/verify-fsearch-E1/watchdog-verify.mjs 六场景——A1（4199 空闲 20s 后开
  // verify-case.ts）状态栏「高亮: hljs 兜底 · 执行: 本地」、.vv-code-body 内 ts-* span=0、
  // __vvLastHighlightOk=false、console.error 出现于 t+15.1s（早于 t+20s 的开文件动作，证明
  // 看门狗在空闲期独立触发），同会话网络记录 manifest/ts-worker/tree-sitter.wasm 全 200；
  // A2 对照（同实例立即开）→ tree-sitter、ts-span=205；B1/B2 于 8391 同构复现；C1/C2 md
  // 围栏 0 vs 32 span。watchdog-verify2.mjs（4199 空闲 20s 后同会话连开 one.ts→two.ts→
  // note.md）三文件全降级（ts-span 均 0、hljs-span>0 证明 hljs 在渲染），console.error 仅
  // t+15.1s 一条——误杀后全会话永久短路，非单文件现象；截图 6 张同目录。
  // 「15s 内有高亮请求则健康」的对照由既有 HL-01/HL-10/HL-10/2 等用例天然承担（goto 后
  // 立即开文件，全绿即对照不回归）。修复方向：init 成功回 ack（workerAlive 置位解除看门狗）；
  // 修复后本用例转正。
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
// 且根因在 packages/highlight，按根因迁入本域文件，修复 PR 以本节为转正载体（t-md 侧
// 探索期编号占位一并转正）。同批探索期编号 BUG-40（worker 看门狗，md 围栏视角）与本文件
// 原 BUG-41 占位系上方 BUG-43 同一缺陷的重复锚点，已按权威编号收编删除（2026-10-10 整理）。

test.fixme('BUG-42 [探索]: 围栏代码块语言标识大小写不归一——Rust 大写写法静默丢失 tree-sitter 降级 hljs 兜底', async ({
  page
}) => {
  // 发现于 Markdown 渲染域、根因属 hl（packages/highlight/src/core-parse.ts）；复核成立
  // （low）。= 探索期编号 BUG-38（t-md.spec.ts 'BUG-38 [探索]' 用例，同一缺陷同判据，
  // 两占位一并转正）。
  // 根因：canonicalLang 两级查找（grammar 清单键/别名表）均区分大小写且未命中原样返回
  // （packages/highlight/src/core-parse.ts:243-245）；buildAliasTable 别名原样入表无
  // toLowerCase（core-parse.ts:376-382）；apps/web/build/grammars/manifest.json 实测 34 键
  // 全小写、无 Rust 键、rust 别名仅 ['rs']、bash 别名 ['sh','shell','zsh']——```Rust 不命中
  // 清单键与别名表，tree-sitter 路径静默丢失、降级 hljs（cls "language-Rust hljs"，仅
  // 2 个 hljs-* span），```rust 得 10 个 ts-* span；别名机制本身正常（```zsh 经别名表命中
  // bash grammar）。服务端 auto / 显式 remote / 本地注入三策略结果完全一致。hljs 兜底仍
  // 着色，仅质量降级且与同语言小写写法行为不一致。
  // 最小复现：注入含 ```rust / ```Rust / ```zsh 的 md → Rust 块 cls "language-Rust hljs"
  // 零 ts-* span（对照 rust 块 language-rust + 10 个 ts-* span）。
  // 证据（复核轮独立取得）：/tmp/vv-recheck-md-e4/recheck.mjs（server-auto 档块1
  // {cls:"language-rust",spanTotal:10,ts:10,hljs:0} vs 块6 {cls:"language-Rust hljs",
  // spanTotal:2,ts:0,hljs:2}；server-remote 与 local-injected 三组逐块一致）。
  // 修复方向：围栏语言经 toLowerCase（及别名查表）归一后再查 grammar；修复后转正。
  test.setTimeout(120_000);
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
