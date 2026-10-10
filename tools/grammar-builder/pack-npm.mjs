#!/usr/bin/env node
// npm 单包打包器（阶段 2 资产链，spec §3）：把构建产物重排为可发布的 npm 包布局——
//   outDir/package.json            包元数据（name/version/files/license/description/repository）
//   outDir/grammars/manifest.json  grammar 清单（移入 grammars/，与 *.wasm 同目录）
//   outDir/grammars/*.wasm         wasm 全集（逐字节拷贝）
//   outDir/queries/<lang>/*.scm    查询资产（整目录拷贝，仅供独立消费；客户端不从 CDN 取 queries）
//   outDir/GRAMMAR_LICENSES.md     许可证聚合随包附带（npm 是第三方分发主通道，license 字段
//                                  'SEE LICENSE IN GRAMMAR_LICENSES.md' 指向的文件必须在包内；
//                                  源 = 仓库根 server/GRAMMAR_LICENSES.md，gen-licenses.mjs 产物，
//                                  打包前置——缺失即抛错）
//   package.json.contentHash       打包内容确定性哈希（wasm+queries+license；manifest 剔除
//                                  generatedAt 后归一纳入；版本号不参与）——publish 门据此
//                                  跳过零变化发包：内容不变时复用已发布版本，CDN URL 稳定
// 布局契约（控制台裁决 2026-10-09，ledger「布局契约统一」条，绑定）：客户端 manifest URL =
// `${base}manifest.json`、wasm URL = `${base}${file}` 同 base（grammarLayers.ts 装配），
// 因此 manifest 必须与 wasm 同目录。manifest 条目注 base: './'（同目录相对）——客户端消费时
// layer.base 覆写条目 base，此字段仅包独立消费（node_modules 直读）可读。
// 用法（Task 5 publish job；本地示例见下）：
//   VV_NPM_PACKAGE_NAME=@scope/vviewer-grammars-full \
//   VV_NPM_PACKAGE_VERSION=0.0.0 VV_NPM_OUT=/tmp/dist-npm node tools/grammar-builder/pack-npm.mjs
// 输入路径可覆写：VV_GRAMMARS_OUT（默认 apps/web/static/grammars，与 build.mjs 同名同义）、
// VV_QUERIES_DIR（默认 packages/highlight/assets/queries）。outDir 应指向空目录（脚本不清理既有内容）。
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');

/** npm files 白名单：queries 仅供独立消费，客户端不取；license 聚合随包（分发义务） */
export const NPM_FILES_FIELD = ['grammars', 'queries', 'GRAMMAR_LICENSES.md'];

/** manifest 条目 base：与 manifest 同目录的相对前缀（布局契约见文件头） */
export const MANIFEST_ENTRY_BASE = './';

/** 按 env 解析输入/输出路径（与 build.mjs 的 env 名对齐；main(env) 可注入测试） */
export function resolvePathsFrom(env = process.env) {
  return {
    grammarsDir: env.VV_GRAMMARS_OUT ?? path.join(repoRoot, 'apps/web/static/grammars'),
    queriesDir: env.VV_QUERIES_DIR ?? path.join(repoRoot, 'packages/highlight/assets/queries'),
    outDir: env.VV_NPM_OUT,
    repoPkgJson: path.join(repoRoot, 'package.json'),
    licenseFile: path.join(repoRoot, 'server/GRAMMAR_LICENSES.md'),
  };
}

/** 根 package.json 的 repository 字段（string 或 {url} 形态归一为 string；缺失返回 null） */
function readRepository(pkgJsonPath) {
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
  } catch {
    return null;
  }
  const r = pkg.repository;
  if (typeof r === 'string') return r;
  if (r && typeof r.url === 'string') return r.url;
  return null;
}

/** 递归收集文件（相对稳定序），返回 [{ file, bytes }] */
function walkFiles(dir) {
  const out = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkFiles(p));
    else out.push({ file: p, bytes: fs.statSync(p).size });
  }
  return out;
}

/**
 * 打包内容确定性哈希（sha256 前 16 hex）：wasm 字节 + 查询树 + license 全参与；
 * package.json（含版本号）不参与；grammars/manifest.json 以归一化形态纳入——
 * 剔除 generatedAt 时间戳（唯一跨构建非稳定字段），键按字典序重排。同内容
 * 跨构建/跨版本哈希稳定，publish 门据此跳过零变化发包（阶段 4 终审后裁决）。
 */
function contentHashOf(outDir) {
  const h = createHash('sha256');
  const files = walkFiles(outDir)
    .map((f) => ({ file: f.file, rel: path.relative(outDir, f.file).split(path.sep).join('/') }))
    .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  for (const f of files) {
    if (f.rel === 'package.json' || f.rel === 'grammars/manifest.json') continue;
    h.update(f.rel);
    h.update('\0');
    h.update(fs.readFileSync(f.file));
    h.update('\0');
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(outDir, 'grammars', 'manifest.json'), 'utf8'));
  delete manifest.generatedAt;
  h.update('grammars/manifest.json');
  h.update('\0');
  h.update(JSON.stringify(manifest, Object.keys(manifest).sort()));
  h.update('\0');
  return h.digest('hex').slice(0, 16);
}

