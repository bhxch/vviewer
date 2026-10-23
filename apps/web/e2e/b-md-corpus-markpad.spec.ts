import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { injectDir, openTreeFile, type TextFileSpec } from './b-markdown-html-docs-helpers';

/**
 * b-md-corpus-markpad —— Markpad 真实语料批量渲染域（MC-01~MC-36，2026-10-22 default 套件）。
 *
 * 维度：bhxch/Markpad 公开仓 27 个真实 md 文件（tools/fetch-e2e-corpus.mjs 下载至
 * e2e/fixtures/corpus/markpad-md/，清单与 sha256 见 corpus/manifest.json）驱动渲染管线的
 * 稳定性与功能覆盖——区别于既有 spec 的内联构造夹具，本组用真实世界语料作载体。
 *
 * 用例组织（规模口径：手写场景 9 个 = 深断言 6 + 汇总锚 3，落 6~12 规模；
 * 批量组 27 例为域特殊设计要求的 for..of 逐文件程序化生成，每例只打开 1 个文件）：
 * - MC-01~MC-27 批量组：打开 → 等渲染完成（.vv-markdown 可见，管线全 await 后才挂载）
 *   → 无页面级未捕获错误（pageerror）→ 渲染容器出现 + 无错误卡。断言只锚稳定性，
 *   不锚语料具体内容。
 * - MC-28~MC-33 深断言组：以语料实有内容（写作时已逐文件读过）锚具体渲染能力
 *   （代码高亮 / 本地图表矩阵 / callout / 任务列表 / 表格 / 删除线 / 脚注 / wikilink /
 *   KaTeX / front matter 剥离 / 非 UTF-8 编码）。
 * - MC-34~MC-36 汇总锚：整批 27 文件按 basename 冲突避让分 3 批（9+9+9，单用例
 *   ≤10 个文件级打开），逐文件打开并聚合收集 console error，断言白名单外为零。
 *
 * 注入通道：injectDir（__vvOpenDirImpl + webkitRelativePath，与 m3/b-markdown-html-docs
 * 组同口径——页面内构造 File 走真实 openDirectoryViaInput 通道，纯前端本地管线，
 * 不依赖服务端）。语料以 readFileSync 原始字节 → base64 注入（TextFileSpec.b64 直通，
 * 绕过 utf-8 编码）——samples/encoding-* 为 GBK/Shift-JIS/CP1252 非 UTF-8 文件，
 * 解码属产品编码层职责，注入层必须保字节无损。树内按 basename 拍平为 bmd/<basename>
 * （27 个 basename 已核对全仓唯一），渲染管线只消费内容字节，目录结构不参与契约。
 * 容错：逐用例 fs.existsSync 判断，语料缺失（fetch 轮未落地）test.skip。
 *
 * kroki 环境无关化：MC-29 / MC-35 挂 page.route('**kroki.io/**') fulfill svg——demo_features.md
 * 的围栏经 spec §6 注册表翻转后分两组：仍 kroki 型 plantuml/ditaa ×2（fulfill 出 img），
 * local 型 vegalite/bpmn/svgbob/excalidraw ×4（CDN/本地 wasm 引擎，产物口径见 MC-29 用例
 * 注记）。fulfill 而非 abort：img 加载成功，不产生资源级 console error 污染汇总锚断言面
 * （abort 的降级源码面板形态已由 b-md-diagrams 覆盖，本组不重复）。favicon 同理 fulfill
 * 204 去噪。
 */

