import { Parser, Language, Query, type Tree } from 'web-tree-sitter';
import { expandQuery, expandQueryAsync, type AsyncQuerySource, type ExpandedQuery, type QueryAssets, type QueryFile } from './queries';
import type { HighlightChunk, HighlightInterval } from './types';

/**
 * 浏览器可打包：本模块零顶层 node 内建 import。
 * fs 仅在传入目录字符串路径（Node 场景）时经变量化动态 import 惰性加载；
 * 浏览器端应传 VirtualQueries（查询）与 grammars（grammar 清单）。
 */

/** 虚拟查询来源：与目录布局同形的映射（lang → 查询文件），供浏览器端打包使用。 */
export type VirtualQueries = Map<string, QueryFile> | Record<string, QueryFile>;

/**
 * grammar 清单：与 apps/web/static/grammars/manifest.json 的 grammars 字段同形。
 * `base` 为该条目 wasm 的目录 URL/路径前缀（资产三层解析链逐条注记来源），
 * 缺省回落 grammarsBase——Task 2/3 的消费契约。
 */
export type GrammarTable = Record<string, { file: string; aliases?: string[]; base?: string }>;

/** highlight 的结果：成功带全量区间（调用方负责去重叠渲染），失败带错误信息。 */
export type HighlightResult =
  | { ok: true; intervals: HighlightInterval[] }
  | { ok: false; error: string };

/**
 * init 阶段打点（Task 9 spike 取证面）：阶段序 wasm-fetch → parser-init → assets → ready。
 * query-loaded 为 query 资产逐文件帧（Task 4 细口径，debug 链路经 onQueryLoaded 折算）：
 * 随首次 highlight 的远程 fetch 完成、时序在 ready 之后，帧缺席 = 该文件请求悬挂。
 */
export interface EngineInitProgress {
  stage: 'wasm-fetch' | 'parser-init' | 'assets' | 'ready' | 'query-loaded';
  detail?: string;
}

export interface EngineOptions {
  /** 查询来源：assets/queries 目录路径（Node，自动扫描子目录）或虚拟映射。 */
  queriesDir?: string | VirtualQueries;
  /** 查询按需加载基础 URL（如 '/queries/'，目录布局同 assets/queries）——Worker 端 fetch 加载；queriesDir/queries 未给时生效。 */
  queriesBase?: string;
  /** grammar wasm 目录（含 manifest.json），Node 文件系统路径。 */
  grammarsDir?: string;
  /** 直接给 grammar 清单（浏览器端跳过 manifest 读取）。 */
  grammars?: GrammarTable;
  /** grammar wasm 加载基础路径，默认 grammarsDir。 */
  grammarsBase?: string;
  /** web-tree-sitter runtime（tree-sitter.wasm）所在目录/URL 前缀，默认 grammarsBase。 */
  runtimeDir?: string;
  /**
   * 远程 query 资产逐文件打点（Task 4 细口径，debug 取证面）：queriesBase 惰性加载形态下，
   * 每份查询文件 fetch 完成上报一次，file 形态 `${lang}/${file}`（如 'bash/highlights.scm'，
   * 与 queriesBase 下目录布局一致）。语义是「fetch 已完成」而非「内容可用」——404/SPA 兜底
   * 缺失/网络失败同样出帧，帧缺席才是悬挂信号。仅 queriesBase 形态生效；queriesDir/虚拟
   * 映射零回调（帧天然缺席）。缺省不传即零打点零开销：线上仅 debug 握手经 initWorker 注入。
   */
  onQueryLoaded?: (file: string) => void;
  /** 注入递归最大深度，默认 3。 */
  maxInjectionDepth?: number;
}

/** 单语言就绪后的查询资产（惰性编译，随 engine 生命周期缓存）。 */
interface PreparedLanguage {
  language: Language;
  highlights: Query | null;
  injections: Query | null;
}

