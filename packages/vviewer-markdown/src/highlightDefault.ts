// highlightDefault.ts — 包内默认围栏高亮器：@bhxch/vviewer-highlight 的 TreeSitterEngine
// 主线程直驱形态。按 fence 逐块 parse（单块有界，无整文档一次解析），不做
// worker——应用侧有自己的 worker client 时经 options.highlightFence / 模块级
// setHighlightFence 注入覆盖本默认实现（依赖倒置与 render-text attach 注入同构）。
//
// grammar wasm 来源可配置（默认 jsdelivr CDN 的 @bhxch/vviewer-grammars-full 拆分子包
// 多基），布局契约：`${base}manifest.json` 与 `${base}${file}` 同 base（grammarLayers.ts
// 同款；发布包内 manifest 与 wasm 同目录）。默认值为 `|` 分隔多基（每基以 /grammars/
// 结尾，逐基即一个拆分子包层，first-wins 合并 + 层失败 warn 跳层）；解析器兼容无分隔符
// 单值（单基=单层，行为与拆包前一致）。查询资产不在 /grammars/ 目录——发布布局的
// queries/ 与 grammars/ 为发布包根下的兄弟目录：单基缺省由 baseUrl 推导（/grammars/ →
// /queries/）；多基时经 queriesBaseResolver 按语言所在子包推导（queries fetch 用引擎级
// 闭包 base、不走 entry.base——非首子包语言必须路由回其所在子包，spec C Task 1 builder
// check 缺口结论），可用 options.queriesUrl 显式指定单值覆盖。
//
// 失败降级链保留：引擎初始化失败 / 未知语言 / tree-sitter 解析失败 → 返回 null
// → 管线内 hljs 动态 import 兜底 → hljs 也失败保留原文（与 pipeline.runHighlight
// 既有语义一致）；本实现永不抛错（无取消语义——主线程同步产出，无 tab 竞态）。
import { TreeSitterEngine, assignIntervalsToLines, renderLineHtml, type GrammarTable, type VirtualQueries } from '@bhxch/vviewer-highlight';
import type { HighlightFence } from './types';

/**
 * grammar 拆分子包的 npm scope 与包名（spec C 拆包面）。
 *
 * 与发布链的单一事实源对齐：release.yml 的 `VV_NPM_PACKAGE_NAME` =
 * `${NPM_SCOPE}/vviewer-grammars-full`（NPM_SCOPE 取仓库变量 vars.NPM_SCOPE，缺省
 * @bhxch）；层数 = release.yml 的 `VV_NPM_PACKAGE_COUNT`（当前 6，fail-fast 校验
 * 以实际装箱结果为准）。二者的漂移由 tools/release-wiring 的门禁单测锁死
 * （跨仓读 workflow 文本比对，评审 critical ① 的「无门禁校准」面已补）。
 */
export const GRAMMAR_PACK_SCOPE = '@bhxch';
export const GRAMMAR_PACK_NAME = `${GRAMMAR_PACK_SCOPE}/vviewer-grammars-full`;
/** 拆分子包层数（p1..pN）——与 release.yml 的 VV_NPM_PACKAGE_COUNT 同值。 */
export const GRAMMAR_PACK_COUNT = 6;

/**
 * 默认 grammar 资产 URL：jsdelivr 拆分子包多基（`|` 分隔，逐基 /grammars/ 结尾——
 * 全量包 228MB 超 jsdelivr 150MB 按包准入 403，拆 p1..pN 每包 ≤50MB 恢复默认全球档可用）。
 *
 * **版本段不钉死**（评审 critical ①）：此前钉死占位版本 `0.0.0-FIRST-TAG`——npm 版本
 * 不可变，该版本永不存在（占位不是可发布版本）→ 6 层 manifest 全 404 → 引擎初始化
 * 异常被 createEngine 外层 catch 吞掉 → 外部消费者静默降级 hljs，且全仓无任何
 * CI/release 门禁校准该版本号（首发 tag 定稿也需改源码，漏改即永久失效）。
 * 改为**不带版本段**（jsdelivr latest 重定向形态，与 apps/web 的 unpkg 档同款既定
 * 形态）：子包一经发布即命中，版本随发布推进自动跟随，无需改源码即不可能指死。
 * 层数漂移（层数 ≠ 实际发布子包数）由 tools/release-wiring 门禁比对 release.yml 的
 * VV_NPM_PACKAGE_COUNT；多余层 404 仅 warn 跳层（无碍），缺层则该层语言缺失。
 */
export const DEFAULT_GRAMMARS_BASE_URL = Array.from(
  { length: GRAMMAR_PACK_COUNT },
  (_, i) => `https://cdn.jsdelivr.net/npm/${GRAMMAR_PACK_NAME}-p${i + 1}/grammars/`
).join('|');

/** 默认 web-tree-sitter runtime（tree-sitter.wasm）目录：0.25 系运行时文件名仍为
 * tree-sitter.wasm（0.27 起更名 web-tree-sitter.wasm，见 @bhxch/vviewer-highlight 注记）。 */
export const DEFAULT_RUNTIME_DIR = 'https://cdn.jsdelivr.net/npm/web-tree-sitter@0.25/';

