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
 *   → hljs 兜底路径（OUT-04 的降级载体）；javascript tags.scm = 具名 function_expression /
 *   function_declaration / class / method 等 definition.* + reference.call（锚整个
 *   call_expression，调用实参内的具名函数表达式即「被过滤 ref 内存活 def」——OUT-12 载体）。
 * - 上行：ViewerPane 渲染 effect 一次性读（getToc :446 同位并列）+ 250ms 轮询 effect
 *   （异步到货面，getInspector 先例）；渲染失败/清理双路清空 → 切换器消失不抛错。
 * - 切换器：显隐 = tocEntries 与 outlineDefinitions（过滤 reference. 后）任一非空；
 *   默认落位「有目录默认目录」（未点过切换器时随数据面跟随）；互斥渲染
 *   OutlineView/Toc/MetaPanel。
 * - 滚动跟随：AppShell 200ms interval 读 metaStore 总线的 firstVisibleLine 句柄
 *   （仅全量实例）二分大纲表 → activeLine 下行高亮（窗口路径缺席静默不启用）；
 *   门限截断（OUT-11）后二分吃 outlineDisplayed 显示集（与 OutlineView 渲染端
 *   同源切片，outlineTruncate.ts 单点），截断态高亮恒有对应行。
 * - 点击跳转：OutlineView onclick(line) → AppShell 写激活 tab pendingLine（1 起）
 *   → ViewerPane 既有通道消费（revealLine → jumpToLine：目标行滚至视口中部 +
 *   vv-search-hit-line-active 行级临时高亮——GlobalSearchPanel BUG-09 同通道）。
 * - 默认落位/touched 台账：rightView/rightViewTouched（AppShell.svelte:133-135）——
 *   默认落位 effect 读数据写视图、touched 后不写（:218-221），段级点击置 touched
 *   （:1349-1374）；OUT-08 锚 touched 跨文件保持 + 未 touched 新页对照。
 * - depth 钳制：OutlineView 渲染端 outlineLogicalDepths 重算逻辑深度，钳制单点
 *   OUTLINE_DEPTH_CLAMP=8（outlineDepth.ts:23，12px/层 → 上界 96px）；OUT-09 锚
 *   11 层嵌套钉界与容器无横向溢出。
 * - 在飞 outline 失效面：实例 destroy 撤在飞（renderCode.ts:520 → client.cancelOutline
 *   lang 级，client.ts:247-250）+ 迟到 resolve 被 destroyed 拦截（renderCode.ts:487）+
 *   ViewerPane lastSeenTab 跨 tab 清空门（:580）；OUT-10 锚切走零串台 + 切回重建。
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

/** OUT-11 载体：2400 个同级 def（> OUTLINE_TRUNCATE_LIMIT 2000，门限常量由
 * outlineTruncate.test.ts 锁死），紧凑两行块（块内 join，块间 join('\n') 无空行
 * ——PY_MANY_FNS 式带尾换行块会插出空行使 fn_i 首行 = 3i，首轮红根因），fn_i
 * 首行 = 2i（0 起），总 4800 行；显示集末项 fn1999（line 3998）为截断态跟随
 * 口径断言的数学锚。通道如实：Node 侧模块常量经 injectDir → page.evaluate
 * base64 跨进程拷贝（b-markdown-html-docs-helpers.ts），90KB 体量无拷贝负担；
 * ≈2MB 尺度锚不走此通道——见 OUT-07 页内构造（HL-03/OUT-04 先例） */
const PY_TRUNCATED_FNS =
  Array.from({ length: 2400 }, (_, i) => `def fn${String(i).padStart(4, '0')}():\n    pass`).join('\n') + '\n';

/** OUT-12 载体 1（嵌于存活 def 内）：被过滤引用节点内存活的定义。js tags：
 * `(call_expression function: (identifier) @name) @reference.call` 锚整个调用表达式，
 * `(function_expression name: (identifier) @name) @definition.function` 捕获具名函数
 * 表达式——实参内的 alpha/beta 在 byte 范围上嵌于 register 调用内。python 的 def/class
 * 不能出现在调用表达式内，构造不出此形态。真实 javascript.wasm + tags.scm 实测 raw
 * depth（outline.ts pairsToOutline 全量口径栈深，reference.* 同样入栈）：outer 0 /
 * register（reference.call）1 / alpha 2 / beta 2 / gamma 1 / tail 0。AppShell 过滤
 * register 后 alpha/beta 仍带 raw 2，显示集内却无 depth 1 父行——直读即跳层。 */
