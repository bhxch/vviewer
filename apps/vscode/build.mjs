// build.mjs — 扩展构建编排（spec H T1）。
//
// 产物（apps/vscode/dist/ 同时是 .vsix 的打包根）：
// - extension.js        host bundle（CJS，vscode 为 external）
// - webview/main.js     webview bundle（ESM + code splitting，chunk-*.js 同目录）
// - webview/highlight-worker.js  tree-sitter 高亮 worker（IIFE 自包含，blob worker 前提）
// - webview/binary-worker.js     hex 解析 worker（IIFE 自包含）
// - webview/pdf/*.mjs   pdfjs worker 双分支（modern/legacy，按能力选支消费）
// - webview/katex.min.css + fonts/  katex 排印样式与字体
// - webview/assets/     grammar lite 集 / queries / tree-sitter.wasm / themes.json
// - package.json        VSIX manifest（name 去 scope、main 重写、selector 实跑生成）
// - .vscodeignore       构建脚本写出（vsce 从**包根**读——放源侧即死资产）
// - README.md / LICENSE / CHANGELOG.md / media/icon.png  vsce 要求项与图标
//
// 门禁（构建内 fail-fast）：
// - 无未解析 import（metafile 扫描，唯一豁免 = host bundle 的 vscode）
// - dist/ 递归字节 <100MB 预检
// - vsce package 实包 .vsix 字节 <100MB（vsce 三条硬校验随之实跑）

import esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { collectAssets } from './scripts/collect-assets.mjs';
import {
  assertGeneratedExtensions,
  buildVsixManifest,
  readSourceManifest,
  runRegistryCollection
} from './scripts/gen-manifest.mjs';
import { assertUnderLimit, dirSize } from './scripts/check-size.mjs';
import {
  katexCssStubPlugin,
  nodeBuiltinStubPlugin,
  svgbobStubPlugin
} from './scripts/build-plugins.mjs';
import { findUnresolvedImports } from './scripts/check-unresolved-imports.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** 仓库根（apps/vscode → 上溯两级） */
const REPO_ROOT = path.resolve(HERE, '..', '..');
const APP_DIR = HERE;
const DIST_DIR = path.join(APP_DIR, 'dist');
const WEBVIEW_DIR = path.join(DIST_DIR, 'webview');
const OUT_DIR = path.join(APP_DIR, 'out');
const CACHE_DIR = path.join(OUT_DIR, 'build-cache');

/** 体积门（spec §5：.vsix 实包字节 <100MB） */
export const SIZE_LIMIT_BYTES = 100 * 1024 * 1024;


/** 合并多份 metafile（供未解析 import 门扫描） */
function mergeMetafiles(parts) {
  const outputs = {};
  const inputs = {};
  for (const part of parts) {
    Object.assign(outputs, part.outputs);
    Object.assign(inputs, part.inputs);
  }
  return { inputs, outputs };
}

