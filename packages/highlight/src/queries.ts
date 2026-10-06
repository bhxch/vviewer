/** 单个语言目录的查询资产（正文文本，含头部注释）。 */
export interface QueryFile {
  highlights?: string;
  injections?: string;
}

/** 语言名 → 查询资产（expandQuery 的 assets 参数类型）。 */
export type QueryAssets = Map<string, QueryFile>;

/** 展开继承后的查询组合。 */
export interface ExpandedQuery {
  highlights: string;
  injections: string;
}

interface ParsedHeader {
  /** 头部声明 `; inherits: a, b` 的父目录列表（保持声明顺序，无声明为 []）。 */
  parents: string[];
  /** 剥离头部 inherits 指令行后的正文。 */
  body: string;
}

/**
 * 解析查询文件头部注释区：从文件开头起，空行与 `;` 注释行可交错；
 * 出现第一条正文（非空非注释）后头部区结束。
 * `; inherits: a, b` 指令行从正文剥离（仅头部区内），其余注释原样保留。
 */
function parseHeader(source: string | undefined): ParsedHeader {
  if (source === undefined) return { parents: [], body: '' };
  const parents: string[] = [];
  const kept: string[] = [];
  let headerEnded = false;
  for (const line of source.split('\n')) {
    if (!headerEnded) {
      const trimmed = line.trim();
      if (trimmed === '') {
        kept.push(line);
        continue;
      }
      if (trimmed.startsWith(';')) {
        const match = /^;\s*inherits\s*:\s*(.+)$/i.exec(trimmed);
        if (match) {
          for (const name of match[1]!.split(',')) {
            const parent = name.trim();
            if (parent !== '') parents.push(parent);
          }
          continue; // 指令行剥离
        }
        kept.push(line);
        continue;
      }
      headerEnded = true;
    }
    kept.push(line);
  }
  return { parents, body: kept.join('\n') };
}

/**
 * 递归展开语言的查询继承（父在前子在后，按 '\n' 拼接为一份文本；不去重）。
 * - 环检测：继承链上重复访问抛 `Error('循环继承')`
 * - 缺父目录：console.warn 并跳过该父支
 * - 语言不在 assets 中返回 null
 */
export function expandQuery(assets: Map<string, QueryFile>, lang: string): ExpandedQuery | null {
  const cache = new Map<string, ExpandedQuery>();

  const resolve = (name: string, onPath: ReadonlySet<string>): ExpandedQuery => {
    const cached = cache.get(name);
    if (cached) return cached;
    const file = assets.get(name);
    if (!file) return { highlights: '', injections: '' };
    if (onPath.has(name)) throw new Error('循环继承');

    const path = new Set(onPath);
    path.add(name);
    const header = parseHeader(file.highlights);
    // inherits 声明优先读 highlights 头部，缺省再看 injections 头部
    const injectionHeader = parseHeader(file.injections);
    const parents = header.parents.length > 0 ? header.parents : injectionHeader.parents;
    const parts: ExpandedQuery[] = [];
    for (const parent of parents) {
      if (!assets.has(parent)) {
        console.warn(`[highlight] 缺少父查询目录: ${parent}（被 ${name} 继承，已跳过）`);
        continue;
      }
      parts.push(resolve(parent, path));
    }

    const merged: ExpandedQuery = {
      highlights: [...parts.map((p) => p.highlights), header.body]
        .filter((s) => s !== '')
        .join('\n'),
      injections: [...parts.map((p) => p.injections), injectionHeader.body]
        .filter((s) => s !== '')
        .join('\n'),
    };
    cache.set(name, merged);
    return merged;
  };

  if (!assets.has(lang)) return null;
  return resolve(lang, new Set());
}
