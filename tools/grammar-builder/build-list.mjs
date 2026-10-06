#!/usr/bin/env node
// 自建语法清单生成器：汇总 helix 语言键（packages/highlight/assets/languages.json）与
// markpad 的 grammar_info.json subpath 表，逐一探测 grammar 源目录 src/parser.c 是否存在，
// 产出 tools/grammar-builder/build-list.json（--self-build 模式的输入）。
// 用法：node tools/grammar-builder/build-list.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');

export const SOURCES = {
  languagesJson:
    process.env.VV_LANGUAGES_JSON ??
    path.join(repoRoot, 'packages/highlight/assets/languages.json'),
  grammarInfoJson:
    process.env.VV_GRAMMAR_INFO ??
    '/share/rw/repo/markpad-aio/Markpad/src-tauri/grammar_info.json',
  grammarsDir:
    process.env.VV_GRAMMARS_DIR ?? '/share/rw/repo/markpad-aio/Markpad/src-tauri/grammars',
  outFile: process.env.VV_BUILD_LIST ?? path.join(here, 'build-list.json'),
};

/**
 * 探测单个 grammar 的 parser.c 是否存在。
 * - subpath 为空：grammarsDir/<name>/src/parser.c
 * - 有 subpath：markpad 的 subpath 表指向仓库内子目录（如 tsx → grammars/tsx/tsx、
 *   markdown → grammars/markdown/tree-sitter-markdown），探测 grammarsDir/<name>/<subpath>/src/parser.c
 */
export function detectParserC(grammarsDir, name, subpath) {
  const rel = subpath ? path.join(name, subpath) : name;
  return fs.existsSync(path.join(grammarsDir, rel, 'src', 'parser.c'));
}

/** 生成 build-list.json 条目：[{ name, subpath, parserCExists, helixLang }]（按 name 排序，幂等） */
export function buildList({ languagesJson, grammarInfoJson, grammarsDir }) {
  const langs = JSON.parse(fs.readFileSync(languagesJson, 'utf8'));
  const grammarInfo = JSON.parse(fs.readFileSync(grammarInfoJson, 'utf8'));

  const entries = [];
  for (const [name, info] of Object.entries(grammarInfo)) {
    const subpath = typeof info?.subpath === 'string' ? info.subpath : '';
    entries.push({
      name,
      subpath,
      parserCExists: detectParserC(grammarsDir, name, subpath),
      helixLang: Object.hasOwn(langs, name) ? name : null,
    });
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return entries;
}

export function main() {
  const entries = buildList(SOURCES);
  const buildable = entries.filter((e) => e.parserCExists);
  fs.mkdirSync(path.dirname(SOURCES.outFile), { recursive: true });
  fs.writeFileSync(SOURCES.outFile, JSON.stringify(entries, null, 2) + '\n');
  console.log(
    `[build-list] ${entries.length} grammars total, ${buildable.length} buildable (src/parser.c exists) -> ${SOURCES.outFile}`,
  );
  return { entries, buildable };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
