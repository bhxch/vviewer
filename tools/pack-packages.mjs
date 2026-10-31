#!/usr/bin/env node
// tools/pack-packages.mjs — 源码包 npm 发布打包器（release.yml publish-packages job）：
// 逐包把 tsc emit 产物（packages/<pkg>/dist，由 packages/<pkg>/tsconfig.build.json 产出）
// 重排为可发布布局并生成发布版 package.json——
//   非 emit 资产复制：按 PACKAGES 常量逐包 copies（tsc 只 emit js/d.ts，不拷贝
//     markdown-engine 的 declare module 垫片 d.ts、highlight 的 assets/ 整目录（含
//     LICENSE-README.md）、render-diagram 的 svgbob gen 产物 js+wasm——需先
//     pnpm gen:svgbob-wasm）；另复制包 README.md 与仓库根 LICENSE（npm 页与许可随包）。
//   dist/package.json：name=源包名（统一 @bhxch/vviewer- 前缀，内部名=发布名）、version=VV_NPM_PACKAGE_VERSION
//     （tag v1.2.3 归一为 1.2.3，与 publish-npm 同法）、private:false、type:module、
//     main/types/exports 由源 exports 改写指 dist 实际层级——emitRoot='.' 的五包
//     './src/X.ts'→{types:'./X.d.ts',default:'./X.js'}；highlight 的 emit rootDir=包根
//     （src/langdetect.ts 跨 rootDir 引 ../assets/languages.json）→ 产物带 src/ 前缀，
//     './src/X.ts'→{types:'./src/X.d.ts',default:'./src/X.js'}，'./assets/*' 两态同串
//     （发布态包根=dist，指 dist/assets/）；dependencies 携带并保留 workspace:*→发布版本
//     的通用替换路径（当前清单六包零相互依赖，为 no-op）；devDependencies 剔除（测试期
//     面）；files 白名单按 dist 实际顶层布局计算。
//   垫片指令回注：tsc 的 d.ts emit 会丢弃 /// <reference path 指令（2026-10-31 实测，
//     源 5 条 → 产物 0 条）——脚本从源码收集全部 reference path 指令，换算为 dist 相对
//     路径后回注 dist/index.d.ts 顶部，消费方 program 经包根 d.ts 收进垫片（npm 态下
//     ambient declare module 不随 import 图传播，此为唯一收进通道）。
//   contentHash：sha256 前 16 hex，覆盖 dist 全部文件（package.json 本身不参与——版本号
//     不参与哈希，同内容跨版本哈希稳定，发布门据此跳零变化发包）。不复用 pack-npm.mjs
//     的 contentHashOf：其 grammars/manifest.json 特判（剔除 generatedAt 的归一化纳入）
//     为 grammar 资产专属分支，此处写通用哈希。
//   相对 specifier 重写：tsc emit 原样保留源码的无扩展名相对 import（bundler 形态），
//     node 原生 ESM 不可解析——打包时逐文件改写为 dist 内可解析的显式 .js/.json 形式
//     （等价 tsc rewriteRelativeImportExtensions 产物而不触碰源码；仅改写 dist 内可解析
//     目标，注释路径字样自动跳过；d.ts 改写 './X.js' 由消费方 TS 经 .d.ts 替换解析）。
// 残包拦截（发布前即失败，不产出不完整包）：dist 缺失/入口 js 缺失/复制源缺失（svgbob
//   gen 未生成即指向 gen:svgbob-wasm）/outDir 已含打包产物（陈旧混包，同 pack-npm
//   ledger H8）/exports 指向缺失/dist 内相对 import 与 /// reference 闭合破缺（剥注释后
//   扫描——emit 保留注释，render-diagram 包根注释含 import('./diagrams') 字样，裸扫描
//   必误报）。
// 用法：
//   node tools/pack-packages.mjs --list            # 打印包目录清单（空格分隔，workflow 构建与发布两循环共用）
//   NPM_SCOPE=@bhxch VV_NPM_PACKAGE_VERSION=0.0.0 node tools/pack-packages.mjs
// 发布包清单单一来源 = 下方 PACKAGES 常量；workflow 经 --list 取清单，不在 YAML 重复
// 维护（吸取 vviewer-grammars-full 包名硬编码三处的教训）。
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

