/**
 * mergeAbortSignals —— effect 级取消的信号合并（deferred 清偿 Task 5）。
 *
 * ViewerPane 渲染 effect 的 read 闭包把「dispatcher 渲染链透传的实例级 signal
 * （pre-instance 阶段为 undefined）」与「effectAbort.signal」合并后传 store.read：
 * cleanup 时 effectAbort.abort() 使「rev++ 早于实例 resolve」窗口内的在飞读即刻
 * reject（此前只能等读超时）；实例建成后的在飞取消仍由实例级 controller 兜底。
 *
 * 语义契约：
 * - 任一侧 undefined 直通另一侧（两侧皆 undefined 返回 undefined，调用方据此维持
 *   store.read 的无 opts 调用形态）；
 * - 任一侧 abort（含构造时已 aborted）→ 结果 signal 同步 aborted，reason 取
 *   先断一侧的 reason。
 *
 * 实现优先原生 AbortSignal.any（reason 随源传播），运行时缺失时回退手写组合
 * （AbortController + addEventListener 桥接，一次性触发后互拆监听）。抽独立小模块
 * 仅为可单测性（jsdom/node 的 AbortSignal.any 有无随版本漂移，两分支都要钉住）。
 */
export function mergeAbortSignals(
  a: AbortSignal | undefined,
  b: AbortSignal | undefined
): AbortSignal | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([a, b]);
  // 回退手写组合：已断同步传播（不等事件循环）；未断桥接任一 abort（以其 reason
  // 断结果——与 AbortSignal.any 的 reason 语义一致）
  const merged = new AbortController();
  if (a.aborted) {
    merged.abort(a.reason);
    return merged.signal;
  }
  if (b.aborted) {
    merged.abort(b.reason);
    return merged.signal;
  }
  const onAbort = (ev: Event): void => {
    a.removeEventListener('abort', onAbort);
    b.removeEventListener('abort', onAbort);
    merged.abort((ev.target as AbortSignal).reason);
  };
  a.addEventListener('abort', onAbort);
  b.addEventListener('abort', onAbort);
  return merged.signal;
}