const JS_NESTED_REF = [
  'function outer() {',
  '    register(function alpha() {',
  '        return 1;',
  '    }, function beta() {',
  '        return 2;',
  '    });',
  '    function gamma() {',
  '        return 3;',
  '    }',
  '}',
  'function tail() {',
  '    return 4;',
  '}',
  ''
].join('\n');

/** OUT-12 载体 2（顶层引用兄弟，复审 Blocking 2 区分口径锚）：setup 与
 * describe(ref)>it(ref)>namedTest 为顶层兄弟——describe/it 均具名标识符调用
 * （tags.scm `(call_expression function: (identifier) @name) @reference.call` 锚整个
 * call_expression 被过滤），匿名 function 无 name 不捕获（`name:` 必选）。真实 grammar
 * 实测过滤集 [setup raw0 [0,19), namedTest raw2 [68,114)]：namedTest 的 byte 范围不在
 * setup 内，真值 0px。载体 1 对「raw depth 栈」与「byte 区间栈」两法同值（[0,1,1,1,0]），
 * 对近似实现盲；本载体 raw 栈法把 namedTest 误挂为 setup 子项（12px）——唯 byte 区间
 * 栈（outline.ts 同款重跑）得 0px，锁死重算口径本身。 */
const JS_SIBLING_REF = [
  'function setup() {}',
  "describe('suite', function () {",
  "    it('works', function namedTest() {",
  '        return 1;',
  '    });',
  '});',
  ''
].join('\n');

/** OUT-09 载体：11 层嵌套 class（A0 起逐层嵌套至 A10，raw depth 0..10）+ 末层
 * def deep()（raw 11）。python tags.scm 的 @definition.class 锚整个 class_definition
 * 节点（assets/queries/python/tags.scm:3-4），byte 区间含嵌套 body → 提取端
 * byteEnd 开放栈逐层 +1（outline.ts:79-89）；12 条目全 definition，无引用过滤面，
 * 文档序 = li 序（A0…A10、deep），缩进断言按序全读。 */
const PY_DEEP_NEST = (() => {
  const lines: string[] = [];
  for (let i = 0; i <= 10; i++) lines.push(`${'    '.repeat(i)}class A${i}:`);
  lines.push(`${'    '.repeat(11)}def deep():`);
  lines.push(`${'    '.repeat(12)}pass`);
  return `${lines.join('\n')}\n`;
})();

/** OUT-10 载体：1500 def × 8 行体（15,000 行 ≈195KB）——条目 < 门限 2000 不触
 * 截断（OUT-11 机械面不掺入，恰值计数可精确断言），体量使 worker outline 到货
 * 窗口达数百 ms 量级（场景档时序控制：切换动作落窗内）；函数体内 assignment 非
 * module 直子、不入 python tags constant 捕获（tags.scm:1 结构限定）→ 条目恰
 * 1500 无漂移。 */
const PY_RACE_FNS = Array.from({ length: 1500 }, (_, i) =>
  [
    `def fn${String(i).padStart(4, '0')}():`,
    ...Array.from({ length: 8 }, (_, j) => `    v${j} = ${j}`),
    ''
  ].join('\n')
).join('\n');

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

