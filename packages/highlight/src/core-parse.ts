import path from 'node:path';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { Parser, Language, Query, type Tree } from 'web-tree-sitter';
import { expandQuery, type QueryAssets, type QueryFile } from './queries';
import type { HighlightInterval } from './types';

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
  /** grammar wasm 目录（含 manifest.json），Node 文件系统路径。 */
  grammarsDir?: string;
  /** 直接给 grammar 清单（浏览器端跳过 manifest 读取）。 */
  grammars?: GrammarTable;
  /** grammar wasm 加载基础路径，默认 grammarsDir。 */
  grammarsBase?: string;
  /** web-tree-sitter runtime（tree-sitter.wasm）所在目录，默认 grammarsBase。 */
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

let initPromise: Promise<void> | null = null;

/**
 * tree-sitter 解析引擎：语言加载与查询编译缓存、区间生成、injection 递归。
 * 纯逻辑，不依赖 Worker API——Worker（worker.ts）与测试直调本类。
 */
export class TreeSitterEngine {
  private readonly parser: Parser;
  private readonly assets: QueryAssets;
  private readonly grammarTable: GrammarTable;
  private readonly grammarsBase: string;
  private readonly aliasToLang: Map<string, string>;
  private readonly maxInjectionDepth: number;
  private readonly prepared = new Map<string, Promise<PreparedLanguage | null>>();

  private constructor(assets: QueryAssets, opts: EngineOptions) {
    this.assets = assets;
    this.grammarTable = opts.grammars ?? this.readManifest(opts.grammarsDir);
    this.grammarsBase = opts.grammarsBase ?? opts.grammarsDir ?? '';
    this.aliasToLang = buildAliasTable(this.grammarTable);
    this.maxInjectionDepth = opts.maxInjectionDepth ?? 3;
    this.parser = new Parser();
  }

  /** 初始化 runtime（Parser.init 幂等）并构建引擎。 */
  static async create(opts: EngineOptions): Promise<TreeSitterEngine> {
    const runtimeDir = opts.runtimeDir ?? opts.grammarsBase ?? opts.grammarsDir ?? '';
    if (!initPromise) {
      initPromise = Parser.init({ locateFile: (file: string) => path.join(runtimeDir, file) }).catch((e) => {
        initPromise = null; // 失败可重试（下次 create 用正确的 runtimeDir）
        throw e;
      });
    }
    await initPromise;
    const assets: QueryAssets =
      typeof opts.queriesDir === 'string'
        ? loadQueriesFromDir(opts.queriesDir)
        : opts.queriesDir === undefined
          ? new Map<never, never>()
          : normalizeVirtualQueries(opts.queriesDir);
    return new TreeSitterEngine(assets, opts);
  }

  /**
   * 高亮文本：展开查询 → 加载语言（缓存）→ 编译查询（缓存）→ 解析 → 区间 → 注入递归。
   * 区间按 (start asc, end desc) 排序，不去重叠（渲染端"已覆盖跳过"）。
   * depth 为当前注入深度；depth ≥ maxInjectionDepth 不再递归注入。
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
          for (const c of prepared.highlights.captures(tree.rootNode)) {
            intervals.push({ start: c.node.startIndex, end: c.node.endIndex, capture: c.name });
          }
        }
        if (prepared.injections && depth < this.maxInjectionDepth) {
          await collectInjections(this, prepared.injections, tree, intervals, depth);
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

  /** 惰性准备单语言：grammar 加载 + 查询编译，全部按 lang 缓存（含失败，避免重复报错刷屏）。 */
  private prepare(lang: string): Promise<PreparedLanguage | null> {
    let p = this.prepared.get(lang);
    if (!p) {
      p = this.doPrepare(lang).catch(() => null);
      this.prepared.set(lang, p);
    }
    return p;
  }

  private async doPrepare(lang: string): Promise<PreparedLanguage | null> {
    const expanded = expandQuery(this.assets, lang);
    if (!expanded) return null;
    const file = this.resolveGrammar(lang);
    if (!file) return null;
    const language = await Language.load(path.join(this.grammarsBase, file));
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

  private readManifest(grammarsDir: string | undefined): GrammarTable {
    if (!grammarsDir) throw new Error('需要 grammarsDir 或 grammars 选项');
    const manifestPath = path.join(grammarsDir, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { grammars: GrammarTable };
    return manifest.grammars;
  }
}

/** 注入递归：injections 查询匹配 → 解析子语言 → 子文本递归高亮 → 偏移合并。 */
async function collectInjections(
  engine: TreeSitterEngine,
  injQuery: Query,
  tree: Tree,
  intervals: HighlightInterval[],
  depth: number,
): Promise<void> {
  for (const match of injQuery.matches(tree.rootNode)) {
    const content = match.captures.find((c) => c.name === 'injection.content');
    if (!content) continue;
    const subLang = resolveInjectionLanguage(match);
    if (!subLang) continue;
    // 递归会复用 parser 重新 parse，先取出子树文本与偏移再 await
    const subText = content.node.text;
    const offset = content.node.startIndex;
    const sub = await engine.highlight(subText, subLang, depth + 1);
    if (!sub.ok) {
      console.warn(`[highlight] 注入语言 ${subLang} 不可用，已跳过（${sub.error}）`);
      continue;
    }
    for (const i of sub.intervals) {
      intervals.push({ start: i.start + offset, end: i.end + offset, capture: i.capture });
    }
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

/** 目录扫描构建查询资产：子目录名即语言名，读 highlights.scm / injections.scm。 */
function loadQueriesFromDir(dir: string): QueryAssets {
  const assets: QueryAssets = new Map();
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const read = (name: string): string | undefined => {
      const p = path.join(dir, entry.name, name);
      return existsSync(p) ? readFileSync(p, 'utf8') : undefined;
    };
    assets.set(entry.name, { highlights: read('highlights.scm'), injections: read('injections.scm') });
  }
  return assets;
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
