import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig, type Plugin } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { createReadStream, cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// 子路径托管（GitHub Pages 项目站点 /<repo>/ 等）：VV_BASE_PATH 注入（如 /vviewer）。
// 默认空 = 根路径，本地 dev/e2e/自建服务器部署行为不变。同名值供下方 sveltekit()
// 的 kit.paths.base 与 PWA manifest（start_url/scope）取用，两处必须取同一值。
// kit 3 起 SvelteKit 配置不再读 svelte.config.js，全部经 sveltekit() 插件参数传入。
const base = process.env.VV_BASE_PATH ?? '';

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

// BUG-15 配套（仅 vite preview 生效）：SvelteKit 的 preview 中间件只认 kit 路由，
// /index.html 直接 404——而 workbox precache 安装期会按清单条目请求
// index.html?__WB_REVISION__=…，任一条目失败即 SW 安装整体失败（caches 永远
// 建不起来，e2e 的 SW 用例全挂）。生产部署（vviewer serve --web-dist build）的
// ServeDir 天然服务 /index.html，无此问题；这里仅在 preview 期把它直连到
// adapter 产物。必须先于 sveltekit() 注册（中间件按插件顺序 use）。
function serveIndexHtmlInPreview(): Plugin {
  return {
    name: 'serve-index-html-preview',
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => {
        const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
        if (pathname !== '/index.html') return next();
        const file = fileURLToPath(new URL('./build/index.html', import.meta.url));
        if (!existsSync(file)) {
          res.statusCode = 404;
          return res.end('build/index.html not found');
        }
        res.setHeader('content-type', 'text/html; charset=utf-8');
        const stream = createReadStream(file);
        stream.on('error', () => {
          if (!res.headersSent) res.statusCode = 500;
          res.end();
        });
        stream.pipe(res);
      });
    }
  };
}

export default defineConfig({
  plugins: [
    serveIndexHtmlInPreview(),
    sveltekit({
      adapter: adapter({ fallback: 'index.html' }),
      paths: { base }
    }),
    copyTsQueries(),
    copyLibarchiveAssets(),
    // M7 PWA（Task 1）：应用壳预缓存 + 高亮资产 CacheFirst 运行时缓存。
    // SW 注册不走插件 html 注入（SvelteKit 的 app.html 不经 transformIndexHtml），
    // 由 +layout.svelte 经 virtual:pwa-register 手动注册（registerType autoUpdate）。
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: null,
      // vite 8 + kit 3：全局 build.outDir 不再被 kit 覆写（改按环境各自 outDir），
      // 插件默认取 vite.root/vite.build.outDir 会落到默认 dist/——sw.js 不进
      // adapter 拷贝、precache glob 也扫不到客户端产物。显式指回 kit 的客户端
      // 输出目录：sw.js/workbox-*.js 随 adapter 进 build/，precache 清单取自真实产物。
      outDir: '.svelte-kit/output/client',
      manifest: {
        // theme_color 不支持 CSS 变量：写死亮色值，暗色由 app.html 的
        // media=(prefers-color-scheme: dark) meta theme-color 覆盖
        name: 'vviewer',
        short_name: 'vviewer',
        description: '本地文件查看器：代码/Markdown/Office/压缩包/媒体一体的纯前端预览',
        lang: 'zh-CN',
        // 子路径托管（VV_BASE_PATH，与 svelte.config.js 的 paths.base 同源）：
        // Pages 项目站点部署在 /<repo>/ 下时 start_url/scope 必须带前缀
        start_url: `${process.env.VV_BASE_PATH ?? ''}/`,
        scope: `${process.env.VV_BASE_PATH ?? ''}/`,
        display: 'standalone',
        background_color: '#ffffff',
        theme_color: '#ffffff',
        icons: [
          { src: 'icons/pwa-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icons/pwa-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          // maskable 变体（gen-icons 生成，内容缩到 80% 安全区）：Android 自适应
          // 圆形/圆角遮罩不裁笔画（终审 M7）
          { src: 'icons/pwa-maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
          { src: 'icons/pwa-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
        ]
      },
      workbox: {
        // 应用壳：打包产物 js/css + 字体；图标与 wasm 资产走静态拷贝不进预缓存。
        // html 不入 glob：index.html 只有 additionalManifestEntries 单一来源
        //（build/ 下无其他 html，已核实）——workbox-build 对 additional 条目不去重
        //（direct push），若 glob 也抓到 index.html 会产生同 URL 双 revision 条目，
        // SW 求值期抛 add-to-cache-list-conflicting-entries → 完全死 SW。
        globPatterns: ['**/*.{js,css,woff2}'],
        navigateFallback: 'index.html',
        navigateFallbackDenylist: [/^\/api\//],
        // BUG-15：vite-plugin-pwa 生成 precache manifest 的时点早于 SvelteKit
        // adapter-static 写出 build/index.html（构建时序竞态，实测产物 102 条
        // precache 零 html），导致 sw.js 求值期 createHandlerBoundToURL('index.html')
        // 抛 non-precached-url——NavigationRoute 与 grammars/queries 运行时路由
        // 全部静默丢失（残缺 SW，离线 reload 落 chrome-error）。index.html 经此
        // 唯一通道显式注入；revision 用 BUILD_REVISION 同源：每次构建刷新，部署
        // 新版后 index.html 随 SW 更新重新预缓存，不陈旧。
        //
        // 偏离备案（评审 R1）：spec BUG-15 方案 2 的「运行时路由先于 NavigationRoute
        // 注册」与 sw.js 顶层 error/unhandledrejection 上报在 generateSW 模板内
        // 不可配置（需 injectManifest 自定义 SW；计划 §4 明示仅实测 generateSW
        // 无法消除单点异常时立项）。单点异常根因已由 precache 修复消除，残余
        // 静默风险由构建期 NavigationRoute 断言与 e2e 的运行期 SW 断言兜底。
        additionalManifestEntries: [{ url: 'index.html', revision: BUILD_REVISION }],
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
            // BUG-06 配套：web-tree-sitter runtime wasm（static/ 固定路径）此前不匹配
            // 任何缓存策略——离线重开代码文件时 runtime 即缺失。CacheFirst 同上。
            // 注意：该 wasm 由 worker 内 fetch，Chrome 对 module worker 的控制语义
            // 实测不经页面 SW——需主线程预热（highlightClient.ts create()）才进缓存。
            urlPattern: /\/tree-sitter\.wasm$/,
            handler: 'CacheFirst',
            options: {
              cacheName: `vv-runtime-${BUILD_REVISION}`,
              expiration: { maxEntries: 4, purgeOnQuotaError: true },
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
