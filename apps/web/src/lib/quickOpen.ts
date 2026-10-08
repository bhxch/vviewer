import type { TreeStore } from '@vviewer/core';

/**
 * QuickOpenPanel（BUG-03 Ctrl+P 快速打开）的可单测纯逻辑：
 * 递归列文件（应用排除规则）、输入过滤与路径工具。
 * 抽离为普通 .ts 的原因：根 vitest 无 svelte 插件，.svelte/.svelte.ts 内逻辑不可单测。
 */

/**
 * 排除判定：与 FileTree.svelte / TreeNodeRow.svelte 的 excluded() 同规则——
 * 全名相等，或 `*.后缀` 通配（以 name 结尾匹配）。
 */
export function excludedName(name: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => name === p || (p.startsWith('*.') && name.endsWith(p.slice(1))));
}

/**
 * 递归列出 store 内全部文件（相对路径）。目录整棵命中排除规则时跳过子树；
 * 深度优先、目录内保持 listChildren 原顺序。maxFiles 封顶防巨型树失控。
 */
export async function listFilesRecursively(
  store: TreeStore,
  patterns: readonly string[],
  opts?: { maxFiles?: number }
): Promise<string[]> {
  const maxFiles = opts?.maxFiles ?? 5000;
  const out: string[] = [];
  const walk = async (dirPath: string): Promise<void> => {
    const children = await store.listChildren(dirPath);
    for (const node of children) {
      if (out.length >= maxFiles) return;
      if (excludedName(node.name, patterns)) continue;
      if (node.kind === 'dir') await walk(node.path);
      else out.push(node.path);
    }
  };
  await walk('');
  return out;
}

/** 路径 → 文件名（最后一段）。 */
export function fileNameOf(path: string): string {
  return path.split('/').pop() ?? path;
}

/**
 * 输入过滤：不区分大小写的子串匹配；文件名命中的条目排在仅路径命中之前
 *（组内保持原序，sort 引擎稳定）。maxResults 截断列表渲染量。
 */
export function filterFiles(files: readonly string[], query: string, maxResults = 100): string[] {
  const q = query.trim().toLowerCase();
  const pool = q === '' ? [...files] : files.filter((p) => p.toLowerCase().includes(q));
  if (q !== '') {
    pool.sort((a, b) => Number(fileNameOf(b).toLowerCase().includes(q)) - Number(fileNameOf(a).toLowerCase().includes(q)));
  }
  return pool.slice(0, maxResults);
}