/** 语料目录与 27 文件清单（顺序即汇总锚分批顺序，manifest.json 为 sha 权威） */
const CORPUS_DIR = fileURLToPath(new URL('./fixtures/corpus/markpad-md', import.meta.url));
const CORPUS: readonly string[] = [
  // 批 1（根 5 + docs/plans 2 + docs/demo 2）
  'AGENTS.md',
  'README.md',
  'README.zh-CN.md',
  'RELEASING.md',
  'THIRD_PARTY_LICENSES.md',
  'docs/plans/2026-02-27-tree-sitter-highlighting-design.md',
  'docs/plans/2026-03-04-export-feature-design.md',
  'docs/demo/testfile.md',
  'docs/demo/test_highlight.md',
  // 批 2（docs 4 + docs/demo 3 + .github 1 + src-tauri/cylc 1）
  'docs/ARCHITECTURE.md',
  'docs/KROKI_SUPPORT.md',
  'docs/UPSTREAM_MERGE_REPORT.md',
  'docs/USER_GUIDE.md',
  'docs/demo/all_languages_test.md',
  'docs/demo/demo_features.md',
  'docs/demo/export_pipeline_test.md',
  '.github/PULL_REQUEST_TEMPLATE.md',
  'src-tauri/queries/cylc/README.md',
  // 批 3（samples 9，含 4 个非 UTF-8 编码文件与 121KB stress-test）
  'samples/encoding-cp1252.md',
  'samples/encoding-gbk-large.md',
  'samples/encoding-gbk.md',
  'samples/encoding-shift-jis.md',
  'samples/katex-stress.md',
  'samples/link-test.md',
  'samples/markdown-syntax.md',
  'samples/markdown-syntax.zh-CN.md',
  'samples/stress-test.md'
];

/** basename（树行匹配键，27 个已核对唯一） */
function basename(rel: string): string {
  return rel.slice(rel.lastIndexOf('/') + 1);
}

/** 语料 → 注入规格：原始字节 base64（encoding-* 非 UTF-8 文件字节无损），见头部说明 */
function corpusSpec(rel: string): TextFileSpec {
  const buf = readFileSync(join(CORPUS_DIR, rel));
  // content 传空串：helpers 约定 b64 给定时忽略 content 的 utf-8 编码（L19-21）
  return { name: basename(rel), content: '', type: 'text/markdown', b64: buf.toString('base64') };
}

/** pageerror 探针：必须先于 injectDir 内 goto 挂载（应用启动即可能抛） */
function collectPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  return errors;
}

/** 注入单个语料文件并打开，等待渲染管线完成（.vv-markdown 可见 = 五步管线就绪） */
async function openCorpus(page: Page, rel: string, visibleTimeout = 30_000): Promise<void> {
  const spec = corpusSpec(rel);
  await injectDir(page, [spec]);
  await openTreeFile(page, spec.name);
  await expect(page.locator('.vv-markdown')).toBeVisible({ timeout: visibleTimeout });
}

/** kroki/favicon/grammar-CDN 去噪 route：须在 goto 前注册（demo_features kroki 围栏随渲染即发起）
 *  CDN 层：门禁构建注入 VV_GRAMMAR_CDN=https://cdn.grammars.test/grammars/（ci.yml:99），三层链
 *  每次页面加载都会发 CDN manifest 请求——不 mock 会打真实 socket，资源级 console error
 *  （net::ERR_CONNECTION_CLOSED）污染 MC-34~36 汇总锚。fulfill 合法空清单（b-grammar-spa-fallback
 *  GRF-05 同惯例）：CDN 层成功返回空表，语言跳层 hljs 兜底，无 warn 无资源错误。 */
async function mockExternalNoise(page: Page): Promise<void> {
  await page.route('**kroki.io/**', (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>'
    })
  );
  await page.route('**/favicon.ico', (route) => route.fulfill({ status: 204 }));
  await page.route('**/cdn.grammars.test/**', (route) =>
    route.fulfill({
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: '{"grammars":{}}'
    })
  );
}

// ─────────────────────────── 批量组 MC-01~MC-27 ───────────────────────────

for (const [i, rel] of CORPUS.entries()) {
  const id = `MC-${String(i + 1).padStart(2, '0')}`;
  test(`${id} · 批量渲染 ${rel}：渲染容器出现、无未捕获错误、无错误卡`, async ({ page }) => {
    // 真实语料逐文件稳定性锚（特殊设计：for..of 逐文件一例）；不锚语料具体内容。
    // 语料全部 < 20MB MARKUP_MAX_BYTES（packages/render-text/src/code.ts:74），合法
    // 会话不该出现错误卡；断言红即语料触发了渲染降级，交门禁分诊而非放宽。
    test.setTimeout(120_000);
    const abs = join(CORPUS_DIR, rel);
    test.skip(!existsSync(abs), '语料文件缺失（fetch 轮未落地），对 manifest 清单容错');
    const pageErrors = collectPageErrors(page);
    await openCorpus(page, rel);
    expect(pageErrors).toEqual([]);
    await expect(page.locator('.vv-error-card')).toHaveCount(0);
  });
}