/**
 * 发布包清单（单一来源）。dir=workspace 包目录（npm 名后缀必须与之一致，脚本断言）；
 * emitRoot=dist 内 js/d.ts 根（默认 '.'；highlight 因 JSON 引用出 src，emit rootDir=包根）；
 * copies=非 emit 资产复制（from 相对包根，to 相对 dist；expect 为复制前存在性断言）。
 */
const PACKAGES = [
  { dir: 'vviewer-detect' },
  { dir: 'vviewer-sanitize' },
  { dir: 'vviewer-markdown-engine', copies: [{ from: 'src/types', to: 'types' }] },
  { dir: 'vviewer-markdown', copies: [{ from: 'src/markdown.css', to: 'markdown.css' }, { from: 'src/types', to: 'types' }] },
  // worker.js 双写：dist/worker.js 供 dist/main.js 的相对 URL（new Worker(new
  // URL('./worker.js', import.meta.url))）解析；dist/src/worker.js 供发布 exports
  // './worker.js' 子路径（源 exports './src/worker.js' 非 *.ts 形态按原样透传）。
  // 同一文件三处同源（src/ 源形态 + 两处发布形态），改 worker 入口只需改 src/。
  {
    dir: 'vviewer-markdown-highlight-worker',
    copies: [
      { from: 'src/worker.js', to: 'worker.js' },
      { from: 'src/worker.js', to: 'src/worker.js' },
    ],
  },
  { dir: 'vviewer-lightbox' },
  {
    dir: 'vviewer-highlight',
    emitRoot: 'src',
    copies: [{ from: 'assets', to: 'assets' }],
  },
  {
    dir: 'vviewer-render-diagram',
    copies: [
      {
        from: 'src/markdown/svgbob-wasm-gen',
        to: 'markdown/svgbob-wasm-gen',
        expect: ['svgbob_wasm.js', 'svgbob_wasm_bg.wasm', 'svgbob_wasm.d.ts'],
      },
    ],
  },
];

const fail = (msg) => {
  throw new Error(`pack-packages: ${msg}`);
};

/** 递归收集文件，返回绝对路径稳定序列 */
function walkFiles(dir) {
  const out = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkFiles(p));
    else out.push(p);
  }
  return out;
}

/** 仓库根 package.json 的 repository 字段（string 或 {url} 形态归一为对象；缺失返回 null） */
function readRepository() {
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
  const r = pkg.repository;
  if (!r) return null;
  const url = typeof r === 'string' ? r : r.url;
  if (!url) return null;
  return { type: 'git', url };
}

/**
 * 剥除 js/d.ts 文本中的注释（行注释 + 块注释，感知字符串/模板字面量）——残包校验
 * 的前置：emit 保留源码注释，注释内的 import('./x') 字样会被裸扫描误判。
 */
