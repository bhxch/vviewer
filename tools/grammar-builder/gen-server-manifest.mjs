#!/usr/bin/env node
// 服务端 grammar 清单生成器：解析 Markpad build.rs 的 (name, dir, subpath, c_symbol)
// 静态表（301 语言的服务端验收集合，spec §2.1），产出 server/grammars-manifest.json。
// 该 JSON 与 build-list.json 同理入库（体积小、由仓库外现势生成、无源不可再生）。
// 用法：node tools/grammar-builder/gen-server-manifest.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const SOURCES = {
  buildRs: process.env.VV_MARKPAD_BUILD_RS ?? '/share/rw/repo/markpad-aio/Markpad/src-tauri/build.rs',
  outFile: process.env.VV_SERVER_MANIFEST ?? path.join(here, '../../server/grammars-manifest.json'),
};

/** 提取 build.rs 中 `vec![ ... ]` 静态表：四元组 ("name", "dir", "subpath", "c_symbol")。 */
export function parseBuildRsTable(text) {
  const block = /let grammars[^=]*=\s*vec!\[([\s\S]*?)\];/.exec(text)?.[1] ?? '';
  const entries = [];
  const re = /\(\s*"([^"]+)"\s*,\s*"([^"]+)"\s*,\s*"([^"]*)"\s*,\s*"([^"]*)"\s*\)/g;
  for (const m of block.matchAll(re)) {
    entries.push({ name: m[1], dir: m[2], subpath: m[3], cSymbol: m[4] });
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return entries;
}

export function toManifest(entries) {
  return JSON.stringify(
    {
      note: '由 Markpad build.rs 静态表生成（node tools/grammar-builder/gen-server-manifest.mjs）；server/build.rs 的编译与 FFI 输入，语言集合 = 服务端 301 验收口径',
      generatedAt: new Date().toISOString(),
      grammars: entries,
    },
    null,
    2,
  ) + '\n';
}

export function main() {
  const entries = parseBuildRsTable(fs.readFileSync(SOURCES.buildRs, 'utf8'));
  if (entries.length < 301) {
    throw new Error(`Markpad build.rs 表仅 ${entries.length} 条（期望 ≥301），上游文件可能已变动`);
  }
  const odd = entries.filter((e) => e.dir !== e.name);
  if (odd.length) console.warn(`[gen-server-manifest] dir != name 条目（源树查找按 dir）: ${JSON.stringify(odd)}`);
  fs.mkdirSync(path.dirname(SOURCES.outFile), { recursive: true });
  fs.writeFileSync(SOURCES.outFile, toManifest(entries));
  console.log(`[gen-server-manifest] ${entries.length} grammars -> ${SOURCES.outFile}`);
  return entries;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
