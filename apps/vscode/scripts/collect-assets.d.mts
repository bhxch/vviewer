// collect-assets.d.mts — collect-assets.mjs 的类型声明（TS 侧 import 该 .mjs 时消费）。
// 实现本体是 .mjs（构建脚本，Node 直跑）；声明文件让 apps/vscode/test/*.test.ts
// 以类型安全方式直测其纯函数（vitest 直解析 .mjs 可跑；tsc 侧靠本声明）。
import type { PathLike } from 'node:fs';

export interface PdfWorkerPlan {
  id: string;
  pkgRel: string;
  outRel: string;
  src: string;
  bytes: number;
}

export interface CollectAssetsSummary {
  outDir: string;
  webviewDir: string;
  languages: number;
  queryLanguages: number;
  queryMissing: string[];
  pdfWorkers: Array<{ id: string; outRel: string; bytes: number }>;
  fonts: number;
  themes: string[];
}

export declare const REPO_ROOT: string;
export declare const ASSET_SOURCES: {
  grammars: string;
  runtimeWasm: string;
  queries: string;
  themes: string;
  icon: string;
};
export declare const FIX_COMMANDS: {
  grammars: string;
  queries: string;
  runtimeWasm: string;
  themes: string;
  icon: string;
  packages: string;
};
export declare const PDF_WORKERS: ReadonlyArray<{ id: string; pkgRel: string; outRel: string }>;
export declare const PACKAGED_THEMES: string[];
export declare const KATEX_FONT_EXT: string;

export declare function missingSourceError(what: string, fix: string): Error;
export declare function readGrammarManifest(grammarsDir: PathLike): {
  languages: string[];
  manifest: Record<string, unknown>;
};
export declare function selectQueryLanguages(
  languages: readonly string[],
  queriesDir: PathLike
): { selected: string[]; missing: string[] };
export declare function planPdfWorkers(pdfjsDir: PathLike): PdfWorkerPlan[];
export declare function listKatexFonts(katexDistDir: PathLike): string[];
export declare function buildKatexExportCss(katexDistDir: PathLike): string;
export declare function trimThemes(
  themes: Record<string, unknown>,
  keys?: readonly string[]
): Record<string, unknown>;
export declare function assertIcon(iconPath: PathLike): { path: string; bytes: number };
export declare function resolvePkgDir(
  pkgName: string,
  fromDir: PathLike | PathLike[],
  mode?: 'root' | 'entry'
): string;
export declare function collectAssets(options?: {
  repoRoot?: string;
  outDir?: string;
}): CollectAssetsSummary;
