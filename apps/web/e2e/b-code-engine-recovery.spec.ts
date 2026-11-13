import { test, expect, type Locator, type Page } from '@playwright/test';
import { closeDrawerIfOpened, openDrawerIfNarrow } from './drawer';

/**
 * 代码渲染器引擎修复批 ENG 域锚（spec E：docs/superpowers/specs/2026-11-12-code-renderer-engine-fixes-design.md
 * §4 ①③④⑤；计划 docs/superpowers/plans/2026-11-14-spec-E-code-engine-fixes.md Task 4）。
 *
 * 场景：
 * - OWX-E1：extless shebang+NUL 文件手选 code（MetaPanel .meta-openwith）→ 修 1 回填
 *   det.lang=python（dispatcher override 分支 shebang 探测，T1）→ tree-sitter。现状
 *   修复前 RED=ts-* 恒 0 走 hljsAuto（用户 bug 主诉）。
 * - ENG-N1/N2：清单外语言 setLang → hljs 兜底 + 状态栏结构化降级注记可见（不进错误卡）
 *   / 清单内语言 → tree-sitter 且无注记（T2 清单感知门 + EngineNote 上行）。
 * - ENG-R1/R2：worker 脚本 abort → failWorker 毒化（秒级，不候 15s 看门狗）→ hljs 兜底
 *   现状 → 显式切语言过 clientInitFailed 门 → recreate（T3）→ 恢复 tree-sitter；重建后
 *   新开文件不再永久 hljs（毒化不全会话永久）。
 * - ENG-R3：manifest abort → 三层全失败 → grammarManifest={}（worker 健康、清单全空，
 *   不 reject 形态）→ 清单外自动路径注记可见（spec §6 第 3 条）→ 显式切语言过
 *   grammarTableEmpty 门 → manifest 重取恢复 + 注记消失。
 *
 * 装置先例（不新造，计划 Global Constraints）：
 * - 目录注入 __vvOpenDirImpl / fill+blur 提交（b-override-lang LANG-01 装置同款）；
 * - MetaPanel 打开方式切换 .meta-openwith selectOption（t-open-with OPEN-06 同款）；
 * - 清单判定基准 = same-origin lite manifest（34 语言，rg 实查无 haskell / 有 rust、
 *   python）；e2e 构建单基 CDN 注入 cdn.grammars.test 恒失败为既有噪音。
 * - worker 构建产物 _app/immutable 深层 ts-worker-&#60;hash&#62;.js（route glob
 *   「双星 + /ts-worker*」匹配，块注释内避写通配符防提前闭合）。
 *
 * 断言口径：
 * - 「按 X 高亮」= .vv-code-pre span[class^="ts-"]（tree-sitter 产物）vs span[class^=
 *   "hljs-"]（hljs 兜底产物），LANG-01 前置对照同款双锚；
 * - 降级注记 = .vv-status-engine-note（T2 状态栏被动文本段；经 getMeta.engineNote
 *   → ViewerPane 250ms 轮询通道上行，轮询断言一律 expect.poll）；
 * - 降级非失败：错误卡 .vv-error-card count 0（spec 反目标边缘——注记不落错误卡）。
 */

/** rust 样例（b-override-lang RUST_SNIPPET 同源：fn/let 关键字必产 tree-sitter 捕获） */
const RUST_SNIPPET = 'fn main() {\n    let msg = "hello vviewer";\n    println!("{}", msg);\n}\n';

const PYTHON_SNIPPET = 'def greet():\n    print("hello vviewer")\n\n\ngreet()\n';

/** OWX-E1 载体：shebang 头 + NUL 正文——NUL 即二进制口径（detect magic.ts:55）→
 * looksTextual false（:49）→ 无扩展名二进制落 hex 兜底（BUG-07 C 项 hex 兜底链）；
 * 手选 code 后修 1 回填 det.lang=python（shebang 首行强信号，override 分支不加
 * looksTextual 门——T1 裁量落定）。 */
const SHEBANG_NUL_PY =
  '#!/usr/bin/env python\ndef greet():\n    print("hello vviewer")\n\ngreet()\n\x00\x00\x00\x00';

interface Payload {
  name: string;
  type: string;
  content?: string;
}

const REG_SPECIAL = /[.*+?^${}()|[\]\\]/g;