/**
 * 默认可用语言集（grammar-builder lite 子集的最小保证面）：传入 options.languages
 * 可收窄到本清单。当前发布 grammar 包（自建 34 语言）不含 markdown——markdown
 * 围栏按「未知语言」直接走 hljs 兜底（语法集覆盖随 grammar 包扩充自动生效）。
 */
export const DEFAULT_LITE_LANGUAGES = [
  'javascript', 'typescript', 'tsx', 'bash', 'json', 'css', 'html',
  'python', 'rust', 'markdown', 'yaml'
] as const;

/** 默认高亮器选项（baseUrl/直传表双形态：URL 按需 fetch 或宿主自带资产）。 */
export interface DefaultHighlighterOptions {
  /** grammar manifest 与 wasm 的目录 URL，必须以 /grammars/ 结尾（布局契约）。 */
  baseUrl?: string;
  /** 直传 grammar 清单（自托管/离线形态，跳过 manifest fetch）。 */
  table?: GrammarTable;
  /** 直传查询资产（离线形态；缺省经 queriesUrl 按需 fetch）。 */
  queries?: VirtualQueries;
  /** 查询资产 URL 前缀（目录布局 `<lang>/highlights.scm`、`<lang>/injections.scm`）；缺省由 baseUrl 推导（/grammars/ → /queries/）。 */
  queriesUrl?: string;
  /** web-tree-sitter runtime（tree-sitter.wasm）所在目录；缺省 DEFAULT_RUNTIME_DIR。 */
  runtimeDir?: string;
  /** 语言白名单（小写归一比对）：未列入的语言直接降级 hljs；缺省=按 manifest 全集。 */
  languages?: readonly string[];
}

/**
 * 校验并归一 grammar base：必须以 /grammars/ 结尾（manifest 与 wasm 同目录是发布
 * 布局契约——客户端 manifest URL = `${base}manifest.json`、wasm URL = `${base}${file}`，
 * 不得再插中间段，grammarLayers.ts 的 base 契约同款）。
 */
export function normalizeGrammarsBase(baseUrl: string): string {
  const withSlash = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  if (!withSlash.endsWith('/grammars/')) {
    throw new Error(`grammars baseUrl 必须以 /grammars/ 结尾（manifest 与 wasm 同目录的发布布局契约）: ${baseUrl}`);
  }
  return withSlash;
}

/**
 * 由 grammar base 推导查询资产 base：发布包布局中 queries/ 与 grammars/ 为包根下
 * 兄弟目录（pack-npm.mjs 布局），同版本号替换目录段即得同源查询 URL。
 * 单基语义——多基下的 per-子包推导在 createEngine 内经 queriesBaseResolver 逐语言完成。
 */
export function deriveQueriesBase(baseUrl: string): string {
  return normalizeGrammarsBase(baseUrl).replace(/grammars\/$/, 'queries/');
}

/**
 * 多基解析（spec C 拆包子包）：`|` 分隔 + trim + 逐基 /grammars/ 结尾契约校验
 * （normalizeGrammarsBase 同款）。无分隔符单值 = 单元素数组（单基兼容锚——
 * build:e2e/ci.yml 等大量既有 spec 依赖单基注入，零回归）。无有效基（空串）抛错。
 */
export function parseMultiGrammarsBases(value: string): string[] {
  const bases = value
    .split('|')
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .map(normalizeGrammarsBase);
  if (bases.length === 0) throw new Error(`grammars base 多基解析为空（至少一个以 /grammars/ 结尾的 base）: ${value}`);
  return bases;
}

/**
 * 创建默认 fence 高亮器（HighlightFence 契约）：引擎惰性单例（首次围栏调用才
 * fetch manifest）；初始化失败缓存 null（后续调用恒走 hljs 兜底，不反复重试——
 * 与 render-text attach 失败终态同语义）。
 */
export function createDefaultHighlightFence(options: DefaultHighlighterOptions = {}): HighlightFence {
  const langs = options.languages ? new Set([...options.languages].map((l) => l.toLowerCase())) : null;
  let enginePromise: Promise<TreeSitterEngine | null> | null = null;
  const ensureEngine = (): Promise<TreeSitterEngine | null> => {
    enginePromise ??= createEngine(options).catch((e: unknown) => {
      console.warn('[markdown] 默认 tree-sitter 高亮器初始化失败，围栏高亮降级 hljs：', e);
      return null;
    });
    return enginePromise;
  };
  return async (code: string, lang: string): Promise<string | null> => {
    // 白名单先行短路：白名单外语言不触发引擎初始化（零 manifest/wasm 请求）
    if (langs && !langs.has(lang.toLowerCase())) return null;
    const engine = await ensureEngine();
    if (!engine) return null; // 引擎不可用（初始化失败）：管线内 hljs 兜底
    if (!engine.hasLanguage(lang)) return null; // 未知语言直接走降级（不发起 wasm/查询请求）
    const res = await engine.highlight(code, lang);
    if (!res.ok) return null; // 解析/查询失败：hljs 兜底
    return intervalsToLineHtml(code, res.intervals);
  };
}

