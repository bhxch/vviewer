#!/usr/bin/env node
// grammar wasm 资产构建器（自建主路径，tree-sitter-cli ≥0.26 免 emcc——首次构建自动下载
// wasi-sdk/binaryen 到 ~/.cache/tree-sitter）。两种模式：
//   --fetch        源获取：目标语言集合 join vendored languages.toml（[[grammar]] git+rev+subpath）
//                  逐个浅取源仓（git init+fetch --depth 1 <rev>，服务端需支持按 SHA 取；并发 8，
//                  单仓失败记 fetch-failures.json 继续）→ 拷贝 <subpath>/ 树（判据 src/parser.c）
//                  到 out/grammars/<name>/<subpath>/（与 markpad 目录同构，作 --self-build 输入）。
//                  默认全量（build-list）；--lite / --languages a,b 收窄。
//   --self-build   对目标语言逐个 `tree-sitter build --wasm`，wasm 直写 apps/web/static/grammars/
//                  并整表重写 manifest.json（source: 'self-built'）。语言选择面：默认 lite
//                  （aliases.json 键，可解析且可建者）；--all = 全部 build-list 可建项 + aliases
//                  可解析补充；--languages a,b 显式点名。已存在的 wasm 跳过（--force 重建）。
// 语言解析顺序（aliases 键 → grammar）：build-list 的 helixLang/name（含 _- 变体）→
// languages.toml 同名条目 → aliases.json wasm 字段去掉 tree-sitter- 前缀后的条目。
// swift/objc/systemrdl 等 markpad build-list 快照缺失的语言靠后两级兜底；objc/systemrdl
// 无查询资产（assets/queries 无目录）且 helix 未收录，lite 集不产出（差异记录在 README）。
// 用法：node build.mjs --fetch [--lite|--languages x,y]
//       node build.mjs --self-build [--all|--languages x,y] [--force]
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync, execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { parse as parseToml } from 'smol-toml';

const execFile = promisify(execFileCb);
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');

export const PATHS = {
  aliasesJson: path.join(here, 'aliases.json'),
  buildListJson: path.join(here, 'build-list.json'),
  languagesToml: process.env.VV_LANGUAGES_TOML ?? path.join(here, 'languages.toml'),
  outDir: process.env.VV_GRAMMARS_OUT ?? path.join(repoRoot, 'apps/web/static/grammars'),
  failureOut: process.env.VV_FAILURE_OUT ?? path.join(here, 'out/failure-list.json'),
  manifestOut: process.env.VV_MANIFEST_OUT ?? path.join(repoRoot, 'apps/web/static/grammars/manifest.json'),
  // --fetch 产出的源树（与 markpad grammars 目录同构），--self-build 的输入
  grammarsDir: process.env.VV_GRAMMARS_DIR ?? path.join(here, 'out/grammars'),
  fetchFailuresOut: process.env.VV_FETCH_FAILURES_OUT ?? path.join(here, 'out/fetch-failures.json'),
  // 不可再生产物的 vendored 存放处（见 ensureVendoredPrebuilts 注释）
  vendoredDir: process.env.VV_VENDORED_DIR ?? path.join(here, 'fixtures'),
};

// 单文件告警阈值：产物不再入库（体积不构成仓库约束），超限仅提示。历史 8MB 上限为
// tree-sitter-wasms 入库时代（M2）的裁定，随产物出库一并废除。
export const WARN_FILE_BYTES = 8 * 1024 * 1024;

export function loadAliases() {
  return JSON.parse(fs.readFileSync(PATHS.aliasesJson, 'utf8'));
}

export function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * 解析构建用 tree-sitter CLI：优先仓库 devDep（node_modules/.bin，版本随 lockfile 锁定），
 * 回退 PATH。裸 PATH 查找会命中系统全局安装（如本机的 0.26.11，其 wasm 构建与 0.27 的
 * wasi-sdk 缓存不兼容，实测全部 stdlib.h not found），故必须显式钉定。
 */
export function resolveTreeSitterBin(root = repoRoot) {
  const local = path.join(root, 'node_modules/.bin/tree-sitter');
  return fs.existsSync(local) ? local : 'tree-sitter';
}

/** 探测 tree-sitter CLI（build --wasm 依赖）；返回布尔。 */
export function detectTreeSitter(bin = resolveTreeSitterBin(), env = process.env) {
  const r = spawnSync(bin, ['--version'], { encoding: 'utf8', env });
  return r.status === 0;
}

/**
 * 语言选择面解析。selection：
 * - 'lite'：aliases.json 全部键
 * - 'all'：build-list 全部可建项 + aliases 键可解析补充（如 swift）
 * - 数组：显式语言名（aliases 键 / helix 语言名 / grammar 名）
 * 返回 { targets: [{name, subpath}], unresolved: string[] }（unresolved 仅告警不致命）。
 */
