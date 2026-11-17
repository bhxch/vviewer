// gen-manifest.mjs — VSIX manifest 生成 + 扩展名清单实跑（spec H T1）。
//
// 扩展名清单（单一来源）：esbuild 打包 `scripts/collect-extensions.ts`（实跑真实注册表）
// → 在 Node 执行 → 得**有效认领扩展名全集** → 写进 `contributes.customEditors[].selector`。
// 认领面与 selector 同源于一次装配（Review Focus 8：两面必须一致）。
//
// VSIX manifest 与 workspace 源 manifest **解耦**（vsce 4.1.1 硬校验）：
// - `name` 须匹配 /^[a-z0-9][a-z0-9\-]*$/i（validation.js:45）——workspace 名
//   `@bhxch/vviewer-vscode` 含 `@` 与 `/` **不合法** → VSIX 侧重写为 `vviewer-vscode`
//   （marketplace 标识 = `bhxch.vviewer-vscode`）。
// - `version` 必填且合法 semver（validation.js:64-70）。
// - `engines.vscode` 与 `devDependencies['@types/vscode']` 按 major.minor 比大小
//   （validation.js:100-137）——devDep 须钉 `~1.90.0`（取最新版 1.1xx 即抛
//   「greater than engines.vscode」）。
// - `main` 重写为 `./extension.js`（源口径 `./dist/extension.js` 在打包根下会指向
//   不存在的 `dist/dist/extension.js` → 404）。
// - `contributes.customEditors` 必留（vsce 的隐式激活事件来源，package.js:1014-1021）。

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** 仓库根（apps/vscode/scripts → 上溯三级） */
export const REPO_ROOT = path.resolve(HERE, '..', '..', '..');

/** 生成物（不入库）依赖的源清单 */
export const GENERATED_EXTENSIONS_PATH = 'packages/vviewer-core/src/registry/generated-extensions.ts';

/** 扩展名清单实跑入口 */
const COLLECT_ENTRY = path.join(HERE, 'collect-extensions.ts');

/** 临时 bundle 落位（apps/vscode/out/ 已 gitignore） */
const CACHE_DIR = path.join(REPO_ROOT, 'apps/vscode/out/build-cache');

/** esbuild 打包时的 external（全是惰性动态 import，实跑注册表时从不执行） */
const TEMP_EXTERNALS = [
  'mermaid',
  'katex',
  'katex/contrib/mhchem',
  'katex/dist/katex.min.css',
  'nomnoml',
  '@viz-js/viz',
  'pdfjs-dist',
  'pdfjs-dist/legacy/build/pdf.mjs'
];

/** 生成物缺失即 fail-fast（提示可执行修复命令——tools/e2e-list-guard.mjs:15 同款纪律） */
export function assertGeneratedExtensions(repoRoot = REPO_ROOT) {
  const file = path.join(repoRoot, GENERATED_EXTENSIONS_PATH);
  if (!fs.existsSync(file)) {
    throw new Error(
      `[vscode] 生成物缺失：${GENERATED_EXTENSIONS_PATH}\n修复命令：pnpm gen:sources`
    );
  }
  return file;
}

/**
 * 实跑真实注册表，取有效认领扩展名全集与其所有者。
 * （esbuild 打包 TS 入口 → Node 执行 → 解析 stdout JSON）
 *
 * esbuild **惰性加载**：其 lib/main.js 在加载期做环境不变式断言
 * （`new TextEncoder().encode("") instanceof Uint8Array`），在 jsdom 环境恒假 → 直接
 * import 会让本模块的消费者（单测）整组失败。esbuild 只在真正实跑注册表时才需要。
 */
export async function runRegistryCollection(repoRoot = REPO_ROOT) {
  const { default: esbuild } = await import('esbuild');
  assertGeneratedExtensions(repoRoot);
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const outfile = path.join(CACHE_DIR, 'collect-extensions.cjs');
  esbuild.buildSync({
    entryPoints: [COLLECT_ENTRY],
    outfile,
    bundle: true,
    // CJS：依赖图内有 CJS 包（yaml 等）在运行时用 require('process')——ESM 产物下
    // esbuild 的 __require shim 会抛「Dynamic require of "process" is not supported」。
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    external: TEMP_EXTERNALS,
    logLevel: 'warning'
  });
  const stdout = execFileSync(process.execPath, [outfile], {
    encoding: 'utf8',
    env: { ...process.env, VV_COLLECT_EXTENSIONS_PRINT: '1' }
  });
  const parsed = JSON.parse(stdout);
  if (!parsed || !Array.isArray(parsed.extensions) || parsed.extensions.length === 0) {
    throw new Error('[vscode] 注册表实跑未产出扩展名清单（collect-extensions 输出异常）');
  }
  return parsed;
}

/** 扩展名 → custom editor selector glob（VSCode 按文件名匹配） */
export function toSelector(extensions) {
  return extensions.map((ext) => `*.${ext}`);
}

/**
 * 由 workspace 源 manifest 生成 VSIX manifest（构建产物 dist/package.json）。
 * - name 去 scope（vsce nameRegex 拒 `@`/`/`）
 * - main 重写为 ./extension.js（打包根相对）
 * - type 固定 commonjs（host bundle 是 CJS）
 * - devDependencies 只留 @types/vscode（vsce 的 engines/types 兼容校验读它；
 *   workspace 协议的 dependencies 对发布产物无意义，故不带）
 */
export function buildVsixManifest(sourceManifest, claimed) {
  const selector = toSelector(claimed.extensions);
  const customEditors = (sourceManifest.contributes?.customEditors ?? []).map((editor) => ({
    ...editor,
    selector
  }));
  const typesVscode = sourceManifest.devDependencies?.['@types/vscode'];
  return {
    name: 'vviewer-vscode',
    displayName: sourceManifest.displayName,
    description: sourceManifest.description,
    version: sourceManifest.version,
    publisher: sourceManifest.publisher,
    license: sourceManifest.license,
    type: 'commonjs',
    engines: sourceManifest.engines,
    categories: sourceManifest.categories,
    keywords: sourceManifest.keywords,
    icon: sourceManifest.icon,
    main: './extension.js',
    repository: sourceManifest.repository,
    contributes: { ...sourceManifest.contributes, customEditors },
    devDependencies: typesVscode ? { '@types/vscode': typesVscode } : {}
  };
}

/** 读 workspace 源 manifest */
export function readSourceManifest(repoRoot = REPO_ROOT) {
  const file = path.join(repoRoot, 'apps/vscode/package.json');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// CLI：node scripts/gen-manifest.mjs → 打印 VSIX manifest
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const claimed = await runRegistryCollection();
  console.log(JSON.stringify(buildVsixManifest(readSourceManifest(), claimed), null, 2));
}
