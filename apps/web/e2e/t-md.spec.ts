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

// ── 探索复核确认缺陷回归占位（README §3.2.4：修复合入前 test.fixme 落位，修复 PR 转正） ──
// 来源：探索期候选缺陷独立复核确认（BUG-37/38/39/40/66，2026-10-10 轮）。标题以缺陷库
// 编号开头、[探索] 标注来源；各用例注释给出最小复现步骤、证据路径与源码定位。
// 通道口径：本套件 baseURL :4173 为 vite preview 纯 web 形态——本地注入通道（injectDir，
// auto 策略落本地管线）可复现的落完整可执行正文；需 --compute 同源实例的远程档缺陷落
// 骨架注释（拓扑参照 e2e-server 的 :4180 同源辅助实例模式，先例 HL-10/3）。

test.fixme('BUG-37 [探索]: 远程档页内锚链接死链——comrak heading id 带 user-content- 前缀而内嵌锚 href 不带，前端无 hash 映射', async () => {
  // 双引擎 heading id 方案不一致（复核维持 medium）：
  // - 本地：packages/render-text/src/markdown/markdownRenderer.ts:162 slugifyHeading
  //   （无前缀）、:179 assignHeadingIds（重名 -2 起、全标点回退 section）；
  // - 远程：comrak 0.56.0（server/Cargo.toml:22）统一 user-content- 前缀
  //   （server/src/compute/markdown.rs:26），且自产内嵌 anchor「id 带前缀、href 不带」
  //   自不一致（仿 GitHub 形态——GitHub 靠自家前端 JS 做 hash→前缀映射，本仓库前端
  //   无任何此逻辑：rg 'data-heading-content|user-content' apps/web/src packages 零命中，
  //   也无页内锚自定义点击处理，hashchange/scrollIntoView 仅 markdownRenderer.ts:339
  //   搜索 mark 高亮一处）→ 纯远程档输出内部自不一致。
  // 最小复现（需 --compute 同源实例，本套件 :4173 纯 web 不可执行）：
  //   ① 实例 http://127.0.0.1:8391（root 夹具目录）→ 连接服务器 → 连接；
  //   ② 文件树展开 explore-md/，点 toc-edge.md，确认状态栏「渲染: 远程」；
  //   ③ 点正文链接「到中文标题一」→ location.hash 变 #中文标题一（URL 编码形态），
  //      但 .vv-viewer-scroll.scrollTop 保持 0（死链）；emoji 标题链接同样不滚；
  //   ④ 对照：同一文件本地注入通道打开（渲染: 本地），同一链接 scrollTop 0→121 正常。
  // 证据（复核轮独立取得）：/tmp/md-e1-repro/repro.mjs——远程档 12 个 heading id 全带
  //   前缀；16 条 a[href^=#] 中 13 条目标 id 不存在（comrak 自产 anchor 类 11 死链 +
  //   正文 2 死链），仅 #intro/#deep-target 命中作者 HTML 自带 id，#intro 滚到作者 div
  //   而非标题；API 直呼 POST /api/compute/markdown 原始输出即自不一致（非前端改写）；
  //   /tmp/md-e1-repro/toc.mjs——TOC 面板按实际 DOM id 定位不受影响（scrollTop 0→121）。
  // 修复方向：前端补 hash→user-content- 前缀映射（GitHub 同款）或 comrak 侧对齐本地
  //   方案。修复后在 --compute 同源实例转正，断言：正文页内锚点击 scrollTop 变化 +
  //   comrak 自产 anchor href 与实际 heading id 全一致（deadLinkCheck 0 死链）。
});