function stripComments(text) {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      out += c;
      i += 1;
      while (i < n) {
        if (text[i] === '\\') {
          out += text[i] + (text[i + 1] ?? '');
          i += 2;
          continue;
        }
        out += text[i];
        i += 1;
        if (text[i - 1] === quote) break;
      }
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/** 收集 src/ 下全部 /// <reference path 指令（引用文件 src 相对路径 + 指令目标） */
const REF_PATH_RE = /\/\/\/\s*<reference\s+path\s*=\s*["']([^"']+)["']\s*\/>/g;
function collectReferenceDirectives(srcRoot) {
  const directives = [];
  for (const file of walkFiles(srcRoot)) {
    if (!/\.ts$/.test(file)) continue;
    const rel = path.relative(srcRoot, file).split(path.sep).join('/');
    const text = fs.readFileSync(file, 'utf8');
    REF_PATH_RE.lastIndex = 0;
    let m;
    while ((m = REF_PATH_RE.exec(text))) {
      directives.push({ fromSrcRel: rel, target: m[1] });
    }
  }
  return directives;
}

/** 相对引用可解析性：exact / .js / .json / .d.ts / index.js 候选任一命中即通过 */
function resolvesInDist(distRoot, fromDir, spec) {
  const base = path.posix.normalize(path.posix.join(fromDir, spec));
  const abs = path.join(distRoot, base);
  if (!abs.startsWith(distRoot + path.sep)) return false;
  const candidates = [abs, `${abs}.js`, `${abs}.json`, `${abs}.d.ts`, path.join(abs, 'index.js')];
  return candidates.some((c) => fs.existsSync(c) && fs.statSync(c).isFile());
}

/**
 * 无扩展名相对 specifier 的 dist 内解析（返回改写后的同目录相对形式；exact 命中不改写，
 * 出包根/不可解析返回 null）。.d.ts 候选仅供闭包校验，运行时改写不用（js import 不能
 * 指向 .d.ts）。
 */
function resolveSpecifierForRewrite(distRoot, fromDir, spec) {
  const base = path.posix.normalize(path.posix.join(fromDir, spec));
  const abs = path.join(distRoot, base);
  if (!abs.startsWith(distRoot + path.sep)) return null;
  for (const [candidate, suffix] of [
    [abs, ''],
    [`${abs}.js`, '.js'],
    [`${abs}.json`, '.json'],
    [path.join(abs, 'index.js'), '/index.js'],
  ]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      // spec 本身就是相对导入文件的合法路径，改写 = 原样追加扩展名/补 index.js
      // （../ 层级关系必须保留——经 join 归一会把 '../' 折叠掉）
      if (!suffix) return spec;
      return `${spec}${suffix}`;
    }
  }
  return null;
}

/**
 * 相对 specifier 显式扩展名重写：tsc emit 原样保留源码的无扩展名相对 import
 * （moduleResolution bundler 形态），bundler 可解析而 node 原生 ESM 不行——发布态
 * 逐文件改写为 dist 内可解析的显式 .js/.json 形式（等价 tsc
 * rewriteRelativeImportExtensions 产物，但不触碰源码两态）。仅改写 dist 内可解析
 * 的目标：注释里的路径字样（如 render-diagram 包根注释的 import('./diagrams')）因
 * 不可解析自动跳过。d.ts 内改写为 './X.js' 后消费方 TS 经 .d.ts 替换解析类型。
 */
