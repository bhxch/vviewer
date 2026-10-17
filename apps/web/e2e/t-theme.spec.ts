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
 * - B-THEME-1..4：外观主题端到端（spec B §2.1-2.3，vscode-themes 计划 Task 5）——
 *   设置面板暗色槽切 Dark Modern 的 UI token+代码高亮联动、JSON 导入应用与刷新
 *   （IndexedDB）恢复、合成最小 VSIX 导入、切回 default 观感零变化 + 槽/主题亮暗
 *   不匹配提醒出现/消失（spec §2.3 终审补）。桌面基准
 *   （chromium project，同 03/2/06/2/07/2 惯例）。期望值唯一来源：
 *   packages/highlight/assets/vscode/*.json 资产原值（大小写混杂，注入文本为运行时
 *   textContent 不经构建压缩，按原值断言；#1F1F1F 等保持大写）。
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
    [
      ...document.querySelectorAll<HTMLOptionElement>('select[aria-label="代码主题"] option')
    ].map((o) => o.value)
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

// ── B 项外观主题（spec B §2.1-2.3，vscode-themes 计划 Task 5）────────────────────
// 桌面基准（chromium project）：导入/IndexedDB/页内探针为重量级场景，同 03/2/06/2/07/2
// 的跳非 chromium 惯例。装置走真实用户管线：设置面板（⚙）双槽 select、隐藏 file input
// 的 setInputFiles、主题按钮三态循环切亮暗。

/** jszip 最窄构造面（export = 的 CJS 包，互操作形态对齐 render-archive zipStore.ts 同款：
 * ESM 下类挂 default、Node 直出 module.exports 本体，二者取其一）。 */
interface ZipBuilder {
  file(path: string, content: string): void;
  generateAsync(opts: { type: 'nodebuffer' }): Promise<Buffer>;
}

/** Node 侧合成最小 VSIX（B-THEME-3）：extension/package.json + contributes.themes 一条
 * + 主题 JSON。浏览器侧消费走真实 createZipStore 解包管线。 */
async function makeVsix(files: Record<string, string>): Promise<Buffer> {
  const mod = await import('jszip');
  const JSZip = (mod as unknown as { default?: new () => ZipBuilder }).default ?? (mod as unknown as new () => ZipBuilder);
  const zip = new JSZip();
  for (const [path, content] of Object.entries(files)) zip.file(path, content);
  return zip.generateAsync({ type: 'nodebuffer' });
}

/** 主题按钮三态循环到目标亮暗（新 context 的 localStorage 为默认 system；headless
 * prefers light，故 light 一次点击、dark 两次——THEME-01 同通道）。 */
async function gotoInMode(page: Page, mode: 'light' | 'dark'): Promise<void> {
  await page.goto('/');
  const themeBtn = page.getByRole('button', { name: /主题：/ });
  await expect(page.locator('html')).toHaveAttribute('data-theme-mode', 'system');
  await themeBtn.click();
  if (mode === 'dark') await themeBtn.click();
  await expect(page.locator('html')).toHaveAttribute('data-theme-mode', mode);
}

/** 打开设置面板（⚙ aria-label「设置」→ role=dialog）。 */
async function openSettings(page: Page): Promise<void> {
  await page.getByRole('button', { name: '设置' }).click();
  await expect(page.getByRole('dialog', { name: '设置' })).toBeVisible();
}

/** style#vv-code-theme 注入全文（运行时 textContent，未经验练压缩，按原值断言）。 */
function injectedStyle(page: Page): Promise<string> {
  return page.evaluate(() => document.getElementById('vv-code-theme')?.textContent ?? '');
}

/** :root 上任意 UI token 计算值（JS 注入的 --ui-* 原样保留资产大小写）。 */
function uiVar(page: Page, name: string): Promise<string> {
  return page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);
}