export function resolveTargets(buildList, selection, aliases = loadAliases(), grammarSources = new Map()) {
  const buildable = buildList.filter((e) => e.parserCExists);
  const findEntry = (key) => {
    const variants = [key, key.replace(/_/g, '-'), key.replace(/-/g, '_')];
    for (const v of variants) {
      const hit = buildable.find((e) => e.helixLang === v || e.name === v);
      if (hit) return { name: hit.name, subpath: hit.subpath };
    }
    const derived = (aliases[key]?.wasm ?? '').replace(/^tree-sitter-/, '');
    for (const v of [...variants, derived]) {
      const src = grammarSources.get(v);
      if (src) return { name: v, subpath: src.subpath };
    }
    return null;
  };

  if (selection === 'all') {
    const map = new Map(buildable.map((e) => [e.name, { name: e.name, subpath: e.subpath }]));
    const unresolved = [];
    for (const key of Object.keys(aliases)) {
      const t = findEntry(key);
      if (t) {
        if (!map.has(t.name)) map.set(t.name, t);
      } else {
        unresolved.push(key);
      }
    }
    return { targets: [...map.values()], unresolved };
  }

  const names = selection === 'lite' ? Object.keys(aliases) : selection;
  const targets = [];
  const unresolved = [];
  for (const key of names) {
    const t = findEntry(key);
    if (t) targets.push(t);
    else unresolved.push(key);
  }
  return { targets, unresolved };
}

/**
 * vendored 预编译 wasm（fixtures/）：cli ≥0.26 的 wasi-sdk wasm 工具链不支持 C++ 外置
 * scanner（loader 的 get_scanner_path 只认 scanner.c，实测 0.27.0），yaml/vue（scanner.cc）
 * 无法再生——以 tree-sitter-wasms 0.1.13 时代的预编译产物作为不可再生的遗留输入 vendor
 * 入库。命中选择面时短路拷贝（不走 cli 构建）；上游工具链支持 .cc 后删除对应 fixture
 * 即恢复自建。返回 Map<vendoredName, srcPath>。
 */
export function listVendoredPrebuilts(vendoredDir = PATHS.vendoredDir) {
  const map = new Map();
  if (!fs.existsSync(vendoredDir)) return map;
  for (const f of fs.readdirSync(vendoredDir).sort()) {
    if (f.endsWith('.wasm')) map.set(f.slice(0, -'.wasm'.length), path.join(vendoredDir, f));
  }
  return map;
}

/**
 * --self-build：目标语言逐个构建。CLI 缺失时整批不执行，写 failure-list.json 并 exit 0
 * （保留旧 emcc 时代的优雅降级语义）。产物直写 outDir，完成后按目录全量重写 manifest
 * （目录即事实源，重复/跨选择面运行收敛）。vendored 命中项短路拷贝。
 * 返回 { mode, built, vendored, skipped, failures, manifest }。
 */
