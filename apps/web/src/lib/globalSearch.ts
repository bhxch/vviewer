import {
  createComputeRouter,
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
 * 全局搜索的路由胶水（M6 T4）：活动目录 store × 用户策略 → 远程 ripgrep
 * （POST /api/search）或纯前端内存 grep。裁决/回退语义复用 ComputeRouter，
 * 但用独立的 router 实例：search 是 file-server 基础能力（服务端挂在 Bearer
 * 组、不要求 --compute；ripgrep 缺失以 501 应答供 auto 回退），health 的
 * "compute" 能力位对它没有裁决意义，故 hasCompute 恒真——回退与"显式
 * remote 不静默回退"语义仍由 router 提供。
 */

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

/** 活动目录 store 是否为远程服务器 store（唯一有服务端 path 语义的来源）。 */
export function isRemoteStore(store: TreeStore): boolean {
  return typeof (store as Partial<RemoteStore>).watch === 'function';
}

const searchRouter: ComputeRouter = createComputeRouter({
  hasCompute: () => true,
  policy: () => loadSettings().computePolicy,
  remote: {
    base: () => loadLastServer()?.baseUrl ?? null,
    token: () => loadLastServer()?.token ?? null
  }
});

async function remoteGrep(
  store: TreeStore,
  query: string,
  opts: GlobalSearchOptions,
  signal: AbortSignal
): Promise<{ matches: GrepMatch[]; truncated: boolean }> {
  const call = searchRouter.remoteCall('/api/search');
  if (!call) throw new Error('未连接服务器，无法远程搜索');
  return grepRemote(
    call,
    {
      pattern: query,
      caseSensitive: opts.caseSensitive,
      regex: opts.regex
    },
    { storeId: store.id, signal }
  );
}

/**
 * 执行一次全局搜索。canceled() 为真时本地 grep 尽快自弃；signal 取消远程
 * fetch/流读。返回执行位置与 truncated；auto 策略回退时 degraded = true。
 * 抛错仅发生在显式 remote 策略的远程失败（router 语义），调用方展示消息。
 */
export async function runGlobalSearch(
  store: TreeStore,
  query: string,
  opts: GlobalSearchOptions,
  onProgress: ((filesDone: number) => void) | undefined,
  canceled: () => boolean,
  signal: AbortSignal
): Promise<GlobalSearchResult> {
  const remote = isRemoteStore(store);
  // path 哨兵 '/'：全局搜索作用于整个 store 而非单文件；remote store 才有
  // 服务端 path 语义，router 据此（连同 remoteFn 有无）完成裁决
  const src: ComputeSource = remote ? { path: '/', storeId: store.id } : {};
  let truncated = false;
  const res = await searchRouter.routeSearch(
    src,
    query,
    async () => {
      const r = await grepStoreLocal(
        store,
        query,
        { caseSensitive: opts.caseSensitive, regex: opts.regex, canceled },
        onProgress
      );
      truncated = r.truncated;
      return r.matches;
    },
    remote ? () => remoteGrep(store, query, opts, signal) : undefined
  );
  if (!res.ok) throw new Error(res.error ?? '搜索失败');
  return {
    matches: res.data ?? [],
    truncated,
    where: res.where,
    degraded: remote && res.where === 'local' && loadSettings().computePolicy === 'auto'
  };
}
