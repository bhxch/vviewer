import type { GrammarTable } from '@bhxch/vviewer-highlight';

/**
 * grammar 资产三层解析链（spec §3）：同源 → 服务端 → CDN，逐层 fetch 各自的
 * manifest.json 并做 first-wins 合并——同名语言以先命中层（更近的来源）为准。
 * 每个条目写全 `base`（wasm 目录前缀），worker 端 doPrepare 按 entry.base 加载；
 * 单层 fetch 失败（非 2xx / 200 text/html SPA fallback / 网络错）仅 console.warn 并
 * 跳过该层，绝不阻塞其余层
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

/**
 * 清单感知判定（spec E 修 2）：lang（canonical 键或条目别名）在合并表内——本地
 * worker 能否解析该语言的判据快照（worker manifest 与本表同源，ok:false 必然时
 * 调用方可提前跳过 doomed 往返）。table null（create 在途/rebuild 清窗）→ true
 * fail-open：不拦，交 worker 链既有裁决（清单未就绪不是拒绝理由）。
 *
 * 大小写归一（BUG-42 回归锚，T4 定向回归捕获）：输入 lang 可能原样透传自 markdown
 * 围栏标识（```Rust）或用户手输——worker 链 canonicalLang/buildAliasTable 已双侧
 * toLowerCase 归一（core-parse.ts），门判定不归一即「门比 worker 链严格」，会把
 * worker 本可解析的语言误判清单外（错误 hljs 降级注记）。键与别名双侧归一，与
 * worker 链同口径。
 */
export function grammarTableHas(table: MergedGrammarTable | null, lang: string): boolean {
  if (table === null) return true; // fail-open
  const key = lang.toLowerCase();
  for (const [name, entry] of Object.entries(table)) {
    if (name.toLowerCase() === key) return true;
    if (entry.aliases?.some((a) => a.toLowerCase() === key)) return true;
  }
  return false;
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

/**
 * 拉取单层 manifest：非 2xx / 200 text/html（SPA fallback）/ 网络错 → null +
 * console.warn（跳层语义的折叠点）。
 */
export async function fetchGrammarManifest(url: string): Promise<GrammarTable | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`[vviewer] grammar manifest ${url}: HTTP ${res.status}, skipping this asset layer`);
      return null;
    }
    // SPA-fallback 防御（与 core-parse remoteQueryLoader 的 C1 前端层修复同款）：
    // 静态服务器把缺失 manifest 兜底成 200 index.html 时视为层缺失——不嗅探会在
    // res.json() 抛 SyntaxError 走 catch，warn 文案误导为网络错。
    if ((res.headers.get('content-type') ?? '').includes('text/html')) {
      console.warn(`[vviewer] grammar manifest ${url}: non-JSON asset response (SPA fallback?), skipping this asset layer`);
      return null;
    }
    const json = (await res.json()) as { grammars?: GrammarTable };
    return json.grammars ?? null;
  } catch (e) {
    console.warn(`[vviewer] grammar manifest ${url} failed to load, skipping this asset layer:`, e);
    return null;
  }
}

/**
 * 装配三层候选并合并：same-origin 恒在；server 层（连接时快照，见下）拼
 * `${serverBase}/grammars/`；cdn 层直接用 cdnBase——spec C 拆包多基（Task 3）：
 * `|` 分隔多基逐基展开为独立 cdn 子包层（层名 cdn-p1..pN，单基时层名 'cdn'
 * 不变——既有 e2e 层名锚零回归），first-wins 合并同语义。逐层串行 fetch，
 * 命中的层以层名回报于 layers。
 */
export async function assembleGrammarLayers(opts: {
  sameOriginBase: string;
  serverBase?: string | null;
  cdnBase?: string | string[] | null;
}): Promise<{ grammars: MergedGrammarTable; layers: string[] }> {
  const candidates: Array<{ name: string; base: string }> = [
    { name: 'same-origin', base: opts.sameOriginBase }
  ];
  if (opts.serverBase) candidates.push({ name: 'server', base: `${opts.serverBase.replace(/\/+$/, '')}/grammars/` });
  const cdnBases = Array.isArray(opts.cdnBase) ? opts.cdnBase : opts.cdnBase ? [opts.cdnBase] : [];
  cdnBases.forEach((base, i) => {
    candidates.push({ name: cdnBases.length > 1 ? `cdn-p${i + 1}` : 'cdn', base });
  });
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
