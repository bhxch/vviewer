import {
  createComputeRouter,
  getRemoteBase,
  grepRemote,
  grepStoreLocal,
  type ComputeRouter,
  type ComputeSource,
  type GrepMatch,
  type RemoteStore,
  type TreeStore
} from '@vviewer/core';
import { loadLastServer } from './openFlow.svelte';
import { isMountRootStoreId } from './serverHealthCache';
import { loadSettings } from './stores/settings';

/**
 * 全局搜索的路由胶水（M6 T4；workspace 多根 T4 扩多源）：来源列表 × 用户策略 →
 * 远程 ripgrep（POST /api/search）或纯前端内存 grep。裁决/回退语义复用
 * ComputeRouter，但用独立的 router 实例：search 是 file-server 基础能力（服务端
 * 挂在 Bearer 组、不要求 --compute；ripgrep 缺失以 501 应答供 auto 回退），health 的
 * "compute" 能力位对它没有裁决意义，故 hasCompute 恒真——回退与"显式
 * remote 不静默回退"语义仍由 router 提供。
 */

/** 搜索来源（与 FileTree/QuickOpenPanel 的 sources 同形：workspace.sources × 活动实例）。
 * rootIndex/basePath 为多根服务器的来源元数据（AppShell 从 workspace.sources 透传，
 * 仅 remote 来源携带；远程命中归属与 basePath 路径换算的依据，缺省 = 根 0 整根）。 */
export interface SearchSource {
  label: string;
  store: TreeStore;
  /** 服务器多根下的根索引（缺省 0）。 */
  rootIndex?: number;
  /** 根内子目录前缀：源内路径相对该前缀（帧路径相对根 → 剥前缀换算）。 */
  basePath?: string;
}

export interface GlobalSearchOptions {
  caseSensitive: boolean;
  regex: boolean;
}

export interface GlobalSearchResult {
  matches: GrepMatch[];
  truncated: boolean;
  where: 'local' | 'remote';
  /** auto 策略下远程 ripgrep 失败回退本地（面板据此显示降级提示条） */
  degraded: boolean;
  /** 存在挂载根来源（目录挂载 spec §3）：服务端 ripgrep 只对 fs 根，挂载根
   * 内容走浏览器内本地扫描（面板显示「该根不可服务端搜索」提示条）。
   * 能力边界裁决，与 policy 无关（显式 remote 也不对挂载根白发注定失败的请求）。 */
  mountSearchDegraded: boolean;
}

/** 挂载根来源提示文案（brief：挂载根显式 root 的 404 收敛为本文案）。 */
export const MOUNT_SEARCH_DEGRADED_HINT = '该根不可服务端搜索，已切换浏览器内搜索';

/** store 是否为挂载根来源（rootIndex ≥ fsRoots 的 remote store，spec §3）。 */
export function isMountRootSource(s: SearchSource): boolean {
  return isMountRootStoreId(s.store.id);
}

/** store 是否为远程服务器 store（唯一有服务端 path 语义的来源）。 */
export function isRemoteStore(store: TreeStore): boolean {
  return typeof (store as Partial<RemoteStore>).watch === 'function';
}

/**
 * 纯前端搜索触达扫描上限时的服务器模式引导文案（BUG-11/CMP-11）。
 * 文案覆盖两类上限（2000 文件 / 200MB 累计，GREP_MAX_BYTES）：截断路径共用
 * 本提示，措辞不指认具体触因（200MB 触发时旧文案「已达 2000 文件」与事实不符）。
 */
export const SERVER_SEARCH_HINT =
  '已触达扫描上限（2000 文件 / 200MB 累计），建议在顶栏连接服务器后使用服务器端搜索';

/**
 * 截断时的引导文案裁决（BUG-11，纯函数可单测）：来源列表中存在远程来源（已是
 * 服务器模式，CMP-08 截断）不引导；全部为纯前端（非远程）来源时引导；列表为空
 * （未打开目录）不引导。面板层仅负责「truncated && hint 非空」的显示时机。
 */
export function serverSearchHint(sources: ReadonlyArray<SearchSource> | null): string | null {
  if (!sources || sources.length === 0) return null;
  if (sources.some((s) => isRemoteStore(s.store))) return null;
  return SERVER_SEARCH_HINT;
}

const searchRouter: ComputeRouter = createComputeRouter({
  hasCompute: () => true,
  policy: () => loadSettings().computePolicy,
  remote: {
    base: () => loadLastServer()?.baseUrl ?? null,
    token: () => loadLastServer()?.token ?? null
  }
});

