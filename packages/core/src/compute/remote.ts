/**
 * 远程计算端点的响应解码与取消身份协议（Task 3）。
 *
 * 服务端 /api/compute/highlight 用紧凑编码：`{intervals: [[s,e,ci],...],
 * captures: [name,...]}`——区间是三元数组、捕获名去重为索引表，展开为
 * HighlightInterval[] 的工作在此集中（可单测），应用层 remoteFn 只做 fetch。
 *
 * 取消身份：ComputeRouter.runRouted 折叠失败时只保留 err.message，
 * HighlightCanceledError 的 name 身份会丢——取消错误经 encodeCanceled 把
 * 身份编入 message 前缀，折叠处用 isCanceledMessage 识别后重建
 * HighlightCanceledError（render-text 以该类型判定 tab 切换静默丢弃）。
 */

import type { HighlightInterval } from './types';

/** 取消身份在 ComputeResult.error 中的标记前缀。 */
export const COMPUTE_CANCELED_PREFIX = 'HighlightCanceled: ';

/** 把取消类错误包成普通 Error：身份编入 message，穿过 router 不丢。 */
export function encodeCanceled(err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err);
  return new Error(`${COMPUTE_CANCELED_PREFIX}${message}`);
}

/** 折叠处识别：该 error message 是否携带取消身份标记。 */
export function isCanceledMessage(error: string | undefined): boolean {
  return typeof error === 'string' && error.startsWith(COMPUTE_CANCELED_PREFIX);
}

/** 剥掉取消标记前缀，取回原始 message。 */
export function stripCanceledPrefix(error: string): string {
  return error.slice(COMPUTE_CANCELED_PREFIX.length);
}

/**
 * 显式 remote 计算失败的类型化错误（name 为 RemoteComputeFailed）。
 * ComputeResult 折叠只保留 message 字符串，类型身份会丢——调用侧（highlightClient
 * 的 withDebug）在 where==='remote' 且 !ok 时抛出本错误，渲染端（render-text code）
 * 以 instanceof 识别：显式 remote 是用户选择，失败如实显示错误卡，不静默降级 hljs
 * （与 router"显式 remote 不回退"的裁决一致；auto 的回退路径 where 为 local，不受影响）。
 */
export class RemoteComputeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RemoteComputeFailed';
  }
}

/** 服务端紧凑高亮响应形状。 */
export interface CompactHighlightResponse {
  intervals: unknown;
  captures: unknown;
}

/**
 * 展开紧凑响应为 HighlightInterval[]（结构校验从严：形状不对直接抛错，
 * 让 router 的回退/报错语义接管，不产出半截数据）。
 */
export function decodeHighlightResponse(body: unknown): HighlightInterval[] {
  if (typeof body !== 'object' || body === null) {
    throw new Error('远程高亮响应不是 JSON 对象');
  }
  const { intervals, captures } = body as CompactHighlightResponse;
  if (!Array.isArray(captures) || !captures.every((c) => typeof c === 'string')) {
    throw new Error('远程高亮响应缺少 captures 字符串表');
  }
  if (!Array.isArray(intervals)) {
    throw new Error('远程高亮响应缺少 intervals 数组');
  }
  return intervals.map((t) => {
    if (!Array.isArray(t) || t.length !== 3) {
      throw new Error(`远程高亮响应区间格式错误: ${JSON.stringify(t)}`);
    }
    const start = t[0];
    const end = t[1];
    const ci = t[2];
    const finite = (n: unknown): n is number =>
      typeof n === 'number' && Number.isFinite(n);
    if (!finite(start) || !finite(end) || !finite(ci)) {
      throw new Error(`远程高亮响应区间格式错误: ${JSON.stringify(t)}`);
    }
    const capture = captures[ci];
    if (typeof capture !== 'string') {
      throw new Error(`远程高亮响应捕获索引越界: ${String(ci)}`);
    }
    return { start, end, capture };
  });
}