/** 等应用挂载（svelte:window drop 监听与 TabBar 就绪；b-override-lang 同款） */
async function waitAppMounted(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(
    () => typeof (window as unknown as { __vvOpenDirImpl?: unknown }).__vvOpenDirImpl === 'function'
  );
  await expect(page.locator('.vv-tabbar')).toBeVisible();
}

/** 目录注入通道（b-override-lang openDir 同款；label = webkitRelativePath 首段） */
async function openDir(page: Page, payloads: Payload[], label = 'eng'): Promise<void> {
  await page.waitForFunction(
    () => typeof (window as unknown as { __vvOpenDirImpl?: unknown }).__vvOpenDirImpl === 'function'
  );
  await page.evaluate(
    ({ payloads, label }) => {
      const files = payloads.map(({ name, type, content }) => {
        const f = new File([content ?? ''], name, { type: type ?? 'text/plain' });
        Object.defineProperty(f, 'webkitRelativePath', { value: `${label}/${name}` });
        return f;
      });
      return (window as unknown as { __vvOpenDirImpl: (f: File[]) => void }).__vvOpenDirImpl(files);
    },
    { payloads, label }
  );
}

/** 树行点击打开文件 tab（≤900px 抽屉断点适配，b-override-lang 同款） */
async function openFile(page: Page, name: string): Promise<void> {
  const drawer = await openDrawerIfNarrow(page);
  await page.locator('.vv-tree-row', { hasText: name }).click();
  await closeDrawerIfOpened(page, drawer);
  await expect(tabNamed(page, name)).toBeVisible();
}

/** 精确名 tab 定位（.vv-tab-name 子元素锚定） */
function tabNamed(page: Page, name: string): Locator {
  return page
    .locator('.vv-tab')
    .filter({
      has: page.locator('.vv-tab-name', { hasText: new RegExp(`^${name.replace(REG_SPECIAL, '\\$&')}$`) })
    });
}

/** ≤600px 断点右栏（MetaPanel）收进抽屉（b-override-lang 同款） */
async function openRightIfNarrow(page: Page): Promise<boolean> {
  const narrow = await page.evaluate(() => window.innerWidth <= 600);
  if (!narrow) return false;
  await page.locator('.vv-right-toggle').click();
  return true;
}

/** ≤600px 断点右抽屉关闭（openRightIfNarrow 配对；b-override-lang 同款——右抽屉
 * fixed 全高压住 tab 条与树行命中点，后继树交互前必须先关） */
async function closeRightIfOpened(page: Page): Promise<void> {
  const narrow = await page.evaluate(() => window.innerWidth <= 600);
  if (!narrow) return;
  const open = await page.evaluate(
    () => document.querySelector('.vv-shell')?.classList.contains('rightopen') ?? false
  );
  if (open) await page.locator('.vv-right-toggle').click();
}

/** 属性面板语言行填语言并提交：fill 只派发 input，blur 触发原生 change（MetaPanel
 * onLangCommit → setHighlightLang；b-override-lang setLang 同款） */
async function setLang(page: Page, lang: string): Promise<void> {
  const input = page.locator('.meta-lang-input');
  await expect(input).toBeVisible();
  await input.fill(lang);
  await input.blur();
}

// ---------------------------------------------------------------- OWX-E1

test('OWX-E1 extless shebang+NUL 文件手选 code → 修 1 回填 python 走 tree-sitter（spec §4 ①）', async ({
  page
}) => {
  test.setTimeout(60_000);
  await waitAppMounted(page);
  await openDir(page, [{ name: 'script-py', type: 'text/plain', content: SHEBANG_NUL_PY }]);
  await openFile(page, 'script-py');
  // 自动路径：NUL 判非文本 → hex 兜底（BUG-07 C 项 hex 兜底链；修复前该文件手选 code
  // 后 lang null 恒 hljsAuto——本用例修复前 RED=下方 ts-* 恒 0）
  await expect(page.locator('.vv-hex')).toBeVisible({ timeout: 20_000 });
  // 手选 code（override 重派，跳过探测链与 BUG-13 预检）：修 1 补 det.lang shebang 回填
  await openRightIfNarrow(page);
  await page.locator('.meta-openwith').selectOption('code');
  await expect(page.locator('.vv-code-pre')).toBeVisible({ timeout: 20_000 });
  // 修 1 回填 python → tree-sitter python（ts-* 出现；修复前恒 hljsAuto）
  await expect
    .poll(() => page.locator('.vv-code-pre span[class^="ts-"]').count(), { timeout: 30_000 })
    .toBeGreaterThan(0);
  // lang 回填直接证据：getMeta.lang 单源链（langOverride ?? 服务端头 ?? det.lang）
  // 本地文件前两者恒空 → 「语言: python」只能来自 det.lang 回填
  await expect(page.locator('.vv-statusbar')).toContainText('语言: python');
});