test('OUT-07 · ≈2MB python 全量+大纲同窗性能锚（场景档钉值）：首屏 ≤20s / 截断大纲到货 ≤30s 恰 2000 行 / 打开窗口内可滚动', async ({ page }) => {
  test.setTimeout(180_000);
  // 载体页内构造（HL-03/OUT-04 先例：__vvOpenDirImpl 免大参数跨 evaluate 拷贝
  // ——≈2MB 经 base64 evaluate 拷贝不可取）。80,000 def × 24B/def（紧凑两行块）=
  // 1,920,000B < 2MiB 窗口阈值（TREE_SITTER_MAX_BYTES = 2*1024*1024，
  // vviewer-render-text strategy.ts:89）→ 全量实例路径（≥ 阈值落窗口模式 outline
  // 恒 []，OUT-04 契约）；大纲条目 8 万（万级）——未截断前全量 li 渲染正是卡顿
  // 源，截断后渲染恒 2000。fn_i 首行 = 2i，总 16 万行。
  await page.goto('/');
  await page.waitForFunction(
    () => typeof (window as unknown as { __vvOpenDirImpl?: unknown }).__vvOpenDirImpl === 'function'
  );
  const builtBytes = await page.evaluate((defs) => {
    const chunks: string[] = [];
    let buf = '';
    for (let i = 0; i < defs; i++) {
      buf += `def fn${String(i).padStart(5, '0')}():\n    pass\n`;
      if (buf.length > 262_144) {
        chunks.push(buf);
        buf = '';
      }
    }
    chunks.push(buf);
    const f = new File(chunks, 'perf-2mb.py', { type: 'text/plain' });
    Object.defineProperty(f, 'webkitRelativePath', { value: 'bout/perf-2mb.py' });
    (window as unknown as { __vvOpenDirImpl: (f: File[]) => void }).__vvOpenDirImpl([f]);
    return f.size;
  }, 80_000);
  // ≈2MB 尺度实证（场景档 §4：判定按构造后字节数）——防构造退化成小文件假绿
  expect(builtBytes).toBeGreaterThan(1_900_000);

  // ① 首屏时限锚（场景档钉值 ≤20s：全量渲染先行，outline worker fire-and-forget
  // 不阻塞首屏——spec §2.2 架构承诺的行为级表达；不用 openCodeFile 的 30s 口径）
  await openTreeFile(page, 'perf-2mb.py');
  await expect(page.locator('.vv-code-pre .vv-code-line').first()).toBeVisible({ timeout: 20_000 });

  // ② 截断大纲到货锚（≤30s）：切换器出现 = 上行链路全通；截断后渲染恒 2000
  //（计数便宜——场景档「禁万级计数」顾虑已被截断化解）+ 提示条可见
  await waitOutlineReady(page);
  await expect(page.locator('.vv-outline li').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.vv-outline li')).toHaveCount(2000, { timeout: 30_000 });
  await expect(page.locator('.vv-outline-truncate-text')).toHaveText('大纲超过 2000 条，仅显示前 2000 条');

  // ③ 打开窗口内代码可滚动（主线程无长任务佐证，场景档③）：scrollTop 写入生效
  // + 可视行内容自洽更新到底段 fn799xx——虚拟行 DOM 随滚动换窗（未虚拟化则此
  // 断言在打开完成时即已满足，同为自洽）。滚到底 DOM 自洽锚（scrollHeight-
  // clientHeight，不做行高换算）；'fn799' 前缀覆盖 fn79900-fn79999，滚到底首可视
  // 行 = 160000 - 视口行数，必落 fn799xx 带（需可视行数 <400，双 project 远在内）
  // 且与其余四位段不撞。锚整个可视窗 join 文本而非 .first()：首可视行落 def 还是
  // pass 随视口行数奇偶翻转（fn_i def 在 0 基 2i、pass 在 2i+1；mobile 375×667
  // 实测 39 行可视 → 首行 1 基 159962 恰为 fn79980 的 pass，.first() 不含 fn799
  // 假红）——可视窗内必有 fn799xx def 行，带内判定不变，行数差一假红归零
  await page.locator('.vv-code-pre').evaluate((el) => {
    el.scrollTop = el.scrollHeight - el.clientHeight;
  });
  await expect
    .poll(
      () =>
        page
          .locator('.vv-code-pre .vv-code-line')
          .allTextContents()
          .then((ls) => ls.join('\n')),
      { timeout: 30_000 }
    )
    .toContain('fn799');
});

test('OUT-08 · rightViewTouched 台账跨文件保持：手动落「属性」后切有大纲文件仍「属性」，未 touched 新页对照默认「目录」', async ({ page }) => {
  test.setTimeout(120_000);
  await injectDir(page, [
    { name: 'calc.py', content: PY_OUTLINE },
    { name: 'shape.ts', content: TS_OUTLINE }
  ]);
  const tocBtn = page.locator('.vv-right-switch-btn', { hasText: '目录' });
  const metaBtn = page.locator('.vv-right-switch-btn', { hasText: '属性' });

  // ① 默认落位基线：calc.py 大纲到货、未 touched → 默认落位 effect 落「目录」
  await openTreeFile(page, 'calc.py');
  await waitOutlineReady(page);
  await expect(tocBtn).toHaveAttribute('aria-pressed', 'true');
  await expect(metaBtn).toHaveAttribute('aria-pressed', 'false');

  // ② 手动点「属性」：段级点击置 rightViewTouched（AppShell.svelte:1360-1363 用户
  //    显式选择，台账语义——轮询/重渲染不置位），MetaPanel 互斥在场
  await metaBtn.click();
  await expect(metaBtn).toHaveAttribute('aria-pressed', 'true');
  await expect(tocBtn).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.meta-panel')).toBeVisible();
  await expect(page.locator('.vv-outline')).toHaveCount(0);
  await ensureRightDrawer(page, false);

  // ③ 切 shape.ts（有大纲）：目录钮重新在场 = outlineDefinitions 非空（新文件大纲
  //    已到货），但落位仍「属性」——默认落位 effect 因 touched 不写（AppShell
  //    .svelte:218-221）。跨文件回默认落位的修前行为此处必红
  await openTreeFile(page, 'shape.ts');
  await ensureRightDrawer(page, true);
  await expect(tocBtn).toBeVisible({ timeout: 30_000 });
  await expect(metaBtn).toHaveAttribute('aria-pressed', 'true');
  await expect(tocBtn).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.meta-panel')).toBeVisible();
  await expect(page.locator('.vv-outline')).toHaveCount(0);
  await ensureRightDrawer(page, false);

  // ④ 对照（场景档：另一新 context，rightViewTouched 初值 false）：同 context 新页
  //    继承 project 视口且 sessionStorage 不共享；rightView/touched 为组件态零持久
  //    化（AppShell.svelte:130-131，零快照/零 settings）→ 新页即初值 false，直接
  //    打开有大纲文件落「目录」（默认落位语义，与 ③ 形成单变量对照）
  const page2 = await page.context().newPage();
  await injectDir(page2, [{ name: 'calc.py', content: PY_OUTLINE }]);
  await openTreeFile(page2, 'calc.py');
  await ensureRightDrawer(page2, true);
  const tocBtn2 = page2.locator('.vv-right-switch-btn', { hasText: '目录' });
  await expect(tocBtn2).toBeVisible({ timeout: 30_000 });
  await expect(tocBtn2).toHaveAttribute('aria-pressed', 'true');
  await expect(page2.locator('.vv-outline li')).toHaveCount(5, { timeout: 30_000 });
  await page2.close();
});

test('OUT-09 · 深嵌套缩进钳制：11 层嵌套 paddingLeft 钉死 96px 上界（min(depth,8)×12px），容器无横向溢出', async ({ page }) => {
  test.setTimeout(90_000);
  await openCodeFile(page, { name: 'deep-nest.py', content: PY_DEEP_NEST }, 'deep-nest.py');
  // 先锚 tree-sitter 路径（OUT-05/12 同款：防 hljs 降级凑出空/伪大纲假绿）
  await expect(page.locator('.vv-statusbar')).toContainText('高亮: tree-sitter', { timeout: 30_000 });
  await waitOutlineReady(page);

  // 12 条目 = 11 class + 末层 def（全 definition，无引用过滤面）
  await expect(page.locator('.vv-outline li')).toHaveCount(12, { timeout: 30_000 });

  // 缩进精确序列：raw depth [0..10, 11] → 逻辑深度 min(d, OUTLINE_DEPTH_CLAMP=8)
  // （outlineDepth.ts:30，OutlineView.svelte:76 渲染端单点）× 12px/层。深层四项
  // （raw 8,9,10,11）钉死同值 96px——无钳制实现落 96/108/120/132px 必红
  const pads = await page
    .locator('.vv-outline li')
    .evaluateAll((els) => els.map((el) => parseFloat(getComputedStyle(el).paddingLeft)));
  expect(pads).toEqual([0, 12, 24, 36, 48, 60, 72, 84, 96, 96, 96, 96]);

  // 场景档上界不变量（序列断言的独立表达）：所有条目 ≤ 96px
  for (const p of pads) expect(p).toBeLessThanOrEqual(96);

  // 容器无横向溢出爆版面（.vv-outline overflow:auto，app.css:681——钮内 nowrap+
  // ellipsis 剪裁，钳制后缩进不把内容推出容器）
  const box = await page
    .locator('.vv-outline')
    .evaluate((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }));
  expect(box.scrollWidth).toBeLessThanOrEqual(box.clientWidth);
});

