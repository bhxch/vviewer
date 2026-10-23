import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { injectDir, openTreeFile, type TextFileSpec } from './b-markdown-html-docs-helpers';

/**
 * b-corpus-code-text —— 代码/配置/结构化文本语料批量分派域（HLD/LCD/CJL，2026-10-23 default 套件）。
 *
 * 维度：多源真实开源语料（清单与 sha256 见 e2e/fixtures/corpus/manifest.json，工具轮次
 * 下载至 e2e/fixtures/corpus/<source-id>/<仓库内相对路径>）驱动「分派链 + 代码渲染三层 +
 * jsonl 专有渲染器」的真实世界覆盖——区别于既有 spec 的内联构造夹具（探测链构造场景归
 * b-code-highlight-degrade / t-bin，jsonl 降级构造场景归 b-jsonl-degrade-chain，本组不重复）。
 *
 * 分派链事实（源码锚，写作时已读）：
 * - 扩展名主路由：core detect/extension.ts 提取小写扩展名 → registry.byExtension
 *   （dispatcher.ts:326）。code 渲染器扩展表含 txt/js/json/yaml/yml/toml/csv/xml/rs/py/
 *   java/c/cpp/ts/tsx/go/php/rb/sh 等（render-text code.ts:2513-2519），md 归 markdown
 *   （markdownRenderer.ts:461），jsonl/ndjson 归 JSON Lines 专有渲染器（jsonl/index.ts:950-951）。
 * - 内容探测链仅对「无扩展名/未知扩展名」生效：签名改派 → looksTextual → hex 兜底
 *   （dispatcher.ts:200-258）。hljs-detect 语料实为 test/detect/<语言>/default.txt
 *   （+根 index.js，均带扩展名——ask 前提「无扩展名」已过时，源清单 rationale 已勘误），
 *   故其分派走扩展名表直落 code 渲染器，looksTextual 不在链上；不落 hex 断言仍保留，
 *   作扩展名表×探测链改派回归网（文本样本无 magic 签名，BUG-13 预检不触发）。
 * - 代码高亮语言：detectLanguage（highlight/langdetect.ts:50-61）扩展名精确表优先
 *   （helix languages.json fileTypes，按语言名排序 first-wins），未命中回落首行 shebang。
 *   状态栏「语言: <lang>」＝ getMeta().lang（code.ts:715,1136），与内容无关、由扩展名
 *   决定——本组按扩展名的语言指示锚即据此（内容无关 ⇒ 确定性）。'txt' 不在表内 ⇒
 *   hljs-detect 语料 lang=null → hljsWholeFile(null) → highlightAuto 按内容探测
 *   （code.ts:1070-1072,851-868），「未知语言通道」的产物 span 照常上屏。
 * - jsonl 渲染器：本地注入文件走窗口流式（rangeCapable store，dispatcher.ts:365-392 →
 *   renderJsonlWindowed），状态条「已加载 N 行」→ EOF 后「共 N 行」（jsonl/index.ts:7-9,172）；
 *   pretty >40 行折叠、展开封顶 400 行（jsonl/parse.ts:11-13）。
 *
 * 用例组织（单用例 ≤10 文件级打开；ID 前缀 HLD=hljs-detect / LCD=linguist-samples /
 * CJL=cookbook-jsonl；批量组为域特殊设计要求的 for..of 程序化生成）：
 * - HLD 批量：hljs-detect 全量按 ≤10 文件/例分批，打开 → 渲染容器出现 → 不落 hex/错误卡
 *   → 零 pageerror → console error 白名单外为零（汇总锚按批内嵌，全量语料覆盖）。
 * - HLD 深断言 ×2：偏好序选源码型语言样本，锚状态栏打开方式指示 + 高亮 span 上屏。
 * - LCD 批量：按扩展名分组 ≤10 文件/例，断言分派合理（代码/配置扩展名 → 代码渲染器，
 *   md → markdown 渲染器）；每组首文件锚「语言: <lang>」状态栏指示（内容无关，见上）。
 * - LCD 深断言 ×4：代码类（span+语言）/配置类（容器+语言）/csv（分派实况，见用例注释）/
 *   md（渲染管线就绪）各 1 例，文件取组内最大（真实样本更可能有高亮产出）。
 * - CJL 批量 + 深断言 ×2：jsonl 渲染器接管（状态条行数指示 + 行卡片）+ 折叠→展开交互
 *   （折叠文件由运行时权威解析实证选定，注释写明实证方式）。
 *
 * 注入通道：injectDir（__vvOpenDirImpl + webkitRelativePath，m3/b-md-corpus-markpad 同
 * 口径，纯前端本地管线不依赖服务端）。语料按 readFileSync 原始字节 → base64 注入
 * （TextFileSpec.b64 直通，字节无损）。树内拍平为 bmd/<仓库相对路径 __ 编码>——本组语料
 * basename 大面积重名（hljs-detect 199 个 default.txt 分居语言目录、linguist 按语言子目录
 * 组织），沿用 b-md-corpus-markpad「目录结构不参与契约」前例（其 L30：渲染管线只消费
 * 内容字节），路径编码保唯一且扩展名原样保留 ⇒ 分派语义（扩展名表 + 内容）逐字节等价；
 * 重名 basename 会使树行/标签定位歧义，拍平是确定性前提而非断言放宽。File.type 缺省
 * （helpers 对非 md 给 text/html）：分派链只消费 name+字节（core detect/index.ts:17-28），
 * MIME 不在链上。
 * 容错：manifest.json 不可读 → 单守卫用例跳过；逐用例 fs.existsSync 对清单文件容错 skip。
 * 环境去噪：grammar-CDN（ci.yml:99 注入 VV_GRAMMAR_CDN=cdn.grammars.test）/favicon/kroki
 * route fulfill（b-md-corpus-markpad mockExternalNoise 同款，须先于 goto 注册）。
 */

