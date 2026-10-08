#!/usr/bin/env node
// grammar wasm 资产构建器，四种模式：
//   --from-wasms   主路径：从 node_modules/tree-sitter-wasms/out 按 aliases.json 映射拷贝到
//                  apps/web/static/grammars/{helixLangName}.wasm，计算 sha256 并写 manifest.json。
//                  单文件 >8MB 跳过；总入库量上限 80MB（aliases.json 顺序 = 高频优先，超限截断）。
//   --fetch        CI 源获取：对 build-list.json ∩ languages.toml（vendored，git+rev+subpath）
//                  逐个浅取源仓（git init+fetch --depth 1 <rev>，服务端需支持按 SHA 取；
//                  并发 8，单仓失败记 fetch-failures.json 继续）→ 拷贝 <subpath>/ 树（判据
//                  src/parser.c）到 out/grammars/<name>/<subpath>/（与 markpad 目录同构，
//                  作为 --self-build 的 VV_GRAMMARS_DIR 输入）。
//   --self-build   备用路径：对 build-list.json 逐个 `tree-sitter build --wasm`。
//                  emcc 缺失时整批不执行，写 out/failure-list.json（reason: emcc not available）并 exit 0。
//                  wasm 写 out/wasm-self/（与预编译集隔离，供 --merge-manifest 合并）。
//   --merge-manifest   合并产物：把 out/wasm-self/*.wasm 覆盖拷入 apps/web/static/grammars/
//                  （同名键覆盖），manifest 对应条目标 source: 'self-built'，总 source 标
//                  'tree-sitter-wasms+self-built'。
// 用法：node tools/grammar-builder/build.mjs [--from-wasms|--fetch|--self-build|--merge-manifest]
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync, execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { parse as parseToml } from 'smol-toml';

const execFile = promisify(execFileCb);
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');

export const PATHS = {
  aliasesJson: path.join(here, 'aliases.json'),
  buildListJson: path.join(here, 'build-list.json'),
  languagesToml: process.env.VV_LANGUAGES_TOML ?? path.join(here, 'languages.toml'),
  wasmsDir:
    process.env.VV_WASMS_DIR ?? path.join(repoRoot, 'node_modules/tree-sitter-wasms/out'),
  outDir:
    process.env.VV_GRAMMARS_OUT ?? path.join(repoRoot, 'apps/web/static/grammars'),
  failureOut:
    process.env.VV_FAILURE_OUT ?? path.join(here, 'out/failure-list.json'),
  skippedOut:
    process.env.VV_SKIPPED_OUT ?? path.join(here, 'out/from-wasms-skipped.json'),
  manifestOut:
    process.env.VV_MANIFEST_OUT ?? path.join(repoRoot, 'apps/web/static/grammars/manifest.json'),
  grammarsDir:
    process.env.VV_GRAMMARS_DIR ?? '/share/rw/repo/markpad-aio/Markpad/src-tauri/grammars',
  // --fetch 产出的源树（与 markpad grammars 目录同构）与失败清单；--self-build 的 wasm 输出
  fetchedDir: process.env.VV_FETCH_OUT ?? path.join(here, 'out/grammars'),
  fetchFailuresOut:
    process.env.VV_FETCH_FAILURES_OUT ?? path.join(here, 'out/fetch-failures.json'),
  selfWasmOut: process.env.VV_SELF_WASM_OUT ?? path.join(here, 'out/wasm-self'),
};

// 资产约束（M2 裁定）：单文件上限 8MB（超限跳过），入库总量上限 80MB（按高频优先截断）。
// 8MB 使 tree-sitter-wasms 全部 36 个预编译 wasm 均可入库（最大 objc 7.4MB）。
export const MAX_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 80 * 1024 * 1024;

export function loadAliases() {
  return JSON.parse(fs.readFileSync(PATHS.aliasesJson, 'utf8'));
}

export function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** 探测 emcc（Emscripten 编译器）；返回可执行路径或 null */
export function detectEmcc() {
  const probe = (cmd) => {
    const r = spawnSync(cmd, ['--version'], { encoding: 'utf8' });
    return r.status === 0 ? cmd : null;
  };
  return probe('emcc') ?? probe('emcc.bat');
}

/**
 * --from-wasms 主路径。
 * 返回 { manifest, skipped, truncated }：
 * - skipped: [{ lang, wasm, bytes, reason }]（>8MB 或文件缺失）
 * - truncated: 总量超 80MB 被截断时的高频优先截断说明
 */
