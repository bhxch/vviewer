#!/usr/bin/env node
// npm 打包器（阶段 2 资产链，spec §3；spec C 2026-11-14 增拆分模式）：把构建产物重排为可发布的
// npm 包布局——
//   outDir/package.json            包元数据（name/version/files/license/description/repository）
//   outDir/grammars/manifest.json  grammar 清单（移入 grammars/，与 *.wasm 同目录）
//   outDir/grammars/*.wasm         wasm 全集（逐字节拷贝）
//   outDir/queries/<lang>/*.scm    查询资产（仅 .scm 拷贝，仅供独立消费；客户端不从 CDN 取 queries）
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
// 拆分模式（spec C：jsdelivr 按包 150MB 准入 403 → 体积均衡拆子包 p1..pN，每包 ≤50MB）：
//   VV_NPM_PACKAGE_NAME=@scope/vviewer-grammars-full VV_NPM_SPLIT=1 \
//   VV_NPM_PACKAGE_VERSION=0.0.0 VV_NPM_OUT=/tmp/dist-npm node tools/grammar-builder/pack-npm.mjs
//   （VV_NPM_SPLIT_LIMIT_MB 覆写每包门禁 MB 供测试/演练；缺省 50）
//   子包落 outDir/p1..pN/，包名 `${name}-p${i}`（i 从 1）；语言条目与其 wasm、queries/<lang>/
//   恒落同一子包（queries 跟随语言所在子包）；装箱 = first-fit-decreasing 体积均衡。
//   门禁两段（spec C 拍板）：①单件前提——单语言载荷（wasm+queries）> 每包门禁即整体抛错
//   （不产任何包，独占成包照样破镜像站低准入线）；②装箱门禁——每包解包总字节
//   （wasm+queries+manifest+license+README）≤ 每包门禁，写盘后实走复核。
// 输入路径可覆写：VV_GRAMMARS_OUT（默认 apps/web/static/grammars，与 build.mjs 同名同义）、
// VV_QUERIES_DIR（默认 packages/vviewer-highlight/assets/queries）。outDir 应指向空目录（脚本不清理既有内容；
// 已含打包产物时 fail-fast 拒跑——ledger H8；拆分模式对根目录按含 p* 子目录同口径拒跑）。
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

/** 拆分模式每包解包体积门禁缺省：50MB（spec C 2026-11-14 拍板——jsdelivr 150MB 之外镜像站可能限制更低，50MB 留 3 倍余量） */
export const DEFAULT_PACK_LIMIT_BYTES = 50 * 1024 * 1024;

