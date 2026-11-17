#!/usr/bin/env node
// tools/check-e2e-surfaces.mjs — e2e CI「仓库树消费面」自检（spec G 分片产物传递护栏）。
//
// 背景（spec G 实施期 review 定损）：分片拓扑把「构建期产物」从 e2e job 移到 e2e-prep
// 并经 artifact 下发，plan 的 Review Focus 5 只盘点了「运行时消费面 = spec 进程
// readFileSync apps/web/e2e/fixtures/corpus/ 相对路径」，漏盘了两类消费面：
//   ① spec 进程直读**仓库树**（Node 侧 barrel import 的生成物 + 顶层 readFileSync 的资产表）；
//   ② spec 进程直读**构建产物目录**（adapter-static 的 apps/web/build——产物层断言面
//      与 server --web-dist 面）；
//   ③ spec 进程 spawn 的**预编译二进制**（server/target/debug/vviewer）。
// 三面漏配的后果不是断言红而是**文件级加载失败**（spec 模块求值期抛错 → 整文件用例
// 全 error），分片 runner 上呈「用例守恒」崩塌——本脚本把这三面固化成显式清单，
// prep 侧（产出面）与 shard 侧（消费面）各跑一次，缺件即在构建/下载后立刻红，
// 而不是等 190 个用例变成 error 后人工回查。
//
// 用法：node tools/check-e2e-surfaces.mjs --stage=consumer|producer
//   consumer = e2e 分片 runner 必备面（artifact 下发后自检）
//   producer = e2e-prep 产出面（consumer 全部 + grammar 源树/清单/queries 等生成物）
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

/**
 * 分片 runner 必备消费面（spec 进程树在本仓工作树内直读的路径）。
 * type: 'file' | 'dir' —— 目录面要求目录存在（内容完整性另有产物自带的门禁负责）。
 */
export const CONSUMER_SURFACES = [
  {
    path: 'packages/vviewer-core/src/registry/generated-extensions.ts',
    type: 'file',
    why: '@bhxch/vviewer-core barrel 顶层导出（packages/vviewer-core/src/index.ts:9）——9 个 e2e spec 顶层 import，缺件即整文件加载失败'
  },
  {
    path: 'packages/vviewer-highlight/assets/themes.json',
    type: 'file',
    why: 't-theme.spec.ts 顶层 readFileSync（模块求值期执行）——缺件即整文件 26 用例 error'
  },
  {
    path: 'packages/vviewer-highlight/assets/languages.json',
    type: 'file',
    why: '@bhxch/vviewer-highlight 的 langdetect.ts 静态 JSON import（包 index → langdetect）——Node 侧 spec 传递依赖，缺件即加载失败'
  },
  {
    path: 'apps/web/.svelte-kit/output/server/manifest.js',
    type: 'file',
    why: 'kit 3 vite preview 伺服面（启动即校验 output/server/manifest.js 存在，缺失直接 preview_build_missing）'
  },
  {
    path: 'apps/web/.svelte-kit/output/client',
    type: 'dir',
    why: 'preview 伺服 client 树（wasm/queries 等 static/ 拷贝物在内）'
  },
  {
    path: 'apps/web/build/index.html',
    type: 'file',
    why: 'adapter-static 部署产物（fallback 页）——b-sw-runtime-cache 自建伺服面与 m5/m6/b-git-panel 的 server --web-dist 面'
  },
  {
    path: 'apps/web/build/sw.js',
    type: 'file',
    why: 'SW 产物层断言面（b-sw-runtime-cache SWR-ROUTE-07 读 sw.js 字面量）'
  },
  {
    path: 'apps/web/build/_app/immutable',
    type: 'dir',
    why: '构建期 env 注入反查面（b-sw-runtime-cache readBuildEnvValue / b-ext-bindings buildEnvMirrorBase 遍历此树）'
  },
  {
    path: 'server/target/debug/vviewer',
    type: 'file',
    why: 'server 预编译二进制（m5/m6/b-git-panel 经 serverHarness spawn）——e2e-prep 编译后经 artifact 下发，分片内零 cargo 编译'
  },
  {
    path: 'apps/web/e2e/fixtures/corpus/manifest.json',
    type: 'file',
    why: '多源渲染语料清单（corpus artifact 下发面；语料逐用例 existsSync 容错 skip，清单缺失即整域退化）'
  }
];