// ---------------------------------------------------------------- ENG-N1 / ENG-N2

test('ENG-N1 清单外语言 setLang → hljs 兜底 + 状态栏降级注记可见（不进错误卡，spec §4 ③）', async ({
  page
}) => {
  test.setTimeout(90_000);
  await waitAppMounted(page);
  await openDir(page, [{ name: 'notes.txt', type: 'text/plain', content: RUST_SNIPPET }]);
  await openFile(page, 'notes.txt');
  await expect(page.locator('.vv-code-pre')).toContainText('fn main()', { timeout: 20_000 });
  // 前置对照（LANG-01 同款）：.txt 无语言检测 → lang null → hljs 自动兜底，ts-* 恒 0
  await expect(page.locator('.vv-code-pre span[class^="ts-"]')).toHaveCount(0);
  await openRightIfNarrow(page);
  // haskell：languages.json 候选（datalist 301 名），lite manifest 34 语言不含（rg 实查）
  await setLang(page, 'haskell');
  // 清单感知门（T2）：跳过 doomed worker 往返 → hljs 兜底 + 结构化注记经 getMeta
  // engineNote → 250ms 轮询上行 → 状态栏被动文本段可见（含语言名）
  const note = page.locator('.vv-status-engine-note');
  await expect.poll(() => note.count(), { timeout: 30_000 }).toBeGreaterThan(0);
  await expect(note).toContainText('haskell');
  // 降级非失败（spec 反目标边缘）：不进错误卡；引擎面 hljs 兜底（ts-* 恒 0）
  await expect(page.locator('.vv-error-card')).toHaveCount(0);
  await expect(page.locator('.vv-code-pre span[class^="ts-"]')).toHaveCount(0);
});

test('ENG-N2 清单内语言 setLang rust → tree-sitter 且无注记（对照面，spec §4 ②承接）', async ({
  page
}) => {
  test.setTimeout(90_000);
  await waitAppMounted(page);
  await openDir(page, [{ name: 'notes2.txt', type: 'text/plain', content: RUST_SNIPPET }]);
  await openFile(page, 'notes2.txt');
  await expect(page.locator('.vv-code-pre')).toContainText('fn main()', { timeout: 20_000 });
  await openRightIfNarrow(page);
  // rust 在 lite manifest 内（rg 实查）→ 门不触发 → tree-sitter 正常路径（LANG-01 同链）
  await setLang(page, 'rust');
  await expect
    .poll(() => page.locator('.vv-code-pre span[class^="ts-"]').count(), { timeout: 30_000 })
    .toBeGreaterThan(0);
  // 清单内无注记：enginNote 缺席 → 状态栏注记段隐藏（ENG-N1 的对照面）
  await expect(page.locator('.vv-status-engine-note')).toHaveCount(0);
});

// ---------------------------------------------------------------- ENG-R1 / ENG-R2