/** 语料根目录（<source-id>/<仓库内相对路径> 布局，manifest.json 为清单权威） */
const CORPUS_DIR = fileURLToPath(new URL('./fixtures/corpus', import.meta.url));
const MANIFEST_PATH = join(CORPUS_DIR, 'manifest.json');

interface CorpusFile {
  path: string;
  size: number;
  sha256: string;
}

interface CorpusSource {
  id: string;
  repo: string;
  commit: string;
  files: CorpusFile[];
}

interface CorpusManifest {
  generatedAt: string;
  sources: CorpusSource[];
  counts: { total: number; bySource: Record<string, number> };
  failures: Array<{ source: string; path: string; reason: string }>;
}

/** manifest 读取容错：缺失/损坏返回 null（守卫用例 skip，不炸收集） */
function loadManifest(): CorpusManifest | null {
  try {
    return JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8')) as CorpusManifest;
  } catch {
    return null;
  }
}

/** 仓库相对路径 → 注入文件名：'/' 编码为 '__'（保唯一 + 保扩展名，见文件头注入注释） */
function flatName(rel: string): string {
  return rel.split('/').join('__');
}

/** 语料 → 注入规格：原始字节 base64（字节无损；type 缺省见文件头注释） */
function corpusSpec(sourceId: string, rel: string): TextFileSpec {
  const buf = readFileSync(join(CORPUS_DIR, sourceId, rel));
  return { name: flatName(rel), content: '', b64: buf.toString('base64') };
}

/**
 * 扩展名 → 预期状态栏语言（detectLanguage 扩展名精确表，内容无关）。
 * 实证方式：node 直查 packages/highlight/assets/languages.json（fileTypes 排序
 * first-wins，langdetect.ts:27-44 同算法），写作时逐项跑过——yaml/yml→yaml、toml→toml、
 * csv→csv、json→json、xml→xml、rs→rust、py→python、java→java、c→c、cpp→cpp、
 * ts→typescript、tsx→tsx、go→go、php→php、rb→ruby、sh→bash。
 * md 不在表内：markdown 实例 getMeta 无 lang 字段（markdownRenderer.ts:430-433,586），
 * 状态栏无「语言」段，其分派锚改用 .vv-markdown 容器（批量组内 isMd 分支）。
 * 清单出现表外扩展名时该组跳过语言锚（只断容器），不放宽为猜测值。
 */
const EXT_EXPECTED_LANG: Readonly<Record<string, string>> = {
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  csv: 'csv',
  json: 'json',
  xml: 'xml',
  rs: 'rust',
  py: 'python',
  java: 'java',
  c: 'c',
  cpp: 'cpp',
  ts: 'typescript',
  tsx: 'tsx',
  go: 'go',
  php: 'php',
  rb: 'ruby',
  sh: 'bash'
};

/** ≤10 文件/用例的分批（保序切片，顺序即 manifest 顺序——确定性） */
function chunk10<T>(arr: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += 10) out.push(arr.slice(i, i + 10));
  return out;
}

/** pageerror 探针：必须先于 injectDir 内 goto 挂载（应用启动即可能抛） */
function collectPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  return errors;
}

