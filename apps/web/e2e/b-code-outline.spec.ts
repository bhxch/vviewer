import { expect, test, type Locator, type Page } from '@playwright/test';
import { injectDir, openTreeFile, type TextFileSpec } from './b-markdown-html-docs-helpers';
import { ensureRightDrawer } from './drawer';

/**
 * b-code-outline —— 代码大纲 + 右面板「目录|属性」切换器（2026-10-31 code-outline Task 3，
 * OUT 域）。spec：docs/superpowers/specs/2026-10-31-code-outline-panel-switch-design.md。
 *
 * 链路事实（源码锚，写作时已读）：
 * - 提取：tags.scm（highlight 包 assets/queries/<lang>/tags.scm）→ worker outline 通道
 *   → renderCode 全量 parse 完成后 fire-and-forget 填充（Task 2）→ getOutline 鸭子
 *   （窗口 inst 恒 []、firstVisibleLine 仅全量存在性透传）→ ViewerPane 轮询上行 →
 *   AppShell outlineEntries → OutlineView（Task 3）。
 * - 语言资产实况（现盘 grep 实证）：python tags.scm = class/function/constant +
 *   reference.call；typescript tags.scm（inherits _typescript）= function/method 签名面
 *   + interface_declaration/abstract_class/module + reference.type——ts 实现体
 *   （function_declaration/method_definition）不在捕获内，接口签名面即 API 面（T1 实测）；
 *   ocaml 有 wasm（static/grammars 34 语集）但 queries/ocaml/ 无 tags.scm → 真实
 *   tree-sitter parse 路径零大纲（OUT-05 的「无 tags 语言」载体）；perl（.pl）无 wasm
 *   → hljs 兜底路径（OUT-04 的降级载体）。
 * - 上行：ViewerPane 渲染 effect 一次性读（getToc :446 同位并列）+ 250ms 轮询 effect
 *   （异步到货面，getInspector 先例）；渲染失败/清理双路清空 → 切换器消失不抛错。
 * - 切换器：显隐 = tocEntries 与 outlineDefinitions（过滤 reference. 后）任一非空；
 *   默认落位「有目录默认目录」（未点过切换器时随数据面跟随）；互斥渲染
 *   OutlineView/Toc/MetaPanel。
 * - 滚动跟随：AppShell 200ms interval 读 metaStore 总线的 firstVisibleLine 句柄
 *   （仅全量实例）二分大纲表 → activeLine 下行高亮（窗口路径缺席静默不启用）。
 * - 点击跳转：OutlineView onclick(line) → AppShell 写激活 tab pendingLine（1 起）
 *   → ViewerPane 既有通道消费（revealLine → jumpToLine：目标行滚至视口中部 +
 *   vv-search-hit-line-active 行级临时高亮——GlobalSearchPanel BUG-09 同通道）。
 *
 * 注入通道：injectDir（b-markdown-html-docs-helpers，__vvOpenDirImpl + webkitRelativePath，
 * 纯前端本地管线）；3MB 载体按 HL-03 先例页内构造（免大参数跨 evaluate 拷贝）。
 * e2e 语法层：VV_GRAMMAR_CDN=cdn.grammars.test 被 mock 空清单（build:e2e 注入），
 * grammar 走同源 static/grammars 层——34 语 wasm 可用性与上文「语言资产实况」互为前提。
 * m3/b-markdown-html-docs-md07-09 的 markdown TOC 既有锚为 OUT 域回归网（定向同跑，
 * 目录视图默认落位语义下 nav.toc 照常渲染），本 spec 不重复断言。
 */

/** OUT-01/02 载体：class + 同级 def + 引用调用（reference.* 应被视图过滤）。
 * 行号锚（0 起）：class=0 / add=1 / run=4 / top_level=8 / helper=12；引用 2 条
 * （add、Calculator）不进视图 → 5 行。 */
const PY_OUTLINE = [
  'class Calculator:',
  '    def add(self, a, b):',
  '        return a + b',
  '',
  '    def run(self):',
  '        return self.add(1, 2)',
  '',
  '',
  'def top_level():',
  '    return Calculator()',
  '',
  '',
  'def helper():',
  '    pass',
  ''
].join('\n');

/** OUT-03 载体：interface + abstract class（ts tags 签名面：接口/方法签名/抽象类，
 * 实现体不捕获）+ reference.type 若干（过滤） */
