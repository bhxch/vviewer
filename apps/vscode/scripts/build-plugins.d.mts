// build-plugins.d.mts — build-plugins.mjs 的类型声明。
//
// 插件对象为纯数据 + 纯函数（不 import esbuild——esbuild 的 lib/main.js 在加载期做环境
// 不变式断言，jsdom 下恒假 → 单测无法 import 依赖它的模块）。此处给出最小结构类型，
// 供单测直接驱动 onResolve/onLoad 回调验证语义。

export interface StubResolveArgs {
  path: string;
  resolveDir: string;
  importer: string;
}

export interface StubBuild {
  onResolve(
    options: { filter: RegExp },
    callback: (args: StubResolveArgs) => unknown
  ): void;
  onLoad(
    options: { filter: RegExp; namespace?: string },
    callback: (args: { path: string }) => unknown
  ): void;
}

export interface StubPlugin {
  name: string;
  setup(build: StubBuild): void;
}

export declare const SVGBOB_GLUE_IMPORT: RegExp;
export declare const SVGBOB_STUB_SOURCE: string;
export declare const svgbobStubPlugin: StubPlugin;
export declare const katexCssStubPlugin: StubPlugin;
export declare const NODE_BUILTIN_STUB: RegExp;
export declare const nodeBuiltinStubPlugin: StubPlugin;
