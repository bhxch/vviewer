// app-paths.ts — `$app/paths` 的 vitest 桩（SvelteKit 虚拟模块）。
//
// kit 3 移除了 `base` 字符串导出：以 `resolve('/')` 求得「<base>/」前缀（base='' 时为
// '/'，子路径托管时为 '/<base>/'）。桩取 base='' 的部署形态（resolve 原样返回）。
export const base = '';
export const assets = '';
export function resolve(path: string): string {
  return path;
}