const TS_OUTLINE = [
  'export interface Shape {',
  '    area(): number;',
  '}',
  '',
  'export abstract class BaseShape implements Shape {',
  '    abstract area(): number;',
  '}',
  ''
].join('\n');

/** OUT-06 载体：60 个同级 def（fn_i 首行 = 3i，0 起），视口数倍高度供滚动跟随 */
const PY_MANY_FNS = Array.from({ length: 60 }, (_, i) => `def fn${String(i).padStart(2, '0')}():\n    pass\n`).join('\n');

/** 打开文件并等代码渲染容器就绪（渲染入口走通后才有实例鸭子面） */
async function openCodeFile(page: Page, spec: TextFileSpec | TextFileSpec[], name: string): Promise<void> {
  await injectDir(page, Array.isArray(spec) ? spec : [spec]);
  await openTreeFile(page, name);
  await expect(page.locator('.vv-code-pre')).toBeVisible({ timeout: 30_000 });
}

/** 等大纲到货（切换器出现 = onoutline 上行链路全通） */
async function waitOutlineReady(page: Page): Promise<void> {
  await ensureRightDrawer(page, true);
  await expect(page.locator('.vv-right-switch')).toBeVisible({ timeout: 30_000 });
}

/** 大纲某行（按符号名边界匹配定位 li——'Shape' 不撞 'BaseShape'；行文本 =
 * kind 徽标 + 符号名，引用条目已过滤不参与撞名） */
function outlineRow(page: Page, name: string): Locator {
  const boundary = new RegExp(`(^|[^A-Za-z0-9_])${name}([^A-Za-z0-9_]|$)`);
  return page.locator('.vv-outline li').filter({ hasText: boundary });
}