/** 按 env 解析输入/输出路径（与 build.mjs 的 env 名对齐；main(env) 可注入测试） */
export function resolvePathsFrom(env = process.env) {
  return {
    grammarsDir: env.VV_GRAMMARS_OUT ?? path.join(repoRoot, 'apps/web/static/grammars'),
    queriesDir: env.VV_QUERIES_DIR ?? path.join(repoRoot, 'packages/vviewer-highlight/assets/queries'),
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
 * 只读输入探测：packNpm / packNpmSplit 共享的校验与 manifest 读取（不写任何盘）。
 * 错误语义与消息与单包同源同序（grammarsDir → 无 wasm → manifest → 引用悬空 → queriesDir → license）。
 */
function probeInputs({ grammarsDir, queriesDir, licenseFile }) {
  if (!grammarsDir || !fs.existsSync(grammarsDir)) throw new Error(`packNpm: grammarsDir 不存在: ${grammarsDir}`);
  const allWasmFiles = fs.readdirSync(grammarsDir).filter((f) => f.endsWith('.wasm')).sort();
  if (!allWasmFiles.length) throw new Error(`packNpm: grammarsDir 无 *.wasm: ${grammarsDir}`);
  const manifestIn = path.join(grammarsDir, 'manifest.json');
  if (!fs.existsSync(manifestIn)) throw new Error(`packNpm: manifest.json 缺失: ${manifestIn}（先跑 build.mjs --self-build？）`);
  const manifest = JSON.parse(fs.readFileSync(manifestIn, 'utf8'));
  const manifestEntries = manifest.grammars ?? {};
  const dangling = Object.values(manifestEntries).map((e) => e.file).filter((f) => !allWasmFiles.includes(f));
  if (dangling.length) throw new Error(`packNpm: manifest 引用的 wasm 缺失: ${dangling.join(', ')}（清单与目录不一致）`);
  if (!queriesDir || !fs.existsSync(queriesDir)) throw new Error(`packNpm: queriesDir 不存在: ${queriesDir}`);
  // license 聚合是打包前置（SEE LICENSE IN 指向必须随包）
  if (!licenseFile || !fs.existsSync(licenseFile)) {
    throw new Error(`packNpm: GRAMMAR_LICENSES.md 缺失: ${licenseFile}（先跑 gen-licenses.mjs？）`);
  }
  return { allWasmFiles, manifest, manifestEntries };
}

/**
 * 布局组装核：packNpm（全量）与 packNpmSplit（语言子集）共用，抽公共函数不复制实现。
 * langs: undefined = 全量（单包语义逐字节不变）；Set = 语言子集（拆分子包——仅本包 wasm +
 * queries/<lang>/ 目录 + manifest 本包条目；语言条目与其 wasm/queries 恒同包）。
 * 返回 { files, bytes, contentHash }——files/bytes 覆盖包内全部文件，Task 5 publish job 用于发布日志。
 * 残包拦截：grammarsDir 缺失/无 wasm/manifest 缺失/manifest 引用悬空/queriesDir 缺失/
 * license 文件缺失/name|version|outDir 缺失/装箱语言不在 manifest 中，任一命中即抛错
 * （publish 前即失败，不产出不完整包）。
 */
function packNpmCore({
  grammarsDir,
  queriesDir,
  outDir,
  name,
  version,
  repoPkgJson = resolvePathsFrom().repoPkgJson,
  licenseFile = resolvePathsFrom().licenseFile,
  langs,
  description,
}) {
  const { allWasmFiles, manifest, manifestEntries } = probeInputs({ grammarsDir, queriesDir, licenseFile });
  if (!outDir) throw new Error('packNpm: outDir 必填');
  if (!name || !version) throw new Error('packNpm: name 与 version 必填');
  // outDir fail-fast（ledger H8）：已含打包产物（上次运行的 package.json）时拒跑——
  // 脚本不清理既有内容，陈旧混包（新旧 wasm/queries 混杂）是最危险的失败形态
  if (fs.existsSync(path.join(outDir, 'package.json'))) {
    throw new Error(`packNpm: outDir 非空（已含打包产物）：请清空或换目录: ${outDir}`);
  }
  const selectedEntries = langs
    ? Object.fromEntries(Object.entries(manifestEntries).filter(([lang]) => langs.has(lang)))
    : manifestEntries;
  if (langs) {
    const missing = [...langs].filter((lang) => !manifestEntries[lang]);
    if (missing.length) throw new Error(`packNpm: 装箱语言不在 manifest 中: ${missing.join(', ')}（装箱单与清单不一致）`);
  }
  const selectedWasm = new Set(Object.values(selectedEntries).map((e) => e.file));
  const wasmFiles = langs ? allWasmFiles.filter((f) => selectedWasm.has(f)) : allWasmFiles;

  fs.mkdirSync(outDir, { recursive: true });
  const pkgGrammars = path.join(outDir, 'grammars');
  fs.mkdirSync(pkgGrammars, { recursive: true });
  for (const f of wasmFiles) fs.copyFileSync(path.join(grammarsDir, f), path.join(pkgGrammars, f));
  // manifest 移入 grammars/（与 wasm 同目录）并逐条注入 base；顶层元数据原样保留；
  // 条目键序保持 manifest 原序（contentHashOf 归一化只重排顶层键，grammars 内序参与哈希）
  const packedManifest = {
    ...manifest,
    grammars: Object.fromEntries(Object.entries(selectedEntries).map(([lang, e]) => [lang, { ...e, base: MANIFEST_ENTRY_BASE }])),
  };
  const manifestOut = path.join(pkgGrammars, 'manifest.json');
  fs.writeFileSync(manifestOut, JSON.stringify(packedManifest, null, 2) + '\n');
  // queries 拷贝：仅 .scm（ledger H8——queries/ 混入的非 scm 资产不进包）；目录层级保持。
  // 单包=全量树；拆分=仅本包语言目录逐个拷（queries 跟随语言所在子包；无 queries 目录的语言合法跳过）
  const scmFilter = (src) => fs.statSync(src).isDirectory() || src.endsWith('.scm');
  if (langs) {
    for (const lang of [...langs].sort()) {
      const srcLang = path.join(queriesDir, lang);
      if (fs.existsSync(srcLang)) fs.cpSync(srcLang, path.join(outDir, 'queries', lang), { recursive: true, filter: scmFilter });
    }
  } else {
    fs.cpSync(queriesDir, path.join(outDir, 'queries'), { recursive: true, filter: scmFilter });
  }
  fs.copyFileSync(licenseFile, path.join(outDir, 'GRAMMAR_LICENSES.md'));

  // README（npm 页）：包级说明（布局契约/CDN 引用/配套运行时），源 GRAMMARS-NPM-README.md。
  // 参与内容哈希——README 变更即触发该包随 tag 发新版本（与 pack-packages 同口径）。
  fs.copyFileSync(path.join(here, 'GRAMMARS-NPM-README.md'), path.join(outDir, 'README.md'));

  const repository = readRepository(repoPkgJson);
  const contentHash = contentHashOf(outDir);
  const pkg = {
    name,
    version,
    private: false,
    files: [...NPM_FILES_FIELD],
    ...(repository ? { repository } : {}),
    license: 'SEE LICENSE IN GRAMMAR_LICENSES.md',
    description: description ?? 'vviewer grammar wasm 全量资产（自建，manifest+queries）',
    contentHash,
  };
  fs.writeFileSync(path.join(outDir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');

  const files = walkFiles(outDir);
  const bytes = files.reduce((s, f) => s + f.bytes, 0);
  return { files: files.length, bytes, contentHash };
}

/**
 * 单包打包（缺省模式，行为逐字节不变——Task 5 publish job 全量包沿用）。
 */
export function packNpm(opts) {
  return packNpmCore(opts);
}

/**
 * 拆分模式（spec C：jsdelivr 按包 150MB 准入 403 → 体积均衡拆子包恢复默认全球档可用）。
 * first-fit-decreasing 体积均衡装箱——按语言载荷（wasm + 其 queries 目录全部 .scm）降序
 * 逐语言放入首个能容纳的子包，放不下开新包（包数 N 最小化由 FFD 近似达成，不追求最优装箱
 * NP 完全解）。子包落 outDir/p<i>/，包名 `${name}-p${i}`（i 从 1），每包布局与单包契约同构。
 * 门禁两段（spec C 拍板）：
 *   ①单件前提——单语言载荷 > packLimitBytes 整体抛错（装箱前逐语言预检，fail-fast 不产任何包：
 *     独占成包放行即破门禁本意——门禁保护的是镜像站低准入线，60MB 独占包照样超限）；
 *   ②装箱门禁——每包解包总字节（wasm+queries+manifest+license+README）≤ packLimitBytes，
 *     写盘后实走复核（FFD 按载荷装箱不含包级固定开销，复核兜底硬门）。
 * 返回 [{ outDir, name, contentHash, bytes, langs }]（langs 字典序）。
 */
export function packNpmSplit({
  grammarsDir,
  queriesDir,
  outDir,
  name,
  version,
  repoPkgJson = resolvePathsFrom().repoPkgJson,
  licenseFile = resolvePathsFrom().licenseFile,
  packLimitBytes = DEFAULT_PACK_LIMIT_BYTES,
}) {
  if (!outDir) throw new Error('packNpmSplit: outDir 必填');
  if (!name || !version) throw new Error('packNpmSplit: name 与 version 必填');
  if (!Number.isFinite(packLimitBytes) || packLimitBytes <= 0) {
    throw new Error(`packNpmSplit: packLimitBytes 非法: ${packLimitBytes}`);
  }
  // 只读探测（不写盘——门禁第 1 段预检失败即零产物）
  const { allWasmFiles, manifest, manifestEntries } = probeInputs({ grammarsDir, queriesDir, licenseFile });
  // 拆分按 manifest 键装箱：目录含 manifest 未引用的 wasm 时拒绝（静默丢弃即残包；单包模式照旧全量拷入）
  const referenced = new Set(Object.values(manifestEntries).map((e) => e.file));
  const unref = allWasmFiles.filter((f) => !referenced.has(f));
  if (unref.length) {
    throw new Error(`packNpmSplit: 目录含 manifest 未引用的 wasm: ${unref.join(', ')}（拆分按 manifest 键装箱，静默丢弃即残包）`);
  }
  // 语言载荷 = wasm 字节 + 该语言 queries 目录全部 .scm 字节（queries 跟随语言所在子包）
  const items = Object.entries(manifestEntries)
    .map(([lang, e]) => {
      const wasmBytes = fs.statSync(path.join(grammarsDir, e.file)).size;
      let queriesBytes = 0;
      const qDir = path.join(queriesDir, lang);
      if (fs.existsSync(qDir)) {
        for (const f of walkFiles(qDir)) if (f.file.endsWith('.scm')) queriesBytes += f.bytes;
      }
      return { lang, load: wasmBytes + queriesBytes };
    })
    .sort((a, b) => (a.load !== b.load ? b.load - a.load : a.lang < b.lang ? -1 : 1));
  if (!items.length) throw new Error('packNpmSplit: manifest 无语言条目，无可装箱内容');
  const mb = (n) => `${(n / 1024 / 1024).toFixed(1)}MB`;
  // 门禁第 1 段：单语言载荷 > packLimitBytes 整体抛错（不产任何包）
  for (const it of items) {
    if (it.load > packLimitBytes) {
      throw new Error(
        `packNpmSplit: 单语言载荷超限（门禁第 1 段）：${it.lang} 载荷 ${mb(it.load)} > 每包门禁 ${mb(packLimitBytes)}` +
          `——独占成包仍破镜像站准入线，fail-fast 不产任何包`,
      );
    }
  }
  // first-fit-decreasing：载荷降序放入首个能容纳的子包（bin.used 初值含包级固定开销——license+README+manifest 顶层
  // 每包一份，计入预算使均衡更贴近真实解包体积；manifest 条目字节随语言数小幅增长，由写盘后复核兜底）
  const overhead =
    fs.statSync(licenseFile).size +
    fs.statSync(path.join(here, 'GRAMMARS-NPM-README.md')).size +
    JSON.stringify({ ...manifest, grammars: {} }).length;
  const bins = [];
  for (const it of items) {
    const bin = bins.find((b) => b.used + it.load <= packLimitBytes);
    if (bin) {
      bin.langs.push(it.lang);
      bin.used += it.load;
    } else {
      bins.push({ langs: [it.lang], used: overhead + it.load });
    }
  }
  // outDir fail-fast（ledger H8 拆分同口径）：根目录已含拆分子包（p* 目录）或单包产物时拒跑——
  // 脚本不清理既有内容，陈旧混包（新旧子包混杂/子包与单包混杂）是最危险的失败形态
  if (fs.existsSync(outDir)) {
    const stalePacks = fs.readdirSync(outDir).filter((n) => /^p\d+$/.test(n));
    if (stalePacks.length) {
      throw new Error(`packNpmSplit: outDir 非空（已含拆分子包 ${stalePacks.sort().join(', ')}）：请清空或换目录: ${outDir}`);
    }
    if (fs.existsSync(path.join(outDir, 'package.json'))) {
      throw new Error(`packNpmSplit: outDir 非空（已含单包打包产物）：请清空或换目录: ${outDir}`);
    }
  }
  // 逐包组装：每包独立跑 packNpmCore 尾段（布局组装/哈希逻辑复用不复制）
  const results = [];
  for (const [i, bin] of bins.entries()) {
    const subName = `${name}-p${i + 1}`;
    const subOut = path.join(outDir, `p${i + 1}`);
    const r = packNpmCore({
      grammarsDir,
      queriesDir,
      outDir: subOut,
      name: subName,
      version,
      repoPkgJson,
      licenseFile,
      langs: new Set(bin.langs),
      description: `vviewer grammar wasm 拆分子包 ${i + 1}/${bins.length}（体积均衡装箱，manifest+queries）`,
    });
    results.push({ outDir: subOut, name: subName, contentHash: r.contentHash, bytes: r.bytes, langs: [...bin.langs].sort() });
  }
  // 门禁第 2 段：每包解包总字节（wasm+queries+manifest+license+README；package.json 元数据不在
  // 门禁口径）≤ packLimitBytes——写盘后实走复核（FFD 预算不含 manifest 条目字节增长，此处兜底硬门）
  for (const [i, bin] of bins.entries()) {
    const subOut = path.join(outDir, `p${i + 1}`);
    const packedTotal = walkFiles(subOut).reduce(
      (s, f) => (path.relative(subOut, f.file) === 'package.json' ? s : s + f.bytes),
      0,
    );
    if (packedTotal > packLimitBytes) {
      throw new Error(
        `packNpmSplit: 装箱门禁超限（第 2 段）：p${i + 1}（${bin.langs.join(', ')}）解包 ${mb(packedTotal)} > 每包门禁 ${mb(packLimitBytes)}`,
      );
    }
  }
  return results;
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
  // 拆分模式（spec C）：VV_NPM_SPLIT=1 → packNpmSplit 产 outDir/p1..pN 子包集；
  // VV_NPM_SPLIT_LIMIT_MB 覆写每包门禁 MB（缺省 50）。返回拆分结果数组（逐包 name/contentHash/langs）。
  if (env.VV_NPM_SPLIT === '1') {
    let packLimitBytes;
    if (env.VV_NPM_SPLIT_LIMIT_MB != null && env.VV_NPM_SPLIT_LIMIT_MB !== '') {
      const mbNum = Number(env.VV_NPM_SPLIT_LIMIT_MB);
      if (!Number.isFinite(mbNum) || mbNum <= 0) throw new Error(`pack-npm: VV_NPM_SPLIT_LIMIT_MB 非法: ${env.VV_NPM_SPLIT_LIMIT_MB}`);
      packLimitBytes = mbNum * 1024 * 1024;
    }
    const results = packNpmSplit({
      ...paths,
      name: env.VV_NPM_PACKAGE_NAME,
      version: env.VV_NPM_PACKAGE_VERSION,
      ...(packLimitBytes !== undefined ? { packLimitBytes } : {}),
    });
    for (const r of results) {
      console.log(
        `[pack-npm] split ${r.name}: ${r.langs.length} langs -> ${r.outDir}` +
          ` (${r.name}@${env.VV_NPM_PACKAGE_VERSION}) contentHash=${r.contentHash}`,
      );
    }
    console.log(`[pack-npm] split 完成：${results.length} 包 -> ${paths.outDir}`);
    return results;
  }
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
