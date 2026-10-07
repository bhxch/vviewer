import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig, type Plugin } from 'vite';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const QUERIES_SRC = fileURLToPath(new URL('../../packages/highlight/assets/queries', import.meta.url));
const QUERIES_DEST = fileURLToPath(new URL('./static/queries', import.meta.url));

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
  plugins: [sveltekit(), copyTsQueries(), copyLibarchiveAssets()],
  // ts-worker 依赖 web-tree-sitter（内部含动态 import），必须以 ES module worker 打包（iife 不支持 code-splitting）
  worker: {
    format: 'es'
  }
});