test('B-THEME-1: 暗色槽切 Dark Modern——UI token 与代码高亮联动（注入文本 + 视口 span 探针）', async ({
  page
}, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', '桌面基准（同 THEME-03/2 惯例）');
  await gotoInMode(page, 'dark');
  await openDir(page, [{ name: 'b1.ts', type: 'text/plain', content: TS_SNIPPET.repeat(20) }]);
  await openFile(page, 'b1.ts');
  await expect(page.locator('.vv-code-pre span[class^="ts-"]').first()).toBeVisible({ timeout: 20_000 });
  expect(await uiBg(page)).toBe('#0d1117'); // 切换前基线：default 外观暗色板

  // 暗色槽 → vscode:Dark Modern（面板 persist 后即时重注入）
  await openSettings(page);
  await page.getByLabel('暗色界面主题').selectOption('vscode:Dark Modern');

  // UI token：dark_modern 资产原值（12 键映射 dark 命中 8 键，取三个代表键；缺键走
  // app.css default 回退，不在断言面——README「上游现状备注」）
  await expect.poll(() => uiBg(page)).toBe('#1F1F1F');
  expect(await uiVar(page, '--ui-side-bg')).toBe('#181818');
  expect(await uiVar(page, '--ui-accent')).toBe('#0078D4');
  // 注入文本：外观头 + UI vars 段 + tokenColors 映射的注释色（Markpad 基准值）
  const text = await injectedStyle(page);
  expect(text).toContain('/* vviewer 外观主题：vscode:Dark Modern（dark）');
  expect(text).toContain('--ui-bg: #1F1F1F;');
  expect(text).toContain('--vv-ts-comment: #6A9955;');
  // 代码主题下拉被接管禁用（TopBar appearanceTakesOver）
  await expect(page.getByLabel('代码主题')).toBeDisabled();

  // 视口探针（THEME-06/2 同手法泛化）：每个出现过的 ts-* 类，其注入变量
  // --vv-<类名> 的计算色与 span 计算色逐类一致
  const scan = await page.evaluate(() => {
    const probe = document.createElement('div');
    probe.style.display = 'none';
    document.body.append(probe);
    const checked: string[] = [];
    const bad: string[] = [];
    for (const span of document.querySelectorAll('.vv-code-pre span[class^="ts-"]')) {
      const cls = span.className;
      if (checked.includes(cls)) continue;
      const varName = `--vv-${cls}`;
      if (getComputedStyle(document.documentElement).getPropertyValue(varName).trim() === '') continue;
      checked.push(cls);
      probe.style.color = `var(${varName})`;
      if (getComputedStyle(span).color !== getComputedStyle(probe).color) bad.push(cls);
    }
    probe.remove();
    return { checked, bad };
  });
  expect(scan.checked.length, '至少一个 ts-* 类的映射变量已注入').toBeGreaterThan(0);
  expect(scan.bad, '视口 span 计算色与外观注入变量逐类一致').toEqual([]);
});

test('B-THEME-2: 导入 JSON 主题并应用、刷新后 IndexedDB 持久恢复', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', '桌面基准（同 THEME-03/2 惯例）');
  await gotoInMode(page, 'dark');
  await openSettings(page);

  // 合法主题 JSON 经隐藏 file input 注入（真实 onchange 管线）
  const probe = {
    name: 'Probe Dark',
    type: 'dark',
    colors: { 'editor.background': '#123456', 'sideBar.background': '#234567', focusBorder: '#ABCDEF' },
    tokenColors: [{ scope: 'comment', settings: { foreground: '#654321' } }]
  };
  await page.locator('.vv-settings input[type="file"]').setInputFiles({
    name: 'probe-dark.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(probe))
  });
  await expect(page.locator('.vv-settings-note', { hasText: '已导入 1 个主题' })).toBeVisible();
  await expect(page.locator('.vv-settings-theme-name', { hasText: 'Probe Dark' })).toBeVisible();

  // 暗色槽选导入主题（value 是随机 imported:<id>，按 label 选）：--ui-bg 等于注入值
  await page.getByLabel('暗色界面主题').selectOption({ label: 'Probe Dark（暗）' });
  await expect.poll(() => uiBg(page)).toBe('#123456');
  expect(await uiVar(page, '--ui-side-bg')).toBe('#234567');
  expect(await uiVar(page, '--ui-accent')).toBe('#ABCDEF');
  expect(await injectedStyle(page)).toContain('--vv-ts-comment: #654321;');

  // reload：槽位（localStorage）+ 主题体（IndexedDB）双持久，恢复选中且生效
  await page.reload();
  await expect.poll(() => uiBg(page), { timeout: 10_000 }).toBe('#123456');
  expect(await injectedStyle(page)).toMatch(/\/\* vviewer 外观主题：imported:.+（dark）——/);
  await openSettings(page);
  // 槽 select 的 imported option 异步填充（listThemes IndexedDB）后才回显持久值，
  // 轮询到回显完成（option 未齐时 select.value 为空串）
  await expect(page.getByLabel('暗色界面主题')).toHaveValue(/^imported:/, { timeout: 10_000 });
});

