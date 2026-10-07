import { Parser, Language, Query, type Tree } from 'web-tree-sitter';
import { expandQuery, expandQueryAsync, type AsyncQuerySource, type ExpandedQuery, type QueryAssets, type QueryFile } from './queries';
import type { HighlightInterval } from './types';

/**
 * 浏览器可打包：本模块零顶层 node 内建 import。
 * fs 仅在传入目录字符串路径（Node 场景）时经变量化动态 import 惰性加载；
 * 浏览器端应传 VirtualQueries（查询）与 grammars（grammar 清单）。
 */

/** 虚拟查询来源：与目录布局同形的映射（lang → 查询文件），供浏览器端打包使用。 */
export type VirtualQueries = Map<string, QueryFile> | Record<string, QueryFile>;

/** grammar 清单：与 apps/web/static/grammars/manifest.json 的 grammars 字段同形。 */
export type GrammarTable = Record<string, { file: string; aliases?: string[] }>;

/** highlight 的结果：成功带全量区间（调用方负责去重叠渲染），失败带错误信息。 */
export type HighlightResult =
  | { ok: true; intervals: HighlightInterval[] }
  | { ok: false; error: string };

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
 * O(n²) 兄弟配对扫描）的护栏——超时返回部分结果而非挂起 worker（promise 永不 settle）。
 * 预算随文本长度线性放宽（20μs/字符），下限 50ms、上限 3s；
 * 实测合法 5MB typescript captures 约 0.6s，余量充足。
 */
function queryBudget(text: string): number {
  return Math.min(3_000_000, Math.max(50_000, text.length * 20));
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
    this.remoteQueries = opts.queriesBase ? remoteQueryLoader(opts.queriesBase) : null;
    this.grammarTable = grammarTable;
    this.grammarsBase = opts.grammarsBase ?? opts.grammarsDir ?? '';
    this.aliasToLang = buildAliasTable(grammarTable);
    this.maxInjectionDepth = opts.maxInjectionDepth ?? 3;
    this.parser = new Parser();
  }

  /** 初始化 runtime（Parser.init 幂等，失败可重试）并构建引擎。 */
  static async create(opts: EngineOptions): Promise<TreeSitterEngine> {
    const runtimeDir = opts.runtimeDir ?? opts.grammarsBase ?? opts.grammarsDir ?? '';
    if (!initPromise) {
      initPromise = Parser.init({ locateFile: (file: string) => joinPath(runtimeDir, file) }).catch((e) => {
        initPromise = null; // 失败可重试（下次 create 用正确的 runtimeDir）
        throw e;
      });
    }
    await initPromise;

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
    return new TreeSitterEngine(assets, grammarTable, opts);
  }

  /**
   * 高亮文本：展开查询 → 加载语言（缓存）→ 编译查询（缓存）→ 解析 → 区间 → 注入递归。
   * 区间按 (start asc, end desc) 排序，不去重叠（渲染端按"内层优先"展平——嵌套区间内层可见）。
   * depth 为当前注入深度；depth ≥ maxInjectionDepth 不再递归注入。
   * lang 可传 manifest 别名（js/sh/py 等），内部先规范化为清单键名。
   */
  async highlight(text: string, lang: string, depth = 0): Promise<HighlightResult> {
    try {
      const prepared = await this.prepare(lang);
      if (!prepared) return { ok: false, error: `语言 ${lang} 无可用 grammar 或查询` };

      const parser = this.parser;
      parser.setLanguage(prepared.language);
      const tree = parser.parse(text);
      if (!tree) return { ok: false, error: `语言 ${lang} 解析失败` };

      try {
        const intervals: HighlightInterval[] = [];
        if (prepared.highlights) {
          for (const c of prepared.highlights.captures(tree.rootNode, { timeoutMicros: queryBudget(text) })) {
            intervals.push({ start: c.node.startIndex, end: c.node.endIndex, capture: c.name });
          }
        }
        if (prepared.injections && depth < this.maxInjectionDepth) {
          await this.collectInjections(prepared.injections, tree, intervals, depth, queryBudget(text));
        }
        intervals.sort((a, b) => a.start - b.start || b.end - a.end);
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

  /** 别名 → 规范语言名（不在清单键与别名中时原样返回）。 */
  private canonicalLang(lang: string): string {
    return this.grammarTable[lang] !== undefined ? lang : (this.aliasToLang.get(lang) ?? lang);
  }

  /** 惰性准备单语言：别名规范化 → grammar 加载 + 查询编译，按规范名缓存。 */
  private prepare(rawLang: string): Promise<PreparedLanguage | null> {
    const lang = this.canonicalLang(rawLang);
    let p = this.prepared.get(lang);
    if (!p) {
      p = this.doPrepare(lang).catch(() => null);
      this.prepared.set(lang, p);
    }
    return p;
  }

  private async doPrepare(lang: string): Promise<PreparedLanguage | null> {
    let expanded: ExpandedQuery | null;
    if (this.remoteQueries) {
      expanded = await expandQueryAsync(this.remoteQueries, lang);
    } else {
      expanded = expandQuery(this.assets, lang);
    }
    if (!expanded) return null;
    const file = this.resolveGrammar(lang);
    if (!file) return null;
    const language = await Language.load(joinPath(this.grammarsBase, file));
    const toQuery = (scm: string): Query | null => {
      if (scm.trim() === '') return null;
      return new Query(language, scm);
    };
    return { language, highlights: toQuery(expanded.highlights), injections: toQuery(expanded.injections) };
  }

  /** 语言名 → grammar wasm 文件名：精确键 → aliases → null。 */
  private resolveGrammar(lang: string): string | null {
    const direct = this.grammarTable[lang];
    if (direct) return direct.file;
    return this.aliasToLang.get(lang) ?? null;
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
 */
function remoteQueryLoader(base: string): AsyncQuerySource {
  const cache = new Map<string, Promise<QueryFile | null>>();
  return (lang) => {
    let p = cache.get(lang);
    if (!p) {
      const dir = joinPath(base, lang);
      const read = async (name: string): Promise<string | undefined> => {
        try {
          const res = await fetch(`${dir}/${name}`);
          return res.ok ? await res.text() : undefined;
        } catch {
          return undefined;
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

/** 构建别名反查表：alias → 主语言名（多对一，后写覆盖先写）。 */
function buildAliasTable(table: GrammarTable): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const [lang, entry] of Object.entries(table)) {
    for (const alias of entry.aliases ?? []) aliases.set(alias, lang);
  }
  return aliases;
}
