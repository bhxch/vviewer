/**
 * dispatch 错误身份单源（spec 2026-10-16 错误身份与字节映射 §4.1）：isAbortError /
 * DispatchReadError / abortReadError / classifyDispatchError 四件的唯一实现处。
 * 此前 isAbortError 在 render-text code.ts 与 dispatcher.ts 各有一份逐字镜像（靠
 * 注释 + 双侧测试人工同步），WorkspaceCreateModal 另有第三份内联单支变体；tree 层
 * 统一抛出形态在三处 store 各写一遍。本模块收口后，render-text 以 re-export 保持
 * 导入面零变动（依赖方向 render-text → core 合法，core 不反向依赖）。
 */

/**
 * 取消错误身份判定（deferred 清偿 Task 3 语义原样迁入）：err 是否为取消（AbortError
 * 形态）。双形态兼容：标准环境 DOMException instanceof Error 成立（WHATWG 继承链），
 * 但 jsdom 等环境的 DOMException 未必是 Error 子类，故两支并判。判定=纯错误身份，
 * 不看 catch 时刻 signal.aborted 状态（「真实读失败 + abort 竞态」不误吞）。
 */
export function isAbortError(err: unknown): boolean {
  return (
    (err instanceof DOMException && err.name === 'AbortError') ||
    (err instanceof Error && err.name === 'AbortError')
  );
}

/**
 * 读失败标记类（自 dispatcher.ts 迁入，形态不变）：dispatch 延迟全量读/流式按需读
 * 失败的标记。包装后由 dispatch catch 识别并向上 reject（调用方既有读取失败面承接，
 * 无重试通道），与策略读的失败语义对齐。
 */
export class DispatchReadError extends Error {
  constructor(err: unknown) {
    super(err instanceof Error ? err.message : String(err));
    this.name = 'DispatchReadError';
  }
}

/** 统一抛出形态（Task 1 既有约定的单源化）：tree 层 localFiles/singleFile/localFs
 * 预 abort 抛出的既定形态（isAbortError 身份判定恒静默不误吞读失败）。 */
export function abortReadError(): Error {
  return new DOMException('读取已取消', 'AbortError');
}

export type DispatchErrorKind = 'abort' | 'read' | 'generic';

/**
 * 错误分类（纯身份，spec §4.1 勘误）：abort=取消（不上屏）；read=读失败（向上
 * reject，无重试通道）；generic=其余渲染失败（错误卡片 + retry/open-as）。
 * 不设 ctx.signal 状态兜底：StreamCtx 无 signal 承载字段（signal 仅按读调用传递），
 * 且状态兜底与六处收紧「身份优先」裁决相抵；dispatcher 读包装处的 signal.aborted
 * 检查留在标注点原位，不进分类层。
 */
export function classifyDispatchError(err: unknown): DispatchErrorKind {
  if (isAbortError(err)) return 'abort';
  if (err instanceof DispatchReadError) return 'read';
  return 'generic';
}
