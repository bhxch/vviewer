// collect-assets.mjs — 扩展离线资产采集（spec H T1）。
//
// 采集契约（计划 T1「资产采集契约」条）：
// - grammar lite 集：源 `apps/web/static/grammars`（构建产物，不入库）→ `dist/webview/assets/grammars/`
//   （34 个 wasm + manifest.json 原样拷贝；manifest 的 `grammars` 键集即语言集）。
// - queries：源 `packages/vviewer-highlight/assets/queries/<lang>/` → `dist/webview/assets/queries/<lang>/`
//   ——**仅** manifest 语言集命中项（canonical 语言名即查询目录名，alias 不另取：
//   引擎按 canonical lang 取查询，packages/vviewer-highlight/src/core-parse.ts:484）。
// - runtime：源 `apps/web/static/tree-sitter.wasm` → `dist/webview/assets/tree-sitter.wasm`
//   （Parser.init 经 locateFile(joinPath(runtimeDir, 'tree-sitter.wasm')) 取用，core-parse.ts:210）。
// - pdfjs worker 双分支：源 `pdfjs-dist/build/pdf.worker.min.mjs` 与
//   `pdfjs-dist/legacy/build/pdf.worker.min.mjs` → `dist/webview/pdf/`（esbuild 不做
//   vite 的裸说明符资产化——packages/vviewer-render-doc/src/pdf.ts:124-127 注释明说该
//   能力是 vite 特有；两支都有消费面，注入按 preferModernBuild() 能力选支）。
// - 主题表：源 `packages/vviewer-highlight/assets/themes.json` → 裁剪为 onelight +
//   serika-dark 两键 → `dist/webview/assets/themes.json`。
// - katex：源 `katex/dist/katex.min.css` + `katex/dist/fonts/*.woff2`（20 个；woff/ttf
//   不取——web 端同款取舍）→ `dist/webview/katex.min.css` + `dist/webview/fonts/`。
// - icon：源 `apps/vscode/media/icon.png` → `dist/media/icon.png`（VSIX 打包根相对路径）。
//
// 失败面纪律：**任一源缺失即 fail-fast 并打印可执行修复命令**，不做静默降级
// （缺 grammar = 扩展无高亮，属构建期必须暴露的失败）。

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** 仓库根（apps/vscode/scripts → 上溯三级） */
export const REPO_ROOT = path.resolve(HERE, '..', '..', '..');

/** 资产源（相对仓库根） */
export const ASSET_SOURCES = {
  grammars: 'apps/web/static/grammars',
  runtimeWasm: 'apps/web/static/tree-sitter.wasm',
  queries: 'packages/vviewer-highlight/assets/queries',
  themes: 'packages/vviewer-highlight/assets/themes.json',
  icon: 'apps/vscode/media/icon.png'
};

/** 缺件修复命令（构建期报错原文附此，可直接复制执行） */
export const FIX_COMMANDS = {
  grammars:
    'pnpm gen:sources && node tools/grammar-builder/build.mjs --fetch --lite && node tools/grammar-builder/build.mjs --self-build',
  queries: 'pnpm gen:sources',
  runtimeWasm: 'pnpm gen:grammars',
  themes: 'pnpm gen:sources',
  icon: '重新生成 apps/vscode/media/icon.png（PNG，≥128×128；vsce 禁 SVG）',
  packages: 'pnpm install'
};

/** pdfjs worker 双分支采集清单（modern / legacy 各 ~1.3MB，均有消费面） */
export const PDF_WORKERS = [
  { id: 'modern', pkgRel: 'build/pdf.worker.min.mjs', outRel: 'pdf/pdf.worker.min.mjs' },
  { id: 'legacy', pkgRel: 'legacy/build/pdf.worker.min.mjs', outRel: 'pdf/pdf.worker.legacy.min.mjs' }
];

/** 扩展内打包的两条代码主题（裁剪自 themes.json 的 214 键） */
export const PACKAGED_THEMES = ['onelight', 'serika-dark'];

/** katex 字体清单（woff2 20 个；woff/ttf 不取——web 端同款取舍） */
export const KATEX_FONT_EXT = '.woff2';

/** 资产源缺失错误（message 内含可执行修复命令） */
export function missingSourceError(what, fix) {
  return new Error(`[vscode] 资产源缺失：${what}\n修复命令：${fix}`);
}

function assertFile(file, what, fix) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    throw missingSourceError(`${what}（${file}）`, fix);
  }
  return file;
}