/** Node fs 的最小结构类型（避免依赖 @types/node；运行时经变量化动态 import 获取）。 */
interface FsLike {
  existsSync(path: string): boolean;
  readFileSync(path: string, encoding: 'utf8'): string;
  readdirSync(path: string, options: { withFileTypes: true }): Array<{ name: string; isDirectory(): boolean }>;
}

let fsPromise: Promise<FsLike> | null = null;

/** 惰性加载 node:fs：变量化 import 路径避免打包器静态解析，仅 Node 分支被触发时调用。 */
async function getFs(): Promise<FsLike> {
  if (!fsPromise) {
    const spec = 'node:fs';
    fsPromise = import(/* @vite-ignore */ spec) as Promise<FsLike>;
  }
  return fsPromise;
}

/** POSIX 路径/URL 拼接（Node 与浏览器通用，不依赖 node:path）。 */
function joinPath(base: string, name: string): string {
  return base === '' ? name : `${base.replace(/\/+$/, '')}/${name}`;
}

/**
 * 单次查询执行的 wasm 侧时间预算（μs）：病态查询（如根级无锚兄弟 pattern 触发
 * O(n²) 兄弟配对扫描）的护栏——超预算时 web-tree-sitter 提前停止执行，不至挂起 worker。
 * 注意 0.25 的 timeoutMicros 语义是"丢弃已收集结果、返回空数组"，并非部分结果；
 * 因此"空区间 + 耗尽预算"由 highlight() 显式转为失败，以接通调用方的 hljs 兜底。
 * 预算随文本长度线性放宽（20μs/字符），下限 50ms、上限 3s；
 * 实测合法 5MB typescript captures 约 0.6s，余量充足。
 */
function queryBudget(text: string): number {
  return Math.min(3_000_000, Math.max(50_000, text.length * 20));
}

/** web-tree-sitter runtime 的 wasm 文件名（Parser.init 经 locateFile 于 runtimeDir 下取用）。 */
const RUNTIME_WASM_FILE = 'tree-sitter.wasm';

/**
 * wasm 加载 resource timing 明细（Task 4 细口径，debug 取证面）：读 performance resource
 * 条目过滤 runtime wasm，取 name/duration/transferSize——定位 init 挂起时区分「fetch 慢」
 * 与「fetch 完成但 Parser.init 内部挂」。只读既有 buffer 不二次 fetch；worker 上下文的
 * resource buffer 独立，读到的即 worker 自己那次 fetch。字段缺失容错：transferSize 跨源
 * 无 Timing-Allow-Origin 或缓存命中时为 0，照实上报不推断；查不到条目（buffer 清空/
 * 极端环境/jsdom 无此 API）返回 undefined——detail 省略、帧仍发。
 */
function runtimeWasmDetail(): string | undefined {
  const perf = performance as {
    getEntriesByType?: (type: string) => Array<{ name: string; duration?: number; transferSize?: number }>;
  };
  const entry = perf.getEntriesByType?.('resource')?.find((e) => e.name.includes(RUNTIME_WASM_FILE));
  if (!entry) return undefined;
  const parts = [`name=${entry.name}`];
  if (typeof entry.duration === 'number') parts.push(`duration=${Math.round(entry.duration * 100) / 100}ms`);
  if (typeof entry.transferSize === 'number') parts.push(`transfer=${entry.transferSize}B`);
  return parts.join(' ');
}

/** debug 帧的 detail 条件化（deferred 卫生）：无 detail 不产生 detail 键。 */
function optDetail(detail: string | undefined): { detail?: string } {
  return detail !== undefined ? { detail } : {};
}

let initPromise: Promise<void> | null = null;

/**
 * tree-sitter 解析引擎：语言加载与查询编译缓存、区间生成、injection 递归。
 * 纯逻辑，不依赖 Worker API——Worker（worker.ts）与测试直调本类。
 */
