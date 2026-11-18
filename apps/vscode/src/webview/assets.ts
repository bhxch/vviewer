// assets.ts — 高亮资产解析（spec H T4）。
//
// 资产三段（RF 5：三者同族绝对 URL，不得混用相对路径）：
// - `grammarsBase`：grammar wasm 目录基址（尾斜杠）——`Language.load(joinPath(entry.base ?? grammarsBase, entry.file))`
//   （packages/vviewer-highlight/src/core-parse.ts:417）
// - `queriesBase`：queries 目录基址（**必带尾斜杠**）——`fetch(`${queriesBase}${lang}/${name}`)`
//   （core-parse.ts:484）
// - `runtimeDir`：含 `tree-sitter.wasm` 的目录基址（尾斜杠）——`Parser.init({ locateFile: (f) => joinPath(runtimeDir, f) })`
//   （core-parse.ts:210）
//
// **清单条目不得带 `base`**：`entry.base ?? grammarsBase` 的回落语义要求 base 缺席——
// 带 base 会绕开 grammarsBase 打到错误源（core-parse.ts:417）。
import type { GrammarTable } from '@bhxch/vviewer-highlight';
import type { AssetUris } from '../host/protocol';

/** 资产三段（绝对 URL + 尾斜杠） */
export interface AssetBases {
  grammarsBase: string;
  queriesBase: string;
  runtimeDir: string;
}

/**
 * manifest → GrammarTable。
 *
 * 只取 `{ file, aliases? }` 两个字段——**显式丢弃 `base`**（回落语义要求，见上）与
 * manifest 里的校验字段（abi/sha256——渲染侧不消费）。
 */
export function toGrammarTable(manifest: unknown): GrammarTable {
  const table: GrammarTable = {};
  if (!manifest || typeof manifest !== 'object') return table;
  const grammars = (manifest as { grammars?: unknown }).grammars;
  if (!grammars || typeof grammars !== 'object') return table;
  for (const [lang, raw] of Object.entries(grammars as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as { file?: unknown; aliases?: unknown };
    if (typeof entry.file !== 'string' || entry.file === '') continue;
    const aliases = Array.isArray(entry.aliases)
      ? entry.aliases.filter((a): a is string => typeof a === 'string')
      : undefined;
    table[lang] = aliases && aliases.length > 0 ? { file: entry.file, aliases } : { file: entry.file };
  }
  return table;
}

/** 资产三段（自 AssetUris 取——已是 asWebviewUri 绝对 URL） */
export function resolveAssetBases(assets: AssetUris): AssetBases {
  return {
    grammarsBase: assets.grammarsBase,
    queriesBase: assets.queriesBase,
    runtimeDir: assets.runtimeDir
  };
}

/**
 * 语言是否在本地 grammar 清单内（canonical 键或条目别名）。
 *
 * 清单感知门（apps/web 同款语义）：清单外的语言跳过注定失败的 worker 往返 → 落 hljs
 * 兜底（**不静默**——降级原因经可见面呈现）。
 */
export function hasLocalGrammar(table: GrammarTable, lang: string): boolean {
  if (!lang) return false;
  if (table[lang]) return true;
  for (const entry of Object.values(table)) {
    if (entry.aliases?.includes(lang)) return true;
  }
  return false;
}

/** 资产可用性（缺件 → 可见降级的判定依据） */
export interface AssetAvailability {
  /** grammar 资产是否可用（清单非空） */
  grammarsOk: boolean;
  /** 缺失的资产种类（稳定标识符） */
  missing: string[];
}

/** 资产可用性判定（grammar 清单为空 = grammar 资产缺失） */
export function resolveAssetAvailability(table: GrammarTable): AssetAvailability {
  const missing = Object.keys(table).length === 0 ? ['grammars'] : [];
  return { grammarsOk: missing.length === 0, missing };
}
