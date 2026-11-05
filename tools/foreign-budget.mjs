// tools/foreign-budget.mjs — plan-3 foreign 预算门禁（spec §6.2 Task 4）：扫 apps/web/build
// 产物，断言 @file-viewer/* 代码面只落 foreign-*.js 组 chunk（Task 3 分组），不混入
// ① 主 chunk（entry + 非 foreign-* chunk）、② 工作箱 precache 清单（同 check-pwa-build
// 口径：sw.js 的 url:"…" 条目）、③ dist 不得出现 file-viewer 资产目录。违规即失败
// （exit 1），不得放宽门禁。无第三方依赖；在仓库根运行（CI 与本地一致）。
//
// marker 取舍（真实产物验证过，见 task-4-report）：压缩产物中 ESM import 的确定性
// 形态 `from"@file-viewer/`（静态）与 `import("@file-viewer/`（动态）——仅在模块未被
// 构建图解析（external 化 / 分组回归）时残留，源码字面量碰巧含该序列概率趋近零。
// 弃用 packageName 类 marker：真实产物 _app/immutable/assets/pptjs.worker.*.js 含
// `packageName: '@file-viewer/ppt'`（vendored pptxjs 的 parser 元数据字符串，非
// @file-viewer 代码），采用必误报。
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const BUILD_DIR = 'apps/web/build';
// sw.js / workbox-*.js 为 workbox 生成物：其 vv-foreign-assets urlPattern 正则含
// @file-viewer CDN 前缀（运行时缓存策略，非代码 import），不在 chunk 断言面（precache
// 条目另由 ② 单独管）
const NON_CHUNK = [/^sw\.js$/, /^workbox-.*\.js$/];
const CHUNK_MARKERS = [/from"@file-viewer\//, /import\("@file-viewer\//];
const PRECACHE_URL = /url:"([^"]+)"/g;
const FOREIGN_CHUNK_URL = /(^|\/)foreign-[^/]*\.js(?:[?#]|$)/;

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

export function scanForeignBudget(buildDir) {
  if (!existsSync(buildDir)) {
    return { fatal: `产物目录不存在（${buildDir}）——先 pnpm --filter web build` };
  }
  const files = walk(buildDir);
  const violations = [];
  // ① 主 chunk：entry + 非 foreign-* chunk 不得含 @file-viewer 代码 import 残留
  //（foreign-*.js 允许存在于 dist——只断言「非主 chunk」与「不进 precache」）
  for (const { rel, abs } of files) {
    const base = basename(rel);
    if (!base.endsWith('.js') || base.startsWith('foreign-') || NON_CHUNK.some((r) => r.test(base))) continue;
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
    }
  } else {
    violations.push({ kind: 'missing-sw', file: 'sw.js' });
  }
  // ③ dist 无 file-viewer 资产目录
  for (const { rel } of files) {
    if (isForeignAssetDir(rel)) violations.push({ kind: 'assets-dir', file: rel });
  }
  return { violations };
}

export function main() {
  const { fatal, violations } = scanForeignBudget(BUILD_DIR);
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
    console.log('[foreign-budget] OK：主 chunk 无 @file-viewer import 残留，precache 清单无 foreign-*.js / @file-viewer URL，dist 无 file-viewer 资产目录。');
  }
  return { violations };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
