import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { injectDir, type TextFileSpec } from './b-markdown-html-docs-helpers';
import { closeDrawerIfOpened, openDrawerIfNarrow } from './drawer';

/**
 * b-md-corpus-multisource —— 多源真实语料批量渲染域（MS 系，2026-10-23 default 套件）。
 *
 * 语料：tools/fetch-e2e-corpus.mjs 按 manifest（e2e/fixtures/corpus/manifest.json，sha256
 * 权威）从各上游公开仓钉定 commit 下载至 e2e/fixtures/corpus/<source-id>/<仓库内相对路径>
 * （基建全 8 源）。
 * 本 spec 只覆盖三个 md 源——mermaid-docs（mermaid-js/mermaid@6d8921f，docs/ 前 70 个）、
 * katex-docs（KaTeX/KaTeX@8f0d9bc，docs/ 全 13 个）、k8s-docs（kubernetes/website@6c42e26，
 * content/en/docs/concepts/workloads 全 38 个）；markpad-md 已有 MC 系覆盖不重复，
 * linguist-samples/hljs-detect 等 text 语料归另一域。
 *
 * 用例组织（规模口径落 6~19，单用例 ≤10 个文件级打开）：
 * - 滚动批（动态清单）：manifest.sources 运行时生成，每源 ceil(n/10) 例滚动批——注入一批
 *   （≤10 文件）→ 逐文件打开 → .vv-markdown 可见（五步管线全 await 后挂载）→ 按源锚
 *   特征下限 → 零 pageerror → console error 白名单外为零。ViewerPane 单实例挂载
 *   （AppShell.svelte:1045 单 <ViewerPane tab=…>，切换即卸载后台 tab DOM），svg/katex/
 *   代码块计数必须在文件激活时逐文件累计（Node 侧求和），不能一次性查全页。
 * - 深断言组（静态声明 ×6）：每源 2 个代表文件逐文件锚具体能力。代表文件按 manifest
 *   实有清单挑选（写作时已逐文件读过实有内容），锚点数值两类口径——
 *   (a) 运行时扫描：spec 内置语料状态机扫描器（见下方扫描器节）从磁盘语料实算围栏/
 *       表格/标题数作下限，语料漂移时自动跟随；
 *   (b) 预检实证常量：以仓内同版本权威引擎离线预检后写死的数值，逐处注释注明实证方式：
 *       · mermaid：mermaid@12.1.0（产品同版本，packages/render-text/package.json:20）
 *         mermaid.parse + jsdom DOM 垫片，2026-10-23 实测 70 文件共 54 个顶层 mermaid
 *         围栏、52 个 parse 通过，仅 2 个真失败（MERMAID_PARSE_INVALID 修正表）；
 *         注意按嵌套围栏状态机 + 精确语言计数——naive 行计数会把 49 个 ```mermaid-example
 *         前缀围栏一并计入 mermaid（54 vs 103，example 不在图表注册表不产 svg）。
 *       · katex：katex@0.19.0（产品同版本，apps/web/package.json:21）renderToString
 *         throwOnError:true 逐个验证——support_table.md 990 个行内 $ 配对 979 通过、
 *         supported.md 961 对 947 通过，其余 katex 文件无行内数学；$$ 块共 24 对
 *         （support_table.md 15 + supported.md 9，env 族/CD/tag 形态，全部住在表格
 *         单元格或独立段）。注意 display 预检（原文直喂 katex 24/24 通过）≠ 管线实证：
 *         CommonMark 反斜杠转义把 LaTeX 换行 \\ 折叠为 \，含 \\ 的对非法不渲染
 *         （管线实证 support_table.md 6/15、supported.md 5/9），深断言锚取管线实证值。
 *         深断言常量仍取实证值的相当余量以下作下限，余量对抗 markdown 转义改写
 *         （\{ → { 等）与文本节点切分损耗。
 * - 缺源占位：manifest 缺某源或源文件全缺（2026-10-23 当日 k8s-docs 曾因 fetcher 递归
 *   树截断短暂缺失，现已落地；分支保留作语料重置期的容错）时生成 skip 占位例，
 *   语料落地后自动展开为真实批。
 *
 * 注入通道：injectDir（__vvOpenDirImpl + webkitRelativePath，与 MC 系/m3 同口径——页面内
 * 构造 File 走真实 openDirectoryViaInput 通道，纯前端本地管线，不依赖服务端）。语料以
 * readFileSync 原始字节 → base64 注入（TextFileSpec.b64 直通）。树内按 basename 拍平，
 * 同批内 basename 冲突时改用全路径（/ → __）派生唯一名（k8s 批 1 同含根/_index.md 与
 * 两个子目录 _index.md）；树行点击用 .vv-tree-name 精确文本匹配（TreeNodeRow.svelte:57
 * 文件名独占 span），防 hasText 子串误中（_index.md 是派生名的子串）。
 *
 * console error 白名单（白名单制，逐条注明理由，复用 MC 系口径 + 1 条外链 CSS）见
 * collectConsoleErrors；kroki/favicon/grammar-CDN/外链 katex.min.css 在装置层 fulfill
 * 去噪，白名单为双保险兜底。
 * 容错：manifest 读取失败视为 null；逐文件 fs.existsSync 判断，缺失即 skip。
 * 确定性：无裸 sleep，全部轮询断言走 expect.poll / toBeVisible 自重试。
 */

