import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect, type Page } from '@playwright/test';
import { closeDrawerIfOpened, openDrawerIfNarrow } from './drawer';

/**
 * theme-system 域缺口补齐（t- 前缀标记本轮新增；README §3.2：一域一文件、
 * 标题以场景编号开头、子场景加后缀）。与既有覆盖的分工（不重写既有文件）：
 * - THEME-01：域内唯一无用例场景——三态循环+整壳配色+localStorage 单键+刷新恢复。
 *   mobile.spec.ts:118 覆盖三态循环与 data-theme-mode 但无编号、且缺配色/持久键断言。
 * - THEME-03/2：THEME-03「214 个主题全部可切换且着色即时变化」判据——
 *   既有 b-theme-system THEME-03 仅连切 2 个主题且无下拉数量断言。
 * - THEME-06/2：THEME-06「9 个 --hljs-* 变量全量写入新色板（无默认残留）」严格形态——
 *   既有测试仅 keyword/comment 断言实际变化、其余仅非空；并补场景步骤⑤
 *   「换另一代码主题重复 ③④」（既有只切了 tokyonight 一个主题）。
 * - THEME-07/2：THEME-07 的 3MB 规模载体——既有载体 small.ts 仅 50 行；
 *   3MB ∈ (2MB, 200MB] 走统一懒高亮通道（hljs 分块路径已退役，域文档 4.3 口径过时），
 *   验证可视区懒高亮渲染下「切主题仅 style#vv-code-theme 变化」契约不因规模回退。
 */

// ── Node 侧主题表与 resolveCapture 复刻（期望值唯一来源：@vviewer/highlight 资产） ──

const THEMES_PATH = fileURLToPath(
  new URL('../../../packages/highlight/assets/themes.json', import.meta.url)
);
const THEMES = JSON.parse(readFileSync(THEMES_PATH, 'utf8')) as Record<
  string,
  Record<string, { fg?: string }>
>;
const THEME_COUNT = Object.keys(THEMES).length; // 实测 214

/** resolveCapture 逐级去 `.后缀` 回退（packages/highlight/src/theme.ts 同款实现）。 */
function resolveCaptureFg(theme: Record<string, { fg?: string }>, capture: string): string | null {
  let key = capture;
  for (;;) {
    const hit = theme[key];
    if (hit) return hit.fg ?? null;
    const dot = key.lastIndexOf('.');
    if (dot < 0) return null;
    key = key.slice(0, dot);
  }
}

/** M7 的 9 个 hljs 近似映射（apps/web/src/lib/theme.ts HLJS_CAPTURE_TO_VAR 全集）。 */
const HLJS_CAPTURE_TO_VAR: readonly (readonly [string, string])[] = [
  ['keyword', '--hljs-keyword'],
  ['string', '--hljs-string'],
  ['comment', '--hljs-comment'],
  ['constant.numeric', '--hljs-number'],
  ['function', '--hljs-title'],
  ['type', '--hljs-type'],
  ['variable', '--hljs-variable'],
  ['tag', '--hljs-tag'],
  ['attribute', '--hljs-attr']
];

/** 某主题下 9 个 --hljs-* 变量的期望取色（fg 缺失 → 变量不输出 → null）。 */
function expectedHljsVars(name: string): Record<string, string | null> {
  const theme = THEMES[name];
  if (!theme) throw new Error(`themes.json 无主题 ${name}`);
  return Object.fromEntries(HLJS_CAPTURE_TO_VAR.map(([c, v]) => [v, resolveCaptureFg(theme, c)]));
}

// ── 装置（与 b-theme-system.spec.ts 同款：页内 File 注入走 __vvOpenDirImpl 真实通道） ──

interface Payload {
  name: string;
  type: string;
  content: string;
}

