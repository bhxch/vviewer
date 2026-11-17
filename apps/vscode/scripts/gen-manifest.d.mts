// gen-manifest.d.mts — gen-manifest.mjs 的类型声明。
export interface ClaimedExtensions {
  extensions: string[];
  owners: Record<string, string>;
}

/** workspace 源 manifest 形态（apps/vscode/package.json） */
export interface SourceManifest {
  name?: string;
  version?: string;
  displayName?: string;
  description?: string;
  publisher?: string;
  license?: string;
  type?: string;
  engines?: Record<string, string>;
  categories?: string[];
  keywords?: string[];
  icon?: string;
  main?: string;
  repository?: unknown;
  contributes?: Record<string, unknown>;
  devDependencies?: Record<string, string>;
}

export declare const REPO_ROOT: string;
export declare const GENERATED_EXTENSIONS_PATH: string;

export declare function assertGeneratedExtensions(repoRoot?: string): string;
export declare function runRegistryCollection(repoRoot?: string): Promise<ClaimedExtensions>;
export declare function toSelector(extensions: readonly string[]): string[];
export declare function buildVsixManifest(
  sourceManifest: SourceManifest,
  claimed: ClaimedExtensions
): Record<string, unknown>;
export declare function readSourceManifest(repoRoot?: string): SourceManifest;