/** 环境去噪 route（b-md-corpus-markpad mockExternalNoise 同款）：须在 goto 前注册。
 *  grammar-CDN 层：门禁构建注入 VV_GRAMMAR_CDN=https://cdn.grammars.test/grammars/
 *  （ci.yml:99），每次页面加载都会发 CDN manifest 请求——fulfill 合法空清单（
 *  b-grammar-spa-fallback GRF-05 同惯例）：语言跳层 hljs 兜底，无资源级错误。
 *  favicon fulfill 204；kroki fulfill svg（本组 md 语料理论上可含 kroki 型围栏，
 *  防御性保留同款遮罩——img 加载成功不产资源级 console error）。 */
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

/**
 * console error 白名单（逐条注明理由；与 b-md-corpus-markpad collectConsoleErrors 同制）：
 * 1. kroki —— 装置层 fulfill 的远端图表服务域：fulfill 边缘（URL 构造、img 解码告警）
 *    属环境无关噪音，非渲染管线缺陷（b-md-diagrams 同域惯例）。
 * 2. Failed to load resource 且 url 为图片资源 —— 语料自带相对图片引用在注入会话中
 *    无宿主文件，产品契约即保留原 src 让浏览器 404 降级（markdownImages.ts L3-4
 *    「404 现状」），属数据缺失而非渲染缺陷。
 * 3. favicon —— vite preview 静态壳资源面，装置层已 fulfill 204，此条为双保险兜底。
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
    errors.push(`${text} @ ${url}`);
  });
  return errors;
}

/** 注入并打开单个语料文件，等待代码渲染容器就绪（.vv-code-pre 挂载即渲染入口已走通） */
async function openCodeCorpus(page: Page, sourceId: string, rel: string): Promise<void> {
  await injectDir(page, [corpusSpec(sourceId, rel)]);
  await openTreeFile(page, flatName(rel));
  await expect(page.locator('.vv-code-pre')).toBeVisible({ timeout: 30_000 });
}

/** jsonl 打开：等 jsonl 容器 + 状态条行数指示 + 首卡实卡（占位卡排除）。
 *  窗口模式「已加载 N 行」/EOF「共 N 行」双口径都算指示存在（jsonl/index.ts:172；本地
 *  小文件 EOF 确认快）——行数下限 [1-9]\d*（排除初始瞬态「已加载 0 行」：块未喂入时
 *  状态条已可采样，提前收敛会让后续断言踩到 lineAvailable=false 的占位卡，
 *  jsonl/index.ts:373-377）；首卡 body 非空 = 实卡非占位的结构性判据。 */
async function waitJsonlReady(page: Page): Promise<void> {
  await expect
    .poll(() => page.locator('.vv-jsonl-status').textContent(), {
      timeout: 20_000,
      message: '等待 jsonl 状态条行数指示出现'
    })
    .toMatch(/^(已加载|共) [1-9]\d* 行$/);
  await expect
    .poll(async () => {
      const t = (await page.locator('.vv-jsonl-card[data-line="0"] .vv-jsonl-body').textContent()) ?? '';
      return t.trim().length;
    }, { timeout: 20_000, message: '等待 jsonl 首卡实卡渲染（body 非占位）' })
    .toBeGreaterThan(0);
}

/** 注入并打开单个 jsonl 语料文件，等待渲染器接管就绪 */
async function openJsonlCorpus(page: Page, sourceId: string, rel: string): Promise<void> {
  await injectDir(page, [corpusSpec(sourceId, rel)]);
  await openTreeFile(page, flatName(rel));
  await expect(page.locator('.vv-jsonl')).toBeVisible({ timeout: 30_000 });
  await waitJsonlReady(page);
}

// ─────────────────────────── 清单装载与守卫 ───────────────────────────

const manifest = loadManifest();