// ─────────────────────────── manifest 与语料清单 ───────────────────────────

const CORPUS_ROOT = fileURLToPath(new URL('./fixtures/corpus', import.meta.url));

/** 本 spec 覆盖的三个 md 源（固定序；markpad-md 归 MC 系、其余 text 语料归另一域） */
const SOURCES_UNDER_TEST = ['mermaid-docs', 'katex-docs', 'k8s-docs'] as const;
type SourceId = (typeof SOURCES_UNDER_TEST)[number];

/** 单用例文件级打开上限（设计要求 ≤10） */
const BATCH_SIZE = 10;

/** manifest schema（tools/fetch-e2e-corpus.mjs 落盘，ask 契约定死） */
interface CorpusFile {
  path: string;
  size: number;
  sha256: string;
}
interface CorpusSource {
  id: string;
  repo: string;
  commit: string;
  truncatedByMaxFiles?: boolean;
  files: CorpusFile[];
}
interface CorpusManifest {
  generatedAt: string;
  sources: CorpusSource[];
  counts: { total: number; bySource: Record<string, number> };
  failures: Array<{ source: string; path: string; reason: string }>;
}

/** manifest 运行时读取：文件缺失/损坏（fetch 轮未落地）→ null，全部用例走占位 skip */
function readManifest(): CorpusManifest | null {
  try {
    return JSON.parse(readFileSync(join(CORPUS_ROOT, 'manifest.json'), 'utf-8')) as CorpusManifest;
  } catch {
    return null;
  }
}
const manifest = readManifest();

function sourceOf(sourceId: SourceId): CorpusSource | null {
  return manifest?.sources.find((s) => s.id === sourceId) ?? null;
}

/** 源内仓库相对路径 → 磁盘语料路径（fixtures/corpus/<source-id>/<repo 相对路径>） */
function diskPath(sourceId: SourceId, rel: string): string {
  return join(CORPUS_ROOT, sourceId, rel);
}

/** 语料文本读取（utf-8；三源均为 .md 文本，无非 UTF-8 编码文件） */
function corpusText(sourceId: SourceId, rel: string): string {
  return readFileSync(diskPath(sourceId, rel), 'utf-8');
}

/** 语料 → 注入规格：原始字节 base64（TextFileSpec.b64 直通，见 injectDir 头注） */
function corpusSpec(sourceId: SourceId, rel: string, name: string): TextFileSpec {
  const buf = readFileSync(diskPath(sourceId, rel));
  return { name, content: '', type: 'text/markdown', b64: buf.toString('base64') };
}

// ─────────────────────────── 语料扫描器（运行时下限来源） ───────────────────────────
// 与预检探针同款状态机：按 CommonMark 围栏规则（0-3 空格缩进、同标记开闭）跟踪嵌套，
// 只统计顶层围栏——mermaid 文档大量示例包在外层 ```` 围栏内，naive 行计数会翻倍多算。

interface TopFence {
  lang: string;
  body: string;
}

function topLevelFences(text: string): TopFence[] {
  const out: TopFence[] = [];
  let inFence = false;
  let mark = '';
  let lang = '';
  let body: string[] = [];
  for (const raw of text.split('\n')) {
    const m = raw.match(/^ {0,3}(`{3,}|~{3,})/);
    if (m) {
      if (!inFence) {
        inFence = true;
        mark = m[1]?.[0] ?? '';
        lang = raw.slice(m[0].length).trim().split(/\s+/)[0] ?? '';
        body = [];
      } else if ((m[1]?.[0] ?? '') === mark && raw.trim() === m[1]) {
        inFence = false;
        out.push({ lang, body: body.join('\n') });
      }
      continue;
    }
    if (inFence) body.push(raw);
  }
  return out;
}

/** 剥离 front matter（k8s 语料每文件头部 --- 块）后的围栏外行 */
function bodyLinesOutsideFences(text: string): string[] {
  const stripped = text.replace(/^---\n[\s\S]*?\n---\n/, '');
  const lines: string[] = [];
  let inFence = false;
  let mark = '';
  for (const raw of stripped.split('\n')) {
    const m = raw.match(/^ {0,3}(`{3,}|~{3,})/);
    if (m) {
      if (!inFence) {
        inFence = true;
        mark = m[1]?.[0] ?? '';
      } else if ((m[1]?.[0] ?? '') === mark && raw.trim() === m[1]) {
        inFence = false;
      }
      continue;
    }
    if (!inFence) lines.push(raw);
  }
  return lines;
}

