import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig, type Plugin } from 'vite';
import { VitePWA, type VitePWAOptions } from 'vite-plugin-pwa';
import { createReadStream, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// 子路径托管（GitHub Pages 项目站点 /<repo>/ 等）：VV_BASE_PATH 注入（如 /vviewer）。
// 默认空 = 根路径，本地 dev/e2e/自建服务器部署行为不变。同名值供下方 sveltekit()
// 的 kit.paths.base 与 PWA manifest（start_url/scope）取用，两处必须取同一值。
// kit 3 起 SvelteKit 配置不再读 svelte.config.js，全部经 sveltekit() 插件参数传入。
const base = process.env.VV_BASE_PATH ?? '';
// kit 3 起 paths.base 类型收窄为 '' | `/${string}`：空串放行；非空归一为单斜杠开头
//（吞掉漏写/重复的前导斜杠），与下方 PWA manifest 同源取 kitBase。
const kitBase: '' | `/${string}` = base === '' ? '' : `/${base.replace(/^\/+/, '')}`;

const QUERIES_SRC = fileURLToPath(new URL('../../packages/vviewer-highlight/assets/queries', import.meta.url));
const QUERIES_DEST = fileURLToPath(new URL('./static/queries', import.meta.url));

// 构建修订号（final review A4）：package.json version + 启动分钟级时间戳（36 进制截断），
// 构建期确定、每次构建刷新。workbox runtimeCaching 的 cacheName 是静态字符串，
// generateRevision 不适用于运行时缓存——可行法即 cacheName 模板拼入该修订号：
// 新版本部署后 sw.js 携带新 cacheName，旧 CacheFirst 缓存（旧名）不再命中、随
// expiration 清理，修复语法 wasm/查询跨版本陈旧。同时经 define 注入
// __BUILD_REVISION__ 供运行时（调试/诊断）读取。
const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8')) as { version: string };
const BUILD_REVISION = `${pkg.version}-${Math.floor(Date.now() / 60_000).toString(36)}`;

// 残余 A8：foreign 资产 env 镜像域（VV_FOREIGN_ASSETS，构建期定型——SW 规则在
// generateSW 阶段由本配置生成，读 process.env 即构建期值，无需运行时常量）。语义
// 与 foreignAssets.ts normalizeBaseDir 对齐（trim + 尾斜杠收口，空 = 未启用）：
// 跨域 http(s) 前缀生成与缺省 CDN 同款 CacheFirst 镜像路由（双路由：env 为空仅
// 默认）；同源路径形态不经此——同源由 /file-viewer-assets/ 预留槽路由承接。
const FOREIGN_ASSETS_ENV_BASE = (() => {
  const v = (process.env.VV_FOREIGN_ASSETS ?? '').trim();
  return v === '' ? '' : v.endsWith('/') ? v : `${v}/`;
})();
const FOREIGN_ASSETS_ENV_MIRROR =
  FOREIGN_ASSETS_ENV_BASE !== '' && /^https?:\/\//.test(FOREIGN_ASSETS_ENV_BASE)
    ? FOREIGN_ASSETS_ENV_BASE
    : '';
// RegExp 字面量转义（镜像 base 拼进 urlPattern——'.' 等元字符须字面匹配）
const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A8 镜像路由预构造（类型取自 VitePWAOptions 推导，不直引 workbox-build）：env 为空
// 空数组。独立常量而非内联条件展开——TS 6 对「上下文类型数组字面量内的条件展开」
// 不下发元素上下文类型，内联写法 handler 字面量拓宽为 string 触发 RuntimeCaching
// 不兼容（且污染其后元素的推断），预构造标注后按普通数组展开。
const FOREIGN_MIRROR_RUNTIME_CACHING: NonNullable<
  NonNullable<VitePWAOptions['workbox']>['runtimeCaching']
> =
  FOREIGN_ASSETS_ENV_MIRROR === ''
    ? []
    : [
        {
          urlPattern: new RegExp(`^${escapeRegExp(FOREIGN_ASSETS_ENV_MIRROR)}`),
          handler: 'CacheFirst',
          options: {
            cacheName: `vv-foreign-assets-${BUILD_REVISION}`,
            expiration: { maxEntries: 64, purgeOnQuotaError: true },
            cacheableResponse: { statuses: [200] }
          }
        }
      ];

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

// BUG-60 配套：vv-* 运行时缓存跨版本清理脚本（构建期生成、烘焙 BUILD_REVISION，
// static/ 不入库）。cacheName 拼构建修订号，部署换版后旧 REV 缓存不再被任何路由
// 引用，而 workbox cleanupOutdatedCaches 仅清 precache 前缀、ExpirationPlugin 不跨
// cacheName 删除——脚本经下方 workbox.importScripts 注入 sw.js，activate 时删除
// 非当前 REV 命名的 vv-* 缓存。修订号必须烘焙而非运行时探测：SW 内 fetch 自身
// scriptURL 拿到的是浏览器 script cache 的旧文本（实测），自描述方案不成立；
// 换版部署所有产物文件同步更新，脚本随部署携带新 REV 即一次清理到位。
const SW_CLEANUP_DEST = fileURLToPath(new URL('./static/vv-sw-cleanup.js', import.meta.url));

function genSwCleanup(): Plugin {
  const write = (): void => {
    const current = [
      `vv-grammars-${BUILD_REVISION}`,
      `vv-runtime-${BUILD_REVISION}`,
      `vv-queries-${BUILD_REVISION}`,
      `vv-diagram-svgbob-${BUILD_REVISION}`,
      `vv-worker-wasm-${BUILD_REVISION}`,
      `vv-cdn-engines-${BUILD_REVISION}`,
      `vv-foreign-assets-${BUILD_REVISION}`
    ];
    writeFileSync(
      SW_CLEANUP_DEST,
      `// 构建期生成（vite.config.ts genSwCleanup）：BUILD_REVISION=${BUILD_REVISION}，勿手改。
// BUG-60：activate 清理非当前修订号的 vv-* 运行时缓存（cleanupOutdatedCaches 仅清
// workbox-precache-* 前缀；cacheName 拼 BUILD_REVISION 的运行时缓存换版后永久残留、
// 随部署次数线性累积——本脚本随部署换版携带新 REV，旧 REV 缓存清理一次到位）。
// 清理正则的族清单必须与上方 current 清单**逐族对齐**：漏一族即该族的旧 REV 缓存
// 永久残留（vv-worker-wasm 曾漏——残余 A7 新增该族时只改了 current 清单）。
self.addEventListener('activate', (event) => {
  const current = ${JSON.stringify(current)};
  event.waitUntil(
    (async () => {
      try {
        const names = await self.caches.keys();
        await Promise.all(
          names
            .filter((n) => /^(vv-grammars|vv-runtime|vv-queries|vv-diagram-svgbob|vv-worker-wasm|vv-cdn-engines|vv-foreign-assets)-/.test(n) && !current.includes(n))
            .map((n) => self.caches.delete(n))
        );
      } catch {
        // 清理失败不阻塞激活：纯存储卫生，非功能路径
      }
    })()
  );
});
`
    );
  };
  return {
    name: 'gen-sw-cleanup',
    configureServer() {
      write();
    },
    buildStart() {
      write();
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

// md 图表（Task 8，控制器裁决后收窄）：本计划新增的图表引擎（graphviz/viz-js、
// nomnoml）确定性聚到单一 chunk，产物文件名携带 diagram-engines- 前缀——
// （1）PWA precache 按 globIgnores 排除该命名，引擎按需加载不进预缓存；
// （2）预算门禁 tools/diagram-budget.mjs 按文件名前缀统计体积（spec §2.6 ≤4MB）。
//
// 裁决备案（spec §2.6 启用集本意）：mermaid/katex 是本计划之前的存量依赖——改造前
// globPatterns '**/*.js' 把它们的默认分块一并 precache（离线可用是既有用户现状），
// §2.4「图表引擎 chunk 不进 precache」的立法本意是防本计划新增引擎膨胀 precache，
// 对存量引擎不适用。故本组仅收 viz+nomnoml（增量，实测 ≈1.35MB 达标）；mermaid/katex
// 回归 SvelteKit 默认分块与 precache 地位（其分片均 < workbox maximumFileSizeToCacheInBytes
// 默认 2MiB，进 precache 不触发插件抛错）。存量地位维持；若未来 mermaid 升级致
// precache 膨胀（分片超 2MiB 被挤出或总体积失控），另行立项，不改本门禁。
//
// 机制备案（偏离 brief 的 rollup 风格 manualChunks）：vite 8 底层为 rolldown，kit 3 在
// environments.client.build.rolldownOptions.output 显式设 chunkFileNames 为纯哈希
//（chunks/[hash].js，chunk 名不进文件名）。顶层 build.rollupOptions.output.manualChunks
// 实测不生效；直接写在顶层 environments.client 也不生效——vite resolveConfig 按
// pre → normal 顺序逐插件 mergeConfig(config, res)，kit 的 config hook 是 order 'pre'
// 且后 merge 的函数字段覆盖先 merge 的（数组则是 concat，故顶层 groups 会生效而
// chunkFileNames 被 kit 盖掉）。本插件用默认（normal）order 的 config hook 返回覆写，
// 排在 kit 之后 merge，从而压过 kit：
// - codeSplitting.groups（rolldown 原生分组，kit 自身同款 API）按包路径正则归堆；
//   groups 数组经 concat 叠加，kit 的 sveltekit-manifest group 原样保留（重复无害）；
// - chunkFileNames 仅对 diagram-engines 特判带名，其余 chunk 保持 kit 默认纯哈希；
//   sveltekit-manifest 分支为 kit 内部契约（固定 _app/manifest.js 保证内容哈希稳定、
//   避免哈希反馈循环），覆写时必须原样复刻，kit 升级若改动需同步。
function diagramEngineChunk(): Plugin {
  return {
    name: 'diagram-engine-chunk',
    config: () => ({
      // worker 构建图（vite 独立 rolldown 构建）：gitWorker 入口内的 isomorphic-git
      // 动态 import——client 侧 codeSplitting groups 够不到 worker 图，分组/带名须在
      // 此复刻。git-engine 特判落 _app/immutable/chunks/（与 client 侧 git-engine 同位：
      // immutable 缓存头 + tools/diagram-budget.mjs 只扫该目录 + globIgnores 排除
      // precache），实测 kit3 默认 worker chunk 基座为 _app/immutable/workers/chunks/
      //（build/index.js:275）——默认分支原样复刻，避免其余 worker chunk 偏离 kit 约定
      //（本函数整体替换 kit 默认，必须自兜底）。
      worker: {
        rolldownOptions: {
          output: {
            chunkFileNames(chunkInfo) {
              if (chunkInfo.name === 'git-engine') return '_app/immutable/chunks/git-engine-[hash].js';
              // foreign worker 侧共享 chunk（计划 4 Task 3）：renderer-signature 的
              // rpgp/openpgp glue 在 worker 图的共享 chunk（原 hash 命名无法 globIgnores，
              // 会被 workbox 收进 precache——foreign 代码面绝不进 precache 铁律）按
              // foreign- 前缀带名，globIgnores '**/foreign-*.js' 通用覆盖
              if (chunkInfo.name.startsWith('foreign-')) return `_app/immutable/workers/chunks/${chunkInfo.name}-[hash].js`;
              return '_app/immutable/workers/chunks/[hash].js';
            },
            codeSplitting: {
              groups: [
                {
                  name: 'git-engine',
                  // 终审修复波（precache 闭包门禁配套）：gitIso.ts（isogit 懒加载边界，
                  // worker 专用 src 模块）显式锚定回本组——基线其随组归并落 git-engine
                  // chunk；本批 foreign 组插入改变 rolldown 归并落位后，gitIso 落独立
                  // hash 命名 worker 共享 chunk（进 precache）却静态 re-export
                  // isomorphic-git（本组 chunk 不进 precache）→ precache'd → 非缓存
                  // chunk 静态边，离线 git 面 eval 期 404。锚定回组即恢复「gitIso +
                  // isogit 同图落 git-engine chunk」的设计位（gitIso.ts 头注）；gitWorker
                  // 的 import('./gitIso') 保持动态——动态 import 到排除 chunk 属设计内
                  // 懒加载（拉取失败不粘滞、可重试），不在 precache 闭包断言面。
                  test: /[\\/]node_modules[\\/](isomorphic-git|async-lock|clean-git-ref|crc-32|diff3|ignore|minimisted|pify|sha\.js|simple-get|buffer)[\\/]|[\\/]gitIso\.ts$/
                },
                {
                  // renderer-signature worker 图面（signature.worker 的 rpgp wasm glue
                  // + openpgp classify 共享 chunk）；两个 worker entry 本体由 globIgnores
                  // 精确项排除（**/signature.worker*.js / **/container.worker*.js）
                  name: 'foreign-signature-worker',
                  test: /[\\/]node_modules[\\/]@file-viewer[\\/]renderer-signature[\\/]/
                }
              ]
            }
          }
        }
      },
      environments: {
        client: {
          build: {
            rolldownOptions: {
              output: {
                chunkFileNames(chunkInfo) {
                  if (chunkInfo.name === 'sveltekit-manifest') return '_app/manifest.js';
                  if (chunkInfo.name === 'diagram-engines') return '_app/immutable/chunks/diagram-engines-[hash].js';
                  // git 信息面板（2026-10-31 git 信息面板 spec）：isomorphic-git 引擎 chunk（worker 内
                  // 动态 import 拉取），带名特判同 diagram-engines——precache 排除与预算
                  // 门禁（tools/diagram-budget.mjs）按该前缀识别
                  if (chunkInfo.name === 'git-engine') return '_app/immutable/chunks/git-engine-[hash].js';
                  // foreign 渲染器组（计划 3 Task 3，spec §6.2）：@file-viewer/* 代码面
                  // 按渲染器组带名（下方 groups）——JS 代码包 chunk 分离进 dist 但绝不
                  // 进 precache（iwork 解析器 chunk 实测 4.05MB 超 workbox 2MiB 单文件
                  // 上限，且「不进 precache」本即全局约束）；带名供 globIgnores 排除
                  // 与 T4 foreign 预算门禁按前缀识别
                  if (chunkInfo.name.startsWith('foreign-')) return `_app/immutable/chunks/${chunkInfo.name}-[hash].js`;
                  return '_app/immutable/chunks/[hash].js';
                },
                codeSplitting: {
                  groups: [
                    { name: 'sveltekit-manifest', test: '<sveltekit:generated>/app-manifest.js' },
                    {
                      name: 'diagram-engines',
                      // graphre 是 nomnoml 的解析器依赖（UMD require），随 nomnoml 归堆——
                      // 否则落默认共享 chunk，与引擎组拆两包（台账 4-2）
                      test: /[\\/]node_modules[\\/](@viz-js[\\/]viz|nomnoml|graphre)[\\/]/
                    },
                    {
                      // 终审修复 C1（目标级终审修复波）：base64-js/ieee754/buffer 独立共享
                      // 组（zip-shared 先例，置于 git-engine 组之前——groups 按序首中即胜）。
                      // 三包曾归 git-engine 组（彼时组注「buffer 为 gitIso.ts 的 Buffer shim
                      // 独占依赖」前提失真：client 图内 isomorphic-git 全族不在图——worker
                      // 专用，组实际只装 buffer/base64-js/ieee754），组产物被 globIgnores
                      // git-engine-* 排除 precache，而 mammoth（vviewer docx 路径，precache'd
                      // 懒加载 chunk）与 msgreader/email 链（precache'd 共享 chunk）静态依赖
                      // buffer → 离线 docx/eml 模块求值期 404。独立组非 foreign- 前缀 → 默认
                      // hash 分支进 precache（~26KB），双消费面闭包恢复完整；worker 图的
                      // git-engine 组员保持含 buffer（gitIso 锚定同图，见 worker 分组）。
                      name: 'buffer-shared',
                      test: /[\\/]node_modules[\\/](base64-js|ieee754|buffer)[\\/]/
                    },
                    {
                      name: 'git-engine',
                      // isomorphic-git 及其独占传递依赖归堆（pnpm-lock 2026-11 实测：表中
                      // 各包仅 isogit 一家消费）。pako@1.0.11 与 readable-stream@2 为
                      // jszip（zip 渲染路径 vviewer-render-archive/doc）共享——绝不可入组：
                      // 组产物 git-engine-*.js 不进 precache，jszip 静态依赖连坐会把 zip
                      // 路径绑到非 precache chunk 上（离线 zip 打开断链）；二者留默认共享
                      // chunk 维持 precache 地位（增量 ~40KB，build 后 rg 复核落组）。
                      // buffer/base64-js/ieee754 已上移 buffer-shared 组（终审修复 C1，见
                      // 上）；client 图现无 isomorphic-git 面（worker 专用），组保留为
                      // worker 图同款防御位——未来 client 侧引 isogit 时仍按名排除 precache。
                      test: /[\\/]node_modules[\\/](isomorphic-git|async-lock|clean-git-ref|crc-32|diff3|ignore|minimisted|pify|sha\.js|simple-get)[\\/]/
                    },
                    {
                      // 终审修复 C1：vite preload helper 虚拟模块（\0vite/preload-helper）
                      // 不匹配任何组 test，rolldown 把它并入先创建的组 chunk（foreign-core，
                      // ~419KB、globIgnores 排除 precache）——10 个 precache'd 文件静态
                      // import 它 → 离线冷启动整站断链。显式独立组收拢：非 foreign- 前缀
                      //（chunkFileNames 对 foreign- 前缀带名永不 precache，默认 hash
                      // 分支才进 precache），增量 ~3KB 随应用壳预缓存。
                      name: 'app-preload-helper',
                      test: /preload-helper/
                    },
                    {
                      // 终审修复 C2：jszip 全量收拢单一共享 chunk。无显式组时 jszip 子
                      // 模块按 importer 集摊进 foreign-ofd（组 chunk 不进 precache），
                      // vviewer zip 渲染路径（precache'd 面）静态依赖它 → 离线 zip/docx
                      // 断链。非 foreign- 前缀 → 默认 hash 分支进 precache（~100KB），
                      // 放在 foreign 组之前（groups 按序首中即胜）。
                      name: 'zip-shared',
                      test: /[\\/]node_modules[\\/]jszip[\\/]/
                    },
                    // ---------- foreign 渲染器组（计划 3 Task 3，spec §6.2）----------
                    // @file-viewer/* 代码面 + foreign 独占传递依赖按渲染器组归堆带名：
                    // globIgnores 排除 precache（代码包 chunk 分离进 dist 但不进
                    // precache——全局约束 + iwork chunk 4.05MB 超 workbox 2MiB 上限）。
                    // 共享依赖铁律（git-engine 同款）：pako@1.0.11 为 vviewer zip 渲染
                    // 路径共享、buffer 已上移 buffer-shared 组（终审修复 C1，非 foreign-
                    // 前缀仍进 precache）——留默认共享 chunk/独立组维持 precache 地位；
                    // jszip 收拢进上方 zip-shared 组（非 foreign- 前缀，仍进 precache）。
                    // foreign 组与共享 chunk 间跨 chunk import 合法，仅懒加载连带，无
                    // 断链。email 的 buffer 依赖经 buffer-shared 组员满足（precache'd，
                    // 闭包完整；实测 build 后 rg 复核）。
                    {
                      name: 'foreign-core',
                      test: /[\\/]node_modules[\\/]@file-viewer[\\/]core[\\/]/
                    },
                    {
                      // 终审修复波 M-2：msgreader 实包为 scoped @kenjiuno/msgreader——原
                      // test 字面 `msgreader` 要求 node_modules/msgreader/ 前缀，永不命中，
                      // msgreader 及其独占依赖 decompressrtf/iconv-lite 落默认共享 chunk
                      //（precache'd）却静态 import diagram-engines 组 chunk 内的 CJS
                      // require-shim（不匹配任何组 test 的匿名共享模块被 rolldown 吸进先建
                      // 组 chunk——app-preload-helper 先例）→ precache'd → 非缓存 chunk 静态
                      // 边，离线 eml/msg 断链。归位本组（uncached）：组 chunk → diagram-engines
                      // 跨组懒加载连带合法。iconv-lite 与 d3-dsv（foreign-geo 面 shpjs→d3
                      // 链）共享——入组后 foreign-geo → foreign-email 跨组 import，双
                      // uncached 合法；precache 同步减重 ~330KB。
                      name: 'foreign-email',
                      test: /[\\/]node_modules[\\/](@file-viewer[\\/]renderer-email|postal-mime|@kenjiuno[\\/](msgreader|decompressrtf)|iconv-lite)[\\/]/
                    },
                    {
                      // pako@2.2.0（epub 独占 major）不入组：与 jszip 链 pako@1.0.11 同名
                      // 包目录，regex 无法区分版本——~45KB 留默认 chunk 无碍
                      name: 'foreign-epub',
                      test: /[\\/]node_modules[\\/]@file-viewer[\\/]renderer-epub[\\/]/
                    },
                    {
                      // jszip@3.10.2 归 zip-shared 共享组（同上铁律），本组跨 chunk import
                      name: 'foreign-ofd',
                      test: /[\\/]node_modules[\\/]@file-viewer[\\/]renderer-ofd[\\/]/
                    },
                    {
                      name: 'foreign-chm',
                      test: /[\\/]node_modules[\\/]@file-viewer[\\/]renderer-chm[\\/]/
                    },
                    {
                      // capability-rtf 副作用包与 word 同组（装配层 word loader 内同载）；
                      // @file-viewer/doc、docx 为 renderer-word 依赖；rtf.js 为
                      // capability-rtf 独占懒加载器目标
                      name: 'foreign-word',
                      test: /[\\/]node_modules[\\/](@file-viewer[\\/](renderer-word|capability-rtf|doc|docx)|rtf\.js)[\\/]/
                    },
                    {
                      // renderer-ppt/pptx 为 renderer-presentation 的内部再导出依赖；
                      // 裸包 ppt@1.0.2/pptx@3.3.3 为二者的传递依赖（无 renderer- 前缀，
                      // 评审 M-1：漏写即落默认共享 chunk 入 precache——PptError 面
                      // 实测 244K chunk 曾入 precache 清单）
                      name: 'foreign-presentation',
                      test: /[\\/]node_modules[\\/]@file-viewer[\\/](renderer-presentation|renderer-ppt|renderer-pptx|ppt|pptx)[\\/]/
                    },
                    {
                      // 终审修复 C2：@xmldom/xmldom 曾归本组（三组共享归首组先例），
                      // 但 mammoth（vviewer docx 路径，precache'd 面）静态依赖它——组
                      // chunk 不进 precache 即离线 docx 断链。回归默认共享 chunk 恢复
                      // precache 地位，spreadsheet/iwork/hangul/design 跨 chunk import
                      name: 'foreign-spreadsheet',
                      test: /[\\/]node_modules[\\/](@file-viewer[\\/]renderer-spreadsheet|e-virt-table|styled-exceljs|utif|tinycolor2)[\\/]/
                    },
                    {
                      name: 'foreign-iwork',
                      test: /[\\/]node_modules[\\/](@file-viewer[\\/]renderer-iwork|keynote-archives)[\\/]/
                    },
                    {
                      name: 'foreign-hangul',
                      test: /[\\/]node_modules[\\/](@file-viewer[\\/]renderer-hangul|@ssabrojs[\\/]hwpxjs|cfb)[\\/]/
                    },
                    {
                      name: 'foreign-wordperfect',
                      test: /[\\/]node_modules[\\/]@file-viewer[\\/]renderer-wordperfect[\\/]/
                    },
                    // ---------- 第二波 foreign 渲染器组（计划 4 Task 3，spec §6.2）----------
                    // 10 组 wave-2 渲染器代码面 + 各自独占传递依赖归堆带名（同上铁律）：
                    // 绝不进 precache（globIgnores foreign-*.js 前缀覆盖）。组间/组外共享
                    // 依赖裁决（groups 按序首中即胜，重复列入后组无效——均不列）：
                    // - ag-psd 为 renderer-data/design 共享（.pnpm 单实例 31.0.3）→ 归首组
                    //   foreign-data，design 组跨 chunk import；
                    // - utif 为 renderer-spreadsheet/image 共享 → 已在 foreign-spreadsheet；
                    //   cfb 为 renderer-hangul/eda 共享 → 已在 foreign-hangul；
                    //   @xmldom/xmldom 为 spreadsheet/iwork/hangul/design 与 vviewer
                    //   docx（mammoth）共享 → 回默认共享 chunk（终审修复 C2，见上）；
                    // - jszip 归 zip-shared 共享组（vviewer zip 路径共享铁律，见上，
                    //   非 foreign- 前缀仍进 precache）；pako@2.2.0（dicom/epub 独占 major 同名目录，regex
                    //   无法区分版本）与 dompurify@3.4.17（drawing）同理不入组——后者与
                    //   vviewer-sanitize 的 dompurify@3.4.16 同名，组内会连坐 sanitize 面；
                    // - events@3.3.0（renderer-dicom 声明依赖）已被其 dist 内联（esm 产物
                    //   自带 EventEmitter polyfill），不入组（不进 vite 图则零影响）。
                    {
                      // sql wasm 消费面：renderSqlite 经 assets-data 基座解析 sql-wasm.wasm
                      name: 'foreign-data',
                      test: /[\\/]node_modules[\\/](@file-viewer[\\/]renderer-data|ag-psd|avsc|hyparquet|sql\.js)[\\/]/
                    },
                    {
                      // renderer-design 本体静态依赖 renderer-data（data-asset 缝，见
                      // foreignRenderers.ts wireDesignOrDataSeam）——跨 chunk import foreign-data
                      name: 'foreign-design',
                      test: /[\\/]node_modules[\\/](@file-viewer[\\/]renderer-design|@paged-media[\\/]introspect-wasm|@webtoon[\\/]psd|fzstd|illustrator-pgf|saxes)[\\/]/
                    },
                    {
                      // heic2any/utif 随 dist 自包含（无 CDN 资产）；utif 已归 foreign-spreadsheet
                      name: 'foreign-image',
                      test: /[\\/]node_modules[\\/](@file-viewer[\\/]renderer-image|heic2any)[\\/]/
                    },
                    {
                      // maplibre-gl worker 为内联源码 blob URL（T2 探针），@maplibre/* 传递
                      // 依赖（geojson-vt/style-spec/mlt/vt-pbf）随主包归堆
                      name: 'foreign-geo',
                      test: /[\\/]node_modules[\\/](@file-viewer[\\/]renderer-geo|@tmcw[\\/]togeojson|maplibre-gl|@maplibre[\\/][^\\/]+|proj4|shpjs)[\\/]/
                    },
                    {
                      name: 'foreign-typst',
                      test: /[\\/]node_modules[\\/](@file-viewer[\\/]renderer-typst|@myriaddreamin[\\/][^\\/]+)[\\/]/
                    },
                    {
                      name: 'foreign-dicom',
                      test: /[\\/]node_modules[\\/](@file-viewer[\\/]renderer-dicom|dicom-parser)[\\/]/
                    },
                    {
                      // jszip 归 zip-shared 共享组（vviewer zip 路径共享铁律）：signature 组跨 chunk import
                      name: 'foreign-signature',
                      test: /[\\/]node_modules[\\/]@file-viewer[\\/]renderer-signature[\\/]/
                    },
                    {
                      // cfb 已归 foreign-hangul（shp 边车同款先例）
                      name: 'foreign-eda',
                      test: /[\\/]node_modules[\\/]@file-viewer[\\/](renderer-eda|eda-layout|eda-orcad)[\\/]/
                    },
                    {
                      // capability-mermaid/capability-drawio-official 为 renderer-drawing
                      // 独占传递依赖（@file-viewer 系，与 vviewer 自有 mermaid 引擎无关）；
                      // drawio-official 不入组即成 hash 命名 facade chunk（动态 import 面）
                      // 静默入 precache 且模块级拉起 foreign-drawing（build 实测）。
                      // roughjs 不入组（build 实测复核：mermaid@12.1.0 亦依赖
                      // roughjs@^4.6.6，同实例共享——入组后 mermaid 的 precache'd 代码
                      // chunk 反向 import foreign-drawing chunk，离线手绘风断链，jszip
                      // 铁律同款）；dompurify 不入组（见上）
                      name: 'foreign-drawing',
                      test: /[\\/]node_modules[\\/]@file-viewer[\\/](renderer-drawing|capability-mermaid|capability-drawio-official)[\\/]|[\\/]node_modules[\\/](@panzoom[\\/]panzoom|plantuml-encoder)[\\/]/
                    },
                    {
                      // renderer-media 媒体扩展名不注册（av 占优），capability-midi 注册
                      // MIDI loader（@tonejs/midi 独占）——midi/mid 消费面同组
                      name: 'foreign-midi',
                      test: /[\\/]node_modules[\\/](@file-viewer[\\/](renderer-media|capability-midi)|@tonejs[\\/]midi)[\\/]/
                    }
                  ]
                }
              }
            }
          }
        }
      }
    })
  };
}

export default defineConfig({
  plugins: [
    serveIndexHtmlInPreview(),
    diagramEngineChunk(),
    sveltekit({
      adapter: adapter({ fallback: 'index.html' }),
      paths: { base: kitBase },
      // 强制 runes 模式（kit 3 配置经本插件参数传入，compilerOptions 转发
      // vite-plugin-svelte；见 AGENTS.md 项目规则）：全局显式开启，禁止 legacy
      // 语法回退与逐文件 <!-- svelte-ignore runes --> 摇摆——项目 .svelte 组件已
      // 全量 runes 写法（$state/$derived/$props），开启后编译器按硬规则执法。
      // lint 期镜像：根 eslint.config.js 的 parserOptions.svelteConfig 取同值，改此处须同步
      compilerOptions: { runes: true }
    }),
    copyTsQueries(),
    copyLibarchiveAssets(),
    genSwCleanup(),
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
        // 子路径托管（VV_BASE_PATH，与 sveltekit() 插件参数 kit.paths.base 同源）：
        // Pages 项目站点部署在 /<repo>/ 下时 start_url/scope 必须带前缀
        start_url: `${kitBase}/`,
        scope: `${kitBase}/`,
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
        // json（BUG-58 配套）：grammars/manifest.json 必须走 precache 而非
        // runtimeCaching——create() 随 viewer.ts 启动预热即 fetch manifest，首次
        // 访问该请求早于 SW 接管（运行时路由拦不到、缓存建不起来），离线启动
        // 会话 CacheFirst 恒 miss、grammar 三层全败降级 hljs。安装期 precache
        // 确定化入缓存，首次离线会话即命中；内容随 grammar 集构建演进，workbox
        // 按内容 revision 翻新（换版 SW 更新即重装）。产物内 .json 仅此两文件
        // （grammars/manifest.json + _app/version.json，后者 <100B）。
        // html 不入 glob：index.html 只有 additionalManifestEntries 单一来源
        //（build/ 下无其他 html，已核实）——workbox-build 对 additional 条目不去重
        //（direct push），若 glob 也抓到 index.html 会产生同 URL 双 revision 条目，
        // SW 求值期抛 add-to-cache-list-conflicting-entries → 完全死 SW。
        // 图表引擎增量 chunk（codeSplitting groups → diagram-engines-*.js，仅
        // viz+nomnoml）不入 precache：本计划新增引擎按需加载即可，防止 precache
        // 膨胀——预算门禁（tools/diagram-budget.mjs，spec §2.6）另行约束其总量
        // ≤4MB。mermaid/katex 为存量依赖，回归默认分块与 precache 地位（裁决见
        // diagramEngineChunk 注释），不在此排除。
        // 排除必须走 globIgnores 而非 globPatterns 内嵌 '!...' 否定条目（brief 原写法
        // 实测无效）：workbox-build 对 globPatterns 逐条独立 glob（getFileManifestEntries），
        // 否定条目单独跑恒零匹配（且恒报 doesn't-match warning），不参与排除；文件仍被
        // 主 pattern 收集，仅因超过 maximumFileSizeToCacheInBytes（2MiB 默认）落出清单，
        // 同时触发 vite-plugin-pwa throwMaximumFileSizeToCacheInBytes 抛错。globIgnores
        // 前三项为 workbox-build 默认值（覆盖式传入须显式带上），末项为本排除。
        // seti.woff（T4 备案裁决：离线首用图标字体可用）走精确路径而非把 woff 加进
        // 泛化组——客户端产物内另有 katex 20 件 KaTeX_*.woff（~330KB），泛化 woff 会
        // 全数误收进 precache。`*` 覆盖 vite hash 中缀（seti.<hash>.woff）。
        globPatterns: ['**/*.{js,css,woff2,json}', '**/seti.*.woff'],
        // 末段为按需加载 chunk 排除：git 引擎 chunk（2026-10-31 git 信息面板 spec，
        // isomorphic-git 经 codeSplitting groups 落 git-engine-*.js）与 foreign 渲染器
        // 组（计划 3 Task 3，spec §6.2——@file-viewer/* 代码面按组落 foreign-*-*.js，
        // 代码包 chunk 分离进 dist 但绝不进 precache：全局约束 + iwork chunk 4.05MB
        // 超 workbox 2MiB 单文件上限）+ foreign worker 匿名资产（终审修复 C1：
        // renderer-ppt/pptx 以 new URL('./xxx.worker.js', import.meta.url) 引用的
        // worker 被 vite 发射为 _app/immutable/assets/pptjs.worker.*.js /
        // pptx.worker.*.js（约 1.06MB）——不经 foreign-* 组 chunk 命名，漏配即被
        // workbox 收进 precache（foreign-budget --check 的 precache-worker 断言
        // 兜底）；第二波同发射机制复现三件（计划 4 Task 3 实测）：renderer-dicom
        // 的 decode-worker-*.js（8.02MB，超 workbox 2MiB 上限——不配即 PWA 插件
        // throwMaximumFileSizeToCacheInBytes 构建失败，iwork 同款）与 renderer-design
        // 的 idml.worker.*.js / postscript.worker.*.js（<2MiB，漏配即静默 precache）。
        // 均按需加载不进 precache（同 diagram-engines 语义，膨胀防护 + 预算门禁按
        // 前缀计账）。renderer-signature 的两个 bundled worker entry（vite 以
        // _app/immutable/workers/ 带名发射，<2MiB 漏配即静默 precache——T2 遗留实测，
        // 计划 4 Task 3 封堵；其共享 chunk 经 worker 图 foreign-signature-worker 组
        // 带名由 '**/foreign-*.js' 覆盖）：own 面的 binary.worker/ts-worker/gitWorker/
        // mp4v.worker 不含此文件名段，不受影响。
        // rpgp wasm 备案（计划 4 终审复核→残余 A7 已修）：renderer-signature 的
        // rpgp-wasm/rpgp_wrapper_bg.wasm（worker 内经 import.meta.url 相对 fetch）经
        // 下方 vv-worker-wasm 路由 CacheFirst（在线二次打开免重复下载；离线签名不可
        // 用属 foreign 姿态——signature.worker 不进 precache，本路由不改变该面）；
        // .wasm 仍不在 precache globPatterns 内，无需 globIgnores 条目。
        globIgnores: [
          '**/node_modules/**/*',
          'sw.js',
          'workbox-*.js',
          '**/diagram-engines-*.js',
          '**/git-engine-*.js',
          '**/foreign-*.js',
          '**/pptjs.worker*.js',
          '**/pptx.worker*.js',
          '**/decode-worker-*.js',
          '**/idml.worker*.js',
          '**/postscript.worker*.js',
          '**/signature.worker*.js',
          '**/container.worker*.js'
        ],
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
        // BUG-60 配套：vv-* 运行时缓存跨版本清理（static/vv-sw-cleanup.js，构建期
        // genSwCleanup 生成并烘焙 BUILD_REVISION；activate 删除非当前 REV 命名的
        // vv-* 缓存——cleanupOutdatedCaches 只清 precache 前缀，cacheName 拼
        // BUILD_REVISION 的运行时缓存换版后永久残留）。
        // importScripts 相对 sw.js 所在根解析；子路径托管（VV_BASE_PATH）同前缀。
        importScripts: [`${kitBase}/vv-sw-cleanup.js`],
        runtimeCaching: [
          {
            // tree-sitter 语法 wasm（~8MB 总量）：不变内容，缓存优先；
            // cacheName 拼构建修订号——新版本部署后旧缓存不再命中（跨版本陈旧修复）
            urlPattern: /\/grammars\/.*\.wasm$/,
            handler: 'CacheFirst',
            options: {
              cacheName: `vv-grammars-${BUILD_REVISION}`,
              // maxEntries 500：全量 grammar 集 ~299 个 wasm（grammar.yml 门禁构建），
              // 300 会在全量集下提前逐出仍被使用的条目；跨版本陈旧由 cacheName 修订号兜底
              expiration: { maxEntries: 500, purgeOnQuotaError: true },
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
            // BUG-59 配套：libarchive.wasm（static/libarchive/ 静态拷贝，~1MB）此前
            // 不在 precache（glob 不含 .wasm）也无 runtimeCaching 路由——离线打开
            // tar/tgz/xz/7z/rar 时 worker 初始化取不到 wasm，20s 超时错误卡。该 wasm
            // 由 libarchive.js 的 classic worker（new Worker(workerUrl)）内 fetch——
            // classic worker 受页面 SW 控制，CacheFirst 离线命中；CacheFirst 同上，
            // 修订号兜底跨版本陈旧。
            urlPattern: /\/libarchive\/libarchive\.wasm$/,
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
          },
          {
            // svgbob 前端 wasm 引擎（diagram-engines 动态 import 的同包资产，实测
            // ~0.37MB）：内容随构建指纹恒定，CacheFirst + 修订号缓存名（跨版本陈旧
            // 由 cacheName 兜底）
            urlPattern: /svgbob_wasm_bg[\w.-]*\.wasm$/,
            handler: 'CacheFirst',
            options: {
              cacheName: `vv-diagram-svgbob-${BUILD_REVISION}`,
              expiration: { maxEntries: 2, purgeOnQuotaError: true },
              cacheableResponse: { statuses: [200] }
            }
          },
          {
            // 残余 A7：worker 图发射的同源 wasm 资产（_app/immutable/workers/assets/
            // *.wasm——renderer-signature 的 rpgp_wrapper_bg、mp4v.worker 的
            // mp4v-decoder、ts-worker 的 worker 版 tree-sitter，均在 worker 内经
            // import.meta.url 相对 fetch）此前不在 precache（glob 不含 .wasm）也无
            // 路由——在线二次打开重复下载。CacheFirst + 修订号缓存名；文件名带内容
            // hash，跨版本陈旧天然免疫。如实备案：signature.worker 属 foreign 代码面
            //（不进 precache），离线签名本就不可达（foreign 姿态）——本路由只省在线
            // 会话的重复下载，不承诺离线签名；own 面 worker（mp4v/ts-worker）的 wasm
            // 则随本路由获得离线二次可用性（worker 本体已 precache）。
            urlPattern: /\/_app\/immutable\/workers\/assets\/.+\.wasm$/,
            handler: 'CacheFirst',
            options: {
              cacheName: `vv-worker-wasm-${BUILD_REVISION}`,
              expiration: { maxEntries: 8, purgeOnQuotaError: true },
              cacheableResponse: { statuses: [200] }
            }
          },
          {
            // foreign 渲染资产（spec §6.2，计划 3 Task 3）：@file-viewer/assets-* npm
            // 包 jsdelivr 直链（assets-standard/-chm/-hangul/-iwork/-ppt/-wordperfect，
            // 精确版本进 URL——跨版本陈旧天然免疫，同 vv-cdn-engines 原则）。规则置于
            // vv-cdn-engines 的 jsdelivr 通配之前（workbox 路由先匹配先赢）：foreign
            // 资产工作集（worker/wasm/ppt 运行时分片）独立计账，不挤占引擎分片的
            // maxEntries 配额。env VV_FOREIGN_ASSETS 跨域镜像域形态由下方条件路由
            // 承接（残余 A8 双路由），同源路径形态由 /file-viewer-assets/ 预留槽承接
            //（SW 规则构建期定型，运行时 env 值不可预知——缺省 CDN 前缀 + env 镜像
            // 前缀 + 预留前缀覆盖）。
            urlPattern: /^https:\/\/cdn\.jsdelivr\.net\/npm\/@file-viewer\/assets-/,
            handler: 'CacheFirst',
            options: {
              cacheName: `vv-foreign-assets-${BUILD_REVISION}`,
              // maxEntries 64 覆盖第一波（assets-standard/-chm/-hangul/-iwork/
              // -wordperfect 的 worker/wasm 工作集）+ 第二波（计划 4 Task 3 HEAD 台账：
              // data sql wasm 1、design worker×6+wasm×2、typst wasm×2+字体 17、drawing
              // viewer-static 等；全族同会话极端工作集 ~45 项 < 64）不半途 LRU 逐出打折扣。
              // assets-ppt 如实注记（终审修复 I2）：renderer-ppt 走内置
              // import('@file-viewer/ppt')（wasmRequired:false），ppt/pot 当前零 CDN
              // 资产消费，vendor/ppt/dist 不经此规则；未来经 presentation.pptModuleUrl
              // 显式切 CDN 时其级联分片自动落此规则（urlPattern 前缀已覆盖），届时
              // 按分片量复核 maxEntries。
              expiration: { maxEntries: 64, purgeOnQuotaError: true },
              cacheableResponse: { statuses: [200] }
            }
          },
          // 残余 A8：env VV_FOREIGN_ASSETS 跨域镜像域双路由（构建期定型，env 为空
          // 仅默认 CDN 路由）。镜像 base 与 foreignAssets.ts 同一消费语义（尾斜杠
          // 归一），urlPattern 由 base 字面转义锚定前缀——镜像资产同族，共用
          // vv-foreign-assets 计账（不另开支缓存名，LRU 工作集口径一致）。同源路径
          // 形态（/file-viewer-assets/ 合并树）不在此生成：预留槽路由已覆盖。
          // 预构造常量展开（类型注记见常量侧注释）。
          ...FOREIGN_MIRROR_RUNTIME_CACHING,
          {
            // foreign 资产同源预留槽（FOREIGN_ASSETS_SAME_ORIGIN_PREFIX，plan 4 接线；
            // asset-installer 合并树布局）：CacheFirst 同上；cacheableResponse 仅 200
            //——404 不入缓存（前缀未部署时零副作用）；SPA fallback 的 200 HTML 由
            // 服务端 Accept 收窄治理（server/src/lib.rs `serve_index` 只对导航请求回
            // index.html，SWR-DEF-01）——SW 层无法按 content-type 过滤（generateSW
            // 不支持自定义 cacheWillUpdate plugin），运行期锚见 SWR-ROUTE-07
            urlPattern: /\/file-viewer-assets\//,
            handler: 'CacheFirst',
            options: {
              cacheName: `vv-foreign-assets-${BUILD_REVISION}`,
              expiration: { maxEntries: 64, purgeOnQuotaError: true },
              cacheableResponse: { statuses: [200] }
            }
          },
          {
            // CDN 图表引擎（spec §6：excalidraw/bpmn/vega/vegalite 经 jsdelivr +esm
            // 精确版本动态 import，新 CDN 类型同吃此规则）：CacheFirst 后二次访问
            // 近似离线；版本进 URL，跨版本陈旧天然免疫（修订号仅缓存名换代用）。
            // bpmn-js 子路径 +esm 会级联拉取数十个依赖分片（每片均精确版本化，实测
            // bpmn 依赖图 35 片），maxEntries 48 覆盖常用集不半途 LRU 逐出打折扣
            urlPattern: /^https:\/\/cdn\.jsdelivr\.net\/npm\/.*/,
            handler: 'CacheFirst',
            options: {
              cacheName: `vv-cdn-engines-${BUILD_REVISION}`,
              expiration: { maxEntries: 48, purgeOnQuotaError: true },
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
    __BUILD_REVISION__: JSON.stringify(BUILD_REVISION),
    // 前端版本（settings center spec §2.1 关于分节）：package.json version 单独
    // 注入（不含修订时间戳，与服务端 CARGO_PKG_VERSION 直接可比）
    __APP_VERSION__: JSON.stringify(pkg.version),
    // P2 资产三层解析链：CDN 层 base（grammar 资产目录前缀，以 / 结尾；空 = 不启用）。
    // highlightClient.ts 读 import.meta.env.VV_GRAMMAR_CDN——vite 默认不注入任意
    // 自定义 env，需在此显式静态替换（构建期定型，e2e/CI 以同名 env 控制）。
    'import.meta.env.VV_GRAMMAR_CDN': JSON.stringify(process.env.VV_GRAMMAR_CDN ?? ''),
    // 计划 3 Task 3（spec §6.2）：foreign 渲染资产三层链的 env 显式层（自托管
    // asset-installer 合并树根，尾斜杠归一在 resolveForeignAssetBase；空 = 缺省
    // CDN 层）。foreignAssets.ts 消费，VV_GRAMMAR_CDN 同款注入先例。
    'import.meta.env.VV_FOREIGN_ASSETS': JSON.stringify(process.env.VV_FOREIGN_ASSETS ?? '')
  }
});