function assertDir(dir, what, fix) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw missingSourceError(`${what}（${dir}）`, fix);
  }
  return dir;
}

/**
 * 读 grammar manifest：返回语言集（canonical 语言名，即查询目录名）。
 * manifest 缺失即 fail-fast（附修复命令）。
 */
export function readGrammarManifest(grammarsDir) {
  assertDir(grammarsDir, 'grammar 目录', FIX_COMMANDS.grammars);
  const manifestPath = path.join(grammarsDir, 'manifest.json');
  assertFile(manifestPath, 'grammar manifest.json', FIX_COMMANDS.grammars);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (!manifest || typeof manifest.grammars !== 'object' || manifest.grammars === null) {
    throw missingSourceError(`grammar manifest 的 grammars 键集不可用（${manifestPath}）`, FIX_COMMANDS.grammars);
  }
  return { languages: Object.keys(manifest.grammars), manifest };
}

/**
 * queries 语言过滤：仅取 manifest 语言集命中项（缺目录跳过——引擎按 canonical lang
 * 取查询，缺查询目录即该语言无查询，运行时降级 hljs，不静默补空目录）。
 */
export function selectQueryLanguages(languages, queriesDir) {
  assertDir(queriesDir, 'queries 目录', FIX_COMMANDS.queries);
  const available = new Set(fs.readdirSync(queriesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name));
  const selected = [];
  const missing = [];
  for (const lang of languages) {
    if (available.has(lang)) selected.push(lang);
    else missing.push(lang);
  }
  return { selected, missing };
}

/**
 * pdfjs worker 双分支采集清单：两文件均需存在且非空（空文件 = 采集失败，非「无内容」）。
 */
export function planPdfWorkers(pdfjsDir) {
  assertDir(pdfjsDir, 'pdfjs-dist 包目录', FIX_COMMANDS.packages);
  return PDF_WORKERS.map((w) => {
    const src = path.join(pdfjsDir, w.pkgRel);
    assertFile(src, `pdfjs worker（${w.id}）`, FIX_COMMANDS.packages);
    const bytes = fs.statSync(src).size;
    if (bytes === 0) {
      throw missingSourceError(`pdfjs worker 为空文件（${src}）`, FIX_COMMANDS.packages);
    }
    return { ...w, src, bytes };
  });
}

/**
 * katex 字体清单：dist/fonts 下 *.woff2（空目录即采集失败——公式排印会退化为无排印 HTML）。
 */
export function listKatexFonts(katexDistDir) {
  assertDir(katexDistDir, 'katex dist 目录', FIX_COMMANDS.packages);
  const fontsDir = path.join(katexDistDir, 'fonts');
  assertDir(fontsDir, 'katex 字体目录', FIX_COMMANDS.packages);
  const fonts = fs.readdirSync(fontsDir)
    .filter((f) => f.endsWith(KATEX_FONT_EXT))
    .sort();
  if (fonts.length === 0) {
    throw missingSourceError(`katex 字体清单为空（${fontsDir}）`, FIX_COMMANDS.packages);
  }
  return fonts;
}

/**
 * 主题裁剪：输出只含 PACKAGED_THEMES 两键（themes.json 214 键全量入包属死重）。
 */
export function trimThemes(themes, keys = PACKAGED_THEMES) {
  if (!themes || typeof themes !== 'object') {
    throw missingSourceError('themes.json 结构不可用', FIX_COMMANDS.themes);
  }
  const out = {};
  for (const key of keys) {
    if (!(key in themes)) {
      throw missingSourceError(`themes.json 缺键「${key}」`, FIX_COMMANDS.themes);
    }
    out[key] = themes[key];
  }
  return out;
}

/** icon 存在性（vsce：缺 icon 字段不报错，填了而文件不在包内才报错） */
export function assertIcon(iconPath) {
  assertFile(iconPath, '扩展图标', FIX_COMMANDS.icon);
  return { path: iconPath, bytes: fs.statSync(iconPath).size };
}

/**
 * 解析 node_modules 内的包目录（katex / pdfjs-dist 由 pnpm 软链入 apps/vscode/node_modules）。
 * - `mode: 'root'`：解析 `<pkg>/package.json` 取包根（pdfjs-dist 无 exports 映射，可解析）。
 * - `mode: 'entry'`：解析包入口后取其所在目录（katex 的 exports 映射不含 './package.json'，
 *   入口 `./dist/katex.js` 所在目录即 katex 的 dist 目录——排印样式与字体都在其下）。
 */