/**
 * 远端命中归属（T5 移交兑现，纯函数可单测）：跨根搜索的命中帧带 root（单根
 * 服务器/本地扫描省略 = 根 0），按 members 中 rootIndex 匹配的来源归属。
 * 同根多源（root 0 整根源 + basePath 子目录源并存是常态，rootIndex 不唯一）
 * 取「basePath 是命中路径前缀者中最长」的最具体源，帧路径剥该源 basePath 前缀
 * 换算回源相对路径；前缀均不匹配时回退整根源（帧路径即其路径空间）。
 * 无法消歧（该根无已登记来源 / 只有 basePath 源且前缀均不匹配）时保守保持
 * members[0] 摊派原样（grepRemote 以 members[0].storeId 摊派）——与移交前行为
 * 一致，宁可打不开也不误开他源的同名文件。
 */
export function attributeRemoteMatches(
  matches: ReadonlyArray<GrepMatch>,
  members: ReadonlyArray<SearchSource>
): GrepMatch[] {
  return matches.map((m) => {
    const root = m.root ?? 0;
    const candidates = members.filter((s) => (s.rootIndex ?? 0) === root);
    if (candidates.length === 0) return { ...m }; // 该根无已登记来源：保守归 members[0]
    // 最具体优先：basePath 是帧路径前缀的候选中最长 basePath（同 basePath 同 storeId）
    const stripped = candidates
      .filter((s) => s.basePath !== undefined && m.path.startsWith(`${s.basePath}/`))
      .sort((a, b) => b.basePath!.length - a.basePath!.length)[0];
    if (stripped !== undefined) {
      return { ...m, storeId: stripped.store.id, path: m.path.slice(stripped.basePath!.length + 1) };
    }
    const whole = candidates.find((s) => s.basePath === undefined);
    if (whole !== undefined) return { ...m, storeId: whole.store.id }; // 帧路径相对根 = 整根源路径空间
    return { ...m }; // 保守：命中不在任何已登记子源内且无整根源
  });
}

/**
 * 远程 ripgrep（T4 多源合并）：同 base 的 remote 源合并为一次请求。请求不带
 * path——多根服务器语义「跨根搜索 path 必须缺省」（带了即 400），单根服务器
 * 缺省即唯一根，与历史单源请求形状一致。endpoint 由 loadLastServer 构造
 * （router.remote.base），故仅 base 与其一致的来源参与远端；base 不匹配的来源
 * 由调用方（runGlobalSearch 远端路径）本地补扫覆盖，不经本函数。
 * 跨根归属（T5 移交兑现）：命中帧 root 字段由 grepRemote 透传，经
 * attributeRemoteMatches 按 members 的 rootIndex/basePath 归属到正确来源并换算
 * 路径；无法消歧的命中保守保持 members[0] 摊派（见该函数 doc）。
 * truncated 不在返回契约内，经回调透传给调用方（与本地路径同模式）。
 */
async function remoteGrep(
  group: ReadonlyArray<SearchSource>,
  query: string,
  opts: GlobalSearchOptions,
  onTruncated: (t: boolean) => void,
  signal: AbortSignal
): Promise<GrepMatch[]> {
  const call = searchRouter.remoteCall('/api/search');
  if (!call) throw new Error('未连接服务器，无法远程搜索');
  const last = loadLastServer();
  const members =
    last === null ? [] : group.filter((s) => getRemoteBase(s.store.id) === last.baseUrl);
  if (members.length === 0) throw new Error('未连接服务器，无法远程搜索');
  const r = await grepRemote(
    call,
    {
      pattern: query,
      caseSensitive: opts.caseSensitive,
      regex: opts.regex
    },
    { storeId: members[0]!.store.id, signal }
  );
  onTruncated(r.truncated);
  return attributeRemoteMatches(r.matches, members);
}

/**
 * 逐源本地扫描（本地路径主扫与远端路径非 members 补扫共用）：串行 grepStoreLocal
 * 合并命中，进度跨源累加（onProgress 报「累计已扫文件数」），任一源触达上限即置位
 * truncated。canceled() 为真时尽快返回已扫部分（结果作废由调用方代际防护裁决）。
 */