/** 构建四个 bundle */
async function buildBundles() {
  const metafiles = [];

  // host bundle（CJS；vscode 为唯一 external）
  const host = await esbuild.build({
    entryPoints: [path.join(APP_DIR, 'src/extension.ts')],
    outfile: path.join(DIST_DIR, 'extension.js'),
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    external: ['vscode'],
    metafile: true,
    logLevel: 'warning',
    plugins: [svgbobStubPlugin]
  });
  metafiles.push(host.metafile);

  // webview bundle（ESM + code splitting：mermaid/katex/pdfjs 动态 chunk 按需取）
  const webview = await esbuild.build({
    entryPoints: [path.join(APP_DIR, 'src/webview/main.ts')],
    outdir: WEBVIEW_DIR,
    entryNames: '[name]',
    chunkNames: 'chunk-[hash]',
    assetNames: 'asset-[hash]',
    bundle: true,
    format: 'esm',
    splitting: true,
    platform: 'browser',
    target: 'es2022',
    metafile: true,
    logLevel: 'warning',
    plugins: [svgbobStubPlugin, katexCssStubPlugin, nodeBuiltinStubPlugin]
  });
  metafiles.push(webview.metafile);

  // tree-sitter 高亮 worker（IIFE 自包含——blob worker 无 import 解析能力）
  const highlightWorker = await esbuild.build({
    entryPoints: [path.join(APP_DIR, 'src/webview/highlightWorker.ts')],
    outfile: path.join(WEBVIEW_DIR, 'highlight-worker.js'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    metafile: true,
    logLevel: 'warning',
    plugins: [svgbobStubPlugin, nodeBuiltinStubPlugin]
  });
  metafiles.push(highlightWorker.metafile);

  // hex 解析 worker（IIFE 自包含）
  const binaryWorker = await esbuild.build({
    entryPoints: [
      path.join(REPO_ROOT, 'packages/vviewer-render-binary/src/binary.worker.ts')
    ],
    outfile: path.join(WEBVIEW_DIR, 'binary-worker.js'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    metafile: true,
    logLevel: 'warning',
    plugins: [nodeBuiltinStubPlugin]
  });
  metafiles.push(binaryWorker.metafile);

  return mergeMetafiles(metafiles);
}

/** 复制 vsce 要求项与图标进打包根 */
function copyPackagingFiles() {
  // nls 文件随包走：打包根的 package.json 保留 %key% 占位（VSCode 客户端按 locale
  // 替换）→ package.nls.json（源语言/缺省）+ package.nls.zh-cn.json（中文）须在包内。
  for (const name of ['README.md', 'LICENSE', 'CHANGELOG.md', 'package.nls.json', 'package.nls.zh-cn.json']) {
    fs.copyFileSync(path.join(APP_DIR, name), path.join(DIST_DIR, name));
  }
}

/** 写 dist/.vscodeignore（vsce 从包根读——源侧建即死资产） */
function writeVscodeIgnore() {
  fs.writeFileSync(
    path.join(DIST_DIR, '.vscodeignore'),
    [
      '# 构建脚本写出（vsce 从包根 dist/ 读取；源侧不建该文件——放源侧即死资产）',
      '**/*.map',
      '**/*.tsbuildinfo',
      ''
    ].join('\n'),
    'utf8'
  );
}

/** vsce package（cwd = 包根 dist/），产出 .vsix 并返回其路径 */
function packageVsix() {
  const vsceBin = path.join(APP_DIR, 'node_modules/@vscode/vsce/vsce');
  fs.mkdirSync(OUT_DIR, { recursive: true });
  execFileSync(
    process.execPath,
    [vsceBin, 'package', '--no-dependencies', '--out', path.join(OUT_DIR, 'vviewer-vscode.vsix')],
    { cwd: DIST_DIR, stdio: 'inherit' }
  );
  const vsix = path.join(OUT_DIR, 'vviewer-vscode.vsix');
  if (!fs.existsSync(vsix)) {
    throw new Error(`[vscode] vsce package 未产出 .vsix（${vsix}）`);
  }
  return vsix;
}

async function main() {
  // 生成物前置（扩展名清单与 core 包共用）——缺失即 fail-fast 并提示修复命令
  assertGeneratedExtensions(REPO_ROOT);

  // 干净重建（dist/ 是打包根，残留文件会进 .vsix；构建缓存同理，避免陈旧产物混淆）
  fs.rmSync(DIST_DIR, { recursive: true, force: true });
  fs.rmSync(CACHE_DIR, { recursive: true, force: true });
  fs.mkdirSync(WEBVIEW_DIR, { recursive: true });

  const metafile = await buildBundles();

  // 门禁 ①：无未解析 import（唯一豁免 = host bundle 的 vscode）
  const unresolved = findUnresolvedImports(metafile, ['vscode']);
  if (unresolved.length > 0) {
    throw new Error(
      `[vscode] 产物存在未解析 import：${JSON.stringify(unresolved, null, 2)}`
    );
  }
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(path.join(CACHE_DIR, 'metafile.json'), JSON.stringify(metafile), 'utf8');

  // 资产采集（grammar/queries/runtime/pdf worker/katex/icon）
  const assets = collectAssets({ repoRoot: REPO_ROOT, outDir: DIST_DIR });

  // VSIX manifest（name 去 scope / main 重写 / selector 实跑注册表生成）
  const sourceManifest = readSourceManifest(REPO_ROOT);
  const claimed = await runRegistryCollection(REPO_ROOT);
  const vsixManifest = buildVsixManifest(sourceManifest, claimed);
  fs.writeFileSync(
    path.join(DIST_DIR, 'package.json'),
    `${JSON.stringify(vsixManifest, null, 2)}\n`,
    'utf8'
  );

  copyPackagingFiles();
  writeVscodeIgnore();

  // 门禁 ②：dist/ 递归字节 <100MB（预检）
  const distBytes = dirSize(DIST_DIR);
  assertUnderLimit(distBytes, SIZE_LIMIT_BYTES, 'dist/ 递归字节');

  // 门禁 ③：vsce package 实包字节 <100MB（vsce 三条硬校验随之实跑）
  const vsix = packageVsix();
  const vsixBytes = fs.statSync(vsix).size;
  assertUnderLimit(vsixBytes, SIZE_LIMIT_BYTES, '.vsix 实包字节');

  console.log(
    `[vscode] 构建完成：扩展名 ${claimed.extensions.length} 个｜grammar ${assets.languages} 语言｜` +
      `queries ${assets.queryLanguages} 语言｜katex 字体 ${assets.fonts} 个｜` +
      `dist ${(distBytes / 1048576).toFixed(1)}MiB｜vsix ${(vsixBytes / 1048576).toFixed(1)}MiB`
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