export class TreeSitterEngine {
  private readonly parser: Parser;
  private readonly assets: QueryAssets;
  private readonly remoteQueries: AsyncQuerySource | null;
  private readonly grammarTable: GrammarTable;
  private readonly grammarsBase: string;
  private readonly aliasToLang: Map<string, string>;
  private readonly maxInjectionDepth: number;
  /** 按规范语言名键控的缓存（别名请求复用同一份加载结果）。 */
  private readonly prepared = new Map<string, Promise<PreparedLanguage | null>>();
  /** 已告警过"不可用注入语言"（每语言仅告警一次，避免逐注释刷屏）。 */
  private readonly warnedInjections = new Set<string>();

  private constructor(assets: QueryAssets, grammarTable: GrammarTable, opts: EngineOptions) {
    this.assets = assets;
    this.remoteQueries = opts.queriesBase ? remoteQueryLoader(opts.queriesBase, opts.onQueryLoaded) : null;
    this.grammarTable = grammarTable;
    this.grammarsBase = opts.grammarsBase ?? opts.grammarsDir ?? '';
    this.aliasToLang = buildAliasTable(grammarTable);
    this.maxInjectionDepth = opts.maxInjectionDepth ?? 3;
    this.parser = new Parser();
  }

  /**
   * 初始化 runtime（Parser.init 幂等，失败可重试）并构建引擎。
   * onInitProgress（可选，Task 9 spike 取证面）：init 各阶段打点回调，仅用于定位
   * init 静默挂起（如 wasm fetch 不归）——缺省不传即零打点零开销，行为与既有签名一致
   * （可选调用的短路语义保证 report 缺位时 runtimeWasmDetail 不执行）。
   * assets 打点位于两形态（grammars 直传表 / grammarsDir readManifest）合流、queries 就绪后，
   * 两形态均被覆盖。detail 的 queries=N 为静态资产映射大小：Node 目录扫描/虚拟映射如实计数；
   * 浏览器端走 queriesBase 惰性按语言 fetch（assets 映射恒空），此处恒为 queries=0 非异常。
   * Task 4 细口径：parser-init/ready 帧附 wasm resource timing（runtimeWasmDetail，
   * 查不到条目时 detail 省略、帧仍发）；query 逐文件打点经 onQueryLoaded 透传
   * remoteQueryLoader，折算为 query-loaded 帧（仅 queriesBase 形态，见字段注）。
   */
  static async create(
    opts: EngineOptions & { onInitProgress?: (p: EngineInitProgress) => void }
  ): Promise<TreeSitterEngine> {
    const report = opts.onInitProgress;
    const runtimeDir = opts.runtimeDir ?? opts.grammarsBase ?? opts.grammarsDir ?? '';
    report?.({ stage: 'wasm-fetch', detail: `runtimeDir=${runtimeDir}` });
    if (!initPromise) {
      initPromise = Parser.init({ locateFile: (file: string) => joinPath(runtimeDir, file) }).catch((e) => {
        initPromise = null; // 失败可重试（下次 create 用正确的 runtimeDir）
        throw e;
      });
    }
    await initPromise;
    report?.({ stage: 'parser-init', ...optDetail(runtimeWasmDetail()) });

    let grammarTable = opts.grammars;
    if (!grammarTable) {
      if (!opts.grammarsDir) throw new Error('需要 grammarsDir 或 grammars 选项');
      grammarTable = await readManifest(opts.grammarsDir);
    }
    const assets: QueryAssets =
      typeof opts.queriesDir === 'string'
        ? await loadQueriesFromDir(opts.queriesDir)
        : opts.queriesDir === undefined
          ? new Map<never, never>()
          : normalizeVirtualQueries(opts.queriesDir);
    report?.({ stage: 'assets', detail: `queries=${assets.size ?? 0}` });
    const engine = new TreeSitterEngine(assets, grammarTable, opts);
    // ready 帧同补 wasm timing（Task 4 细口径）：条目若在 parser-init 时点尚未入 buffer，
    // 此处兜底再读一次——两帧独立取值，取到即附
    report?.({ stage: 'ready', ...optDetail(runtimeWasmDetail()) });
    return engine;
  }