export function buildFromWasms({
  aliases = loadAliases(),
  wasmsDir = PATHS.wasmsDir,
  outDir = PATHS.outDir,
  manifestOut = PATHS.manifestOut,
  skippedOut = PATHS.skippedOut,
  maxFileBytes = MAX_FILE_BYTES,
  maxTotalBytes = MAX_TOTAL_BYTES,
} = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  const grammars = {};
  const skipped = [];
  let totalBytes = 0;
  let truncated = null;

  // aliases.json 键序 = 高频优先；截断与跳过均记录到清单
  for (const [lang, entry] of Object.entries(aliases)) {
    const src = path.join(wasmsDir, `${entry.wasm}.wasm`);
    if (!fs.existsSync(src)) {
      skipped.push({ lang, wasm: entry.wasm, bytes: 0, reason: 'wasm not found in tree-sitter-wasms' });
      continue;
    }
    const bytes = fs.statSync(src).size;
    if (bytes > maxFileBytes) {
      skipped.push({ lang, wasm: entry.wasm, bytes, reason: `file ${bytes} bytes > ${maxFileBytes} limit` });
      continue;
    }
    if (totalBytes + bytes > maxTotalBytes) {
      truncated = {
        lang,
        reason: `total ${totalBytes + bytes} bytes would exceed ${maxTotalBytes} limit; remaining entries skipped (high-frequency-first order)`,
      };
      skipped.push({ lang, wasm: entry.wasm, bytes, reason: truncated.reason });
      continue;
    }
    const destFile = `${lang}.wasm`;
    fs.copyFileSync(src, path.join(outDir, destFile));
    totalBytes += bytes;
    grammars[lang] = {
      file: destFile,
      abi: null, // tree-sitter-wasms 未声明 ABI 版本；运行时由 web-tree-sitter 加载校验兜底
      sha256: sha256File(src),
      aliases: entry.aliases,
    };
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    source: 'tree-sitter-wasms',
    grammars,
  };
  fs.writeFileSync(manifestOut, JSON.stringify(manifest, null, 2) + '\n');
  if (skipped.length) {
    // 跳过清单持久化（out/ 不入库，见 .gitignore）
    fs.mkdirSync(path.dirname(skippedOut), { recursive: true });
    fs.writeFileSync(skippedOut, JSON.stringify({ truncated, skipped }, null, 2) + '\n');
  }
  return { manifest, skipped, truncated };
}

/**
 * --self-build 备用路径：对 build-list.json 逐个 `tree-sitter build --wasm`。
 * emcc 缺失时整批不执行，返回 { mode: 'failure', failures } 并写 failure-list.json（不抛错）。
 * wasm 写 selfWasmOut（默认 out/wasm-self，与预编译集隔离，CI 由 --merge-manifest 合并）；
 * 传 outDir 可直写目标目录（兼容旧行为）。
 */
export function selfBuild({
  emcc = detectEmcc(),
  buildListJson = PATHS.buildListJson,
  grammarsDir = PATHS.grammarsDir,
  outDir = PATHS.selfWasmOut,
  failureOut = PATHS.failureOut,
} = {}) {
  const buildList = JSON.parse(fs.readFileSync(buildListJson, 'utf8'));
  const buildable = buildList.filter((e) => e.parserCExists);

  if (!emcc) {
    const failures = buildable.map((e) => ({
      name: e.name,
      subpath: e.subpath,
      reason: 'emcc not available',
    }));
    fs.mkdirSync(path.dirname(failureOut), { recursive: true });
    fs.writeFileSync(failureOut, JSON.stringify(failures, null, 2) + '\n');
    console.warn(
      `[self-build] emcc not available: ${failures.length} grammars recorded to ${failureOut}, nothing built`,
    );
    return { mode: 'failure', failures };
  }

  // emcc 可用：逐个构建（tree-sitter CLI 亦需在 PATH）
  const failures = [];
  let built = 0;
  fs.mkdirSync(outDir, { recursive: true });
  for (const entry of buildable) {
    const srcDir = path.join(grammarsDir, entry.name, entry.subpath);
    const outFile = path.join(outDir, `${entry.name}.wasm`);
    const r = spawnSync('tree-sitter', ['build', '--wasm', '--output', outFile, '.'], {
      cwd: srcDir,
      encoding: 'utf8',
    });
    if (r.status !== 0) {
      failures.push({ name: entry.name, subpath: entry.subpath, reason: (r.stderr || r.stdout || '').trim().slice(-500) || `exit ${r.status}` });
    } else {
      built++;
    }
  }
  fs.mkdirSync(path.dirname(failureOut), { recursive: true });
  fs.writeFileSync(failureOut, JSON.stringify(failures, null, 2) + '\n');
  console.log(`[self-build] built ${built}, failed ${failures.length}`);
  return { mode: 'built', built, failures };
}

