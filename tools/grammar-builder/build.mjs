#!/usr/bin/env node
// grammar wasm 资产构建器，两种模式：
//   --from-wasms   主路径：从 node_modules/tree-sitter-wasms/out 按 aliases.json 映射拷贝到
//                  apps/web/static/grammars/{helixLangName}.wasm，计算 sha256 并写 manifest.json。
//                  单文件 >8MB 跳过；总入库量上限 80MB（aliases.json 顺序 = 高频优先，超限截断）。
//   --self-build   备用路径：对 build-list.json 逐个 `tree-sitter build --wasm`。
//                  emcc 缺失时整批不执行，写 out/failure-list.json（reason: emcc not available）并 exit 0。
// 用法：node tools/grammar-builder/build.mjs [--from-wasms|--self-build]
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');

export const PATHS = {
  aliasesJson: path.join(here, 'aliases.json'),
  buildListJson: path.join(here, 'build-list.json'),
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
 */
export function selfBuild({
  emcc = detectEmcc(),
  buildListJson = PATHS.buildListJson,
  grammarsDir = PATHS.grammarsDir,
  outDir = PATHS.outDir,
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

export function main(argv = process.argv.slice(2)) {
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
  console.error('usage: node build.mjs --from-wasms | --self-build');
  return process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