// ─────────────────────────── 深断言组 MC-28~MC-33 ───────────────────────────

test('MC-28 · all_languages_test.md 多语言围栏全部进入高亮管线（279 代码块计数 + bash 徽标着色）', async ({
  page
}) => {
  // 语料实有：282 个带语言围栏（ada→zig，564 行 ``` 标记 / 2），其中 dot/latex/mermaid
  // 各 1 走图表通道（resolveDiagramType 注册表接管，不产普通 pre code）——普通代码围栏
  // 279 全量进入高亮管线。锚：pre code 全量计数（语料结构，sha 锚定于 manifest）+ 图表
  // 容器恰 3；bash 徽标文本与着色 span（tree-sitter 命中或 hljs 兜底均产出 span，
  // MD-05 判据「获得语法着色」不锚引擎）。
  test.setTimeout(150_000);
  const rel = 'docs/demo/all_languages_test.md';
  test.skip(!existsSync(join(CORPUS_DIR, rel)), '语料文件缺失，对 manifest 清单容错');
  const pageErrors = collectPageErrors(page);
  await openCorpus(page, rel, 30_000);
  const md = page.locator('.vv-markdown');

  await expect(md.locator('pre code')).toHaveCount(279);
  await expect(md.locator('.md-diagram')).toHaveCount(3);
  const bash = md.locator('pre code.language-bash').first();
  await expect(bash).toBeVisible();
  await expect(md.locator('.md-code-lang', { hasText: 'bash' }).first()).toHaveText('bash');
  await expect(bash.locator('span').first()).toBeVisible({ timeout: 30_000 });

  expect(pageErrors).toEqual([]);
  await expect(page.locator('.vv-error-card')).toHaveCount(0);
});

test('MC-29 · demo_features.md 本地图表矩阵四引擎齐出 + kroki 型兜底 img + front matter 剥离', async ({
  page
}) => {
  // 语料实有（12 个图表围栏）：本地引擎 mermaid/graphviz(dot 别名)/nomnoml/svgbob ×4 产 svg +
  // math 通道 ×3（```math ×2 与 ```latex——math 的注册表别名，diagrams.ts:39）产 katex
  // display；仍 kroki 型 plantuml/ditaa ×2（spec §6 翻转注记：原 kroki 型 6 个中
  // vegalite/bpmn/excalidraw 已翻 CDN local，svgbob 翻本地 wasm——引擎产物口径见下）。
  // 锚：每围栏一个 .md-diagram 容器；仍 kroki 型经 fulfill 出 img（环境无关，不锚图内容）；
  // local 型出引擎产物——svgbob 本地 wasm svg 恒定，CDN 三类（vegalite/bpmn/excalidraw）
  // 真网出 svg、离线降级 kroki img（f807636 运行时回退），按「svg 或 img 终态产物」断言
  // 网络无关；front matter（title/author/tags）不泄漏进渲染正文（MD-06 判据，author 值
  // 'Markpad Team' 仅存在于 front matter）。csharp/rust 围栏照常高亮（图表语言除外）。
  test.setTimeout(150_000);
  const rel = 'docs/demo/demo_features.md';
  test.skip(!existsSync(join(CORPUS_DIR, rel)), '语料文件缺失（fetch 轮未落地），对 manifest 清单容错');
  await mockExternalNoise(page);
  const pageErrors = collectPageErrors(page);
  await openCorpus(page, rel, 30_000);
  const md = page.locator('.vv-markdown');

  // front matter 剥离：author 值不得出现在渲染正文
  await expect(md.getByText('Markpad Team')).toHaveCount(0);

  // 图表容器全量：12 围栏 → 12 .md-diagram
  await expect(md.locator('.md-diagram')).toHaveCount(12);

  // 仍 kroki 型 ×2：fulfill svg 出 img（环境无关）
  for (const lang of ['plantuml', 'ditaa']) {
    await expect(
      md
        .locator('.md-diagram')
        .filter({ has: page.locator('.md-diagram-lang', { hasText: lang }) })
        .locator('.md-diagram-view img')
    ).toHaveCount(1, { timeout: 30_000 });
  }

  // local 型：svgbob 本地 wasm svg 恒定（不依赖外网）；CDN 三类 svg 或 img 皆可
  //（真网 CDN 引擎产物 svg / 离线降级 kroki img——终态不得停在空视图或错误卡）
  for (const lang of ['mermaid', 'graphviz', 'nomnoml', 'svgbob']) {
    await expect(
      md
        .locator('.md-diagram')
        .filter({ has: page.locator('.md-diagram-lang', { hasText: lang }) })
        .locator('.md-diagram-view svg')
    ).toHaveCount(1, { timeout: 30_000 });
  }
  for (const lang of ['vegalite', 'bpmn', 'excalidraw']) {
    await expect(
      md
        .locator('.md-diagram')
        .filter({ has: page.locator('.md-diagram-lang', { hasText: lang }) })
        .locator('.md-diagram-view svg, .md-diagram-view img')
        .first()
    ).toBeVisible({ timeout: 60_000 });
  }
  await expect(md.locator('.md-diagram-view .katex-display')).toHaveCount(3);

  // 公式面：块级 7 = 正文 $$×3 + \[..\]×1 + diagram-view 内 math 通道 3（math×2+latex）
  await expect(md.locator('.katex-display')).toHaveCount(7);
  await expect(md.locator('.katex').first()).toBeVisible({ timeout: 30_000 });

  // 静态围栏高亮不受图表步挤占：csharp 代码块在、rust 徽标在
  await expect(md.locator('pre code.language-csharp')).toHaveCount(1);
  await expect(md.locator('.md-code-lang', { hasText: 'rust' }).first()).toHaveText('rust');

  expect(pageErrors).toEqual([]);
  await expect(page.locator('.vv-error-card')).toHaveCount(0);
});

