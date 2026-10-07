/**
 * 计算路由：按 policy × 能力 × 来源路径裁决一次计算在本地还是远程执行。
 *
 * 路由语义（三类后端同构）：
 * - policy 'local'：恒本地（不触碰远程）；
 * - policy 'remote'：有能力且调用侧提供了 remoteFn 才走远程，失败**不回退**、
 *   如实报错——远程是用户的显式选择，静默回退会掩盖配置问题；
 * - policy 'auto'：有能力且 src.path 存在（文件来自远程 store 才有服务端 path
 *   语义）走远程，失败回退本地（可用性优先）。
 *
 * router 不发起网络请求：remoteCall() 只负责拼 URL 与鉴权头，remoteFn 由
 * 调用侧组装（便于单测注入 mock，也让网络策略留在应用层）。
 */

import type {
  ComputePolicy,
  ComputeResult,
  ComputeSource,
  HighlightInterval,
  MarkdownComputeOptions
} from './types';

/**
 * 服务端 14 语言中带 injections.scm 者（实测 packages/highlight/assets/queries/
 * {rust,c,cpp,go,html,javascript}/injections.scm 存在；css/typescript/tsx 等无）。
 * 服务端 v1 无 injection（M6 计划级裁决）：对这些语言远程高亮会丢注入区间
 * （markdown 围栏、HTML 内嵌脚本等），auto 策略应留在本地 worker。
 */
export const INJECTION_LANGS: ReadonlySet<string> = new Set([
  'rust',
  'c',
  'cpp',
  'go',
  'html',
  'javascript'
]);

/**
 * highlightClient 装配 highlight remoteFn 的路由规则：auto 下注入语言不远程
 * （服务端 v1 无 injection，本地高亮保注入完整，可用性优先）；显式 remote
 * 是用户选择，仍装配（丢注入由该显式选择自担）。
 */
export function highlightRemoteEligible(policy: ComputePolicy, lang: string): boolean {
  return !(policy === 'auto' && INJECTION_LANGS.has(lang));
}

export interface ComputeRouterOptions {
  /** 连接缓存里是否含 "compute" 能力（capabilities 来自连接时 /api/health）。 */
  hasCompute: () => boolean;
  /** 当前计算策略（settings.computePolicy 的实时读取）。 */
  policy: () => ComputePolicy;
  /** 会话内已连接服务器的 base 与 token（未连接时 base 返回 null）。 */
  remote: { base: () => string | null; token: () => string | null };
}

/** 远程调用描述：remoteCall() 产出，调用侧据此构造 fetch。 */
export interface RemoteComputeCall {
  url: string;
  headers: Record<string, string>;
}

type RemoteFn<T, A extends unknown[]> = (...args: A) => Promise<T>;

export interface ComputeRouter {
  routeHighlight(
    src: ComputeSource,
    lang: string,
    localFn: () => Promise<HighlightInterval[]>,
    remoteFn?: RemoteFn<HighlightInterval[], [src: ComputeSource, lang: string]>
  ): Promise<ComputeResult<HighlightInterval[]>>;
  routeMarkdown(
    src: ComputeSource | undefined,
    text: string,
    options: MarkdownComputeOptions | undefined,
    localFn: () => Promise<string>,
    remoteFn?: RemoteFn<string, [text: string, options: MarkdownComputeOptions | undefined]>
  ): Promise<ComputeResult<string>>;
  /**
   * 跨文件/文件内搜索共用裁决：泛型数据形状（文件内 SearchMatch、跨文件
   * GrepMatch 等任意命中数组），router 只负责 policy × 能力 × 来源裁决与回退。
   */
  routeSearch<T>(
    src: ComputeSource,
    query: string,
    localFn: () => Promise<T[]>,
    remoteFn?: RemoteFn<T[], [src: ComputeSource, query: string]>
  ): Promise<ComputeResult<T[]>>;
  /** 组装远程请求的 URL 与鉴权头；未连接服务器（base 为 null）返回 null。 */
  remoteCall(apiPath: string): RemoteComputeCall | null;
}

/**
 * 裁决纯函数：local 恒本地；无能力或无 remoteFn 一律本地；
 * remote 直接远程；auto 还要求 src 有服务端 path 语义才远程。
 */
export function decideComputeRoute(
  policy: ComputePolicy,
  hasCompute: boolean,
  hasRemoteFn: boolean,
  hasServerPath: boolean
): 'local' | 'remote' {
  if (policy === 'local') return 'local';
  if (!hasCompute || !hasRemoteFn) return 'local';
  if (policy === 'remote') return 'remote';
  return hasServerPath ? 'remote' : 'local';
}

function hasServerPath(src: ComputeSource | undefined): boolean {
  return typeof src?.path === 'string' && src.path !== '';
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 执行裁决结果：remote 失败时仅 auto 允许回退 local（policy() 需实时读）。 */
async function runRouted<T>(
  decision: 'local' | 'remote',
  policy: () => ComputePolicy,
  localFn: () => Promise<T>,
  remoteFn: (() => Promise<T>) | undefined
): Promise<ComputeResult<T>> {
  if (decision === 'remote' && remoteFn) {
    try {
      return { where: 'remote', ok: true, data: await remoteFn() };
    } catch (err) {
      if (policy() !== 'auto') {
        return { where: 'remote', ok: false, error: errorText(err) }; // 显式 remote：不回退
      }
      // auto：远程失败回退本地
    }
  }
  try {
    return { where: 'local', ok: true, data: await localFn() };
  } catch (err) {
    return { where: 'local', ok: false, error: errorText(err) };
  }
}

export function createComputeRouter(opts: ComputeRouterOptions): ComputeRouter {
  const decisionFor = (hasServer: boolean, hasRemoteFn: boolean): 'local' | 'remote' =>
    decideComputeRoute(opts.policy(), opts.hasCompute(), hasRemoteFn, hasServer);
  return {
    routeHighlight(src, lang, localFn, remoteFn) {
      const decision = decisionFor(hasServerPath(src), remoteFn !== undefined);
      return runRouted(decision, opts.policy, localFn, remoteFn ? () => remoteFn(src, lang) : undefined);
    },
    routeMarkdown(src, text, options, localFn, remoteFn) {
      const decision = decisionFor(hasServerPath(src), remoteFn !== undefined);
      return runRouted(
        decision,
        opts.policy,
        localFn,
        remoteFn ? () => remoteFn(text, options) : undefined
      );
    },
    routeSearch<T>(src: ComputeSource, query: string, localFn: () => Promise<T[]>, remoteFn?: RemoteFn<T[], [src: ComputeSource, query: string]>) {
      const decision = decisionFor(hasServerPath(src), remoteFn !== undefined);
      return runRouted(decision, opts.policy, localFn, remoteFn ? () => remoteFn(src, query) : undefined);
    },
    remoteCall(apiPath) {
      const base = opts.remote.base();
      if (!base) return null;
      const token = opts.remote.token();
      const headers: Record<string, string> = {};
      if (token) headers.authorization = `Bearer ${token}`;
      return { url: `${base}${apiPath}`, headers };
    }
  };
}
