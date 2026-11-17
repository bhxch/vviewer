// build-plugins.test.ts — esbuild 插件语义契约（spec H T1）。
//
// 核心回归锚（计划 Errata ①）：svgbob 条件桩的**拦截路径逐字照抄真实 import**
// —— packages/vviewer-render-diagram/src/markdown/diagramEngines.ts:63 的
// `import('./svgbob-wasm-gen/svgbob_wasm.js')`。初版误写为 `svbob_wasm.js`（少一个 g）
// → 过滤器匹配不到真实 import → 桩不命中 → 新 checkout 仍以「Could not resolve」失败。
// 本组用例把「逐字匹配」与「不误匹配初版误写」双向钉死。
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  NODE_BUILTIN_STUB,
  SVGBOB_GLUE_IMPORT,
  SVGBOB_STUB_SOURCE,
  katexCssStubPlugin,
  nodeBuiltinStubPlugin,
  svgbobStubPlugin,
  type StubBuild,
  type StubPlugin
} from '../scripts/build-plugins.mjs';

/** 捕获插件注册的 onResolve / onLoad 回调（模拟 esbuild 的 PluginBuild） */
function capture(plugin: StubPlugin): {
  resolve: (args: { path: string; resolveDir: string; importer: string }) => unknown;
  load: (args: { path: string }) => unknown;
  resolveFilter: RegExp;
} {
  let resolveFn: ((args: { path: string; resolveDir: string; importer: string }) => unknown) | null = null;
  let loadFn: ((args: { path: string }) => unknown) | null = null;
  let resolveFilter = /.*/;
  const build: StubBuild = {
    onResolve(options, callback) {
      resolveFilter = options.filter;
      resolveFn = callback;
    },
    onLoad(_options, callback) {
      loadFn = callback;
    }
  };
  plugin.setup(build);
  if (!resolveFn || !loadFn) throw new Error(`插件 ${plugin.name} 未注册 onResolve/onLoad`);
  return {
    resolve: (args) => resolveFn!(args),
    load: (args) => loadFn!(args),
    resolveFilter
  };
}

describe('svgbob glue 条件桩', () => {
  it('过滤器逐字匹配真实 import（diagramEngines.ts:63 的相对路径）', () => {
    expect(SVGBOB_GLUE_IMPORT.test('./svgbob-wasm-gen/svgbob_wasm.js')).toBe(true);
    expect(SVGBOB_GLUE_IMPORT.test('svgbob-wasm-gen/svgbob_wasm.js')).toBe(true);
  });

  it('不匹配初版误写（少一个 g 的 svbob_wasm.js）——Errata ① 回归锚', () => {
    expect(SVGBOB_GLUE_IMPORT.test('./svgbob-wasm-gen/svbob_wasm.js')).toBe(false);
  });

  it('glue 文件存在 → 不桩（正常打包，完整 svgbob 能力）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vv-svgbob-exists-'));
    const glueDir = path.join(dir, 'svgbob-wasm-gen');
    fs.mkdirSync(glueDir);
    fs.writeFileSync(path.join(glueDir, 'svgbob_wasm.js'), 'export default async function () {}');
    const { resolve } = capture(svgbobStubPlugin);
    const res = resolve({
      path: './svgbob-wasm-gen/svgbob_wasm.js',
      resolveDir: dir,
      importer: 'diagramEngines.ts'
    });
    expect(res).toBeNull();
  });

  it('glue 文件不存在 → 桩模块（default() 抛错，运行期围栏降级）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vv-svgbob-absent-'));
    const { resolve, load } = capture(svgbobStubPlugin);
    const res = resolve({
      path: './svgbob-wasm-gen/svgbob_wasm.js',
      resolveDir: dir,
      importer: 'diagramEngines.ts'
    }) as { path: string; namespace: string };
    expect(res.namespace).toBe('svgbob-stub');
    expect(res.path).toBe(path.join(dir, 'svgbob-wasm-gen', 'svgbob_wasm.js'));
    const loaded = load({ path: res.path }) as { contents: string; loader: string };
    expect(loaded.loader).toBe('js');
    expect(loaded.contents).toContain('export default');
    expect(loaded.contents).toContain('pnpm gen:svgbob-wasm');
    expect(SVGBOB_STUB_SOURCE).toBe(loaded.contents);
  });
});

describe('katex CSS 空实现插件', () => {
  it('只拦 katex/dist/katex.min.css（包内 pipeline.ts:643 的动态 import）', () => {
    const { resolveFilter } = capture(katexCssStubPlugin);
    expect(resolveFilter.test('katex/dist/katex.min.css')).toBe(true);
    expect(resolveFilter.test('katex/dist/katex.css')).toBe(false);
    expect(resolveFilter.test('katex')).toBe(false);
  });

  it('解析为空模块（esbuild 下不注入样式，排印样式由扩展自备面提供）', () => {
    const { resolve, load } = capture(katexCssStubPlugin);
    const res = resolve({
      path: 'katex/dist/katex.min.css',
      resolveDir: '/tmp',
      importer: 'pipeline.ts'
    }) as { namespace: string };
    expect(res.namespace).toBe('katex-css-noop');
    const loaded = load({ path: 'katex/dist/katex.min.css' }) as { contents: string; loader: string };
    expect(loaded.loader).toBe('js');
    expect(loaded.contents).toContain('export default');
  });
});

describe('node 内建模块桩插件', () => {
  it('拦 fs/promises 与 module（web-tree-sitter 的 node 分支动态 import）', () => {
    expect(NODE_BUILTIN_STUB.test('fs/promises')).toBe(true);
    expect(NODE_BUILTIN_STUB.test('module')).toBe(true);
    expect(NODE_BUILTIN_STUB.test('node:fs/promises')).toBe(true);
  });

  it('不拦图内存在同名 npm 包者（buffer/events/process——桩之会顶掉真包）', () => {
    expect(NODE_BUILTIN_STUB.test('buffer')).toBe(false);
    expect(NODE_BUILTIN_STUB.test('events')).toBe(false);
    expect(NODE_BUILTIN_STUB.test('process')).toBe(false);
  });

  it('解析为空模块', () => {
    const { resolve, load } = capture(nodeBuiltinStubPlugin);
    const res = resolve({ path: 'fs/promises', resolveDir: '/tmp', importer: 'tree-sitter.js' }) as {
      namespace: string;
    };
    expect(res.namespace).toBe('node-builtin-stub');
    const loaded = load({ path: 'fs/promises' }) as { contents: string };
    expect(loaded.contents).toContain('export default');
  });
});