test('MC-30 · testfile.md GFM 全家桶：五种 callout / 任务列表禁用 / 表格 / 删除线 / 围栏 / 公式', async ({
  page
}) => {
  // 语料实有：NOTE/TIP/IMPORTANT/WARNING/CAUTION 五种 callout（类型小写归一，
  // enrich.ts convertCallouts toLowerCase → markdown-alert-{type}）、任务列表 3 项
  // （2 勾选 1 未勾）、表格 1 张 3 行、删除线 ×1、rust/javascript/python 围栏各 1、
  // 行内 + 块级公式各 1。锚用户可见结构与可交互语义（checkbox disabled）。
  test.setTimeout(120_000);
  const rel = 'docs/demo/testfile.md';
  test.skip(!existsSync(join(CORPUS_DIR, rel)), '语料文件缺失，对 manifest 清单容错');
  const pageErrors = collectPageErrors(page);
  await openCorpus(page, rel, 30_000);
  const md = page.locator('.vv-markdown');

  for (const type of ['note', 'tip', 'important', 'warning', 'caution']) {
    await expect(md.locator(`.markdown-alert-${type}`)).toHaveCount(1);
  }

  const boxes = md.locator('li.task-list-item input[type="checkbox"]');
  await expect(boxes).toHaveCount(3);
  await expect(boxes.nth(0)).toBeChecked();
  await expect(boxes.nth(1)).toBeChecked();
  await expect(boxes.nth(2)).not.toBeChecked();
  for (const i of [0, 1, 2]) await expect(boxes.nth(i)).toBeDisabled();

  await expect(md.locator('table')).toHaveCount(1);
  await expect(md.locator('table tr')).toHaveCount(3);
  await expect(md.locator('del', { hasText: 'strikethrough' })).toHaveCount(1);
  for (const lang of ['rust', 'javascript', 'python']) {
    await expect(md.locator(`pre code.language-${lang}`)).toHaveCount(1);
  }
  await expect(md.locator('.katex-display')).toHaveCount(1);
  await expect(md.locator('.katex')).toHaveCount(2);

  expect(pageErrors).toEqual([]);
  await expect(page.locator('.vv-error-card')).toHaveCount(0);
});