test('B-THEME-3: 导入合成最小 VSIX（package.json + contributes.themes + 主题 JSON）', async ({
  page
}, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', '桌面基准（同 THEME-03/2 惯例）');
  const vsix = await makeVsix({
    'extension/package.json': JSON.stringify({
      name: 'vv-probe-themes',
      publisher: 'probe',
      contributes: { themes: [{ label: 'Vsix Probe', path: './themes/probe-dark.json' }] }
    }),
    'extension/themes/probe-dark.json': JSON.stringify({
      name: 'Vsix Probe',
      type: 'dark',
      colors: { 'editor.background': '#246824' },
      tokenColors: [{ scope: 'comment', settings: { foreground: '#864286' } }]
    })
  });

  await gotoInMode(page, 'dark');
  await openSettings(page);
  await page.locator('.vv-settings input[type="file"]').setInputFiles({
    name: 'probe-themes.vsix',
    mimeType: 'application/octet-stream',
    buffer: vsix
  });
  // 清单 label → 主题名「Vsix Probe」入库；列表行带 vsix 来源徽标
  await expect(page.locator('.vv-settings-note', { hasText: '已导入 1 个主题' })).toBeVisible();
  await expect(page.locator('.vv-settings-theme', { hasText: 'Vsix Probe' })).toBeVisible();
  await expect(page.locator('.vv-settings-theme-src', { hasText: 'vsix' })).toBeVisible();
  // 槽 select 候选同步出现（kind 徽标「暗」）；选中即应用
  await page.getByLabel('暗色界面主题').selectOption({ label: 'Vsix Probe（暗）' });
  await expect.poll(() => uiBg(page)).toBe('#246824');
});

test('B-THEME-4: 外观槽切回 default——观感零变化（--ui-bg 回默认、注入文本回 legacy 形态）；亮暗不匹配提醒随匹配度出现/消失', async ({
  page
}, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', '桌面基准（同 THEME-03/2 惯例）');
  await gotoInMode(page, 'light');
  await openSettings(page);
  // 亮色槽 → Dark Modern（槽/主题亮暗不匹配不阻止）：UI token 被接管
  await page.getByLabel('亮色界面主题').selectOption('vscode:Dark Modern');
  await expect.poll(() => uiBg(page)).toBe('#1F1F1F');
  // 不匹配提醒（spec §2.3 终审补）：亮槽选暗色主题出现一行提醒，且选择未被阻止
  //（上一行 --ui-bg 轮询到 #1F1F1F 即证已应用）
  await expect(page.locator('.vv-settings-warn', { hasText: '亮色槽' })).toBeVisible();
  // 切回匹配主题（Light Modern）：提醒消失，配色为亮色资产值
  await page.getByLabel('亮色界面主题').selectOption('vscode:Light Modern');
  await expect(page.locator('.vv-settings-warn')).toHaveCount(0);
  await expect.poll(() => uiBg(page)).toBe('#FFFFFF');
  // 切回 default：--ui-bg 回亮色默认；注入文本回 legacy 形态（代码主题注释头，
  // UI vars 段消失；byte 级 legacy 等价由 theme.test.ts legacyExpectedText 单测锁定）
  await page.getByLabel('亮色界面主题').selectOption('default');
  await expect.poll(() => uiBg(page)).toBe('#ffffff');
  const text = await injectedStyle(page);
  expect(text).toContain('/* vviewer 代码主题：onelight（light）');
  expect(text).not.toContain('--ui-');
  // 接管解除：代码主题下拉恢复可用
  await expect(page.getByLabel('代码主题')).toBeEnabled();
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

// 修复背景（原占位注释压缩）：themeMode=system 下 OS 亮暗切换（不刷新页面）后 TopBar 的
// mode 陈旧（effectiveMode 实时读 matchMedia 但 matchMedia 非响应式信号）——代码主题下拉
// 显示与实际生效主题脱钩；此时切主题按陈旧 mode 写错槽位（写入与眼前亮暗相反的槽）并污染
// 另一槽位。修复 = TopBar 以 $state 镜像 matchMedia.matches（onSystemModeChange 回调同步），
// mode 的 derived 依赖链闭合，下拉显示与 onCodeThemeChange 写槽恒等于实际生效亮暗。
test('BUG-49 转正: themeMode=system 下 OS 亮暗切换后下拉显示=实际生效，写槽不串位', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      'vviewer:settings',
      JSON.stringify({ themeMode: 'system', codeThemeLight: 'github_light', codeThemeDark: 'gruvbox' })
    );
  });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/');
  const select = page.getByLabel('代码主题');
  await expect(select).toHaveValue('github_light'); // 亮槽
  // OS 切暗（不刷新）：下拉显示值跟随实际生效主题（修复前仍显示 github_light，
  // 而 style#vv-code-theme 注释头已切 gruvbox（dark）——显示与生效脱钩）
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(select).toHaveValue('gruvbox');
  await expect.poll(() => themeCommentHeader(page, 'gruvbox')).toBe(true);
  // 此时切主题：写入眼前暗态对应的暗槽，亮槽不受污染（修复前按陈旧 mode 写亮槽
  // codeThemeLight，且下拉值随即跳变为另一槽位主题）
  await select.selectOption('github_dark');
  const saved = (await page.evaluate(() => localStorage.getItem('vviewer:settings') ?? '{}')) as string;
  const parsed = JSON.parse(saved) as { codeThemeDark?: string; codeThemeLight?: string };
  expect(parsed.codeThemeDark).toBe('github_dark');
  expect(parsed.codeThemeLight).toBe('github_light');
  await expect.poll(() => themeCommentHeader(page, 'github_dark')).toBe(true);
  // 切回亮态：亮槽记忆仍是用户当初的 github_light（两槽位互不污染）
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(select).toHaveValue('github_light');
});