async function createEngine(options: DefaultHighlighterOptions): Promise<TreeSitterEngine> {
  const bases = parseMultiGrammarsBases(options.baseUrl ?? DEFAULT_GRAMMARS_BASE_URL);
  const base = bases[0]!;
  const table: GrammarTable = {};
  const baseByLang = new Map<string, string>();
  if (options.table) {
    // 直传表（自托管/离线形态）：保持单源语义——条目 base 统一覆写为首基（单基时首基=
    // 唯一基，与改造前逐字节一致；多基直传为病态组合，wasm/queries 统一按首基解析）
    for (const [lang, entry] of Object.entries(options.table)) {
      table[lang] = { ...entry, base };
    }
  } else {
    // 多基逐层 fetch + first-wins 合并（应用侧 grammarLayers mergeGrammarLayers 同语义
    // 就地实现，不引依赖）：同名语言以先命中层为准；每条目 base 记其所在子包（wasm
    // per-entry 加载 + queries 路由依据）。层失败（非 2xx / 200 text/html SPA fallback /
    // 网络错）仅 warn 跳层，不阻塞其余层；全部层不可用才抛错（引擎初始化失败 → hljs 兜底）
    for (const layerBase of bases) {
      let layerTable: GrammarTable | null = null;
      try {
        const res = await fetch(`${layerBase}manifest.json`);
        // SPA-fallback 防御（core-parse remoteQueryLoader 同款）：200 text/html 兜底视为缺失
        if (!res.ok || (res.headers.get('content-type') ?? '').includes('text/html')) {
          console.warn(`[markdown] grammar manifest HTTP ${res.status}，跳过该子包层: ${layerBase}manifest.json`);
          continue;
        }
        const json = (await res.json()) as { grammars?: GrammarTable };
        layerTable = json.grammars ?? null;
        if (!layerTable) console.warn(`[markdown] grammar manifest 缺 grammars 字段，跳过该子包层: ${layerBase}manifest.json`);
      } catch (e) {
        console.warn(`[markdown] grammar manifest 加载失败，跳过该子包层: ${layerBase}manifest.json`, e);
      }
      if (!layerTable) continue;
      for (const [lang, entry] of Object.entries(layerTable)) {
        if (lang in table) continue; // first-wins：先命中层（更近/更靠前的子包）为准
        table[lang] = { ...entry, base: layerBase };
        baseByLang.set(lang, layerBase);
      }
    }
    if (Object.keys(table).length === 0) {
      throw new Error(
        `grammar manifest 加载失败：全部 ${bases.length} 个子包层不可用（${bases.map((b) => `${b}manifest.json`).join(', ')}）`,
      );
    }
  }
  // queries base 解析：queries 显式直传 → undefined（离线形态）；显式 queriesUrl → 单值
  // （跨子包共享时由宿主自行决定，单值覆盖优先）；多基且无显式 queries 来源 →
  // queriesBaseResolver 按语言所在子包派生 deriveQueriesBase（Task 1 builder check 缺口
  // 改造——非首子包语言从其所在子包取 queries，不再落错误 base 404）；单基 → 单值推导
  // （原语义逐字节不变，resolver 不传）。
  const fallbackQueriesBase = options.queriesUrl ?? deriveQueriesBase(base);
  const useResolver = !options.queries && !options.queriesUrl && bases.length > 1;
  return TreeSitterEngine.create({
    grammars: table,
    grammarsBase: base,
    queriesDir: options.queries,
    queriesBase: options.queries ? undefined : fallbackQueriesBase,
    ...(useResolver
      ? {
          queriesBaseResolver: (lang: string) => deriveQueriesBase(baseByLang.get(lang) ?? base),
        }
      : {}),
    runtimeDir: options.runtimeDir ?? DEFAULT_RUNTIME_DIR
  });
}

// ---------- 区间 → 行 HTML（自 render-text src/code/chunks.ts 迁入最小行表助手） ----------

/** 行表构建（尾 \n 归一，wc -l 口径）：'a\nb\n' → ['a','b']；空文件 '' → []。 */
function buildLineIndex(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  return lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines;
}

/** 行起始偏移（UTF-16，含前序换行符）：'ab\ncd' → [0, 3]。 */
function buildLineOffsets(lines: string[]): number[] {
  const offsets = new Array<number>(lines.length);
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    offsets[i] = offset;
    offset += lines[i]!.length + 1; // +1 换行符
  }
  return offsets;
}

/**
 * 区间 → 行 HTML（fenceToHtml 契约的产物形态）：区间按行分配（内层优先展平）
 * → 行文本 + 段落经 renderLineHtml 生成 span HTML（类名 ts-<capture>，与
 * markdown.css 的 .ts-* 映射段同一来源）。
 */
function intervalsToLineHtml(code: string, intervals: import('@bhxch/vviewer-highlight').HighlightInterval[]): string {
  const lines = buildLineIndex(code);
  const byLine = new Map(
    assignIntervalsToLines(intervals, buildLineOffsets(lines)).map((a) => [a.line, a.segs])
  );
  return lines.map((line, i) => renderLineHtml(line, byLine.get(i))).join('\n');
}