async function openDir(page: Page, payloads: Payload[]): Promise<void> {
  await page.waitForFunction(
    () => typeof (window as unknown as { __vvOpenDirImpl?: unknown }).__vvOpenDirImpl === 'function'
  );
  await page.evaluate((payloads) => {
    const files = payloads.map(({ name, type, content }) => {
      const f = new File([content], name, { type });
      Object.defineProperty(f, 'webkitRelativePath', { value: `ttheme/${name}` });
      return f;
    });
    return (window as unknown as { __vvOpenDirImpl: (f: File[]) => void }).__vvOpenDirImpl(files);
  }, payloads);
}

async function openFile(page: Page, name: string): Promise<void> {
  const drawer = await openDrawerIfNarrow(page);
  await page.locator('.vv-tree-row', { hasText: name }).click();
  await closeDrawerIfOpened(page, drawer);
  await expect(page.locator('.vv-tab.active', { hasText: name })).toBeVisible();
}

/** style#vv-code-theme 的注释头形如「/* vviewer 代码主题：<name>（<mode>）…」（theme.ts applyCodeTheme）。 */
function themeCommentHeader(page: Page, name: string): Promise<boolean> {
  return page.evaluate(
    (n) => (document.getElementById('vv-code-theme')?.textContent ?? '').includes(`代码主题：${n}（`),
    name
  );
}

/** 壳层 --ui-bg 原始声明值（Lightning CSS 会把 #ffffff 压成 #fff，先展开 3 位 hex 再比较；
 * 逻辑复制自 b-theme-system.spec.ts THEME-02）。 */
async function uiBg(page: Page): Promise<string> {
  return page.evaluate(() => {
    const v = getComputedStyle(document.documentElement).getPropertyValue('--ui-bg').trim();
    const m = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(v);
    return m && m[1] && m[2] && m[3]
      ? `#${m[1]}${m[1]}${m[2]}${m[2]}${m[3]}${m[3]}`.toLowerCase()
      : v;
  });
}

function savedThemeMode(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    try {
      const raw = localStorage.getItem('vviewer:settings');
      return raw ? (JSON.parse(raw)?.themeMode ?? null) : null;
    } catch {
      return null;
    }
  });
}

/** 可视区 ts-* span 类名序列指纹 + head 子节点签名 + style 文本（THEME-07 既有手法）。 */
function signature(page: Page) {
  return page.evaluate(() => ({
    head: [...document.head.children].map((el) => `${el.tagName}#${el.id}`).join('|'),
    spans: [...document.querySelectorAll('.vv-code-pre span[class^="ts-"]')]
      .map((s) => s.className)
      .join('|'),
    styleText: document.getElementById('vv-code-theme')?.textContent ?? ''
  }));
}

/** 指纹稳定化：懒高亮 chunk 异步落定期间类名序列可能追加，稳定两轮后才采信。 */
async function stableSignature(page: Page) {
  let prev = await signature(page);
  for (let i = 0; i < 25; i++) {
    await page.waitForTimeout(100);
    const cur = await signature(page);
    if (cur.spans === prev.spans && cur.head === prev.head) return cur;
    prev = cur;
  }
  return prev;
}

// ── 场景载体片段 ──

/** tree-sitter 主路径载体（typescript 在内嵌 lite 集，m2.spec.ts sample.ts 同通道）。 */
const TS_SNIPPET = 'const a: number = 1; // c\n';

/** hljs 整文件兜底载体：perl 不在内嵌 grammar 集（b-theme-system THEME-06 同款）。 */
const PERL_SNIPPET = `# perl 脚本（hljs 兜底）
use strict;
use warnings;

my %counts;
open my $fh, '<', $ARGV[0] or die "cannot open $ARGV[0]: $!";
while (my $line = <$fh>) {
    for my $word (split /\\s+/, lc $line) {
        $counts{$word}++;
    }
}
close $fh;

for my $word (sort { $counts{$b} <=> $counts{$a} } keys %counts) {
    printf "%-20s %d\\n", $word, $counts{$word};
}
`;

// ── 用例 ──