/** hex #rrggbb → getComputedStyle 的 rgb(r, g, b) 形态（注入变量取 themes.json fg 原值）。 */
function hexToRgb(hex: string): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1]!, 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

/** 视口内指定类名 span 中文本为 text 的计算色（无匹配返回 null）。 */
async function spanColor(page: Page, cls: string, text: string): Promise<string | null> {
  return page.evaluate(
    ([c, t]) => {
      const el = [...document.querySelectorAll(`.vv-code-pre span.${c}`)].find(
        (s) => s.textContent === t
      );
      return el ? getComputedStyle(el).color : null;
    },
    [cls, text] as const
  );
}

// 修复背景（原占位注释压缩）：tree-sitter 主路径下 CODE_CAPTURES（53 项）与各语言
// highlights.scm 实际产出的 capture 集存在系统性缺口——span 类名是全量 capture 点转 `-`
//（无前缀回退），数字/布尔/存储类关键字等细粒度 capture（约 240 语言至少缺 1）的 span
// 无 CSS 规则、无注入变量，任何代码主题下恒 inherit。修复 = 类名端接前缀归约
//（highlight 包 resolveCaptureClass：最长前缀命中 CODE_CAPTURES 清单，清单内恒等），
// renderLineHtml 改走归约——类名 ⊂ 清单 = 注入变量集 = app.css .ts-* 规则集，三面永久
// 对齐；清单/注入文本/app.css 规则均不膨胀（Spec B vscode 移植逐键全等约束不触碰）。
test('BUG-50 转正: 数字/布尔/存储类关键字 token 归约着色并随代码主题切换变化', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      'vviewer:settings',
      JSON.stringify({ themeMode: 'light', codeThemeLight: 'github_light' })
    );
  });
  await page.goto('/');
  const rust = 'fn main() {\n    let count: u32 = 42;\n    let ok = true;\n    if ok { return; }\n}\n';
  await openDir(page, [{ name: 'captures.rs', type: 'text/plain', content: rust }]);
  await openFile(page, 'captures.rs');
  // tree-sitter 主路径（hljs 兜底的 span 是 hljs-* 类，不产 ts-* span）
  await expect(page.locator('.vv-statusbar')).toContainText('高亮: tree-sitter', { timeout: 20_000 });
  // 修复前这些 token 的 span 类名是清单外细粒度名（ts-constant-numeric-integer /
  // ts-constant-builtin-boolean / ts-keyword-storage / ts-keyword-control-return）——
  // 归约后挂最近语义父级类名，细粒度类名不再出现
  await expect(page.locator('.vv-code-pre span.ts-constant-numeric-integer')).toHaveCount(0);
  const num = page.locator('.vv-code-pre span.ts-constant-numeric', { hasText: '42' });
  await expect(num).toHaveCount(1, { timeout: 20_000 });
  const numFg = resolveCaptureFg(THEMES['github_light']!, 'constant.numeric')!;
  const boolFg = resolveCaptureFg(THEMES['github_light']!, 'constant.builtin')!;
  const kwFg = resolveCaptureFg(THEMES['github_light']!, 'keyword')!;
  expect(await spanColor(page, 'ts-constant-numeric', '42')).toBe(hexToRgb(numFg));
  expect(await spanColor(page, 'ts-constant-builtin', 'true')).toBe(hexToRgb(boolFg));
  expect(await spanColor(page, 'ts-keyword', 'let')).toBe(hexToRgb(kwFg));
  // return @keyword.control.return → 归约 keyword.control（清单内子捕获，注入色经主题
  // 表 keyword.control 精确键或前缀回退）
  expect(await spanColor(page, 'ts-keyword-control', 'return')).toBe(
    hexToRgb(resolveCaptureFg(THEMES['github_light']!, 'keyword.control')!)
  );
  // 切主题：归约 span 的计算色随注入变量整体切换（零重解析契约——类名不动只换变量）
  await page.getByLabel('代码主题').selectOption('catppuccin_mocha');
  const numFg2 = resolveCaptureFg(THEMES['catppuccin_mocha']!, 'constant.numeric')!;
  const boolFg2 = resolveCaptureFg(THEMES['catppuccin_mocha']!, 'constant.builtin')!;
  const kwFg2 = resolveCaptureFg(THEMES['catppuccin_mocha']!, 'keyword')!;
  expect(numFg2.toLowerCase()).not.toBe(numFg.toLowerCase()); // 资产保证「随主题变化」可判定
  await expect.poll(() => spanColor(page, 'ts-constant-numeric', '42')).toBe(hexToRgb(numFg2));
  await expect.poll(() => spanColor(page, 'ts-constant-builtin', 'true')).toBe(hexToRgb(boolFg2));
  await expect.poll(() => spanColor(page, 'ts-keyword', 'let')).toBe(hexToRgb(kwFg2));
});

