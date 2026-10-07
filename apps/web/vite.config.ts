import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig, type Plugin } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const QUERIES_SRC = fileURLToPath(new URL('../../packages/highlight/assets/queries', import.meta.url));
const QUERIES_DEST = fileURLToPath(new URL('./static/queries', import.meta.url));

// 构建修订号（final review A4）：package.json version + 启动分钟级时间戳（36 进制截断），
// 构建期确定、每次构建刷新。workbox runtimeCaching 的 cacheName 是静态字符串，
// generateRevision 不适用于运行时缓存——可行法即 cacheName 模板拼入该修订号：
// 新版本部署后 sw.js 携带新 cacheName，旧 CacheFirst 缓存（旧名）不再命中、随
// expiration 清理，修复语法 wasm/查询跨版本陈旧。同时经 define 注入
// __BUILD_REVISION__ 供运行时（调试/诊断）读取。
const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8')) as { version: string };
const BUILD_REVISION = `${pkg.version}-${Math.floor(Date.now() / 60_000).toString(36)}`;

/**
 * tree-sitter 查询静态资产：Worker 端按需 fetch /queries/{lang}/*.scm，
 * 286 目录 752 文件不入库（.gitignore），dev/build 启动时从 highlight 包全量同步拷贝。
 */
function copyTsQueries(): Plugin {
  const copy = (): void => {
    rmSync(QUERIES_DEST, { recursive: true, force: true });
    cpSync(QUERIES_SRC, QUERIES_DEST, { recursive: true });
  };
  return {
    name: 'copy-ts-queries',
    configureServer() {
      copy();
    },
    buildStart() {
      copy();
    }
  };
}

// libarchive.js 的 worker bundle 与 wasm（~1MB）不做打包变换：worker 内部以
// new URL('libarchive.wasm', import.meta.url) 相对定位 wasm，作为打包入口处理会
// 引入哈希资产路径耦合；改为与 ts-queries 相同的静态拷贝模式——dev/build 启动时
// 拷到 static/libarchive/（不入库），viewer.ts 以 BASE_URL 注入 workerUrl。
const LIBARCHIVE_FILES = ['worker-bundle.js', 'libarchive.wasm'] as const;
const LIBARCHIVE_DEST = fileURLToPath(new URL('./static/libarchive', import.meta.url));


function copyLibarchiveAssets(): Plugin {
  const copy = (): void => {
    const require = createRequire(fileURLToPath(new URL('./package.json', import.meta.url)));
    const dist = join(dirname(require.resolve('libarchive.js/package.json')), 'dist');
    mkdirSync(LIBARCHIVE_DEST, { recursive: true });
    for (const f of LIBARCHIVE_FILES) cpSync(join(dist, f), join(LIBARCHIVE_DEST, f));
  };
  return {
    name: 'copy-libarchive-assets',
    configureServer() {
      copy();
    },
    buildStart() {
      copy();
    }
  };
}

export default defineConfig({
  plugins: [
    sveltekit(),
    copyTsQueries(),
    copyLibarchiveAssets(),
    // M7 PWA（Task 1）：应用壳预缓存 + 高亮资产 CacheFirst 运行时缓存。
    // SW 注册不走插件 html 注入（SvelteKit 的 app.html 不经 transformIndexHtml），
    // 由 +layout.svelte 经 virtual:pwa-register 手动注册（registerType autoUpdate）。
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: null,
      manifest: {
        // theme_color 不支持 CSS 变量：写死亮色值，暗色由 app.html 的
        // media=(prefers-color-scheme: dark) meta theme-color 覆盖
        name: 'vviewer',
        short_name: 'vviewer',
        description: '本地文件查看器：代码/Markdown/Office/压缩包/媒体一体的纯前端预览',
        lang: 'zh-CN',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        background_color: '#ffffff',
        theme_color: '#ffffff',
        icons: [
          { src: 'icons/pwa-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icons/pwa-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' }
        ]
      },
      workbox: {
        // 应用壳：打包产物 js/css/html + 字体；图标与 wasm 资产走静态拷贝不进预缓存
        globPatterns: ['**/*.{js,css,html,woff2}'],
        navigateFallback: 'index.html',
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [
          {
            // tree-sitter 语法 wasm（~8MB 总量）：不变内容，缓存优先；
            // cacheName 拼构建修订号——新版本部署后旧缓存不再命中（跨版本陈旧修复）
            urlPattern: /\/grammars\/.*\.wasm$/,
            handler: 'CacheFirst',
            options: {
              cacheName: `vv-grammars-${BUILD_REVISION}`,
              expiration: { maxEntries: 300, purgeOnQuotaError: true },
              cacheableResponse: { statuses: [200] }
            }
          },
          {
            // tree-sitter 查询 .scm（构建期静态拷贝，路径随版本不变）；修订号同上
            urlPattern: /\/queries\//,
            handler: 'CacheFirst',
            options: {
              cacheName: `vv-queries-${BUILD_REVISION}`,
              expiration: { maxEntries: 300, purgeOnQuotaError: true },
              cacheableResponse: { statuses: [200] }
            }
          }
        ]
      },
      devOptions: { enabled: false }
    })
  ],
  // ts-worker 依赖 web-tree-sitter（内部含动态 import），必须以 ES module worker 打包（iife 不支持 code-splitting）
  worker: {
    format: 'es'
  },
  define: {
    // 构建修订号注入运行时（与 SW cacheName 同源；诊断/关于页可读）
    __BUILD_REVISION__: JSON.stringify(BUILD_REVISION)
  }
});