test('THEME-01: 三态循环（跟随系统→亮→暗→跟随系统）、整壳配色变化、localStorage 单键持久与刷新恢复', async ({
  page
}) => {
  await page.goto('/');
  const themeBtn = page.getByRole('button', { name: /主题：/ });
  const mode = () => page.locator('html').getAttribute('data-theme-mode');

  // 初始态：settings 默认 themeMode=system（settings.ts DEFAULTS）
  await expect(page.locator('html')).toHaveAttribute('data-theme-mode', 'system');
  await expect(themeBtn).toHaveText('主题：跟随系统');
  const bgLight = await uiBg(page);
  expect(bgLight).toBe('#ffffff'); // headless 默认 prefers light

  // ① system → 亮：按钮文案、data-theme-mode、整壳配色、localStorage 单键同步
  await themeBtn.click();
  await expect(page.locator('html')).toHaveAttribute('data-theme-mode', 'light');
  await expect(themeBtn).toHaveText('主题：亮');
  await expect.poll(() => savedThemeMode(page)).toBe('light');
  expect(await uiBg(page)).toBe(bgLight); // 亮态壳层配色不变（light 亮色板）

  // ② 亮 → 暗：整壳 UI 配色可见变化 + 单键更新
  await themeBtn.click();
  await expect(page.locator('html')).toHaveAttribute('data-theme-mode', 'dark');
  await expect(themeBtn).toHaveText('主题：暗');
  await expect.poll(() => savedThemeMode(page)).toBe('dark');
  await expect.poll(uiBg.bind(null, page)).toBe('#0d1117'); // 与亮态实际不同色

  // ③ 暗 → 跟随系统：循环闭环，配色还原亮色板（headless system 解析为亮）
  await themeBtn.click();
  await expect(page.locator('html')).toHaveAttribute('data-theme-mode', 'system');
  await expect(themeBtn).toHaveText('主题：跟随系统');
  await expect.poll(uiBg.bind(null, page)).toBe(bgLight);

  // ④ 暗态 F5 刷新：主题态与刷新前一致（持久于 localStorage 并恢复）
  await themeBtn.click(); // system → light
  await expect(page.locator('html')).toHaveAttribute('data-theme-mode', 'light');
  await themeBtn.click(); // light → dark
  await expect(page.locator('html')).toHaveAttribute('data-theme-mode', 'dark');
  expect(await savedThemeMode(page)).toBe('dark');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme-mode', 'dark');
  await expect(page.getByRole('button', { name: /主题：/ })).toHaveText('主题：暗');
  await expect.poll(() => savedThemeMode(page)).toBe('dark');
  await expect.poll(uiBg.bind(null, page)).toBe('#0d1117');
});

