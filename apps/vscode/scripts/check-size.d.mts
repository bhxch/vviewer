// check-size.d.mts — check-size.mjs 的类型声明。
export declare const SIZE_LIMIT_BYTES: number;
export declare function dirSize(dir: string): number;
export declare function assertUnderLimit(bytes: number, limit?: number, label?: string): number;
export declare function checkSize(options?: {
  distDir?: string;
  vsixPath?: string;
  limit?: number;
}): { distBytes: number; vsixBytes: number | null };