test('MC-31 · stress-test.md 121KB 大文档：脚注编组回链 / 3 图表 / 72 代码块 / 多表格全渲染', async ({
  page
}) => {
  // 语料实有：121794 字节（全批最大），74 个显式围栏（markdown-it fence token 权威
  // 解析：text×60 + 语言围栏×11 + mermaid×3；「标记行/2」口径不成立——语料存在未闭合
  // 围栏形态）+ 1 个 4 空格缩进代码块（任务列表演示段）。mermaid ×3 走图表通道，
  // 其余 71 显式围栏 + 缩进代码块 = 72 个 pre code（依赖 protectLatexDelimiters 的
  // 未闭合 \[ 结构保序修复：679 行「\[ not a link」字面示例曾令后续数十行围栏标记
  // 被拼接失效）。锚大输入下管线完整性 + 图表异步产物就绪。
  test.setTimeout(180_000);
  const rel = 'samples/stress-test.md';
  test.skip(!existsSync(join(CORPUS_DIR, rel)), '语料文件缺失，对 manifest 清单容错');
  const pageErrors = collectPageErrors(page);
  await openCorpus(page, rel, 30_000);
  const md = page.locator('.vv-markdown');

  await expect(md.locator('sup.footnote-ref')).toHaveCount(4);
  await expect(md.locator('section.footnotes')).toHaveCount(1);
  await expect(md.locator('section.footnotes li')).toHaveCount(3);

  await expect(md.locator('pre code')).toHaveCount(72);
  await expect(md.locator('.md-diagram')).toHaveCount(3);
  await expect(md.locator('.md-diagram-view svg')).toHaveCount(3, { timeout: 30_000 });
  // 表格下限锚（609 个 | 行拆数十张表，精确数无行为价值；下限防表格解析退化）
  await expect
    .poll(() => md.locator('table').count(), {
      timeout: 30_000,
      message: '等待表格全量挂载'
    })
    .toBeGreaterThanOrEqual(5);

  expect(pageErrors).toEqual([]);
  await expect(page.locator('.vv-error-card')).toHaveCount(0);
});

test('MC-32 · markdown-syntax.md wikilink 分流与脚注：跨文件死链 span、页内锚 a、脚注编组', async ({
  page
}) => {
  // 语料实有（正文裸语法，行内码/表格内的同款字样豁免）：跨文件 wikilink ×3
  // （L323 裸 + L324 带别名 + L406 [[sub/deep#Setup]] → span.md-wikilink-dead，
  // enrich.ts:221；目标文件不在注入会话中）、页内锚 wikilink ×2（L325 [[#1. Text]] /
  // L333 [[#^demo-block]] → a[data-wikilink]，enrich.ts:245）、
  // 定义脚注 [^ref]×2 + 行内脚注 ^[...]×1（markdown-it-footnote 编组进 section.footnotes）、
  // mermaid ×4（flowchart/sequence/pie/gantt 全合法图型，本地渲染 svg）。
  test.setTimeout(150_000);
  const rel = 'samples/markdown-syntax.md';
  test.skip(!existsSync(join(CORPUS_DIR, rel)), '语料文件缺失，对 manifest 清单容错');
  const pageErrors = collectPageErrors(page);
  await openCorpus(page, rel, 30_000);
  const md = page.locator('.vv-markdown');

  await expect(md.locator('span.md-wikilink-dead')).toHaveCount(3);
  await expect(md.locator('a[data-wikilink]')).toHaveCount(2);
  await expect(md.locator('sup.footnote-ref')).toHaveCount(3);
  await expect(md.locator('section.footnotes')).toHaveCount(1);
  await expect(md.locator('section.footnotes li')).toHaveCount(2);

  await expect(md.locator('.md-diagram')).toHaveCount(4);
  await expect(md.locator('.md-diagram-view svg')).toHaveCount(4, { timeout: 30_000 });

  expect(pageErrors).toEqual([]);
  await expect(page.locator('.vv-error-card')).toHaveCount(0);
});