test('THEME-03/2: 代码主题下拉全量可切——option 集=themes.json 键集、214 项逐项落 DOM、着色即时变化', async ({
  page
}, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', '跟随 THEME-03 主场景桌面基准（chromium project）');
  test.setTimeout(120_000);
  await page.goto('/');
  await openDir(page, [{ name: 'opts.ts', type: 'text/plain', content: TS_SNIPPET.repeat(20) }]);
  await openFile(page, 'opts.ts');
  await expect(page.locator('.vv-code-pre span[class^="ts-"]').first()).toBeVisible({
    timeout: 20_000
  });

  // 下拉 option 全集与 themes.json 键集一一对应（TopBar themeOptions：精选置顶+全部字母序）
  const optionValues = await page.evaluate(() =>
    [...document.querySelectorAll('select[aria-label="代码主题"] option')].map((o) => o.value)
  );
  const tableNames = Object.keys(THEMES);
  expect(optionValues.length, `下拉项数=themes.json 主题数(${THEME_COUNT})`).toBe(tableNames.length);
  expect([...optionValues].sort()).toEqual([...tableNames].sort());

  // 页内全量遍历（与用户切换同管线：改 select value + change 事件，THEME-07 既有手法），
  // 逐项断言 style#vv-code-theme 注释头落上该主题名；统计 --vv-ts-keyword 去重色数证「着色即时变化」
  const result = await page.evaluate(async (names) => {
    const sel = document.querySelector<HTMLSelectElement>('select[aria-label="代码主题"]');
    const style = document.getElementById('vv-code-theme');
    const missed: string[] = [];
    const kwColors = new Set<string>();
    for (const n of names) {
      sel!.value = n;
      sel!.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0)); // applyCodeTheme 微任务链（loadTables 已缓存）后读
      const text = style?.textContent ?? '';
      if (!text.includes(`代码主题：${n}（`)) missed.push(n);
      const m = /--vv-ts-keyword:\s*([^;]+);/.exec(text);
      if (m) kwColors.add(m[1]!.trim());
    }
    return { missed, distinctKeywordColors: kwColors.size, final: sel!.value };
  }, tableNames);
  expect(result.missed, '全部主题切换后注释头均落 DOM').toEqual([]);
  expect(result.final).toBe(tableNames[tableNames.length - 1]);
  // 214 主题实测 130 个去重 keyword 取色（5 个缺 fg 不输出）——>1 即证着色随主题实际变化
  expect(result.distinctKeywordColors).toBeGreaterThan(1);
});

test('THEME-06/2: 9 个 --hljs-* 变量逐项等于主题表取色（tokyonight→gruvbox 双主题，无默认残留）', async ({
  page
}, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', '跟随 THEME-06 主场景桌面基准（chromium project）');
  test.setTimeout(120_000);
  await page.goto('/');
  await openDir(page, [{ name: 'theme06.pl', type: 'text/plain', content: PERL_SNIPPET }]);
  await openFile(page, 'theme06.pl');
  await expect(page.locator('.vv-statusbar')).toContainText('高亮: hljs 兜底', { timeout: 30_000 });
  await expect(page.locator('.vv-code-pre span[class^="hljs-"]').first()).toBeVisible({
    timeout: 30_000
  });

  /** style#vv-code-theme 内 9 个 --hljs-* 变量实测值（未输出=null）。 */
  const readVars = (theme: string) =>
    page.evaluate((t) => {
      const text = document.getElementById('vv-code-theme')?.textContent ?? '';
      const out: Record<string, string | null> = {};
      for (const [, v] of [
        ['keyword', '--hljs-keyword'],
        ['string', '--hljs-string'],
        ['comment', '--hljs-comment'],
        ['constant.numeric', '--hljs-number'],
        ['function', '--hljs-title'],
        ['type', '--hljs-type'],
        ['variable', '--hljs-variable'],
        ['tag', '--hljs-tag'],
        ['attribute', '--hljs-attr']
      ] as const) {
        const m = new RegExp(`${v}:\\s*([^;]+);`).exec(text);
        out[v] = m ? m[1]!.trim() : null;
      }
      return { headerOk: text.includes(`代码主题：${t}（`), vars: out };
    }, theme);

  // 场景步骤③④⑤：切主题后 9 个变量逐项 === 主题表 resolveCapture 取色（严格全等，
  // fg 缺失的变量须不输出——「无默认残留」的精确形态）；换另一主题重复
  for (const theme of ['tokyonight', 'gruvbox']) {
    await page.getByLabel('代码主题').selectOption(theme);
    await expect
      .poll(() => readVars(theme), { timeout: 10_000 })
      .toEqual({ headerOk: true, vars: expectedHljsVars(theme) });

    // 视口内 hljs span 计算色与变量一致（探针元素直用同一 var 表达式；全 9 类，缺类跳过）
    const mismatches = await page.evaluate(() => {
      const probe = document.createElement('div');
      probe.style.display = 'none';
      document.body.append(probe);
      const bad: string[] = [];
      for (const cls of [
        'hljs-keyword',
        'hljs-string',
        'hljs-comment',
        'hljs-number',
        'hljs-title',
        'hljs-type',
        'hljs-variable',
        'hljs-tag',
        'hljs-attr'
      ]) {
        const span = document.querySelector(`.vv-code-pre span.${cls}`);
        if (!span) continue; // 载体片段未必触发全部 9 类
        const varName = `--hljs-${cls.slice('hljs-'.length)}`;
        probe.style.color = `var(${varName})`;
        if (getComputedStyle(span).color !== getComputedStyle(probe).color) bad.push(cls);
      }
      probe.remove();
      return bad;
    });
    expect(mismatches, `${theme} 视口 span 计算色与变量一致`).toEqual([]);
  }
});

