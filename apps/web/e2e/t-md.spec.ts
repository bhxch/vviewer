import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
import { injectDir, openTreeFile } from './b-markdown-html-docs-helpers';

/**
 * t-md.spec.ts — markdown-html-docs 域缺口补齐（t- 前缀标记本轮新增，不改既有文件）。
 * 缺口来源：docs/e2e/markdown-html-docs.md 第 2 节场景期望 vs 既有套件断言强度盘点
 * （MD-01/MD-10/MD-12 无以编号开头的用例，或断言弱于场景期望）：
 * - MD-01 删除线 del 元素断言缺位（既有载体 samples/m3/demo.md 无 ~~ 内容），
 *   补自建含删除线样例 + checkbox「均为 disabled」逐个断言 + 无错误卡片；
 *   首轮执行分诊：表格/checkbox/无错误卡片达标，删除线判据属产品缺陷独立为
 *   MD-01/2（现 test.fixme——CAND-md-F1：本地 markdown-it 15 出 <s> 与远程
 *   comrak <del> 双引擎不一致，违反场景文档 §2 判据，断言不放宽）；
 * - MD-10 落编号用例：sandbox 形态/脚本不执行/行内样式保留/双视图切换
 *   （m3.spec.ts 旧用例无编号且未断言行内样式保留）；
 * - MD-12 拆两个子场景：源码视图搜索（计数 n/N 推进 + 当前命中行级高亮）与
 *   渲染视图搜索恒空——后者为设计行为（packages/render-text/src/html.ts:186，
 *   渲染视图是沙箱 iframe 不做跨文档搜索，search 恒返回 []）。
 * 注入通道复用 b-markdown-html-docs-helpers.ts（__vvOpenDirImpl，与既有套件同口径）；
 * 选择器出处：.vv-code-line[data-line] 与 vv-search-hit-line(-active)（render-text/src/code.ts
 * fillRows/applyHitClass）、mark.vv-search-hit（code.ts overlaySearchHits）、
 * .vv-search-count「无结果」形态（apps/web/src/lib/SearchPanel.svelte）、
 * .vv-error-card 统一错误卡（apps/web/src/app.css）、/ 快捷键 window 级
 * 非输入焦点即开（apps/web/src/lib/ViewerPane.svelte）。
 */

const m3Samples = fileURLToPath(new URL('../../../samples/m3', import.meta.url));
/** MD-10 载体：与场景前置一致（数据集含 samples/m3/page.html），同 m3.spec.ts 读法 */
const PAGE_HTML = readFileSync(`${m3Samples}/page.html`, 'utf-8');

/** MD-12 载体：标签计数可控的自建样例——'section' 共 6 次，分布 3 行（开/闭各 1） */
const MD12_HTML = [
  '<!DOCTYPE html>',
  '<html>',
  '<head><title>MD-12 搜索样例</title></head>',
  '<body>',
  '<section id="a">第一段正文</section>',
  '<p>中间普通段落，不含目标标签。</p>',
  '<section id="b">第二段正文</section>',
  '<section id="c">第三段正文</section>',
  '</body>',
  '</html>',
  ''
].join('\n');

test('MD-01: GFM 表格渲染为 HTML 表格，任务列表 checkbox 均禁用，无错误卡片', async ({
  page
}) => {
  test.setTimeout(60_000);
  const content = [
    '| 特性 | 状态 |',
    '| ---- | ---- |',
    '| GFM 表格 | 渲染正常 |',
    '| 对齐样式 | 默认左对齐 |',
    '',
    '- [x] 已完成事项',
    '- [ ] 待办事项',
    ''
  ].join('\n');
  await injectDir(page, [{ name: 'md01.md', content }]);
  await openTreeFile(page, 'md01.md');
  const md = page.locator('.vv-markdown');
  await expect(md).toBeVisible({ timeout: 20_000 });

  // 表格渲染为 HTML 表格（表头 + 2 数据行）
  await expect(md.locator('table')).toBeVisible();
  await expect(md.locator('table tr')).toHaveCount(3);

  // 任务列表：2 个 checkbox 且均为 disabled（逐个断言——既有 m3 用例只断首个）
  const boxes = md.locator('li.task-list-item input[type="checkbox"]');
  await expect(boxes).toHaveCount(2);
  await expect(boxes.nth(0)).toBeDisabled();
  await expect(boxes.nth(1)).toBeDisabled();

  // 无错误卡片（.vv-error-card 为渲染失败/超限降级统一卡结构，app.css:88）
  await expect(page.locator('.vv-error-card')).toHaveCount(0);
});