// BUG-51 首帧采样探针：document-start 起 rAF 逐帧记录 body 背景 + html
// data-theme-mode（原复现探针同口径；body 未解析出的帧跳过，保证帧 0 必有背景值）。
async function sampleFirstFrames(page: Page, settings: Record<string, unknown> | null): Promise<void> {
  await page.addInitScript((s) => {
    if (s !== null) localStorage.setItem('vviewer:settings', JSON.stringify(s));
    const w = window as unknown as { __vvFrames?: { bg: string; mode: string | null }[] };
    w.__vvFrames = [];
    const sample = (): void => {
      if (document.body) {
        w.__vvFrames!.push({
          bg: getComputedStyle(document.body).backgroundColor,
          mode: document.documentElement.getAttribute('data-theme-mode')
        });
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }, settings);
}

function firstFrames(page: Page): Promise<{ bg: string; mode: string | null }[]> {
  return page.evaluate(() =>
    (window as unknown as { __vvFrames: { bg: string; mode: string | null }[] }).__vvFrames.slice(0, 3)
  );
}

// 修复背景（原占位注释压缩）：暗色偏好用户每次导航/刷新都先渲染完整亮色首帧（FOUC）——
// data-theme-mode 唯一写入点曾是 AppShell onMount，暗色恢复唯一入口在 JS bundle 执行之后。
// 修复 = app.html head 内联预置脚本（%sveltekit.head% 之前按 localStorage vviewer:settings
// 的 themeMode 写 data-theme-mode，缺省 system；与 AppShell dataset 写入逐值同口径）。
test('BUG-51 转正: colorScheme:dark 首帧即暗——预置脚本先于 JS bundle 落 html[data-theme-mode]', async ({ page }) => {
  await sampleFirstFrames(page, null); // 无快照 → loadSettings 默认 themeMode=system
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');
  await expect(page.locator('.vv-topbar')).toBeVisible(); // 应用已挂载（采样窗口覆盖挂载前后）
  const [first] = await firstFrames(page);
  expect(first!.mode).toBe('system');
  expect(first!.bg).toBe('rgb(13, 17, 23)'); // 首帧即暗（修复前 rgb(255,255,255) 且 mode=null）
});

test('BUG-51 转正: 显式 themeMode=dark 在 colorScheme:light 下首帧即暗', async ({ page }) => {
  await sampleFirstFrames(page, { themeMode: 'dark' });
  await page.goto('/'); // OS 偏好 light：显式 dark 槽优先，预置脚本同样命中
  await expect(page.locator('.vv-topbar')).toBeVisible();
  const [first] = await firstFrames(page);
  expect(first!.mode).toBe('dark');
  expect(first!.bg).toBe('rgb(13, 17, 23)');
});

test('BUG-51 转正: light 对照组首帧即亮、采样帧全程无暗色闪烁', async ({ page }) => {
  await sampleFirstFrames(page, { themeMode: 'light' });
  await page.goto('/');
  await expect(page.locator('.vv-topbar')).toBeVisible();
  const frames = await firstFrames(page);
  expect(frames.length).toBeGreaterThan(0);
  for (const f of frames) {
    expect(f.mode).toBe('light');
    expect(f.bg).toBe('rgb(255, 255, 255)');
  }
});