test('THEME-07/2: 3MB 懒高亮通道下切主题仅 style#vv-code-theme 变化（head 签名/可视区 span 指纹不变、落 DOM 亚毫秒级）', async ({
  page
}, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', '跟随 THEME-07 主场景桌面基准（chromium project）');
  test.setTimeout(180_000);
  await page.goto('/');
  // 19B × 160000 = 3.04MB ∈ (2MB, 200MB] → 统一懒高亮通道（阶段 4 接替 hljs 分块，
  // m2.spec.ts 6MB 用例同构）：可视区 chunk 渲染，36 万 span 全量同驻 DOM 的旧口径不复存在
  await openDir(page, [
    { name: 'big3m.js', type: 'text/javascript', content: 'const vv = 1; // c\n'.repeat(160000) }
  ]);
  await openFile(page, 'big3m.js');
  await expect(page.locator('.vv-statusbar')).toContainText('高亮: tree-sitter', {
    timeout: 30_000
  });
  await expect(page.locator('.vv-code-pre span[class^="ts-"]').first()).toBeVisible({
    timeout: 30_000
  });
  await expect(page.locator('.vv-code-pre span[class^="hljs-"]')).toHaveCount(0); // 懒高亮主路径不落 hljs

  // 滚至中部，让可视区 chunk 指纹稳定后再采信基线
  const pre = page.locator('.vv-code-pre');
  await pre.evaluate((el) => {
    el.scrollTop = 100000;
  });
  const base = await stableSignature(page);
  expect(base.spans.length, '滚动后可视区已有 ts-* span').toBeGreaterThan(0);

  // 页内触发切换（与用户同管线），MutationObserver 测 style#vv-code-theme 落 DOM 耗时
  const durationMs = await page.evaluate(
    () =>
      new Promise<number>((resolve, reject) => {
        const el = document.getElementById('vv-code-theme');
        const sel = document.querySelector<HTMLSelectElement>('select[aria-label="代码主题"]');
        if (!el || !sel) {
          reject(new Error('style#vv-code-theme 或代码主题下拉不存在'));
          return;
        }
        const t0 = performance.now();
        const mo = new MutationObserver(() => {
          mo.disconnect();
          resolve(performance.now() - t0);
        });
        mo.observe(el, { childList: true, subtree: true, characterData: true });
        sel.value = 'github_dark';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        setTimeout(() => reject(new Error('5000ms 内未观察到主题样式落 DOM')), 5000);
      })
  );
  console.log(
    `[perf] 3MB 懒高亮通道切主题落 DOM 耗时: ${durationMs.toFixed(2)}ms（报告口径 0.5~0.8ms）`
  );
  expect(durationMs).toBeLessThan(50); // 宽松阈值防环境抖动（b-theme-system THEME-07 同口径）

  const after = await stableSignature(page);
  expect(after.head).toBe(base.head); // head 子节点结构签名不变
  expect(after.spans).toBe(base.spans); // 可视区 span 类名序列逐字不变（零重解析）
  expect(after.styleText).not.toBe(base.styleText); // 变化的仅是 style#vv-code-theme 文本
  expect(await themeCommentHeader(page, 'github_dark')).toBe(true);
});

