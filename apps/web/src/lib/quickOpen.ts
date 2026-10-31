import type { TreeStore } from '@bhxch/vviewer-core';

/**
 * QuickOpenPanel（BUG-03 Ctrl+P 快速打开）的可单测纯逻辑：
 * 递归列文件（应用排除规则）、输入过滤与路径工具。
 * 抽离为普通 .ts 的原因：根 vitest 无 svelte 插件，.svelte/.svelte.ts 内逻辑不可单测。
 * workspace 多根（T4）：扫描入参从单 store 扩为来源列表，结果携带 storeId 供面板按源打开。
 */

/**
 * 排除判定：与 FileTree.svelte / TreeNodeRow.svelte 的 excluded() 同规则——
 * 全名相等，或 `*.后缀` 通配（以 name 结尾匹配）。
 */
export function excludedName(name: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => name === p || (p.startsWith('*.') && name.endsWith(p.slice(1))));
}

/** 多源扫描的一个结果：path 为源内相对路径，storeId 指回来源（面板按源 addTab）。
 * size（io-streaming 计划 2 Task 4）：TreeNode.size 透传，供打开链路写入 Tab.source.size
 * （dispatcher 读策略与渲染器 ctx.size 消费）；缺省 = 条目无大小信息。 */
export interface ScannedFile {
  storeId: string;
  path: string;
  name: string;
  size?: number;
}

/**
 * 递归列出全部来源内的文件（相对路径），按来源顺序串行扫描。目录整棵命中
 * 排除规则时跳过子树；深度优先、目录内保持 listChildren 原顺序。
 * maxFiles 为跨源全局上限，防巨型树失控（前源打满即止，不再进入后源）。
 * opts.onWarn（BUG-27）：单目录 listChildren 失败（服务端 403/断网等）不再
 * 一票否决整表——树侧 TreeNodeRow.svelte 同款单目录降级：告警 + 跳过该子树，
 * 其余条目照常可列可开。告警文本由调用方透出（面板状态行）。
 */
export async function listFilesRecursively(
  sources: ReadonlyArray<{ label: string; store: TreeStore }>,
  patterns: readonly string[],
  opts?: { maxFiles?: number; onWarn?: (message: string) => void }
): Promise<ScannedFile[]> {
  const maxFiles = opts?.maxFiles ?? 5000;
  const out: ScannedFile[] = [];
  for (const src of sources) {
    if (out.length >= maxFiles) break;
    const storeId = src.store.id;
    const walk = async (dirPath: string): Promise<void> => {
      let children: Awaited<ReturnType<TreeStore['listChildren']>>;
      try {
        children = await src.store.listChildren(dirPath);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        opts?.onWarn?.(`目录 ${dirPath === '' ? src.label : dirPath} 列举失败：${message}`);
        return; // 跳过失败子树，兄弟层与其余来源继续
      }
      for (const node of children) {
        if (out.length >= maxFiles) return;
        if (excludedName(node.name, patterns)) continue;
        if (node.kind === 'dir') await walk(node.path);
        // size 条件展开：无大小信息的条目不落 size 键（既有结果形状不变，quickOpen.test
        // 的 toEqual 断言零变更）；有则透传供打开链路消费
        else {
          out.push(
            node.size !== undefined
              ? { storeId, path: node.path, name: node.name, size: node.size }
              : { storeId, path: node.path, name: node.name }
          );
        }
      }
    };
    await walk('');
  }
  return out;
}

/** 路径 → 文件名（最后一段）。 */
export function fileNameOf(path: string): string {
  return path.split('/').pop() ?? path;
}

/**
 * 输入过滤：不区分大小写的子串匹配（按 path）；文件名命中的条目排在仅路径命中
 * 之前（组内保持原序，sort 引擎稳定）。maxResults 截断列表渲染量。
 * 泛型作用于带 path 的任意条目（T4 起面板传 ScannedFile，保留形状透传）。
 */
export function filterFiles<T extends { path: string }>(
  files: readonly T[],
  query: string,
  maxResults = 100
): T[] {
  const q = query.trim().toLowerCase();
  const pool = q === '' ? [...files] : files.filter((f) => f.path.toLowerCase().includes(q));
  if (q !== '') {
    pool.sort(
      (a, b) => Number(fileNameOf(b.path).toLowerCase().includes(q)) - Number(fileNameOf(a.path).toLowerCase().includes(q))
    );
  }
  return pool.slice(0, maxResults);
}