/** 行内码 span 剔除（产品 MATH_SKIP_TAGS 跳过 CODE 祖先，扫描器对齐该语义） */
function stripInlineCode(line: string): string {
  return line.replace(/`[^`]*`/g, (s) => ' '.repeat(s.length));
}

/**
 * $$ 块级公式对数（同行配对）。口径：围栏外、行内码外，$$ 配对的内文非空且不含
 * '|'（表格单元格边界）——非 | 规则剔除相邻单元格 $x$/$y$ 拼接出的伪对。三源实得
 * 对均为真块（support_table.md 15 + supported.md 9，env 族/CD/tag 形态，其余文件 0）。
 * 注意：本计数是原文口径——含 LaTeX 换行 \\ 的对被 CommonMark 转义折叠为 \ 后非法、
 * 管线不渲染（实证 support_table.md 6/15、supported.md 5/9），故作下限时须给足转义
 * 改写余量（批量项叠加取半的行内数、深断言 min 上限另锚管线实证值）。
 */
function displayMathPairCount(text: string): number {
  let count = 0;
  for (const raw of bodyLinesOutsideFences(text)) {
    const line = stripInlineCode(raw);
    let i = 0;
    while (i < line.length) {
      const open = line.indexOf('$$', i);
      if (open === -1) break;
      const close = line.indexOf('$$', open + 2);
      if (close === -1) break;
      const inner = line.slice(open + 2, close);
      if (inner.trim() !== '' && !inner.includes('|')) count += 1;
      i = close + 2;
    }
  }
  return count;
}

/**
 * 行内 $...$ 配对数（扫描器镜像产品 pipeline.ts scanMathSegments 的行内规则：
 * 开定界符后/闭定界符前不贴空白、止于行尾）。仅用于 katex 批的每文件下限，
 * 取一半作锚（余量抗 markdown 转义改写与文本节点切分损耗，见头部实证节）。
 */
function inlineMathSpanCount(text: string): number {
  let count = 0;
  for (const raw of bodyLinesOutsideFences(text)) {
    const line = stripInlineCode(raw);
    for (let i = 0; i < line.length; i += 1) {
      if (line[i] !== '$') continue;
      if (line[i + 1] === '$') {
        i += 1;
        continue;
      }
      const next = line[i + 1] ?? '';
      if (next && !/[\s$]/.test(next)) {
        let j = i + 1;
        while (j < line.length && line[j] !== '$' && line[j] !== '\n') j += 1;
        if (line[j] === '$' && j > i + 1 && !/\s/.test(line[j - 1] ?? '')) {
          count += 1;
          i = j;
        }
      }
    }
  }
  return count;
}

/** 表格分隔行数（仅由 | : - 空白组成、含 ≥1 个 | 与 ≥3 个 -；每条分隔行 = 一张表） */
function tableSeparatorCount(text: string): number {
  let count = 0;
  for (const raw of bodyLinesOutsideFences(text)) {
    if (/^[ \t]*[|:\-\t ]*$/.test(raw) && raw.includes('|') && (raw.match(/-/g) ?? []).length >= 3) {
      count += 1;
    }
  }
  return count;
}

/** ## 级标题数（ATX 空格形态；front matter 已剥） */
function heading2Count(text: string): number {
  return bodyLinesOutsideFences(text).filter((l) => /^## /.test(l)).length;
}

/** yaml 围栏数（k8s 语料主力代码围栏；yaml 不在图表注册表，必落 pre code） */
function yamlFenceCount(text: string): number {
  return topLevelFences(text).filter((f) => f.lang === 'yaml').length;
}

/**
 * mermaid 顶层围栏 parse 失败修正表（预检实证：mermaid@12.1.0 parse + jsdom，2026-10-23；
 * 70 文件 54 围栏 52 通过，以下 2 个真失败——8.6.0_docs.md 围栏语法错误 parse 报错、
 * directives.md 第 2 围栏仅指令无图体 UnknownDiagramError。产品 mermaid 渲染失败走
 * .md-diagram-error 降级不出 svg，svg 下限须扣除）。
 */
const MERMAID_PARSE_INVALID: Partial<Record<string, number>> = {
  'docs/config/8.6.0_docs.md': 1,
  'docs/config/directives.md': 1
};

/** mermaid 文件可渲染围栏下限 = 顶层 mermaid 围栏 − parse 失败修正 */
function mermaidValidFences(rel: string, text: string): number {
  const total = topLevelFences(text).filter((f) => f.lang === 'mermaid').length;
  return total - (MERMAID_PARSE_INVALID[rel] ?? 0);
}

// ─────────────────────────── 注入与打开装置 ───────────────────────────

function basename(rel: string): string {
  return rel.slice(rel.lastIndexOf('/') + 1);
}

/**
 * 批内唯一注入名：basename 冲突时改用全路径派生（/ → __）。
 * k8s 批 1 同含根 _index.md 与 compositepodgroup-api/_index.md、controllers/_index.md，
 * basename 拍平必冲突；.md 后缀保留，管线按扩展名检测不受影响。
 */
function injectedNames(rels: string[]): Map<string, string> {
  const seen = new Set<string>();
  const map = new Map<string, string>();
  for (const rel of rels) {
    let name = basename(rel);
    if (seen.has(name)) name = rel.replace(/\//g, '__');
    while (seen.has(name)) name = `dup-${name}`;
    seen.add(name);
    map.set(rel, name);
  }
  return map;
}

/** pageerror 探针：必须先于 injectDir 内 goto 挂载（应用启动即可能抛） */
function collectPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  return errors;
}

/**
 * console error 白名单（按 url/text 判定，逐项注明理由；MC 系口径 + 1 条外链 CSS）：
 * 1. kroki —— 装置层 fulfill 的远端图表服务域（本三源实测无 kroki 型围栏，路由为防御性
 *    预留）：fulfill 边缘噪音属环境无关，非渲染管线缺陷（b-md-diagrams 同域惯例）。
 * 2. Failed to load resource 且 url 为图片资源 —— 语料自带图片引用（mermaid-docs 的
 *    img/book-banner-*.jpg、./img/*.png、/header.png、api.producthunt.com/*.svg 等）在
 *    注入会话中无宿主文件，产品契约即保留原 src 让浏览器 404 降级（markdownImages 的
 *    「404 现状」）；外域 img 已被 BUG-40 拦截不发请求，不会出现在此面。
 * 3. favicon —— vite preview 静态壳资源面，装置层已 fulfill 204，此条为双保险兜底。
 * 4. 外链 CSS —— support_table.md/supported.md 上游文档原生携带
 *    cdn.jsdelivr.net 的 katex.min.css <link>，离线环境资源级 error 属数据面缺失；
 *    装置层已 fulfill 空 CSS，此条为双保险兜底。
 */
function collectConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    const url = msg.location()?.url ?? '';
    if (/kroki/i.test(url) || /kroki/i.test(text)) return;
    if (text.includes('Failed to load resource') && /\.(png|jpe?g|gif|webp|svg|ico)([?#]|$)/i.test(url)) {
      return;
    }
    if (/favicon/i.test(url)) return;
    if (/cdn\.jsdelivr\.net/i.test(url) || /cdn\.jsdelivr\.net/i.test(text)) return;
    errors.push(`${text} @ ${url}`);
  });
  return errors;
}

/**
 * 外部噪音 route：须在 goto 前注册。kroki（防御性预留，三源实测无 kroki 围栏）、
 * favicon 204、grammar-CDN 合法空清单（门禁构建注入 VV_GRAMMAR_CDN=https://cdn.grammars.test/
 * grammars/（ci.yml:99），三层链每次页面加载都发 CDN manifest 请求，不 mock 打真实
 * socket 产生资源级 console error 污染汇总面——MC 系同款装置）、jsdelivr 外链 CSS 空
 * 文件（support_table/supported 上游原生 <link>）。
 */
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
  await page.route('**/cdn.jsdelivr.net/**', (route) =>
    route.fulfill({ contentType: 'text/css', body: '/* 语料外链样式去噪（离线环境无关化） */' })
  );
}

/**
 * 精确名打开树文件：树行按 .vv-tree-name 精确文本匹配（hasText 子串会误中
 * compositepodgroup-api___index.md 之类的派生名里的 _index.md），窄视口经抽屉开合
 * （drawer.ts），tab 激活等待沿用 MC 系 .vv-tab.active 口径（active 类天然限定唯一）。
 */
async function openCorpusFile(page: Page, name: string, visibleTimeout = 30_000): Promise<void> {
  const drawer = await openDrawerIfNarrow(page);
  await page
    .locator('.vv-tree-row')
    .filter({ has: page.getByText(name, { exact: true }) })
    .click();
  await closeDrawerIfOpened(page, drawer);
  await expect(
    page.locator('.vv-tab.active').filter({ has: page.getByText(name, { exact: true }) })
  ).toBeVisible();
  await expect(page.locator('.vv-markdown')).toBeVisible({ timeout: visibleTimeout });
}

/** 源文件在 manifest 且已落盘（深断言代表文件挑选 + 容错 skip 判据） */
function corpusAvailable(sourceId: SourceId, rel: string): boolean {
  const src = sourceOf(sourceId);
  return src !== null && src.files.some((f) => f.path === rel) && existsSync(diskPath(sourceId, rel));
}

/** 源的实有文件清单（manifest ∩ 磁盘，manifest 序即 fetch tree 序） */
function availableFiles(sourceId: SourceId): string[] {
  return (sourceOf(sourceId)?.files ?? [])
    .map((f) => f.path)
    .filter((rel) => existsSync(diskPath(sourceId, rel)));
}

/** 每文件特征下限：按源分派（mermaid 可渲染围栏 / katex 公式 / k8s yaml 围栏） */
function perFileBound(sourceId: SourceId, rel: string): number {
  const text = corpusText(sourceId, rel);
  switch (sourceId) {
    case 'mermaid-docs':
      return mermaidValidFences(rel, text);
    case 'katex-docs':
      // $$ 对全额 + 行内对一半（余量见 inlineMathSpanCount 头注；实证 979/990 与 947/961
      // 通过率 ≈ 98.5%，半额锚远低于真实产能）
      return displayMathPairCount(text) + Math.floor(inlineMathSpanCount(text) / 2);
    case 'k8s-docs':
      return yamlFenceCount(text);
  }
}

/** 滚动批超时上限（CI 双核 workers=1 留量：mermaid 异步渲染/katex 千级公式/大文件管线） */
const BATCH_TIMEOUT: Record<SourceId, number> = {
  'mermaid-docs': 480_000,
  'katex-docs': 480_000,
  'k8s-docs': 420_000
};

// ─────────────────────────── 滚动批（动态清单生成） ───────────────────────────
// 三源全量滚动批即汇总锚载体：每批 console error 逐文件累积收集、批末白名单外为零
// （MC 系将批量组与汇总锚分列两组各开一遍全量文件；多源 121 文件体量下重开一遍
// 翻倍时长无增益，故合并为单趟——收集面等价覆盖三源全量滚动批）。

let seq = 0;
function nid(): string {
  return `MS-${String((seq += 1)).padStart(2, '0')}`;
}

for (const sourceId of SOURCES_UNDER_TEST) {
  const rels = availableFiles(sourceId);
  const batches: string[][] = [];
  for (let i = 0; i < rels.length; i += BATCH_SIZE) batches.push(rels.slice(i, i + BATCH_SIZE));

  if (batches.length === 0) {
    test(`${nid()} · ${sourceId} 语料滚动批（语料未落地占位）`, async () => {
      // 容错占位：manifest 缺该源（如 k8s-docs fetch 修复中）或源文件全部缺失时整组
      // 跳过；语料落地后本 spec 按 manifest 自动展开为真实滚动批，无需改测试。
      test.skip(
        true,
        sourceOf(sourceId) ? '源已登记但语料文件全部缺失（fetch 轮未落地）' : 'manifest 缺该源（fetch 失败修复中）'
      );
    });
    continue;
  }

  batches.forEach((batch, bi) => {
    test(`${nid()} · ${sourceId} 滚动批 ${bi + 1}/${batches.length}（${batch.length} 文件）：逐文件渲染完成、特征达下限、console error 白名单外为零`, async ({
      page
    }) => {
      test.setTimeout(BATCH_TIMEOUT[sourceId]);
      for (const rel of batch) {
        test.skip(!existsSync(diskPath(sourceId, rel)), `语料文件缺失：${rel}`);
      }
      await mockExternalNoise(page);
      const pageErrors = collectPageErrors(page);
      const consoleErrors = collectConsoleErrors(page);

      const names = injectedNames(batch);
      await injectDir(
        page,
        batch.map((rel) => corpusSpec(sourceId, rel, names.get(rel)!))
      );

      let boundSum = 0; // 特征下限累计（svg/公式/代码块）
      let actualSum = 0; // 特征实测累计（激活态逐文件快照）
      let tableSum = 0; // k8s：表格实测累计
      let tableSepSum = 0; // k8s：表格分隔行下限累计
      let codeAnchorDone = false; // k8s：高亮存在性锚只做一次（首个有围栏文件）
      for (const rel of batch) {
        const text = corpusText(sourceId, rel);
        const bound = perFileBound(sourceId, rel);
        boundSum += bound;
        if (sourceId === 'k8s-docs') tableSepSum += tableSeparatorCount(text);

        await openCorpusFile(page, names.get(rel)!);
        const md = page.locator('.vv-markdown');

        if (sourceId === 'mermaid-docs') {
          // mermaid 异步渲染：svg 逐文件轮询至该文件可渲染围栏下限（parse 修正见
          // MERMAID_PARSE_INVALID；失败围栏走 .md-diagram-error 不产 svg）
          if (bound > 0) {
            await expect
              .poll(() => page.locator('.md-diagram-view svg').count(), {
                timeout: 60_000,
                message: `等待 ${rel} 的 mermaid svg 达下限 ${bound}`
              })
              .toBeGreaterThanOrEqual(bound);
          }
          actualSum += await page.locator('.md-diagram-view svg').count();
        } else if (sourceId === 'katex-docs') {
          // katex 公式：管线 katex 步随挂载完成（.vv-markdown 可见 = 全步 await），
          // 轮询兜底异步边缘；下限 = $$ 对全额 + 行内对半额
          if (bound > 0) {
            await expect
              .poll(() => page.locator('.katex').count(), {
                timeout: 60_000,
                message: `等待 ${rel} 的 .katex 达下限 ${bound}`
              })
              .toBeGreaterThanOrEqual(bound);
          }
          actualSum += await page.locator('.katex').count();
        } else {
          // k8s：pre code 随 innerHTML 挂载即全量（高亮 span 异步回填不改元素数），
          // yaml 围栏不在图表注册表（diagrams.ts:21-38）必落 pre code
          const preCode = await md.locator('pre code').count();
          expect(preCode).toBeGreaterThanOrEqual(bound);
          actualSum += preCode;
          tableSum += await md.locator('table').count();
          // 代码高亮存在性（批内首个有围栏文件上做一次）：语言徽标 + 高亮 span
          //（tree-sitter 命中或 hljs 兜底均产出，不锚引擎）
          if (bound > 0 && !codeAnchorDone) {
            codeAnchorDone = true;
            await expect(md.locator('.md-code-lang').first()).toBeVisible({ timeout: 30_000 });
            await expect(md.locator('pre code span').first()).toBeAttached({ timeout: 30_000 });
          }
        }

        // 合法会话不该出现错误卡（逐文件断言，单面板挂载下恰为当前文件判据）
        await expect(page.locator('.vv-error-card')).toHaveCount(0);
      }

      // 批级累计下限 + 全批 pageerror/console 白名单断言
      expect(actualSum).toBeGreaterThanOrEqual(boundSum);
      if (sourceId === 'k8s-docs' && tableSepSum > 0) {
        // 每条表格分隔行对应一张表（实测 38 文件共 18 条分隔行）
        expect(tableSum).toBeGreaterThanOrEqual(tableSepSum);
      }
      expect(consoleErrors).toEqual([]);
      expect(pageErrors).toEqual([]);
    });
  });
}

// ─────────────────────────── 深断言组（每源 2 代表文件） ───────────────────────────

test('MS 深断言 · mermaid-docs intro/index.md：10 图表围栏全量 svg + mermaid-example 保持代码块', async ({
  page
}) => {
  // 语料实有（已读，AUTOGENERATED 横幅 + 教程正文）：```mermaid 与 ```mermaid-example
  // 交替各 10 个（运行时实算），其余 6 个围栏为 html/bash/sh 与无语言形态。锚：每顶层
  // mermaid 围栏一个 .md-diagram 容器、svg 全量就绪（预检 mermaid@12.1.0 parse 10/10
  // 通过）；mermaid-example 不在图表注册表（diagrams.ts:21 仅注册 mermaid，无 example
  // 别名）→ 与其余代码围栏一并保持 pre code 形态，与活图形成同文件对照。
  test.setTimeout(300_000);
  const sourceId: SourceId = 'mermaid-docs';
  const rel = 'docs/intro/index.md';
  if (!corpusAvailable(sourceId, rel)) {
    test.skip(true, '代表文件不在语料集（manifest 收缩或 fetch 轮未落地）');
    return;
  }
  await mockExternalNoise(page);
  const pageErrors = collectPageErrors(page);
  const text = corpusText(sourceId, rel);
  const liveCount = topLevelFences(text).filter((f) => f.lang === 'mermaid').length;
  const plainCodeCount = topLevelFences(text).filter((f) => f.lang !== 'mermaid').length;

  await injectDir(page, [corpusSpec(sourceId, rel, basename(rel))]);
  await openCorpusFile(page, basename(rel), 60_000);
  const md = page.locator('.vv-markdown');

  // 图表容器恰等于活围栏数（每围栏一容器，失败围栏也在——svg 才区分成败）
  await expect(md.locator('.md-diagram')).toHaveCount(liveCount);
  await expect(md.locator('.md-diagram-view svg')).toHaveCount(liveCount, { timeout: 60_000 });
  await expect(md.locator('.md-diagram').filter({ has: page.locator('.md-diagram-lang', { hasText: 'mermaid' }) }).first()).toBeVisible();
  // mermaid-example 未注册 → 全部围栏外语言落代码块（含 bash/js/ts 示例）
  expect(await md.locator('pre code').count()).toBeGreaterThanOrEqual(plainCodeCount);

  expect(pageErrors).toEqual([]);
  await expect(page.locator('.vv-error-card')).toHaveCount(0);
});

test('MS 深断言 · mermaid-docs config/accessibility.md：11 围栏全 svg + accTitle 落 svg <title>', async ({
  page
}) => {
  // 语料实有（已读）：11 对 ```mermaid-example（讲解形态）/```mermaid（活图）围栏，
  // 11 个活围栏全部携带 accTitle + accDescr（预检实测 11/11，parse 11/11 通过）。
  // 锚：全量 svg + mermaid 无障碍语义落地——accTitle 渲染为 svg 内 <title> 元素
  // （mermaid a11y 契约），是「图表可及性」这一具体能力的逐文件实证。
  test.setTimeout(300_000);
  const sourceId: SourceId = 'mermaid-docs';
  const rel = 'docs/config/accessibility.md';
  if (!corpusAvailable(sourceId, rel)) {
    test.skip(true, '代表文件不在语料集（manifest 收缩或 fetch 轮未落地）');
    return;
  }
  await mockExternalNoise(page);
  const pageErrors = collectPageErrors(page);
  const liveCount = topLevelFences(corpusText(sourceId, rel)).filter((f) => f.lang === 'mermaid').length;

  await injectDir(page, [corpusSpec(sourceId, rel, basename(rel))]);
  await openCorpusFile(page, basename(rel), 60_000);
  const md = page.locator('.vv-markdown');

  await expect(md.locator('.md-diagram')).toHaveCount(liveCount);
  await expect(md.locator('.md-diagram-view svg')).toHaveCount(liveCount, { timeout: 60_000 });
  // accTitle → svg <title>（11 围栏全带 accTitle，实证见头部）；title 元素不可见，锚 attached
  await expect(md.locator('.md-diagram-view svg title').first()).toBeAttached({ timeout: 30_000 });
  expect(await md.locator('.md-diagram-view svg title').count()).toBeGreaterThanOrEqual(1);

  expect(pageErrors).toEqual([]);
  await expect(page.locator('.vv-error-card')).toHaveCount(0);
});

test('MS 深断言 · katex-docs support_table.md：千行函数表内 990 行内公式排印 + 源码列字面保留', async ({
  page
}) => {
  // 语料实有（已读，52KB）：KaTeX 官方支持表，主体为 |命令|渲染|源码| 三列表，渲染列
  // 单元格内联 $...$（预检 katex@0.19.0 同版本 throwOnError 逐个验证：990 对 979 通过，
  // 失败的 11 个为文档自演示的非法形态如 \begingroup a}）；另有 15 对单元格内 $$ display
  // 块（align/gather/CD/tag 等 env 族文档行，displayMode 验证 15/15 通过）。锚：.katex
  // ≥ 400（实证值的四成，余量抗 markdown 转义改写与节点切分损耗）；公式住单元格
  // （td .katex / td .katex-display）；源码列反引号内同形语法保持字面（MATH_SKIP_TAGS
  // 跳过 CODE，\def 示例不被渲染）。
  test.setTimeout(360_000);
  const sourceId: SourceId = 'katex-docs';
  const rel = 'docs/support_table.md';
  if (!corpusAvailable(sourceId, rel)) {
    test.skip(true, '代表文件不在语料集（manifest 收缩或 fetch 轮未落地）');
    return;
  }
  await mockExternalNoise(page);
  const pageErrors = collectPageErrors(page);

  await injectDir(page, [corpusSpec(sourceId, rel, basename(rel))]);
  await openCorpusFile(page, basename(rel), 90_000);
  const md = page.locator('.vv-markdown');

  await expect
    .poll(() => md.locator('.katex').count(), { timeout: 60_000, message: '等待表格内公式全量排印' })
    .toBeGreaterThanOrEqual(400);
  // 公式在表格单元格内（该文件公式全部住 td）
  await expect(md.locator('td .katex').first()).toBeAttached();
  // 单元格内 display 块（15 对 $$ 全在 td 行内）
  await expect(md.locator('td .katex-display').first()).toBeAttached();
  // 源码列反引号字面保留：\def 示例保持代码形态不被公式化
  await expect(md.locator('code').filter({ hasText: '\\def' }).first()).toBeAttached();
  // ## 分节标题全量（Symbols/Letters/… 运行时实算）
  expect(await md.locator('h2').count()).toBeGreaterThanOrEqual(heading2Count(corpusText(sourceId, rel)));

  expect(pageErrors).toEqual([]);
  await expect(page.locator('.vv-error-card')).toHaveCount(0);
});

test('MS 深断言 · katex-docs supported.md：行内千级公式 + 单元格 display 块 + \\tag 锚定', async ({
  page
}) => {
  // 语料实有（已读，48KB）：分节函数表（行内 $...$ 961 对，预检 947 通过）+ 9 对真实
  // $$ 块（equation+split/align/gather/alignat/CD/subarray/tag/tag* 等，全部位于表格
  // 单元格或独立段）。锚：.katex ≥ 400（实证值四成，管线实算 .katex 总 943）；
  // .katex-display 实证 5——9 对中 4 对（subarray/alignat/CD/substack）内文含 LaTeX 换行
  // \\，CommonMark 反斜杠转义折叠为 \（\3、\@VbVV、\0、'\ ' 未定义控制序列），katex
  // throwOnError 保留原文不产出 display（语义固化单测见 render-text markdownPipeline
  // 「表格 $$ 块内 \\ 转义折叠」；对照 support_table.md 同口径 6/15）；display 块住单元格
  // （td .katex-display）；\tag{hi} 的标签文本可见（katex \tag 产物）。
  test.setTimeout(360_000);
  const sourceId: SourceId = 'katex-docs';
  const rel = 'docs/supported.md';
  if (!corpusAvailable(sourceId, rel)) {
    test.skip(true, '代表文件不在语料集（manifest 收缩或 fetch 轮未落地）');
    return;
  }
  await mockExternalNoise(page);
  const pageErrors = collectPageErrors(page);
  const displayPairs = displayMathPairCount(corpusText(sourceId, rel)); // 实测 9，管线实证渲染 5（见上注释）

  await injectDir(page, [corpusSpec(sourceId, rel, basename(rel))]);
  await openCorpusFile(page, basename(rel), 90_000);
  const md = page.locator('.vv-markdown');

  await expect
    .poll(() => md.locator('.katex').count(), { timeout: 60_000, message: '等待公式全量排印' })
    .toBeGreaterThanOrEqual(400);
  await expect
    .poll(() => md.locator('.katex-display').count(), { timeout: 60_000, message: '等待 display 块全量排印' })
    .toBeGreaterThanOrEqual(Math.min(5, displayPairs));
  // display 数学住在表格单元格（该文件 $$ 块主体在 td 内）
  await expect(md.locator('td .katex-display').first()).toBeAttached();
  // \tag{hi}（L251 独立段）标签文本落 display 产物
  await expect(md.locator('.katex-display', { hasText: 'hi' }).first()).toBeAttached();

  expect(pageErrors).toEqual([]);
  await expect(page.locator('.vv-error-card')).toHaveCount(0);
});

test('MS 深断言 · k8s-docs pods/pod-lifecycle.md：yaml 围栏高亮 + 3 表 + 10 个 h2 + front matter 剥离', async ({
  page
}) => {
  // 语料实有（已读，56KB，钉定 commit 实测下载）：11 个 ```yaml 围栏（Pod/容器状态
  // 清单）、3 张表（phase/condition 表）、10 个 ## 标题（含 1 个 hugo shortcode 标题，
  // 仍为 h2）、front matter（title/content_type/weight/math，其中 math: true 与
  // content_type: concept 逐行核对仅存在于 front matter）。全部下限运行时实算，
  // front matter 锚为逐行核对结果。
  test.setTimeout(240_000);
  const sourceId: SourceId = 'k8s-docs';
  // manifest.files[].path 为仓内相对路径（含 pathPrefix），磁盘即 corpus/k8s-docs/<path>
  const rel = 'content/en/docs/concepts/workloads/pods/pod-lifecycle.md';
  if (!corpusAvailable(sourceId, rel)) {
    test.skip(true, '代表文件不在语料集（k8s-docs 源缺失或 manifest 收缩）');
    return;
  }
  await mockExternalNoise(page);
  const pageErrors = collectPageErrors(page);
  const text = corpusText(sourceId, rel);
  const yamlCount = yamlFenceCount(text); // 实测 11
  const sepCount = tableSeparatorCount(text); // 实测 3
  const h2Count = heading2Count(text); // 实测 10

  await injectDir(page, [corpusSpec(sourceId, rel, basename(rel))]);
  await openCorpusFile(page, basename(rel), 60_000);
  const md = page.locator('.vv-markdown');

  expect(await md.locator('pre code').count()).toBeGreaterThanOrEqual(yamlCount);
  await expect(md.locator('pre code.language-yaml').first()).toBeAttached();
  // yaml 代码块获得语法着色（tree-sitter 命中或 hljs 兜底均产出 span，不锚引擎）
  await expect(md.locator('pre code.language-yaml span').first()).toBeAttached({ timeout: 30_000 });
  await expect(md.locator('.md-code-lang', { hasText: 'yaml' }).first()).toHaveText('yaml');
  // 表格结构：每条分隔行一张表
  expect(await md.locator('table').count()).toBeGreaterThanOrEqual(sepCount);
  // 标题结构全量（含 shortcode 形态标题）
  expect(await md.locator('h2').count()).toBeGreaterThanOrEqual(h2Count);
  // front matter 不泄漏（math: true / content_type: concept 逐行核对仅 front matter 有）
  await expect(md.getByText('math: true')).toHaveCount(0);
  await expect(md.getByText('content_type: concept')).toHaveCount(0);

  expect(pageErrors).toEqual([]);
  await expect(page.locator('.vv-error-card')).toHaveCount(0);
});

