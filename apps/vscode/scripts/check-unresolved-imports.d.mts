// check-unresolved-imports.d.mts — check-unresolved-imports.mjs 的类型声明。
export interface MetafileImport {
  path: string;
  kind?: string;
  external?: boolean;
}

export interface MetafileOutput {
  imports?: MetafileImport[];
}

export interface Metafile {
  outputs: Record<string, MetafileOutput>;
}

export declare function findUnresolvedImports(
  metafile: Metafile,
  allowedExternals?: string[]
): Array<{ file: string; path: string; kind?: string }>;
export declare function assertNoUnresolvedImports(
  metafile: Metafile,
  allowedExternals?: string[]
): Array<{ file: string; path: string; kind?: string }>;
