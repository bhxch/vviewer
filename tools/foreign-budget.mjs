// tools/foreign-budget.mjs — plan-3 foreign 预算门禁（spec §6.2 Task 4）：扫 apps/web/build
// 产物，四断言面：① 主 chunk（entry + 非 foreign-* chunk，排除 sw.js / workbox-*.js）
// 不得含 @file-viewer import 残留；② 工作箱 precache 清单（同 check-pwa-build 口径：
// sw.js 的 url:"…" 条目）不得含 foreign-*.js、@file-viewer 资产 URL 或 foreign
// worker 匿名资产（_app/immutable/assets/*.worker*.js，终审修复 C1）；③ dist 不得
// 出现 file-viewer 资产目录；④ apps/web 声明了 @file-viewer/* 依赖时，产物必须存在
// ≥1 个 foreign-*.js 组 chunk（分组机制整体失效——如 manualChunks 配置丢失——时
// marker 三断言全无锚点，此存在性断言兜底）。违规即失败（exit 1），不得放宽门禁。
// 无第三方依赖；在仓库根运行（CI 与本地一致）。
//
// 检出能力如实口径：marker 断言只拦 external 化 / import 残留（压缩产物中 ESM import
// 的确定性形态）——@file-viewer 代码被静默打包进非 foreign chunk 且包名被压缩消除时
// 无 marker 可寻，该路径由 ② precache 断言（glob 回归会把 foreign-*.js 收进 precache）
// 与 ④ 存在性断言（分组整体失效即违规）闭合。
//
// marker 取舍（真实产物验证过，见 task-4-report）：压缩/非压缩 ESM import 残留形态
// `from"@file-viewer/`、`from "@file-viewer/`、`import("@file-viewer/`、
// `import"@file-viewer/`（side-effect）；源码字面量碰巧含该序列概率趋近零。
// 弃用 packageName 类 marker：真实产物 _app/immutable/assets/pptjs.worker.*.js 含
// `packageName: '@file-viewer/ppt'`（vendored pptxjs 的 parser 元数据字符串，非
// @file-viewer 代码），采用必误报。
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FOREIGN_PREFIX } from './check-foreign-deps.mjs';