test('OUT-01 · python 大纲渲染：树行可见、depth 缩进分层、kind 中文徽标、引用条目过滤', async ({ page }) => {
  test.setTimeout(60_000);
  await openCodeFile(page, { name: 'calc.py', content: PY_OUTLINE }, 'calc.py');
  await waitOutlineReady(page);

  // 默认落位：有大纲 → 目录视图（rightView 未被用户动过），目录段 aria-pressed
  await expect(page.locator('.vv-right-switch-btn', { hasText: '目录' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.vv-outline')).toBeVisible();

  // 引用过滤：全量 7 条（5 definition + 2 reference.call）只出 5 行
  await expect(page.locator('.vv-outline li')).toHaveCount(5);

  // 定义行与 kind 徽标（剥 definition. 前缀映射：class→类 / function→函数）
  const classRow = outlineRow(page, 'Calculator');
  await expect(classRow.locator('.vv-outline-kind')).toHaveText('类');
  await expect(classRow.locator('.vv-outline-name')).toHaveText('Calculator');
  await expect(outlineRow(page, 'top_level').locator('.vv-outline-kind')).toHaveText('函数');

  // depth 缩进：类（depth 0）0px，类内方法（depth 1）12px/层（spec §3 钳 8 层）
  const padOf = (row: Locator): Promise<string> => row.evaluate((el) => getComputedStyle(el).paddingLeft);
  expect(await padOf(classRow)).toBe('0px');
  expect(await padOf(outlineRow(page, 'add'))).toBe('12px');
});

test('OUT-02 · 大纲点击跳转：pendingLine 既有通道消费，目标行视口就位（行级高亮佐证）', async ({ page }) => {
  test.setTimeout(60_000);
  await openCodeFile(page, { name: 'calc.py', content: PY_OUTLINE }, 'calc.py');
  await waitOutlineReady(page);

  // fixwave 豁免锚（同 tab rev 重渲不清空大纲面板）：点击走 rev++ 全量重渲染通道，
  // 大纲面板不得自清空重建。先给首项 DOM 打标 + 读滚动位——面板若在重渲窗口闪空
  // （OutlineView 卸载重挂），键控 each 也救不回旧节点，标记必失，poll 短窗即红；
  // 即时断言（无 sleep）卡闪变发生点。5 项大纲在测试视口无溢出，scrollTop 恒 0，
  // 滚动位锚为字面稳定位，重建检测主证是 DOM 标记。
  const outlineBody = page.locator('.vv-outline');
  const firstItem = page.locator('.vv-outline li').first();
  await expect(firstItem).toContainText('Calculator');
  const scrollTopBefore = await outlineBody.evaluate((el) => el.scrollTop);
  await firstItem.evaluate((el) => {
    (el as HTMLElement & { __vvOutAnchor?: number }).__vvOutAnchor = 1;
  });

  // 点击 helper 行（0 起第 12 行）→ pendingLine 13 → 渲染 effect 重跑消费 revealLine(12)
  await outlineRow(page, 'helper').locator('button').click();

  // 即时断言（微任务 flush 已落地，协议往返远大于之）：右栏仍处目录视图（闪 meta
  // 即红）、大纲在场、首项未变
  await expect(page.locator('.vv-right-switch-btn', { hasText: '目录' })).toHaveAttribute('aria-pressed', 'true');
  await expect(outlineBody).toBeVisible();
  await expect(firstItem).toContainText('Calculator');

  // expect.poll 短窗确认不闪变：标记存活 = 点击后全程无卸载重建（闪变回翻窗口数百
  // ms，2s 窗覆盖）；滚动位同窗稳定（重建归零必红）
  await expect
    .poll(
      () =>
        firstItem.evaluate((el) => (el as HTMLElement & { __vvOutAnchor?: number }).__vvOutAnchor ?? 0),
      { timeout: 2_000 }
    )
    .toBe(1);
  await expect.poll(() => outlineBody.evaluate((el) => el.scrollTop), { timeout: 2_000 }).toBe(scrollTopBefore);

  // jumpToLine 目标行加 vv-search-hit-line-active（BUG-09 跳转同款行级高亮），data-line 0 起
  await expect(page.locator('.vv-code-line.vv-search-hit-line-active')).toHaveAttribute(
    'data-line',
    '12',
    { timeout: 30_000 }
  );
  await expect(page.locator('.vv-code-line.vv-search-hit-line-active')).toContainText('def helper');
});

test('OUT-03 · 切换器显隐矩阵：py 有 / ts 有 / md TOC 有 / 无大纲纯属性（互斥渲染与默认落位）', async ({ page }) => {
  test.setTimeout(120_000);
  const specs: TextFileSpec[] = [
    { name: 'calc.py', content: PY_OUTLINE },
    { name: 'shape.ts', content: TS_OUTLINE },
    { name: 'doc.md', content: '# 大纲文档\n\n正文一。\n\n## 小节甲\n\n正文二。\n' },
    { name: 'plain.txt', content: 'plain body\n' }
  ];
  await injectDir(page, specs);

  // py：大纲在 → 切换器 + OutlineView（默认目录）。mobile 断点右栏在抽屉内：
  // 断言前开抽屉、断言后关回——375px 双抽屉各 300px 宽存在热区重叠，右抽屉常开
  // 会拦截后续树行点击（e937d05 双抽屉独立开合语义的用例编排责任）
  await openTreeFile(page, 'calc.py');
  await ensureRightDrawer(page, true);
  await expect(page.locator('.vv-right-switch')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.vv-outline li')).toHaveCount(5, { timeout: 30_000 });
  await ensureRightDrawer(page, false);

  // ts：接口签名面（helix ts tags 即 API 签名面，T1 实测）→ 接口/类/方法行
  await openTreeFile(page, 'shape.ts');
  await ensureRightDrawer(page, true);
  await expect(page.locator('.vv-right-switch')).toBeVisible({ timeout: 30_000 });
  await expect(outlineRow(page, 'Shape').locator('.vv-outline-kind')).toHaveText('接口', { timeout: 30_000 });
  await expect(outlineRow(page, 'BaseShape').locator('.vv-outline-kind')).toHaveText('类');
  await ensureRightDrawer(page, false);

  // md：TOC 在 → 切换器 + Toc（md/code 大纲按数据源互斥；默认目录视图）
  await openTreeFile(page, 'doc.md');
  await ensureRightDrawer(page, true);
  await expect(page.locator('.vv-right-switch')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('nav.toc li button')).toHaveCount(2, { timeout: 30_000 });
  await expect(page.locator('.vv-outline')).toHaveCount(0);
  await ensureRightDrawer(page, false);

  // 无大纲无 TOC：切换器消失，纯属性（检查器/导出区块留属性视图——现状不回退）
  await openTreeFile(page, 'plain.txt');
  await ensureRightDrawer(page, true);
  await expect(page.locator('.vv-right-switch')).toHaveCount(0, { timeout: 30_000 });
  await expect(page.locator('.meta-panel')).toBeVisible();
});

test('OUT-04 · >2MB 窗口路径与 hljs 兜底路径均不出大纲（鸭子缺席上行 []，无切换器不抛错）', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/');
  await page.waitForFunction(
    () => typeof (window as unknown as { __vvOpenDirImpl?: unknown }).__vvOpenDirImpl === 'function'
  );

  // >2MB（窗口流式懒高亮，Task 2 契约：窗口 inst getOutline 恒 []）：48,000 行 ≈ 3.0MB
  await page.evaluate((rows) => {
    const lines: string[] = [];
    for (let i = 0; i < rows; i++) {
      const no = String(i).padStart(6, '0');
      lines.push(`v${no} = '${'x'.repeat(40)}'  # pad ${no}`);
    }
    const f = new File([lines.join('\n') + '\n'], 'big-3mb.py', { type: 'text/plain' });
    Object.defineProperty(f, 'webkitRelativePath', { value: `bout/big-3mb.py` });
    return (window as unknown as { __vvOpenDirImpl: (f: File[]) => void }).__vvOpenDirImpl([f]);
  }, 48_000);
  await openTreeFile(page, 'big-3mb.py');
  await expect(page.locator('.vv-code-pre .vv-code-line').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.vv-statusbar')).toContainText('高亮: tree-sitter', { timeout: 30_000 });
  // 渲染就绪且大纲轮询窗口已过（多轮 250ms tick）仍无切换器
  await page.waitForTimeout(1_200);
  await expect(page.locator('.vv-right-switch')).toHaveCount(0);
  await expect(page.locator('.vv-error-card')).toHaveCount(0);

  // hljs 兜底路径（.pl → perl：languages.json 在册、34 语 wasm 集无 → tree-sitter
  // 不入主路径，Task 2 契约 hljs 分支不投递 outline）：无切换器纯属性
  await injectDir(page, [{ name: 'lang.pl', content: 'sub greet {\n    return "hi";\n}\n' }]);
  await openTreeFile(page, 'lang.pl');
  await expect(page.locator('.vv-statusbar')).toContainText('高亮: hljs 兜底', { timeout: 30_000 });
  await page.waitForTimeout(1_200);
  await expect(page.locator('.vv-right-switch')).toHaveCount(0);
  await expect(page.locator('.vv-error-card')).toHaveCount(0);
});

test('OUT-05 · 无 tags 语言（ocaml：wasm 可用、queries 无 tags.scm）真实 parse 路径零大纲', async ({ page }) => {
  test.setTimeout(120_000);
  // 载体实况：static/grammars 34 语集含 ocaml.wasm（真实 tree-sitter parse），
  // assets/queries/ocaml/ 仅有 highlights/locals 无 tags.scm（写作时 ls 实证）→
  // 大纲 []，无正则兜底（Global Constraints）。
  await openCodeFile(page, { name: 'lang.ml', content: 'let greet () = "hi"\n\nlet () = print_endline (greet ())\n' }, 'lang.ml');
  // 先锚「高亮: tree-sitter」：证明不是 hljs 降级凑出的 []（否则断言空洞）
  await expect(page.locator('.vv-statusbar')).toContainText('高亮: tree-sitter', { timeout: 30_000 });
  await page.waitForTimeout(1_200); // 大纲轮询窗口（250ms × 数轮）过后仍无切换器
  await expect(page.locator('.vv-right-switch')).toHaveCount(0);
  await expect(page.locator('.meta-panel')).toBeVisible();
});

test('OUT-06 · 滚动跟随：滚动后激活高亮项随首可视行二分迁移（firstVisibleLine 句柄链路）', async ({ page }) => {
  test.setTimeout(120_000);
  await openCodeFile(page, { name: 'many.py', content: PY_MANY_FNS }, 'many.py');
  await waitOutlineReady(page);
  await expect(page.locator('.vv-outline li')).toHaveCount(60, { timeout: 30_000 });

  // 初始：首可视行 0 → 二分得 fn00（line 0）为激活项
  await expect
    .poll(() => page.locator('.vv-outline button.active').textContent(), { timeout: 30_000 })
    .toContain('fn00');

  // 定点滚动：scrollTop 800 / 行高 20px（e2e 默认字号行高，HL-03 同款锚）→
  // 首可视行 = 40 → 二分得最后一个 line ≤ 40 的定义 fn13（line 39；fn14 = 42 > 40）。
  // 不滚到底断言末项——首可视行是视口顶行，到底时激活项随视口高度漂移，非确定性。
  await page.locator('.vv-code-pre').evaluate((el) => {
    el.scrollTop = 800;
  });
  await expect
    .poll(() => page.locator('.vv-outline button.active').textContent(), { timeout: 30_000 })
    .toContain('fn13');
});