// ── 主题系统域探索复核确认缺陷回归占位（2026-10-10 轮）──────────────────────────
// README §3.2.4 第 4 条：修复合入前以 test.fixme 落占位并在标题/注释标注缺陷号，缺陷修复
// PR 中转为正式断言。标题以缺陷库编号开头、[探索] 标注来源（缺陷由探索/复核会话独立复现
// 确认）；各用例注释给出最小复现步骤、证据路径与源码定位。分诊：三条根因均属本域（theme），
// 不外迁——BUG-49 主题三态①×代码主题双槽位②（TopBar.svelte/theme.ts）；BUG-50 缺口在代码
// 主题注入清单 CODE_CAPTURES（theme.ts:48-102）与 app.css .ts-* 规则的对齐层，非 packages/
// highlight 高亮链路（resolveCapture 前缀回退机制正常、themes.json 可经回退取到色）；
// BUG-51 为三态①首帧落 html[data-theme-mode] 的时机（app.html 无预置脚本、唯一写入点
// AppShell onMount）。

test.fixme('BUG-49 [探索]: themeMode=system 下 OS 亮暗切换后 TopBar mode 陈旧——代码主题下拉显示与实际生效脱钩，切主题写错槽位并污染另一槽位', async () => {
  // 现象：themeMode=「跟随系统」页面加载后，OS 亮暗切换（不刷新页面）会——
  //   a) 顶栏「代码主题」下拉显示值与实际生效主题脱钩：下拉仍显示旧槽位主题，
  //      实际已应用另一槽位主题（style#vv-code-theme 注释头与 body 背景已切走）；
  //   b) 此时在下拉切换主题：按陈旧 mode 写入错误槽位（写入与用户眼前亮暗相反的槽位），
  //      且下拉值随即跳变为另一槽位主题；之后切到该亮暗态可见槽位被用户从未在该态
  //      选过的主题污染（已持久化进 localStorage）。
  // 根因（已核对源码）：
  //   - apps/web/src/lib/TopBar.svelte:24 `let mode = $derived(effectiveMode(settings.themeMode))`
  //     仅追踪 settings.themeMode；apps/web/src/lib/theme.ts:210-215 effectiveMode 每次实时读
  //     matchMedia，而 matchMedia 非响应式信号 → OS 切换不触发 mode 重算（保持陈旧值）；
  //   - TopBar.svelte:40-43 onSystemModeChange 回调仅调 applyCodeTheme 重应用样式，不更新任何 $state；
  //   - TopBar.svelte:60-66 onCodeThemeChange 以 `if (mode === 'dark') …` 按陈旧 mode 决定写槽
  //     （62-63 行判槽用旧值；65 行 applyCodeTheme 时 saveSettings→notify→settings 整体替换已
  //     触发 derived 重算读到新值——「写槽旧值、生效新值」劈叉，实测注释确为「onelight（dark）」）。
  // 最小复现（chromium colorScheme 仿真）：
  //   1) colorScheme:light 打开 baseURL，localStorage 写 vviewer:settings=
  //      {"themeMode":"system","codeThemeLight":"github_light","codeThemeDark":"gruvbox",…} 并刷新；
  //   2) 不刷新页面，仿真切 prefers-color-scheme:dark；
  //   3) select[aria-label="代码主题"].value 仍=github_light，而 style#vv-code-theme 注释已变
  //      「代码主题：gruvbox（dark）」、body 背景 rgb(13,17,23)——下拉显示与实际生效脱钩；
  //   4) 下拉选 onelight → localStorage 变 codeThemeLight:"onelight"（codeThemeDark 仍 gruvbox，
  //      即写入与眼前暗态相反的亮槽位），style 变 onelight（dark），select 显示跳回 gruvbox；
  //   5) 点主题按钮切到亮态 → 亮槽位出现用户从未在亮态选过的 onelight。
  // 证据：上报探测 apps/web/.temp/explore-theme/p1-shell.mjs（p1-out.json）两轮 + p3-verify.mjs
  //   A 段独立复现、数值一致；复核独立脚本 /tmp/vv-recheck-theme-E1/recheck.mjs（Playwright
  //   chromium + colorScheme 仿真）在纯前端档 4199 与服务端档 8391 均完整复现、四项判定全 true。
  //   对照：刷新页面（mode 正确初始化）后暗态下拉选 github_dark 正确写入 codeThemeDark、亮槽位
  //   不受影响——缺陷仅限「OS 切换后未刷新」的陈旧 mode 场景。
  // 转正提示：修复方向 = mode 响应式化（matchMedia 变更接入 $state）或 onSystemModeChange 同步
  //   更新 mode 状态；按 3)4)5) 逆命题落断言（OS 切换后下拉显示恒=实际生效主题；下拉写槽恒=
  //   用户眼前亮暗对应槽位；两槽位互不污染）。
});