test('MC-33 · encoding-gbk.md 非 UTF-8 语料：GBK 字节注入后渲染容器就绪且不崩', async ({
  page
}) => {
  // 真实世界维度：语料为 GBK 编码（7405 字节，原始字节注入）。产品无编码标注 UI 的
  // 稳定契约锚点（未检索到状态栏编码字段），本用例只锚稳定性判据：解码替换字符不阻断
  // 渲染管线、容器出现、正文结构（列表）可见、零未捕获错误、无错误卡。
  test.setTimeout(120_000);
  const rel = 'samples/encoding-gbk.md';
  test.skip(!existsSync(join(CORPUS_DIR, rel)), '语料文件缺失，对 manifest 清单容错');
  const pageErrors = collectPageErrors(page);
  await openCorpus(page, rel, 30_000);
  const md = page.locator('.vv-markdown');

  await expect(md.locator('li').first()).toBeVisible();

  expect(pageErrors).toEqual([]);
  await expect(page.locator('.vv-error-card')).toHaveCount(0);
});

// ─────────────────────────── 汇总锚 MC-34~MC-36 ───────────────────────────
// 整批 console error 聚合：27 文件按 basename 避让分 3 批（README.md 与 cylc/README.md
// 分居批 1/批 2），单用例 ≤10 次文件级打开。每批注入→逐文件打开→渲染就绪，页面级
// console error 收集断言白名单外为零 + pageerror 全程为零。

/** console error 白名单（按 url/text 判定，逐项注明理由）：
 * 1. kroki —— MC-29/35 装置层 fulfill 的远端图表服务域：fulfill 边缘（pako 编码后 URL
 *    构造、img 解码告警）属环境无关噪音，非渲染管线缺陷（b-md-diagrams 同域惯例）。
 * 2. Failed to load resource 且 url 为图片资源 —— 语料自带相对图片引用（如
 *    export_pipeline_test.md 的 ../../pics/codeblock.png）在注入会话中无宿主文件，
 *    产品契约即保留原 src 让浏览器 404 降级（markdownImages.ts L3-4「404 现状」），
 *    属数据缺失而非渲染缺陷。
 * 3. favicon —— vite preview 静态壳资源面，装置层已 fulfill 204，此条为双保险兜底。
 * 4. cdn.jsdelivr.net —— spec §6 四类 local CDN 图表引擎的加载面：离线/被墙环境下动态
 *    import 的资源级失败属回退链设计内路径（local→kroki 降级，f807636），非渲染缺陷；
 *    真网环境无此条命中。 */
function collectConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    const url = msg.location()?.url ?? '';
    if (/kroki/i.test(url) || /kroki/i.test(text)) return;
    if (/cdn\.jsdelivr\.net/i.test(url) || /cdn\.jsdelivr\.net/i.test(text)) return;
    if (text.includes('Failed to load resource') && /\.(png|jpe?g|gif|webp|svg|ico)([?#]|$)/i.test(url)) {
      return;
    }
    if (/favicon/i.test(url)) return;
    errors.push(`${text} @ ${url}`);
  });
  return errors;
}

for (const [bi, batch] of [CORPUS.slice(0, 9), CORPUS.slice(9, 18), CORPUS.slice(18, 27)].entries()) {
  const id = `MC-${String(34 + bi)}`;
  test(`${id} · 整批渲染汇总锚（第 ${bi + 1} 批 ${batch.length} 文件）：console error 白名单外为零`, async ({
    page
  }) => {
    // 批 2 含 demo_features（kroki 围栏）与 all_languages（282 高亮）→ 300s；
    // 批 3 含 stress-test（121KB）与 gbk-large（103KB）→ 300s。
    test.setTimeout(300_000);
    for (const rel of batch) {
      test.skip(!existsSync(join(CORPUS_DIR, rel)), `语料文件缺失：${rel}`);
    }
    await mockExternalNoise(page);
    const pageErrors = collectPageErrors(page);
    const consoleErrors = collectConsoleErrors(page);

    await injectDir(
      page,
      batch.map((rel) => corpusSpec(rel))
    );
    for (const rel of batch) {
      await openTreeFile(page, basename(rel));
      await expect(page.locator('.vv-markdown')).toBeVisible({ timeout: 30_000 });
    }

    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
    await expect(page.locator('.vv-error-card')).toHaveCount(0);
  });
}