test.fixme('BUG-38 [探索]: 围栏语言标识大小写不归一——Rust 大写写法静默丢失 tree-sitter 降级 hljs 兜底', async ({
  page
}) => {
  // 复核成立（low）：```Rust（大写 R）不命中全小写 grammar 清单键与别名表，tree-sitter
  // 路径静默丢失、降级 hljs（cls "language-Rust hljs"，仅 hljs-* span）；```rust 正常
  // 出 ts-* span。别名机制本身正常（```zsh 经别名表命中 bash grammar）。三策略
  // （server auto / 显式 remote / 本地注入）结果一致。
  // 源码：packages/highlight/src/core-parse.ts:243-245 canonicalLang 两级查找均区分
  // 大小写且未命中原样返回；core-parse.ts:376-382 buildAliasTable 别名原样入表；
  // apps/web/build/grammars/manifest.json grammars 表 34 键全小写、无 Rust 键、
  // rust 别名仅 ['rs']、bash 别名 ['sh','shell','zsh']。
  // 最小复现：注入含 ```rust / ```Rust / ```zsh 的 md → Rust 块 cls "language-Rust hljs"
  // 零 ts-* span（对照 rust 块 language-rust + ts-* span）。
  // 修复方向：围栏语言经 toLowerCase（及别名查表）归一后再查 grammar；修复后转正。
  test.setTimeout(90_000);
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
  await injectDir(page, [{ name: 'md38-fence.md', content }]);
  await openTreeFile(page, 'md38-fence.md');
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

test.fixme('BUG-39 [探索]: markdown 渲染视图净化放行五类等价加载向量——poster/SVG image/style url/table background/input image 外域真实外联', async ({
  page
}) => {
  // 复核成立、范围校准为 md 档（medium）：净化钩子
  // （packages/render-text/src/markdown/sanitize.ts:63-114，仅覆盖 IMG 的 src/srcset 与
  // VIDEO/AUDIO/SOURCE 的 src）放行五类等价加载向量，DOM 属性全保留且浏览器真实发起
  // 外域请求（md 档 6 条，失败原因 net::ERR_EMPTY_RESPONSE 即已进网络栈——跟踪像素
  // 可回传 IP/会话）。html 沙箱档（vectors.html）属性同样保留但被 srcdoc 内 CSP meta
  // （packages/render-text/src/html.ts:27-28 CSP_CONTENT，:66-71 注入）在网络栈前拦死，
  // 不在本缺陷范围。
  // 最小复现：注入含五类向量的 md（外域指向不可解析保留域 external.example.com）→
  // 打开渲染视图 → 检索请求命中 6 条；修复后判据：external.example 请求 0 条
  // （不预设实现形态：剥属性/打 BUG-17 同款 data-vv-blocked-external 标记均可）。
  // 证据（复核轮独立取得）：/tmp/vv-repro-cand-md-e2/repro.mjs（request/requestfailed/
  // requestresponse 三相记录）——md 档 requests=6（poster/svg-img/svg-xlink/bg/tbg/
  // input），failures 全为网络层错误；img[alt=plain] 等既有 BUG-17 行为完好。
  test.setTimeout(90_000);
  const V = 'http://external.example.com';
  const content = [
    `<img alt="plain" src="${V}/plain.jpg">`,
    '',
    `<video controls poster="${V}/poster.jpg"></video>`,
    '',
    `<svg><image href="${V}/svg-img.png"></image><image xlink:href="${V}/svg-xlink.png"></image></svg>`,
    '',
    `<div style="background:url(${V}/bg.png)">行内样式 url 外联</div>`,
    '',
    `<table background="${V}/tbg.png"><tr><td>表格背景外联</td></tr></table>`,
    '',
    `<p><input type="image" src="${V}/input.png" alt="input 外联"></p>`,
    ''
  ].join('\n');
  // 外域请求监听先于注入装载（核心判据：修复后 0 条外联，不预设净化实现形态）
  const external: string[] = [];
  page.on('request', (req) => {
    if (req.url().includes('external.example')) external.push(req.url());
  });
  await injectDir(page, [{ name: 'md39-vectors.md', content }]);
  await openTreeFile(page, 'md39-vectors.md');
  const md = page.locator('.vv-markdown');
  await expect(md).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(1_500); // 网络观察窗：覆盖属性加载触发的外域请求
  expect(external).toEqual([]);

  // 基线护栏：既有 BUG-17 行为不回退（img 外域 src 剥除 + 拦截标记）
  const img = md.locator('img[alt="plain"]');
  await expect(img).not.toHaveAttribute('src');
  await expect(img).toHaveAttribute('data-vv-blocked-external', '1');
  await expect(page.locator('.vv-error-card')).toHaveCount(0);
});

test.fixme('BUG-66 [探索]: 本地 markdown-it 路径删除线渲染为 s 而非 del——与远程 comrak 双引擎标签不一致', async ({
  page
}) => {
  // = CAND-md-F1 的复核定论缺陷库编号（2026-10-10 复核确认，low）；与本文件上方
  // MD-01/2 [CAND-md-F1] 用例（本轮既有，按「只追加不改」保留）同缺陷同判据，本用例
  // 挂缺陷库编号供修复 PR 转正对照，两用例一并转正。
  // 源码：packages/render-text/src/markdown/engine.ts:20-24 markdown-it 15.0.2 同配置
  // （html/linkify/breaks:false + taskLists + footnote）把 ~~x~~ 渲染为 <s>（node 实测
  // "<p>正文含 <s>删除线文本</s> 与正常文本。</p>"）；远程 comrak 出 <del>
  // （server/src/compute/markdown.rs:19 ext.strikethrough，:126-127 单测断言
  // <del>gone</del>，API 直呼实测同）——视觉删除线正常（s/del 默认样式同为
  // line-through），缺陷为语义标签不符场景判据（docs/e2e/markdown-html-docs.md:27
  // 「删除线文本渲染为 del 元素」）+ 双引擎 DOM 一致性偏差。修复方向：本地 renderer
  // rule 把 strikethrough_open/close 输出 del，与 comrak/GFM 对齐；修复后转正。
  test.setTimeout(60_000);
  const content = ['正文含 ~~删除线文本~~ 与正常文本。', ''].join('\n');
  await injectDir(page, [{ name: 'md66-del.md', content }]);
  await openTreeFile(page, 'md66-del.md');
  const md = page.locator('.vv-markdown');
  await expect(md).toBeVisible({ timeout: 20_000 });

  // 场景判据原强度：del 元素（不放宽为 s/del 双收）
  await expect(md.locator('del')).toHaveCount(1);
  await expect(md.locator('del')).toHaveText('删除线文本');

  await expect(page.locator('.vv-error-card')).toHaveCount(0);
});

// ── 复核确认缺陷库编号挂接（2026-10-10 第二轮；README §3.2.4 口径与上节相同）──
// 上节占位落位时（eecd910）缺陷库编号未定档、标题用探索期编号（BUG-37/38/39/40/66）；
// 本轮复核定档后编号偏移：探索 BUG-37→BUG-39（heading id 死链）、BUG-39→BUG-40（净化
// 向量）、BUG-38→BUG-42（围栏大小写）、BUG-40→BUG-41（worker 看门狗）、BUG-66 不变。
// 按「只追加不改」约定：编号偏移的两条 md 域缺陷在此补挂确认编号占位（同缺陷同判据，
// 与上方对应用例一并转正），避免修复 PR 按确认编号检索命中错位用例；BUG-42/BUG-41
// 根因属 hl（packages/highlight），按一域一文件落 t-hl.spec.ts；BUG-66 编号未偏移
// （上方用例即挂确认编号），不再重复。
// 【2026-10-10 占位整理更新】worker 看门狗缺陷按 hl 域权威清单定档 BUG-35（fsearch 域
// 整理轮曾按其清单记 BUG-43，编号勘误轮以内容配对归一为 BUG-35）：上方原探索期
// 'BUG-40 [探索]' 用例与 t-hl 侧 'BUG-41 [探索]' 占位已按「同缺陷唯一锚点」收编删除，
// 全仓库唯一锚点为 t-hl.spec.ts 'BUG-35 [探索]'——按 BUG-41/探索期 BUG-40/早期定档
// BUG-43 检索请落该条。

test.fixme('BUG-39 [探索]: 远程档 heading id 双引擎方案不一致——comrak user-content- 前缀致页内锚死链、内嵌 anchor href 自不一致', async () => {
  // = 探索期编号 BUG-37（本文件上方 'BUG-37 [探索]' 用例）复核定档后的缺陷库确认编号，
  // 同缺陷同判据，两用例一并转正；本条挂确认编号供修复 PR 按 BUG-39 检索。
  // 复核维持 medium：本地 slugifyHeading 无前缀、重名 -2 起、全标点回退 section
  // （packages/render-text/src/markdown/markdownRenderer.ts slugifyHeading/assignHeadingIds）；
  // 远程 comrak 0.56.0（server/Cargo.toml:22、Cargo.lock:252-253）统一 user-content- 前缀、
  // 重名 -1 起、全标点/emoji 标题成 user-content- / user-content--1 / user-content-标题--emoji
  // （server/src/compute/markdown.rs:26 header_id_prefix），且自产内嵌 anchor「id 带前缀、
  // href 不带」自不一致（仿 GitHub 形态——GitHub 靠自家前端 JS 做 hash→前缀映射，本仓库
  // 前端无任何此逻辑：rg 'data-heading-content|user-content' apps/web/src packages 零命中，
  // 页内锚也无自定义点击处理，hashchange/scrollIntoView 仅 markdownRenderer.ts:339 搜索
  // mark 高亮一处）→ 纯远程档输出内部自不一致：正文作者页内锚 3 条中 2 条死链（hash 变
  // scrollTop 不动）、comrak 自产 anchor 链接 12 条中 11 条死链、#intro 碰巧命中作者
  // <div id="intro"> 滚到错误元素。校准：TOC 面板按实际 DOM id 定位不受影响（远程档点
  // TOC scrollTop 0→121），文档浏览与其余功能正常，非崩溃/数据丢失/功能不可用。
  // 最小复现（需 --compute 同源实例，本套件 :4173 纯 web 不可执行，拓扑先例 HL-10/3）：
  //   ① http://127.0.0.1:8391 → 连接服务器 → 填 http://127.0.0.1:8391 → 连接；
  //   ② 文件树展开 explore-md/，点 toc-edge.md，确认状态栏「渲染: 远程」；
  //   ③ 点正文链接「到中文标题一」→ location.hash 变 #%E4%B8%AD%E6%96%87%E6%A0%87%E9%A2%98%E4%B8%80
  //      但 .vv-viewer-scroll.scrollTop 保持 0；emoji 标题链接同样不滚；
  //   ④ 对照：同一文件本地注入通道（无服务器连接）打开（渲染: 本地），同一链接
  //      scrollTop 0→121 正常跳转。
  // 证据（复核轮独立取得）：/tmp/md-e1-repro/repro.mjs——远程档 12 个 heading id 全带
  //   前缀（user-content-中文标题一 / -1 / user-content- / user-content--1 /
  //   user-content-标题--emoji），16 条 a[href^=#] 中 13 条目标 id 不存在（comrak 自产
  //   anchor 类 11 + 正文 2），仅 #intro/#deep-target 命中作者 HTML 自带 id；
  //   curl POST /api/compute/markdown 原始输出即「id 带前缀、内嵌锚 href 不带」
  //   （comrak 0.56 输出行为，非前端改写）；/tmp/md-e1-repro/toc.mjs——TOC 面板不受影响。
  // 修复方向：前端补 hash→user-content- 前缀映射（GitHub 同款）或 comrak 侧对齐本地方案。
  //   转正断言（--compute 同源实例）：正文页内锚点击 scrollTop 变化 + deadLinkCheck
  //   0 死链（comrak 自产 anchor href 与实际 heading id 全一致）。
});

test.fixme('BUG-40 [探索]: markdown 渲染视图净化放行五类等价加载向量——poster/SVG image/style url/table background/input image 外域真实外联', async ({
  page
}) => {
  // = 探索期编号 BUG-39（本文件上方 'BUG-39 [探索]' 用例）复核定档后的缺陷库确认编号，
  // 同缺陷同判据（载体/断言与上方用例一致），两用例一并转正；本条挂确认编号供修复 PR
  // 按 BUG-40 检索。复核成立、范围校准为 md 档（medium）：净化钩子
  // （packages/render-text/src/markdown/sanitize.ts:54-116，仅覆盖 IMG 的 src/srcset 与
  // VIDEO/AUDIO/SOURCE 的 src）放行 video/audio poster、SVG <image href/xlink:href>、
  // 行内 style url(...)、table background 属性、input type=image src 五类等价加载向量，
  // DOM 属性全保留且浏览器真实发起外域请求（md 档与纯前端档各 6 条 GET，failures 均为
  // net::ERR_EMPTY_RESPONSE 即已进网络栈——跟踪像素可回传 IP/会话）。html 沙箱档属性
  // 同样保留但被 srcdoc 内 CSP meta（packages/render-text/src/html.ts:27-28、68-71）在
  // 网络栈之前拦死（failures='csp'，对照实验证实 meta CSP 在 srcdoc 正常执行），不在本
  // 缺陷范围。
  // 证据（复核轮独立取得）：/tmp/vv-repro-cand-md-e2/repro.mjs（request/requestfailed/
  // requestresponse 三相记录）——md 档 requests=6（poster/svg-img/svg-xlink/bg/tbg/input），
  // failures 全为网络层错误，img[alt=plain] 等既有 BUG-17 行为完好；control.mjs——
  // errorText='csp'=网络栈之前拦截、未出浏览器。
  // 修复后判据：external.example 请求 0 条（不预设净化实现形态：剥属性/打 BUG-17 同款
  // data-vv-blocked-external 标记均可）。
  test.setTimeout(90_000);
  const V = 'http://external.example.com';
  const content = [
    `<img alt="plain" src="${V}/plain.jpg">`,
    '',
    `<video controls poster="${V}/poster.jpg"></video>`,
    '',
    `<svg><image href="${V}/svg-img.png"></image><image xlink:href="${V}/svg-xlink.png"></image></svg>`,
    '',
    `<div style="background:url(${V}/bg.png)">行内样式 url 外联</div>`,
    '',
    `<table background="${V}/tbg.png"><tr><td>表格背景外联</td></tr></table>`,
    '',
    `<p><input type="image" src="${V}/input.png" alt="input 外联"></p>`,
    ''
  ].join('\n');
  // 外域请求监听先于注入装载（核心判据：修复后 0 条外联，不预设净化实现形态）
  const external: string[] = [];
  page.on('request', (req) => {
    if (req.url().includes('external.example')) external.push(req.url());
  });
  await injectDir(page, [{ name: 'md40-vectors.md', content }]);
  await openTreeFile(page, 'md40-vectors.md');
  const md = page.locator('.vv-markdown');
  await expect(md).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(1_500); // 网络观察窗：覆盖属性加载触发的外域请求
  expect(external).toEqual([]);

  // 基线护栏：既有 BUG-17 行为不回退（img 外域 src 剥除 + 拦截标记）
  const img = md.locator('img[alt="plain"]');
  await expect(img).not.toHaveAttribute('src');
  await expect(img).toHaveAttribute('data-vv-blocked-external', '1');
  await expect(page.locator('.vv-error-card')).toHaveCount(0);
});