function rewriteRelativeSpecifiers(distRoot) {
  const REWRITE_RE = /(\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)(['"])(\.[^'"]+)\2/g;
  let changed = 0;
  for (const file of walkFiles(distRoot)) {
    const rel = path.relative(distRoot, file).split(path.sep).join('/');
    if (!/\.(js|mjs|cjs)$/.test(rel) && !/\.d\.ts$/.test(rel)) continue;
    const raw = fs.readFileSync(file, 'utf8');
    const fromDir = path.dirname(rel).split(path.sep).join('/');
    let dirty = false;
    const out = raw.replace(REWRITE_RE, (full, prefix, quote, spec) => {
      if (/\.(js|json|mjs|cjs|d\.ts)$/.test(spec)) return full;
      const resolved = resolveSpecifierForRewrite(distRoot, fromDir, spec);
      if (resolved === null || resolved === spec) return full;
      dirty = true;
      changed += 1;
      return `${prefix}${quote}${resolved}${quote}`;
    });
    if (dirty) fs.writeFileSync(file, out);
  }
  return changed;
}

/** dist 相对引用闭合校验（js 相对 import/export + d.ts 的 /// reference path） */
function checkDistClosure(pkgName, distRoot) {
  const problems = [];
  for (const file of walkFiles(distRoot)) {
    const rel = path.relative(distRoot, file).split(path.sep).join('/');
    if (!/\.(js|mjs|cjs)$/.test(rel) && !/\.d\.ts$/.test(rel)) continue;
    const raw = fs.readFileSync(file, 'utf8');
    const specs = [];
    REF_PATH_RE.lastIndex = 0;
    let m;
    while ((m = REF_PATH_RE.exec(raw))) specs.push(m[1]);
    const stripped = stripComments(raw);
    const REL_SPEC_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)['"](\.[^'"]+)['"]/g;
    REL_SPEC_RE.lastIndex = 0;
    while ((m = REL_SPEC_RE.exec(stripped))) specs.push(m[1]);
    const fromDir = path.dirname(rel);
    for (const spec of [...new Set(specs)]) {
      if (resolvesInDist(distRoot, fromDir, spec)) continue;
      problems.push(`${pkgName}: dist/${rel} 相对引用不可解析: ${spec}`);
    }
  }
  return problems;
}

/** 源 exports → 发布 exports：'./src/X.ts' 按 emitRoot 改写为 {types,default}；
 *  './src/X.css' 同法改写为字符串（非 emit 资产由 copies 复制到 dist 同层级）；
 *  其余 ./src/ 形态（如 .js 直引）原样——dist 内须有同路径副本（copies 承载）。 */
function buildExports(srcPkg, emitRoot) {
  const raw = srcPkg.exports ?? { '.': srcPkg.main };
  const out = {};
  for (const [key, val] of Object.entries(raw)) {
    if (typeof val !== 'string') fail(`${srcPkg.name}: exports.${key} 非字符串形态，脚本不支持`);
    const spec = val.startsWith('./') ? val : `./${val}`;
    if (!spec.startsWith('./src/')) {
      out[key] = spec;
      continue;
    }
    const base = spec.slice('./src/'.length);
    const prefix = emitRoot === 'src' ? './src/' : './';
    if (spec.endsWith('.ts')) {
      const stem = base.replace(/\.ts$/, '');
      out[key] = { types: `${prefix}${stem}.d.ts`, default: `${prefix}${stem}.js` };
    } else if (spec.endsWith('.css')) {
      out[key] = `${prefix}${base}`;
    } else {
      out[key] = spec;
    }
  }
  return out;
}

/** exports 指向存在性校验（'./assets/*' 模式校验前缀目录） */
function checkExportsTargets(pkgName, distRoot, exports) {
  const problems = [];
  for (const [key, val] of Object.entries(exports)) {
    const target = typeof val === 'string' ? val : val.default;
    if (target.includes('*')) {
      const prefixDir = target.slice(0, target.indexOf('*'));
      if (!fs.existsSync(path.join(distRoot, prefixDir))) problems.push(`${pkgName}: exports["${key}"] 模式前缀缺失: ${prefixDir}`);
      continue;
    }
    if (!fs.existsSync(path.join(distRoot, target))) problems.push(`${pkgName}: exports["${key}"] 指向缺失: ${target}`);
  }
  return problems;
}

/** dependencies 携带：workspace:* → 发布版本（包名已统一 @bhxch/vviewer-，
 *  内部名=发布名，无需名字改写）。第三方依赖原样。 */
function mapDependencies(deps, version) {
  if (!deps) return undefined;
  const out = {};
  for (const [k, v] of Object.entries(deps)) {
    out[k] = v === 'workspace:*' ? version : v.startsWith('workspace:') ? v.slice('workspace:'.length) : v;
  }
  return out;
}

/** contentHash：sha256 前 16 hex，dist 全文件（package.json 不参与） */
function contentHashOf(distRoot) {
  const h = createHash('sha256');
  const rels = walkFiles(distRoot)
    .map((f) => path.relative(distRoot, f).split(path.sep).join('/'))
    .sort();
  for (const rel of rels) {
    if (rel === 'package.json') continue;
    h.update(rel);
    h.update('\0');
    h.update(fs.readFileSync(path.join(distRoot, rel)));
    h.update('\0');
  }
  return h.digest('hex').slice(0, 16);
}

/** files 白名单：dist 实际顶层布局（目录含整棵子树；package.json 与点文件除外） */
function filesFieldOf(distRoot) {
  return fs
    .readdirSync(distRoot, { withFileTypes: true })
    .filter((e) => e.name !== 'package.json' && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort();
}

function packOne({ dir, emitRoot = '.', copies = [] }, { scope, version }) {
  const srcRoot = path.join(repoRoot, 'packages', dir);
  const distRoot = path.join(srcRoot, 'dist');
  const srcPkg = JSON.parse(fs.readFileSync(path.join(srcRoot, 'package.json'), 'utf8'));
  if (!srcPkg.name.startsWith('@') || !srcPkg.name.includes('/')) fail(`${dir}: 源包名须为 @scope/name 形态: ${srcPkg.name}`);
  const suffix = srcPkg.name.split('/')[1];
  if (suffix !== dir) fail(`${dir}: 源包名后缀 ${suffix} 与清单目录不一致（发布清单漂移）`);
  // 发布名 = 源包名（统一 @bhxch/vviewer- 前缀，与 vviewer-grammars-full 同款；
  // @bhxch scope 混有非本项目包，vviewer- 前缀做归属消歧）。monorepo 内部名与
  // 发布名一致（单名方案），NPM_SCOPE 仅作命名守卫（env 与包名 scope 不符即 fail）。
  if (!srcPkg.name.startsWith(`${scope}/vviewer-`)) {
    fail(`${dir}: 源包名 ${srcPkg.name} 与发布 scope ${scope} 不符（统一 @bhxch/vviewer- 命名）`);
  }
  const npmName = srcPkg.name;

  // outDir fail-fast（同 pack-npm ledger H8）：已含打包产物时拒跑，防陈旧混包
  if (fs.existsSync(path.join(distRoot, 'package.json'))) {
    fail(`${dir}: packages/${dir}/dist 已含打包产物——rm -rf 后重跑`);
  }
  if (!fs.existsSync(distRoot)) fail(`${dir}: dist 缺失——先 pnpm exec tsc -p packages/${dir}/tsconfig.build.json`);
  const entry = emitRoot === 'src' ? 'src/index.js' : 'index.js';
  if (!fs.existsSync(path.join(distRoot, entry))) fail(`${dir}: 入口缺失 dist/${entry}（emit 面与 emitRoot=${emitRoot} 不符）`);

  // 非 emit 资产复制（复制源缺失即 fail-fast；svgbob gen 未生成指向 gen:svgbob-wasm）
  for (const c of copies) {
    const from = path.join(srcRoot, c.from);
    if (!fs.existsSync(from)) fail(`${dir}: 复制源缺失 ${c.from}`);
    for (const f of c.expect ?? []) {
      if (!fs.existsSync(path.join(from, f))) fail(`${dir}: ${c.from}/${f} 缺失——svgbob gen 产物未生成？先跑 pnpm gen:svgbob-wasm`);
    }
    fs.cpSync(from, path.join(distRoot, c.to), {
      recursive: true,
      // 点文件不入包（gen 目录内 .gitignore 等）
      filter: (src) => !path.basename(src).startsWith('.'),
    });
  }
  // README（npm 页）与仓库根 LICENSE（Apache-2.0 许可随包）——存在才复制
  if (fs.existsSync(path.join(srcRoot, 'README.md'))) fs.copyFileSync(path.join(srcRoot, 'README.md'), path.join(distRoot, 'README.md'));
  const rootLicense = path.join(repoRoot, 'LICENSE');
  if (fs.existsSync(rootLicense)) fs.copyFileSync(rootLicense, path.join(distRoot, 'LICENSE'));

  // 垫片指令回注：tsc d.ts emit 丢弃 /// <reference path（实测），按 dist 相对路径
  // 重写后回注 dist/index.d.ts 顶部（消费方 program 的唯一收进通道）
  const distIndexDts = path.join(distRoot, 'index.d.ts');
  const directives = collectReferenceDirectives(path.join(srcRoot, 'src'));
  if (directives.length) {
    if (!fs.existsSync(distIndexDts)) fail(`${dir}: 有 reference 指令但 dist/index.d.ts 缺失`);
    const lines = [
      ...new Set(
        directives.map(({ fromSrcRel, target }) => {
          // 目标换算为 src 根相对（= dist 根相对）：dist/index.d.ts 在 dist 根，前缀 './'
          const absTarget = path.posix.normalize(path.posix.join(path.posix.dirname(fromSrcRel), target));
          return `/// <reference path="./${absTarget}" />`;
        }),
      ),
    ];
    fs.writeFileSync(distIndexDts, `${lines.join('\n')}\n${fs.readFileSync(distIndexDts, 'utf8')}`);
  }

  // 相对 specifier 显式扩展名重写（先于闭包校验：校验对象即发布面文本）
  const rewritten = rewriteRelativeSpecifiers(distRoot);

  // 发布版 package.json（files/exports 均按 dist 实际布局）
  const exportsMap = buildExports(srcPkg, emitRoot);
  const problems = [
    ...checkExportsTargets(dir, distRoot, exportsMap),
    ...checkDistClosure(dir, distRoot),
  ];
  if (problems.length) fail(`残包校验不通过：\n${problems.join('\n')}`);
  const dotEntry = exportsMap['.'];
  const mainPath = typeof dotEntry === 'string' ? dotEntry : dotEntry.default;
  const typesPath = typeof dotEntry === 'string' ? undefined : dotEntry.types;
  const repository = readRepository();
  const pkg = {
    name: npmName,
    version,
    private: false,
    type: 'module',
    main: mainPath,
    ...(typesPath ? { types: typesPath } : {}),
    exports: exportsMap,
    files: filesFieldOf(distRoot),
    ...(srcPkg.description ? { description: srcPkg.description } : {}),
    ...(repository ? { repository: { ...repository, directory: `packages/${dir}` } } : {}),
    ...(srcPkg.license ? { license: srcPkg.license } : {}),
    ...(srcPkg.dependencies ? { dependencies: mapDependencies(srcPkg.dependencies, version) } : {}),
    contentHash: contentHashOf(distRoot),
  };
  fs.writeFileSync(path.join(distRoot, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');

  const fileCount = walkFiles(distRoot).length;
  if (rewritten) console.log(`[pack-packages] ${dir}: ${rewritten} 个相对 specifier 重写为显式扩展名`);
  return { dir, name: pkg.name, version, contentHash: pkg.contentHash, fileCount };
}

/** 入口：--list 打印清单；否则按 NPM_SCOPE/VV_NPM_PACKAGE_VERSION 打包全部清单包 */
export async function main(argv = process.argv.slice(2), env = process.env) {
  if (argv.includes('--list')) {
    console.log(PACKAGES.map((p) => p.dir).join(' '));
    return [];
  }
  const scope = env.NPM_SCOPE;
  const version = env.VV_NPM_PACKAGE_VERSION;
  if (!scope || !version) {
    fail(
      '缺少环境变量 NPM_SCOPE 与 VV_NPM_PACKAGE_VERSION（publish-packages job 设置）。' +
        '本地示例：NPM_SCOPE=@vviewer VV_NPM_PACKAGE_VERSION=0.0.0 node tools/pack-packages.mjs',
    );
  }
  const results = PACKAGES.map((p) => packOne(p, { scope, version }));
  for (const r of results) {
    console.log(`[pack-packages] ${r.name}@${r.version} -> packages/${r.dir}/dist (${r.fileCount} files) contentHash=${r.contentHash}`);
  }
  return results;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