test.fixme('MD-01/2 [CAND-md-F1]: 删除线文本渲染为 del 元素（GFM strikethrough）', async ({
  page
}) => {
  // CAND-md-F1（产品缺陷，2026-10-10 分诊转 fixme，断言不放宽）：
  // 本地 markdown-it 15.0.2（packages/render-text/package.json:13）把 ~~x~~ 渲染为
  // <s> 而非 <del>（markdown-it v13 起 strikethrough 默认标签 del→s；本仓库 node
  // 实测 renderMarkdownToHtml 同配置输出 <s>删除线文本</s>，e2e 实测 .vv-markdown
  // 内 del 0 个），违反场景文档 §2 MD-01 判据「删除线文本渲染为 del 元素（视觉删除线）」。
  // 且与远程 comrak 路径双引擎不一致：comrak 开 ext.strikethrough 出 <del>
  // （server/src/compute/markdown.rs:19；tests/compute_markdown.rs:127 断言
  // <del>gone</del>）——同文档双引擎标签不一致正是 engine.ts:1-3 注释里 footnote
  // 补齐时的同款缺陷类。修复方向：本地引擎 renderer rule 把 strikethrough_open/close
  // 输出 del，与 comrak/GFM（cmark-gfm 参考实现）对齐；修复后本用例转正回 test。
  // 注：demo.md 历史从未含 ~~ 内容（git log -S'~~' 零命中），源报告「del 渲染」
  // 证据对本子判据属空转，场景文档第 4 节允许自造元素复测。
  test.setTimeout(60_000);
  const content = ['正文含 ~~删除线文本~~ 与正常文本。', ''].join('\n');
  await injectDir(page, [{ name: 'md01-del.md', content }]);
  await openTreeFile(page, 'md01-del.md');
  const md = page.locator('.vv-markdown');
  await expect(md).toBeVisible({ timeout: 20_000 });

  // 删除线文本渲染为 del 元素（场景判据原强度，不放宽为 s/del 双收）
  await expect(md.locator('del')).toHaveCount(1);
  await expect(md.locator('del')).toHaveText('删除线文本');

  // 渲染不崩（无错误卡片）
  await expect(page.locator('.vv-error-card')).toHaveCount(0);
});

test('MD-10: HTML 沙箱——sandbox 无 allow-scripts、内联脚本不执行、行内样式保留、双视图切换', async ({
  page
}) => {
  test.setTimeout(60_000);
  await injectDir(page, [{ name: 'page.html', content: PAGE_HTML }]);
  await openTreeFile(page, 'page.html');
  const frame = page.locator('.vv-html-frame');
  await expect(frame).toBeVisible({ timeout: 20_000 });

  // sandbox 只含 allow-same-origin（偏差 #1 已裁决形态），绝无 allow-scripts
  expect(await frame.getAttribute('sandbox')).toBe('allow-same-origin');
  expect((await frame.getAttribute('sandbox'))!.split(/\s+/)).not.toContain('allow-scripts');

  // 内联脚本不执行双证据：净化剥除 <script> 标签 + 沙箱封死执行面
  // （page.html 原文含 window.__executed = true，渲染视图必须无执行痕迹）
  const srcdoc = await frame.getAttribute('srcdoc');
  expect(srcdoc).not.toContain('<script');
  const executed = await page.evaluate(() => {
    const f = document.querySelector('.vv-html-frame') as HTMLIFrameElement;
    const win = f.contentWindow as unknown as { __executed?: boolean; document: Document } | null;
    if (!win) return 'no-window';
    return Boolean(win.__executed) || win.document.body.hasAttribute('data-script-ran');
  });
  expect(executed).toBe(false);

  // 行内样式保留（场景期望；m3.spec 旧用例未断言——page.html 含 <p style="color: crimson;">）
  const styledParas = await page.evaluate(() => {
    const f = document.querySelector('.vv-html-frame') as HTMLIFrameElement;
    return f.contentDocument?.querySelectorAll('p[style]').length ?? -1;
  });
  expect(styledParas).toBeGreaterThanOrEqual(1);

  // 源码视图：原始文本（未经净化）经 code 渲染链展示；切回渲染视图 iframe 回归
  await page.locator('.vv-html-btn-source').click();
  const pre = page.locator('.vv-code-pre');
  await expect(pre).toBeVisible();
  await expect(pre).toContainText('__executed');
  await page.locator('.vv-html-btn-rendered').click();
  await expect(frame).toBeVisible();
});