if (manifest === null) {
  test('CORPUS-00 · 语料清单缺失守卫：manifest.json 不可读时整组跳过（对基建轮次容错）', async () => {
    // 契约：基建轮次落地 fixtures/corpus/manifest.json；缺失/损坏不炸收集，跳过待补。
    test.skip(true, '语料清单缺失（fetch 轮未落地），对 manifest 契约容错');
  });
} else {
  const sourceById = (id: string): CorpusSource | undefined =>
    manifest.sources.find((s) => s.id === id);

  // ───────────────────── HLD 域：hljs-detect（扩展名语料 ×193 语言探测样本） ─────────────────────

  const hljs = sourceById('hljs-detect');

  // 批量组：全量清单按 ≤10 文件/例分批（basename 大面积重名 ⇒ 拍平名注入，见文件头）。
  for (const [bi, batch] of chunk10(hljs?.files ?? []).entries()) {
    test(`HLD-${String(bi + 1).padStart(2, '0')} · hljs-detect 批量（${batch.length} 文件）：逐文件打开不崩、渲染容器出现、不落 hex/错误卡`, async ({
      page
    }) => {
      // 稳定性锚（特殊设计：for..of 逐批一例）：.txt/.js 扩展名表直落 code 渲染器
      // （code.ts:2513-2519 含 txt/js；文件头「分派链事实」），文本样本无 magic 签名
      // ⇒ BUG-13 预检不改派。断言红即真实语料触发了改派/渲染降级，交门禁分诊。
      test.setTimeout(240_000);
      const sourceId = 'hljs-detect';
      for (const f of batch) {
        test.skip(!existsSync(join(CORPUS_DIR, sourceId, f.path)), `语料文件缺失：${f.path}`);
      }
      await mockExternalNoise(page);
      const pageErrors = collectPageErrors(page);
      const consoleErrors = collectConsoleErrors(page);

      await injectDir(
        page,
        batch.map((f) => corpusSpec(sourceId, f.path))
      );
      for (const f of batch) {
        await openTreeFile(page, flatName(f.path));
        await expect(page.locator('.vv-code-pre')).toBeVisible({ timeout: 30_000 });
        await expect(page.locator('.vv-hex')).toHaveCount(0);
        await expect(page.locator('.vv-error-card')).toHaveCount(0);
      }

      expect(consoleErrors).toEqual([]);
      expect(pageErrors).toEqual([]);
    });
  }

  // 深断言组：偏好序选「源码型语言」样本（内容为真实源码 ⇒ highlightAuto/tree-sitter
  // 必有高亮产出；plaintext 等纯文本样本可能零 span，不入选）。清单经 cap 120 截取，
  // 具体语言目录在不在以清单为准——全缺席则 skip（对清单构成容错）。
  const HLD_DEEP_PREFS = [/\/python\//, /\/javascript\//, /\/typescript\//, /\/rust\//, /\/go\//, /\/java\//];
  const hldDeepFiles = HLD_DEEP_PREFS.map((p) => hljs?.files.find((f) => p.test(`/${f.path}`))).filter(
    (f): f is CorpusFile => f !== undefined
  );

  for (const [di, f] of hldDeepFiles.slice(0, 2).entries()) {
    test(`HLD-D${di + 1} · hljs-detect 深断言 ${f.path}：打开方式指示 + 高亮 span 上屏（未知语言通道）`, async ({
      page
    }) => {
      // .txt 不在语言表 ⇒ lang=null → highlightAuto 按内容探测（code.ts:1070-1072），
      // 源码样本必产着色 span；锚「打开方式: 代码/文本 + （txt）」分派指示（detLabel
      // = res.det.ext 无点，ViewerPane.svelte:347-348）与 span 下限，不锚引擎种类
      // （tree-sitter/hljs 兜底均产出 span，与 MC-28 判据同口径）。
      test.setTimeout(120_000);
      test.skip(!existsSync(join(CORPUS_DIR, 'hljs-detect', f.path)), `语料文件缺失：${f.path}`);
      await mockExternalNoise(page);
      const pageErrors = collectPageErrors(page);
      await openCodeCorpus(page, 'hljs-detect', f.path);

      await expect(page.locator('.vv-statusbar')).toContainText('打开方式: 代码/文本', {
        timeout: 20_000
      });
      await expect(page.locator('.vv-statusbar')).toContainText('（txt）');
      await expect(page.locator('.vv-code-pre .vv-code-body span').first()).toBeVisible({
        timeout: 30_000
      });

      expect(pageErrors).toEqual([]);
      await expect(page.locator('.vv-error-card')).toHaveCount(0);
      await expect(page.locator('.vv-hex')).toHaveCount(0);
    });
  }

  // ───────────────────── LCD 域：linguist-samples（按扩展名分派语料） ─────────────────────

  const linguist = sourceById('linguist-samples');

  /** 清单文件按扩展名分组（小写；保清单序）。 */
  function groupByExt(files: readonly CorpusFile[]): Map<string, CorpusFile[]> {
    const groups = new Map<string, CorpusFile[]>();
    for (const f of files) {
      const ext = f.path.slice(f.path.lastIndexOf('.') + 1).toLowerCase();
      const list = groups.get(ext) ?? [];
      list.push(f);
      groups.set(ext, list);
    }
    return groups;
  }

  const lcdGroups = [...groupByExt(linguist?.files ?? []).entries()].sort(([a], [b]) => (a < b ? -1 : 1));

  // 批量组：每扩展名一组，组内 ≤10 文件/例；组首文件锚「语言: <lang>」状态栏指示
  // （扩展名决定、内容无关 ⇒ 确定性，见文件头「分派链事实」）。
  for (const [ext, files] of lcdGroups) {
    for (const [bi, batch] of chunk10(files).entries()) {
      const isMd = ext === 'md';
      const expectedLang = EXT_EXPECTED_LANG[ext];
      test(`LCD-${ext}${bi > 0 ? `-${bi + 1}` : ''} · linguist ${ext} 批量（${batch.length} 文件）：${isMd ? 'markdown 渲染器接管' : '代码渲染器接管'}、语言指示在位、不落 hex/错误卡`, async ({
        page
      }) => {
        // 分派锚（实现实况）：代码/配置扩展名在 code 渲染器扩展表（code.ts:2513-2519
        // 含 yaml/yml/toml/csv/json/xml/rs/py/java/c/cpp/ts/tsx/go/php/rb/sh），md 归
        // markdownRenderer（markdownRenderer.ts:461）。csv 的「代码渲染器」承引同一行
        // 扩展表——非猜测，registry 注册实况如此。组首文件再锚语言指示（表外扩展名
        // 跳过语言锚只断容器，不猜值）。
        test.setTimeout(240_000);
        const sourceId = 'linguist-samples';
        for (const f of batch) {
          test.skip(!existsSync(join(CORPUS_DIR, sourceId, f.path)), `语料文件缺失：${f.path}`);
        }
        await mockExternalNoise(page);
        const pageErrors = collectPageErrors(page);
        const consoleErrors = collectConsoleErrors(page);

        await injectDir(
          page,
          batch.map((f) => corpusSpec(sourceId, f.path))
        );
        for (const [i, f] of batch.entries()) {
          await openTreeFile(page, flatName(f.path));
          if (isMd) {
            await expect(page.locator('.vv-markdown')).toBeVisible({ timeout: 30_000 });
          } else {
            await expect(page.locator('.vv-code-pre')).toBeVisible({ timeout: 30_000 });
          }
          if (i === 0 && expectedLang !== undefined && !isMd) {
            await expect(page.locator('.vv-statusbar')).toContainText(`语言: ${expectedLang}`, {
              timeout: 20_000
            });
          }
          await expect(page.locator('.vv-error-card')).toHaveCount(0);
          await expect(page.locator('.vv-hex')).toHaveCount(0);
        }

        expect(consoleErrors).toEqual([]);
        expect(pageErrors).toEqual([]);
      });
    }
  }

  /** 组内最大文件（size 来自 manifest sha 权威；并列取清单序首个——确定性）。 */
  function largestOf(files: readonly CorpusFile[]): CorpusFile | undefined {
    return files.reduce<CorpusFile | undefined>(
      (max, f) => (max === undefined || f.size > max.size ? f : max),
      undefined
    );
  }

  // 深断言 ×1 代码类：偏好 py/rs/go，取组内最大文件——真实源码样本，tree-sitter
  // 命中或 hljs 兜底均产出 span（「获得语法着色」不锚引擎，MC-28 判据同口径）。
  const codeDeepExt = ['py', 'rs', 'go'].find((e) => (linguist?.files ?? []).some((f) => f.path.toLowerCase().endsWith(`.${e}`)));
  const codeDeep = codeDeepExt !== undefined ? largestOf((linguist?.files ?? []).filter((f) => f.path.toLowerCase().endsWith(`.${codeDeepExt}`))) : undefined;
  if (codeDeep !== undefined && codeDeepExt !== undefined) {
    test(`LCD-D1 · linguist 深断言代码类（.${codeDeepExt} 最大样本 ${codeDeep.path}）：语法着色 span + 状态栏语言指示`, async ({
      page
    }) => {
      test.setTimeout(120_000);
      test.skip(!existsSync(join(CORPUS_DIR, 'linguist-samples', codeDeep.path)), `语料文件缺失：${codeDeep.path}`);
      await mockExternalNoise(page);
      const pageErrors = collectPageErrors(page);
      await openCodeCorpus(page, 'linguist-samples', codeDeep.path);

      await expect(page.locator('.vv-code-pre .vv-code-body span').first()).toBeVisible({
        timeout: 30_000
      });
      await expect(page.locator('.vv-statusbar')).toContainText(`语言: ${EXT_EXPECTED_LANG[codeDeepExt]}`, {
        timeout: 20_000
      });

      expect(pageErrors).toEqual([]);
      await expect(page.locator('.vv-error-card')).toHaveCount(0);
      await expect(page.locator('.vv-hex')).toHaveCount(0);
    });
  }

  // 深断言 ×2 配置类：偏好 yaml/toml——语言指示为主锚（扩展名表决定），容器为分派锚；
  // 不锚 span（配置样本键值稀疏时着色产出不保证下限，避免内容敏感的脆弱断言）。
  const cfgDeepExt = ['yaml', 'toml'].find((e) => (linguist?.files ?? []).some((f) => f.path.toLowerCase().endsWith(`.${e}`)));
  const cfgDeep = cfgDeepExt !== undefined ? largestOf((linguist?.files ?? []).filter((f) => f.path.toLowerCase().endsWith(`.${cfgDeepExt}`))) : undefined;
  if (cfgDeep !== undefined && cfgDeepExt !== undefined) {
    test(`LCD-D2 · linguist 深断言配置类（.${cfgDeepExt} 最大样本 ${cfgDeep.path}）：代码渲染器接管 + 状态栏语言指示`, async ({
      page
    }) => {
      test.setTimeout(120_000);
      test.skip(!existsSync(join(CORPUS_DIR, 'linguist-samples', cfgDeep.path)), `语料文件缺失：${cfgDeep.path}`);
      await mockExternalNoise(page);
      const pageErrors = collectPageErrors(page);
      await openCodeCorpus(page, 'linguist-samples', cfgDeep.path);

      await expect(page.locator('.vv-statusbar')).toContainText(`语言: ${EXT_EXPECTED_LANG[cfgDeepExt]}`, {
        timeout: 20_000
      });

      expect(pageErrors).toEqual([]);
      await expect(page.locator('.vv-error-card')).toHaveCount(0);
      await expect(page.locator('.vv-hex')).toHaveCount(0);
    });
  }

  // 深断言 ×3 csv：csv 在 code 渲染器扩展表（code.ts:2514）⇒ 代码渲染器接管 + 语言
  // 指示 csv（languages.json 有 csv 条目，写作时实证）；不锚 span（csv 纯数据行经
  // highlightAuto 常无着色产出——无语言可探，注释即依据，不放宽不硬锚）。
  const csvDeep = largestOf((linguist?.files ?? []).filter((f) => f.path.toLowerCase().endsWith('.csv')));
  if (csvDeep !== undefined) {
    test(`LCD-D3 · linguist 深断言 csv（最大样本 ${csvDeep.path}）：代码渲染器接管（扩展表实况）+ 语言指示`, async ({
      page
    }) => {
      test.setTimeout(120_000);
      test.skip(!existsSync(join(CORPUS_DIR, 'linguist-samples', csvDeep.path)), `语料文件缺失：${csvDeep.path}`);
      await mockExternalNoise(page);
      const pageErrors = collectPageErrors(page);
      await openCodeCorpus(page, 'linguist-samples', csvDeep.path);

      await expect(page.locator('.vv-statusbar')).toContainText('打开方式: 代码/文本', {
        timeout: 20_000
      });
      await expect(page.locator('.vv-statusbar')).toContainText('（csv）');
      await expect(page.locator('.vv-statusbar')).toContainText('语言: csv', { timeout: 20_000 });

      expect(pageErrors).toEqual([]);
      await expect(page.locator('.vv-error-card')).toHaveCount(0);
      await expect(page.locator('.vv-hex')).toHaveCount(0);
    });
  }

  // 深断言 ×4 md：markdown 渲染器接管 + 管线就绪（.vv-markdown 可见 = 五步管线
  // await 完成后挂载，b-md-corpus-markpad openCorpus 同判据）+ 本地引擎指示。
  const mdDeep = largestOf((linguist?.files ?? []).filter((f) => f.path.toLowerCase().endsWith('.md')));
  if (mdDeep !== undefined) {
    test(`LCD-D4 · linguist 深断言 md（最大样本 ${mdDeep.path}）：markdown 渲染器接管 + 渲染管线就绪`, async ({
      page
    }) => {
      test.setTimeout(120_000);
      test.skip(!existsSync(join(CORPUS_DIR, 'linguist-samples', mdDeep.path)), `语料文件缺失：${mdDeep.path}`);
      await mockExternalNoise(page);
      const pageErrors = collectPageErrors(page);
      await injectDir(page, [corpusSpec('linguist-samples', mdDeep.path)]);
      await openTreeFile(page, flatName(mdDeep.path));
      await expect(page.locator('.vv-markdown')).toBeVisible({ timeout: 30_000 });
      await expect(page.locator('.vv-statusbar')).toContainText('渲染: 本地', { timeout: 30_000 });

      expect(pageErrors).toEqual([]);
      await expect(page.locator('.vv-error-card')).toHaveCount(0);
      await expect(page.locator('.vv-hex')).toHaveCount(0);
    });
  }

  // ───────────────────── CJL 域：jsonl 源（若清单中有——跨源动态发现 .jsonl） ─────────────────────

  const jsonlEntries = manifest.sources.flatMap((s) =>
    s.files
      .filter((f) => f.path.toLowerCase().endsWith('.jsonl'))
      .map((f) => ({ source: s, file: f }))
  );

  // 批量组：每源 ≤10 文件/例（cookbook-jsonl 5 文件 ⇒ 1 例）。
  const jsonlBySource = new Map<string, Array<{ source: CorpusSource; file: CorpusFile }>>();
  for (const e of jsonlEntries) {
    const list = jsonlBySource.get(e.source.id) ?? [];
    list.push(e);
    jsonlBySource.set(e.source.id, list);
  }
  for (const [sourceId, entries] of jsonlBySource) {
    for (const [bi, batch] of chunk10(entries).entries()) {
      test(`CJL-${sourceId}${bi > 0 ? `-${bi + 1}` : ''} · jsonl 批量（${batch.length} 文件）：jsonl 渲染器接管、行数指示在位、行卡片出现`, async ({
        page
      }) => {
        // 窗口流式（rangeCapable 本地 store）：状态条「已加载 N 行」/EOF「共 N 行」
        // 双口径都算指示存在；逐文件断言容器 + 指示 + 首卡可见，不锚行数精确值
        // （上轮 MC-28 教训：结构/下限锚，行数是通道产物非契约）。
        test.setTimeout(240_000);
        for (const e of batch) {
          test.skip(!existsSync(join(CORPUS_DIR, e.source.id, e.file.path)), `语料文件缺失：${e.file.path}`);
        }
        await mockExternalNoise(page);
        const pageErrors = collectPageErrors(page);
        const consoleErrors = collectConsoleErrors(page);

        await injectDir(
          page,
          batch.map((e) => corpusSpec(e.source.id, e.file.path))
        );
        for (const e of batch) {
          await openTreeFile(page, flatName(e.file.path));
          await expect(page.locator('.vv-jsonl')).toBeVisible({ timeout: 30_000 });
          await waitJsonlReady(page);
          await expect(page.locator('.vv-error-card')).toHaveCount(0);
          await expect(page.locator('.vv-hex')).toHaveCount(0);
        }
        // 末文件在位时锚渲染器指示（打开方式指示 = registry label，ViewerPane.svelte:347）
        await expect(page.locator('.vv-statusbar')).toContainText('打开方式: JSON Lines', {
          timeout: 20_000
        });

        expect(consoleErrors).toEqual([]);
        expect(pageErrors).toEqual([]);
      });
    }
  }

  // 深断言 ×1 接管结构：最大 jsonl——行卡片结构（gutter 行号 + body 非空）+ 渲染器
  // 指示 + 分派面（不落 code/hex：jsonl 扩展名注册先于生成物 fallback，viewer.ts:50-52）。
  const jsonlLargest = jsonlEntries.reduce<{ source: CorpusSource; file: CorpusFile } | undefined>(
    (max, e) => (max === undefined || e.file.size > max.file.size ? e : max),
    undefined
  );
  if (jsonlLargest !== undefined) {
    test(`CJL-D1 · jsonl 深断言接管结构（最大样本 ${jsonlLargest.file.path}）：行卡片结构 + 打开方式指示`, async ({
      page
    }) => {
      test.setTimeout(120_000);
      test.skip(
        !existsSync(join(CORPUS_DIR, jsonlLargest.source.id, jsonlLargest.file.path)),
        `语料文件缺失：${jsonlLargest.file.path}`
      );
      await mockExternalNoise(page);
      const pageErrors = collectPageErrors(page);
      await openJsonlCorpus(page, jsonlLargest.source.id, jsonlLargest.file.path);

      const firstCard = page.locator('.vv-jsonl-card[data-line="0"]');
      await expect(firstCard.locator('.vv-jsonl-gutter')).toHaveText('1', { timeout: 20_000 });
      const bodyText = (await firstCard.locator('.vv-jsonl-body').textContent()) ?? '';
      expect(bodyText.trim().length, '首卡 body 应有真实行文本（非占位）').toBeGreaterThan(0);
      await expect(page.locator('.vv-statusbar')).toContainText('打开方式: JSON Lines', {
        timeout: 20_000
      });
      await expect(page.locator('.vv-code-pre')).toHaveCount(0); // 未被 code 委托接管

      expect(pageErrors).toEqual([]);
      await expect(page.locator('.vv-error-card')).toHaveCount(0);
    });
  }

  // 深断言 ×2 折叠→展开：折叠文件由运行时权威解析实证选定——Node 侧镜像
  // jsonl/parse.ts:52-72 同算法（JSON.parse → JSON.stringify(v,null,2)，行数按
  // 「每行以换行符收尾」计），取「首行 40<prettyLines≤400（折叠初始态必挂展开钮，
  // 且展开非封顶态）」的清单序首个文件；无合格文件则 skip。展开后行数精确锚即该
  // 权威解析值（内容由 manifest sha256 锚定，非脆断）。
  function prettyLinesOf(raw: string): number | null {
    try {
      const pretty = JSON.stringify(JSON.parse(raw) as unknown, null, 2);
      return (pretty + '\n').split('\n').length;
    } catch {
      return null; // failed 行不参与折叠（parse.ts 三态）
    }
  }
  const foldEntry = jsonlEntries.find((e) => {
    const abs = join(CORPUS_DIR, e.source.id, e.file.path);
    if (!existsSync(abs)) return false;
    const firstRow = readFileSync(abs, 'utf-8').split('\n').find((l) => l.trim() !== '');
    if (firstRow === undefined) return false;
    const lines = prettyLinesOf(firstRow);
    return lines !== null && lines > 40 && lines <= 400; // >40 折叠（parse.ts:11）、≤400 非封顶（parse.ts:13）
  });
  if (foldEntry !== undefined) {
    const abs = join(CORPUS_DIR, foldEntry.source.id, foldEntry.file.path);
    const firstRow = readFileSync(abs, 'utf-8').split('\n').find((l) => l.trim() !== '') ?? '';
    const expectedBodyLines = JSON.stringify(JSON.parse(firstRow) as unknown, null, 2).split('\n').length;
    test(`CJL-D2 · jsonl 深断言折叠→展开（${foldEntry.file.path} 首行 pretty ${expectedBodyLines} 行）：折叠初始态 + 展开全显`, async ({
      page
    }) => {
      // 折叠初始态恒 40 行可见 + 「展开全部」钮（jsonl/index.ts:395-433）；点击后该卡
      // 重渲为全显（expandedRows 集合），body 行数收敧行到权威解析值（上文实证口径），
      // 展开钮消失。非封顶样本（本组语料实证 maxPretty 351 ≤ 400）无「已截断显示」cap。
      test.setTimeout(120_000);
      test.skip(
        !existsSync(join(CORPUS_DIR, foldEntry.source.id, foldEntry.file.path)),
        `语料文件缺失：${foldEntry.file.path}`
      );
      await mockExternalNoise(page);
      const pageErrors = collectPageErrors(page);
      await openJsonlCorpus(page, foldEntry.source.id, foldEntry.file.path);

      const firstCard = page.locator('.vv-jsonl-card[data-line="0"]');
      await expect(firstCard).toBeVisible();
      const expandBtn = firstCard.locator('.vv-jsonl-expand');
      await expect(expandBtn).toBeVisible({ timeout: 20_000 });
      // 折叠初始态：body 恰 40 行可见（JSONL_COLLAPSE_LINES）
      const collapsedText = (await firstCard.locator('.vv-jsonl-body').textContent()) ?? '';
      expect(collapsedText.split('\n').length, '折叠初始态应恰 40 行可见').toBe(40);

      await expandBtn.click();
      await expect(expandBtn).toHaveCount(0, { timeout: 20_000 }); // 展开后重渲：钮消失
      await expect
        .poll(
          () => firstCard.locator('.vv-jsonl-body').textContent().then((t) => (t ?? '').split('\n').length),
          { timeout: 20_000, message: '等待展开后 body 全显' }
        )
        .toBe(expectedBodyLines);

      expect(pageErrors).toEqual([]);
      await expect(page.locator('.vv-error-card')).toHaveCount(0);
    });
  }
}