export function resolvePkgDir(pkgName, fromDir, mode = 'root') {
  const dirs = Array.isArray(fromDir) ? fromDir : [fromDir];
  const errors = [];
  for (const dir of dirs) {
    const req = createRequire(path.join(dir, 'package.json'));
    try {
      if (mode === 'root') return path.dirname(req.resolve(`${pkgName}/package.json`));
      return path.dirname(req.resolve(pkgName));
    } catch (err) {
      errors.push(`${dir}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw missingSourceError(
    `包「${pkgName}」未安装（自 ${dirs.join(' / ')} 解析失败）`,
    FIX_COMMANDS.packages
  );
}

function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function copyDir(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
}

/**
 * 采集全部资产到 dist/webview（+ dist/media/icon.png）。
 * 返回采集摘要（供构建日志与单测断言）。
 */
export function collectAssets(options = {}) {
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const outDir = options.outDir ?? path.join(repoRoot, 'apps/vscode/dist');
  const appDir = path.join(repoRoot, 'apps/vscode');
  const webviewDir = path.join(outDir, 'webview');

  // grammar 集
  const grammarsDir = path.join(repoRoot, ASSET_SOURCES.grammars);
  const { languages } = readGrammarManifest(grammarsDir);
  copyDir(grammarsDir, path.join(webviewDir, 'assets/grammars'));

  // queries（仅 manifest 语言集命中项）
  const queriesDir = path.join(repoRoot, ASSET_SOURCES.queries);
  const { selected, missing } = selectQueryLanguages(languages, queriesDir);
  for (const lang of selected) {
    copyDir(path.join(queriesDir, lang), path.join(webviewDir, 'assets/queries', lang));
  }

  // runtime wasm
  const runtimeWasm = path.join(repoRoot, ASSET_SOURCES.runtimeWasm);
  assertFile(runtimeWasm, 'tree-sitter runtime wasm', FIX_COMMANDS.runtimeWasm);
  copyFile(runtimeWasm, path.join(webviewDir, 'assets/tree-sitter.wasm'));

  // 主题表（裁剪两键）
  const themesPath = path.join(repoRoot, ASSET_SOURCES.themes);
  assertFile(themesPath, 'themes.json', FIX_COMMANDS.themes);
  const themes = JSON.parse(fs.readFileSync(themesPath, 'utf8'));
  const trimmed = trimThemes(themes);
  fs.mkdirSync(path.join(webviewDir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(webviewDir, 'assets/themes.json'), `${JSON.stringify(trimmed, null, 2)}\n`, 'utf8');

  // pdfjs worker 双分支（pdfjs-dist 是 @bhxch/vviewer-render-doc 的依赖，非扩展直依赖
  // → 自该包目录解析）
  const pdfjsDir = resolvePkgDir('pdfjs-dist', path.join(repoRoot, 'packages/vviewer-render-doc'), 'root');
  const pdfWorkers = planPdfWorkers(pdfjsDir);
  for (const w of pdfWorkers) copyFile(w.src, path.join(webviewDir, w.outRel));

  // katex 排印样式 + 字体（扩展直依赖 katex；兜底自 markdown 组合包解析）
  const katexDistDir = resolvePkgDir('katex', [appDir, path.join(repoRoot, 'packages/vviewer-markdown')], 'entry');
  const katexCss = path.join(katexDistDir, 'katex.min.css');
  assertFile(katexCss, 'katex.min.css', FIX_COMMANDS.packages);
  copyFile(katexCss, path.join(webviewDir, 'katex.min.css'));
  const fonts = listKatexFonts(katexDistDir);
  for (const font of fonts) {
    copyFile(path.join(katexDistDir, 'fonts', font), path.join(webviewDir, 'fonts', font));
  }

  // icon（复制进 VSIX 打包根）
  const icon = assertIcon(path.join(repoRoot, ASSET_SOURCES.icon));
  copyFile(icon.path, path.join(outDir, 'media/icon.png'));

  return {
    outDir,
    webviewDir,
    languages: languages.length,
    queryLanguages: selected.length,
    queryMissing: missing,
    pdfWorkers: pdfWorkers.map((w) => ({ id: w.id, outRel: w.outRel, bytes: w.bytes })),
    fonts: fonts.length,
    themes: Object.keys(trimmed)
  };
}

// CLI 直跑形态：node scripts/collect-assets.mjs [outDir]
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const outDir = process.argv[2] ? path.resolve(process.argv[2]) : undefined;
  const summary = collectAssets(outDir ? { outDir } : {});
  console.log(`[vscode] 资产采集完成：${JSON.stringify(summary)}`);
}