test.fixme('BUG-50 [探索]: CODE_CAPTURES 53 项清单与各语言 highlights.scm 实际产出系统性缺口——数字/布尔/存储类关键字等 ts-span 恒不着色、切主题不变', async () => {
  // 现象（校准 medium：主题功能局部失效，对照 span 如 string/comment/function/type 均正常变色，
  //   非崩溃/数据丢失/完全不可用）：tree-sitter 主路径下，代码主题注入清单 CODE_CAPTURES
  //   （apps/web/src/lib/theme.ts:48-102，53 项）与各语言 highlights.scm 实际产出的 capture 集
  //   存在系统性缺口；span 类名是全量 capture 点转 `-`（packages/render-text/src/code.ts:420 经
  //   packages/highlight/src/theme.ts:31-33 captureToCssClass，无前缀回退），app.css:55-81 的
  //   .ts-* 规则也只覆盖这 53 项——数字字面量、布尔、fn/let/mut（keyword.storage*）、return 等
  //   高频 token 的 span（ts-constant-numeric-integer / ts-keyword-storage /
  //   ts-keyword-control-return 等）在任何代码主题下都无 CSS 规则、无注入变量，恒为 inherit
  //   默认前景色 rgb(31,35,40)，切主题不变。long.rs 视口 413 个 ts-span 中 63 个（15%）恒不着色。
  // 静态差集（本分诊以同口径脚本重跑，数值与上报逐项一致）：CODE_CAPTURES=53；rust 实际 54/
  //   命中 34/缺 20（含 keyword.storage、keyword.storage.modifier(.mut/.ref)、keyword.storage.type、
  //   keyword.control.return、constant.numeric.integer/.float、constant.builtin.boolean）、
  //   go 37/24/13、ecma 41/29/12、c 32/24/8、python 33/26/7；缺口更广（scss 缺 26、djot 缺 21、
  //   markdown 缺 15，约 240 个语言至少缺 1）。机制：resolveCapture 最长前缀回退
  //   （packages/highlight/src/theme.ts:15-24）只用于 themeToCssVars 注入 CODE_CAPTURES 变量
  //   （apps/web/src/lib/theme.ts:191），span 类名与 CSS 规则两端均无回退；themes.json 虽无
  //   keyword.storage/constant.numeric.integer 直接键，经前缀回退可解析到色（github_light 的
  //   constant.numeric=#0550ae、github_dark=#79c0ff）——缺口纯在清单与 CSS 对齐层（均本域文件，
  //   非高亮链路缺陷）。
  // 最小复现：服务端档 8391 连接后打开 domain-theme-system/long.rs（tree-sitter 主路径），对
  //   .ts-keyword-storage/.ts-keyword-control-return/.ts-constant-numeric-integer span 依次在代码
  //   主题 github_light→catppuccin_mocha→github_dark 下读 getComputedStyle().color——恒为
  //   rgb(31,35,40)；同视口 .ts-string/.ts-comment-line 三主题明显变色
  //   （如 .ts-string rgb(10,48,105)→rgb(166,227,161)→rgb(165,214,255)）。
  // 证据：上报脚本 .temp/explore-theme/p3-verify.mjs B 段；复核探针（chromium headless 1280x900，
  //   8391 档连接→domain-theme-system/long.rs）实测三主题 style#vv-code-theme 均不含
  //   --vv-ts-keyword-storage / -keyword-control-return / -constant-numeric-integer /
  //   -constant-builtin-boolean（--vv-ts-string 等为 true），span 计数 18/9/36、未着色 63/413
  //   （三主题一致），全部数值与上报 p3 段 B 逐字吻合。
  // 转正提示：修复 = CODE_CAPTURES 补齐各语言实际产出的 capture（或 span 类名/CSS 规则两端接入
  //   前缀回退）+ app.css .ts-* 规则同步（theme.test.ts 双向校验一并更新）；断言按上述三类 span
  //   在 ≥2 主题下计算色随主题变化落。
});