test('MD-12/源码视图: / 搜索标签名计数正确（1/6→2/6）且当前命中行级高亮', async ({ page }) => {
  test.setTimeout(60_000);
  await injectDir(page, [{ name: 'md12.html', content: MD12_HTML }]);
  await openTreeFile(page, 'md12.html');

  // 切「源码」视图（renderCode 渲染链，html.ts:149-152）
  await page.locator('.vv-html-btn-source').click();
  await expect(page.locator('.vv-code-pre')).toBeVisible();

  // 树行/按钮持焦（非输入框）→ / 打开搜索面板（ViewerPane window 级快捷键）
  await page.keyboard.press('/');
  await expect(page.locator('.vv-search-panel')).toBeVisible();
  await expect(page.locator('.vv-search-input')).toBeFocused();
  await page.keyboard.insertText('section');

  // 命中计数：'section' 在 3 行内开/闭标签各 1 次 → 6 命中，首命中自动跳转 current=1
  await expect(page.locator('.vv-search-count')).toHaveText('1/6', { timeout: 5_000 });
  // 词级 mark 数 = 命中总数（code.ts fillRows → overlaySearchHits）
  await expect(page.locator('mark.vv-search-hit')).toHaveCount(6);
  // 全部命中行有行级背景（code.ts:650 hits !== undefined → vv-search-hit-line；小文件全可视）
  await expect(page.locator('.vv-code-line.vv-search-hit-line')).toHaveCount(3);

  // Enter 推进：current 2/6，当前命中（行 4 的闭标签）叠 active 行级高亮
  // （code.ts:607/651，1.5s 后消退——紧随计数断言即时断言）
  await page.keyboard.press('Enter');
  await expect(page.locator('.vv-search-count')).toHaveText('2/6');
  await expect(page.locator('.vv-code-line[data-line="4"].vv-search-hit-line-active')).toHaveCount(1);
});

test('MD-12/渲染视图: 重复搜索恒无结果（沙箱 iframe 不做跨文档搜索，设计行为）', async ({
  page
}) => {
  test.setTimeout(60_000);
  await injectDir(page, [{ name: 'md12.html', content: MD12_HTML }]);
  await openTreeFile(page, 'md12.html');

  // 渲染视图（默认）：instance.search 恒返回 []（html.ts:186）→ 计数「无结果」（SearchPanel:159-160）
  await page.keyboard.press('/');
  await expect(page.locator('.vv-search-panel')).toBeVisible();
  await expect(page.locator('.vv-search-input')).toBeFocused();
  await page.keyboard.insertText('section');
  await expect(page.locator('.vv-search-count')).toHaveText('无结果', { timeout: 5_000 });
  await expect(page.locator('mark.vv-search-hit')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.locator('.vv-search-panel')).toHaveCount(0);

  // 对照：同 query 在源码视图有结果（证明非内容无可搜文本，而是视图语义差异）
  await page.locator('.vv-html-btn-source').click();
  await expect(page.locator('.vv-code-pre')).toBeVisible();
  await page.keyboard.press('/');
  await expect(page.locator('.vv-search-input')).toBeFocused();
  await page.keyboard.insertText('section');
  await expect(page.locator('.vv-search-count')).toHaveText('1/6', { timeout: 5_000 });
  await page.keyboard.press('Escape');
  await expect(page.locator('.vv-search-panel')).toHaveCount(0);

  // 切回渲染视图重复搜索：仍恒无结果，查看器不崩（场景步骤 3 的报告 low 瑕疵实为设计行为）
  await page.locator('.vv-html-btn-rendered').click();
  await expect(page.locator('.vv-html-frame')).toBeVisible();
  await page.keyboard.press('/');
  await expect(page.locator('.vv-search-input')).toBeFocused();
  await page.keyboard.insertText('section');
  await expect(page.locator('.vv-search-count')).toHaveText('无结果', { timeout: 5_000 });
  await expect(page.locator('mark.vv-search-hit')).toHaveCount(0);
  await expect(page.locator('.vv-viewer-host')).toBeVisible();
});