const BUILD_DIR = 'apps/web/build';
const WEB_PKG = 'apps/web/package.json';
// sw.js / workbox-*.js 为 workbox 生成物：其 vv-foreign-assets urlPattern 正则含
// @file-viewer CDN 前缀（运行时缓存策略，非代码 import），不在 chunk 断言面（precache
// 条目另由 ② 单独管）
const NON_CHUNK = [/^sw\.js$/, /^workbox-.*\.js$/];
const CHUNK_MARKERS = [
  /from"@file-viewer\//,
  /from "@file-viewer\//,
  /import\("@file-viewer\//,
  /import"@file-viewer\//
];
const PRECACHE_URL = /url:"([^"]+)"/g;
const FOREIGN_CHUNK_URL = /(^|\/)foreign-[^/]*\.js(?:[?#]|$)/;
const FOREIGN_CHUNK_FILE = /^foreign-.*\.js$/;
// C1（终审修复波）：foreign renderer 以 `new URL('./xxx.worker.js', import.meta.url)`
// 引用的 worker 被 vite 发射为匿名资产（_app/immutable/assets/pptjs.worker.*.js /
// pptx.worker.*.js，约 1.06MB）——不经 foreign-* 组 chunk 命名，vite.config.ts
// globIgnores 漏配即被 workbox 收进 precache。denylist 按「assets/ 目录 + .worker
// 文件名」的 foreign 匿名资产形态通用封堵（覆盖未来 renderer-* 新增 worker 资产——
// 同发射机制必然复现同形态）。注意面：vviewer 自有 worker（ts-worker/gitWorker/
// binary.worker/libarchive worker-bundle）落 _app/immutable/workers/ 或无 .worker
// 文件名段，不命中；若未来自有资产确需进 precache 且文件名含 .worker，需在此显式
// 豁免（门禁收紧偏置：红先问，不静默放行）。
const FOREIGN_WORKER_ASSET_URL = /(^|\/)_app\/immutable\/assets\/[^/]*\.worker[^/]*\.js(?:[?#]|$)/;

function walk(d, base = d) {
  return readdirSync(d, { withFileTypes: true }).flatMap((e) => {
    const p = join(d, e.name);
    return e.isDirectory() ? walk(p, base) : [{ rel: relative(base, p), abs: p }];
  });
}

// ③ 目录 segment 精确匹配（@file-viewer 包资产被复制进产物的目录形态），
// 不做子串匹配——避免误伤文件名碰巧含 file-viewer 的正常产物
function isForeignAssetDir(rel) {
  return rel.split(sep).some((s) => s === 'file-viewer' || s === '@file-viewer');
}

// apps/web 声明的 @file-viewer/* 依赖名（dependencies + devDependencies）
export function foreignDepsOf(pkgJson) {
  return Object.keys({ ...pkgJson.dependencies, ...pkgJson.devDependencies }).filter((n) => n.startsWith(FOREIGN_PREFIX));
}

export function scanForeignBudget(buildDir, foreignDeps) {
  if (!existsSync(buildDir)) {
    return { fatal: `产物目录不存在（${buildDir}）——先 pnpm --filter web build` };
  }
  const files = walk(buildDir);
  const violations = [];
  const chunkLike = files.filter(({ rel }) => {
    const base = basename(rel);
    return base.endsWith('.js') && !base.startsWith('foreign-') && !NON_CHUNK.some((r) => r.test(base));
  });
  // ① 主 chunk：entry + 非 foreign-* chunk 不得含 @file-viewer 代码 import 残留
  //（foreign-*.js 允许存在于 dist——只断言「非主 chunk」与「不进 precache」）
  for (const { rel, abs } of chunkLike) {
    const content = readFileSync(abs, 'utf8');
    const marker = CHUNK_MARKERS.find((m) => m.test(content));
    if (marker) violations.push({ kind: 'chunk-import', file: rel, marker: marker.source });
  }
  // ② precache 清单：不收 foreign-*.js、不收 @file-viewer 资产 URL
  //（cdn.jsdelivr.net/npm/@file-viewer 及同源落盘形态，按含 @file-viewer 超集判定）
  const swPath = join(buildDir, 'sw.js');
  if (existsSync(swPath)) {
    for (const [, url] of readFileSync(swPath, 'utf8').matchAll(PRECACHE_URL)) {
      if (FOREIGN_CHUNK_URL.test(url)) violations.push({ kind: 'precache-foreign', file: 'sw.js', url });
      if (url.includes('@file-viewer')) violations.push({ kind: 'precache-cdn', file: 'sw.js', url });
      if (FOREIGN_WORKER_ASSET_URL.test(url)) violations.push({ kind: 'precache-worker', file: 'sw.js', url });
    }
  } else {
    violations.push({ kind: 'missing-sw', file: 'sw.js' });
  }
  // ③ dist 无 file-viewer 资产目录
  for (const { rel } of files) {
    if (isForeignAssetDir(rel)) violations.push({ kind: 'assets-dir', file: rel });
  }
  // ④ 存在性断言：声明了 @file-viewer/* 依赖则产物必须存在 ≥1 个 foreign-*.js
  // 组 chunk（Task 3 分组机制整体失效时 ①②③ 无锚点，此条兜底）
  if (foreignDeps.length > 0 && !files.some(({ rel }) => FOREIGN_CHUNK_FILE.test(basename(rel)))) {
    violations.push({ kind: 'no-foreign-chunk', file: BUILD_DIR, deps: foreignDeps });
  }
  return { violations };
}

export function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0] !== '--check') {
    console.error('用法：node tools/foreign-budget.mjs --check');
    process.exit(2);
  }
  const { fatal, violations } = scanForeignBudget(
    BUILD_DIR,
    foreignDepsOf(JSON.parse(readFileSync(new URL(`../${WEB_PKG}`, import.meta.url), 'utf8')))
  );
  if (fatal) {
    console.error(`[foreign-budget] ✗ ${fatal}`);
    process.exitCode = 1;
    return { violations: [] };
  }
  if (violations.length > 0) {
    console.error(`[foreign-budget] ✗ ${violations.length} 处违规（@file-viewer 代码面只落 foreign-*.js 组 chunk 且不进 precache）：`);
    for (const v of violations) {
      const detail = [v.file, v.url, v.marker ? `marker: ${v.marker}` : ''].filter(Boolean).join(' → ');
      console.error(`  - [${v.kind}] ${detail}`);
    }
    console.error('处置：vite.config manualChunks 分组（foreign-*）与 precache globIgnores（foreign-*.js）回归即修，不得放宽门禁。');
    process.exitCode = 1;
  } else {
    console.log('[foreign-budget] OK：主 chunk 无 @file-viewer import 残留，precache 清单无 foreign-*.js / @file-viewer URL / worker 匿名资产，dist 无 file-viewer 资产目录，foreign 组 chunk 存在。');
  }
  return { violations };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
