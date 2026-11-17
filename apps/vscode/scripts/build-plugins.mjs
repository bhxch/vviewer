// build-plugins.mjs — esbuild 插件集（spec H T1）。
//
// 本模块**不 import esbuild**（esbuild 的 lib/main.js 在加载期做环境不变式断言，
// 在 jsdom 下恒假 → 单测无法 import 依赖它的模块）——插件对象本身是纯数据 + 纯函数，
// 单测可直接驱动其 onResolve/onLoad 回调验证语义。

import fs from 'node:fs';
import path from 'node:path';

/**
 * svgbob glue 条件桩（评审订正②）。
 *
 * 真实 import 路径**逐字照抄** packages/vviewer-render-diagram/src/markdown/diagramEngines.ts:63
 * —— `import('./svgbob-wasm-gen/svgbob_wasm.js')`（初版误写为 `svbob_wasm.js`，少一个 g；
 * 照字面实现的过滤器匹配不到真实 import → 桩不命中 → 新 checkout 仍以「Could not resolve」
 * 失败）。该生成目录不入库（.gitignore 排除 svgbob-wasm-gen/*.js 与 *.wasm）→ esbuild 须
 * 静态解析该 dynamic import。
 *
 * 落定：文件在 → 正常打包（完整 svgbob 围栏渲染）；文件不在 → esbuild 插件桩模块
 * （default() 抛错 → 运行期围栏降级链）。故扩展构建**不强制 Rust 工具链**。
 */
export const SVGBOB_GLUE_IMPORT = /svgbob-wasm-gen[\\/]svgbob_wasm\.js$/;

/** 桩模块源码：default() 抛错（运行期由包内管线 catch 后走降级链） */
export const SVGBOB_STUB_SOURCE = `export default async function init() {
  throw new Error('svgbob glue 未生成：需 pnpm gen:svgbob-wasm');
}
export function render() {
  throw new Error('svgbob glue 未生成：需 pnpm gen:svgbob-wasm');
}
`;

/** svgbob glue 条件桩插件 */
export const svgbobStubPlugin = {
  name: 'svgbob-glue-conditional-stub',
  setup(build) {
    build.onResolve({ filter: SVGBOB_GLUE_IMPORT }, (args) => {
      const abs = path.resolve(args.resolveDir, args.path);
      if (fs.existsSync(abs)) return null; // 文件在 → 正常打包
      return { path: abs, namespace: 'svgbob-stub' };
    });
    build.onLoad({ filter: /.*/, namespace: 'svgbob-stub' }, () => ({
      contents: SVGBOB_STUB_SOURCE,
      loader: 'js'
    }));
  }
};

/**
 * katex CSS 空实现插件。
 *
 * 包内 packages/vviewer-markdown/src/pipeline.ts:643 的 `import('katex/dist/katex.min.css')`
 * 是 **vite 专属**的样式注入形态（vite 抽成独立样式 chunk 按需注入 <style>）——esbuild 无
 * 此机制：若不拦截，esbuild 会把 CSS 打进产物并连带复制其引用的字体资产（重复且走相对
 * URL）。故构建期把该 import 解析为空模块（运行期 import 成功但无副作用），排印样式由
 * 扩展自备注入面提供（`dist/webview/katex.min.css` + `fonts/`，T3 接线）。
 */
export const katexCssStubPlugin = {
  name: 'katex-css-noop',
  setup(build) {
    build.onResolve({ filter: /^katex\/dist\/katex\.min\.css$/ }, () => ({
      path: 'katex-css-noop',
      namespace: 'katex-css-noop'
    }));
    build.onLoad({ filter: /.*/, namespace: 'katex-css-noop' }, () => ({
      contents: 'export default {};',
      loader: 'js'
    }));
  }
};

/**
 * node 内建模块桩插件（仅用于 browser 平台的 bundle）。
 *
 * web-tree-sitter（packages/vviewer-highlight 的运行时依赖）内含 node 分支的动态
 * import（`await import("fs/promises")` / `await import("module")`）——浏览器平台下
 * esbuild 报「Could not resolve "fs/promises"」。该分支由 `ENVIRONMENT_IS_NODE` 守卫，
 * 浏览器/worker 恒不执行，故构建期解析为空模块即可。
 *
 * 为何用桩而非 `external`：桩不留 external 记录 → 产物图（metafile）无 external 残留，
 * 「无未解析 import」门（唯一豁免 = host bundle 的 vscode）保持成立。
 *
 * 桩名单只含仓内依赖图**无同名 npm 包**者（`buffer`/`events`/`process` 三个 npm 包在图内
 * ——不可桩，否则会顶掉真包）。
 */
export const NODE_BUILTIN_STUB = /^(node:)?(fs|fs\/promises|module|os|path|url|crypto|worker_threads)$/;

export const nodeBuiltinStubPlugin = {
  name: 'node-builtin-stub',
  setup(build) {
    build.onResolve({ filter: NODE_BUILTIN_STUB }, (args) => ({
      path: args.path,
      namespace: 'node-builtin-stub'
    }));
    build.onLoad({ filter: /.*/, namespace: 'node-builtin-stub' }, () => ({
      contents: 'export default {};\nexport const promises = {};\n',
      loader: 'js'
    }));
  }
};