async function grepSourcesLocal(
  sources: ReadonlyArray<SearchSource>,
  query: string,
  opts: GlobalSearchOptions,
  onProgress: ((filesDone: number) => void) | undefined,
  canceled: () => boolean
): Promise<{ matches: GrepMatch[]; truncated: boolean }> {
  const matches: GrepMatch[] = [];
  let truncated = false;
  let done = 0; // 已完成源的累计文件数（进度跨源累加的基线）
  for (const s of sources) {
    if (canceled()) return { matches, truncated };
    let seen = 0;
    const r = await grepStoreLocal(
      s.store,
      query,
      { caseSensitive: opts.caseSensitive, regex: opts.regex, canceled },
      onProgress === undefined
        ? undefined
        : (n) => {
            seen = Math.max(seen, n);
            onProgress(done + n);
          }
    );
    matches.push(...r.matches);
    truncated = truncated || r.truncated;
    done += seen;
  }
  return { matches, truncated };
}

/**
 * 执行一次全局搜索（T4 多源）。canceled() 为真时本地 grep 尽快自弃；signal 取消
 * 远程 fetch/流读。返回执行位置与 truncated；auto 策略回退时 degraded = true。
 * 抛错仅发生在显式 remote 策略的远程失败（router 语义），调用方展示消息。
 * 本地路径：逐源 grepStoreLocal 串行合并，进度跨源累加、截断任一源触达即置位。
 * 远端路径（T7 混合来源修复）：远端请求只覆盖 base 与 last-server 一致的 members
 * 源，其余来源（不同 base 的 remote 源 + 全部本地源）在远端路径内本地补扫合并——
 * 服务器一次请求触达不到它们，混合 workspace 不再静默漏搜本地源（本地源不依赖
 * 服务器、不受 auto 回退影响）。
 * 挂载根（目录挂载 spec §3）：remote store 但 rootIndex ≥ fsRoots 的根无服务端
 * 搜索（server 跨根搜索只覆盖 fs 根，显式 root 亦 404）——该类来源不进远端请求、
 * 走本地补扫（与 501 同一「非 200 → 浏览器内」降级通道的能力边界前置形态：
 * 不白发注定失败的请求），mountSearchDegraded 供面板显示收敛文案。
 */
export async function runGlobalSearch(
  sources: ReadonlyArray<SearchSource>,
  query: string,
  opts: GlobalSearchOptions,
  onProgress: ((filesDone: number) => void) | undefined,
  canceled: () => boolean,
  signal: AbortSignal
): Promise<GlobalSearchResult> {
  const remoteSources = sources.filter((s) => isRemoteStore(s.store) && !isMountRootSource(s));
  const mountDegraded = sources.some((s) => isMountRootSource(s));
  const remote = remoteSources.length > 0;
  // path 哨兵 '/'：全局搜索作用于整个 store 而非单文件；remote store 才有
  // 服务端 path 语义，router 据此（连同 remoteFn 有无）完成裁决
  const src: ComputeSource = remote ? { path: '/', storeId: remoteSources[0]!.store.id } : {};
  let truncated = false;
  const res = await searchRouter.routeSearch(
    src,
    query,
    async () => {
      const r = await grepSourcesLocal(sources, query, opts, onProgress, canceled);
      truncated = r.truncated;
      return r.matches;
    },
    remote
      ? async () => {
          // 非 members 源 = base 与 last-server 不一致的 remote 源 + 全部本地源
          //（local store 无 base，getRemoteBase 返回 undefined 必不等）。远端失败
          // 即抛（router 语义不变：auto 回退本地全量扫描 / remote 策略如实报错），
          // 故补扫在远端请求成功后进行。
          const last = loadLastServer();
          const nonMembers =
            last === null
              ? []
              : sources.filter(
                  (s) =>
                    !isRemoteStore(s.store) ||
                    isMountRootSource(s) || // 挂载根：服务端搜索不覆盖，本地补扫（spec §3）
                    getRemoteBase(s.store.id) !== last.baseUrl
                );
          const remoteMatches = await remoteGrep(
            remoteSources,
            query,
            opts,
            (t) => (truncated = t),
            signal
          );
          // 进度合计口径（最简）：远端 NDJSON 无逐文件进度事件、计 0，进度只累计
          // 本地补扫的文件数（自 0 起）；auto 回退时本地路径重新全量汇报
          const local = await grepSourcesLocal(nonMembers, query, opts, onProgress, canceled);
          truncated = truncated || local.truncated; // 任一路径截断即置位
          return [...remoteMatches, ...local.matches];
        }
      : undefined
  );
  if (!res.ok) throw new Error(res.error ?? '搜索失败');
  return {
    matches: res.data ?? [],
    truncated,
    where: res.where,
    degraded: remote && res.where === 'local' && loadSettings().computePolicy === 'auto',
    mountSearchDegraded: mountDegraded
  };
}