test('ENG-R1/R2 worker 毒化 → 显式切语言门控重建恢复；新开文件不再永久 hljs（spec §4 ④⑤）', async ({
  page
}) => {
  test.setTimeout(120_000);
  // goto 前安装 worker 脚本 abort：脚本加载失败 → client onerror → failWorker 毒化
  //（秒级收敛，不候 15s 看门狗；route 先于 goto 安装使首个 worker 请求即被拦）
  await page.route('**/ts-worker*', (route) => route.abort());
  await waitAppMounted(page);
  // 三文件一次注入（同 label 二次 openDir 会因 storeId 去重被吞——见下 ENG-R1 注）
  await openDir(page, [
    { name: 'poison.py', type: 'text/plain', content: PYTHON_SNIPPET },
    { name: 'revive.txt', type: 'text/plain', content: RUST_SNIPPET },
    { name: 'poison2.py', type: 'text/plain', content: PYTHON_SNIPPET }
  ]);
  await openFile(page, 'poison.py');
  await expect(page.locator('.vv-code-pre')).toContainText('def greet()', { timeout: 20_000 });
  // 毒化收敛锚：worker 不可用全链降级现状 → hljs 兜底（ts-* 恒 0）
  await expect
    .poll(() => page.locator('.vv-code-pre span[class^="hljs-"]').count(), { timeout: 30_000 })
    .toBeGreaterThan(0);
  await expect(page.locator('.vv-code-pre span[class^="ts-"]')).toHaveCount(0);
  // 解除阻断：后续 worker 请求正常加载（重建的新 worker 可达）
  await page.unroute('**/ts-worker*');
  // —— ENG-R1：显式切语言（revive.txt 新 tab）→ 门控重建（clientInitFailed）→ 恢复 ——
  // 同 label 二次 openDir 会因 storeId=localfiles:<label> 去重命中被吞（addDirStoreTab
  // activate 返回，新文件不进树——本用例首轮实跑实证），三文件在首注入时一次带齐、
  // 分次 openFile（LANG-06 先例形态）
  await openFile(page, 'revive.txt');
  await expect(page.locator('.vv-code-pre')).toContainText('fn main()', { timeout: 20_000 });
  await openRightIfNarrow(page);
  await setLang(page, 'rust');
  // setHighlightLang（T3 接线）→ requestHighlightRecreate → 门三源 clientInitFailed=true
  // → 过门：detach 相位回 pending + dispose 毒化实例 + 重 create（unroute 后新 worker
  // 正常加载）→ 重渲染的 waitForAttachedClient 等到新 client → tree-sitter rust
  await expect
    .poll(() => page.locator('.vv-code-pre span[class^="ts-"]').count(), { timeout: 60_000 })
    .toBeGreaterThan(0);
  await expect(page.locator('.vv-statusbar')).toContainText('语言: rust');
  // —— ENG-R2：重建后新开第二个 .py 文件 → ts-* > 0（毒化不再全会话永久）——
  await closeRightIfOpened(page);
  await openFile(page, 'poison2.py');
  await expect(page.locator('.vv-code-pre')).toContainText('def greet()', { timeout: 20_000 });
  await expect
    .poll(() => page.locator('.vv-code-pre span[class^="ts-"]').count(), { timeout: 30_000 })
    .toBeGreaterThan(0);
});

// ---------------------------------------------------------------- ENG-R3

test('ENG-R3 worker 健康、清单全空 → 自动路径注记可见；显式切语言过 grammarTableEmpty 门重建恢复（spec §6 第 2/3 条）', async ({
  page
}) => {
  test.setTimeout(120_000);
  // goto 前安装 manifest abort：same-origin 层失败（CDN 层 e2e 构建恒失败为既有噪音、
  // serverBase 无连接）→ 三层全失败 → grammarManifest={}（不 reject——hljs 降级仍可用，
  // worker 本身健康）
  await page.route('**/grammars/manifest.json', (route) => route.abort());
  await waitAppMounted(page);
  await openDir(page, [{ name: 'empty-manifest.py', type: 'text/plain', content: PYTHON_SNIPPET }]);
  await openFile(page, 'empty-manifest.py');
  await expect(page.locator('.vv-code-pre')).toContainText('def greet()', { timeout: 20_000 });
  // 清单外自动路径（det.lang=python 不在空表）注记可见（spec §6 第 3 条的 e2e 面）：
  // 全量 start() hasLocal=false → 门 reject 折叠 → catch 注记 no-grammar-hljs → hljs 兜底
  const note = page.locator('.vv-status-engine-note');
  await expect.poll(() => note.count(), { timeout: 30_000 }).toBeGreaterThan(0);
  await expect(note).toContainText('python');
  await expect(page.locator('.vv-code-pre span[class^="ts-"]')).toHaveCount(0);
  // 解除阻断 → 显式动作过 grammarTableEmpty 门 → manifest 重取 → tree-sitter 恢复
  await page.unroute('**/grammars/manifest.json');
  await openRightIfNarrow(page);
  await setLang(page, 'rust');
  await expect
    .poll(() => page.locator('.vv-code-pre span[class^="ts-"]').count(), { timeout: 60_000 })
    .toBeGreaterThan(0);
  // 注记随重渲染新实例消失（新实例 rust 清单内 hasLocal=true，engineNote 缺席）
  await expect(page.locator('.vv-status-engine-note')).toHaveCount(0);
});