test.fixme('BUG-51 [探索]: 暗色偏好用户每次导航/刷新先渲染完整亮色首帧——app.html 无预置脚本，data-theme-mode 唯一写入点是 AppShell onMount', async () => {
  // 现象：系统偏好暗色用户每次导航/刷新都先渲染完整亮色首帧（白底、html 无 data-theme-mode
  //   属性），直至 JS bundle 执行写入 data-theme-mode 后才恢复暗色。独立复现 6/6：本地白帧期约
  //   17~167ms（首访最长，二/三访因缓存缩短至 17~44ms；网络越慢越长）；仅影响暗色偏好用户
  //   （light 偏好对照组全程白底无闪烁）。
  // 根因（已核对源码）：apps/web/src/app.html:3-7 head 仅两条 meta theme-color、无内联预置脚本；
  //   apps/web/src/app.css:6 亮色默认（--ui-bg:#ffffff）、:29 body background:var(--ui-bg)，暗色
  //   变量全部挂在 :root[data-theme-mode="dark"]（:13-19）与 @media(prefers-color-scheme:dark)
  //   :root[data-theme-mode="system"]（:20-27）之下；rg 全源码确认 data-theme-mode 唯一写入点是
  //   apps/web/src/lib/AppShell.svelte:51 onMount——暗色恢复唯一入口在 JS bundle 执行之后。
  // 最小复现（chromium）：
  //   1) newContext({colorScheme:'dark'})；addInitScript 在 document-start 挂 rAF 逐帧采样
  //      getComputedStyle(document.body).backgroundColor 与 html data-theme-mode；
  //   2) 导航到 baseURL（4199/8391 同样）：首帧 body 背景 rgb(255,255,255) 且 html 无
  //      data-theme-mode 属性，持续至 JS 挂载写入 data-theme-mode=system 后变暗
  //      （复核实测 4199 首访 60→227ms、二访 21→54ms、三访 32→49ms；8391 首访 12→162ms、
  //      二访 11→44ms、三访 16→49ms）；
  //   3) 交叉验证：route abort 全部 *.js 后页面永久停在白底/mode=null（两站 5s 采样均仅一帧）
  //      → 暗色唯一入口在 JS；light 对照组首尾均白底、无闪烁。
  // 证据：复核脚本 /tmp/review-theme-e3/fouc.mjs（6 组采样全部复现；视觉证据 dark-early.png
  //   完整亮色 UI / dark-settled.png #0d1117）；上报脚本 .temp/explore-theme/p5-fouc.mjs 4 组
  //   采样全部复现（4199 首访 77→147ms、8391 首访 30→173ms，同一量级）。
  // 转正提示：修复 = app.html head 加内联预置脚本（按 localStorage/默认值在 %sveltekit.head%
  //   之前写 data-theme-mode）；断言 = colorScheme:dark 下 rAF 首帧采样 body 背景即暗色、
  //   html 首帧即带 data-theme-mode 属性。
});