// ---------- --fetch：CI 侧 grammar 源获取（L1） ----------

/**
 * 解析 vendored languages.toml 的 [[grammar]] 段：
 * Map<name, { git, rev, subpath }>（subpath 缺省 ''）。缺 git/rev 的条目跳过（无源可取）。
 */
export function parseGrammarSources(tomlText) {
  const doc = parseToml(tomlText);
  const out = new Map();
  for (const g of doc.grammar ?? []) {
    if (!g || typeof g.name !== 'string') continue;
    const src = g.source ?? {};
    if (typeof src.git !== 'string' || typeof src.rev !== 'string') continue;
    out.set(g.name, { git: src.git, rev: src.rev, subpath: typeof src.subpath === 'string' ? src.subpath : '' });
  }
  return out;
}

/**
 * 取数计划：build-list（self-build 的输入，parser.c 判据已过）逐条 join languages.toml。
 * toml 缺条目或缺 git/rev 记入 missing（fetch 前即知，CI 直接可见）。
 */
export function planFetch(buildList, grammarSources) {
  const plan = [];
  const missing = [];
  for (const e of buildList) {
    const src = grammarSources.get(e.name);
    if (!src) {
      missing.push({ name: e.name, reason: 'no [[grammar]] source (git/rev) in languages.toml' });
      continue;
    }
    plan.push({ name: e.name, subpath: e.subpath, git: src.git, rev: src.rev });
  }
  return { plan, missing };
}

/** 单仓浅取：init → remote add → fetch --depth 1 <rev>（服务端按 SHA 取，GitHub/Codeberg 支持）
 *  → checkout FETCH_HEAD → 拷贝 <subpath>/ 树（滤 .git，判据 src/parser.c）到 outDir/<name>/<subpath>。
 *  已存在同构源树（幂等重跑）返回 'skipped'。 */
export async function fetchOneGrammar(entry, { tmpRoot, outDir }) {
  const target = path.join(outDir, entry.name, entry.subpath);
  if (fs.existsSync(path.join(target, 'src', 'parser.c'))) return 'skipped';
  const dst = path.join(tmpRoot, entry.name);
  await fs.promises.rm(dst, { recursive: true, force: true });
  const git = (args) => execFile('git', args, { encoding: 'utf8', timeout: 300_000 });
  await fs.promises.mkdir(tmpRoot, { recursive: true });
  await git(['init', '-q', dst]);
  await git(['-C', dst, 'remote', 'add', 'origin', entry.git]);
  await git(['-C', dst, 'fetch', '-q', '--depth', '1', 'origin', entry.rev]);
  await git(['-C', dst, 'checkout', '-q', '--detach', 'FETCH_HEAD']);
  const srcRoot = entry.subpath ? path.join(dst, entry.subpath) : dst;
  if (!fs.existsSync(path.join(srcRoot, 'src', 'parser.c'))) {
    throw new Error(`parser.c not found under ${entry.subpath || '<root>'}/src`);
  }
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  await fs.promises.cp(srcRoot, target, {
    recursive: true,
    filter: (p) => !p.split(path.sep).includes('.git')
  });
  await fs.promises.rm(dst, { recursive: true, force: true });
  return 'fetched';
}

/**
 * 并发抓取整份计划（默认 8）：单仓失败记清单继续；结果写 fetchFailuresOut。
 * 返回 { fetched, skipped, failures }（failures 同时落盘，CI 以失败清单长度设门禁阈值）。
 */
