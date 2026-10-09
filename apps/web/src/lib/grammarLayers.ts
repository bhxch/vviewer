import type { GrammarTable } from '@vviewer/highlight';

/**
 * grammar 资产三层解析链（spec §3）：同源 → 服务端 → CDN，逐层 fetch 各自的
 * manifest.json 并做 first-wins 合并——同名语言以先命中层（更近的来源）为准。
 * 每个条目写全 `base`（wasm 目录前缀），worker 端 doPrepare 按 entry.base 加载；
 * 单层 fetch 失败（非 2xx / 网络错）仅 console.warn 并跳过该层，绝不阻塞其余层
 * （可用性优先于完整性：合并结果缺某语言时，该语言高亮降级，其余语言不受影响）。
 *
 * base 契约：同时容纳 manifest.json 与 *.wasm 的目录前缀（以 / 结尾），三层同构
 * ——同源 static/grammars/、服务端 <origin>/grammars/、CDN <pkg>@<ver>/grammars/
 * （pack 布局的修正由 Task 4 承接）；wasm URL = `${base}${file}`，不得再插中间段。
 */
export interface GrammarLayer {
  base: string;
  table: GrammarTable;
}

/** 合并产物：每条目 base 恒存在（「每条注记来源」契约的类型化表达）。 */
export type MergedGrammarTable = Record<string, { file: string; aliases?: string[]; base: string }>;

/** 条目 → wasm 预热 URL：base 已含目录段，直接拼文件名（joinPath 同语义，不翻倍）。 */
export function grammarWarmUrl(entry: { base: string; file: string }): string {
  return `${entry.base}${entry.file}`;
}

/** 依序合并各层（first-wins）：每条目写全 base，别名表随条目原样并入。 */
export function mergeGrammarLayers(layers: GrammarLayer[]): MergedGrammarTable {
  const out: MergedGrammarTable = {};
  for (const layer of layers) {
    for (const [lang, entry] of Object.entries(layer.table)) {
      if (out[lang]) continue; // first-wins
      out[lang] = { ...entry, base: layer.base };
    }
  }
  return out;
}

/** 拉取单层 manifest：非 2xx / 网络错 → null + console.warn（跳层语义的折叠点）。 */
export async function fetchGrammarManifest(url: string): Promise<GrammarTable | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`[vviewer] grammar manifest ${url}: HTTP ${res.status}，跳过该资产层`);
      return null;
    }
    const json = (await res.json()) as { grammars?: GrammarTable };
    return json.grammars ?? null;
  } catch (e) {
    console.warn(`[vviewer] grammar manifest ${url} 加载失败，跳过该资产层:`, e);
    return null;
  }
}

/**
 * 装配三层候选并合并：same-origin 恒在；server 层（连接时快照，见下）拼
 * `${serverBase}/grammars/`；cdn 层直接用 cdnBase。逐层串行 fetch，命中的层
 * 以层名（same-origin/server/cdn）回报于 layers。
 */
export async function assembleGrammarLayers(opts: {
  sameOriginBase: string;
  serverBase?: string | null;
  cdnBase?: string | null;
}): Promise<{ grammars: MergedGrammarTable; layers: string[] }> {
  const candidates: Array<{ name: string; base: string }> = [
    { name: 'same-origin', base: opts.sameOriginBase }
  ];
  if (opts.serverBase) candidates.push({ name: 'server', base: `${opts.serverBase.replace(/\/+$/, '')}/grammars/` });
  if (opts.cdnBase) candidates.push({ name: 'cdn', base: opts.cdnBase });
  const layers: GrammarLayer[] = [];
  const hit: string[] = [];
  for (const c of candidates) {
    const table = await fetchGrammarManifest(`${c.base}manifest.json`);
    if (table) {
      layers.push({ base: c.base, table });
      hit.push(c.name);
    }
  }
  return { grammars: mergeGrammarLayers(layers), layers: hit };
}
