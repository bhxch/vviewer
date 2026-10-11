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
import { loadSettings } from './stores/settings';

/**
 * 全局搜索的路由胶水（M6 T4；workspace 多根 T4 扩多源）：来源列表 × 用户策略 →
 * 远程 ripgrep（POST /api/search）或纯前端内存 grep。裁决/回退语义复用
 * ComputeRouter，但用独立的 router 实例：search 是 file-server 基础能力（服务端
 * 挂在 Bearer 组、不要求 --compute；ripgrep 缺失以 501 应答供 auto 回退），health 的
 * "compute" 能力位对它没有裁决意义，故 hasCompute 恒真——回退与"显式
 * remote 不静默回退"语义仍由 router 提供。
 */

/** 搜索来源（与 FileTree/QuickOpenPanel 的 sources 同形：workspace.sources × 活动实例）。 */
export interface SearchSource {
  label: string;
  store: TreeStore;
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
 * 远程 ripgrep（T4 多源合并）：同 base 的 remote 源合并为一次请求。请求不带
 * path——多根服务器语义「跨根搜索 path 必须缺省」（带了即 400），单根服务器
 * 缺省即唯一根，与历史单源请求形状一致。endpoint 由 loadLastServer 构造
 * （router.remote.base），故仅 base 与其一致的来源参与远端（base 不匹配的来源
 * 在 auto 下由本地回退覆盖）。
 * 已知边界（T5 评审收尾，移交 T7）：命中统一归组内首个来源的 storeId——多根
 * 服务器跨根搜索时非 0 号根的命中会以首源 store 打开（路径空间/归属错位）。
 * 精确归属需 core grepRemote 解析命中帧的 root 字段 + 按 members[].rootIndex
 * 归属；未顺手实现的原因：T5 起 basePath 子目录来源使「同根多源」成为常态
 * （rootIndex 不再唯一），且帧路径相对根、子目录源的路径空间相对 basePath，
 * 仅按 root 归属仍会错标——需要帧路径按源 basePath 换算的完整方案，非小改。
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
  return r.matches;
}

/**
 * 执行一次全局搜索（T4 多源）。canceled() 为真时本地 grep 尽快自弃；signal 取消
 * 远程 fetch/流读。返回执行位置与 truncated；auto 策略回退时 degraded = true。
 * 抛错仅发生在显式 remote 策略的远程失败（router 语义），调用方展示消息。
 * 本地路径：逐源 grepStoreLocal 串行合并，进度跨源累加、截断任一源触达即置位。
 */
export async function runGlobalSearch(
  sources: ReadonlyArray<SearchSource>,
  query: string,
  opts: GlobalSearchOptions,
  onProgress: ((filesDone: number) => void) | undefined,
  canceled: () => boolean,
  signal: AbortSignal
): Promise<GlobalSearchResult> {
  const remoteSources = sources.filter((s) => isRemoteStore(s.store));
  const remote = remoteSources.length > 0;
  // path 哨兵 '/'：全局搜索作用于整个 store 而非单文件；remote store 才有
  // 服务端 path 语义，router 据此（连同 remoteFn 有无）完成裁决
  const src: ComputeSource = remote ? { path: '/', storeId: remoteSources[0]!.store.id } : {};
  let truncated = false;
  const res = await searchRouter.routeSearch(
    src,
    query,
    async () => {
      const matches: GrepMatch[] = [];
      let localTruncated = false;
      let done = 0; // 已完成源的累计文件数（进度跨源累加的基线）
      for (const s of sources) {
        if (canceled()) return matches;
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
        localTruncated = localTruncated || r.truncated;
        done += seen;
      }
      truncated = localTruncated;
      return matches;
    },
    remote
      ? () => remoteGrep(remoteSources, query, opts, (t) => (truncated = t), signal)
      : undefined
  );
  if (!res.ok) throw new Error(res.error ?? '搜索失败');
  return {
    matches: res.data ?? [],
    truncated,
    where: res.where,
    degraded: remote && res.where === 'local' && loadSettings().computePolicy === 'auto'
  };
}