export async function fetchGrammarSources({
  plan,
  outDir = PATHS.fetchedDir,
  failuresOut = PATHS.fetchFailuresOut,
  concurrency = 8,
} = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  const failures = [];
  let fetched = 0;
  let skipped = 0;
  let cursor = 0;
  async function worker() {
    for (;;) {
      const i = cursor++;
      if (i >= plan.length) return;
      const entry = plan[i];
      try {
        const r = await fetchOneGrammar(entry, { tmpRoot: path.join(outDir, '.tmp'), outDir });
        if (r === 'fetched') fetched++;
        else skipped++;
      } catch (err) {
        failures.push({
          name: entry.name,
          git: entry.git,
          rev: entry.rev,
          reason: err instanceof Error ? (err.message || String(err)).split('\n').at(-1) : String(err)
        });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  fs.mkdirSync(path.dirname(failuresOut), { recursive: true });
  fs.writeFileSync(failuresOut, JSON.stringify(failures, null, 2) + '\n');
  return { fetched, skipped, failures };
}

// ---------- --merge-manifest：self-build 产物与预编译集合并（L1） ----------

/**
 * 把 selfDir（--self-build 产物）的 *.wasm 覆盖拷入 outDir（同名键覆盖），刷新 manifest：
 * 对应条目 sha256 重算、source 标 'self-built'（aliases 沿用既有登记，新键从 aliases.json
 * 兜底）；总 source 标 'tree-sitter-wasms+self-built'。超 8MB 单文件上限跳过并记录。
 * manifest 缺失时从空表起（纯 self-build 集合）。
 */
export function mergeManifest({
  selfDir = PATHS.selfWasmOut,
  outDir = PATHS.outDir,
  manifestOut = PATHS.manifestOut,
  aliases = loadAliases(),
  maxFileBytes = MAX_FILE_BYTES,
} = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestOut, 'utf8'));
  } catch {
    manifest = { generatedAt: new Date().toISOString(), source: 'tree-sitter-wasms+self-built', grammars: {} };
  }
  const merged = [];
  const skippedFiles = [];
  for (const f of fs.readdirSync(selfDir)) {
    if (!f.endsWith('.wasm')) continue;
    const lang = f.slice(0, -'.wasm'.length);
    const src = path.join(selfDir, f);
    const bytes = fs.statSync(src).size;
    if (bytes > maxFileBytes) {
      skippedFiles.push({ lang, bytes, reason: `file ${bytes} bytes > ${maxFileBytes} limit` });
      continue;
    }
    fs.copyFileSync(src, path.join(outDir, f));
    const prev = manifest.grammars[lang];
    manifest.grammars[lang] = {
      file: f,
      abi: null,
      sha256: sha256File(src),
      aliases: prev?.aliases ?? aliases[lang]?.aliases ?? [],
      source: 'self-built'
    };
    merged.push(lang);
  }
  manifest.source = 'tree-sitter-wasms+self-built';
  manifest.generatedAt = new Date().toISOString();
  fs.writeFileSync(manifestOut, JSON.stringify(manifest, null, 2) + '\n');
  return { manifest, merged, skipped: skippedFiles };
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.includes('--from-wasms')) {
    const { manifest, skipped, truncated } = buildFromWasms();
    const count = Object.keys(manifest.grammars).length;
    const bytes = Object.values(manifest.grammars).reduce((n, g) => {
      const p = path.join(PATHS.outDir, g.file);
      return n + fs.statSync(p).size;
    }, 0);
    console.log(`[from-wasms] ${count} grammars, ${(bytes / 1024 / 1024).toFixed(1)} MB -> ${PATHS.manifestOut}`);
    if (skipped.length) console.warn(`[from-wasms] skipped ${skipped.length}: ${JSON.stringify(skipped)}`);
    if (truncated) console.warn(`[from-wasms] truncated: ${JSON.stringify(truncated)}`);
    return manifest;
  }
  if (argv.includes('--self-build')) {
    return selfBuild();
  }
  if (argv.includes('--merge-manifest')) {
    const { manifest, merged, skipped } = mergeManifest();
    console.log(`[merge-manifest] merged ${merged.length} self-built wasm -> ${PATHS.manifestOut}`);
    if (skipped.length) console.warn(`[merge-manifest] skipped ${skipped.length}: ${JSON.stringify(skipped)}`);
    return { merged, skipped };
  }
  if (argv.includes('--fetch')) {
    const buildList = JSON.parse(fs.readFileSync(PATHS.buildListJson, 'utf8')).filter((e) => e.parserCExists);
    const grammarSources = parseGrammarSources(fs.readFileSync(PATHS.languagesToml, 'utf8'));
    const { plan, missing } = planFetch(buildList, grammarSources);
    const { fetched, skipped, failures } = await fetchGrammarSources({ plan });
    console.log(`[fetch] planned ${plan.length}, fetched ${fetched}, skipped(cached) ${skipped}, failed ${failures.length}`);
    if (missing.length) console.warn(`[fetch] missing source: ${JSON.stringify(missing)}`);
    if (failures.length) console.warn(`[fetch] failures -> ${PATHS.fetchFailuresOut}: ${JSON.stringify(failures.map((f) => f.name))}`);
    return { fetched, skipped, failures, missing };
  }
  console.error('usage: node build.mjs --from-wasms | --fetch | --self-build | --merge-manifest');
  return process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