  /**
   * 高亮文本：展开查询 → 加载语言（缓存）→ 编译查询（缓存）→ 解析 → 区间 → 注入递归。
   * 区间按 (start asc, end desc) 排序，不去重叠（渲染端按"内层优先"展平——嵌套区间内层可见）。
   * depth 为当前注入深度；depth ≥ maxInjectionDepth 不再递归注入。
   * lang 可传 manifest 别名（js/sh/py 等），内部先规范化为清单键名。
   *
   * chunk（可选）为子文本窗口语义标注（spec §5.1 子文本 parse 裁决），**不改变任何行为**：
   * chunk 模式下调用方已把可视区窗口子文本作为 text 传入——engine 不感知行号、不做切分
   * （不引入 includedRanges）；queryBudget(text) 按子文本长度计（预算天然不放大，无需
   * 整文本口径）；返回区间相对子文本，行号平移由调用侧（渲染层）负责。保留形参仅使
   * client → worker → engine 链路显式携带窗口语义（自文档化），实现零分支。
   */
  async highlight(text: string, lang: string, depth = 0, chunk?: HighlightChunk): Promise<HighlightResult> {
    try {
      const prepared = await this.prepare(lang);
      if (!prepared) return { ok: false, error: `语言 ${lang} 无可用 grammar 或查询` };

      const budgetMicros = queryBudget(text);
      const startedAt = performance.now();
      const parser = this.parser;
      parser.setLanguage(prepared.language);
      const tree = parser.parse(text);
      if (!tree) return { ok: false, error: `语言 ${lang} 解析失败` };

      try {
        const intervals: HighlightInterval[] = [];
        if (prepared.highlights) {
          for (const c of prepared.highlights.captures(tree.rootNode, { timeoutMicros: budgetMicros })) {
            intervals.push({ start: c.node.startIndex, end: c.node.endIndex, capture: c.name });
          }
        }
        if (prepared.injections && depth < this.maxInjectionDepth) {
          await this.collectInjections(prepared.injections, tree, intervals, depth, budgetMicros);
        }
        intervals.sort((a, b) => a.start - b.start || b.end - a.end);
        // web-tree-sitter 0.25 超时语义：丢弃已收集结果、返回空数组。若不转失败，
        // 调用方会拿到 ok:true + 空区间而静默无高亮、不走 hljs 兜底。
        // 判据取"空区间 + 墙钟 ≥ 90% 预算"——真实零捕获的文本不会恰好贴着预算完成，误伤即
        // 便发生也只是多走一次 hljs 兜底，代价可接受。
        if (intervals.length === 0 && (performance.now() - startedAt) * 1000 >= budgetMicros * 0.9) {
          return { ok: false, error: `查询执行超时（预算 ${Math.round(budgetMicros / 1000)}ms），已丢弃空结果以转兜底` };
        }
        return { ok: true, intervals };
      } finally {
        tree.delete();
      }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * 注入递归：injections 查询匹配 → 解析子语言 → 子文本递归高亮 → 偏移合并。
   * 未知语言前置短路（warn 每语言一次）：缺失 grammar 的注入目标（如 comment/jsdoc/graphql）
   * 在真实文件里逐注释出现，递归失败路径的逐次告警会刷屏。
   */
  private async collectInjections(
    injQuery: Query,
    tree: Tree,
    intervals: HighlightInterval[],
    depth: number,
    budgetMicros: number,
  ): Promise<void> {
    for (const match of injQuery.matches(tree.rootNode, { timeoutMicros: budgetMicros })) {
      const content = match.captures.find((c) => c.name === 'injection.content');
      if (!content) continue;
      const subLang = resolveInjectionLanguage(match);
      if (!subLang) continue;
      if (!this.hasLanguage(subLang)) {
        if (!this.warnedInjections.has(subLang)) {
          this.warnedInjections.add(subLang);
          console.warn(`[highlight] 注入语言 ${subLang} 不可用，已跳过（语言 ${subLang} 无可用 grammar 或查询）`);
        }
        continue;
      }
      // 递归会复用 parser 重新 parse，先取出子树文本与偏移再 await
      const subText = content.node.text;
      const offset = content.node.startIndex;
      const sub = await this.highlight(subText, subLang, depth + 1);
      if (!sub.ok) continue;
      for (const i of sub.intervals) {
        intervals.push({ start: i.start + offset, end: i.end + offset, capture: i.capture });
      }
    }
  }

  /** 语言是否可解析（grammar 清单键命中；别名先规范化）：注入递归的前置短路检查。 */
  hasLanguage(rawLang: string): boolean {
    return this.grammarTable[this.canonicalLang(rawLang)] !== undefined;
  }

  /** 释放 wasm 资源：查询 delete、缓存清空、parser delete。 */
  dispose(): void {
    for (const p of this.prepared.values()) {
      void p.then((lang) => {
        lang?.highlights?.delete();
        lang?.injections?.delete();
      });
    }
    this.prepared.clear();
    this.parser.delete();
  }

  /**
   * 别名 → 规范语言名（不在清单键与别名中时原样返回）。
   * BUG-42：两级查找前先 toLowerCase——grammar 清单键与别名表均全小写，围栏语言
   * 标识（如 ```Rust）不归一时静默不命中，tree-sitter 路径丢失降级 hljs 兜底。
   */
  private canonicalLang(lang: string): string {
    const key = lang.toLowerCase();
    return this.grammarTable[key] !== undefined ? key : (this.aliasToLang.get(key) ?? lang);
  }

  /** 惰性准备单语言：别名规范化 → grammar 加载 + 查询编译，按规范名缓存。 */
  private prepare(rawLang: string): Promise<PreparedLanguage | null> {
    const lang = this.canonicalLang(rawLang);
    let p = this.prepared.get(lang);
    if (!p) {
      p = this.doPrepare(lang).catch((e: unknown) => {
        // BUG-06a 可观测：单 grammar 加载/查询编译失败显性化——此前静默吞为 null，
        // 该语言永远回退 hljs 且零痕迹（worker 脚本级失败另有 onerror 通道，此处
        // 补的是 per-language 通道）。返回 null 语义不变：该语言回退兜底。
        console.warn(`[highlight] 语言 ${lang} 的 grammar/查询准备失败，已回退兜底:`, e);
        return null;
      });
      this.prepared.set(lang, p);
    }
    return p;
  }

  private async doPrepare(lang: string): Promise<PreparedLanguage | null> {
    // SUSP-06：条目判定前置——grammar 缺失时零 query 资产请求（此前 expandQueryAsync
    // 先行，同源 manifest 剥离条目时 /queries/** 空打）
    const entry = this.resolveGrammarEntry(lang);
    if (!entry) return null;
    let expanded: ExpandedQuery | null;
    if (this.remoteQueries) {
      expanded = await expandQueryAsync(this.remoteQueries, lang);
    } else {
      expanded = expandQuery(this.assets, lang);
    }
    if (!expanded) return null;
    const language = await Language.load(joinPath(entry.base ?? this.grammarsBase, entry.file));
    const toQuery = (scm: string): Query | null => {
      if (scm.trim() === '') return null;
      return new Query(language, scm);
    };
    return { language, highlights: toQuery(expanded.highlights), injections: toQuery(expanded.injections) };
  }

  /** 语言名 → grammar 清单条目（别名路径同样返回条目，含 base）：精确键 → aliases → null。 */
  private resolveGrammarEntry(lang: string): { file: string; base?: string } | null {
    const direct = this.grammarTable[lang];
    if (direct) return direct;
    const alias = this.aliasToLang.get(lang);
    return alias ? (this.grammarTable[alias] ?? null) : null;
  }
}

/** 从注入匹配解析子语言：`#set! injection.language` → `@injection.language` 捕获 → shebang shim。 */
function resolveInjectionLanguage(match: {
  setProperties?: Record<string, string | null>;
  captures: { name: string; node: { text: string } }[];
}): string | null {
  const prop = match.setProperties?.['injection.language'];
  if (prop) return prop;
  for (const c of match.captures) {
    if (c.name === 'injection.language') return c.node.text.trim();
    if (c.name === 'injection.shebang') return shebangLanguage(c.node.text);
  }
  return null;
}

/** shebang shim：`#!/usr/bin/env bash` → `bash`；`#!/usr/bin/python3` → `python`。 */
function shebangLanguage(text: string): string | null {
  const firstLine = text.split('\n', 1)[0] ?? '';
  const tokens = firstLine.slice(2).trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  const base = (t: string): string => t.split('/').pop() ?? '';
  let name = base(tokens[0]!);
  if (name === 'env' && tokens[1]) name = base(tokens[1]!);
  if (name === 'env' || name === '') return null;
  return name.replace(/[-.]?\d+(\.\d+)*$/, '') || null;
}

/**
 * fetch 版查询来源（浏览器 Worker 端）：按需请求 `${base}${lang}/highlights.scm` 与 `injections.scm`。
 * 目录布局与 assets/queries 一致；请求结果（含 404 的 null）按语言缓存，语言不变则只请求一次。
 * onLoaded（可选，Task 4 细口径）：每份文件 fetch 完成上报一次（`${lang}/${name}`，含
 * 404/SPA 兜底缺失/网络失败——帧语义是「fetch 已完成」，缺席才是悬挂）；缺省 undefined
 * 零调用（非 debug 链路不注入，行为与既有签名逐字节一致）。
 */
function remoteQueryLoader(base: string, onLoaded?: (file: string) => void): AsyncQuerySource {
  const cache = new Map<string, Promise<QueryFile | null>>();
  return (lang) => {
    let p = cache.get(lang);
    if (!p) {
      const dir = joinPath(base, lang);
      const read = async (name: string): Promise<string | undefined> => {
        try {
          const res = await fetch(`${dir}/${name}`);
          // SPA-fallback 防御（终审 C1，双层修之前端层）：缺失查询被静态服务器以
          // 200 index.html 兜底时视为缺失——误载会让 Query 编译抛错，整语言降级 hljs
          if (!res.ok || (res.headers.get('content-type') ?? '').includes('text/html')) {
            return undefined;
          }
          return await res.text();
        } catch {
          return undefined;
        } finally {
          // 逐文件打点：finally 保证命中/缺失/异常三路恰好一帧
          onLoaded?.(`${lang}/${name}`);
        }
      };
      p = Promise.all([read('highlights.scm'), read('injections.scm')]).then(([highlights, injections]) =>
        highlights === undefined && injections === undefined ? null : { highlights, injections },
      );
      cache.set(lang, p);
    }
    return p;
  };
}

/** 目录扫描构建查询资产：子目录名即语言名，读 highlights.scm / injections.scm（Node 专用）。 */
async function loadQueriesFromDir(dir: string): Promise<QueryAssets> {  const fs = await getFs();
  const assets: QueryAssets = new Map();
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const read = (name: string): string | undefined => {
      const p = joinPath(joinPath(dir, entry.name), name);
      return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : undefined;
    };
    assets.set(entry.name, { highlights: read('highlights.scm'), injections: read('injections.scm') });
  }
  return assets;
}

/** 读 grammar 目录的 manifest.json（Node 专用；浏览器端请直接传 grammars 表）。 */
async function readManifest(grammarsDir: string): Promise<GrammarTable> {
  const fs = await getFs();
  const manifestPath = joinPath(grammarsDir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { grammars: GrammarTable };
  return manifest.grammars;
}

function normalizeVirtualQueries(v: VirtualQueries): QueryAssets {
  return v instanceof Map ? v : new Map(Object.entries(v));
}

/** 构建别名反查表：alias → 主语言名（多对一，后写覆盖先写；键小写归一，BUG-42）。 */
function buildAliasTable(table: GrammarTable): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const [lang, entry] of Object.entries(table)) {
    for (const alias of entry.aliases ?? []) aliases.set(alias.toLowerCase(), lang);
  }
  return aliases;
}