export async function selfBuild({
  selection = 'lite',
  force = false,
  env = process.env,
  concurrency = 8,
  treeSitterBin = resolveTreeSitterBin(),
  buildListJson = PATHS.buildListJson,
  grammarsDir = PATHS.grammarsDir,
  outDir = PATHS.outDir,
  manifestOut = PATHS.manifestOut,
  failureOut = PATHS.failureOut,
  aliases = loadAliases(),
  languagesTomlPath = PATHS.languagesToml,
  vendoredDir = PATHS.vendoredDir,
} = {}) {
  const buildList = JSON.parse(fs.readFileSync(buildListJson, 'utf8'));
  let grammarSources = new Map();
  try {
    grammarSources = parseGrammarSources(fs.readFileSync(languagesTomlPath, 'utf8'));
  } catch {
    // languages.toml 只影响 aliases 键兜底解析，缺失时按 build-list 解析即可
  }
  const { targets, unresolved } = resolveTargets(buildList, selection, aliases, grammarSources);
  if (unresolved.length) {
    console.warn(`[self-build] unresolved selection keys (skipped): ${JSON.stringify(unresolved)}`);
  }

  if (!detectTreeSitter(treeSitterBin, env)) {
    const failures = targets.map((e) => ({
      name: e.name,
      subpath: e.subpath,
      reason: 'tree-sitter CLI not available',
    }));
    fs.mkdirSync(path.dirname(failureOut), { recursive: true });
    fs.writeFileSync(failureOut, JSON.stringify(failures, null, 2) + '\n');
    console.warn(
      `[self-build] tree-sitter CLI not available: ${failures.length} grammars recorded to ${failureOut}, nothing built`,
    );
    return { mode: 'failure', failures };
  }

  fs.mkdirSync(outDir, { recursive: true });
  const failures = [];
  const vendoredFiles = listVendoredPrebuilts(vendoredDir);
  const vendoredNames = new Set([...vendoredFiles.keys()].filter((n) => targets.some((t) => t.name === n)));
  let built = 0;
  let vendored = 0;
  let skipped = 0;
  let cursor = 0;
  async function worker() {
    for (;;) {
      const i = cursor++;
      if (i >= targets.length) return;
      const entry = targets[i];
      const outFile = path.join(outDir, `${entry.name}.wasm`);
      if (!force && fs.existsSync(outFile)) {
        skipped++;
        continue;
      }
      // vendored 短路：不可再生语言直接拷贝遗留产物
      const vendoredSrc = vendoredFiles.get(entry.name);
      if (vendoredSrc) {
        fs.copyFileSync(vendoredSrc, outFile);
        vendored++;
        continue;
      }
      const srcDir = path.join(grammarsDir, entry.name, entry.subpath);
      if (!fs.existsSync(path.join(srcDir, 'src', 'parser.c'))) {
        failures.push({
          name: entry.name,
          subpath: entry.subpath,
          reason: `parser.c not found under ${srcDir}/src（先跑 --fetch？）`,
        });
        continue;
      }
      ensureTreeSitterConfig(srcDir, entry.name);
      try {
        await execFile(treeSitterBin, ['build', '--wasm', '--output', outFile, '.'], {
          cwd: srcDir,
          encoding: 'utf8',
          timeout: 600_000,
          maxBuffer: 4 * 1024 * 1024,
          env,
        });
        built++;
        const bytes = fs.statSync(outFile).size;
        if (bytes > WARN_FILE_BYTES) {
          console.warn(`[self-build] ${entry.name}.wasm ${(bytes / 1024 / 1024).toFixed(1)}MB > 8MB（仅告警）`);
        }
      } catch (err) {
        // cli 的符号检查在写产物之后才做，失败会留下坏产物——删除避免污染 skip-if-exists 缓存
        fs.rmSync(outFile, { force: true });
        const detail = String((err && (err.stderr || err.stdout)) || err?.message || err).trim().slice(-500);
        failures.push({ name: entry.name, subpath: entry.subpath, reason: detail || 'build failed' });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, targets.length)) }, worker));

  const manifest = writeManifest(outDir, manifestOut, aliases, vendoredNames);
  ensureRuntimeWasm(outDir);
  fs.mkdirSync(path.dirname(failureOut), { recursive: true });
  fs.writeFileSync(failureOut, JSON.stringify(failures, null, 2) + '\n');
  console.log(
    `[self-build] built ${built}, vendored ${vendored}, skipped(cached) ${skipped}, failed ${failures.length}; manifest ${Object.keys(manifest.grammars).length} entries -> ${manifestOut}`,
  );
  return { mode: 'built', built, vendored, skipped, failures, manifest };
}

/** 按 outDir 现存 *.wasm 全量重写 manifest（目录即事实源；aliases 从 aliases.json 兜底；
 *  vendoredNames 中的条目标 source: 'vendored'）。 */