/**
 * e2e-prep 产出面必备项（consumer 全部 + 生成物侧）。
 * 注：shard 侧**刻意不下发** server/grammars-manifest.json 与 assets/queries——
 * 二者是 cargo build.rs 的编译期输入，分片内不编译 Rust；下发而无 grammar 源树会
 * 让误触发的 cargo build 静默产出「0 grammar」partial 构建（无声降级），缺件时的
 * build.rs panic（显式指向 pnpm gen:sources）才是正确形态。
 */
export const PRODUCER_ONLY_SURFACES = [
  {
    path: 'server/grammars-manifest.json',
    type: 'file',
    why: 'cargo build.rs 的语言清单输入（gen-sources 产物，不入库）'
  },
  {
    path: 'packages/vviewer-highlight/assets/queries',
    type: 'dir',
    why: 'cargo build.rs copy_queries 的查询资产输入（gen-sources 产物，不入库）'
  },
  {
    path: 'tools/grammar-builder/out/grammars',
    type: 'dir',
    why: 'grammar 源码树（cargo build 编译 C/C++ parser 的输入；1.9GB 全量不过 artifact，故只在 prep 侧）'
  },
  {
    path: 'apps/web/static/grammars',
    type: 'dir',
    why: 'wasm 产物（web build 期拷入 client 树；此为 prep 侧产出面）'
  },
  {
    path: 'apps/web/static/tree-sitter.wasm',
    type: 'file',
    why: 'web-tree-sitter 运行时 wasm（web build 期拷入 client 树）'
  }
];

/** 判定单个消费面是否满足（存在性 + 形态） */
export function checkSurface(root, surface) {
  const abs = path.join(root, surface.path);
  if (!existsSync(abs)) return { ok: false, reason: '缺失' };
  const st = statSync(abs);
  if (surface.type === 'dir' && !st.isDirectory()) return { ok: false, reason: '应为目录' };
  if (surface.type === 'file' && !st.isFile()) return { ok: false, reason: '应为文件' };
  return { ok: true, reason: '' };
}

/** 解析 --stage 参数（缺省 consumer）：支持 `--stage=producer` 与 `--stage producer` 两形态 */
export function parseStage(argv) {
  const inline = argv.find((a) => a.startsWith('--stage='));
  if (inline !== undefined) return inline.slice('--stage='.length);
  const j = argv.indexOf('--stage');
  if (j !== -1 && argv[j + 1]) return argv[j + 1];
  return 'consumer';
}

function main(argv) {
  const stage = parseStage(argv);
  if (stage !== 'consumer' && stage !== 'producer') {
    console.error(`--stage 非法：${stage}（可选 consumer | producer）`);
    return 2;
  }
  const surfaces = stage === 'producer' ? [...CONSUMER_SURFACES, ...PRODUCER_ONLY_SURFACES] : CONSUMER_SURFACES;
  const missing = [];
  for (const s of surfaces) {
    const r = checkSurface(repoRoot, s);
    if (r.ok) {
      console.log(`✓ ${s.path}`);
    } else {
      console.log(`✗ ${s.path} —— ${r.reason}：${s.why}`);
      missing.push(s);
    }
  }
  if (missing.length > 0) {
    console.error(
      `\n[check-e2e-surfaces] stage=${stage} 缺 ${missing.length}/${surfaces.length} 项消费面——` +
        'e2e 进程树将因缺件整文件加载失败（用例级 error 而非断言红）。' +
        'e2e-prep 侧查产出面、分片侧查消费面，两侧同清单。'
    );
    return 1;
  }
  console.log(`\n[check-e2e-surfaces] stage=${stage}：${surfaces.length} 项消费面齐备。`);
  return 0;
}

// 仅在被直接执行时跑 main（导出面供单测/其他脚本复用）
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2));
}