/**
 * 组装 npm 包布局。返回 { files, bytes }——files/bytes 覆盖包内全部文件
 * （package.json + grammars + queries + GRAMMAR_LICENSES.md），Task 5 publish job
 * 用于发布日志。残包拦截：grammarsDir 缺失/无 wasm/manifest 缺失/manifest 引用悬空/
 * queriesDir 缺失/license 文件缺失/name|version|outDir 缺失，任一命中即抛错
 * （publish 前即失败，不产出不完整包）。
 */
export function packNpm({
  grammarsDir,
  queriesDir,
  outDir,
  name,
  version,
  repoPkgJson = resolvePathsFrom().repoPkgJson,
  licenseFile = resolvePathsFrom().licenseFile,
}) {
  if (!grammarsDir || !fs.existsSync(grammarsDir)) throw new Error(`packNpm: grammarsDir 不存在: ${grammarsDir}`);
  const wasmFiles = fs.readdirSync(grammarsDir).filter((f) => f.endsWith('.wasm')).sort();
  if (!wasmFiles.length) throw new Error(`packNpm: grammarsDir 无 *.wasm: ${grammarsDir}`);
  const manifestIn = path.join(grammarsDir, 'manifest.json');
  if (!fs.existsSync(manifestIn)) throw new Error(`packNpm: manifest.json 缺失: ${manifestIn}（先跑 build.mjs --self-build？）`);
  const manifest = JSON.parse(fs.readFileSync(manifestIn, 'utf8'));
  const manifestEntries = manifest.grammars ?? {};
  const dangling = Object.values(manifestEntries).map((e) => e.file).filter((f) => !wasmFiles.includes(f));
  if (dangling.length) throw new Error(`packNpm: manifest 引用的 wasm 缺失: ${dangling.join(', ')}（清单与目录不一致）`);
  if (!queriesDir || !fs.existsSync(queriesDir)) throw new Error(`packNpm: queriesDir 不存在: ${queriesDir}`);
  // license 聚合是打包前置（SEE LICENSE IN 指向必须随包）
  if (!licenseFile || !fs.existsSync(licenseFile)) {
    throw new Error(`packNpm: GRAMMAR_LICENSES.md 缺失: ${licenseFile}（先跑 gen-licenses.mjs？）`);
  }
  if (!outDir) throw new Error('packNpm: outDir 必填');
  if (!name || !version) throw new Error('packNpm: name 与 version 必填');

  fs.mkdirSync(outDir, { recursive: true });
  const pkgGrammars = path.join(outDir, 'grammars');
  fs.mkdirSync(pkgGrammars, { recursive: true });
  for (const f of wasmFiles) fs.copyFileSync(path.join(grammarsDir, f), path.join(pkgGrammars, f));
  // manifest 移入 grammars/（与 wasm 同目录）并逐条注入 base；顶层元数据原样保留
  const packedManifest = {
    ...manifest,
    grammars: Object.fromEntries(Object.entries(manifestEntries).map(([lang, e]) => [lang, { ...e, base: MANIFEST_ENTRY_BASE }])),
  };
  const manifestOut = path.join(pkgGrammars, 'manifest.json');
  fs.writeFileSync(manifestOut, JSON.stringify(packedManifest, null, 2) + '\n');
  fs.cpSync(queriesDir, path.join(outDir, 'queries'), { recursive: true });
  fs.copyFileSync(licenseFile, path.join(outDir, 'GRAMMAR_LICENSES.md'));

  const repository = readRepository(repoPkgJson);
  const contentHash = contentHashOf(outDir);
  const pkg = {
    name,
    version,
    private: false,
    files: [...NPM_FILES_FIELD],
    ...(repository ? { repository } : {}),
    license: 'SEE LICENSE IN GRAMMAR_LICENSES.md',
    description: 'vviewer grammar wasm 全量资产（自建，manifest+queries）',
    contentHash,
  };
  fs.writeFileSync(path.join(outDir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');

  const files = walkFiles(outDir);
  const bytes = files.reduce((s, f) => s + f.bytes, 0);
  return { files: files.length, bytes, contentHash };
}

export async function main(env = process.env) {
  const required = [
    ['VV_NPM_PACKAGE_NAME', env.VV_NPM_PACKAGE_NAME],
    ['VV_NPM_PACKAGE_VERSION', env.VV_NPM_PACKAGE_VERSION],
    ['VV_NPM_OUT', env.VV_NPM_OUT],
  ];
  const missing = required.filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    throw new Error(
      `pack-npm: 缺少环境变量 ${missing.join(', ')}（publish job 设置）。` +
        `本地示例：VV_NPM_PACKAGE_NAME=@scope/vviewer-grammars-full VV_NPM_PACKAGE_VERSION=0.0.0 ` +
        `VV_NPM_OUT=/tmp/dist-npm node tools/grammar-builder/pack-npm.mjs`,
    );
  }
  const paths = resolvePathsFrom(env);
  const r = packNpm({ ...paths, name: env.VV_NPM_PACKAGE_NAME, version: env.VV_NPM_PACKAGE_VERSION });
  console.log(
    `[pack-npm] ${r.files} files, ${(r.bytes / 1024 / 1024).toFixed(1)}MB -> ${paths.outDir}` +
      ` (${env.VV_NPM_PACKAGE_NAME}@${env.VV_NPM_PACKAGE_VERSION}) contentHash=${r.contentHash}`,
  );
  return r;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
