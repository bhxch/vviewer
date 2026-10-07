import { isCanceledMessage, RemoteComputeError, type ComputeResult, type HighlightInterval } from '@vviewer/core';
import { HighlightCanceledError } from '@vviewer/highlight';

/**
 * ComputeResult<HighlightInterval[]> → 区间数组或类型化错误（withDebug 的收敛点，
 * 独立纯函数模块便于单测覆盖路由结果各分支）。
 *
 * 错误身份协议：
 * - 取消（tab 切换）：router 折叠丢了 HighlightCanceledError 的 name，经 message
 *   前缀识别后重建（render-text 以该类型静默丢弃，不降级 hljs）；
 * - 显式 remote 失败（where==='remote' 且 !ok，remote 策略 router 不回退）：抛
 *   RemoteComputeError——渲染端以 instanceof 识别后显示错误卡，不静默降级 hljs；
 * - 其余（本地 worker 失败 / auto 回退后仍失败）：普通 Error，渲染端走 hljs 兜底。
 */
export function resolveHighlightResult(
  res: ComputeResult<HighlightInterval[]>
): HighlightInterval[] {
  if (res.ok && res.data) return res.data;
  if (isCanceledMessage(res.error)) throw new HighlightCanceledError();
  if (res.where === 'remote') throw new RemoteComputeError(res.error ?? '远程高亮失败');
  throw new Error(res.error ?? '高亮失败');
}