test('MS 深断言 · k8s-docs controllers/deployment.md：95 围栏全落代码块 + 列表内缩进围栏 + janetkuo 不泄漏', async ({
  page
}) => {
  // 语料实有（已读，59KB，钉定 commit 实测下载）：95 个顶层围栏（shell 42 + 无语言 50 +
  // yaml 3，运行时实算），其中 72 个为列表项内 3 空格缩进围栏——CommonMark 列表项内
  // 围栏仍落 pre code（含 li 作用域锚）；全部语言不在图表注册表，无一进图表通道。
  // front matter 逐行核对：reviewers 的 - janetkuo 仅存在于 front matter，渲染正文
  // 不得泄漏（MC-29 同口径的 front matter 剥离锚）。11 个 ## 标题。
  test.setTimeout(240_000);
  const sourceId: SourceId = 'k8s-docs';
  const rel = 'content/en/docs/concepts/workloads/controllers/deployment.md';
  if (!corpusAvailable(sourceId, rel)) {
    test.skip(true, '代表文件不在语料集（k8s-docs 源缺失或 manifest 收缩）');
    return;
  }
  await mockExternalNoise(page);
  const pageErrors = collectPageErrors(page);
  const text = corpusText(sourceId, rel);
  const fenceCount = topLevelFences(text).length; // 实测 95
  const h2Count = heading2Count(text); // 实测 11

  await injectDir(page, [corpusSpec(sourceId, rel, basename(rel))]);
  await openCorpusFile(page, basename(rel), 60_000);
  const md = page.locator('.vv-markdown');

  // 全部围栏落 pre code（shell/无语言/yaml 均非图表语言，无通道接管损耗）
  await expect
    .poll(() => md.locator('pre code').count(), { timeout: 30_000, message: '等待代码块全量挂载' })
    .toBeGreaterThanOrEqual(fenceCount);
  // 列表项内缩进围栏（kubectl 命令序列）同样成块
  await expect(md.locator('li pre code').first()).toBeAttached();
  await expect(md.locator('pre code.language-shell').first()).toBeAttached();
  await expect(md.locator('.md-code-lang', { hasText: 'shell' }).first()).toHaveText('shell');
  expect(await md.locator('h2').count()).toBeGreaterThanOrEqual(h2Count);
  // front matter 不泄漏（reviewers 名单仅 front matter 有）
  await expect(md.getByText('janetkuo')).toHaveCount(0);

  expect(pageErrors).toEqual([]);
  await expect(page.locator('.vv-error-card')).toHaveCount(0);
});
