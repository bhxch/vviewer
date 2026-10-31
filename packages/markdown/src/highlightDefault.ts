// highlightDefault.ts — 包内默认围栏高亮器：@vviewer/highlight 的 TreeSitterEngine
// 主线程直驱形态。按 fence 逐块 parse（单块有界，无整文档一次解析），不做
// worker——应用侧有自己的 worker client 时经 options.highlightFence / 模块级
// setHighlightFence 注入覆盖本默认实现（依赖倒置与 render-text attach 注入同构）。
//
// grammar wasm 来源可配置（默认 jsdelivr CDN 的 @bhxch/vviewer-grammars-full），
// 布局契约：`${base}manifest.json` 与 `${base}${file}` 同 base（grammarLayers.ts
// 同款；发布包内 manifest 与 wasm 同目录）。查询资产不在 /grammars/ 目录——发布
// 布局的 queries/ 与 grammars/ 为发布包根下的兄弟目录，默认由 baseUrl 推导
// （/grammars/ → /queries/），可用 options.queriesUrl 显式指定。
//
// 失败降级链保留：引擎初始化失败 / 未知语言 / tree-sitter 解析失败 → 返回 null
// → 管线内 hljs 动态 import 兜底 → hljs 也失败保留原文（与 pipeline.runHighlight
// 既有语义一致）；本实现永不抛错（无取消语义——主线程同步产出，无 tab 竞态）。
import { TreeSitterEngine, assignIntervalsToLines, renderLineHtml, type GrammarTable, type VirtualQueries } from '@vviewer/highlight';
import type { HighlightFence } from './types';

/** 默认 grammar 资产 URL：jsdelivr 的 npm 发布包，/grammars/ 结尾为布局契约。 */
export const DEFAULT_GRAMMARS_BASE_URL =
  'https://cdn.jsdelivr.net/npm/@bhxch/vviewer-grammars-full@0.1.0/grammars/';

/** 默认 web-tree-sitter runtime（tree-sitter.wasm）目录：0.25 系运行时文件名仍为
 * tree-sitter.wasm（0.27 起更名 web-tree-sitter.wasm，见 @vviewer/highlight 注记）。 */
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
 */
export function deriveQueriesBase(baseUrl: string): string {
  return normalizeGrammarsBase(baseUrl).replace(/grammars\/$/, 'queries/');
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
  const base = normalizeGrammarsBase(options.baseUrl ?? DEFAULT_GRAMMARS_BASE_URL);
  let manifest = options.table;
  if (!manifest) {
    const res = await fetch(`${base}manifest.json`);
    // SPA-fallback 防御（core-parse remoteQueryLoader 同款）：200 text/html 兜底视为缺失
    if (!res.ok || (res.headers.get('content-type') ?? '').includes('text/html')) {
      throw new Error(`grammar manifest 加载失败: HTTP ${res.status} ${base}manifest.json`);
    }
    const json = (await res.json()) as { grammars?: GrammarTable };
    if (!json.grammars) throw new Error(`grammar manifest 缺 grammars 字段: ${base}manifest.json`);
    manifest = json.grammars;
  }
  // 条目 base 以资产 URL 前缀覆写（manifest 内 base 字段仅供包独立消费可读，
  // grammarLayers 装配语义同款）；单层来源本实现只支持一份（多层合并属应用侧
  // 资产链职责，宿主需要时自行装配后经 options.table 直传）。
  const table: GrammarTable = {};
  for (const [lang, entry] of Object.entries(manifest)) {
    table[lang] = { ...entry, base };
  }
  return TreeSitterEngine.create({
    grammars: table,
    grammarsBase: base,
    queriesDir: options.queries,
    queriesBase: options.queries ? undefined : (options.queriesUrl ?? deriveQueriesBase(base)),
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
function intervalsToLineHtml(code: string, intervals: import('@vviewer/highlight').HighlightInterval[]): string {
  const lines = buildLineIndex(code);
  const byLine = new Map(
    assignIntervalsToLines(intervals, buildLineOffsets(lines)).map((a) => [a.line, a.segs])
  );
  return lines.map((line, i) => renderLineHtml(line, byLine.get(i))).join('\n');
}