test('OUT-10 · 在飞 outline 跨 tab 失效：开 calc.py 渲染就绪即切 plain.txt 右栏零串台，切回大纲重建', async ({ page }) => {
  test.setTimeout(120_000);
  await injectDir(page, [
    { name: 'calc.py', content: PY_RACE_FNS },
    { name: 'plain.txt', content: 'plain body\n' }
  ]);

  // ① 打开 calc.py（全量 parse 完成 = fire-and-forget 投递 outline，renderCode.ts
  //    :481-494），不等切换器立即切 plain.txt——在飞响应若在切走后到达，实例已
  //    destroy：destroy 撤在飞（renderCode.ts:520 → client.cancelOutline lang 级，
  //    client.ts:247-250）+ 迟到 resolve 被 destroyed 拦截（renderCode.ts:487）+
  //    ViewerPane lastSeenTab 跨 tab 清空门（ViewerPane.svelte:580）。先锚
  //    tree-sitter 路径（OUT-05 同款：防 hljs 降级使大纲恒 [] 的假绿通路）
  await openTreeFile(page, 'calc.py');
  await expect(page.locator('.vv-code-pre')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.vv-statusbar')).toContainText('高亮: tree-sitter', { timeout: 30_000 });
  await openTreeFile(page, 'plain.txt');
  // plain 渲染就绪先行（场景档口径），随后开抽屉读右栏终态
  await expect(page.locator('.vv-code-pre')).toBeVisible({ timeout: 30_000 });
  await ensureRightDrawer(page, true);

  // ② 轮询窗口后（OUT-04 同款 1.2s = 多轮 250ms tick）右栏终态零串台：calc.py 的
  //    outline 响应不得在 plain.txt 激活期出现在右栏——切走后终态锚（场景档：不锚
  //    中间帧；中间态无论已到/在飞，三层失效都使 plain 实例期右栏无大纲）
  await page.waitForTimeout(1_200);
  await expect(page.locator('.vv-right-switch')).toHaveCount(0);
  await expect(page.locator('.vv-outline')).toHaveCount(0);
  await expect(page.locator('.meta-panel')).toBeVisible();
  await ensureRightDrawer(page, false);

  // ③ 切回 calc.py：大纲重建——切换器重现（上行链路重通）+ 条目数回归恰 1500
  //    （重渲染新实例重提取，dispatcher 每次派发新建实例销毁旧实例；跨文件切回
  //    与 OUT-03 同通路）；untouched 默认落位「目录」；< 门限无截断提示条
  await openTreeFile(page, 'calc.py');
  await waitOutlineReady(page);
  await expect(page.locator('.vv-outline li')).toHaveCount(1500, { timeout: 30_000 });
  await expect(page.locator('.vv-outline-truncate-text')).toHaveCount(0);
  await expect(page.locator('.vv-right-switch-btn', { hasText: '目录' })).toHaveAttribute('aria-pressed', 'true');
});

test('OUT-11 · 门限截断机械面（2400 def）：折叠恰 2000 行 + 提示条在视口内且布局不塌 + 「全部展开」全量 + 截断态二分限显示集', async ({ page }) => {
  test.setTimeout(180_000);
  // 时限面（打开至就绪无超时）由 ≈2MB 真尺度锚 OUT-07 承担；本用例锚截断机制
  // 本身的机械行为：门限计数/提示条/展开钮/二分口径（2400 def ≈90KB 小尺度下
  // 行为与万级一致——切片逻辑与体量正交，OUTLINE_TRUNCATE_LIMIT 单点）
  await openCodeFile(page, { name: 'many-trunc.py', content: PY_TRUNCATED_FNS }, 'many-trunc.py');
  await waitOutlineReady(page);

  // ① 截断态渲染行数恰为门限（2000 = OUTLINE_TRUNCATE_LIMIT）
  await expect(page.locator('.vv-outline li')).toHaveCount(2000, { timeout: 30_000 });
  // ② 提示条真实可见（toBeVisible 校验非空盒 + 无裁剪，强于 toHaveText 的纯
  //    textContent 读取）+ 文案精确锁死（含门限数值插值面）
  const bar = page.locator('.vv-outline-truncate');
  await expect(bar).toBeVisible();
  await expect(page.locator('.vv-outline-truncate-text')).toHaveText('大纲超过 2000 条，仅显示前 2000 条');
  // ②b 布局不塌（boundingBox 实测）：展开钮未被全局钮基座 width:100% 撑成横贯
  // 整条（scoped width:auto 压过 app.css .vv-outline button）——钮宽显著小于
  // 提示条容器宽，且文案 span 未被压塌（bar 宽 > 钮宽即证 span 占有剩余空间）
  const barBox = await bar.boundingBox();
  const btnBox = await page.locator('.vv-outline-expand').boundingBox();
  expect(barBox).not.toBeNull();
  expect(btnBox).not.toBeNull();
  expect(btnBox!.width).toBeLessThan(barBox!.width);
  expect(btnBox!.width).toBeLessThan(barBox!.width / 2);

  // 截断态跟随口径（设计警示同步约定「二分限显示集」）：滚到容器底（DOM 自洽锚
  // ——scrollHeight-clientHeight 不做行高换算：e2e 行高并非精确 20px，OUT-06 仅
  // 证明 h∈(19.05,20.51]；4800 行 ×20px 虚拟总高远小于 SCROLL_PX_CAP
  // （virtualScroller.ts:21，33_554_428），未进压缩域，直映语义成立）。到底后首
  // 可视行 ≈ 4760-4790（随视口高浮动，≫ fn1999 line 3998）：限显示集二分得末项
  // fn1999（显示集最大 line，恒为落点）；若二分仍吃全集，激活项将是 fn23xx
  // （line ≈ 首可视行的切片外条目），不含 fn1999，本断言即红。
  await page.locator('.vv-code-pre').evaluate((el) => {
    el.scrollTop = el.scrollHeight - el.clientHeight;
  });
  await expect
    .poll(() => page.locator('.vv-outline button.active').textContent(), { timeout: 30_000 })
    .toContain('fn1999');

  // ③「全部展开」→ 全量渲染 2400 行、提示条消失、切片外末项在册
  await page.locator('.vv-outline-expand').click();
  await expect(page.locator('.vv-outline li')).toHaveCount(2400, { timeout: 30_000 });
  await expect(page.locator('.vv-outline li').last()).toContainText('fn2399');
  await expect(page.locator('.vv-outline-truncate-text')).toHaveCount(0);

  // 展开后跟随恢复全集口径（scrollTop 未动仍在底部，首可视行 ≈ 4760-4790）：
  // 显示集翻全集后二分落点迁移到切片外条目 fn23xx——'fn2' 前缀断言容忍视口高
  // 浮动（落点恒 ≥ fn2000 line 4000，而显示集落点上限恒 fn1999，二者不相交）
  await expect
    .poll(() => page.locator('.vv-outline button.active').textContent(), { timeout: 30_000 })
    .toContain('fn2');
});

test('OUT-12 · reference 过滤后 depth 栈重算：被过滤引用内的定义行不跳层（嵌于存活 def 内齐层），顶层引用兄弟不误挂为前一 def 子项', async ({ page }) => {
  test.setTimeout(90_000);
  await injectDir(page, [
    { name: 'nested.js', content: JS_NESTED_REF },
    { name: 'siblings.js', content: JS_SIBLING_REF }
  ]);
  const padsOf = (): Promise<number[]> =>
    page
      .locator('.vv-outline li')
      .evaluateAll((els) => els.map((el) => parseFloat(getComputedStyle(el).paddingLeft)));

  // ① 载体 1（引用嵌于存活 def 内）：先锚 tree-sitter 路径（OUT-05 同款：防 hljs
  // 降级凑出空大纲/假绿）
  await openTreeFile(page, 'nested.js');
  await expect(page.locator('.vv-code-pre')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.vv-statusbar')).toContainText('高亮: tree-sitter', { timeout: 30_000 });
  await waitOutlineReady(page);

  // 引用过滤：全量 6 条（5 definition.function + 1 reference.call）只出 5 行，register 不在场
  await expect(page.locator('.vv-outline li')).toHaveCount(5);
  await expect(outlineRow(page, 'register')).toHaveCount(0);

  // 栈重算（outlineDepth.ts）：alpha/beta（raw 2，父 reference.call 已过滤）与 gamma
  // （raw 1）同为 outer 的真实子层 → 三者齐 12px；直读 raw depth 则 alpha/beta 24px
  // 而显示集内无 12px 父行（跳层，修前 [0,24,24,12,0] 必红）。outer/tail 顶层 0px。
  expect(await padsOf()).toEqual([0, 12, 12, 12, 0]);
  await ensureRightDrawer(page, false);

  // ② 载体 2（顶层引用兄弟）：过滤后恰 2 行（describe/it 均被过滤）。namedTest 的
  // byte 范围不在 setup 内 → 0px；raw depth 栈近似法在此形态得 12px（误挂为 setup
  // 子项）即红——载体 1 对两法同值，唯本形态锁死「byte 区间栈重跑提取端」口径
  await openTreeFile(page, 'siblings.js');
  await waitOutlineReady(page);
  await expect(page.locator('.vv-outline li')).toHaveCount(2);
  await expect(outlineRow(page, 'setup')).toHaveCount(1);
  await expect(outlineRow(page, 'namedTest')).toHaveCount(1);
  expect(await padsOf()).toEqual([0, 0]);
});