export function writeManifest(outDir, manifestOut, aliases = loadAliases(), vendoredNames = new Set()) {
  const grammars = {};
  for (const f of fs.readdirSync(outDir).sort()) {
    if (!f.endsWith('.wasm')) continue;
    const lang = f.slice(0, -'.wasm'.length);
    grammars[lang] = {
      file: f,
      abi: null, // cli 构建产物按 grammar 自身 LANGUAGE_VERSION 定 ABI，运行时由 web-tree-sitter 加载校验兜底
      sha256: sha256File(path.join(outDir, f)),
      aliases: aliases[lang]?.aliases ?? [],
      ...(vendoredNames.has(lang) ? { source: 'vendored' } : {}),
    };
  }
  const manifest = {
    generatedAt: new Date().toISOString(),
    source: 'self-built',
    grammars,
  };
  fs.writeFileSync(manifestOut, JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

/**
 * web-tree-sitter 运行时 wasm（tree-sitter.wasm）就位到 static/ 根：runtime.test 与 dev
 * 服务器直接读文件系统，不经 vite（依赖版本由 packages/highlight 的 pnpm-lock 锁定）。
 */
export function ensureRuntimeWasm(outDir = PATHS.outDir) {
  // web-tree-sitter 的 exports 不含 ./package.json，从主入口（包根下的 .cjs）反推包目录
  const require = createRequire(path.join(repoRoot, 'packages/highlight/package.json'));
  const wtsDir = path.dirname(require.resolve('web-tree-sitter'));
  const dest = path.join(path.dirname(outDir), 'tree-sitter.wasm');
  fs.copyFileSync(path.join(wtsDir, 'tree-sitter.wasm'), dest);
  return dest;
}

// ---------- --fetch：grammar 源获取 ----------

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
 * 取数计划：解析后的目标（build-list 与/或 languages.toml 兜底条目）逐条 join sources。
 * 缺 git/rev 的记入 missing（fetch 前即知，CI 直接可见）。
 */
export function planFetch(targets, grammarSources) {
  const plan = [];
  const missing = [];
  for (const t of targets) {
    const src = grammarSources.get(t.name);
    if (!src) {
      missing.push({ name: t.name, reason: 'no [[grammar]] source (git/rev) in languages.toml' });
      continue;
    }
    plan.push({ name: t.name, subpath: t.subpath, git: src.git, rev: src.rev });
  }
  return { plan, missing };
}

/**
 * 构建前确保 tree-sitter.json 存在：cli 0.27 只在有该配置时编译并链接外置 scanner
 * （src/scanner.c|cc），缺失则产物缺 scanner 符号导致链接失败（yaml/vue/php 实测）。
 * 对没有配置的老 grammar 写最小 shim；符号名先按 name 的 -→_ 变换推导，并在 parser.c
 * 中校验（c-sharp → tree_sitter_c_sharp），推导失败退化为 parser.c 内首个符号匹配。
 */
export function ensureTreeSitterConfig(srcDir, name) {
  const configFile = path.join(srcDir, 'tree-sitter.json');
  if (fs.existsSync(configFile)) return 'existing';
  const srcDirPath = path.join(srcDir, 'src');
  const scanner = ['scanner.c', 'scanner.cc', 'scanner.cpp'].map((f) => path.join(srcDirPath, f)).find((f) => fs.existsSync(f));
  if (!scanner) return 'not-needed'; // 纯 parser.c 无需配置
  const parserC = fs.readFileSync(path.join(srcDirPath, 'parser.c'), 'utf8');
  let symbol = name.replace(/-/g, '_');
  if (!parserC.includes(`tree_sitter_${symbol}`)) {
    const m = /tree_sitter_[a-z0-9_]+\s*\(/.exec(parserC);
    if (!m) return 'symbol-not-found';
    symbol = m[0].replace(/\s*\($/, '');
  }
  const config = { grammars: [{ name: symbol, path: '.' }] };
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n');
  return 'shimmed';
}

/** 单仓浅取：init → remote add → fetch --depth 1 <rev>（服务端按 SHA 取，GitHub/Codeberg 支持）
 *  → checkout FETCH_HEAD → 拷贝整仓树（滤 .git，判据 <subpath>/src/parser.c）到 outDir/<name>/。
 *  整仓拷贝保留仓库内布局（typescript/tsx/ocaml 的 scanner include 仓库根 common/scanner.h）。
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
  await fs.promises.rm(path.join(outDir, entry.name), { recursive: true, force: true });
  await fs.promises.mkdir(outDir, { recursive: true });
  await fs.promises.cp(dst, path.join(outDir, entry.name), {
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
  outDir = PATHS.grammarsDir,
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

export async function main(argv = process.argv.slice(2)) {
  const languagesFlag = (() => {
    const i = argv.indexOf('--languages');
    if (i === -1) return null;
    const v = argv[i + 1];
    if (!v) throw new Error('--languages 需要逗号分隔的语言名');
    return v.split(',').map((s) => s.trim()).filter(Boolean);
  })();
  const selection = argv.includes('--all') ? 'all' : argv.includes('--lite') ? 'lite' : languagesFlag;
  if (argv.includes('--lite') && languagesFlag) throw new Error('--lite 与 --languages 互斥');

  if (argv.includes('--fetch')) {
    const buildList = JSON.parse(fs.readFileSync(PATHS.buildListJson, 'utf8')).filter((e) => e.parserCExists);
    const grammarSources = parseGrammarSources(fs.readFileSync(PATHS.languagesToml, 'utf8'));
    const { targets, unresolved } = resolveTargets(buildList, selection ?? 'all', loadAliases(), grammarSources);
    if (unresolved.length) console.warn(`[fetch] unresolved selection keys (skipped): ${JSON.stringify(unresolved)}`);
    const { plan, missing } = planFetch(targets, grammarSources);
    const { fetched, skipped, failures } = await fetchGrammarSources({ plan });
    console.log(`[fetch] planned ${plan.length}, fetched ${fetched}, skipped(cached) ${skipped}, failed ${failures.length}`);
    if (missing.length) console.warn(`[fetch] missing source: ${JSON.stringify(missing)}`);
    if (failures.length) console.warn(`[fetch] failures -> ${PATHS.fetchFailuresOut}: ${JSON.stringify(failures.map((f) => f.name))}`);
    return { fetched, skipped, failures, missing };
  }
  if (argv.includes('--self-build')) {
    return selfBuild({ selection: selection ?? 'lite', force: argv.includes('--force') });
  }
  console.error('usage: node build.mjs --fetch [--lite|--languages x,y] | --self-build [--all|--languages x,y] [--force]');
  return process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
