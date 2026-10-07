// check-pwa-build.mjs —— PWA build 产物断言（Task 1，M7）：sw.js / manifest.webmanifest
// 存在、图标齐全、工作箱 precache 条目 > 10、运行时缓存策略就位。
// 由 apps/web 的 build 脚本在 vite build 之后自动执行，产物缺失即 build 失败。
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const build = fileURLToPath(new URL('../build/', import.meta.url));
const fail = (msg) => {
  console.error(`[check-pwa-build] ✗ ${msg}`);
  process.exit(1);
};

for (const f of [
  'sw.js',
  'manifest.webmanifest',
  'icons/pwa-192.png',
  'icons/pwa-512.png',
  'icons/pwa-maskable-192.png',
  'icons/pwa-maskable-512.png'
]) {
  if (!existsSync(`${build}/${f}`)) fail(`缺少产物 ${f}`);
}

const manifest = JSON.parse(readFileSync(`${build}/manifest.webmanifest`, 'utf8'));
if (manifest.name !== 'vviewer') fail(`manifest.name 应为 vviewer，实际 ${manifest.name}`);
if (manifest.display !== 'standalone') fail('manifest.display 应为 standalone');
const icons = manifest.icons ?? [];
if (
  icons.length !== 4
  || !icons.some((i) => i.sizes === '192x192' && i.purpose === 'any')
  || !icons.some((i) => i.sizes === '512x512' && i.purpose === 'any')
  || !icons.some((i) => i.sizes === '192x192' && i.purpose === 'maskable')
  || !icons.some((i) => i.sizes === '512x512' && i.purpose === 'maskable')
) {
  fail(`manifest.icons 应含 192/512 的 any+maskable 四项，实际 ${JSON.stringify(icons)}`);
}

const sw = readFileSync(`${build}/sw.js`, 'utf8');
// 产物为压缩后的 workbox generateSW 输出：precache 清单形如 {url:"...",revision:"..."}（键不带引号）
const precacheUrls = [...sw.matchAll(/url:"([^"]+)"/g)].map((m) => m[1]);
if (precacheUrls.length <= 10) {
  fail(`工作箱 precache 条目应 > 10，实际 ${precacheUrls.length}`);
}
// cacheName 拼构建修订号（vite.config BUILD_REVISION，构建期确定）：断言前缀即可，
// 修订号每次构建刷新，sw.js 内形如 cacheName:"vv-grammars-0.1.0-xxx"
for (const [name, pattern] of [
  ['vv-grammars', /\/grammars\/.*\.wasm$/],
  ['vv-queries', /\/queries\//]
]) {
  if (!sw.includes(`cacheName:"${name}-`)) fail(`sw.js 缺少运行时缓存 ${name}-<revision>`);
}
if (!sw.includes('registerRoute')) fail('sw.js 缺少 registerRoute（运行时缓存未生成）');
const revision = sw.match(/cacheName:"vv-grammars-([^"]+)"/)?.[1];
if (!revision) fail('sw.js 运行时缓存 cacheName 缺少构建修订号');

console.log(
  `[check-pwa-build] ✓ sw.js + manifest.webmanifest + icons 齐全，precache ${precacheUrls.length} 条，运行时缓存 vv-grammars/vv-queries@${revision} 就位`
);
